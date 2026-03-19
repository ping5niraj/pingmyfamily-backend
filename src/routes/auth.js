const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');
const admin = require('firebase-admin');

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    })
  });
}

// ─────────────────────────────────────────
// POST /api/auth/firebase-verify
// Verify Firebase ID token → login or register
// ─────────────────────────────────────────
router.post('/firebase-verify', async (req, res) => {
  const { id_token, phone } = req.body;

  if (!id_token || !phone) {
    return res.status(400).json({ error: 'id_token and phone are required' });
  }

  try {
    // Verify token with Firebase Admin
    const decodedToken = await admin.auth().verifyIdToken(id_token);
    console.log('[Firebase] Token verified for:', decodedToken.phone_number);

    const normalised = phone.replace(/\s+/g, '');

    // Check if user exists
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
      message: 'Phone verified — complete registration'
    });

  } catch (err) {
    console.error('[Firebase] Token verification error:', err.message);
    return res.status(401).json({
      error: 'Firebase token verification failed: ' + err.message
    });
  }
});

// ─── DEV fallback ──────────────────────────────────────────
router.get('/send-otp', (req, res) => {
  res.json({ message: 'Use POST /api/auth/send-otp with { phone }' });
});

router.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const normalised = phone.replace(/\s+/g, '');
  const otp = process.env.DEV_OTP || '123456';
  console.log(`[DEV] OTP for ${normalised}: ${otp}`);
  return res.json({ success: true, message: 'OTP sent (DEV mode)', dev_otp: otp });
});

router.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });
  if (otp !== (process.env.DEV_OTP || '123456')) {
    return res.status(400).json({ error: 'Incorrect OTP' });
  }
  const normalised = phone.replace(/\s+/g, '');
  const { data: existingUser } = await supabase
    .from('pmf_users').select('*').eq('phone', normalised).single();

  if (existingUser) {
    const token = jwt.sign(
      { id: existingUser.id, phone: existingUser.phone },
      process.env.JWT_SECRET, { expiresIn: '30d' }
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
    process.env.JWT_SECRET, { expiresIn: '30m' }
  );
  return res.json({ success: true, isNewUser: true, tempToken });
});

module.exports = router;
