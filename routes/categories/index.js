const express = require("express");
const router = express.Router();
const prisma = require("../../config/prisma");

router.get("/", async (req, res) => {
  try {
    const cats = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, slug: true },
    });

    return res.json({ success: true, data: cats });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
