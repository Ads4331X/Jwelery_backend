const jwt = require("jsonwebtoken");

/**
 * Middleware: verifies JWT from Authorization header.
 * Attaches decoded payload to req.user: { id, role, type }
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "Access denied. No token provided.",
      success: false,
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role, type, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({
      message: "Invalid or expired token.",
      success: false,
    });
  }
}

module.exports = authMiddleware;
