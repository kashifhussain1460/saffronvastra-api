import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAdmin, requireAuth, AuthenticatedRequest } from "../../common/auth.middleware.js";

const REVIEW_STATUSES = ["Pending", "Approved", "Rejected"] as const;

const idParam = (req: Request) => (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
const slugParam = (req: Request) => (Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug);

function paging(req: Request, defaultLimit: number) {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? String(defaultLimit)), 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function validationError(res: Response, error: z.ZodError) {
  return res.status(400).json({
    status: "error",
    message: error.issues[0]?.message || "Please check the form and try again.",
    errors: error.flatten().fieldErrors,
  });
}

// Real numbers only: average and count of Approved reviews. A product with none has average null.
export async function approvedReviewStats(productIds: string[]) {
  const stats = new Map<string, { count: number; average: number | null }>();
  if (productIds.length === 0) return stats;
  const grouped = await prisma.review.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds }, status: "Approved" },
    _count: { _all: true },
    _avg: { rating: true },
  });
  for (const g of grouped) {
    stats.set(g.productId, { count: g._count._all, average: g._avg.rating === null ? null : Math.round(g._avg.rating * 10) / 10 });
  }
  return stats;
}

// Replaces the stored (never reviewer-derived) rating columns with the real approved aggregates.
export async function withRealRatings<T extends { id: string }>(products: T[]): Promise<Array<T & { rating: number | null; reviewsCount: number }>> {
  const stats = await approvedReviewStats(products.map((p) => p.id));
  return products.map((p) => {
    const s = stats.get(p.id);
    return { ...p, rating: s?.average ?? null, reviewsCount: s?.count ?? 0 };
  });
}

// "Ananya Sen" is shown as "Ananya S." so a review never exposes a full name or email.
function publicName(displayName: string | null | undefined) {
  const parts = (displayName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Verified customer";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

// ---------------------------------------------------------------------------
// Public: approved reviews of a product
// ---------------------------------------------------------------------------

export const publicReviewsRouter = Router();

publicReviewsRouter.get("/product/:slug", async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findUnique({ where: { slug: slugParam(req) }, select: { id: true, status: true, deletedAt: true } });
    if (!product || product.deletedAt || product.status !== "Active") {
      return res.status(404).json({ status: "error", message: "Product not found" });
    }
    const { page, limit, skip } = paging(req, 10);
    const where = { productId: product.id, status: "Approved" };
    const [grouped, total, rows] = await Promise.all([
      prisma.review.groupBy({ by: ["rating"], where, _count: { _all: true } }),
      prisma.review.count({ where }),
      prisma.review.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: limit,
        include: { user: { select: { profile: { select: { displayName: true } } } } },
      }),
    ]);
    const distribution: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    let sum = 0;
    for (const g of grouped) {
      distribution[String(g.rating)] = g._count._all;
      sum += g.rating * g._count._all;
    }
    const count = Object.values(distribution).reduce((a, b) => a + b, 0);
    return res.status(200).json({
      status: "success",
      data: { count, average: count ? Math.round((sum / count) * 10) / 10 : null, distribution },
      items: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        reply: r.reply,
        author: publicName(r.user?.profile?.displayName),
        createdAt: r.createdAt,
      })),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("[reviews] public list failed", error);
    return res.status(500).json({ status: "error", message: "Reviews could not be loaded." });
  }
});

// ---------------------------------------------------------------------------
// Customer: my reviews
// ---------------------------------------------------------------------------

export const myReviewsRouter = Router();
myReviewsRouter.use(requireAuth);

const ratingField = z
  .number({ required_error: "Choose a rating from 1 to 5", invalid_type_error: "Rating must be a whole number from 1 to 5" })
  .int("Rating must be a whole number from 1 to 5")
  .min(1, "Rating must be between 1 and 5")
  .max(5, "Rating must be between 1 and 5");
const titleField = z
  .string()
  .trim()
  .max(100, "Title must be 100 characters or fewer")
  .optional()
  .nullable();
const bodyField = z
  .string({ required_error: "Write your review" })
  .trim()
  .min(10, "Your review must be at least 10 characters")
  .max(2000, "Your review must be 2000 characters or fewer");

const createSchema = z
  .object({
    productId: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1).optional(),
    rating: ratingField,
    title: titleField,
    body: bodyField,
  })
  .refine((v) => v.productId || v.slug, { message: "Choose the product to review", path: ["productId"] });
