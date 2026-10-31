import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { requireAdmin } from "../../common/auth.middleware.js";
import {
  handleEtsyConfirm,
  handleEtsyDownloadFailedCSV,
  handleEtsyHistory,
  handleEtsyPreview,
  handleEtsyStatus,
} from "./etsy-import.controller.js";

export const etsyImportRouter = Router();

// Enforce administrative authorization across all Etsy import operations
etsyImportRouter.use(requireAdmin);

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB
  },
  fileFilter: (_req, file, cb) => {
    // Check filename extension and common CSV mimetypes
    const isCsvName = file.originalname.toLowerCase().endsWith(".csv");
    if (isCsvName) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed for Etsy import."));
    }
  },
});

const uploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  upload.single("file")(req, res, (err: any) => {
    if (err) {
      if (err?.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          status: "error",
          message: "The uploaded CSV file is too large. Maximum size is 15 MB.",
        });
      }
      return res.status(400).json({ status: "error", message: err.message });
    }
    next();
  });
};

// Route Definitions
etsyImportRouter.post("/preview", uploadMiddleware, handleEtsyPreview);
etsyImportRouter.post("/confirm", handleEtsyConfirm);
etsyImportRouter.get("/history", handleEtsyHistory);
etsyImportRouter.get("/history/:importId/failed-csv", handleEtsyDownloadFailedCSV);
etsyImportRouter.get("/:importId/status", handleEtsyStatus);

