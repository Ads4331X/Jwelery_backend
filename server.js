const express = require("express");
const path = require("path");
const app = require("./app");

// Note: Upload URLs are served by uploadroute.js at
//   /api/uploads/products-image/:filename
// (uploadRoute is mounted at /api/uploads in app.js).
// The legacy /uploads static middleware is intentionally not used because
// it doesn't match the URL scheme persisted in ProductImage.url.

const { startMetalRateScheduler } = require("./services/metalRateScheduler");
const { fetchAndStoreMetalRates } = require("./services/metalRatesFetcher");

const isVercel = Boolean(process.env.VERCEL);

if (require.main === module && !isVercel) {
  startMetalRateScheduler();

  // Fetch immediately on startup so the DB is never empty on first run.
  // Wrapped so a failure doesn't crash the server.
  fetchAndStoreMetalRates()
    .then(() => console.log("[startup] Metal rates fetched successfully."))
    .catch((err) =>
      console.warn("[startup] Metal rates fetch failed:", err.message),
    );

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () =>
    console.log(`Server running on http://localhost:${PORT}`),
  );
}
