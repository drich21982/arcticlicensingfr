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

async function getColumnType(tableName, columnName) {
  const result = await pool.query(
    `SELECT data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );

  return result.rows[0] || null;
}

function sqlTypeFromColumn(column) {
  if (!column) return "UUID";
  if (column.udt_name === "uuid") return "UUID";
  if (["int2", "int4", "int8"].includes(column.udt_name)) return "INTEGER";
  if (column.data_type && column.data_type.toLowerCase().includes("integer")) return "INTEGER";
  return "UUID";
}

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = $1
     LIMIT 1`,
    [tableName]
  );

  return result.rows.length > 0;
}

async function columnExists(tableName, columnName) {
  const column = await getColumnType(tableName, columnName);
  return !!column;
}

async function ensureStatusConstraint(tableName, constraintName) {
  const exists = await tableExists(tableName);
  if (!exists) return;

  const hasStatus = await columnExists(tableName, "status");
  if (!hasStatus) {
    console.warn(`[dbInit] Skipping ${constraintName}: ${tableName}.status does not exist`);
    return;
  }

  await pool.query(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${constraintName}`);
  await pool.query(`
    ALTER TABLE ${tableName}
    ADD CONSTRAINT ${constraintName}
    CHECK (status IN ('active', 'inactive', 'draft', 'archived'))
  `);
}

async function ensureSchema() {
  const usersExists = await tableExists("users");
  if (!usersExists) {
    console.warn("[dbInit] users table does not exist yet; skipping permission bootstrap");
    return;
  }

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS disabled BOOLEAN DEFAULT FALSE
  `);

  const usersIdColumn = await getColumnType("users", "id");
  const usersIdSqlType = sqlTypeFromColumn(usersIdColumn);
  const usersIdUdt = usersIdColumn?.udt_name || "uuid";

  const permissionsExists = await tableExists("admin_permissions");

  if (permissionsExists) {
    const existingPermissionUserId = await getColumnType("admin_permissions", "user_id");

    if (!existingPermissionUserId || existingPermissionUserId.udt_name !== usersIdUdt) {
      console.warn("[dbInit] Recreating admin_permissions due to user_id type mismatch");
      await pool.query(`DROP TABLE IF EXISTS admin_permissions CASCADE`);
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_permissions (
      id SERIAL PRIMARY KEY,
      user_id ${usersIdSqlType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      allowed BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, permission)
    )
  `);

  const logsExists = await tableExists("admin_logs");

  if (logsExists) {
    const existingLogAdminId = await getColumnType("admin_logs", "admin_id");

    if (existingLogAdminId && existingLogAdminId.udt_name !== usersIdUdt) {
      console.warn("[dbInit] Recreating admin_logs.admin_id due to type mismatch");
      await pool.query(`ALTER TABLE admin_logs DROP COLUMN IF EXISTS admin_id`);
      await pool.query(`
        ALTER TABLE admin_logs
        ADD COLUMN admin_id ${usersIdSqlType} REFERENCES users(id) ON DELETE SET NULL
      `);
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_logs (
      id SERIAL PRIMARY KEY,
      admin_id ${usersIdSqlType} REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await ensureStatusConstraint("products", "products_status_check");
  await ensureStatusConstraint("downloads", "downloads_status_check");
  await ensureStatusConstraint("licenses", "licenses_status_check");

  const founderEmail = String(process.env.ADMIN_SEED_EMAIL || "").trim().toLowerCase();

  if (founderEmail) {
    const founder = await pool.query(
      "SELECT id FROM users WHERE lower(email)=lower($1) AND role='admin'",
      [founderEmail]
    );

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
