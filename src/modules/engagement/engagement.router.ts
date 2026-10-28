import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAdmin, AuthenticatedRequest } from "../../common/auth.middleware.js";
import { generateOpaqueToken } from "../../common/crypto.utils.js";
import { siteUrl } from "../email/email.layout.js";
import { adminRecipients, emailStatus, queueEmail, sendEmail } from "../email/email.service.js";
import {
  contactAdminEmail,
  contactReceivedEmail,
  contactReplyEmail,
  newsletterCampaignEmail,
  newsletterWelcomeEmail,
} from "../email/email.templates.js";
import { env } from "../../config/env.js";
import { notifyAdminsContactMessage } from "../notifications/notify.js";
import { background } from "../../common/background.js";

// Local and test runs may skip the limiter; production never does.
const testBypassAllowed = process.env.NODE_ENV !== "production";

const publicFormLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    testBypassAllowed &&
    (process.env.NODE_ENV === "test" || req.headers["x-test-bypass-rate-limit"] === "true"),
  message: {
    status: "error",
    code: "RATE_LIMIT_EXCEEDED",
    message: "Too many submissions. Please try again later.",
  },
});

const emailField = z
  .string({ required_error: "Email is required" })
  .trim()
  .toLowerCase()
  .min(1, "Email is required")
  .max(254, "Email is too long")
  .email("Enter a valid email address");

const newsletterSchema = z.object({
  email: emailField,
  source: z.string().trim().max(60).optional(),
});

const contactSchema = z.object({
  name: z.string({ required_error: "Name is required" }).trim().min(1, "Name is required").max(100, "Name must be 100 characters or fewer"),
  email: emailField,
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+()\-\s]{7,20}$/, "Enter a valid phone number")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  subject: z.string().trim().max(150, "Subject must be 150 characters or fewer").optional(),
  message: z
    .string({ required_error: "Message is required" })
    .trim()
    .min(10, "Message must be at least 10 characters")
    .max(2000, "Message must be 2000 characters or fewer"),
  orderNumber: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9-]+$/, "Order number is not valid")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const campaignSchema = z.object({
  subject: z.string({ required_error: "Subject is required" }).trim().min(3, "Subject must be at least 3 characters").max(150, "Subject must be 150 characters or fewer"),
  preheader: z.string().trim().max(150, "Preview text must be 150 characters or fewer").optional().nullable(),
  body: z.string({ required_error: "Write the newsletter" }).trim().min(10, "The newsletter must be at least 10 characters").max(10000, "The newsletter must be 10000 characters or fewer"),
});

function validationError(res: Response, error: z.ZodError) {
  return res.status(400).json({
    status: "error",
    message: error.issues[0]?.message || "Please check the form and try again.",
    errors: error.flatten().fieldErrors,
  });
}

const unsubscribeUrl = (token: string) => siteUrl(`/newsletter/unsubscribe?token=${token}`);

// ---------------------------------------------------------------------------
// Public: newsletter
// ---------------------------------------------------------------------------

// Sign-up. The answer is the same whether or not the address was already subscribed, so the endpoint
// cannot be used to find out who is on the list. The welcome email goes out only for a new or returning subscriber.
export const newsletterRouter = Router();
newsletterRouter.post("/", publicFormLimiter, async (req: Request, res: Response) => {
  const parsed = newsletterSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const { email } = parsed.data;
    const existing = await prisma.newsletterSubscriber.findUnique({ where: { email } });
    const token = existing?.unsubscribeToken || generateOpaqueToken(24);
    const subscriber = existing
      ? await prisma.newsletterSubscriber.update({
          where: { email },
          data: { status: "Subscribed", unsubscribedAt: null, unsubscribeToken: token },
        })
      : await prisma.newsletterSubscriber.create({
          data: { email, source: parsed.data.source || null, unsubscribeToken: token },
        });

    if (!existing || existing.status === "Unsubscribed") {
      queueEmail({
        to: subscriber.email,
        template: "newsletter-welcome",
        message: newsletterWelcomeEmail({ unsubscribeUrl: unsubscribeUrl(token) }),
        relatedId: subscriber.id,
      });
    }
    return res.status(200).json({ status: "success", message: "You are subscribed to the Saffron Circle." });
  } catch (error) {
    console.error("[newsletter] sign-up failed", error);
    return res.status(500).json({ status: "error", message: "We could not complete your sign-up. Please try again." });
  }
});

