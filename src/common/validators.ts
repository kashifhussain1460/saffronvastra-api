import { z } from "zod";

// Shared server-side rules for Indian delivery addresses. The storefront checks the same rules for a better
// experience, but these are the ones that count: the API never trusts the browser.

export const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
  "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal",
  // Union territories
  "Andaman & Nicobar Islands", "Chandigarh", "Dadra & Nagar Haveli and Daman & Diu", "Delhi", "Jammu & Kashmir",
  "Ladakh", "Lakshadweep", "Puducherry",
] as const;

const STATE_LOOKUP = new Map(INDIAN_STATES.map((s) => [s.toLowerCase().replace(/\s+and\s+/g, " & "), s]));

/** 10-digit Indian mobile number; accepts spaces, dashes and a +91 / 91 / 0 prefix, stores "+91 XXXXXXXXXX". */
export const indianMobile = z
  .string({ required_error: "Mobile number is required" })
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, "").replace(/^(\+91|91|0)(?=\d{10}$)/, ""))
  .refine((v) => /^[6-9]\d{9}$/.test(v), "Enter a valid 10-digit Indian mobile number")
  .transform((v) => `+91 ${v}`);

/** 6-digit PIN code; the first digit is never 0. */
export const indianPincode = z
  .string({ required_error: "PIN code is required" })
  .trim()
  .refine((v) => /^[1-9]\d{5}$/.test(v), "Enter a valid 6-digit PIN code");

export const indianState = z
  .string({ required_error: "State is required" })
  .trim()
  .transform((v) => STATE_LOOKUP.get(v.toLowerCase().replace(/\s+and\s+/g, " & ")) ?? v)
  .refine((v) => (INDIAN_STATES as readonly string[]).includes(v), "Select a valid Indian state or union territory");

export const indiaOnly = z
  .string()
  .trim()
  .default("India")
  .refine((v) => /^india$/i.test(v), "We currently deliver within India only")
  .transform(() => "India");

const text = (label: string, min: number, max: number) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(min, min > 1 ? `${label} must be at least ${min} characters` : `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

export const addressFields = {
  fullName: text("Full name", 2, 100),
  phone: indianMobile,
  street: text("Street address", 3, 200),
  apartment: z.string().trim().max(100, "Apartment must be 100 characters or fewer").optional().nullable(),
  city: text("City", 2, 100),
  state: indianState,
  pincode: indianPincode,
  country: indiaOnly,
};

/** At most 50 of one piece per line (the same limit as the cart). */
export const lineQuantity = z
  .number({ invalid_type_error: "Quantity must be a number" })
  .int("Quantity must be a whole number")
  .min(1, "Quantity must be at least 1")
  .max(50, "Quantity cannot exceed 50 pieces")
  .default(1);

/** Optional mobile: empty means "not given"; anything else must be a valid Indian number (one clear message). */
export const optionalIndianMobile = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), indianMobile.optional());
