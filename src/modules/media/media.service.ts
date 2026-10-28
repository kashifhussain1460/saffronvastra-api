import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { isStoredUrl, removeStored } from "../../common/storage.js";

function httpError(statusCode: number, message: string) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _&-]{0,59}$/;

const updateSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(200, "Name must be 200 characters or fewer").optional(),
    altText: z.string().trim().max(200, "Alt text must be 200 characters or fewer").optional(),
    folder: z.string().trim().regex(FOLDER_PATTERN, "Folder name is not valid").optional(),
  })
  .strict();

export function validFolder(value: unknown) {
  if (value === undefined || value === null || value === "") return "Product Images";
  if (typeof value !== "string" || !FOLDER_PATTERN.test(value.trim())) throw httpError(400, "Folder name is not valid");
  return value.trim();
}

type UsageCounts = { productImages: number; collections: number; categories: number; total: number };

/**
 * How often each asset is referenced. Product images store the URL (not always the
 * media id), so references are matched on either.
 */
async function usageFor(assets: Array<{ id: string; url: string }>): Promise<Map<string, UsageCounts>> {
  const result = new Map<string, UsageCounts>();
  for (const a of assets) result.set(a.id, { productImages: 0, collections: 0, categories: 0, total: 0 });
  if (assets.length === 0) return result;
  const ids = assets.map((a) => a.id);
  const urls = assets.map((a) => a.url);
  const byUrl = new Map(assets.map((a) => [a.url, a.id]));

  const [images, collections, categories] = await Promise.all([
    prisma.productImage.findMany({
      where: { OR: [{ mediaAssetId: { in: ids } }, { url: { in: urls } }] },
      select: { mediaAssetId: true, url: true },
    }),
    prisma.collection.findMany({
      where: { OR: [{ heroMediaId: { in: ids } }, { bannerImage: { in: urls } }] },
      select: { heroMediaId: true, bannerImage: true },
    }),
    prisma.category.findMany({
      where: { OR: [{ image: { in: urls } }, { bannerImage: { in: urls } }] },
      select: { image: true, bannerImage: true },
    }),
  ]);

  const bump = (id: string | undefined, key: "productImages" | "collections" | "categories") => {
    const row = id ? result.get(id) : undefined;
    if (row) {
      row[key] += 1;
      row.total += 1;
    }
  };
  for (const i of images) bump(i.mediaAssetId && result.has(i.mediaAssetId) ? i.mediaAssetId : byUrl.get(i.url), "productImages");
  for (const c of collections) bump(c.heroMediaId && result.has(c.heroMediaId) ? c.heroMediaId : byUrl.get(c.bannerImage || ""), "collections");
  for (const c of categories) bump(byUrl.get(c.image || "") ?? byUrl.get(c.bannerImage || ""), "categories");
  return result;
}

function usageMessage(u: UsageCounts) {
  const parts: string[] = [];
  if (u.productImages) parts.push(`${u.productImages} product image${u.productImages === 1 ? "" : "s"}`);
  if (u.collections) parts.push(`${u.collections} collection${u.collections === 1 ? "" : "s"}`);
  if (u.categories) parts.push(`${u.categories} categor${u.categories === 1 ? "y" : "ies"}`);
  return `This image is still used by ${parts.join(", ")} (${u.total} in total). Remove it from those first, then delete it.`;
}

async function getStats() {
  const [total, folders, bytes, usedImages, usedCollections, usedCategories] = await Promise.all([
    prisma.mediaAsset.count(),
    prisma.mediaAsset.groupBy({ by: ["folder"], _count: { _all: true } }),
    prisma.mediaAsset.aggregate({ _sum: { bytes: true } }),
    prisma.productImage.findMany({ select: { mediaAssetId: true, url: true }, distinct: ["url", "mediaAssetId"] }),
    prisma.collection.findMany({ select: { heroMediaId: true, bannerImage: true } }),
    prisma.category.findMany({ select: { image: true, bannerImage: true } }),
  ]);
  const usedIds = new Set<string>();
  const usedUrls = new Set<string>();
  for (const i of usedImages) {
    if (i.mediaAssetId) usedIds.add(i.mediaAssetId);
    usedUrls.add(i.url);
  }
  for (const c of usedCollections) {
    if (c.heroMediaId) usedIds.add(c.heroMediaId);
    if (c.bannerImage) usedUrls.add(c.bannerImage);
  }
  for (const c of usedCategories) {
    if (c.image) usedUrls.add(c.image);
    if (c.bannerImage) usedUrls.add(c.bannerImage);
  }
  const unused = await prisma.mediaAsset.count({
    where: { id: { notIn: [...usedIds] }, url: { notIn: [...usedUrls] } },
  });
  return {
    total,
    unused,
    totalBytes: bytes._sum.bytes || 0,
    folders: Object.fromEntries(folders.map((f) => [f.folder, f._count._all])),
  };
}

