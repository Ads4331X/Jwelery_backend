const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { body, validationResult } = require("express-validator");

const prisma = require("../config/prisma");
const transporter = require("./transporter");
const generateToken = require("./generateToken");
const {
  generateOtp,
  hashOtp,
  compareOtp,
  otpExpiry,
  MAX_ATTEMPTS,
} = require("./otp");

const RESET_TOKEN_TTL = "10m";

const PASSWORD_MIN_LENGTH = 6;

function validatePasswordPolicy(pw) {
  if (typeof pw !== "string") return "Password must be a string.";
  if (pw.trim().length === 0) return "Password cannot be blank.";

  // Keep it simple & reliable (works well with real-world users)
  // but still enforce some strength.
  if (pw.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }

  const hasLetter = /[A-Za-z]/.test(pw);
  const hasNumber = /[0-9]/.test(pw);
  if (!hasLetter || !hasNumber) {
    return "Password must include at least one letter and one number.";
  }

  return null;
}

// A resend can only be requested once every 3 minutes.
const OTP_RESEND_COOLDOWN_SECONDS = 3 * 60;

/**
 * Builds a forgot-password (OTP) router shared by both customer and admin
 * auth flows. Each caller supplies how to look up / update its own account
 * table, plus what to label the account type and JWT `type` as.
 *
 * @param {object} opts
 * @param {(email: string) => Promise<{id:string, email:string, firstName?:string, password:string}|null>} opts.findAccount
 *        Must include `password` — it's needed both to send the email and,
 *        in /reset, to check the new password isn't the same as the old one.
 * @param {(id: string, hashedPassword: string) => Promise<any>} opts.updatePassword
 * @param {"CUSTOMER"|"ADMIN"} opts.accountType     - stored on OtpCode rows
 * @param {"customer"|"admin"} opts.tokenType        - stored in the JWT payload
 * @param {string} [opts.senderName]                 - shown in the email
 */
