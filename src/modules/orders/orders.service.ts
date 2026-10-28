import { queueAdminNewOrderEmail, queueOrderEmail } from "../email/email.orders.js";
import { notifyAdminsNewOrder, notifyOrderEvent, type OrderEvent } from "../notifications/notify.js";
import { prisma } from "../../database/prisma.js";
import { generateUUID, hashToken } from "../../common/crypto.utils.js";
import { couponError, evaluateCoupon } from "../coupons/coupons.service.js";
import { getSettings, toMinor } from "../settings/settings.service.js";
import { CartOwner, getActiveCart } from "../cart/cart.service.js";
import { cashfreeConfigured } from "../payments/cashfree.client.js";
import { closeOnlinePayments } from "../payments/payments.service.js";
import { refundableMinor } from "../payments/refunds.service.js";
import { background } from "../../common/background.js";

export interface QuoteParams {
  owner: CartOwner;
  couponCode?: string | null;
  shippingAddress?: any;
  shippingMethod?: "standard" | "express";
  items?: Array<{ variantId: string; quantity: number }>;
  // Cash on Delivery is the default; online payment has no COD handling fee.
  paymentProvider?: "COD" | "CASHFREE";
}

export interface ResolvedLineItem {
  variantId: string;
  variant: any;
  product: any;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  coverImage: string;
}

/**
 * Resolve items either from explicit list or active cart
 */
export async function resolveLineItems(
  owner: CartOwner,
  explicitItems?: Array<{ variantId: string; quantity: number }>
): Promise<{ items: ResolvedLineItem[]; subtotalMinor: number; activeCartId: string | null }> {
  let activeCartId: string | null = null;
  const resolved: ResolvedLineItem[] = [];

  if (explicitItems && explicitItems.length > 0) {
    for (const item of explicitItems) {
      const variant = await prisma.productVariant.findUnique({
        where: { id: item.variantId },
        include: {
          product: {
            include: {
              images: { orderBy: { sortOrder: "asc" } },
            },
          },
        },
      });

      if (!variant || variant.status !== "Active" || variant.product.status !== "Active" || variant.product.deletedAt) {
        throw new Error(`Variant ${item.variantId} is inactive or does not exist`);
      }

      const unitPriceMinor = variant.priceOverrideMinor ?? variant.product.basePriceMinor;
      const lineTotalMinor = unitPriceMinor * item.quantity;
      const coverImage =
        variant.product.images.find((img) => img.isCover)?.url ||
        variant.product.images[0]?.url ||
        "/images/brand/logo_emblem.png";

      resolved.push({
        variantId: variant.id,
        variant,
        product: variant.product,
        quantity: item.quantity,
        unitPriceMinor,
        lineTotalMinor,
        coverImage,
      });
    }
  } else {
    // Resolve from active cart
    const cart = await getActiveCart(owner);
    if (cart && cart.items.length > 0) {
      activeCartId = cart.id;
      for (const item of cart.items) {
        const variant = item.variant;
        const product = variant?.product;

        if (!variant || variant.status !== "Active" || product?.status !== "Active" || product?.deletedAt) {
          throw new Error(
            `Item "${product?.title || 'Selected garment'}" is no longer available in the atelier.`
          );
        }

        // Always the current catalogue price. The price saved when the item was added to the cart can be out of date.
        const unitPriceMinor = variant.priceOverrideMinor ?? product.basePriceMinor;
        const lineTotalMinor = unitPriceMinor * item.quantity;
        const coverImage =
          product.images?.find((img: any) => img.isCover)?.url ||
          product.images?.[0]?.url ||
          "/images/brand/logo_emblem.png";

        resolved.push({
          variantId: variant.id,
          variant,
          product,
          quantity: item.quantity,
          unitPriceMinor,
          lineTotalMinor,
          coverImage,
        });
      }
    }
  }

  const subtotalMinor = resolved.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  return { items: resolved, subtotalMinor, activeCartId };
}

/**
 * Calculate checkout quote with discounts, shipping, and tax
 */
