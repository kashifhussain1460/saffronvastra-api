import { Response } from "express";
import { AuthenticatedRequest } from "../../common/auth.middleware.js";
import { updateOrderStatusSchema, createShipmentSchema } from "./orders.schema.js";
import {
  getAdminOrders,
  getOrderDetail,
  updateOrderStatus,
  createOrderShipment,
  addOrderNote,
  updateOrderPaymentStatus,
} from "./orders.service.js";

// Not-found and conflict errors are safe to show; anything else is logged and hidden.
function sendOrderError(res: Response, error: any) {
  if (error?.message === "Order not found") {
    return res.status(404).json({ status: "error", message: "Order not found" });
  }
  if (error?.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({ status: "error", message: error.message });
  }
  console.error("[admin orders]", error);
  return res.status(500).json({ status: "error", message: "The request could not be completed." });
}

export async function listAdminOrders(req: AuthenticatedRequest, res: Response) {
  try {
    const {
      status,
      paymentStatus,
      search,
      page,
      limit,
      startDate,
      endDate,
    } = req.query;

    const result = await getAdminOrders({
      status: status ? String(status) : undefined,
      paymentStatus: paymentStatus ? String(paymentStatus) : undefined,
      search: search ? String(search) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 10,
      startDate: startDate ? String(startDate) : undefined,
      endDate: endDate ? String(endDate) : undefined,
    });

    return res.status(200).json({
      status: "success",
      ...result,
    });
  } catch (error: any) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}

export async function getAdminOrderDetail(req: AuthenticatedRequest, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const order = await getOrderDetail(id, null, true);

    return res.status(200).json({
      status: "success",
      data: order,
    });
  } catch (error: any) {
    return sendOrderError(res, error);
  }
}

export async function patchOrderStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const validated = updateOrderStatusSchema.parse(req.body);
    const actorUserId = req.user!.id;
    const reqId = (req as any).id;

    const updated = await updateOrderStatus(
      id,
      validated.status,
      validated.note || null,
      actorUserId,
      reqId
    );

    return res.status(200).json({
      status: "success",
      message: `Order fulfillment status updated to ${validated.status}`,
      data: updated,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ status: "error", errors: error.errors });
    }
    return sendOrderError(res, error);
  }
}

export async function postShipment(req: AuthenticatedRequest, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const validated = createShipmentSchema.parse(req.body);
    const actorUserId = req.user!.id;
    const reqId = (req as any).id;

    const result = await createOrderShipment(
      id,
      validated,
      actorUserId,
      reqId
    );

    return res.status(201).json({
      status: "success",
      message: "Shipment tracking created and order status advanced to Shipped",
      data: result,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ status: "error", errors: error.errors });
    }
    return sendOrderError(res, error);
  }
}

export async function postOrderNote(req: AuthenticatedRequest, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ status: "error", message: "Write a note before saving" });
    if (text.length > 1000) return res.status(400).json({ status: "error", message: "A note can be at most 1000 characters" });
    const note = await addOrderNote(id, text, req.user!.id);
    return res.status(201).json({ status: "success", data: note });
  } catch (error: any) {
    return sendOrderError(res, error);
  }
}

export async function patchOrderPaymentStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const status = req.body?.paymentStatus;
    if (typeof status !== "string" || !["Pending", "Paid", "Failed"].includes(status)) {
      return res.status(400).json({ status: "error", message: "Payment status must be Pending, Paid or Failed" });
    }
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null;
    const updated = await updateOrderPaymentStatus(id, status, note, req.user!.id, (req as any).id);
    return res.status(200).json({ status: "success", data: updated });
  } catch (error: any) {
    return sendOrderError(res, error);
  }
}
