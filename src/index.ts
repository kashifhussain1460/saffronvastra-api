import type { Express } from "express";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./database/prisma.js";
import { checkSmtp } from "./modules/email/email.service.js";
import { startPaymentReconciler } from "./modules/payments/payments.service.js";

// On Vercel the platform runs the exported app itself: no port, no timers, no signal handlers. Scheduled work comes from
// Vercel Cron (see vercel.json and modules/internal/cron.router.ts). Everywhere else this file starts a normal server.
export default app as Express;

if (!env.ON_VERCEL) startServer();

function startServer() {
  const server = app.listen(env.PORT, () => {
    console.log("===================================================================");
    console.log(`   SAFFRON THREADS: PRODUCTION API SERVICE LISTENING ON PORT ${env.PORT} `);
    console.log(`   Environment: ${env.NODE_ENV}                                     `);
    console.log(`   Liveness:    http://localhost:${env.PORT}/health/live             `);
    console.log(`   Readiness:   http://localhost:${env.PORT}/health/ready            `);
    console.log(`   API v1 Root: http://localhost:${env.PORT}/api/v1                  `);
    console.log("===================================================================");
    // report a wrong SMTP password, port or security setting at start-up, not on the first customer email
    void checkSmtp();
    // confirms open online payments and refunds with the payment provider when a webhook was missed
    startPaymentReconciler();
  });

  // Graceful Shutdown
  async function shutdown(signal: string) {
    console.log(`\n[${signal}] Initiating graceful shutdown...`);
    server.close(async () => {
      console.log("HTTP server closed.");
      try {
        await prisma.$disconnect();
        console.log("Prisma disconnected from database.");
        process.exit(0);
      } catch (err) {
        console.error("Error during disconnect:", err);
        process.exit(1);
      }
    });

    setTimeout(() => {
      console.error("Forceful shutdown after timeout.");
      process.exit(1);
    }, 10000);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Global Process Safety Handlers
  process.on("unhandledRejection", (reason: any, promise: Promise<any>) => {
    console.error("[FATAL] Unhandled Promise Rejection at:", promise, "reason:", reason);
  });

  process.on("uncaughtException", (error: Error) => {
    console.error("[FATAL] Uncaught Exception thrown:", error);
    shutdown("uncaughtException");
  });
}
