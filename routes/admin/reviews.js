const express = require("express");
const router = express.Router();
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");
const requireRole = require("../../middleware/roleMiddleware");

router.get("/", authMiddleware, requireRole("SUPER_ADMIN", "ADMIN"), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [reviews, totalCount] = await Promise.all([
      prisma.review.findMany({
        include: {
          user: { select: { firstName: true, lastName: true, username: true } },
          product: { select: { name: true, slug: true } }
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.review.count(),
    ]);

    return res.json({
      success: true,
      data: {
        reviews,
        total: totalCount,
        page,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete("/:id", authMiddleware, requireRole("SUPER_ADMIN", "ADMIN"), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.review.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Review not found." });
    }

    await prisma.review.delete({ where: { id } });
    return res.json({ success: true, message: "Review deleted successfully." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
