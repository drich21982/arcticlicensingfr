require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { normalizeOrigin } = require("./utils");
const { ensureSchema } = require("./dbInit");
const verifyRoutes = require("./routes/verify");

const app = express();

const allowedOrigins = [
  process.env.CORS_ORIGIN,
  process.env.FRONTEND_URL,
  "http://arcticlicensing.com",
  "http://www.arcticlicensing.com",
  "https://arcticlicensing.com",
  "https://www.arcticlicensing.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
].filter(Boolean).map(normalizeOrigin);

app.use(helmet({
  crossOriginResourcePolicy: false
}));

app.use(cors({
  origin: true,
  credentials: true
}));

// Stripe webhook needs raw body before express.json.
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Arctic Licensing API",
    version: "2.0.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.use("/api/auth", require("./routes/auth"));
app.use("/api/products", require("./routes/products"));
app.use("/api/license", require("./routes/license"));
app.use("/api/customer", require("./routes/customer"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/checkout", require("./routes/checkout"));
app.use("/api/stripe", require("./routes/stripe"));

app.use("/api/verify", verifyRoutes);
app.use("/api/admin/activations", require("./routes/adminActivations"));

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err.message === "CORS blocked") {
    return res.status(403).json({ error: "CORS blocked" });
  }
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Atlas Product Hub API running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
