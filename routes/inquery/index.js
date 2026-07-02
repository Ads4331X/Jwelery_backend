const express = require("express");
const router = express.Router();
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");
const requireRole = require("../../middleware/roleMiddleware");
const transporter = require("../../utils/transporter");

const { body, validationResult } = require("express-validator");

// Helper
const formatInquiry = (inquiry) => ({
  id: inquiry.id,
  fullName: inquiry.fullName,
  phone: inquiry.phone || "",
  email: inquiry.email || "",
  message: inquiry.message,
  status: inquiry.status,
  createdAt: inquiry.createdAt,
});

// GET all inquiries
router.get("/", authMiddleware, async (req, res) => {
  try {
    const inquiries = await prisma.contactEnquiry.findMany({
      orderBy: { createdAt: "desc" },
    });

    return res.json({
      success: true,
      data: inquiries.map(formatInquiry),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// CREATE inquiry
router.post(
  "/",
  [
    body("fullName").notEmpty().withMessage("Full name is required"),
    body("message").notEmpty().withMessage("Message is required"),
    body("email").optional().isEmail().withMessage("Invalid email"),
    body("phone").optional().isString(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const { fullName, email, phone, message } = req.body;

      const inquiry = await prisma.contactEnquiry.create({
        data: {
          fullName,
          email: email || "",
          phone: phone || "",
          message,
        },
      });

      try {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: process.env.SMTP_USER,
          subject: `New Inquiry from ${fullName}`,
          text: `
Name: ${fullName}
Email: ${email || "-"}
Phone: ${phone || "-"}

Message:
${message}
          `,
        });
      } catch (err) {
        console.error("Admin email failed:", err);
      }

      try {
        if (email) {
          await transporter.sendMail({
            from: process.env.SMTP_USER,
            to: email,
            subject: "Inquiry Received",
            text: `
Hello ${fullName},

Thank you for contacting Anand Jewellery.

We have received your inquiry and will respond within 1–2 business days.

Regards,
Anand Jewellery
            `,
          });
        }
      } catch (err) {
        console.error("Customer email failed:", err);
      }

      return res.json({
        success: true,
        message: "Inquiry sent successfully",
        data: inquiry,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// DELETE inquiry
router.delete(
  "/:id",
  authMiddleware,
  requireRole("SUPER_ADMIN", "ADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const inquiry = await prisma.contactEnquiry.findUnique({ where: { id } });

      if (!inquiry) {
        return res.status(404).json({
          success: false,
          message: "Inquiry not found",
        });
      }

      await prisma.contactEnquiry.delete({ where: { id } });

      return res.json({
        success: true,
        message: "Inquiry deleted successfully",
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// UPDATE STATUS
router.put(
  "/:id/status",
  authMiddleware,
  requireRole("SUPER_ADMIN", "ADMIN"),
  [
    body("status")
      .isIn(["UNREAD", "READ", "REPLIED"])
      .withMessage("Invalid status"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const { id } = req.params;
      const { status } = req.body;

      const inquiry = await prisma.contactEnquiry.update({
        where: { id },
        data: { status },
      });

      return res.json({
        success: true,
        message: "Status updated successfully",
        data: inquiry,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
