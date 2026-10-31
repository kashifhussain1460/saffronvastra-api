import { prisma } from "../../database/prisma.js";
import { withRealRatings } from "../reviews/reviews.router.js";

export interface ProductFilterParams {
  categorySlug?: string;
  collectionSlug?: string;
  fabric?: string;
  minPrice?: number;
  maxPrice?: number;
  search?: string;
  sort?: "featured" | "price-asc" | "price-desc" | "newest";
  page?: number;
  limit?: number;
  status?: string;
  bestseller?: boolean;
  newArrival?: boolean;
  // "exclude" (default) hides deleted products, "only" lists just those, "include" shows everything.
  deleted?: "exclude" | "only" | "include";
}

export async function getCategories(includeDrafts = false) {
  const where: any = {};
  if (!includeDrafts) {
    where.status = "Active";
  }

  const categories = await prisma.category.findMany({
    where,
    orderBy: { sortOrder: "asc" },
    include: {
      _count: {
        // Soft-deleted products are never counted.
        select: {
          products: { where: includeDrafts ? { deletedAt: null } : { status: "Active", deletedAt: null } },
          children: true,
        },
      },
    },
  });

  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    parentId: c.parentId,
    shortDescription: c.shortDescription,
    image: c.image,
    bannerImage: c.bannerImage,
    sortOrder: c.sortOrder,
    status: c.status,
    productsCount: c._count.products,
    childrenCount: c._count.children,
    ...(includeDrafts
      ? { parentId: c.parentId, detailedDescription: c.detailedDescription, childrenCount: c._count.children }
      : {}),
  }));
}

export async function getCategoryBySlug(slug: string, opts: { includeHidden?: boolean } = {}) {
  const category = await prisma.category.findUnique({
    where: { slug },
    include: {
      _count: {
        select: { products: { where: { status: "Active", deletedAt: null } } },
      },
    },
  });

  if (!category || (category.status !== "Active" && !opts.includeHidden)) {
    const error: any = new Error("Category not found");
    error.statusCode = 404;
    throw error;
  }

  return {
    ...category,
    productsCount: category._count.products,
  };
}

export async function getCollections(includeDrafts = false) {
  const where: any = {};
  if (!includeDrafts) {
    where.status = "Active";
  }

  const collections = await prisma.collection.findMany({
    where,
    orderBy: { sortOrder: "asc" },
    include: {
      _count: {
        select: { products: { where: { product: includeDrafts ? { deletedAt: null } : { status: "Active", deletedAt: null } } } },
      },
    },
  });

  return collections.map((col) => ({
    id: col.id,
    title: col.title,
    slug: col.slug,
    tagline: col.tagline,
    description: col.description,
    bannerImage: col.bannerImage,
    heroMediaId: col.heroMediaId,
    sortOrder: col.sortOrder,
    status: col.status,
    productsCount: col._count.products,
  }));
}

export async function getCollectionBySlug(slug: string, options: { includeUnpublished?: boolean } = {}) {
  const collection = await prisma.collection.findUnique({
    where: { slug },
    include: {
      products: {
        where: { product: options.includeUnpublished ? { deletedAt: null } : { status: "Active", deletedAt: null } },
        orderBy: { sortOrder: "asc" },
        include: {
          product: {
            include: {
              images: { orderBy: { sortOrder: "asc" } },
              variants: { where: { status: "Active" } },
              category: { include: { parent: true } },
            },
          },
        },
      },
    },
  });

  // A Draft or Archived collection is not public.
  if (!collection || (!options.includeUnpublished && collection.status !== "Active")) {
    const error: any = new Error("Collection not found");
    error.statusCode = 404;
    throw error;
  }

  return {
    id: collection.id,
    title: collection.title,
    slug: collection.slug,
    tagline: collection.tagline,
    description: collection.description,
    bannerImage: collection.bannerImage,
    sortOrder: collection.sortOrder,
    status: collection.status,
    products: collection.products.map((cp) => cp.product),
  };
}

