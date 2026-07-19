const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const authMiddleware = require("./middleware/authMiddleware");
const requireRole = require("./middleware/roleMiddleware");

// ─── Manual CORS for this router ─────────────────────────────────────────────
router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// ─── Upload directory ─────────────────────────────────────────────────────────
// Vercel serverless filesystem is read-only under /var/task.
// Only /tmp is writable (but not persistent across deploys).
const isVercel = Boolean(process.env.VERCEL);
const UPLOAD_DIR = isVercel
  ? path.join("/tmp", "uploads", "products-image")
  : path.join(__dirname, "uploads", "products-image");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── Multer config ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, unique);
  },
});

const fileFilter = (_req, file, cb) => {
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only JPEG, PNG, WEBP, and GIF images are allowed."));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ─── POST /api/uploads/product-image ─────────────────────────────────────────
router.post(
  "/product-image",
  authMiddleware,
  requireRole("SUPER_ADMIN", "ADMIN"),
  upload.single("image"),
  (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "No image file provided." });
    }
    const API_URL =
      process.env.API_URL ||
      (process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : `http://localhost:${process.env.PORT || 5000}`);
    // Keep the API response stable. In production on Vercel these files may
    // not persist, but this avoids runtime crashes.
    const url = `${API_URL}/api/uploads/products-image/${req.file.filename}`;
    return res.json({ success: true, data: { url } });
  },
);

// ─── Static serving for already-stored image URLs ──────────────────────────
// upload URLs returned by POST /product-image are under:
//   /api/uploads/products-image/:filename
// Since this router is mounted at /api/uploads in app.js, we must serve
// the matching sub-path here.
router.use(
  "/products-image",
  express.static(UPLOAD_DIR, { fallthrough: false }),
);

module.exports = router;
