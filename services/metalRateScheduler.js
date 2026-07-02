// services/metalRateScheduler.js
const cron = require("node-cron");
const { fetchAndStoreMetalRates } = require("./metalRatesFetcher");

function startMetalRateScheduler() {
  // Runs at 00:00 and 12:00 every day — twice daily, 12 hours apart
  cron.schedule("0 0,12 * * *", async () => {
    try {
      await fetchAndStoreMetalRates();
    } catch (err) {
      console.error("[metalRateScheduler] Fetch failed:", err.message);
    }
  });

  console.log("[metalRateScheduler] Scheduled — runs at 00:00 and 12:00 daily.");
}

module.exports = { startMetalRateScheduler };
