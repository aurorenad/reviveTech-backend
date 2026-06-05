import { Router } from "express";
import { UserRole } from "@prisma/client";
import {
  createRefurbishment,
  deleteRefurbishment,
  getRefurbishment,
  listRefurbishments,
  updateRefurbishment,
} from "../controller/refurbishment.controller.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();

router.get(
  "/",
  requireAuth,
  requireRoles([UserRole.ADMIN, UserRole.TECHNICIAN, UserRole.FINANCE_OFFICER]),
  listRefurbishments,
);
router.get("/:id", requireAuth, requireRoles([UserRole.ADMIN, UserRole.TECHNICIAN]), getRefurbishment);
router.post("/", requireAuth, requireRoles([UserRole.ADMIN, UserRole.TECHNICIAN]), createRefurbishment);
router.put("/:id", requireAuth, requireRoles([UserRole.ADMIN, UserRole.TECHNICIAN]), updateRefurbishment);
router.delete("/:id", requireAuth, requireRoles([UserRole.ADMIN]), deleteRefurbishment);

export default router;
