import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { auditSystem } from "../../common/audit.js";
import { AppError, badRequest, conflictError, notFound } from "../../common/errors.js";
import type { CartOwner } from "../cart/cart.service.js";
import { queueRequestEmail } from "../email/email.requests.js";
import { notifyAdmins, notifyOrderEvent } from "../notifications/notify.js";
import { updateOrderStatus } from "../orders/orders.service.js";
import { background } from "../../common/background.js";

/**
 * Cancellation, return and exchange requests. The rules follow the published Terms & Conditions and FAQ:
 *  - Cancellation: until the order is dispatched. Within 24 hours of placing it a request is routine; later it is
 *    reviewed against the order's production status. After dispatch the return rules apply instead.
 *  - Return / exchange: only for a delivered order, within 7 calendar days of delivery. Defective, damaged, incorrect or
 *    misdescribed products can still be raised later: they are accepted with a flag for individual review, because
 *    consumer rights do not end with the return window. A change of mind after 7 days is not accepted.
 *  - Staff decide. Nothing is refunded just because a request was submitted.
 */

export const RETURN_WINDOW_DAYS = 7;
export const CANCELLATION_WINDOW_HOURS = 24;
const DAY_MS = 24 * 60 * 60 * 1000;

export const REASONS = ["CHANGE_OF_MIND", "SIZE_ISSUE", "DEFECTIVE", "DAMAGED", "INCORRECT", "NOT_AS_DESCRIBED", "OTHER"] as const;
const REMEDY_REASONS = new Set(["DEFECTIVE", "DAMAGED", "INCORRECT", "NOT_AS_DESCRIBED"]);
const OPEN_FOR_CANCEL = new Set(["Pending", "Processing", "Ready to Ship"]);
// statuses that still hold the quantity of a return (a rejected or withdrawn request gives it back)
const HOLDING = ["Requested", "Approved", "Received", "Completed"];

const TRANSITIONS: Record<string, string[]> = {
  Requested: ["Approved", "Rejected", "Cancelled"],
  Approved: ["Received", "Completed"],
  Received: ["Completed"],
  Rejected: [],
  Cancelled: [],
  Completed: [],
};

