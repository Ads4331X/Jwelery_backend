const express = require("express");
const bcrypt = require("bcrypt");
const router = express.Router();
const prisma = require("../../config/prisma");
const generateToken = require("../../utils/generateToken");

// POST /api/admin/auth — Admin login
router.post("/", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required.",
        success: false,
      });
    }

    const admin = await prisma.admin.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        password: true,
        role: true,
        isActive: true,
      },
    });

    if (!admin) {
      return res.status(401).json({
        message: "Invalid credentials.",
        success: false,
      });
    }

    if (!admin.isActive) {
      return res.status(403).json({
        message: "Account is deactivated. Contact super admin.",
        success: false,
      });
    }

    const isPasswordValid = await bcrypt.compare(password, admin.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        message: "Invalid credentials.",
        success: false,
      });
    }

    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const token = generateToken({
      id: admin.id,
      role: admin.role,
      type: "admin",
    });

    return res.json({
      message: "Login successful.",
      success: true,
      data: {
        id: admin.id,
        email: admin.email,
        username: admin.username,
        role: admin.role,
      },
      token,
    });
  } catch (err) {
    console.error("Admin login error:", err);
    return res.status(500).json({
      message: "Server error.",
      success: false,
    });
  }
});

module.exports = router;
