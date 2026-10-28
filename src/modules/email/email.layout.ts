import { BRAND_IDENTITY, BRAND_NAME_UPPER } from "../../config/brand.js";
import { env } from "../../config/env.js";

// Email colours and type: the same values as the storefront tokens in Website/app/globals.css (emails cannot read CSS variables,
// so the hex of each token is repeated here). Change a token there, change it here.
export const BRAND = {
  name: `${BRAND_IDENTITY.name}`,
  tagline: "Tradition in every thread. Made for today.",
  primary: "#181818", // --color-primary: buttons
  link: "#C92424", // --color-secondary: links
  accent: "#E43131", // --color-accent: note rule
  ink: "#181818", // --color-ink: text and headings
  inkSecondary: "#4D4E4F", // --color-ink-secondary
  muted: "#6B6B6B", // --color-ink-muted
  line: "#E9E9E9", // --color-line: dividers and card edge
  surfaceMuted: "#F7F7F7", // --color-surface-muted: page band, note background
  white: "#FFFFFF", // --color-canvas / --color-on-primary
  inverse: "#181818", // --color-inverse: footer
  onInverse: "#FFFFFF", // --color-on-inverse
  onInverseMuted: "#E9E9E9", // --color-on-inverse-muted
  // Kumbh Sans (storefront font) where the client loads web fonts; the fallbacks are what Outlook and others show.
  font: "'Kumbh Sans', 'Segoe UI', Helvetica, Arial, sans-serif",
  weightHeading: 500,
  weightBody: 400,
  weightStrong: 600,
  stitch: "#C9C9C9", // dashed "seam" under the header: the thread motif
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const rupees = (minor: number | null | undefined) =>
  `₹${((minor || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export const siteUrl = (path = "") => `${env.APP_URL.replace(/\/$/, "")}${path}`;

export function formatDate(value: Date | string | null | undefined) {
  return value
    ? new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
    : "";
}

// ---- building blocks (table based, inline styles: the only thing email clients agree on) ----

export const paragraph = (text: string) =>
  `<p style="margin:0 0 16px;font-family:${BRAND.font};font-size:15px;line-height:1.7;color:${BRAND.ink};">${text}</p>`;

export const heading = (text: string) =>
  `<h1 style="margin:0 0 16px;font-family:${BRAND.font};font-size:30px;line-height:1.2;letter-spacing:-0.5px;font-weight:${BRAND.weightHeading};color:${BRAND.ink};">${text}</h1>`;

export const subheading = (text: string) =>
  `<h2 style="margin:28px 0 10px;font-family:${BRAND.font};font-size:21px;font-weight:${BRAND.weightHeading};color:${BRAND.ink};">${text}</h2>`;

export const button = (label: string, href: string) =>
  `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0;"><tr><td style="background:${BRAND.primary};border-radius:28px;">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 32px;font-family:${BRAND.font};font-size:14px;font-weight:${BRAND.weightStrong};color:${BRAND.white};text-decoration:none;">${escapeHtml(label)}</a>
  </td></tr></table>`;

export const note = (html: string) =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0;"><tr><td style="background:${BRAND.surfaceMuted};border-left:3px solid ${BRAND.accent};border-radius:0 10px 10px 0;padding:14px 18px;font-family:${BRAND.font};font-size:13px;line-height:1.6;color:${BRAND.ink};">${html}</td></tr></table>`;

export function keyValueRows(rows: Array<[string, string]>) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 16px;">${rows
    .map(
      ([k, v]) => `<tr>
      <td style="padding:7px 0;font-family:${BRAND.font};font-size:13px;color:${BRAND.muted};width:38%;vertical-align:top;">${escapeHtml(k)}</td>
      <td style="padding:7px 0;font-family:${BRAND.font};font-size:14px;color:${BRAND.ink};vertical-align:top;">${v}</td>
    </tr>`
    )
    .join("")}</table>`;
}

export interface EmailLine {
  title: string;
  detail: string;
  quantity: number;
  totalMinor: number;
}

export function itemsTable(lines: EmailLine[]) {
  const rows = lines
    .map(
      (l) => `<tr>
      <td style="padding:12px 0;border-bottom:1px solid ${BRAND.line};font-family:${BRAND.font};font-size:14px;color:${BRAND.ink};">
        <strong style="font-weight:${BRAND.weightStrong};">${escapeHtml(l.title)}</strong><br/>
        <span style="font-size:12px;color:${BRAND.muted};">${escapeHtml(l.detail)} &middot; Qty ${l.quantity}</span>
      </td>
      <td align="right" style="padding:12px 0;border-bottom:1px solid ${BRAND.line};font-family:${BRAND.font};font-size:14px;color:${BRAND.ink};white-space:nowrap;">${rupees(l.totalMinor)}</td>
    </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 6px;">${rows}</table>`;
}

