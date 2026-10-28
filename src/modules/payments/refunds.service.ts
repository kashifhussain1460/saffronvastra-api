import { Prisma } from "@prisma/client";
import crypto from "crypto";
import { prisma } from "../../database/prisma.js";
import { auditSystem } from "../../common/audit.js";
import { AppError, badRequest, conflictError, notFound } from "../../common/errors.js";
import { queueRefundEmail } from "../email/email.requests.js";
import { notifyOrderEvent } from "../notifications/notify.js";
import * as cf from "./cashfree.client.js";

/**
 * Refunds. The rules this file enforces:
 *  - Only staff start a refund, and only against a payment that really succeeded.
 *  - Money already refunded or still being refunded counts against the limit, so the same money can never go out
 *    twice, even if two staff members click at the same moment (the order row is locked).
 *  - A refund sent to the gateway carries our own refund id and an idempotency key, so a retry cannot refund twice.
 *  - Cash-on-delivery money is returned by hand: staff record the bank / UPI reference of the transfer they made.
 */

async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`);
}

const REFUND_FAILED = new Set(["CANCELLED", "REJECTED", "FAILED"]);

/** Money taken for an order minus what has been (or is being) given back, per payment. */
export function refundableMinor(payment: { amountMinor: number; refunds: Array<{ amountMinor: number; status: string }> }) {
  const used = payment.refunds.filter((r) => r.status === "PENDING" || r.status === "COMPLETED").reduce((sum, r) => sum + r.amountMinor, 0);
  return Math.max(0, payment.amountMinor - used);
}

/** Order.paymentStatus follows the money: Paid, Partially Refunded or Refunded, from the payments and refunds on record. */
export async function recomputeOrderPaymentStatus(tx: Prisma.TransactionClient, orderId: string) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: { include: { refunds: true } } } });
  const paid = order.payments.filter((p) => p.status === "SUCCESS");
  if (paid.length === 0) return order.paymentStatus;
  const collected = paid.reduce((s, p) => s + p.amountMinor, 0);
  const refunded = paid.flatMap((p) => p.refunds).filter((r) => r.status === "COMPLETED").reduce((s, r) => s + r.amountMinor, 0);
  const net = collected - refunded;
  const next = net <= 0 ? "Refunded" : net < order.totalMinor ? "Partially Refunded" : "Paid";
  if (next !== order.paymentStatus) await tx.order.update({ where: { id: orderId }, data: { paymentStatus: next } });
  return next;
}

const newRefundRef = () => `RF${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

export interface InitiateRefundInput {
  orderId: string; // id or order number
  amountMinor: number;
  reason: string;
  paymentId?: string | null;
  requestId?: string | null;
  manualReference?: string | null;
  actorUserId: string;
  requestIdForAudit?: string | null;
}

export async function initiateRefund(input: InitiateRefundInput) {
  const clean = input.orderId.replace(/^#/, "").trim();
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw badRequest("INVALID_AMOUNT", "Enter a refund amount greater than zero.");
  const reason = input.reason.trim();
  if (reason.length < 3) throw badRequest("REASON_REQUIRED", "Give a reason for the refund.");

  const refund = await prisma.$transaction(async (tx) => {
    const found = await tx.order.findFirst({ where: { OR: [{ id: clean }, { orderNumber: clean }] }, select: { id: true } });
    if (!found) throw notFound("Order not found");
    await lockOrder(tx, found.id);
    const order = await tx.order.findUniqueOrThrow({ where: { id: found.id }, include: { payments: { include: { refunds: true }, orderBy: { createdAt: "asc" } } } });
    const candidates = order.payments.filter((p) => p.status === "SUCCESS" && (!input.paymentId || p.id === input.paymentId));
    const payment = candidates[0];
    if (!payment) throw conflictError("NOTHING_TO_REFUND", "There is no successful payment on this order to refund.");
    const available = refundableMinor(payment);
    if (input.amountMinor > available) {
      throw conflictError("REFUND_EXCEEDS_PAID", `At most ₹${(available / 100).toFixed(2)} can still be refunded on this payment.`);
    }
    if (input.requestId) {
      const request = await tx.orderRequest.findUnique({ where: { id: input.requestId } });
      if (!request || request.orderId !== order.id) throw badRequest("REQUEST_MISMATCH", "That request does not belong to this order.");
    }
    const gateway = payment.provider === "CASHFREE";
    if (!gateway) {
      const ref = (input.manualReference || "").trim();
      if (ref.length < 3) throw badRequest("MANUAL_REFERENCE_REQUIRED", "Enter the bank or UPI reference of the transfer you made to the customer.");
    }
    return tx.refund.create({
      data: {
        paymentId: payment.id,
        requestId: input.requestId || null,
        amountMinor: input.amountMinor,
        reason: reason.slice(0, 300),
        method: gateway ? "GATEWAY" : "MANUAL",
        refundRef: gateway ? newRefundRef() : null,
        manualReference: gateway ? null : (input.manualReference || "").trim().slice(0, 120),
        // a manual refund is recorded after the transfer was made; a gateway refund waits for the provider
        status: gateway ? "PENDING" : "COMPLETED",
        processedAt: gateway ? null : new Date(),
        initiatedByUserId: input.actorUserId,
      },
      include: { payment: true },
    });
  });

  if (refund.method === "MANUAL") {
    await prisma.$transaction(async (tx) => {
      await lockOrder(tx, refund.payment.orderId);
      await recomputeOrderPaymentStatus(tx, refund.payment.orderId);
    });
    await auditSystem({ action: "REFUND_RECORDED_MANUAL", entityType: "Refund", entityId: refund.id, details: { orderId: refund.payment.orderId, amountMinor: refund.amountMinor, actorUserId: input.actorUserId } });
    queueRefundEmail(refund.id);
    notifyOrderEvent(refund.payment.orderId, "refund");
    return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  }

  // Gateway refund: the row above reserves the amount; now ask Cashfree.
  try {
    const result = await cf.createRefund(
      refund.payment.providerOrderId as string,
      { refundId: refund.refundRef as string, amountMinor: refund.amountMinor, note: reason },
      refund.id
    );
    await applyRefundResult(refund.id, result);
    await auditSystem({ action: "REFUND_SENT_TO_GATEWAY", entityType: "Refund", entityId: refund.id, details: { orderId: refund.payment.orderId, amountMinor: refund.amountMinor, actorUserId: input.actorUserId, providerStatus: result.refund_status } });
  } catch (error: any) {
    if (error instanceof cf.CashfreeError && error.unknownOutcome) {
      // We do not know if Cashfree acted. Keep it pending: the background check asks Cashfree and settles it.
      await auditSystem({ action: "REFUND_OUTCOME_UNKNOWN", entityType: "Refund", entityId: refund.id, status: "failure", details: { code: error.code } });
      throw new AppError(502, "REFUND_PENDING_CHECK", "The payment provider did not answer. The refund is marked pending and will be checked automatically; do not retry it.");
    }
    await prisma.refund.update({ where: { id: refund.id }, data: { status: "FAILED", failureReason: String(error?.message || "rejected").slice(0, 200), processedAt: new Date() } });
    await auditSystem({ action: "REFUND_REJECTED_BY_GATEWAY", entityType: "Refund", entityId: refund.id, status: "failure", details: { code: error?.code, message: error?.message } });
    throw new AppError(502, "REFUND_REJECTED", `The payment provider did not accept the refund: ${String(error?.message || "unknown reason")}`);
  }
  return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/** Applies the status Cashfree returned for one refund; used by the create call, the webhook and the background check. */
async function applyRefundResult(refundId: string, remote: Pick<cf.CfRefund, "refund_status" | "cf_refund_id" | "status_description">) {
  const status = String(remote.refund_status || "").toUpperCase();
  let changed = false;
  let orderId = "";
  await prisma.$transaction(async (tx) => {
    const refund = await tx.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!refund) return;
    orderId = refund.payment.orderId;
    await lockOrder(tx, orderId);
    const fresh = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    const providerRef = remote.cf_refund_id != null ? String(remote.cf_refund_id) : fresh.providerRef;
    if (status === "SUCCESS" && fresh.status !== "COMPLETED") {
      await tx.refund.update({ where: { id: refundId }, data: { status: "COMPLETED", providerRef, processedAt: new Date(), failureReason: null } });
      changed = true;
    } else if (REFUND_FAILED.has(status) && fresh.status === "PENDING") {
      await tx.refund.update({ where: { id: refundId }, data: { status: "FAILED", providerRef, processedAt: new Date(), failureReason: String(remote.status_description || status).slice(0, 200) } });
      changed = true;
    } else if (fresh.providerRef !== providerRef && providerRef) {
      await tx.refund.update({ where: { id: refundId }, data: { providerRef } });
    }
    await recomputeOrderPaymentStatus(tx, orderId);
  });
  if (changed) {
    queueRefundEmail(refundId);
    notifyOrderEvent(orderId, "refund");
  }
}

/** REFUND_STATUS_WEBHOOK. The refund is matched by the refund id we sent, never by anything else in the payload. */
export async function applyRefundWebhook(refund: any): Promise<string> {
  const refundRef = String(refund?.refund_id || "");
  if (!refundRef) return "ignored";
  const row = await prisma.refund.findUnique({ where: { refundRef }, select: { id: true } });
  if (!row) return "ignored";
  await applyRefundResult(row.id, { refund_status: refund.refund_status, cf_refund_id: refund.cf_refund_id, status_description: refund.status_description });
  return "refund-updated";
}

/** Asks Cashfree for the current state of refunds still pending (the webhook may have been missed). */
export async function reconcilePendingRefunds(limit = 40) {
  if (!cf.cashfreeConfigured()) return 0;
  const pending = await prisma.refund.findMany({
    where: { status: "PENDING", method: "GATEWAY", refundRef: { not: null }, createdAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } },
    include: { payment: { select: { providerOrderId: true } } },
    take: limit,
    orderBy: { createdAt: "asc" },
  });
  let settled = 0;
  for (const refund of pending) {
    try {
      const remote = await cf.getRefund(refund.payment.providerOrderId as string, refund.refundRef as string);
      await applyRefundResult(refund.id, remote);
      settled++;
    } catch (error: any) {
      if (error instanceof cf.CashfreeError && error.status === 404) {
        // Cashfree has no record: the request never arrived, so the amount can be released.
        await prisma.refund.update({ where: { id: refund.id }, data: { status: "FAILED", failureReason: "Not received by the payment provider", processedAt: new Date() } });
        settled++;
      } else console.error("[payments] refund check failed:", error?.message);
    }
  }
  return settled;
}
