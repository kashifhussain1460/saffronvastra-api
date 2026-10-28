import { BRAND, button, escapeHtml, heading, keyValueRows, layout, note, paragraph, rupees, textLayout } from "./email.layout.js";
import type { RenderedEmail } from "./email.templates.js";

// Payment, refund and request (cancellation / return / exchange) emails. Wording follows the published Terms & Conditions
// and FAQ; nothing here promises more than they do.

const first = (name: string) => (name || "there").trim().split(/\s+/)[0] || "there";

export const REQUEST_TYPE_LABEL: Record<string, string> = { CANCELLATION: "cancellation", RETURN: "return", EXCHANGE: "exchange" };
export const REASON_LABEL: Record<string, string> = {
  CHANGE_OF_MIND: "Change of mind",
  SIZE_ISSUE: "Size issue",
  DEFECTIVE: "Defective product",
  DAMAGED: "Damaged product",
  INCORRECT: "Incorrect product received",
  NOT_AS_DESCRIBED: "Not as described",
  OTHER: "Other",
};

// ---- payments ----

export function paymentFailedEmail(d: { customerName: string; orderNumber: string; totalMinor: number; retryUrl: string }): RenderedEmail {
  const name = first(d.customerName);
  return {
    subject: `We could not confirm the payment for order ${d.orderNumber}`,
    html: layout({
      preheader: `Order ${d.orderNumber} is saved. You can try the payment again.`,
      body:
        heading("Your payment did not go through") +
        paragraph(`Hello ${escapeHtml(name)}, we could not confirm the payment of <strong>${rupees(d.totalMinor)}</strong> for order <strong>${escapeHtml(d.orderNumber)}</strong>. Your order is saved, and you can try again with any payment option shown at checkout.`) +
        button("Try payment again", d.retryUrl) +
        note("If the money was deducted from your account, please wait for the payment provider's status update. If it is still not confirmed, write to us with the payment reference and your order number.") +
        paragraph(`Please never share your banking password, UPI PIN or card security code with anyone, including us.`),
    }),
    text: textLayout([
      `Hello ${name},`,
      `We could not confirm the payment of ${rupees(d.totalMinor)} for order ${d.orderNumber}. Your order is saved; you can try again here: ${d.retryUrl}`,
      "If money was deducted, wait for the payment provider's status update, then write to us with the payment reference and order number.",
    ]),
  };
}

export interface RefundEmailData {
  customerName: string;
  orderNumber: string;
  amountMinor: number;
  status: "COMPLETED" | "FAILED";
  method: "GATEWAY" | "MANUAL";
  reference?: string | null;
  orderUrl: string | null;
}

export function refundUpdateEmail(d: RefundEmailData): RenderedEmail {
  const name = first(d.customerName);
  const done = d.status === "COMPLETED";
  return {
    subject: done ? `Your refund for order ${d.orderNumber} has been issued` : `Update on your refund for order ${d.orderNumber}`,
    html: layout({
      preheader: done ? `${rupees(d.amountMinor)} has been refunded.` : `We need to look at your refund again.`,
      body:
        heading(done ? "Your refund has been issued" : "Your refund needs another look") +
        paragraph(
          done
            ? `Hello ${escapeHtml(name)}, we have issued a refund of <strong>${rupees(d.amountMinor)}</strong> for order <strong>${escapeHtml(d.orderNumber)}</strong>.`
            : `Hello ${escapeHtml(name)}, the refund of <strong>${rupees(d.amountMinor)}</strong> for order <strong>${escapeHtml(d.orderNumber)}</strong> could not be completed. Our team will contact you about the next step.`
        ) +
        keyValueRows(
          [
            ["Amount", rupees(d.amountMinor)],
            ["Order", escapeHtml(d.orderNumber)],
            ...(done && d.method === "MANUAL" && d.reference ? ([["Transfer reference", escapeHtml(d.reference)]] as Array<[string, string]>) : []),
          ]
        ) +
        (done
          ? note(
              d.method === "GATEWAY"
                ? "The refund goes back to the original payment method. The time it takes to appear in your account depends on your bank or payment provider."
                : "The amount was transferred to you directly. The time it takes to appear depends on your bank."
            )
          : "") +
        (d.orderUrl ? button("View your order", d.orderUrl) : ""),
    }),
    text: textLayout([
      `Hello ${name},`,
      done ? `We have issued a refund of ${rupees(d.amountMinor)} for order ${d.orderNumber}.` : `The refund of ${rupees(d.amountMinor)} for order ${d.orderNumber} could not be completed. Our team will contact you.`,
      ...(done && d.method === "MANUAL" && d.reference ? [`Transfer reference: ${d.reference}`] : []),
      ...(d.orderUrl ? [`View your order: ${d.orderUrl}`] : []),
    ]),
  };
}

