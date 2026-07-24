const { del } = require("@vercel/blob");

/**
 * Delete product images from Vercel Blob storage.
 *
 * @param {string[]} urls - Array of Vercel Blob URLs to delete.
 *
 * Because Vercel Blob URLs are absolute HTTPS URLs, we can directly pass
 * them to del(). No filename extraction or filesystem path manipulation
 * is needed.
 *
 * In production (Vercel) and local development, this deletes from the same
 * real Blob store as long as BLOB_READ_WRITE_TOKEN is set.
 */
const deleteImageFiles = async (urls = []) => {
  if (!Array.isArray(urls) || urls.length === 0) return;

  const deletePromises = urls.map(async (url) => {
    if (!url || typeof url !== "string") return;
    try {
      await del(url);
    } catch (err) {
      // Don't crash the request when cleanup fails
      console.error("Failed to delete product image from Blob:", url, err);
    }
  });

  await Promise.allSettled(deletePromises);
};

module.exports = {
  deleteImageFiles,
};