// One-click unsubscribe, used by the link in every newsletter. Repeating it is harmless.
newsletterRouter.post("/unsubscribe", publicFormLimiter, async (req: Request, res: Response) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token || token.length > 200) {
    return res.status(400).json({ status: "error", message: "This unsubscribe link is not valid." });
  }
  const subscriber = await prisma.newsletterSubscriber.findUnique({ where: { unsubscribeToken: token } });
  if (!subscriber) {
    return res.status(404).json({ status: "error", message: "This unsubscribe link is not valid." });
  }
  if (subscriber.status !== "Unsubscribed") {
    await prisma.newsletterSubscriber.update({
      where: { id: subscriber.id },
      data: { status: "Unsubscribed", unsubscribedAt: new Date() },
    });
  }
  const [name, domain] = subscriber.email.split("@");
  return res.status(200).json({
    status: "success",
    message: "You have been unsubscribed and will not receive any more newsletters.",
    email: `${name.slice(0, 1)}***@${domain}`,
  });
});

// ---------------------------------------------------------------------------
// Public: contact and order-support messages
// ---------------------------------------------------------------------------

export const contactRouter = Router();
contactRouter.post("/", publicFormLimiter, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  try {
    const saved = await prisma.contactMessage.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        phone: parsed.data.phone || null,
        subject: parsed.data.subject || null,
        message: parsed.data.message,
        orderNumber: parsed.data.orderNumber || null,
        userId: req.user?.id || null,
      },
      select: { id: true },
    });

    queueEmail({
      to: parsed.data.email,
      template: "contact-received",
      message: contactReceivedEmail({ name: parsed.data.name, subject: parsed.data.subject, message: parsed.data.message, orderNumber: parsed.data.orderNumber }),
      relatedId: saved.id,
    });
    notifyAdminsContactMessage({ id: saved.id, name: parsed.data.name, subject: parsed.data.subject });
    background((async () => {
      const alert = contactAdminEmail({ ...parsed.data, inboxUrl: siteUrl("/admin/inbox") });
      for (const to of await adminRecipients()) queueEmail({ to, template: "contact-admin", message: alert, relatedId: saved.id });
    })());

    return res.status(201).json({ status: "success", message: "Thank you. Our concierge will reply by email.", data: saved });
  } catch (error) {
    console.error("[contact] message failed", error);
    return res.status(500).json({ status: "error", message: "We could not send your message. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// Admin: inbox, subscribers, newsletters
// ---------------------------------------------------------------------------

export const adminEngagementRouter = Router();
adminEngagementRouter.use(requireAdmin);

const MESSAGE_STATUSES = ["New", "Read", "Resolved"];
const SUBSCRIBER_STATUSES = ["Subscribed", "Unsubscribed"];

function paging(req: Request) {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

const idParam = (req: Request) => (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);

// Counters for the sidebar and the page headers.
adminEngagementRouter.get("/summary", async (_req: Request, res: Response) => {
  const [newMessages, subscribed, unsubscribed, drafts] = await Promise.all([
    prisma.contactMessage.count({ where: { status: "New" } }),
    prisma.newsletterSubscriber.count({ where: { status: "Subscribed" } }),
    prisma.newsletterSubscriber.count({ where: { status: "Unsubscribed" } }),
    prisma.newsletterCampaign.count({ where: { status: "Draft" } }),
  ]);
  return res.status(200).json({ status: "success", data: { newMessages, subscribed, unsubscribed, drafts } });
});

adminEngagementRouter.get("/contact-messages", async (req: Request, res: Response) => {
  const { page, limit, skip } = paging(req);
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (status && !MESSAGE_STATUSES.includes(status)) {
    return res.status(400).json({ status: "error", message: "Status must be New, Read or Resolved" });
  }
  const where: any = status ? { status } : {};
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { subject: { contains: search, mode: "insensitive" } },
      { message: { contains: search, mode: "insensitive" } },
      { orderNumber: { contains: search, mode: "insensitive" } },
    ];
  }
  const [total, items] = await Promise.all([
    prisma.contactMessage.count({ where }),
    prisma.contactMessage.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit }),
  ]);
  return res.status(200).json({ status: "success", items, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

adminEngagementRouter.patch("/contact-messages/:id", async (req: Request, res: Response) => {
  const status = req.body?.status;
  if (typeof status !== "string" || !MESSAGE_STATUSES.includes(status)) {
    return res.status(400).json({ status: "error", message: "Status must be New, Read or Resolved" });
  }
  const id = idParam(req);
  const existing = await prisma.contactMessage.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return res.status(404).json({ status: "error", message: "Message not found" });
  const updated = await prisma.contactMessage.update({ where: { id }, data: { status } });
  return res.status(200).json({ status: "success", data: updated });
});

// Answer a message from the inbox: the customer gets an email and the message is marked Resolved.
adminEngagementRouter.post("/contact-messages/:id/reply", async (req: AuthenticatedRequest, res: Response) => {
  const reply = typeof req.body?.reply === "string" ? req.body.reply.trim() : "";
  if (reply.length < 2) return res.status(400).json({ status: "error", message: "Write your reply first" });
  if (reply.length > 5000) return res.status(400).json({ status: "error", message: "A reply can be at most 5000 characters" });
  const id = idParam(req);
  const message = await prisma.contactMessage.findUnique({ where: { id } });
  if (!message) return res.status(404).json({ status: "error", message: "Message not found" });

  const email = await sendEmail({
    to: message.email,
    template: "contact-reply",
    message: contactReplyEmail({ name: message.name, reply, originalMessage: message.message, orderNumber: message.orderNumber }),
    relatedId: message.id,
  });
  // A reply that failed to go out is not recorded as an answer.
  if (!email) return res.status(502).json({ status: "error", message: "The reply could not be queued. Please try again." });
  if (email.status === "Failed") {
    return res.status(502).json({ status: "error", message: `The reply could not be sent: ${email.error || "the email server refused it"}` });
  }
  const updated = await prisma.contactMessage.update({
    where: { id },
    data: { status: "Resolved", replyText: reply, repliedAt: new Date(), repliedByUserId: req.user!.id },
  });
  return res.status(200).json({ status: "success", data: updated, email: { status: email.status } });
});

adminEngagementRouter.get("/newsletter-subscribers", async (req: Request, res: Response) => {
  const { page, limit, skip } = paging(req);
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (status && !SUBSCRIBER_STATUSES.includes(status)) {
    return res.status(400).json({ status: "error", message: "Status must be Subscribed or Unsubscribed" });
  }
  const where: any = status ? { status } : {};
  if (search) where.email = { contains: search, mode: "insensitive" };
  const [total, items] = await Promise.all([
    prisma.newsletterSubscriber.count({ where }),
    prisma.newsletterSubscriber.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      select: { id: true, email: true, source: true, status: true, unsubscribedAt: true, createdAt: true },
    }),
  ]);
  return res.status(200).json({ status: "success", items, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

// Staff can unsubscribe someone who asks by email, or put them back.
adminEngagementRouter.patch("/newsletter-subscribers/:id", async (req: Request, res: Response) => {
  const status = req.body?.status;
  if (typeof status !== "string" || !SUBSCRIBER_STATUSES.includes(status)) {
    return res.status(400).json({ status: "error", message: "Status must be Subscribed or Unsubscribed" });
  }
  const id = idParam(req);
  const existing = await prisma.newsletterSubscriber.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ status: "error", message: "Subscriber not found" });
  const updated = await prisma.newsletterSubscriber.update({
    where: { id },
    data: {
      status,
      unsubscribedAt: status === "Unsubscribed" ? new Date() : null,
      unsubscribeToken: existing.unsubscribeToken || generateOpaqueToken(24),
    },
    select: { id: true, email: true, source: true, status: true, unsubscribedAt: true, createdAt: true },
  });
  return res.status(200).json({ status: "success", data: updated });
});

// ---- newsletters (campaigns) ----

adminEngagementRouter.get("/newsletter-campaigns", async (req: Request, res: Response) => {
  const { page, limit, skip } = paging(req);
  const [total, items] = await Promise.all([
    prisma.newsletterCampaign.count(),
    prisma.newsletterCampaign.findMany({ orderBy: { createdAt: "desc" }, skip, take: limit }),
  ]);
  return res.status(200).json({ status: "success", items, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

adminEngagementRouter.post("/newsletter-campaigns", async (req: AuthenticatedRequest, res: Response) => {
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);
  const created = await prisma.newsletterCampaign.create({
    data: { subject: parsed.data.subject, preheader: parsed.data.preheader || null, body: parsed.data.body, createdByUserId: req.user!.id },
  });
  return res.status(201).json({ status: "success", data: created });
});

adminEngagementRouter.patch("/newsletter-campaigns/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  const existing = await prisma.newsletterCampaign.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ status: "error", message: "Newsletter not found" });
  if (existing.status !== "Draft") return res.status(409).json({ status: "error", message: "A newsletter that was sent cannot be edited" });
  const parsed = campaignSchema.safeParse({ ...existing, ...req.body });
  if (!parsed.success) return validationError(res, parsed.error);
  const updated = await prisma.newsletterCampaign.update({
    where: { id },
    data: { subject: parsed.data.subject, preheader: parsed.data.preheader || null, body: parsed.data.body },
  });
  return res.status(200).json({ status: "success", data: updated });
});

adminEngagementRouter.delete("/newsletter-campaigns/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  const existing = await prisma.newsletterCampaign.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ status: "error", message: "Newsletter not found" });
  if (existing.status !== "Draft") return res.status(409).json({ status: "error", message: "A newsletter that was sent is kept as a record and cannot be deleted" });
  await prisma.newsletterCampaign.delete({ where: { id } });
  return res.status(200).json({ status: "success" });
});

// A test copy to one address (yours by default), with a sample unsubscribe link.
adminEngagementRouter.post("/newsletter-campaigns/:id/test", async (req: AuthenticatedRequest, res: Response) => {
  const id = idParam(req);
  const campaign = await prisma.newsletterCampaign.findUnique({ where: { id } });
  if (!campaign) return res.status(404).json({ status: "error", message: "Newsletter not found" });
  const to = typeof req.body?.to === "string" && req.body.to.trim() ? req.body.to.trim() : req.user!.email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ status: "error", message: "Enter a valid email address" });
  const record = await sendEmail({
    to,
    template: "newsletter-campaign",
    message: newsletterCampaignEmail({ subject: `[Test] ${campaign.subject}`, preheader: campaign.preheader, body: campaign.body, unsubscribeUrl: siteUrl("/newsletter/unsubscribe?token=test") }),
    relatedId: `${campaign.id}:test`,
  });
  return res.status(201).json({ status: "success", data: record });
});

// Sends the newsletter to everyone who is subscribed. It can only be sent once.
adminEngagementRouter.post("/newsletter-campaigns/:id/send", async (req: Request, res: Response) => {
  const id = idParam(req);
  const campaign = await prisma.newsletterCampaign.findUnique({ where: { id } });
  if (!campaign) return res.status(404).json({ status: "error", message: "Newsletter not found" });
  if (campaign.status !== "Draft") return res.status(409).json({ status: "error", message: "This newsletter was already sent" });
  if (!emailStatus().configured && env.NODE_ENV === "production") {
    return res.status(409).json({ status: "error", message: "No email provider is configured, so nothing can be delivered" });
  }

  // Claim it first, so two clicks cannot send it twice.
  const claimed = await prisma.newsletterCampaign.updateMany({ where: { id, status: "Draft" }, data: { status: "Sending" } });
  if (claimed.count === 0) return res.status(409).json({ status: "error", message: "This newsletter is already being sent" });

  const subscribers = await prisma.newsletterSubscriber.findMany({ where: { status: "Subscribed" }, select: { id: true, email: true, unsubscribeToken: true } });
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const queue = [...subscribers];
  const worker = async () => {
    for (let sub = queue.shift(); sub; sub = queue.shift()) {
      let token = sub.unsubscribeToken;
      if (!token) {
        token = generateOpaqueToken(24);
        await prisma.newsletterSubscriber.update({ where: { id: sub.id }, data: { unsubscribeToken: token } });
      }
      const record = await sendEmail({
        to: sub.email,
        template: "newsletter-campaign",
        message: newsletterCampaignEmail({ subject: campaign.subject, preheader: campaign.preheader, body: campaign.body, unsubscribeUrl: unsubscribeUrl(token) }),
        relatedId: campaign.id,
      });
      if (record?.status === "Sent") sent++;
      else if (record?.status === "Skipped") skipped++;
      else failed++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const done = await prisma.newsletterCampaign.update({
    where: { id },
    data: { status: "Sent", sentAt: new Date(), recipientCount: subscribers.length, sentCount: sent, failedCount: failed },
  });
  return res.status(200).json({ status: "success", data: done, skippedCount: skipped });
});
