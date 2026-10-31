import {
  EtsyImageItem,
  EtsyRawRow,
  EtsyVariationGroup,
} from "./etsy-import.types.js";

/**
 * Robust RFC-4180 compliant CSV parser.
 * Handles:
 * - UTF-8 Byte Order Mark (BOM)
 * - Multiline text fields with embedded \r\n and \n
 * - Escaped double quotes ("")
 * - Commas inside quoted strings
 * - Trailing whitespace and empty records
 */
export function parseRFC4180CSV(input: Buffer | string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  let text = typeof input === "string" ? input : input.toString("utf8");

  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const resultRows: string[][] = [];
  let currentRow: string[] = [""];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        currentRow[currentRow.length - 1] += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      currentRow.push("");
    } else if ((c === "\r" || c === "\n") && !inQuotes) {
      if (c === "\r" && next === "\n") {
        i++; // handle CRLF
      }
      resultRows.push(currentRow);
      currentRow = [""];
    } else {
      currentRow[currentRow.length - 1] += c;
    }
  }

  // Push trailing record if non-empty
  if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== "")) {
    resultRows.push(currentRow);
  }

  if (resultRows.length === 0) {
    return { headers: [], rows: [] };
  }

  // Standardize header names
  const rawHeaders = resultRows[0].map((h) =>
    h.trim().replace(/^["']|["']$/g, "").toUpperCase()
  );

  const rows: Record<string, string>[] = [];

  for (let r = 1; r < resultRows.length; r++) {
    const rawRow = resultRows[r];
    // Skip empty lines
    if (rawRow.length === 1 && rawRow[0].trim() === "") continue;

    const rowObj: Record<string, string> = {};
    for (let c = 0; c < rawHeaders.length; c++) {
      const header = rawHeaders[c];
      const val = rawRow[c] !== undefined ? rawRow[c] : "";
      rowObj[header] = val;
    }
    rows.push(rowObj);
  }

  return { headers: rawHeaders, rows };
}

/**
 * Validates that all critical Etsy CSV columns exist in the file.
 */
export function validateEtsyHeaders(headers: string[]): {
  isValid: boolean;
  missingHeaders: string[];
} {
  const normalized = headers.map((h) => h.toUpperCase());
  const critical = ["TITLE", "PRICE", "CURRENCY_CODE"];
  const missing = critical.filter((ch) => !normalized.includes(ch));
  return {
    isValid: missing.length === 0,
    missingHeaders: missing,
  };
}

/**
 * Extracts and maps all product images (IMAGE1 through IMAGE10) in strict order.
 */
export function extractImages(row: Record<string, string>, title: string): EtsyImageItem[] {
  const images: EtsyImageItem[] = [];

  for (let k = 1; k <= 10; k++) {
    const key = `IMAGE${k}`;
    const rawUrl = row[key];
    if (rawUrl && typeof rawUrl === "string" && rawUrl.trim()) {
      const trimmed = rawUrl.trim();
      images.push({
        url: trimmed,
        order: k,
        isCover: k === 1,
      });
    }
  }

  return images;
}

/**
 * Extracts all 3 variation groups from the Etsy CSV.
 */
export function extractVariations(row: Record<string, string>): EtsyVariationGroup[] {
  const variations: EtsyVariationGroup[] = [];

  for (let g = 1; g <= 3; g++) {
    const typeKey = `VARIATION ${g} TYPE`;
    const nameKey = `VARIATION ${g} NAME`;
    const valuesKey = `VARIATION ${g} VALUES`;

    const type = (row[typeKey] || "").trim();
    const name = (row[nameKey] || "").trim();
    const rawValues = (row[valuesKey] || "").trim();

    if (type || name || rawValues) {
      // Values are typically comma-separated
      const values = rawValues
        ? rawValues
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
        : [];

      variations.push({
        type,
        name: name || `Variation ${g}`,
        rawValues,
        values,
      });
    }
  }

  return variations;
}

/**
 * Extracts tags from comma-separated TAGS column.
 * Preserves all tags without dropping or modifying.
 */
export function extractTags(rawTags: string | undefined): string[] {
  if (!rawTags || typeof rawTags !== "string") return [];
  return rawTags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Extracts materials from comma-separated MATERIALS column.
 */
export function extractMaterials(rawMaterials: string | undefined): string[] {
  if (!rawMaterials || typeof rawMaterials !== "string") return [];
  return rawMaterials
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * Generates an RFC-4180 compliant CSV string with Formula Injection Protection.
 * Protects against CSV Injection by prefixing formula triggers (=, +, -, @, \t, \r) with '.
 */
export function generateSafeCSV(
  headers: string[],
  rows: Record<string, any>[]
): string {
  const sanitizeCell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    let str = String(value);

    // Guard against CSV Formula Injection (DDE injection)
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }

    // Escape quotes and wrap in quotes if containing comma, newline or quotes
    if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headerRow = headers.map(sanitizeCell).join(",");
  const dataRows = rows.map((row) =>
    headers.map((h) => sanitizeCell(row[h])).join(",")
  );

  return [headerRow, ...dataRows].join("\r\n");
}

