import { Router } from "express";
import {
  evaluateDeviceValuation,
  checkFinancingRisk,
  getRepairSteps,
  suggestResellPricing,
  sendSupportMessage,
} from "../controller/ai.controller.js";
import { listAiInteractions } from "../controller/ai-layer.controller.js";
import { optionalAuth, requireAuth, requireRoles } from "../middleware/auth.js";
import { UserRole } from "@prisma/client";

const router = Router();

// Endpoint access rules:
// Support Chat is accessible by anyone or logged-in users (requireAuth optional or required - let's make it optional by registering session log if authenticated).
// Valuation and repair advice are authenticated.
router.post("/support-chat", optionalAuth, sendSupportMessage); // chatbot
router.post("/valuation", requireAuth, evaluateDeviceValuation);
router.post("/finance-check", requireAuth, checkFinancingRisk);
router.post("/repair-guidance", requireAuth, requireRoles([UserRole.TECHNICIAN, UserRole.ADMIN]), getRepairSteps);
router.post(
  "/resell-pricing",
  requireAuth,
  requireRoles([UserRole.FINANCE_OFFICER, UserRole.ADMIN]),
  suggestResellPricing,
);
router.get("/interactions", requireAuth, requireRoles([UserRole.ADMIN, UserRole.SUPPORT_AGENT]), listAiInteractions);

export default router;
