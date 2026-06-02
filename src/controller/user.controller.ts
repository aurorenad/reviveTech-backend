import type { Response } from "express";
import bcrypt from "bcryptjs";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { UserRole, UserStatus } from "@prisma/client";
import { writeAuditLog } from "../utils/audit-log.js";
import { parseOptionalString } from "../utils/request.js";
import { deliverOtpEmail } from "../utils/send-otp.js";
import { frontendRoleToBackend, frontendStatusToBackend } from "../utils/roles.js";
import { uploadProfileAvatar } from "../services/upload.service.js";

export const getProfile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    res.status(200).json({
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
        role: user.role,
        createdAt: user.createdAt,
      },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to get profile", error: error.message });
  }
};

export const updateProfile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    const { firstName, lastName, phone } = req.body;

    const normalizedPhone =
      phone === undefined
        ? user.phone
        : typeof phone === "string" && phone.trim() && phone.trim() !== "—"
          ? phone.trim()
          : null;

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(firstName !== undefined && firstName !== "" ? { firstName: String(firstName).trim() } : {}),
        ...(lastName !== undefined ? { lastName: String(lastName).trim() } : {}),
        ...(phone !== undefined ? { phone: normalizedPhone } : {}),
      },
    });

    res.status(200).json({
      message: "Profile updated successfully",
      user: {
        id: updatedUser.id,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        email: updatedUser.email,
        phone: updatedUser.phone,
        avatarUrl: updatedUser.avatarUrl,
        role: updatedUser.role,
      },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to update profile", error: error.message });
  }
};

export const updateProfileAvatar = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ message: "Avatar image is required" });
      return;
    }

    const avatarUrl = await uploadProfileAvatar({ buffer: file.buffer, originalname: file.originalname });
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        role: true,
      },
    });

    await writeAuditLog({
      action: "USER_UPDATE_AVATAR",
      details: `User ${updatedUser.email} updated profile avatar.`,
      userId: updatedUser.id,
    });

    res.status(200).json({ message: "Profile avatar updated successfully", user: updatedUser });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to update profile avatar", error: error.message });
  }
};

export const adminCreateUser = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { firstName, lastName, email, phone, password, role, sendVerificationEmail } = req.body;

    if (!firstName || !lastName || !email || !password) {
      res.status(400).json({ message: "Required fields: firstName, lastName, email, password" });
      return;
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser && existingUser.status !== UserStatus.DELETED) {
      res.status(400).json({ message: "User with this email already exists" });
      return;
    }

    const resolvedRole = role ? frontendRoleToBackend(role as string) ?? UserRole.CUSTOMER : UserRole.CUSTOMER;

    if (!Object.values(UserRole).includes(resolvedRole)) {
      res.status(400).json({ message: `Invalid role. Allowed: ${Object.values(UserRole).join(", ")}` });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const skipVerification = sendVerificationEmail !== true;

    const user = existingUser
      ? await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          firstName,
          lastName,
          phone: phone || null,
          password: hashedPassword,
          role: resolvedRole,
          status: UserStatus.ACTIVE,
          isVerified: skipVerification,
          otpCode: null,
          otpExpiresAt: null,
        },
      })
      : await prisma.user.create({
        data: {
          firstName,
          lastName,
          email,
          phone: phone || null,
          password: hashedPassword,
          role: resolvedRole,
          status: UserStatus.ACTIVE,
          isVerified: skipVerification,
        },
      });

    let devOtp: string | undefined;
    if (!skipVerification) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
      await prisma.user.update({
        where: { id: user.id },
        data: { isVerified: false, otpCode: otp, otpExpiresAt: otpExpires },
      });
      const delivery = await deliverOtpEmail(email, otp, "verification");
      devOtp = delivery.devOtp;
    }

    await writeAuditLog({
      action: "ADMIN_CREATE_USER",
      details: `Admin ${req.user?.email} created user ${email} with role ${resolvedRole}.`,
      userId: req.user?.id || null,
    });

    res.status(201).json({
      message: skipVerification
        ? "User created and can sign in immediately."
        : "User created. Verification code sent by email.",
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isVerified: skipVerification,
      },
      ...(devOtp ? { otpCode: devOtp } : {}),
    });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to create user", error: error.message });
  }
};

export const adminListUsers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const users = await prisma.user.findMany({
      where: { status: { not: UserStatus.DELETED } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        isVerified: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ users });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to list users", error: error.message });
  }
};