function createForgotPasswordRouter({
  findAccount,
  updatePassword,
  accountType,
  tokenType,
  senderName = "Anand Jewellers",
}) {
  const router = express.Router();

  /* ──────────────────────────────────────────────────────────────────
   * POST /request  — body: { email }
   * ────────────────────────────────────────────────────────────────── */
  router.post(
    "/request",
    [body("email").isEmail().withMessage("A valid email is required.")],
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

        const { email } = req.body;
        const account = await findAccount(email);

        if (!account) {
          return res.status(404).json({
            success: false,
            message: "No account found with this email.",
          });
        }

        // Most recent code for this account/purpose, consumed or not — used
        // both for the resend cooldown and to anchor the original expiry.
        const recentOtp = await prisma.otpCode.findFirst({
          where: {
            accountId: account.id,
            accountType,
            purpose: "PASSWORD_RESET",
          },
          orderBy: { createdAt: "desc" },
        });

        const now = Date.now();

        if (recentOtp) {
          const msSinceLastSend = now - new Date(recentOtp.createdAt).getTime();
          if (msSinceLastSend < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
            const secondsLeft = Math.ceil(
              (OTP_RESEND_COOLDOWN_SECONDS * 1000 - msSinceLastSend) / 1000,
            );
            return res.status(429).json({
              success: false,
              message: `Please wait ${secondsLeft}s before requesting another code.`,
            });
          }
        }

        // Invalidate any earlier unconsumed codes for this account/purpose.
        await prisma.otpCode.updateMany({
          where: {
            accountId: account.id,
            accountType,
            purpose: "PASSWORD_RESET",
            consumed: false,
          },
          data: { consumed: true },
        });

        // A resend within a still-live window keeps the *original* expiry —
        // the whole session caps out 10 minutes after the first code was
        // sent, no matter how many resends happen. Only a brand-new session
        // (no prior code, or the previous one already expired) gets a fresh
        // 10-minute window.
        const sessionStillLive =
          recentOtp && new Date(recentOtp.expiresAt).getTime() > now;
        const expiresAt = sessionStillLive ? recentOtp.expiresAt : otpExpiry();

        const code = generateOtp();
        const codeHash = await hashOtp(code);

        await prisma.otpCode.create({
          data: {
            accountId: account.id,
            accountType,
            codeHash,
            purpose: "PASSWORD_RESET",
            expiresAt,
          },
        });

        try {
          const greetingName = account.firstName || account.username || "";
          await transporter.sendMail({
            from: process.env.SMTP_USER,
            to: account.email,
            subject: `Your password reset code — ${senderName}`,
            text: `Hello${greetingName ? " " + greetingName : ""},

Your password reset code is: ${code}

This code is valid for 10 minutes from when it was first requested. If you didn't request this, you can safely ignore this email.

Regards,
${senderName}`,
          });
        } catch (err) {
          console.error("OTP email failed:", err);
          return res.status(500).json({
            success: false,
            message: "Could not send the code right now. Please try again.",
          });
        }

        return res.json({
          success: true,
          message: "A verification code has been sent to your email.",
        });
      } catch (err) {
        console.error("Forgot-password request error:", err);
        return res
          .status(500)
          .json({ success: false, message: "Server error." });
      }
    },
  );

  /* ──────────────────────────────────────────────────────────────────
   * POST /verify — body: { email, code } → returns a short-lived resetToken
   * ────────────────────────────────────────────────────────────────── */
  router.post(
    "/verify",
    [
      body("email").isEmail().withMessage("A valid email is required."),
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

        const { email, code } = req.body;
        const genericInvalid = {
          success: false,
          message: "Invalid or expired code.",
        };

        const account = await findAccount(email);
        if (!account) return res.status(400).json(genericInvalid);

        const otp = await prisma.otpCode.findFirst({
          where: {
            accountId: account.id,
            accountType,
            purpose: "PASSWORD_RESET",
            consumed: false,
          },
          orderBy: { createdAt: "desc" },
        });

        if (!otp) return res.status(400).json(genericInvalid);

        if (otp.expiresAt < new Date()) {
          return res.status(400).json({
            success: false,
            message: "This code has expired. Please request a new one.",
          });
        }

        if (otp.attempts >= MAX_ATTEMPTS) {
          return res.status(429).json({
            success: false,
            message: "Too many incorrect attempts. Please request a new code.",
          });
        }

        const isMatch = await compareOtp(code, otp.codeHash);

        if (!isMatch) {
          await prisma.otpCode.update({
            where: { id: otp.id },
            data: { attempts: otp.attempts + 1 },
          });
          return res.status(400).json(genericInvalid);
        }

        await prisma.otpCode.update({
          where: { id: otp.id },
          data: { consumed: true },
        });

        const resetToken = generateToken(
          {
            id: account.id,
            email: account.email,
            type: tokenType,
            purpose: "password_reset",
            otpId: otp.id,
          },
          { expiresIn: RESET_TOKEN_TTL },
        );

        return res.json({
          success: true,
          message: "Code verified.",
          resetToken,
        });
      } catch (err) {
        console.error("OTP verify error:", err);
        return res
          .status(500)
          .json({ success: false, message: "Server error." });
      }
    },
  );

  /* ──────────────────────────────────────────────────────────────────
   * POST /reset — body: { resetToken, newPassword }
   * ────────────────────────────────────────────────────────────────── */
  router.post(
    "/reset",
    [
      body("resetToken").notEmpty().withMessage("Reset token is required."),
      body("newPassword")
        .isString()
        .notEmpty()
        .withMessage("Password is required."),
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

        const { resetToken, newPassword } = req.body;

        let decoded;
        try {
          decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
        } catch (err) {
          return res.status(401).json({
            success: false,
            message:
              "Reset link is invalid or has expired. Please start again.",
          });
        }

        if (
          decoded.purpose !== "password_reset" ||
          decoded.type !== tokenType
        ) {
          return res
            .status(401)
            .json({ success: false, message: "Invalid reset token." });
        }

        const otp = await prisma.otpCode.findUnique({
          where: { id: decoded.otpId },
        });
        const now = new Date();

        if (
          !otp ||
          !otp.consumed ||
          otp.purpose !== "PASSWORD_RESET" ||
          otp.accountId !== decoded.id ||
          otp.accountType !== accountType ||
          otp.expiresAt < now ||
          otp.resetUsedAt !== null
        ) {
          return res.status(401).json({
            success: false,
            message:
              otp && otp.resetUsedAt
                ? "This reset link has already been used. Please start again."
                : "Reset link is invalid or has expired. Please start again.",
          });
        }

        // Look the account back up (by the email embedded in the token) so
        // we can compare the new password against the current one.
        const account = await findAccount(decoded.email);
        if (!account || account.id !== decoded.id) {
          return res
            .status(404)
            .json({ success: false, message: "Account not found." });
        }

        const passwordPolicyError = validatePasswordPolicy(newPassword);
        if (passwordPolicyError) {
          return res
            .status(400)
            .json({ success: false, message: passwordPolicyError });
        }

        const sameAsOld = await bcrypt.compare(newPassword, account.password);
        if (sameAsOld) {
          return res.status(400).json({
            success: false,
            message: "New password must be different from your old password.",
          });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Single-use guarantee for this verified reset token.
        // We set resetUsedAt only when it hasn't been used before.
        const resetUpdated = await prisma.otpCode.updateMany({
          where: {
            id: decoded.otpId,
            resetUsedAt: null,
          },
          data: { resetUsedAt: new Date() },
        });

        if (resetUpdated.count !== 1) {
          return res.status(401).json({
            success: false,
            message:
              "This reset link has already been used. Please start again.",
          });
        }

        await updatePassword(decoded.id, hashedPassword);

        // Belt-and-suspenders: invalidate any other pending reset codes.
        await prisma.otpCode.updateMany({
          where: {
            accountId: decoded.id,
            accountType,
            purpose: "PASSWORD_RESET",
            consumed: false,
          },
          data: { consumed: true },
        });

        return res.json({
          success: true,
          message: "Password reset successfully.",
        });
      } catch (err) {
        console.error("Password reset error:", err);
        return res
          .status(500)
          .json({ success: false, message: "Server error." });
      }
    },
  );

  return router;
}

module.exports = createForgotPasswordRouter;
