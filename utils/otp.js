const crypto = require("crypto");
const bcrypt = require("bcrypt");

const SALT_ROUNDS = 10;
const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

/**
 * Generate a random numeric OTP code, e.g. "483920".
 * Uses crypto.randomInt (CSPRNG) rather than Math.random, since Math.random
 * isn't safe for anything security-sensitive like a reset code.
 */
function generateOtp() {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = 10 ** OTP_LENGTH; // exclusive upper bound for randomInt
  return String(crypto.randomInt(min, max));
}

/**
 * Hash a plaintext OTP code before storing it.
 */
async function hashOtp(code) {
  return bcrypt.hash(code, SALT_ROUNDS);
}

/**
 * Compare a plaintext OTP code against its stored hash.
 */
async function compareOtp(code, hash) {
  return bcrypt.compare(code, hash);
}

/**
 * Returns a Date object OTP_TTL_MINUTES from now.
 */
function otpExpiry() {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
}

module.exports = {
  generateOtp,
  hashOtp,
  compareOtp,
  otpExpiry,
  OTP_TTL_MINUTES,
  MAX_ATTEMPTS,
};
