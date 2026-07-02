const jwt = require("jsonwebtoken");

/**
 * Generate a JWT token.
 * @param {{ id: string, role?: string, type: "admin" | "customer" }} payload
 * @returns {string} signed JWT
 */
function generateToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

module.exports = generateToken;
