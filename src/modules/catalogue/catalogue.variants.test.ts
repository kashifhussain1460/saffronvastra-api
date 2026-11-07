import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeVariants } from "./catalogue.service.js";

// The admin panel temporarily hides colour variants (Website lib/features.ts COLOUR_VARIANTS_ENABLED = false)
// and sends one variant per size under the default colour. These tests pin that the API accepts both that
// payload and a payload with no colour at all, and that real colours (re-enabled later) still work.
describe("normalizeVariants — size-only products", () => {
  it("accepts one variant per size under the default colour the admin form now sends", () => {
    const out = normalizeVariants([
      { size: "S", colourName: "Standard", colourHex: "#1A1A1A", priceOverrideMinor: null },
      { size: "M", colourName: "Standard", colourHex: "#1A1A1A", priceOverrideMinor: null },
      { size: "XL", colourName: "Standard", colourHex: "#1A1A1A", priceOverrideMinor: null },
    ])!;
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((v) => v.size), ["S", "M", "XL"]);
    assert.ok(out.every((v) => v.colourName === "Standard" && v.colourHex === "#1A1A1A"));
  });

  it("defaults a variant sent without any colour to Standard / #1A1A1A", () => {
    const out = normalizeVariants([{ size: "Free Size" }])!;
    assert.deepEqual(out[0], { size: "Free Size", colourName: "Standard", colourHex: "#1A1A1A", priceOverrideMinor: null });
  });

  it("keeps per-size price overrides", () => {
    const out = normalizeVariants([
      { size: "S", colourName: "Standard", colourHex: "#1A1A1A", priceOverrideMinor: 250000 },
      { size: "M", colourName: "Standard", colourHex: "#1A1A1A", priceOverrideMinor: null },
    ])!;
    assert.equal(out[0].priceOverrideMinor, 250000);
    assert.equal(out[1].priceOverrideMinor, null);
  });

  it("rejects the same size twice (one colour means size is the only key)", () => {
    assert.throws(
      () =>
        normalizeVariants([
          { size: "M", colourName: "Standard", colourHex: "#1A1A1A" },
          { size: "M", colourName: "Standard", colourHex: "#1A1A1A" },
        ]),
      /Duplicate variant/,
    );
  });

  it("still rejects an empty variant list (at least one size is required)", () => {
    assert.throws(() => normalizeVariants([]), /At least one/);
  });

  it("still accepts several real colours, so re-enabling colour variants needs no API change", () => {
    const out = normalizeVariants([
      { size: "M", colourName: "Maroon", colourHex: "#6B1F1F" },
      { size: "M", colourName: "Gold", colourHex: "#D4AF37" },
    ])!;
    assert.deepEqual(out.map((v) => v.colourName), ["Maroon", "Gold"]);
  });
});