export const adminGetUser = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      res.status(400).json({ message: "User id is required" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        isVerified: true,
        createdAt: true,
        updatedAt: true,
        devicesOwned: true,
        financingApplications: true,
        orders: true,
        tradeInRequests: true,
      },
    });

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.status(200).json({ user });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to get user", error: error.message });
  }
};

export const adminUpdateUser = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      res.status(400).json({ message: "User id is required" });
      return;
    }

    const { firstName, lastName, phone, role, status, isVerified } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const resolvedRole = role !== undefined ? frontendRoleToBackend(role as string) : null;
    if (role !== undefined && !resolvedRole) {
      res.status(400).json({
        message: `Invalid role. Use one of: Customer, Admin, Technician, Finance Officer, Support Agent`,
      });
      return;
    }

    const resolvedStatus = status !== undefined ? frontendStatusToBackend(status as string) : null;
    if (status !== undefined && !resolvedStatus) {
      res.status(400).json({ message: `Invalid status. Use Active or Deactivated` });
      return;
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        ...(firstName !== undefined ? { firstName } : {}),
        ...(lastName !== undefined ? { lastName } : {}),
        ...(phone !== undefined ? { phone: phone || null } : {}),
        ...(resolvedRole ? { role: resolvedRole } : {}),
        ...(resolvedStatus ? { status: resolvedStatus } : {}),
        ...(isVerified !== undefined ? { isVerified: Boolean(isVerified) } : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        isVerified: true,
        updatedAt: true,
      },
    });

    await writeAuditLog({
      action: "ADMIN_UPDATE_USER",
      details: `Admin ${req.user?.email} updated user ${updatedUser.email} (role: ${updatedUser.role}, status: ${updatedUser.status}).`,
      userId: req.user?.id || null,
    });

    res.status(200).json({ message: "User updated successfully", user: updatedUser });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to update user", error: error.message });
  }
};

export const adminUpdateRole = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { userId, role } = req.body;

    if (!userId || !role) {
      res.status(400).json({ message: "Required fields: userId, role" });
      return;
    }

    if (!Object.values(UserRole).includes(role)) {
      res.status(400).json({ message: `Invalid role. Allowed roles: ${Object.values(UserRole).join(", ")}` });
      return;
    }

    const userToUpdate = await prisma.user.findUnique({ where: { id: userId } });
    if (!userToUpdate) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { role: role as UserRole },
    });

    await writeAuditLog({
      action: "ADMIN_UPDATE_ROLE",
      details: `Admin ${req.user?.email} updated role of ${updatedUser.email} to ${updatedUser.role}.`,
      userId: req.user?.id || null,
    });

    res.status(200).json({
      message: `User role updated successfully to ${updatedUser.role}`,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        role: updatedUser.role,
      },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to update user role", error: error.message });
  }
};

export const adminDeleteUser = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      res.status(400).json({ message: "User id is required" });
      return;
    }

    if (id === req.user?.id) {
      res.status(400).json({ message: "Admins cannot delete their own account from this endpoint" });
      return;
    }

    const existingUser = await prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    await prisma.$transaction(async transaction => {
      await transaction.device.updateMany({
        where: { ownerId: id },
        data: { ownerId: null },
      });
      await transaction.financingApplication.updateMany({
        where: { approvedById: id },
        data: { approvedById: null },
      });
      await transaction.payment.deleteMany({
        where: {
          OR: [
            { userId: id },
            { order: { customerId: id } },
          ],
        },
      });
      await transaction.order.deleteMany({ where: { customerId: id } });
      await transaction.financingApplication.deleteMany({ where: { customerId: id } });
      await transaction.tradeInRequest.deleteMany({ where: { userId: id } });
      await transaction.supportChatSession.deleteMany({ where: { customerId: id } });
      await transaction.repairLog.deleteMany({ where: { technicianId: id } });
      await transaction.aiInteraction.deleteMany({ where: { userId: id } });
      await transaction.user.delete({ where: { id } });
    });

    await writeAuditLog({
      action: "ADMIN_DELETE_USER",
      details: `Admin ${req.user?.email} deleted user ${existingUser.email}.`,
      userId: req.user?.id || null,
    });

    res.status(200).json({ message: "User permanently deleted from the database" });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to delete user", error: error.message });
  }
};
