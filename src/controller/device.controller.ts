import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { DeviceCondition, DeviceStatus, ListingStatus, TradeInStatus, UserRole } from "@prisma/client";
import { AiService } from "../services/ai.service.js";
import { uploadInventoryImages, uploadTradeInImages, isCloudinaryConfigured } from "../services/upload.service.js";
import { sendTradeInDecisionEmail, sendTradeInOfferAcceptedEmail, sendTradeInPickupEmail } from "../services/email.service.js";
import { writeAuditLog } from "../utils/audit-log.js";
import { parseOptionalString } from "../utils/request.js";

const mapSellCondition = (condition: string): DeviceCondition | null => {
  const normalized = condition.trim().toUpperCase();
  if (normalized === "EXCELLENT" || normalized === "GRADE A") return DeviceCondition.EXCELLENT;
  if (normalized === "GOOD" || normalized === "GRADE B") return DeviceCondition.GOOD;
  if (normalized === "FAIR" || normalized === "GRADE C") return DeviceCondition.FAIR;
  if (normalized === "POOR" || normalized === "FOR PARTS" || normalized === "GRADE D") return DeviceCondition.POOR;
  if (Object.values(DeviceCondition).includes(normalized as DeviceCondition)) {
    return normalized as DeviceCondition;
  }
  return null;
};

// Helper to estimate carbon and e-waste offsets
const calculateSustainabilityMetrics = (brand: string, model: string) => {
  const brandLower = brand.toLowerCase();
  const modelLower = model.toLowerCase();

  let eWasteSavedKg = 0.2; // Default for phones
  let carbonSavedKg = 55.0; // Default for phones

  if (modelLower.includes("macbook") || modelLower.includes("laptop")) {
    eWasteSavedKg = 1.6;
    carbonSavedKg = 220.0;
  } else if (modelLower.includes("ipad") || modelLower.includes("tablet") || modelLower.includes("tab")) {
    eWasteSavedKg = 0.5;
    carbonSavedKg = 110.0;
  } else if (brandLower.includes("apple")) {
    carbonSavedKg = 70.0;
  } else if (brandLower.includes("samsung")) {
    carbonSavedKg = 60.0;
  }

  return { eWasteSavedKg, carbonSavedKg };
};

// Helper to compute Smart Trust Score
const calculateTrustScore = (condition: DeviceCondition, batteryHealth: number, repairHistoryCount: number) => {
  let score = 100.0;

  // Deduct based on condition
  if (condition === "EXCELLENT") score -= 5;
  else if (condition === "GOOD") score -= 12;
  else if (condition === "FAIR") score -= 22;
  else if (condition === "POOR") score -= 35;

  // Deduct for battery degradation
  if (batteryHealth < 80) {
    score -= 15;
  } else if (batteryHealth < 90) {
    score -= 5;
  }

  // Small deduction per repair log (more repairs = slightly lower trust score)
  score -= Math.min(10, repairHistoryCount * 2);

  return Math.max(30.0, Math.min(100.0, score));
};

export const intakeDevice = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { brand, model, originalSerialNumber, condition, batteryHealth, basePrice, price } = req.body;

    if (!brand || !model || !condition || basePrice === undefined || price === undefined) {
      res.status(400).json({ message: "Required fields: brand, model, condition, basePrice, price" });
      return;
    }

    const { eWasteSavedKg, carbonSavedKg } = calculateSustainabilityMetrics(brand, model);
    const trustScore = calculateTrustScore(condition, batteryHealth || 100, 0);
    const files = (req as AuthenticatedRequest & { files?: Express.Multer.File[] }).files ?? [];
    const imageUrls = files.length ? await uploadInventoryImages(files) : [];

    const device = await prisma.device.create({
      data: {
        brand,
        model,
        imageUrls: JSON.stringify(imageUrls),
        originalSerialNumber,
        condition: condition as DeviceCondition,
        status: DeviceStatus.INTAKE,
        batteryHealth: batteryHealth !== undefined ? batteryHealth : 100,
        basePrice,
        price,
        trustScore,
        eWasteSavedKg,
        carbonSavedKg,
      },
    });

    await writeAuditLog({
      action: "DEVICE_INTAKE",
      details: `Technician ${req.user?.email} registered device ${device.brand} ${device.model} (ID: ${device.id}).`,
      userId: req.user?.id || null,
    });

    res.status(201).json({ message: "Device registered in intake successfully", device });
  } catch (error: any) {
    res.status(500).json({ message: "Intake registration failed", error: error.message });
  }
};

