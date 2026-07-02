const express = require("express");
const router = express.Router();
const prisma = require("../../config/prisma");
const authMiddleware = require("../../middleware/authMiddleware");

// Helper to convert rate per gram to tola and 10 grams
const formatRates = (goldRate, silverRate, visibleSetting) => {
  const TOLA_IN_GRAMS = 11.6638;
  return {
    gold_tola: goldRate ? Number((goldRate.ratePerGram * TOLA_IN_GRAMS).toFixed(2)) : 0,
    gold_ten_gram: goldRate ? Number((goldRate.ratePerGram * 10).toFixed(2)) : 0,
    silver_tola: silverRate ? Number((silverRate.ratePerGram * TOLA_IN_GRAMS).toFixed(2)) : 0,
    silver_ten_gram: silverRate ? Number((silverRate.ratePerGram * 10).toFixed(2)) : 0,
    visible: visibleSetting?.value === "true",
    updated_at: goldRate ? goldRate.createdAt.toISOString() : new Date().toISOString(),
  };
};

// GET /api/admin/metal-rates
router.get("/", async (req, res) => {
  try {
    const goldRate = await prisma.metalRate.findFirst({
      where: { metalType: "GOLD" },
      orderBy: { createdAt: "desc" },
    });
    
    const silverRate = await prisma.metalRate.findFirst({
      where: { metalType: "SILVER" },
      orderBy: { createdAt: "desc" },
    });

    const visibleSetting = await prisma.siteSetting.findUnique({
      where: { key: "metal_rates_visible" }
    });

    return res.json({
      success: true,
      data: formatRates(goldRate, silverRate, visibleSetting)
    });
  } catch (error) {
    console.error("Fetch metal rates error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// PUT /api/admin/metal-rates/visibility
router.put("/visibility", authMiddleware, async (req, res) => {
  try {
    const { visible } = req.body;
    
    await prisma.siteSetting.upsert({
      where: { key: "metal_rates_visible" },
      update: { value: visible ? "true" : "false" },
      create: { key: "metal_rates_visible", value: visible ? "true" : "false" },
    });

    return res.json({ success: true, message: "Visibility updated." });
  } catch (error) {
    console.error("Update visibility error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Manual update (fallback if API fails or admin wants to override)
router.put("/", authMiddleware, async (req, res) => {
  try {
    const { gold_ten_gram, silver_ten_gram } = req.body;
    
    if (gold_ten_gram) {
      await prisma.metalRate.create({
        data: {
          metalType: "GOLD",
          ratePerGram: gold_ten_gram / 10,
          updatedBy: req.user.id
        }
      });
    }
    
    if (silver_ten_gram) {
      await prisma.metalRate.create({
        data: {
          metalType: "SILVER",
          ratePerGram: silver_ten_gram / 10,
          updatedBy: req.user.id
        }
      });
    }

    return res.json({ success: true, message: "Rates updated manually." });
  } catch (error) {
    console.error("Update metal rates error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
