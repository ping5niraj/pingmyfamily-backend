const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// ─────────────────────────────────────────
// GET /api/birthdays
// Get all verified family members birthdays
// Returns: today's birthdays + upcoming (next 30 days)
// ─────────────────────────────────────────
router.get('/', async (req, res) => {
  // Get all verified family member IDs
  const { data: outgoing } = await supabase
    .from('pmf_relationships')
    .select('to_user_id')
    .eq('from_user_id', req.user.id)
    .eq('verification_status', 'verified');

  const { data: incoming } = await supabase
    .from('pmf_relationships')
    .select('from_user_id, relation_tamil, relation_type')
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'verified');

  const familyIds = new Set();
  const relationMap = {};

  outgoing?.forEach(r => familyIds.add(r.to_user_id));
  incoming?.forEach(r => {
    familyIds.add(r.from_user_id);
    relationMap[r.from_user_id] = r.relation_tamil;
  });

  // Also get relation_tamil for outgoing
  const { data: outgoingRels } = await supabase
    .from('pmf_relationships')
    .select('to_user_id, relation_tamil')
    .eq('from_user_id', req.user.id)
    .eq('verification_status', 'verified');

  outgoingRels?.forEach(r => {
    if (!relationMap[r.to_user_id]) relationMap[r.to_user_id] = r.relation_tamil;
  });

  if (familyIds.size === 0) {
    return res.json({ success: true, today: [], upcoming: [], all: [] });
  }

  // Get users with date_of_birth
  const { data: members, error } = await supabase
    .from('pmf_users')
    .select('id, name, profile_photo, date_of_birth, gender')
    .in('id', [...familyIds])
    .not('date_of_birth', 'is', null);

  if (error) return res.status(500).json({ error: 'Failed to fetch birthdays' });

  const today = new Date();
  const todayMonth = today.getMonth() + 1;
  const todayDay = today.getDate();
  const todayYear = today.getFullYear();

  const todayBirthdays = [];
  const upcomingBirthdays = [];
  const allBirthdays = [];

  members?.forEach(member => {
    if (!member.date_of_birth) return;

    const dob = new Date(member.date_of_birth);
    const birthMonth = dob.getMonth() + 1;
    const birthDay = dob.getDate();
    const birthYear = dob.getFullYear();

    const age = todayYear - birthYear;

    // Days until next birthday
    let nextBirthday = new Date(todayYear, birthMonth - 1, birthDay);
    if (nextBirthday < today) {
      nextBirthday = new Date(todayYear + 1, birthMonth - 1, birthDay);
    }
    const daysUntil = Math.floor((nextBirthday - today) / (1000 * 60 * 60 * 24));

    const memberData = {
      id: member.id,
      name: member.name,
      profile_photo: member.profile_photo,
      date_of_birth: member.date_of_birth,
      relation_tamil: relationMap[member.id] || '',
      birth_month: birthMonth,
      birth_day: birthDay,
      age: age,
      days_until: daysUntil,
      is_today: birthMonth === todayMonth && birthDay === todayDay,
    };

    if (memberData.is_today) {
      todayBirthdays.push(memberData);
    } else if (daysUntil <= 30) {
      upcomingBirthdays.push(memberData);
    }

    allBirthdays.push(memberData);
  });

  // Sort upcoming by days_until
  upcomingBirthdays.sort((a, b) => a.days_until - b.days_until);
  allBirthdays.sort((a, b) => {
    const aDate = new Date(2000, a.birth_month - 1, a.birth_day);
    const bDate = new Date(2000, b.birth_month - 1, b.birth_day);
    return aDate - bDate;
  });

  return res.json({
    success: true,
    today: todayBirthdays,
    upcoming: upcomingBirthdays,
    all: allBirthdays,
    today_count: todayBirthdays.length,
    upcoming_count: upcomingBirthdays.length
  });
});

module.exports = router;
