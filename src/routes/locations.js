const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// ─────────────────────────────────────────
// GET /api/locations/mine
// Get my current location + who can see it
// ─────────────────────────────────────────
router.get('/mine', async (req, res) => {
  const { data: location } = await supabase
    .from('pmf_locations')
    .select('*')
    .eq('user_id', req.user.id)
    .single();

  const { data: permissions } = await supabase
    .from('pmf_location_permissions')
    .select('to_user_id, to_user:to_user_id(id, name, profile_photo)')
    .eq('from_user_id', req.user.id);

  return res.json({
    success: true,
    location: location || null,
    shared_with: permissions?.map(p => p.to_user) || []
  });
});

// ─────────────────────────────────────────
// POST /api/locations/share
// Share location with selected members
// Body: { latitude, longitude, address?, to_user_ids[] }
// ─────────────────────────────────────────
router.post('/share', async (req, res) => {
  const { latitude, longitude, address, to_user_ids } = req.body;

  if (!latitude || !longitude) {
    return res.status(400).json({ error: 'Latitude and longitude are required' });
  }

  if (!to_user_ids || to_user_ids.length === 0) {
    return res.status(400).json({ error: 'Select at least one person to share with' });
  }

  // Upsert location
  const { data, error } = await supabase
    .from('pmf_locations')
    .upsert({
      user_id: req.user.id,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      address: address || null,
      shared_at: new Date().toISOString(),
      is_active: true
    }, { onConflict: 'user_id' })
    .select().single();

  if (error) {
    console.error('Location share error:', error);
    return res.status(500).json({ error: 'Failed to save location' });
  }

  // Delete old permissions
  await supabase
    .from('pmf_location_permissions')
    .delete()
    .eq('from_user_id', req.user.id);

  // Insert new permissions
  const perms = to_user_ids.map(uid => ({
    from_user_id: req.user.id,
    to_user_id: uid
  }));

  const { error: permError } = await supabase
    .from('pmf_location_permissions')
    .insert(perms);

  if (permError) {
    console.error('Permissions error:', permError);
    return res.status(500).json({ error: 'Failed to save permissions' });
  }

  return res.json({
    success: true,
    location: data,
    shared_with_count: to_user_ids.length
  });
});

// ─────────────────────────────────────────
// PUT /api/locations/permissions
// Update who can see my location (without changing coords)
// Body: { to_user_ids[] }
// ─────────────────────────────────────────
router.put('/permissions', async (req, res) => {
  const { to_user_ids } = req.body;

  await supabase
    .from('pmf_location_permissions')
    .delete()
    .eq('from_user_id', req.user.id);

  if (to_user_ids && to_user_ids.length > 0) {
    const perms = to_user_ids.map(uid => ({
      from_user_id: req.user.id,
      to_user_id: uid
    }));
    await supabase.from('pmf_location_permissions').insert(perms);
  }

  return res.json({ success: true, shared_with_count: to_user_ids?.length || 0 });
});

// ─────────────────────────────────────────
// DELETE /api/locations/hide
// Hide my location from everyone
// ─────────────────────────────────────────
router.delete('/hide', async (req, res) => {
  await supabase
    .from('pmf_locations')
    .update({ is_active: false })
    .eq('user_id', req.user.id);

  await supabase
    .from('pmf_location_permissions')
    .delete()
    .eq('from_user_id', req.user.id);

  return res.json({ success: true, message: 'Location hidden from everyone' });
});

// ─────────────────────────────────────────
// GET /api/locations/family
// Get locations of family members who shared with me
// ─────────────────────────────────────────
router.get('/family', async (req, res) => {
  // Find who has given ME permission to see their location
  const { data: permissions } = await supabase
    .from('pmf_location_permissions')
    .select('from_user_id')
    .eq('to_user_id', req.user.id);

  const allowedUserIds = permissions?.map(p => p.from_user_id) || [];

  if (allowedUserIds.length === 0) {
    return res.json({ success: true, locations: [] });
  }

  const { data: locations, error } = await supabase
    .from('pmf_locations')
    .select(`
      id, latitude, longitude, address, shared_at, is_active, user_id,
      user:user_id ( id, name, profile_photo )
    `)
    .in('user_id', allowedUserIds)
    .eq('is_active', true)
    .order('shared_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to fetch locations' });

  return res.json({ success: true, locations: locations || [] });
});

// ─────────────────────────────────────────
// POST /api/locations/request/:userId
// Request location from a family member
// ─────────────────────────────────────────
router.post('/request/:userId', async (req, res) => {
  const { userId } = req.params;

  const { data: rel } = await supabase
    .from('pmf_relationships')
    .select('id')
    .or(
      `and(from_user_id.eq.${req.user.id},to_user_id.eq.${userId}),` +
      `and(from_user_id.eq.${userId},to_user_id.eq.${req.user.id})`
    )
    .eq('verification_status', 'verified')
    .single();

  if (!rel) {
    return res.status(403).json({ error: 'Not a verified family member' });
  }

  const { data: requester } = await supabase
    .from('pmf_users').select('name').eq('id', req.user.id).single();

  const { data: message } = await supabase
    .from('pmf_messages')
    .insert({
      from_user_id: req.user.id,
      message_type: 'personal',
      subject: '📍 இட விவரம் கோரிக்கை / Location Request',
      content: `${requester?.name} உங்கள் இடத்தை பகிர கோருகிறார்.\n(${requester?.name} is requesting your location)\n\nfrootze app → Locations → Share My Location`,
    })
    .select().single();

  if (message) {
    await supabase.from('pmf_message_recipients').insert({
      message_id: message.id,
      to_user_id: userId,
      is_read: false
    });
  }

  return res.json({ success: true, message: 'Location request sent' });
});

module.exports = router;
