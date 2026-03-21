const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const authMiddleware = require('../middleware/auth');
const { sendEmail, sendTelegram } = require('../services/notifications');

router.use(authMiddleware);

// Helper — find user by phone, handles any format
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
// Add a relationship — creates pending request
// Sends notifications automatically
// ─────────────────────────────────────────
router.post('/', async (req, res) => {
  const { to_user_phone, relation_type, relation_tamil } = req.body;

  if (!to_user_phone || !relation_type) {
    return res.status(400).json({ error: 'to_user_phone and relation_type are required' });
  }

  // Find target user — tries all phone formats
  const toUser = await findUserByPhone(to_user_phone);

  if (!toUser) {
    return res.status(404).json({ error: 'No user found with that phone number. They need to register on frootze first.' });
  }

  if (toUser.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot add yourself' });
  }

  // Check if relationship already exists
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

  // Get sender info
  const { data: fromUser } = await supabase
    .from('pmf_users')
    .select('id, name, phone')
    .eq('id', req.user.id)
    .single();

  // Create relationship
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

  // Create in-app notification message
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

  // Send notifications
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

  if (toUser.telegram_chat_id) {
    const telegramResult = await sendTelegram({
      chat_id: toUser.telegram_chat_id,
      from_name: fromUser?.name,
      relation_tamil,
      type: 'request'
    });
    notifResults.telegram = telegramResult.success;
  }

  // Use digits-only for WhatsApp link
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
// ─────────────────────────────────────────
router.get('/mine', async (req, res) => {
  const { data: outgoing } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil, verification_status, created_at,
      to_user:to_user_id(id, name, phone, profile_photo)`)
    .eq('from_user_id', req.user.id)
    .order('created_at', { ascending: false });

  const { data: incoming } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil, verification_status, created_at,
      to_user:from_user_id(id, name, phone, profile_photo)`)
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'verified')
    .order('created_at', { ascending: false });

  // Pending requests that need MY action
  const { data: pendingMyAction } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil, verification_status,
      to_user:from_user_id(id, name, phone, profile_photo)`)
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'pending');

  const allVerified = [
    ...(outgoing?.filter(r => r.verification_status === 'verified') || []),
    ...(incoming || [])
  ];

  const summary = {
    total_verified: allVerified.length,
    pending_sent: outgoing?.filter(r => r.verification_status === 'pending').length || 0,
    pending_my_action: pendingMyAction?.length || 0
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
// Accept relationship request
// ─────────────────────────────────────────
router.post('/verify', async (req, res) => {
  const { relationship_id } = req.body;

  const { data: rel } = await supabase
    .from('pmf_relationships')
    .select('*, from_user:from_user_id(id, name, email, telegram_chat_id)')
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

  if (rel.from_user?.telegram_chat_id) {
    await sendTelegram({
      chat_id: rel.from_user.telegram_chat_id,
      from_name: acceptor?.name,
      relation_tamil: rel.relation_tamil,
      type: 'accepted'
    });
  }

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
// Reject relationship request
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
