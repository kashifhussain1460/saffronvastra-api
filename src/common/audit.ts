import { Request } from "express";
import { prisma } from "../database/prisma.js";
import type { AuthenticatedRequest } from "./auth.middleware.js";
import { background } from "./background.js";

/**
 * Durable audit trail for staff changes and security events, written to `admin_audit_logs`.
 *
 * Rules:
 * - The actor comes from the server-side session (`req.user`), never from anything the client sends.
 * - Details pass through `redact()`: secrets, tokens and passwords never reach the table; long text is cut.
 * - Writing an audit row never breaks the action it describes, but a failure is logged loudly.
 * - The application only ever inserts: there is no update or delete path for audit rows.
 */

export type AuditCategory = "admin" | "security";
export type AuditStatus = "success" | "failure" | "denied";

export interface AuditEvent {
  action: string;
  entityType: string;
  entityId?: string | null;
  category?: AuditCategory;
  status?: AuditStatus;
  details?: unknown;
  /** For security events about an account that is not the signed-in one (e.g. a failed login). */
  actorUserId?: string | null;
}

const SECRET_KEY = /pass(word)?|token|secret|cookie|authorization|otp|hash|session/i;
const MAX_STRING = 500;
const MAX_KEYS = 60;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}... [${value.length} chars]` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => redact(v, depth + 1));
    return value.length > 50 ? [...items, `[${value.length - 50} more]`] : items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** An email address shown only partly, for security rows about accounts that may not exist. */
export function maskEmail(email: string | undefined | null): string | null {
  if (!email || !email.includes("@")) return null;
  const [name, domain] = email.toLowerCase().split("@");
  return `${name.slice(0, 2)}${"*".repeat(Math.max(1, name.length - 2))}@${domain}`;
}

/** Fields that changed between two snapshots, as { field: { before, after } }. */
export function changes(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined, fields: string[]) {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const f of fields) {
    const b = before?.[f];
    const a = after?.[f];
    if (JSON.stringify(b) !== JSON.stringify(a)) out[f] = { before: b ?? null, after: a ?? null };
  }
  return out;
}

export async function audit(req: Request, event: AuditEvent): Promise<void> {
  const user = (req as AuthenticatedRequest).user;
  try {
    await prisma.adminAuditLog.create({
      data: {
        action: event.action,
        category: event.category || "admin",
        status: event.status || "success",
        actorUserId: event.actorUserId !== undefined ? event.actorUserId : user?.id || null,
        actorRole: user ? (user.roles.includes("ADMIN") ? "ADMIN" : user.roles[0] || null) : null,
        entityType: event.entityType,
        entityId: event.entityId || "-",
        requestId: ((req as any).id as string) || null,
        ipAddress: req.ip || null,
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 300) : null,
        safeDiff: event.details === undefined ? undefined : (redact(event.details) as any),
      },
    });
  } catch (error: any) {
    console.error(`[AUDIT] could not record ${event.action} for ${event.entityType}:${event.entityId ?? "-"}: ${error?.message}`);
  }
}

/** Same table, for events with no browser request behind them (payment webhooks, background reconciliation). */
export async function auditSystem(event: Omit<AuditEvent, "actorUserId"> & { requestId?: string | null }): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        action: event.action,
        category: event.category || "admin",
        status: event.status || "success",
        actorUserId: null,
        actorRole: "SYSTEM",
        entityType: event.entityType,
        entityId: event.entityId || "-",
        requestId: event.requestId || null,
        safeDiff: event.details === undefined ? undefined : (redact(event.details) as any),
      },
    });
  } catch (error: any) {
    console.error(`[AUDIT] could not record ${event.action} for ${event.entityType}:${event.entityId ?? "-"}: ${error?.message}`);
  }
}

/**
 * Records every mutating request (POST/PUT/PATCH/DELETE) that reaches an admin router, after it has been answered:
 * success for 2xx/3xx, failure for 4xx/5xx. 401 and 403 are left to the security events written by the auth
 * middleware. Field names are always recorded; values only after redaction.
 */
export function auditAdminMutations(entityType: string) {
  return (req: Request, res: import("express").Response, next: import("express").NextFunction) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    let responseBody: any;
    const json = res.json.bind(res);
    res.json = ((body: any) => {
      responseBody = body;
      return json(body);
    }) as typeof res.json;
    res.on("finish", () => {
      if (res.statusCode === 401 || res.statusCode === 403) return;
      // e.g. PATCH /newsletter-campaigns/<id> -> NEWSLETTER_CAMPAIGNS_UPDATE; POST /<id>/publish -> ARTICLE_PUBLISH
      const segments = req.path.split("/").filter(Boolean);
      const isId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
      const id = segments.find(isId) || responseBody?.data?.id || null;
      const words = segments.filter((s) => !isId(s));
      const last = words[words.length - 1];
      const resource = words.length > 1 || (words.length === 1 && !ACTION_WORDS.has(words[0])) ? words[0] : null;
      const verb = last && ACTION_WORDS.has(last) ? last : { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" }[req.method]!;
      const subject = resource || entityType;
      const action = `${subject}_${verb}`.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^A-Za-z_]+/g, "_").toUpperCase();
      background(audit(req, {
        action,
        entityType: resource ? `${entityType}:${resource}` : entityType,
        entityId: id,
        status: res.statusCode < 400 ? "success" : "failure",
        details: {
          method: req.method,
          path: req.baseUrl + req.path,
          httpStatus: res.statusCode,
          fields: req.body && typeof req.body === "object" ? Object.keys(req.body) : [],
          values: req.body,
          ...(res.statusCode >= 400 ? { error: responseBody?.message || responseBody?.code } : {}),
        },
      }));
    });
    next();
  };
}

const ACTION_WORDS = new Set(["publish", "unpublish", "archive", "restore", "send", "test", "reply", "resend", "upload", "read", "read-all", "reorder", "status", "payment-status", "shipments", "notes"]);
