const express = require("express");
const crypto = require("crypto");
const prisma = require("../config/prisma");
const { createEsewaSignature } = require("../utils/signature");
const authMiddleware = require("../middleware/authMiddleware");
const {
  sendOrderConfirmationEmail,
  sendAdminNewOrderEmail,
  sendLowStockAlertEmail,
} = require("../utils/orderEmails");

const LOW_STOCK_THRESHOLD = 5;

const router = express.Router();
const secret = process.env.ESEWA_SECRET;

const esewaConfig = {
  merchandID: "EPAYTEST",
  esewaPaymentUrl: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
  secret: process.env.ESEWA_SECRET,
};

const computePricingFromSchema = ({ product, ratePerGram }) => {
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

  return `AJ-${year}-${Date.now().toString().slice(-6)}`;
};

const requireCustomer = (req, res, next) => {
  if (req.user?.type !== "customer") {
    return res.status(403).json({ success: false, message: "Forbidden." });
  }
  next();
};

/**
 * POST /esewa/initiate
 *
 * Accept cart items + address from frontend (NOT an orderId).
 * Validates stock, computes pricing, creates a PendingPayment record.
 * Returns gateway URL + form fields + signature.
 * NO order is created at this point.
 */
router.post("/initiate", authMiddleware, requireCustomer, async (req, res) => {
  try {
    const { items, address, addressId } = req.body;
    const userId = req.user.id;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Items must be a non-empty array" });
    }

    // Validate address fields if no addressId
    if (!addressId) {
      if (
        !address?.fullName ||
        !address?.phone ||
        !address?.streetAddress ||
        !address?.city
      ) {
        return res.status(400).json({
          success: false,
          message: "Shipping address is required",
        });
      }
    }

    // Fetch products
    const productIds = items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
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
        stock: true,
      },
    });

    const productsById = new Map(products.map((p) => [p.id, p]));

    // Validate stock
    for (const item of items) {
      const p = productsById.get(item.productId);
      if (!p || !p.isActive) {
        return res.status(400).json({
          success: false,
          message: `Item failed: productId=${item.productId} is invalid or inactive`,
        });
      }
      if (Number(p.stock ?? 0) < (item.qty || 1)) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for "${p.name}". Available: ${p.stock}`,
        });
      }
    }

    // Get metal rates
    const metalTypes = Array.from(new Set(products.map((p) => p.metalType)));
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

    for (const mt of metalTypes) {
      if (!ratesByType.has(mt)) {
        return res
          .status(500)
          .json({ success: false, message: `Metal rate missing for ${mt}` });
      }
    }

    // Compute pricing for each item
    const orderItemsComputed = items.map((item) => {
      const product = productsById.get(item.productId);
      const ratePerGram = ratesByType.get(product.metalType);
      const qty = item.qty || 1;
      const breakdown = computePricingFromSchema({ product, ratePerGram });
      const totalPrice = Math.round(breakdown.totalAmount * qty * 100) / 100;

      return {
        ...item,
        productId: product.id,
        productName: product.name,
        metalType: product.metalType,
        weightGrams: Number(product.weightGrams),
        metalRate: ratePerGram,
        makingCharge: breakdown.makingCharge,
        wastageCharge: breakdown.wastageCharge,
        vatPercent: Number(product.vatPercent ?? 13),
        vatAmountPerUnit: breakdown.vatAmount,
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

    // Generate transaction UUID
    const transaction_uuid = `PP-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    // Create PendingPayment
    await prisma.pendingPayment.create({
      data: {
        transactionUuid: transaction_uuid,
        userId,
        items: JSON.stringify(orderItemsComputed),
        addressData: JSON.stringify(address || {}),
        addressId: addressId || null,
        computedData: JSON.stringify({
          totalAmount,
          metalRateSnapshot,
          orderItemsComputed,
          products: products.map((p) => ({
            id: p.id,
            name: p.name,
            stock: p.stock,
          })),
        }),
        totalAmount,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min expiry
      },
    });

    // Build eSewa payment data
    const paymentData = {
      amount: totalAmount.toString(),
      tax_amount: "0",
      product_service_charge: "0",
      product_delivery_charge: "0",
      total_amount: totalAmount.toString(),
      product_code: esewaConfig.merchandID,
      transaction_uuid,
      success_url: `${process.env.FRONTEND_URL}/checkout/esewa/success`,
      failure_url: `${process.env.FRONTEND_URL}/checkout/esewa/failure`,
      signed_field_names: "total_amount,transaction_uuid,product_code",
    };

    const generatedSignature = createEsewaSignature({
      amount: paymentData.total_amount,
      transaction_uuid: paymentData.transaction_uuid,
      product_code: paymentData.product_code,
    });

    return res.json({
      success: true,
      gatewayUrl: esewaConfig.esewaPaymentUrl,
      fields: { ...paymentData, signature: generatedSignature },
    });
  } catch (error) {
    console.error("POST /esewa/initiate error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * GET /esewa/verify
 *
 * eSewa redirects here after successful payment with a signed `data` blob.
 * Verifies the signature, finds the PendingPayment, creates the actual order,
 * clears cart, and marks the PendingPayment as COMPLETED.
 */
router.get("/verify", async (req, res) => {
  console.log("GET /esewa/verify req.query:", req.query);

  const token = req.query.data;
  if (!token)
    return res.status(400).json({ message: "Missing token", success: false });

  const decodedData = Buffer.from(token, "base64").toString("utf-8");
  let data;
  try {
    data = JSON.parse(decodedData);
  } catch {
    return res
      .status(400)
      .json({ message: "Invalid data format", success: false });
  }

  console.log(
    "[verify] received data from eSewa:",
    JSON.stringify(data, null, 2),
  );

  // Verify eSewa signature
  const signedFields = data.signed_field_names.split(",");
  const message = signedFields.map((f) => `${f}=${data[f]}`).join(",");
  console.log("[verify] message to sign:", message);
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("base64");
  console.log("[verify] computed HMAC:", hmac);
  console.log("[verify] expected HMAC:", data.signature);

  if (hmac !== data.signature) {
    return res
      .status(403)
      .json({ message: "Invalid Signature", success: false });
  }

  const transaction_uuid = data.transaction_uuid;

  // Find PendingPayment
  const pendingPay = await prisma.pendingPayment.findUnique({
    where: { transactionUuid: transaction_uuid },
  });

  if (!pendingPay) {
    return res.status(404).json({
      message: "Pending payment not found",
      success: false,
    });
  }

  if (pendingPay.status === "COMPLETED") {
    // Payment was already verified and order was created.
    // Find the order and return success.
    const existingOrder = await prisma.order.findFirst({
      where: { paymentRef: transaction_uuid },
      select: {
        orderNumber: true,
        id: true,
        totalAmount: true,
        status: true,
      },
    });
    if (existingOrder) {
      return res.json({
        message: "Payment Successful",
        success: true,
        data: {
          orderNumber: existingOrder.orderNumber,
          id: existingOrder.id,
          totalAmount: existingOrder.totalAmount,
          status: existingOrder.status,
        },
      });
    }
    // Order not found — fall through to error.
    return res.status(400).json({
      message: `Payment already ${pendingPay.status.toLowerCase()} but order not found`,
      success: false,
    });
  }

  if (pendingPay.status !== "PENDING") {
    return res.status(400).json({
      message: `Payment already ${pendingPay.status.toLowerCase()}`,
      success: false,
    });
  }

  if (new Date(pendingPay.expiresAt) < new Date()) {
    await prisma.pendingPayment.delete({
      where: { id: pendingPay.id },
    });
    return res.status(400).json({
      message: "Payment session expired",
      success: false,
    });
  }

  try {
    const computedData = JSON.parse(pendingPay.computedData);
    const addressData = JSON.parse(pendingPay.addressData);
    const orderItemsComputed = JSON.parse(pendingPay.items);
    const userId = pendingPay.userId;

    // Resolve address
    let resolvedAddressId = pendingPay.addressId;
    if (!resolvedAddressId) {
      const createdAddr = await prisma.address.create({
        data: {
          userId,
          fullName: addressData.fullName,
          phone: addressData.phone,
          street: addressData.streetAddress,
          city: addressData.city,
          country: "Nepal",
          isDefault: false,
        },
      });
      resolvedAddressId = createdAddr.id;
    }

    // Generate order number
    const orderNumber = await generateOrderNumber({
      prismaClient: prisma,
    });

    // 1) Clear cart
    await prisma.$transaction(async (tx) => {
      await tx.cartItem.deleteMany({
        where: { cart: { userId } },
      });
    });

    // 2) Create order + orderItems in a transaction
    const createdOrder = await prisma.$transaction(async (tx) => {
      // Decrement stock
      let lowStockEmailQueue = [];
      for (const it of orderItemsComputed) {
        const p = await tx.product.findUnique({
          where: { id: it.productId },
          select: {
            stock: true,
            isActive: true,
            isLowStockAlertSent: true,
            name: true,
          },
        });

        if (!p || !p.isActive) {
          throw Object.assign(new Error("Product invalid/inactive"), {
            status: 400,
            expose: true,
          });
        }

        if (Number(p.stock ?? 0) < it.quantity) {
          throw Object.assign(new Error("Insufficient stock"), {
            status: 400,
            expose: true,
          });
        }

        const newStock = Number(p.stock ?? 0) - it.quantity;
        const shouldAlert =
          newStock <= LOW_STOCK_THRESHOLD && p.isLowStockAlertSent === false;

        await tx.product.update({
          where: { id: it.productId },
          data: { stock: { decrement: it.quantity } },
        });

        if (shouldAlert) {
          await tx.product.update({
            where: { id: it.productId },
            data: { isLowStockAlertSent: true },
          });
          lowStockEmailQueue.push({
            id: it.productId,
            name: p.name,
            stock: newStock,
          });
        }
      }

      const order = await tx.order.create({
        data: {
          orderNumber,
          userId,
          addressId: resolvedAddressId,
          status: "PENDING",
          paymentStatus: "PAID",
          paymentMethod: "ESEWA",
          paymentRef: transaction_uuid,
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
              orderItemsComputed.reduce(
                (s, it) => s + it.vatAmountPerUnit * it.quantity,
                0,
              ) * 100,
            ) / 100,
          totalAmount: computedData.totalAmount,
          metalRateSnapshot: computedData.metalRateSnapshot,
          notes: addressData.deliveryNote || null,
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

      // Fire low stock alerts
      for (const p of lowStockEmailQueue) {
        try {
          sendLowStockAlertEmail(p, {
            adminEditUrl: `https://example.com/admin/products/${p.id}`,
          });
        } catch (e) {
          console.error("sendLowStockAlertEmail call failed:", e);
        }
      }

      return order;
    });

    // 3) Mark PendingPayment as COMPLETED
    await prisma.pendingPayment.update({
      where: { id: pendingPay.id },
      data: { status: "COMPLETED" },
    });

    // Fire-and-forget emails
    try {
      const customer = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, firstName: true, phone: true },
      });

      const orderForEmail = {
        ...createdOrder,
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

    return res.json({
      message: "Payment Successful",
      success: true,
      data: {
        orderNumber: createdOrder.orderNumber,
        id: createdOrder.id,
        totalAmount: createdOrder.totalAmount,
        status: createdOrder.status,
      },
    });
  } catch (error) {
    console.error("GET /esewa/verify order creation error:", error);
    const status = error?.status || 500;
    const message = error?.expose ? error.message : "Server error";

    // If order creation failed, mark PendingPayment as expired so user can retry
    try {
      await prisma.pendingPayment.update({
        where: { id: pendingPay.id },
        data: { status: "EXPIRED" },
      });
    } catch (e) {
      console.error("Failed to mark PendingPayment as EXPIRED:", e);
    }

    return res.status(status).json({ success: false, message });
  }
});

/**
 * GET /esewa/failure
 *
 * eSewa redirects here when payment fails with a signed `data` blob.
 * We simply delete the PendingPayment. NO order was created, so nothing to cancel.
 */
router.get("/failure", async (req, res) => {
  console.log("GET /esewa/failure req.query:", req.query);

  const token = req.query.data;
  if (!token) {
    return res.status(400).json({
      message: "Missing payment data.",
      success: false,
    });
  }

  let decodedData;
  try {
    decodedData = Buffer.from(token, "base64").toString("utf-8");
  } catch {
    return res.status(400).json({
      message: "Invalid payment data format.",
      success: false,
    });
  }

  let data;
  try {
    data = JSON.parse(decodedData);
  } catch {
    return res.status(400).json({
      message: "Invalid payment data payload.",
      success: false,
    });
  }

  const transaction_uuid = data.transaction_uuid;
  if (!transaction_uuid) {
    return res.status(400).json({
      message: "Missing transaction reference in payment data.",
      success: false,
    });
  }

  try {
    // Delete the PendingPayment — NO order to cancel, no stock to restore
    const result = await prisma.pendingPayment.deleteMany({
      where: {
        transactionUuid: transaction_uuid,
        status: "PENDING",
      },
    });

    return res.json({
      message: "Payment failed. No order was created.",
      success: true,
      deleted: result.count,
      transaction_uuid,
    });
  } catch (error) {
    console.error("GET /esewa/failure error:", error);
    return res.status(500).json({
      message: "Server error while recording payment failure.",
      success: false,
    });
  }
});

/**
 * POST /esewa/failure/manual
 *
 * Fallback when eSewa does NOT redirect (e.g. user closes tab).
 * Client sends the transaction_uuid from sessionStorage.
 * Simply deletes the PendingPayment. NO order was created.
 */
router.post("/failure/manual", async (req, res) => {
  const { transaction_uuid } = req.body;

  if (!transaction_uuid) {
    return res.status(400).json({
      message: "Missing transaction_uuid in request body.",
      success: false,
    });
  }

  try {
    const result = await prisma.pendingPayment.deleteMany({
      where: {
        transactionUuid: transaction_uuid,
        status: "PENDING",
      },
    });

    return res.json({
      message: "Payment cancelled. No order was created.",
      success: true,
      deleted: result.count,
      transaction_uuid,
    });
  } catch (error) {
    console.error("POST /esewa/failure/manual error:", error);
    return res.status(500).json({
      message: "Server error while recording payment cancellation.",
      success: false,
    });
  }
});

module.exports = router;
