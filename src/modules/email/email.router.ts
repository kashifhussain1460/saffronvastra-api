import { Router, Request, Response } from "express";
import { prisma } from "../../database/prisma.js";
import { requireAdmin, AuthenticatedRequest } from "../../common/auth.middleware.js";
import { TEMPLATE_NAMES, TemplateName, renderSample } from "./email.templates.js";
import { devSinkEnabled, emailStatus, readDevSink, resendStoredEmail, sendEmail } from "./email.service.js";

// Admin: the log of every email, previews, and a test send.
export const adminEmailRouter = Router();
adminEmailRouter.use(requireAdmin);

const STATUSES = ["Pending", "Sent", "Failed", "Skipped"];

adminEmailRouter.get("/status", (_req: Request, res: Response) => {
  res.status(200).json({ status: "success", data: { ...emailStatus(), templates: TEMPLATE_NAMES } });
});

// Only outside production: recent full messages (with working links) for testing.
adminEmailRouter.get("/dev-sink", (req: Request, res: Response) => {
  if (!devSinkEnabled()) return res.status(404).json({ status: "error", message: "Not found" });
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  return res.status(200).json({ status: "success", items: readDevSink(to) });
});

adminEmailRouter.get("/", async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const template = typeof req.query.template === "string" ? req.query.template : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ status: "error", message: "Status must be Pending, Sent, Failed or Skipped" });
  }
  const where: any = {};
  if (status) where.status = status;
  if (template) where.template = template;
  if (search) where.OR = [{ to: { contains: search, mode: "insensitive" } }, { subject: { contains: search, mode: "insensitive" } }, { relatedId: { contains: search, mode: "insensitive" } }];

  const [total, items] = await Promise.all([
    prisma.emailMessage.count({ where }),
    prisma.emailMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: { id: true, to: true, template: true, subject: true, status: true, error: true, attempts: true, relatedId: true, sensitive: true, createdAt: true, sentAt: true },
    }),
  ]);
  return res.status(200).json({ status: "success", items, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

adminEmailRouter.get("/:id", async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const record = await prisma.emailMessage.findUnique({ where: { id } });
  if (!record) return res.status(404).json({ status: "error", message: "Email not found" });
  return res.status(200).json({ status: "success", data: record });
});

adminEmailRouter.post("/:id/resend", async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const result = await resendStoredEmail(id);
  if ("error" in result) {
    const map = {
      "not-found": [404, "Email not found"],
      sensitive: [409, "This message holds a private link and cannot be sent again from the log"],
      "already-sent": [409, "This message was already sent"],
    } as const;
    const [code, message] = map[(result as { error: keyof typeof map }).error];
    return res.status(code).json({ status: "error", message });
  }
  return res.status(200).json({ status: "success", data: result.record });
});

// Sends a sample of one template to an address, to check the provider and see the design.
adminEmailRouter.post("/test", async (req: AuthenticatedRequest, res: Response) => {
  const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
  const template = req.body?.template as TemplateName;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ status: "error", message: "Enter a valid email address" });
  }
  if (!TEMPLATE_NAMES.includes(template)) {
    return res.status(400).json({ status: "error", message: "Unknown template" });
  }
  const message = renderSample(template, req.user?.email || "an administrator");
  const record = await sendEmail({ to, template, message, relatedId: "test" });
  return res.status(201).json({ status: "success", data: record });
});
