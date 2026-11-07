import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { variantDetail } from "./email.variant.js";

describe("variantDetail (order line detail in emails)", () => {
  it("shows only the size for the placeholder colour used by size-only products", () => {
    assert.equal(variantDetail("M", "Standard"), "Size M");
  });

  it("ignores the placeholder colour regardless of case and spacing", () => {
    assert.equal(variantDetail("XL", "  standard "), "Size XL");
  });

  it("still shows a real colour (older orders, or when colour variants are re-enabled)", () => {
    assert.equal(variantDetail("S", "Green"), "Size S · Green");
  });

  it("handles a missing size or colour", () => {
    assert.equal(variantDetail(null, "Green"), "Green");
    assert.equal(variantDetail("L", null), "Size L");
    assert.equal(variantDetail(null, null), "");
  });
});
