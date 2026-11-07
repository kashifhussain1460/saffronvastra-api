import { prisma } from '../../database/prisma.js';

export interface SocialProductFilter {
  search?: string;
  categorySlug?: string;
  uncategorised?: boolean;
  ids?: string[];        // by-ids lookup, includes Draft
  page?: number;
  limit?: number;        // capped at 50
}

export interface SocialProductRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  basePriceMinor: number;
  categoryName?: string;
  coverImageUrl?: string;
  coverImageMime?: string;
  variantCount: number;
  publishedPlatforms: string[];
}

export interface SocialProductPage {
  items: SocialProductRow[];
  total: number;
  page: number;
  limit: number;
}

export async function querySocialProducts(
  filter: SocialProductFilter,
): Promise<SocialProductPage> {
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(50, Math.max(1, filter.limit ?? 20));
  const skip = (page - 1) * limit;

  // Build the where clause.
  // When ids provided: bypass status/deleted filters.
  let where: Record<string, unknown>;

  if (filter.ids && filter.ids.length > 0) {
    where = { id: { in: filter.ids } };
  } else {
    where = {
      status: { not: 'Archived' },   // Active + Draft included; Archived excluded
      deletedAt: null,
    };

    if (filter.search?.trim()) {
      const q = filter.search.trim();
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { material: { contains: q, mode: 'insensitive' } },
        { variants: { some: { sku: { contains: q, mode: 'insensitive' } } } },
      ];
    }

    if (filter.uncategorised) {
      where.categoryId = null;
    } else if (filter.categorySlug) {
      where.category = { slug: filter.categorySlug };
    }
  }

  // ── Query 1 + 2 (run in parallel) ─────────────────────────────────────────
  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        basePriceMinor: true,
        categoryId: true,
        category: { select: { name: true } },
        _count: { select: { variants: true } },
      },
    }),
  ]);

  if (products.length === 0) {
    return { items: [], total, page, limit };
  }

  const productIds = products.map((p) => p.id);

  // ── Query 3: published platforms per product ───────────────────────────────
  // Find all platforms that have at least one completed job for these products.
  const publishedJobs = await prisma.socialPublishJob.findMany({
    where: {
      status: 'completed',
      variant: { campaignProduct: { product: { id: { in: productIds } } } },
    },
    select: {
      variant: {
        select: {
          platform: true,
          campaignProduct: { select: { productId: true } },
        },
      },
    },
  });

  // Map productId → Set<platform>
  const platformMap = new Map<string, Set<string>>();
  for (const job of publishedJobs) {
    const pid = job.variant.campaignProduct.productId;
    const plat = job.variant.platform;
    if (!platformMap.has(pid)) platformMap.set(pid, new Set());
    platformMap.get(pid)!.add(plat);
  }

  // ── Query 4: cover images ──────────────────────────────────────────────────
  // Fetch all images for the page's product IDs ordered so the preferred image
  // per product comes first: isCover=true before isCover=false, then lowest
  // sortOrder. We pick the first occurrence per product in-memory.
  const rawImages = await prisma.productImage.findMany({
    where: { productId: { in: productIds } },
    orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }],
    select: {
      productId: true,
      url: true,
      mediaAsset: { select: { mimeType: true } },
    },
  });

  // Keep only the first image per product (the preferred cover).
  const coverMap = new Map<
    string,
    { url: string; mediaAsset: { mimeType: string } | null }
  >();
  for (const img of rawImages) {
    if (!coverMap.has(img.productId)) {
      coverMap.set(img.productId, img);
    }
  }

  // ── Assemble result ────────────────────────────────────────────────────────
  const items: SocialProductRow[] = products.map((p) => {
    const cover = coverMap.get(p.id);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      status: p.status,
      basePriceMinor: p.basePriceMinor,
      categoryName: p.category?.name ?? undefined,
      coverImageUrl: cover?.url ?? undefined,
      coverImageMime: cover?.mediaAsset?.mimeType ?? undefined,
      variantCount: p._count.variants,
      publishedPlatforms: Array.from(platformMap.get(p.id) ?? []),
    };
  });

  return { items, total, page, limit };
}
