import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAdmin } from "../../common/auth.middleware.js";

// Read-only access to the audit trail. There is deliberately no update or delete route.
export const adminAuditRouter = Router();
adminAuditRouter.use(requireAdmin);

const querySchema = z.object({
  search: z.string().trim().max(200).optional(),
  category: z.enum(["admin", "security"]).optional(),
  status: z.enum(["success", "failure", "denied"]).optional(),
  entityType: z.string().trim().max(80).optional(),
  actorUserId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  to: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

async function buildWhere(q: z.infer<typeof querySchema>) {
  const where: any = {};
  if (q.category) where.category = q.category;
  if (q.status) where.status = q.status;
  if (q.entityType) where.entityType = { startsWith: q.entityType };
  if (q.actorUserId) where.actorUserId = q.actorUserId;
  if (q.from || q.to) {
    where.createdAt = {};
    if (q.from) where.createdAt.gte = new Date(q.from);
    if (q.to) where.createdAt.lte = /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? new Date(`${q.to}T23:59:59.999Z`) : new Date(q.to);
  }
  if (q.search) {
    const actors = await prisma.user.findMany({ where: { email: { contains: q.search, mode: "insensitive" } }, select: { id: true }, take: 50 });
    where.OR = [
      { action: { contains: q.search.replace(/\s+/g, "_"), mode: "insensitive" } },
      { entityId: { contains: q.search, mode: "insensitive" } },
      { requestId: { contains: q.search, mode: "insensitive" } },
      ...(actors.length ? [{ actorUserId: { in: actors.map((a) => a.id) } }] : []),
    ];
  }
  return where;
}

async function withActors<T extends { actorUserId: string | null }>(rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.actorUserId).filter(Boolean))] as string[];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } }) : [];
  const email = new Map(users.map((u) => [u.id, u.email]));
  return rows.map((r) => ({ ...r, actorEmail: r.actorUserId ? email.get(r.actorUserId) || null : null }));
}

adminAuditRouter.get("/", async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ status: "error", code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message || "Invalid filter" });
  const q = parsed.data;
  try {
    const where = await buildWhere(q);
    const [total, rows, categories] = await Promise.all([
      prisma.adminAuditLog.count({ where }),
      prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.limit, take: q.limit }),
      prisma.adminAuditLog.groupBy({ by: ["entityType"], _count: { _all: true }, orderBy: { entityType: "asc" } }),
    ]);
    return res.status(200).json({
      status: "success",
      items: await withActors(rows),
      entityTypes: categories.map((c) => ({ entityType: c.entityType, count: c._count._all })),
      pagination: { total, page: q.page, limit: q.limit, totalPages: Math.ceil(total / q.limit) },
    });
  } catch (error) {
    console.error("[audit-logs]", error);
    return res.status(500).json({ status: "error", message: "The activity log could not be loaded." });
  }
});

adminAuditRouter.get("/export.csv", async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ status: "error", code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message || "Invalid filter" });
  const where = await buildWhere(parsed.data);
  const rows = await withActors(await prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 5000 }));
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["Time (UTC)", "Category", "Action", "Status", "Actor", "Role", "Entity", "Entity id", "Request id", "IP"].map(cell).join(","),
    ...rows.map((r) => [r.createdAt.toISOString(), r.category, r.action, r.status, r.actorEmail || r.actorUserId || "", r.actorRole || "", r.entityType, r.entityId, r.requestId || "", r.ipAddress || ""].map(cell).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="activity-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.status(200).send(lines.join("\n"));
});

adminAuditRouter.get("/:id", async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ status: "error", message: "Entry not found" });
  const row = await prisma.adminAuditLog.findUnique({ where: { id } });
  if (!row) return res.status(404).json({ status: "error", message: "Entry not found" });
  const [withActor] = await withActors([row]);
  return res.status(200).json({ status: "success", data: withActor });
});