export async function calculateQuote(params: QuoteParams) {
  const { items, subtotalMinor } = await resolveLineItems(params.owner, params.items);

  let discountMinor = 0;
  let appliedCoupon: any = null;

  if (params.couponCode && params.couponCode.trim()) {
    const cleanCode = params.couponCode.trim().toUpperCase();
    const coupon = await prisma.coupon.findUnique({ where: { code: cleanCode } });
    // Throws a 400 with a plain message when the code cannot be used on this order.
    discountMinor = evaluateCoupon(coupon, subtotalMinor);
    appliedCoupon = {
      code: coupon!.code,
      type: coupon!.type,
      value: coupon!.value,
      description: coupon!.description,
      discountMinor,
    };
  }

  // Shipping rules come from the store settings (defaults: free from ₹5,000, otherwise ₹499).
  const settings = await getSettings();
  const freeShippingThresholdMinor = toMinor(settings.shipping.freeShippingThreshold);
  const flatFeeMinor = toMinor(settings.shipping.flatFee);
  let shippingMinor = 0;
  if (params.shippingMethod === "express") {
    shippingMinor = flatFeeMinor;
  } else if (subtotalMinor >= freeShippingThresholdMinor || subtotalMinor === 0) {
    shippingMinor = 0;
  } else {
    shippingMinor = flatFeeMinor;
  }
  const codFeeMinor = subtotalMinor === 0 || params.paymentProvider === "CASHFREE" ? 0 : toMinor(settings.cod.fee);

  // Tax rules (All bespoke garment prices include GST)
  const taxMinor = 0;

  const totalMinor = Math.max(0, subtotalMinor - discountMinor + shippingMinor + codFeeMinor + taxMinor);

  return {
    currency: "INR",
    subtotalMinor,
    discountMinor,
    shippingMinor,
    codFeeMinor,
    codEnabled: settings.cod.enabled,
    onlineEnabled: cashfreeConfigured(),
    paymentProvider: params.paymentProvider || "COD",
    taxMinor,
    totalMinor,
    freeShippingThresholdMinor,
    itemsCount: items.reduce((sum, item) => sum + item.quantity, 0),
    coupon: appliedCoupon,
    itemsSummary: items.map((it) => ({
      variantId: it.variantId,
      title: it.product.title,
      size: it.variant.size,
      colour: it.variant.colourName,
      quantity: it.quantity,
      unitPriceMinor: it.unitPriceMinor,
      lineTotalMinor: it.lineTotalMinor,
      image: it.coverImage,
    })),
  };
}

/**
 * Stepper milestone progression matching Saffron Threads Orders Stepper mockup
 */
export function buildOrderStepper(orderStatus: string, statusHistory: any[] = []) {
  const allMilestones = [
    { key: "Pending", label: "Order Placed", description: "Bespoke purchase received" },
    { key: "Processing", label: "Artisan Crafting", description: "Hand embroidery in Jaipur Atelier" },
    { key: "Ready to Ship", label: "Quality Inspection", description: "Zari verification passed" },
    { key: "Shipped", label: "Courier Dispatched", description: "Handed over to luxury courier" },
    { key: "Delivered", label: "Delivered", description: "Received at royal residence" },
  ];

  const statusPriority: Record<string, number> = {
    Pending: 0,
    Processing: 1,
    "Ready to Ship": 2,
    Shipped: 3,
    Delivered: 4,
    Cancelled: -1,
  };

  const currentStepIndex = statusPriority[orderStatus] ?? 1;

  return allMilestones.map((m, index) => {
    const historyItem = statusHistory.find((h) => h.newStatus === m.key);
    return {
      key: m.key,
      label: m.label,
      description: m.description,
      isCompleted: orderStatus !== "Cancelled" && index <= currentStepIndex,
      isCurrent: orderStatus !== "Cancelled" && index === currentStepIndex,
      completedAt: historyItem?.createdAt || null,
    };
  });
}

/**
 * Place a made-to-order bespoke purchase with IdempotencyKey protection
 */
