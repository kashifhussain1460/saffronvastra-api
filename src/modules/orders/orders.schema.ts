import { z } from "zod";
import { addressFields, lineQuantity } from "../../common/validators.js";

export const addressSnapshotSchema = z.object({
  ...addressFields,
  email: z.string().trim().toLowerCase().email("Valid contact email required").max(254).optional().nullable(),
});

// One line per piece, 1-50 each, at most 50 lines: the same limits the cart enforces.
const orderItemsSchema = z
  .array(z.object({ variantId: z.string().uuid("Invalid variant UUID"), quantity: lineQuantity }))
  .max(50, "An order can contain at most 50 different pieces")
  .refine((items) => new Set(items.map((i) => i.variantId)).size === items.length, "Each piece may appear only once; change its quantity instead");

export const checkoutQuoteSchema = z.object({
  couponCode: z.string().trim().optional().nullable(),
  shippingAddress: addressSnapshotSchema.partial().optional().nullable(),
  shippingMethod: z.enum(["standard", "express"]).default("standard"),
  items: orderItemsSchema.optional(),
  // the quote depends on the payment method: Cash on Delivery may carry a handling fee, online payment does not
  paymentProvider: z.enum(["COD", "CASHFREE"]).optional(),
});

export const placeOrderSchema = z.object({
  shippingAddress: addressSnapshotSchema,
  billingAddress: addressSnapshotSchema.optional().nullable(),
  // Cash on Delivery, or online payment through Cashfree (only when it is configured: placeOrder checks that).
  paymentMethod: z.object({
    provider: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .refine((v) => v === "COD" || v === "CASHFREE", { message: "Choose Cash on Delivery or online payment" }),
  }),
  bespokeNotes: z.string().max(1000).optional().nullable(),
  couponCode: z.string().trim().optional().nullable(),
  shippingMethod: z.enum(["standard", "express"]).default("standard"),
  items: orderItemsSchema.optional(),
  idempotencyKey: z.string().optional().nullable(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum([
    "Pending",
    "Processing",
    "Ready to Ship",
    "Shipped",
    "Delivered",
    "Cancelled",
  ]),
  note: z.string().max(500).optional().nullable(),
});

export const createShipmentSchema = z.object({
  carrier: z.string().min(2, "Carrier name is required").max(100),
  trackingNumber: z.string().min(3, "Tracking number is required").max(100),
  trackingUrl: z.string().url("Invalid tracking URL").optional().nullable().or(z.literal("")),
  estimatedDelivery: z.string().optional().nullable(),
});
