import { Request, Response, NextFunction } from "express";
import {
  executeEtsyImport,
  generateEtsyPreview,
  getEtsyImportHistory,
  getEtsyImportStatus,
  getFailedRowsCSV,
  httpError,
} from "./etsy-import.service.js";
import { EtsyConfirmImportSchema } from "./etsy-import.types.js";

export async function handleEtsyPreview(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.file) {
      throw httpError(400, "Please upload a valid CSV file.");
    }

    const filename = req.file.originalname || "EtsyListingsDownload.csv";

    // Validate extension
    if (!filename.toLowerCase().endsWith(".csv")) {
      throw httpError(400, "Only files with a .csv extension are supported.");
    }

    const preview = await generateEtsyPreview(req.file.buffer, filename);

    res.status(200).json({
      status: "success",
      data: preview,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleEtsyConfirm(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const parsed = EtsyConfirmImportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw httpError(
        400,
        parsed.error.errors.map((e) => e.message).join(", ")
      );
    }

    const user = (req as any).user;
    const actorUserId = user?.id || "admin-system";
    const actorName =
      user?.profile?.displayName || user?.fullName || user?.email || "Administrator";

    const summary = await executeEtsyImport(
      parsed.data,
      actorUserId,
      actorName,
      {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }
    );

    res.status(200).json({
      status: "success",
      data: summary,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleEtsyStatus(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const rawId = req.params.importId;
    const importId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!importId) {
      throw httpError(400, "Import ID is required.");
    }

    const status = await getEtsyImportStatus(importId);
    if (!status) {
      throw httpError(404, "Import record not found.");
    }

    res.status(200).json({
      status: "success",
      data: status,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleEtsyHistory(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const history = await getEtsyImportHistory();
    res.status(200).json({
      status: "success",
      data: history,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleEtsyDownloadFailedCSV(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const rawId = req.params.importId;
    const importId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!importId) {
      throw httpError(400, "Import ID is required.");
    }

    const csvContent = await getFailedRowsCSV(importId);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="etsy-import-failed-${importId.slice(0, 8)}.csv"`
    );
    res.status(200).send(csvContent);
  } catch (error) {
    next(error);
  }
}
