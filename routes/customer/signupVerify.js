const express = require("express");
const router = express.Router();

const prisma = require("../../config/prisma");
const generateToken = require("../../utils/generateToken");

const { compareOtp, MAX_ATTEMPTS } = require("../../utils/otp");
const { body, validationResult } = require("express-validator");

const LOGIN_PURPOSE_ERROR = {
  success: false,
  message: "Invalid or expired code.",
};

// POST /api/customer/signup/verify
// body: { userId, code }
router.post(
  "/verify",
  [
    body("userId").notEmpty().withMessage("userId is required"),
    body("code")
      .isLength({ min: 6, max: 6 })
      .withMessage("Code must be 6 digits."),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed.",
          errors: errors.array(),
        });
      }

      const { userId, code } = req.body;

      const otp = await prisma.otpCode.findFirst({
        where: {
          accountId: userId,
          accountType: "CUSTOMER",
          purpose: "SIGNUP_VERIFICATION",
          consumed: false,
        },
        orderBy: { createdAt: "desc" },
      });

      if (!otp) return res.status(400).json(LOGIN_PURPOSE_ERROR);

      if (otp.expiresAt < new Date()) {
        return res.status(400).json({
          success: false,
          message: "This code has expired. Please request a new one.",
        });
      }

      if (otp.attempts >= MAX_ATTEMPTS) {
        return res.status(429).json({
          success: false,
          message: "Too many attempts, request a new code",
        });
      }

      const isMatch = await compareOtp(code, otp.codeHash);

      if (!isMatch) {
        await prisma.otpCode.update({
          where: { id: otp.id },
          data: { attempts: otp.attempts + 1 },
        });

        if (otp.attempts + 1 >= MAX_ATTEMPTS) {
          return res.status(429).json({
            success: false,
            message: "Too many attempts, request a new code",
          });
        }

        return res.status(400).json(LOGIN_PURPOSE_ERROR);
      }

      // Consume OTP + mark user verified in a transaction.
      const [updatedOtp, updatedUser] = await prisma.$transaction([
        prisma.otpCode.update({
          where: { id: otp.id },
          data: { consumed: true },
        }),
        prisma.user.update({
          where: { id: userId },
          data: { emailVerified: true },
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
            createdAt: true,
          },
        }),
      ]);

      const token = generateToken({
        id: updatedUser.id,
        type: "customer",
      });

      return res.json({
        success: true,
        data: {
          token,
          user: updatedUser,
        },
      });
    } catch (err) {
      console.error("Signup OTP verify error:", err);
      return res.status(500).json({
        success: false,
        message: "Server error.",
      });
    }
  },
);

module.exports = router;