export async function placeOrder(
  owner: CartOwner,
  data: any,
  idempotencyKey?: string | null
) {
  // 1. Idempotency Check (Fast Path for existing keys)
  if (idempotencyKey) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { key: idempotencyKey },
    });
    if (existing && existing.expiresAt > new Date()) {
      if (existing.requestHash !== hashToken(JSON.stringify(data))) {
        throw conflict("This idempotency key was already used for a different order");
      }
      return {
        isDuplicate: true,
        statusCode: existing.responseCode,
        payload: existing.responseBody,
      };
    }
  }

  const paymentProvider = String(data.paymentMethod?.provider || "").toUpperCase();
  if (paymentProvider !== "COD" && paymentProvider !== "CASHFREE") throw couponError("Choose a payment method.");
  const isOnline = paymentProvider === "CASHFREE";

  // 2. Resolve items
  const { items, subtotalMinor, activeCartId } = await resolveLineItems(owner, data.items);
  if (items.length === 0) {
    throw new Error("Cannot checkout with an empty cart");
  }

  // 3. Compute final quote
  const quote = await calculateQuote({
    owner,
    couponCode: data.couponCode,
    shippingAddress: data.shippingAddress,
    shippingMethod: data.shippingMethod,
    items: data.items,
    paymentProvider,
  });

  // 4. Generate unique readable orderNumber (ST10234 format)
  let orderNumber = "";
  for (let i = 0; i < 10; i++) {
    const rand = Math.floor(10000 + Math.random() * 90000);
    const candidate = `ST${rand}`;
    const found = await prisma.order.findUnique({ where: { orderNumber: candidate } });
    if (!found) {
      orderNumber = candidate;
      break;
    }
  }
  if (!orderNumber) {
    orderNumber = `ST${Date.now().toString().slice(-5)}`;
  }

  if (isOnline ? !quote.onlineEnabled : !quote.codEnabled) {
    throw couponError(isOnline ? "Online payment is not available right now." : "Cash on Delivery is not available right now.");
  }
  // An online order waits as Pending until the provider confirms the payment; a Cash on Delivery order goes straight to the atelier.
  const initialOrderStatus = isOnline ? "Pending" : "Processing";

  // 5. Atomic transaction with race-condition safe idempotency insert
  try {
    const result = await prisma.$transaction(async (tx) => {
      // 5.1 Create Order
      const order = await tx.order.create({
        data: {
          orderNumber,
          userId: owner.userId,
          guestProfileId: owner.guestProfileId,
          status: initialOrderStatus,
          paymentStatus: "Pending",
          currency: "INR",
          subtotalMinor: quote.subtotalMinor,
          // Any COD handling fee is kept with the delivery charge so the order totals still add up.
          shippingMinor: quote.shippingMinor + quote.codFeeMinor,
          taxMinor: quote.taxMinor,
          discountMinor: quote.discountMinor,
          totalMinor: quote.totalMinor,
          shippingAddress: data.shippingAddress,
          billingAddress: data.billingAddress || data.shippingAddress,
          // Only the chosen method is kept. Anything else the browser sent (ids, card hints) is not stored.
          paymentMethod: { provider: paymentProvider },
          bespokeNotes: data.bespokeNotes || null,
          couponCode: quote.coupon?.code ?? null,
        },
      });

      // 5.2 Create Order Items (Immutable Snapshots)
      const createdItems = [];
      for (const item of items) {
        const oi = await tx.orderItem.create({
          data: {
            orderId: order.id,
            productVariantId: item.variant.id,
            productTitle: item.product.title,
            productSlug: item.product.slug,
            productImage: item.coverImage,
            sku: item.variant.sku,
            size: item.variant.size,
            colour: item.variant.colourName,
            quantity: item.quantity,
            unitPriceMinor: item.unitPriceMinor,
            taxMinor: 0,
            lineTotalMinor: item.lineTotalMinor,
          },
        });
        createdItems.push(oi);
      }

      // 5.3 Create Payment
      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          provider: paymentProvider,
          providerReference: `PAY_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          // the first online attempt uses the order number as its payment-provider order id
          providerOrderId: isOnline ? orderNumber : null,
          amountMinor: quote.totalMinor,
          currency: "INR",
          status: "PENDING",
          metadata: { provider: paymentProvider },
        },
      });

      // 5.4 Create Status History
      const initialStatus = await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          oldStatus: null,
          newStatus: initialOrderStatus,
          actorUserId: owner.userId,
          note: isOnline ? "Order created. Waiting for the online payment." : "Bespoke made-to-order purchase confirmed. Dispatched to Jaipur Atelier master artisan.",
        },
      });

      // 5.5 Increment coupon usage
      if (quote.coupon) {
        const liveCoupon = await tx.coupon.findUnique({ where: { code: quote.coupon.code } });
        // Checked again inside the transaction so two orders cannot both take the last use.
        evaluateCoupon(liveCoupon, subtotalMinor);
        const claimed = await tx.coupon.updateMany({
          where: {
            code: quote.coupon.code,
            ...(liveCoupon!.maxRedemptions != null ? { redemptionsCount: { lt: liveCoupon!.maxRedemptions } } : {}),
          },
          data: { redemptionsCount: { increment: 1 } },
        });
        if (claimed.count === 0) throw couponError("This promo code has reached its usage limit.");
      }

      // 5.6 Convert active cart
      if (activeCartId) {
        await tx.cart.update({
          where: { id: activeCartId },
          data: { status: "CONVERTED" },
        });
      }

      // 5.6b Attribute conversion to active tracking session
      try {
        const sessionFilter = owner.userId
          ? { userId: owner.userId }
          : owner.guestProfileId
          ? { guestProfileId: owner.guestProfileId }
          : null;

        if (sessionFilter) {
          const activeSession = await tx.trackingSession.findFirst({
            where: sessionFilter,
            orderBy: { lastSeenAt: "desc" },
          });

          if (activeSession) {
            const summary = await tx.sessionSummary.findFirst({
              where: { trackingSessionId: activeSession.id },
              orderBy: { createdAt: "desc" },
            });
            if (summary) {
              await tx.sessionSummary.update({
                where: { id: summary.id },
                data: { convertedOrderId: order.id },
              });
            } else {
              await tx.sessionSummary.create({
                data: {
                  trackingSessionId: activeSession.id,
                  windowStart: activeSession.startedAt || new Date(),
                  windowEnd: new Date(),
                  convertedOrderId: order.id,
                  pageViews: 0,
                  uniqueProducts: 0,
                  activeSeconds: 0,
                  cartActions: 1,
                },
              });
            }
          }
        }
      } catch (analyticsErr) {
        // Non-blocking for checkout transaction
        console.warn("[CHECKOUT_ANALYTICS_ATTRIBUTION_WARN]", analyticsErr);
      }

      // 5.7 Construct complete order and response payload
      const stepper = buildOrderStepper(initialOrderStatus, [initialStatus]);
      const timeline = stepper.map((st) => ({
        title: st.label,
        date: st.completedAt
          ? new Date(st.completedAt).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
            })
          : st.description,
        completed: st.isCompleted,
        current: st.isCurrent,
      }));

      const completeOrder = {
        ...order,
        items: createdItems.map((it: any) => ({
          ...it,
          product: {
            title: it.productTitle || "Bespoke Creation",
            slug: (it.productTitle || "bespoke")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-"),
            images: [
              it.coverImage ||
                it.productImage ||
                "/images/brand/logo_emblem.png",
            ],
          },
          unitPrice: it.unitPriceMinor / 100,
          color: { name: it.colour || "Jaipur Saffron" },
        })),
        shipments: [],
        statusHistory: [initialStatus],
        payments: [payment],
        stepper,
        timeline,
        subtotal: quote.subtotalMinor / 100,
        shipping: (quote.shippingMinor + quote.codFeeMinor) / 100,
        discount: quote.discountMinor / 100,
        total: quote.totalMinor / 100,
      };

      const responsePayload = {
        status: "success",
        message: "Order placed successfully",
        data: {
          order: completeOrder,
          payment,
          requiresPayment: isOnline,
        },
      };

      // 5.8 Insert Idempotency Key ATOMICALLY inside transaction
      // If a concurrent checkout races with the same key, PostgreSQL unique index will abort the loser!
      if (idempotencyKey) {
        await tx.idempotencyKey.create({
          data: {
            key: idempotencyKey,
            scope: "CHECKOUT",
            requestHash: hashToken(JSON.stringify(data)),
            responseCode: 201,
            responseBody: responsePayload,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
          },
        });
      }

      return { order: completeOrder, payment, responsePayload };
    });

    // Cash on Delivery orders are confirmed now. Online orders are confirmed (and these messages sent) when the payment arrives.
    if (!isOnline) {
      queueOrderEmail(result.order.id, "order-confirmation");
      queueAdminNewOrderEmail(result.order.id);
      notifyOrderEvent(result.order.id, "placed");
      notifyAdminsNewOrder(result.order.id);
    }

    return {
      isDuplicate: false,
      statusCode: 201,
      payload: result.responsePayload,
    };
  } catch (error: any) {
    // If a concurrent request created the order with this idempotency key, catch P2002 and return the winning order
    if (
      idempotencyKey &&
      error.code === "P2002" &&
      (error.meta?.target?.includes("key") || String(error.message).includes("idempotency_keys"))
    ) {
      const existing = await prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
      });
      if (existing) {
        return {
          isDuplicate: true,
          statusCode: existing.responseCode,
          payload: existing.responseBody,
        };
      }
    }
    throw error;
  }
}

/**
 * Retrieve list of orders for customer
 */
export async function getCustomerOrders(owner: CartOwner) {
  const whereClause = owner.userId
    ? { userId: owner.userId }
    : owner.guestProfileId
    ? { guestProfileId: owner.guestProfileId }
    : null;

  if (!whereClause) {
    return [];
  }

  const orders = await prisma.order.findMany({
    where: whereClause,
    orderBy: { createdAt: "desc" },
    include: {
      items: true,
      shipments: true,
      statusHistory: { orderBy: { createdAt: "asc" } },
      payments: true,
    },
  });

  return orders.map((order) => {
    const primaryItem = order.items[0];
    const stepper = buildOrderStepper(order.status, order.statusHistory);
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      currency: order.currency,
      totalMinor: order.totalMinor,
      subtotalMinor: order.subtotalMinor,
      shippingMinor: order.shippingMinor,
      discountMinor: order.discountMinor,
      itemsCount: order.items.reduce((sum, it) => sum + it.quantity, 0),
      primaryItem: primaryItem
        ? {
            title: primaryItem.productTitle,
            image: primaryItem.productImage,
            size: primaryItem.size,
            colour: primaryItem.colour,
          }
        : null,
      items: order.items,
      shipments: order.shipments,
      statusHistory: order.statusHistory,
      shippingAddress: order.shippingAddress,
      paymentMethod: order.paymentMethod,
      stepper,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  });
}

/**
 * Retrieve detailed single order by UUID or orderNumber
 */
export async function getOrderDetail(
  identifier: string,
  owner?: CartOwner | null,
  isAdmin = false
) {
  const cleanId = identifier.replace(/^#/, "").trim();

  const order = await prisma.order.findFirst({
    where: {
      OR: [{ id: cleanId }, { orderNumber: cleanId }, { orderNumber: `ST${cleanId}` }],
    },
    include: {
      items: true,
      shipments: { orderBy: { createdAt: "desc" } },
      statusHistory: isAdmin
        ? {
            orderBy: { createdAt: "asc" },
            include: { actorUser: { select: { email: true, profile: { select: { displayName: true } } } } },
          }
        : { orderBy: { createdAt: "asc" } },
      // Customers see the facts of each payment, never the provider's identifiers.
      payments: isAdmin
        ? { orderBy: { createdAt: "asc" as const }, include: { refunds: { orderBy: { createdAt: "asc" as const } } } }
        : {
            orderBy: { createdAt: "asc" as const },
            select: {
              id: true,
              provider: true,
              status: true,
              amountMinor: true,
              currency: true,
              paidAt: true,
              createdAt: true,
              failureReason: true,
              refunds: { orderBy: { createdAt: "asc" as const }, select: { id: true, amountMinor: true, status: true, method: true, createdAt: true, processedAt: true } },
            },
          },
      // A customer sees their own requests without staff identifiers (who decided, internal ids).
      requests: isAdmin
        ? { orderBy: { createdAt: "desc" as const }, include: { items: true, events: { orderBy: { createdAt: "asc" as const } } } }
        : {
            orderBy: { createdAt: "desc" as const },
            select: {
              id: true,
              requestNumber: true,
              type: true,
              status: true,
              reasonCode: true,
              details: true,
              resolution: true,
              outsideWindow: true,
              returnShippingPayer: true,
              evidence: true,
              decisionNote: true,
              createdAt: true,
              completedAt: true,
              items: { select: { orderItemId: true, quantity: true, exchangeSize: true } },
              events: { orderBy: { createdAt: "asc" as const }, select: { fromStatus: true, toStatus: true, actorRole: true, note: true, createdAt: true } },
            },
          },
      // Internal notes are for staff only.
      ...(isAdmin
        ? {
            notes: {
              orderBy: { createdAt: "asc" as const },
              include: { author: { select: { email: true, profile: { select: { displayName: true } } } } },
            },
          }
        : {}),
    },
  });

  if (!order) {
    throw new Error("Order not found");
  }

  // Verify access rights
  if (!isAdmin) {
    if (!owner) {
      throw new Error("Forbidden: You do not have permission to view this order");
    }
    const isUserOwner = Boolean(owner.userId && order.userId === owner.userId);
    const isGuestOwner = Boolean(owner.guestProfileId && order.guestProfileId === owner.guestProfileId);
    if (!isUserOwner && !isGuestOwner) {
      throw new Error("Forbidden: You do not have permission to view this order");
    }
  }

  const stepper = buildOrderStepper(order.status, order.statusHistory);

  // Money still to be given back, per payment and for the order as a whole.
  // Staff see who started each refund (a name, not an internal id).
  let initiators = new Map<string, string>();
  if (isAdmin) {
    const ids = [...new Set(order.payments.flatMap((p: any) => p.refunds.map((r: any) => r.initiatedByUserId)).filter(Boolean))] as string[];
    if (ids.length) {
      const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, profile: { select: { displayName: true } } } });
      initiators = new Map(users.map((u) => [u.id, u.profile?.displayName || u.email]));
    }
  }
  const payments = order.payments.map((p: any) => ({
    ...p,
    refundableMinor: p.status === "SUCCESS" ? refundableMinor(p) : 0,
    ...(isAdmin ? { refunds: p.refunds.map((r: any) => ({ ...r, initiatedByName: r.initiatedByUserId ? initiators.get(r.initiatedByUserId) || null : null })) } : {}),
  }));
  const collected = payments.filter((p: any) => p.status === "SUCCESS").reduce((s: number, p: any) => s + p.amountMinor, 0);
  const refunded = payments.flatMap((p: any) => p.refunds).filter((r: any) => r.status === "COMPLETED").reduce((s: number, r: any) => s + r.amountMinor, 0);
  const deliveredEntry = [...order.statusHistory].reverse().find((h: any) => h.newStatus === "Delivered");

  return {
    ...order,
    payments,
    stepper,
    deliveredAt: deliveredEntry ? deliveredEntry.createdAt : null,
    // A cancelled order that was paid owes the customer their money back.
    refundDueMinor: order.status === "Cancelled" ? Math.max(0, collected - refunded) : 0,
    refundedMinor: refunded,
    collectedMinor: collected,
  };
}

/**
 * Tracking for someone without an account: the order number plus the email address given at checkout. Anything that does
 * not match answers exactly the same, so this cannot be used to find out which order numbers exist.
 */
export async function trackOrderPublic(orderNumber: string, email: string) {
  const clean = orderNumber.replace(/^#/, "").trim().toUpperCase();
  const order = await prisma.order.findUnique({
    where: { orderNumber: clean },
    include: { items: true, shipments: { orderBy: { createdAt: "desc" }, take: 1 }, statusHistory: { orderBy: { createdAt: "asc" } } },
  });
  const stored = String((order?.shippingAddress as any)?.email || "").trim().toLowerCase();
  if (!order || !stored || stored !== email.trim().toLowerCase()) {
    const error: any = new Error("We could not find an order with those details. Check the order number and the email address used at checkout.");
    error.statusCode = 404;
    throw error;
  }
  const shipment = order.shipments[0];
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentProvider: String((order.paymentMethod as any)?.provider || ""),
    createdAt: order.createdAt,
    totalMinor: order.totalMinor,
    stepper: buildOrderStepper(order.status, order.statusHistory),
    items: order.items.map((it) => ({ title: it.productTitle, size: it.size, colour: it.colour, quantity: it.quantity, image: it.productImage })),
    shipment: shipment ? { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber, trackingUrl: shipment.trackingUrl, status: shipment.status, estimatedDelivery: shipment.estimatedDelivery } : null,
  };
}

/**
 * Admin: Query all orders with dashboard stats & filtering
 */
export async function getAdminOrders(filters: {
  status?: string;
  paymentStatus?: string;
  search?: string;
  page?: number;
  limit?: number;
  startDate?: string;
  endDate?: string;
}) {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.max(1, Math.min(100, filters.limit || 10));
  const skip = (page - 1) * limit;

  const where: any = {};

  if (filters.status && filters.status !== "all" && filters.status !== "All Orders") {
    where.status = filters.status;
  }

  if (filters.paymentStatus && filters.paymentStatus !== "all") {
    where.paymentStatus = filters.paymentStatus;
  }

  if (filters.startDate || filters.endDate) {
    where.createdAt = {};
    if (filters.startDate) {
      const d = new Date(filters.startDate);
      if (!isNaN(d.getTime())) where.createdAt.gte = d;
    }
    if (filters.endDate) {
      const d = new Date(filters.endDate);
      if (!isNaN(d.getTime())) where.createdAt.lte = d;
    }
  }

  if (filters.search) {
    const s = filters.search.trim().replace(/^#/, "");
    where.OR = [
      { orderNumber: { contains: s, mode: "insensitive" } },
      { id: { contains: s, mode: "insensitive" } },
      // Search in shippingAddress JSON
      {
        shippingAddress: {
          path: ["fullName"],
          string_contains: s,
        },
      },
      {
        shippingAddress: {
          path: ["phone"],
          string_contains: s,
        },
      },
    ];
  }

  const [orders, total, totalOrders, processingCount, readyToShipCount, shippedCount, deliveredCount, paidRevenue] =
    await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          items: true,
          shipments: true,
          statusHistory: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      prisma.order.count({ where }),
      prisma.order.count(),
      prisma.order.count({ where: { status: "Processing" } }),
      prisma.order.count({ where: { status: "Ready to Ship" } }),
      prisma.order.count({ where: { status: "Shipped" } }),
      prisma.order.count({ where: { status: "Delivered" } }),
      // Revenue is money actually received (successful payments) minus refunds that were completed.
      prisma.payment.aggregate({ where: { status: "SUCCESS" }, _sum: { amountMinor: true } }),
    ]);
  const refundedTotal = await prisma.refund.aggregate({ where: { status: "COMPLETED" }, _sum: { amountMinor: true } });

  const items = orders.map((order) => {
    const addr = order.shippingAddress as any;
    return {
      id: order.id,
      orderNumber: `#${order.orderNumber}`,
      customer: {
        name: addr?.fullName || "Valued Client",
        phone: addr?.phone || "",
        email: addr?.email || "",
      },
      items: order.items.map((it) => ({
        id: it.id,
        title: it.productTitle,
        image: it.productImage,
        size: it.size,
        colour: it.colour,
        quantity: it.quantity,
        unitPriceMinor: it.unitPriceMinor,
        lineTotalMinor: it.lineTotalMinor,
      })),
      itemsCount: order.items.reduce((s, it) => s + it.quantity, 0),
      totalMinor: order.totalMinor,
      subtotalMinor: order.subtotalMinor,
      shippingMinor: order.shippingMinor,
      discountMinor: order.discountMinor,
      paymentStatus: order.paymentStatus,
      paymentProvider: String((order.paymentMethod as any)?.provider || "").toUpperCase() || null,
      orderStatus: order.status,
      date: order.createdAt,
      latestNote: order.statusHistory[0]?.note || null,
    };
  });

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
    stats: {
      totalOrders,
      processingCount,
      readyToShipCount,
      shippedCount,
      deliveredCount,
      totalRevenueMinor: (paidRevenue._sum.amountMinor || 0) - (refundedTotal._sum.amountMinor || 0),
      refundedMinor: refundedTotal._sum.amountMinor || 0,
    },
  };
}

