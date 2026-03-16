const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');

// ─────────────────────────────────────────
// POST /api/users
// Register a new user after OTP verification
// Requires: tempToken in Authorization header
// Body: { name, gender, date_of_birth (optional), email (optional) }
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

  // Check not already registered (race condition guard)
  const { data: existing } = await supabase
    .from('pmf_users')
    .select('id')
    .eq('phone', decoded.phone)
    .single();

  if (existing) {
    return res.status(409).json({ error: 'User already registered — use verify-otp to login' });
  }

  // Insert new user
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
    .select()
    .single();

  if (insertError) {
    console.error('Insert error:', insertError);
    return res.status(500).json({ error: 'Failed to create user' });
  }

  // Issue full JWT
  const fullToken = jwt.sign(
    { id: newUser.id, phone: newUser.phone },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );

  return res.status(201).json({
    success: true,
    token: fullToken,
    user: {
      id: newUser.id,
      name: newUser.name,
      phone: newUser.phone,
      gender: newUser.gender,
      profile_photo: newUser.profile_photo
    }
  });
});

// ─────────────────────────────────────────
// GET /api/users/me
// Get own profile — requires full JWT
// ─────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  const { data: user, error } = await supabase
    .from('pmf_users')
    .select('id, name, phone, email, gender, date_of_birth, profile_photo, status, created_at')
    .eq('id', req.user.id)
    .single();

  if (error || !user) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json({ success: true, user });
});

// ─────────────────────────────────────────
// PUT /api/users/me
// Update own profile — requires full JWT
// Body: { name, gender, date_of_birth, email, profile_photo }
// ─────────────────────────────────────────
router.put('/me', authMiddleware, async (req, res) => {
  const { name, gender, date_of_birth, email, profile_photo } = req.body;

  const updates = {};
  if (name) updates.name = name.trim();
  if (gender) {
    if (!['male', 'female', 'other'].includes(gender)) {
      return res.status(400).json({ error: 'Invalid gender value' });
    }
    updates.gender = gender;
  }
  if (date_of_birth) updates.date_of_birth = date_of_birth;
  if (email) updates.email = email.trim().toLowerCase();
  if (profile_photo) updates.profile_photo = profile_photo;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data: updated, error } = await supabase
    .from('pmf_users')
    .update(updates)
    .eq('id', req.user.id)
    .select()
    .single();

  if (error) {
    console.error('Update error:', error);
    return res.status(500).json({ error: 'Failed to update profile' });
  }

  return res.json({ success: true, user: updated });
});

module.exports = router;
