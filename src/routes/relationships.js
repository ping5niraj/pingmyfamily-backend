const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const authMiddleware = require('../middleware/auth');
const { sendEmail, sendTelegram } = require('../services/notifications');

router.use(authMiddleware);

// ─────────────────────────────────────────
// Reverse relation mapping
// If Niranjan added Shyam as "son"
// Then from Shyam's view, Niranjan is "father"
// ─────────────────────────────────────────
const REVERSE_RELATION = {
  father:   { type: 'son',     tamil: 'மகன்' },
  mother:   { type: 'son',     tamil: 'மகன்' },
  son:      { type: 'father',  tamil: 'அப்பா' },
  daughter: { type: 'father',  tamil: 'அப்பா' },
  brother:  { type: 'brother', tamil: 'அண்ணன்/தம்பி' },
  sister:   { type: 'sister',  tamil: 'அக்கா/தங்கை' },
  spouse:   { type: 'spouse',  tamil: 'மனைவி/கணவன்' },
};

// Gender-aware reverse — if we know gender we can be more specific
function getReverseRelation(relation_type, fromUserGender) {
  const base = REVERSE_RELATION[relation_type];
  if (!base) return { type: relation_type, tamil: relation_type };

  // If father/mother added son/daughter — reverse depends on gender of adder
  if (relation_type === 'son' || relation_type === 'daughter') {
    if (fromUserGender === 'female') return { type: 'mother', tamil: 'அம்மா' };
    return { type: 'father', tamil: 'அப்பா' };
  }
  if (relation_type === 'father') return { type: 'son', tamil: 'மகன்' };
  if (relation_type === 'mother') return { type: 'son', tamil: 'மகன்' };

  return base;
}

// ─────────────────────────────────────────
// Helper — find user by phone, handles any format
// ─────────────────────────────────────────
async function findUserByPhone(rawPhone) {
  const digits = rawPhone.replace(/\D/g, '');
  console.log('[findUserByPhone] looking for digits:', digits);

  const { data: allUsers, error } = await supabase
    .from('pmf_users')
    .select('*');

  if (error) {
    console.log('[findUserByPhone] DB error:', error.message, '| code:', error.code);
    return null;
  }

  console.log('[findUserByPhone] total users in DB:', allUsers?.length);

  const match = allUsers?.find(u => {
    const stored = (u.phone || '').replace(/\D/g, '');
    return stored === digits || stored.endsWith(digits) || digits.endsWith(stored);
  });

  if (match) console.log('[findUserByPhone] found:', match.name, match.phone);
  else console.log('[findUserByPhone] no match found for:', digits);

  return match || null;
}