export const listDevices = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { brand, condition, status, ownerId, search } = req.query;

    const where: any = {};
    if (brand) where.brand = { contains: brand as string, mode: "insensitive" };
    if (condition && Object.values(DeviceCondition).includes(condition as DeviceCondition)) {
      where.condition = condition as DeviceCondition;
    }
    if (status && Object.values(DeviceStatus).includes(status as DeviceStatus)) {
      where.status = status as DeviceStatus;
    }
    if (ownerId) where.ownerId = ownerId as string;
    if (search) {
      where.OR = [
        { brand: { contains: search as string, mode: "insensitive" } },
        { model: { contains: search as string, mode: "insensitive" } },
        { originalSerialNumber: { contains: search as string, mode: "insensitive" } },
      ];
    }

    const devices = await prisma.device.findMany({
      where,
      include: {
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        listings: true,
        passport: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ devices });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to list devices", error: error.message });
  }
};

export const getDevice = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      res.status(400).json({ message: "Device id is required" });
      return;
    }

    const device = await prisma.device.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        repairLogs: true,
        passport: true,
        listings: true,
        refurbishments: true,
        sustainabilityJobs: true,
      },
    });

    if (!device) {
      res.status(404).json({ message: "Device not found" });
      return;
    }

    res.status(200).json({ device });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to get device", error: error.message });
  }
};

export const updateDevice = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      res.status(400).json({ message: "Device id is required" });
      return;
    }

    const existingDevice = await prisma.device.findUnique({ where: { id }, include: { repairLogs: true } });
    if (!existingDevice) {
      res.status(404).json({ message: "Device not found" });
      return;
    }

    const {
      brand,
      model,
      originalSerialNumber,
      condition,
      status,
      batteryHealth,
      repairNotes,
      basePrice,
      price,
      ownerId,
    } = req.body;

    if (condition && !Object.values(DeviceCondition).includes(condition)) {
      res.status(400).json({ message: "Invalid condition value" });
      return;
    }

    if (status && !Object.values(DeviceStatus).includes(status)) {
      res.status(400).json({ message: "Invalid status value" });
      return;
    }

    const nextBrand = brand !== undefined ? brand : existingDevice.brand;
    const nextModel = model !== undefined ? model : existingDevice.model;
    const nextCondition = condition ? (condition as DeviceCondition) : existingDevice.condition;
    const nextBatteryHealth = batteryHealth !== undefined ? Number(batteryHealth) : existingDevice.batteryHealth;
    const { eWasteSavedKg, carbonSavedKg } = calculateSustainabilityMetrics(nextBrand, nextModel);

    const device = await prisma.device.update({
      where: { id },
      data: {
        ...(brand !== undefined ? { brand } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(originalSerialNumber !== undefined ? { originalSerialNumber: originalSerialNumber || null } : {}),
        ...(condition ? { condition: nextCondition } : {}),
        ...(status ? { status: status as DeviceStatus } : {}),
        ...(batteryHealth !== undefined ? { batteryHealth: nextBatteryHealth } : {}),
        ...(repairNotes !== undefined ? { repairNotes } : {}),
        ...(basePrice !== undefined ? { basePrice: Number(basePrice) } : {}),
        ...(price !== undefined ? { price: Number(price) } : {}),
        ...(ownerId !== undefined ? { ownerId: ownerId || null } : {}),
        trustScore: calculateTrustScore(nextCondition, nextBatteryHealth, existingDevice.repairLogs.length),
        eWasteSavedKg,
        carbonSavedKg,
      },
      include: {
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        passport: true,
        listings: true,
      },
    });

    await writeAuditLog({
      action: "DEVICE_UPDATE",
      details: `User ${req.user?.email} updated device ${device.brand} ${device.model} (${device.id}).`,
      userId: req.user?.id || null,
    });

    res.status(200).json({ message: "Device updated successfully", device });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to update device", error: error.message });
  }
};