const updateSchema = z.object({ rating: ratingField.optional(), title: titleField, body: bodyField.optional() });

async function hasDeliveredPurchase(userId: string, product: { id: string; slug: string }) {
  const found = await prisma.order.findFirst({
    where: {
      userId,
      status: "Delivered",
      items: { some: { OR: [{ productVariant: { is: { productId: product.id } } }, { productSlug: product.slug }] } },
    },
    select: { id: true },
  });
  return Boolean(found);
}

const mine = (r: any) => ({
  id: r.id,
  productId: r.productId,
  rating: r.rating,
  title: r.title,
  body: r.body,
  status: r.status,
  reply: r.status === "Approved" ? r.reply : null,
  createdAt: r.createdAt,
  product: r.product ? { id: r.product.id, title: r.product.title, slug: r.product.slug, image: r.product.images?.[0]?.url ?? null } : undefined,
});

myReviewsRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.review.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      include: { product: { select: { id: true, title: true, slug: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } } } } },
    });
    return res.status(200).json({ status: "success", items: rows.map(mine) });
  } catch (error) {
    console.error("[reviews] mine failed", error);
    return res.status(500).json({ status: "error", message: "Your reviews could not be loaded." });
  }
});

// Whether this person may write a review of a product right now, and if not, why.
myReviewsRouter.get("/eligibility/:slug", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const product = await prisma.product.findUnique({ where: { slug: slugParam(req) }, select: { id: true, slug: true, status: true, deletedAt: true } });
    if (!product || product.deletedAt || product.status !== "Active") {
      return res.status(404).json({ status: "error", message: "Product not found" });
    }
    const existing = await prisma.review.findUnique({ where: { productId_userId: { productId: product.id, userId: req.user!.id } } });
    if (existing) return res.status(200).json({ status: "success", data: { canReview: false, reason: "reviewed", review: mine(existing) } });
    const purchased = await hasDeliveredPurchase(req.user!.id, product);
    return res.status(200).json({
      status: "success",
      data: purchased ? { canReview: true, reason: null } : { canReview: false, reason: "not-purchased" },
    });
  } catch (error) {
    console.error("[reviews] eligibility failed", error);
    return res.status(500).json({ status: "error", message: "Could not check whether you can review this piece." });
  }
});

myReviewsRouter.post("/", async (req: AuthenticatedRequest, res: Response) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);
  const d = parsed.data;
  try {
    const product = await prisma.product.findFirst({
      where: d.productId ? { id: d.productId } : { slug: d.slug },
      select: { id: true, slug: true, status: true, deletedAt: true },
    });
    if (!product || product.deletedAt || product.status !== "Active") {
      return res.status(404).json({ status: "error", message: "Product not found" });
    }
    if (!(await hasDeliveredPurchase(req.user!.id, product))) {
      return res.status(403).json({ status: "error", code: "NOT_A_PURCHASER", message: "Only customers who received this piece can review it." });
    }
    const existing = await prisma.review.findUnique({ where: { productId_userId: { productId: product.id, userId: req.user!.id } } });
    if (existing) {
      return res.status(409).json({ status: "error", code: "ALREADY_REVIEWED", message: "You have already reviewed this piece. You can edit your review from My Reviews." });
    }
    const created = await prisma.review.create({
      data: { productId: product.id, userId: req.user!.id, rating: d.rating, title: d.title?.trim() || null, body: d.body },
    });
    return res.status(201).json({ status: "success", message: "Thanks, your review will appear after moderation", data: mine(created) });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return res.status(409).json({ status: "error", code: "ALREADY_REVIEWED", message: "You have already reviewed this piece. You can edit your review from My Reviews." });
    }
    console.error("[reviews] create failed", error);
    return res.status(500).json({ status: "error", message: "Your review could not be saved. Please try again." });
  }
});

// Someone else's review looks exactly like one that does not exist.
async function ownReview(req: AuthenticatedRequest) {
  return prisma.review.findFirst({ where: { id: idParam(req), userId: req.user!.id } });
}

