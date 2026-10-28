import { Response } from "express";
import { AuthenticatedRequest } from "../../common/auth.middleware.js";
import { addCartItemSchema, updateCartItemSchema } from "./cart.schema.js";
import {
  resolveCartOwner,
  getActiveCart,
  formatCartResponse,
  addItemToCart,
  updateCartItemQuantity,
  removeCartItem,
  clearActiveCart,
} from "./cart.service.js";

function setGuestCookieIfNeeded(res: Response, owner: any) {
  if (owner.isNewGuest && owner.guestId) {
    res.cookie("saffron_guest_id", owner.guestId, {
      httpOnly: false, // Accessible to tracking & storefront client
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 365 * 24 * 60 * 60 * 1000,
      path: "/",
    });
    res.setHeader("x-guest-id", owner.guestId);
  }
}

export async function getCart(req: AuthenticatedRequest, res: Response) {
  try {
    const owner = await resolveCartOwner(req);
    setGuestCookieIfNeeded(res, owner);

    const cart = await getActiveCart(owner);
    const formatted = formatCartResponse(cart);

    return res.status(200).json({
      status: "success",
      data: formatted,
    });
  } catch (error: any) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}

export async function addItem(req: AuthenticatedRequest, res: Response) {
  try {
    const validated = addCartItemSchema.parse(req.body);
    const owner = await resolveCartOwner(req);
    setGuestCookieIfNeeded(res, owner);

    const updatedCart = await addItemToCart(owner, validated.variantId, validated.quantity);
    const formatted = formatCartResponse(updatedCart);

    return res.status(201).json({
      status: "success",
      message: "Item added to cart",
      data: formatted,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ status: "error", errors: error.errors });
    }
    const status = error.message.includes("not found") || error.message.includes("inactive") ? 404 : 500;
    return res.status(status).json({ status: "error", message: error.message });
  }
}

export async function updateItem(req: AuthenticatedRequest, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const validated = updateCartItemSchema.parse(req.body);
    const owner = await resolveCartOwner(req);
    setGuestCookieIfNeeded(res, owner);

    const updatedCart = await updateCartItemQuantity(owner, id, validated.quantity);
    const formatted = formatCartResponse(updatedCart);

    return res.status(200).json({
      status: "success",
      message: "Cart item updated",
      data: formatted,
    });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ status: "error", errors: error.errors });
    }
    const status = error.message.includes("not found") ? 404 : 500;
    return res.status(status).json({ status: "error", message: error.message });
  }
}

export async function removeItem(req: AuthenticatedRequest, res: Response) {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const owner = await resolveCartOwner(req);
    setGuestCookieIfNeeded(res, owner);

    const updatedCart = await removeCartItem(owner, id);
    const formatted = formatCartResponse(updatedCart);

    return res.status(200).json({
      status: "success",
      message: "Item removed from cart",
      data: formatted,
    });
  } catch (error: any) {
    const status = error.message.includes("not found") ? 404 : 500;
    return res.status(status).json({ status: "error", message: error.message });
  }
}

export async function clearCart(req: AuthenticatedRequest, res: Response) {
  try {
    const owner = await resolveCartOwner(req);
    setGuestCookieIfNeeded(res, owner);

    const updatedCart = await clearActiveCart(owner);
    const formatted = formatCartResponse(updatedCart);

    return res.status(200).json({
      status: "success",
      message: "Cart cleared successfully",
      data: formatted,
    });
  } catch (error: any) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}
