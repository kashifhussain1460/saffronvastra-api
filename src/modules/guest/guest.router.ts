import { Router } from "express";
import { handleBootstrapGuest, handleMergeGuest } from "./guest.controller.js";
import { requireAuth } from "../../common/auth.middleware.js";

export const guestRouter = Router();

guestRouter.post("/bootstrap", handleBootstrapGuest);
guestRouter.post("/merge", requireAuth, handleMergeGuest);
