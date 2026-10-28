import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import crypto from "node:crypto";
import { z } from "zod";
import { AuthenticatedRequest, requireAdmin } from "../../common/auth.middleware.js";
import { AppError, sendError } from "../../common/errors.js";
import { resolveCartOwner } from "../cart/cart.service.js";
import { prisma } from "../../database/prisma.js";
import { MAX_UPLOAD_BYTES, publishBuffer } from "../../common/storage.js";
import {
  REASONS,
  applyStaffAction,
  createRequest,
  getEligibility,
  getRequestDetail,
  listRequests,
  withdrawRequest,
} from "./requests.service.js";

const testBypass = (req: Request) => process.env.NODE_ENV !== "production" && (process.env.NODE_ENV === "test" || req.headers["x-test-bypass-rate-limit"] === "true");

const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: testBypass,
  message: { status: "error", code: "RATE_LIMITED", message: "Too many requests. Please try again later." },
});
const eligibilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: testBypass,
  message: { status: "error", code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." },
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: testBypass,
  message: { status: "error", code: "RATE_LIMITED", message: "Too many uploads. Please try again later." },
});

// ---------------------------------------------------------------------------------------------------------------
// Evidence photos. Strict on purpose: the uploader is an anonymous or signed-in shopper, not staff.
//  - size and count limits; the type comes from the file's own bytes, never from the name or the declared mime type
//  - the stored name is random and its extension comes from the detected type
// ---------------------------------------------------------------------------------------------------------------
const MAX_EVIDENCE_BYTES = Math.min(5 * 1024 * 1024, MAX_UPLOAD_BYTES);
const MAX_EVIDENCE_LABEL = `${Math.round(MAX_EVIDENCE_BYTES / (1024 * 1024))} MB`;

function detectImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: ".jpg", mime: "image/jpeg" };
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: ".png", mime: "image/png" };
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return { ext: ".webp", mime: "image/webp" };
  return null;
}

const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 } });

export const requestEvidenceRouter = Router();
requestEvidenceRouter.post(
  "/evidence",
  uploadLimiter,
  (req: Request, res: Response, next) => {
    evidenceUpload.single("file")(req, res, (err: any) => {
      if (!err) return next();
      req.resume();
      if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ status: "error", code: "FILE_TOO_LARGE", message: `The photo is too large. The maximum size is ${MAX_EVIDENCE_LABEL}.` });
      return res.status(400).json({ status: "error", code: "UPLOAD_FAILED", message: "The photo could not be uploaded." });
    });
  },
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (req.user?.roles.includes("ADMIN")) throw new AppError(403, "FORBIDDEN", "Staff accounts cannot upload request photos.");
      // Only someone who has placed an order may upload. (Every visitor gets a guest id, so that alone proves nothing.)
      const owner = await resolveCartOwner(req);
      const owned = owner.userId || owner.guestProfileId
        ? await prisma.order.count({ where: { OR: [...(owner.userId ? [{ userId: owner.userId }] : []), ...(owner.guestProfileId ? [{ guestProfileId: owner.guestProfileId }] : [])] } })
        : 0;
      if (owned === 0) throw new AppError(401, "UNAUTHORIZED", "Photos can be attached to a request for one of your orders.");
      const file = req.file;
      if (!file) throw new AppError(400, "NO_FILE", "Choose a photo to upload.");
      const kind = detectImage(file.buffer);
      if (!kind) throw new AppError(400, "UNSUPPORTED_FILE", "Only JPEG, PNG or WebP photos are accepted.");
      const name = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${kind.ext}`;
      const stored = await publishBuffer("requests", name, file.buffer, kind.mime);
      return res.status(201).json({ status: "success", data: { url: stored.url } });
    } catch (error) {
      return sendError(res, error, "request-evidence");
    }
  }
);

// ---------------------------------------------------------------------------------------------------------------
// Customer: /orders/:id/requests...
// ---------------------------------------------------------------------------------------------------------------
const createSchema = z.object({
  type: z.enum(["CANCELLATION", "RETURN", "EXCHANGE"]),
  reasonCode: z.enum(REASONS),
  details: z.string().trim().max(1000, "Details can be at most 1000 characters").optional().nullable(),
  items: z
    .array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().min(1).max(50), exchangeSize: z.string().trim().max(20).optional().nullable() }))
    .max(50)
    .optional(),
  evidence: z.array(z.string().regex(/^(\/uploads\/requests\/|https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/uploads\/requests\/)[A-Za-z0-9._-]+$/, "Invalid photo")).max(5).optional(),
});

// Limiters are attached to each route: this router is mounted at /orders next to the ordinary order routes.
export const orderRequestsRouter = Router();

orderRequestsRouter.get("/:id/requests/eligibility", eligibilityLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = await resolveCartOwner(req);
    return res.status(200).json({ status: "success", data: await getEligibility(String(req.params.id), owner) });
  } catch (error) {
    return sendError(res, error, "request-eligibility");
  }
});

orderRequestsRouter.post("/:id/requests", requestLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.roles.includes("ADMIN")) throw new AppError(403, "ADMIN_CANNOT_ORDER", "Staff accounts cannot raise customer requests.");
    const body = createSchema.parse(req.body);
    const owner = await resolveCartOwner(req);
    const request = await createRequest(String(req.params.id), owner, body, req.user?.id || null);
    return res.status(201).json({ status: "success", data: request });
  } catch (error) {
    return sendError(res, error, "request-create");
  }
});

orderRequestsRouter.post("/:id/requests/:requestId/withdraw", requestLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = await resolveCartOwner(req);
    const request = await withdrawRequest(String(req.params.id), String(req.params.requestId), owner, req.user?.id || null);
    return res.status(200).json({ status: "success", data: request });
  } catch (error) {
    return sendError(res, error, "request-withdraw");
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Staff: /admin/requests
// ---------------------------------------------------------------------------------------------------------------
export const adminRequestsRouter = Router();
adminRequestsRouter.use(requireAdmin);

adminRequestsRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const data = await listRequests({ status: q.status, type: q.type, search: q.search, page: Number(q.page) || 1, limit: Number(q.limit) || 20 });
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    return sendError(res, error, "request-list");
  }
});

adminRequestsRouter.get("/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.status(200).json({ status: "success", data: await getRequestDetail(String(req.params.id)) });
  } catch (error) {
    return sendError(res, error, "request-detail");
  }
});

const actionSchema = z.object({
  note: z.string().trim().max(1000).optional().nullable(),
  returnShippingPayer: z.enum(["CUSTOMER", "SELLER"]).optional().nullable(),
  resolution: z.enum(["REFUND", "EXCHANGE"]).optional().nullable(),
});

for (const action of ["approve", "reject", "receive", "complete"] as const) {
  adminRequestsRouter.post(`/:id/${action}`, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = actionSchema.parse(req.body || {});
      const updated = await applyStaffAction(String(req.params.id), action, body, req.user!.id);
      return res.status(200).json({ status: "success", data: await getRequestDetail(updated.id) });
    } catch (error) {
      return sendError(res, error, `request-${action}`);
    }
  });
}
