const jwt = require("jsonwebtoken");

/**
 * Generate a JWT token.
 * @param {{ id: string, role?: string, type: "admin" | "customer" }} payload
 * @param {{ expiresIn?: string }} [options] optional overrides (e.g. short-lived reset tokens)
 * @returns {string} signed JWT
 */
function generateToken(payload, options = {}) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: options.expiresIn || process.env.JWT_EXPIRES_IN || "7d",
  });
}

module.exports = generateToken;
