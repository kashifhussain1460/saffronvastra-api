import { Router } from "express";
import {
  listAdminOrders,
  getAdminOrderDetail,
  patchOrderStatus,
  postShipment,
  postOrderNote,
  patchOrderPaymentStatus,
} from "./admin.orders.controller.js";
import { requireAdmin } from "../../common/auth.middleware.js";

export const adminOrdersRouter = Router();

adminOrdersRouter.use(requireAdmin);

adminOrdersRouter.get("/", listAdminOrders);
adminOrdersRouter.get("/:id", getAdminOrderDetail);
adminOrdersRouter.patch("/:id/status", patchOrderStatus);
adminOrdersRouter.post("/:id/shipments", postShipment);
adminOrdersRouter.post("/:id/notes", postOrderNote);
adminOrdersRouter.patch("/:id/payment-status", patchOrderPaymentStatus);
