const express = require("express");
const { body, validationResult, param } = require("express-validator");

const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");
const { sendOrderStatusUpdateEmail } = require("../../utils/orderEmails");

const router = express.Router();

const requireAdmin = (req, res, next) => {
  if (req.user?.type !== "admin") {
    return res.status(403).json({ success: false, message: "Forbidden." });
  }
  next();
};

const ORDER_STATUS_VALUES = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "READY_FOR_DELIVERY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "REFUNDED",
];

function validateBody(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  return null;
}

function buildItemSummary(items) {
  if (!Array.isArray(items)) return "";
  return items
    .slice(0, 5)
    .map((it) => `${it.productName} (x${it.quantity})`)
    .join(", ")
    .concat(items.length > 5 ? ", …" : "");
}

router.get("/", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 10;

    const take = Number.isFinite(pageSize) ? Math.min(pageSize, 50) : 10;
    const skip = Math.max(0, (Number.isFinite(page) ? page - 1 : 0) * take);

    const status = req.query.status ? String(req.query.status) : undefined;

    const where = status ? { status: status } : {};

    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: {
        user: {
          select: { id: true, firstName: true, email: true },
        },
        items: {
          select: { productName: true, quantity: true },
        },
      },
    });

    const data = orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      paymentStatus: o.paymentStatus,
      totalAmount: o.totalAmount,
      createdAt: o.createdAt,
      customer: {
        name: o.user?.firstName || null,
        email: o.user?.email || null,
      },
      itemSummary: buildItemSummary(o.items),
    }));

    return res.json({ success: true, data });
  } catch (error) {
    console.error("Admin list orders error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get(
  "/:id",
  authMiddleware,
  requireAdmin,
  [param("id").notEmpty().withMessage("id is required")],
  async (req, res) => {
    const bodyError = validateBody(req, res);
    if (bodyError) return;

    try {
      const { id } = req.params;

      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              email: true,
              phone: true,
            },
          },
          address: true,
          items: {
            select: {
              productName: true,
              metalType: true,
              weightGrams: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
            },
          },
          statusLogs: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              status: true,
              note: true,
              changedBy: true,
              createdAt: true,
            },
          },
        },
      });

      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      }

      return res.json({
        success: true,
        data: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
          paymentMethod: order.paymentMethod,
          paymentRef: order.paymentRef,
          totalAmount: order.totalAmount,
          createdAt: order.createdAt,
          customer: {
            id: order.user?.id,
            name: order.user?.firstName,
            email: order.user?.email,
            phone: order.user?.phone,
          },
          address: order.address
            ? {
                id: order.address.id,
                fullName: order.address.fullName,
                phone: order.address.phone,
                streetAddress: order.address.street,
                city: order.address.city,
                country: order.address.country,
                notes: order.notes,
              }
            : null,
          items: order.items.map((it) => ({
            productName: it.productName,
            metalType: it.metalType,
            weightGrams: it.weightGrams,
            qty: it.quantity,
            unitPrice: it.unitPrice,
            totalPrice: it.totalPrice,
          })),
          statusLogs: order.statusLogs.map((l) => ({
            id: l.id,
            status: l.status,
            note: l.note,
            changedBy: l.changedBy,
            createdAt: l.createdAt,
          })),
        },
      });
    } catch (error) {
      console.error("Admin get order error:", error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.patch(
  "/:id/status",
  authMiddleware,
  requireAdmin,
  [
    param("id").notEmpty().withMessage("id is required"),
    body("status").isIn(ORDER_STATUS_VALUES).withMessage("Invalid status"),
    body("note").optional().isString().withMessage("note must be a string"),
  ],
  async (req, res) => {
    const bodyError = validateBody(req, res);
    if (bodyError) return;

    const { id } = req.params;
    const { status, note } = req.body;

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { id } });
        if (!order) return null;

        const orderUpdated = await tx.order.update({
          where: { id },
          data: { status },
        });

        await tx.orderStatusLog.create({
          data: {
            orderId: id,
            status,
            note: note || null,
            changedBy: req.user.id,
          },
        });

        return orderUpdated;
      });

      if (!updated) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      }

      // Trigger customer email (non-blocking)
      try {
        const orderForEmail = await prisma.order.findUnique({
          where: { id },
          include: {
            items: true,
            user: {
              select: { id: true, email: true, firstName: true, phone: true },
            },
          },
        });

        if (orderForEmail) {
          const customer = orderForEmail.user;
          const orderEmailShape = {
            ...orderForEmail,
            items: orderForEmail.items,
          };
          try {
            sendOrderStatusUpdateEmail(orderEmailShape, customer, status);
          } catch (e) {
            console.error("sendOrderStatusUpdateEmail call failed:", e);
          }
        }
      } catch (e) {
        console.error("Order status email prep failed:", e);
      }

      // Return updated order with detail needed by admin UI
      const detail = await prisma.order.findUnique({
        where: { id },
        include: {
          address: true,
          items: true,
          user: {
            select: { id: true, firstName: true, email: true, phone: true },
          },
          statusLogs: {
            orderBy: { createdAt: "asc" },
          },
        },
      });

      return res.json({
        success: true,
        data: {
          id: detail.id,
          orderNumber: detail.orderNumber,
          status: detail.status,
          paymentStatus: detail.paymentStatus,
          paymentMethod: detail.paymentMethod,
          paymentRef: detail.paymentRef,
          totalAmount: detail.totalAmount,
          createdAt: detail.createdAt,
          customer: {
            id: detail.user?.id,
            name: detail.user?.firstName,
            email: detail.user?.email,
            phone: detail.user?.phone,
          },
          address: detail.address
            ? {
                id: detail.address.id,
                fullName: detail.address.fullName,
                phone: detail.address.phone,
                streetAddress: detail.address.street,
                city: detail.address.city,
                country: detail.address.country,
                notes: detail.notes,
              }
            : null,
          items: detail.items.map((it) => ({
            productName: it.productName,
            metalType: it.metalType,
            weightGrams: it.weightGrams,
            qty: it.quantity,
            unitPrice: it.unitPrice,
            totalPrice: it.totalPrice,
          })),
          statusLogs: detail.statusLogs.map((l) => ({
            id: l.id,
            status: l.status,
            note: l.note,
            changedBy: l.changedBy,
            createdAt: l.createdAt,
          })),
        },
      });
    } catch (error) {
      console.error("Admin patch order status error:", error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
