import { Router } from "express";
import {
  getMe,
  updateMe,
  getAddresses,
  createAddress,
  deleteAddress,
  getAllCustomersForAdmin,
  getCustomerForAdmin,
} from "./customer.controller.js";
import { requireAuth, requireAdmin } from "../../common/auth.middleware.js";

export const customerRouter = Router();

customerRouter.use(requireAuth);

customerRouter.get("/", getMe);
customerRouter.patch("/", updateMe);
customerRouter.get("/addresses", getAddresses);
customerRouter.post("/addresses", createAddress);
customerRouter.delete("/addresses/:id", deleteAddress);

export const adminCustomerRouter = Router();
adminCustomerRouter.use(requireAdmin);
adminCustomerRouter.get("/", getAllCustomersForAdmin);
adminCustomerRouter.get("/:id", getCustomerForAdmin);
