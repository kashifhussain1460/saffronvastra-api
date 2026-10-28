import { Router, Response } from "express";
import { AuthenticatedRequest } from "../../common/auth.middleware.js";
import {
  resolveTrackingSession,
  ingestBatchEvents,
  recordHeartbeat,
} from "./analytics.service.js";

export const analyticsRouter = Router();

/**
 * GET /api/v1/analytics/session
 * Resolve or initialize tracking session for current visitor (guest or user)
 */
analyticsRouter.get("/session", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const trackingSessionId =
      (req.headers["x-tracking-session-id"] as string) ||
      req.cookies?.["saffron_tracking_session_id"] ||
      (req.query.sessionId as string);

    const guestId =
      req.guestId ||
      (req.headers["x-guest-id"] as string) ||
      req.cookies?.["saffron_guest_id"] ||
      (req.query.guestId as string);

    const session = await resolveTrackingSession({
      trackingSessionId,
      guestId,
      userId: req.user?.id,
    });

    res.status(200).json({
      status: "success",
      data: {
        trackingSessionId: session.id,
        guestProfileId: session.guestProfileId,
        userId: session.userId,
        startedAt: session.startedAt,
      },
    });
  } catch (error: any) {
    console.error("[ANALYTICS_SESSION_ERROR]", error);
    res.status(500).json({
      status: "error",
      code: "ANALYTICS_SESSION_FAILED",
      message: error.message || "Failed to resolve tracking session",
    });
  }
});

/**
 * POST /api/v1/analytics/events
 * Ingest a batch of events with client UUID deduplication
 */
analyticsRouter.post("/events", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const trackingSessionId =
      req.body.trackingSessionId ||
      (req.headers["x-tracking-session-id"] as string) ||
      req.cookies?.["saffron_tracking_session_id"];

    const guestId =
      req.body.guestId ||
      req.guestId ||
      (req.headers["x-guest-id"] as string) ||
      req.cookies?.["saffron_guest_id"];

    const events = Array.isArray(req.body.events)
      ? req.body.events
      : req.body.event
      ? [req.body.event]
      : [];

    if (events.length === 0) {
      return res.status(400).json({
        status: "error",
        code: "INVALID_EVENTS_PAYLOAD",
        message: "No events provided in request body. 'events' array is required.",
      });
    }

    const result = await ingestBatchEvents({
      trackingSessionId,
      guestId,
      userId: req.user?.id,
      events,
    });

    res.status(200).json({
      status: "success",
      message: `Ingested ${result.accepted} events (${result.duplicates} duplicates skipped)`,
      data: result,
    });
  } catch (error: any) {
    console.error("[ANALYTICS_INGEST_ERROR]", error);
    res.status(500).json({
      status: "error",
      code: "ANALYTICS_INGEST_FAILED",
      message: error.message || "Failed to ingest analytics events",
    });
  }
});

/**
 * POST /api/v1/analytics/heartbeat
 * Accumulate active foreground seconds for a visitor's session
 */
analyticsRouter.post("/heartbeat", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const trackingSessionId =
      req.body.trackingSessionId ||
      (req.headers["x-tracking-session-id"] as string) ||
      req.cookies?.["saffron_tracking_session_id"];

    const guestId =
      req.body.guestId ||
      req.guestId ||
      (req.headers["x-guest-id"] as string) ||
      req.cookies?.["saffron_guest_id"];

    const seconds = Number(req.body.seconds) || 15;
    const path = req.body.path;
    const routeTemplate = req.body.routeTemplate;

    const result = await recordHeartbeat({
      trackingSessionId,
      guestId,
      userId: req.user?.id,
      seconds,
      path,
      routeTemplate,
    });

    res.status(200).json({
      status: "success",
      message: `Heartbeat recorded (+${result.recordedSeconds}s)`,
      data: result,
    });
  } catch (error: any) {
    console.error("[ANALYTICS_HEARTBEAT_ERROR]", error);
    res.status(500).json({
      status: "error",
      code: "ANALYTICS_HEARTBEAT_FAILED",
      message: error.message || "Failed to record heartbeat",
    });
  }
});
