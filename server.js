const express = require("express");
const path = require("path");
const app = require("./app");

// Uploads folder + metal-rate scheduler only make sense on a real,
// persistent server — NOT on Vercel serverless. That's why these
// live here in server.js instead of app.js.
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const { startMetalRateScheduler } = require("./services/metalRateScheduler");
const { fetchAndStoreMetalRates } = require("./services/metalRatesFetcher");

const isVercel = Boolean(process.env.VERCEL);

if (!isVercel) {
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
