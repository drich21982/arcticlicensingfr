const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { isFounderUser, getPermissions } = require("../middleware/auth");
const router = express.Router();

function sign(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }

    const existing = await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);

    if (existing.rows.length) {
      return res.status(409).json({ error: "Email already exists" });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, lower($2), $3, 'customer')
       RETURNING id, name, email, role, created_at`,
      [name, email, hash]
    );

    const user = result.rows[0];
    user.is_founder = isFounderUser(user);
    user.permissions = user.role === "admin" ? await getPermissions(user.id) : [];

    res.json({
      token: sign(user),
      user
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT id, name, email, password_hash, role, created_at, COALESCE(disabled, FALSE) AS disabled FROM users WHERE lower(email) = lower($1)",
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const row = result.rows[0];

    if (row.disabled) {
      return res.status(403).json({ error: "Account disabled" });
    }

    const ok = await bcrypt.compare(password, row.password_hash || "");

    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      created_at: row.created_at,
      is_founder: isFounderUser(row),
      permissions: row.role === "admin" ? await getPermissions(row.id) : []
    };

    res.json({
      token: sign(user),
      user
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

module.exports = router;
