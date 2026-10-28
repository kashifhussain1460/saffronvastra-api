import { Response, CookieOptions } from "express";
import { env } from "../config/env.js";

const isProduction = env.NODE_ENV === "production";

export const SESSION_COOKIE_NAME = "saffron_session";
export const GUEST_COOKIE_NAME = "saffron_guest_id";

export function getSessionCookieOptions(days = env.SESSION_MAX_AGE_DAYS): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: days * 24 * 60 * 60 * 1000,
  };
}

export function getGuestCookieOptions(days = 180): CookieOptions {
  return {
    httpOnly: false, // Accessible to client tracking scripts for event headers
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: days * 24 * 60 * 60 * 1000,
  };
}

export function setSessionCookie(res: Response, token: string, maxAgeMs?: number) {
  res.cookie(SESSION_COOKIE_NAME, token, maxAgeMs ? { ...getSessionCookieOptions(), maxAge: maxAgeMs } : getSessionCookieOptions());
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
  });
}

export function setGuestCookie(res: Response, guestId: string) {
  res.cookie(GUEST_COOKIE_NAME, guestId, getGuestCookieOptions());
}
