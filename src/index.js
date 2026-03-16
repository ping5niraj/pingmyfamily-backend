require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');

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

// ─── Routes ────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

// Phase 1 routes
app.use('/api/relationships', require('./routes/relationships'));
// app.use('/api/tree', require('./routes/tree'));
// app.use('/api/invites', require('./routes/invites'));
// app.use('/api/inference', require('./routes/inference'));

// ─── 404 Handler ───────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global Error Handler ──────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PingMyFamily API running on port ${PORT}`);
  console.log(`[DEV] OTP is hardcoded: ${process.env.DEV_OTP || '123456'}`);
  console.log(`[DEV] Remember: MASTER_OTP must be removed before production`);
});
