import { z } from "zod";

export interface EtsyRawRow {
  TITLE: string;
  DESCRIPTION: string;
  PRICE: string;
  CURRENCY_CODE: string;
  QUANTITY: string;
  TAGS: string;
  MATERIALS: string;
  IMAGE1?: string;
  IMAGE2?: string;
  IMAGE3?: string;
  IMAGE4?: string;
  IMAGE5?: string;
  IMAGE6?: string;
  IMAGE7?: string;
  IMAGE8?: string;
  IMAGE9?: string;
  IMAGE10?: string;
  "VARIATION 1 TYPE"?: string;
  "VARIATION 1 NAME"?: string;
  "VARIATION 1 VALUES"?: string;
  "VARIATION 2 TYPE"?: string;
  "VARIATION 2 NAME"?: string;
  "VARIATION 2 VALUES"?: string;
  "VARIATION 3 TYPE"?: string;
  "VARIATION 3 NAME"?: string;
  "VARIATION 3 VALUES"?: string;
  SKU?: string;
  [key: string]: string | undefined;
}

export interface EtsyVariationGroup {
  type: string;
  name: string;
  rawValues: string;
  values: string[];
}

export interface EtsyImageItem {
  url: string;
  order: number;
  isCover: boolean;
  accessible?: boolean;
  error?: string;
}

export interface EtsyProductRowPreview {
  rowIndex: number;
  title: string;
  slug: string;
  description: string;
  price: number;
  basePriceMinor: number;
  currency: string;
  quantity: number;
  sku: string;
  tags: string[];
  materials: string[];
  images: EtsyImageItem[];
  variations: EtsyVariationGroup[];
  hasVariations: boolean;
  validation: {
    isValid: boolean;
    status: "valid" | "warning" | "error";
    errors: string[];
    warnings: string[];
    isDuplicate: boolean;
    duplicateReason?: string;
    existingProductId?: string;
  };
  rawRow: Record<string, string>;
}

export interface EtsyPreviewStats {
  totalRows: number;
  validProducts: number;
  invalidRows: number;
  warningsCount: number;
  duplicateRecords: number;
  missingTitles: number;
  missingPrices: number;
  missingImages: number;
  productsWithVariations: number;
  productsWithSku: number;
}

export interface EtsyPreviewResponse {
  importSessionId: string;
  filename: string;
  fileSizeBytes: number;
  stats: EtsyPreviewStats;
  products: EtsyProductRowPreview[];
}

export type DuplicatePolicy = "skip" | "update" | "create_new";

export const EtsyConfirmImportSchema = z.object({
  importSessionId: z.string().min(1, "Import session ID is required"),
  duplicatePolicy: z.enum(["skip", "update", "create_new"]).default("skip"),
  status: z.enum(["Active", "Draft"]).default("Active"),
});

export type EtsyConfirmImportInput = z.infer<typeof EtsyConfirmImportSchema>;

export interface EtsyImportItemResult {
  rowIndex: number;
  title: string;
  sku: string;
  slug: string;
  productId?: string;
  status: "created" | "updated" | "skipped" | "failed";
  reason?: string;
  imageCount: number;
  variantCount: number;
}

export interface EtsyFailedRow {
  rowIndex: number;
  title: string;
  sku: string;
  reason: string;
  rawRow: Record<string, string>;
}

export interface EtsyImportExecutionSummary {
  importId: string;
  filename: string;
  importedAt: string;
  importedByUserId: string;
  importedByName: string;
  duplicatePolicy: DuplicatePolicy;
  totalRecords: number;
  successfulImports: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  status: "completed" | "partial" | "failed";
  results: EtsyImportItemResult[];
  failedRows: EtsyFailedRow[];
}

export interface EtsyImportHistoryItem {
  importId: string;
  filename: string;
  importedAt: string;
  importedByUserId?: string;
  importedByName?: string;
  totalRecords: number;
  successfulImports: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  duplicatePolicy: string;
  status: string;
}

