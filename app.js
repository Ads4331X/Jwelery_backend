require("dotenv").config();
const express = require("express");

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────
const uploadRoute = require("./uploadroute");
app.use("/api/uploads", uploadRoute);

const adminAuth = require("./api/admin/auth");
const adminSignup = require("./api/admin/signup");
const adminRole = require("./api/admin/role");
const adminAccounts = require("./api/admin/accounts");
const adminMetalRates = require("./api/admin/metalRates");
const adminSiteSettings = require("./api/admin/siteSettings");

app.use("/api/admin/auth", adminAuth);
app.use("/api/admin/signup", adminSignup);
app.use("/api/admin/role", adminRole);
app.use("/api/admin/accounts", adminAccounts);
app.use("/api/admin/metal-rates", adminMetalRates);
app.use("/api/admin/site-settings", adminSiteSettings);

const customerAuth = require("./api/customer/auth");
const customerSignup = require("./api/customer/signup");
app.use("/api/customer/auth", customerAuth);
app.use("/api/customer/signup", customerSignup);

const inquiry = require("./api/inquery/index");
app.use("/api/inquiry", inquiry);

const product = require("./api/products/index");
const categories = require("./api/categories/index");
app.use("/api/products", product);
app.use("/api/categories", categories);

app.get("/", (req, res) => res.send("Anand Jewellers API — running"));

module.exports = app;
