/** An error whose message is safe to show to the person who caused it. Anything else is reported as a generic 500. */
export class AppError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const forbidden = (message = "You do not have permission to do this") => new AppError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found") => new AppError(404, "NOT_FOUND", message);
export const conflictError = (code: string, message: string) => new AppError(409, code, message);

import type { Response } from "express";

/** Writes an AppError (or ZodError) as a clean response; everything else is a logged, generic 500. */
export function sendError(res: Response, error: any, context: string) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ status: "error", code: error.code, message: error.message });
  }
  if (error?.name === "ZodError") {
    return res.status(400).json({ status: "error", code: "VALIDATION_ERROR", message: error.errors?.[0]?.message || "Invalid input", errors: error.errors });
  }
  console.error(`[${context}]`, error?.message || error);
  return res.status(500).json({ status: "error", code: "INTERNAL_ERROR", message: "Something went wrong on our side. Please try again." });
}
