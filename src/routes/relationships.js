const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { getTamilName, isValidCoreRelation } = require('../utils/tamilRelations');
const { runInference } = require('../utils/inferenceEngine');

// All routes require authentication
router.use(authMiddleware);

// ─────────────────────────────────────────
// POST /api/relationships
// Add a new relationship (triggers verification request to the other person)
// Body: { to_user_phone, relation_type }
// Example: { to_user_phone: "9999999998", relation_type: "father" }
// ─────────────────────────────────────────
router.post('/', async (req, res) => {
  const { to_user_phone, relation_type } = req.body;

  if (!to_user_phone || !relation_type) {
    return res.status(400).json({ error: 'to_user_phone and relation_type are required' });
  }

  if (!isValidCoreRelation(relation_type)) {
    return res.status(400).json({
      error: 'Invalid relation_type',
      valid_types: ['father', 'mother', 'spouse', 'brother', 'sister', 'son', 'daughter']
    });
  }

  // Find the other user by phone
  const { data: toUser, error: userError } = await supabase
    .from('pmf_users')
    .select('id, name, phone')
    .eq('phone', to_user_phone)
    .single();

  if (userError || !toUser) {
    return res.status(404).json({
      error: 'No user found with that phone number. They need to register on PingMyFamily first.'
    });
  }

  // Can't add yourself
  if (toUser.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot add yourself as a relative' });
  }

  // Check if relationship already exists
  const { data: existing } = await supabase
    .from('pmf_relationships')
    .select('id, verification_status')
    .eq('from_user_id', req.user.id)
    .eq('to_user_id', toUser.id)
    .eq('relation_type', relation_type)
    .single();

  if (existing) {
    return res.status(409).json({
      error: `You already have a ${relation_type} relationship with this person`,
      status: existing.verification_status
    });
  }

  // Create the relationship (pending verification)
  const { data: newRel, error: insertError } = await supabase
    .from('pmf_relationships')
    .insert({
      from_user_id: req.user.id,
      to_user_id: toUser.id,
      relation_type,
      relation_tamil: getTamilName(relation_type),
      verification_status: 'pending',
      created_by: req.user.id
    })
    .select()
    .single();

  if (insertError) {
    console.error('Insert relationship error:', insertError);
    return res.status(500).json({ error: 'Failed to add relationship' });
  }

  return res.status(201).json({
    success: true,
    message: `Relationship request sent to ${toUser.name}. Waiting for their confirmation.`,
    relationship: {
      id: newRel.id,
      with: { name: toUser.name, phone: toUser.phone },
      relation_type: newRel.relation_type,
      relation_tamil: newRel.relation_tamil,
      status: 'pending'
    }
  });
});

// ─────────────────────────────────────────
// GET /api/relationships/mine
// Get all my relationships (verified + pending)
// ─────────────────────────────────────────
router.get('/mine', async (req, res) => {
  // Relationships I initiated
  const { data: initiated, error: e1 } = await supabase
    .from('pmf_relationships')
    .select(`
      id, relation_type, relation_tamil, verification_status, created_at, verified_at,
      to_user:to_user_id ( id, name, phone, gender, profile_photo )
    `)
    .eq('from_user_id', req.user.id)
    .order('created_at', { ascending: false });

  // Relationships others initiated with me (pending my verification)
  const { data: received, error: e2 } = await supabase
    .from('pmf_relationships')
    .select(`
      id, relation_type, relation_tamil, verification_status, created_at,
      from_user:from_user_id ( id, name, phone, gender, profile_photo )
    `)
    .eq('to_user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (e1 || e2) {
    return res.status(500).json({ error: 'Failed to fetch relationships' });
  }

  // Pending verification requests waiting for MY action
  const pendingMyAction = (received || []).filter(r => r.verification_status === 'pending');

  return res.json({
    success: true,
    summary: {
      total_verified: (initiated || []).filter(r => r.verification_status === 'verified').length,
      pending_sent: (initiated || []).filter(r => r.verification_status === 'pending').length,
      pending_my_action: pendingMyAction.length
    },
    my_relationships: initiated || [],
    pending_verification: pendingMyAction
  });
});

// ─────────────────────────────────────────
// POST /api/relationships/verify
// Confirm a relationship request someone sent to me
// Body: { relationship_id }
// ─────────────────────────────────────────
router.post('/verify', async (req, res) => {
  const { relationship_id } = req.body;

  if (!relationship_id) {
    return res.status(400).json({ error: 'relationship_id is required' });
  }

  // Find the relationship — must be directed TO me and still pending
  const { data: rel, error: fetchError } = await supabase
    .from('pmf_relationships')
    .select('*')
    .eq('id', relationship_id)
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'pending')
    .single();

  if (fetchError || !rel) {
    return res.status(404).json({
      error: 'Relationship request not found or already actioned'
    });
  }

  // Mark as verified
  const { error: updateError } = await supabase
    .from('pmf_relationships')
    .update({
      verification_status: 'verified',
      verified_at: new Date().toISOString()
    })
    .eq('id', relationship_id);

  if (updateError) {
    return res.status(500).json({ error: 'Failed to verify relationship' });
  }

  // Run inference engine for both users
  await runInference(rel.from_user_id);
  await runInference(rel.to_user_id);

  return res.json({
    success: true,
    message: 'Relationship verified! Extended family has been updated automatically.'
  });
});

// ─────────────────────────────────────────
// POST /api/relationships/reject
// Reject a relationship request
// Body: { relationship_id }
// ─────────────────────────────────────────
router.post('/reject', async (req, res) => {
  const { relationship_id } = req.body;

  if (!relationship_id) {
    return res.status(400).json({ error: 'relationship_id is required' });
  }

  const { data: rel, error: fetchError } = await supabase
    .from('pmf_relationships')
    .select('*')
    .eq('id', relationship_id)
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'pending')
    .single();

  if (fetchError || !rel) {
    return res.status(404).json({
      error: 'Relationship request not found or already actioned'
    });
  }

  const { error: updateError } = await supabase
    .from('pmf_relationships')
    .update({ verification_status: 'rejected' })
    .eq('id', relationship_id);

  if (updateError) {
    return res.status(500).json({ error: 'Failed to reject relationship' });
  }

  return res.json({
    success: true,
    message: 'Relationship request rejected.'
  });
});

module.exports = router;
