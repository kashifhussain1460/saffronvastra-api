import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { verifyMetaChallenge, processInstagramWebhook } from "./meta-webhook.service.js";

const testBypass = (req: Request) => process.env.NODE_ENV !== "production" && (process.env.NODE_ENV === "test" || req.headers["x-test-bypass-rate-limit"] === "true");

export const metaWebhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: testBypass,
  message: { status: "error", code: "RATE_LIMITED", message: "Too many requests" },
});

/** Meta's one-time verification call when "Verify and save" is clicked in the App Dashboard. */
export function instagramWebhookVerifyHandler(req: Request, res: Response) {
  const result = verifyMetaChallenge(req.query as Record<string, unknown>);
  if (!result.ok) return res.status(403).send("Forbidden");
  // Meta requires the exact challenge string back, as plain text (not JSON).
  res.status(200).type("text/plain").send(result.challenge);
}

/** Every subsequent event delivery. The body must reach the signature check as the exact bytes Meta sent. */
export async function instagramWebhookEventHandler(req: Request, res: Response) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : "";
  if (!raw) return res.status(400).json({ status: "error", message: "Empty body" });
  const result = await processInstagramWebhook(raw, req.headers, (req as any).id);
  return res.status(result.httpStatus).json(result.body);
}

export const metaWebhookRouter = Router();
metaWebhookRouter.get("/webhooks/instagram", metaWebhookRateLimiter, instagramWebhookVerifyHandler);
// The POST route is mounted directly on `app` in app.ts (ahead of express.json()) so it gets the raw body,
// the same way the Cashfree webhook does — see app.ts.
