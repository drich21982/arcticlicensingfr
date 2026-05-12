require("dotenv").config();

const bcrypt = require("bcryptjs");
const pool = require("./db");
const { ensureSchema, ADMIN_PERMISSION_KEYS } = require("./dbInit");

async function main() {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  const name = process.env.ADMIN_SEED_NAME || "Owner";

  if (!email || !password) {
    throw new Error("ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD are required");
  }

  await ensureSchema();

  const hash = await bcrypt.hash(password, 12);

  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, lower($2), $3, 'admin')
     ON CONFLICT (email)
     DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = 'admin'
     RETURNING email`,
    [name, email, hash]
  );

  const userIdResult = await pool.query("SELECT id FROM users WHERE lower(email)=lower($1)", [email]);
  const userId = userIdResult.rows[0].id;

  for (const permission of ADMIN_PERMISSION_KEYS) {
    await pool.query(
      `INSERT INTO admin_permissions (user_id, permission, allowed)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id, permission)
       DO UPDATE SET allowed = TRUE`,
      [userId, permission]
    );
  }

  console.log(`Founder admin ready: ${result.rows[0].email}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
