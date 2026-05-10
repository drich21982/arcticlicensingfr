require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true
}));

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), require('./routes/stripeWebhook'));
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => res.json({ name: 'Atlas Product Hub API', status: 'online', version: '2.0.0' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/customer', require('./routes/customer'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/license', require('./routes/license'));
app.use('/api/checkout', require('./routes/checkout'));

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (String(err.message || '').includes('CORS blocked')) return res.status(403).json({ error: err.message });
  res.status(500).json({ error: 'Server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Atlas Product Hub API running on port ${port}`));
