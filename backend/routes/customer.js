const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');
const router = express.Router();
router.use(authRequired);

router.get('/summary', async (req, res) => {
  const [licenses, downloads, invoices, tickets] = await Promise.all([
    pool.query('SELECT COUNT(*)::int n FROM licenses WHERE user_id=$1', [req.user.id]),
    pool.query(`SELECT COUNT(*)::int n FROM downloads d JOIN licenses l ON l.product_id=d.product_id WHERE l.user_id=$1 AND l.status='active'`, [req.user.id]),
    pool.query('SELECT COUNT(*)::int n FROM invoices WHERE user_id=$1', [req.user.id]),
    pool.query('SELECT COUNT(*)::int n FROM support_tickets WHERE user_id=$1 AND status<>$2', [req.user.id, 'closed'])
  ]);
  res.json({ summary: { licenses: licenses.rows[0].n, downloads: downloads.rows[0].n, invoices: invoices.rows[0].n, open_tickets: tickets.rows[0].n } });
});
router.get('/licenses', async (req, res) => {
  const r = await pool.query(`SELECT l.*, p.name product_name, p.version product_version FROM licenses l JOIN products p ON p.id=l.product_id WHERE l.user_id=$1 ORDER BY l.created_at DESC`, [req.user.id]);
  res.json({ licenses: r.rows });
});
router.get('/activations', async (req, res) => {
  const r = await pool.query(`SELECT a.*, p.name product_name, l.license_key FROM license_activations a JOIN products p ON p.id=a.product_id JOIN licenses l ON l.id=a.license_id WHERE l.user_id=$1 ORDER BY a.last_checked_at DESC`, [req.user.id]);
  res.json({ activations: r.rows });
});
router.get('/downloads', async (req, res) => {
  const r = await pool.query(`SELECT DISTINCT d.*, p.name product_name FROM downloads d JOIN products p ON p.id=d.product_id JOIN licenses l ON l.product_id=p.id WHERE l.user_id=$1 AND l.status='active' ORDER BY d.created_at DESC`, [req.user.id]);
  res.json({ downloads: r.rows });
});
router.get('/invoices', async (req, res) => {
  const r = await pool.query(`SELECT i.*, p.name product_name FROM invoices i LEFT JOIN products p ON p.id=i.product_id WHERE i.user_id=$1 ORDER BY i.created_at DESC`, [req.user.id]);
  res.json({ invoices: r.rows });
});
router.post('/support', async (req, res) => {
  const { subject, message, priority='normal' } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });
  const r = await pool.query(`INSERT INTO support_tickets (user_id, subject, message, priority) VALUES ($1,$2,$3,$4) RETURNING *`, [req.user.id, subject, message, priority]);
  res.status(201).json({ ticket: r.rows[0] });
});
router.get('/support', async (req, res) => {
  const r = await pool.query('SELECT * FROM support_tickets WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ tickets: r.rows });
});
router.patch('/account', async (req, res) => {
  const { name, password } = req.body;
  if (name) await pool.query('UPDATE users SET name=$1, updated_at=NOW() WHERE id=$2', [name, req.user.id]);
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [await bcrypt.hash(password, 12), req.user.id]);
  }
  const r = await pool.query('SELECT id,name,email,role,status,created_at FROM users WHERE id=$1', [req.user.id]);
  res.json({ user: r.rows[0] });
});
module.exports = router;
