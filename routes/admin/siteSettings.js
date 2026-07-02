const express = require("express");
const router = express.Router();
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");

router.get("/", async (req, res) => {
  try {
    const settings = await prisma.siteSetting.findMany();
    const config = {};
    settings.forEach((s) => {
      config[s.key] = s.value;
    });

    const defaultSettings = {
      id: "main",
      address: config.address || "",
      maps_url: config.maps_url || "",
      email: config.email || "",
      phone: config.phone || "",
      facebook_url: config.facebook_url || "",
      instagram_url: config.instagram_url || "",
      updated_at: new Date().toISOString(),
    };

    return res.json({ success: true, data: defaultSettings });
  } catch (error) {
    console.error("Fetch site settings error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.put("/", authMiddleware, async (req, res) => {
  try {
    const data = req.body;
    const keys = [
      "address",
      "maps_url",
      "email",
      "phone",
      "facebook_url",
      "instagram_url",
    ];

    await prisma.$transaction(
      keys.map((key) => {
        return prisma.siteSetting.upsert({
          where: { key },
          update: { value: data[key] || "" },
          create: { key, value: data[key] || "" },
        });
      }),
    );

    return res.json({
      success: true,
      message: "Settings updated successfully.",
    });
  } catch (error) {
    console.error("Update site settings error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
