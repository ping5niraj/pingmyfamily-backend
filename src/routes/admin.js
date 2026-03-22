const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─────────────────────────────────────────
// Admin auth middleware
// ─────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    if (!decoded.isAdmin) return res.status(401).json({ error: 'Not an admin' });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─────────────────────────────────────────
// POST /api/admin/login
// ─────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username !== process.env.ADMIN_USERNAME ||
      password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'தவறான பயனர்பெயர் அல்லது கடவுச்சொல் / Invalid credentials' });
  }
  const token = jwt.sign(
    { isAdmin: true, username },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
  return res.json({ success: true, token });
});

// ─────────────────────────────────────────
// GET /api/admin/stats
// ─────────────────────────────────────────
router.get('/stats', adminAuth, async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [users, relationships, kuthams, newToday, pending] = await Promise.all([
    supabase.from('pmf_users').select('id', { count: 'exact', head: true }),
    supabase.from('pmf_relationships').select('id', { count: 'exact', head: true })
      .eq('verification_status', 'verified'),
    supabase.from('pmf_kuthams').select('id', { count: 'exact', head: true }),
    supabase.from('pmf_users').select('id', { count: 'exact', head: true })
      .gte('created_at', today.toISOString()),
    supabase.from('pmf_relationships').select('id', { count: 'exact', head: true })
      .eq('verification_status', 'pending'),
  ]);

  return res.json({
    success: true,
    stats: {
      total_users: users.count || 0,
      total_verified_relationships: relationships.count || 0,
      total_kuthams: kuthams.count || 0,
      new_users_today: newToday.count || 0,
      pending_relationships: pending.count || 0,
    }
  });
});

// ─────────────────────────────────────────
// GET /api/admin/kuthams
// ─────────────────────────────────────────
router.get('/kuthams', adminAuth, async (req, res) => {
  const { data: kuthams } = await supabase
    .from('pmf_kuthams')
    .select('id, name, created_at')
    .order('name', { ascending: true });

  // Get user count per kutham
  const { data: users } = await supabase
    .from('pmf_users')
    .select('kutham');

  const countMap = {};
  (users || []).forEach(u => {
    if (u.kutham) countMap[u.kutham] = (countMap[u.kutham] || 0) + 1;
  });

  const result = (kuthams || []).map(k => ({
    ...k,
    user_count: countMap[k.name] || 0
  }));

  return res.json({ success: true, kuthams: result });
});

// ─────────────────────────────────────────
// POST /api/admin/kuthams
// ─────────────────────────────────────────
router.post('/kuthams', adminAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Kutham name required' });

  const { data, error } = await supabase
    .from('pmf_kuthams')
    .insert({ name: name.trim() })
    .select().single();

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Kutham already exists' });
    return res.status(500).json({ error: 'Failed to add kutham' });
  }

  return res.json({ success: true, kutham: data });
});

// ─────────────────────────────────────────
// DELETE /api/admin/kuthams/:id
// ─────────────────────────────────────────
router.delete('/kuthams/:id', adminAuth, async (req, res) => {
  await supabase.from('pmf_kuthams').delete().eq('id', req.params.id);
  return res.json({ success: true });
});

// ─────────────────────────────────────────
// GET /api/admin/users
// ─────────────────────────────────────────
router.get('/users', adminAuth, async (req, res) => {
  const { search } = req.query;

  let query = supabase
    .from('pmf_users')
    .select('id, name, phone, gender, kutham, district, created_at, status')
    .order('created_at', { ascending: false })
    .limit(100);

  if (search) {
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data: users, error } = await query;
  if (error) return res.status(500).json({ error: 'Failed to fetch users' });

  return res.json({ success: true, users: users || [], count: users?.length || 0 });
});

module.exports = router;