export async function getProducts(params: ProductFilterParams) {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(50, Math.max(1, params.limit || 12));
  const skip = (page - 1) * limit;

  const where: any = {};

  if (params.status && params.status !== "all") {
    where.status = params.status;
  } else if (!params.status) {
    where.status = "Active";
  }

  if (params.deleted === "only") where.deletedAt = { not: null };
  else if (params.deleted !== "include") where.deletedAt = null;

  if (params.bestseller) where.isBestseller = true;
  if (params.newArrival) where.isNewArrival = true;

  if (params.categorySlug && params.categorySlug !== "all") {
    where.category = {
      ...(params.status === "Active" ? { status: "Active" } : {}),
      OR: [
        { slug: params.categorySlug },
        { parent: { slug: params.categorySlug } },
      ],
    };
  } else if (params.status === "Active") {
    where.NOT = {
      category: {
        status: { not: "Active" },
      },
    };
  }

  if (params.collectionSlug && params.collectionSlug !== "all") {
    where.collections = {
      some: {
        collection: { slug: params.collectionSlug },
      },
    };
  }

  if (params.fabric && params.fabric !== "all") {
    where.material = { contains: params.fabric, mode: "insensitive" };
  }

  if (params.minPrice !== undefined || params.maxPrice !== undefined) {
    where.basePriceMinor = {};
    if (params.minPrice !== undefined) where.basePriceMinor.gte = params.minPrice * 100;
    if (params.maxPrice !== undefined) where.basePriceMinor.lte = params.maxPrice * 100;
  }

  if (params.search && params.search.trim()) {
    const query = params.search.trim();
    where.OR = [
      { title: { contains: query, mode: "insensitive" } },
      { description: { contains: query, mode: "insensitive" } },
      { material: { contains: query, mode: "insensitive" } },
      { embroidery: { contains: query, mode: "insensitive" } },
      { category: { name: { contains: query, mode: "insensitive" } } },
    ];
  }

  // A lower display order is listed first; products with equal order stay newest first.
  let orderBy: any = [{ displayOrder: "asc" }, { createdAt: "desc" }];
  if (params.sort === "price-asc") orderBy = { basePriceMinor: "asc" };
  if (params.sort === "price-desc") orderBy = { basePriceMinor: "desc" };
  if (params.sort === "featured") orderBy = [{ isFeatured: "desc" }, { createdAt: "desc" }];

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      include: {
        category: { include: { parent: true } },
        images: { orderBy: { sortOrder: "asc" } },
        variants: { where: { status: "Active" } },
      },
    }),
  ]);

  return {
    items: await withRealRatings(products),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + products.length < total,
    },
  };
}

// Published products by id, in the order requested. Ids that are unknown or not published are omitted.
export async function getProductsByIds(ids: string[]) {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  const rows = await prisma.product.findMany({
    where: { id: { in: unique }, status: "Active", deletedAt: null },
    include: {
      category: { include: { parent: true } },
      images: { orderBy: { sortOrder: "asc" } },
      variants: { where: { status: "Active" } },
    },
  });
  const byId = new Map(rows.map((p) => [p.id, p]));
  const ordered = unique.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => Boolean(p));
  return withRealRatings(ordered);
}

export async function getProductBySlug(slug: string, options: { includeUnpublished?: boolean } = {}) {
  const product = await prisma.product.findUnique({
    where: { slug },
    include: {
      category: { include: { parent: true } },
      images: { orderBy: { sortOrder: "asc" } },
      variants: { where: { status: "Active" } },
      collections: {
        include: {
          collection: true,
        },
      },
    },
  });

  // Draft and Archived products are never visible to the public.
  // Draft, Archived and deleted products are not public. Staff can still open them to preview or restore.
  if (!product || (!options.includeUnpublished && (product.status !== "Active" || product.deletedAt))) {
    const error: any = new Error("Product not found");
    error.statusCode = 404;
    throw error;
  }

  // Related products from same category
  const related = await prisma.product.findMany({
    where: {
      categoryId: product.categoryId,
      id: { not: product.id },
      status: "Active",
      deletedAt: null,
    },
    take: 4,
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      variants: true,
    },
  });

  const [withRating] = await withRealRatings([product]);
  return {
    ...withRating,
    relatedProducts: await withRealRatings(related),
  };
}

// =========================================================================
// ADMIN CATALOGUE OPERATIONS
// =========================================================================

// ---------------------------------------------------------------------------
// Category and collection input validation (server-side source of truth)
// ---------------------------------------------------------------------------

const CATALOGUE_STATUSES = ["Active", "Inactive", "Draft", "Archived"];

function slugFromText(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function requiredText(value: unknown, label: string, max: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw httpError(400, `${label} is required`);
  if (text.length > max) throw httpError(400, `${label} must be ${max} characters or fewer`);
  return text;
}

function optionalText(value: unknown, label: string, max: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw httpError(400, `${label} must be ${max} characters or fewer`);
  return value.trim() || null;
}

function optionalImageUrl(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !IMAGE_URL_PATTERN.test(value)) throw httpError(400, `${label} is not a valid image URL`);
  return value;
}

