const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { auth, requireAdmin, requirePermission, hasPermission, isFounderUser } = require("../middleware/auth");
const { licenseKey } = require("../utils");
const { ADMIN_PERMISSION_KEYS } = require("../dbInit");

const router = express.Router();

router.use(auth, requireAdmin);

async function logAdmin(adminId, action, meta = {}) {
  try {
    await pool.query(
      "INSERT INTO admin_logs (admin_id, action, meta) VALUES ($1, $2, $3)",
      [adminId, action, meta]
    );
  } catch (err) {
    console.error("admin log failed", err);
  }
}

function cleanPermissionList(input = []) {
  return [...new Set((Array.isArray(input) ? input : [])
    .map(p => String(p || "").trim())
    .filter(p => ADMIN_PERMISSION_KEYS.includes(p)))];
}

async function getTargetUser(userId) {
  const result = await pool.query(
    `SELECT id, name, email, role, created_at, COALESCE(disabled, FALSE) AS disabled
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

function requireCanManageTarget(actor, target) {
  if (!target) return { ok: false, status: 404, error: "User not found" };
  if (target.id === actor.id) {
    return { ok: false, status: 400, error: "You cannot modify your own role or permissions here" };
  }
  if (isFounderUser(target)) {
    return { ok: false, status: 403, error: "Founder account cannot be modified" };
  }
  return { ok: true };
}

router.get("/permissions", async (req, res) => {
  res.json({ permissions: ADMIN_PERMISSION_KEYS });
});

router.get("/summary", async (req, res) => {
  try {
    const queries = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM users"),
      pool.query("SELECT COUNT(*)::int AS count FROM products"),
      pool.query("SELECT COUNT(*)::int AS count FROM licenses"),
      pool.query("SELECT COUNT(*)::int AS count FROM license_activations"),
      pool.query("SELECT COUNT(*)::int AS count FROM invoices"),
      pool.query("SELECT COALESCE(SUM(amount_cents),0)::int AS total FROM invoices WHERE status='paid'")
    ]);

    res.json({
      customers: queries[0].rows[0].count,
      products: queries[1].rows[0].count,
      licenses: queries[2].rows[0].count,
      activations: queries[3].rows[0].count,
      invoices: queries[4].rows[0].count,
      revenue_cents: queries[5].rows[0].total
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load admin summary" });
  }
});

router.get("/products", async (req, res) => {
  const result = await pool.query("SELECT * FROM products ORDER BY created_at DESC");
  res.json(result.rows);
});

router.post("/products", requirePermission("products.create"), async (req, res) => {
  try {
    const {
      id, name, slug, category, type, price_cents, short_description,
      description, image_url, version, status, stripe_price_id
    } = req.body;

    if (!id || !name || !slug) {
      return res.status(400).json({ error: "id, name, and slug are required" });
    }

    const result = await pool.query(
      `INSERT INTO products
       (id, name, slug, category, type, price_cents, short_description, description, image_url, version, status, stripe_price_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'active'),$12)
       RETURNING *`,
      [
        id, name, slug, category || "Website", type || "Files",
        Number(price_cents || 0), short_description || "", description || "",
        image_url || "", version || "1.0.0", status || "active", stripe_price_id || null
      ]
    );

    await logAdmin(req.user.id, "product.create", { product_id: id });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505" && err.constraint === "products_slug_key") {
      return res.status(409).json({ error: "A product with this slug already exists" });
    }
    res.status(500).json({ error: "Failed to create product" });
  }
});

router.patch("/products/:id", requirePermission("products.edit"), async (req, res) => {
  try {
    const fields = [
      "name", "slug", "category", "type", "price_cents", "short_description",
      "description", "image_url", "version", "status", "stripe_price_id"
    ];

    const updates = [];
    const values = [];

    fields.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        values.push(field === "price_cents" ? Number(req.body[field] || 0) : req.body[field]);
        updates.push(`${field} = $${values.length}`);
      }
    });

    if (!updates.length) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE products SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Product not found" });
    }

    await logAdmin(req.user.id, "product.update", { product_id: req.params.id });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505" && err.constraint === "products_slug_key") {
      return res.status(409).json({ error: "A product with this slug already exists" });
    }
    res.status(500).json({ error: "Failed to update product" });
  }
});

router.delete("/products/:id", requirePermission("products.archive"), async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE products SET status='archived', updated_at=NOW() WHERE id=$1 RETURNING id",
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Product not found" });
    await logAdmin(req.user.id, "product.archive", { product_id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to archive product" });
  }
});

router.get("/customers", requirePermission("customers.view"), async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const values = [];
    let where = "";

    if (q) {
      values.push(`%${q.toLowerCase()}%`);
      where = "WHERE lower(u.email) LIKE $1 OR lower(u.name) LIKE $1";
    }

    const result = await pool.query(
      `SELECT
          u.id,
          u.name,
          u.email,
          u.role,
          COALESCE(u.disabled, FALSE) AS disabled,
          CASE WHEN lower(u.email) = lower($${values.length + 1}) AND u.role='admin' THEN TRUE ELSE FALSE END AS is_founder,
          COALESCE(json_agg(ap.permission) FILTER (WHERE ap.allowed = TRUE AND ap.permission IS NOT NULL), '[]') AS permissions,
          u.created_at
       FROM users u
       LEFT JOIN admin_permissions ap ON ap.user_id = u.id
       ${where}
       GROUP BY u.id
       ORDER BY u.created_at DESC`,
      [...values, process.env.ADMIN_SEED_EMAIL || ""]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load customers" });
  }
});

router.get("/customers/:id/permissions", requirePermission("admins.view"), async (req, res) => {
  try {
    const target = await getTargetUser(req.params.id);
    if (!target) return res.status(404).json({ error: "User not found" });

    const result = await pool.query(
      "SELECT permission FROM admin_permissions WHERE user_id=$1 AND allowed=TRUE ORDER BY permission ASC",
      [req.params.id]
    );

    res.json({
      user: target,
      available: ADMIN_PERMISSION_KEYS,
      permissions: result.rows.map(row => row.permission)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load permissions" });
  }
});

router.patch("/customers/:id", requirePermission("customers.edit"), async (req, res) => {
  const client = await pool.connect();

  try {
    const target = await getTargetUser(req.params.id);
    const targetCheck = requireCanManageTarget(req.user, target);
    if (!targetCheck.ok) return res.status(targetCheck.status).json({ error: targetCheck.error });

    const { name, role, status, disabled, password, permissions } = req.body;
    const nextRole = role || target.role;
    const wantsAdmin = nextRole === "admin";
    const wasAdmin = target.role === "admin";

    if (role && !["customer", "admin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    if (!wasAdmin && wantsAdmin && !hasPermission(req.user, "customers.promote_admin")) {
      return res.status(403).json({ error: "Missing permission: customers.promote_admin" });
    }

    if (wasAdmin && role === "customer" && !hasPermission(req.user, "admins.demote")) {
      return res.status(403).json({ error: "Missing permission: admins.demote" });
    }

    if (permissions !== undefined && !hasPermission(req.user, "admins.manage_permissions")) {
      return res.status(403).json({ error: "Missing permission: admins.manage_permissions" });
    }

    await client.query("BEGIN");

    const updates = [];
    const values = [];

    if (name !== undefined) {
      values.push(name);
      updates.push(`name = $${values.length}`);
    }

    if (role !== undefined) {
      values.push(role);
      updates.push(`role = $${values.length}`);
    }

    if (status !== undefined || disabled !== undefined) {
      const isDisabled = disabled !== undefined ? !!disabled : status === "disabled";
      values.push(isDisabled);
      updates.push(`disabled = $${values.length}`);
    }

    if (password) {
      const hash = await bcrypt.hash(password, 12);
      values.push(hash);
      updates.push(`password_hash = $${values.length}`);
    }

    if (updates.length) {
      values.push(req.params.id);
      await client.query(
        `UPDATE users SET ${updates.join(", ")} WHERE id = $${values.length}`,
        values
      );
    }

    if (permissions !== undefined) {
      const requested = cleanPermissionList(permissions);

      if (!req.user.is_founder) {
        const impossible = requested.filter(p => !hasPermission(req.user, p));
        if (impossible.length) {
          throw new Error(`Cannot grant permissions you do not have: ${impossible.join(", ")}`);
        }
      }

      await client.query("DELETE FROM admin_permissions WHERE user_id=$1", [req.params.id]);
      if (nextRole === "admin") {
        for (const permission of requested) {
          await client.query(
            `INSERT INTO admin_permissions (user_id, permission, allowed)
             VALUES ($1, $2, TRUE)
             ON CONFLICT (user_id, permission)
             DO UPDATE SET allowed = TRUE`,
            [req.params.id, permission]
          );
        }
      }
    }

    if (role === "customer") {
      await client.query("DELETE FROM admin_permissions WHERE user_id=$1", [req.params.id]);
    }

    await client.query("COMMIT");

    await logAdmin(req.user.id, "user.update", {
      target_user_id: req.params.id,
      role: role || undefined,
      permissions_changed: permissions !== undefined
    });

    const updated = await getTargetUser(req.params.id);
    const permissionRows = await pool.query(
      "SELECT permission FROM admin_permissions WHERE user_id=$1 AND allowed=TRUE ORDER BY permission ASC",
      [req.params.id]
    );
    updated.permissions = permissionRows.rows.map(row => row.permission);
    updated.status = updated.disabled ? "disabled" : "active";

    res.json(updated);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to update customer" });
  } finally {
    client.release();
  }
});

router.get("/licenses", async (req, res) => {
  const result = await pool.query(
    `SELECT l.*, u.email AS user_email, p.name AS product_name
     FROM licenses l
     LEFT JOIN users u ON u.id = l.user_id
     JOIN products p ON p.id = l.product_id
     ORDER BY l.created_at DESC`
  );
  res.json(result.rows);
});

router.post("/licenses/generate", requirePermission("licenses.generate"), async (req, res) => {
  try {
    const { email, product_id, max_activations, expires_at } = req.body;

    if (!email || !product_id) {
      return res.status(400).json({ error: "email and product_id are required" });
    }

    let user = await pool.query("SELECT id FROM users WHERE lower(email)=lower($1)", [email]);

    if (!user.rows.length) {
      user = await pool.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, lower($2), '', 'customer')
         RETURNING id`,
        [email.split("@")[0], email]
      );
    }

    const key = licenseKey(process.env.LICENSE_PREFIX || "ARCTIC");

    const result = await pool.query(
      `INSERT INTO licenses (license_key, product_id, user_id, status, max_activations, expires_at)
       VALUES ($1, $2, $3, 'active', $4, $5)
       RETURNING *`,
      [key, product_id, user.rows[0].id, Number(max_activations || 1), expires_at || null]
    );

    await logAdmin(req.user.id, "license.generate", { product_id, email });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate license" });
  }
});