// ─────────────────────────────────────────
// POST /api/relationships
// ─────────────────────────────────────────
router.post('/', async (req, res) => {
  const { to_user_phone, relation_type, relation_tamil } = req.body;

  if (!to_user_phone || !relation_type) {
    return res.status(400).json({ error: 'to_user_phone and relation_type are required' });
  }

  const toUser = await findUserByPhone(to_user_phone);

  if (!toUser) {
    return res.status(404).json({ error: 'No user found with that phone number. They need to register on frootze first.' });
  }

  if (toUser.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot add yourself' });
  }

  const { data: existing } = await supabase
    .from('pmf_relationships')
    .select('id, verification_status')
    .or(`and(from_user_id.eq.${req.user.id},to_user_id.eq.${toUser.id}),and(from_user_id.eq.${toUser.id},to_user_id.eq.${req.user.id})`)
    .single();

  if (existing) {
    return res.status(400).json({
      error: existing.verification_status === 'verified'
        ? 'இந்த உறவு ஏற்கனவே உள்ளது / Relationship already exists'
        : 'கோரிக்கை ஏற்கனவே அனுப்பப்பட்டது / Request already sent'
    });
  }

  const { data: fromUser } = await supabase
    .from('pmf_users')
    .select('id, name, phone, gender')
    .eq('id', req.user.id)
    .single();

  const { data: relationship, error: createError } = await supabase
    .from('pmf_relationships')
    .insert({
      from_user_id: req.user.id,
      to_user_id: toUser.id,
      relation_type,
      relation_tamil,
      verification_status: 'pending',
      created_by: req.user.id
    })
    .select().single();

  if (createError) {
    console.error('Create relationship error:', createError);
    return res.status(500).json({ error: 'Failed to create relationship' });
  }

  const { data: message } = await supabase
    .from('pmf_messages')
    .insert({
      from_user_id: req.user.id,
      message_type: 'personal',
      subject: '🌳 குடும்ப இணைப்பு கோரிக்கை / Family Connection Request',
      content: `${fromUser?.name} உங்களை தங்கள் ${relation_tamil} ஆக சேர்க்க கோருகிறார். frootze Dashboard-ல் ஏற்கவும் அல்லது நிராகரிக்கவும்.\n\n${fromUser?.name} has sent you a family connection request as ${relation_tamil}. Please accept or reject from your Dashboard.`
    })
    .select().single();

  if (message) {
    await supabase.from('pmf_message_recipients').insert({
      message_id: message.id,
      to_user_id: toUser.id,
      is_read: false
    });
  }

  const notifResults = { email: false, telegram: false };

  if (toUser.email) {
    const emailResult = await sendEmail({
      to_email: toUser.email,
      from_name: fromUser?.name,
      relation_tamil,
      type: 'request'
    });
    notifResults.email = emailResult.success;
  }

  const digitsOnly = to_user_phone.replace(/\D/g, '').replace(/^91/, '');

  return res.json({
    success: true,
    relationship,
    notifications: notifResults,
    whatsapp_link: `https://wa.me/91${digitsOnly}?text=${encodeURIComponent(
      `🌳 வணக்கம்!\n\n${fromUser?.name} frootze-ல் உங்களை ${relation_tamil} ஆக சேர்க்க கோரிக்கை அனுப்பியுள்ளார்.\n\nஏற்க frootze.com திறக்கவும்:\nhttps://frootze.com\n\n_${fromUser?.name} sent you a family request on frootze._`
    )}`
  });
});

// ─────────────────────────────────────────
// GET /api/relationships/mine
// Returns all relationships with correct labels per viewer
// ─────────────────────────────────────────
router.get('/mine', async (req, res) => {

  // Outgoing — I added them — label is as I defined
  const { data: outgoing } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil, verification_status, created_at,
      to_user:to_user_id(id, name, phone),
      from_user:from_user_id(id, gender)`)
    .eq('from_user_id', req.user.id)
    .order('created_at', { ascending: false });

  // Incoming verified — they added me — label must be REVERSED
  const { data: incoming } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil, verification_status, created_at,
      to_user:from_user_id(id, name, phone),
      from_user:from_user_id(id, gender)`)
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'verified')
    .order('created_at', { ascending: false });

  // Pending requests that need MY action
  const { data: pendingMyAction } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil, verification_status,
      to_user:from_user_id(id, name, phone)`)
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'pending');

  // For outgoing verified — label stays as defined
  const outgoingVerified = (outgoing || [])
    .filter(r => r.verification_status === 'verified')
    .map(r => ({
      ...r,
      // label stays same — I defined this relation
    }));

  // For incoming verified — reverse the label
  const incomingVerified = (incoming || []).map(r => {
    const reversed = getReverseRelation(r.relation_type, r.from_user?.gender);
    return {
      ...r,
      relation_type: reversed.type,
      relation_tamil: reversed.tamil,
    };
  });

  const allVerified = [...outgoingVerified, ...incomingVerified];

  const summary = {
    total_verified: allVerified.length,
    pending_sent: (outgoing || []).filter(r => r.verification_status === 'pending').length,
    pending_my_action: (pendingMyAction || []).length
  };

  return res.json({
    success: true,
    my_relationships: allVerified,
    pending_verification: pendingMyAction || [],
    summary
  });
});

// ─────────────────────────────────────────
// POST /api/relationships/verify
// ─────────────────────────────────────────
router.post('/verify', async (req, res) => {
  const { relationship_id } = req.body;

  const { data: rel } = await supabase
    .from('pmf_relationships')
    .select('*, from_user:from_user_id(id, name, email)')
    .eq('id', relationship_id)
    .eq('to_user_id', req.user.id)
    .single();

  if (!rel) return res.status(404).json({ error: 'Request not found' });

  await supabase
    .from('pmf_relationships')
    .update({ verification_status: 'verified', verified_at: new Date().toISOString() })
    .eq('id', relationship_id);

  const { data: acceptor } = await supabase
    .from('pmf_users').select('name').eq('id', req.user.id).single();

  if (rel.from_user?.email) {
    await sendEmail({
      to_email: rel.from_user.email,
      from_name: acceptor?.name,
      relation_tamil: rel.relation_tamil,
      type: 'accepted'
    });
  }

  return res.json({ success: true, message: 'உறவு சரிபார்க்கப்பட்டது / Relationship verified' });
});

// ─────────────────────────────────────────
// POST /api/relationships/reject
// ─────────────────────────────────────────
router.post('/reject', async (req, res) => {
  const { relationship_id } = req.body;

  await supabase
    .from('pmf_relationships')
    .update({ verification_status: 'rejected' })
    .eq('id', relationship_id)
    .eq('to_user_id', req.user.id);

  return res.json({ success: true, message: 'நிராகரிக்கப்பட்டது / Rejected' });
});

module.exports = router;