async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`);
}

const ownsOrder = (order: { userId: string | null; guestProfileId: string | null }, owner: CartOwner) =>
  Boolean((owner.userId && order.userId === owner.userId) || (owner.guestProfileId && order.guestProfileId === owner.guestProfileId));

function deliveredAtOf(history: Array<{ newStatus: string; createdAt: Date }>) {
  const entry = [...history].reverse().find((h) => h.newStatus === "Delivered");
  return entry ? entry.createdAt : null;
}

async function loadOwnedOrder(identifier: string, owner: CartOwner) {
  const clean = identifier.replace(/^#/, "").trim();
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: clean }, { orderNumber: clean }] },
    include: { items: true, statusHistory: { orderBy: { createdAt: "asc" } }, payments: { include: { refunds: true } } },
  });
  if (!order || !ownsOrder(order, owner)) throw notFound("Order not found");
  return order;
}

async function requestedQuantities(orderId: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  const rows = await client.orderRequestItem.findMany({
    where: { request: { orderId, type: { in: ["RETURN", "EXCHANGE"] }, status: { in: HOLDING } } },
    select: { orderItemId: true, quantity: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.orderItemId, (map.get(r.orderItemId) || 0) + r.quantity);
  return map;
}

// ---------------------------------------------------------------------------------------------------------------
// What can the customer do with this order?
// ---------------------------------------------------------------------------------------------------------------

export async function getEligibility(identifier: string, owner: CartOwner) {
  const order = await loadOwnedOrder(identifier, owner);
  const now = Date.now();
  const deliveredAt = deliveredAtOf(order.statusHistory);
  const windowEndsAt = deliveredAt ? new Date(deliveredAt.getTime() + RETURN_WINDOW_DAYS * DAY_MS) : null;
  const withinWindow = Boolean(windowEndsAt && now <= windowEndsAt.getTime());
  const requested = await requestedQuantities(order.id);
  const openCancel = await prisma.orderRequest.findFirst({ where: { orderId: order.id, type: "CANCELLATION", status: { in: ["Requested", "Approved"] } }, select: { requestNumber: true } });

  const variantIds = order.items.map((i) => i.productVariantId).filter((v): v is string => Boolean(v));
  const variants = variantIds.length
    ? await prisma.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true, productId: true, colourName: true } })
    : [];
  const byVariant = new Map(variants.map((v) => [v.id, v]));
  const sizesFor = async (item: (typeof order.items)[number]) => {
    const base = item.productVariantId ? byVariant.get(item.productVariantId) : null;
    if (!base) return [] as string[];
    const rows = await prisma.productVariant.findMany({ where: { productId: base.productId, colourName: base.colourName, status: "Active" }, select: { size: true } });
    return [...new Set(rows.map((r) => r.size))].filter((s) => s !== item.size);
  };

  const items = await Promise.all(
    order.items.map(async (it) => ({
      orderItemId: it.id,
      title: it.productTitle,
      image: it.productImage,
      size: it.size,
      colour: it.colour,
      purchased: it.quantity,
      alreadyRequested: requested.get(it.id) || 0,
      available: Math.max(0, it.quantity - (requested.get(it.id) || 0)),
      exchangeSizes: await sizesFor(it),
    }))
  );

  const canCancel = OPEN_FOR_CANCEL.has(order.status) && !openCancel;
  const delivered = order.status === "Delivered";
  return {
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    canCancel,
    cancelNote: !OPEN_FOR_CANCEL.has(order.status)
      ? order.status === "Cancelled"
        ? "This order is already cancelled."
        : order.status === "Delivered"
          ? "This order has been delivered. Use a return or exchange request instead."
          : "This order has been dispatched, so it can no longer be cancelled. Once it arrives you can request a return or exchange."
      : openCancel
        ? `A cancellation request (${openCancel.requestNumber}) is already open.`
        : now - order.createdAt.getTime() > CANCELLATION_WINDOW_HOURS * 60 * 60 * 1000
          ? "This order was placed more than 24 hours ago. The request is reviewed against the order's production status."
          : null,
    // after the window only a defective / damaged / incorrect product can still be raised; createRequest decides by reason
    canReturn: delivered && items.some((i) => i.available > 0),
    deliveredAt,
    windowEndsAt,
    withinWindow,
    returnWindowDays: RETURN_WINDOW_DAYS,
    afterWindowNote: delivered && !withinWindow ? "The 7-day return period has ended. A defective, damaged or incorrect product can still be reported and will be reviewed individually." : null,
    items,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Creating a request
// ---------------------------------------------------------------------------------------------------------------

export interface CreateRequestInput {
  type: "CANCELLATION" | "RETURN" | "EXCHANGE";
  reasonCode: (typeof REASONS)[number];
  details?: string | null;
  items?: Array<{ orderItemId: string; quantity: number; exchangeSize?: string | null }>;
  evidence?: string[];
}

async function newRequestNumber(tx: Prisma.TransactionClient) {
  for (let i = 0; i < 10; i++) {
    const candidate = `RQ${Math.floor(10000 + Math.random() * 90000)}`;
    if (!(await tx.orderRequest.findUnique({ where: { requestNumber: candidate }, select: { id: true } }))) return candidate;
  }
  return `RQ${Date.now().toString().slice(-8)}`;
}

export async function createRequest(identifier: string, owner: CartOwner, input: CreateRequestInput, actorUserId: string | null) {
  const found = await loadOwnedOrder(identifier, owner);
  const details = (input.details || "").trim();
  if (input.type !== "CANCELLATION" && (REMEDY_REASONS.has(input.reasonCode) || input.reasonCode === "OTHER") && details.length < 10) {
    throw badRequest("DETAILS_REQUIRED", "Please describe the problem in a few words (at least 10 characters).");
  }
  if (input.evidence && input.evidence.length > 5) throw badRequest("TOO_MANY_PHOTOS", "You can attach at most 5 photos.");

  const created = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, found.id);
    const order = await tx.order.findUniqueOrThrow({
      where: { id: found.id },
      include: { items: true, statusHistory: { orderBy: { createdAt: "asc" } } },
    });
    let outsideWindow = false;
    const lines: Array<{ orderItemId: string; quantity: number; exchangeSize: string | null }> = [];

    if (input.type === "CANCELLATION") {
      if (!OPEN_FOR_CANCEL.has(order.status)) {
        throw conflictError("NOT_CANCELLABLE", order.status === "Cancelled" ? "This order is already cancelled." : "This order has been dispatched or delivered, so it can no longer be cancelled.");
      }
      const open = await tx.orderRequest.findFirst({ where: { orderId: order.id, type: "CANCELLATION", status: { in: ["Requested", "Approved"] } } });
      if (open) throw conflictError("REQUEST_ALREADY_OPEN", `A cancellation request (${open.requestNumber}) is already open for this order.`);
      outsideWindow = Date.now() - order.createdAt.getTime() > CANCELLATION_WINDOW_HOURS * 60 * 60 * 1000;
    } else {
      if (order.status !== "Delivered") {
        throw conflictError("NOT_DELIVERED", "A return or exchange can be requested once the order has been delivered.");
      }
      const deliveredAt = deliveredAtOf(order.statusHistory);
      if (!deliveredAt) throw conflictError("NOT_DELIVERED", "We have no delivery date for this order yet.");
      const windowEnds = new Date(deliveredAt.getTime() + RETURN_WINDOW_DAYS * DAY_MS);
      outsideWindow = Date.now() > windowEnds.getTime();
      if (outsideWindow && !REMEDY_REASONS.has(input.reasonCode)) {
        throw new AppError(422, "RETURN_WINDOW_ENDED", `The ${RETURN_WINDOW_DAYS}-day return period ended on ${windowEnds.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}. If the product is defective, damaged or not what you ordered, choose that reason and we will review it.`);
      }
      if (!input.items || input.items.length === 0) throw badRequest("ITEMS_REQUIRED", "Choose the item you want to return or exchange.");
      const seen = new Set<string>();
      const requested = await requestedQuantities(order.id, tx);
      for (const line of input.items) {
        if (seen.has(line.orderItemId)) throw badRequest("DUPLICATE_ITEM", "Each item can be listed only once.");
        seen.add(line.orderItemId);
        const item = order.items.find((i) => i.id === line.orderItemId);
        if (!item) throw badRequest("ITEM_NOT_IN_ORDER", "That item is not part of this order.");
        const available = item.quantity - (requested.get(item.id) || 0);
        if (line.quantity > available) {
          throw conflictError("QUANTITY_NOT_AVAILABLE", available <= 0 ? `${item.productTitle} already has a request for every piece.` : `Only ${available} piece(s) of ${item.productTitle} can still be requested.`);
        }
        let exchangeSize: string | null = null;
        if (input.type === "EXCHANGE") {
          exchangeSize = (line.exchangeSize || "").trim();
          if (!exchangeSize) throw badRequest("EXCHANGE_SIZE_REQUIRED", `Choose the size you want instead for ${item.productTitle}.`);
          const base = item.productVariantId ? await tx.productVariant.findUnique({ where: { id: item.productVariantId }, select: { productId: true, colourName: true } }) : null;
          const target = base
            ? await tx.productVariant.findFirst({ where: { productId: base.productId, colourName: base.colourName, size: exchangeSize, status: "Active" }, select: { id: true } })
            : null;
          if (!target || exchangeSize === item.size) {
            throw conflictError("EXCHANGE_SIZE_UNAVAILABLE", `Size ${exchangeSize} is not available for ${item.productTitle}. Choose another size, or ask for a refund instead.`);
          }
        }
        lines.push({ orderItemId: item.id, quantity: line.quantity, exchangeSize });
      }
    }

    const request = await tx.orderRequest.create({
      data: {
        requestNumber: await newRequestNumber(tx),
        orderId: order.id,
        userId: order.userId,
        guestProfileId: order.guestProfileId,
        type: input.type,
        status: "Requested",
        reasonCode: input.reasonCode,
        details: details || null,
        resolution: input.type === "RETURN" ? "REFUND" : input.type === "EXCHANGE" ? "EXCHANGE" : "NONE",
        outsideWindow,
        evidence: input.evidence && input.evidence.length ? input.evidence : undefined,
        items: { create: lines },
        events: { create: { fromStatus: null, toStatus: "Requested", actorUserId, actorRole: "CUSTOMER", note: details ? details.slice(0, 300) : null } },
      },
    });
    return { request, orderNumber: order.orderNumber, orderId: order.id };
  });

  await auditSystem({ action: "ORDER_REQUEST_CREATED", entityType: "OrderRequest", entityId: created.request.id, details: { orderNumber: created.orderNumber, type: input.type, reason: input.reasonCode, outsideWindow: created.request.outsideWindow } });
  queueRequestEmail(created.request.id, "received");
  notifyOrderEvent(created.orderId, "request-received");
  background(notifyAdmins({ type: "ORDER_REQUEST", title: `New ${input.type.toLowerCase()} request`, body: `${created.request.requestNumber} for order ${created.orderNumber}${created.request.outsideWindow ? " (outside the usual window)" : ""}.`, metadata: { requestNumber: created.request.requestNumber, orderNumber: created.orderNumber } }));
  return created.request;
}

/** The customer changes their mind before staff have looked at it. */
export async function withdrawRequest(identifier: string, requestId: string, owner: CartOwner, actorUserId: string | null) {
  const order = await loadOwnedOrder(identifier, owner);
  return prisma.$transaction(async (tx) => {
    await lockOrder(tx, order.id);
    const request = await tx.orderRequest.findFirst({ where: { id: requestId, orderId: order.id } });
    if (!request) throw notFound("Request not found");
    if (request.status !== "Requested") throw conflictError("CANNOT_WITHDRAW", "This request has already been reviewed and can no longer be withdrawn.");
    const updated = await tx.orderRequest.update({ where: { id: request.id }, data: { status: "Cancelled" } });
    await tx.orderRequestEvent.create({ data: { requestId: request.id, fromStatus: "Requested", toStatus: "Cancelled", actorUserId, actorRole: "CUSTOMER", note: "Withdrawn by the customer" } });
    return updated;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------------------------------------------

export async function listRequests(filters: { status?: string; type?: string; search?: string; page?: number; limit?: number }) {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.max(1, Math.min(100, filters.limit || 20));
  const where: Prisma.OrderRequestWhereInput = {};
  if (filters.status && filters.status !== "all") where.status = filters.status;
  if (filters.type && filters.type !== "all") where.type = filters.type;
  if (filters.search?.trim()) {
    const s = filters.search.trim().replace(/^#/, "");
    where.OR = [
      { requestNumber: { contains: s, mode: "insensitive" } },
      { order: { orderNumber: { contains: s, mode: "insensitive" } } },
      { order: { shippingAddress: { path: ["fullName"], string_contains: s } } },
    ];
  }
  const [rows, total, counts] = await Promise.all([
    prisma.orderRequest.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" }, include: { order: { select: { orderNumber: true, shippingAddress: true, totalMinor: true, paymentStatus: true } }, items: true } }),
    prisma.orderRequest.count({ where }),
    prisma.orderRequest.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      requestNumber: r.requestNumber,
      orderNumber: r.order.orderNumber,
      customerName: (r.order.shippingAddress as any)?.fullName || "Customer",
      type: r.type,
      status: r.status,
      reasonCode: r.reasonCode,
      resolution: r.resolution,
      outsideWindow: r.outsideWindow,
      itemsCount: r.items.reduce((s, i) => s + i.quantity, 0),
      createdAt: r.createdAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  };
}

export async function getRequestDetail(id: string) {
  const request = await prisma.orderRequest.findUnique({
    where: { id },
    include: {
      items: { include: { orderItem: true } },
      events: { orderBy: { createdAt: "asc" } },
      refunds: { orderBy: { createdAt: "asc" } },
      order: { include: { payments: { include: { refunds: true }, orderBy: { createdAt: "asc" } } } },
    },
  });
  if (!request) throw notFound("Request not found");
  const order = request.order;
  const address = (order.shippingAddress || {}) as any;
  // A fair starting figure for the refund: the value of the pieces, with the order's discount shared across them.
  const subtotal = order.subtotalMinor || 1;
  const itemsValue = request.items.reduce((sum, line) => sum + line.orderItem.unitPriceMinor * line.quantity, 0);
  const suggestedRefundMinor = request.type === "CANCELLATION" ? order.totalMinor : Math.round(itemsValue * (1 - order.discountMinor / subtotal));
  const refunded = request.refunds.filter((r) => r.status === "COMPLETED").reduce((s, r) => s + r.amountMinor, 0);
  const actions = (TRANSITIONS[request.status] || []).filter((a) => a !== "Received" || request.type !== "CANCELLATION");
  return {
    ...request,
    customer: { name: address.fullName || "Customer", email: address.email || null, phone: address.phone || null },
    orderSummary: { orderNumber: order.orderNumber, status: order.status, paymentStatus: order.paymentStatus, totalMinor: order.totalMinor, paymentProvider: String((order.paymentMethod as any)?.provider || "") },
    payments: order.payments.map((p) => ({ id: p.id, provider: p.provider, status: p.status, amountMinor: p.amountMinor, refunds: p.refunds.map((r) => ({ id: r.id, amountMinor: r.amountMinor, status: r.status })) })),
    suggestedRefundMinor,
    refundedMinor: refunded,
    allowedActions: actions,
  };
}

export type StaffAction = "approve" | "reject" | "receive" | "complete";

export interface StaffActionInput {
  note?: string | null;
  returnShippingPayer?: "CUSTOMER" | "SELLER" | null;
  resolution?: "REFUND" | "EXCHANGE" | null;
}

export async function applyStaffAction(requestId: string, action: StaffAction, input: StaffActionInput, actorUserId: string) {
  const note = (input.note || "").trim();
  const target = { approve: "Approved", reject: "Rejected", receive: "Received", complete: "Completed" }[action];
  if (action === "reject" && note.length < 3) throw badRequest("NOTE_REQUIRED", "Tell the customer why the request cannot be approved.");

  const before = await prisma.orderRequest.findUnique({ where: { id: requestId }, include: { order: true } });
  if (!before) throw notFound("Request not found");

  // Approving a cancellation cancels the order first (that has its own rules, e.g. nothing already shipped).
  if (action === "approve" && before.type === "CANCELLATION" && before.order.status !== "Cancelled") {
    await updateOrderStatus(before.orderId, "Cancelled", note || `Cancelled at the customer's request (${before.requestNumber}).`, actorUserId);
  }

  const result = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, before.orderId);
    const request = await tx.orderRequest.findUniqueOrThrow({ where: { id: requestId }, include: { refunds: true, order: { include: { payments: { include: { refunds: true } } } } } });
    if (!(TRANSITIONS[request.status] || []).includes(target)) {
      throw conflictError("INVALID_TRANSITION", `A request that is ${request.status} cannot be ${target.toLowerCase()}.`);
    }
    if (action === "receive" && request.type === "CANCELLATION") throw conflictError("INVALID_TRANSITION", "A cancellation has nothing to receive.");
    if (action === "complete" && request.type !== "CANCELLATION" && request.status !== "Received") {
      throw conflictError("NOT_RECEIVED_YET", "Mark the returned product as received before completing the request.");
    }
    if (action === "complete" && request.type === "RETURN" && request.resolution === "REFUND" && !request.refunds.some((r) => r.status === "COMPLETED")) {
      throw conflictError("REFUND_FIRST", "Issue the refund for this return before completing it.");
    }
    const data: Prisma.OrderRequestUpdateInput = { status: target };
    if (action === "approve" || action === "reject") {
      data.decidedByUserId = actorUserId;
      data.decidedAt = new Date();
      if (note) data.decisionNote = note.slice(0, 1000);
    }
    if (action === "approve") {
      if (input.resolution) data.resolution = input.resolution;
      if (request.type !== "CANCELLATION") {
        // Published policy: the customer pays return shipping for a change of mind or a size choice; we pay when the product is faulty.
        const payer = input.returnShippingPayer || (request.reasonCode === "CHANGE_OF_MIND" || request.reasonCode === "SIZE_ISSUE" ? "CUSTOMER" : "SELLER");
        data.returnShippingPayer = payer;
      }
    }
    if (action === "receive") data.receivedAt = new Date();
    if (action === "complete") {
      data.completedAt = new Date();
      if (note) data.decisionNote = [request.decisionNote, note].filter(Boolean).join("\n").slice(0, 1000);
    }
    let finalStatus = target;
    // A cancellation with no money collected has nothing left to settle: it is complete as soon as it is approved.
    if (action === "approve" && request.type === "CANCELLATION") {
      const collected = request.order.payments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + p.amountMinor, 0);
      if (collected === 0) {
        data.status = "Completed";
        data.completedAt = new Date();
        finalStatus = "Completed";
      }
    }
    const updated = await tx.orderRequest.update({ where: { id: requestId }, data });
    await tx.orderRequestEvent.create({ data: { requestId, fromStatus: request.status, toStatus: finalStatus, actorUserId, actorRole: "ADMIN", note: note ? note.slice(0, 500) : null } });
    await tx.adminAuditLog.create({
      data: { actorUserId, actorRole: "ADMIN", action: `ORDER_REQUEST_${action.toUpperCase()}`, entityType: "OrderRequest", entityId: requestId, safeDiff: { requestNumber: request.requestNumber, from: request.status, to: finalStatus, hasNote: Boolean(note) } as any },
    });
    return { updated, finalStatus };
  });

  if (action === "approve") queueRequestEmail(requestId, "approved");
  else if (action === "reject") queueRequestEmail(requestId, "rejected");
  if (result.finalStatus === "Completed") queueRequestEmail(requestId, "completed");
  if (action === "approve") notifyOrderEvent(before.orderId, "request-approved");
  else if (action === "reject") notifyOrderEvent(before.orderId, "request-rejected");
  if (result.finalStatus === "Completed") notifyOrderEvent(before.orderId, "request-completed");
  return result.updated;
}