function validSlug(value: unknown) {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!slug) throw httpError(400, "Slug is required");
  if (slug.length > 120 || !SLUG_PATTERN.test(slug)) {
    throw httpError(400, "Slug may contain only lowercase letters, numbers and single hyphens (max 120 characters)");
  }
  return slug;
}

function validSortOrder(value: unknown) {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw httpError(400, "Sort order must be a whole number between 0 and 10000");
  return n;
}

function validCatalogueStatus(value: unknown) {
  const status = value ?? "Active";
  if (typeof status !== "string" || !CATALOGUE_STATUSES.includes(status)) throw httpError(400, "Status must be Active, Inactive, Draft or Archived");
  return status;
}

const hasKey = (data: any, key: string) => Boolean(data) && Object.prototype.hasOwnProperty.call(data, key);

async function normalizeCategory(data: any, existing?: any) {
  const name = requiredText(hasKey(data, "name") || !existing ? data?.name : existing.name, "Category name", 80);
  const slugInput = hasKey(data, "slug") ? data.slug : existing ? existing.slug : slugFromText(name);
  const parentInput = hasKey(data, "parentId") ? data.parentId : existing?.parentId ?? null;
  const fields = {
    name,
    slug: validSlug(slugInput),
    shortDescription: optionalText(hasKey(data, "shortDescription") ? data.shortDescription : existing?.shortDescription, "Short description", 300),
    detailedDescription: optionalText(hasKey(data, "detailedDescription") ? data.detailedDescription : existing?.detailedDescription, "Detailed description", 2000),
    image: optionalImageUrl(hasKey(data, "image") ? data.image : existing?.image, "Image"),
    bannerImage: optionalImageUrl(hasKey(data, "bannerImage") ? data.bannerImage : existing?.bannerImage, "Banner image"),
    sortOrder: validSortOrder(hasKey(data, "sortOrder") ? data.sortOrder : existing?.sortOrder),
    status: validCatalogueStatus(hasKey(data, "status") ? data.status : existing?.status),
    parentId: null as string | null,
  };

  if (parentInput) {
    if (typeof parentInput !== "string") throw httpError(400, "Parent category is not valid");
    if (existing && parentInput === existing.id) throw httpError(400, "A category cannot be its own parent");
    // Walk up the chain so a category can never become its own ancestor.
    let cursor: string | null = parentInput;
    for (let depth = 0; cursor && depth < 20; depth++) {
      if (existing && cursor === existing.id) throw httpError(400, "A category cannot be moved under one of its own sub-categories");
      const parent: { id: string; parentId: string | null } | null = await prisma.category.findUnique({
        where: { id: cursor },
        select: { id: true, parentId: true },
      });
      if (!parent) throw httpError(400, "The selected parent category does not exist");
      cursor = parent.parentId;
    }
    fields.parentId = parentInput;
  }
  return fields;
}

export async function createCategory(data: any) {
  const fields = await normalizeCategory(data);
  if (await prisma.category.findUnique({ where: { slug: fields.slug }, select: { id: true } })) {
    throw httpError(409, "A category with this slug already exists");
  }
  try {
    return await prisma.category.create({ data: fields });
  } catch (error: any) {
    if (error?.code === "P2002") throw httpError(409, "A category with this slug already exists");
    throw error;
  }
}

export async function updateCategory(id: string, data: any) {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw httpError(404, "Category not found");
  const fields = await normalizeCategory(data, existing);
  if (fields.slug !== existing.slug) {
    const clash = await prisma.category.findUnique({ where: { slug: fields.slug }, select: { id: true } });
    if (clash && clash.id !== id) throw httpError(409, "A category with this slug already exists");
  }
  try {
    return await prisma.category.update({ where: { id }, data: fields });
  } catch (error: any) {
    if (error?.code === "P2002") throw httpError(409, "A category with this slug already exists");
    throw error;
  }
}

