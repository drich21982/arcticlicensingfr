const jwt = require("jsonwebtoken");
const pool = require("../db");

function founderEmail() {
  return String(process.env.ADMIN_SEED_EMAIL || "").trim().toLowerCase();
}

function isFounderUser(user) {
  return !!user && user.role === "admin" && String(user.email || "").toLowerCase() === founderEmail();
}

async function getPermissions(userId) {
  const result = await pool.query(
    "SELECT permission FROM admin_permissions WHERE user_id = $1 AND allowed = TRUE",
    [userId]
  );
  return result.rows.map(row => row.permission);
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing authorization token" });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      `SELECT id, email, name, role, created_at, COALESCE(disabled, FALSE) AS disabled
       FROM users
       WHERE id = $1`,
      [payload.id]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Invalid user" });
    }

    const user = result.rows[0];

    if (user.disabled) {
      return res.status(403).json({ error: "Account disabled" });
    }

    user.is_founder = isFounderUser(user);
    user.permissions = user.role === "admin" ? await getPermissions(user.id) : [];

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

function hasPermission(user, permission) {
  if (!user || user.role !== "admin") return false;
  if (user.is_founder) return true;
  if (Array.isArray(user.permissions) && user.permissions.includes("*")) return true;
  return Array.isArray(user.permissions) && user.permissions.includes(permission);
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (hasPermission(req.user, permission)) return next();
    return res.status(403).json({ error: `Missing permission: ${permission}` });
  };
}

module.exports = {
  auth,
  requireAdmin,
  requirePermission,
  hasPermission,
  isFounderUser,
  founderEmail,
  getPermissions
};
