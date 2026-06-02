import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { DeviceStatus, FinancingStatus, RepaymentStatus } from "@prisma/client";

export const getDashboardStats = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // 1. Sales & Revenue
    const orders = await prisma.order.findMany({
      where: { status: "PAID" },
    });
    const totalSalesRevenue = orders.reduce((sum, o) => sum + o.totalAmount, 0);

    // 2. Device Counts
    const totalIntake = await prisma.device.count({ where: { status: DeviceStatus.INTAKE } });
    const totalRepairing = await prisma.device.count({ where: { status: DeviceStatus.REPAIRING } });
    const totalReady = await prisma.device.count({ where: { status: DeviceStatus.READY } });
    const totalSold = await prisma.device.count({ where: { status: DeviceStatus.SOLD } });

    // 3. Financing Stats
    const financingPending = await prisma.financingApplication.count({ where: { status: FinancingStatus.PENDING } });
    const financingApproved = await prisma.financingApplication.count({ where: { status: FinancingStatus.APPROVED } });
    const financingActiveApplications = await prisma.financingApplication.findMany({
      where: { status: FinancingStatus.APPROVED },
      include: { repayments: true },
    });

    let totalRepaymentsExpected = 0;
    let totalRepaymentsCollected = 0;
    let overdueRepaymentsCount = 0;

    financingActiveApplications.forEach(app => {
      app.repayments.forEach(repay => {
        totalRepaymentsExpected += repay.amountDue;
        totalRepaymentsCollected += repay.amountPaid;

        if (repay.status === RepaymentStatus.UNPAID && new Date() > repay.dueDate) {
          overdueRepaymentsCount++;
        }
      });
    });

    res.status(200).json({
      sales: {
        totalOrdersPaid: orders.length,
        totalRevenue: totalSalesRevenue,
      },
      inventory: {
        intakeCount: totalIntake,
        repairingCount: totalRepairing,
        readyForSaleCount: totalReady,
        soldCount: totalSold,
      },
      financing: {
        pendingApplications: financingPending,
        approvedApplications: financingApproved,
        expectedCollections: totalRepaymentsExpected,
        actualCollections: totalRepaymentsCollected,
        overduePayments: overdueRepaymentsCount,
      },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to get dashboard statistics", error: error.message });
  }
};

export const getSustainabilityReport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Sustainability Metrics aggregate
    // Calculated based on devices currently in the platform lifecycle (Intake to Sold)
    const devices = await prisma.device.findMany();

    const totalDevicesRefurbished = devices.filter(d => d.status !== DeviceStatus.TRADE_IN).length;
    const totalEWasteSavedKg = devices.reduce((sum, d) => sum + d.eWasteSavedKg, 0);
    const totalCarbonSavedKg = devices.reduce((sum, d) => sum + d.carbonSavedKg, 0);

    // Dynamic equivalency statistics
    // 1 passenger car emits about 4.6 metric tons (4600 kg) of CO2 per year.
    const equivalentCarDaysSaved = Math.round((totalCarbonSavedKg / (4600 / 365)) * 10) / 10;
    // 1 typical tree absorbs about 22kg CO2 per year.
    const equivalentTreeYearsSaved = Math.round((totalCarbonSavedKg / 22) * 10) / 10;

    res.status(200).json({
      sustainability: {
        devicesProcessedCount: totalDevicesRefurbished,
        totalEWasteSavedKg: Math.round(totalEWasteSavedKg * 100) / 100,
        totalCarbonSavedKg: Math.round(totalCarbonSavedKg * 100) / 100,
        equivalencies: {
          passengerCarDaysOffset: equivalentCarDaysSaved,
          treeAbsorptionYearsOffset: equivalentTreeYearsSaved,
        },
      },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to compile sustainability metrics", error: error.message });
  }
};