export async function deleteCategory(id: string) {
  const existing = await prisma.category.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw httpError(404, "Category not found");

  const [childCount, liveProducts, removedProducts] = await Promise.all([
    prisma.category.count({ where: { parentId: id } }),
    prisma.product.count({ where: { categoryId: id, deletedAt: null } }),
    prisma.product.count({ where: { categoryId: id, deletedAt: { not: null } } }),
  ]);

  if (childCount > 0) {
    throw httpError(409, `Cannot delete this category: it has ${childCount} sub-categor${childCount === 1 ? "y" : "ies"}. Move or delete them first.`);
  }
  if (liveProducts > 0) {
    throw httpError(
      409,
      `Cannot delete this category: ${liveProducts} product${liveProducts === 1 ? " is" : "s are"} assigned to it. Move them to another category first, or set the category to Archived instead.`
    );
  }
  if (removedProducts > 0) {
    throw httpError(
      409,
      `Cannot delete this category: ${removedProducts} deleted product${removedProducts === 1 ? " is" : "s are"} still linked to it for order history. Set the category to Archived instead.`
    );
  }

  return prisma.category.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Product input validation (server-side source of truth)
// ---------------------------------------------------------------------------

const PRODUCT_STATUSES = ["Active", "Draft", "Archived"];
const AVAILABILITY_MODES = ["Available to Order", "Made to Order", "Unavailable"];
const MAX_PRICE_MINOR = 500_000_000; // INR 5,000,000 (fits the Int column with headroom)
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE_URL_PATTERN = /^(\/(uploads|images)\/[^\s]+|https?:\/\/[^\s]+)$/i;

function httpError(statusCode: number, message: string) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toMinor(minor: unknown, rupees: unknown): number | null {
  if (minor !== undefined && minor !== null && minor !== "") return Number(minor);
  if (rupees !== undefined && rupees !== null && rupees !== "") return Math.round(Number(rupees) * 100);
  return null;
}

interface NormalizedProduct {
  title: string;
  slug: string;
  description: string;
  material: string | null;
  embroidery: string | null;
  careInstructions: string | null;
  shortDescription: string | null;
  brand: string | null;
  productType: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  focusKeywords: string[];
  displayOrder: number;
  basePriceMinor: number;
  comparePriceMinor: number | null;
  availabilityMode: string;
  leadTimeDays: number;
  status: string;
  isFeatured: boolean;
  isBestseller: boolean;
  isNewArrival: boolean;
  categoryId: string;
}

function normalizeProductFields(data: any): NormalizedProduct {
  const title = typeof data?.title === "string" ? data.title.trim() : "";
  if (!title) throw httpError(400, "Product name is required");
  if (title.length > 200) throw httpError(400, "Product name must be 200 characters or fewer");

  const slug = typeof data.slug === "string" ? data.slug.trim().toLowerCase() : "";
  if (!slug) throw httpError(400, "Slug is required");
  if (slug.length > 120 || !SLUG_PATTERN.test(slug)) {
    throw httpError(400, "Slug may contain only lowercase letters, numbers and single hyphens (max 120 characters)");
  }

  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) throw httpError(400, "Description is required");
  if (description.length > 5000) throw httpError(400, "Description must be 5000 characters or fewer");

  const basePriceMinor = toMinor(data.basePriceMinor, data.price);
  if (basePriceMinor === null || !Number.isInteger(basePriceMinor) || basePriceMinor <= 0 || basePriceMinor > MAX_PRICE_MINOR) {
    throw httpError(400, "Price must be greater than zero and no more than 5,000,000");
  }

  const compareRaw = toMinor(data.comparePriceMinor, data.compareAtPrice);
  let comparePriceMinor: number | null = null;
  if (compareRaw !== null) {
    if (!Number.isInteger(compareRaw) || compareRaw > MAX_PRICE_MINOR) {
      throw httpError(400, "Compare-at price is not a valid amount");
    }
    if (compareRaw <= basePriceMinor) {
      throw httpError(400, "Compare-at price must be greater than the regular price");
    }
    comparePriceMinor = compareRaw;
  }

  const status = data.status ?? "Active";
  if (!PRODUCT_STATUSES.includes(status)) throw httpError(400, "Status must be Active, Draft or Archived");

  const availabilityMode = data.availabilityMode ?? "Made to Order";
  if (!AVAILABILITY_MODES.includes(availabilityMode)) throw httpError(400, "Invalid availability mode");

  const leadTimeDays = data.leadTimeDays ?? 7;
  if (!Number.isInteger(leadTimeDays) || leadTimeDays < 1 || leadTimeDays > 365) {
    throw httpError(400, "Lead time must be a whole number of days between 1 and 365");
  }

  if (typeof data.categoryId !== "string" || !data.categoryId) throw httpError(400, "Category is required");

  const optionalText = (value: unknown, label: string, max: number) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > max) throw httpError(400, `${label} must be ${max} characters or fewer`);
    return value.trim() || null;
  };

  return {
    title,
    slug,
    description,
    material: optionalText(data.material, "Material", 120),
    embroidery: optionalText(data.embroidery, "Embroidery", 120),
    careInstructions: optionalText(data.careInstructions, "Care instructions", 1000),
    shortDescription: optionalText(data.shortDescription, "Short description", 500),
    brand: optionalText(data.brand, "Brand", 80),
    productType: optionalText(data.productType, "Product type", 80),
    seoTitle: optionalText(data.seoTitle, "Meta title", 60),
    seoDescription: optionalText(data.seoDescription, "Meta description", 160),
    focusKeywords: normalizeKeywords(data.focusKeywords),
    displayOrder: normalizeDisplayOrder(data.displayOrder),
    basePriceMinor,
    comparePriceMinor,
    availabilityMode,
    leadTimeDays,
    status,
    isFeatured: data.isFeatured === true,
    isBestseller: data.isBestseller === true,
    isNewArrival: data.isNewArrival === true,
    categoryId: data.categoryId,
  };
}

