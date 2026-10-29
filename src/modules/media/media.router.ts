import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import path from "node:path";
import {
  handleGetMedia,
  handleUpdateMedia,
  handleDeleteMedia,
  handleUploadMedia,
  handleReplaceMedia,
  handleImportFromBlob,
} from "./media.controller.js";
import { ALLOWED_IMAGE_TYPES } from "./media.service.js";
import { requireAdmin } from "../../common/auth.middleware.js";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, STAGING_DIR } from "../../common/storage.js";

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, STAGING_DIR);
  },
  filename: (_req, file, cb) => {
    // The stored extension comes from the validated mimetype, never from the client's filename.
    const ext = ALLOWED_IMAGE_TYPES[file.mimetype] || ".bin";
    const base = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 60);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, WebP, GIF or AVIF images are allowed"));
    }
  },
});

const uploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  upload.fields([{ name: "file", maxCount: 1 }, { name: "image", maxCount: 1 }])(req, res, (err: any) => {
    if (err) {
      // Drain the rest of the upload so the connection (and any proxy in front) can finish cleanly.
      req.resume();
      if (err?.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ status: "error", message: `The image is too large. The maximum size is ${MAX_UPLOAD_LABEL}.` });
      }
      return res.status(400).json({ status: "error", message: err.message });
    }
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    if (files) {
      if (files["file"]?.[0]) req.file = files["file"][0];
      else if (files["image"]?.[0]) req.file = files["image"][0];
    }
    next();
  });
};

export const mediaRouter = Router();

mediaRouter.use(requireAdmin);

mediaRouter.get("/", handleGetMedia);
mediaRouter.post("/upload", uploadMiddleware, handleUploadMedia);
mediaRouter.post("/import-blob", handleImportFromBlob);
mediaRouter.post("/:id/replace", uploadMiddleware, handleReplaceMedia);
mediaRouter.patch("/:id", handleUpdateMedia);
mediaRouter.delete("/:id", handleDeleteMedia);
