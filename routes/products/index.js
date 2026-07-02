const express = require("express");
const router = express.Router();
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");
const { body, validationResult } = require("express-validator");
const requireRole = require("../../middleware/roleMiddleware");

const formatProduct = (product) => ({
  id: product.id,
  name: product.name,
  slug: product.slug || "",
  description: product.description || "",
  categoryId: product.categoryId,
  category: product.category,
  metalType: product.metalType,
  weightGrams: product.weightGrams,
  purity: product.purity || null,
  makingCharge: product.makingCharge,
  makingChargeType: product.makingChargeType,
  wastagePercent: product.wastagePercent,
  vatPercent: product.vatPercent,
  stock: product.stock,
  isFeatured: product.isFeatured,
  isDealOfDay: product.isDealOfDay,
  isActive: product.isActive,
  sortOrder: product.sortOrder,
  images: product.images || [],
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
});

// ── Single source of truth for field types ──
const productValidation = [
  body("name").optional().isString().withMessage("Name must be a string"),
  body("slug").optional().isString().withMessage("Slug must be a string"),
  body("description")
    .optional()
    .isString()
    .withMessage("Description must be a string"),
  body("categoryId")
    .optional()
    .isString()
    .withMessage("Category ID must be a string"),
  body("metalType")
    .optional()
    .isString()
    .withMessage("Metal type must be a string"),
  body("weightGrams")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("Weight must be a positive number"),
  body("purity").optional().isString().withMessage("Purity must be a string"),
  body("makingCharge")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("Making charge must be a positive number"),
  body("makingChargeType")
    .optional()
    .isIn(["FIXED", "PERCENTAGE"])
    .withMessage("Invalid making charge type"),
  body("wastagePercent")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("Wastage percent must be 0 or greater"),
  body("vatPercent")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("VAT percent must be 0 or greater"),
  body("stock")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Stock must be a non-negative integer"),
  body("isFeatured")
    .optional()
    .isBoolean()
    .withMessage("isFeatured must be boolean"),
  body("isDealOfDay")
    .optional()
    .isBoolean()
    .withMessage("isDealOfDay must be boolean"),
  body("isActive")
    .optional()
    .isBoolean()
    .withMessage("isActive must be boolean"),
  body("sortOrder")
    .optional()
    .isInt()
    .withMessage("sortOrder must be an integer"),
];

// ── Only presence checks for POST (reuses type validation above) ──
const requiredForCreate = [
  body("name").notEmpty().withMessage("Product name is required"),
  body("categoryId").notEmpty().withMessage("Category is required"),
  body("metalType").notEmpty().withMessage("Metal type is required"),
  body("weightGrams").notEmpty().withMessage("Weight is required"),
  body("makingCharge").notEmpty().withMessage("Making charge is required"),
  body("stock").notEmpty().withMessage("Stock is required"),
];

// ── Shared error handler ──
const handleErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

router.get("/", async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      orderBy: { createdAt: "asc" },
      include: { images: true, category: true },
    });
    return res.json({
      success: true,
      data: products.map(formatProduct),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post(
  "/",
  authMiddleware,
  requireRole("SUPER_ADMIN", "ADMIN"),
  requiredForCreate,
  productValidation,
  handleErrors,
  async (req, res) => {
    try {
      const { imageUrls = [], ...productData } = req.body;

      const product = await prisma.product.create({
        data: {
          ...productData,
          images: {
            create: imageUrls.map((url, i) => ({
              url,
              isPrimary: i === 0,
              sortOrder: i,
            })),
          },
        },
        include: { images: true, category: true },
      });

      return res.json({
        success: true,
        data: formatProduct(product),
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  },
);

router.delete(
  "/:id",
  authMiddleware,
  requireRole("SUPER_ADMIN", "ADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const product = await prisma.product.findUnique({ where: { id } });

      if (!product) {
        return res.status(404).json({
          success: false,
          message: "Product not found",
        });
      }

      await prisma.product.delete({ where: { id } });

      return res.json({
        success: true,
        message: "Product deleted successfully",
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.put(
  "/:id",
  authMiddleware,
  requireRole("SUPER_ADMIN", "ADMIN"),
  productValidation,
  handleErrors,
  async (req, res) => {
    try {
      const { id } = req.params;

      const existing = await prisma.product.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({
          success: false,
          message: "Product not found",
        });
      }

      const { imageUrls = [], ...productData } = req.body;

      if (imageUrls.length > 0) {
        await prisma.productImage.deleteMany({ where: { productId: id } });
      }

      const product = await prisma.product.update({
        where: { id },
        data: {
          ...productData,
          images:
            imageUrls.length > 0
              ? {
                  create: imageUrls.map((url, i) => ({
                    url,
                    isPrimary: i === 0,
                    sortOrder: i,
                  })),
                }
              : undefined,
        },
        include: { images: true, category: true },
      });

      return res.json({ success: true, data: formatProduct(product) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
