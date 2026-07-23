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

router.get("/verify", async (req, res) => {
  try {
    const { pidx } = req.query;
    if (!pidx) {
      return res
        .status(400)
        .json({ success: false, message: "Missing payment id (pidx)." });
    }

    // ─── Step 1: Lookup payment status with Khalti ──────────────────────
    const khaltiRes = await fetch(
      `${process.env.KHALTI_GATEWAY_URL}/api/v2/epayment/lookup/`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${process.env.KHALTI_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pidx }),
      },
    );

    if (!khaltiRes.ok) {
      let errBody;
      try {
        errBody = await khaltiRes.json();
      } catch {
        errBody = { detail: khaltiRes.statusText };
      }
      console.error("Khalti lookup failed:", khaltiRes.status, errBody);
      return res.status(502).json({
        success: false,
        message: "Could not verify payment status with Khalti.",
      });
    }

    const lookupResult = await khaltiRes.json();

    // Extract our transaction_uuid from Khalti's purchase_order_id
    const transactionUuid = lookupResult.purchase_order_id;
    if (!transactionUuid) {
      return res.status(400).json({
        success: false,
        message: "Khalti response missing purchase_order_id.",
      });
    }

    // ─── Step 2: Early-exit local checks (optimisation only) ────────────
    const pendingPay = await prisma.pendingPayment.findUnique({
      where: { transactionUuid },
    });

    if (!pendingPay) {
      return res.status(404).json({
        success: false,
        message: "Pending payment not found.",
      });
    }

    if (pendingPay.status === "COMPLETED") {
      // Already processed — return existing order
      const existingOrder = await prisma.order.findFirst({
        where: { paymentRef: transactionUuid },
        select: {
          orderNumber: true,
          id: true,
          totalAmount: true,
          status: true,
        },
      });
      if (existingOrder) {
        return res.json({
          success: true,
          message: "Payment already completed.",
          data: {
            orderNumber: existingOrder.orderNumber,
            id: existingOrder.id,
            totalAmount: existingOrder.totalAmount,
            status: existingOrder.status,
          },
        });
      }
      return res.status(400).json({
        success: false,
        message:
          "Payment already completed but order not found — contact support.",
      });
    }

    if (new Date(pendingPay.expiresAt) < new Date()) {
      // Expired locally — clean up
      try {
        await prisma.pendingPayment.delete({ where: { id: pendingPay.id } });
      } catch (_) {
        /* ignore */
      }
      return res.status(400).json({
        success: false,
        message: "Payment session expired.",
      });
    }

    if (pendingPay.status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `Payment already ${pendingPay.status.toLowerCase()}.`,
      });
    }

    // ─── Step 3: Authoritative Khalti status check ──────────────────────
    const khaltiStatus = lookupResult.status;

    // Casing documented by Khalti: "Completed", "Pending", "User canceled",
    // "Expired", "Refunded", etc.
    if (khaltiStatus === "Completed") {
      // ── Anti-tampering: amount check ──────────────────────────────────
      const paidPaisa = Number(lookupResult.total_amount);
      const expectedPaisa = Math.round(Number(pendingPay.totalAmount) * 100);

      if (paidPaisa !== expectedPaisa) {
        console.error("AMOUNT MISMATCH — potential tampering:", {
          transactionUuid,
          paidPaisa,
          expectedPaisa,
          lookupResult,
        });
        return res.status(409).json({
          success: false,
          message: "Payment amount mismatch — transaction flagged.",
        });
      }

      // All checks passed — create the order
      const result = await finalizePendingPayment({
        pendingPaymentId: pendingPay.id,
        paymentMethod: "KHALTI",
        paymentRef: transactionUuid,
        prismaClient: prisma,
      });

      return res.json({
        success: true,
        message: "Payment Successful",
        data: {
          orderNumber: result.orderNumber,
          id: result.id,
          totalAmount: result.totalAmount,
          status: result.status,
        },
      });
    }

    // ── Non-completed statuses ──────────────────────────────────────────
    if (khaltiStatus === "Pending") {
      return res.json({
        success: false,
        message: "Payment is still processing — check back later.",
      });
    }

    // Terminal failure statuses — cancel the pending payment
    if (["User canceled", "Expired", "Refunded"].includes(khaltiStatus)) {
      await cancelPendingPayment({
        transactionUuid,
        prismaClient: prisma,
      });
      return res.json({
        success: false,
        message: `Payment was ${khaltiStatus.toLowerCase()}. No order was created.`,
      });
    }

    // Unexpected status
    console.error(
      "Unexpected Khalti lookup status:",
      khaltiStatus,
      lookupResult,
    );
    return res.status(502).json({
      success: false,
      message: `Unexpected payment status from Khalti: ${khaltiStatus}.`,
    });
  } catch (error) {
    console.error("GET /khalti/verify error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});
