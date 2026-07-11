const express = require("express");
const router = express.Router();

const { body, validationResult } = require("express-validator");

const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");

// PATCH /api/customer/profile — update firstName/lastName for logged-in customer
router.patch(
  "/",
  authMiddleware,
  [
    body("firstName")
      .exists()
      .withMessage("First name is required.")
      .bail()
      .isString()
      .withMessage("First name must be a string.")
      .bail()
      .trim()
      .notEmpty()
      .withMessage("First name is required."),

    body("lastName")
      .optional({ nullable: true })
      .isString()
      .withMessage("Last name must be a string.")
      .bail()
      .trim()
      .notEmpty()
      .withMessage("Last name cannot be empty."),
  ],
  async (req, res) => {
    try {
      if (req.user?.type !== "customer") {
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

      const { firstName, lastName } = req.body;

      const updated = await prisma.user.update({
        where: { id: req.user.id },
        data: {
          firstName,
          ...(lastName !== undefined ? { lastName } : {}),
        },
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      });

      return res.json({ success: true, data: updated });
    } catch (err) {
      // Prisma throws if record doesn't exist; keep it generic unless we detect it.
      console.error("Update-profile error:", err);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  },
);

module.exports = router;
