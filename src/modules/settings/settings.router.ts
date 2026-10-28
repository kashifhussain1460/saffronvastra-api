import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma.js";
import { requireAdmin, AuthenticatedRequest } from "../../common/auth.middleware.js";
import {
  DEFAULT_SETTINGS,
  GROUP_KEYS,
  PUBLIC_GROUPS,
  SETTING_GROUPS,
  SettingGroup,
  getAllSettings,
} from "./settings.service.js";

// Public: only the settings that are safe for any visitor to see. Always answers, falling back to defaults.
export const publicSettingsRouter = Router();
publicSettingsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const { values } = await getAllSettings();
    const data: Record<string, unknown> = {};
    for (const key of PUBLIC_GROUPS) data[key] = values[key];
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    console.error("[settings] public read failed", error);
    return res.status(500).json({ status: "error", message: "Settings are unavailable right now." });
  }
});

export const adminSettingsRouter = Router();
adminSettingsRouter.use(requireAdmin);

adminSettingsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const { values, meta } = await getAllSettings();
    return res.status(200).json({ status: "success", data: values, meta, defaults: DEFAULT_SETTINGS });
  } catch (error) {
    console.error("[settings] admin read failed", error);
    return res.status(500).json({ status: "error", message: "We could not load the settings." });
  }
});

// Body: { <group>: { ...fields } } for one or more groups. Each group is validated as a whole (merged over what is
// stored), unknown groups and unknown fields are refused, and nothing is saved unless every group is valid.
adminSettingsRouter.put("/", async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0) {
    return res.status(400).json({ status: "error", message: "Send at least one settings group to save." });
  }
  const unknown = Object.keys(body).filter((k) => !GROUP_KEYS.includes(k as SettingGroup));
  if (unknown.length) {
    return res.status(400).json({ status: "error", message: `Unknown setting: ${unknown.join(", ")}` });
  }

  try {
    const { values } = await getAllSettings();
    const toSave: Array<[SettingGroup, unknown]> = [];
    const fieldErrors: Record<string, Record<string, string[] | undefined>> = {};
    let firstMessage = "";

    for (const key of Object.keys(body) as SettingGroup[]) {
      const incoming = body[key];
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
        return res.status(400).json({ status: "error", message: `"${key}" must be an object` });
      }
      const parsed = (SETTING_GROUPS[key] as z.ZodTypeAny).safeParse({ ...values[key], ...incoming });
      if (!parsed.success) {
        fieldErrors[key] = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>;
        firstMessage ||= parsed.error.issues[0]?.message || "Please check the settings and try again.";
      } else {
        toSave.push([key, parsed.data]);
      }
    }
    if (firstMessage) {
      return res.status(400).json({ status: "error", message: firstMessage, errors: fieldErrors });
    }

    const userId = req.user?.id ?? null;
    await prisma.$transaction(
      toSave.map(([key, value]) =>
        prisma.storeSetting.upsert({
          where: { key },
          create: { key, value: value as any, updatedByUserId: userId },
          update: { value: value as any, updatedByUserId: userId },
        })
      )
    );
    const fresh = await getAllSettings();
    return res.status(200).json({ status: "success", message: "Settings saved.", data: fresh.values, meta: fresh.meta });
  } catch (error) {
    console.error("[settings] save failed", error);
    return res.status(500).json({ status: "error", message: "We could not save the settings. Please try again." });
  }
});
