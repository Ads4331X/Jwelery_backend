const express = require("express");
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");
const { body, validationResult } = require("express-validator");
const {
  sendOrderConfirmationEmail,
  sendAdminNewOrderEmail,
} = require("../../utils/orderEmails");

const router = express.Router();

const requireCustomer = (req, res, next) => {
  if (req.user?.type !== "customer") {
    return res.status(403).json({ success: false, message: "Forbidden." });
  }
  next();
};

const computePricingFromSchema = ({ product, ratePerGram }) => {
  // Canonical formula (documented in prisma/schema.prisma):
  // metalCost     = currentRatePerGram × weightGrams
  // wastageAmt    = metalCost × (wastagePercent / 100)
  // makingAmt     = FIXED  → makingCharge
  //                 PERCENT → metalCost × (makingCharge / 100)
  // subtotal      = metalCost + wastageAmt + makingAmt
  // vatAmt        = subtotal × (vatPercent / 100)
  // FINAL PRICE   = subtotal + vatAmt

  const weightGrams = Number(product.weightGrams);
  const wastagePercent = Number(product.wastagePercent ?? 0);
  const vatPercent = Number(product.vatPercent ?? 13);
  const makingCharge = Number(product.makingCharge);
  const makingChargeType = product.makingChargeType;

  const metalCost = Number(ratePerGram) * weightGrams;
  const wastageCharge = metalCost * (wastagePercent / 100);

  let makingChargeComputed;
  if (makingChargeType === "PERCENTAGE") {
    makingChargeComputed = metalCost * (makingCharge / 100);
  } else {
    // FIXED
    makingChargeComputed = makingCharge;
  }

  const subtotal = metalCost + wastageCharge + makingChargeComputed;
  const vatAmount = subtotal * (vatPercent / 100);
  const total = subtotal + vatAmount;

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  return {
    metalCost: round2(metalCost),
    wastageCharge: round2(wastageCharge),
    makingCharge: round2(makingChargeComputed),
    vatAmount: round2(vatAmount),
    totalAmount: round2(total),
  };
};

const generateOrderNumber = async ({ prismaClient }) => {
  const year = new Date().getFullYear();
  // Avoid needing a sequential counter (no extra table). Use random suffix.
  // Retry on unique constraint.
  const random4 = () =>
    String(Math.floor(Math.random() * 10000)).padStart(4, "0");

  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = random4();
    const orderNumber = `AJ-${year}-${suffix}`;
    try {
      const exists = await prismaClient.order.findUnique({
        where: { orderNumber },
        select: { id: true },
      });
      if (exists) continue;
      return orderNumber;
    } catch (e) {
      // continue to retry
    }
  }

  // fallback: deterministic timestamp
  return `AJ-${year}-${Date.now().toString().slice(-6)}`;
};

const validateBody = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  return null;
};