/**
 * Admin: Update fulfillment status milestone with audit log
 */
// Fulfilment only moves forward one milestone at a time. An order can be cancelled until it ships;
// Delivered and Cancelled are final.
const ALLOWED_STATUS_TRANSITIONS: Record<string, string[]> = {
  Pending: ["Processing", "Cancelled"],
  Processing: ["Ready to Ship", "Cancelled"],
  "Ready to Ship": ["Shipped", "Cancelled"],
  Shipped: ["Delivered"],
  Delivered: [],
  Cancelled: [],
};

function conflict(message: string) {
  const error: any = new Error(message);
  error.statusCode = 409;
  return error;
}

export async function updateOrderStatus(
  orderId: string,
  newStatus: string,
  note: string | null,
  actorUserId: string,
  requestId?: string
) {
  const cleanId = orderId.replace(/^#/, "").trim();
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: cleanId }, { orderNumber: cleanId }] },
  });

  if (!order) {
    throw new Error("Order not found");
  }

  const oldStatus = order.status;

  if (newStatus === oldStatus) {
    throw conflict(`The order is already ${oldStatus}`);
  }
  if (!(ALLOWED_STATUS_TRANSITIONS[oldStatus] || []).includes(newStatus)) {
    throw conflict(`An order cannot move from ${oldStatus} to ${newStatus}`);
  }
  // An online order is confirmed by the payment provider, never by hand.
  if (oldStatus === "Pending" && newStatus === "Processing" && String((order.paymentMethod as any)?.provider || "").toUpperCase() === "CASHFREE" && order.paymentStatus !== "Paid") {
    throw conflict("The online payment has not been received yet, so this order cannot be confirmed.");
  }
  // "Shipped" needs a courier and tracking number, which only the shipment step records.
  if (newStatus === "Shipped") {
    throw conflict("Add the courier and tracking number to mark this order as shipped");
  }

  const [updatedOrder] = await prisma.$transaction([
    prisma.order.update({
      where: { id: order.id },
      data: { status: newStatus },
      include: {
        items: true,
        shipments: true,
        statusHistory: { orderBy: { createdAt: "asc" } },
        payments: true,
      },
    }),
    prisma.orderStatusHistory.create({
      data: {
        orderId: order.id,
        oldStatus,
        newStatus,
        actorUserId,
        note: note || `Fulfillment milestone advanced from ${oldStatus} to ${newStatus}.`,
      },
    }),
    prisma.adminAuditLog.create({
      data: {
        actorUserId,
        action: "ORDER_STATUS_UPDATE",
        entityType: "Order",
        entityId: order.id,
        requestId: requestId || null,
        safeDiff: { oldStatus, newStatus, note },
      },
    }),
  ]);

  const emailForStatus: Record<string, "order-ready" | "order-delivered" | "order-cancelled"> = {
    "Ready to Ship": "order-ready",
    Delivered: "order-delivered",
    Cancelled: "order-cancelled",
  };
  if (newStatus === "Cancelled") background(closeOnlinePayments(order.id));
  if (emailForStatus[newStatus]) queueOrderEmail(order.id, emailForStatus[newStatus]);
  const eventForStatus: Record<string, OrderEvent> = { "Ready to Ship": "ready", Delivered: "delivered", Cancelled: "cancelled" };
  if (eventForStatus[newStatus]) notifyOrderEvent(order.id, eventForStatus[newStatus]);

  const stepper = buildOrderStepper(updatedOrder.status, updatedOrder.statusHistory);
  return {
    ...updatedOrder,
    stepper,
  };
}

