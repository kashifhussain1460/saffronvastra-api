import { createHash } from "node:crypto";
import { list } from "@vercel/blob";
import { prisma } from "../../database/prisma.js";
import { useBlob } from "../../common/storage.js";
import { detectImage } from "./media.service.js";

/**
 * "Import from Blob": images that were put into the Blob store by hand (Vercel dashboard) are found, checked and
 * added to the media library, and linked to the product / category / collection their folder name points at.
 *
 * Folder convention inside the store (lowercase, no spaces; the name is the item's slug):
 *   uploads/products/<product-slug>/<01.webp, 02.webp ...>   first file in name order is the cover
 *   uploads/categories/<category-slug>.<ext>
 *   uploads/collections/<collection-slug>.<ext>
 *   uploads/banners/<any-name>.<ext>                          library only (placed by hand in the admin)
 * Files anywhere else (the ones the admin uploaded itself, request photos) are never touched.
 */

export type BlobTarget =
  | { kind: "product"; slug: string; file: string }
  | { kind: "category"; slug: string; file: string }
  | { kind: "collection"; slug: string; file: string }
  | { kind: "banner"; slug: string; file: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;
const IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,150}\.(jpe?g|png|webp|gif|avif)$/i;

export const FOLDER_BY_KIND: Record<BlobTarget["kind"], string> = {
  product: "Product Images",
  category: "Category Images",
  collection: "Collection Images",
  banner: "Banner Images",
};

/** Works out what a Blob path is for. Returns null for anything outside the convention. */
export function parseBlobPath(pathname: string): BlobTarget | null {
  const parts = pathname.split("/");
  if (parts[0] !== "uploads") return null;
  const file = parts[parts.length - 1];
  if (!IMAGE_FILE.test(file)) return null;
  const stem = file.replace(/\.[^.]+$/, "").toLowerCase();
  if (parts[1] === "products" && parts.length === 4 && SLUG.test(parts[2])) return { kind: "product", slug: parts[2], file };
  if (parts[1] === "categories" && parts.length === 3 && SLUG.test(stem)) return { kind: "category", slug: stem, file };
  if (parts[1] === "collections" && parts.length === 3 && SLUG.test(stem)) return { kind: "collection", slug: stem, file };
  if (parts[1] === "banners" && parts.length === 3) return { kind: "banner", slug: stem, file };
  return null;
}

export interface BlobEntry {
  url: string;
  pathname: string;
  size: number;
}

export interface BlobSource {
  /** One page of the store's file list under the given prefix. */
  list(prefix: string, cursor: string | undefined, limit: number): Promise<{ blobs: BlobEntry[]; cursor?: string; hasMore: boolean }>;
  /** The whole file. */
  fetchBytes(url: string): Promise<Buffer>;
}

export const vercelBlobSource: BlobSource = {
  async list(prefix, cursor, limit) {
    const page = await list({ prefix, cursor, limit });
    return { blobs: page.blobs.map((b) => ({ url: b.url, pathname: b.pathname, size: b.size })), cursor: page.cursor, hasMore: page.hasMore };
  },
  async fetchBytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  },
};

export interface ImportReport {
  scanned: number;
  created: number;
  alreadyInLibrary: number;
  duplicates: Array<{ path: string; sameAs: string }>;
  invalid: Array<{ path: string; reason: string }>;
  linked: Array<{ path: string; to: string }>;
  unmatched: Array<{ path: string; reason: string }>;
  ignored: number;
  nextCursor: string | null;
  done: boolean;
}

const MAX_BYTES = 25 * 1024 * 1024;

// The cursor given to the caller is the store's own page cursor plus how far into that page we got. Without the second
// part a file that can never be imported (not an image) would be met again and again and the import would never finish.
function encodeCursor(listCursor: string | undefined, offset: number): string {
  return Buffer.from(JSON.stringify({ c: listCursor ?? null, o: offset })).toString("base64url");
}
function decodeCursor(value: string | null | undefined): { listCursor: string | undefined; offset: number } {
  if (!value) return { listCursor: undefined, offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return { listCursor: typeof parsed.c === "string" ? parsed.c : undefined, offset: Number.isInteger(parsed.o) && parsed.o > 0 ? parsed.o : 0 };
  } catch {
    return { listCursor: undefined, offset: 0 };
  }
}

/**
 * Imports one batch. Safe to run again at any time: a file already in the library is not added twice, and a link is
 * only made when it does not exist yet. At most batchSize NEW files are downloaded per call (files already in the
 * library cost one database lookup). Keep calling with nextCursor until done is true.
 */
