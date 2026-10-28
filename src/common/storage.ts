import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { del, put } from "@vercel/blob";
import { env } from "../config/env.js";

/**
 * Where uploaded images are kept.
 *  - Local development and a normal server: the folder public/uploads, served at /uploads.
 *  - Vercel: the disk does not persist, so files go to Vercel Blob (the store's token is BLOB_READ_WRITE_TOKEN) and the
 *    address saved in the database is the Blob https address. Files are first written to a temporary folder so the
 *    existing checks (real file type, duplicate check) run before anything is published.
 */
export const useBlob = Boolean(env.BLOB_READ_WRITE_TOKEN);

/** Folder multer writes to before a file is checked and published. */
export const STAGING_DIR = useBlob ? path.join(os.tmpdir(), "saffron-uploads") : path.resolve(process.cwd(), "public/uploads");
/** The permanent folder on a server with a disk. Not used for new files when Blob storage is configured. */
export const LOCAL_UPLOAD_DIR = path.resolve(process.cwd(), "public/uploads");

/** A Vercel function accepts a request body of at most 4.5 MB, so uploads there are capped just below that. */
export const MAX_UPLOAD_BYTES = env.ON_VERCEL ? 4 * 1024 * 1024 : 15 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`;

fs.mkdirSync(STAGING_DIR, { recursive: true });

export interface StoredFile {
  url: string;
  storageKey: string;
}

/** Publishes a file already checked and sitting in STAGING_DIR. With Blob storage the temporary file is removed. */
export async function publishStagedFile(localPath: string, filename: string, contentType: string): Promise<StoredFile> {
  if (!useBlob) return { url: `/uploads/${filename}`, storageKey: `uploads/${filename}` };
  const stored = await put(`uploads/${filename}`, fs.createReadStream(localPath), { access: "public", addRandomSuffix: false, contentType });
  await fs.promises.unlink(localPath).catch(() => undefined);
  return { url: stored.url, storageKey: stored.pathname };
}

/** Publishes an in-memory file (used for the photos customers attach to a return request). */
export async function publishBuffer(subfolder: string, filename: string, data: Buffer, contentType: string): Promise<StoredFile> {
  if (useBlob) {
    const stored = await put(`uploads/${subfolder}/${filename}`, data, { access: "public", addRandomSuffix: false, contentType });
    return { url: stored.url, storageKey: stored.pathname };
  }
  const dir = path.join(LOCAL_UPLOAD_DIR, subfolder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), data, { flag: "wx" });
  return { url: `/uploads/${subfolder}/${filename}`, storageKey: `uploads/${subfolder}/${filename}` };
}

/** True when the address is a file this system stored (a local /uploads path or a Blob address). */
export function isStoredUrl(url: string): boolean {
  return url.startsWith("/uploads/") || /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//.test(url);
}

/** Deletes a stored file. Never throws: a file that is already gone is not an error. */
export async function removeStored(url: string): Promise<void> {
  try {
    if (url.startsWith("/uploads/")) {
      const file = path.resolve(LOCAL_UPLOAD_DIR, url.slice("/uploads/".length));
      if (file.startsWith(LOCAL_UPLOAD_DIR + path.sep)) await fs.promises.unlink(file).catch(() => undefined);
    } else if (useBlob && /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//.test(url)) {
      await del(url);
    }
  } catch (error) {
    console.error("[storage] could not delete", url, error);
  }
}
