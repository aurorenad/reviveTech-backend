import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { AiService } from "../services/ai.service.js";
import { AiInteractionType, DeviceCondition, Prisma } from "@prisma/client";

const toJson = (value: unknown): Prisma.InputJsonValue => {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
};

export const evaluateDeviceValuation = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { brand, model, condition, batteryHealth } = req.body;

    if (!brand || !model || !condition) {
      res.status(400).json({ message: "Required fields: brand, model, condition" });
      return;
    }

    const evaluation = await AiService.evaluateDevice({
      brand,
      model,
      condition: condition as DeviceCondition,
      batteryHealth: batteryHealth !== undefined ? parseInt(batteryHealth) : 100,
    });

    await prisma.aiInteraction.create({
      data: {
        userId: req.user?.id || null,
        type: AiInteractionType.VALUATION,
        input: toJson({ brand, model, condition, batteryHealth }),
        output: toJson(evaluation),
      },
    });

    res.status(200).json({ valuation: evaluation });
  } catch (error: any) {
    res.status(500).json({ message: "AI valuation failed", error: error.message });
  }
};

export const checkFinancingRisk = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { monthlyIncome, existingDebts, requestedAmount, creditScore, employmentStatus } = req.body;

    if (monthlyIncome === undefined || existingDebts === undefined || requestedAmount === undefined || !employmentStatus) {
      res.status(400).json({
        message: "Required fields: monthlyIncome, existingDebts, requestedAmount, employmentStatus",
      });
      return;
    }

    const riskCheck = await AiService.evaluateFinancing({
      monthlyIncome: parseFloat(monthlyIncome),
      existingDebts: parseFloat(existingDebts),
      requestedAmount: parseFloat(requestedAmount),
      employmentStatus,
      ...(creditScore ? { creditScore: parseInt(creditScore) } : {}),
    });

    await prisma.aiInteraction.create({
      data: {
        userId: req.user?.id || null,
        type: AiInteractionType.FINANCING_RISK,
        input: toJson({ monthlyIncome, existingDebts, requestedAmount, creditScore, employmentStatus }),
        output: toJson(riskCheck),
      },
    });

    res.status(200).json({ evaluation: riskCheck });
  } catch (error: any) {
    res.status(500).json({ message: "AI financing check failed", error: error.message });
  }
};

export const getRepairSteps = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { brand, model, symptoms } = req.body;

    if (!brand || !model || !symptoms) {
      res.status(400).json({ message: "Required fields: brand, model, symptoms" });
      return;
    }

    const guidelines = await AiService.getRepairGuidance({
      brand,
      model,
      symptoms,
    });

    await prisma.aiInteraction.create({
      data: {
        userId: req.user?.id || null,
        type: AiInteractionType.REPAIR_GUIDANCE,
        input: toJson({ brand, model, symptoms }),
        output: toJson(guidelines),
      },
    });

    res.status(200).json({ repairGuidance: guidelines });
  } catch (error: any) {
    res.status(500).json({ message: "AI repair guidelines fetch failed", error: error.message });
  }
};

export const suggestResellPricing = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const {
      brand,
      model,
      originalCondition,
      postRepairCondition,
      batteryHealth,
      acquisitionCost,
      repairCost,
      originalAiEstimate,
      preOfferInspection,
      repairNotes,
      defects,
    } = req.body;

    if (!brand || !model || !originalCondition || acquisitionCost === undefined) {
      res.status(400).json({
        message: "Required fields: brand, model, originalCondition, acquisitionCost",
      });
      return;
    }

    const suggestion = await AiService.suggestResellPrice({
      brand,
      model,
      originalCondition: originalCondition as DeviceCondition,
      ...(postRepairCondition ? { postRepairCondition: postRepairCondition as DeviceCondition } : {}),
      batteryHealth: batteryHealth !== undefined ? parseInt(batteryHealth) : 85,
      acquisitionCost: parseFloat(acquisitionCost),
      ...(repairCost !== undefined ? { repairCost: parseFloat(repairCost) } : {}),
      ...(originalAiEstimate !== undefined ? { originalAiEstimate: parseFloat(originalAiEstimate) } : {}),
      ...(preOfferInspection ? { preOfferInspection } : {}),
      ...(repairNotes ? { repairNotes } : {}),
      ...(defects ? { defects } : {}),
    });

    await prisma.aiInteraction.create({
      data: {
        userId: req.user?.id || null,
        type: AiInteractionType.RESELL_PRICING,
        input: toJson(req.body),
        output: toJson(suggestion),
      },
    });

    res.status(200).json({ suggestion });
  } catch (error: any) {
    res.status(500).json({ message: "AI resell pricing failed", error: error.message });
  }
};

export const sendSupportMessage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { sessionId, message } = req.body;

    if (!message) {
      res.status(400).json({ message: "Required fields: message" });
      return;
    }

    let activeSessionId = sessionId;

    // Create session if not exists
    if (!activeSessionId) {
      const session = await prisma.supportChatSession.create({
        data: {
          customerId: req.user?.id || null,
        },
      });
      activeSessionId = session.id;
    } else {
      const sessionExists = await prisma.supportChatSession.findUnique({
        where: { id: activeSessionId },
      });
      if (!sessionExists) {
        const session = await prisma.supportChatSession.create({
          data: {
            customerId: req.user?.id || null,
          },
        });
        activeSessionId = session.id;
      }
    }

    const responseText = await AiService.handleSupportChat(activeSessionId, message);

    await prisma.aiInteraction.create({
      data: {
        userId: req.user?.id || null,
        sessionId: activeSessionId,
        type: AiInteractionType.SUPPORT_CHAT,
        input: toJson({ message }),
        output: toJson({ reply: responseText }),
        response: responseText,
      },
    });

    res.status(200).json({
      sessionId: activeSessionId,
      reply: responseText,
    });
  } catch (error: any) {
    res.status(500).json({ message: "AI chat message processing failed", error: error.message });
  }
};