export const deleteDevice = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      res.status(400).json({ message: "Device id is required" });
      return;
    }

    const existingDevice = await prisma.device.findUnique({ where: { id } });
    if (!existingDevice) {
      res.status(404).json({ message: "Device not found" });
      return;
    }

    await prisma.device.update({
      where: { id },
      data: { status: DeviceStatus.ARCHIVED },
    });
    await prisma.marketplaceListing.updateMany({
      where: { deviceId: id },
      data: { status: ListingStatus.INACTIVE },
    });

    await writeAuditLog({
      action: "DEVICE_DELETE",
      details: `User ${req.user?.email} deleted device ${existingDevice.brand} ${existingDevice.model} (${id}).`,
      userId: req.user?.id || null,
    });

    res.status(200).json({ message: "Device deleted successfully" });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to delete device", error: error.message });
  }
};

export const updateRepairStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { deviceId, status, diagnostics, stepsTaken, partsUsed } = req.body;

    if (!deviceId || !status || !diagnostics || !stepsTaken) {
      res.status(400).json({ message: "Required fields: deviceId, status, diagnostics, stepsTaken" });
      return;
    }

    if (status !== DeviceStatus.DIAGNOSTIC && status !== DeviceStatus.REPAIRING) {
      res.status(400).json({ message: "Repair status must be DIAGNOSTIC or REPAIRING" });
      return;
    }

    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      res.status(404).json({ message: "Device not found" });
      return;
    }

    const partsString = partsUsed ? JSON.stringify(partsUsed) : "[]";

    const repairLog = await prisma.repairLog.create({
      data: {
        deviceId,
        technicianId: req.user!.id,
        diagnostics,
        stepsTaken,
        partsUsed: partsString,
        status: status as DeviceStatus,
      },
    });

    // Update main device status and notes
    const updatedDevice = await prisma.device.update({
      where: { id: deviceId },
      data: {
        status: status as DeviceStatus,
        repairNotes: diagnostics,
      },
    });

    res.status(200).json({ message: "Repair status updated successfully", repairLog, device: updatedDevice });
  } catch (error: any) {
    res.status(500).json({ message: "Repair update failed", error: error.message });
  }
};

export const submitQcCheck = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { deviceId, checklistPassed } = req.body;

    if (!deviceId || checklistPassed === undefined) {
      res.status(400).json({ message: "Required fields: deviceId, checklistPassed" });
      return;
    }

    if (!checklistPassed) {
      res.status(400).json({ message: "Device must pass all quality control checks to update" });
      return;
    }

    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      res.status(404).json({ message: "Device not found" });
      return;
    }

    if (device.status !== DeviceStatus.DIAGNOSTIC && device.status !== DeviceStatus.REPAIRING) {
      res.status(400).json({ message: "Device must be in diagnostics or repair before quality control" });
      return;
    }

    const updatedDevice = await prisma.device.update({
      where: { id: deviceId },
      data: { status: DeviceStatus.QC },
    });

    res.status(200).json({ message: "Device successfully moved to Quality Control (QC) status", device: updatedDevice });
  } catch (error: any) {
    res.status(500).json({ message: "QC submission failed", error: error.message });
  }
};

