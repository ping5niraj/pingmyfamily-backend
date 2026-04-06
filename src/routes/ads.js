/**
 * ads.js — Business Agent Ads API
 * C:\Projects\PingMyFamily\backend\src\routes\ads.js
 *
 * Only users with is_business_agent=true can create ads.
 * Admin upgrades users via /api/admin/upgrade-agent
 *
 * Endpoints:
 *   POST   /api/ads              — create ad (business agent only)
 *   GET    /api/ads/my           — get my ads
 *   GET    /api/ads/feed/:user_id — get ads visible to this user (for feed)
 *   PATCH  /api/ads/:id/status   — pause / activate ad
 *   DELETE /api/ads/:id          — delete own ad
 */

const express  = require('express');
const router   = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// ─────────────────────────────────────────
// Helper — verify business agent
// ─────────────────────────────────────────
async function isBusinessAgent(userId) {
  const { data } = await supabase
    .from('pmf_users')
    .select('is_business_agent')
    .eq('id', userId)
    .single();
  return data?.is_business_agent === true;
}

// ─────────────────────────────────────────
// Helper — get verified family member IDs
// ─────────────────────────────────────────
async function getFamilyIds(userId) {
  const ids = new Set([userId]);
  const { data: out } = await supabase
    .from('pmf_relationships')
    .select('to_user_id')
    .eq('from_user_id', userId)
    .eq('verification_status', 'verified')
    .eq('is_offline', false);
  const { data: inc } = await supabase
    .from('pmf_relationships')
    .select('from_user_id')
    .eq('to_user_id', userId)
    .eq('verification_status', 'verified')
    .eq('is_offline', false);
  (out || []).forEach(r => { if (r.to_user_id) ids.add(r.to_user_id); });
  (inc || []).forEach(r => { if (r.from_user_id) ids.add(r.from_user_id); });
  return ids;
}

// ─────────────────────────────────────────
// POST /api/ads
// Create a new ad — business agent only
// Body: { ad_type, target_user_id?, target_kutham?, media_url?, media_type?,
//         caption, cta_text?, cta_url?, whatsapp_number? }
// ─────────────────────────────────────────
router.post('/', async (req, res) => {
  if (!(await isBusinessAgent(req.user.id))) {
    return res.status(403).json({ error: 'Only Business Agents can create ads' });
  }

  const {
    ad_type, target_user_id, target_kutham,
    media_url, media_type, caption,
    cta_text, cta_url, whatsapp_number,
  } = req.body;

  if (!ad_type) return res.status(400).json({ error: 'ad_type is required' });
  if (!caption && !media_url) return res.status(400).json({ error: 'Caption or media is required' });
  if (ad_type === 'personal' && !target_user_id) return res.status(400).json({ error: 'target_user_id required for personal ads' });
  if (ad_type === 'group'    && !target_kutham)  return res.status(400).json({ error: 'target_kutham required for group ads' });

  try {
    const { data: ad, error } = await supabase
      .from('pmf_ads')
      .insert({
        posted_by: req.user.id,
        ad_type, target_user_id: target_user_id || null,
        target_kutham: target_kutham || null,
        media_url: media_url || null,
        media_type: media_type || null,
        caption: caption || null,
        cta_text: cta_text || null,
        cta_url: cta_url || null,
        whatsapp_number: whatsapp_number || null,
        status: 'active',
      })
      .select().single();

    if (error) throw error;
    return res.json({ success: true, ad, message: 'விளம்பரம் வெளியிடப்பட்டது / Ad published' });
  } catch (err) {
    console.error('Create ad error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /api/ads/my
// Get my own ads (business agent)
// ─────────────────────────────────────────
router.get('/my', async (req, res) => {
  try {
    const { data: ads, error } = await supabase
      .from('pmf_ads')
      .select('*')
      .eq('posted_by', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, ads: ads || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /api/ads/feed/:user_id
// Get ads visible to this user — for inserting at top of feed
// Returns ads where:
//   broadcast  → always visible
//   group      → user's kutham matches
//   personal   → user is the target
// ─────────────────────────────────────────
router.get('/feed/:user_id', async (req, res) => {
  const userId = req.params.user_id;

  try {
    // Get user's kutham
    const { data: me } = await supabase
      .from('pmf_users')
      .select('kutham')
      .eq('id', userId)
      .single();

    // Get all family member IDs — ads only from family business agents
    const familyIds = await getFamilyIds(userId);
    const familyIdsArray = Array.from(familyIds);

    // Fetch active ads from family business agents
    const { data: ads, error } = await supabase
      .from('pmf_ads')
      .select(`
        *,
        posted_by_user:posted_by(id, name, kutham, profile_photo)
      `)
      .in('posted_by', familyIdsArray)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Filter by visibility rules
    const visible = (ads || []).filter(ad => {
      if (ad.ad_type === 'broadcast') return true;
      if (ad.ad_type === 'group'    && me?.kutham && ad.target_kutham === me.kutham) return true;
      if (ad.ad_type === 'personal' && ad.target_user_id === userId) return true;
      // Always show own ads
      if (ad.posted_by === userId) return true;
      return false;
    });

    return res.json({ success: true, ads: visible });
  } catch (err) {
    console.error('Ads feed error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// PATCH /api/ads/:id/status
// Toggle active / paused
// ─────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status must be active or paused' });
  }
  try {
    const { data: ad } = await supabase.from('pmf_ads').select('posted_by').eq('id', req.params.id).single();
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    if (ad.posted_by !== req.user.id) return res.status(403).json({ error: 'Not your ad' });
    await supabase.from('pmf_ads').update({ status }).eq('id', req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// DELETE /api/ads/:id
// ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { data: ad } = await supabase.from('pmf_ads').select('posted_by').eq('id', req.params.id).single();
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    if (ad.posted_by !== req.user.id) return res.status(403).json({ error: 'Not your ad' });
    await supabase.from('pmf_ads').delete().eq('id', req.params.id);
    return res.json({ success: true, message: 'விளம்பரம் நீக்கப்பட்டது / Ad deleted' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
