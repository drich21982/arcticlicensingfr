const express = require("express");
const Stripe = require("stripe");
const pool = require("../db");
const { licenseKey } = require("../utils");

const router = express.Router();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const { fulfillCheckout } = require("../fulfillCheckout");
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

    console.log("Stripe webhook received:", event.type);

    if (event.type === "checkout.session.completed") {
      const result = await fulfillCheckout(event.data.object);
      console.log("Stripe checkout fulfilled:", event.data.object.id, result);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook error:", err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

module.exports = router;
