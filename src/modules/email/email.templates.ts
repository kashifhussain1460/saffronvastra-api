import { BRAND_IDENTITY } from "../../config/brand.js";
import {
  paymentFailedEmail,
  refundUpdateEmail,
  requestAdminAlertEmail,
  requestCompletedEmail,
  requestDecisionEmail,
  requestReceivedEmail,
} from "./email.templates.extra.js";
import {
  BRAND,
  EmailLine,
  addressBlock,
  button,
  escapeHtml,
  formatDate,
  heading,
  itemsTable,
  keyValueRows,
  layout,
  note,
  paragraph,
  rupees,
  siteUrl,
  subheading,
  textLayout,
  totalsTable,
} from "./email.layout.js";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  // Stored in the email log instead of html/text when the real body holds a credential (a reset link).
  storedHtml?: string;
  storedText?: string;
  sensitive?: boolean;
  headers?: Record<string, string>;
}

export type TemplateName =
  | "welcome"
  | "password-reset"
  | "email-verification"
  | "password-changed"
  | "order-confirmation"
  | "order-ready"
  | "order-shipped"
  | "order-delivered"
  | "order-cancelled"
  | "payment-received"
  | "payment-failed"
  | "refund-update"
  | "request-received"
  | "request-approved"
  | "request-rejected"
  | "request-completed"
  | "request-admin-alert"
  | "admin-new-order"
  | "contact-received"
  | "contact-admin"
  | "contact-reply"
  | "newsletter-welcome"
  | "newsletter-campaign"
  | "test-email";

export const TEMPLATE_NAMES: TemplateName[] = [
  "welcome",
  "password-reset",
  "email-verification",
  "password-changed",
  "order-confirmation",
  "order-ready",
  "order-shipped",
  "order-delivered",
  "order-cancelled",
  "payment-received",
  "payment-failed",
  "refund-update",
  "request-received",
  "request-approved",
  "request-rejected",
  "request-completed",
  "request-admin-alert",
  "admin-new-order",
  "contact-received",
  "contact-admin",
  "contact-reply",
  "newsletter-welcome",
  "newsletter-campaign",
  "test-email",
];

const firstName = (name?: string | null) => (name || "").trim().split(/\s+/)[0] || "there";

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

export function welcomeEmail(d: { name: string }): RenderedEmail {
  const name = firstName(d.name);
  const shopUrl = siteUrl("/collections");
  return {
    subject: `Welcome to ${BRAND_IDENTITY.name}`,
    html: layout({
      preheader: "Your account is ready. Discover handcrafted pieces made to order in Jaipur.",
      body:
        heading(`Welcome, ${escapeHtml(name)}`) +
        paragraph(`Your ${BRAND_IDENTITY.name} account is ready. Every piece in our collection is embroidered by hand and made to order by artisans in Jaipur, so each one is made just for you.`) +
        paragraph("With your account you can follow your orders, save pieces to your wishlist and check out faster.") +
        button("Explore the collection", shopUrl),
    }),
    text: textLayout([
      `Welcome, ${name}.`,
      `Your ${BRAND_IDENTITY.name} account is ready. Every piece is embroidered by hand and made to order by artisans in Jaipur.`,
      `Explore the collection: ${shopUrl}`,
    ]),
  };
}

export function passwordResetEmail(d: { name?: string | null; resetUrl: string; expiresInMinutes: number }): RenderedEmail {
  const body = (url: string) =>
    heading("Reset your password") +
    paragraph(`Hello ${escapeHtml(firstName(d.name))}, we received a request to choose a new password for your ${BRAND_IDENTITY.name} account.`) +
    button("Choose a new password", url) +
    note(`This link works for ${d.expiresInMinutes} minutes and can be used once. If you did not ask for it, you can ignore this email and your password will stay as it is.`) +
    paragraph(`<span style="font-size:12px;color:${BRAND.muted};">If the button does not work, copy this address into your browser:<br/>${escapeHtml(url)}</span>`);
  const text = (url: string) =>
    textLayout([
      `Hello ${firstName(d.name)},`,
      `We received a request to choose a new password for your ${BRAND_IDENTITY.name} account.`,
      `Choose a new password: ${url}`,
      `The link works for ${d.expiresInMinutes} minutes and can be used once. If you did not ask for it, ignore this email.`,
    ]);
  const hidden = "[reset link hidden in the log]";
  return {
    subject: `Reset your ${BRAND_IDENTITY.name} password`,
    html: layout({ preheader: `Choose a new password for your ${BRAND_IDENTITY.name} account.`, body: body(d.resetUrl) }),
    text: text(d.resetUrl),
    // the log keeps the message but not the link, which works as a password
    storedHtml: layout({ preheader: `Choose a new password for your ${BRAND_IDENTITY.name} account.`, body: body(hidden) }),
    storedText: text(hidden),
    sensitive: true,
  };
}