export async function getMediaAssets(params: {
  folder?: string;
  search?: string;
  unused?: boolean;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 24));
  const skip = (page - 1) * limit;

  const where: any = {};

  if (params.folder && params.folder !== "All Images") {
    where.folder = params.folder;
  }

  if (params.search && params.search.trim()) {
    const term = params.search.trim();
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { altText: { contains: term, mode: "insensitive" } },
    ];
  }

  const [total, assets, stats] = await Promise.all([
    prisma.mediaAsset.count({ where }),
    prisma.mediaAsset.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { uploadedByUser: { select: { email: true } } },
    }),
    getStats(),
  ]);

  const usage = await usageFor(assets);

  return {
    items: assets.map(({ uploadedByUser, ...a }) => ({
      ...a,
      uploadedBy: uploadedByUser?.email || null,
      usage: usage.get(a.id),
    })),
    stats,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + assets.length < total,
    },
  };
}

export async function createMediaAsset(data: {
  name: string;
  url: string;
  storageKey?: string;
  folder?: string;
  mimeType: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  altText?: string;
  uploadedByUserId?: string | null;
  sha256?: string | null;
}) {
  return prisma.mediaAsset.create({
    data: {
      storageKey: data.storageKey || `assets/${Date.now()}-${data.name.replace(/\s+/g, "_")}`,
      name: data.name,
      url: data.url,
      folder: data.folder || "Product Images",
      mimeType: data.mimeType,
      bytes: data.bytes,
      width: data.width ?? null,
      height: data.height ?? null,
      altText: data.altText ?? data.name,
      uploadedByUserId: data.uploadedByUserId || null,
      sha256: data.sha256 || null,
    },
  });
}

export async function updateMediaAsset(id: string, body: unknown) {
  const parsed = updateSchema.safeParse(body ?? {});
  if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message || "Invalid request");
  if (Object.keys(parsed.data).length === 0) throw httpError(400, "Nothing to update");
  const existing = await prisma.mediaAsset.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw httpError(404, "Media asset not found");
  return prisma.mediaAsset.update({ where: { id }, data: parsed.data });
}

export async function deleteMediaAsset(id: string) {
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw httpError(404, "Media asset not found");

  const usage = (await usageFor([asset])).get(asset.id)!;
  if (usage.total > 0) {
    const error = httpError(409, usageMessage(usage));
    error.usage = usage;
    throw error;
  }

  await prisma.mediaAsset.delete({ where: { id } });

  // Remove the file too, but only when it is one we stored and no other asset shares it.
  if (isStoredUrl(asset.url)) {
    const shared = await prisma.mediaAsset.count({ where: { url: asset.url } });
    if (shared === 0) await removeStored(asset.url);
  }
  return asset;
}

// ---------------------------------------------------------------------------
// Upload content checks: the declared MIME type is client-controlled, so the real
// type is read from the file's own bytes.
// ---------------------------------------------------------------------------

export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};

export function detectImage(buf: Buffer): { mime: string; width: number | null; height: number | null } | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a")) {
    return { mime: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let width: number | null = null;
    let height: number | null = null;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = buf.readUInt16BE(i + 5);
        width = buf.readUInt16BE(i + 7);
        break;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { mime: "image/jpeg", width, height };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    const kind = buf.subarray(12, 16).toString("latin1");
    let width: number | null = null;
    let height: number | null = null;
    if (kind === "VP8X") {
      width = 1 + buf.readUIntLE(24, 3);
      height = 1 + buf.readUIntLE(27, 3);
    } else if (kind === "VP8 ") {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (kind === "VP8L") {
      const bits = buf.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
    return { mime: "image/webp", width, height };
  }
  if (buf.length >= 16 && buf.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", width: null, height: null };
  }
  return null;
}

/** Strip any directory part and unsafe characters from a client-supplied file name. */
export function safeDisplayName(original: string) {
  const base = original.split(/[\\/]/).pop() || "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim().slice(0, 200);
  return cleaned || "image";
}

export async function sha256OfFile(file: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on("data", (c) => hash.update(c)).on("end", () => resolve()).on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Swaps the file behind an asset and keeps every reference: product images (which also store the URL),
 * category images and collection banners that point at the old URL are moved to the new one in the same transaction.
 */
export async function replaceMediaFile(id: string, next: { url: string; storageKey: string; mimeType: string; bytes: number; width: number | null; height: number | null; sha256: string }) {
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw httpError(404, "Media asset not found");
  const oldUrl = asset.url;
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.mediaAsset.update({ where: { id }, data: next });
    const images = await tx.productImage.updateMany({ where: { mediaAssetId: id }, data: { url: next.url } });
    const catImages = await tx.category.updateMany({ where: { image: oldUrl }, data: { image: next.url } });
    const catBanners = await tx.category.updateMany({ where: { bannerImage: oldUrl }, data: { bannerImage: next.url } });
    const colBanners = await tx.collection.updateMany({ where: { bannerImage: oldUrl }, data: { bannerImage: next.url } });
    return { updated, references: { productImages: images.count, categoryImages: catImages.count + catBanners.count, collectionBanners: colBanners.count } };
  });
  if (isStoredUrl(oldUrl) && oldUrl !== next.url) {
    const shared = await prisma.mediaAsset.count({ where: { url: oldUrl } });
    if (shared === 0) await removeStored(oldUrl);
  }
  return { asset: result.updated, previousUrl: oldUrl, references: result.references };
}
