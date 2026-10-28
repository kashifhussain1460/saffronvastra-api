import { Response } from "express";
import { AuthenticatedRequest } from "../../common/auth.middleware.js";
import { generateUUID } from "../../common/crypto.utils.js";
import { resolveCartOwner } from "../cart/cart.service.js";
import { checkoutQuoteSchema, placeOrderSchema } from "./orders.schema.js";
import {
  trackOrderPublic,
  calculateQuote,
  placeOrder,
  getCustomerOrders,
  getOrderDetail,
} from "./orders.service.js";

function setGuestCookieIfNeeded(res: Response, owner: any) {
  if (owner.isNewGuest && owner.guestId) {
    res.cookie("saffron_guest_id", owner.guestId, {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 365 * 24 * 60 * 60 * 1000,
      path: "/",
    });
    res.setHeader("x-guest-id", owner.guestId);
  }
}

export async function getQuote(req: AuthenticatedRequest, res: Response) {
  try {
    const validated = checkoutQuoteSchema.parse(req.body);
    const owner = await resolveCartOwner(req);
    setGuestCookieIfNeeded(res, owner);

    const quote = await calculateQuote({
      owner,
      couponCode: validated.couponCode,
      shippingAddress: validated.shippingAddress,
      shippingMethod: validated.shippingMethod,
      items: validated.items,
      paymentProvider: validated.paymentProvider,
    });

    return res.status(200).json({
      status: "success",
      data: quote,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ status: "error", errors: error.errors });
    }
    if (error.statusCode === 400) {
      return res.status(400).json({ status: "error", message: error.message });
    }
    return res.status(500).json({ status: "error", message: error.message });
  }
}

export async function checkout(req: AuthenticatedRequest, res: Response) {
  // Orders are a customer action. Staff accounts manage orders but never place them.
  if (req.user?.roles.includes("ADMIN")) {
    return res.status(403).json({
      status: "error",
      code: "ADMIN_CANNOT_ORDER",
      message: "Administrator accounts cannot place orders. Sign in with a customer account to shop.",
    });
  }
  try {
    const validated = placeOrderSchema.parse(req.body);
    const owner = await resolveCartOwner(req);
    setGuestCookieIfNeeded(res, owner);

    // Extract idempotency key from header or body, or generate one
    const idempotencyKey =
      (req.headers["idempotency-key"] as string) ||
      (req.headers["x-idempotency-key"] as string) ||
      validated.idempotencyKey ||
      generateUUID();

    res.setHeader("Idempotency-Key", idempotencyKey);

    const result = await placeOrder(owner, validated, idempotencyKey);

    return res.status(result.statusCode).json(result.payload);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ status: "error", errors: error.errors });
    }
    if (error.statusCode === 400) {
      return res.status(400).json({ status: "error", message: error.message });
    }
    if (error.statusCode === 409) {
      return res.status(409).json({ status: "error", message: error.message });
    }
    const status =
      error.message.includes("empty cart") ||
      error.message.includes("no longer available") ||
      error.message.includes("inactive") ||
      error.message.includes("does not exist")
        ? 400
        : 500;
    if (status === 500) {
      console.error("[checkout]", error);
      return res.status(500).json({ status: "error", message: "We could not place your order. Please try again." });
    }
    return res.status(status).json({ status: "error", message: error.message });
  }
}

export async function trackOrder(req: AuthenticatedRequest, res: Response) {
  try {
    const orderNumber = typeof req.body?.orderNumber === "string" ? req.body.orderNumber : "";
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    if (!orderNumber.trim() || !email.trim() || orderNumber.length > 30 || email.length > 254) {
      return res.status(400).json({ status: "error", code: "VALIDATION_ERROR", message: "Enter your order number and the email address used at checkout." });
    }
    const data = await trackOrderPublic(orderNumber, email);
    return res.status(200).json({ status: "success", data });
  } catch (error: any) {
    if (error.statusCode === 404) return res.status(404).json({ status: "error", code: "ORDER_NOT_FOUND", message: error.message });
    console.error("[track-order]", error?.message);
    return res.status(500).json({ status: "error", message: "We could not look that up. Please try again." });
  }
}

export async function listMyOrders(req: AuthenticatedRequest, res: Response) {
  try {
    const owner = await resolveCartOwner(req);
    if (!owner.userId && !owner.guestProfileId) {
      return res.status(401).json({
        status: "error",
        code: "UNAUTHORIZED",
        message: "Authentication or guest session required to view orders",
      });
    }

    const orders = await getCustomerOrders(owner);
    return res.status(200).json({
      status: "success",
      data: orders,
    });
  } catch (error: any) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}

export async function getMyOrderDetail(req: AuthenticatedRequest, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const owner = await resolveCartOwner(req);
    const isAdmin = req.user?.roles.includes("ADMIN") || false;

    const order = await getOrderDetail(id, owner, isAdmin);
    return res.status(200).json({
      status: "success",
      data: order,
    });
  } catch (error: any) {
    if (error.message === "Order not found") {
      return res.status(404).json({ status: "error", message: "Order not found" });
    }
    // Someone else's order answers exactly like a missing one, so order numbers cannot be probed.
    if (error.message.startsWith("Forbidden")) {
      return res.status(404).json({ status: "error", message: "Order not found" });
    }
    return res.status(500).json({ status: "error", message: error.message });
  }
}
