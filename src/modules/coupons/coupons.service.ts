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

// Decides whether a coupon can be used on an order of this size, and how much it takes off.
// Throws a 400 with a plain message for every way it can fail.
export function evaluateCoupon(coupon: CouponRow | null, subtotalMinor: number, now = new Date()) {
  if (!coupon) throw couponError("This promo code is not valid.");
  if (coupon.status !== "Active") throw couponError("This promo code is no longer active.");
  if (coupon.startsAt && now < coupon.startsAt) throw couponError("This promo code is not active yet.");
  if (coupon.endsAt && now > coupon.endsAt) throw couponError("This promo code has expired.");
  if (coupon.maxRedemptions != null && coupon.redemptionsCount >= coupon.maxRedemptions) {
    throw couponError("This promo code has reached its usage limit.");
  }
  if (coupon.minSubtotalMinor != null && subtotalMinor < coupon.minSubtotalMinor) {
    throw couponError(`Spend at least ${rupeeText(coupon.minSubtotalMinor)} to use this promo code.`);
  }
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