export function emailVerificationEmail(d: { name?: string | null; verifyUrl: string; expiresInHours: number }): RenderedEmail {
  const body = (url: string) =>
    heading("Confirm your email address") +
    paragraph(`Hello ${escapeHtml(firstName(d.name))}, welcome to ${BRAND_IDENTITY.name}. Please confirm that this is your email address so we can keep your account secure and reach you about your orders.`) +
    button("Confirm my email", url) +
    note(`This link works for ${d.expiresInHours} hours and can be used once. If you did not create an account, you can ignore this email.`) +
    paragraph(`<span style="font-size:12px;color:${BRAND.muted};">If the button does not work, copy this address into your browser:<br/>${escapeHtml(url)}</span>`);
  const text = (url: string) =>
    textLayout([
      `Hello ${firstName(d.name)},`,
      `Please confirm the email address for your ${BRAND_IDENTITY.name} account.`,
      `Confirm my email: ${url}`,
      `The link works for ${d.expiresInHours} hours and can be used once. If you did not create an account, ignore this email.`,
    ]);
  const hidden = "[verification link hidden in the log]";
  const preheader = `Confirm your email address to finish setting up your ${BRAND_IDENTITY.name} account.`;
  return {
    subject: `Confirm your email for ${BRAND_IDENTITY.name}`,
    html: layout({ preheader, body: body(d.verifyUrl) }),
    text: text(d.verifyUrl),
    // the log keeps the message but not the link, which proves ownership of the address
    storedHtml: layout({ preheader, body: body(hidden) }),
    storedText: text(hidden),
    sensitive: true,
  };
}

