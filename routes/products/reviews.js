const express = require("express");
const router = express.Router({ mergeParams: true });
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");
const requireRole = require("../../middleware/roleMiddleware");
const jwt = require("jsonwebtoken");
const Filter = require('bad-words');

const filter = new Filter();

const softAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      // Ignore invalid tokens for soft auth
    }
  }
  next();
};

const checkProfanity = (req, res, next) => {
  if (req.body.comment && filter.isProfane(req.body.comment)) {
    return res.status(400).json({
      success: false,
      message: "Your comment contains profanity. Please revise it."
    });
  }
  next();
};

// GET /api/products/:productId/reviews
router.get("/", softAuth, async (req, res) => {
  try {
    const { productId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [reviews, totalCount] = await Promise.all([
      prisma.review.findMany({
        where: { productId, isVisible: true },
        include: { user: { select: { firstName: true, lastName: true, username: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.review.count({ where: { productId, isVisible: true } }),
    ]);

    const stats = await prisma.review.aggregate({
      where: { productId, isVisible: true },
      _avg: { rating: true },
      _count: { rating: true }
    });

    let canReview = false;
    if (req.user && req.user.type === "CUSTOMER") {
      const userId = req.user.id;
      // Has already reviewed?
      const existingReview = await prisma.review.findUnique({
        where: { userId_productId: { userId, productId } }
      });
      if (!existingReview) {
        // Has a DELIVERED order for this product?
        const orderCount = await prisma.orderItem.count({
          where: {
            productId,
            order: {
              userId,
              status: "DELIVERED"
            }
          }
        });
        canReview = orderCount > 0;
      }
    }

    return res.json({
      success: true,
      data: {
        reviews,
        total: totalCount,
        page,
        totalPages: Math.ceil(totalCount / limit),
        avgRating: stats._avg.rating || 0,
        reviewCount: stats._count.rating || 0,
        canReview
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /api/products/:productId/reviews
router.post("/", authMiddleware, checkProfanity, async (req, res) => {
  try {
    const { productId } = req.params;
    const userId = req.user.id;
    const { rating, comment } = req.body;

    if (req.user.type !== "CUSTOMER") {
       return res.status(403).json({ success: false, message: "Admins cannot review products." });
    }

    const orderCount = await prisma.orderItem.count({
      where: {
        productId,
        order: {
          userId,
          status: "DELIVERED"
        }
      }
    });

    if (orderCount === 0) {
      return res.status(403).json({
        success: false,
        message: "You can only review products you've purchased and received."
      });
    }

    const review = await prisma.review.create({
      data: {
        userId,
        productId,
        rating: parseInt(rating),
        comment
      },
      include: { user: { select: { firstName: true, lastName: true, username: true } } },
    });

    return res.json({ success: true, data: review });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ success: false, message: "You've already reviewed this product." });
    }
    console.error(error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// PUT /api/products/:productId/reviews/:id
router.put("/:id", authMiddleware, checkProfanity, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { rating, comment } = req.body;

    const existing = await prisma.review.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Review not found." });
    }
    if (existing.userId !== userId) {
      return res.status(403).json({ success: false, message: "You can only edit your own reviews." });
    }

    const review = await prisma.review.update({
      where: { id },
      data: {
        rating: rating !== undefined ? parseInt(rating) : undefined,
        comment: comment !== undefined ? comment : undefined
      },
      include: { user: { select: { firstName: true, lastName: true, username: true } } },
    });

    return res.json({ success: true, data: review });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// DELETE /api/products/:productId/reviews/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const existing = await prisma.review.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Review not found." });
    }

    if (req.user.role) {
      if (req.user.role === "DELIVERY_STAFF") {
        return res.status(403).json({ success: false, message: "Delivery staff cannot delete reviews." });
      }
    } else {
      if (existing.userId !== userId) {
        return res.status(403).json({ success: false, message: "You can only delete your own reviews." });
      }
    }

    await prisma.review.delete({ where: { id } });
    return res.json({ success: true, message: "Review deleted successfully." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
