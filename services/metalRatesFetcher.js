// src/services/metalRatesFetcher.js

const prisma = require("../config/prisma");

const METALS_API_URL = "https://api.metals.dev/v1/latest";

const DEFAULT_FALLBACK_RATES = {
  GOLD: 19329.01,  // NPR/gram — approximate
  SILVER: 279.28,
};

/**
 * Seeds the database with default/fallback metal rates if no rates exist.
 * This ensures the Khalti/eSewa payment flow never fails due to missing rates.
 */
async function seedDefaultRatesIfNeeded(prismaClient) {
  for (const [metalType, rate] of Object.entries(DEFAULT_FALLBACK_RATES)) {
    const existing = await prismaClient.metalRate.findFirst({
      where: { metalType },
      orderBy: { createdAt: "desc" },
    });
    if (!existing) {
      console.warn(
        `[metalRatesFetcher] No ${metalType} rate found — seeding default ${rate} NPR/g`,
      );
      await prismaClient.metalRate.create({
        data: {
          metalType,
          ratePerGram: rate.toFixed(2),
        },
      });
    }
  }
}

async function fetchAndStoreMetalRates() {
  const apiKey = process.env.METALS_API_KEY;

  // If no API key, fall back to defaults silently
  if (!apiKey) {
    console.warn(
      "[metalRatesFetcher] METALS_API_KEY is not set — using fallback default rates",
    );
    await seedDefaultRatesIfNeeded(prisma);
    return DEFAULT_FALLBACK_RATES;
  }

  const url = `${METALS_API_URL}?api_key=${apiKey}&currency=NPR&unit=g`;

  console.log(
    "[metalRatesFetcher] Request URL:",
    url.replace(apiKey, "***MASKED***"),
  );
  console.log("[metalRatesFetcher] API key length:", apiKey.length);

  let res;
  try {
    res = await fetch(url);
  } catch (fetchErr) {
    console.error("[metalRatesFetcher] Network error fetching metals.dev:", fetchErr.message);
    console.warn("[metalRatesFetcher] Falling back to default rates");
    await seedDefaultRatesIfNeeded(prisma);
    return DEFAULT_FALLBACK_RATES;
  }

  if (!res.ok) {
    let responseBody;
    try {
      responseBody = await res.text();
    } catch {
      responseBody = "(could not read body)";
    }
    console.error("[metalRatesFetcher] Request failed:", {
      status: res.status,
      statusText: res.statusText,
      body: responseBody,
      url: url.replace(apiKey, "***MASKED***"),
    });
    console.warn("[metalRatesFetcher] Falling back to default rates");
    await seedDefaultRatesIfNeeded(prisma);
    return DEFAULT_FALLBACK_RATES;
  }

  const json = await res.json();

  // Expected response:
  // {
  //   status: "success",
  //   currency: "NPR",
  //   unit: "g",
  //   metals: {
  //     gold: 19329.0098,
  //     silver: 279.2788,
  //     ...
  //   }
  // }

  const goldRate = Number(json?.metals?.gold);
  const silverRate = Number(json?.metals?.silver);

  if (Number.isNaN(goldRate) || Number.isNaN(silverRate)) {
    console.error("[metalRatesFetcher] Gold or Silver price missing from metals.dev response");
    console.warn("[metalRatesFetcher] Falling back to default rates");
    await seedDefaultRatesIfNeeded(prisma);
    return DEFAULT_FALLBACK_RATES;
  }

  await prisma.$transaction([
    prisma.metalRate.create({
      data: {
        metalType: "GOLD",
        ratePerGram: goldRate.toFixed(2),
      },
    }),
    prisma.metalRate.create({
      data: {
        metalType: "SILVER",
        ratePerGram: silverRate.toFixed(2),
      },
    }),
  ]);

  console.log(
    `[metalRatesFetcher] Stored GOLD=${goldRate.toFixed(
      2,
    )} NPR/g, SILVER=${silverRate.toFixed(2)} NPR/g`,
  );

  return {
    gold: goldRate,
    silver: silverRate,
    currency: json.currency,
    unit: json.unit,
    timestamp: json.timestamps?.metal,
  };
}

module.exports = {
  fetchAndStoreMetalRates,
};
