const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// ─────────────────────────────────────────
// POST /api/messages/send
// Send personal/group/broadcast/announcement
// Body: { message_type, content, subject?, to_user_ids? }
// ─────────────────────────────────────────
router.post('/send', async (req, res) => {
  const { message_type, content, subject, to_user_ids } = req.body;

  if (!content) return res.status(400).json({ error: 'Message content is required' });
  if (!message_type) return res.status(400).json({ error: 'message_type is required' });

  // Get all verified relationships for this user
  const { data: relationships } = await supabase
    .from('pmf_relationships')
    .select('from_user_id, to_user_id')
    .or(`from_user_id.eq.${req.user.id},to_user_id.eq.${req.user.id}`)
    .eq('verification_status', 'verified');

  // Build recipient list
  let recipientIds = [];

  if (message_type === 'personal') {
    // Must provide exactly one recipient
    if (!to_user_ids || to_user_ids.length !== 1) {
      return res.status(400).json({ error: 'Personal message requires exactly one recipient' });
    }
    recipientIds = to_user_ids;

  } else if (message_type === 'group') {
    // Selected members
    if (!to_user_ids || to_user_ids.length === 0) {
      return res.status(400).json({ error: 'Group message requires at least one recipient' });
    }
    recipientIds = to_user_ids;

  } else if (message_type === 'broadcast' || message_type === 'announcement') {
    // All verified family members
    const verifiedIds = new Set();
    relationships?.forEach(rel => {
      if (rel.from_user_id === req.user.id) verifiedIds.add(rel.to_user_id);
      if (rel.to_user_id === req.user.id) verifiedIds.add(rel.from_user_id);
    });
    recipientIds = [...verifiedIds];

    if (recipientIds.length === 0) {
      return res.status(400).json({ error: 'No verified family members to send to' });
    }
  }

  // Create message
  const { data: message, error: msgError } = await supabase
    .from('pmf_messages')
    .insert({
      from_user_id: req.user.id,
      message_type,
      subject: subject?.trim() || null,
      content: content.trim(),
    })
    .select().single();

  if (msgError) {
    console.error('Message insert error:', msgError);
    return res.status(500).json({ error: 'Failed to send message' });
  }

  // Create recipients
  const recipients = recipientIds.map(uid => ({
    message_id: message.id,
    to_user_id: uid,
    is_read: false
  }));

  const { error: recError } = await supabase
    .from('pmf_message_recipients')
    .insert(recipients);

  if (recError) {
    console.error('Recipients insert error:', recError);
    return res.status(500).json({ error: 'Failed to save recipients' });
  }

  return res.json({
    success: true,
    message: `Message sent to ${recipientIds.length} member(s)`,
    message_id: message.id,
    recipient_count: recipientIds.length
  });
});

// ─────────────────────────────────────────
// GET /api/messages/inbox
// Get all messages received by logged-in user
// ─────────────────────────────────────────
router.get('/inbox', async (req, res) => {
  const { data: received, error } = await supabase
    .from('pmf_message_recipients')
    .select(`
      id, is_read, read_at, created_at,
      message:message_id (
        id, message_type, subject, content, created_at,
        from_user:from_user_id ( id, name, profile_photo )
      )
    `)
    .eq('to_user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'Failed to fetch inbox' });

  const unreadCount = received?.filter(r => !r.is_read).length || 0;

  return res.json({
    success: true,
    unread_count: unreadCount,
    messages: received || []
  });
});

// ─────────────────────────────────────────
// GET /api/messages/sent
// Get messages sent by logged-in user
// ─────────────────────────────────────────
router.get('/sent', async (req, res) => {
  const { data: sent, error } = await supabase
    .from('pmf_messages')
    .select(`
      id, message_type, subject, content, created_at,
      recipients:pmf_message_recipients (
        id, is_read, to_user_id,
        to_user:to_user_id ( id, name, profile_photo )
      )
    `)
    .eq('from_user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'Failed to fetch sent messages' });

  return res.json({ success: true, messages: sent || [] });
});

// ─────────────────────────────────────────
// PUT /api/messages/:id/read
// Mark message as read
// ─────────────────────────────────────────
router.put('/:id/read', async (req, res) => {
  const { error } = await supabase
    .from('pmf_message_recipients')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('message_id', req.params.id)
    .eq('to_user_id', req.user.id);

  if (error) return res.status(500).json({ error: 'Failed to mark as read' });
  return res.json({ success: true });
});

// ─────────────────────────────────────────
// GET /api/messages/family-members
// Get verified family members for recipient selection
// ─────────────────────────────────────────
router.get('/family-members', async (req, res) => {
  const { data: outgoing } = await supabase
    .from('pmf_relationships')
    .select('to_user:to_user_id ( id, name, profile_photo ), relation_tamil')
    .eq('from_user_id', req.user.id)
    .eq('verification_status', 'verified');

  const { data: incoming } = await supabase
    .from('pmf_relationships')
    .select('from_user:from_user_id ( id, name, profile_photo ), relation_tamil')
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'verified');

  const members = new Map();

  outgoing?.forEach(r => {
    if (r.to_user) members.set(r.to_user.id, { ...r.to_user, relation_tamil: r.relation_tamil });
  });
  incoming?.forEach(r => {
    if (r.from_user && !members.has(r.from_user.id)) {
      members.set(r.from_user.id, { ...r.from_user, relation_tamil: r.relation_tamil });
    }
  });

  return res.json({ success: true, members: [...members.values()] });
});

module.exports = router;
