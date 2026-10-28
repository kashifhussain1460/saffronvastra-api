import { Router } from "express";
import {
  getCart,
  addItem,
  updateItem,
  removeItem,
  clearCart,
} from "./cart.controller.js";

export const cartRouter = Router();

cartRouter.get("/", getCart);
cartRouter.post("/items", addItem);
cartRouter.patch("/items/:id", updateItem);
cartRouter.delete("/items/:id", removeItem);
cartRouter.delete("/", clearCart);