/**
 * Admin: Record shipment tracking and advance order to Shipped
 */
export async function createOrderShipment(
  orderId: string,
  data: {
    carrier: string;
    trackingNumber: string;
    trackingUrl?: string | null;
    estimatedDelivery?: string | null;
  },
  actorUserId: string,
  requestId?: string
) {
  const cleanId = orderId.replace(/^#/, "").trim();
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: cleanId }, { orderNumber: cleanId }] },
  });

  if (!order) {
    throw new Error("Order not found");
  }

  if (order.status !== "Ready to Ship") {
    throw conflict(`Shipment details can only be added when the order is Ready to Ship (it is ${order.status})`);
  }
  if (data.trackingUrl && !/^https?:\/\//i.test(data.trackingUrl)) {
    const error: any = new Error("Tracking link must start with http:// or https://");
    error.statusCode = 400;
    throw error;
  }

  const defaultUrl = data.trackingUrl || (data.carrier.toLowerCase().includes("bluedart")
    ? `https://www.bluedart.com/tracking?track=${data.trackingNumber}`
    : data.carrier.toLowerCase().includes("delhivery")
    ? `https://www.delhivery.com/track/package/${data.trackingNumber}`
    : `https://www.tracking.com/${data.trackingNumber}`);

  const [shipment, updatedOrder] = await prisma.$transaction(async (tx) => {
    const s = await tx.shipment.create({
      data: {
        orderId: order.id,
        carrier: data.carrier,
        trackingNumber: data.trackingNumber,
        trackingUrl: defaultUrl,
        status: "In Transit",
        shippedAt: new Date(),
        estimatedDelivery: data.estimatedDelivery
          ? new Date(data.estimatedDelivery)
          : new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 business days
      },
    });

    const o = await tx.order.update({
      where: { id: order.id },
      data: { status: "Shipped" },
      include: {
        items: true,
        shipments: true,
        statusHistory: { orderBy: { createdAt: "asc" } },
        payments: true,
      },
    });

    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        oldStatus: order.status,
        newStatus: "Shipped",
        actorUserId,
        note: `Consignment handed to ${data.carrier}. Tracking: ${data.trackingNumber}`,
      },
    });

    await tx.adminAuditLog.create({
      data: {
        actorUserId,
        action: "SHIPMENT_CREATED",
        entityType: "Shipment",
        entityId: s.id,
        requestId: requestId || null,
        safeDiff: { carrier: data.carrier, trackingNumber: data.trackingNumber, orderId: order.id },
      },
    });

    return [s, o];
  });

  queueOrderEmail(order.id, "order-shipped");
  notifyOrderEvent(order.id, "shipped");

  const stepper = buildOrderStepper(updatedOrder.status, updatedOrder.statusHistory);
  return {
    shipment,
    order: {
      ...updatedOrder,
      stepper,
    },
  };
}

