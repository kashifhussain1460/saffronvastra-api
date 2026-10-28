import { prisma } from "../../database/prisma.js";
import { background } from "../../common/background.js";

// In-app notifications. Every helper here is fire-and-forget and never throws:
// a failed notification must never break the order or contact flow that triggered it.

type NotifyInput = {
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
};

export async function notifyUser(input: NotifyInput): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        metadata: (input.metadata ?? undefined) as any,
      },
    });
  } catch (error) {
    console.error("[notify] could not create notification", error);
  }
}

export async function notifyAdmins(input: Omit<NotifyInput, "userId">): Promise<void> {
  try {
    const admins = await prisma.user.findMany({
      where: { status: "ACTIVE", userRoles: { some: { role: { code: "ADMIN" } } } },
      select: { id: true },
    });
    if (!admins.length) return;
    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        type: input.type,
        title: input.title,
        body: input.body,
        metadata: (input.metadata ?? undefined) as any,
      })),
    });
  } catch (error) {
    console.error("[notify] could not create admin notifications", error);
  }
}

export type OrderEvent =
  | "placed"
  | "ready"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "payment-received"
  | "payment-failed"
  | "refund"
  | "request-received"
  | "request-approved"
  | "request-rejected"
  | "request-completed";

const ORDER_COPY: Record<OrderEvent, (n: string) => { title: string; body: string }> = {
  placed: (n) => ({ title: "Order placed", body: `Thank you. We have received order ${n} and will start preparing it.` }),
  ready: (n) => ({ title: "Order ready to ship", body: `Order ${n} is packed and ready to ship.` }),
  shipped: (n) => ({ title: "Order shipped", body: `Order ${n} is on its way to you.` }),
  delivered: (n) => ({ title: "Order delivered", body: `Order ${n} has been delivered.` }),
  cancelled: (n) => ({ title: "Order cancelled", body: `Order ${n} has been cancelled.` }),
  "payment-received": (n) => ({ title: "Payment received", body: `We have received payment for order ${n}.` }),
  "payment-failed": (n) => ({ title: "Payment not confirmed", body: `We could not confirm the payment for order ${n}. You can try again from your order.` }),
  refund: (n) => ({ title: "Refund update", body: `There is an update on the refund for order ${n}. See the order for details.` }),
  "request-received": (n) => ({ title: "Request received", body: `We received your request for order ${n}. Our team will review it.` }),
  "request-approved": (n) => ({ title: "Request approved", body: `Your request for order ${n} was approved. See the order for the next steps.` }),
  "request-rejected": (n) => ({ title: "Request update", body: `We could not approve your request for order ${n}. See the order for details.` }),
  "request-completed": (n) => ({ title: "Request complete", body: `Your request for order ${n} is complete.` }),
};

// Tells the order's customer about an order event (signed-in customers only).
export function notifyOrderEvent(orderId: string, event: OrderEvent): void {
  background((async () => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { orderNumber: true, userId: true },
      });
      if (!order?.userId) return;
      const copy = ORDER_COPY[event](order.orderNumber);
      await notifyUser({
        userId: order.userId,
        type: "ORDER_UPDATE",
        ...copy,
        metadata: { orderNumber: order.orderNumber, event },
      });
    } catch (error) {
      console.error("[notify] order event failed", error);
    }
  })());
}

// Tells every admin that a new order arrived.
export function notifyAdminsNewOrder(orderId: string): void {
  background((async () => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { orderNumber: true, totalMinor: true, currency: true },
      });
      if (!order) return;
      await notifyAdmins({
        type: "NEW_ORDER",
        title: "New order",
        body: `Order ${order.orderNumber} was just placed.`,
        metadata: { orderNumber: order.orderNumber, totalMinor: order.totalMinor, currency: order.currency },
      });
    } catch (error) {
      console.error("[notify] new order alert failed", error);
    }
  })());
}

// Tells every admin that a contact message arrived.
export function notifyAdminsContactMessage(message: { id: string; name: string; subject?: string | null }): void {
  background(notifyAdmins({
    type: "CONTACT_MESSAGE",
    title: "New contact message",
    body: `${message.name} wrote${message.subject ? `: ${message.subject}` : " to the concierge."}`,
    metadata: { messageId: message.id },
  }));
}
