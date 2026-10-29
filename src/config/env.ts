import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("4000").transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_DATABASE_URL: z.string().min(1, "APP_DATABASE_URL is required"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  COOKIE_SECRET: z.string().optional(),
  // Which proxies may set X-Forwarded-For (Express "trust proxy"). The storefront proxies the API from the same host.
  TRUST_PROXY: z.string().default("loopback"),
  // Administrator sessions are shorter than customer sessions (hours).
  ADMIN_SESSION_MAX_AGE_HOURS: z.string().default("12").transform((val) => parseInt(val, 10)),
  SESSION_MAX_AGE_DAYS: z.string().default("30").transform((val) => parseInt(val, 10)),

  // Email. Without SMTP_HOST nothing is sent: every message is still recorded and shown in the admin email log.
  APP_URL: z.string().default("http://localhost:3000"), // public address of the storefront, used in email links
  // Sender. When EMAIL_FROM is empty it is built from SMTP_FROM_NAME and SMTP_FROM_EMAIL (or the SMTP login).
  EMAIL_FROM: z.string().optional(),
  SMTP_FROM_NAME: z.string().optional(),
  SMTP_FROM_EMAIL: z.string().optional(),
  ADMIN_NOTIFY_EMAIL: z.string().optional(), // receives new-order and new-message alerts
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().default("587").transform((val) => parseInt(val, 10)),
  SMTP_SECURE: z.string().default("false").transform((val) => val === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // ssl (implicit TLS, port 465) | tls or starttls (port 587) | none. SMTP_SECURTIY is the misspelling found in a .env.
  SMTP_SECURITY: z.string().optional(),
  SMTP_SECURTIY: z.string().optional(),

  // Online payments (Cashfree). Without CASHFREE_APP_ID and CASHFREE_SECRET_KEY online payment is not offered at all;
  // Cash on Delivery keeps working. The secret key also signs Cashfree's webhooks, so it is never sent to the browser.
  CASHFREE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  CASHFREE_APP_ID: z.string().optional(),
  CASHFREE_SECRET_KEY: z.string().optional(),
  CASHFREE_API_VERSION: z.string().default("2026-01-01"),
  // Public https address of THIS api, used as the webhook (notify) url. Leave empty on a local machine: Cashfree needs
  // https there, and the order status is then confirmed by the server-side check instead.
  PUBLIC_API_URL: z.string().optional(),
  // Test hook for the automated tests: send Cashfree calls to a local fake instead. Ignored in production.
  CASHFREE_BASE_URL_OVERRIDE: z.string().optional(),

  // Vercel. BLOB_READ_WRITE_TOKEN (added by connecting a Vercel Blob store) makes uploads go to Blob storage instead of
  // the local disk, which does not persist there. CRON_SECRET protects the scheduled-job endpoints: Vercel sends it as
  // "Authorization: Bearer <CRON_SECRET>" on every cron call.
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  VERCEL: z.string().optional(), // set to "1" by Vercel itself
});

const parsed = envSchema.parse(process.env);

if (parsed.NODE_ENV === "production" && parsed.CASHFREE_BASE_URL_OVERRIDE) {
  throw new Error("CASHFREE_BASE_URL_OVERRIDE must not be set when NODE_ENV is production");
}
if (parsed.NODE_ENV === "production" && parsed.CASHFREE_APP_ID && parsed.CASHFREE_ENV === "sandbox") {
  console.warn("[payments] CASHFREE_ENV is sandbox while NODE_ENV is production: no real money will move.");
}

// There is no built-in cookie secret in production: the server refuses to start without one.
if (parsed.NODE_ENV === "production" && !parsed.COOKIE_SECRET) {
  throw new Error("COOKIE_SECRET must be set when NODE_ENV is production");
}

export const env = {
  ...parsed,
  ON_VERCEL: Boolean(parsed.VERCEL),
  COOKIE_SECRET: parsed.COOKIE_SECRET || "development-only-cookie-secret-not-for-production",
};
