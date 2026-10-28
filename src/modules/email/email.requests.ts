import { prisma } from "../../database/prisma.js";
import { siteUrl } from "./email.layout.js";
import { adminRecipients, queueEmail } from "./email.service.js";
import {
  refundUpdateEmail,
  requestAdminAlertEmail,
  requestCompletedEmail,
  requestDecisionEmail,
  requestReceivedEmail,
  type RequestEmailData,
} from "./email.templates.extra.js";
import { background } from "../../common/background.js";

// Emails for refunds and for cancellation / return / exchange requests. Never throw, never delay the caller.

function contactOf(order: { shippingAddress: unknown; user: { email: string; profile: { displayName: string | null } | null } | null }) {
  const address = (order.shippingAddress || {}) as any;
  return {
    recipient: (address.email as string | undefined) || order.user?.email || null,
    name: (address.fullName as string | undefined) || order.user?.profile?.displayName || "there",
  };
}

const orderPage = (order: { orderNumber: string; userId: string | null }) =>
  order.userId ? siteUrl(`/account/orders/${order.orderNumber}`) : siteUrl(`/order-confirmation?order=${encodeURIComponent(order.orderNumber)}`);

export function queueRefundEmail(refundId: string) {
  background((async () => {
    try {
      const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        include: { payment: { include: { order: { include: { user: { select: { email: true, profile: { select: { displayName: true } } } } } } } } },
      });
      if (!refund || (refund.status !== "COMPLETED" && refund.status !== "FAILED")) return;
      const order = refund.payment.order;
      const { recipient, name } = contactOf(order);
      queueEmail({
        to: recipient,
        template: "refund-update",
        message: refundUpdateEmail({
          customerName: name,
          orderNumber: order.orderNumber,
          amountMinor: refund.amountMinor,
          status: refund.status,
          method: refund.method as "GATEWAY" | "MANUAL",
          reference: refund.manualReference,
          orderUrl: order.userId ? siteUrl(`/account/orders/${order.orderNumber}`) : null,
        }),
        relatedId: order.orderNumber,
      });
    } catch (error: any) {
      console.error(`[email] refund ${refundId} failed:`, error?.message);
    }
  })());
}

async function requestData(requestId: string) {
  const request = await prisma.orderRequest.findUnique({
    where: { id: requestId },
    include: {
      items: { include: { orderItem: true } },
      order: { include: { user: { select: { email: true, profile: { select: { displayName: true } } } } } },
      refunds: true,
    },
  });
  if (!request) return null;
  const { recipient, name } = contactOf(request.order);
  const data: RequestEmailData = {
    customerName: name,
    requestNumber: request.requestNumber,
    type: request.type,
    orderNumber: request.order.orderNumber,
    reasonCode: request.reasonCode,
    resolution: request.resolution,
    items: request.items.map((i) => ({
      title: i.orderItem.productTitle,
      detail: [i.orderItem.size && `Size ${i.orderItem.size}`, i.orderItem.colour].filter(Boolean).join(" · "),
      quantity: i.quantity,
    })),
    outsideWindow: request.outsideWindow,
    decisionNote: request.decisionNote,
    returnShippingPayer: request.returnShippingPayer,
    statusUrl: orderPage(request.order),
  };
  const refundMinor = request.refunds.filter((r) => r.status === "COMPLETED").reduce((s, r) => s + r.amountMinor, 0);
  return { request, recipient, data, refundMinor, customerEmail: recipient };
}

export type RequestEmailKind = "received" | "approved" | "rejected" | "completed";

export function queueRequestEmail(requestId: string, kind: RequestEmailKind) {
  background((async () => {
    try {
      const loaded = await requestData(requestId);
      if (!loaded) return;
      const { request, recipient, data, refundMinor, customerEmail } = loaded;
      if (kind === "received") {
        queueEmail({ to: recipient, template: "request-received", message: requestReceivedEmail(data), relatedId: request.requestNumber });
        const alert = requestAdminAlertEmail({ ...data, adminUrl: siteUrl("/admin/returns"), customerEmail });
        for (const to of await adminRecipients()) queueEmail({ to, template: "request-admin-alert", message: alert, relatedId: request.requestNumber });
      } else if (kind === "approved" || kind === "rejected") {
        queueEmail({ to: recipient, template: kind === "approved" ? "request-approved" : "request-rejected", message: requestDecisionEmail({ ...data, approved: kind === "approved" }), relatedId: request.requestNumber });
      } else {
        queueEmail({ to: recipient, template: "request-completed", message: requestCompletedEmail({ ...data, refundMinor }), relatedId: request.requestNumber });
      }
    } catch (error: any) {
      console.error(`[email] request ${requestId} (${kind}) failed:`, error?.message);
    }
  })());
}
