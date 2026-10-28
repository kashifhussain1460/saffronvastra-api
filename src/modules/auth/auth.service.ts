import { BRAND_IDENTITY } from "../../config/brand.js";
import { queueEmail } from "../email/email.service.js";
import { env } from "../../config/env.js";
import { emailVerificationEmail, passwordChangedEmail, passwordResetEmail, welcomeEmail } from "../email/email.templates.js";
import { siteUrl } from "../email/email.layout.js";
import { prisma } from "../../database/prisma.js";
import {
  hashPassword,
  verifyPassword,
  generateOpaqueToken,
  hashToken,
} from "../../common/crypto.utils.js";
import { mergeGuestDataToUser } from "../guest/guest.service.js";
import { SignupDto, LoginDto } from "./auth.schema.js";

async function ensureDefaultRole(code: string): Promise<string> {
  const existing = await prisma.role.findUnique({ where: { code } });
  if (existing) return existing.id;

  const created = await prisma.role.create({
    data: {
      code,
      description: `${code} role for ${BRAND_IDENTITY.name}`,
    },
  });
  return created.id;
}

export function sessionLifetimeMs(isAdmin: boolean) {
  return isAdmin ? env.ADMIN_SESSION_MAX_AGE_HOURS * 3600 * 1000 : env.SESSION_MAX_AGE_DAYS * 24 * 3600 * 1000;
}

export async function createSession(userId: string, userAgent?: string, ipAddress?: string, isAdmin = false) {
  const rawToken = generateOpaqueToken(32);
  const tokenHash = hashToken(rawToken);

  // customers: SESSION_MAX_AGE_DAYS (30 by default); administrators: ADMIN_SESSION_MAX_AGE_HOURS (12 by default)
  const expiresAt = new Date(Date.now() + sessionLifetimeMs(isAdmin));

  const session = await prisma.authSession.create({
    data: {
      userId,
      tokenHash,
      userAgent: userAgent ? userAgent.slice(0, 500) : null,
      ipAddress: ipAddress ? ipAddress.slice(0, 100) : null,
      expiresAt,
    },
  });

  return { session, rawToken };
}

export async function signupUser(dto: SignupDto, userAgent?: string, ipAddress?: string) {
  const existingUser = await prisma.user.findUnique({
    where: { email: dto.email },
  });

  if (existingUser) {
    const error: any = new Error("An account with this email address already exists.");
    error.statusCode = 409;
    error.code = "EMAIL_ALREADY_EXISTS";
    throw error;
  }

  const hashedPassword = await hashPassword(dto.password);
  const customerRoleId = await ensureDefaultRole("CUSTOMER");

  // Create User, Profile, and UserRole inside a transaction
  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: dto.email,
        passwordHash: hashedPassword,
        status: "ACTIVE",
        profile: {
          create: {
            displayName: dto.fullName,
            phone: dto.phone || null,
            tier: "Circle Member",
          },
        },
        userRoles: {
          create: {
            roleId: customerRoleId,
          },
        },
      },
      include: {
        profile: true,
        userRoles: {
          include: {
            role: true,
          },
        },
      },
    });

    return newUser;
  });

  // No session yet: the account can be used once the email address is confirmed (the welcome email follows then).
  await issueEmailVerification(user.id, user.email, user.profile?.displayName || dto.fullName);

  // Merge guest data if guestId provided
  if (dto.guestId) {
    try {
      await mergeGuestDataToUser(dto.guestId, user.id);
    } catch {
      // Non-blocking merge error
    }
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.profile?.displayName || dto.fullName,
      phone: user.profile?.phone || null,
      tier: user.profile?.tier || "Circle Member",
      roles: user.userRoles.map((ur) => ur.role.code),
    },
    verificationRequired: true,
  };
}

export async function loginUser(dto: LoginDto, userAgent?: string, ipAddress?: string) {
  const user = await prisma.user.findUnique({
    where: { email: dto.email },
    include: {
      profile: true,
      userRoles: {
        include: {
          role: true,
        },
      },
    },
  });

  if (!user || !user.passwordHash || user.status !== "ACTIVE") {
    const error: any = new Error("Invalid email or password.");
    error.statusCode = 401;
    error.code = "INVALID_CREDENTIALS";
    throw error;
  }

  const isPasswordValid = await verifyPassword(user.passwordHash, dto.password);
  if (!isPasswordValid) {
    const error: any = new Error("Invalid email or password.");
    error.statusCode = 401;
    error.code = "INVALID_CREDENTIALS";
    throw error;
  }

  // Only after the password is right, so this answer never tells a stranger that an address has an account.
  if (!user.emailVerifiedAt) {
    const error: any = new Error("Please confirm your email address first. Use the link we sent you, or ask for a new one.");
    error.statusCode = 403;
    error.code = "EMAIL_NOT_VERIFIED";
    throw error;
  }

  // Create new session (session rotation); administrators get the shorter admin lifetime
  const isAdmin = user.userRoles.some((ur) => ur.role.code === "ADMIN");
  const { rawToken } = await createSession(user.id, userAgent, ipAddress, isAdmin);

  // Merge guest data if guestId provided
  if (dto.guestId) {
    try {
      await mergeGuestDataToUser(dto.guestId, user.id);
    } catch {
      // Non-blocking
    }
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.profile?.displayName || "Client",
      phone: user.profile?.phone || null,
      tier: user.profile?.tier || "Circle Member",
      roles: user.userRoles.map((ur) => ur.role.code),
    },
    sessionToken: rawToken,
  };
}

export async function logoutUser(sessionToken: string) {
  const tokenHash = hashToken(sessionToken);
  await prisma.authSession.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { success: true };
}