export const certifyDevice = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { deviceId, certificationDetails } = req.body;

    if (!deviceId) {
      res.status(400).json({ message: "Required fields: deviceId" });
      return;
    }

    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      include: { repairLogs: true },
    });
    if (!device) {
      res.status(404).json({ message: "Device not found" });
      return;
    }

    if (device.status !== DeviceStatus.QC) {
      res.status(400).json({ message: "Device must pass quality control before certification" });
      return;
    }

    // Recalculate Trust Score with repair logs accounted for
    const trustScore = calculateTrustScore(device.condition, device.batteryHealth, device.repairLogs.length);

    // Create or Update Digital Passport
    const repairHistoryList = device.repairLogs.map(log => ({
      date: log.createdAt,
      diagnostics: log.diagnostics,
      stepsTaken: log.stepsTaken,
      partsUsed: JSON.parse(log.partsUsed),
    }));

    const batteryHistoryList = [
      { date: device.createdAt, health: device.batteryHealth }
    ];

    const ownershipHistoryList = [
      { date: device.createdAt, owner: "Platform Intake" }
    ];

    const passport = await prisma.devicePassport.upsert({
      where: { deviceId },
      create: {
        deviceId,
        repairHistory: JSON.stringify(repairHistoryList),
        batteryHealthHistory: JSON.stringify(batteryHistoryList),
        ownershipHistory: JSON.stringify(ownershipHistoryList),
        certificationDetails: certificationDetails || "Certified Genuine Refurbished - 100% functional review completed.",
      },
      update: {
        repairHistory: JSON.stringify(repairHistoryList),
        certificationDetails: certificationDetails || "Certified Genuine Refurbished - 100% functional review completed.",
      },
    });

    const updatedDevice = await prisma.device.update({
      where: { id: deviceId },
      data: {
        status: DeviceStatus.READY,
        trustScore,
      },
    });

    await writeAuditLog({
      action: "DEVICE_CERTIFY",
      details: `Technician ${req.user?.email} certified device ${device.brand} ${device.model} (Passport ID: ${passport.id}).`,
      userId: req.user?.id || null,
    });

    res.status(200).json({
      message: "Device certified successfully, digital passport issued",
      device: updatedDevice,
      passport,
    });
  } catch (error: any) {
    res.status(500).json({ message: "Certification failed", error: error.message });
  }
};

export const getDigitalPassport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const deviceId = parseOptionalString(req.params["deviceId"]);

    if (!deviceId) {
      res.status(400).json({ message: "deviceId parameter is required" });
      return;
    }

    const passport = await prisma.devicePassport.findUnique({
      where: { deviceId },
    });

    if (!passport) {
      res.status(404).json({ message: "Digital passport not found for this device" });
      return;
    }

    const device = await prisma.device.findUnique({ where: { id: passport.deviceId } });
    if (!device) {
      res.status(404).json({ message: "Device not found for this passport" });
      return;
    }

    res.status(200).json({
      passport: {
        id: passport.id,
        deviceId: passport.deviceId,
        deviceDetails: {
          brand: device.brand,
          model: device.model,
          condition: device.condition,
          status: device.status,
          batteryHealth: device.batteryHealth,
          trustScore: device.trustScore,
          eWasteSavedKg: device.eWasteSavedKg,
          carbonSavedKg: device.carbonSavedKg,
        },
        repairHistory: JSON.parse(passport.repairHistory),
        batteryHealthHistory: JSON.parse(passport.batteryHealthHistory),
        ownershipHistory: JSON.parse(passport.ownershipHistory),
        certificationDetails: passport.certificationDetails,
        certifiedAt: passport.certifiedAt,
      },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to retrieve passport", error: error.message });
  }
};

export const submitTradeIn = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const {
      brand,
      model,
      condition,
      category,
      batteryHealth,
      askingPrice,
      defects,
      storage,
      ram,
      color,
      location,
    } = req.body;

    if (!brand || !model || !condition) {
      res.status(400).json({ message: "Required fields: brand, model, condition" });
      return;
    }

    const deviceCondition = mapSellCondition(String(condition));
    if (!deviceCondition) {
      res.status(400).json({ message: "Invalid condition value" });
      return;
    }

    const parsedBattery = batteryHealth !== undefined && batteryHealth !== ""
      ? parseInt(String(batteryHealth), 10)
      : 85;
    const battery = Number.isFinite(parsedBattery) ? Math.min(100, Math.max(0, parsedBattery)) : 85;

    const files = (req as AuthenticatedRequest & { files?: Express.Multer.File[] }).files ?? [];
    let imageUrls: string[] = [];
    if (files.length > 0) {
      if (!isCloudinaryConfigured()) {
        res.status(503).json({ message: "Image upload is not configured on the server" });
        return;
      }
      imageUrls = await uploadTradeInImages(files);
    }

    const evaluation = await AiService.evaluateDevice({
      brand: String(brand),
      model: String(model),
      condition: deviceCondition,
      batteryHealth: battery,
    });
    const customerValuationMessage =
      `According to the information you gave, we suggest an estimated offer of $${evaluation.tradeInRecommendation}. ` +
      `Please bring your device to our technician for physical inspection to confirm that the provided details are accurate before final approval.`;

    const tradeIn = await prisma.tradeInRequest.create({
      data: {
        userId: req.user!.id,
        brand: String(brand),
        model: String(model),
        category: category ? String(category) : null,
        condition: deviceCondition,
        batteryHealth: battery,
        askingPrice: askingPrice !== undefined && askingPrice !== "" ? parseFloat(String(askingPrice)) : null,
        estimatedValue: evaluation.tradeInRecommendation,
        imageUrls: JSON.stringify(imageUrls),
        defects: defects ? String(defects) : null,
        storage: storage ? String(storage) : null,
        ram: ram ? String(ram) : null,
        color: color ? String(color) : null,
        location: location ? String(location) : null,
        aiReasoning: customerValuationMessage,
        status: TradeInStatus.PENDING,
      },
      include: {
        user: { select: { firstName: true, lastName: true, email: true, phone: true } },
      },
    });

    await writeAuditLog({
      action: "TRADE_IN_SUBMIT",
      details: `Customer ${req.user?.email} submitted sell request for ${brand} ${model} (ID: ${tradeIn.id}).`,
      userId: req.user?.id || null,
    });

    res.status(201).json({
      message: "Sell request submitted. Our finance team will review it shortly.",
      tradeIn,
      aiEvaluation: {
        ...evaluation,
        reasoning: customerValuationMessage,
      },
      aiEnabled: AiService.isLlmConfigured(),
    });
  } catch (error: any) {
    res.status(500).json({ message: "Trade-in submission failed", error: error.message });
  }
};

