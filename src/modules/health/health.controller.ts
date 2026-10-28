import { Request, Response } from "express";
import { prisma } from "../../database/prisma.js";

export async function getLiveness(req: Request, res: Response) {
  return res.status(200).json({
    status: "ok",
    service: "saffron-threads-api",
    version: "1.0.0",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

export async function getReadiness(req: Request, res: Response) {
  try {
    const startTime = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const dbLatencyMs = Date.now() - startTime;

    return res.status(200).json({
      status: "ready",
      service: "saffron-threads-api",
      version: "1.0.0",
      database: {
        status: "connected",
        provider: "postgresql",
        latencyMs: dbLatencyMs,
        tablesCount: 38,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(503).json({
      status: "unhealthy",
      service: "saffron-threads-api",
      error: error.message || "Database connection failure",
      timestamp: new Date().toISOString(),
    });
  }
}
