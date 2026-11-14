// Etsy -> own storage image migration (resumable, idempotent). Run from D:\saff\backend:
//   node node_modules/tsx/dist/cli.mjs scripts/image-migration/migrate.ts <command> [options]
// Commands: inventory | download | verify | upload | verify-live | status | pause | resume | export | rollback
// See README.md in this folder. Nothing is written to the database or to Blob storage except by `upload --apply`
// (and `rollback --apply`). All other commands only read the database.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { head } from "@vercel/blob";
import { prisma } from "../../src/database/prisma.js";
import { detectImage } from "../../src/modules/media/media.service.js";
import { publishBuffer, useBlob } from "../../src/common/storage.js";

// ---------------------------------------------------------------------------------------------------------------------
// Paths and options
// ---------------------------------------------------------------------------------------------------------------------
const ROOT = path.resolve(process.env.IMG_MIGRATION_ROOT || "D:/saff/product-images");
const MIG = path.join(ROOT, "_migration");
const BACKUPS = path.resolve(process.env.IMG_MIGRATION_BACKUPS || "D:/saff/backups");
const F = {
  inventory: path.join(MIG, "product-image-inventory.json"),
  summary: path.join(MIG, "migration-summary.json"),
  failures: path.join(MIG, "migration-failures.json"),
  csv: path.join(MIG, "migration-report.csv"),
  gate: path.join(MIG, "validated.json"),
  backup: path.join(MIG, "backup-original.json"),
  state: path.join(MIG, "upload-state.json"),
  log: path.join(MIG, "migration-log.jsonl"),
  mapping: path.join(MIG, "url-mapping.json"),
  pause: path.join(MIG, "PAUSE"),
  live: path.join(MIG, "final-verification.json"),
};

const args = process.argv.slice(2);
const command = args[0] || "help";
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const CONCURRENCY = Math.min(Math.max(Number(opt("concurrency", "3")), 1), 6);
const DELAY_MS = Math.max(Number(opt("delay", "250")), 0);
const LIMIT = opt("limit") ? Number(opt("limit")) : Infinity;
const ONLY = opt("only"); // one product slug

const UA = "Mozilla/5.0 (compatible; SaffronVastra image migration; owner-initiated)";
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
const SLUG_OK = /^[a-z0-9][a-z0-9-]{0,200}$/;
const MIN_BYTES = 5 * 1024;
const MIN_SIDE = 200;

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const now = () => new Date().toISOString();

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function logLine(entry: Record<string, unknown>) {
  fs.mkdirSync(MIG, { recursive: true });
  fs.appendFileSync(F.log, JSON.stringify({ at: now(), ...entry }) + "\n");
}
function isEtsyUrl(u: string) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "etsy.com" || h.endsWith(".etsy.com") || h.endsWith("etsystatic.com");
  } catch {
    return false;
  }
}
function isOwnStorage(u: string) {
  return u.startsWith("/uploads/") || /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//.test(u);
}
function csvCell(v: unknown) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const pad2 = (n: number) => String(n).padStart(2, "0");

// ---------------------------------------------------------------------------------------------------------------------
// Database inventory (read only)
// ---------------------------------------------------------------------------------------------------------------------
interface Row {
  imageId: string;
  position: number; // 1-based place in the gallery
  sortOrder: number;
  isCover: boolean;
  url: string;
  altText: string;
  mediaAssetId: string | null;
  source: "etsy" | "own-storage" | "other";
}
interface Prod {
  id: string;
  slug: string;
  title: string;
  status: string;
  deleted: boolean;
  rows: Row[];
}

async function loadProducts(): Promise<Prod[]> {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      deletedAt: true,
      images: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { id: true, url: true, altText: true, sortOrder: true, isCover: true, mediaAssetId: true } },
    },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
  return products.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    status: p.status,
    deleted: Boolean(p.deletedAt),
    rows: p.images.map((i, idx) => ({
      imageId: i.id,
      position: idx + 1,
      sortOrder: i.sortOrder,
      isCover: i.isCover,
      url: i.url,
      altText: i.altText,
      mediaAssetId: i.mediaAssetId,
      source: isEtsyUrl(i.url) ? "etsy" : isOwnStorage(i.url) ? "own-storage" : "other",
    })),
  }));
}
const needsMigration = (p: Prod) => p.rows.some((r) => r.source === "etsy");
const productSignature = (p: Prod) => sha256(JSON.stringify(p.rows.map((r) => [r.imageId, r.url, r.sortOrder, r.isCover])));

function selected(products: Prod[]): Prod[] {
  let list = products.filter(needsMigration);
  if (ONLY) list = list.filter((p) => p.slug === ONLY);
  return list.slice(0, LIMIT);
}

