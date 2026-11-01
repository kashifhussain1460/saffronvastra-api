import { prisma } from "../../database/prisma.js";

export type CouponRow = NonNullable<Awaited<ReturnType<typeof prisma.coupon.findUnique>>>;

export function couponError(message: string) {
  const error: any = new Error(message);
  error.statusCode = 400;
  return error;
}

// Percent coupons are stored as a whole percent (10 = 10%). Older rows were stored in hundredths of a percent
// (1000 = 10%), so anything above 100 is read that way. The result is always capped at 100.
export function percentOf(value: number) {
  const percent = value > 100 ? value / 100 : value;
  return Math.min(100, Math.max(0, percent));
}

const rupeeText = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export interface CouponEvaluationContext {
  items?: Array<{
    lineTotalMinor: number;
    product?: {
      title?: string | null;
      slug?: string | null;
      categoryId?: string | null;
      category?: { slug?: string | null; name?: string | null } | null;
    };
  }>;
  owner?: {
    userId?: string | null;
    guestProfileId?: string | null;
  };
  now?: Date;
}

/**
 * Decides whether a coupon can be used on an order of this size, and how much it takes off.
 * Supports:
 * 1. Universal coupons (Guest & Authenticated users)
 * 2. Member-restricted coupons (Authenticated users only)
 * 3. Product/Category-specific coupons (Jackets, Kimonos, Suzani, etc.)
 *
 * Throws a 400 with a user-friendly message for every validation error.
 */
export function evaluateCoupon(
  coupon: CouponRow | null,
  subtotalMinor: number,
  contextOrDate?: CouponEvaluationContext | Date
) {
  if (!coupon) throw couponError("This promo code is not valid.");
  if (coupon.status !== "Active") throw couponError("This promo code is no longer active.");

  const ctx: CouponEvaluationContext =
    contextOrDate instanceof Date ? { now: contextOrDate } : contextOrDate || {};
  const now = ctx.now || new Date();

  if (coupon.startsAt && now < coupon.startsAt) throw couponError("This promo code is not active yet.");
  if (coupon.endsAt && now > coupon.endsAt) throw couponError("This promo code has expired.");
  if (coupon.maxRedemptions != null && coupon.redemptionsCount >= coupon.maxRedemptions) {
    throw couponError("This promo code has reached its usage limit.");
  }
  if (coupon.minSubtotalMinor != null && subtotalMinor < coupon.minSubtotalMinor) {
    throw couponError(`Spend at least ${rupeeText(coupon.minSubtotalMinor)} to use this promo code.`);
  }

  // 1. Check for Member / Authenticated User restriction
  const desc = coupon.description || "";
  const isAuthOnly =
    coupon.code.startsWith("MEMBER") ||
    coupon.code === "FIRSTORDER" ||
    coupon.code === "AUTH10" ||
    /\[(?:auth_only|members_only)\]/i.test(desc);

  if (isAuthOnly && !ctx.owner?.userId) {
    throw couponError("This promo code is reserved for registered members. Please sign in or create an account to apply.");
  }

  // 2. Check for Product / Category-specific restriction
  let productKeyword: string | null = null;
  const tagMatch = desc.match(/\[(?:product|category):([a-z0-9_-]+)\]/i);
  if (tagMatch) {
    productKeyword = tagMatch[1].toLowerCase();
  } else if (coupon.code === "SUZANI20" || coupon.code === "SUZANI10") {
    productKeyword = "suzani";
  } else if (coupon.code === "JACKET10" || coupon.code === "JACKET15") {
    productKeyword = "jacket";
  } else if (coupon.code === "KIMONO15" || coupon.code === "KIMONO10") {
    productKeyword = "kimono";
  }

  if (productKeyword && ctx.items && ctx.items.length > 0) {
    const matchingItems = ctx.items.filter((it) => {
      const title = (it.product?.title || "").toLowerCase();
      const slug = (it.product?.slug || "").toLowerCase();
      const catSlug = (it.product?.category?.slug || "").toLowerCase();
      const catName = (it.product?.category?.name || "").toLowerCase();
      return (
        title.includes(productKeyword!) ||
        slug.includes(productKeyword!) ||
        catSlug.includes(productKeyword!) ||
        catName.includes(productKeyword!)
      );
    });

    if (matchingItems.length === 0) {
      const readableTarget =
        productKeyword === "suzani"
          ? "Suzani Embroidered garments"
          : productKeyword === "jacket"
          ? "Jackets"
          : productKeyword === "kimono"
          ? "Kimonos"
          : `${productKeyword.toUpperCase()} items`;
      throw couponError(`This promo code is only valid on ${readableTarget}. Please add an eligible garment to your bag.`);
    }

    // Calculate discount on matching items
    const eligibleSubtotalMinor = matchingItems.reduce((sum, it) => sum + it.lineTotalMinor, 0);
    const discountMinor =
      coupon.type === "PERCENTAGE"
        ? Math.min(eligibleSubtotalMinor, Math.round((eligibleSubtotalMinor * percentOf(coupon.value)) / 100))
        : Math.min(coupon.value, eligibleSubtotalMinor);
    return discountMinor;
  }

  // 3. General order-wide coupon
  const discountMinor =
    coupon.type === "PERCENTAGE"
      ? Math.min(subtotalMinor, Math.round((subtotalMinor * percentOf(coupon.value)) / 100))
      : Math.min(coupon.value, subtotalMinor);
  return discountMinor;
}

// Where a coupon stands right now, for the admin table.
export function couponState(c: CouponRow, now = new Date()): "Active" | "Disabled" | "Scheduled" | "Expired" | "Exhausted" {
  if (c.status !== "Active") return "Disabled";
  if (c.endsAt && now > c.endsAt) return "Expired";
  if (c.startsAt && now < c.startsAt) return "Scheduled";
  if (c.maxRedemptions != null && c.redemptionsCount >= c.maxRedemptions) return "Exhausted";
  return "Active";
}
