const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { getTamilName, isValidCoreRelation } = require('../utils/tamilRelations');
const { runInference } = require('../utils/inferenceEngine');

// ─── Relationship flip map ─────────────────────────────
// When person B views a relationship that person A created
// we flip it to show B's perspective
const FLIP_MAP = {
  father:    { type: 'son',      tamil: 'Magan'   }, // if I added you as father, you see me as son
  mother:    { type: 'son',      tamil: 'Magan'   }, // mother sees me as son
  son:       { type: 'father',   tamil: 'Appa'    }, // son sees me as father
  daughter:  { type: 'father',   tamil: 'Appa'    }, // daughter sees me as father
  brother:   { type: 'brother',  tamil: 'Annan'   }, // brother sees me as brother
  sister:    { type: 'sister',   tamil: 'Akka'    }, // sister sees me as sister
  spouse:    { type: 'spouse',   tamil: 'Manam'   }, // spouse sees me as spouse
  son:       { type: 'father',   tamil: 'Appa'    },
  grandson:  { type: 'grandfather_paternal', tamil: 'Thatha' },
  granddaughter: { type: 'grandfather_paternal', tamil: 'Thatha' },
  uncle_elder:   { type: 'cousin_male', tamil: 'Machan' },
  uncle_younger: { type: 'cousin_male', tamil: 'Machan' },
  aunt_paternal: { type: 'cousin_female', tamil: 'Maami' },
  uncle_maternal:{ type: 'cousin_male', tamil: 'Machan' },
  aunt_maternal: { type: 'cousin_female', tamil: 'Maami' },
  grandfather_paternal: { type: 'grandson', tamil: 'Peran' },
  grandmother_paternal: { type: 'grandson', tamil: 'Peran' },
  grandfather_maternal: { type: 'grandson', tamil: 'Peran' },
  grandmother_maternal: { type: 'grandson', tamil: 'Peran' },
  father_in_law: { type: 'son_in_law', tamil: 'Maappillai' },
  mother_in_law: { type: 'son_in_law', tamil: 'Maappillai' },
  brother_in_law:{ type: 'brother_in_law', tamil: 'Maitthunan' },
  sister_in_law: { type: 'sister_in_law', tamil: 'Naathanar' },
  co_brother:    { type: 'co_brother', tamil: 'Sakaali' },
};

// Gender-aware flip — if we know the logged-in user's gender
function getFlipped(relationType, userGender) {
  const base = FLIP_MAP[relationType];
  if (!base) return { type: relationType, tamil: getTamilName(relationType) };

  // Adjust for gender
  if (relationType === 'father' || relationType === 'mother') {
    if (userGender === 'female') return { type: 'daughter', tamil: 'Magal' };
    return { type: 'son', tamil: 'Magan' };
  }
  if (relationType === 'son' || relationType === 'daughter') {
    if (userGender === 'female') return { type: 'mother', tamil: 'Amma' };
    return { type: 'father', tamil: 'Appa' };
  }
  if (relationType === 'brother' || relationType === 'sister') {
    if (userGender === 'female') return { type: 'sister', tamil: 'Akka' };
    return { type: 'brother', tamil: 'Annan' };
  }
  if (relationType === 'grandson' || relationType === 'granddaughter') {
    if (userGender === 'female') return { type: 'grandmother_paternal', tamil: 'Paati' };
    return { type: 'grandfather_paternal', tamil: 'Thatha' };
  }

  return base;
}

// ─────────────────────────────────────────
// POST /api/relationships
// ─────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
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

  if (toUser.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot add yourself as a relative' });
  }

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
// Returns BOTH outgoing and incoming relationships
// Incoming are flipped to show from logged-in user's perspective
// ─────────────────────────────────────────
router.get('/mine', authMiddleware, async (req, res) => {
  // Get logged-in user's gender for flip logic
  const { data: currentUser } = await supabase
    .from('pmf_users')
    .select('gender')
    .eq('id', req.user.id)
    .single();

  const userGender = currentUser?.gender || 'male';

  // Relationships I created (outgoing)
  const { data: outgoing, error: e1 } = await supabase
    .from('pmf_relationships')
    .select(`
      id, relation_type, relation_tamil, verification_status, created_at, verified_at,
      to_user:to_user_id ( id, name, phone, gender, profile_photo )
    `)
    .eq('from_user_id', req.user.id)
    .order('created_at', { ascending: false });

  // Relationships others created with me (incoming)
  const { data: incoming, error: e2 } = await supabase
    .from('pmf_relationships')
    .select(`
      id, relation_type, relation_tamil, verification_status, created_at, verified_at,
      from_user:from_user_id ( id, name, phone, gender, profile_photo )
    `)
    .eq('to_user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (e1 || e2) {
    return res.status(500).json({ error: 'Failed to fetch relationships' });
  }

  // Flip incoming relationships to show from MY perspective
  const flippedIncoming = (incoming || []).map(rel => {
    const flipped = getFlipped(rel.relation_type, userGender);
    return {
      id: rel.id,
      relation_type: flipped.type,
      relation_tamil: flipped.tamil,
      verification_status: rel.verification_status,
      created_at: rel.created_at,
      verified_at: rel.verified_at,
      to_user: rel.from_user, // the other person becomes "to_user" from my perspective
      is_incoming: true       // flag so frontend knows this was initiated by other person
    };
  });

  // Merge outgoing + flipped incoming (avoid duplicates)
  const outgoingIds = new Set((outgoing || []).map(r => r.id));
  const uniqueIncoming = flippedIncoming.filter(r => !outgoingIds.has(r.id));
  const allRelationships = [...(outgoing || []), ...uniqueIncoming];

  // Pending verification — incoming that are pending MY confirmation
  const pendingMyAction = (incoming || []).filter(r => r.verification_status === 'pending').map(rel => ({
    ...rel,
    to_user: rel.from_user
  }));

  return res.json({
    success: true,
    summary: {
      total_verified: allRelationships.filter(r => r.verification_status === 'verified').length,
      pending_sent: (outgoing || []).filter(r => r.verification_status === 'pending').length,
      pending_my_action: pendingMyAction.length
    },
    my_relationships: allRelationships.filter(r => r.verification_status === 'verified'),
    pending_verification: pendingMyAction
  });
});

// ─────────────────────────────────────────
// POST /api/relationships/verify
// ─────────────────────────────────────────
router.post('/verify', authMiddleware, async (req, res) => {
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
    return res.status(404).json({ error: 'Relationship request not found or already actioned' });
  }

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

  await runInference(rel.from_user_id);
  await runInference(rel.to_user_id);

  return res.json({
    success: true,
    message: 'Relationship verified! Extended family has been updated automatically.'
  });
});

// ─────────────────────────────────────────
// POST /api/relationships/reject
// ─────────────────────────────────────────
router.post('/reject', authMiddleware, async (req, res) => {
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
    return res.status(404).json({ error: 'Relationship request not found or already actioned' });
  }

  const { error: updateError } = await supabase
    .from('pmf_relationships')
    .update({ verification_status: 'rejected' })
    .eq('id', relationship_id);

  if (updateError) {
    return res.status(500).json({ error: 'Failed to reject relationship' });
  }

  return res.json({ success: true, message: 'Relationship request rejected.' });
});

module.exports = router;
