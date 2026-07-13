const express = require("express");
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");
const { body, validationResult } = require("express-validator");

const router = express.Router();

const requireCustomer = (req, res, next) => {
  if (req.user?.type !== "customer") {
    return res.status(403).json({ success: false, message: "Forbidden." });
  }
  next();
};

const validateBody = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  return null;
};

const unsetOtherDefaults = async ({ tx, userId, keepAddressId }) => {
  await tx.address.updateMany({
    where: { userId, id: { not: keepAddressId } },
    data: { isDefault: false },
  });
};

const addressOwnerCheck = async ({ tx, userId, addressId }) => {
  const addr = await tx.address.findFirst({
    where: { id: addressId, userId },
    select: { id: true },
  });
  if (!addr) {
    return false;
  }
  return true;
};

router.get("/", authMiddleware, requireCustomer, async (req, res) => {
  try {
    const userId = req.user.id;

    const addresses = await prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        fullName: true,
        phone: true,
        street: true,
        city: true,
        state: true,
        postalCode: true,
        isDefault: true,
        country: true,
      },
    });

    return res.json({ success: true, data: addresses });
  } catch (error) {
    console.error("List addresses error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post(
  "/",
  authMiddleware,
  requireCustomer,
  [
    body("fullName")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("fullName is required"),
    body("phone").isString().trim().notEmpty().withMessage("phone is required"),
    body("street")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("street is required"),
    body("city").isString().trim().notEmpty().withMessage("city is required"),

    body("state")
      .optional({ nullable: true })
      .isString()
      .trim()
      .notEmpty()
      .withMessage("state must be a string"),

    body("postalCode")
      .optional({ nullable: true })
      .isString()
      .trim()
      .notEmpty()
      .withMessage("postalCode must be a string"),

    body("isDefault")
      .optional({ nullable: true })
      .isBoolean()
      .withMessage("isDefault must be boolean"),
  ],
  async (req, res) => {
    try {
      const bodyError = validateBody(req, res);
      if (bodyError) return;

      const userId = req.user.id;
      const { fullName, phone, street, city, state, postalCode, isDefault } =
        req.body;

      const wantsDefault = Boolean(isDefault);

      const created = await prisma.$transaction(async (tx) => {
        if (wantsDefault) {
          await tx.address.updateMany({
            where: { userId },
            data: { isDefault: false },
          });
        }

        const row = await tx.address.create({
          data: {
            userId,
            fullName,
            phone,
            street,
            city,
            ...(state !== undefined ? { state } : {}),
            ...(postalCode !== undefined ? { postalCode } : {}),
            isDefault: wantsDefault,
          },
          select: {
            id: true,
            fullName: true,
            phone: true,
            street: true,
            city: true,
            state: true,
            postalCode: true,
            isDefault: true,
            country: true,
          },
        });

        return row;
      });

      return res.status(201).json({ success: true, data: created });
    } catch (error) {
      console.error("Create address error:", error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.put(
  "/:id",
  authMiddleware,
  requireCustomer,
  [
    body("fullName")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("fullName is required"),
    body("phone").isString().trim().notEmpty().withMessage("phone is required"),
    body("street")
      .isString()
      .trim()
      .notEmpty()
      .withMessage("street is required"),
    body("city").isString().trim().notEmpty().withMessage("city is required"),

    body("state").optional({ nullable: true }).isString().trim().notEmpty(),

    body("postalCode")
      .optional({ nullable: true })
      .isString()
      .trim()
      .notEmpty(),

    body("isDefault")
      .optional({ nullable: true })
      .isBoolean()
      .withMessage("isDefault must be boolean"),
  ],
  async (req, res) => {
    try {
      const bodyError = validateBody(req, res);
      if (bodyError) return;

      const userId = req.user.id;
      const { id } = req.params;
      const { fullName, phone, street, city, state, postalCode, isDefault } =
        req.body;

      const wantsDefault = Boolean(isDefault);

      const updated = await prisma.$transaction(async (tx) => {
        const ok = await addressOwnerCheck({
          tx,
          userId,
          addressId: id,
        });
        if (!ok) {
          const err = new Error("Forbidden.");
          err.status = 403;
          throw err;
        }

        if (wantsDefault) {
          await unsetOtherDefaults({
            tx,
            userId,
            keepAddressId: id,
          });
        }

        const row = await tx.address.update({
          where: { id },
          data: {
            fullName,
            phone,
            street,
            city,
            ...(state !== undefined ? { state } : {}),
            ...(postalCode !== undefined ? { postalCode } : {}),
            ...(wantsDefault
              ? { isDefault: true }
              : Boolean(isDefault) === false
                ? { isDefault: false }
                : {}),
          },
          select: {
            id: true,
            fullName: true,
            phone: true,
            street: true,
            city: true,
            state: true,
            postalCode: true,
            isDefault: true,
            country: true,
          },
        });

        return row;
      });

      return res.json({ success: true, data: updated });
    } catch (error) {
      console.error("Update address error:", error);
      const status = error?.status || 500;
      const message = status === 403 ? "Forbidden." : "Server error";
      return res.status(status).json({ success: false, message });
    }
  },
);

router.delete("/:id", authMiddleware, requireCustomer, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const deleted = await prisma.address.deleteMany({
      where: { id, userId },
    });

    if (!deleted.count) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }

    return res.json({ success: true, data: { id } });
  } catch (error) {
    console.error("Delete address error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.patch(
  "/:id/default",
  authMiddleware,
  requireCustomer,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { id } = req.params;

      const updated = await prisma.$transaction(async (tx) => {
        const ok = await addressOwnerCheck({
          tx,
          userId,
          addressId: id,
        });
        if (!ok) {
          const err = new Error("Forbidden.");
          err.status = 403;
          throw err;
        }

        await unsetOtherDefaults({ tx, userId, keepAddressId: id });

        const row = await tx.address.update({
          where: { id },
          data: { isDefault: true },
          select: {
            id: true,
            fullName: true,
            phone: true,
            street: true,
            city: true,
            state: true,
            postalCode: true,
            isDefault: true,
            country: true,
          },
        });

        return row;
      });

      return res.json({ success: true, data: updated });
    } catch (error) {
      console.error("Set default address error:", error);
      const status = error?.status || 500;
      const message = status === 403 ? "Forbidden." : "Server error";
      return res.status(status).json({ success: false, message });
    }
  },
);

module.exports = router;
