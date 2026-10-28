import { Router } from "express";
import { env } from "../../config/env.js";
import { getLiveness, getReadiness } from "./health.controller.js";

export const healthRouter = Router();

healthRouter.get("/live", getLiveness);
healthRouter.get("/ready", getReadiness);
healthRouter.get("/", getReadiness);

// Outside production only: lets the test suite prove that internal error details never reach a client.
if (env.NODE_ENV !== "production") {
  healthRouter.get("/error-probe", (req, res, next) => {
    if (req.query.mode === "handler") {
      return res.status(500).json({ status: "error", message: "internal detail: relation \"secret_table\" does not exist" });
    }
    next(new Error("internal detail: connection string postgres://user:pass@db"));
  });
}
