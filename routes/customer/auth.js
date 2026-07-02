const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const prisma = require("../../config/prisma");
const generateToken = require("../../utils/generateToken");

// POST /api/customer/auth — Customer login
router.post("/", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required.",
        success: false,
      });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        password: true,
        isActive: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        message: "Invalid credentials.",
        success: false,
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: "Account is deactivated.",
        success: false,
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        message: "Invalid credentials.",
        success: false,
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = generateToken({
      id: user.id,
      type: "customer",
    });

    return res.json({
      message: "Login successful.",
      success: true,
      data: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      token,
    });
  } catch (err) {
    console.error("Customer login error:", err);
    return res.status(500).json({
      message: "Server error.",
      success: false,
    });
  }
});

module.exports = router;
