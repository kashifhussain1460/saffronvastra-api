// Single source of truth for the brand name and brand-owned addresses. Import from here; never type them inline.
export const BRAND_IDENTITY = {
  name: "SaffronVastra",
  domain: "saffronvastra.com",
} as const;

export const BRAND_NAME_UPPER = BRAND_IDENTITY.name.toUpperCase();
