const fs = require("fs");
const path = require("path");

// In your codebase, product images are uploaded to:
// uploads/products-image/<filename>
const PRODUCTS_IMAGE_DIR = path.join(
  process.cwd(),
  "uploads",
  "products-image",
);

const extractFilename = (urlOrPath) => {
  if (!urlOrPath) return null;
  const str = String(urlOrPath);
  // If it's a URL, grab the last segment.
  const parts = str.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
};

const deleteImageFiles = (urls = []) => {
  if (!Array.isArray(urls)) return;

  for (const u of urls) {
    const filename = extractFilename(u);
    if (!filename) continue;

    const filePath = path.join(PRODUCTS_IMAGE_DIR, filename);

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      // Don't crash the request when cleanup fails
      console.error("Failed to delete product image:", filePath, err);
    }
  }
};

module.exports = {
  deleteImageFiles,
};
