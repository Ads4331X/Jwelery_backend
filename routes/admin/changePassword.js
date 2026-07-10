const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const { body, validationResult } = require("express-validator");

const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");

// POST /api/admin/change-password — requires a logged-in admin.
router.post(
  "/",
  authMiddleware,
  [
    body("currentPassword")
      .notEmpty()
      .withMessage("Current password is required."),
    body("newPassword")
      .isLength({ min: 6 })
      .withMessage("New password must be at least 6 characters."),
  ],
  async (req, res) => {
    try {
      if (req.user.type !== "admin") {
        return res.status(403).json({ success: false, message: "Forbidden." });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: "Validation failed.",
          errors: errors.array(),
        });
      }

      const { currentPassword, newPassword } = req.body;

      const admin = await prisma.admin.findUnique({
        where: { id: req.user.id },
      });
      if (!admin) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found." });
      }

      const isMatch = await bcrypt.compare(currentPassword, admin.password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: "Current password is incorrect.",
        });
      }

      const sameAsOld = await bcrypt.compare(newPassword, admin.password);
      if (sameAsOld) {
        return res.status(400).json({
          success: false,
          message: "New password must be different from the current password.",
        });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await prisma.admin.update({
        where: { id: admin.id },
        data: { password: hashedPassword },
      });

      return res.json({
        success: true,
        message: "Password updated successfully.",
      });
    } catch (err) {
      console.error("Change-password error:", err);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  },
);

module.exports = router;
