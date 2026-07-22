require("dotenv").config();
const express = require("express");

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Must echo back the requesting origin (not wildcard '*') when credentials are
// included in the request (i.e. auth cookies). For development we allow
// localhost:5173 (Vite). In production, the FRONTEND_URL env var is used, and
// any *.vercel.app domain is automatically allowed (for Vercel preview deploys).
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5000",
  process.env.FRONTEND_URL,
].filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return false;
  // Check exact matches (local dev + configured FRONTEND_URL)
  if (allowedOrigins.includes(origin)) return true;
  // Allow any Vercel deployment subdomain
  if (origin.endsWith(".vercel.app")) return true;
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else if (!origin) {
    // server-to-server or same-origin requests
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  // If origin is present but not allowed, we simply don't set CORS headers
  // so the browser will enforce the same-origin policy.

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    // For preflight, we MUST send the CORS headers before returning 204,
    // otherwise the browser rejects the actual request.
    return res.sendStatus(204);
  }

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
const customerAddresses = require("./routes/customer/addresses");
const customerSignupVerify = require("./routes/customer/signupVerify");
const customerSignupResendOtp = require("./routes/customer/signupResendOtp");

app.use("/api/customer/auth", customerAuth);
app.use("/api/customer/signup", customerSignup);
app.use("/api/customer/signup", customerSignupVerify);
app.use("/api/customer/signup", customerSignupResendOtp);
app.use("/api/customer/forgot-password", customerForgotPassword);
app.use("/api/customer/change-password", customerChangePassword);
app.use("/api/customer/profile", customerUpdateProfile);
app.use("/api/customer/addresses", customerAddresses);

const inquiry = require("./routes/inquery/index");
app.use("/api/inquiry", inquiry);

const product = require("./routes/products/index");
const productReviews = require("./routes/products/reviews");
const categories = require("./routes/categories/index");
const customerOrders = require("./routes/customer/orders");
const adminOrders = require("./routes/admin/orders");
const adminOrdersStats = require("./routes/admin/ordersStats");
app.use("/api/products", product);
app.use("/api/products/:productId/reviews", productReviews);

app.use("/api/categories", categories);
app.use("/api/customer/orders", customerOrders);
app.use("/api/admin/orders", adminOrders);
app.use("/api/admin/orders", adminOrdersStats);

const esewaRoutes = require("./routes/esewa");
app.use("/api/esewa", esewaRoutes);

const adminReviews = require("./routes/admin/reviews");
app.use("/api/admin/reviews", adminReviews);

app.get("/", (req, res) => res.send("Anand Jewellers API — running"));

module.exports = app;
