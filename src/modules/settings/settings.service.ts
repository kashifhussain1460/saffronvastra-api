import { BRAND_IDENTITY } from "../../config/brand.js";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";

// Store settings live in the store_settings table, one row per group. A group that has never been saved
// falls back to the defaults below, so a fresh database behaves exactly as the shop always has.

const rupees = (label: string, max: number) =>
  z
    .number({ required_error: `${label} is required`, invalid_type_error: `${label} must be a number` })
    .min(0, `${label} cannot be negative`)
    .max(max, `${label} is too large`)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, `${label} can have at most two decimal places`);

const optionalText = (label: string, max: number) =>
  z.string().trim().max(max, `${label} must be ${max} characters or fewer`);

const emailText = z.string().trim().max(254, "Email is too long").email("Enter a valid email address");

export const SETTING_GROUPS = {
  store: z
    .object({
      name: z.string().trim().min(1, "Store name is required").max(80, "Store name must be 80 characters or fewer"),
      supportEmail: emailText,
      supportPhone: z
        .string()
        .trim()
        .regex(/^[0-9+()\-\s]{7,20}$/, "Enter a valid phone number"),
      address: optionalText("Address", 300),
    })
    .strict(),
  announcement: z
    .object({
      enabled: z.boolean({ invalid_type_error: "Enabled must be true or false" }),
      text: optionalText("Announcement text", 140),
      link: z
        .string()
        .trim()
        .max(300, "Link must be 300 characters or fewer")
        .refine((v) => v === "" || v.startsWith("/") || /^https?:\/\//i.test(v), "Link must start with /, http:// or https://"),
    })
    .strict()
    .refine((v) => !v.enabled || v.text.length > 0, { message: "Enter the announcement text or turn the bar off", path: ["text"] }),
  shipping: z
    .object({
      freeShippingThreshold: rupees("Free shipping threshold", 10_000_000),
      flatFee: rupees("Shipping fee", 1_000_000),
    })
    .strict(),
  cod: z
    .object({
      enabled: z.boolean({ invalid_type_error: "Enabled must be true or false" }),
      fee: rupees("COD fee", 100_000),
    })
    .strict(),
  notifications: z
    .object({
      adminEmail: z.union([z.literal(""), emailText]),
    })
    .strict(),
} as const;

export type SettingGroup = keyof typeof SETTING_GROUPS;
export const GROUP_KEYS = Object.keys(SETTING_GROUPS) as SettingGroup[];

export const DEFAULT_SETTINGS = {
  store: {
    name: `${BRAND_IDENTITY.name}`,
    supportEmail: `concierge@${BRAND_IDENTITY.domain}`,
    supportPhone: "+91 (0141) 287-4390",
    address: "14 Heritage Haveli Marg, C-Scheme, Jaipur, Rajasthan 302001, India",
  },
  announcement: { enabled: true, text: "Complimentary shipping on orders above ₹5,000", link: "" },
  shipping: { freeShippingThreshold: 5000, flatFee: 499 },
  cod: { enabled: true, fee: 0 },
  notifications: { adminEmail: "" },
};

export type AllSettings = typeof DEFAULT_SETTINGS;

// Settings shown to every visitor. Notification addresses stay private.
export const PUBLIC_GROUPS: SettingGroup[] = ["store", "announcement", "shipping", "cod"];

export async function getAllSettings(): Promise<{
  values: AllSettings;
  meta: Record<string, { updatedAt: Date; updatedByUserId: string | null } | null>;
}> {
  const rows = await prisma.storeSetting.findMany({ where: { key: { in: GROUP_KEYS } } });
  const values: any = {};
  const meta: any = {};
  for (const key of GROUP_KEYS) {
    const row = rows.find((r) => r.key === key);
    const stored = row && typeof row.value === "object" && row.value && !Array.isArray(row.value) ? (row.value as object) : {};
    values[key] = { ...DEFAULT_SETTINGS[key], ...stored };
    meta[key] = row ? { updatedAt: row.updatedAt, updatedByUserId: row.updatedByUserId } : null;
  }
  return { values, meta };
}

export async function getSettings(): Promise<AllSettings> {
  try {
    return (await getAllSettings()).values;
  } catch (error) {
    console.error("[settings] could not read settings, using defaults", error);
    return DEFAULT_SETTINGS;
  }
}

export const toMinor = (rupeeAmount: number) => Math.round(rupeeAmount * 100);

// The admin address that overrides ADMIN_NOTIFY_EMAIL, or null when not set.
export async function configuredAdminEmail(): Promise<string | null> {
  const s = await getSettings();
  return s.notifications.adminEmail || null;
}
