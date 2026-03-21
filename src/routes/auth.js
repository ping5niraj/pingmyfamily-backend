const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const supabase = require('../supabase');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    })
  });
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
});

// ─────────────────────────────────────────
// Auto-link helper
// When new user registers, check pmf_pending_invites
// and automatically create pending relationship requests
// ─────────────────────────────────────────
async function processAutoLinks(newUser) {
  const digits = (newUser.phone || '').replace(/\D/g, '');
  console.log('[AutoLink] Checking pending invites for:', digits);

  const { data: pendingInvites } = await supabase
    .from('pmf_pending_invites')
    .select('*, from_user:from_user_id(id, name, phone)')
    .eq('to_phone', digits)
    .eq('status', 'pending');

  if (!pendingInvites || pendingInvites.length === 0) {
    console.log('[AutoLink] No pending invites found');
    return;
  }

  console.log('[AutoLink] Found', pendingInvites.length, 'pending invite(s)');

  for (const invite of pendingInvites) {
    try {
      // Create the relationship request automatically
      const { error: relError } = await supabase.from('pmf_relationships').insert({
        from_user_id: invite.from_user_id,
        to_user_id: newUser.id,
        relation_type: invite.relation_type,
        relation_tamil: invite.relation_tamil,
        verification_status: 'pending',
        created_by: invite.from_user_id
      });

      if (relError) {
        console.log('[AutoLink] Relationship insert error:', relError.message);
        continue;
      }

      // Create in-app notification for new user
      const { data: message } = await supabase.from('pmf_messages').insert({
        from_user_id: invite.from_user_id,
        message_type: 'personal',
        subject: '🌳 குடும்ப இணைப்பு கோரிக்கை / Family Connection Request',
        content: `${invite.from_user?.name} உங்களை தங்கள் ${invite.relation_tamil} ஆக சேர்க்க கோருகிறார். Dashboard-ல் ஏற்கவும் அல்லது நிராகரிக்கவும்.\n\n${invite.from_user?.name} wants to add you as ${invite.relation_tamil}. Please accept or reject from your Dashboard.`
      }).select().single();

      if (message) {
        await supabase.from('pmf_message_recipients').insert({
          message_id: message.id, to_user_id: newUser.id, is_read: false
        });
      }

      // Mark invite as processed
      await supabase.from('pmf_pending_invites')
        .update({ status: 'processed' })
        .eq('id', invite.id);

      console.log('[AutoLink] Created relationship request from', invite.from_user?.name, 'as', invite.relation_tamil);
    } catch (e) {
      console.log('[AutoLink] Error processing invite:', e.message);
    }
  }
}

// ─────────────────────────────────────────
// POST /api/auth/firebase-verify
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

  const token = jwt.sign({ id: user.id, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
  return res.json({
    success: true, token,
    user: { id: user.id, name: user.name, phone: user.phone, gender: user.gender, profile_photo: user.profile_photo }
  });
});

// ─────────────────────────────────────────
// POST /api/users  (Registration)
// After user is created — process auto-links
// ─────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { name, gender, phone, tempToken } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

  try {
    const decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
    if (!decoded.isTemp) return res.status(401).json({ error: 'Invalid temp token' });

    const normalised = phone.replace(/\s+/g, '');
    const { data: newUser, error: insertError } = await supabase
      .from('pmf_users')
      .insert({ name, gender, phone: normalised })
      .select().single();

    if (insertError) return res.status(500).json({ error: 'Registration failed' });

    // ── AUTO-LINK: check for pending invites ──
    await processAutoLinks(newUser);

    const token = jwt.sign({ id: newUser.id, phone: newUser.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({
      success: true, token,
      user: { id: newUser.id, name: newUser.name, phone: newUser.phone, gender: newUser.gender }
    });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// ─────────────────────────────────────────
// POST /api/auth/set-password
// ─────────────────────────────────────────
router.post('/set-password', async (req, res) => {
  const { password, token } = req.body;
  if (!password || !token) return res.status(400).json({ error: 'Password and token required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

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
// ─────────────────────────────────────────
router.post('/send-invite-email', async (req, res) => {
  const { to_email, from_name, relation_tamil, invite_link } = req.body;
  if (!to_email || !from_name) return res.status(400).json({ error: 'Email and name required' });

  try {
    await transporter.sendMail({
      from: `"frootze குடும்பம் 🌳" <${process.env.GMAIL_USER}>`,
      to: to_email,
      subject: `${from_name} உங்களை frootze குடும்ப மரத்தில் சேர அழைக்கிறார்!`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f4ff;padding:20px;border-radius:16px;">
        <h1 style="color:#6B21A8;text-align:center;">🌳 frootze</h1>
        <div style="background:white;border-radius:12px;padding:24px;">
          <p style="color:#444;font-size:16px;"><strong>${from_name}</strong> உங்களை frootze-ல் <strong>${relation_tamil || 'குடும்பத்தினர்'}</strong> ஆக சேர்க்க அழைக்கிறார்.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${invite_link || 'https://frootze.com'}" style="background:linear-gradient(135deg,#6B21A8,#059669);color:white;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:bold;">
              Join Family Tree
            </a>
          </div>
        </div>
      </div>`
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Email sending failed' });
  }
});

// ─── DEV fallback OTP ────────────────────
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
