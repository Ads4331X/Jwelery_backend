/**
 * Factory: returns middleware that allows only the specified roles.
 * Must be used AFTER authMiddleware (expects req.user to exist).
 *
 * Usage: requireRole("SUPER_ADMIN", "ADMIN")
 *
 * @param  {...string} allowedRoles
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        message: "Authentication required.",
        success: false,
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: "Forbidden. Insufficient permissions.",
        success: false,
      });
    }

    next();
  };
}

module.exports = requireRole;
