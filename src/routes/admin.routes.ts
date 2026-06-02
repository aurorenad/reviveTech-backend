import { Router } from "express";
import {
  getDashboardStats,
  getSustainabilityReport,
  getInventoryPrediction,
  getSystemLogs,
  getSalesSummary,
} from "../controller/admin.controller.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { UserRole } from "@prisma/client";

const router = Router();

// Stats and Predictions (restricted to Admin)
router.get("/stats", requireAuth, requireRoles([UserRole.ADMIN]), getDashboardStats);
router.get("/predictions", requireAuth, requireRoles([UserRole.ADMIN]), getInventoryPrediction);
router.get("/system-logs", requireAuth, requireRoles([UserRole.ADMIN]), getSystemLogs);
router.get("/sales-summary", requireAuth, requireRoles([UserRole.ADMIN]), getSalesSummary);

// Sustainability report (readable by any logged in system user)
router.get("/sustainability", requireAuth, getSustainabilityReport);

export default router;