/**
 * Admin: add an internal note to an order. Notes are never shown to the customer.
 */
export async function addOrderNote(orderId: string, text: string, authorUserId: string) {
  const cleanId = orderId.replace(/^#/, "").trim();
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: cleanId }, { orderNumber: cleanId }] },
    select: { id: true },
  });
  if (!order) {
    throw new Error("Order not found");
  }
  return prisma.orderNote.create({
    data: { orderId: order.id, authorUserId, text },
    include: { author: { select: { email: true, profile: { select: { displayName: true } } } } },
  });
}

// Payment status moves independently of fulfilment: staff record what was actually received.
const ALLOWED_PAYMENT_TRANSITIONS: Record<string, string[]> = {
  Pending: ["Paid", "Failed"],
  Failed: ["Pending", "Paid"],
  Paid: [],
  Refunded: [],
};
const PAYMENT_RECORD_STATUS: Record<string, string> = { Pending: "PENDING", Paid: "SUCCESS", Failed: "FAILED" };

export async function updateOrderPaymentStatus(
  orderId: string,
  newStatus: string,
  note: string | null,
  actorUserId: string,
  requestId?: string
) {
  const cleanId = orderId.replace(/^#/, "").trim();
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: cleanId }, { orderNumber: cleanId }] },
    include: { payments: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!order) {
    throw new Error("Order not found");
  }
  if (String((order.paymentMethod as any)?.provider || "").toUpperCase() === "CASHFREE") {
    throw conflict("Online payments are confirmed by the payment provider. Use \"Check payment status\" instead of changing it by hand.");
  }
  if (order.status === "Cancelled" && newStatus === "Paid") {
    throw conflict("A cancelled order cannot be marked as paid");
  }
  if (newStatus === order.paymentStatus) {
    throw conflict(`Payment is already ${order.paymentStatus}`);
  }
  if (!(ALLOWED_PAYMENT_TRANSITIONS[order.paymentStatus] || []).includes(newStatus)) {
    throw conflict(`Payment cannot move from ${order.paymentStatus} to ${newStatus}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: newStatus } });
    if (order.payments[0]) {
      await tx.payment.update({ where: { id: order.payments[0].id }, data: { status: PAYMENT_RECORD_STATUS[newStatus] } });
    }
    await tx.adminAuditLog.create({
      data: {
        actorUserId,
        action: "ORDER_PAYMENT_STATUS_UPDATE",
        entityType: "Order",
        entityId: order.id,
        requestId: requestId || null,
        safeDiff: { oldStatus: order.paymentStatus, newStatus, note },
      },
    });
  });

  if (newStatus === "Paid") {
    queueOrderEmail(order.id, "payment-received");
    notifyOrderEvent(order.id, "payment-received");
  }

  return getOrderDetail(order.id, null, true);
}
