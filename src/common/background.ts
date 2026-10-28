import { waitUntil } from "@vercel/functions";

/**
 * Runs work that must not delay the response (emails, notifications, audit lines).
 * On Vercel the function is frozen once the response is sent, so the work is handed to waitUntil, which keeps the
 * function alive until the promise settles. On a normal server this is just a fire-and-forget promise.
 * A failure is logged and never reaches the caller.
 */
export function background(work: Promise<unknown>): void {
  const guarded = work.catch((error) => {
    console.error("[background] task failed:", error);
  });
  try {
    waitUntil(guarded);
  } catch {
    // not running on Vercel: the promise simply continues on its own
  }
}
