const express = require("express");
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");

const router = express.Router();

const requireAdmin = (req, res, next) => {
  if (req.user?.type !== "admin") {
    return res.status(403).json({ success: false, message: "Forbidden." });
  }
  next();
};

function parseDateRange() {
  const now = new Date();

  // ordersToday: createdAt >= today at 00:00 local time
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  // ordersThisMonth: createdAt >= first day of current month
  const startOfThisMonth = new Date(now);
  startOfThisMonth.setDate(1);
  startOfThisMonth.setHours(0, 0, 0, 0);

  return { startOfToday, startOfThisMonth, now };
}

router.get("/stats/summary", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { startOfToday, startOfThisMonth } = parseDateRange();

    // Revenue: sum totalAmount only for PAID orders (COD-only could still use this).
    const paidFilter = { paymentStatus: "PAID" };

    // Keep it to 1-2 round trips: use aggregate for sums + counts.
    // Note: Prisma doesn't support conditional sum in a single query easily,
    // so we use $transaction to run them in parallel (same round-trip).
    const [
      totalOrdersAgg,
      todayOrdersCountAgg,
      thisMonthOrdersCountAgg,
      revenueAgg,
      revenueThisMonthAgg,
      pendingAgg,
      processingAgg,
      recentOrders,
    ] = await prisma.$transaction([
      // Total orders + recent
      prisma.order.aggregate({
        _count: { _all: true },
      }),

      prisma.order.aggregate({
        _count: { _all: true },
        where: { createdAt: { gte: startOfToday } },
      }),

      prisma.order.aggregate({
        _count: { _all: true },
        where: { createdAt: { gte: startOfThisMonth } },
      }),

      prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: paidFilter,
      }),

      prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: {
          ...paidFilter,
          createdAt: { gte: startOfThisMonth },
        },
      }),

      prisma.order.count({ where: { status: "PENDING" } }),
      prisma.order.count({ where: { status: "PROCESSING" } }),

      prisma.order.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
    ]);

    const formatMoney = (n) => {
      if (typeof n !== "number") return 0;
      return Math.round((n + Number.EPSILON) * 100) / 100;
    };

    const totalOrders = totalOrdersAgg?._count?._all ?? 0;
    const ordersToday = todayOrdersCountAgg?._count?._all ?? 0;
    const ordersThisMonth = thisMonthOrdersCountAgg?._count?._all ?? 0;

    const totalRevenue = formatMoney(revenueAgg?._sum?.totalAmount ?? 0);
    const revenueThisMonth = formatMoney(
      revenueThisMonthAgg?._sum?.totalAmount ?? 0,
    );

    const pendingOrders = pendingAgg ?? 0;
    const processingOrders = processingAgg ?? 0;

    const recentOrdersPayload = (recentOrders ?? []).map((o) => {
      const first = o.user?.firstName ?? "";
      const last = o.user?.lastName ?? "";
      const customerName = `${first} ${last}`.trim() || "Unknown";

      return {
        orderNumber: o.orderNumber,
        customerName,
        totalAmount: formatMoney(Number(o.totalAmount)),
        status: o.status,
        createdAt: o.createdAt,
      };
    });

    return res.json({
      success: true,
      data: {
        totalOrders,
        ordersToday,
        ordersThisMonth,
        totalRevenue,
        revenueThisMonth,
        pendingOrders,
        processingOrders,
        recentOrders: recentOrdersPayload,
      },
    });
  } catch (error) {
    console.error("Admin orders stats summary error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
