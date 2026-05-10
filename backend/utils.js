const crypto = require('crypto');

function makeLicenseKey(prefix = 'ATLAS') {
  const raw = crypto.randomBytes(18).toString('hex').toUpperCase();
  const chunks = raw.match(/.{1,6}/g).slice(0, 4);
  return `${prefix}-${chunks.join('-')}`;
}

function normalizeDomain(domain = '') {
  return String(domain).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();
}

function activationFingerprint(domain, ip) {
  return crypto.createHash('sha256').update(`${normalizeDomain(domain)}|${ip || ''}`).digest('hex');
}

module.exports = { makeLicenseKey, normalizeDomain, activationFingerprint };
