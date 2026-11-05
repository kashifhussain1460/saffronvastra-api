import { timingSafeEqual } from "node:crypto";
import { Request, Response, Router } from "express";
import { env } from "../../config/env.js";
import { reconcilePendingPayments } from "../payments/payments.service.js";
import { recoverStaleLocks } from "../social/jobs.service.js";
import { runJobBatch } from "../social/jobs.runner.js";

/**
 * Endpoints called by the scheduler (Vercel Cron). Vercel sends "Authorization: Bearer <CRON_SECRET>" on every call,
 * so nothing here is open to the public. Every job must be safe to run twice or to be missed: it only finishes
 * outstanding work, it never repeats a side effect.
 */
export const cronRouter = Router();

function authorised(req: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(String(req.headers.authorization || ""));
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

cronRouter.use((req: Request, res: Response, next) => {
  if (!env.CRON_SECRET) return res.status(503).json({ status: "error", message: "CRON_SECRET is not configured." });
  if (!authorised(req)) return res.status(401).json({ status: "error", message: "Unauthorized" });
  return next();
});

// Confirms open online payments and refunds with Cashfree when a webhook was missed, and cancels online orders that
// were never paid within the hold time (returning the promo code use). Same job the admin "check now" button runs.
cronRouter.get("/reconcile", async (_req: Request, res: Response) => {
  try {
    const result = await reconcilePendingPayments();
    console.log("[cron] reconcile finished", JSON.stringify(result));
    return res.status(200).json({ status: "success", data: result });
  } catch (error: any) {
    console.error("[cron] reconcile failed:", error?.message);
    return res.status(500).json({ status: "error", message: "Reconcile failed" });
  }
});

// Social publishing sweeper: frees stale job locks, then runs one batch of queued publish jobs.
cronRouter.get("/social", async (_req: Request, res: Response) => {
  if (!env.SOCIAL_PUBLISHING_ENABLED) {
    return res.status(404).json({ status: "error", code: "NOT_FOUND", message: "Not found" });
  }
  try {
    const recovered = await recoverStaleLocks();
    const processed = await runJobBatch(10);
    console.log("[cron] social sweep finished", JSON.stringify({ recovered, processed }));
    return res.status(200).json({ status: "success", data: { recovered, processed } });
  } catch (error: any) {
    console.error("[cron] social sweep failed:", error?.message);
    return res.status(500).json({ status: "error", message: "Social sweep failed" });
  }
});