// ---------------------------------------------------------------------------------------------------------------------
// Manifests (the per-product checkpoint)
// ---------------------------------------------------------------------------------------------------------------------
interface ManifestImage {
  imageId: string;
  originalUrl: string;
  localPath: string | null;
  filename: string | null;
  position: number;
  sortOrder: number;
  isPrimary: boolean;
  source: Row["source"];
  downloadStatus: "completed" | "failed" | "pending" | "skipped-already-in-own-storage";
  mimeType?: string;
  sha256?: string;
  bytes?: number;
  width?: number | null;
  height?: number | null;
  attempts?: number;
  error?: string;
  duplicateOfUrl?: string;
  downloadedAt?: string;
}
interface Manifest {
  productId: string;
  productName: string;
  productSlug: string;
  generatedAt: string;
  images: ManifestImage[];
}
const manifestPath = (slug: string) => path.join(ROOT, slug, "manifest.json");
function readManifest(slug: string): Manifest | null {
  return readJson<Manifest | null>(manifestPath(slug), null);
}
function assertSlug(slug: string) {
  if (!SLUG_OK.test(slug)) throw new Error(`Refusing unsafe product slug "${slug}"`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------------------------------------------------
class FetchError extends Error {
  constructor(message: string, public retryable: boolean, public retryAfterMs?: number) {
    super(message);
  }
}

async function fetchImage(url: string, maxAttempts = 5): Promise<{ buf: Buffer; mime: string; width: number | null; height: number | null; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "image/*" }, redirect: "follow", signal: AbortSignal.timeout(45_000) });
      if (!res.ok) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
        throw new FetchError(`HTTP ${res.status}`, retryable, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
      }
      const type = (res.headers.get("content-type") || "").toLowerCase();
      if (!type.startsWith("image/")) throw new FetchError(`not an image response (content-type "${type || "none"}")`, true);
      const buf = Buffer.from(await res.arrayBuffer());
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 0 && declared !== buf.length) throw new FetchError(`truncated download (${buf.length} of ${declared} bytes)`, true);
      if (buf.length < MIN_BYTES) throw new FetchError(`file too small (${buf.length} bytes)`, true);
      const detected = detectImage(buf.subarray(0, Math.min(buf.length, 65536)));
      if (!detected) throw new FetchError("content is not a JPEG, PNG, WebP, GIF or AVIF image", true);
      if (!detected.width || !detected.height || detected.width < MIN_SIDE || detected.height < MIN_SIDE) {
        throw new FetchError(`unexpected image dimensions (${detected.width}x${detected.height})`, false);
      }
      return { buf, mime: detected.mime, width: detected.width, height: detected.height, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof FetchError ? error.retryable : true; // network errors and timeouts are retried
      if (!retryable || attempt === maxAttempts) break;
      const wait = (error instanceof FetchError && error.retryAfterMs) || Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      await sleep(wait);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw Object.assign(new Error(message), { attempts: maxAttempts });
}

/** Every URL already downloaded on disk (from any product's manifest), so the same photo is fetched once. */
function knownDownloads(): Map<string, { file: string; entry: ManifestImage }> {
  const map = new Map<string, { file: string; entry: ManifestImage }>();
  if (!fs.existsSync(ROOT)) return map;
  for (const dir of fs.readdirSync(ROOT)) {
    if (dir.startsWith("_") || !SLUG_OK.test(dir)) continue;
    const m = readManifest(dir);
    if (!m) continue;
    for (const e of m.images) {
      if (e.downloadStatus === "completed" && e.localPath) {
        const file = path.join(ROOT, dir, e.filename || "");
        if (fs.existsSync(file) && !map.has(e.originalUrl)) map.set(e.originalUrl, { file, entry: e });
      }
    }
  }
  return map;
}