export async function importFromBlob(
  options: { cursor?: string | null; batchSize?: number; actorUserId?: string | null } = {},
  source: BlobSource = vercelBlobSource
): Promise<ImportReport> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 15, 1), 40);
  const { listCursor, offset } = decodeCursor(options.cursor);
  const page = await source.list("uploads/", listCursor, 100);
  const report: ImportReport = { scanned: 0, created: 0, alreadyInLibrary: 0, duplicates: [], invalid: [], linked: [], unmatched: [], ignored: 0, nextCursor: null, done: false };

  // stable order so the first file of a product folder (01.webp) is handled first
  const ordered = page.blobs.slice().sort((a, b) => a.pathname.localeCompare(b.pathname, "en", { numeric: true }));
  const wanted = ordered.filter((b) => parseBlobPath(b.pathname));
  report.ignored = offset === 0 ? ordered.length - wanted.length : 0;

  const known = await prisma.mediaAsset.findMany({
    where: { OR: [{ url: { in: wanted.map((b) => b.url) } }, { storageKey: { in: wanted.map((b) => b.pathname) } }] },
    select: { url: true, storageKey: true },
  });
  const inLibrary = new Set(known.flatMap((k) => [k.url, k.storageKey]));

  let newBudget = batchSize;
  let i = offset;
  for (; i < wanted.length; i++) {
    const blob = wanted[i];
    if (!(inLibrary.has(blob.url) || inLibrary.has(blob.pathname))) {
      if (newBudget === 0) break;
      newBudget--;
    }
    report.scanned++;
    try {
      await importOne(blob, parseBlobPath(blob.pathname)!, report, source, options.actorUserId ?? null);
    } catch (error: any) {
      report.invalid.push({ path: blob.pathname, reason: error?.message || "could not be imported" });
    }
  }

  if (i < wanted.length) {
    report.nextCursor = encodeCursor(listCursor, i); // more of this page is left
    report.done = false;
  } else if (page.hasMore && page.cursor) {
    report.nextCursor = encodeCursor(page.cursor, 0);
    report.done = false;
  } else {
    report.nextCursor = null;
    report.done = true;
  }
  return report;
}

async function importOne(blob: BlobEntry, target: BlobTarget, report: ImportReport, source: BlobSource, actorUserId: string | null) {
  let asset = await prisma.mediaAsset.findFirst({ where: { OR: [{ url: blob.url }, { storageKey: blob.pathname }] } });

  if (asset) {
    report.alreadyInLibrary++;
  } else {
    if (blob.size > MAX_BYTES) throw new Error("file is larger than 25 MB");
    const bytes = await source.fetchBytes(blob.url);
    const detected = detectImage(bytes.subarray(0, Math.min(bytes.length, 65536)));
    if (!detected) throw new Error("the file is not a valid JPEG, PNG, WebP, GIF or AVIF image");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    // The same picture in two folders is normal (one photo for two products), so it is added again as its own file.
    // It is only noted in the report.
    const same = await prisma.mediaAsset.findFirst({ where: { sha256 } });
    if (same) report.duplicates.push({ path: blob.pathname, sameAs: same.name });
    asset = await prisma.mediaAsset.create({
      data: {
        storageKey: blob.pathname,
        name: blob.pathname.split("/").pop() || "image",
        url: blob.url,
        folder: FOLDER_BY_KIND[target.kind],
        mimeType: detected.mime,
        bytes: bytes.length,
        width: detected.width,
        height: detected.height,
        altText: "",
        uploadedByUserId: actorUserId,
        sha256,
      },
    });
    report.created++;
  }

  const linked = await linkAsset(asset, target);
  if (linked.ok) {
    if (linked.changed) report.linked.push({ path: blob.pathname, to: linked.label });
  } else if (target.kind !== "banner") {
    report.unmatched.push({ path: blob.pathname, reason: linked.reason });
  }
}

type LinkResult = { ok: true; changed: boolean; label: string } | { ok: false; reason: string };

async function linkAsset(asset: { id: string; url: string; altText: string }, target: BlobTarget): Promise<LinkResult> {
  if (target.kind === "banner") return { ok: true, changed: false, label: "" };

  if (target.kind === "product") {
    const product = await prisma.product.findFirst({ where: { slug: target.slug, deletedAt: null }, select: { id: true, title: true } });
    if (!product) return { ok: false, reason: `no product with the slug "${target.slug}"` };
    const already = await prisma.productImage.findFirst({ where: { productId: product.id, OR: [{ mediaAssetId: asset.id }, { url: asset.url }] } });
    if (already) return { ok: true, changed: false, label: product.title };
    const last = await prisma.productImage.findFirst({ where: { productId: product.id }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    const hasCover = await prisma.productImage.count({ where: { productId: product.id, isCover: true } });
    await prisma.productImage.create({
      data: { productId: product.id, mediaAssetId: asset.id, url: asset.url, altText: product.title, sortOrder: last ? last.sortOrder + 1 : 0, isCover: hasCover === 0 },
    });
    return { ok: true, changed: true, label: product.title };
  }

  if (target.kind === "category") {
    const category = await prisma.category.findFirst({ where: { slug: target.slug }, select: { id: true, name: true, image: true } });
    if (!category) return { ok: false, reason: `no category with the slug "${target.slug}"` };
    if (category.image === asset.url) return { ok: true, changed: false, label: category.name };
    if (category.image) return { ok: false, reason: `category "${category.name}" already has an image: left unchanged` };
    await prisma.category.update({ where: { id: category.id }, data: { image: asset.url } });
    return { ok: true, changed: true, label: category.name };
  }

  const collection = await prisma.collection.findFirst({ where: { slug: target.slug }, select: { id: true, title: true, bannerImage: true } });
  if (!collection) return { ok: false, reason: `no collection with the slug "${target.slug}"` };
  if (collection.bannerImage === asset.url) return { ok: true, changed: false, label: collection.title };
  if (collection.bannerImage) return { ok: false, reason: `collection "${collection.title}" already has a banner: left unchanged` };
  await prisma.collection.update({ where: { id: collection.id }, data: { bannerImage: asset.url, heroMediaId: asset.id } });
  return { ok: true, changed: true, label: collection.title };
}

export function blobImportAvailable(): boolean {
  return useBlob;
}
