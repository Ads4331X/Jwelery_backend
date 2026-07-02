const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");
const requireRole = require("../../middleware/roleMiddleware");

const saltRounds = 10;

const formatAdmin = (admin) => ({
  id: admin.id,
  email: admin.email,
  display_name: admin.username || "",
  role: admin.role,
  created_at: admin.createdAt,
});

// GET /api/admin/accounts — List all admins
router.get("/", authMiddleware, async (req, res) => {
  try {
    const admins = await prisma.admin.findMany({
      orderBy: { createdAt: "asc" },
    });

    return res.json({
      success: true,
      admins: admins.map(formatAdmin),
    });
  } catch (error) {
    console.error("Fetch admins error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// DELETE /api/admin/accounts/:id — Delete an admin (SUPER_ADMIN only)
router.delete(
  "/:id",
  authMiddleware,
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (req.user.id === id) {
        return res.status(400).json({
          success: false,
          message: "You cannot delete your own account.",
        });
      }

      await prisma.admin.delete({ where: { id } });

      return res.json({
        success: true,
        message: "Admin deleted successfully.",
      });
    } catch (error) {
      console.error("Delete admin error:", error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// PUT /api/admin/accounts/:id/role — Update admin role (SUPER_ADMIN only)
router.put(
  "/:id/role",
  authMiddleware,
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { role } = req.body;

      const allowedRoles = ["SUPER_ADMIN", "ADMIN", "DELIVERY_STAFF"];

      if (!allowedRoles.includes(role)) {
        return res.status(400).json({
          success: false,
          message: "Invalid role specified.",
        });
      }

      await prisma.admin.update({
        where: { id },
        data: { role },
      });

      return res.json({
        success: true,
        message: "Admin role updated successfully.",
      });
    } catch (error) {
      console.error("Update role error:", error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// PUT /api/admin/accounts/profile — Update current admin profile
router.put("/profile", authMiddleware, async (req, res) => {
  try {
    const { username, password } = req.body;

    const updateData = {};
    if (username !== undefined) updateData.username = username;
    if (password) updateData.password = await bcrypt.hash(password, saltRounds);

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update.",
      });
    }

    await prisma.admin.update({
      where: { id: req.user.id },
      data: updateData,
    });

    return res.json({
      success: true,
      message: "Profile updated successfully.",
    });
  } catch (error) {
    console.error("Update profile error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
