import { Response } from "express";
import { addressFields, optionalIndianMobile } from "../../common/validators.js";
import { prisma } from "../../database/prisma.js";
import { AuthenticatedRequest } from "../../common/auth.middleware.js";
import { z } from "zod";

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(2, "Name must be at least 2 characters").max(100).optional(),
  // anything other than an empty value must be a valid Indian mobile number
  phone: optionalIndianMobile,
});

const addressSchema = z.object({
  ...addressFields,
  isDefault: z.boolean().default(false),
});

export async function getMe(req: AuthenticatedRequest, res: Response) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        profile: true,
        addresses: {
          orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        },
        userRoles: {
          include: { role: true },
        },
        _count: {
          select: {
            authSessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ status: "error", message: "User not found" });
    }

    return res.status(200).json({
      status: "success",
      data: {
        id: user.id,
        email: user.email,
        emailVerified: !!user.emailVerifiedAt,
        fullName: user.profile?.displayName || "Client",
        phone: user.profile?.phone || null,
        tier: user.profile?.tier || "Circle Member",
        roles: user.userRoles.map((ur) => ur.role.code),
        addresses: user.addresses,
        activeSessionsCount: user._count.authSessions,
        createdAt: user.createdAt,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}

export async function updateMe(req: AuthenticatedRequest, res: Response) {
  try {
    const validated = updateProfileSchema.parse(req.body);

    const updatedProfile = await prisma.customerProfile.upsert({
      where: { userId: req.user!.id },
      update: {
        ...(validated.displayName && { displayName: validated.displayName }),
        ...(validated.phone && { phone: validated.phone }),
      },
      create: {
        userId: req.user!.id,
        displayName: validated.displayName || null,
        phone: validated.phone || null,
        tier: "Circle Member",
      },
    });

    return res.status(200).json({
      status: "success",
      message: "Profile updated successfully",
      data: updatedProfile,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ status: "error", errors: error.errors });
    }
    return res.status(500).json({ status: "error", message: error.message });
  }
}

export async function getAddresses(req: AuthenticatedRequest, res: Response) {
  try {
    const addresses = await prisma.address.findMany({
      where: { userId: req.user!.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });

    return res.status(200).json({
      status: "success",
      data: addresses,
    });
  } catch (error: any) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}

export async function createAddress(req: AuthenticatedRequest, res: Response) {
  try {
    const validated = addressSchema.parse(req.body);

    if (validated.isDefault) {
      await prisma.address.updateMany({
        where: { userId: req.user!.id },
        data: { isDefault: false },
      });
    }

    const address = await prisma.address.create({
      data: {
        userId: req.user!.id,
        ...validated,
      },
    });

    return res.status(201).json({
      status: "success",
      message: "Address added successfully",
      data: address,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ status: "error", errors: error.errors });
    }
    return res.status(500).json({ status: "error", message: error.message });
  }
}

export async function deleteAddress(req: AuthenticatedRequest, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const existing = await prisma.address.findFirst({
      where: { id: id as string, userId: req.user!.id },
    });

    if (!existing) {
      return res.status(404).json({ status: "error", message: "Address not found" });
    }

    await prisma.address.delete({ where: { id: id as string } });

    return res.status(200).json({
      status: "success",
      message: "Address deleted successfully",
    });
  } catch (error: any) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}

const adminListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]).optional(),
  tier: z.string().trim().max(50).optional(),
});

// Customers are every account that is not an administrator.
const NOT_ADMIN = { userRoles: { none: { role: { code: "ADMIN" } } } };

// Order count and lifetime spend per user; cancelled orders never count towards spend.
async function orderStats(userIds: string[]) {
  const stats = new Map<string, { ordersCount: number; totalSpentMinor: number; lastOrderDate: Date | null }>();
  if (!userIds.length) return stats;
  const [all, spend] = await Promise.all([
    prisma.order.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.order.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds }, status: { not: "Cancelled" } },
      _sum: { totalMinor: true },
    }),
  ]);
  const spendBy = new Map(spend.map((r) => [r.userId, r._sum.totalMinor ?? 0]));
  for (const r of all) {
    if (!r.userId) continue;
    stats.set(r.userId, {
      ordersCount: r._count._all,
      totalSpentMinor: spendBy.get(r.userId) ?? 0,
      lastOrderDate: r._max.createdAt,
    });
  }
  return stats;
}

const EMPTY_STATS = { ordersCount: 0, totalSpentMinor: 0, lastOrderDate: null as Date | null };

export async function getAllCustomersForAdmin(req: any, res: Response) {
  const parsed = adminListQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ status: "error", message: "Invalid query parameters" });
  }
  const { page, limit, q, status, tier } = parsed.data;
  try {
    const where: any = {
      ...NOT_ADMIN,
      ...(status ? { status } : {}),
      ...(tier ? { profile: { is: { tier } } } : {}),
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: "insensitive" } },
              { profile: { is: { displayName: { contains: q, mode: "insensitive" } } } },
              { profile: { is: { phone: { contains: q, mode: "insensitive" } } } },
            ],
          }
        : {}),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: { profile: true },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);
    const stats = await orderStats(users.map((u) => u.id));

    const items = users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.profile?.displayName || u.email.split("@")[0],
      phone: u.profile?.phone || null,
      tier: u.profile?.tier || "Circle Member",
      status: u.status,
      ...(stats.get(u.id) ?? EMPTY_STATS),
      createdAt: u.createdAt,
    }));

    return res.status(200).json({
      status: "success",
      items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error("[customers] admin list failed", err);
    return res.status(500).json({ status: "error", message: "Could not load customers" });
  }
}

export async function getCustomerForAdmin(req: any, res: Response) {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ status: "error", message: "Customer not found" });
  try {
    const user = await prisma.user.findFirst({
      where: { id: id.data, ...NOT_ADMIN },
      include: {
        profile: true,
        addresses: { orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] },
        orders: {
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true,
            orderNumber: true,
            status: true,
            paymentStatus: true,
            totalMinor: true,
            currency: true,
            createdAt: true,
            _count: { select: { items: true } },
          },
        },
      },
    });
    if (!user) return res.status(404).json({ status: "error", message: "Customer not found" });

    const [stats, subscriber] = await Promise.all([
      orderStats([user.id]),
      prisma.newsletterSubscriber.findUnique({ where: { email: user.email }, select: { status: true, createdAt: true } }),
    ]);

    return res.status(200).json({
      status: "success",
      data: {
        id: user.id,
        email: user.email,
        displayName: user.profile?.displayName || user.email.split("@")[0],
        phone: user.profile?.phone || null,
        tier: user.profile?.tier || "Circle Member",
        status: user.status,
        emailVerified: !!user.emailVerifiedAt,
        createdAt: user.createdAt,
        ...(stats.get(user.id) ?? EMPTY_STATS),
        newsletter: subscriber ? subscriber.status : "Not subscribed",
        addresses: user.addresses,
        orders: user.orders.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          status: o.status,
          paymentStatus: o.paymentStatus,
          totalMinor: o.totalMinor,
          currency: o.currency,
          itemCount: o._count.items,
          createdAt: o.createdAt,
        })),
      },
    });
  } catch (err) {
    console.error("[customers] admin detail failed", err);
    return res.status(500).json({ status: "error", message: "Could not load customer" });
  }
}