export const listTradeIns = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const isStaff =
      req.user?.role === UserRole.ADMIN ||
      req.user?.role === UserRole.FINANCE_OFFICER ||
      req.user?.role === UserRole.TECHNICIAN;
    const tradeIns = await prisma.tradeInRequest.findMany({
      where: isStaff ? {} : { userId: req.user!.id },
      include: {
        user: {
          select: { firstName: true, lastName: true, email: true }
        },
        technician: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" }
    });

    res.status(200).json({ tradeIns });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to retrieve trade-in requests", error: error.message });
  }
};

export const getTradeIn = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      res.status(400).json({ message: "Trade-in request id is required" });
      return;
    }

    const tradeIn = await prisma.tradeInRequest.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        technician: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    if (!tradeIn) {
      res.status(404).json({ message: "Trade-in request not found" });
      return;
    }

    const canView =
      req.user?.role === UserRole.ADMIN ||
      req.user?.role === UserRole.FINANCE_OFFICER ||
      req.user?.role === UserRole.TECHNICIAN ||
      tradeIn.userId === req.user?.id;
    if (!canView) {
      res.status(403).json({ message: "Forbidden: You can only view your own trade-in requests" });
      return;
    }

    res.status(200).json({ tradeIn });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to retrieve trade-in request", error: error.message });
  }
};