function normalizeKeywords(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw httpError(400, "Focus keywords must be a list of at most 100 words or phrases");
  const cleaned = value.map((k) => (typeof k === "string" ? k.trim() : ""));
  if (cleaned.some((k) => !k || k.length > 50)) throw httpError(400, "Each focus keyword must be 1 to 50 characters");
  return Array.from(new Set(cleaned));
}

function normalizeDisplayOrder(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw httpError(400, "Display order must be a whole number between 0 and 10000");
  return n;
}

function normalizeImages(images: any, title: string) {
  if (images === undefined) return undefined;
  if (!Array.isArray(images)) throw httpError(400, "Images must be a list");
  if (images.length > 20) throw httpError(400, "A product can have at most 20 images");
  return images.map((img: any) => {
    const url = typeof img === "string" ? img : img?.url;
    if (typeof url !== "string" || !IMAGE_URL_PATTERN.test(url)) throw httpError(400, "Image URL is not valid");
    const altText = typeof img === "string" ? title : String(img.altText || title).slice(0, 200);
    return { url, altText };
  });
}

function normalizeVariants(variants: any) {
  if (variants === undefined) return undefined;
  if (!Array.isArray(variants)) throw httpError(400, "Variants must be a list");
  if (variants.length === 0) throw httpError(400, "At least one size/colour variant is required");
  if (variants.length > 100) throw httpError(400, "A product can have at most 100 variants");
  const seen = new Set<string>();
  return variants.map((v: any) => {
    const size = typeof v?.size === "string" ? v.size.trim() : "";
    if (!size || size.length > 30) throw httpError(400, "Each variant needs a size");
    const colourName = String(v.colourName || v.color?.name || "Standard").trim().slice(0, 60);
    const colourHex = String(v.colourHex || v.color?.hex || "#1A1A1A");
    if (!/^#[0-9a-fA-F]{6}$/.test(colourHex)) throw httpError(400, "Variant colour must be a 6-digit hex value");
    const key = `${size.toLowerCase()}|${colourName.toLowerCase()}`;
    if (seen.has(key)) throw httpError(400, `Duplicate variant: ${colourName} / ${size}`);
    seen.add(key);
    let priceOverrideMinor: number | null = null;
    if (v.priceOverrideMinor !== undefined && v.priceOverrideMinor !== null) {
      priceOverrideMinor = Number(v.priceOverrideMinor);
      if (!Number.isInteger(priceOverrideMinor) || priceOverrideMinor <= 0 || priceOverrideMinor > MAX_PRICE_MINOR) {
        throw httpError(400, "Variant price override must be greater than zero");
      }
    }
    return { size, colourName, colourHex, priceOverrideMinor };
  });
}

async function normalizeCollectionIds(collectionIds: any) {
  if (collectionIds === undefined) return undefined;
  if (!Array.isArray(collectionIds) || collectionIds.some((id) => typeof id !== "string")) {
    throw httpError(400, "Collections must be a list of ids");
  }
  const unique = Array.from(new Set<string>(collectionIds));
  if (unique.length === 0) return unique;
  const found = await prisma.collection.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw httpError(400, "One or more selected collections no longer exist");
  return unique;
}

async function assertCategoryExists(categoryId: string) {
  const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
  if (!category) throw httpError(400, "The selected category no longer exists");
}

// SKUs are derived from the product id and variant position, so they are unique
// by construction (the old random 3-digit suffix collided on the unique index).
function variantSku(productId: string, index: number, size: string) {
  const sizeCode = size.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "STD";
  return `ST-${productId.replace(/-/g, "").slice(0, 8).toUpperCase()}-${index + 1}-${sizeCode}`;
}

const PRODUCT_INCLUDE = {
  category: { include: { parent: true } },
  images: { orderBy: { sortOrder: "asc" as const } },
  variants: true,
  collections: { select: { collectionId: true } },
};

const PUBLISH_NEEDS_IMAGE = "Add at least one product image before publishing";

export async function createProduct(data: any) {
  const fields = normalizeProductFields(data);
  const images = normalizeImages(data.images, fields.title) ?? [];
  const variants = normalizeVariants(data.variants);
  if (!variants) throw httpError(400, "At least one size/colour variant is required");
  if (fields.status === "Active" && images.length === 0) throw httpError(400, PUBLISH_NEEDS_IMAGE);
  const collectionIds = (await normalizeCollectionIds(data.collectionIds)) ?? [];
  await assertCategoryExists(fields.categoryId);

  const slugOwner = await prisma.product.findUnique({ where: { slug: fields.slug }, select: { id: true, deletedAt: true } });
  if (slugOwner) {
    throw httpError(
      409,
      slugOwner.deletedAt
        ? "A deleted product uses this slug. Restore that product or choose a different slug."
        : "A product with this slug already exists"
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data: fields });

      if (images.length > 0) {
        await tx.productImage.createMany({
          data: images.map((img, idx) => ({
            productId: product.id,
            url: img.url,
            altText: img.altText,
            isCover: idx === 0,
            sortOrder: idx,
          })),
        });
      }

      await tx.productVariant.createMany({
        data: variants.map((v, idx) => ({
          productId: product.id,
          sku: variantSku(product.id, idx, v.size),
          size: v.size,
          colourName: v.colourName,
          colourHex: v.colourHex,
          priceOverrideMinor: v.priceOverrideMinor,
          status: "Active",
        })),
      });

      if (collectionIds.length > 0) {
        await tx.collectionProduct.createMany({
          data: collectionIds.map((collectionId) => ({ collectionId, productId: product.id })),
        });
      }

      return tx.product.findUnique({ where: { id: product.id }, include: PRODUCT_INCLUDE });
    });
  } catch (error: any) {
    if (error?.code === "P2002") throw httpError(409, "A product with this slug already exists");
    throw error;
  }
}

