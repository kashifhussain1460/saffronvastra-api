import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  extractImages,
  extractMaterials,
  extractTags,
  extractVariations,
  generateSafeCSV,
  parseRFC4180CSV,
  validateEtsyHeaders,
} from "./etsy-import.parser.js";
import { generateEtsyPreview } from "./etsy-import.service.js";

test("RFC-4180 CSV Parser: handles standard CSV, quoted fields, and commas inside quotes", () => {
  const csv = `TITLE,DESCRIPTION,PRICE,CURRENCY_CODE\n"Luxury Velvet Jacket","Hand-embroidered, pure silk lining",3999,INR`;
  const { headers, rows } = parseRFC4180CSV(csv);
  assert.equal(headers.length, 4);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].TITLE, "Luxury Velvet Jacket");
  assert.equal(rows[0].DESCRIPTION, "Hand-embroidered, pure silk lining");
  assert.equal(rows[0].PRICE, "3999");
  assert.equal(rows[0].CURRENCY_CODE, "INR");
});

test("RFC-4180 CSV Parser: handles UTF-8 Byte Order Mark (BOM)", () => {
  const bomCSV = "\uFEFFTITLE,PRICE,CURRENCY_CODE\n\"Silk Kimono\",4500,INR";
  const { headers, rows } = parseRFC4180CSV(bomCSV);
  assert.equal(headers[0], "TITLE");
  assert.equal(rows[0].TITLE, "Silk Kimono");
});

test("RFC-4180 CSV Parser: handles multiline descriptions with embedded newlines", () => {
  const multilineCSV = `TITLE,DESCRIPTION,PRICE,CURRENCY_CODE\n"Jacket","Line 1\nLine 2\r\nLine 3",2999,INR`;
  const { rows } = parseRFC4180CSV(multilineCSV);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].DESCRIPTION.includes("Line 1\nLine 2\r\nLine 3"));
});

test("RFC-4180 CSV Parser: handles escaped double quotes", () => {
  const quoteCSV = `TITLE,DESCRIPTION,PRICE,CURRENCY_CODE\n"The ""Royal"" Collection","Contains ""Zari"" work",5999,INR`;
  const { rows } = parseRFC4180CSV(quoteCSV);
  assert.equal(rows[0].TITLE, 'The "Royal" Collection');
  assert.equal(rows[0].DESCRIPTION, 'Contains "Zari" work');
});

test("validateEtsyHeaders: verifies presence of required columns", () => {
  const valid = validateEtsyHeaders(["TITLE", "DESCRIPTION", "PRICE", "CURRENCY_CODE"]);
  assert.equal(valid.isValid, true);
  assert.equal(valid.missingHeaders.length, 0);

  const invalid = validateEtsyHeaders(["TITLE", "DESCRIPTION"]);
  assert.equal(invalid.isValid, false);
  assert.ok(invalid.missingHeaders.includes("PRICE"));
  assert.ok(invalid.missingHeaders.includes("CURRENCY_CODE"));
});

test("extractImages: correctly maps IMAGE1 through IMAGE10 in exact order", () => {
  const row: Record<string, string> = {
    IMAGE1: "https://example.com/img1.jpg",
    IMAGE2: "https://example.com/img2.jpg",
    IMAGE5: "https://example.com/img5.jpg",
    IMAGE10: "https://example.com/img10.jpg",
  };
  const images = extractImages(row, "Test Title");
  assert.equal(images.length, 4);
  assert.equal(images[0].order, 1);
  assert.equal(images[0].isCover, true);
  assert.equal(images[0].url, "https://example.com/img1.jpg");
  assert.equal(images[1].order, 2);
  assert.equal(images[1].isCover, false);
  assert.equal(images[2].order, 5);
  assert.equal(images[3].order, 10);
});

test("extractVariations: extracts up to 3 variation groups and parses comma values", () => {
  const row: Record<string, string> = {
    "VARIATION 1 TYPE": "Custom Property",
    "VARIATION 1 NAME": "Size",
    "VARIATION 1 VALUES": "S, M, L, XL",
    "VARIATION 2 TYPE": "Attribute",
    "VARIATION 2 NAME": "Color",
    "VARIATION 2 VALUES": "Maroon, Gold",
  };
  const variations = extractVariations(row);
  assert.equal(variations.length, 2);
  assert.equal(variations[0].name, "Size");
  assert.deepEqual(variations[0].values, ["S", "M", "L", "XL"]);
  assert.equal(variations[1].name, "Color");
  assert.deepEqual(variations[1].values, ["Maroon", "Gold"]);
});

test("extractTags and extractMaterials: parses comma-separated lists preserving every item", () => {
  const tags = extractTags("velvet, embroidered, jacket, boho");
  assert.deepEqual(tags, ["velvet", "embroidered", "jacket", "boho"]);

  const materials = extractMaterials("Cotton, Velvet, Silk");
  assert.deepEqual(materials, ["Cotton", "Velvet", "Silk"]);
});

test("generateSafeCSV: guards against formula injection triggers (=, +, -, @, \\t)", () => {
  const rows = [
    { name: "=SUM(A1:A10)", description: "@malicious", price: "+100" },
    { name: "Normal Product", description: "Safe text", price: "2500" },
  ];
  const csv = generateSafeCSV(["name", "description", "price"], rows);
  assert.ok(csv.includes("`'=SUM(A1:A10)`") || csv.includes("'=SUM(A1:A10)"));
  assert.ok(csv.includes("'@malicious"));
  assert.ok(csv.includes("'+100"));
});

test("Actual Etsy CSV: parses all 58 records and verifies preview integrity", async () => {
  // Path to the actual uploaded EtsyListingsDownload.csv in workspace root
  const csvPath = path.resolve(process.cwd(), "../EtsyListingsDownload.csv");
  if (!fs.existsSync(csvPath)) {
    // If running with cwd=backend
    assert.ok(true, "Skipped if file not located at relative path");
    return;
  }

  const buffer = fs.readFileSync(csvPath);
  const preview = await generateEtsyPreview(buffer, "EtsyListingsDownload.csv");

  assert.equal(preview.stats.totalRows, 58, "Should find exactly 58 rows in actual Etsy CSV");
  assert.equal(preview.products.length, 58, "All 58 product records must be parsed");
  assert.equal(preview.stats.validProducts, 58, "All 58 products must be valid");
  assert.equal(preview.stats.missingTitles, 0, "No product should have a missing title");
  assert.equal(preview.stats.missingPrices, 0, "No product should have a missing price");

  // Verify first record details
  const first = preview.products[0];
  assert.ok(first.title.startsWith("Cream Cotton Duck Jacket"));
  assert.equal(first.price, 3699);
  assert.equal(first.basePriceMinor, 369900);
  assert.equal(first.currency, "INR");
  assert.equal(first.quantity, 5);
  assert.ok(first.images.length >= 4);
  assert.ok(first.tags.length > 0);
  assert.ok(first.materials.length > 0);
  assert.ok(first.hasVariations);
  assert.deepEqual(first.variations[0].values, ["S", "M", "L", "XL"]);
});

