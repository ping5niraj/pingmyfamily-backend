const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');

// In-memory OTP store
const otpStore = {};

router.get('/send-otp', (req, res) => {
  res.json({ message: 'Use POST /api/auth/send-otp with { phone }' });
});

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  const normalised = phone.replace(/\s+/g, '');
  const otp = process.env.DEV_OTP || '123456';
  const expiresAt = Date.now() + 10 * 60 * 1000;

  otpStore[normalised] = { otp, expiresAt };
  console.log(`[DEV] OTP for ${normalised}: ${otp}`);

  return res.json({
    success: true,
    message: 'OTP sent (DEV mode — use 123456)',
    dev_otp: otp
  });
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP are required' });

  const normalised = phone.replace(/\s+/g, '');
  const record = otpStore[normalised];

  if (!record) return res.status(400).json({ error: 'OTP not requested — please request OTP first' });
  if (Date.now() > record.expiresAt) {
    delete otpStore[normalised];
    return res.status(400).json({ error: 'OTP expired — request a new one' });
  }
  if (record.otp !== otp) return res.status(400).json({ error: 'Incorrect OTP. Please try again.' });

  delete otpStore[normalised];

  const { data: existingUser, error: fetchError } = await supabase
    .from('pmf_users').select('*').eq('phone', normalised).single();

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
      success: true, isNewUser: false, token,
      user: {
        id: existingUser.id, name: existingUser.name,
        phone: existingUser.phone, gender: existingUser.gender,
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
    success: true, isNewUser: true, tempToken,
    message: 'Phone verified — complete registration'
  });
});

module.exports = router;