export async function getProductById(id: string) {
  const product = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
  if (!product) throw httpError(404, "Product not found");
  return product;
}

export async function updateProduct(id: string, data: any) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw httpError(404, "Product not found");

  // Optimistic concurrency: a form that sends the version it loaded cannot overwrite someone else's newer save.
  if (data?.expectedUpdatedAt !== undefined && data.expectedUpdatedAt !== null) {
    const expected = new Date(data.expectedUpdatedAt);
    if (Number.isNaN(expected.getTime()) || expected.getTime() !== existing.updatedAt.getTime()) {
      const error: any = httpError(409, "This product was changed by someone else after you opened it. Reload the page to see the latest version, then make your changes again.");
      error.code = "STALE_PRODUCT";
      throw error;
    }
  }

  // Only whitelisted fields can change; absent fields keep their stored value.
  const has = (key: string) => data && Object.prototype.hasOwnProperty.call(data, key);
  const priceGiven = has("basePriceMinor") || has("price");
  const compareGiven = has("comparePriceMinor") || has("compareAtPrice");
  const fields = normalizeProductFields({
    title: has("title") ? data.title : existing.title,
    slug: has("slug") ? data.slug : existing.slug,
    description: has("description") ? data.description : existing.description,
    material: has("material") ? data.material : existing.material,
    embroidery: has("embroidery") ? data.embroidery : existing.embroidery,
    careInstructions: has("careInstructions") ? data.careInstructions : existing.careInstructions,
    shortDescription: has("shortDescription") ? data.shortDescription : existing.shortDescription,
    brand: has("brand") ? data.brand : existing.brand,
    productType: has("productType") ? data.productType : existing.productType,
    seoTitle: has("seoTitle") ? data.seoTitle : existing.seoTitle,
    seoDescription: has("seoDescription") ? data.seoDescription : existing.seoDescription,
    focusKeywords: has("focusKeywords") ? data.focusKeywords : existing.focusKeywords,
    displayOrder: has("displayOrder") ? data.displayOrder : existing.displayOrder,
    basePriceMinor: priceGiven ? data.basePriceMinor : existing.basePriceMinor,
    price: priceGiven ? data.price : undefined,
    comparePriceMinor: compareGiven ? data.comparePriceMinor : existing.comparePriceMinor,
    compareAtPrice: compareGiven ? data.compareAtPrice : undefined,
    availabilityMode: has("availabilityMode") ? data.availabilityMode : existing.availabilityMode,
    leadTimeDays: has("leadTimeDays") ? data.leadTimeDays : existing.leadTimeDays,
    status: has("status") ? data.status : existing.status,
    isFeatured: has("isFeatured") ? data.isFeatured : existing.isFeatured,
    isBestseller: has("isBestseller") ? data.isBestseller : existing.isBestseller,
    isNewArrival: has("isNewArrival") ? data.isNewArrival : existing.isNewArrival,
    categoryId: has("categoryId") ? data.categoryId : existing.categoryId,
  });
  const images = normalizeImages(data.images, fields.title);
  const variants = normalizeVariants(data.variants);
  const collectionIds = await normalizeCollectionIds(data.collectionIds);
  if (fields.status === "Active") {
    const imageCount = images ? images.length : await prisma.productImage.count({ where: { productId: id } });
    if (imageCount === 0) throw httpError(400, PUBLISH_NEEDS_IMAGE);
  }
  if (fields.categoryId !== existing.categoryId) await assertCategoryExists(fields.categoryId);
  if (fields.slug !== existing.slug) {
    const clash = await prisma.product.findUnique({ where: { slug: fields.slug }, select: { id: true } });
    if (clash && clash.id !== id) throw httpError(409, "A product with this slug already exists");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: fields });

      if (images) {
        await tx.productImage.deleteMany({ where: { productId: id } });
        if (images.length > 0) {
          await tx.productImage.createMany({
            data: images.map((img, idx) => ({
              productId: id,
              url: img.url,
              altText: img.altText,
              isCover: idx === 0,
              sortOrder: idx,
            })),
          });
        }
      }

      if (variants) {
        // Variants may be referenced by carts and orders, so removed ones are deactivated, never deleted.
        const current = await tx.productVariant.findMany({ where: { productId: id } });
        const keyOf = (size: string, colour: string) => `${size.toLowerCase()}|${colour.toLowerCase()}`;
        const wanted = new Map(variants.map((v) => [keyOf(v.size, v.colourName), v]));
        const seenKeys = new Set<string>();
        for (const row of current) {
          const key = keyOf(row.size, row.colourName);
          const match = wanted.get(key);
          seenKeys.add(key);
          await tx.productVariant.update({
            where: { id: row.id },
            data: match
              ? { status: "Active", colourHex: match.colourHex, priceOverrideMinor: match.priceOverrideMinor }
              : { status: "Inactive" },
          });
        }
        let position = current.length;
        for (const v of variants) {
          if (seenKeys.has(keyOf(v.size, v.colourName))) continue;
          await tx.productVariant.create({
            data: {
              productId: id,
              sku: variantSku(id, position++, v.size),
              size: v.size,
              colourName: v.colourName,
              colourHex: v.colourHex,
              priceOverrideMinor: v.priceOverrideMinor,
              status: "Active",
            },
          });
        }
      }

      if (collectionIds) {
        await tx.collectionProduct.deleteMany({ where: { productId: id } });
        if (collectionIds.length > 0) {
          await tx.collectionProduct.createMany({
            data: collectionIds.map((collectionId) => ({ collectionId, productId: id })),
          });
        }
      }

      return tx.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    });
  } catch (error: any) {
    if (error?.code === "P2002") throw httpError(409, "A product with this slug already exists");
    throw error;
  }
}

