import { Router } from "express";
import {
  handleSignup,
  handleLogin,
  handleLogout,
  handleForgotPassword,
  handleResetPassword,
  handleVerifyEmail,
  handleResendVerification,
} from "./auth.controller.js";

export const authRouter = Router();

authRouter.post("/signup", handleSignup);
authRouter.post("/login", handleLogin);
authRouter.post("/logout", handleLogout);
authRouter.post("/forgot-password", handleForgotPassword);
authRouter.post("/reset-password", handleResetPassword);
authRouter.post("/verify-email", handleVerifyEmail);
authRouter.post("/resend-verification", handleResendVerification);
