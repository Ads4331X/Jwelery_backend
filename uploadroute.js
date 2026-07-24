const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const { put } = require("@vercel/blob");
const authMiddleware = require("./middleware/authMiddleware");
const requireRole = require("./middleware/roleMiddleware");

// ─── BLOB_READ_WRITE_TOKEN validation ─────────────────────────────────────────
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error(
    "[vercel-blob] BLOB_READ_WRITE_TOKEN is missing. " +
      "Create a Blob store in your Vercel dashboard (Storage → Create → Blob), " +
      "then copy the BLOB_READ_WRITE_TOKEN into your Vercel project's environment variables " +
      "and your local .env file for development.",
  );
}

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

// ─── Multer config (memoryStorage — Vercel Blob needs the raw buffer) ─────────
const MAX_FILE_SIZE = 4.5 * 1024 * 1024; // 4.5 MB (Vercel Blob upload limit)

const fileFilter = (_req, file, cb) => {
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only JPEG, PNG, WEBP, and GIF images are allowed."));
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

// ─── Multer error middleware (must come AFTER the upload handler) ────────────
// Multer v2 emits errors (file too large, wrong type) that propagate to Express
// but get swallowed by the global handler as "Internal server error". This
// middleware catches them specifically and returns a clear message.
const multerErrorHandler = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    // Multer-specific errors (e.g., file too large)
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: `File too large. Maximum allowed size is ${MAX_FILE_SIZE / 1024 / 1024} MB.`,
      });
    }
    return res.status(400).json({
      success: false,
      message: `Upload error: ${err.message}`,
    });
  }
  if (err) {
    // Custom errors (e.g., from fileFilter)
    return res.status(400).json({
      success: false,
      message: err.message || "Upload error.",
    });
  }
  next();
};

// ─── POST /api/uploads/product-image ─────────────────────────────────────────
router.post(
  "/product-image",
  authMiddleware,
  requireRole("SUPER_ADMIN", "ADMIN"),
  (req, res, next) => {
    upload.single("image")(req, res, (err) => {
      if (err) return multerErrorHandler(err, req, res, next);
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "No image file provided." });
      }

      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.status(500).json({
          success: false,
          message:
            "Server misconfigured: BLOB_READ_WRITE_TOKEN is not set. " +
            "Please add it in your Vercel dashboard (Storage → Blob) and in your local .env file.",
        });
      }

      const ext = path.extname(req.file.originalname).toLowerCase() || ".jpg";
      const uniqueFilename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

      // ─── Upload to Vercel Blob ───────────────────────────────────────────
      const blob = await put(
        `products-image/${uniqueFilename}`,
        req.file.buffer,
        {
          access: "public",
          contentType: req.file.mimetype,
        },
      );

      // blob.url is the real, permanent, publicly-accessible URL.
      // No API_URL prefixing needed — Vercel Blob URLs are absolute HTTPS.
      return res.json({ success: true, data: { url: blob.url } });
    } catch (error) {
      console.error("[upload-error]", error);
      return res.status(500).json({
        success: false,
        message: `Image upload failed: ${error.message || "Please try again."}`,
      });
    }
  },
);

// ─── Static serving NOT needed ────────────────────────────────────────────
// Vercel Blob URLs are served directly by Vercel's CDN, not by Express.
// The old express.static("/products-image", ...) middleware has been removed.

module.exports = router;
