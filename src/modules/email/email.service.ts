import nodemailer from "nodemailer";
import { prisma } from "../../database/prisma.js";
import { env } from "../../config/env.js";
import { configuredAdminEmail } from "../settings/settings.service.js";
import { RenderedEmail, TemplateName } from "./email.templates.js";
import { resolveSmtpSettings } from "./smtp.config.js";
import { background } from "../../common/background.js";

// One transport for the whole process. Without SMTP_HOST there is no provider: messages are recorded, not sent.
export const smtp = resolveSmtpSettings();
const transporter = smtp.configured
  ? nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: smtp.requireTLS,
      auth: smtp.user ? { user: smtp.user, pass: env.SMTP_PASS } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    })
  : null;

// Signs in to the SMTP server once at start-up (no message is sent) so a wrong password or port shows up in the log
// and on the admin Emails page straight away instead of on the first customer email.
let lastSmtpCheck: { ok: boolean; at: string; error?: string } | null = null;
export async function checkSmtp() {
  for (const w of smtp.warnings) console.warn(`[email] ${w}`);
  if (!transporter) return null;
  try {
    await transporter.verify();
    lastSmtpCheck = { ok: true, at: new Date().toISOString() };
    console.log(`[email] SMTP sign-in OK: ${smtp.host}:${smtp.port} (${smtp.mode}) as ${smtp.user}, sending as ${smtp.from}`);
  } catch (error: any) {
    lastSmtpCheck = { ok: false, at: new Date().toISOString(), error: String(error?.message || error).slice(0, 300) };
    console.error(`[email] SMTP check failed for ${smtp.host}:${smtp.port} (${smtp.mode}): ${lastSmtpCheck.error}`);
  }
  return lastSmtpCheck;
}

export function emailStatus() {
  return {
    provider: transporter ? "smtp" : "none",
    configured: Boolean(transporter),
    from: smtp.from,
    appUrl: env.APP_URL,
    adminNotifyConfigured: Boolean(env.ADMIN_NOTIFY_EMAIL),
    // how the SMTP_* settings were understood (the password is never shown)
    smtp: smtp.configured
      ? { host: smtp.host, port: smtp.port, security: smtp.mode, user: smtp.user, passwordSet: smtp.hasPassword, fromSource: smtp.fromSource }
      : null,
    warnings: smtp.warnings,
    lastCheck: lastSmtpCheck,
    note: transporter
      ? "Emails are sent through the configured SMTP server."
      : "No email provider is configured (SMTP_HOST is empty). Emails are recorded in this log but not delivered.",
  };
}

// Development and test only: the full text of recent messages, including reset links, so a test can follow them.
// It is never filled in production.
export interface DevSinkEntry {
  id: string;
  to: string;
  template: string;
  subject: string;
  html: string;
  text: string;
  createdAt: string;
}
const devSink: DevSinkEntry[] = [];
export const devSinkEnabled = () => env.NODE_ENV !== "production";
export const readDevSink = (to?: string) => (to ? devSink.filter((m) => m.to === to.toLowerCase()) : devSink).slice(-50);

// Reserved test domains never resolve to a mailbox: record them, never hand them to a mail server.
const isTestAddress = (address: string) => /\.(internal|invalid|test|localhost)$/.test(address);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SendArgs {
  to: string | null | undefined;
  template: TemplateName;
  message: RenderedEmail;
  relatedId?: string | null;
}

// Sends one email and records it. It never throws: a mail problem must not break the action that caused it.
export async function sendEmail({ to, template, message, relatedId }: SendArgs) {
  try {
    const address = String(to || "").trim().toLowerCase();
    if (!EMAIL_PATTERN.test(address)) return null;

    const record = await prisma.emailMessage.create({
      data: {
        to: address,
        template,
        subject: message.subject,
        html: message.storedHtml ?? message.html,
        text: message.storedText ?? message.text,
        sensitive: Boolean(message.sensitive),
        relatedId: relatedId || null,
      },
    });

    if (devSinkEnabled()) {
      devSink.push({
        id: record.id,
        to: address,
        template,
        subject: message.subject,
        html: message.html,
        text: message.text,
        createdAt: record.createdAt.toISOString(),
      });
      if (devSink.length > 200) devSink.shift();
    }

    if (isTestAddress(address)) {
      return prisma.emailMessage.update({
        where: { id: record.id },
        data: { status: "Skipped", error: "Test address: recorded, not delivered." },
      });
    }

    if (!transporter) {
      return prisma.emailMessage.update({
        where: { id: record.id },
        data: { status: "Skipped", error: "No email provider is configured." },
      });
    }

    try {
      await transporter.sendMail({
        from: smtp.from,
        to: address,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
      });
      return prisma.emailMessage.update({
        where: { id: record.id },
        data: { status: "Sent", attempts: { increment: 1 }, sentAt: new Date(), error: null },
      });
    } catch (error: any) {
      return prisma.emailMessage.update({
        where: { id: record.id },
        data: { status: "Failed", attempts: { increment: 1 }, error: String(error?.message || error).slice(0, 300) },
      });
    }
  } catch (error: any) {
    console.error("[email] could not record or send a message:", error?.message);
    return null;
  }
}

// Fire and forget: callers do not wait for the mail server.
export function queueEmail(args: SendArgs) {
  background(sendEmail(args));
}

// Send the stored copy of a message again (Failed or Skipped, never one that holds a credential).
export async function resendStoredEmail(id: string) {
  const record = await prisma.emailMessage.findUnique({ where: { id } });
  if (!record) return { error: "not-found" as const };
  if (record.sensitive) return { error: "sensitive" as const };
  if (record.status === "Sent") return { error: "already-sent" as const };
  if (!transporter || isTestAddress(record.to)) {
    const updated = await prisma.emailMessage.update({
      where: { id },
      data: { status: "Skipped", error: transporter ? "Test address: recorded, not delivered." : "No email provider is configured." },
    });
    return { record: updated };
  }
  try {
    await transporter.sendMail({ from: smtp.from, to: record.to, subject: record.subject, html: record.html, text: record.text });
    const updated = await prisma.emailMessage.update({
      where: { id },
      data: { status: "Sent", attempts: { increment: 1 }, sentAt: new Date(), error: null },
    });
    return { record: updated };
  } catch (error: any) {
    const updated = await prisma.emailMessage.update({
      where: { id },
      data: { status: "Failed", attempts: { increment: 1 }, error: String(error?.message || error).slice(0, 300) },
    });
    return { record: updated };
  }
}

// Who gets store alerts: the configured address list, or else every administrator account.
export async function adminRecipients(): Promise<string[]> {
  // An address saved in the admin settings wins over the environment value.
  const configured = await configuredAdminEmail();
  if (configured && EMAIL_PATTERN.test(configured)) return [configured];
  if (env.ADMIN_NOTIFY_EMAIL) {
    return env.ADMIN_NOTIFY_EMAIL.split(",").map((e) => e.trim()).filter((e) => EMAIL_PATTERN.test(e));
  }
  const admins = await prisma.user.findMany({
    where: { status: "ACTIVE", userRoles: { some: { role: { code: "ADMIN" } } } },
    select: { email: true },
  });
  return admins.map((a) => a.email);
}
