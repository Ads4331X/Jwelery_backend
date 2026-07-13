const express = require("express");
const router = express.Router();

const prisma = require("../../config/prisma");
const {
  generateOtp,
  hashOtp,
  otpExpiry,
  OTP_TTL_MINUTES,
} = require("../../utils/otp");
const transporter = require("../../utils/transporter");
const { body, validationResult } = require("express-validator");

// POST /api/customer/signup/resend-otp
// body: { userId }
router.post(
  "/resend-otp",
  [body("userId").notEmpty().withMessage("userId is required")],
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

      const { userId } = req.body;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, firstName: true, username: true },
      });

      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }

      // Basic resend throttling (do not introduce new OTP constants).
      // If the most recent unconsumed signup OTP was created recently, reject.
      const recentOtp = await prisma.otpCode.findFirst({
        where: {
          accountId: userId,
          accountType: "CUSTOMER",
          purpose: "SIGNUP_VERIFICATION",
        },
        orderBy: { createdAt: "desc" },
      });

      // Enforce a short cooldown window to prevent rapid resends.
      // (Using OTP_TTL_MINUTES=10 implies a natural resend window; still keep it simple.)
      const cooldownMs = (OTP_TTL_MINUTES * 60 * 1000) / 4; // 2.5 minutes
      if (recentOtp) {
        const msSinceLastSend =
          Date.now() - new Date(recentOtp.createdAt).getTime();
        if (msSinceLastSend < cooldownMs) {
          const secondsLeft = Math.ceil((cooldownMs - msSinceLastSend) / 1000);
          return res.status(429).json({
            success: false,
            message: `Please wait ${secondsLeft}s before requesting another code`,
          });
        }
      }

      await prisma.otpCode.updateMany({
        where: {
          accountId: userId,
          accountType: "CUSTOMER",
          purpose: "SIGNUP_VERIFICATION",
          consumed: false,
        },
        data: { consumed: true },
      });

      const code = generateOtp();
      const codeHash = await hashOtp(code);
      const expiresAt = otpExpiry();

      await prisma.otpCode.create({
        data: {
          accountId: userId,
          accountType: "CUSTOMER",
          purpose: "SIGNUP_VERIFICATION",
          codeHash,
          expiresAt,
        },
      });

      const greetingName = user.firstName || user.username || "";
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: user.email,
        subject: `Your signup verification code — Anand Jewellers`,
        text: `Hello${greetingName ? " " + greetingName : ""},\n\nYour signup verification code is: ${code}\n\nThis code is valid for ${OTP_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.\n\nRegards,\nAnand Jewellers`,
      });

      return res.json({
        success: true,
        message: "A verification code has been sent to your email.",
      });
    } catch (err) {
      console.error("Signup OTP resend error:", err);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  },
);

module.exports = router;
