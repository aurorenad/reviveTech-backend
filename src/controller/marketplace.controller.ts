import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { DeviceStatus, ListingStatus, OrderStatus, PaymentStatus } from "@prisma/client";
import { writeAuditLog } from "../utils/audit-log.js";
import { parseOptionalString } from "../utils/request.js";

const BROWSEABLE_DEVICE_STATUSES: DeviceStatus[] = [DeviceStatus.READY, DeviceStatus.AVAILABLE];

// Smart Pricing Engine algorithm
// Adjusts the listing price based on current stock levels for the brand and the device condition.
const runSmartPricingEngine = async (deviceId: string): Promise<number> => {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return 0;

  let finalPrice = device.basePrice;

  // 1. Demand & Inventory Adjustment
  // Find total ready/active devices of the same brand
  const totalSameBrand = await prisma.device.count({
    where: {
      brand: device.brand,
      status: DeviceStatus.READY,
    },
  });

  // Simple supply-demand rule:
  // If supply is low (<= 2 items in stock), markup price by 10%.
  // If supply is high (>= 10 items in stock), discount price by 8% to clear inventory.
  if (totalSameBrand <= 2) {
    finalPrice *= 1.10;
  } else if (totalSameBrand >= 10) {
    finalPrice *= 0.92;
  }

  // 2. Trust Score Adjustment
  // High trust score (>= 95) adds 3% premium. Low trust score (< 70) discounts 10%.
  if (device.trustScore >= 95) {
    finalPrice *= 1.03;
  } else if (device.trustScore < 70) {
    finalPrice *= 0.90;
  }

  return Math.round(finalPrice * 100) / 100;
};

export const getListings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { brand, condition, minPrice, maxPrice, search } = req.query;

    const filters: any = {
      status: ListingStatus.ACTIVE,
      device: {
        status: { in: BROWSEABLE_DEVICE_STATUSES },
      },
    };

    if (brand) {
      filters.device.brand = { contains: brand as string, mode: "insensitive" };
    }

    if (condition) {
      filters.device.condition = condition;
    }

    if (minPrice || maxPrice) {
      filters.price = {};
      if (minPrice) filters.price.gte = parseFloat(minPrice as string);
      if (maxPrice) filters.price.lte = parseFloat(maxPrice as string);
    }

    if (search) {
      filters.OR = [
        { title: { contains: search as string, mode: "insensitive" } },
        { description: { contains: search as string, mode: "insensitive" } },
        { device: { model: { contains: search as string, mode: "insensitive" } } },
      ];
    }

    const listings = await prisma.marketplaceListing.findMany({
      where: filters,
      include: {
        device: {
          select: {
            id: true,
            brand: true,
            model: true,
            condition: true,
            batteryHealth: true,
            trustScore: true,
            basePrice: true,
            price: true,
            eWasteSavedKg: true,
            carbonSavedKg: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ listings });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to retrieve marketplace listings", error: error.message });
  }
};

export const getListingDetails = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);

    if (!id) {
      res.status(400).json({ message: "Listing id is required" });
      return;
    }

    let listing = await prisma.marketplaceListing.findUnique({
      where: { id },
      include: {
        device: {
          include: {
            passport: true,
          },
        },
      },
    });

    // Allow /marketplace/:deviceId when the param is a device id (e.g. wishlist links)
    if (!listing) {
      listing = await prisma.marketplaceListing.findFirst({
        where: {
          deviceId: id,
          status: ListingStatus.ACTIVE,
          device: { status: { in: BROWSEABLE_DEVICE_STATUSES } },
        },
        include: {
          device: {
            include: {
              passport: true,
            },
          },
        },
      });
    }

    if (!listing) {
      res.status(404).json({ message: "Listing not found" });
      return;
    }

    res.status(200).json({ listing });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to retrieve listing details", error: error.message });
  }
};

export const createListing = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { deviceId, title, description } = req.body;

    if (!deviceId || !title || !description) {
      res.status(400).json({ message: "Required fields: deviceId, title, description" });
      return;
    }

    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      res.status(404).json({ message: "Device not found" });
      return;
    }

    if (device.status !== DeviceStatus.READY) {
      res.status(400).json({ message: "Device is not certified. Repair and QC must be completed first." });
      return;
    }

    // Run dynamic Smart Pricing Engine to calculate optimized listing price
    const optimizedPrice = await runSmartPricingEngine(deviceId);

    const listing = await prisma.marketplaceListing.create({
      data: {
        deviceId,
        title,
        description,
        price: optimizedPrice,
      },
    });

    // Sync optimized price back to Device model
    await prisma.device.update({
      where: { id: deviceId },
      data: { price: optimizedPrice },
    });

    res.status(201).json({ message: "Listing created successfully with AI-optimized pricing", listing });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to create listing", error: error.message });
  }
};

export const updateListing = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      res.status(400).json({ message: "Listing id is required" });
      return;
    }

    const { title, description, price, status } = req.body;

    if (status && !Object.values(ListingStatus).includes(status)) {
      res.status(400).json({ message: "Invalid listing status value" });
      return;
    }

    const listing = await prisma.marketplaceListing.findUnique({ where: { id } });
    if (!listing) {
      res.status(404).json({ message: "Listing not found" });
      return;
    }

    const updatedListing = await prisma.marketplaceListing.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(price !== undefined ? { price: Number(price) } : {}),
        ...(status ? { status: status as ListingStatus } : {}),
      },
      include: { device: true },
    });

    if (price !== undefined) {
      await prisma.device.update({
        where: { id: listing.deviceId },
        data: { price: Number(price) },
      });
    }

    await writeAuditLog({
      action: "MARKETPLACE_LISTING_UPDATE",
      details: `Admin ${req.user?.email} updated marketplace listing ${id}.`,
      userId: req.user?.id || null,
    });

    res.status(200).json({ message: "Listing updated successfully", listing: updatedListing });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to update listing", error: error.message });
  }
};

