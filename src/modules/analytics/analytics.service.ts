import { prisma } from "../../database/prisma.js";
import { generateUUID, hashToken } from "../../common/crypto.utils.js";

export interface SessionResolutionParams {
  trackingSessionId?: string | null;
  guestId?: string | null;
  userId?: string | null;
  consentState?: any;
}

export interface ActivityEventInput {
  eventId?: string;
  eventName: string;
  occurredAt?: string | Date;
  routeTemplate?: string;
  path: string;
  productId?: string | null;
  metadata?: any;
}

export interface BatchEventsParams {
  trackingSessionId?: string | null;
  guestId?: string | null;
  userId?: string | null;
  events: ActivityEventInput[];
}

export interface HeartbeatParams {
  trackingSessionId?: string | null;
  guestId?: string | null;
  userId?: string | null;
  seconds?: number;
  path?: string;
  routeTemplate?: string;
}

/**
 * Resolve or initialize a tracking session for a guest or authenticated user
 */
export async function resolveTrackingSession(params: SessionResolutionParams) {
  // 1. If an explicit trackingSessionId was provided, attempt to locate it
  if (params.trackingSessionId) {
    const existing = await prisma.trackingSession.findUnique({
      where: { id: params.trackingSessionId },
      include: {
        guestProfile: true,
        summaries: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    if (existing) {
      // If user is now logged in, bind userId if not already set
      if (params.userId && !existing.userId) {
        await prisma.trackingSession.update({
          where: { id: existing.id },
          data: { userId: params.userId, lastSeenAt: new Date() },
        });
      } else {
        await prisma.trackingSession.update({
          where: { id: existing.id },
          data: { lastSeenAt: new Date() },
        });
      }
      return existing;
    }
  }

  // 2. If authenticated user, find their active tracking session in the last 24h
  if (params.userId) {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const userSession = await prisma.trackingSession.findFirst({
      where: {
        userId: params.userId,
        endedAt: null,
        lastSeenAt: { gte: twentyFourHoursAgo },
      },
      orderBy: { lastSeenAt: "desc" },
      include: {
        guestProfile: true,
        summaries: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    if (userSession) {
      await prisma.trackingSession.update({
        where: { id: userSession.id },
        data: { lastSeenAt: new Date() },
      });
      return userSession;
    }
  }

  // 3. Resolve or create guest profile if guestId provided
  let guestProfileId: string | null = null;
  if (params.guestId) {
    const hash = hashToken(params.guestId);
    let guestProfile = await prisma.guestProfile.findUnique({
      where: { guestIdHash: hash },
    });

    if (!guestProfile) {
      guestProfile = await prisma.guestProfile.create({
        data: {
          guestIdHash: hash,
          consentState: params.consentState || { analytics: true, essential: true },
        },
      });
    } else {
      await prisma.guestProfile.update({
        where: { id: guestProfile.id },
        data: { lastSeenAt: new Date() },
      });
    }

    guestProfileId = guestProfile.id;

    // Check for recent active session for this guest
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const guestSession = await prisma.trackingSession.findFirst({
      where: {
        guestProfileId,
        endedAt: null,
        lastSeenAt: { gte: twentyFourHoursAgo },
      },
      orderBy: { lastSeenAt: "desc" },
      include: {
        guestProfile: true,
        summaries: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    if (guestSession) {
      await prisma.trackingSession.update({
        where: { id: guestSession.id },
        data: { lastSeenAt: new Date() },
      });
      return guestSession;
    }
  }

  // 4. Create new tracking session
  const sessionKey = generateUUID();
  const sessionKeyHash = hashToken(sessionKey);
  const now = new Date();

  const newSession = await prisma.trackingSession.create({
    data: {
      guestProfileId,
      userId: params.userId || null,
      sessionKeyHash,
      startedAt: now,
      lastSeenAt: now,
      consentState: params.consentState || { analytics: true },
    },
    include: {
      guestProfile: true,
      summaries: true,
    },
  });

  // Initialize session summary
  await prisma.sessionSummary.create({
    data: {
      trackingSessionId: newSession.id,
      windowStart: now,
      windowEnd: now,
      pageViews: 0,
      uniqueProducts: 0,
      activeSeconds: 0,
      cartActions: 0,
    },
  });

  return newSession;
}

/**
 * Ingest a batch of analytics events with client UUID deduplication
 */
export async function ingestBatchEvents(params: BatchEventsParams) {
  if (!params.events || !Array.isArray(params.events) || params.events.length === 0) {
    return {
      trackingSessionId: params.trackingSessionId || null,
      accepted: 0,
      duplicates: 0,
      total: 0,
    };
  }

  // Resolve tracking session
  const session = await resolveTrackingSession({
    trackingSessionId: params.trackingSessionId,
    guestId: params.guestId,
    userId: params.userId,
  });

  let accepted = 0;
  let duplicates = 0;
  let newPageViews = 0;
  let newCartActions = 0;

  for (const ev of params.events) {
    const eventId = ev.eventId || generateUUID();

    // Check for duplicate eventId
    const existing = await prisma.activityEvent.findUnique({
      where: { eventId },
      select: { id: true },
    });

    if (existing) {
      duplicates++;
      continue;
    }

    const occurredAt = ev.occurredAt ? new Date(ev.occurredAt) : new Date();

    await prisma.activityEvent.create({
      data: {
        eventId,
        trackingSessionId: session.id,
        eventName: ev.eventName,
        occurredAt,
        routeTemplate: ev.routeTemplate || ev.path,
        path: ev.path,
        productId: ev.productId || null,
        metadata: ev.metadata || {},
      },
    });

    accepted++;

    if (ev.eventName === "page_view") {
      newPageViews++;
    } else if (
      ev.eventName === "add_to_cart" ||
      ev.eventName === "remove_from_cart" ||
      ev.eventName === "cart_update" ||
      ev.eventName === "cart_clear"
    ) {
      newCartActions++;
    }
  }

  // Update session lastSeenAt
  const now = new Date();
  await prisma.trackingSession.update({
    where: { id: session.id },
    data: { lastSeenAt: now },
  });

  if (session.guestProfileId) {
    await prisma.guestProfile.update({
      where: { id: session.guestProfileId },
      data: { lastSeenAt: now },
    });
  }

  // Calculate distinct products viewed in this session
  const uniqueProductsResult = await prisma.activityEvent.findMany({
    where: {
      trackingSessionId: session.id,
      productId: { not: null },
    },
    select: { productId: true },
    distinct: ["productId"],
  });
  const uniqueProductsCount = uniqueProductsResult.length;

  // Update or create session summary
  const summary = await prisma.sessionSummary.findFirst({
    where: { trackingSessionId: session.id },
    orderBy: { createdAt: "desc" },
  });

  if (summary) {
    await prisma.sessionSummary.update({
      where: { id: summary.id },
      data: {
        pageViews: { increment: newPageViews },
        cartActions: { increment: newCartActions },
        uniqueProducts: uniqueProductsCount,
        windowEnd: now,
      },
    });
  } else {
    await prisma.sessionSummary.create({
      data: {
        trackingSessionId: session.id,
        windowStart: session.startedAt,
        windowEnd: now,
        pageViews: newPageViews,
        cartActions: newCartActions,
        uniqueProducts: uniqueProductsCount,
        activeSeconds: 0,
      },
    });
  }

  return {
    trackingSessionId: session.id,
    accepted,
    duplicates,
    total: params.events.length,
  };
}

/**
 * Record active foreground time heartbeat
 */
export async function recordHeartbeat(params: HeartbeatParams) {
  const session = await resolveTrackingSession({
    trackingSessionId: params.trackingSessionId,
    guestId: params.guestId,
    userId: params.userId,
  });

  // Cap interval seconds to 60s per heartbeat to prevent metric distortion
  const safeSeconds = Math.max(1, Math.min(Number(params.seconds) || 15, 60));
  const now = new Date();

  await prisma.trackingSession.update({
    where: { id: session.id },
    data: { lastSeenAt: now },
  });

  if (session.guestProfileId) {
    await prisma.guestProfile.update({
      where: { id: session.guestProfileId },
      data: { lastSeenAt: now },
    });
  }

  const summary = await prisma.sessionSummary.findFirst({
    where: { trackingSessionId: session.id },
    orderBy: { createdAt: "desc" },
  });

  let totalActiveSeconds = safeSeconds;

  if (summary) {
    const updated = await prisma.sessionSummary.update({
      where: { id: summary.id },
      data: {
        activeSeconds: { increment: safeSeconds },
        windowEnd: now,
      },
    });
    totalActiveSeconds = updated.activeSeconds;
  } else {
    const created = await prisma.sessionSummary.create({
      data: {
        trackingSessionId: session.id,
        windowStart: session.startedAt,
        windowEnd: now,
        pageViews: 1,
        uniqueProducts: 0,
        cartActions: 0,
        activeSeconds: safeSeconds,
      },
    });
    totalActiveSeconds = created.activeSeconds;
  }

  return {
    trackingSessionId: session.id,
    activeSeconds: totalActiveSeconds,
    recordedSeconds: safeSeconds,
    timestamp: now.toISOString(),
  };
}

/**
 * High-level aggregated analytics for Admin Dashboard
 */
export async function getAnalyticsSummary(query: {
  startDate?: string;
  endDate?: string;
  days?: number;
}) {
  const endDate = query.endDate ? new Date(query.endDate) : new Date();
  const startInput = query.startDate ? new Date(query.startDate) : null;
  if (isNaN(endDate.getTime()) || (startInput && isNaN(startInput.getTime()))) {
    const error: any = new Error("startDate and endDate must be valid dates");
    error.statusCode = 400;
    throw error;
  }
  if (query.days !== undefined && !(Number.isInteger(Number(query.days)) && Number(query.days) >= 1 && Number(query.days) <= 366)) {
    const error: any = new Error("days must be a whole number between 1 and 366");
    error.statusCode = 400;
    throw error;
  }
  const days = startInput
    ? Math.max(1, Math.round((endDate.getTime() - startInput.getTime()) / 86_400_000))
    : Number(query.days) || 30;
  const startDate = startInput || new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  // 1. Session & Visitor Metrics
  const totalSessions = await prisma.trackingSession.count({
    where: {
      startedAt: { gte: startDate, lte: endDate },
    },
  });

  // Distinct guest profiles + distinct users
  const uniqueGuestCount = await prisma.trackingSession.findMany({
    where: {
      startedAt: { gte: startDate, lte: endDate },
      guestProfileId: { not: null },
    },
    select: { guestProfileId: true },
    distinct: ["guestProfileId"],
  });

  const uniqueUserCount = await prisma.trackingSession.findMany({
    where: {
      startedAt: { gte: startDate, lte: endDate },
      userId: { not: null },
    },
    select: { userId: true },
    distinct: ["userId"],
  });

  const totalVisitors = uniqueGuestCount.length + uniqueUserCount.length;

  // 2. Event Counts
  const totalEvents = await prisma.activityEvent.count({
    where: {
      occurredAt: { gte: startDate, lte: endDate },
    },
  });

  const pageViewEvents = await prisma.activityEvent.count({
    where: {
      occurredAt: { gte: startDate, lte: endDate },
      eventName: "page_view",
    },
  });

  const cartActionEvents = await prisma.activityEvent.count({
    where: {
      occurredAt: { gte: startDate, lte: endDate },
      eventName: { in: ["add_to_cart", "remove_from_cart", "cart_clear"] },
    },
  });

  // 3. Summaries Aggregations (Active Time & Conversions)
  // Summaries belong to the sessions that started in the period, so the numerator
  // and denominator of the conversion rate cover the same sessions.
  const summaries = await prisma.sessionSummary.findMany({
    where: {
      session: { startedAt: { gte: startDate, lte: endDate } },
    },
  });

  const totalActiveSeconds = summaries.reduce((acc, s) => acc + s.activeSeconds, 0);
  const avgActiveDurationSeconds =
    summaries.length > 0 ? Math.round(totalActiveSeconds / summaries.length) : 0;

  // Sessions in the period that ended in an order (counted once per session).
  const convertedOrdersCount = new Set(
    summaries.filter((s) => s.convertedOrderId !== null).map((s) => s.trackingSessionId)
  ).size;
  // null when there are no sessions: a rate cannot be computed from nothing.
  const conversionRatePercent =
    totalSessions > 0 ? Number(((convertedOrdersCount / totalSessions) * 100).toFixed(2)) : null;

  // 3b. Orders. Sales exclude Cancelled orders and online orders still waiting for their payment (status Pending).
  const periodOrders = await prisma.order.findMany({
    where: { createdAt: { gte: startDate, lte: endDate } },
    select: { id: true, status: true, totalMinor: true, createdAt: true },
  });
  const countedOrders = periodOrders.filter((o) => o.status !== "Cancelled" && o.status !== "Pending");
  const revenueMinor = countedOrders.reduce((acc, o) => acc + o.totalMinor, 0);
  const awaitingPaymentCount = periodOrders.filter((o) => o.status === "Pending").length;
  const cancelledCount = periodOrders.filter((o) => o.status === "Cancelled").length;
  // Money given back for these orders (completed refunds only), so net sales can be shown next to sales.
  const refundAgg = await prisma.refund.aggregate({
    where: { status: "COMPLETED", payment: { order: { createdAt: { gte: startDate, lte: endDate } } } },
    _sum: { amountMinor: true },
  });
  const refundedMinor = refundAgg._sum.amountMinor || 0;
  const statusMap = new Map<string, { count: number; totalMinor: number }>();
  for (const o of periodOrders) {
    const row = statusMap.get(o.status) || { count: 0, totalMinor: 0 };
    row.count += 1;
    row.totalMinor += o.totalMinor;
    statusMap.set(o.status, row);
  }
  const statusBreakdown = [...statusMap.entries()]
    .map(([status, v]) => ({ status, count: v.count, totalMinor: v.totalMinor }))
    .sort((a, b) => b.count - a.count);

  const soldGroups = await prisma.orderItem.groupBy({
    by: ["productSlug", "productTitle"],
    where: { order: { createdAt: { gte: startDate, lte: endDate }, status: { notIn: ["Cancelled", "Pending"] } } },
    _sum: { quantity: true, lineTotalMinor: true },
  });
  const topSellingProducts = soldGroups
    .map((g) => ({
      slug: g.productSlug,
      title: g.productTitle,
      unitsSold: g._sum.quantity || 0,
      revenueMinor: g._sum.lineTotalMinor || 0,
    }))
    .sort((a, b) => b.revenueMinor - a.revenueMinor)
    .slice(0, 5);

  // Daily revenue/orders across the whole period (UTC day buckets).
  const dayKey = (d: Date) => d.toISOString().split("T")[0];
  const buckets = new Map<string, { orders: number; revenueMinor: number }>();
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  while (cursor.getTime() <= endDate.getTime() && buckets.size < 400) {
    buckets.set(dayKey(cursor), { orders: 0, revenueMinor: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  for (const o of countedOrders) {
    const b = buckets.get(dayKey(o.createdAt));
    if (b) {
      b.orders += 1;
      b.revenueMinor += o.totalMinor;
    }
  }
  const dailyTrends = [...buckets.entries()].map(([date, v]) => ({ date, ...v }));

  // 4. Top Viewed Products
  const topProductViews = await prisma.activityEvent.groupBy({
    by: ["productId"],
    where: {
      occurredAt: { gte: startDate, lte: endDate },
      eventName: "product_view",
      productId: { not: null },
    },
    _count: {
      productId: true,
    },
    orderBy: {
      _count: {
        productId: "desc",
      },
    },
    take: 5,
  });

  const productIds = topProductViews.map((p) => p.productId!).filter(Boolean);
  const productRecords = await prisma.product.findMany({
    where: { id: { in: productIds } },
    include: {
      images: { orderBy: { sortOrder: "asc" }, take: 1 },
      category: { select: { name: true } },
    },
  });

  const topProducts = topProductViews.flatMap((pv) => {
    const prod = productRecords.find((p) => p.id === pv.productId);
    if (!prod) return []; // product no longer exists: do not invent a name for it
    return [
      {
        productId: pv.productId,
        views: pv._count.productId,
        title: prod.title,
        slug: prod.slug,
        categoryName: prod.category?.name || "",
        basePriceMinor: prod.basePriceMinor,
        image: prod.images?.[0]?.url || null,
      },
    ];
  });

  // 5. Popular Routes
  const popularRoutesGroup = await prisma.activityEvent.groupBy({
    by: ["path"],
    where: {
      occurredAt: { gte: startDate, lte: endDate },
      eventName: "page_view",
    },
    _count: {
      path: true,
    },
    orderBy: {
      _count: {
        path: "desc",
      },
    },
    take: 6,
  });

  const popularRoutes = popularRoutesGroup.map((r) => ({
    path: r.path,
    views: r._count.path,
  }));

  // 6. Event Breakdown
  const eventBreakdownGroup = await prisma.activityEvent.groupBy({
    by: ["eventName"],
    where: {
      occurredAt: { gte: startDate, lte: endDate },
    },
    _count: {
      eventName: true,
    },
    orderBy: {
      _count: {
        eventName: "desc",
      },
    },
  });

  const eventBreakdown = eventBreakdownGroup.map((e) => ({
    eventName: e.eventName,
    count: e._count.eventName,
  }));

  return {
    timeframe: {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      days,
    },
    metrics: {
      totalVisitors,
      totalSessions,
      totalPageViews: pageViewEvents,
      totalEvents,
      totalCartActions: cartActionEvents,
      avgActiveDurationSeconds,
      convertedOrdersCount,
      conversionRatePercent,
    },
    orders: {
      ordersCount: countedOrders.length,
      cancelledCount,
      awaitingPaymentCount,
      revenueMinor,
      refundedMinor,
      netRevenueMinor: revenueMinor - refundedMinor,
      averageOrderValueMinor: countedOrders.length > 0 ? Math.round(revenueMinor / countedOrders.length) : 0,
      statusBreakdown,
      topSellingProducts,
    },
    topProducts,
    popularRoutes,
    eventBreakdown,
    dailyTrends,
  };
}

/**
 * Detailed timeline and metrics for an individual visitor tracking session
 */
export async function getSessionDetail(sessionId: string) {
  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
    include: {
      guestProfile: true,
      summaries: { orderBy: { createdAt: "desc" }, take: 1 },
      events: {
        orderBy: { occurredAt: "asc" },
      },
    },
  });

  if (!session) {
    return null;
  }

  let user = null;
  if (session.userId) {
    user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        email: true,
        profile: {
          select: { displayName: true, tier: true, phone: true },
        },
      },
    });
  }

  let convertedOrder = null;
  const summary = session.summaries[0];
  if (summary?.convertedOrderId) {
    convertedOrder = await prisma.order.findUnique({
      where: { id: summary.convertedOrderId },
      select: {
        id: true,
        orderNumber: true,
        totalMinor: true,
        status: true,
        createdAt: true,
      },
    });
  }

  // Calculate session elapsed time
  const startTime = session.startedAt.getTime();
  const timeline = session.events.map((e, index) => {
    const elapsedSeconds = Math.max(0, Math.round((e.occurredAt.getTime() - startTime) / 1000));
    return {
      id: e.id,
      eventId: e.eventId,
      eventName: e.eventName,
      occurredAt: e.occurredAt.toISOString(),
      elapsedSeconds,
      path: e.path,
      routeTemplate: e.routeTemplate,
      productId: e.productId,
      metadata: e.metadata,
    };
  });

  return {
    id: session.id,
    startedAt: session.startedAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    user: user
      ? {
          id: user.id,
          email: user.email,
          displayName: user.profile?.displayName || null,
          tier: user.profile?.tier || "Circle Member",
        }
      : null,
    guestProfileId: session.guestProfileId,
    activeSeconds: summary?.activeSeconds || 0,
    pageViews: summary?.pageViews || 0,
    uniqueProducts: summary?.uniqueProducts || 0,
    cartActions: summary?.cartActions || 0,
    isConverted: Boolean(summary?.convertedOrderId),
    convertedOrder,
    totalEventsCount: session.events.length,
    timeline,
  };
}

/**
 * List recent visitor sessions for the Admin Portal
 */
export async function getRecentSessions(query: {
  page?: number;
  limit?: number;
  convertedOnly?: boolean;
  days?: number;
}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 15));
  const skip = (page - 1) * limit;

  const whereClause: any = {};
  if (query.days && query.days > 0) {
    whereClause.startedAt = { gte: new Date(Date.now() - query.days * 86_400_000) };
  }
  if (query.convertedOnly) {
    whereClause.summaries = {
      some: {
        convertedOrderId: { not: null },
      },
    };
  }

  const [total, sessions] = await Promise.all([
    prisma.trackingSession.count({ where: whereClause }),
    prisma.trackingSession.findMany({
      where: whereClause,
      orderBy: { lastSeenAt: "desc" },
      skip,
      take: limit,
      include: {
        guestProfile: true,
        summaries: { orderBy: { createdAt: "desc" }, take: 1 },
        _count: {
          select: { events: true },
        },
      },
    }),
  ]);

  // Fetch users for sessions that have userId
  const userIds = sessions.map((s) => s.userId).filter(Boolean) as string[];
  const users =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            email: true,
            profile: { select: { displayName: true, tier: true } },
          },
        })
      : [];

  const items = sessions.map((s) => {
    const summary = s.summaries[0];
    const u = users.find((user) => user.id === s.userId);
    return {
      id: s.id,
      startedAt: s.startedAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      activeSeconds: summary?.activeSeconds || 0,
      pageViews: summary?.pageViews || 0,
      cartActions: summary?.cartActions || 0,
      eventsCount: s._count.events,
      isConverted: Boolean(summary?.convertedOrderId),
      convertedOrderId: summary?.convertedOrderId || null,
      visitorType: s.userId ? "Registered Customer" : "Guest Patron",
      identity: s.userId
        ? u?.profile?.displayName || u?.email || "Customer"
        : `Guest (${s.guestProfileId?.slice(0, 8) || "Anonymous"})`,
      userEmail: u?.email || null,
      tier: u?.profile?.tier || (s.userId ? "Circle Member" : "Visitor"),
    };
  });

  return {
    sessions: items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Live active sessions (last 15 minutes) and real-time event feed
 */
export async function getLiveActiveVisitors(windowMinutes = 15) {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);

  const activeSessionsCount = await prisma.trackingSession.count({
    where: {
      lastSeenAt: { gte: cutoff },
    },
  });

  const recentEvents = await prisma.activityEvent.findMany({
    where: {
      occurredAt: { gte: cutoff },
    },
    orderBy: { occurredAt: "desc" },
    take: 20,
    include: {
      session: {
        select: {
          id: true,
          userId: true,
          guestProfileId: true,
        },
      },
    },
  });

  return {
    windowMinutes,
    activeVisitorsCount: activeSessionsCount,
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      eventId: e.eventId,
      sessionId: e.trackingSessionId,
      eventName: e.eventName,
      path: e.path,
      productId: e.productId,
      occurredAt: e.occurredAt.toISOString(),
      metadata: e.metadata,
    })),
  };
}
