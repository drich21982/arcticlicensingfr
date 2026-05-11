const express = require('express');
const pool = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  const { category, type, q, status = 'active' } = req.query;
  const vals = [];
  const where = [];
  if (status !== 'all') { vals.push(status); where.push(`status=$${vals.length}`); }
  if (category) { vals.push(category); where.push(`LOWER(category)=LOWER($${vals.length})`); }
  if (type) { vals.push(type); where.push(`LOWER(type)=LOWER($${vals.length})`); }
  if (q) { vals.push(`%${q}%`); where.push(`(name ILIKE $${vals.length} OR short_description ILIKE $${vals.length} OR description ILIKE $${vals.length})`); }
  const sql = `SELECT * FROM products ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY created_at DESC`;
  const result = await pool.query(sql, vals);
  res.json({ products: result.rows });
});

router.get('/:id', async (req, res) => {
  const r = await pool.query('SELECT * FROM products WHERE id=$1 OR slug=$1 LIMIT 1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Product not found' });
  const d = await pool.query('SELECT id, version, file_name, changelog, is_latest, created_at FROM downloads WHERE product_id=$1 ORDER BY created_at DESC', [r.rows[0].id]);
  res.json({ product: r.rows[0], downloads: d.rows });
});
module.exports = router;
