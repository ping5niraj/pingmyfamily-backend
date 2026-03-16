const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');

// In-memory OTP store — { phone: { otp, expiresAt } }
// Fine for Phase 1 dev. Replace with Redis or DB in production.
const otpStore = {};

// ─────────────────────────────────────────
// POST /api/auth/send-otp
// Body: { phone }
// DEV: Always sends OTP 123456 (no SMS)
// TODO: Swap in MSG91 here when ready
// ─────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  // Normalise — strip spaces, ensure starts with country code
  const normalised = phone.replace(/\s+/g, '');

  // DEV: hardcoded OTP
  const otp = process.env.DEV_OTP || '123456';
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  otpStore[normalised] = { otp, expiresAt };

  console.log(`[DEV] OTP for ${normalised}: ${otp}`); // visible in Railway logs

  return res.json({
    success: true,
    message: 'OTP sent (DEV mode — use 123456)',
    // Remove the line below before production
    dev_otp: otp
  });
});

// ─────────────────────────────────────────
// POST /api/auth/verify-otp
// Body: { phone, otp }
// Returns: JWT token + user object (or isNewUser flag)
// ─────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone and OTP are required' });
  }

  const normalised = phone.replace(/\s+/g, '');
  const record = otpStore[normalised];

  if (!record) {
    return res.status(400).json({ error: 'OTP not requested for this number' });
  }

  if (Date.now() > record.expiresAt) {
    delete otpStore[normalised];
    return res.status(400).json({ error: 'OTP expired — request a new one' });
  }

  if (record.otp !== otp) {
    return res.status(400).json({ error: 'Incorrect OTP' });
  }

  // OTP valid — clear it
  delete otpStore[normalised];

  // Check if user already exists in pmf_users
  const { data: existingUser, error: fetchError } = await supabase
    .from('pmf_users')
    .select('*')
    .eq('phone', normalised)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
    // PGRST116 = no rows found — that's fine (new user)
    console.error('Supabase fetch error:', fetchError);
    return res.status(500).json({ error: 'Database error' });
  }

  if (existingUser) {
    // Returning user — issue token directly
    const token = jwt.sign(
      { id: existingUser.id, phone: existingUser.phone },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.json({
      success: true,
      isNewUser: false,
      token,
      user: {
        id: existingUser.id,
        name: existingUser.name,
        phone: existingUser.phone,
        gender: existingUser.gender,
        profile_photo: existingUser.profile_photo
      }
    });
  }

  // New user — return temp token so they can call POST /api/users to register
  const tempToken = jwt.sign(
    { phone: normalised, isTemp: true },
    process.env.JWT_SECRET,
    { expiresIn: '30m' }
  );

  return res.json({
    success: true,
    isNewUser: true,
    tempToken,
    message: 'Phone verified — complete registration via POST /api/users'
  });
});

module.exports = router;