export const technicianReviewTradeIn = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const tradeInId = parseOptionalString(req.params["id"]) || req.body.tradeInId;
    const { technicianComment, repairEstimate } = req.body;

    if (!tradeInId || !technicianComment || !String(technicianComment).trim() || repairEstimate === undefined) {
      res.status(400).json({ message: "Required fields: tradeInId, technicianComment, repairEstimate" });
      return;
    }
    const parsedEstimate = Number(repairEstimate);
    if (!Number.isFinite(parsedEstimate) || parsedEstimate < 0) {
      res.status(400).json({ message: "repairEstimate must be a valid number >= 0" });
      return;
    }

    const tradeIn = await prisma.tradeInRequest.findUnique({ where: { id: tradeInId } });
    if (!tradeIn) {
      res.status(404).json({ message: "Trade-in request not found" });
      return;
    }

    if (tradeIn.status !== TradeInStatus.PENDING) {
      res.status(400).json({ message: "Only pending sell requests can be technician-reviewed" });
      return;
    }

    const updatedTradeIn = await prisma.tradeInRequest.update({
      where: { id: tradeInId },
      data: {
        technicianId: req.user?.id || null,
        technicianComment: String(technicianComment).trim(),
        technicianRepairEstimate: parsedEstimate,
        technicianReviewedAt: new Date(),
      },
      include: {
        user: { select: { firstName: true, lastName: true, email: true, phone: true } },
        technician: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    await writeAuditLog({
      action: "TRADE_IN_TECH_REVIEW",
      details: `Technician ${req.user?.email} reviewed sell request ${tradeInId}.`,
      userId: req.user?.id || null,
    });

    res.status(200).json({ message: "Technician review saved", tradeIn: updatedTradeIn });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to save technician review", error: error.message });
  }
};

export const reviewTradeIn = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const tradeInId = parseOptionalString(req.params["id"]) || req.body.tradeInId;
    const { status, officerNotes, finalOfferAmount } = req.body;

    if (!tradeInId || !status) {
      res.status(400).json({ message: "Required fields: tradeInId, status" });
      return;
    }

    const allowedReviewStatuses: TradeInStatus[] = [TradeInStatus.APPROVED, TradeInStatus.REJECTED];
    if (!allowedReviewStatuses.includes(status as TradeInStatus)) {
      res.status(400).json({ message: "Status must be APPROVED or REJECTED" });
      return;
    }

    const tradeIn = await prisma.tradeInRequest.findUnique({ where: { id: tradeInId } });
    if (!tradeIn) {
      res.status(404).json({ message: "Trade-in request not found" });
      return;
    }

    if (tradeIn.status !== TradeInStatus.PENDING) {
      res.status(400).json({ message: "Only pending sell requests can be reviewed" });
      return;
    }

    if (!tradeIn.technicianComment || tradeIn.technicianRepairEstimate === null) {
      res.status(400).json({ message: "Technician must add test comment and repair estimate before finance decision" });
      return;
    }

    let parsedFinalOffer: number | null = null;
    if (status === TradeInStatus.APPROVED) {
      if (finalOfferAmount === undefined || finalOfferAmount === null || finalOfferAmount === "") {
        res.status(400).json({ message: "finalOfferAmount is required when approving a sell request" });
        return;
      }
      const n = Number(finalOfferAmount);
      if (!Number.isFinite(n) || n <= 0) {
        res.status(400).json({ message: "finalOfferAmount must be a positive number" });
        return;
      }
      parsedFinalOffer = n;
    }

    const updatedTradeIn = await prisma.tradeInRequest.update({
      where: { id: tradeInId },
      data: {
        status: status as TradeInStatus,
        finalOfferAmount: status === TradeInStatus.APPROVED ? parsedFinalOffer : null,
        decisionAt: new Date(),
        ...(officerNotes !== undefined ? { officerNotes: officerNotes ? String(officerNotes) : null } : {}),
      },
      include: {
        user: { select: { firstName: true, lastName: true, email: true, phone: true } },
        technician: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    await writeAuditLog({
      action: "TRADE_IN_REVIEW",
      details: `Officer ${req.user?.email} marked sell request ${tradeInId} as ${status}.`,
      userId: req.user?.id || null,
    });

    try {
      if (updatedTradeIn.user?.email) {
        const customerName =
          `${updatedTradeIn.user?.firstName || ""} ${updatedTradeIn.user?.lastName || ""}`.trim() || "Customer";
        await sendTradeInDecisionEmail({
          to: updatedTradeIn.user.email,
          customerName,
          deviceLabel: `${updatedTradeIn.brand} ${updatedTradeIn.model}`,
          status: status as "APPROVED" | "REJECTED",
          finalOfferAmount: updatedTradeIn.finalOfferAmount,
          officerNotes: updatedTradeIn.officerNotes,
          technicianComment: updatedTradeIn.technicianComment,
        });
      }
    } catch (emailError) {
      console.error("Failed to send trade-in decision email:", emailError);
    }

    res.status(200).json({ message: `Trade-in request marked as ${status}`, tradeIn: updatedTradeIn });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to review trade-in", error: error.message });
  }
};

export const customerDecisionTradeIn = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const tradeInId = parseOptionalString(req.params["id"]) || req.body.tradeInId;
    const { decision } = req.body;

    if (!tradeInId || !decision) {
      res.status(400).json({ message: "Required fields: tradeInId, decision" });
      return;
    }

    const normalizedDecision = String(decision).toUpperCase();
    if (normalizedDecision !== "APPROVE" && normalizedDecision !== "REJECT") {
      res.status(400).json({ message: "decision must be APPROVE or REJECT" });
      return;
    }

    const tradeIn = await prisma.tradeInRequest.findUnique({
      where: { id: tradeInId },
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    if (!tradeIn) {
      res.status(404).json({ message: "Trade-in request not found" });
      return;
    }
    if (tradeIn.userId !== req.user?.id) {
      res.status(403).json({ message: "Forbidden: You can only decide your own offer" });
      return;
    }
    if (tradeIn.status !== TradeInStatus.APPROVED || !tradeIn.finalOfferAmount) {
      res.status(400).json({ message: "Offer is not ready for customer decision yet" });
      return;
    }
    if (tradeIn.customerOfferDecision) {
      res.status(400).json({ message: "Customer decision already recorded" });
      return;
    }

    const accept = normalizedDecision === "APPROVE";
    const nextStatus = accept ? TradeInStatus.COMPLETED : TradeInStatus.REJECTED;
    const updatedTradeIn = await prisma.tradeInRequest.update({
      where: { id: tradeInId },
      data: {
        customerOfferDecision: accept ? "APPROVED" : "REJECTED",
        customerDecisionAt: new Date(),
        status: nextStatus,
      },
      include: {
        user: { select: { firstName: true, lastName: true, email: true, phone: true } },
        technician: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    if (accept) {
      const { eWasteSavedKg, carbonSavedKg } = calculateSustainabilityMetrics(tradeIn.brand, tradeIn.model);
      await prisma.device.create({
        data: {
          brand: tradeIn.brand,
          model: tradeIn.model,
          condition: tradeIn.condition,
          status: DeviceStatus.INTAKE,
          basePrice: tradeIn.finalOfferAmount,
          price: tradeIn.finalOfferAmount * 1.3,
          ownerId: null,
          trustScore: calculateTrustScore(tradeIn.condition, tradeIn.batteryHealth ?? 85, 0),
          eWasteSavedKg,
          carbonSavedKg,
          repairNotes: `Repair pipeline initiated from accepted sell offer (${tradeIn.id}).`,
        },
      });
      if (updatedTradeIn.user?.email) {
        const customerName =
          `${updatedTradeIn.user.firstName || ""} ${updatedTradeIn.user.lastName || ""}`.trim() || "Customer";
        await sendTradeInOfferAcceptedEmail({
          to: updatedTradeIn.user.email,
          customerName,
          deviceLabel: `${updatedTradeIn.brand} ${updatedTradeIn.model}`,
          finalOfferAmount: updatedTradeIn.finalOfferAmount || tradeIn.finalOfferAmount || 0,
        });
      }
    } else if (updatedTradeIn.user?.email) {
      const customerName =
        `${updatedTradeIn.user.firstName || ""} ${updatedTradeIn.user.lastName || ""}`.trim() || "Customer";
      await sendTradeInPickupEmail({
        to: updatedTradeIn.user.email,
        customerName,
        deviceLabel: `${updatedTradeIn.brand} ${updatedTradeIn.model}`,
      });
    }

    await writeAuditLog({
      action: "TRADE_IN_CUSTOMER_DECISION",
      details: `Customer ${req.user?.email} ${accept ? "approved" : "rejected"} sell offer ${tradeInId}.`,
      userId: req.user?.id || null,
    });

    res.status(200).json({
      message: accept
        ? "Offer approved. Device moved to technician repair process."
        : "Offer rejected. Pickup instructions were sent to your email.",
      tradeIn: updatedTradeIn,
    });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to save customer decision", error: error.message });
  }
};

export const deleteTradeIn = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      res.status(400).json({ message: "Trade-in request id is required" });
      return;
    }

    const tradeIn = await prisma.tradeInRequest.findUnique({ where: { id } });
    if (!tradeIn) {
      res.status(404).json({ message: "Trade-in request not found" });
      return;
    }

    const canDelete = req.user?.role === UserRole.ADMIN || tradeIn.userId === req.user?.id;
    if (!canDelete) {
      res.status(403).json({ message: "Forbidden: You can only delete your own trade-in requests" });
      return;
    }

    await prisma.tradeInRequest.delete({ where: { id } });

    res.status(200).json({ message: "Trade-in request deleted successfully" });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to delete trade-in request", error: error.message });
  }
};
