const express = require("express");
const crypto = require("crypto");
const prisma = require("../config/prisma");
const { createEsewaSignature } = require("../utils/signature");
const router = express.Router();
const secret = process.env.ESEWA_SECRET;

const esewaConfig = {
  merchandID: "EPAYTEST",
  esewaPaymentUrl: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
  success: false,
  secret: process.env.ESEWA_SECRET,
};

router.post("/initiate", async (req, res) => {
  const { orderId } = req.body;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, totalAmount: true },
  });

  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  const transaction_uuid = `${order.orderNumber}-${Date.now()}`;

  const paymentData = {
    amount: order.totalAmount.toString(),
    tax_amount: "0",
    product_service_charge: "0",
    product_delivery_charge: "0",
    total_amount: order.totalAmount.toString(),
    product_code: esewaConfig.merchandID,
    transaction_uuid,
    success_url: `${process.env.FRONTEND_URL}/checkout/esewa/success`,
    failure_url: `${process.env.FRONTEND_URL}/checkout/esewa/failure`,
    signed_field_names: "total_amount,transaction_uuid,product_code",
  };

  const message = `total_amount=${paymentData.total_amount},transaction_uuid=${paymentData.transaction_uuid},product_code=${paymentData.product_code}`;
  const generatedSignature = createEsewaSignature({
    amount: paymentData.total_amount,
    transaction_uuid: paymentData.transaction_uuid,
    product_code: paymentData.product_code,
  });
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentRef: transaction_uuid },
  });

  return res.json({
    success: true,
    gatewayUrl: esewaConfig.esewaPaymentUrl,
    fields: { ...paymentData, signature: generatedSignature },
  });
});

router.get("/verify", async (req, res) => {
  const token = req.query.data;
  if (!token)
    return res.status(400).json({ result: "Missing token", success: false });

  const decodedData = Buffer.from(token, "base64").toString("utf-8");
  const data = JSON.parse(decodedData);

  // verify signature
  const signedFields = data.signed_field_names.split(",");
  const message = signedFields.map((f) => `${f}=${data[f]}`).join(",");
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("base64");

  if (hmac !== data.signature) {
    return res
      .status(403)
      .json({ result: "Invalid Signature", success: false });
  }

  // update order
  const prisma = require("../config/prisma");
  const transaction_uuid = data.transaction_uuid;

  // Correlate with existing order created at checkout.
  // We store eSewa's transaction_uuid in Order.paymentRef during /esewa/initiate.
  const paymentRef = data.transaction_uuid;

  const result = await prisma.order.updateMany({
    where: {
      paymentRef: paymentRef,
      status: { in: ["PENDING"] },
    },
    data: {
      paymentStatus: "PAID",
      paymentMethod: "ESEWA",
      paymentRef,
    },
  });

  return res.json({
    message: "Payment Successful",
    success: true,
    updated: result.count,
  });
});

router.get("/failure", async (req, res) => {
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

  // Update order — mark payment as FAILED and cancel the order
  // so it's taken out of the normal fulfillment queue.
  const result = await prisma.order.updateMany({
    where: {
      paymentRef: transaction_uuid,
      paymentStatus: { in: ["UNPAID"] },
    },
    data: {
      paymentStatus: "FAILED",
      status: "CANCELLED",
    },
  });

  return res.json({
    message: "Payment Failed. Your order has been cancelled.",
    success: true,
    updated: result.count,
    transaction_uuid,
  });
});

module.exports = router;