export function passwordChangedEmail(d: { name?: string | null }): RenderedEmail {
  const contact = siteUrl("/contact");
  return {
    subject: `Your ${BRAND_IDENTITY.name} password was changed`,
    html: layout({
      preheader: "Your password was changed. If this was not you, tell us right away.",
      body:
        heading("Your password was changed") +
        paragraph(`Hello ${escapeHtml(firstName(d.name))}, this is a confirmation that the password for your ${BRAND_IDENTITY.name} account was just changed. For your safety you have been signed out everywhere.`) +
        note("If you did not do this, please <a href=\"" + escapeHtml(contact) + "\" style=\"color:" + BRAND.link + ";\">contact us</a> straight away.") +
        button("Sign in", siteUrl("/auth/login")),
    }),
    text: textLayout([
      `Hello ${firstName(d.name)},`,
      `The password for your ${BRAND_IDENTITY.name} account was just changed. You have been signed out everywhere.`,
      `If this was not you, contact us right away: ${contact}`,
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

export interface OrderEmailData {
  orderNumber: string;
  customerName: string;
  items: EmailLine[];
  subtotalMinor: number;
  shippingMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  shippingAddress: any;
  paymentMethodLabel: string;
  paymentProvider?: string; // COD or CASHFREE
  paymentStatus: string;
  orderUrl: string | null; // only registered customers can open the order page
  createdAt: Date | string;
  // shipment
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  estimatedDelivery?: Date | string | null;
}

function totalsFor(d: OrderEmailData) {
  const rows: Array<[string, string, boolean?]> = [["Items", rupees(d.subtotalMinor)]];
  if (d.discountMinor > 0) rows.push(["Discount", `-${rupees(d.discountMinor)}`]);
  rows.push(["Shipping", d.shippingMinor > 0 ? rupees(d.shippingMinor) : "Free"]);
  if (d.taxMinor > 0) rows.push(["Tax", rupees(d.taxMinor)]);
  rows.push([d.paymentStatus === "Paid" ? "Total paid" : d.paymentProvider === "CASHFREE" ? "Total to pay" : "Total to pay on delivery", rupees(d.totalMinor), true]);
  return totalsTable(rows);
}

const orderLink = (d: OrderEmailData, label = "View your order") => (d.orderUrl ? button(label, d.orderUrl) : "");
const orderTextLink = (d: OrderEmailData) => (d.orderUrl ? [`View your order: ${d.orderUrl}`] : []);

export function orderConfirmationEmail(d: OrderEmailData): RenderedEmail {
  const name = firstName(d.customerName);
  return {
    subject: `Your ${BRAND_IDENTITY.name} order ${d.orderNumber} is confirmed`,
    html: layout({
      preheader: `Thank you, ${name}. Order ${d.orderNumber} is with our artisans.`,
      body:
        heading(`Thank you, ${escapeHtml(name)}`) +
        paragraph(`We have received your order and sent it to our workshop in Jaipur. Each piece is made to order, so we will write to you again when it is ready and when it ships.`) +
        keyValueRows([
          ["Order number", `<strong>${escapeHtml(d.orderNumber)}</strong>`],
          ["Placed on", escapeHtml(formatDate(d.createdAt))],
          ["Payment", escapeHtml(d.paymentMethodLabel)],
        ]) +
        subheading("Your pieces") +
        itemsTable(d.items) +
        totalsFor(d) +
        subheading("Delivering to") +
        paragraph(addressBlock(d.shippingAddress)) +
        note(d.paymentProvider === "CASHFREE" ? "Your online payment has been received. Thank you." : "You pay in cash when your order is delivered. There is nothing to pay online.") +
        orderLink(d),
    }),
    text: textLayout([
      `Thank you, ${name}.`,
      `We have received your order ${d.orderNumber} (${formatDate(d.createdAt)}) and sent it to our workshop in Jaipur.`,
      "",
      ...d.items.map((l) => `- ${l.title} (${l.detail}) x${l.quantity}: ${rupees(l.totalMinor)}`),
      d.paymentProvider === "CASHFREE" ? `Total paid: ${rupees(d.totalMinor)}` : `Total to pay on delivery: ${rupees(d.totalMinor)}`,
      "",
      d.paymentProvider === "CASHFREE" ? "Your online payment has been received." : "You pay in cash when your order is delivered.",
      ...orderTextLink(d),
    ]),
  };
}

export function orderReadyEmail(d: OrderEmailData): RenderedEmail {
  const name = firstName(d.customerName);
  return {
    subject: `Your order ${d.orderNumber} is ready to ship`,
    html: layout({
      preheader: `Order ${d.orderNumber} has passed our final inspection.`,
      body:
        heading("Your piece is ready") +
        paragraph(`Hello ${escapeHtml(name)}, order <strong>${escapeHtml(d.orderNumber)}</strong> has passed our final inspection and is being packed. We will send you the tracking details as soon as it ships.`) +
        itemsTable(d.items) +
        orderLink(d),
    }),
    text: textLayout([
      `Hello ${name},`,
      `Order ${d.orderNumber} has passed our final inspection and is being packed. We will send the tracking details when it ships.`,
      ...orderTextLink(d),
    ]),
  };
}

export function orderShippedEmail(d: OrderEmailData): RenderedEmail {
  const name = firstName(d.customerName);
  const eta = d.estimatedDelivery ? formatDate(d.estimatedDelivery) : "";
  const trackingLink = d.trackingUrl && /^https?:\/\//i.test(d.trackingUrl) ? d.trackingUrl : null;
  return {
    subject: `Your order ${d.orderNumber} is on its way`,
    html: layout({
      preheader: `Order ${d.orderNumber} has been handed to ${d.carrier || "the courier"}.`,
      body:
        heading("Your order is on its way") +
        paragraph(`Hello ${escapeHtml(name)}, order <strong>${escapeHtml(d.orderNumber)}</strong> has been shipped from our workshop.`) +
        keyValueRows([
          ["Courier", escapeHtml(d.carrier || "")],
          ["Tracking number", `<strong>${escapeHtml(d.trackingNumber || "")}</strong>`],
          ...(eta ? ([["Expected delivery", escapeHtml(eta)]] as Array<[string, string]>) : []),
        ]) +
        (trackingLink ? button("Track your parcel", trackingLink) : "") +
        subheading("Delivering to") +
        paragraph(addressBlock(d.shippingAddress)) +
        (d.paymentStatus === "Paid" ? "" : note(`Please keep ${escapeHtml(rupees(d.totalMinor))} ready to pay in cash on delivery.`)) +
        orderLink(d, "View your order"),
    }),
    text: textLayout([
      `Hello ${name},`,
      `Order ${d.orderNumber} has been shipped from our workshop.`,
      `Courier: ${d.carrier || ""}`,
      `Tracking number: ${d.trackingNumber || ""}`,
      ...(eta ? [`Expected delivery: ${eta}`] : []),
      ...(trackingLink ? [`Track your parcel: ${trackingLink}`] : []),
      ...(d.paymentStatus === "Paid" ? [] : [`Please keep ${rupees(d.totalMinor)} ready to pay in cash on delivery.`]),
      ...orderTextLink(d),
    ]),
  };
}

export function orderDeliveredEmail(d: OrderEmailData): RenderedEmail {
  const name = firstName(d.customerName);
  return {
    subject: `Your order ${d.orderNumber} has been delivered`,
    html: layout({
      preheader: "We hope you love it. Tell us what you think.",
      body:
        heading("Delivered") +
        paragraph(`Hello ${escapeHtml(name)}, order <strong>${escapeHtml(d.orderNumber)}</strong> has been delivered. We hope your new piece brings you joy.`) +
        itemsTable(d.items) +
        paragraph("Our artisans would love to hear how it fits and feels. You can review your pieces from your account.") +
        (d.orderUrl ? button("Review your order", d.orderUrl) : ""),
    }),
    text: textLayout([
      `Hello ${name},`,
      `Order ${d.orderNumber} has been delivered. We hope your new piece brings you joy.`,
      "You can review your pieces from your account.",
      ...orderTextLink(d),
    ]),
  };
}

export function orderCancelledEmail(d: OrderEmailData): RenderedEmail {
  const name = firstName(d.customerName);
  return {
    subject: `Your order ${d.orderNumber} was cancelled`,
    html: layout({
      preheader: `Order ${d.orderNumber} has been cancelled.`,
      body:
        heading("Your order was cancelled") +
        paragraph(`Hello ${escapeHtml(name)}, order <strong>${escapeHtml(d.orderNumber)}</strong> has been cancelled.`) +
        itemsTable(d.items) +
        (d.paymentStatus === "Paid"
          ? note("A payment was recorded for this order. Our team will contact you about it.")
          : note("No payment was collected, so there is nothing to refund.")) +
        paragraph(`If you have questions, reply to this email or visit our <a href="${escapeHtml(siteUrl("/contact"))}" style="color:${BRAND.link};">contact page</a>.`),
    }),
    text: textLayout([
      `Hello ${name},`,
      `Order ${d.orderNumber} has been cancelled.`,
      d.paymentStatus === "Paid" ? "A payment was recorded for this order. Our team will contact you about it." : "No payment was collected, so there is nothing to refund.",
    ]),
  };
}

export function paymentReceivedEmail(d: OrderEmailData): RenderedEmail {
  const name = firstName(d.customerName);
  return {
    subject: `Payment received for order ${d.orderNumber}`,
    html: layout({
      preheader: `We received ${rupees(d.totalMinor)} for order ${d.orderNumber}.`,
      body:
        heading("Payment received") +
        paragraph(`Hello ${escapeHtml(name)}, thank you. We have recorded your payment for order <strong>${escapeHtml(d.orderNumber)}</strong>.`) +
        keyValueRows([
          ["Order number", escapeHtml(d.orderNumber)],
          ["Amount", `<strong>${escapeHtml(rupees(d.totalMinor))}</strong>`],
          ["Method", escapeHtml(d.paymentMethodLabel)],
        ]) +
        itemsTable(d.items) +
        orderLink(d),
    }),
    text: textLayout([
      `Hello ${name},`,
      `We have recorded your payment of ${rupees(d.totalMinor)} for order ${d.orderNumber}. Thank you.`,
      ...orderTextLink(d),
    ]),
  };
}

export function adminNewOrderEmail(d: OrderEmailData & { customerEmail?: string | null; adminUrl: string }): RenderedEmail {
  return {
    subject: `New order ${d.orderNumber}: ${rupees(d.totalMinor)} (${d.paymentMethodLabel})`,
    html: layout({
      preheader: `${d.customerName} placed order ${d.orderNumber}.`,
      body:
        heading("New order") +
        keyValueRows([
          ["Order", `<strong>${escapeHtml(d.orderNumber)}</strong>`],
          ["Customer", escapeHtml(d.customerName)],
          ["Email", escapeHtml(d.customerEmail || "not given")],
          ["Payment", escapeHtml(d.paymentMethodLabel)],
          ["Total", `<strong>${escapeHtml(rupees(d.totalMinor))}</strong>`],
        ]) +
        itemsTable(d.items) +
        subheading("Deliver to") +
        paragraph(addressBlock(d.shippingAddress)) +
        button("Open in admin", d.adminUrl),
    }),
    text: textLayout([
      `New order ${d.orderNumber}: ${rupees(d.totalMinor)} (${d.paymentMethodLabel})`,
      `Customer: ${d.customerName} <${d.customerEmail || "no email"}>`,
      ...d.items.map((l) => `- ${l.title} (${l.detail}) x${l.quantity}`),
      `Open in admin: ${d.adminUrl}`,
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Contact and newsletter
// ---------------------------------------------------------------------------------------------

export function contactReceivedEmail(d: { name: string; subject?: string | null; message: string; orderNumber?: string | null }): RenderedEmail {
  const name = firstName(d.name);
  return {
    subject: "We received your message",
    html: layout({
      preheader: `Thank you for writing to ${BRAND_IDENTITY.name}. We will reply by email.`,
      body:
        heading(`Thank you, ${escapeHtml(name)}`) +
        paragraph("We received your message and our customer support team will reply to you by email.") +
        keyValueRows([
          ...(d.subject ? ([["Topic", escapeHtml(d.subject)]] as Array<[string, string]>) : []),
          ...(d.orderNumber ? ([["Order", escapeHtml(d.orderNumber)]] as Array<[string, string]>) : []),
        ]) +
        note(`<em>${escapeHtml(d.message).replace(/\n/g, "<br/>")}</em>`),
    }),
    text: textLayout([`Thank you, ${name}.`, "We received your message and will reply by email.", "", `Your message: ${d.message}`]),
  };
}

export function contactAdminEmail(d: {
  name: string;
  email: string;
  phone?: string | null;
  subject?: string | null;
  message: string;
  orderNumber?: string | null;
  inboxUrl: string;
}): RenderedEmail {
  return {
    subject: `New message from ${d.name}${d.orderNumber ? ` (order ${d.orderNumber})` : ""}`,
    html: layout({
      preheader: d.message.slice(0, 90),
      body:
        heading("New message") +
        keyValueRows([
          ["From", escapeHtml(d.name)],
          ["Email", escapeHtml(d.email)],
          ...(d.phone ? ([["Phone", escapeHtml(d.phone)]] as Array<[string, string]>) : []),
          ...(d.subject ? ([["Topic", escapeHtml(d.subject)]] as Array<[string, string]>) : []),
          ...(d.orderNumber ? ([["Order", escapeHtml(d.orderNumber)]] as Array<[string, string]>) : []),
        ]) +
        note(escapeHtml(d.message).replace(/\n/g, "<br/>")) +
        button("Open the inbox", d.inboxUrl),
    }),
    text: textLayout([`New message from ${d.name} <${d.email}>`, d.subject ? `Topic: ${d.subject}` : "", d.orderNumber ? `Order: ${d.orderNumber}` : "", "", d.message, "", `Open the inbox: ${d.inboxUrl}`].filter(Boolean)),
  };
}

// The shop's answer to a message from the inbox, with the customer's own words underneath.
export function contactReplyEmail(d: { name: string; reply: string; originalMessage: string; orderNumber?: string | null }): RenderedEmail {
  const name = firstName(d.name);
  return {
    subject: d.orderNumber ? `Re: your message about order ${d.orderNumber}` : `Re: your message to ${BRAND_IDENTITY.name}`,
    html: layout({
      preheader: d.reply.slice(0, 90),
      body:
        heading(`Hello ${escapeHtml(name)}`) +
        bodyToHtml(d.reply) +
        subheading("Your message") +
        note(`<em>${escapeHtml(d.originalMessage).replace(/\n/g, "<br/>")}</em>`) +
        paragraph("You can reply to this email if you need anything else."),
    }),
    text: textLayout([`Hello ${name},`, "", d.reply, "", "Your message:", d.originalMessage]),
  };
}

export function newsletterWelcomeEmail(d: { unsubscribeUrl: string }): RenderedEmail {
  return {
    subject: "Welcome to the Saffron Circle",
    html: layout({
      preheader: "Early access to new collections and stories from our Jaipur artisans.",
      unsubscribeUrl: d.unsubscribeUrl,
      body:
        heading("Welcome to the Saffron Circle") +
        paragraph("Thank you for joining. You will be the first to hear about new collections, special offers and stories from the artisans behind every piece.") +
        button("Explore the collection", siteUrl("/collections")),
    }),
    text: textLayout(["Welcome to the Saffron Circle.", "You will be the first to hear about new collections, offers and stories from our artisans.", `Explore the collection: ${siteUrl("/collections")}`], d.unsubscribeUrl),
    headers: listUnsubscribeHeaders(d.unsubscribeUrl),
  };
}

// Plain paragraphs only: a blank line starts a new one, and web addresses become links.
export function bodyToHtml(body: string) {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const safe = escapeHtml(p).replace(/\n/g, "<br/>");
      const linked = safe.replace(
        /(https?:\/\/[^\s<]+)/g,
        (url) => `<a href="${url}" style="color:${BRAND.link};">${url}</a>`
      );
      return paragraph(linked);
    })
    .join("");
}

export function newsletterCampaignEmail(d: { subject: string; preheader?: string | null; body: string; unsubscribeUrl: string }): RenderedEmail {
  return {
    subject: d.subject,
    html: layout({
      preheader: d.preheader || d.subject,
      unsubscribeUrl: d.unsubscribeUrl,
      body: heading(escapeHtml(d.subject)) + bodyToHtml(d.body) + button(`Visit ${BRAND_IDENTITY.name}`, siteUrl("/")),
    }),
    text: textLayout([d.subject, "", d.body, "", `Visit ${BRAND_IDENTITY.name}: ${siteUrl("/")}`], d.unsubscribeUrl),
    headers: listUnsubscribeHeaders(d.unsubscribeUrl),
  };
}

export function listUnsubscribeHeaders(url: string) {
  return { "List-Unsubscribe": `<${url}>` };
}

export function testEmail(d: { sentBy: string }): RenderedEmail {
  return {
    subject: `Test email from ${BRAND_IDENTITY.name}`,
    html: layout({
      preheader: "Your email settings work.",
      body: heading("It works") + paragraph(`This is a test message sent by ${escapeHtml(d.sentBy)} to check that email from ${BRAND_IDENTITY.name} reaches this inbox.`),
    }),
    text: textLayout(["It works.", `This is a test message sent by ${d.sentBy}.`]),
  };
}

// ---------------------------------------------------------------------------------------------
// Sample data, used by the admin "send a test of this template" action and the previews
// ---------------------------------------------------------------------------------------------

export function sampleOrder(): OrderEmailData {
  return {
    orderNumber: "ST00000",
    customerName: "Asha Verma",
    items: [
      { title: "Maroon Velvet Embroidered Jacket", detail: "Size M · Maroon", quantity: 1, totalMinor: 1100000 },
      { title: "Ivory Handwork Kimono", detail: "Size S · Ivory", quantity: 1, totalMinor: 1049900 },
    ],
    subtotalMinor: 2149900,
    shippingMinor: 0,
    discountMinor: 100000,
    taxMinor: 0,
    totalMinor: 2049900,
    shippingAddress: { fullName: "Asha Verma", street: "12 Palace Road", city: "Jaipur", state: "Rajasthan", pincode: "302002", country: "India", phone: "+91 98765 43210" },
    paymentMethodLabel: "Cash on Delivery",
    paymentStatus: "Pending",
    orderUrl: siteUrl("/account/orders/ST00000"),
    createdAt: new Date(),
    carrier: "Bluedart",
    trackingNumber: "BD12345678",
    trackingUrl: "https://www.bluedart.com/tracking",
    estimatedDelivery: new Date(Date.now() + 5 * 86400000),
  };
}

function sampleRequest() {
  return {
    customerName: "Asha Verma",
    requestNumber: "RQ00000",
    type: "RETURN",
    orderNumber: "ST00000",
    reasonCode: "SIZE_ISSUE",
    resolution: "REFUND",
    items: [{ title: "Maroon Velvet Embroidered Jacket", detail: "Size M · Maroon", quantity: 1 }],
    outsideWindow: false,
    statusUrl: siteUrl("/account/orders/ST00000"),
  };
}

export function renderSample(template: TemplateName, sentBy: string): RenderedEmail {
  const order = sampleOrder();
  switch (template) {
    case "welcome":
      return welcomeEmail({ name: "Asha Verma" });
    case "email-verification":
      return emailVerificationEmail({ name: "Asha Verma", verifyUrl: siteUrl("/auth/verify-email?token=sample"), expiresInHours: 24 });
    case "password-reset":
      return passwordResetEmail({ name: "Asha Verma", resetUrl: siteUrl("/auth/reset-password?token=sample"), expiresInMinutes: 60 });
    case "password-changed":
      return passwordChangedEmail({ name: "Asha Verma" });
    case "order-confirmation":
      return orderConfirmationEmail(order);
    case "order-ready":
      return orderReadyEmail(order);
    case "order-shipped":
      return orderShippedEmail(order);
    case "order-delivered":
      return orderDeliveredEmail(order);
    case "order-cancelled":
      return orderCancelledEmail(order);
    case "payment-received":
      return paymentReceivedEmail({ ...order, paymentStatus: "Paid" });
    case "payment-failed":
      return paymentFailedEmail({ customerName: "Asha Verma", orderNumber: "ST00000", totalMinor: order.totalMinor, retryUrl: siteUrl("/order-confirmation?order=ST00000") });
    case "refund-update":
      return refundUpdateEmail({ customerName: "Asha Verma", orderNumber: "ST00000", amountMinor: 549900, status: "COMPLETED", method: "GATEWAY", orderUrl: siteUrl("/account/orders/ST00000") });
    case "request-received":
      return requestReceivedEmail(sampleRequest());
    case "request-approved":
      return requestDecisionEmail({ ...sampleRequest(), approved: true, decisionNote: "Please pack the jacket in its original packaging. We will email the return address shortly.", returnShippingPayer: "SELLER" });
    case "request-rejected":
      return requestDecisionEmail({ ...sampleRequest(), approved: false, decisionNote: "The jacket shows signs of use, so it does not meet the conditions for a change-of-mind return." });
    case "request-completed":
      return requestCompletedEmail({ ...sampleRequest(), refundMinor: 549900 });
    case "request-admin-alert":
      return requestAdminAlertEmail({ ...sampleRequest(), adminUrl: siteUrl("/admin/returns"), customerEmail: "asha@example.com" });
    case "admin-new-order":
      return adminNewOrderEmail({ ...order, customerEmail: "asha@example.com", adminUrl: siteUrl("/admin/orders/ST00000") });
    case "contact-received":
      return contactReceivedEmail({ name: "Asha Verma", subject: "Order production status & tracking", message: "Could you tell me when my order will be ready?", orderNumber: "ST00000" });
    case "contact-admin":
      return contactAdminEmail({ name: "Asha Verma", email: "asha@example.com", subject: "Order production status & tracking", message: "Could you tell me when my order will be ready?", orderNumber: "ST00000", inboxUrl: siteUrl("/admin/inbox") });
    case "contact-reply":
      return contactReplyEmail({ name: "Asha Verma", reply: "Thank you for waiting. Your piece is being finished by our artisans and will ship within the week.", originalMessage: "Could you tell me when my order will be ready?", orderNumber: "ST00000" });
    case "newsletter-welcome":
      return newsletterWelcomeEmail({ unsubscribeUrl: siteUrl("/newsletter/unsubscribe?token=sample") });
    case "newsletter-campaign":
      return newsletterCampaignEmail({ subject: "The Velvet Edit has arrived", preheader: "New pieces, hand embroidered in Jaipur.", body: "Our newest velvet jackets are here, each one embroidered by hand.\n\nSee them all at " + siteUrl("/collections/velvet-jackets"), unsubscribeUrl: siteUrl("/newsletter/unsubscribe?token=sample") });
    case "test-email":
      return testEmail({ sentBy });
  }
}