myReviewsRouter.patch("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);
  const existing = await ownReview(req);
  if (!existing) return res.status(404).json({ status: "error", message: "Review not found" });
  const d = parsed.data;
  const updated = await prisma.review.update({
    where: { id: existing.id },
    data: {
      ...(d.rating !== undefined ? { rating: d.rating } : {}),
      ...(d.title !== undefined ? { title: d.title?.trim() || null } : {}),
      ...(d.body !== undefined ? { body: d.body } : {}),
      // An edited review is read again before it is shown.
      status: "Pending",
      moderatedAt: null,
      moderatedByUserId: null,
    },
  });
  return res.status(200).json({ status: "success", message: "Thanks, your review will appear after moderation", data: mine(updated) });
});

myReviewsRouter.delete("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const existing = await ownReview(req);
  if (!existing) return res.status(404).json({ status: "error", message: "Review not found" });
  await prisma.review.delete({ where: { id: existing.id } });
  return res.status(200).json({ status: "success" });
});

// ---------------------------------------------------------------------------
// Admin: moderation
// ---------------------------------------------------------------------------

export const adminReviewsRouter = Router();
adminReviewsRouter.use(requireAdmin);

const replySchema = z.object({
  reply: z
    .string({ required_error: "Write your reply first" })
    .trim()
    .min(1, "Write your reply first")
    .max(1000, "A reply can be at most 1000 characters"),
});

const adminShape = (r: any) => ({
  id: r.id,
  rating: r.rating,
  title: r.title,
  body: r.body,
  status: r.status,
  reply: r.reply,
  createdAt: r.createdAt,
  moderatedAt: r.moderatedAt,
  product: r.product ? { id: r.product.id, title: r.product.title, slug: r.product.slug } : null,
  customer: r.user ? { id: r.user.id, email: r.user.email, name: r.user.profile?.displayName ?? null } : null,
});

const adminInclude = {
  product: { select: { id: true, title: true, slug: true } },
  user: { select: { id: true, email: true, profile: { select: { displayName: true } } } },
};

adminReviewsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = paging(req, 15);
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const ratingRaw = typeof req.query.rating === "string" ? req.query.rating : "";
    if (status && !(REVIEW_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ status: "error", message: "Status must be Pending, Approved or Rejected" });
    }
    const where: any = status ? { status } : {};
    if (ratingRaw) {
      const rating = Number(ratingRaw);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ status: "error", message: "Rating must be a whole number from 1 to 5" });
      }
      where.rating = rating;
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { body: { contains: search, mode: "insensitive" } },
        { product: { title: { contains: search, mode: "insensitive" } } },
        { user: { email: { contains: search, mode: "insensitive" } } },
      ];
    }
    const [total, rows, grouped] = await Promise.all([
      prisma.review.count({ where }),
      prisma.review.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit, include: adminInclude }),
      prisma.review.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const counts: Record<string, number> = { Pending: 0, Approved: 0, Rejected: 0 };
    for (const g of grouped) counts[g.status] = g._count._all;
    return res.status(200).json({
      status: "success",
      items: rows.map(adminShape),
      counts,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("[reviews] admin list failed", error);
    return res.status(500).json({ status: "error", message: "The reviews could not be loaded." });
  }
});

// Reviews are kept: a review that should not show is Rejected, never deleted.
adminReviewsRouter.patch("/:id", async (req: AuthenticatedRequest, res: Response) => {
  const status = req.body?.status;
  if (typeof status !== "string" || !(REVIEW_STATUSES as readonly string[]).includes(status)) {
    return res.status(400).json({ status: "error", message: "Status must be Pending, Approved or Rejected" });
  }
  const id = idParam(req);
  const existing = await prisma.review.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return res.status(404).json({ status: "error", message: "Review not found" });
  const updated = await prisma.review.update({
    where: { id },
    data: status === "Pending" ? { status, moderatedAt: null, moderatedByUserId: null } : { status, moderatedAt: new Date(), moderatedByUserId: req.user!.id },
    include: adminInclude,
  });
  return res.status(200).json({ status: "success", data: adminShape(updated) });
});

adminReviewsRouter.post("/:id/reply", async (req: AuthenticatedRequest, res: Response) => {
  const parsed = replySchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);
  const id = idParam(req);
  const existing = await prisma.review.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return res.status(404).json({ status: "error", message: "Review not found" });
  const updated = await prisma.review.update({
    where: { id },
    data: { reply: parsed.data.reply, moderatedByUserId: req.user!.id },
    include: adminInclude,
  });
  return res.status(200).json({ status: "success", data: adminShape(updated) });
});
