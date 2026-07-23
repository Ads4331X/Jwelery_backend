const express = require("express");
const crypto = require("crypto");
const prisma = require("../config/prisma");
const authMiddleware = require("../middleware/authMiddleware");
const {
  createPendingPayment,
  finalizePendingPayment,
  cancelPendingPayment,
  validatePaymentInitiateRequest,
} = require("../services/paymentPending");

const requireCustomer = (req, res, next) => {
  if (req.user?.type !== "customer") {
    return res.status(403).json({ success: false, message: "Forbidden." });
  }
  next();
};

const router = express.Router();

router.post("/initiate", authMiddleware, requireCustomer, async (req, res) => {
  try {
    const { items, address, addressId } = req.body;
    const userId = req.user.id;

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

    const { transaction_uuid, totalAmount } = await createPendingPayment({
      userId,
      items,
      address,
      addressId,
      prismaClient: prisma,
    });

    const customer = await prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true, phone: true },
    });

    const khaltiPayload = {
      return_url: `${process.env.FRONTEND_URL}/checkout/khalti/callback`,
      website_url: process.env.FRONTEND_URL,
      amount: Math.round(totalAmount * 100),
      purchase_order_id: transaction_uuid,
      purchase_order_name: `Anand Jewellers Order ${transaction_uuid}`,
      customer_info: {
        name: `${customer?.firstName ?? ""} ${customer?.lastName ?? ""}`.trim(),
        email: customer?.email,
        phone: customer?.phone ?? undefined,
      },
    };

    const khaltiRes = await fetch(
      `${process.env.KHALTI_GATEWAY_URL}/api/v2/epayment/initiate/`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${process.env.KHALTI_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(khaltiPayload),
      },
    );

    const khaltiData = await khaltiRes.json();

    if (!khaltiRes.ok) {
      console.error("Khalti initiate failed:", khaltiData);
      await cancelPendingPayment({
        transactionUuid: transaction_uuid,
        prismaClient: prisma,
      });
      return res
        .status(502)
        .json({ success: false, message: "Could not start Khalti payment." });
    }

    return res.json({
      success: true,
      payment_url: khaltiData.payment_url,
      pidx: khaltiData.pidx,
    });
  } catch (error) {
    console.error("POST /khalti/initiate error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});
