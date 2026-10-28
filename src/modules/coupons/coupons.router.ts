import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAdmin } from "../../common/auth.middleware.js";
import { CouponRow, couponState, percentOf } from "./coupons.service.js";

export const adminCouponsRouter = Router();
adminCouponsRouter.use(requireAdmin);

const idParam = (req: Request) => (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);

const hasMax2dp = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

const dateField = (label: string) =>
  z
    .union([z.string().trim(), z.null()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} is not a valid date` });
        return z.NEVER;
      }
      return d;
    });

const baseShape = {
  code: z
    .string({ required_error: "Code is required" })
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9_-]{3,20}$/, "Code must be 3-20 characters: letters, numbers, - or _")),
  type: z.enum(["percent", "fixed"], { errorMap: () => ({ message: "Type must be percent or fixed" }) }),
  value: z
    .number({ required_error: "Value is required", invalid_type_error: "Value must be a number" })
    .positive("Value must be greater than 0"),
  description: z.string().trim().max(200, "Description must be 200 characters or fewer").optional().nullable(),
  minSubtotal: z
    .number({ invalid_type_error: "Minimum order must be a number" })
    .min(0, "Minimum order cannot be negative")
    .max(10_000_000, "Minimum order is too large")
    .refine(hasMax2dp, "Minimum order can have at most two decimal places")
    .optional()
    .nullable(),
  usageLimit: z
    .number({ invalid_type_error: "Usage limit must be a number" })
    .int("Usage limit must be a whole number")
    .min(1, "Usage limit must be at least 1")
    .max(1_000_000, "Usage limit is too large")
    .optional()
    .nullable(),
  startsAt: dateField("Start date"),
  endsAt: dateField("End date"),
  active: z.boolean({ invalid_type_error: "Active must be true or false" }).optional(),
};

type Input = {
  type: "percent" | "fixed";
  value: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
};

// Rules that span several fields. Returned as [field, message] so the form can show them next to the field.
function crossChecks(d: Input): Array<[string, string]> {
  const issues: Array<[string, string]> = [];
  if (d.type === "percent") {
    if (!Number.isInteger(d.value)) issues.push(["value", "Percentage must be a whole number"]);
    else if (d.value < 1 || d.value > 100) issues.push(["value", "Percentage must be between 1 and 100"]);
  } else {
    if (!hasMax2dp(d.value)) issues.push(["value", "Amount can have at most two decimal places"]);
    else if (d.value > 10_000_000) issues.push(["value", "Amount is too large"]);
  }
  if (d.startsAt && d.endsAt && d.endsAt <= d.startsAt) issues.push(["endsAt", "End date must be after the start date"]);
  return issues;
}

const createSchema = z.object(baseShape).strict();
const updateSchema = z.object(baseShape).partial().strict();

function reject(res: Response, message: string, errors?: Record<string, string[] | undefined>) {
  return res.status(400).json({ status: "error", message, ...(errors ? { errors } : {}) });
}

function zodReject(res: Response, error: z.ZodError) {
  return reject(res, error.issues[0]?.message || "Please check the form and try again.", error.flatten().fieldErrors as any);
}

function serialize(c: CouponRow) {
  return {
    id: c.id,
    code: c.code,
    type: c.type === "PERCENTAGE" ? "percent" : "fixed",
    value: c.type === "PERCENTAGE" ? percentOf(c.value) : c.value / 100,
    description: c.description,
    minSubtotal: c.minSubtotalMinor != null ? c.minSubtotalMinor / 100 : null,
    usageLimit: c.maxRedemptions,
    usageCount: c.redemptionsCount,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    active: c.status === "Active",
    state: couponState(c),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

const STATES = ["Active", "Disabled", "Scheduled", "Expired", "Exhausted"];

adminCouponsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (status && !STATES.includes(status)) {
      return reject(res, `Status must be one of ${STATES.join(", ")}`);
    }
    const rows = await prisma.coupon.findMany({
      where: search
        ? { OR: [{ code: { contains: search, mode: "insensitive" } }, { description: { contains: search, mode: "insensitive" } }] }
        : {},
      orderBy: { createdAt: "desc" },
    });
    const filtered = status ? rows.filter((c) => couponState(c) === status) : rows;
    const items = filtered.slice((page - 1) * limit, page * limit).map(serialize);
    return res.status(200).json({
      status: "success",
      items,
      pagination: { total: filtered.length, page, limit, totalPages: Math.ceil(filtered.length / limit) },
    });
  } catch (error) {
    console.error("[coupons] list failed", error);
    return res.status(500).json({ status: "error", message: "We could not load the coupons." });
  }
});

adminCouponsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return zodReject(res, parsed.error);
  const d = parsed.data;
  const issues = crossChecks(d);
  if (issues.length) {
    const errors: Record<string, string[]> = {};
    for (const [f, m] of issues) (errors[f] ||= []).push(m);
    return reject(res, issues[0][1], errors);
  }
  try {
    const dup = await prisma.coupon.findUnique({ where: { code: d.code } });
    if (dup) {
      return res.status(409).json({ status: "error", message: "A coupon with this code already exists.", errors: { code: ["This code is already in use"] } });
    }
    const created = await prisma.coupon.create({
      data: {
        code: d.code,
        type: d.type === "percent" ? "PERCENTAGE" : "FIXED_AMOUNT",
        value: d.type === "percent" ? d.value : Math.round(d.value * 100),
        description: d.description || null,
        minSubtotalMinor: d.minSubtotal ? Math.round(d.minSubtotal * 100) : null,
        maxRedemptions: d.usageLimit ?? null,
        startsAt: d.startsAt ?? null,
        endsAt: d.endsAt ?? null,
        status: d.active === false ? "Disabled" : "Active",
      },
    });
    return res.status(201).json({ status: "success", data: serialize(created) });
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ status: "error", message: "A coupon with this code already exists.", errors: { code: ["This code is already in use"] } });
    }
    console.error("[coupons] create failed", error);
    return res.status(500).json({ status: "error", message: "We could not create the coupon." });
  }
});

adminCouponsRouter.patch("/:id", async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return zodReject(res, parsed.error);
  const d = parsed.data;
  if (Object.keys(d).length === 0) return reject(res, "Nothing to update.");
  try {
    const existing = await prisma.coupon.findUnique({ where: { id: idParam(req) } });
    if (!existing) return res.status(404).json({ status: "error", message: "Coupon not found." });

    const current = serialize(existing);
    const merged = {
      type: d.type ?? current.type,
      value: d.value ?? current.value,
      startsAt: d.startsAt !== undefined ? d.startsAt : existing.startsAt,
      endsAt: d.endsAt !== undefined ? d.endsAt : existing.endsAt,
    } as Input;
    // The stored value only changes with the type or value, so legacy rows are not re-validated when untouched.
    const touchesValue = d.type !== undefined || d.value !== undefined;
    const issues = crossChecks(merged).filter(([f]) => (f === "value" ? touchesValue : true));
    if (issues.length) {
      const errors: Record<string, string[]> = {};
      for (const [f, m] of issues) (errors[f] ||= []).push(m);
      return reject(res, issues[0][1], errors);
    }

    if (d.code !== undefined && d.code !== existing.code) {
      if (existing.redemptionsCount > 0) {
        return res.status(409).json({ status: "error", message: "The code cannot be changed once the coupon has been used.", errors: { code: ["Used coupons keep their code"] } });
      }
      const dup = await prisma.coupon.findUnique({ where: { code: d.code } });
      if (dup) return res.status(409).json({ status: "error", message: "A coupon with this code already exists.", errors: { code: ["This code is already in use"] } });
    }
    if (d.usageLimit != null && d.usageLimit < existing.redemptionsCount) {
      return reject(res, `Usage limit cannot be below the ${existing.redemptionsCount} times it has already been used.`, {
        usageLimit: [`Already used ${existing.redemptionsCount} times`],
      });
    }

    const data: any = {};
    if (d.code !== undefined) data.code = d.code;
    if (d.type !== undefined) data.type = d.type === "percent" ? "PERCENTAGE" : "FIXED_AMOUNT";
    if (touchesValue) data.value = merged.type === "percent" ? merged.value : Math.round(merged.value * 100);
    if (d.description !== undefined) data.description = d.description || null;
    if (d.minSubtotal !== undefined) data.minSubtotalMinor = d.minSubtotal ? Math.round(d.minSubtotal * 100) : null;
    if (d.usageLimit !== undefined) data.maxRedemptions = d.usageLimit;
    if (d.startsAt !== undefined) data.startsAt = d.startsAt;
    if (d.endsAt !== undefined) data.endsAt = d.endsAt;
    if (d.active !== undefined) data.status = d.active ? "Active" : "Disabled";

    const updated = await prisma.coupon.update({ where: { id: existing.id }, data });
    return res.status(200).json({ status: "success", data: serialize(updated) });
  } catch (error: any) {
    if (error.code === "P2002") {
      return res.status(409).json({ status: "error", message: "A coupon with this code already exists.", errors: { code: ["This code is already in use"] } });
    }
    console.error("[coupons] update failed", error);
    return res.status(500).json({ status: "error", message: "We could not update the coupon." });
  }
});

// A coupon that has been used stays on record (disable it instead); one that never was can be deleted.
adminCouponsRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.coupon.findUnique({ where: { id: idParam(req) } });
    if (!existing) return res.status(404).json({ status: "error", message: "Coupon not found." });
    if (existing.redemptionsCount > 0) {
      return res.status(409).json({
        status: "error",
        message: "This coupon has been used on orders, so it cannot be deleted. Disable it instead.",
      });
    }
    await prisma.coupon.delete({ where: { id: existing.id } });
    return res.status(200).json({ status: "success", message: "Coupon deleted." });
  } catch (error) {
    console.error("[coupons] delete failed", error);
    return res.status(500).json({ status: "error", message: "We could not delete the coupon." });
  }
});