export function totalsTable(rows: Array<[string, string, boolean?]>) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 18px;">${rows
    .map(
      ([k, v, strong]) => `<tr>
      <td style="padding:5px 0;font-family:${BRAND.font};font-size:${strong ? 15 : 13}px;font-weight:${strong ? BRAND.weightStrong : BRAND.weightBody};color:${strong ? BRAND.ink : BRAND.muted};">${escapeHtml(k)}</td>
      <td align="right" style="padding:5px 0;font-family:${BRAND.font};font-size:${strong ? 15 : 13}px;font-weight:${strong ? BRAND.weightStrong : BRAND.weightBody};color:${BRAND.ink};">${v}</td>
    </tr>`
    )
    .join("")}</table>`;
}

export function addressBlock(a: any) {
  if (!a) return "";
  const line2 = [a.apartment].filter(Boolean).join(", ");
  return [
    `<strong>${escapeHtml(a.fullName || "")}</strong>`,
    escapeHtml(a.street || ""),
    line2 ? escapeHtml(line2) : "",
    escapeHtml([a.city, a.state, a.pincode].filter(Boolean).join(", ")),
    escapeHtml(a.country || ""),
    a.phone ? `Phone: ${escapeHtml(a.phone)}` : "",
  ]
    .filter(Boolean)
    .join("<br/>");
}

interface LayoutOptions {
  preheader: string;
  body: string;
  // Marketing mail must offer a one-click way out.
  unsubscribeUrl?: string;
}

// The frame every email shares. Header: accent strip, floral SV monogram, letter-spaced wordmark, stitched seam.
// Footer: dark rounded panel with the white logo, a "Visit store" pill, the useful links and a sign-off.
// Everything that carries the brand also works with images switched off (the wordmark is live text).
export function layout({ preheader, body, unsubscribeUrl }: LayoutOptions): string {
  const home = escapeHtml(siteUrl("/"));
  const link = (label: string, path: string) =>
    `<a href="${escapeHtml(siteUrl(path))}" style="color:${BRAND.onInverse};text-decoration:none;white-space:nowrap;">${label}</a>`;
  const dot = `<span style="color:${BRAND.muted};padding:0 8px;">&middot;</span>`;
  const reason = unsubscribeUrl
    ? `You are receiving this because you joined the Saffron Circle. <a href="${escapeHtml(unsubscribeUrl)}" style="color:${BRAND.onInverse};text-decoration:underline;">Unsubscribe</a> at any time.`
    : `You are receiving this email because of activity on your ${escapeHtml(BRAND_IDENTITY.name)} account or order.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="x-apple-disable-message-reformatting"/>
