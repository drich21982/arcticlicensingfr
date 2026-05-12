const express = require("express");
const Stripe = require("stripe");
const pool = require("../db");
const { auth } = require("../middleware/auth");
const { publicUrl } = require("../utils");
const { fulfillCheckout } = require("../fulfillCheckout");
const router = express.Router();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

router.post("/create-session", auth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured" });
    }

    const { product_id } = req.body;

    if (!product_id) {
      return res.status(400).json({ error: "product_id is required" });
    }

    const productResult = await pool.query(
      "SELECT * FROM products WHERE id = $1 AND status = 'active'",
      [product_id]
    );

    if (!productResult.rows.length) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = productResult.rows[0];

    const sessionConfig = {
      mode: "payment",
      customer_email: req.user.email,
      success_url: publicUrl(`/dashboard/licenses.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`),
      cancel_url: publicUrl(`/products/details.html?id=${encodeURIComponent(product.id)}&checkout=cancelled`),
      metadata: {
        user_id: String(req.user.id),
        product_id: String(product.id)
      }
    };

    if (product.stripe_price_id) {
      sessionConfig.line_items = [
        { price: product.stripe_price_id, quantity: 1 }
      ];
    } else {
      sessionConfig.line_items = [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Number(product.price_cents || 0),
            product_data: {
              name: product.name,
              description: product.short_description || product.description || undefined
            }
          }
        }
      ];
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});


router.get("/confirm-session/:sessionId", auth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured" });
    }

    const sessionId = String(req.params.sessionId || "").trim();

    if (!sessionId.startsWith("cs_")) {
      return res.status(400).json({ error: "Invalid checkout session" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const sessionUserId = String(session.metadata?.user_id || "").trim();

    if (sessionUserId !== String(req.user.id)) {
      return res.status(403).json({ error: "This checkout session does not belong to your account" });
    }

    const result = await fulfillCheckout(session);
    res.json(result);
  } catch (err) {
    console.error("Checkout confirmation failed:", err);
    res.status(500).json({ error: err.message || "Failed to confirm checkout" });
  }
});

module.exports = router;
