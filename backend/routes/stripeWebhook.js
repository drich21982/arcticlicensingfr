const Stripe = require('stripe');
const pool = require('../db');
const { makeLicenseKey, invoiceNumber } = require('../utils');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

module.exports = async function stripeWebhook(req, res) {
  if (!stripe) return res.status(500).send('Stripe not configured');
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata && session.metadata.user_id;
    const productId = session.metadata && session.metadata.product_id;
    if (userId && productId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const already = await client.query('SELECT id FROM invoices WHERE provider_reference=$1 LIMIT 1', [session.id]);
        if (already.rowCount === 0) {
          const key = makeLicenseKey();
          const lic = await client.query(
            `INSERT INTO licenses (license_key, product_id, user_id, status, max_activations, stripe_session_id)
             VALUES ($1,$2,$3,'active',1,$4) RETURNING id`,
            [key, productId, userId, session.id]
          );
          await client.query(
            `INSERT INTO invoices (invoice_number, user_id, product_id, license_id, amount_cents, status, provider, provider_reference, hosted_invoice_url)
             VALUES ($1,$2,$3,$4,$5,'paid','stripe',$6,$7)`,
            [invoiceNumber(), userId, productId, lic.rows[0].id, session.amount_total || 0, session.id, session.url || null]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Stripe fulfillment failed:', err);
        return res.status(500).send('Fulfillment failed');
      } finally {
        client.release();
      }
    }
  }
  res.json({ received: true });
};
