const {
  sendOrderConfirmationEmail,
  sendAdminNewOrderEmail,
  sendLowStockAlertEmail,
} = require("../utils/orderEmails");

const LOW_STOCK_THRESHOLD = 5;

/**
 * Generates a unique human-readable order number in the format AJ-YYYY-RRRR.
 * Retries up to 5 times if a collision is detected.
 *
 * @param {{ prismaClient: import("@prisma/client").PrismaClient }} params
 * @returns {Promise<string>}
 */
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

/**
 * Computes pricing breakdown for a single product based on its schema fields
 * and the current metal rate per gram.
 *
 * Canonical formula (documented in prisma/schema.prisma):
 *   metalCost     = currentRatePerGram × weightGrams
 *   wastageAmt    = metalCost × (wastagePercent / 100)
 *   makingAmt     = FIXED  → makingCharge
 *                   PERCENT → metalCost × (makingCharge / 100)
 *   subtotal      = metalCost + wastageAmt + makingAmt
 *   vatAmt        = subtotal × (vatPercent / 100)
 *   FINAL PRICE   = subtotal + vatAmt
 */
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

/**
 * Validates items, fetches products, checks stock, looks up metal rates,
 * computes per-item pricing, and creates a PendingPayment record.
 *
 * This function has ZERO gateway-specific logic — it is shared by eSewa,
 * Khalti, and any future payment integrations.
 *
 * @param {{
 *   userId: string,
 *   items: Array<{ productId: string, qty?: number }>,
 *   address?: object,
 *   addressId?: string,
 *   prismaClient: import("@prisma/client").PrismaClient
 * }} params
 * @returns {Promise<{
 *   transaction_uuid: string,
 *   totalAmount: number,
 *   orderItemsComputed: Array,
 *   metalRateSnapshot: object,
 *   products: Array,
 *   pendingPayment: object
 * }>}
 */
const createPendingPayment = async ({
  userId,
  items,
  address,
  addressId,
  prismaClient,
}) => {
  // Fetch products
  const productIds = items.map((i) => i.productId);
  const products = await prismaClient.product.findMany({
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
      const err = new Error(
        `Item failed: productId=${item.productId} is invalid or inactive`,
      );
      err.status = 400;
      err.expose = true;
      throw err;
    }
    if (Number(p.stock ?? 0) < (item.qty || 1)) {
      const err = new Error(
        `Insufficient stock for "${p.name}". Available: ${p.stock}`,
      );
      err.status = 400;
      err.expose = true;
      throw err;
    }
  }

  // Get metal rates
  const metalTypes = Array.from(new Set(products.map((p) => p.metalType)));
  const latestRates = await Promise.all(
    metalTypes.map(async (mt) => {
      const rate = await prismaClient.metalRate.findFirst({
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
      const err = new Error(`Metal rate missing for ${mt}`);
      err.status = 500;
      err.expose = true;
      throw err;
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
  const pendingPayment = await prismaClient.pendingPayment.create({
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

  return {
    transaction_uuid,
    totalAmount,
    orderItemsComputed,
    metalRateSnapshot,
    products,
    pendingPayment,
  };
};

/**
 * Completes a PendingPayment by creating the actual Order, clearing the cart,
 * decrementing stock, firing low-stock alerts, marking the PendingPayment as
 * COMPLETED, and dispatching confirmation emails.
 *
 * @param {{
 *   pendingPaymentId: string,
 *   paymentMethod: string,
 *   paymentRef: string,
 *   prismaClient: import("@prisma/client").PrismaClient
 * }} params
 * @returns {Promise<{
 *   orderNumber: string,
 *   id: string,
 *   totalAmount: number,
 *   status: string,
 *   createdOrder: object
 * }>}
 */
const finalizePendingPayment = async ({
  pendingPaymentId,
  paymentMethod,
  paymentRef,
  prismaClient,
}) => {
  // Look up the PendingPayment
  const pendingPay = await prismaClient.pendingPayment.findUnique({
    where: { id: pendingPaymentId },
  });

  if (!pendingPay) {
    const err = new Error("Pending payment not found");
    err.status = 404;
    err.expose = true;
    throw err;
  }

  const computedData = JSON.parse(pendingPay.computedData);
  const addressData = JSON.parse(pendingPay.addressData);
  const orderItemsComputed = JSON.parse(pendingPay.items);
  const userId = pendingPay.userId;

  // Resolve address
  let resolvedAddressId = pendingPay.addressId;
  if (!resolvedAddressId) {
    const createdAddr = await prismaClient.address.create({
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
    prismaClient,
  });

  // 1) Clear cart
  await prismaClient.$transaction(async (tx) => {
    await tx.cartItem.deleteMany({
      where: { cart: { userId } },
    });
  });

  // 2) Create order + orderItems in a transaction
  const createdOrder = await prismaClient.$transaction(async (tx) => {
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
        paymentMethod,
        paymentRef,
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
  await prismaClient.pendingPayment.update({
    where: { id: pendingPay.id },
    data: { status: "COMPLETED" },
  });

  // Fire-and-forget emails
  try {
    const customer = await prismaClient.user.findUnique({
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

  return {
    orderNumber,
    id: createdOrder.id,
    totalAmount: computedData.totalAmount,
    status: createdOrder.status,
    createdOrder,
  };
};

/**
 * Deletes a PendingPayment by its transactionUuid if it is still in PENDING status.
 * Used by payment failure/cancellation flows.
 *
 * @param {{
 *   transactionUuid: string,
 *   prismaClient: import("@prisma/client").PrismaClient
 * }} params
 * @returns {Promise<{ count: number }>}
 */
const cancelPendingPayment = async ({ transactionUuid, prismaClient }) => {
  const result = await prismaClient.pendingPayment.deleteMany({
    where: {
      transactionUuid,
      status: "PENDING",
    },
  });
  return { count: result.count };
};

/**
 * Pure validation function for payment-initiation requests.
 * No HTTP/res knowledge, no DB calls — simply validates the request shape.
 *
 * @param {{
 *   items: any,
 *   address?: { fullName?: string, phone?: string, streetAddress?: string, city?: string },
 *   addressId?: string
 * }} params
 * @returns {{ valid: true } | { valid: false, message: string }}
 */
const validatePaymentInitiateRequest = ({ items, address, addressId }) => {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return {
      valid: false,
      message: "Items must be a non-empty array",
    };
  }

  if (!addressId) {
    if (
      !address?.fullName ||
      !address?.phone ||
      !address?.streetAddress ||
      !address?.city
    ) {
      return {
        valid: false,
        message: "Shipping address is required",
      };
    }
  }

  return { valid: true };
};

module.exports = {
  LOW_STOCK_THRESHOLD,
  generateOrderNumber,
  computePricingFromSchema,
  createPendingPayment,
  finalizePendingPayment,
  cancelPendingPayment,
  validatePaymentInitiateRequest,
};
