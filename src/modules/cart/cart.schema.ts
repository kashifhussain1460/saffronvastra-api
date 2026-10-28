import { z } from "zod";

export const addCartItemSchema = z.object({
  variantId: z.string().uuid("Invalid variant ID format"),
  quantity: z.number().int().positive().max(50, "Quantity cannot exceed 50 garments").default(1),
});

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(0, "Quantity cannot be negative").max(50, "Quantity cannot exceed 50 garments"),
});
