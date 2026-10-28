import crypto from "crypto";
import { env } from "../../config/env.js";

/**
 * Thin client for the Cashfree Payment Gateway REST API (https://www.cashfree.com/docs). No SDK: plain fetch with a
 * timeout. The secret key stays in this file and in the request headers; it is never logged or returned.
 */

export const cashfreeConfigured = () => Boolean(env.CASHFREE_APP_ID && env.CASHFREE_SECRET_KEY);

const baseUrl = () => {
  if (env.NODE_ENV !== "production" && env.CASHFREE_BASE_URL_OVERRIDE) return env.CASHFREE_BASE_URL_OVERRIDE.replace(/\/$/, "");
  return env.CASHFREE_ENV === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
};

export class CashfreeError extends Error {
  status: number;
  code: string;
  /** true when we do not know whether Cashfree acted on the request (timeout, network failure) */
  unknownOutcome: boolean;
  constructor(message: string, status: number, code: string, unknownOutcome = false) {
    super(message);
    this.name = "CashfreeError";
    this.status = status;
    this.code = code;
    this.unknownOutcome = unknownOutcome;
  }
}

async function call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  if (!cashfreeConfigured()) throw new CashfreeError("Online payment is not configured", 503, "NOT_CONFIGURED");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-client-id": env.CASHFREE_APP_ID as string,
        "x-client-secret": env.CASHFREE_SECRET_KEY as string,
        "x-api-version": env.CASHFREE_API_VERSION,
        ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      // Cashfree error bodies look like { message, code, type }. Only these two short fields are kept.
      const code = String(json?.code || json?.type || res.status).slice(0, 60);
      const message = String(json?.message || "Payment provider rejected the request").slice(0, 200);
      throw new CashfreeError(message, res.status, code, res.status >= 500);
    }
    return json as T;
  } catch (error: any) {
    if (error instanceof CashfreeError) throw error;
    throw new CashfreeError(
      error?.name === "AbortError" ? "Payment provider timed out" : "Payment provider could not be reached",
      504,
      "NETWORK",
      true
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---- amounts: we store paise (integers); Cashfree speaks rupees with at most two decimals ----
export const toRupees = (minor: number) => Number((minor / 100).toFixed(2));
export const toMinorUnits = (rupees: unknown) => Math.round(Number(rupees) * 100);

export interface CfOrder {
  cf_order_id?: string | number;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED" | "TERMINATION_REQUESTED" | string;
  payment_session_id?: string;
}

export interface CfPayment {
  cf_payment_id: string | number;
  payment_status: "SUCCESS" | "FAILED" | "PENDING" | "NOT_ATTEMPTED" | "USER_DROPPED" | "CANCELLED" | "VOID" | string;
  payment_amount: number;
  payment_currency: string;
  payment_message?: string;
  payment_time?: string;
}

export interface CfRefund {
  cf_refund_id?: string | number;
  refund_id: string;
  order_id?: string;
  refund_amount?: number;
  refund_status: "SUCCESS" | "PENDING" | "PENDING_APPROVAL" | "CANCELLED" | "ONHOLD" | "REJECTED" | "FAILED" | string;
  status_description?: string;
}

export function createOrder(input: {
  orderId: string;
  amountMinor: number;
  customerId: string;
  customerPhone: string;
  customerEmail?: string | null;
  customerName?: string | null;
  returnUrl: string;
  notifyUrl?: string | null;
  note?: string;
  idempotencyKey: string;
}) {
  return call<CfOrder>(
    "POST",
    "/orders",
    {
      order_id: input.orderId,
      order_amount: toRupees(input.amountMinor),
      order_currency: "INR",
      customer_details: {
        customer_id: input.customerId,
        customer_phone: input.customerPhone,
        ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
        ...(input.customerName ? { customer_name: input.customerName } : {}),
      },
      order_meta: { return_url: input.returnUrl, ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}) },
      ...(input.note ? { order_note: input.note.slice(0, 200) } : {}),
    },
    input.idempotencyKey
  );
}

export const terminateOrder = (orderId: string) => call<CfOrder>("PATCH", `/orders/${encodeURIComponent(orderId)}`, { order_status: "TERMINATED" });

export const getOrder = (orderId: string) => call<CfOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);

export const getOrderPayments = (orderId: string) => call<CfPayment[]>("GET", `/orders/${encodeURIComponent(orderId)}/payments`);

export function createRefund(orderId: string, input: { refundId: string; amountMinor: number; note?: string }, idempotencyKey: string) {
  return call<CfRefund>(
    "POST",
    `/orders/${encodeURIComponent(orderId)}/refunds`,
    {
      refund_id: input.refundId,
      refund_amount: toRupees(input.amountMinor),
      ...(input.note ? { refund_note: input.note.slice(0, 100) } : {}),
      refund_speed: "STANDARD",
    },
    idempotencyKey
  );
}

export const getRefund = (orderId: string, refundId: string) =>
  call<CfRefund>("GET", `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`);

/**
 * Cashfree signs every webhook: base64( HMAC-SHA256( secret, timestamp + rawBody ) ) in `x-webhook-signature`, with the
 * timestamp in `x-webhook-timestamp`. The raw bytes of the body are used exactly as received.
 */
export function verifyWebhookSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined, secret = env.CASHFREE_SECRET_KEY): boolean {
  if (!secret || !timestamp || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(timestamp + rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Test helper: builds the signature Cashfree would send. Used by the automated tests only. */
export function signWebhookForTests(rawBody: string, timestamp: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
}