export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    const rawResetToken = generateOpaqueToken(32);
    const tokenHash = hashToken(rawResetToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.$transaction([
      // an older, unused link stops working as soon as a new one is requested
      prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
      prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } }),
    ]);

    const profile = await prisma.customerProfile.findUnique({ where: { userId: user.id }, select: { displayName: true } });
    queueEmail({
      to: user.email,
      template: "password-reset",
      message: passwordResetEmail({
        name: profile?.displayName,
        resetUrl: siteUrl(`/auth/reset-password?token=${rawResetToken}`),
        expiresInMinutes: 60,
      }),
      relatedId: user.id,
    });
  }

  // The answer is the same whether or not the address has an account, and it never contains the token.
  return {
    message: "If an account exists with this email address, password reset instructions have been sent.",
  };
}

export async function executePasswordReset(token: string, newPassword: string) {
  const tokenHash = hashToken(token);
  const resetTokenRecord = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (
    !resetTokenRecord ||
    resetTokenRecord.usedAt ||
    resetTokenRecord.expiresAt < new Date()
  ) {
    const error: any = new Error("Invalid or expired password reset token.");
    error.statusCode = 400;
    error.code = "INVALID_RESET_TOKEN";
    throw error;
  }

  const newHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    // 1. Update user password
    await tx.user.update({
      where: { id: resetTokenRecord.userId },
      data: { passwordHash: newHash },
    });

    // 2. Claim the token: only one of two simultaneous requests can succeed
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: resetTokenRecord.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      const error: any = new Error("Invalid or expired password reset token.");
      error.statusCode = 400;
      error.code = "INVALID_RESET_TOKEN";
      throw error;
    }

    // 3. Revoke all existing sessions for security
    await tx.authSession.updateMany({
      where: { userId: resetTokenRecord.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  const owner = await prisma.user.findUnique({
    where: { id: resetTokenRecord.userId },
    select: { email: true, profile: { select: { displayName: true } } },
  });
  if (owner) {
    queueEmail({
      to: owner.email,
      template: "password-changed",
      message: passwordChangedEmail({ name: owner.profile?.displayName }),
      relatedId: resetTokenRecord.userId,
    });
  }

  return { success: true, message: "Password updated successfully. Please log in.", userId: resetTokenRecord.userId };
}

// ------------------------------------------------------------------ email verification
const VERIFICATION_TTL_HOURS = 24;
const RESEND_COOLDOWN_SECONDS = 60;

function verificationError(): Error {
  const error: any = new Error("This verification link is invalid, has expired or was already used.");
  error.statusCode = 400;
  error.code = "INVALID_VERIFICATION_TOKEN";
  return error;
}

/** Creates a single-use, expiring token (only its hash is stored), retires older ones, and emails the link. */
export async function issueEmailVerification(userId: string, email: string, name?: string | null) {
  const raw = generateOpaqueToken(32);
  const now = new Date();
  await prisma.$transaction([
    prisma.emailVerificationToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } }),
    prisma.emailVerificationToken.create({
      data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(now.getTime() + VERIFICATION_TTL_HOURS * 3600 * 1000) },
    }),
  ]);
  queueEmail({
    to: email,
    template: "email-verification",
    message: emailVerificationEmail({ name, verifyUrl: siteUrl(`/auth/verify-email?token=${raw}`), expiresInHours: VERIFICATION_TTL_HOURS }),
    relatedId: userId,
  });
}

export async function verifyEmailToken(token: string) {
  const tokenHash = hashToken(token);
  const now = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    const record = await tx.emailVerificationToken.findUnique({ where: { tokenHash } });
    if (!record || record.usedAt || record.expiresAt < now) return null;
    const claimed = await tx.emailVerificationToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) return null;
    const before = await tx.user.findUnique({ where: { id: record.userId }, select: { emailVerifiedAt: true } });
    const user = await tx.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: before?.emailVerifiedAt ?? now },
      select: { id: true, email: true, profile: { select: { displayName: true } } },
    });
    return { user, newlyVerified: !before?.emailVerifiedAt };
  });
  if (!outcome) throw verificationError();
  if (outcome.newlyVerified) {
    queueEmail({
      to: outcome.user.email,
      template: "welcome",
      message: welcomeEmail({ name: outcome.user.profile?.displayName || "there" }),
      relatedId: outcome.user.id,
    });
  }
  return { userId: outcome.user.id, email: outcome.user.email };
}

/**
 * Signed in: resends for that account. Signed out: takes an email address and answers the same way whether or not
 * an account exists, so the endpoint cannot be used to discover accounts.
 */
export async function resendEmailVerification(opts: { userId?: string; email?: string }) {
  const generic = { message: "If the account exists and is not yet confirmed, a new confirmation link has been sent." };
  const user = opts.userId
    ? await prisma.user.findUnique({ where: { id: opts.userId }, include: { profile: true } })
    : opts.email
      ? await prisma.user.findUnique({ where: { email: opts.email.trim().toLowerCase() }, include: { profile: true } })
      : null;
  if (!user) return generic;
  if (user.emailVerifiedAt) return opts.userId ? { message: "Your email address is already confirmed.", alreadyVerified: true } : generic;

  const latest = await prisma.emailVerificationToken.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
  if (latest && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
    if (!opts.userId) return generic;
    const error: any = new Error("A confirmation email was sent a moment ago. Please wait a minute before asking for another.");
    error.statusCode = 429;
    error.code = "VERIFICATION_COOLDOWN";
    throw error;
  }
  await issueEmailVerification(user.id, user.email, user.profile?.displayName);
  return opts.userId ? { message: "A new confirmation link has been sent to your email address." } : generic;
}