<meta name="color-scheme" content="light only"/>
<meta name="supported-color-schemes" content="light only"/>
<link href="https://fonts.googleapis.com/css2?family=Kumbh+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<title>${escapeHtml(BRAND_IDENTITY.name)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.surfaceMuted};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BRAND.surfaceMuted};">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${BRAND.surfaceMuted};">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;background:${BRAND.white};border-radius:18px;overflow:hidden;box-shadow:0 8px 28px rgba(24,24,24,0.08);">
    <tr><td style="height:5px;line-height:5px;font-size:0;background:${BRAND.accent};">&nbsp;</td></tr>
    <tr><td align="center" style="padding:30px 24px 0;background:${BRAND.white};">
      <a href="${home}" style="text-decoration:none;">
        <img src="${escapeHtml(siteUrl("/email/logo-mark.png"))}" width="84" alt="" style="display:block;margin:0 auto;border:0;outline:none;width:84px;max-width:100%;height:auto;"/>
        <div style="margin-top:12px;font-family:${BRAND.font};font-size:15px;line-height:1;letter-spacing:7px;text-indent:7px;font-weight:${BRAND.weightStrong};color:${BRAND.ink};text-transform:uppercase;">${escapeHtml(BRAND_IDENTITY.name)}</div>
      </a>
      <div style="margin-top:9px;font-family:${BRAND.font};font-size:11px;line-height:1.4;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.muted};">${escapeHtml(BRAND.tagline)}</div>
    </td></tr>
    <tr><td style="padding:24px 36px 0;"><div style="border-top:2px dashed ${BRAND.stitch};font-size:0;line-height:0;height:0;">&nbsp;</div></td></tr>
    <tr><td style="padding:30px 36px 30px;">${body}</td></tr>
    <tr><td style="padding:0 12px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;border-spacing:0;background:${BRAND.inverse};border-radius:14px;">
        <tr><td style="padding:26px 28px 6px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td valign="middle"><a href="${home}" style="text-decoration:none;"><img src="${escapeHtml(siteUrl("/email/logo-footer.png"))}" width="150" alt="${escapeHtml(BRAND_IDENTITY.name)}" style="display:block;border:0;outline:none;width:150px;max-width:100%;height:auto;font-family:${BRAND.font};font-size:18px;font-weight:${BRAND.weightStrong};color:${BRAND.onInverse};"/></a></td>
            <td valign="middle" align="right"><a href="${home}" style="display:inline-block;padding:9px 18px;border:1px solid ${BRAND.onInverse};border-radius:22px;font-family:${BRAND.font};font-size:12px;font-weight:${BRAND.weightStrong};color:${BRAND.onInverse};text-decoration:none;white-space:nowrap;">Visit store &rarr;</a></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:16px 28px 0;"><div style="border-top:1px dashed #4E4E4E;font-size:0;line-height:0;height:0;">&nbsp;</div></td></tr>
        <tr><td style="padding:16px 28px 0;font-family:${BRAND.font};font-size:13px;line-height:2;color:${BRAND.onInverse};">
          ${link("Track order", "/account/orders")}${dot}${link("Shipping", "/policies/shipping")}${dot}${link("Returns", "/policies/returns")}${dot}${link("FAQs", "/faqs")}${dot}${link("Contact", "/contact")}
        </td></tr>
        <tr><td style="padding:14px 28px 0;font-family:${BRAND.font};font-size:15px;font-weight:${BRAND.weightHeading};color:${BRAND.onInverse};">Handcrafted in Jaipur, made to order.</td></tr>
        <tr><td style="padding:8px 28px 24px;font-family:${BRAND.font};font-size:11px;line-height:1.7;color:${BRAND.onInverseMuted};">
          ${reason}<br/>&copy; ${new Date().getFullYear()} ${escapeHtml(BRAND_IDENTITY.name)}. Questions? Just reply to this email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// Plain-text twin of a message: the same facts, no markup.
export function textLayout(lines: string[], unsubscribeUrl?: string) {
  return [
    `${BRAND_NAME_UPPER}`,
    BRAND.tagline,
    "",
    ...lines,
    "",
    "--",
    "Handcrafted in Jaipur, made to order.",
    `Contact: ${siteUrl("/contact")}`,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : "",
  ]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n");
}
