const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

function signUser(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3)
       RETURNING id, name, email, role, status, created_at`,
      [name.trim(), email.toLowerCase().trim(), hash]
    );
    const user = result.rows[0];
    res.status(201).json({ token: signUser(user), user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email=$1 LIMIT 1', [String(email || '').toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Invalid login' });

    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid login' });

    const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status, created_at: user.created_at };
    res.json({ token: signUser(user), user: safeUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', authRequired, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, role, status, created_at FROM users WHERE id=$1', [req.user.id]);
  res.json({ user: result.rows[0] });
});

module.exports = router;