export async function togglePublishProduct(id: string) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) {
    const error: any = new Error("Product not found");
    error.statusCode = 404;
    throw error;
  }

  if (existing.deletedAt) {
    throw httpError(409, "This product is deleted. Restore it before publishing.");
  }
  const nextStatus = existing.status === "Active" ? "Draft" : "Active";
  if (nextStatus === "Active") {
    // the same rules the product form applies before publishing, enforced here because the API is the authority
    const [imageCount, variantCount] = await Promise.all([
      prisma.productImage.count({ where: { productId: id } }),
      prisma.productVariant.count({ where: { productId: id, status: "Active" } }),
    ]);
    if (imageCount === 0) throw httpError(400, PUBLISH_NEEDS_IMAGE);
    if (variantCount === 0) throw httpError(400, "Add at least one available size before publishing");
  }
  return prisma.product.update({
    where: { id },
    data: { status: nextStatus },
  });
}

async function normalizeCollection(data: any, existing?: any) {
  const title = requiredText(hasKey(data, "title") || !existing ? data?.title : existing.title, "Collection title", 120);
  const slugInput = hasKey(data, "slug") ? data.slug : existing ? existing.slug : slugFromText(title);
  const heroInput = hasKey(data, "heroMediaId") ? data.heroMediaId : existing?.heroMediaId ?? null;
  if (heroInput) {
    if (typeof heroInput !== "string" || !(await prisma.mediaAsset.findUnique({ where: { id: heroInput }, select: { id: true } }))) {
      throw httpError(400, "The selected hero image does not exist");
    }
  }
  return {
    title,
    slug: validSlug(slugInput),
    tagline: optionalText(hasKey(data, "tagline") ? data.tagline : existing?.tagline, "Tagline", 200),
    description: optionalText(hasKey(data, "description") ? data.description : existing?.description, "Description", 2000),
    bannerImage: optionalImageUrl(hasKey(data, "bannerImage") ? data.bannerImage : existing?.bannerImage, "Banner image"),
    heroMediaId: (heroInput as string | null) || null,
    sortOrder: validSortOrder(hasKey(data, "sortOrder") ? data.sortOrder : existing?.sortOrder),
    status: validCatalogueStatus(hasKey(data, "status") ? data.status : existing?.status),
  };
}

