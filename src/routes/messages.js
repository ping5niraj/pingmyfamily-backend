const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { sendTelegramInvite } = require('../services/telegram');

router.use(authMiddleware);

// ─────────────────────────────────────────
// POST /api/messages/send-telegram
// Send Telegram invite notification
// ─────────────────────────────────────────
router.post('/send-telegram', async (req, res) => {
  const { to_username, from_name, relation_tamil, invite_link } = req.body;
  if (!to_username) return res.status(400).json({ error: 'Telegram username required' });

  const result = await sendTelegramInvite({ to_username, from_name, relation_tamil, invite_link });
  if (result.success) return res.json({ success: true });
  return res.status(500).json({ error: result.error || 'Telegram send failed' });
});

// ─────────────────────────────────────────
// GET /api/messages/family-members
// Get verified family members for messaging
// ─────────────────────────────────────────
router.get('/family-members', async (req, res) => {
  const { data: outgoing } = await supabase
    .from('pmf_relationships')
    .select('to_user:to_user_id(id, name, profile_photo), relation_tamil')
    .eq('from_user_id', req.user.id)
    .eq('verification_status', 'verified');

  const { data: incoming } = await supabase
    .from('pmf_relationships')
    .select('from_user:from_user_id(id, name, profile_photo), relation_tamil')
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'verified');

  const members = [
    ...(outgoing?.map(r => ({ ...r.to_user, relation_tamil: r.relation_tamil })) || []),
    ...(incoming?.map(r => ({ ...r.from_user, relation_tamil: r.relation_tamil })) || []),
  ];

  // Remove duplicates
  const unique = members.filter((m, i, self) => self.findIndex(x => x.id === m.id) === i);
  return res.json({ success: true, members: unique });
});

// ─────────────────────────────────────────
// POST /api/messages/send
// Send a message
// ─────────────────────────────────────────
router.post('/send', async (req, res) => {
  const { to_user_ids, subject, content, message_type } = req.body;
  if (!content) return res.status(400).json({ error: 'Content required' });

  const { data: message, error } = await supabase
    .from('pmf_messages')
    .insert({ from_user_id: req.user.id, message_type: message_type || 'personal', subject, content })
    .select().single();

  if (error) return res.status(500).json({ error: 'Failed to send message' });

  if (to_user_ids && to_user_ids.length > 0) {
    const recipients = to_user_ids.map(uid => ({ message_id: message.id, to_user_id: uid, is_read: false }));
    await supabase.from('pmf_message_recipients').insert(recipients);
  }

  return res.json({ success: true, message });
});

// ─────────────────────────────────────────
// GET /api/messages/inbox
// ─────────────────────────────────────────
router.get('/inbox', async (req, res) => {
  const { data: recipients } = await supabase
    .from('pmf_message_recipients')
    .select(`id, is_read, message:message_id(id, subject, content, message_type, created_at, from_user:from_user_id(id, name, profile_photo))`)
    .eq('to_user_id', req.user.id)
    .order('created_at', { ascending: false });

  return res.json({ success: true, messages: recipients || [] });
});

// ─────────────────────────────────────────
// GET /api/messages/sent
// ─────────────────────────────────────────
router.get('/sent', async (req, res) => {
  const { data: messages } = await supabase
    .from('pmf_messages')
    .select('*')
    .eq('from_user_id', req.user.id)
    .order('created_at', { ascending: false });

  return res.json({ success: true, messages: messages || [] });
});

// ─────────────────────────────────────────
// PUT /api/messages/:id/read
// ─────────────────────────────────────────
router.put('/:id/read', async (req, res) => {
  await supabase
    .from('pmf_message_recipients')
    .update({ is_read: true })
    .eq('id', req.params.id)
    .eq('to_user_id', req.user.id);

  return res.json({ success: true });
});

module.exports = router;
