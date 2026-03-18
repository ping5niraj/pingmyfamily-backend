require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Health Check ──────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'PingMyFamily API',
    status: 'running',
    version: '1.0.0',
    phase: 'Phase 1 — Entertainer',
    timestamp: new Date().toISOString()
  });
});

// ─── Public Routes ─────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));

// ─── Protected Routes ──────────────────────────────────
app.use('/api/users', require('./routes/users'));
app.use('/api/relationships', require('./routes/relationships'));
app.use('/api/photos', require('./routes/photos'));

// ─── 404 Handler ───────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global Error Handler ──────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Prevent crashes ───────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception — server continues:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection — server continues:', reason);
});

// ─── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PingMyFamily API running on port ${PORT}`);
  console.log(`[DEV] OTP is hardcoded: ${process.env.DEV_OTP || '123456'}`);
});
