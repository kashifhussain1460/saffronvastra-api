// Garment measurements per size (inches), stored on Product.measurements and shown on the product page.
// The standard charts below are the shop's default, based on common Indian unisex jacket sizing (chest 38/40/42/44 in
// for S–XL with matching shoulder, sleeve and length); the owner can replace a product's rows with measured values.
import { Prisma } from "@prisma/client";

export const MEASUREMENT_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "Free Size"] as const;

export interface MeasurementRow {
  size: string;
  fitsChestMin?: number; // body chest this size fits (inches)
  fitsChestMax?: number;
  chest: number; // garment chest, measured all round
  shoulder?: number; // shoulder seam to shoulder seam (not for drop-shoulder kimonos)
  sleeve?: number; // shoulder seam to cuff
  length: number; // back neck to hem
}

export interface ProductMeasurements {
  note?: string;
  rows: MeasurementRow[];
}

export const STANDARD_NOTE =
  "Standard measurements for this style. Each piece is hand embroidered and made to order, so measurements can vary by up to 1 inch (2.5 cm).";

// Fitted / hip-length jackets (most of the catalogue).
export const STANDARD_JACKET: ProductMeasurements = {
  note: STANDARD_NOTE,
  rows: [
    { size: "S", fitsChestMin: 34, fitsChestMax: 36, chest: 38, shoulder: 16, sleeve: 23, length: 26 },
    { size: "M", fitsChestMin: 36, fitsChestMax: 38, chest: 40, shoulder: 16.5, sleeve: 23.5, length: 26.5 },
    { size: "L", fitsChestMin: 38, fitsChestMax: 40, chest: 42, shoulder: 17, sleeve: 24, length: 27 },
    { size: "XL", fitsChestMin: 40, fitsChestMax: 42, chest: 44, shoulder: 17.5, sleeve: 24.5, length: 27.5 },
    { size: "Free Size", fitsChestMin: 34, fitsChestMax: 42, chest: 46, shoulder: 18, sleeve: 23, length: 28 },
  ],
};

// Long, open-front kimono jackets: relaxed chest, drop shoulder (no shoulder seam), below-hip length.
export const STANDARD_LONG_KIMONO: ProductMeasurements = {
  note: STANDARD_NOTE,
  rows: [
    { size: "S", fitsChestMin: 34, fitsChestMax: 36, chest: 42, sleeve: 21, length: 36 },
    { size: "M", fitsChestMin: 36, fitsChestMax: 38, chest: 44, sleeve: 21, length: 36.5 },
    { size: "L", fitsChestMin: 38, fitsChestMax: 40, chest: 46, sleeve: 21.5, length: 37 },
    { size: "XL", fitsChestMin: 40, fitsChestMax: 42, chest: 48, sleeve: 22, length: 37.5 },
    { size: "Free Size", fitsChestMin: 34, fitsChestMax: 42, chest: 48, sleeve: 21, length: 37 },
  ],
};

// Sleeveless vests and waistcoats: the jacket body (Nehru-jacket proportions) without a sleeve.
export const STANDARD_VEST: ProductMeasurements = {
  note: STANDARD_NOTE,
  rows: STANDARD_JACKET.rows.map(({ sleeve: _sleeve, ...rest }) => rest),
};

export type StandardKind = "jacket" | "long-kimono" | "vest";

// The standard chart for a product, limited to the sizes it is sold in (all sizes when none are given).
export function standardMeasurementsFor(kind: StandardKind, sizes?: string[]): ProductMeasurements {
  const chart = kind === "long-kimono" ? STANDARD_LONG_KIMONO : kind === "vest" ? STANDARD_VEST : STANDARD_JACKET;
  const wanted = sizes && sizes.length ? new Set(sizes) : null;
  return { note: chart.note, rows: chart.rows.filter((r) => !wanted || wanted.has(r.size)).map((r) => ({ ...r })) };
}

function httpError(status: number, message: string) {
  const error: any = new Error(message);
  error.statusCode = status;
  return error;
}

const RANGES: Record<string, [number, number]> = {
  fitsChestMin: [20, 70],
  fitsChestMax: [20, 70],
  chest: [20, 80],
  shoulder: [8, 30],
  sleeve: [4, 40],
  length: [10, 70],
};

// Validates measurements from the admin form or a script. undefined = not given; null/empty = clear them.
export function normalizeMeasurements(value: unknown): ProductMeasurements | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) throw httpError(400, "Measurements must be an object with rows");
  const input = value as { note?: unknown; rows?: unknown };
  if (!Array.isArray(input.rows)) throw httpError(400, "Measurements must include a list of rows");
  if (input.rows.length === 0) return null;
  if (input.rows.length > MEASUREMENT_SIZES.length) throw httpError(400, "Measurements can have at most one row per size");

  const seen = new Set<string>();
  const rows: MeasurementRow[] = input.rows.map((raw: any, i: number) => {
    const size = typeof raw?.size === "string" ? raw.size.trim() : "";
    if (!(MEASUREMENT_SIZES as readonly string[]).includes(size)) throw httpError(400, `Measurement row ${i + 1}: unknown size "${size}"`);
    if (seen.has(size)) throw httpError(400, `Measurements list size ${size} more than once`);
    seen.add(size);
    const row: any = { size };
    for (const [key, [min, max]] of Object.entries(RANGES)) {
      const v = raw?.[key];
      if (v === undefined || v === null || v === "") {
        if (key === "chest" || key === "length") throw httpError(400, `Size ${size}: ${key} is required`);
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw httpError(400, `Size ${size}: ${key} must be between ${min} and ${max} inches`);
      row[key] = Math.round(n * 4) / 4; // quarter-inch precision
    }
    if (row.fitsChestMin !== undefined && row.fitsChestMax !== undefined && row.fitsChestMin > row.fitsChestMax) {
      throw httpError(400, `Size ${size}: "fits chest from" must not be larger than "fits chest to"`);
    }
    return row as MeasurementRow;
  });

  // keep the usual size order whatever order the form sent
  rows.sort((a, b) => MEASUREMENT_SIZES.indexOf(a.size as any) - MEASUREMENT_SIZES.indexOf(b.size as any));
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 300) : undefined;
  return note ? { note, rows } : { rows };
}

// Prisma needs DbNull (not plain null) to clear a Json column.
export const measurementsForWrite = (m: ProductMeasurements | null) =>
  m === null ? Prisma.DbNull : (m as unknown as Prisma.InputJsonValue);
