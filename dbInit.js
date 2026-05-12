const pool = require("./db");

const ADMIN_PERMISSION_KEYS = [
  "products.create",
  "products.edit",
  "products.archive",
  "products.delete",
  "downloads.create",
  "downloads.edit",
  "downloads.delete",
  "licenses.generate",
  "licenses.revoke",
  "licenses.disable",
  "customers.view",
  "customers.edit",
  "customers.promote_admin",
  "admins.view",
  "admins.manage_permissions",
  "admins.demote",
  "invoices.view",
  "tickets.view",
  "tickets.reply",
  "commissions.view",
  "commissions.manage",
  "settings.manage",
  "logs.view"
];

async function ensureSchema() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN DEFAULT FALSE`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_permissions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      allowed BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, permission)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_logs (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check`);
  await pool.query(`
    ALTER TABLE products
    ADD CONSTRAINT products_status_check
    CHECK (status IN ('active', 'inactive', 'draft', 'archived'))
  `);

  await pool.query(`ALTER TABLE downloads DROP CONSTRAINT IF EXISTS downloads_status_check`);
  await pool.query(`
    ALTER TABLE downloads
    ADD CONSTRAINT downloads_status_check
    CHECK (status IN ('active', 'inactive', 'draft', 'archived'))
  `);

  const founderEmail = String(process.env.ADMIN_SEED_EMAIL || "").trim().toLowerCase();
  if (founderEmail) {
    const founder = await pool.query("SELECT id FROM users WHERE lower(email)=lower($1) AND role='admin'", [founderEmail]);
    if (founder.rows.length) {
      for (const permission of ADMIN_PERMISSION_KEYS) {
        await pool.query(
          `INSERT INTO admin_permissions (user_id, permission, allowed)
           VALUES ($1, $2, TRUE)
           ON CONFLICT (user_id, permission)
           DO UPDATE SET allowed = TRUE`,
          [founder.rows[0].id, permission]
        );
      }
    }
  }
}

module.exports = { ensureSchema, ADMIN_PERMISSION_KEYS };
