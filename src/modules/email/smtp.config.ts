import { BRAND_IDENTITY } from "../../config/brand.js";
import { env } from "../../config/env.js";

/**
 * Turns the SMTP_* settings into one consistent transport configuration.
 *
 * Connection security (the usual pairs):
 *   port 465            -> implicit TLS ("ssl")     : secure = true
 *   port 587 / 25 / 2525 -> STARTTLS ("tls")        : secure = false, then upgraded; requireTLS refuses plain text
 * SMTP_SECURITY may say ssl | tls | starttls | none. A contradictory SMTP_SECURE=true on port 587 is corrected to
 * STARTTLS (implicit TLS on 587 always fails the handshake) and reported in `warnings`.
 *
 * Sender: EMAIL_FROM when set; otherwise SMTP_FROM_NAME (or the brand name) with SMTP_FROM_EMAIL or the SMTP
 * login address. Most providers (Hostinger included) only accept mail whose From is the authenticated mailbox.
 */
export type SmtpMode = "ssl" | "starttls" | "none";

export interface SmtpSettings {
  configured: boolean;
  host?: string;
  port: number;
  mode: SmtpMode;
  secure: boolean;
  requireTLS: boolean;
  user?: string;
  hasPassword: boolean;
  from: string;
  fromSource: "EMAIL_FROM" | "SMTP_FROM_NAME + login" | "default";
  warnings: string[];
}

function wantedMode(): SmtpMode | null {
  const raw = (env.SMTP_SECURITY || env.SMTP_SECURTIY || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "ssl" || raw === "smtps" || raw === "implicit") return "ssl";
  if (raw === "tls" || raw === "starttls") return "starttls";
  if (raw === "none" || raw === "false" || raw === "off") return "none";
  return null;
}

export function resolveSmtpSettings(): SmtpSettings {
  const warnings: string[] = [];
  const port = env.SMTP_PORT;
  if (env.SMTP_SECURTIY && !env.SMTP_SECURITY) warnings.push("SMTP_SECURTIY is misspelled; it is read for now, but rename it to SMTP_SECURITY.");

  let mode = wantedMode();
  if (!mode) mode = port === 465 ? "ssl" : env.SMTP_SECURE && port !== 587 ? "ssl" : "starttls";
  if (mode === "ssl" && port === 587) {
    warnings.push("Port 587 uses STARTTLS, not implicit TLS: SMTP_SECURE=true was ignored for this port (use port 465 for implicit TLS).");
    mode = "starttls";
  }
  if (mode === "starttls" && port === 465) {
    warnings.push("Port 465 uses implicit TLS: STARTTLS was changed to implicit TLS for this port.");
    mode = "ssl";
  }

  const loginIsEmail = Boolean(env.SMTP_USER && /^[^\s@]+@[^\s@]+$/.test(env.SMTP_USER));
  const fromEmail = env.SMTP_FROM_EMAIL || (loginIsEmail ? env.SMTP_USER : undefined);
  let from: string;
  let fromSource: SmtpSettings["fromSource"];
  if (env.EMAIL_FROM) {
    from = env.EMAIL_FROM;
    fromSource = "EMAIL_FROM";
  } else if (fromEmail) {
    from = `"${(env.SMTP_FROM_NAME || BRAND_IDENTITY.name).replace(/"/g, "")}" <${fromEmail}>`;
    fromSource = "SMTP_FROM_NAME + login";
  } else {
    from = `"${BRAND_IDENTITY.name}" <orders@${BRAND_IDENTITY.domain.replace(/.com$/, ".local")}>`;
    fromSource = "default";
  }
  const fromAddress = /<([^>]+)>/.exec(from)?.[1] || from;
  if (env.SMTP_HOST && loginIsEmail && fromAddress.toLowerCase() !== env.SMTP_USER!.toLowerCase()) {
    warnings.push(`The sender ${fromAddress} is not the SMTP login ${env.SMTP_USER}; many providers reject or spam-folder such mail.`);
  }
  if (env.SMTP_HOST && !env.SMTP_USER) warnings.push("SMTP_USER is empty: the server will be used without signing in.");
  if (env.SMTP_HOST && env.SMTP_USER && !env.SMTP_PASS) warnings.push("SMTP_PASS is empty.");

  return {
    configured: Boolean(env.SMTP_HOST),
    host: env.SMTP_HOST,
    port,
    mode,
    secure: mode === "ssl",
    requireTLS: mode === "starttls",
    user: env.SMTP_USER,
    hasPassword: Boolean(env.SMTP_PASS),
    from,
    fromSource,
    warnings,
  };
}
