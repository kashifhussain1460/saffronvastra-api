import test from "node:test";
import assert from "node:assert/strict";
import { parseBlobPath } from "./blobImport.service.js";

test("a product folder gives the product slug and the file", () => {
  assert.deepEqual(parseBlobPath("uploads/products/velvet-jacket-maroon/01.webp"), { kind: "product", slug: "velvet-jacket-maroon", file: "01.webp" });
});

test("a category or collection file is named after its slug, in any letter case and extension", () => {
  assert.deepEqual(parseBlobPath("uploads/categories/Jackets.JPG"), { kind: "category", slug: "jackets", file: "Jackets.JPG" });
  assert.deepEqual(parseBlobPath("uploads/collections/autumn-2026.png"), { kind: "collection", slug: "autumn-2026", file: "autumn-2026.png" });
});

test("a banner is accepted under any name", () => {
  assert.equal(parseBlobPath("uploads/banners/home hero.webp")?.kind, "banner");
});

test("files outside the convention are never imported", () => {
  for (const path of [
    "uploads/1792695423305-x-qa.png", // uploaded by the admin itself
    "uploads/requests/1792-abc.jpg", // customer photos
    "uploads/products/velvet-jacket/extra/01.webp", // too deep
    "uploads/products/01.webp", // no product folder
    "uploads/products/Velvet Jacket/01.webp", // not a slug
    "uploads/products/velvet-jacket/notes.txt", // not an image
    "uploads/products/velvet-jacket/..%2F01.webp",
    "other/products/velvet-jacket/01.webp",
    "uploads/categories/jackets/01.webp",
  ]) {
    assert.equal(parseBlobPath(path), null, path);
  }
});
