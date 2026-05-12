const pool = require("./db");
const { licenseKey } = require("./utils");

async function tableColumns(client, tableName) {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [tableName]
  );
  return new Set(result.rows.map(r => r.column_name));
}

async function findProductIdFromSession(client, stripe, session) {
  const metaProductId = String(session.metadata?.product_id || "").trim();
  if (metaProductId) return metaProductId;

  // Fallback for checkout sessions created before metadata was added.
  // Match by Stripe Price ID when possible.
  if (stripe && session.id) {
    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
      for (const item of lineItems.data || []) {
        const priceId = item.price?.id;
        if (!priceId) continue;
        const found = await client.query(
          "SELECT id FROM products WHERE stripe_price_id = $1 LIMIT 1",
          [priceId]
        );
        if (found.rows.length) return found.rows[0].id;
      }
    } catch (err) {
      console.warn("Could not infer product from Stripe line items:", err.message);
    }
  }

  throw new Error("Missing product_id metadata and product could not be inferred from Stripe session");
}

async function fulfillCheckout(session, options = {}) {
  const client = await pool.connect();
  const stripe = options.stripe || null;
  const fallbackUserId = options.fallbackUserId || null;

  try {
    if (!session || !session.id) throw new Error("Invalid Stripe checkout session");
    if (session.payment_status !== "paid") {
      throw new Error(`Checkout session is not paid. Current status: ${session.payment_status}`);
    }

    await client.query("BEGIN");

    const userId = String(session.metadata?.user_id || fallbackUserId || "").trim();
    if (!userId) throw new Error("Missing user_id metadata and no authenticated fallback user was provided");

    const productId = await findProductIdFromSession(client, stripe, session);

    const productCheck = await client.query("SELECT id FROM products WHERE id = $1", [productId]);
    if (!productCheck.rows.length) throw new Error(`Product not found for fulfillment: ${productId}`);

    const userCheck = await client.query("SELECT id FROM users WHERE id = $1", [userId]);
    if (!userCheck.rows.length) throw new Error(`User not found for fulfillment: ${userId}`);

    const invoiceCols = await tableColumns(client, "invoices");
    if (invoiceCols.has("stripe_session_id")) {
      const existingInvoice = await client.query("SELECT id FROM invoices WHERE stripe_session_id = $1 LIMIT 1", [session.id]);
      if (existingInvoice.rows.length) {
        await client.query("COMMIT");
        return { ok: true, alreadyFulfilled: true };
      }
    }

    const amount = Number(session.amount_total || 0);
    const currency = String(session.currency || "usd").toLowerCase();

    const invoiceInsertCols = [];
    const invoiceValues = [];
    const addInvoice = (col, val) => {
      if (invoiceCols.has(col)) {
        invoiceInsertCols.push(col);
        invoiceValues.push(val);
      }
    };

    addInvoice("user_id", userId);
    addInvoice("product_id", productId);
    addInvoice("amount_cents", amount);
    addInvoice("amount", amount); // legacy fallback if older DB used amount instead of amount_cents
    addInvoice("currency", currency);
    addInvoice("status", "paid");
    addInvoice("stripe_session_id", session.id);
    addInvoice("stripe_payment_intent", session.payment_intent || null);
    addInvoice("payment_method", "stripe");

    if (invoiceInsertCols.length) {
      const placeholders = invoiceInsertCols.map((_, i) => `$${i + 1}`).join(", ");
      await client.query(
        `INSERT INTO invoices (${invoiceInsertCols.join(", ")}) VALUES (${placeholders})`,
        invoiceValues
      );
    } else {
      throw new Error("Invoices table has no compatible columns for fulfillment");
    }

    const licensesCols = await tableColumns(client, "licenses");
    const key = licenseKey(process.env.LICENSE_PREFIX || "ARCTIC");

    const licenseInsertCols = [];
    const licenseValues = [];
    const addLicense = (col, val) => {
      if (licensesCols.has(col)) {
        licenseInsertCols.push(col);
        licenseValues.push(val);
      }
    };

    addLicense("license_key", key);
    addLicense("key", key); // legacy fallback
    addLicense("product_id", productId);
    addLicense("user_id", userId);
    addLicense("status", "active");
    addLicense("max_activations", 1);
    addLicense("activations_allowed", 1);

    if (!licenseInsertCols.includes("license_key") && !licenseInsertCols.includes("key")) {
      throw new Error("Licenses table is missing license_key/key column");
    }

    const licensePlaceholders = licenseInsertCols.map((_, i) => `$${i + 1}`).join(", ");
    await client.query(
      `INSERT INTO licenses (${licenseInsertCols.join(", ")}) VALUES (${licensePlaceholders})`,
      licenseValues
    );

    await client.query("COMMIT");
    return { ok: true, alreadyFulfilled: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { fulfillCheckout };
