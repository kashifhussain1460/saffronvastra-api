import { Request, Response, NextFunction } from "express";
import { audit } from "./audit.js";
import { prisma } from "../database/prisma.js";
import { hashToken } from "./crypto.utils.js";
import { SESSION_COOKIE_NAME } from "./cookie.utils.js";
import { background } from "./background.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string | null;
  phone: string | null;
  tier: string;
  roles: string[];
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  session?: {
    id: string;
    expiresAt: Date;
  };
  guestId?: string;
}

export async function optionalAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const rawToken =
      req.cookies?.[SESSION_COOKIE_NAME] ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null);

    // Also extract guestId if sent in header or cookie
    const guestId = (req.headers["x-guest-id"] as string) || req.cookies?.["saffron_guest_id"];
    if (guestId) {
      req.guestId = guestId;
    }

    (req as any)._authChecked = true;

    if (!rawToken) {
      return next();
    }

    const tokenHash = hashToken(rawToken);
    const session = await prisma.authSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            profile: true,
            userRoles: {
              include: {
                role: true,
              },
            },
          },
        },
      },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user) {
      return next();
    }

    if (session.user.status !== "ACTIVE") {
      return next();
    }

    const roles = session.user.userRoles.map((ur) => ur.role.code);

    req.user = {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.profile?.displayName || null,
      phone: session.user.profile?.phone || null,
      tier: session.user.profile?.tier || "Circle Member",
      roles,
    };

    req.session = {
      id: session.id,
      expiresAt: session.expiresAt,
    };

    return next();
  } catch (error) {
    (req as any)._authChecked = true;
    return next();
  }
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.user) {
    return next();
  }
  if ((req as any)._authChecked) {
    return res.status(401).json({
      status: "error",
      code: "UNAUTHORIZED",
      message: "Authentication required to access this resource",
    });
  }
  await optionalAuth(req, res, () => {
    if (!req.user) {
      return res.status(401).json({
        status: "error",
        code: "UNAUTHORIZED",
        message: "Authentication required to access this resource",
      });
    }
    next();
  });
}

export async function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // If user context was already resolved by optionalAuth, check role directly without re-querying session DB
  if (req.user) {
    if (!req.user.roles.includes("ADMIN")) {
      background(audit(req, { category: "security", action: "ADMIN_ACCESS_DENIED", status: "denied", entityType: "Route", entityId: req.originalUrl.split("?")[0].slice(0, 200), details: { method: req.method } }));
      return res.status(403).json({
        status: "error",
        code: "FORBIDDEN",
        message: "Administrative privileges required",
      });
    }
    return next();
  }

  if ((req as any)._authChecked) {
    return res.status(401).json({
      status: "error",
      code: "UNAUTHORIZED",
      message: "Authentication required to access this resource",
    });
  }

  await requireAuth(req, res, () => {
    if (!req.user?.roles.includes("ADMIN")) {
      background(audit(req, { category: "security", action: "ADMIN_ACCESS_DENIED", status: "denied", entityType: "Route", entityId: req.originalUrl.split("?")[0].slice(0, 200), details: { method: req.method } }));
      return res.status(403).json({
        status: "error",
        code: "FORBIDDEN",
        message: "Administrative privileges required",
      });
    }
    next();
  });
}
