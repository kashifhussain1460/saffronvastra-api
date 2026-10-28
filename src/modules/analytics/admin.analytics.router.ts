import { Router, Response } from "express";
import { AuthenticatedRequest, requireAdmin } from "../../common/auth.middleware.js";
import {
  getAnalyticsSummary,
  getSessionDetail,
  getRecentSessions,
  getLiveActiveVisitors,
} from "./analytics.service.js";

export const adminAnalyticsRouter = Router();

// Protect all admin analytics endpoints
adminAnalyticsRouter.use(requireAdmin);

/**
 * GET /api/v1/admin/analytics/summary
 * Aggregated analytics KPI metrics, top products, route visits, and daily trends
 */
adminAnalyticsRouter.get("/summary", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const summary = await getAnalyticsSummary({
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      days: req.query.days ? Number(req.query.days) : undefined,
    });

    res.status(200).json({
      status: "success",
      data: summary,
    });
  } catch (error: any) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ status: "error", message: error.message });
    }
    console.error("[ADMIN_ANALYTICS_SUMMARY_ERROR]", error);
    res.status(500).json({
      status: "error",
      code: "ANALYTICS_SUMMARY_FAILED",
      message: error.message || "Failed to generate analytics summary",
    });
  }
});

/**
 * GET /api/v1/admin/analytics/live
 * Real-time active visitors (last 15m) and latest event stream
 */
adminAnalyticsRouter.get("/live", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const windowMinutes = req.query.window ? Number(req.query.window) : 15;
    const live = await getLiveActiveVisitors(windowMinutes);

    res.status(200).json({
      status: "success",
      data: live,
    });
  } catch (error: any) {
    console.error("[ADMIN_ANALYTICS_LIVE_ERROR]", error);
    res.status(500).json({
      status: "error",
      code: "ANALYTICS_LIVE_FAILED",
      message: error.message || "Failed to fetch live visitor data",
    });
  }
});

/**
 * GET /api/v1/admin/analytics/sessions
 * List recent visitor tracking sessions with pagination
 */
adminAnalyticsRouter.get("/sessions", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessions = await getRecentSessions({
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      convertedOnly: req.query.convertedOnly === "true",
      days: req.query.days ? Number(req.query.days) : undefined,
    });

    res.status(200).json({
      status: "success",
      data: sessions,
    });
  } catch (error: any) {
    console.error("[ADMIN_ANALYTICS_SESSIONS_ERROR]", error);
    res.status(500).json({
      status: "error",
      code: "ANALYTICS_SESSIONS_FAILED",
      message: error.message || "Failed to list analytics sessions",
    });
  }
});

/**
 * GET /api/v1/admin/analytics/sessions/:id
 * Individual session drilldown with chronological visitor activity timeline
 */
adminAnalyticsRouter.get("/sessions/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const session = await getSessionDetail(sessionId);

    if (!session) {
      return res.status(404).json({
        status: "error",
        code: "SESSION_NOT_FOUND",
        message: `Tracking session ${sessionId} not found`,
      });
    }

    res.status(200).json({
      status: "success",
      data: session,
    });
  } catch (error: any) {
    console.error("[ADMIN_ANALYTICS_SESSION_DETAIL_ERROR]", error);
    res.status(500).json({
      status: "error",
      code: "SESSION_DETAIL_FAILED",
      message: error.message || "Failed to fetch session detail",
    });
  }
});
