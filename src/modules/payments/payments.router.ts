import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { AuthenticatedRequest, requireAdmin } from "../../common/auth.middleware.js";
import { audit } from "../../common/audit.js";
import { AppError, sendError } from "../../common/errors.js";
import { resolveCartOwner } from "../cart/cart.service.js";
import { prisma } from "../../database/prisma.js";
import { processCashfreeWebhook, reconcileOrderPayments, reconcilePendingPayments, startOnlinePayment, verifyOrderPayment } from "./payments.service.js";
import { initiateRefund } from "./refunds.service.js";

const testBypass = (req: Request) => process.env.NODE_ENV !== "production" && (process.env.NODE_ENV === "test" || req.headers["x-test-bypass-rate-limit"] === "true");

/** Cashfree calls this endpoint. The body must reach the signature check as the exact bytes that were sent. */
export async function cashfreeWebhookHandler(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : "";
  if (!raw) return res.status(400).json({ status: "error", message: "Empty body" });
  const result = await processCashfreeWebhook(raw, req.headers, (req as any).id);
  return res.status(result.httpStatus).json(result.body);
}

export const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: testBypass,
  message: { status: "error", code: "RATE_LIMITED", message: "Too many requests" },
});

const paymentRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: testBypass,
  message: { status: "error", code: "RATE_LIMITED", message: "Too many payment requests. Please wait a moment." },
});

// Customer: /orders/:id/payment/...  (a signed-in customer, or the guest who placed the order)
// The limiter is attached to each route, not to the router: this router is mounted at /orders next to the ordinary order
// routes, and a router-wide limiter would also count every normal order lookup.
export const orderPaymentsRouter = Router();

orderPaymentsRouter.post("/:id/payment/start", paymentRateLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.roles.includes("ADMIN")) throw new AppError(403, "ADMIN_CANNOT_ORDER", "Staff accounts cannot pay for orders.");
    const owner = await resolveCartOwner(req);
    const result = await startOnlinePayment(String(req.params.id), owner);
    return res.status(200).json({ status: "success", data: result });
  } catch (error) {
    return sendError(res, error, "payment-start");
  }
});

orderPaymentsRouter.get("/:id/payment-status", paymentRateLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = await resolveCartOwner(req);
    const result = await verifyOrderPayment(String(req.params.id), owner);
    return res.status(200).json({ status: "success", data: result });
  } catch (error) {
    return sendError(res, error, "payment-status");
  }
});

// Admin: /admin/orders/:id/...
export const adminPaymentsRouter = Router();
adminPaymentsRouter.use(requireAdmin);

const refundSchema = z.object({
  // rupees with at most two decimals, as typed in the admin screen
  amount: z.coerce.number().positive("Enter a refund amount greater than zero").max(10_000_000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "Use at most two decimal places"),
  reason: z.string().trim().min(3, "Give a reason for the refund").max(300),
  paymentId: z.string().uuid().optional().nullable(),
  requestId: z.string().uuid().optional().nullable(),
  manualReference: z.string().trim().max(120).optional().nullable(),
});

// "Check now" for every open online payment and refund; the same job that runs by itself every ten minutes.
// Declared before the /:id routes so "reconcile" is never read as an order id.
adminPaymentsRouter.post("/reconcile", async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await reconcilePendingPayments();
    return res.status(200).json({ status: "success", data: result });
  } catch (error) {
    return sendError(res, error, "payment-reconcile-all");
  }
});

adminPaymentsRouter.post("/:id/refunds", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = refundSchema.parse(req.body);
    const refund = await initiateRefund({
      orderId: String(req.params.id),
      amountMinor: Math.round(body.amount * 100),
      reason: body.reason,
      paymentId: body.paymentId,
      requestId: body.requestId,
      manualReference: body.manualReference,
      actorUserId: req.user!.id,
    });
    await audit(req, { action: "REFUND_INITIATED", entityType: "Refund", entityId: refund.id, details: { orderId: String(req.params.id), amountMinor: refund.amountMinor, method: refund.method, status: refund.status } });
    return res.status(201).json({ status: "success", data: refund });
  } catch (error) {
    return sendError(res, error, "refund");
  }
});

adminPaymentsRouter.post("/:id/payments/reconcile", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const clean = String(req.params.id).replace(/^#/, "").trim();
    const order = await prisma.order.findFirst({ where: { OR: [{ id: clean }, { orderNumber: clean }] }, select: { id: true } });
    if (!order) throw new AppError(404, "NOT_FOUND", "Order not found");
    await reconcileOrderPayments(order.id);
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: { include: { refunds: true }, orderBy: { createdAt: "asc" } } } });
    return res.status(200).json({ status: "success", data: { paymentStatus: fresh.paymentStatus, payments: fresh.payments } });
  } catch (error) {
    return sendError(res, error, "payment-reconcile");
  }
});
