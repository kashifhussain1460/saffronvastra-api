import { Request, Response } from "express";
import {
  signupSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema,
} from "./auth.schema.js";
import {
  signupUser,
  loginUser,
  logoutUser,
  requestPasswordReset,
  executePasswordReset,
  verifyEmailToken,
  resendEmailVerification,
  sessionLifetimeMs,
} from "./auth.service.js";
import type { AuthenticatedRequest } from "../../common/auth.middleware.js";
import { audit, maskEmail } from "../../common/audit.js";
import {
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE_NAME,
} from "../../common/cookie.utils.js";
import { background } from "../../common/background.js";

export async function handleSignup(req: Request, res: Response) {
  try {
    const validatedData = signupSchema.parse(req.body);
    const userAgent = req.headers["user-agent"];
    const ipAddress = req.ip || req.socket.remoteAddress;

    const { user } = await signupUser(validatedData, userAgent, ipAddress);
    background(audit(req, { category: "security", action: "SIGNUP", entityType: "User", entityId: user.id, actorUserId: user.id }));

    // No session until the email address is confirmed.
    return res.status(201).json({
      status: "success",
      message: "Account created. We have sent a confirmation link to your email address.",
      data: { email: user.email, verificationRequired: true },
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({
        status: "error",
        code: "VALIDATION_ERROR",
        errors: error.errors,
      });
    }

    return res.status(error.statusCode || 500).json({
      status: "error",
      code: error.code || "SIGNUP_FAILED",
      message: error.message || "Failed to create account",
    });
  }
}

export async function handleLogin(req: Request, res: Response) {
  try {
    const validatedData = loginSchema.parse(req.body);
    const userAgent = req.headers["user-agent"];
    const ipAddress = req.ip || req.socket.remoteAddress;

    const { user, sessionToken } = await loginUser(validatedData, userAgent, ipAddress);

    // the cookie lives exactly as long as the session it carries
    setSessionCookie(res, sessionToken, sessionLifetimeMs(user.roles.includes("ADMIN")));
    background(audit(req, { category: "security", action: "LOGIN_SUCCESS", entityType: "User", entityId: user.id, actorUserId: user.id, details: { roles: user.roles } }));

    return res.status(200).json({
      status: "success",
      message: "Logged in successfully",
      data: { user }, // the session token travels only in the httpOnly cookie
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({
        status: "error",
        code: "VALIDATION_ERROR",
        errors: error.errors,
      });
    }

    if (error.statusCode && error.statusCode < 500) {
      background(audit(req, {
        category: "security",
        action: "LOGIN_FAILED",
        status: "failure",
        entityType: "User",
        entityId: null,
        actorUserId: null,
        details: { email: maskEmail(typeof req.body?.email === "string" ? req.body.email : null), reason: error.code || "INVALID_CREDENTIALS" },
      }));
    }
    return res.status(error.statusCode || 500).json({
      status: "error",
      code: error.code || "LOGIN_FAILED",
      message: error.message || "Authentication failed",
    });
  }
}

export async function handleLogout(req: Request, res: Response) {
  try {
    const rawToken =
      req.cookies?.[SESSION_COOKIE_NAME] ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null);

    if (rawToken) {
      await logoutUser(rawToken);
      background(audit(req, { category: "security", action: "LOGOUT", entityType: "User", entityId: (req as AuthenticatedRequest).user?.id || null }));
    }

    clearSessionCookie(res);

    return res.status(200).json({
      status: "success",
      message: "Logged out successfully",
    });
  } catch (error: any) {
    clearSessionCookie(res);
    return res.status(200).json({
      status: "success",
      message: "Logged out",
    });
  }
}

export async function handleForgotPassword(req: Request, res: Response) {
  try {
    const validatedData = forgotPasswordSchema.parse(req.body);
    const result = await requestPasswordReset(validatedData.email);
    background(audit(req, { category: "security", action: "PASSWORD_RESET_REQUESTED", entityType: "User", entityId: null, details: { email: maskEmail(validatedData.email) } }));

    return res.status(200).json({
      status: "success",
      ...result,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({
        status: "error",
        code: "VALIDATION_ERROR",
        errors: error.errors,
      });
    }

    return res.status(500).json({
      status: "error",
      message: "Unable to process password reset request",
    });
  }
}

export async function handleResetPassword(req: Request, res: Response) {
  try {
    const validatedData = resetPasswordSchema.parse(req.body);
    const { userId, ...result } = await executePasswordReset(validatedData.token, validatedData.newPassword);
    background(audit(req, { category: "security", action: "PASSWORD_RESET_COMPLETED", entityType: "User", entityId: userId, actorUserId: userId }));

    clearSessionCookie(res);

    return res.status(200).json({
      status: "success",
      ...result,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({
        status: "error",
        code: "VALIDATION_ERROR",
        errors: error.errors,
      });
    }

    return res.status(error.statusCode || 500).json({
      status: "error",
      code: error.code || "RESET_FAILED",
      message: error.message || "Failed to reset password",
    });
  }
}

export async function handleVerifyEmail(req: Request, res: Response) {
  const parsed = verifyEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: "error", code: "INVALID_VERIFICATION_TOKEN", message: "This verification link is invalid, has expired or was already used." });
  }
  try {
    const result = await verifyEmailToken(parsed.data.token);
    background(audit(req, { category: "security", action: "EMAIL_VERIFIED", entityType: "User", entityId: result.userId, actorUserId: result.userId }));
    return res.status(200).json({ status: "success", message: "Your email address is confirmed.", data: { email: result.email } });
  } catch (error: any) {
    if (error.statusCode === 400) return res.status(400).json({ status: "error", code: error.code, message: error.message });
    console.error("[verify-email]", error);
    return res.status(500).json({ status: "error", message: "We could not confirm your email right now." });
  }
}

export async function handleResendVerification(req: AuthenticatedRequest, res: Response) {
  const parsed = resendVerificationSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ status: "error", code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message || "Invalid request" });
  }
  if (!req.user && !parsed.data.email) {
    return res.status(400).json({ status: "error", code: "VALIDATION_ERROR", message: "Enter the email address of your account." });
  }
  try {
    const result = await resendEmailVerification({ userId: req.user?.id, email: req.user ? undefined : parsed.data.email });
    return res.status(200).json({ status: "success", ...result });
  } catch (error: any) {
    if (error.statusCode === 429) return res.status(429).json({ status: "error", code: error.code, message: error.message });
    console.error("[resend-verification]", error);
    return res.status(500).json({ status: "error", message: "We could not send a new link right now." });
  }
}
