const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const { body, validationResult } = require("express-validator");
const prisma = require("../../config/prisma");
const generateToken = require("../../utils/generateToken");

const saltRounds = 10;

// POST /api/customer/signup — Customer registration (open)
router.post(
  "/",
  [
    body("email").isEmail().withMessage("Valid email is required."),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters."),
    body("firstName").notEmpty().withMessage("First name is required."),
    body("lastName").optional(),
    body("username").optional(),
    body("phone").optional(),
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

      const { email, password, firstName, lastName, username, phone } =
        req.body;

      // Check for duplicate email
      const existing = await prisma.user.findUnique({
        where: { email },
      });

      if (existing) {
        return res.status(409).json({
          message: "An account with this email already exists.",
          success: false,
        });
      }

      // Hash password
      const hashed = await bcrypt.hash(password, saltRounds);

      const user = await prisma.user.create({
        data: {
          email,
          password: hashed,
          firstName,
          lastName: lastName || null,
          username: username || null,
          phone: phone || null,
        },
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          lastName: true,
          createdAt: true,
        },
      });

      // Auto-login: generate JWT on signup
      const token = generateToken({
        id: user.id,
        type: "customer",
      });

      return res.status(201).json({
        message: "Account created successfully.",
        success: true,
        data: user,
        token,
      });
    } catch (err) {
      console.error("Customer signup error:", err);
      return res.status(500).json({
        message: "Server error.",
        success: false,
      });
    }
  },
);

module.exports = router;
