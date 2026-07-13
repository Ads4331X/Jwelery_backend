const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const { body, validationResult } = require("express-validator");
const prisma = require("../../config/prisma");

const transporter = require("../../utils/transporter");
const { generateOtp, hashOtp, otpExpiry } = require("../../utils/otp");

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

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({
          message: "An account with this email already exists.",
          success: false,
        });
      }

      const hashed = await bcrypt.hash(password, saltRounds);

      const user = await prisma.user.create({
        data: {
          email,
          password: hashed,
          firstName,
          lastName: lastName || null,
          username: username || null,
          phone: phone || null,
          emailVerified: false,
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

      // Generate OTP for signup verification.
      const code = generateOtp();
      const codeHash = await hashOtp(code);
      const expiresAt = otpExpiry();

      await prisma.otpCode.create({
        data: {
          accountId: user.id,
          accountType: "CUSTOMER",
          purpose: "SIGNUP_VERIFICATION",
          codeHash,
          expiresAt,
        },
      });

      // Send verification email (reuse existing transporter).
      const greetingName = user.firstName || user.username || "";
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: user.email,
        subject: `Your signup verification code — Anand Jewellers`,
        text: `Hello${greetingName ? " " + greetingName : ""},\n\nYour signup verification code is: ${code}\n\nThis code is valid for 10 minutes. If you didn't request this, you can safely ignore this email.\n\nRegards,\nAnand Jewellers`,
      });

      return res.status(201).json({
        success: true,
        data: { userId: user.id, email: user.email },
        requiresVerification: true,
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