export async function createCollection(data: any) {
  const fields = await normalizeCollection(data);
  if (await prisma.collection.findUnique({ where: { slug: fields.slug }, select: { id: true } })) {
    throw httpError(409, "A collection with this slug already exists");
  }
  try {
    return await prisma.collection.create({ data: fields });
  } catch (error: any) {
    if (error?.code === "P2002") throw httpError(409, "A collection with this slug already exists");
    throw error;
  }
}

export async function updateCollection(id: string, data: any) {
  const existing = await prisma.collection.findUnique({ where: { id } });
  if (!existing) throw httpError(404, "Collection not found");
  const fields = await normalizeCollection(data, existing);
  if (fields.slug !== existing.slug) {
    const clash = await prisma.collection.findUnique({ where: { slug: fields.slug }, select: { id: true } });
    if (clash && clash.id !== id) throw httpError(409, "A collection with this slug already exists");
  }
  try {
    return await prisma.collection.update({ where: { id }, data: fields });
  } catch (error: any) {
    if (error?.code === "P2002") throw httpError(409, "A collection with this slug already exists");
    throw error;
  }
}

// Deleting a collection removes only its links to products (cascade); the products stay.
export async function deleteCollection(id: string) {
  const existing = await prisma.collection.findUnique({
    where: { id },
    select: { id: true, _count: { select: { products: true } } },
  });
  if (!existing) throw httpError(404, "Collection not found");
  await prisma.collection.delete({ where: { id } });
  return { removedLinks: existing._count.products };
}

// Products are never removed from the database. Deleting hides them everywhere and keeps every
// order, review and audit record that points at them.
export async function softDeleteProduct(id: string, actorUserId: string) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw httpError(404, "Product not found");
  if (existing.deletedAt) throw httpError(409, "This product is already deleted");
  return prisma.product.update({
    where: { id },
    data: { deletedAt: new Date(), deletedByUserId: actorUserId, status: "Archived" },
    include: PRODUCT_INCLUDE,
  });
}

// A restored product comes back as a Draft, so it is never published by surprise.
export async function restoreProduct(id: string) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw httpError(404, "Product not found");
  if (!existing.deletedAt) throw httpError(409, "This product is not deleted");
  return prisma.product.update({
    where: { id },
    data: { deletedAt: null, deletedByUserId: null, status: "Draft" },
    include: PRODUCT_INCLUDE,
  });
}

/**
 * Saves the order of one level of the category tree. The caller sends every sibling under the same parent, in the
 * new order; a partial or stale list is refused so two admins reordering at once cannot interleave positions.
 */
export async function reorderCategories(body: any) {
  const ids = body?.orderedIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id: unknown) => typeof id !== "string") || new Set(ids).size !== ids.length) {
    throw httpError(400, "orderedIds must be a non-empty list of distinct category ids");
  }
  const parentId = body?.parentId === undefined || body?.parentId === "" ? null : body.parentId;
  if (parentId !== null && typeof parentId !== "string") throw httpError(400, "parentId must be a category id or null");

  return prisma.$transaction(async (tx) => {
    const siblings = await tx.category.findMany({ where: { parentId }, select: { id: true } });
    const known = new Set(siblings.map((s) => s.id));
    if (siblings.length !== ids.length || ids.some((id: string) => !known.has(id))) {
      throw httpError(409, "The category list has changed since it was loaded. Reload the page and try again.");
    }
    for (const [index, id] of ids.entries()) {
      await tx.category.update({ where: { id }, data: { sortOrder: (index + 1) * 10 } });
    }
    return tx.category.findMany({ where: { parentId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, sortOrder: true } });
  });
}
