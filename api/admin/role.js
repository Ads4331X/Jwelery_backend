const express = require("express");
const router = express.Router();
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");

// GET /api/admin/role — Get the authenticated admin's role
router.get("/", authMiddleware, async (req, res) => {
  try {
    // req.user is set by authMiddleware: { id, role, type }
    if (req.user.type !== "admin") {
      return res.status(403).json({
        message: "This endpoint is for admins only.",
        success: false,
      });
    }

    const admin = await prisma.admin.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        isActive: true,
      },
    });

    if (!admin) {
      return res.status(404).json({
        message: "Admin not found.",
        success: false,
      });
    }

    return res.json({
      message: "Role fetched successfully.",
      success: true,
      data: {
        role: admin.role,
        username: admin.username,
        email: admin.email,
      },
    });
  } catch (err) {
    console.error("Fetch role error:", err);
    return res.status(500).json({
      message: "Server error.",
      success: false,
    });
  }
});

module.exports = router;
