import { BRAND_IDENTITY } from "./config/brand.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "./config/env.js";
import { healthRouter } from "./modules/health/health.router.js";
import { newsletterRouter, contactRouter, adminEngagementRouter } from "./modules/engagement/engagement.router.js";
import { adminEmailRouter } from "./modules/email/email.router.js";
import { authRouter } from "./modules/auth/auth.router.js";
import { guestRouter } from "./modules/guest/guest.router.js";
import { customerRouter, adminCustomerRouter } from "./modules/customers/customer.router.js";
import { catalogueRouter, adminCatalogueRouter } from "./modules/catalogue/catalogue.router.js";
import { mediaRouter } from "./modules/media/media.router.js";
import { cartRouter } from "./modules/cart/cart.router.js";
import {
  checkoutRouter,
  customerOrdersRouter,
  ordersRouter,
} from "./modules/orders/orders.router.js";
import { adminOrdersRouter } from "./modules/orders/admin.orders.router.js";
import { analyticsRouter } from "./modules/analytics/analytics.router.js";
import { adminAnalyticsRouter } from "./modules/analytics/admin.analytics.router.js";
import { adminCouponsRouter } from "./modules/coupons/coupons.router.js";
import { publicSettingsRouter, adminSettingsRouter } from "./modules/settings/settings.router.js";
import { publicJournalRouter, adminArticlesRouter } from "./modules/content/content.router.js";
import { publicReviewsRouter, myReviewsRouter, adminReviewsRouter } from "./modules/reviews/reviews.router.js";
import { myNotificationsRouter, adminNotificationsRouter } from "./modules/notifications/notifications.router.js";
import { optionalAuth } from "./common/auth.middleware.js";
import { auditAdminMutations } from "./common/audit.js";
import { adminAuditRouter } from "./modules/audit/audit.router.js";
import { adminRequestsRouter, orderRequestsRouter, requestEvidenceRouter } from "./modules/requests/requests.router.js";
import { cronRouter } from "./modules/internal/cron.router.js";
import { adminPaymentsRouter, cashfreeWebhookHandler, orderPaymentsRouter, webhookRateLimiter } from "./modules/payments/payments.router.js";

export const app = express();

// The storefront proxies /api from the same host: trust it to report the real visitor address, so rate limits
// and stored IPs are per visitor instead of one shared proxy address.
app.set("trust proxy", /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY.split(",").map((v) => v.trim()));

// Security and utility middleware
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(
  cors({
    origin: env.NODE_ENV === "production" ? [env.CORS_ORIGIN] : [env.CORS_ORIGIN, "http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
  })
);
app.use(cookieParser(env.COOKIE_SECRET));
// Payment webhook: mounted BEFORE the JSON parser. The signature covers the exact bytes Cashfree sent.
app.post("/api/v1/payments/cashfree/webhook", webhookRateLimiter, express.raw({ type: "*/*", limit: "1mb" }), cashfreeWebhookHandler);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Static file serving for uploads
app.use("/uploads", express.static(path.resolve(process.cwd(), "public/uploads")));

// Rate Limiters
// Test and local bypasses never apply in production, where they would switch rate limiting off.
const testBypassAllowed = process.env.NODE_ENV !== "production";

export const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === "production" ? 2000 : 50000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.path.startsWith("/analytics") ||
    (testBypassAllowed &&
      (process.env.NODE_ENV === "test" ||
        req.headers["x-test-bypass-rate-limit"] === "true" ||
        req.ip === "127.0.0.1" ||
        req.ip === "::1" ||
        req.ip === "::ffff:127.0.0.1")),
  message: {
    status: "error",
    code: "RATE_LIMIT_EXCEEDED",
    message: "Too many requests from this IP. Please try again after 15 minutes.",
  },
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === "production" ? 15 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    testBypassAllowed &&
    (process.env.NODE_ENV === "test" || req.headers["x-test-bypass-rate-limit"] === "true"),
  message: {
    status: "error",
    code: "AUTH_RATE_LIMIT_EXCEEDED",
    message: "Too many authentication attempts. Please try again after 15 minutes.",
  },
});

export const checkoutRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    testBypassAllowed &&
    (process.env.NODE_ENV === "test" || req.headers["x-test-bypass-rate-limit"] === "true"),
  message: {
    status: "error",
    code: "CHECKOUT_RATE_LIMIT_EXCEEDED",
    message: "Too many checkout attempts. Please try again shortly.",
  },
});

// Request ID & Logging Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  // A client may pass its own id for correlation, but only a short well-formed one; otherwise the server makes one.
  const supplied = req.headers["x-request-id"];
  const reqId = typeof supplied === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(supplied) ? supplied : randomUUID();
  res.setHeader("x-request-id", reqId);
  (req as any).id = reqId;

  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== "test") {
      console.log(
        `[${new Date().toISOString()}] [${reqId}] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`
      );
    }
  });

  next();
});

const STATUS_CODES_BY_HTTP: Record<number, string> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "VALIDATION_ERROR",
  429: "RATE_LIMITED",
};