router.post(
  "/",
  authMiddleware,
  requireCustomer,
  [
    body("items")
      .isArray({ min: 1 })
      .withMessage("Items must be a non-empty array"),
    body("items.*.productId")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("Each item.productId must be a non-empty string"),
    body("items.*.qty")
      .isInt({ min: 1 })
      .withMessage("Each item.qty must be an integer >= 1"),

    body("address.fullName")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("Full name is required"),
    body("address.phone")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("Phone is required"),
    body("address.streetAddress")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("Street address is required"),
    body("address.city")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("City is required"),

    body("address.deliveryNote")
      .optional()
      .isString()
      .withMessage("deliveryNote must be a string"),
  ],
  async (req, res) => {
    try {
      const bodyError = validateBody(req, res);
      if (bodyError) return;

      const userId = req.user.id;
      const { items, address } = req.body;

      const productIds = items.map((i) => i.productId);

      const products = await prisma.product.findMany({
        where: {
          id: { in: productIds },
        },
        select: {
          id: true,
          name: true,
          metalType: true,
          weightGrams: true,
          makingCharge: true,
          makingChargeType: true,
          wastagePercent: true,
          vatPercent: true,
          isActive: true,
        },
      });

      const productsById = new Map(products.map((p) => [p.id, p]));

      for (const item of items) {
        const p = productsById.get(item.productId);
        if (!p || !p.isActive) {
          return res.status(400).json({
            success: false,
            message: `Item failed: productId=${item.productId} is invalid or inactive`,
          });
        }
      }

      const metalTypes = Array.from(new Set(products.map((p) => p.metalType)));

      // Latest per metal type
      const latestRates = await Promise.all(
        metalTypes.map(async (mt) => {
          const rate = await prisma.metalRate.findFirst({
            where: { metalType: mt },
            orderBy: { createdAt: "desc" },
            select: { metalType: true, ratePerGram: true },
          });
          return rate;
        }),
      );

      const ratesByType = new Map(
        latestRates
          .filter(Boolean)
          .map((r) => [r.metalType, Number(r.ratePerGram)]),
      );

      // If any rate missing, fail
      for (const mt of metalTypes) {
        if (!ratesByType.has(mt)) {
          return res.status(500).json({
            success: false,
            message: `Metal rate missing for ${mt}`,
          });
        }
      }

      const orderItemsComputed = items.map((item) => {
        const product = productsById.get(item.productId);
        const ratePerGram = ratesByType.get(product.metalType);

        const breakdown = computePricingFromSchema({
          product,
          ratePerGram,
        });

        const qty = item.qty;
        const totalPrice = Math.round(breakdown.totalAmount * qty * 100) / 100;

        return {
          productId: product.id,
          productName: product.name,
          metalType: product.metalType,
          weightGrams: Number(product.weightGrams),
          metalRate: ratePerGram,
          makingCharge: breakdown.makingCharge,
          wastageCharge: breakdown.wastageCharge,
          vatPercent: Number(product.vatPercent ?? 13),
          unitPrice: breakdown.totalAmount,
          quantity: qty,
          totalPrice,
          metalCost: breakdown.metalCost,
        };
      });

      const totalAmount =
        Math.round(
          orderItemsComputed.reduce((sum, it) => sum + it.totalPrice, 0) * 100,
        ) / 100;

      const metalRateSnapshot = Object.fromEntries(
        latestRates
          .filter(Boolean)
          .map((r) => [r.metalType, Number(r.ratePerGram)]),
      );

      const orderNumber = await generateOrderNumber({ prismaClient: prisma });

      const addressRow = {
        userId,
        fullName: address.fullName,
        phone: address.phone,
        street: address.streetAddress,
        city: address.city,
        country: "Nepal",
        isDefault: false,
      };

      const created = await prisma.$transaction(async (tx) => {
        const createdAddress = await tx.address.create({ data: addressRow });

        const order = await tx.order.create({
          data: {
            orderNumber,
            userId,
            addressId: createdAddress.id,
            status: "PENDING",
            paymentStatus: "UNPAID",
            paymentMethod: "COD",
            paymentRef: null,
            metalCost:
              Math.round(
                orderItemsComputed.reduce(
                  (s, it) => s + it.metalCost * it.quantity,
                  0,
                ) * 100,
              ) / 100,
            makingCharge:
              Math.round(
                orderItemsComputed.reduce(
                  (s, it) => s + it.makingCharge * it.quantity,
                  0,
                ) * 100,
              ) / 100,
            wastageCharge:
              Math.round(
                orderItemsComputed.reduce(
                  (s, it) => s + it.wastageCharge * it.quantity,
                  0,
                ) * 100,
              ) / 100,
            vatAmount:
              Math.round(
                orderItemsComputed.reduce((s, it) => {
                  const vatPerUnit =
                    it.unitPrice -
                    it.unitPrice / (1 + Number(it.vatPercent ?? 13) / 100);
                  return s + vatPerUnit * it.quantity;
                }, 0) * 100,
              ) / 100,
            totalAmount,
            metalRateSnapshot,
            notes: address.deliveryNote || null,
          },
        });

        await tx.orderItem.createMany({
          data: orderItemsComputed.map((it) => ({
            orderId: order.id,
            productId: it.productId,
            productName: it.productName,
            metalType: it.metalType,
            weightGrams: it.weightGrams,
            metalRate: it.metalRate,
            makingCharge: it.makingCharge,
            wastageCharge: it.wastageCharge,
            vatPercent: it.vatPercent,
            unitPrice: it.unitPrice,
            quantity: it.quantity,
            totalPrice: it.totalPrice,
          })),
        });

        return order;
      });

      // Fire-and-forget emails (must not block response)
      try {
        const customer = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, email: true, firstName: true, phone: true },
        });

        const orderForEmail = {
          ...created,
          items: orderItemsComputed.map((it) => ({
            productId: it.productId,
            productName: it.productName,
            metalType: it.metalType,
            weightGrams: it.weightGrams,
            unitPrice: it.unitPrice,
            quantity: it.quantity,
            totalPrice: it.totalPrice,
          })),
        };

        // Wrap in try/catch regardless; email functions themselves also catch.
        try {
          sendOrderConfirmationEmail(orderForEmail, customer);
        } catch (e) {
          console.error("Order confirmation email call failed:", e);
        }

        try {
          sendAdminNewOrderEmail(orderForEmail, customer);
        } catch (e) {
          console.error("Admin new order email call failed:", e);
        }
      } catch (e) {
        console.error("Order email prep failed:", e);
      }

      return res.status(201).json({
        success: true,
        data: {
          orderNumber: created.orderNumber,
          id: created.id,
          totalAmount: created.totalAmount,
          status: created.status,
        },
      });
    } catch (error) {
      console.error("Create order error:", error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.get("/", authMiddleware, requireCustomer, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 50;

    const take = Number.isFinite(pageSize) ? Math.min(pageSize, 50) : 50;
    const skip = Math.max(0, (Number.isFinite(page) ? page - 1 : 0) * take);

    const orders = await prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: {
        items: {
          select: {
            productName: true,
            metalType: true,
            weightGrams: true,
            quantity: true,
            unitPrice: true,
          },
        },
      },
    });

    return res.json({
      success: true,
      data: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod,
        totalAmount: o.totalAmount,
        createdAt: o.createdAt,
        items: o.items.map((it) => ({
          productName: it.productName,
          metalType: it.metalType,
          weightGrams: it.weightGrams,
          qty: it.quantity,
          price: it.unitPrice,
        })),
      })),
    });
  } catch (error) {
    console.error("List orders error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/:id", authMiddleware, requireCustomer, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: { id, userId },
      include: {
        address: true,
        items: {
          select: {
            productName: true,
            metalType: true,
            weightGrams: true,
            quantity: true,
            unitPrice: true,
          },
        },
      },
    });

    if (!order) {
      // Must 404/403 if order doesn't belong to the requesting user.
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    return res.json({
      success: true,
      data: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt,
        address: order.address
          ? {
              id: order.address.id,
              fullName: order.address.fullName,
              phone: order.address.phone,
              streetAddress: order.address.street,
              city: order.address.city,
              deliveryNote: order.notes,
            }
          : null,
        items: order.items.map((it) => ({
          productName: it.productName,
          metalType: it.metalType,
          weightGrams: it.weightGrams,
          qty: it.quantity,
          price: it.unitPrice,
        })),
      },
    });
  } catch (error) {
    console.error("Get order error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
