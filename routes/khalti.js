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

// ─── Structured Logger ────────────────────────────────────────────────────────
const LOG_TAG = "[khalti]";
const log = (level, msg, data) => {
  const ts = new Date().toISOString();
  const prefix = `${LOG_TAG} ${level.toUpperCase()} ${ts}`;
  if (data !== undefined) {
    console[level](`${prefix} ${msg}`, JSON.stringify(data, null, 0));
  } else {
    console[level](`${prefix} ${msg}`);
  }
};
const logInfo = (msg, data) => log("log", msg, data);
const logWarn = (msg, data) => log("warn", msg, data);
const logError = (msg, data) => log("error", msg, data);

// ─── Middleware: customer-only ────────────────────────────────────────────────
const requireCustomer = (req, res, next) => {
  if (req.user?.type !== "customer") {
    return res.status(403).json({ success: false, message: "Forbidden." });
  }
  next();
};

// ─── Pre-flight env var validation ───────────────────────────────────────────
const REQUIRED_KHALTI_VARS = [
  "KHALTI_SECRET",
  "KHALTI_GATEWAY_URL",
  "FRONTEND_URL",
];
function validateKhaltiEnv() {
  const missing = REQUIRED_KHALTI_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    const msg = `Missing required Khalti environment variables: ${missing.join(", ")}`;
    logError(msg);
    return { valid: false, message: msg };
  }
  return { valid: true };
}

const router = express.Router();

router.post("/initiate", authMiddleware, requireCustomer, async (req, res) => {
  try {
    logInfo("POST /initiate Request received", {
      body: req.body,
      userId: req.user?.id,
      userType: req.user?.type,
    });

    // ─── Pre-flight env var validation ─────────────────────────────────────
    const envCheck = validateKhaltiEnv();
    if (!envCheck.valid) {
      return res
        .status(500)
        .json({ success: false, message: envCheck.message });
    }

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

    // ─── Environment variable debug logging (masked) ──────────────────────
    logInfo("POST /initiate Env check", {
      KHALTI_SECRET_SET: !!process.env.KHALTI_SECRET,
      KHALTI_SECRET_LENGTH: process.env.KHALTI_SECRET?.length ?? 0,
      KHALTI_GATEWAY_URL: process.env.KHALTI_GATEWAY_URL,
      FRONTEND_URL: process.env.FRONTEND_URL,
      JWT_SECRET_SET: !!process.env.JWT_SECRET,
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

    logInfo("POST /initiate Calling Khalti API", {
      url: `${process.env.KHALTI_GATEWAY_URL}/api/v2/epayment/initiate/`,
      payload: khaltiPayload,
    });

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

    let khaltiData;
    try {
      khaltiData = await khaltiRes.json();
    } catch {
      const textBody = await khaltiRes.text();
      logError("POST /initiate Khalti response not JSON, raw body", {
        status: khaltiRes.status,
        body: textBody,
      });
      return res.status(502).json({
        success: false,
        message: `Khalti returned non-JSON response (${khaltiRes.status})`,
      });
    }

    logInfo("POST /initiate Khalti response", {
      status: khaltiRes.status,
      body: khaltiData,
    });

    if (!khaltiRes.ok) {
      logError("POST /initiate Khalti initiate failed", khaltiData);
      await cancelPendingPayment({
        transactionUuid: transaction_uuid,
        prismaClient: prisma,
      });
      return res.status(502).json({
        success: false,
        message:
          khaltiData?.detail ??
          khaltiData?.message ??
          "Could not start Khalti payment.",
      });
    }

    return res.json({
      success: true,
      payment_url: khaltiData.payment_url,
      pidx: khaltiData.pidx,
    });
  } catch (error) {
    logError("POST /initiate Error", {
      message: error?.message,
      stack: process.env.NODE_ENV !== "production" ? error?.stack : undefined,
    });
    const status = error?.status || 500;
    return res.status(status).json({
      success: false,
      message: error?.expose ? error.message : "Server error",
      ...(process.env.NODE_ENV !== "production" && error?.expose
        ? { detail: error.message }
        : {}),
    });
  }
});

router.get("/verify", async (req, res) => {
  try {
    logInfo("GET /verify called", { query: req.query });

    const { pidx } = req.query;
    if (!pidx) {
      return res
        .status(400)
        .json({ success: false, message: "Missing payment id (pidx)." });
    }

    // ─── Pre-flight env var validation ─────────────────────────────────────
    const envCheck = validateKhaltiEnv();
    if (!envCheck.valid) {
      return res
        .status(500)
        .json({ success: false, message: envCheck.message });
    }

    // ─── Step 1: Lookup payment status with Khalti ──────────────────────
    logInfo("GET /verify Calling Khalti lookup", { pidx });

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
      logError("GET /verify Khalti lookup failed", {
        status: khaltiRes.status,
        response: errBody,
      });
      return res.status(502).json({
        success: false,
        message: `Could not verify payment status with Khalti (${khaltiRes.status}).`,
        ...(process.env.NODE_ENV !== "production" ? { detail: errBody } : {}),
      });
    }

    const lookupResult = await khaltiRes.json();
    logInfo("GET /verify Khalti lookup result", lookupResult);

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
      logWarn("GET /verify Pending payment not found", { transactionUuid });
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
        logError("GET /verify AMOUNT MISMATCH — potential tampering", {
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

      logInfo("GET /verify Order created successfully", {
        orderNumber: result.orderNumber,
        id: result.id,
        totalAmount: result.totalAmount,
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
    logError("GET /verify Unexpected Khalti lookup status", {
      status: khaltiStatus,
      lookupResult,
    });
    return res.status(502).json({
      success: false,
      message: `Unexpected payment status from Khalti: ${khaltiStatus}.`,
    });
  } catch (error) {
    logError("GET /verify Error", {
      message: error?.message,
      stack: process.env.NODE_ENV !== "production" ? error?.stack : undefined,
    });
    const status = error?.status || 500;
    return res.status(status).json({
      success: false,
      message: error?.expose ? error.message : "Server error",
      ...(process.env.NODE_ENV !== "production" && error?.expose
        ? { detail: error.message }
        : {}),
    });
  }
});

module.exports = router;
