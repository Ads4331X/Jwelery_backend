const express = require("express");
const crypto = require("crypto");
const prisma = require("../config/prisma");
const { createEsewaSignature } = require("../utils/signature");
const authMiddleware = require("../middleware/authMiddleware");
const {
  createPendingPayment,
  finalizePendingPayment,
  cancelPendingPayment,
  validatePaymentInitiateRequest,
} = require("../services/paymentPending");

const router = express.Router();
const secret = process.env.ESEWA_SECRET;

const esewaConfig = {
  merchandID: "EPAYTEST",
  esewaPaymentUrl: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
  secret: process.env.ESEWA_SECRET,
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
 * Delegates validation, pricing, and PendingPayment creation to
 * createPendingPayment (which is gateway-agnostic), then builds
 * eSewa-specific fields and signature.
 * NO order is created at this point.
 */
router.post("/initiate", authMiddleware, requireCustomer, async (req, res) => {
  try {
    const { items, address, addressId } = req.body;
    const userId = req.user.id;

    // Validate request shape (gateway-agnostic)
    const validation = validatePaymentInitiateRequest({
      items,
      address,
      addressId,
    });
    if (!validation.valid) {
      return res
        .status(400)
        .json({ success: false, message: validation.message });
    }

    // Create PendingPayment (gateway-agnostic: validates stock, computes pricing, stores intent)
    const { transaction_uuid, totalAmount } = await createPendingPayment({
      userId,
      items,
      address,
      addressId,
      prismaClient: prisma,
    });

    // Build eSewa payment data (gateway-specific)
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
    return res.status(error?.status || 500).json({
      success: false,
      message: error?.expose ? error.message : "Server error",
    });
  }
});

/**
 * GET /esewa/verify
 *
 * eSewa redirects here after successful payment with a signed `data` blob.
 * Verifies the eSewa HMAC signature, then delegates order creation to the
 * gateway-agnostic finalizePendingPayment.
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

  // Verify eSewa signature (gateway-specific)
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
    // Delegate order creation to the gateway-agnostic service
    const result = await finalizePendingPayment({
      pendingPaymentId: pendingPay.id,
      paymentMethod: "ESEWA",
      paymentRef: transaction_uuid,
      prismaClient: prisma,
    });

    return res.json({
      message: "Payment Successful",
      success: true,
      data: {
        orderNumber: result.orderNumber,
        id: result.id,
        totalAmount: result.totalAmount,
        status: result.status,
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
 * Cancels the PendingPayment via the shared cancelPendingPayment helper.
 * NO order was created, so nothing to cancel.
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
    const result = await cancelPendingPayment({
      transactionUuid: transaction_uuid,
      prismaClient: prisma,
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
    const result = await cancelPendingPayment({
      transactionUuid: transaction_uuid,
      prismaClient: prisma,
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
