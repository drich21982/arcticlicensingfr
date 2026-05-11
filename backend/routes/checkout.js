const express = require('express');
const Stripe = require('stripe');
const pool = require('../db');
const { authRequired } = require('../middleware/auth');
const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

router.post('/create-session', authRequired, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe is not configured' });
    const { product_id } = req.body;
    const productRes = await pool.query('SELECT * FROM products WHERE id=$1 AND status=$2', [product_id, 'active']);
    const product = productRes.rows[0];
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (Number(product.price_cents) <= 0) return res.status(400).json({ error: 'Product has no price configured' });

    const frontend = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: req.user.email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: product.name, description: product.short_description || product.description || undefined, images: product.image_url && product.image_url.startsWith('http') ? [product.image_url] : undefined },
          unit_amount: Number(product.price_cents)
        },
        quantity: 1
      }],
      success_url: `${frontend}/dashboard/licenses.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontend}/products/details.html?id=${encodeURIComponent(product.id)}&checkout=cancelled`,
      metadata: { user_id: req.user.id, product_id: product.id }
    });
    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create Stripe checkout session' });
  }
});
module.exports = router;
