const express = require('express');
const pool = require('../db');
const { normalizeDomain, activationFingerprint } = require('../utils');
const router = express.Router();

router.post('/verify', async (req, res) => {
  const { license_key, product_id, domain, ip, version } = req.body || {};
  if (!license_key || !product_id) {
    return res.status(400).json({ valid: false, reason: 'missing_license_key_or_product_id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const licRes = await client.query(
      `SELECT l.*, p.name product_name, p.version product_version, p.status product_status
       FROM licenses l JOIN products p ON p.id=l.product_id
       WHERE l.license_key=$1 AND l.product_id=$2 LIMIT 1`,
      [license_key, product_id]
    );
    const license = licRes.rows[0];
    if (!license) {
      await client.query('ROLLBACK');
      return res.json({ valid: false, reason: 'license_not_found', product: null, activation_status: 'none', max_activations: 0, current_activations: 0 });
    }

    const countRes = await client.query(`SELECT COUNT(*)::int count FROM license_activations WHERE license_id=$1 AND status='active'`, [license.id]);
    let currentActivations = countRes.rows[0].count;

    if (license.product_status !== 'active') throwReason('product_disabled');
    if (license.status !== 'active') throwReason(`license_${license.status}`);
    if (license.expires_at && new Date(license.expires_at) < new Date()) throwReason('license_expired');

    const requestDomain = normalizeDomain(domain || '');
    if (license.domain_lock && normalizeDomain(license.domain_lock) !== requestDomain) throwReason('domain_lock_mismatch');
    if (license.ip_lock && String(license.ip_lock).trim() !== String(ip || '').trim()) throwReason('ip_lock_mismatch');

    const fingerprint = activationFingerprint(requestDomain, ip || '');
    const existing = await client.query(`SELECT * FROM license_activations WHERE license_id=$1 AND fingerprint=$2 LIMIT 1`, [license.id, fingerprint]);

    let activationStatus = 'existing';
    if (existing.rows[0]) {
      await client.query(`UPDATE license_activations SET domain=$1, ip=$2, version=$3, last_checked_at=NOW(), status='active' WHERE id=$4`, [requestDomain, ip || '', version || '', existing.rows[0].id]);
    } else {
      if (currentActivations >= license.max_activations) throwReason('activation_limit_reached');
      await client.query(
        `INSERT INTO license_activations (license_id, product_id, domain, ip, version, fingerprint) VALUES ($1,$2,$3,$4,$5,$6)`,
        [license.id, product_id, requestDomain, ip || '', version || '', fingerprint]
      );
      currentActivations += 1;
      activationStatus = 'created';
    }

    await client.query('COMMIT');
    return res.json({
      valid: true,
      reason: 'valid',
      product: { id: license.product_id, name: license.product_name, version: license.product_version },
      activation_status: activationStatus,
      max_activations: license.max_activations,
      current_activations: currentActivations
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.safeReason) {
      const count = await pool.query(`SELECT COUNT(*)::int count FROM license_activations a JOIN licenses l ON l.id=a.license_id WHERE l.license_key=$1 AND a.status='active'`, [license_key]);
      return res.json({ valid: false, reason: err.safeReason, product: { id: product_id }, activation_status: 'blocked', max_activations: 0, current_activations: count.rows[0]?.count || 0 });
    }
    console.error(err);
    return res.status(500).json({ valid: false, reason: 'server_error' });
  } finally {
    client.release();
  }
});

function throwReason(reason) {
  const err = new Error(reason);
  err.safeReason = reason;
  throw err;
}

module.exports = router;
