import { Router } from "express";
import {
  adminCreateUser,
  adminDeleteUser,
  adminGetUser,
  adminListUsers,
  adminUpdateRole,
  adminUpdateUser,
  getProfile,
  updateProfile,
  updateProfileAvatar,
} from "../controller/user.controller.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { avatarUpload } from "../middleware/upload.js";
import { UserRole } from "@prisma/client";

const router = Router();

router.get("/profile", requireAuth, getProfile);
router.put("/profile", requireAuth, updateProfile);
router.put("/profile/avatar", requireAuth, avatarUpload.single("avatar"), updateProfileAvatar);

// Admin-only actions
router.post("/admin/users", requireAuth, requireRoles([UserRole.ADMIN]), adminCreateUser);
router.get("/admin/users", requireAuth, requireRoles([UserRole.ADMIN]), adminListUsers);
router.get("/admin/users/:id", requireAuth, requireRoles([UserRole.ADMIN]), adminGetUser);
router.put("/admin/users/:id", requireAuth, requireRoles([UserRole.ADMIN]), adminUpdateUser);
router.delete("/admin/users/:id", requireAuth, requireRoles([UserRole.ADMIN]), adminDeleteUser);
router.put("/admin/role", requireAuth, requireRoles([UserRole.ADMIN]), adminUpdateRole);

export default router;
