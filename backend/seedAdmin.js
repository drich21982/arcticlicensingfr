require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function main() {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  const name = process.env.ADMIN_SEED_NAME || 'Atlas Owner';
  if (!email || !password) throw new Error('Set ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD in .env');
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1,$2,$3,'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role='admin', status='active', updated_at=NOW()`,
    [name, email.toLowerCase(), hash]
  );
  console.log(`Admin ready: ${email}`);
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
