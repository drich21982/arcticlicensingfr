const express = require('express');
const pool = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { makeLicenseKey } = require('../utils');
const router = express.Router();

router.use(authRequired, adminRequired);

async function log(adminId, action, targetType, targetId, metadata = {}) {
  await pool.query(
    'INSERT INTO admin_logs (admin_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5)',
    [adminId, action, targetType, targetId, metadata]
  ).catch(() => {});
}
function clean(v){ return typeof v === 'string' ? v.trim() : v; }

router.get('/summary', async (req, res) => {
  const [users, products, licenses, activations, invoices] = await Promise.all([
    pool.query('SELECT COUNT(*)::int total FROM users'),
    pool.query('SELECT COUNT(*)::int total FROM products'),
    pool.query(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='active')::int active FROM licenses`),
    pool.query('SELECT COUNT(*)::int total FROM license_activations'),
    pool.query('SELECT COALESCE(SUM(amount_cents),0)::int revenue FROM invoices WHERE status=$1', ['paid'])
  ]);
  res.json({ summary: { users: users.rows[0].total, products: products.rows[0].total, licenses: licenses.rows[0], activations: activations.rows[0].total, revenue_cents: invoices.rows[0].revenue } });
});

router.get('/customers', async (req, res) => {
  const result = await pool.query('SELECT id, name, email, role, status, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT 1000');
  res.json({ customers: result.rows });
});

router.patch('/customers/:id', async (req, res) => {
  const allowedRoles = ['customer','admin'];
  const allowedStatuses = ['active','disabled'];
  const role = req.body.role ? clean(req.body.role) : null;
  const status = req.body.status ? clean(req.body.status) : null;
  if (role && !allowedRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (status && !allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const result = await pool.query(
    `UPDATE users SET role=COALESCE($1, role), status=COALESCE($2, status), updated_at=NOW() WHERE id=$3 RETURNING id,name,email,role,status,created_at,updated_at`,
    [role, status, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Customer not found' });
  await log(req.user.id, 'customer_updated', 'user', req.params.id, { role, status });
  res.json({ customer: result.rows[0] });
});

router.get('/products', async (req, res) => {
  const result = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
  res.json({ products: result.rows });
});

router.post('/products', async (req, res) => {
  const p = req.body;
  if (!p.id || !p.name || !p.slug) return res.status(400).json({ error: 'Product ID, name, and slug are required' });
  const result = await pool.query(
    `INSERT INTO products (id,name,slug,category,type,price_cents,short_description,description,image_url,version,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [clean(p.id), clean(p.name), clean(p.slug), clean(p.category) || 'Website', clean(p.type) || 'Digital Product', Number(p.price_cents || 0), clean(p.short_description) || '', clean(p.description) || '', clean(p.image_url) || '../assets/img/product-placeholder.svg', clean(p.version) || '1.0.0', clean(p.status) || 'active']
  );
  await log(req.user.id, 'product_created', 'product', result.rows[0].id, result.rows[0]);
  res.status(201).json({ product: result.rows[0] });
});

router.put('/products/:id', async (req, res) => {
  const p = req.body;
  if (!p.name || !p.slug) return res.status(400).json({ error: 'Product name and slug are required' });
  const result = await pool.query(
    `UPDATE products SET name=$1, slug=$2, category=$3, type=$4, price_cents=$5, short_description=$6, description=$7, image_url=$8, version=$9, status=$10, updated_at=NOW()
     WHERE id=$11 RETURNING *`,
    [clean(p.name), clean(p.slug), clean(p.category) || 'Website', clean(p.type) || 'Digital Product', Number(p.price_cents || 0), clean(p.short_description) || '', clean(p.description) || '', clean(p.image_url) || '../assets/img/product-placeholder.svg', clean(p.version) || '1.0.0', clean(p.status) || 'active', req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Product not found' });
  await log(req.user.id, 'product_updated', 'product', req.params.id, p);
  res.json({ product: result.rows[0] });
});

router.delete('/products/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM products WHERE id=$1 RETURNING *', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Product not found' });
  await log(req.user.id, 'product_deleted', 'product', req.params.id, result.rows[0]);
  res.json({ success: true, product: result.rows[0] });
});

router.get('/licenses', async (req, res) => {
  const result = await pool.query(`
    SELECT l.*, p.name product_name, u.email customer_email, COALESCE(a.current_activations,0)::int current_activations
    FROM licenses l
    JOIN products p ON p.id=l.product_id
    LEFT JOIN users u ON u.id=l.user_id
    LEFT JOIN (SELECT license_id, COUNT(*) FILTER (WHERE status='active') current_activations FROM license_activations GROUP BY license_id) a ON a.license_id=l.id
    ORDER BY l.created_at DESC LIMIT 1000`);
  res.json({ licenses: result.rows });
});

router.post('/licenses/generate', async (req, res) => {
  const { product_id, user_email, max_activations, domain_lock, ip_lock, expires_at, notes, count } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id is required' });
  const product = await pool.query('SELECT id FROM products WHERE id=$1', [product_id]);
  if (!product.rows[0]) return res.status(404).json({ error: 'Product not found' });
  const qty = Math.max(1, Math.min(Number(count || 1), 100));
  const userRes = user_email ? await pool.query('SELECT id FROM users WHERE email=$1 LIMIT 1', [user_email.toLowerCase().trim()]) : { rows: [] };
  const userId = userRes.rows[0]?.id || null;
  const created = [];
  for (let i = 0; i < qty; i++) {
    const key = makeLicenseKey('ATLAS');
    const result = await pool.query(
      `INSERT INTO licenses (license_key, product_id, user_id, max_activations, domain_lock, ip_lock, expires_at, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [key, product_id, userId, Number(max_activations || 1), clean(domain_lock) || null, clean(ip_lock) || null, expires_at || null, clean(notes) || null, req.user.id]
    );
    created.push(result.rows[0]);
  }
  await log(req.user.id, 'licenses_generated', 'license', product_id, { count: qty, product_id, user_email });
  res.status(201).json({ licenses: created });
});

router.patch('/licenses/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['active','revoked','disabled','expired'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const result = await pool.query('UPDATE licenses SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [status, req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'License not found' });
  await log(req.user.id, 'license_status_updated', 'license', req.params.id, { status });
  res.json({ license: result.rows[0] });
});

router.get('/downloads', async (req, res) => {
  const result = await pool.query(`SELECT d.*, p.name product_name FROM downloads d JOIN products p ON p.id=d.product_id ORDER BY d.created_at DESC`);
  res.json({ downloads: result.rows });
});

router.post('/downloads', async (req, res) => {
  const d = req.body;
  if (!d.product_id || !d.file_name || !d.file_url) return res.status(400).json({ error: 'Product, file name, and file URL are required' });
  const result = await pool.query(`INSERT INTO downloads (product_id, version, file_name, file_url, changelog, is_latest) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [clean(d.product_id), clean(d.version) || '1.0.0', clean(d.file_name), clean(d.file_url), clean(d.changelog) || '', d.is_latest !== false]);
  await log(req.user.id, 'download_created', 'download', result.rows[0].id, result.rows[0]);
  res.status(201).json({ download: result.rows[0] });
});

router.put('/downloads/:id', async (req, res) => {
  const d = req.body;
  const result = await pool.query(`UPDATE downloads SET product_id=$1, version=$2, file_name=$3, file_url=$4, changelog=$5, is_latest=$6 WHERE id=$7 RETURNING *`, [clean(d.product_id), clean(d.version) || '1.0.0', clean(d.file_name), clean(d.file_url), clean(d.changelog) || '', d.is_latest !== false, req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Download not found' });
  await log(req.user.id, 'download_updated', 'download', req.params.id, result.rows[0]);
  res.json({ download: result.rows[0] });
});

router.delete('/downloads/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM downloads WHERE id=$1 RETURNING *', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Download not found' });
  await log(req.user.id, 'download_deleted', 'download', req.params.id, result.rows[0]);
  res.json({ success: true });
});

router.get('/activations', async (req, res) => {
  const result = await pool.query(`SELECT a.*, l.license_key, p.name product_name FROM license_activations a JOIN licenses l ON l.id=a.license_id JOIN products p ON p.id=a.product_id ORDER BY a.last_checked_at DESC LIMIT 1000`);
  res.json({ activations: result.rows });
});

router.get('/invoices', async (req, res) => {
  const result = await pool.query(`SELECT i.*, u.email customer_email, p.name product_name FROM invoices i LEFT JOIN users u ON u.id=i.user_id LEFT JOIN products p ON p.id=i.product_id ORDER BY i.created_at DESC LIMIT 1000`);
  res.json({ invoices: result.rows });
});

router.post('/invoices', async (req, res) => {
  const i = req.body;
  if (!i.invoice_number) return res.status(400).json({ error: 'Invoice number is required' });
  const userRes = i.user_email ? await pool.query('SELECT id FROM users WHERE email=$1 LIMIT 1', [i.user_email.toLowerCase().trim()]) : { rows: [] };
  const licenseRes = i.license_key ? await pool.query('SELECT id FROM licenses WHERE license_key=$1 LIMIT 1', [i.license_key.trim()]) : { rows: [] };
  const result = await pool.query(
    `INSERT INTO invoices (invoice_number, user_id, product_id, license_id, amount_cents, status, provider, provider_reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [clean(i.invoice_number), userRes.rows[0]?.id || null, clean(i.product_id) || null, licenseRes.rows[0]?.id || null, Number(i.amount_cents || 0), clean(i.status) || 'paid', clean(i.provider) || 'manual', clean(i.provider_reference) || null]
  );
  await log(req.user.id, 'invoice_created', 'invoice', result.rows[0].id, result.rows[0]);
  res.status(201).json({ invoice: result.rows[0] });
});

module.exports = router;
