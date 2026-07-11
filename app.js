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

const adminAuth = require("./routes/admin/auth");
const adminSignup = require("./routes/admin/signup");
const adminRole = require("./routes/admin/role");
const adminAccounts = require("./routes/admin/accounts");
const adminMetalRates = require("./routes/admin/metalRates");
const adminSiteSettings = require("./routes/admin/siteSettings");
const adminForgotPassword = require("./routes/admin/forgotPassword");
const adminChangePassword = require("./routes/admin/changePassword");

app.use("/api/admin/auth", adminAuth);
app.use("/api/admin/signup", adminSignup);
app.use("/api/admin/role", adminRole);
app.use("/api/admin/accounts", adminAccounts);
app.use("/api/admin/metal-rates", adminMetalRates);
app.use("/api/admin/site-settings", adminSiteSettings);
app.use("/api/admin/forgot-password", adminForgotPassword);
app.use("/api/admin/change-password", adminChangePassword);

const customerAuth = require("./routes/customer/auth");
const customerSignup = require("./routes/customer/signup");
const customerForgotPassword = require("./routes/customer/forgotPassword");
const customerChangePassword = require("./routes/customer/changePassword");
const customerUpdateProfile = require("./routes/customer/updateProfile");
app.use("/api/customer/auth", customerAuth);
app.use("/api/customer/signup", customerSignup);
app.use("/api/customer/forgot-password", customerForgotPassword);
app.use("/api/customer/change-password", customerChangePassword);
app.use("/api/customer/profile", customerUpdateProfile);

const inquiry = require("./routes/inquery/index");
app.use("/api/inquiry", inquiry);

const product = require("./routes/products/index");
const categories = require("./routes/categories/index");
const customerOrders = require("./routes/customer/orders");
const adminOrders = require("./routes/admin/orders");
app.use("/api/products", product);
app.use("/api/categories", categories);
app.use("/api/customer/orders", customerOrders);
app.use("/api/admin/orders", adminOrders);

app.get("/", (req, res) => res.send("Anand Jewellers API — running"));

module.exports = app;
