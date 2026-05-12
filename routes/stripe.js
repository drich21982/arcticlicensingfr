const express = require("express");
const Stripe = require("stripe");
const pool = require("../db");
const { licenseKey } = require("../utils");

const router = express.Router();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

async function fulfillCheckout(session) {
  const client = await pool.connect();

  try {
    if (!session || !session.id) {
      throw new Error("Invalid Stripe checkout session");
    }

    if (session.payment_status !== "paid") {
      throw new Error(`Checkout session is not paid. Current status: ${session.payment_status}`);
    }

    const userId = String(session.metadata?.user_id || "").trim();
    const productId = session.metadata?.product_id;

    if (!userId || !productId) {
      throw new Error("Missing Stripe metadata for fulfillment");
    }

    await client.query("BEGIN");

    const existingInvoice = await client.query(
      "SELECT id FROM invoices WHERE stripe_session_id = $1",
      [session.id]
    );

    if (existingInvoice.rows.length) {
      await client.query("COMMIT");
      return { alreadyFulfilled: true };
    }

    const productCheck = await client.query(
      "SELECT id FROM products WHERE id = $1",
      [productId]
    );

    if (!productCheck.rows.length) {
      throw new Error(`Product not found for fulfillment: ${productId}`);
    }

    const userCheck = await client.query(
      "SELECT id FROM users WHERE id = $1",
      [userId]
    );

    if (!userCheck.rows.length) {
      throw new Error(`User not found for fulfillment: ${userId}`);
    }

    const amount = Number(session.amount_total || 0);
    const currency = session.currency || "usd";

    await client.query(
      `INSERT INTO invoices
       (user_id, product_id, amount_cents, currency, status, stripe_session_id, stripe_payment_intent)
       VALUES ($1, $2, $3, $4, 'paid', $5, $6)`,
      [
        userId,
        productId,
        amount,
        currency,
        session.id,
        session.payment_intent || null
      ]
    );

    const key = licenseKey(process.env.LICENSE_PREFIX || "ARCTIC");

    await client.query(
      `INSERT INTO licenses
       (license_key, product_id, user_id, status, max_activations)
       VALUES ($1, $2, $3, 'active', 1)`,
      [key, productId, userId]
    );

    await client.query("COMMIT");

    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

router.post("/webhook", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).send("Stripe not configured");
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error("Missing STRIPE_WEBHOOK_SECRET");
      return res.status(500).send("Stripe webhook secret not configured");
    }

    const signature = req.headers["stripe-signature"];

    if (!signature) {
      return res.status(400).send("Missing Stripe signature");
    }

    const event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      webhookSecret
    );

    if (event.type === "checkout.session.completed") {
      await fulfillCheckout(event.data.object);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook error:", err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

module.exports = router;