router.patch("/licenses/:id/status", requirePermission("licenses.disable"), async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "disabled", "revoked"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    if (status === "revoked" && !hasPermission(req.user, "licenses.revoke")) {
      return res.status(403).json({ error: "Missing permission: licenses.revoke" });
    }

    const result = await pool.query(
      "UPDATE licenses SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [status, req.params.id]
    );

    await logAdmin(req.user.id, "license.status", { license_id: req.params.id, status });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update license" });
  }
});

router.get("/downloads", async (req, res) => {
  const result = await pool.query(
    `SELECT d.*, p.name AS product_name
     FROM downloads d
     JOIN products p ON p.id = d.product_id
     ORDER BY d.created_at DESC`
  );
  res.json(result.rows);
});

router.post("/downloads", requirePermission("downloads.create"), async (req, res) => {
  try {
    const { product_id, title, file_url, version, status } = req.body;

    if (!product_id || !title || !file_url) {
      return res.status(400).json({ error: "product_id, title, and file_url are required" });
    }

    const result = await pool.query(
      `INSERT INTO downloads (product_id, title, file_url, version, status)
       VALUES ($1, $2, $3, $4, COALESCE($5,'active'))
       RETURNING *`,
      [product_id, title, file_url, version || "1.0.0", status || "active"]
    );

    await logAdmin(req.user.id, "download.create", { product_id, title });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create download" });
  }
});

