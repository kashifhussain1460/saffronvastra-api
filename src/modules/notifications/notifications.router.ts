import { Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { AuthenticatedRequest, requireAdmin, requireAuth } from "../../common/auth.middleware.js";

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unread: z.enum(["true", "false"]).optional(),
});

// Both feeds share one implementation: they only ever touch rows owned by the signed-in user.
function feedRouter(guard: any) {
  const router = Router();
  router.use(guard);

  router.get("/", async (req: AuthenticatedRequest, res: Response) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ status: "error", message: "Invalid query parameters" });
    const { page, limit, unread } = parsed.data;
    const userId = req.user!.id;
    try {
      const where = { userId, ...(unread === "true" ? { readAt: null } : {}) };
      const [items, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { userId, readAt: null } }),
      ]);
      return res.status(200).json({
        status: "success",
        items,
        unreadCount,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      });
    } catch (error) {
      console.error("[notifications] list failed", error);
      return res.status(500).json({ status: "error", message: "Could not load notifications" });
    }
  });

  router.get("/unread-count", async (req: AuthenticatedRequest, res: Response) => {
    try {
      const unreadCount = await prisma.notification.count({ where: { userId: req.user!.id, readAt: null } });
      return res.status(200).json({ status: "success", data: { unreadCount } });
    } catch (error) {
      return res.status(500).json({ status: "error", message: "Could not load notifications" });
    }
  });

  router.post("/read-all", async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await prisma.notification.updateMany({
        where: { userId: req.user!.id, readAt: null },
        data: { readAt: new Date() },
      });
      return res.status(200).json({ status: "success", data: { updated: result.count } });
    } catch (error) {
      return res.status(500).json({ status: "error", message: "Could not update notifications" });
    }
  });

  router.patch("/:id/read", async (req: AuthenticatedRequest, res: Response) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ status: "error", message: "Notification not found" });
    try {
      // Scoped to the owner: someone else's id is indistinguishable from a missing one.
      const result = await prisma.notification.updateMany({
        where: { id: id.data, userId: req.user!.id, readAt: null },
        data: { readAt: new Date() },
      });
      const found = result.count
        ? true
        : !!(await prisma.notification.findFirst({ where: { id: id.data, userId: req.user!.id }, select: { id: true } }));
      if (!found) return res.status(404).json({ status: "error", message: "Notification not found" });
      return res.status(200).json({ status: "success", message: "Marked as read" });
    } catch (error) {
      return res.status(500).json({ status: "error", message: "Could not update notification" });
    }
  });

  return router;
}

export const myNotificationsRouter = feedRouter(requireAuth);
export const adminNotificationsRouter = feedRouter(requireAdmin);
