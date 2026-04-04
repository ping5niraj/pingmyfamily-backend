const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const authMiddleware = require('../middleware/auth');
const { generateSuggestionsForNetwork } = require('../services/suggestionEngine');

router.use(authMiddleware);

// ─────────────────────────────────────────
// POST /api/suggestions/generate
// Called after a relationship is verified
// ─────────────────────────────────────────
router.post('/generate', async (req, res) => {
  const { user_id_a, user_id_b } = req.body;
  if (!user_id_a || !user_id_b) {
    return res.status(400).json({ error: 'user_id_a and user_id_b required' });
  }
  try {
    await generateSuggestionsForNetwork(user_id_a, user_id_b);
    return res.json({ success: true });
  } catch (err) {
    console.error('Generate suggestions error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /api/suggestions/mine
// ─────────────────────────────────────────
router.get('/mine', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pmf_suggestions')
      .select(`
        id, relation_type, relation_tamil, suggested_name, via_relation, created_at,
        suggested_user:suggested_user_id(id, name, profile_photo, kutham),
        via_user:via_user_id(id, name)
      `)
      .eq('for_user_id', req.user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, suggestions: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /api/suggestions/:id/accept
// ─────────────────────────────────────────
router.post('/:id/accept', async (req, res) => {
  try {
    const { data: suggestion } = await supabase
      .from('pmf_suggestions')
      .select('*')
      .eq('id', req.params.id)
      .eq('for_user_id', req.user.id)
      .single();

    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });

    await supabase.from('pmf_relationships').upsert({
      from_user_id: req.user.id,
      to_user_id: suggestion.suggested_user_id,
      relation_type: suggestion.relation_type,
      relation_tamil: suggestion.relation_tamil,
      verification_status: 'pending',
      created_by: req.user.id,
      is_offline: false,
    }, { onConflict: 'from_user_id,to_user_id,relation_type', ignoreDuplicates: true });

    await supabase.from('pmf_suggestions')
      .update({ status: 'accepted' })
      .eq('id', req.params.id);

    return res.json({ success: true, message: 'உறவு கோரிக்கை அனுப்பப்பட்டது' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /api/suggestions/:id/dismiss
// ─────────────────────────────────────────
router.post('/:id/dismiss', async (req, res) => {
  try {
    await supabase.from('pmf_suggestions')
      .update({ status: 'dismissed' })
      .eq('id', req.params.id)
      .eq('for_user_id', req.user.id);

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
