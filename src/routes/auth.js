const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
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

// Gmail transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  }
});

// ─────────────────────────────────────────
// POST /api/auth/firebase-verify
// Verify Firebase ID token → login or register
// ─────────────────────────────────────────
router.post('/firebase-verify', async (req, res) => {
  const { id_token, phone } = req.body;
  if (!id_token || !phone) return res.status(400).json({ error: 'id_token and phone required' });

  try {
    const decodedToken = await admin.auth().verifyIdToken(id_token);
    console.log('[Firebase] Token verified for:', decodedToken.phone_number);

    const normalised = phone.replace(/\s+/g, '');
    const { data: existingUser, error: fetchError } = await supabase
      .from('pmf_users').select('*').eq('phone', normalised).single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      return res.status(500).json({ error: 'Database error' });
    }

    if (existingUser) {
      const token = jwt.sign(
        { id: existingUser.id, phone: existingUser.phone },
        process.env.JWT_SECRET, { expiresIn: '30d' }
      );
      return res.json({
        success: true, isNewUser: false, token,
        user: { id: existingUser.id, name: existingUser.name, phone: existingUser.phone, gender: existingUser.gender, profile_photo: existingUser.profile_photo }
      });
    }

    const tempToken = jwt.sign(
      { phone: normalised, isTemp: true },
      process.env.JWT_SECRET, { expiresIn: '30m' }
    );
    return res.json({ success: true, isNewUser: true, tempToken });

  } catch (err) {
    console.error('[Firebase] Error:', err.message);
    return res.status(401).json({ error: 'Firebase token verification failed' });
  }
});

// ─────────────────────────────────────────
// POST /api/auth/login
// Login with phone + password
// ─────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

  const normalised = phone.replace(/\s+/g, '');
  const { data: user, error } = await supabase
    .from('pmf_users').select('*').eq('phone', normalised).single();

  if (error || !user) return res.status(401).json({ error: 'தொலைபேசி எண் பதிவு செய்யப்படவில்லை / Phone not registered' });
  if (!user.password_hash) return res.status(401).json({ error: 'கடவுச்சொல் அமைக்கப்படவில்லை / Password not set. Please use OTP login.' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'தவறான கடவுச்சொல் / Wrong password' });

  const token = jwt.sign(
    { id: user.id, phone: user.phone },
    process.env.JWT_SECRET, { expiresIn: '30d' }
  );

  return res.json({
    success: true, token,
    user: { id: user.id, name: user.name, phone: user.phone, gender: user.gender, profile_photo: user.profile_photo }
  });
});

// ─────────────────────────────────────────
// POST /api/auth/set-password
// Set password after OTP registration
// ─────────────────────────────────────────
router.post('/set-password', async (req, res) => {
  const { password, token } = req.body;
  if (!password || !token) return res.status(400).json({ error: 'Password and token required' });
  if (password.length < 6) return res.status(400).json({ error: 'கடவுச்சொல் குறைந்தது 6 எழுத்து / Password must be at least 6 characters' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const hash = await bcrypt.hash(password, 10);

    await supabase.from('pmf_users').update({ password_hash: hash }).eq('id', decoded.id);

    return res.json({ success: true, message: 'கடவுச்சொல் அமைக்கப்பட்டது / Password set successfully' });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// ─────────────────────────────────────────
// POST /api/auth/reset-password
// Reset password using OTP verified token
// ─────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const normalised = phone.replace(/\s+/g, '');
  const hash = await bcrypt.hash(password, 10);

  await supabase.from('pmf_users').update({ password_hash: hash }).eq('phone', normalised);

  return res.json({ success: true, message: 'Password reset successfully' });
});

// ─────────────────────────────────────────
// POST /api/auth/send-invite-email
// Send invite email to relative
// ─────────────────────────────────────────
router.post('/send-invite-email', async (req, res) => {
  const { to_email, from_name, relation_tamil, invite_link } = req.body;
  if (!to_email || !from_name) return res.status(400).json({ error: 'Email and name required' });

  try {
    await transporter.sendMail({
      from: `"frootze குடும்பம் 🌳" <${process.env.GMAIL_USER}>`,
      to: to_email,
      subject: `${from_name} உங்களை frootze குடும்ப மரத்தில் சேர அழைக்கிறார்!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f4ff; padding: 20px; border-radius: 16px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="color: #6B21A8; font-size: 32px; margin: 0;">🌳 frootze</h1>
            <p style="color: #666; font-size: 14px;">Your Family. Your Roots.</p>
          </div>
          <div style="background: white; border-radius: 12px; padding: 24px; margin-bottom: 20px;">
            <h2 style="color: #1a0533; font-size: 20px;">வணக்கம்! 👋</h2>
            <p style="color: #444; font-size: 16px; line-height: 1.6;">
              <strong>${from_name}</strong> உங்களை frootze குடும்ப மரத்தில் <strong>${relation_tamil || 'குடும்பத்தினர்'}</strong> ஆக சேர்க்க அழைக்கிறார்.
            </p>
            <p style="color: #444; font-size: 14px;">
              <strong>${from_name}</strong> has invited you to join their family tree on frootze as their <strong>${relation_tamil || 'family member'}</strong>.
            </p>
          </div>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${invite_link || 'https://frootze.com'}" 
               style="background: linear-gradient(135deg, #6B21A8, #059669); color: white; padding: 14px 32px; border-radius: 999px; text-decoration: none; font-weight: bold; font-size: 16px;">
              குடும்ப மரத்தில் சேரவும் / Join Family Tree
            </a>
          </div>
          <p style="color: #999; font-size: 12px; text-align: center; margin-top: 24px;">
            இலவசமாக உங்கள் குடும்ப மரத்தை உருவாக்குங்கள் · frootze.com
          </p>
        </div>
      `
    });

    return res.json({ success: true, message: 'Email sent successfully' });
  } catch (err) {
    console.error('Email error:', err.message);
    return res.status(500).json({ error: 'Email sending failed: ' + err.message });
  }
});

// ─── DEV fallback ────────────────────────
router.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  return res.json({ success: true, message: 'Use Firebase OTP', dev_otp: process.env.DEV_OTP || '123456' });
});

router.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });
  if (otp !== (process.env.DEV_OTP || '123456')) return res.status(400).json({ error: 'Incorrect OTP' });

  const normalised = phone.replace(/\s+/g, '');
  const { data: existingUser } = await supabase.from('pmf_users').select('*').eq('phone', normalised).single();

  if (existingUser) {
    const token = jwt.sign({ id: existingUser.id, phone: existingUser.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({ success: true, isNewUser: false, token, user: { id: existingUser.id, name: existingUser.name, phone: existingUser.phone, gender: existingUser.gender, profile_photo: existingUser.profile_photo } });
  }

  const tempToken = jwt.sign({ phone: normalised, isTemp: true }, process.env.JWT_SECRET, { expiresIn: '30m' });
  return res.json({ success: true, isNewUser: true, tempToken });
});

module.exports = router;