// ---- requests ----

export interface RequestEmailData {
  customerName: string;
  requestNumber: string;
  type: string;
  orderNumber: string;
  reasonCode: string;
  resolution: string;
  items: Array<{ title: string; detail: string; quantity: number }>;
  outsideWindow?: boolean;
  decisionNote?: string | null;
  returnShippingPayer?: string | null;
  statusUrl: string;
}

const kind = (d: { type: string }) => REQUEST_TYPE_LABEL[d.type] || "request";
const itemsList = (items: RequestEmailData["items"]) =>
  items.length
    ? `<ul style="margin:0 0 16px;padding-left:18px;font-family:${BRAND.font};font-size:14px;line-height:1.7;color:${BRAND.ink};">${items
        .map((i) => `<li>${escapeHtml(i.title)}${i.detail ? ` (${escapeHtml(i.detail)})` : ""} &times; ${i.quantity}</li>`)
        .join("")}</ul>`
    : "";

export function requestReceivedEmail(d: RequestEmailData): RenderedEmail {
  const name = first(d.customerName);
  return {
    subject: `We received your ${kind(d)} request ${d.requestNumber}`,
    html: layout({
      preheader: `Request ${d.requestNumber} for order ${d.orderNumber} is with our team.`,
      body:
        heading(`We received your ${kind(d)} request`) +
        paragraph(`Hello ${escapeHtml(name)}, your ${kind(d)} request <strong>${escapeHtml(d.requestNumber)}</strong> for order <strong>${escapeHtml(d.orderNumber)}</strong> is with our team. Please do not send anything back yet: we will tell you what to do once the request has been reviewed.`) +
        keyValueRows([
          ["Request", escapeHtml(d.requestNumber)],
          ["Reason", escapeHtml(REASON_LABEL[d.reasonCode] || d.reasonCode)],
        ]) +
        itemsList(d.items) +
        (d.outsideWindow ? note("This request was made after the 7-day return period. It will be reviewed individually, and your rights under applicable consumer law are not affected.") : "") +
        button("View request status", d.statusUrl),
    }),
    text: textLayout([
      `Hello ${name},`,
      `We received your ${kind(d)} request ${d.requestNumber} for order ${d.orderNumber}. Please do not send anything back yet; we will tell you what to do after the review.`,
      `Status: ${d.statusUrl}`,
    ]),
  };
}