// Internal error details never reach the client: any 500 body is replaced by a generic message with the request id.
// The original message is logged with the same id so it can be found.
app.use((req: Request, res: Response, next: NextFunction) => {
  const json = res.json.bind(res);
  res.json = ((body: any) => {
    // One error contract for every module (see ERROR_CODES.md): always a stable code, a readable message and the
    // request id. Existing fields (errors, usage, ...) are kept so current clients keep working.
    if (body && typeof body === "object" && body.status === "error" && res.statusCode >= 400 && res.statusCode < 500) {
      body = {
        ...body,
        code: body.code || STATUS_CODES_BY_HTTP[res.statusCode] || "REQUEST_FAILED",
        message: body.message || (Array.isArray(body.errors) && body.errors[0]?.message) || "The request could not be completed.",
        requestId: (req as any).id,
      };
    }
    if (res.statusCode === 500 && body && typeof body === "object" && body.status === "error") {
      if (body.message) console.error(`[ERROR] [${(req as any).id}] ${req.method} ${req.originalUrl}: ${body.message}`);
      body = {
        status: "error",
        code: body.code || "INTERNAL_SERVER_ERROR",
        message: "Something went wrong on our side. Please try again.",
        requestId: (req as any).id,
      };
    }
    return json(body);
  }) as Response["json"];
  next();
});

// Root & Health routes
app.use("/health", healthRouter);

// API v1 Router
const apiV1Router = express.Router();
apiV1Router.use(generalApiLimiter);
apiV1Router.use(optionalAuth);
apiV1Router.use("/health", healthRouter);
apiV1Router.use("/auth/login", authRateLimiter);
apiV1Router.use("/auth/signup", authRateLimiter);
apiV1Router.use("/auth/forgot-password", authRateLimiter);
apiV1Router.use("/auth/reset-password", authRateLimiter);
apiV1Router.use("/auth/verify-email", authRateLimiter);
apiV1Router.use("/auth/resend-verification", authRateLimiter);
apiV1Router.use("/auth", authRouter);
apiV1Router.use("/guest", guestRouter);
apiV1Router.use("/cart", cartRouter);
apiV1Router.use("/checkout", checkoutRateLimiter, checkoutRouter);
apiV1Router.use("/me/orders", customerOrdersRouter);
apiV1Router.use("/me/reviews", myReviewsRouter);
apiV1Router.use("/me/notifications", myNotificationsRouter);
apiV1Router.use("/settings", publicSettingsRouter);
apiV1Router.use("/journal", publicJournalRouter);
apiV1Router.use("/reviews", publicReviewsRouter);
apiV1Router.use("/orders", orderPaymentsRouter);
apiV1Router.use("/orders", orderRequestsRouter);
apiV1Router.use("/requests", requestEvidenceRouter);
apiV1Router.use("/orders", ordersRouter);
apiV1Router.use("/me", customerRouter);
apiV1Router.use("/", catalogueRouter); // /categories, /collections, /products, /search
apiV1Router.use("/newsletter", newsletterRouter);
apiV1Router.use("/contact", contactRouter);
apiV1Router.use("/admin/audit-logs", adminAuditRouter);
apiV1Router.use("/admin/engagement", auditAdminMutations("Engagement"), adminEngagementRouter);
apiV1Router.use("/admin/emails", auditAdminMutations("Email"), adminEmailRouter);
apiV1Router.use("/admin/coupons", auditAdminMutations("Coupon"), adminCouponsRouter);
apiV1Router.use("/admin/settings", auditAdminMutations("Settings"), adminSettingsRouter);
apiV1Router.use("/admin/articles", auditAdminMutations("Article"), adminArticlesRouter);
apiV1Router.use("/admin/reviews", auditAdminMutations("Review"), adminReviewsRouter);
apiV1Router.use("/admin/notifications", adminNotificationsRouter);
apiV1Router.use("/analytics", analyticsRouter);
apiV1Router.use("/admin/analytics", adminAnalyticsRouter);
apiV1Router.use("/admin/orders", auditAdminMutations("Order"), adminPaymentsRouter);
apiV1Router.use("/admin/requests", auditAdminMutations("OrderRequest"), adminRequestsRouter);
apiV1Router.use("/admin/orders", adminOrdersRouter);
apiV1Router.use("/admin/customers", auditAdminMutations("Customer"), adminCustomerRouter);
apiV1Router.use("/admin", adminCatalogueRouter); // /admin/categories, /admin/products, /admin/collections
apiV1Router.use("/admin/media", auditAdminMutations("Media"), mediaRouter); // /admin/media

// Welcome endpoint for /api/v1
apiV1Router.get("/", (req: Request, res: Response) => {
  res.status(200).json({
    name: `${BRAND_IDENTITY.name} Production API`,
    version: "v1",
    documentation: "/api/v1/docs",
    status: "operational",
    endpoints: {
      health: "/api/v1/health",
      auth: "/api/v1/auth",
      guest: "/api/v1/guest",
      me: "/api/v1/me",
      catalogue: "/api/v1/catalogue",
      cart: "/api/v1/cart",
      orders: "/api/v1/orders",
      analytics: "/api/v1/analytics",
    },
  });
});

// Scheduled jobs (Vercel Cron): own secret, no session, not counted by the visitor rate limiter.
app.use("/api/v1/internal/cron", cronRouter);

app.use("/api/v1", apiV1Router);

// 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    status: "error",
    code: "NOT_FOUND",
    message: `Cannot ${req.method} ${req.originalUrl}`,
    requestId: (req as any).id,
  });
});

// Global Error Handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  const status = err.status || err.statusCode || 500;
  console.error(`[ERROR] [${(req as any).id}] ${err.message}`, err.stack);

  res.status(status).json({
    status: "error",
    code: err.code || "INTERNAL_SERVER_ERROR",
    message: status >= 500 ? "Something went wrong on our side. Please try again." : err.message || "The request could not be completed.",
    requestId: (req as any).id,
  });
});
