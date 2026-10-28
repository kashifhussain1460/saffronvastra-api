import { prisma } from "../../database/prisma.js";
import { siteUrl } from "./email.layout.js";
import {
  OrderEmailData,
  TemplateName,
  adminNewOrderEmail,
  orderCancelledEmail,
  orderConfirmationEmail,
  orderDeliveredEmail,
  orderReadyEmail,
  orderShippedEmail,
  paymentReceivedEmail,
} from "./email.templates.js";
import { adminRecipients, queueEmail } from "./email.service.js";
import { paymentFailedEmail } from "./email.templates.extra.js";
import { background } from "../../common/background.js";

const PAYMENT_LABELS: Record<string, string> = { COD: "Cash on Delivery", CASHFREE: "Online payment" };

async function loadOrder(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      shipments: { orderBy: { createdAt: "desc" }, take: 1 },
      user: { select: { email: true, profile: { select: { displayName: true } } } },
    },
  });
}

type LoadedOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

// The facts an order email needs, taken from the stored order.
function orderEmailData(order: LoadedOrder): { data: OrderEmailData; recipient: string | null } {
  const address = (order.shippingAddress || {}) as any;
  const provider = String((order.paymentMethod as any)?.provider || "").toUpperCase();
  const shipment = order.shipments[0];
  return {
    recipient: address.email || order.user?.email || null,
    data: {
      orderNumber: order.orderNumber,
      customerName: address.fullName || order.user?.profile?.displayName || "there",
      items: order.items.map((it) => ({
        title: it.productTitle,
        detail: [it.size && `Size ${it.size}`, it.colour].filter(Boolean).join(" · "),
        quantity: it.quantity,
        totalMinor: it.lineTotalMinor,
      })),
      subtotalMinor: order.subtotalMinor,
      shippingMinor: order.shippingMinor,
      discountMinor: order.discountMinor,
      taxMinor: order.taxMinor,
      totalMinor: order.totalMinor,
      shippingAddress: address,
      paymentMethodLabel: PAYMENT_LABELS[provider] || provider || "Not recorded",
      paymentProvider: provider,
      paymentStatus: order.paymentStatus,
      // Only a signed-in customer can open the order page.
      orderUrl: order.userId ? siteUrl(`/account/orders/${order.orderNumber}`) : null,
      createdAt: order.createdAt,
      carrier: shipment?.carrier,
      trackingNumber: shipment?.trackingNumber,
      trackingUrl: shipment?.trackingUrl,
      estimatedDelivery: shipment?.estimatedDelivery,
    },
  };
}

const CUSTOMER_TEMPLATES: Partial<Record<TemplateName, (d: OrderEmailData) => ReturnType<typeof orderConfirmationEmail>>> = {
  "order-confirmation": orderConfirmationEmail,
  "order-ready": orderReadyEmail,
  "order-shipped": orderShippedEmail,
  "order-delivered": orderDeliveredEmail,
  "order-cancelled": orderCancelledEmail,
  "payment-received": paymentReceivedEmail,
};

// Email the customer about their order. Never throws and never delays the caller.
export function queueOrderEmail(orderId: string, template: TemplateName) {
  background((async () => {
    try {
      const order = await loadOrder(orderId);
      if (!order) return;
      const { data, recipient } = orderEmailData(order);
      if (template === "payment-failed") {
        // the order page needs a signed-in customer; this page also works for guests (their browser holds the guest id)
        const retryUrl = siteUrl(`/order-confirmation?order=${encodeURIComponent(order.orderNumber)}`);
        queueEmail({ to: recipient, template, message: paymentFailedEmail({ customerName: data.customerName, orderNumber: data.orderNumber, totalMinor: data.totalMinor, retryUrl }), relatedId: order.orderNumber });
        return;
      }
      const render = CUSTOMER_TEMPLATES[template];
      if (!render) return;
      queueEmail({ to: recipient, template, message: render(data), relatedId: order.orderNumber });
    } catch (error: any) {
      console.error(`[email] ${template} for order ${orderId} failed:`, error?.message);
    }
  })());
}

// Tell the shop about a new order.
export function queueAdminNewOrderEmail(orderId: string) {
  background((async () => {
    try {
      const order = await loadOrder(orderId);
      if (!order) return;
      const { data, recipient } = orderEmailData(order);
      const message = adminNewOrderEmail({ ...data, customerEmail: recipient, adminUrl: siteUrl(`/admin/orders/${order.orderNumber}`) });
      for (const to of await adminRecipients()) {
        queueEmail({ to, template: "admin-new-order", message, relatedId: order.orderNumber });
      }
    } catch (error: any) {
      console.error(`[email] admin alert for order ${orderId} failed:`, error?.message);
    }
  })());
}
