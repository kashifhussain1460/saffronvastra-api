import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { env } from "../../config/env.js";
import { hashToken } from "../../common/crypto.utils.js";
import { auditSystem } from "../../common/audit.js";
import { AppError, conflictError, notFound } from "../../common/errors.js";
import type { CartOwner } from "../cart/cart.service.js";
import { queueAdminNewOrderEmail, queueOrderEmail } from "../email/email.orders.js";
import { notifyAdminsNewOrder, notifyOrderEvent } from "../notifications/notify.js";
import * as cf from "./cashfree.client.js";
import { applyRefundWebhook, reconcilePendingRefunds, recomputeOrderPaymentStatus } from "./refunds.service.js";
import { background } from "../../common/background.js";

/**
 * Online payments (Cashfree). The rules this file enforces:
 *  - An order is paid only when the payment provider says so, never because the browser came back to a success url.
 *  - The amount and currency Cashfree reports must equal what we asked for, or the payment is not accepted.
 *  - Every transition runs under a row lock on the order, so webhooks, the return page and the background check can
 *    arrive in any order, or twice, and the result is the same.
 *  - Each attempt has its own Cashfree order id, so a retry never collides with an expired earlier attempt.
 */

/** How long an unpaid online order is held before it is cancelled by the background check. */
export const ONLINE_PAYMENT_HOLD_HOURS = 24;

const FAILED_STATES = new Set(["FAILED", "USER_DROPPED", "CANCELLED", "VOID", "NOT_ATTEMPTED"]);

export type PaymentOutcome = "paid" | "failed" | "ignored" | "duplicate" | "mismatch" | "duplicate-charge";

async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`);
}

async function loadOwnedOrder(identifier: string, owner: CartOwner) {
  const clean = identifier.replace(/^#/, "").trim();
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: clean }, { orderNumber: clean }] },
    include: { payments: { orderBy: { createdAt: "asc" } } },
  });
  const owns = Boolean(order && ((owner.userId && order.userId === owner.userId) || (owner.guestProfileId && order.guestProfileId === owner.guestProfileId)));
  // The same answer for "not yours" and "does not exist": order numbers must not be guessable.
  if (!order || !owns) throw notFound("Order not found");
  return order;
}

const providerOf = (order: { paymentMethod: unknown }) => String((order.paymentMethod as any)?.provider || "").toUpperCase();

function customerFields(order: { orderNumber: string; userId: string | null; guestProfileId: string | null; shippingAddress: unknown }) {
  const address = (order.shippingAddress || {}) as any;
  const digits = String(address.phone || "").replace(/\D/g, "");
  return {
    customerId: String(order.userId || order.guestProfileId || `guest-${order.orderNumber}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50),
    customerPhone: digits.slice(-10),
    customerEmail: address.email || null,
    customerName: address.fullName || null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Starting a payment
// ---------------------------------------------------------------------------------------------------------------

export interface PaymentSessionResult {
  alreadyPaid: boolean;
  orderNumber: string;
  paymentSessionId?: string;
  mode?: "sandbox" | "production";
}

