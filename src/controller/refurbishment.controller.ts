import type { Response } from "express";
import { DeviceStatus, Prisma, RefurbishmentStatus, UserRole } from "@prisma/client";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { writeAuditLog } from "../utils/audit-log.js";
import { parseOptionalString, sendMissingFields } from "../utils/request.js";

const mapDeviceStatus = (status: RefurbishmentStatus): DeviceStatus => {
  const statusMap: Partial<Record<RefurbishmentStatus, DeviceStatus>> = {
    RECEIVED: DeviceStatus.INTAKE,
    DIAGNOSING: DeviceStatus.DIAGNOSTIC,
    REPAIRING: DeviceStatus.REPAIRING,
    QUALITY_CHECK: DeviceStatus.QC,
    CERTIFIED: DeviceStatus.READY,
    READY: DeviceStatus.READY,
  };

  return statusMap[status] ?? DeviceStatus.INTAKE;
};

export const createRefurbishment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { deviceId, technicianId, status, diagnostics, repairNotes, partsUsed } = req.body;

    if (!deviceId) {
      sendMissingFields(res, ["deviceId"]);
      return;
    }

    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      res.status(404).json({ message: "Device not found" });
      return;
    }

    const refurbishmentStatus = status && Object.values(RefurbishmentStatus).includes(status)
      ? (status as RefurbishmentStatus)
      : RefurbishmentStatus.RECEIVED;

    const refurbishment = await prisma.refurbishment.create({
      data: {
        deviceId,
        technicianId: req.user?.role === UserRole.ADMIN ? technicianId || req.user.id : req.user?.id || null,
        status: refurbishmentStatus,
        diagnostics,
        repairNotes,
        partsUsed: partsUsed ? JSON.stringify(partsUsed) : "[]",
      },
      include: { device: true, technician: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });

    await prisma.device.update({
      where: { id: deviceId },
      data: { status: mapDeviceStatus(refurbishmentStatus), repairNotes: repairNotes || diagnostics || device.repairNotes },
    });

    await writeAuditLog({
      action: "REFURBISHMENT_CREATE",
      details: `Refurbishment ${refurbishment.id} created for ${device.brand} ${device.model}.`,
      userId: req.user?.id || null,
    });

    res.status(201).json({ message: "Refurbishment record created successfully", refurbishment });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to create refurbishment record", error: error.message });
  }
};

export const listRefurbishments = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const refurbishments = await prisma.refurbishment.findMany({
      where: req.user?.role === UserRole.TECHNICIAN ? { technicianId: req.user.id } : {},
      include: {
        device: {
          include: {
            tradeInRequest: {
              select: {
                id: true,
                defects: true,
                technicianComment: true,
                technicianRepairEstimate: true,
                estimatedValue: true,
                condition: true,
                batteryHealth: true,
                finalOfferAmount: true,
              },
            },
          },
        },
        technician: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ refurbishments });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to list refurbishments", error: error.message });
  }
};

export const getRefurbishment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      sendMissingFields(res, ["id"]);
      return;
    }

    const refurbishment = await prisma.refurbishment.findUnique({
      where: { id },
      include: {
        device: {
          include: {
            passport: true,
            repairLogs: true,
            tradeInRequest: {
              select: {
                id: true,
                defects: true,
                technicianComment: true,
                technicianRepairEstimate: true,
                estimatedValue: true,
                condition: true,
                batteryHealth: true,
                finalOfferAmount: true,
                aiReasoning: true,
              },
            },
          },
        },
        technician: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    if (!refurbishment) {
      res.status(404).json({ message: "Refurbishment record not found" });
      return;
    }

    if (req.user?.role === UserRole.TECHNICIAN && refurbishment.technicianId !== req.user.id) {
      res.status(403).json({ message: "Forbidden: This refurbishment is assigned to another technician" });
      return;
    }

    res.status(200).json({ refurbishment });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to get refurbishment record", error: error.message });
  }
};

export const updateRefurbishment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    const { status, diagnostics, repairNotes, partsUsed, qcPassed, certifiedAt, technicianId } = req.body;
    if (!id) {
      sendMissingFields(res, ["id"]);
      return;
    }

    const existing = await prisma.refurbishment.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ message: "Refurbishment record not found" });
      return;
    }

    if (req.user?.role === UserRole.TECHNICIAN && existing.technicianId !== req.user.id) {
      res.status(403).json({ message: "Forbidden: This refurbishment is assigned to another technician" });
      return;
    }

    const existingDevice = await prisma.device.findUnique({ where: { id: existing.deviceId } });
    if (!existingDevice) {
      res.status(404).json({ message: "Device not found for refurbishment record" });
      return;
    }

    const nextStatus = status && Object.values(RefurbishmentStatus).includes(status)
      ? (status as RefurbishmentStatus)
      : existing.status;

    const data: Prisma.RefurbishmentUncheckedUpdateInput = {
      status: nextStatus,
    };

    if (diagnostics !== undefined) data.diagnostics = diagnostics;
    if (repairNotes !== undefined) data.repairNotes = repairNotes;
    if (technicianId !== undefined && req.user?.role === UserRole.ADMIN) data.technicianId = technicianId || null;
    if (partsUsed !== undefined) data.partsUsed = JSON.stringify(partsUsed);
    if (qcPassed !== undefined) data.qcPassed = Boolean(qcPassed);
    if (certifiedAt) data.certifiedAt = new Date(certifiedAt);
    else if (nextStatus === RefurbishmentStatus.CERTIFIED) data.certifiedAt = new Date();

    const refurbishment = await prisma.refurbishment.update({
      where: { id },
      data,
      include: { device: true, technician: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });

    await prisma.device.update({
      where: { id: existing.deviceId },
      data: { status: mapDeviceStatus(nextStatus), repairNotes: repairNotes || diagnostics || existingDevice.repairNotes },
    });

    if (nextStatus === RefurbishmentStatus.READY || nextStatus === RefurbishmentStatus.CERTIFIED) {
      const financeOfficers = await prisma.user.findMany({
        where: { role: UserRole.FINANCE_OFFICER, status: "ACTIVE" },
        select: { id: true },
      });
      if (financeOfficers.length > 0) {
        await prisma.notification.createMany({
          data: financeOfficers.map((officer) => ({
            userId: officer.id,
            type: "REPAIR_COMPLETE",
            message: `Repair complete: ${existingDevice.brand} ${existingDevice.model} is ready for pricing.`,
          })),
        });
      }
    }

    await writeAuditLog({
      action: "REFURBISHMENT_UPDATE",
      details: `Refurbishment ${id} updated to ${nextStatus}.`,
      userId: req.user?.id || null,
    });

    res.status(200).json({ message: "Refurbishment record updated successfully", refurbishment });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to update refurbishment record", error: error.message });
  }
};

export const deleteRefurbishment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      sendMissingFields(res, ["id"]);
      return;
    }

    const existing = await prisma.refurbishment.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ message: "Refurbishment record not found" });
      return;
    }

    await prisma.refurbishment.delete({ where: { id } });

    await writeAuditLog({
      action: "REFURBISHMENT_DELETE",
      details: `Refurbishment ${id} deleted.`,
      userId: req.user?.id || null,
    });

    res.status(200).json({ message: "Refurbishment record deleted successfully" });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to delete refurbishment record", error: error.message });
  }
};
