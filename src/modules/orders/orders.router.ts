import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  getQuote,
  checkout,
  listMyOrders,
  getMyOrderDetail,
  trackOrder,
} from "./orders.controller.js";

// Checkout Router (/checkout)
export const checkoutRouter = Router();
checkoutRouter.post("/quote", getQuote);
checkoutRouter.post("/", checkout);

// Customer Orders Router (/me/orders)
export const customerOrdersRouter = Router();
customerOrdersRouter.get("/", listMyOrders);
customerOrdersRouter.get("/:id", getMyOrderDetail);

// Looking an order up without an account is rate limited hard: it takes a guessable order number and an email address.
const trackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV !== "production" && (process.env.NODE_ENV === "test" || req.headers["x-test-bypass-rate-limit"] === "true"),
  message: { status: "error", code: "RATE_LIMITED", message: "Too many lookups. Please try again in a few minutes." },
});

// Orders Router alias (/orders)
export const ordersRouter = Router();
ordersRouter.post("/track", trackLimiter, trackOrder);
ordersRouter.get("/", listMyOrders);
ordersRouter.get("/:id", getMyOrderDetail);
