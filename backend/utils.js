const crypto = require('crypto');
function makeLicenseKey(prefix = process.env.LICENSE_PREFIX || 'ARCTIC') {
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
function invoiceNumber() { return `INV-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function productIdFromName(name='') { return String(name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64); }
module.exports = { makeLicenseKey, normalizeDomain, activationFingerprint, invoiceNumber, productIdFromName };
