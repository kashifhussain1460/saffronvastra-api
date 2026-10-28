import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAdmin, AuthenticatedRequest } from "../../common/auth.middleware.js";

const ARTICLE_STATUSES = ["Draft", "Published", "Archived"] as const;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const idParam = (req: Request) => (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
const slugParam = (req: Request) => (Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug);

function paging(req: Request, defaultLimit = 12) {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? String(defaultLimit)), 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function validationError(res: Response, error: z.ZodError) {
  return res.status(400).json({
    status: "error",
    message: error.issues[0]?.message || "Please check the form and try again.",
    errors: error.flatten().fieldErrors,
  });
}

const readMinutes = (body: string) => Math.max(1, Math.round(body.trim().split(/\s+/).filter(Boolean).length / 200));

// A cover image is a site path (media library or /images/...) or an http(s) address. Nothing else.
const coverImageField = z
  .string()
  .trim()
  .max(500, "Cover image address is too long")
  .refine((v) => v === "" || (v.startsWith("/") && !v.startsWith("//")) || /^https?:\/\/\S+$/i.test(v), "Cover image must be a site path such as /images/... or an http(s) address")
  .optional()
  .nullable();

const optionalText = (label: string, max: number) =>
  z.string().trim().max(max, `${label} must be ${max} characters or fewer`).optional().nullable();

const articleShape = {
  title: z
    .string({ required_error: "Title is required" })
    .trim()
    .min(3, "Title must be at least 3 characters")
    .max(150, "Title must be 150 characters or fewer"),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(100, "Slug must be 100 characters or fewer")
    .refine((v) => v === "" || SLUG_PATTERN.test(v), "Slug can only use lowercase letters, numbers and single hyphens")
    .optional()
    .nullable(),
  excerpt: optionalText("Excerpt", 300),
  category: optionalText("Category", 60),
  coverImage: coverImageField,
  body: z
    .string({ required_error: "Story text is required" })
    .trim()
    .min(20, "The story must be at least 20 characters")
    .max(30000, "The story must be 30000 characters or fewer"),
  status: z.enum(ARTICLE_STATUSES, { errorMap: () => ({ message: "Status must be Draft, Published or Archived" }) }).optional(),
};

const createSchema = z.object(articleShape);
const updateSchema = z.object(articleShape).partial();

const publicSummary = (a: any) => ({
  id: a.id,
  slug: a.slug,
  title: a.title,
  excerpt: a.excerpt,
  coverImage: a.coverImage,
  category: a.category,
  publishedAt: a.publishedAt,
  readMinutes: readMinutes(a.body ?? ""),
});

// ---------------------------------------------------------------------------
// Public journal: Published stories only
// ---------------------------------------------------------------------------

export const publicJournalRouter = Router();

publicJournalRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = paging(req);
    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    const where: any = { status: "Published" };
    if (category) where.category = { equals: category, mode: "insensitive" };
    const [total, rows, cats] = await Promise.all([
      prisma.article.count({ where }),
      prisma.article.findMany({ where, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }], skip, take: limit }),
      prisma.article.findMany({ where: { status: "Published", category: { not: null } }, select: { category: true }, distinct: ["category"] }),
    ]);
    return res.status(200).json({
      status: "success",
      items: rows.map(publicSummary),
      categories: cats.map((c) => c.category).filter(Boolean).sort(),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("[journal] list failed", error);
    return res.status(500).json({ status: "error", message: "The journal could not be loaded." });
  }
});

publicJournalRouter.get("/:slug", async (req: Request, res: Response) => {
  try {
    const article = await prisma.article.findUnique({ where: { slug: slugParam(req) } });
    if (!article || article.status !== "Published") {
      return res.status(404).json({ status: "error", message: "Story not found" });
    }
    return res.status(200).json({ status: "success", data: { ...publicSummary(article), body: article.body } });
  } catch (error) {
    console.error("[journal] read failed", error);
    return res.status(500).json({ status: "error", message: "The story could not be loaded." });
  }
});

// ---------------------------------------------------------------------------
// Admin articles
// ---------------------------------------------------------------------------

export const adminArticlesRouter = Router();
adminArticlesRouter.use(requireAdmin);

async function uniqueSlug(base: string, excludeId?: string) {
  const root = base || "story";
  for (let i = 1; i < 200; i++) {
    const candidate = i === 1 ? root : `${root}-${i}`;
    const clash = await prisma.article.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!clash || clash.id === excludeId) return candidate;
  }
  return `${root}-${Date.now()}`;
}

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