/** Creates (or re-opens) the Cashfree order for an unpaid online order and returns the session the browser needs. */
export async function startOnlinePayment(identifier: string, owner: CartOwner): Promise<PaymentSessionResult> {
  if (!cf.cashfreeConfigured()) throw new AppError(503, "ONLINE_PAYMENT_UNAVAILABLE", "Online payment is not available right now.");
  let order = await loadOwnedOrder(identifier, owner);
  if (providerOf(order) !== "CASHFREE") throw conflictError("NOT_ONLINE_ORDER", "This order is not an online payment order.");
  if (order.status === "Cancelled") throw conflictError("ORDER_CANCELLED", "This order has been cancelled and can no longer be paid.");
  if (order.paymentStatus === "Paid") return { alreadyPaid: true, orderNumber: order.orderNumber };

  // The customer may have paid on an earlier attempt and the webhook may be late: look before charging again.
  await reconcileOrderPayments(order.id);
  order = await loadOwnedOrder(order.id, owner);
  if (order.paymentStatus === "Paid") return { alreadyPaid: true, orderNumber: order.orderNumber };

  // Pick the open attempt, or open a new one, under the order lock so two tabs cannot open two attempts.
  const attempt = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order.id);
    const fresh = await tx.payment.findMany({ where: { orderId: order.id, provider: "CASHFREE" }, orderBy: { createdAt: "asc" } });
    const open = [...fresh].reverse().find((p) => p.status === "PENDING");
    if (open) return open;
    const n = fresh.length + 1;
    const created = await tx.payment.create({
      data: {
        orderId: order.id,
        provider: "CASHFREE",
        providerReference: `PAY_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        providerOrderId: n === 1 ? order.orderNumber : `${order.orderNumber}-${n}`,
        amountMinor: order.totalMinor,
        currency: "INR",
        status: "PENDING",
        metadata: { provider: "CASHFREE", attempt: n },
      },
    });
    if (order.paymentStatus === "Failed") await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "Pending" } });
    return created;
  });

  const providerOrderId = attempt.providerOrderId as string;
  let session: string | undefined;
  // The order may already exist at Cashfree (a second tab, or a retry after a timeout).
  try {
    const existing = await cf.getOrder(providerOrderId);
    if (existing.order_status === "ACTIVE" && existing.payment_session_id) session = existing.payment_session_id;
    else if (existing.order_status === "PAID") {
      await reconcileOrderPayments(order.id);
      return { alreadyPaid: true, orderNumber: order.orderNumber };
    } else {
      await markAttemptExpired(attempt.id);
      return startOnlinePayment(order.id, owner); // a fresh attempt with a new Cashfree order id
    }
  } catch (error: any) {
    if (!(error instanceof cf.CashfreeError) || error.status !== 404) {
      if (error instanceof cf.CashfreeError) throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "We could not reach the payment provider. Please try again in a moment.");
      throw error;
    }
  }

  if (!session) {
    const customer = customerFields(order);
    if (customer.customerPhone.length !== 10) {
      throw new AppError(400, "INVALID_PHONE", "A valid 10-digit mobile number is needed to pay online.");
    }
    try {
      const created = await cf.createOrder({
        orderId: providerOrderId,
        amountMinor: attempt.amountMinor,
        ...customer,
        returnUrl: `${env.APP_URL.replace(/\/$/, "")}/order-confirmation?order=${encodeURIComponent(order.orderNumber)}`,
        notifyUrl: env.PUBLIC_API_URL?.startsWith("https://") ? `${env.PUBLIC_API_URL.replace(/\/$/, "")}/api/v1/payments/cashfree/webhook` : null,
        note: `Order ${order.orderNumber}`,
        idempotencyKey: attempt.id,
      });
      session = created.payment_session_id;
    } catch (error: any) {
      await prisma.payment.update({ where: { id: attempt.id }, data: { failureReason: String(error?.message || "start failed").slice(0, 200) } });
      await auditSystem({ action: "PAYMENT_START_FAILED", entityType: "Order", entityId: order.id, status: "failure", details: { providerOrderId, code: error?.code, status: error?.status } });
      throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "We could not start the payment. Your order is saved; please try again.");
    }
  }
  if (!session) throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "We could not start the payment. Your order is saved; please try again.");
  return { alreadyPaid: false, orderNumber: order.orderNumber, paymentSessionId: session, mode: env.CASHFREE_ENV };
}

// ---------------------------------------------------------------------------------------------------------------
// Applying what the provider reports
// ---------------------------------------------------------------------------------------------------------------

export interface GatewayPaymentInput {
  providerOrderId: string;
  payment: Pick<cf.CfPayment, "cf_payment_id" | "payment_status" | "payment_amount" | "payment_currency"> & { payment_message?: string };
  source: "webhook" | "verify" | "reconcile";
  requestId?: string | null;
}

/**
 * Idempotent. Safe to call any number of times, in any order, from the webhook, the return page or the background check.
 */
export async function applyGatewayPayment(input: GatewayPaymentInput): Promise<{ outcome: PaymentOutcome; orderId?: string; orderNumber?: string }> {
  const attemptRow = await prisma.payment.findUnique({ where: { providerOrderId: input.providerOrderId }, select: { id: true, orderId: true } });
  if (!attemptRow) return { outcome: "ignored" };

  const status = String(input.payment.payment_status || "").toUpperCase();
  const cfPaymentId = String(input.payment.cf_payment_id);
  let notify: "paid" | "failed" | null = null;
  let result: { outcome: PaymentOutcome; orderNumber?: string } = { outcome: "ignored" };

  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, attemptRow.orderId);
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: attemptRow.id } });
    const order = await tx.order.findUniqueOrThrow({ where: { id: attemptRow.orderId }, include: { payments: true } });
    result = { outcome: "ignored", orderNumber: order.orderNumber };

    if (status === "SUCCESS") {
      const amountOk = cf.toMinorUnits(input.payment.payment_amount) === payment.amountMinor && String(input.payment.payment_currency || "INR").toUpperCase() === "INR";
      if (!amountOk) {
        await tx.payment.update({ where: { id: payment.id }, data: { failureReason: "AMOUNT_MISMATCH" } });
        await tx.adminAuditLog.create({
          data: {
            action: "PAYMENT_AMOUNT_MISMATCH",
            category: "security",
            status: "failure",
            actorRole: "SYSTEM",
            entityType: "Order",
            entityId: order.id,
            requestId: input.requestId || null,
            safeDiff: { expectedMinor: payment.amountMinor, reported: input.payment.payment_amount, currency: input.payment.payment_currency, source: input.source },
          },
        });
        result = { outcome: "mismatch", orderNumber: order.orderNumber };
        return;
      }
      if (payment.status === "SUCCESS") {
        result = { outcome: "duplicate", orderNumber: order.orderNumber };
        return;
      }
      const otherSuccess = order.payments.find((p) => p.id !== payment.id && p.status === "SUCCESS");
      await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCESS", providerPaymentId: cfPaymentId, paidAt: new Date(), failureReason: null } });
      if (otherSuccess) {
        // A second successful charge for the same order: keep it on record so staff can refund the surplus.
        await tx.adminAuditLog.create({
          data: { action: "PAYMENT_DUPLICATE_CHARGE", category: "admin", status: "failure", actorRole: "SYSTEM", entityType: "Order", entityId: order.id, requestId: input.requestId || null, safeDiff: { paymentId: payment.id, amountMinor: payment.amountMinor, source: input.source } },
        });
        await recomputeOrderPaymentStatus(tx, order.id);
        result = { outcome: "duplicate-charge", orderNumber: order.orderNumber };
        return;
      }
      await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "Paid" } });
      if (order.status === "Pending") {
        await tx.order.update({ where: { id: order.id }, data: { status: "Processing" } });
        await tx.orderStatusHistory.create({
          data: { orderId: order.id, oldStatus: "Pending", newStatus: "Processing", actorUserId: null, note: "Online payment received. Order confirmed and sent to the atelier." },
        });
      } else if (order.status === "Cancelled") {
        // Paid after the order was cancelled: staff must refund it. It is flagged, not silently accepted.
        await tx.adminAuditLog.create({
          data: { action: "PAYMENT_AFTER_CANCELLATION", category: "admin", status: "failure", actorRole: "SYSTEM", entityType: "Order", entityId: order.id, requestId: input.requestId || null, safeDiff: { paymentId: payment.id, amountMinor: payment.amountMinor, source: input.source } },
        });
      }
      await tx.adminAuditLog.create({
        data: { action: "PAYMENT_CONFIRMED", category: "admin", status: "success", actorRole: "SYSTEM", entityType: "Order", entityId: order.id, requestId: input.requestId || null, safeDiff: { paymentId: payment.id, amountMinor: payment.amountMinor, source: input.source } },
      });
      result = { outcome: "paid", orderNumber: order.orderNumber };
      notify = order.status === "Cancelled" ? null : "paid";
      return;
    }

    if (FAILED_STATES.has(status)) {
      // A failed or abandoned attempt never undoes a payment that already succeeded.
      if (payment.status !== "PENDING") return;
      await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: String(input.payment.payment_message || status).slice(0, 200) } });
      const stillOpen = order.payments.some((p) => p.id !== payment.id && (p.status === "PENDING" || p.status === "SUCCESS"));
      if (!stillOpen && order.paymentStatus === "Pending") {
        await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "Failed" } });
        notify = "failed";
      }
      result = { outcome: "failed", orderNumber: order.orderNumber };
    }
  });

  if (notify === "paid" && result.orderNumber) {
    const order = await prisma.order.findUnique({ where: { orderNumber: result.orderNumber }, select: { id: true } });
    if (order) {
      queueOrderEmail(order.id, "order-confirmation");
      queueOrderEmail(order.id, "payment-received");
      queueAdminNewOrderEmail(order.id);
      notifyOrderEvent(order.id, "placed");
      notifyOrderEvent(order.id, "payment-received");
      notifyAdminsNewOrder(order.id);
    }
  } else if (notify === "failed" && result.orderNumber) {
    const order = await prisma.order.findUnique({ where: { orderNumber: result.orderNumber }, select: { id: true } });
    if (order) {
      queueOrderEmail(order.id, "payment-failed");
      notifyOrderEvent(order.id, "payment-failed");
    }
  }
  return { ...result, orderId: attemptRow.orderId };
}

async function markAttemptExpired(paymentId: string) {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return;
    await lockOrder(tx, payment.orderId);
    const fresh = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (fresh.status !== "PENDING") return;
    await tx.payment.update({ where: { id: paymentId }, data: { status: "EXPIRED" } });
    const order = await tx.order.findUniqueOrThrow({ where: { id: fresh.orderId }, include: { payments: true } });
    const stillOpen = order.payments.some((p) => p.id !== paymentId && (p.status === "PENDING" || p.status === "SUCCESS"));
    if (!stillOpen && order.paymentStatus === "Pending") await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "Failed" } });
  });
}

/**
 * An order was cancelled: its open payment attempts are closed so the customer cannot pay it later through an old link.
 * Best effort and never throws; a payment that still arrives is flagged for a refund (PAYMENT_AFTER_CANCELLATION).
 */
export async function closeOnlinePayments(orderId: string): Promise<void> {
  try {
    const open = await prisma.payment.findMany({ where: { orderId, provider: "CASHFREE", status: "PENDING" } });
    for (const attempt of open) {
      await prisma.payment.update({ where: { id: attempt.id }, data: { status: "EXPIRED" } });
      if (cf.cashfreeConfigured() && attempt.providerOrderId) await cf.terminateOrder(attempt.providerOrderId).catch(() => undefined);
    }
  } catch (error: any) {
    console.error("[payments] could not close open payment attempts:", error?.message || error);
  }
}

/** Asks Cashfree about every open attempt of an order and applies the answer. Never throws. */
export async function reconcileOrderPayments(orderId: string): Promise<void> {
  if (!cf.cashfreeConfigured()) return;
  try {
    const attempts = await prisma.payment.findMany({ where: { orderId, provider: "CASHFREE", status: "PENDING", providerOrderId: { not: null } } });
    for (const attempt of attempts) {
      const providerOrderId = attempt.providerOrderId as string;
      let remote: cf.CfOrder;
      try {
        remote = await cf.getOrder(providerOrderId);
      } catch (error: any) {
        if (error instanceof cf.CashfreeError && error.status === 404) continue; // no Cashfree order yet: nothing was paid
        throw error;
      }
      if (remote.order_status === "PAID") {
        const payments = await cf.getOrderPayments(providerOrderId);
        const success = payments.find((p) => String(p.payment_status).toUpperCase() === "SUCCESS");
        if (success) await applyGatewayPayment({ providerOrderId, payment: success, source: "reconcile" });
      } else if (remote.order_status === "EXPIRED" || remote.order_status === "TERMINATED") {
        await markAttemptExpired(attempt.id);
      } else {
        // ACTIVE: failed tries do not close an order, but record them so the customer sees "payment failed".
        const payments = await cf.getOrderPayments(providerOrderId).catch(() => [] as cf.CfPayment[]);
        const failed = payments.find((p) => FAILED_STATES.has(String(p.payment_status).toUpperCase()));
        if (failed && !payments.some((p) => String(p.payment_status).toUpperCase() === "SUCCESS")) {
          // the order is still open for another try; only the latest failure message is kept
          await prisma.payment.update({ where: { id: attempt.id }, data: { failureReason: String(failed.payment_message || failed.payment_status).slice(0, 200) } });
        }
      }
    }
  } catch (error: any) {
    console.error("[payments] reconcile failed:", error?.message || error);
  }
}

/** What the return page asks: "is this order paid?" The answer is checked with the provider, not taken from the url. */
export async function verifyOrderPayment(identifier: string, owner: CartOwner) {
  const order = await loadOwnedOrder(identifier, owner);
  if (providerOf(order) === "CASHFREE" && order.paymentStatus !== "Paid") await reconcileOrderPayments(order.id);
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: { orderBy: { createdAt: "desc" }, take: 1 } } });
  const last = fresh.payments[0];
  return {
    orderNumber: fresh.orderNumber,
    provider: providerOf(fresh),
    orderStatus: fresh.status,
    paymentStatus: fresh.paymentStatus,
    attemptStatus: last?.status ?? null,
    failureReason: last?.status === "FAILED" ? last.failureReason : null,
    canRetry: providerOf(fresh) === "CASHFREE" && fresh.status !== "Cancelled" && fresh.paymentStatus !== "Paid",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------------------------------------------

export interface WebhookResult {
  httpStatus: number;
  body: { status: string; message?: string };
}

export async function processCashfreeWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, requestId?: string | null): Promise<WebhookResult> {
  const header = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const timestamp = header("x-webhook-timestamp");
  if (!cf.verifyWebhookSignature(rawBody, timestamp, header("x-webhook-signature"))) {
    await auditSystem({ action: "PAYMENT_WEBHOOK_REJECTED", category: "security", status: "denied", entityType: "Webhook", entityId: "cashfree", requestId, details: { reason: "bad or missing signature" } });
    return { httpStatus: 401, body: { status: "error", message: "Invalid signature" } };
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { httpStatus: 400, body: { status: "error", message: "Invalid payload" } };
  }
  const type = String(event?.type || "UNKNOWN");
  const data = event?.data || {};
  // Cashfree's own per-delivery id when present, else a hash of what was signed: the same delivery maps to one key.
  const eventKey = header("x-idempotency-key") || hashToken(`${timestamp}.${rawBody}`);
  const summary = {
    type,
    orderId: data?.order?.order_id ?? data?.refund?.order_id ?? null,
    cfPaymentId: data?.payment?.cf_payment_id ?? data?.refund?.cf_payment_id ?? null,
    refundId: data?.refund?.refund_id ?? null,
    status: data?.payment?.payment_status ?? data?.refund?.refund_status ?? null,
    amount: data?.payment?.payment_amount ?? data?.refund?.refund_amount ?? null,
  };

  let record = await prisma.webhookEvent
    .create({ data: { provider: "CASHFREE", providerEventId: eventKey, eventType: type, payload: summary as any, status: "FAILED" } })
    .catch(async (error: any) => {
      if (error?.code !== "P2002") throw error;
      return null;
    });
  if (!record) {
    const existing = await prisma.webhookEvent.findUnique({ where: { provider_providerEventId: { provider: "CASHFREE", providerEventId: eventKey } } });
    // Already handled: acknowledge so Cashfree stops retrying. A delivery that failed earlier is processed again.
    if (existing?.processedAt && existing.status !== "FAILED") return { httpStatus: 200, body: { status: "duplicate" } };
    record = existing;
  }

  try {
    let outcome = "ignored";
    if (type === "PAYMENT_SUCCESS_WEBHOOK" || type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") {
      const orderId = String(data?.order?.order_id || "");
      if (orderId && data?.payment) {
        const res = await applyGatewayPayment({ providerOrderId: orderId, payment: data.payment, source: "webhook", requestId });
        outcome = res.outcome;
      }
    } else if (type === "REFUND_STATUS_WEBHOOK") {
      outcome = await applyRefundWebhook(data?.refund || {});
    }
    const ignored = outcome === "ignored" || outcome === "mismatch";
    if (record) {
      await prisma.webhookEvent.update({ where: { id: record.id }, data: { status: ignored ? "IGNORED" : "PROCESSED", processedAt: new Date() } });
    }
    return { httpStatus: 200, body: { status: outcome } };
  } catch (error: any) {
    console.error("[payments] webhook processing failed:", error?.message || error);
    if (record) await prisma.webhookEvent.update({ where: { id: record.id }, data: { status: "FAILED" } }).catch(() => undefined);
    // 500 makes Cashfree deliver it again later.
    return { httpStatus: 500, body: { status: "error", message: "Could not process the event" } };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Background check (every few minutes) and the admin "check now" button
// ---------------------------------------------------------------------------------------------------------------

export async function reconcilePendingPayments(limit = 40) {
  if (!cf.cashfreeConfigured()) return { checked: 0, cancelled: 0 };
  const now = Date.now();
  const open = await prisma.payment.findMany({
    where: { provider: "CASHFREE", status: "PENDING", providerOrderId: { not: null }, createdAt: { lt: new Date(now - 3 * 60 * 1000), gt: new Date(now - 14 * 24 * 60 * 60 * 1000) } },
    select: { orderId: true },
    take: limit,
    orderBy: { createdAt: "asc" },
  });
  const orderIds = [...new Set(open.map((p) => p.orderId))];
  for (const id of orderIds) await reconcileOrderPayments(id);
  await reconcilePendingRefunds(limit);

  // An online order that was never paid does not stay open forever.
  const cutoff = new Date(now - ONLINE_PAYMENT_HOLD_HOURS * 60 * 60 * 1000);
  const stale = await prisma.order.findMany({
    where: { status: "Pending", paymentStatus: { in: ["Pending", "Failed"] }, createdAt: { lt: cutoff }, paymentMethod: { path: ["provider"], equals: "CASHFREE" } },
    select: { id: true },
    take: limit,
  });
  let cancelled = 0;
  for (const { id } of stale) {
    await reconcileOrderPayments(id);
    const done = await prisma.$transaction(async (tx) => {
      await lockOrder(tx, id);
      const order = await tx.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
      if (order.status !== "Pending" || order.paymentStatus === "Paid" || order.payments.some((p) => p.status === "SUCCESS")) return false;
      await tx.order.update({ where: { id }, data: { status: "Cancelled", paymentStatus: "Failed" } });
      await tx.payment.updateMany({ where: { orderId: id, status: "PENDING" }, data: { status: "EXPIRED" } });
      // the promo code use taken at checkout goes back, so an abandoned payment does not burn a limited code
      if (order.couponCode) await tx.coupon.updateMany({ where: { code: order.couponCode, redemptionsCount: { gt: 0 } }, data: { redemptionsCount: { decrement: 1 } } });
      await tx.orderStatusHistory.create({
        data: { orderId: id, oldStatus: "Pending", newStatus: "Cancelled", actorUserId: null, note: `Payment was not completed within ${ONLINE_PAYMENT_HOLD_HOURS} hours.` },
      });
      return true;
    });
    if (done) {
      cancelled++;
      background(closeOnlinePayments(id));
      await auditSystem({ action: "ORDER_AUTO_CANCELLED_UNPAID", entityType: "Order", entityId: id, details: { holdHours: ONLINE_PAYMENT_HOLD_HOURS } });
      queueOrderEmail(id, "order-cancelled");
    }
  }
  return { checked: orderIds.length, cancelled };
}

let timer: NodeJS.Timeout | null = null;
/** Starts the periodic check. Does nothing when online payment is not configured. */
export function startPaymentReconciler(everyMs = 10 * 60 * 1000) {
  if (timer || !cf.cashfreeConfigured()) return;
  timer = setInterval(() => {
    reconcilePendingPayments().catch((e) => console.error("[payments] background check failed:", e?.message));
  }, everyMs);
  timer.unref();
}
