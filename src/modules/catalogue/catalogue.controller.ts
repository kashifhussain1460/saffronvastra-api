import { Request, Response } from "express";
import { audit, changes } from "../../common/audit.js";
import { prisma } from "../../database/prisma.js";
import {
  getCategories,
  getCategoryBySlug,
  getCollections,
  getCollectionBySlug,
  getProducts,
  getProductBySlug,
  getProductsByIds,
  softDeleteProduct,
  restoreProduct,
  createCategory,
  updateCategory,
  reorderCategories,
  deleteCategory,
  createProduct,
  updateProduct,
  getProductById,
  togglePublishProduct,
  createCollection,
  updateCollection,
  deleteCollection,
} from "./catalogue.service.js";

// Public catalogue routes share handlers with the admin UI, so visibility of
// Draft/Archived rows is decided here from the authenticated session.
function isAdminRequest(req: Request): boolean {
  return (req as any).user?.roles?.includes("ADMIN") === true;
}

// Expected errors carry a statusCode and a safe message. Anything else (for
// example a raw database error with file paths) is logged and replaced.
function sendProductError(res: Response, error: any, fallbackMessage: string) {
  if (error?.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({ status: "error", message: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  console.error(fallbackMessage, error);
  return res.status(500).json({ status: "error", message: fallbackMessage });
}

async function logAdminAction(req: Request, action: string, entityType: string, entityId: string, safeDiff?: any) {
  await audit(req, { action, entityType, entityId, details: safeDiff });
}

const PRODUCT_AUDIT_FIELDS = ["title", "slug", "status", "basePriceMinor", "comparePriceMinor", "categoryId", "availabilityMode", "leadTimeDays", "seoTitle", "seoDescription", "isFeatured", "isBestseller", "isNewArrival"];
const CATEGORY_AUDIT_FIELDS = ["name", "slug", "status", "parentId", "sortOrder", "image", "bannerImage"];

// =========================================================================
// PUBLIC CATALOGUE CONTROLLERS
// =========================================================================

export async function handleGetCategories(req: Request, res: Response) {
  try {
    // Draft entries are only ever returned to administrators.
    const includeDrafts = req.query.includeDrafts === "true" && isAdminRequest(req);
    const categories = await getCategories(includeDrafts);
    return res.status(200).json({ status: "success", data: categories });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleGetCategoryBySlug(req: Request, res: Response) {
  try {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    // Draft and Archived categories are visible to administrators only.
    const category = await getCategoryBySlug(slug as string, { includeHidden: isAdminRequest(req) });
    return res.status(200).json({ status: "success", data: category });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleGetCollections(req: Request, res: Response) {
  try {
    // Draft entries are only ever returned to administrators.
    const includeDrafts = req.query.includeDrafts === "true" && isAdminRequest(req);
    const collections = await getCollections(includeDrafts);
    return res.status(200).json({ status: "success", data: collections });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleGetCollectionBySlug(req: Request, res: Response) {
  try {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    const collection = await getCollectionBySlug(slug as string, { includeUnpublished: isAdminRequest(req) });
    return res.status(200).json({ status: "success", data: collection });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleGetProducts(req: Request, res: Response) {
  try {
    const {
      category,
      collection,
      fabric,
      minPrice,
      maxPrice,
      search,
      sort,
      page,
      limit,
      status,
      bestseller,
      newArrival,
      deleted,
    } = req.query;

    const result = await getProducts({
      categorySlug: category as string,
      collectionSlug: collection as string,
      fabric: fabric as string,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      search: search as string,
      sort: sort as any,
      page: page ? parseInt(page as string, 10) : 1,
      limit: limit ? parseInt(limit as string, 10) : 12,
      // Only administrators may ask for Draft/Archived/all; everyone else gets Active only.
      status: isAdminRequest(req) ? (status as string) : "Active",
      // Only administrators can look at deleted products.
      deleted: isAdminRequest(req) && (deleted === "only" || deleted === "include") ? deleted : "exclude",
      bestseller: bestseller === "true",
      newArrival: newArrival === "true",
    });

    return res.status(200).json({ status: "success", ...result });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleGetProductsByIds(req: Request, res: Response) {
  try {
    const raw = typeof req.query.ids === "string" ? req.query.ids : "";
    const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length > 50) return res.status(400).json({ status: "error", message: "Request at most 50 products at a time" });
    // Only published products are returned, whoever asks, so a saved item that was unpublished simply drops out.
    const items = await getProductsByIds(ids);
    return res.status(200).json({ status: "success", items });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleGetProductBySlug(req: Request, res: Response) {
  try {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    const product = await getProductBySlug(slug as string, { includeUnpublished: isAdminRequest(req) });
    return res.status(200).json({ status: "success", data: product });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleSearch(req: Request, res: Response) {
  try {
    const q = (req.query.q as string) || "";
    const result = await getProducts({ search: q, limit: 24 });
    return res.status(200).json({ status: "success", query: q, ...result });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

// =========================================================================
// ADMIN CATALOGUE CONTROLLERS
// =========================================================================

export async function handleCreateCategory(req: Request, res: Response) {
  try {
    const created = await createCategory(req.body);
    await logAdminAction(req, "CATEGORY_CREATE", "Category", created.id, {
      name: created.name,
      slug: created.slug,
    });
    return res.status(201).json({ status: "success", data: created });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleUpdateCategory(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const before = await prisma.category.findUnique({ where: { id: id as string } });
    const updated = await updateCategory(id as string, req.body);
    await logAdminAction(req, "CATEGORY_UPDATE", "Category", id as string, { changes: changes(before as any, updated as any, CATEGORY_AUDIT_FIELDS) });
    return res.status(200).json({ status: "success", data: updated });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleReorderCategories(req: Request, res: Response) {
  try {
    const before = await prisma.category.findMany({ where: { parentId: req.body?.parentId || null }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true } });
    const ordered = await reorderCategories(req.body);
    await logAdminAction(req, "CATEGORY_REORDER", "Category", req.body?.parentId || "top-level", {
      changes: { order: { before: before.map((c) => c.name), after: ordered.map((c) => c.name) } },
    });
    return res.status(200).json({ status: "success", data: ordered });
  } catch (error: any) {
    return sendProductError(res, error, "The new order could not be saved.");
  }
}

export async function handleDeleteCategory(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await deleteCategory(id as string);
    await logAdminAction(req, "CATEGORY_DELETE", "Category", id as string);
    return res.status(200).json({ status: "success", message: "Category deleted" });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleCreateProduct(req: Request, res: Response) {
  try {
    const created = await createProduct(req.body);
    if (created) {
      await logAdminAction(req, "PRODUCT_CREATE", "Product", created.id, {
        title: created.title,
        slug: created.slug,
        status: created.status,
      });
    }
    return res.status(201).json({ status: "success", data: created });
  } catch (error: any) {
    return sendProductError(res, error, "Could not create the product. Please try again.");
  }
}

export async function handleGetProductById(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const product = await getProductById(id as string);
    return res.status(200).json({ status: "success", data: product });
  } catch (error: any) {
    return sendProductError(res, error, "Could not load the product.");
  }
}

export async function handleUpdateProduct(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const before = await prisma.product.findUnique({ where: { id: id as string } });
    const updated = await updateProduct(id as string, req.body);
    await logAdminAction(req, "PRODUCT_UPDATE", "Product", id as string, {
      submittedFields: Object.keys(req.body || {}),
      changes: changes(before as any, updated as any, PRODUCT_AUDIT_FIELDS),
    });
    return res.status(200).json({ status: "success", data: updated });
  } catch (error: any) {
    return sendProductError(res, error, "Could not update the product. Please try again.");
  }
}

export async function handleTogglePublishProduct(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const updated = await togglePublishProduct(id as string);
    await logAdminAction(req, "PRODUCT_PUBLISH_TOGGLE", "Product", id as string, {
      newStatus: updated.status,
    });
    return res.status(200).json({ status: "success", data: updated });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleCreateCollection(req: Request, res: Response) {
  try {
    const created = await createCollection(req.body);
    await logAdminAction(req, "COLLECTION_CREATE", "Collection", created.id, {
      title: created.title,
      slug: created.slug,
    });
    return res.status(201).json({ status: "success", data: created });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleUpdateCollection(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const updated = await updateCollection(id as string, req.body);
    await logAdminAction(req, "COLLECTION_UPDATE", "Collection", id as string, req.body);
    return res.status(200).json({ status: "success", data: updated });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleDeleteCollection(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { removedLinks } = await deleteCollection(id as string);
    await logAdminAction(req, "COLLECTION_DELETE", "Collection", id as string, { removedLinks });
    return res.status(200).json({
      status: "success",
      message: `Collection deleted. ${removedLinks} product link${removedLinks === 1 ? "" : "s"} removed; the products themselves were not changed.`,
      removedLinks,
    });
  } catch (error: any) {
    return sendProductError(res, error, "The request could not be completed.");
  }
}

export async function handleDeleteProduct(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deleted = await softDeleteProduct(id as string, (req as any).user.id);
    await logAdminAction(req, "PRODUCT_SOFT_DELETE", "Product", id as string, { title: deleted.title, slug: deleted.slug });
    return res.status(200).json({ status: "success", data: deleted });
  } catch (error: any) {
    return sendProductError(res, error, "Could not delete the product.");
  }
}

export async function handleRestoreProduct(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const restored = await restoreProduct(id as string);
    await logAdminAction(req, "PRODUCT_RESTORE", "Product", id as string, { title: restored.title, slug: restored.slug });
    return res.status(200).json({ status: "success", data: restored });
  } catch (error: any) {
    return sendProductError(res, error, "Could not restore the product.");
  }
}
