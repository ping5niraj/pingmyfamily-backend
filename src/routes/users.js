const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const authMiddleware = require('../middleware/auth');

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

      // In-app notification for new user
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
      console.log('[AutoLink] Error:', e.message);
    }
  }
}

// ─────────────────────────────────────────
// POST /api/users
// Register new user after OTP verification
// ─────────────────────────────────────────
router.post('/', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (!decoded.isTemp) {
    return res.status(400).json({ error: 'Use tempToken from verify-otp to register' });
  }

  const { name, gender, date_of_birth, email } = req.body;

  if (!name || !gender) {
    return res.status(400).json({ error: 'Name and gender are required' });
  }

  if (!['male', 'female', 'other'].includes(gender)) {
    return res.status(400).json({ error: 'Gender must be male, female, or other' });
  }

  const { data: existing } = await supabase
    .from('pmf_users').select('id').eq('phone', decoded.phone).single();

  if (existing) {
    return res.status(409).json({ error: 'User already registered' });
  }

  const { data: newUser, error: insertError } = await supabase
    .from('pmf_users')
    .insert({
      name: name.trim(),
      phone: decoded.phone,
      gender,
      date_of_birth: date_of_birth || null,
      email: email ? email.trim().toLowerCase() : null,
      status: 'active'
    })
    .select().single();

  if (insertError) {
    return res.status(500).json({ error: 'Failed to create user' });
  }

  // ── AUTO-LINK: check pending invites for this phone ──
  await processAutoLinks(newUser);

  const fullToken = jwt.sign(
    { id: newUser.id, phone: newUser.phone },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );

  return res.status(201).json({
    success: true, token: fullToken,
    user: {
      id: newUser.id, name: newUser.name,
      phone: newUser.phone, gender: newUser.gender,
      profile_photo: newUser.profile_photo
    }
  });
});

// ─────────────────────────────────────────
// GET /api/users/me
// ─────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  const { data: user, error } = await supabase
    .from('pmf_users')
    .select('id, name, phone, email, gender, date_of_birth, profile_photo, status, kutham, address, pincode, district, city, created_at')
    .eq('id', req.user.id).single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });
  return res.json({ success: true, user });
});

// ─────────────────────────────────────────
// PUT /api/users/me
// ─────────────────────────────────────────
router.put('/me', authMiddleware, async (req, res) => {
  const {
    name, gender, date_of_birth, email, profile_photo,
    kutham, address, pincode, district, city
  } = req.body;

  const updates = {};
  if (name) updates.name = name.trim();
  if (gender) {
    if (!['male', 'female', 'other'].includes(gender)) {
      return res.status(400).json({ error: 'Invalid gender value' });
    }
    updates.gender = gender;
  }
  if (date_of_birth !== undefined) updates.date_of_birth = date_of_birth;
  if (email) updates.email = email.trim().toLowerCase();
  if (profile_photo) updates.profile_photo = profile_photo;
  if (kutham !== undefined) updates.kutham = kutham?.trim() || null;
  if (address !== undefined) updates.address = address?.trim() || null;
  if (pincode !== undefined) updates.pincode = pincode?.trim() || null;
  if (district !== undefined) updates.district = district?.trim() || null;
  if (city !== undefined) updates.city = city?.trim() || null;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data: updated, error } = await supabase
    .from('pmf_users').update(updates).eq('id', req.user.id).select().single();

  if (error) return res.status(500).json({ error: 'Failed to update profile' });
  return res.json({ success: true, user: updated });
});

// ─────────────────────────────────────────
// GET /api/users/directory
// ─────────────────────────────────────────
router.get('/directory', authMiddleware, async (req, res) => {
  const { kutham, pincode, district, city, search } = req.query;

  let query = supabase
    .from('pmf_users')
    .select('id, name, phone, gender, profile_photo, kutham, address, pincode, district, city, created_at')
    .eq('status', 'active')
    .not('kutham', 'is', null);

  if (kutham) query = query.ilike('kutham', `%${kutham}%`);
  if (pincode) query = query.eq('pincode', pincode);
  if (district) query = query.ilike('district', `%${district}%`);
  if (city) query = query.ilike('city', `%${city}%`);
  if (search) query = query.ilike('name', `%${search}%`);

  const { data: users, error } = await query
    .order('kutham', { ascending: true })
    .limit(100);

  if (error) return res.status(500).json({ error: 'Failed to fetch directory' });
  return res.json({ success: true, count: users?.length || 0, users: users || [] });
});

// ─────────────────────────────────────────
// GET /api/users/directory/filters
// ─────────────────────────────────────────
router.get('/directory/filters', authMiddleware, async (req, res) => {
  const { data: users, error } = await supabase
    .from('pmf_users')
    .select('kutham, district, city, pincode')
    .eq('status', 'active')
    .not('kutham', 'is', null);

  if (error) return res.status(500).json({ error: 'Failed to fetch filters' });

  const kuthams   = [...new Set(users.map(u => u.kutham).filter(Boolean))].sort();
  const districts = [...new Set(users.map(u => u.district).filter(Boolean))].sort();
  const cities    = [...new Set(users.map(u => u.city).filter(Boolean))].sort();
  const pincodes  = [...new Set(users.map(u => u.pincode).filter(Boolean))].sort();

  return res.json({ success: true, kuthams, districts, cities, pincodes });
});

module.exports = router;
