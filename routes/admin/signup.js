const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const { body, validationResult } = require("express-validator");
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");
const requireRole = require("../../middleware/roleMiddleware");

const saltRounds = 10;

router.post(
  "/",
  authMiddleware,
  requireRole("SUPER_ADMIN"),
  [
    body("email").isEmail().withMessage("Valid email is required."),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters."),
    body("username").notEmpty().withMessage("Username is required."),
    body("role")
      .optional()
      .isIn(["SUPER_ADMIN", "ADMIN", "DELIVERY_STAFF"])
      .withMessage("Role must be SUPER_ADMIN, ADMIN, or DELIVERY_STAFF."),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);

      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: "Validation failed.",
          success: false,
          errors: errors.array(),
        });
      }

      const { email, password, username, role } = req.body;

      const existing = await prisma.admin.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({
          message: "An admin with this email already exists.",
          success: false,
        });
      }

      const hashed = await bcrypt.hash(password, saltRounds);

      const admin = await prisma.admin.create({
        data: {
          email,
          password: hashed,
          username,
          role: role || "ADMIN",
        },
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      });

      return res.status(201).json({
        message: "Admin created successfully.",
        success: true,
        data: admin,
      });
    } catch (err) {
      console.error("Admin signup error:", err);
      return res.status(500).json({
        message: "Server error.",
        success: false,
      });
    }
  },
);

module.exports = router;