export const getInventoryPrediction = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Inventory Prediction System
    // Inspects historical sales popularity of specific brands vs active ready stock levels
    const soldDevices = await prisma.device.findMany({
      where: { status: DeviceStatus.SOLD },
    });

    const activeDevices = await prisma.device.findMany({
      where: {
        status: { in: [DeviceStatus.INTAKE, DeviceStatus.DIAGNOSTIC, DeviceStatus.REPAIRING, DeviceStatus.QC, DeviceStatus.READY] },
      },
    });

    // Count sales per brand
    const salesFrequency: Record<string, number> = {};
    soldDevices.forEach(d => {
      const key = `${d.brand} ${d.model}`.toLowerCase();
      salesFrequency[key] = (salesFrequency[key] || 0) + 1;
    });

    // Count current stock per brand
    const stockLevels: Record<string, number> = {};
    activeDevices.forEach(d => {
      const key = `${d.brand} ${d.model}`.toLowerCase();
      stockLevels[key] = (stockLevels[key] || 0) + 1;
    });

    // Generate recommendations
    const predictions: Array<{
      item: string;
      soldCount: number;
      currentStock: number;
      restockPriority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
      reasoning: string;
    }> = [];

    // Evaluate popular items
    Object.keys(salesFrequency).forEach(key => {
      const soldCount = salesFrequency[key] || 0;
      const currentStock = stockLevels[key] || 0;
      const formattedName = key.replace(/(^\w|\s\w)/g, m => m.toUpperCase());

      let restockPriority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" = "LOW";
      let reasoning = "";

      if (soldCount > 3 && currentStock === 0) {
        restockPriority = "CRITICAL";
        reasoning = `High customer interest detected. This item has ${soldCount} sales history with zero available replacement units in refurbishment queue.`;
      } else if (soldCount > 1 && currentStock === 0) {
        restockPriority = "HIGH";
        reasoning = `Steady demand indicators. Refurbishment queue is empty. Recommend acquisition.`;
      } else if (soldCount > currentStock * 2) {
        restockPriority = "MEDIUM";
        reasoning = `Sales velocity ($${soldCount} units) is pacing twice as fast as stock availability (${currentStock} units).`;
      } else {
        restockPriority = "LOW";
        reasoning = `Adequate stock covers historic purchase rates.`;
      }

      predictions.push({
        item: formattedName,
        soldCount,
        currentStock,
        restockPriority,
        reasoning,
      });
    });

    // Handle items never sold yet but might be low on stock
    Object.keys(stockLevels).forEach(key => {
      const soldCount = salesFrequency[key] || 0;
      const currentStock = stockLevels[key] || 0;
      const formattedName = key.replace(/(^\w|\s\w)/g, m => m.toUpperCase());

      if (soldCount === 0) {
        predictions.push({
          item: formattedName,
          soldCount: 0,
          currentStock,
          restockPriority: "LOW",
          reasoning: "Fresh inventory profile or low demand. Stock is sufficient.",
        });
      }
    });

    // Sort by priority level
    const priorityWeight = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
    predictions.sort((a, b) => (priorityWeight[b.restockPriority] || 0) - (priorityWeight[a.restockPriority] || 0));

    res.status(200).json({ predictions });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to generate inventory predictions", error: error.message });
  }
};

export const getSystemLogs = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const limitRaw = Number(_req.query["limit"] || 100);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;

    const logs = await prisma.systemLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, role: true },
        },
      },
    });

    res.status(200).json({ logs });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to fetch system logs", error: error.message });
  }
};

export const getSalesSummary = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const orders = await prisma.order.findMany({
      where: { paymentStatus: "PAID" },
      include: {
        orderItems: {
          include: {
            device: {
              select: { basePrice: true, brand: true, model: true, condition: true },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    type MonthBucket = { month: string; orders: number; revenue: number; profit: number };
    const byMonth: Record<string, MonthBucket> = {};
    for (const order of orders) {
      const month = order.createdAt.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      if (!byMonth[month]) byMonth[month] = { month, orders: 0, revenue: 0, profit: 0 };
      byMonth[month].orders += 1;
      byMonth[month].revenue += order.totalAmount;
      byMonth[month].profit += order.orderItems.reduce((sum, item) => {
        const cost = (item.device?.basePrice ?? item.price) * item.quantity;
        const earned = item.price * item.quantity;
        return sum + (earned - cost);
      }, 0);
    }

    const monthly = Object.values(byMonth);
    const rows = orders.map((order) => {
      const revenue = order.totalAmount;
      const profit = order.orderItems.reduce((sum, item) => {
        const cost = (item.device?.basePrice ?? item.price) * item.quantity;
        return sum + (item.price * item.quantity - cost);
      }, 0);
      return {
        id: order.id,
        period: order.createdAt.toISOString().slice(0, 10),
        region: "Global",
        orders: order.orderItems.reduce((s, i) => s + i.quantity, 0),
        revenue,
        profit,
        margin: revenue > 0 ? (profit / revenue) * 100 : 0,
        growth: 0,
      };
    });

    res.status(200).json({
      kpis: {
        revenue: monthly.reduce((s, m) => s + m.revenue, 0),
        orders: monthly.reduce((s, m) => s + m.orders, 0),
        profit: monthly.reduce((s, m) => s + m.profit, 0),
      },
      trends: {
        revenue: monthly.map((m) => ({ month: m.month, revenue: Math.round(m.revenue) })),
        orders: monthly.map((m) => ({ month: m.month, orders: m.orders })),
        profit: monthly.map((m) => ({ month: m.month, value: Math.round(m.profit) })),
      },
      rows,
    });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to fetch sales summary", error: error.message });
  }
};