export const deleteListing = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parseOptionalString(req.params["id"]);
    if (!id) {
      res.status(400).json({ message: "Listing id is required" });
      return;
    }

    const listing = await prisma.marketplaceListing.findUnique({ where: { id } });
    if (!listing) {
      res.status(404).json({ message: "Listing not found" });
      return;
    }

    await prisma.marketplaceListing.delete({ where: { id } });

    await writeAuditLog({
      action: "MARKETPLACE_LISTING_DELETE",
      details: `Admin ${req.user?.email} deleted marketplace listing ${id}.`,
      userId: req.user?.id || null,
    });

    res.status(200).json({ message: "Listing deleted successfully" });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to delete listing", error: error.message });
  }
};

export const triggerSmartPricing = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { listingId } = req.body;

    if (!listingId) {
      res.status(400).json({ message: "Required fields: listingId" });
      return;
    }

    const listing = await prisma.marketplaceListing.findUnique({ where: { id: listingId } });
    if (!listing) {
      res.status(404).json({ message: "Listing not found" });
      return;
    }

    const newPrice = await runSmartPricingEngine(listing.deviceId);

    const updatedListing = await prisma.marketplaceListing.update({
      where: { id: listingId },
      data: { price: newPrice },
    });

    await prisma.device.update({
      where: { id: listing.deviceId },
      data: { price: newPrice },
    });

    res.status(200).json({
      message: "Smart pricing recalculated and updated successfully",
      previousPrice: listing.price,
      newPrice,
      listing: updatedListing,
    });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to trigger smart pricing", error: error.message });
  }
};

export const checkout = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { deviceIds, financingApplicationId } = req.body;

    if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      res.status(400).json({ message: "deviceIds array is required" });
      return;
    }

    // Verify all devices are READY
    const devices = await prisma.device.findMany({
      where: {
        id: { in: deviceIds },
      },
    });

    if (devices.length !== deviceIds.length) {
      res.status(400).json({ message: "Some devices could not be found" });
      return;
    }

    const unavailableDevices = devices.filter((d) => !BROWSEABLE_DEVICE_STATUSES.includes(d.status));
    if (unavailableDevices.length > 0) {
      res.status(400).json({
        message: "Some devices are not ready or are already sold",
        devices: unavailableDevices.map(d => `${d.brand} ${d.model} (${d.status})`),
      });
      return;
    }

    let totalAmount = devices.reduce((sum, d) => sum + d.price, 0);

    // If financing, verify application matches and is approved
    if (financingApplicationId) {
      const financingApp = await prisma.financingApplication.findUnique({
        where: { id: financingApplicationId as string },
      });

      if (!financingApp) {
        res.status(404).json({ message: "Financing application not found" });
        return;
      }

      if (financingApp.status !== "APPROVED") {
        res.status(400).json({ message: `Financing application is not approved yet (Status: ${financingApp.status})` });
        return;
      }

      if (financingApp.customerId !== req.user!.id) {
        res.status(403).json({ message: "This financing application belongs to another customer" });
        return;
      }

      if (deviceIds.length !== 1 || financingApp.deviceId !== deviceIds[0]) {
        res.status(400).json({ message: "Financing application must match the single device being checked out" });
        return;
      }

      // Check if financing total matches checkout sum
      if (Math.abs(financingApp.totalAmount - totalAmount) > 1.0) {
        res.status(400).json({
          message: `Financing amount ($${financingApp.totalAmount}) does not match checkout sum ($${totalAmount})`,
        });
        return;
      }
    }

    // Create the Order
    const order = await prisma.order.create({
      data: {
        customerId: req.user!.id,
        totalAmount,
        status: financingApplicationId ? OrderStatus.CONFIRMED : OrderStatus.PENDING,
        paymentStatus: financingApplicationId ? PaymentStatus.PENDING : PaymentStatus.UNPAID,
        financingId: financingApplicationId || null,
        orderItems: {
          create: devices.map(d => ({
            deviceId: d.id,
            price: d.price,
          })),
        },
      },
    });

    // Mark devices as SOLD and update marketplace listings to SOLD
    await prisma.device.updateMany({
      where: { id: { in: deviceIds } },
      data: { status: DeviceStatus.SOLD },
    });

    await prisma.marketplaceListing.updateMany({
      where: { deviceId: { in: deviceIds } },
      data: { status: ListingStatus.SOLD },
    });

    const cart = await prisma.cart.findUnique({ where: { userId: req.user!.id } });
    if (cart) {
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id, deviceId: { in: deviceIds } } });
    }

    // Record digital passport ownership transfer
    for (const device of devices) {
      const passport = await prisma.devicePassport.findUnique({ where: { deviceId: device.id } });
      if (passport) {
        const ownership = JSON.parse(passport.ownershipHistory);
        ownership.push({
          date: new Date(),
          owner: `Purchased by User ${req.user!.firstName} ${req.user!.lastName} (Order ID: ${order.id})`,
        });
        await prisma.devicePassport.update({
          where: { deviceId: device.id },
          data: { ownershipHistory: JSON.stringify(ownership) },
        });
      }
    }

    await writeAuditLog({
      action: "ORDER_CHECKOUT",
      details: `User ${req.user?.email} checked out order ${order.id} for $${totalAmount}.`,
      userId: req.user?.id || null,
    });

    res.status(201).json({
      message: financingApplicationId ? "Checkout successful with approved installment financing!" : "Order placed successfully. Please complete payment.",
      order,
    });
  } catch (error: any) {
    res.status(500).json({ message: "Checkout failed", error: error.message });
  }
};