async function downloadProduct(p: Prod, cache: Map<string, { file: string; entry: ManifestImage }>) {
  assertSlug(p.slug);
  const dir = path.join(ROOT, p.slug);
  fs.mkdirSync(dir, { recursive: true });
  const previous = readManifest(p.slug);
  const prevByImage = new Map((previous?.images ?? []).map((e) => [e.imageId, e]));

  const images: ManifestImage[] = p.rows.map((r) => {
    const base: ManifestImage = {
      imageId: r.imageId,
      originalUrl: r.url,
      localPath: null,
      filename: null,
      position: r.position,
      sortOrder: r.sortOrder,
      isPrimary: r.isCover,
      source: r.source,
      downloadStatus: r.source === "etsy" ? "pending" : "skipped-already-in-own-storage",
    };
    const old = prevByImage.get(r.imageId);
    // keep a finished download if the file is still there, unchanged and the URL is the same
    if (r.source === "etsy" && old && old.originalUrl === r.url && old.downloadStatus === "completed" && old.filename) {
      const file = path.join(dir, old.filename);
      if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === old.sha256) return { ...old, position: r.position, sortOrder: r.sortOrder, isPrimary: r.isCover, source: r.source };
    }
    return base;
  });
  const save = () => writeJson(manifestPath(p.slug), { productId: p.id, productName: p.title, productSlug: p.slug, generatedAt: now(), images } satisfies Manifest);
  save();

  const todo = images.filter((i) => i.source === "etsy" && i.downloadStatus !== "completed");
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const img = todo[next++];
      try {
        const hit = cache.get(img.originalUrl);
        let buf: Buffer, mime: string, width: number | null, height: number | null, attempts = 0;
        if (hit && hit.entry.mimeType && fs.existsSync(hit.file)) {
          buf = fs.readFileSync(hit.file);
          mime = hit.entry.mimeType;
          width = hit.entry.width ?? null;
          height = hit.entry.height ?? null;
          img.duplicateOfUrl = img.originalUrl;
        } else {
          ({ buf, mime, width, height, attempts } = await fetchImage(img.originalUrl));
          await sleep(DELAY_MS);
        }
        const filename = `image-${pad2(img.position)}.${EXT[mime]}`;
        const target = path.join(dir, filename);
        fs.writeFileSync(`${target}.part`, buf);
        fs.renameSync(`${target}.part`, target);
        Object.assign(img, {
          filename,
          localPath: `product-images/${p.slug}/${filename}`,
          downloadStatus: "completed" as const,
          mimeType: mime,
          sha256: sha256(buf),
          bytes: buf.length,
          width,
          height,
          attempts: attempts || undefined,
          error: undefined,
          downloadedAt: now(),
        });
        cache.set(img.originalUrl, { file: target, entry: img });
        logLine({ event: "download", status: "completed", productId: p.id, slug: p.slug, position: img.position, url: img.originalUrl, bytes: buf.length });
      } catch (error: any) {
        Object.assign(img, { downloadStatus: "failed" as const, error: String(error?.message || error), attempts: error?.attempts });
        logLine({ event: "download", status: "failed", productId: p.id, slug: p.slug, position: img.position, url: img.originalUrl, error: img.error });
      }
      save(); // checkpoint after every image
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(todo.length, 1)) }, worker));
  return images;
}