router.patch("/downloads/:id", requirePermission("downloads.edit"), async (req, res) => {
  try {
    const fields = ["title", "file_url", "version", "status"];
    const updates = [];
    const values = [];

    fields.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        values.push(req.body[field]);
        updates.push(`${field} = $${values.length}`);
      }
    });

    if (!updates.length) return res.status(400).json({ error: "No fields to update" });

    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE downloads SET ${updates.join(", ")}, updated_at=NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    await logAdmin(req.user.id, "download.update", { download_id: req.params.id });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update download" });
  }
});

router.delete("/downloads/:id", requirePermission("downloads.delete"), async (req, res) => {
  try {
    await pool.query("UPDATE downloads SET status='archived', updated_at=NOW() WHERE id=$1", [req.params.id]);
    await logAdmin(req.user.id, "download.archive", { download_id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to archive download" });
  }
});

router.get("/activations", async (req, res) => {
  const result = await pool.query(
    `SELECT a.*, l.license_key, u.email AS user_email, p.name AS product_name
     FROM license_activations a
     JOIN licenses l ON l.id = a.license_id
     LEFT JOIN users u ON u.id = l.user_id
     JOIN products p ON p.id = l.product_id
     ORDER BY a.last_seen_at DESC`
  );
  res.json(result.rows);
});

router.get("/invoices", requirePermission("invoices.view"), async (req, res) => {
  const result = await pool.query(
    `SELECT i.*, u.email AS user_email, p.name AS product_name
     FROM invoices i
     LEFT JOIN users u ON u.id = i.user_id
     LEFT JOIN products p ON p.id = i.product_id
     ORDER BY i.created_at DESC`
  );
  res.json(result.rows);
});

router.get("/logs", requirePermission("logs.view"), async (req, res) => {
  const result = await pool.query(
    `SELECT l.*, u.email AS admin_email
     FROM admin_logs l
     LEFT JOIN users u ON u.id = l.admin_id
     ORDER BY l.created_at DESC
     LIMIT 250`
  );
  res.json(result.rows);
});

module.exports = router;
