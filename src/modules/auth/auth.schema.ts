import { z } from "zod";
import { optionalIndianMobile } from "../../common/validators.js";

// The same password rule as the registration form: 8-128 characters with at least one letter and one number.
export const newPassword = z
  .string({ required_error: "Password is required" })
  .min(8, "Password must be at least 8 characters long")
  .max(128, "Password cannot exceed 128 characters")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Use at least one letter and one number");

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email("Please provide a valid email address"),
  password: newPassword,
  fullName: z
    .string({ required_error: "Full name is required" })
    .trim()
    .min(2, "Full name must be at least 2 characters")
    .max(100, "Full name must be 100 characters or fewer")
    .regex(/^[\p{L}][\p{L}\p{M}' .-]*$/u, "Use letters, spaces, apostrophes, dots or hyphens only"),
  phone: optionalIndianMobile,
  guestId: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Please provide a valid email address"),
  password: z.string().min(1, "Password is required"),
  guestId: z.string().optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email("Please provide a valid email address"),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Reset token is required"),
  newPassword,
});

export const verifyEmailSchema = z.object({
  token: z.string({ required_error: "Verification token is required" }).trim().min(16, "Verification token is not valid").max(200, "Verification token is not valid"),
});

export const resendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email("Please provide a valid email address").max(254).optional(),
});

export type SignupDto = z.infer<typeof signupSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;