async function cmdDownload() {
  const products = selected(await loadProducts());
  const cache = knownDownloads();
  console.log(`Downloading Etsy images for ${products.length} product(s) into ${ROOT} (concurrency ${CONCURRENCY}, delay ${DELAY_MS} ms)`);
  let done = 0, failed = 0, imagesOk = 0;
  for (const p of products) {
    if (fs.existsSync(F.pause)) {
      console.log(`PAUSED (remove ${F.pause} or run "resume"). ${done} product(s) handled in this run.`);
      return;
    }
    const images = await downloadProduct(p, cache);
    const etsy = images.filter((i) => i.source === "etsy");
    const bad = etsy.filter((i) => i.downloadStatus !== "completed");
    done++;
    imagesOk += etsy.length - bad.length;
    failed += bad.length;
    console.log(`[${done}/${products.length}] ${p.slug.slice(0, 70)}  ${etsy.length - bad.length}/${etsy.length} ok${bad.length ? `  FAILED ${bad.length}: ${bad.map((b) => b.error).join("; ")}` : ""}`);
  }
  console.log(`Done. images ok ${imagesOk}, failed ${failed}. Next: verify`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Inventory + verify (reports and the gate for the upload phase)
// ---------------------------------------------------------------------------------------------------------------------
async function cmdInventory() {
  const products = await loadProducts();
  const urlOwners = new Map<string, string[]>();
  for (const p of products) for (const r of p.rows) urlOwners.set(r.url, [...(urlOwners.get(r.url) ?? []), p.slug]);
  const titleOwners = new Map<string, string[]>();
  for (const p of products) titleOwners.set(p.title.trim().toLowerCase(), [...(titleOwners.get(p.title.trim().toLowerCase()) ?? []), p.slug]);
  const inv = {
    generatedAt: now(),
    totals: {
      products: products.length,
      productsNeedingMigration: products.filter(needsMigration).length,
      productsFullyOnEtsy: products.filter((p) => p.rows.length && p.rows.every((r) => r.source === "etsy")).length,
      productsMixed: products.filter((p) => needsMigration(p) && p.rows.some((r) => r.source !== "etsy")).length,
      productsWithoutImages: products.filter((p) => p.rows.length === 0).length,
      imageRows: products.reduce((n, p) => n + p.rows.length, 0),
      etsyRows: products.reduce((n, p) => n + p.rows.filter((r) => r.source === "etsy").length, 0),
      ownStorageRows: products.reduce((n, p) => n + p.rows.filter((r) => r.source === "own-storage").length, 0),
      otherRows: products.reduce((n, p) => n + p.rows.filter((r) => r.source === "other").length, 0),
      uniqueEtsyUrls: new Set(products.flatMap((p) => p.rows.filter((r) => r.source === "etsy").map((r) => r.url))).size,
      duplicateUrls: [...urlOwners.entries()].filter(([, v]) => v.length > 1).map(([url, slugs]) => ({ url, slugs })),
      duplicateTitles: [...titleOwners.values()].filter((v) => v.length > 1),
      productsWithoutCover: products.filter((p) => p.rows.length && !p.rows.some((r) => r.isCover)).map((p) => p.slug),
      productsWithMultipleCovers: products.filter((p) => p.rows.filter((r) => r.isCover).length > 1).map((p) => p.slug),
    },
    products: products.map((p) => ({
      productId: p.id,
      productName: p.title,
      productSlug: p.slug,
      status: p.status,
      deleted: p.deleted,
      plan: needsMigration(p) ? "migrate-etsy-rows" : "nothing-to-do",
      images: p.rows.map((r) => ({ imageId: r.imageId, position: r.position, sortOrder: r.sortOrder, isPrimary: r.isCover, url: r.url, source: r.source, mediaAssetId: r.mediaAssetId, sharedWithProducts: (urlOwners.get(r.url) ?? []).filter((s) => s !== p.slug) })),
    })),
  };
  writeJson(F.inventory, inv);
  console.log(JSON.stringify(inv.totals, null, 2));
  console.log(`Written ${F.inventory}`);
}

interface Problem {
  productId: string;
  slug: string;
  imageId?: string;
  position?: number;
  originalUrl?: string;
  kind: string;
  reason: string;
}

async function cmdVerify() {
  const products = await loadProducts();
  const migrate = products.filter(needsMigration);
  const problems: Problem[] = []; // things that block the upload phase
  const failures: Problem[] = []; // documented download failures (retry report)
  const csv: string[] = [["product_id", "product_slug", "product_name", "product_status", "position", "is_primary", "original_url", "local_path", "filename", "download_status", "sha256", "bytes", "width", "height", "error"].join(",")];
  let discovered = 0, downloaded = 0, failedDownloads = 0, bytes = 0, processed = 0, withMissing = 0;
  const shaOwners = new Map<string, string[]>();
  const perProduct: Record<string, string> = {};
  const productsReady: string[] = [];

  for (const p of migrate) {
    const m = readManifest(p.slug);
    const etsyRows = p.rows.filter((r) => r.source === "etsy");
    discovered += etsyRows.length;
    if (!m) {
      problems.push({ productId: p.id, slug: p.slug, kind: "no-manifest", reason: "no manifest.json: product not downloaded yet" });
      for (const r of etsyRows) csv.push([p.id, p.slug, p.title, p.status, r.position, r.isCover, r.url, "", "", "not-downloaded", "", "", "", "", ""].map(csvCell).join(","));
      continue;
    }
    processed++;
    let productBad = false;
    if (m.productId !== p.id || m.productSlug !== p.slug) {
      problems.push({ productId: p.id, slug: p.slug, kind: "wrong-product", reason: `manifest belongs to ${m.productId}/${m.productSlug}` });
      productBad = true;
    }
    if (m.images.length !== p.rows.length) {
      problems.push({ productId: p.id, slug: p.slug, kind: "gallery-count", reason: `manifest has ${m.images.length} images, database has ${p.rows.length}` });
      productBad = true;
    }
    const folder = path.join(ROOT, p.slug);
    const known = new Set<string>(["manifest.json"]);
    for (const r of p.rows) {
      const e = m.images.find((x) => x.imageId === r.imageId);
      if (!e) {
        problems.push({ productId: p.id, slug: p.slug, imageId: r.imageId, position: r.position, originalUrl: r.url, kind: "missing-in-manifest", reason: "database image is not in the manifest" });
        productBad = true;
        continue;
      }
      if (e.originalUrl !== r.url || e.position !== r.position || e.sortOrder !== r.sortOrder || e.isPrimary !== r.isCover) {
        problems.push({ productId: p.id, slug: p.slug, imageId: r.imageId, position: r.position, originalUrl: r.url, kind: "order-or-primary-mismatch", reason: `manifest (pos ${e.position}, sort ${e.sortOrder}, primary ${e.isPrimary}) differs from database (pos ${r.position}, sort ${r.sortOrder}, primary ${r.isCover})` });
        productBad = true;
      }
      if (r.source !== "etsy") continue;
      let status = e.downloadStatus as string;
      let error = e.error || "";
      if (e.downloadStatus === "completed") {
        const file = path.join(folder, e.filename || "?");
        known.add(e.filename || "?");
        if (!e.filename || !fs.existsSync(file)) {
          status = "failed";
          error = "local file is missing";
        } else {
          const buf = fs.readFileSync(file);
          const detected = detectImage(buf.subarray(0, Math.min(buf.length, 65536)));
          if (sha256(buf) !== e.sha256 || buf.length !== e.bytes) {
            status = "failed";
            error = "checksum or size differs from the manifest";
          } else if (!detected || !EXT[detected.mime] || e.filename.split(".").pop() !== EXT[detected.mime]) {
            status = "failed";
            error = "file content is not an image of the type its extension says";
          } else {
            downloaded++;
            bytes += buf.length;
            shaOwners.set(e.sha256!, [...(shaOwners.get(e.sha256!) ?? []), p.slug]);
          }
        }
      }
      if (status !== "completed") {
        failedDownloads++;
        productBad = true;
        failures.push({ productId: p.id, slug: p.slug, imageId: r.imageId, position: r.position, originalUrl: r.url, kind: "download", reason: error || `status ${status}` });
      }
      csv.push([p.id, p.slug, p.title, p.status, r.position, r.isCover, r.url, e.localPath || "", e.filename || "", status, e.sha256 || "", e.bytes || "", e.width || "", e.height || "", error].map(csvCell).join(","));
    }
    // stray files in the folder that the manifest does not know about
    for (const f of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
      if (!known.has(f) && !f.endsWith(".part")) problems.push({ productId: p.id, slug: p.slug, kind: "stray-file", reason: `${f} is in the folder but not in the manifest` });
    }
    if (m.images.some((i) => i.source === "etsy" && i.downloadStatus !== "completed")) withMissing++;
    if (!productBad) {
      productsReady.push(p.slug);
      perProduct[p.id] = productSignature(p);
    }
  }

  // a folder can only belong to the product with that slug
  const slugToId = new Map(products.map((p) => [p.slug, p.id]));
  for (const dir of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {
    if (dir.startsWith("_")) continue;
    const m = readManifest(dir);
    if (m && migrate.some((p) => p.slug === dir) === false && slugToId.get(dir) !== m.productId) {
      problems.push({ productId: m.productId, slug: dir, kind: "foreign-folder", reason: "folder with a manifest that does not match any product needing migration" });
    }
  }

  const duplicateImages = [...shaOwners.entries()].filter(([, v]) => v.length > 1).length;
  const summary = {
    generatedAt: now(),
    totalProductsInDatabase: products.length,
    totalProductsNeedingMigration: migrate.length,
    totalProductsProcessed: processed,
    totalImagesDiscovered: discovered,
    totalImagesDownloadedSuccessfully: downloaded,
    totalFailedDownloads: failedDownloads,
    totalDuplicateImages: duplicateImages,
    totalProductsWithMissingImages: withMissing,
    totalStorageConsumedBytes: bytes,
    totalStorageConsumedMB: Number((bytes / 1048576).toFixed(1)),
    productsReadyForUpload: productsReady.length,
    blockingProblems: problems.length,
    validationPassed: problems.length === 0 && failedDownloads === 0 && processed === migrate.length,
  };
  writeJson(F.summary, summary);
  writeJson(F.failures, { generatedAt: now(), downloadFailures: failures, validationProblems: problems });
  fs.writeFileSync(F.csv, csv.join("\n") + "\n");
  // the gate: the upload phase only touches products listed here, and only while their database rows are unchanged
  writeJson(F.gate, { at: now(), validationPassed: summary.validationPassed, products: perProduct });
  await cmdInventory();
  console.log(JSON.stringify(summary, null, 2));
  if (problems.length || failures.length) {
    console.log("Problems:");
    for (const x of [...problems, ...failures].slice(0, 25)) console.log(` - [${x.kind}] ${x.slug}${x.position ? `#${x.position}` : ""}: ${x.reason}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Upload + database update
// ---------------------------------------------------------------------------------------------------------------------
interface StateEntry {
  imageId: string;
  productId: string;
  slug: string;
  oldUrl: string;
  localPath: string;
  newUrl?: string;
  storageKey?: string;
  mediaAssetId?: string;
  sha256: string;
  bytes: number;
  status: "uploaded" | "committed" | "failed";
  error?: string;
  at: string;
}
type State = Record<string, StateEntry>;

async function snapshotForBackup() {
  const [productImages, products, variants, mediaCount] = await Promise.all([
    prisma.productImage.findMany(),
    prisma.product.findMany(),
    prisma.productVariant.findMany(),
    prisma.mediaAsset.count(),
  ]);
  const strip = (o: any) => {
    const { updatedAt, ...rest } = o;
    return rest;
  };
  const productHash: Record<string, string> = {};
  for (const p of products) productHash[p.id] = sha256(JSON.stringify([strip(p), variants.filter((v) => v.productId === p.id).map(strip).sort((a, b) => a.id.localeCompare(b.id))]));
  return { productImages, productHash, mediaAssetCount: mediaCount };
}

async function cmdUpload() {
  const apply = flag("apply");
  const gate = readJson<{ validationPassed: boolean; products: Record<string, string> } | null>(F.gate, null);
  if (!gate) throw new Error("No validation gate found. Run download, then verify first.");
  if (!useBlob) throw new Error("Blob storage is not configured (BLOB_READ_WRITE_TOKEN missing): refusing to write files to a local disk for a production catalogue.");
  const products = await loadProducts();
  const list = selected(products).filter((p) => gate.products[p.id] !== undefined);
  const skippedNotReady = selected(products).filter((p) => gate.products[p.id] === undefined);
  console.log(`Mode: ${apply ? "APPLY (writes to Blob storage and the database)" : "DRY RUN (nothing is written)"}`);
  console.log(`Storage: Vercel Blob. Products ready: ${list.length}; not ready (skipped, see verify): ${skippedNotReady.length}`);

  if (!apply) {
    for (const p of list) console.log(` would migrate ${p.slug.slice(0, 70)}: ${p.rows.filter((r) => r.source === "etsy").length} image(s)`);
    return;
  }

  // original references are saved once, before the first change, and never overwritten
  if (!fs.existsSync(F.backup)) {
    const snap = await snapshotForBackup();
    writeJson(F.backup, { at: now(), ...snap });
    const copy = path.join(BACKUPS, `image-migration-${now().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(copy, { recursive: true });
    fs.copyFileSync(F.backup, path.join(copy, "backup-original.json"));
    console.log(`Backup of original image references written (${snap.productImages.length} image rows): ${F.backup}`);
  }

  const state = readJson<State>(F.state, {});
  let done = 0, failed = 0;
  for (const p of list) {
    if (fs.existsSync(F.pause)) {
      console.log(`PAUSED (run "resume" to continue). ${done} product(s) migrated in this run.`);
      break;
    }
    const current = (await loadProducts()).find((x) => x.id === p.id)!;
    const etsyRows = current.rows.filter((r) => r.source === "etsy");
    const alreadyNew = current.rows.filter((r) => state[r.imageId]?.newUrl === r.url);
    // changed since verification? (rows we already migrated count as unchanged)
    if (productSignature(current) !== gate.products[p.id] && alreadyNew.length === 0) {
      console.log(` SKIP ${p.slug}: its images changed after verification, run verify again`);
      logLine({ event: "upload", status: "skipped-changed", productId: p.id, slug: p.slug });
      failed++;
      continue;
    }
    const manifest = readManifest(p.slug)!;
    try {
      const planned: StateEntry[] = [];
      for (const r of etsyRows) {
        const e = manifest.images.find((x) => x.imageId === r.imageId)!;
        let st = state[r.imageId];
        if (!st || st.status === "failed" || !st.newUrl) {
          const file = path.join(ROOT, p.slug, e.filename!);
          const buf = fs.readFileSync(file);
          if (sha256(buf) !== e.sha256) throw new Error(`${e.filename}: local file changed since verification`);
          const filename = `${pad2(r.position)}-${e.sha256!.slice(0, 10)}.${EXT[e.mimeType!]}`;
          let stored: { url: string; storageKey: string };
          try {
            stored = await publishBuffer(`products/${p.slug}`, filename, buf, e.mimeType!);
          } catch (err: any) {
            if (!/already exists/i.test(String(err?.message))) throw err;
            const existing = await head(`uploads/products/${p.slug}/${filename}`); // a previous run got this far: same bytes, same key
            stored = { url: existing.url, storageKey: existing.pathname };
          }
          // the new address must answer and be the same file before the database points at it
          const check = await fetch(stored.url, { signal: AbortSignal.timeout(45_000) });
          const got = Buffer.from(await check.arrayBuffer());
          if (!check.ok || sha256(got) !== e.sha256) throw new Error(`uploaded file ${stored.url} did not verify (HTTP ${check.status})`);
          st = { imageId: r.imageId, productId: p.id, slug: p.slug, oldUrl: r.url, localPath: e.localPath!, newUrl: stored.url, storageKey: stored.storageKey, sha256: e.sha256!, bytes: e.bytes!, status: "uploaded", at: now() };
          state[r.imageId] = st;
          writeJson(F.state, state);
          logLine({ event: "upload", status: "uploaded", productId: p.id, slug: p.slug, position: r.position, oldUrl: r.url, newUrl: st.newUrl });
        }
        planned.push(st);
      }

      // one transaction per product: all of its Etsy rows move together or none does
      const committed = await prisma.$transaction(
        async (tx) => {
          const out: Array<{ imageId: string; mediaAssetId: string }> = [];
          for (const st of planned) {
            const row = await tx.productImage.findUnique({ where: { id: st.imageId } });
            if (!row || row.productId !== p.id) throw new Error(`image row ${st.imageId} does not belong to this product`);
            const rowInfo = etsyRows.find((r) => r.imageId === st.imageId)!;
            const asset = await tx.mediaAsset.upsert({
              where: { storageKey: st.storageKey! },
              update: {},
              create: {
                storageKey: st.storageKey!,
                name: `${p.slug.slice(0, 80)}-${pad2(rowInfo.position)}.${st.localPath.split(".").pop()}`,
                url: st.newUrl!,
                mimeType: manifest.images.find((x) => x.imageId === st.imageId)!.mimeType!,
                bytes: st.bytes,
                width: manifest.images.find((x) => x.imageId === st.imageId)!.width ?? null,
                height: manifest.images.find((x) => x.imageId === st.imageId)!.height ?? null,
                altText: (row.altText || p.title).slice(0, 200),
                folder: "Product Images",
                sha256: st.sha256,
              },
            });
            if (row.url === st.newUrl) {
              out.push({ imageId: st.imageId, mediaAssetId: asset.id });
              continue;
            }
            if (row.url !== st.oldUrl) throw new Error(`image row ${st.imageId} changed while migrating`);
            await tx.productImage.update({ where: { id: st.imageId }, data: { url: st.newUrl!, mediaAssetId: asset.id } });
            out.push({ imageId: st.imageId, mediaAssetId: asset.id });
          }
          return out;
        },
        { timeout: 60_000 }
      );
      for (const c of committed) Object.assign(state[c.imageId], { status: "committed", mediaAssetId: c.mediaAssetId, error: undefined });
      writeJson(F.state, state);

      // post-check: same number of rows, same order, same cover
      const after = (await loadProducts()).find((x) => x.id === p.id)!;
      const sameShape = after.rows.length === current.rows.length && after.rows.every((r, i) => r.imageId === current.rows[i].imageId && r.sortOrder === current.rows[i].sortOrder && r.isCover === current.rows[i].isCover);
      if (!sameShape) throw new Error("post-check failed: gallery order or primary image changed");
      logLine({ event: "db-update", status: "committed", productId: p.id, slug: p.slug, images: committed.length });
      done++;
      console.log(` OK  ${p.slug.slice(0, 70)}  ${committed.length} image(s) migrated`);
    } catch (error: any) {
      failed++;
      for (const r of etsyRows) if (state[r.imageId] && state[r.imageId].status !== "committed") Object.assign(state[r.imageId], { error: String(error?.message || error) });
      writeJson(F.state, state);
      logLine({ event: "upload", status: "failed", productId: p.id, slug: p.slug, error: String(error?.message || error) });
      console.log(` FAIL ${p.slug.slice(0, 70)}: ${error?.message || error}`);
    }
  }
  writeJson(F.mapping, Object.values(state).map((s) => ({ productId: s.productId, productSlug: s.slug, imageId: s.imageId, oldUrl: s.oldUrl, localPath: s.localPath, newUrl: s.newUrl, status: s.status })));
  console.log(`Run finished: ${done} product(s) migrated, ${failed} failed/skipped. Mapping: ${F.mapping}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Verification against the live data, status, rollback
// ---------------------------------------------------------------------------------------------------------------------
async function cmdVerifyLive() {
  const backup = readJson<any>(F.backup, null);
  if (!backup) throw new Error("No backup-original.json: nothing has been migrated yet.");
  const state = readJson<State>(F.state, {});
  const products = await loadProducts();
  const snap = await snapshotForBackup();
  const issues: string[] = [];
  const byId = new Map<string, any>((backup.productImages as any[]).map((r) => [r.id, r]));
  let checkedUrls = 0, migratedRows = 0, migratedProducts = new Set<string>();

  for (const p of products) {
    for (const r of p.rows) {
      const orig = byId.get(r.imageId);
      if (!orig) {
        issues.push(`${p.slug}: image row ${r.imageId} did not exist at backup time`);
        continue;
      }
      if (orig.sortOrder !== r.sortOrder || orig.isCover !== r.isCover || orig.productId !== p.id) issues.push(`${p.slug}#${r.position}: order/primary/product differs from backup`);
      const st = state[r.imageId];
      if (st?.status === "committed") {
        migratedRows++;
        migratedProducts.add(p.id);
        if (r.url !== st.newUrl) issues.push(`${p.slug}#${r.position}: database url is not the migrated url`);
        if (r.source === "etsy") issues.push(`${p.slug}#${r.position}: still an Etsy URL`);
        if (!r.mediaAssetId) issues.push(`${p.slug}#${r.position}: not linked to a media asset`);
        const res = await fetch(r.url, { signal: AbortSignal.timeout(45_000) });
        const buf = Buffer.from(await res.arrayBuffer());
        checkedUrls++;
        if (!res.ok) issues.push(`${p.slug}#${r.position}: ${r.url} answered HTTP ${res.status}`);
        else if (sha256(buf) !== st.sha256) issues.push(`${p.slug}#${r.position}: stored file differs from the downloaded one`);
        const asset = r.mediaAssetId ? await prisma.mediaAsset.findUnique({ where: { id: r.mediaAssetId } }) : null;
        if (!asset || asset.url !== r.url) issues.push(`${p.slug}#${r.position}: media asset missing or points elsewhere`);
      } else if (orig.url !== r.url || orig.mediaAssetId !== r.mediaAssetId) {
        issues.push(`${p.slug}#${r.position}: row not migrated but changed since backup`);
      }
    }
    if (p.rows.length !== (backup.productImages as any[]).filter((x) => x.productId === p.id).length) issues.push(`${p.slug}: image count differs from backup`);
    if (backup.productHash[p.id] && snap.productHash[p.id] !== backup.productHash[p.id]) issues.push(`${p.slug}: product or variant fields changed since backup`);
  }
  const remainingEtsy = products.reduce((n, p) => n + p.rows.filter((r) => r.source === "etsy").length, 0);
  const result = { at: now(), migratedProducts: migratedProducts.size, migratedImageRows: migratedRows, newUrlsChecked: checkedUrls, remainingEtsyRows: remainingEtsy, issues, passed: issues.length === 0 };
  writeJson(F.live, result);
  console.log(JSON.stringify({ ...result, issues: issues.slice(0, 30) }, null, 2));
}

async function cmdStatus() {
  const products = await loadProducts();
  const migrate = products.filter(needsMigration);
  const state = readJson<State>(F.state, {});
  const total = products.reduce((n, p) => n + p.rows.filter((r) => r.source === "etsy").length, 0);
  const backup = readJson<any>(F.backup, null);
  const originalEtsyRows = backup ? (backup.productImages as any[]).filter((r) => isEtsyUrl(r.url)).length : total;
  let downloaded = 0, failedDl = 0, pendingProducts = 0;
  for (const p of migrate) {
    const m = readManifest(p.slug);
    const etsy = m?.images.filter((i) => i.source === "etsy") ?? [];
    downloaded += etsy.filter((i) => i.downloadStatus === "completed").length;
    failedDl += etsy.filter((i) => i.downloadStatus === "failed").length;
    if (!m || etsy.some((i) => i.downloadStatus !== "completed")) pendingProducts++;
  }
  const entries = Object.values(state);
  const uploaded = entries.filter((s) => s.newUrl).length;
  const committed = entries.filter((s) => s.status === "committed").length;
  const failedUp = entries.filter((s) => s.error && s.status !== "committed").length;
  const base = Math.max(originalEtsyRows, total, 1);
  const dlTotal = base;
  const downloadedAll = downloaded + committed; // migrated rows no longer show as Etsy
  const overall = Math.round(((Math.min(downloadedAll, dlTotal) + uploaded + committed) / (3 * base)) * 100);
  console.log(
    [
      `Products in database       : ${products.length}`,
      `Products needing migration : ${new Set([...migrate.map((p) => p.id), ...entries.map((s) => s.productId)]).size}`,
      `Products pending           : ${pendingProducts}`,
      `Etsy image rows (original) : ${base}`,
      `Images downloaded          : ${downloaded}${committed ? ` (+${committed} already migrated)` : ""}`,
      `Images uploaded            : ${uploaded}`,
      `Failed downloads           : ${failedDl}`,
      `Failed uploads             : ${failedUp}`,
      `Database updates completed : ${committed} image rows in ${new Set(entries.filter((s) => s.status === "committed").map((s) => s.productId)).size} product(s)`,
      `Remaining Etsy rows in DB  : ${total}`,
      `Overall                    : ${overall}%`,
      `Paused                     : ${fs.existsSync(F.pause) ? "yes" : "no"}`,
    ].join("\n")
  );
}

async function cmdRollback() {
  const apply = flag("apply");
  const backup = readJson<any>(F.backup, null);
  const state = readJson<State>(F.state, {});
  if (!backup) throw new Error("No backup-original.json");
  const entries = Object.values(state).filter((s) => s.status === "committed" && (!ONLY || s.slug === ONLY));
  console.log(`${apply ? "APPLY" : "DRY RUN"}: restoring ${entries.length} image row(s) to their original references (files in Blob storage are kept).`);
  if (!apply) return;
  await prisma.$transaction(async (tx) => {
    for (const s of entries) {
      const orig = (backup.productImages as any[]).find((r) => r.id === s.imageId);
      if (!orig) continue;
      await tx.productImage.update({ where: { id: s.imageId }, data: { url: orig.url, mediaAssetId: orig.mediaAssetId } });
      if (s.mediaAssetId) await tx.mediaAsset.deleteMany({ where: { id: s.mediaAssetId, productImages: { none: {} } } });
      delete state[s.imageId];
    }
  });
  writeJson(F.state, state);
  logLine({ event: "rollback", rows: entries.length });
}

// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(MIG, { recursive: true });
  switch (command) {
    case "inventory": return cmdInventory();
    case "download": return cmdDownload();
    case "verify": return cmdVerify();
    case "upload": return cmdUpload();
    case "verify-live": return cmdVerifyLive();
    case "status": return cmdStatus();
    case "pause": fs.writeFileSync(F.pause, now()); console.log("Pause requested: the running command stops after its current product."); return;
    case "resume": fs.rmSync(F.pause, { force: true }); console.log("Pause cleared."); return;
    case "export": return cmdVerify();
    case "rollback": return cmdRollback();
    default:
      console.log("Commands: inventory | download | verify | upload [--apply] | verify-live | status | pause | resume | export | rollback [--apply]\nOptions: --limit N  --only <slug>  --concurrency N  --delay ms");
  }
}
main()
  .catch((e) => {
    console.error("ERROR:", e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
