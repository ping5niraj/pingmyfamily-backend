const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// GET /api/kuthams — return approved kutham list
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('pmf_kuthams')
    .select('id, name')
    .order('name', { ascending: true });

  if (error) return res.status(500).json({ error: 'Failed to fetch kuthams' });
  return res.json({ success: true, kuthams: data || [] });
});

module.exports = router;