adminArticlesRouter.get("/", async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = paging(req, 20);
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (status && !(ARTICLE_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ status: "error", message: "Status must be Draft, Published or Archived" });
    }
    const where: any = status ? { status } : {};
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { slug: { contains: search, mode: "insensitive" } },
        { excerpt: { contains: search, mode: "insensitive" } },
        { category: { contains: search, mode: "insensitive" } },
      ];
    }
    const [total, items, grouped] = await Promise.all([
      prisma.article.count({ where }),
      prisma.article.findMany({ where, orderBy: [{ updatedAt: "desc" }], skip, take: limit }),
      prisma.article.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const counts: Record<string, number> = { Draft: 0, Published: 0, Archived: 0 };
    for (const g of grouped) counts[g.status] = g._count._all;
    return res.status(200).json({
      status: "success",
      items,
      counts,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("[articles] list failed", error);
    return res.status(500).json({ status: "error", message: "The articles could not be loaded." });
  }
});

adminArticlesRouter.get("/:id", async (req: Request, res: Response) => {
  const article = await prisma.article.findUnique({ where: { id: idParam(req) } });
  if (!article) return res.status(404).json({ status: "error", message: "Article not found" });
  return res.status(200).json({ status: "success", data: article });
});

adminArticlesRouter.post("/", async (req: AuthenticatedRequest, res: Response) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);
  const d = parsed.data;
  try {
    let slug: string;
    if (d.slug) {
      const clash = await prisma.article.findUnique({ where: { slug: d.slug }, select: { id: true } });
      if (clash) return res.status(409).json({ status: "error", message: "That slug is already used by another story", errors: { slug: ["That slug is already used by another story"] } });
      slug = d.slug;
    } else {
      slug = await uniqueSlug(slugify(d.title));
    }
    const status = d.status ?? "Draft";
    const created = await prisma.article.create({
      data: {
        slug,
        title: d.title,
        excerpt: clean(d.excerpt),
        category: clean(d.category),
        coverImage: clean(d.coverImage),
        body: d.body,
        status,
        publishedAt: status === "Published" ? new Date() : null,
        authorUserId: req.user!.id,
      },
    });
    return res.status(201).json({ status: "success", data: created });
  } catch (error: any) {
    if (error?.code === "P2002") return res.status(409).json({ status: "error", message: "That slug is already used by another story", errors: { slug: ["That slug is already used by another story"] } });
    console.error("[articles] create failed", error);
    return res.status(500).json({ status: "error", message: "The story could not be saved. Please try again." });
  }
});

adminArticlesRouter.patch("/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  const existing = await prisma.article.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ status: "error", message: "Article not found" });
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error);
  const d = parsed.data;
  try {
    const data: any = {};
    if (d.title !== undefined) data.title = d.title;
    if (d.excerpt !== undefined) data.excerpt = clean(d.excerpt);
    if (d.category !== undefined) data.category = clean(d.category);
    if (d.coverImage !== undefined) data.coverImage = clean(d.coverImage);
    if (d.body !== undefined) data.body = d.body;
    if (d.slug !== undefined) {
      const slug = d.slug || (await uniqueSlug(slugify(d.title ?? existing.title), id));
      if (slug !== existing.slug) {
        const clash = await prisma.article.findUnique({ where: { slug }, select: { id: true } });
        if (clash) return res.status(409).json({ status: "error", message: "That slug is already used by another story", errors: { slug: ["That slug is already used by another story"] } });
        data.slug = slug;
      }
    }
    if (d.status !== undefined && d.status !== existing.status) {
      data.status = d.status;
      if (d.status === "Published") data.publishedAt = existing.publishedAt ?? new Date();
    }
    const updated = await prisma.article.update({ where: { id }, data });
    return res.status(200).json({ status: "success", data: updated });
  } catch (error: any) {
    if (error?.code === "P2002") return res.status(409).json({ status: "error", message: "That slug is already used by another story", errors: { slug: ["That slug is already used by another story"] } });
    console.error("[articles] update failed", error);
    return res.status(500).json({ status: "error", message: "The story could not be saved. Please try again." });
  }
});

function transition(action: "publish" | "unpublish" | "archive") {
  return async (req: Request, res: Response) => {
    const id = idParam(req);
    const existing = await prisma.article.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ status: "error", message: "Article not found" });
    const data: any =
      action === "publish"
        ? { status: "Published", publishedAt: existing.publishedAt ?? new Date() }
        : action === "unpublish"
        ? { status: "Draft" }
        : { status: "Archived" };
    const updated = await prisma.article.update({ where: { id }, data });
    return res.status(200).json({ status: "success", data: updated });
  };
}

adminArticlesRouter.post("/:id/publish", transition("publish"));
adminArticlesRouter.post("/:id/unpublish", transition("unpublish"));
adminArticlesRouter.post("/:id/archive", transition("archive"));
