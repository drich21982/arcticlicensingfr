const express = require("express");
const pool = require("../db");
const { auth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.use(auth, requireAdmin);

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        la.*,
        l.license_key,
        p.name AS product_name
      FROM license_activations la
      LEFT JOIN licenses l ON l.id = la.license_id
      LEFT JOIN products p ON p.id = l.product_id
      ORDER BY la.last_seen_at DESC NULLS LAST
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load activations" });
  }
});

module.exports = router;