export function requestDecisionEmail(d: RequestEmailData & { approved: boolean }): RenderedEmail {
  const name = first(d.customerName);
  const payerLine =
    d.returnShippingPayer === "SELLER"
      ? "We will bear reasonable return shipping costs or arrange a collection."
      : d.returnShippingPayer === "CUSTOMER"
        ? "For a change-of-mind or size return, return shipping is ordinarily paid by the customer."
        : "";
  return {
    subject: d.approved ? `Your ${kind(d)} request ${d.requestNumber} was approved` : `Update on your ${kind(d)} request ${d.requestNumber}`,
    html: layout({
      preheader: d.approved ? `Next steps for order ${d.orderNumber}.` : `We could not approve request ${d.requestNumber}.`,
      body:
        heading(d.approved ? `Your ${kind(d)} request was approved` : `We could not approve your ${kind(d)} request`) +
        paragraph(`Hello ${escapeHtml(name)}, we have reviewed your ${kind(d)} request <strong>${escapeHtml(d.requestNumber)}</strong> for order <strong>${escapeHtml(d.orderNumber)}</strong>.`) +
        (d.decisionNote ? note(`<strong>Message from our team</strong><br/>${escapeHtml(d.decisionNote).replace(/\n/g, "<br/>")}`) : "") +
        (d.approved && payerLine ? paragraph(payerLine) : "") +
        (d.approved && d.type !== "CANCELLATION" ? paragraph("Please do not send the product back until you have the return instructions from our team. If anything is unclear, reply to this email.") : "") +
        (!d.approved ? paragraph("Your rights under applicable consumer law are not affected by this decision. If you disagree, reply to this email and we will look at it again.") : "") +
        button("View request status", d.statusUrl),
    }),
    text: textLayout([
      `Hello ${name},`,
      d.approved ? `Your ${kind(d)} request ${d.requestNumber} for order ${d.orderNumber} was approved.` : `We could not approve your ${kind(d)} request ${d.requestNumber} for order ${d.orderNumber}.`,
      ...(d.decisionNote ? [`Message from our team: ${d.decisionNote}`] : []),
      ...(d.approved && payerLine ? [payerLine] : []),
      `Status: ${d.statusUrl}`,
    ]),
  };
}

export function requestCompletedEmail(d: RequestEmailData & { refundMinor?: number | null }): RenderedEmail {
  const name = first(d.customerName);
  return {
    subject: `Your ${kind(d)} request ${d.requestNumber} is complete`,
    html: layout({
      preheader: `Request ${d.requestNumber} has been completed.`,
      body:
        heading(`Your ${kind(d)} is complete`) +
        paragraph(`Hello ${escapeHtml(name)}, your ${kind(d)} request <strong>${escapeHtml(d.requestNumber)}</strong> for order <strong>${escapeHtml(d.orderNumber)}</strong> is now complete.`) +
        (d.refundMinor ? paragraph(`A refund of <strong>${rupees(d.refundMinor)}</strong> was issued. You will get a separate email with its details.`) : "") +
        (d.decisionNote ? note(escapeHtml(d.decisionNote)) : "") +
        button("View request status", d.statusUrl),
    }),
    text: textLayout([`Hello ${name},`, `Your ${kind(d)} request ${d.requestNumber} for order ${d.orderNumber} is complete.`, `Status: ${d.statusUrl}`]),
  };
}

export function requestAdminAlertEmail(d: RequestEmailData & { adminUrl: string; customerEmail?: string | null }): RenderedEmail {
  return {
    subject: `New ${kind(d)} request ${d.requestNumber} (order ${d.orderNumber})`,
    html: layout({
      preheader: `${d.customerName} raised a ${kind(d)} request.`,
      body:
        heading(`New ${kind(d)} request`) +
        keyValueRows([
          ["Request", escapeHtml(d.requestNumber)],
          ["Order", escapeHtml(d.orderNumber)],
          ["Customer", escapeHtml(d.customerName) + (d.customerEmail ? ` (${escapeHtml(d.customerEmail)})` : "")],
          ["Reason", escapeHtml(REASON_LABEL[d.reasonCode] || d.reasonCode)],
          ["Wanted", escapeHtml(d.resolution === "EXCHANGE" ? "Exchange" : d.resolution === "REFUND" ? "Refund" : "-")],
        ]) +
        itemsList(d.items) +
        (d.outsideWindow ? note("Raised after the 7-day return period: needs an individual decision.") : "") +
        button("Review request", d.adminUrl),
    }),
    text: textLayout([`New ${kind(d)} request ${d.requestNumber} for order ${d.orderNumber} from ${d.customerName}.`, `Reason: ${REASON_LABEL[d.reasonCode] || d.reasonCode}`, `Review: ${d.adminUrl}`]),
  };
}

