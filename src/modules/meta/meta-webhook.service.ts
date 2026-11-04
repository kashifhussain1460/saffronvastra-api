import crypto from "node:crypto";
import { prisma } from "../../database/prisma.js";
import { auditSystem } from "../../common/audit.js";
import { env } from "../../config/env.js";

/**
 * Meta (Instagram/Facebook) webhook: verification handshake + signed event delivery.
 *
 * Setup in the Meta App Dashboard (App > Webhooks, or Instagram > Configure webhooks):
 *   Callback URL  = {PUBLIC_API_URL}/api/v1/webhooks/instagram
 *   Verify token  = INSTAGRAM_VERIFY_TOKEN (any string you choose; set it as an env var here and paste the
 *                   same value into the dashboard — Meta only needs it to match once, during verification)
 *   App Secret    = META_APP_SECRET (App Dashboard > Settings > Basic > App Secret; signs every event
 *                   delivery afterwards, so it must be exact; never sent to the browser)
 *
 * Mirrors the Cashfree webhook pattern (payments.service.ts): raw body for the signature check, a
 * WebhookEvent row per delivery for idempotency (Meta retries undelivered events), and a quick 200 so
 * Meta does not retry a slow handler.
 */

/** Meta's one-time handshake: GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=... */
export function verifyMetaChallenge(query: Record<string, unknown>): { ok: true; challenge: string } | { ok: false } {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || typeof challenge !== "string") return { ok: false };
  if (!env.INSTAGRAM_VERIFY_TOKEN || token !== env.INSTAGRAM_VERIFY_TOKEN) return { ok: false };
  return { ok: true, challenge };
}

/** Every delivery after verification is signed: X-Hub-Signature-256: sha256=<hex hmac of the raw body>. */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | undefined, secret = env.META_APP_SECRET): boolean {
  if (!secret || !signatureHeader) return false;
  const [scheme, hex] = signatureHeader.split("=");
  if (scheme !== "sha256" || !hex) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let given: Buffer;
  try {
    given = Buffer.from(hex, "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export interface WebhookResult {
  httpStatus: number;
  body: unknown;
}

/**
 * Receives a batch of entries (Meta always wraps events as { object, entry: [...] }). Nothing here acts on
 * the events yet — this stores each delivery (for idempotency and visibility in the WebhookEvent table) and
 * acknowledges it. Add real handling per field under "TODO" once the subscribed webhook fields are decided
 * (e.g. comments, mentions, messages) — see https://developers.facebook.com/docs/instagram-platform/webhooks.
 */
export async function processInstagramWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, requestId?: string | null): Promise<WebhookResult> {
  const header = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };

  if (!verifyMetaSignature(rawBody, header("x-hub-signature-256"))) {
    await auditSystem({ action: "META_WEBHOOK_REJECTED", category: "security", status: "denied", entityType: "Webhook", entityId: "instagram", requestId, details: { reason: "bad or missing signature" } });
    return { httpStatus: 401, body: { status: "error", message: "Invalid signature" } };
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { httpStatus: 400, body: { status: "error", message: "Invalid payload" } };
  }

  // One delivery can carry several entries; Meta does not send a single top-level delivery id, so key on a
  // hash of what was signed — the same delivery (and Meta's retries of it) then maps to one row.
  const eventKey = crypto.createHash("sha256").update(rawBody).digest("hex");
  const objectType = String(event?.object || "UNKNOWN");
  const entries = Array.isArray(event?.entry) ? event.entry : [];
  const fields = Array.from(new Set(entries.flatMap((e: any) => (Array.isArray(e?.changes) ? e.changes.map((c: any) => c.field) : []).concat(Array.isArray(e?.messaging) ? ["messaging"] : []))));

  let record = await prisma.webhookEvent
    .create({ data: { provider: "INSTAGRAM", providerEventId: eventKey, eventType: fields.join(",") || objectType, payload: event as any, status: "FAILED" } })
    .catch(async (error: any) => {
      if (error?.code !== "P2002") throw error;
      return null;
    });
  if (!record) {
    const existing = await prisma.webhookEvent.findUnique({ where: { provider_providerEventId: { provider: "INSTAGRAM", providerEventId: eventKey } } });
    if (existing?.processedAt && existing.status !== "FAILED") return { httpStatus: 200, body: { status: "duplicate" } };
    record = existing;
  }

  try {
    // TODO: act on `entries` per subscribed field (comments, mentions, messages, ...) once that is decided.
    // Each entry: { id: <ig business account id>, time, changes: [{ field, value }] } or { messaging: [...] }.
    if (record) await prisma.webhookEvent.update({ where: { id: record.id }, data: { status: "PROCESSED", processedAt: new Date() } });
    return { httpStatus: 200, body: { status: "ok" } };
  } catch (error: any) {
    console.error("[meta-webhook] processing failed:", error?.message || error);
    if (record) await prisma.webhookEvent.update({ where: { id: record.id }, data: { status: "FAILED" } }).catch(() => undefined);
    // 500 makes Meta deliver it again later (Meta retries for several hours on non-2xx).
    return { httpStatus: 500, body: { status: "error", message: "Could not process the event" } };
  }
}
