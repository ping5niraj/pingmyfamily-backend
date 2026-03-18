const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const supabase = require('../supabase');

// In-memory OTP store — { phone: { otp, expiresAt } }
const otpStore = {};

// ─── Send OTP via MSG91 ────────────────────────────────────
async function sendOTPviaMSG91(phone, otp) {
  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  const senderId = process.env.MSG91_SENDER_ID || 'NALAMN';

  // MSG91 OTP API
  const url = 'https://api.msg91.com/api/v5/otp';

  const params = {
    template_id: templateId,
    mobile: `91${phone}`, // India country code
    authkey: authKey,
    otp: otp,
    sender: senderId,
  };

  const response = await axios.get(url, { params });
  console.log('MSG91 response:', response.data);
  return response.data;
}

// ─── GET /api/auth/send-otp ────────────────────────────────
router.get('/send-otp', (req, res) => {
  res.json({ message: 'Use POST /api/auth/send-otp with { phone } in the request body' });
});

// ─────────────────────────────────────────
// POST /api/auth/send-otp
// Body: { phone }
// ─────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  const normalised = phone.replace(/\s+/g, '');

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  // Store OTP
  otpStore[normalised] = { otp, expiresAt };

  const isDev = process.env.NODE_ENV !== 'production' && !process.env.MSG91_AUTH_KEY;

  if (isDev) {
    // DEV mode — no SMS
    console.log(`[DEV] OTP for ${normalised}: ${otp}`);
    return res.json({
      success: true,
      message: 'OTP sent (DEV mode — use 123456)',
      dev_otp: otp
    });
  }

  try {
    // Production — send via MSG91
    await sendOTPviaMSG91(normalised, otp);
    console.log(`[MSG91] OTP sent to ${normalised}`);

    return res.json({
      success: true,
      message: 'OTP sent successfully to your phone'
    });
  } catch (err) {
    console.error('MSG91 error:', err.response?.data || err.message);

    // Fallback — still store OTP, just log error
    return res.status(500).json({
      error: 'Failed to send OTP. Please try again.',
      details: err.response?.data?.message || err.message
    });
  }
});

// ─────────────────────────────────────────
// POST /api/auth/verify-otp
// Body: { phone, otp }
// ─────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone and OTP are required' });
  }

  const normalised = phone.replace(/\s+/g, '');
  const record = otpStore[normalised];

  if (!record) {
    return res.status(400).json({ error: 'OTP not requested for this number — please request OTP first' });
  }

  if (Date.now() > record.expiresAt) {
    delete otpStore[normalised];
    return res.status(400).json({ error: 'OTP expired — request a new one' });
  }

  if (record.otp !== otp) {
    return res.status(400).json({ error: 'Incorrect OTP. Please try again.' });
  }

  // OTP valid — clear it
  delete otpStore[normalised];

  // Check if user exists
  const { data: existingUser, error: fetchError } = await supabase
    .from('pmf_users')
    .select('*')
    .eq('phone', normalised)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
    console.error('Supabase fetch error:', fetchError);
    return res.status(500).json({ error: 'Database error' });
  }

  if (existingUser) {
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

  // New user
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
