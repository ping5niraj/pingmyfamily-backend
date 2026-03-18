const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const supabase = require('../supabase');

// In-memory OTP store
const otpStore = {};

// ─── Send OTP via MSG91 ────────────────────────────────────
async function sendOTPviaMSG91(phone, otp) {
  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  const senderId = process.env.MSG91_SENDER_ID || 'NALAMN';

  console.log('[MSG91] Sending OTP to:', phone);
  console.log('[MSG91] Template ID:', templateId);
  console.log('[MSG91] Sender ID:', senderId);

  // MSG91 Send OTP API — correct format
  const url = `https://api.msg91.com/api/v5/otp?template_id=${templateId}&mobile=91${phone}&authkey=${authKey}&otp=${otp}&sender=${senderId}`;

  const response = await axios.post(url);
  console.log('[MSG91] Response:', response.data);
  return response.data;
}

// ─── GET handler ──────────────────────────────────────────
router.get('/send-otp', (req, res) => {
  res.json({ message: 'Use POST /api/auth/send-otp with { phone } in the request body' });
});

// ─────────────────────────────────────────
// POST /api/auth/send-otp
// ─────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  const normalised = phone.replace(/\s+/g, '');

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  otpStore[normalised] = { otp, expiresAt };

  // Check if MSG91 is configured
  const hasMSG91 = process.env.MSG91_AUTH_KEY && process.env.MSG91_TEMPLATE_ID;

  if (!hasMSG91) {
    console.log(`[DEV] OTP for ${normalised}: ${otp}`);
    return res.json({
      success: true,
      message: 'OTP sent (DEV mode)',
      dev_otp: otp
    });
  }

  try {
    await sendOTPviaMSG91(normalised, otp);
    return res.json({
      success: true,
      message: 'OTP sent successfully to your phone'
    });
  } catch (err) {
    console.error('[MSG91] Error:', err.response?.data || err.message);
    return res.status(500).json({
      error: 'Failed to send OTP. Please try again.',
      details: err.response?.data || err.message
    });
  }
});

// ─────────────────────────────────────────
// POST /api/auth/verify-otp
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

  delete otpStore[normalised];

  const { data: existingUser, error: fetchError } = await supabase
    .from('pmf_users')
    .select('*')
    .eq('phone', normalised)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
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
