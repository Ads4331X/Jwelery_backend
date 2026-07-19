const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const secret = process.env.ESEWA_SECRET;

router.get("/verify", (req, res) => {
  const token = req.query.data;
  if (!token) return res.status(400).json({ result: "Missing token" });

  const decodedData = Buffer.from(token, "base64").toString("utf-8");
  const data = JSON.parse(decodedData);
  const signedFields = data.signed_field_names.split(",");
  const message = signedFields.map((f) => `${f}=${data[f]}`).join(",");
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("base64");
  if (hmac === data.signature) {
    return res.json({
      message: "Payment Sucessfull",
      success: true,
    });
  } else {
    return res
      .status(403)
      .json({ result: "Invalid Signature", success: false });
  }
});

router.get("/failure", async (req, res) => {
  return res.status(403).json({
    message: "Payment Failed. Please try again later.",
    success: false,
  });
});

module.exports = router;
