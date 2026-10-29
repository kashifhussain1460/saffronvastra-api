import { Request, Response } from "express";
import fs from "node:fs";
import {
  getMediaAssets,
  createMediaAsset,
  updateMediaAsset,
  deleteMediaAsset,
  detectImage,
  safeDisplayName,
  validFolder,
  sha256OfFile,
  replaceMediaFile,
} from "./media.service.js";
import { prisma } from "../../database/prisma.js";
import { publishStagedFile } from "../../common/storage.js";
import { blobImportAvailable, importFromBlob } from "./blobImport.service.js";

// Expected errors carry a statusCode and a safe message; anything else is logged and replaced.
function sendError(res: Response, error: any, fallbackMessage: string) {
  if (error?.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({
      status: "error",
      message: error.message,
      ...(error.usage ? { usage: error.usage } : {}),
    });
  }
  console.error(fallbackMessage, error);
  return res.status(500).json({ status: "error", message: fallbackMessage });
}

export async function handleGetMedia(req: Request, res: Response) {
  try {
    const { folder, search, page, limit } = req.query;
    const result = await getMediaAssets({
      folder: typeof folder === "string" ? folder : undefined,
      search: typeof search === "string" ? search : undefined,
      page: page ? parseInt(page as string, 10) || 1 : 1,
      limit: limit ? parseInt(limit as string, 10) || 24 : 24,
    });

    return res.status(200).json({ status: "success", ...result });
  } catch (error: any) {
    return sendError(res, error, "The media library could not be loaded.");
  }
}

export async function handleUpdateMedia(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const updated = await updateMediaAsset(id as string, req.body);
    return res.status(200).json({ status: "success", data: updated });
  } catch (error: any) {
    return sendError(res, error, "The media asset could not be updated.");
  }
}

// Finds images put into the Blob store by hand, adds them to the library and links them (see blobImport.service.ts).
// The caller repeats the request with nextCursor until done is true.
export async function handleImportFromBlob(req: Request, res: Response) {
  if (!blobImportAvailable()) {
    return res.status(400).json({ status: "error", message: "Blob storage is not connected to this server (BLOB_READ_WRITE_TOKEN is not set)." });
  }
  try {
    const cursor = typeof req.body?.cursor === "string" ? req.body.cursor : undefined;
    const batchSize = Number.isFinite(Number(req.body?.batchSize)) ? Number(req.body.batchSize) : undefined;
    const report = await importFromBlob({ cursor, batchSize, actorUserId: (req as any).user?.id || null });
    return res.status(200).json({ status: "success", data: report });
  } catch (error: any) {
    return sendError(res, error, "The import from Blob failed.");
  }
}

export async function handleDeleteMedia(req: Request, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await deleteMediaAsset(id as string);
    return res.status(200).json({ status: "success", message: "Media asset deleted" });
  } catch (error: any) {
    return sendError(res, error, "The media asset could not be deleted.");
  }
}

// Trust the file's own bytes, not the declared Content-Type or the file name.
async function inspectUpload(file: Express.Multer.File): Promise<{ detected: { mime: string; width: number | null; height: number | null } } | { error: string }> {
  const head = Buffer.alloc(64);
  const fd = await fs.promises.open(file.path, "r");
  try {
    await fd.read(head, 0, 64, 0);
  } finally {
    await fd.close();
  }
  const detected = detectImage(head);
  if (!detected) return { error: "The file is not a valid JPEG, PNG, WebP, GIF or AVIF image" };
  if (detected.mime !== file.mimetype) return { error: "The file content does not match its declared image type" };
  return { detected };
}

export async function handleUploadMedia(req: Request, res: Response) {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ status: "error", message: "No image file provided" });
  }
  const discard = () => fs.promises.unlink(file.path).catch(() => undefined);
  try {
    const inspected = await inspectUpload(file);
    if ("error" in inspected) {
      await discard();
      return res.status(400).json({ status: "error", message: inspected.error });
    }
    const { detected } = inspected;

    // The same picture uploaded twice is not stored twice: the existing asset is returned instead.
    const sha256 = await sha256OfFile(file.path);
    const existing = await prisma.mediaAsset.findFirst({ where: { sha256 } });
    if (existing) {
      await discard();
      return res.status(200).json({ status: "success", duplicate: true, message: `This image is already in the library as "${existing.name}".`, data: existing });
    }

    const folder = validFolder(req.body.folder);
    const name = safeDisplayName(file.originalname);
    const altText = typeof req.body.altText === "string" && req.body.altText.trim()
      ? req.body.altText.trim().slice(0, 200)
      : name.replace(/\.[^/.]+$/, "");

    const stored = await publishStagedFile(file.path, file.filename, detected.mime);
    const asset = await createMediaAsset({
      name,
      url: stored.url,
      storageKey: stored.storageKey,
      folder,
      mimeType: detected.mime,
      bytes: file.size,
      width: detected.width,
      height: detected.height,
      altText,
      uploadedByUserId: (req as any).user?.id || null,
      sha256,
    });

    return res.status(201).json({ status: "success", data: asset });
  } catch (error: any) {
    await discard();
    return sendError(res, error, "The image could not be uploaded.");
  }
}

export async function handleReplaceMedia(req: Request, res: Response) {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const file = req.file;
  if (!file) return res.status(400).json({ status: "error", message: "No image file provided" });
  const discard = () => fs.promises.unlink(file.path).catch(() => undefined);
  try {
    const inspected = await inspectUpload(file);
    if ("error" in inspected) {
      await discard();
      return res.status(400).json({ status: "error", message: inspected.error });
    }
    const sha256 = await sha256OfFile(file.path);
    const current = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!current) {
      await discard();
      return res.status(404).json({ status: "error", message: "Media asset not found" });
    }
    if (current.sha256 === sha256) {
      await discard();
      return res.status(200).json({ status: "success", unchanged: true, message: "This is the same image; nothing was changed.", data: current });
    }
    const stored = await publishStagedFile(file.path, file.filename, inspected.detected.mime);
    const result = await replaceMediaFile(id, {
      url: stored.url,
      storageKey: stored.storageKey,
      mimeType: inspected.detected.mime,
      bytes: file.size,
      width: inspected.detected.width,
      height: inspected.detected.height,
      sha256,
    });
    return res.status(200).json({ status: "success", data: result.asset, previousUrl: result.previousUrl, references: result.references });
  } catch (error: any) {
    await discard();
    return sendError(res, error, "The image could not be replaced.");
  }
}
