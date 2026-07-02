// src/services/metalRatesFetcher.js

const prisma = require("../config/prisma");

const METALS_API_URL = "https://api.metals.dev/v1/latest";

async function fetchAndStoreMetalRates() {
  const apiKey = process.env.METALS_API_KEY;

  if (!apiKey) {
    throw new Error("METALS_API_KEY is not set in .env");
  }

  const url = `${METALS_API_URL}?api_key=${apiKey}&currency=NPR&unit=g`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`metals.dev API failed (${res.status})`);
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
    throw new Error("Gold or Silver price missing from metals.dev response");
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
