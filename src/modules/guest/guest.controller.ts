import { Request, Response } from "express";
import { bootstrapGuest, mergeGuestDataToUser } from "./guest.service.js";
import { setGuestCookie, GUEST_COOKIE_NAME } from "../../common/cookie.utils.js";
import { AuthenticatedRequest } from "../../common/auth.middleware.js";

export async function handleBootstrapGuest(req: Request, res: Response) {
  try {
    const existingGuestId =
      req.body?.guestId ||
      (req.headers["x-guest-id"] as string) ||
      req.cookies?.[GUEST_COOKIE_NAME];

    const result = await bootstrapGuest(existingGuestId);

    // Set cookie for browser
    setGuestCookie(res, result.guestId);

    return res.status(200).json({
      status: "success",
      data: result,
    });
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      message: error.message || "Failed to bootstrap guest session",
    });
  }
}

export async function handleMergeGuest(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        status: "error",
        message: "Must be logged in to merge guest session",
      });
    }

    const guestId =
      req.body?.guestId ||
      (req.headers["x-guest-id"] as string) ||
      req.cookies?.[GUEST_COOKIE_NAME];

    if (!guestId) {
      return res.status(400).json({
        status: "error",
        message: "guestId is required for session merge",
      });
    }

    const result = await mergeGuestDataToUser(guestId, req.user.id);

    return res.status(200).json({
      status: "success",
      data: result,
    });
  } catch (error: any) {
    return res.status(500).json({
      status: "error",
      message: error.message || "Failed to merge guest session",
    });
  }
}
