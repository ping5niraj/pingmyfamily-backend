const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// Tamil relation knowledge base for quiz
const RELATION_KNOWLEDGE = [
  { type: 'father',               tamil: 'அப்பா',        english: 'Father' },
  { type: 'mother',               tamil: 'அம்மா',        english: 'Mother' },
  { type: 'brother',              tamil: 'அண்ணன்',       english: 'Brother' },
  { type: 'sister',               tamil: 'அக்கா',        english: 'Sister' },
  { type: 'son',                  tamil: 'மகன்',          english: 'Son' },
  { type: 'daughter',             tamil: 'மகள்',          english: 'Daughter' },
  { type: 'spouse',               tamil: 'மனைவி/கணவன்',  english: 'Spouse' },
  { type: 'grandfather_paternal', tamil: 'தாத்தா',        english: 'Grandfather' },
  { type: 'grandmother_paternal', tamil: 'பாட்டி',        english: 'Grandmother' },
  { type: 'uncle_elder',          tamil: 'பெரியப்பா',     english: 'Uncle (elder)' },
  { type: 'uncle_younger',        tamil: 'சித்தப்பா',     english: 'Uncle (younger)' },
  { type: 'aunt_paternal',        tamil: 'அத்தை',         english: 'Aunt' },
  { type: 'father_in_law',        tamil: 'மாமா',          english: 'Father-in-law' },
  { type: 'mother_in_law',        tamil: 'மாமி',          english: 'Mother-in-law' },
  { type: 'grandson',             tamil: 'பேரன்',         english: 'Grandson' },
  { type: 'granddaughter',        tamil: 'பேத்தி',        english: 'Granddaughter' },
];

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function getRandom(arr, n) {
  return shuffle(arr).slice(0, n);
}

// ─────────────────────────────────────────
// GET /api/quiz/today
// Get today's quiz status + questions
// ─────────────────────────────────────────
router.get('/today', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  // Check if already played today
  const { data: existing } = await supabase
    .from('pmf_quiz_scores')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('quiz_date', today)
    .single();

  if (existing) {
    // Get streak
    const { data: scores } = await supabase
      .from('pmf_quiz_scores')
      .select('quiz_date, score')
      .eq('user_id', req.user.id)
      .order('quiz_date', { ascending: false })
      .limit(30);

    return res.json({
      success: true,
      already_played: true,
      today_score: existing.score,
      today_total: existing.total,
      streak: existing.streak,
      scores: scores || []
    });
  }

  // Get family members for photo questions
  const { data: outgoing } = await supabase
    .from('pmf_relationships')
    .select('to_user:to_user_id(id, name, profile_photo), relation_type, relation_tamil')
    .eq('from_user_id', req.user.id)
    .eq('verification_status', 'verified');

  const familyMembers = outgoing?.filter(r => r.to_user?.profile_photo) || [];

  // Generate 5 questions
  const questions = [];
  const questionTypes = shuffle(['relation_type', 'tamil_word', 'photo_name', 'relation_type', 'tamil_word']);

  for (let i = 0; i < 5; i++) {
    const qType = questionTypes[i];

    if (qType === 'relation_type' || familyMembers.length < 2) {
      // Q: "How is [Name] related to you?"
      const rel = familyMembers[Math.floor(Math.random() * familyMembers.length)];
      if (!rel) {
        // Fallback to tamil word question
        const correct = RELATION_KNOWLEDGE[Math.floor(Math.random() * RELATION_KNOWLEDGE.length)];
        const wrong = getRandom(RELATION_KNOWLEDGE.filter(r => r.type !== correct.type), 3);
        questions.push({
          id: i,
          type: 'tamil_word',
          question: `"${correct.tamil}" என்றால் என்ன? / What does "${correct.tamil}" mean?`,
          correct_answer: correct.english,
          options: shuffle([correct.english, ...wrong.map(w => w.english)]),
        });
        continue;
      }

      const wrong = getRandom(
        RELATION_KNOWLEDGE.filter(r => r.type !== rel.relation_type),
        3
      );
      questions.push({
        id: i,
        type: 'relation_type',
        question: `${rel.to_user.name} உங்களுக்கு எப்படி உறவு? / How is ${rel.to_user.name} related to you?`,
        correct_answer: rel.relation_tamil,
        options: shuffle([
          rel.relation_tamil,
          ...wrong.map(w => w.tamil)
        ]),
      });

    } else if (qType === 'tamil_word') {
      // Q: What does this Tamil word mean?
      const correct = RELATION_KNOWLEDGE[Math.floor(Math.random() * RELATION_KNOWLEDGE.length)];
      const wrong = getRandom(RELATION_KNOWLEDGE.filter(r => r.type !== correct.type), 3);
      questions.push({
        id: i,
        type: 'tamil_word',
        question: `"${correct.tamil}" என்றால் என்ன? / What does "${correct.tamil}" mean?`,
        correct_answer: correct.english,
        options: shuffle([correct.english, ...wrong.map(w => w.english)]),
      });

    } else if (qType === 'photo_name') {
      // Q: Who is this person? (show photo)
      if (familyMembers.length < 2) {
        const correct = RELATION_KNOWLEDGE[Math.floor(Math.random() * RELATION_KNOWLEDGE.length)];
        const wrong = getRandom(RELATION_KNOWLEDGE.filter(r => r.type !== correct.type), 3);
        questions.push({
          id: i,
          type: 'tamil_word',
          question: `"${correct.tamil}" என்றால் என்ன?`,
          correct_answer: correct.english,
          options: shuffle([correct.english, ...wrong.map(w => w.english)]),
        });
        continue;
      }

      const correct = familyMembers[Math.floor(Math.random() * familyMembers.length)];
      const wrongMembers = getRandom(
        familyMembers.filter(m => m.to_user.id !== correct.to_user.id),
        Math.min(3, familyMembers.length - 1)
      );

      const allOptions = [correct.to_user.name, ...wrongMembers.map(m => m.to_user.name)];
      while (allOptions.length < 4) {
        allOptions.push(`குடும்பத்தினர் ${allOptions.length}`);
      }

      questions.push({
        id: i,
        type: 'photo_name',
        question: 'இவர் யார்? / Who is this person?',
        photo: correct.to_user.profile_photo,
        correct_answer: correct.to_user.name,
        options: shuffle(allOptions),
      });
    }
  }

  return res.json({
    success: true,
    already_played: false,
    questions,
    total: questions.length
  });
});

// ─────────────────────────────────────────
// POST /api/quiz/submit
// Submit quiz answers and save score
// Body: { answers: [{ question_id, answer }] }
// ─────────────────────────────────────────
router.post('/submit', async (req, res) => {
  const { answers, questions } = req.body;
  const today = new Date().toISOString().split('T')[0];

  // Check if already submitted today
  const { data: existing } = await supabase
    .from('pmf_quiz_scores')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('quiz_date', today)
    .single();

  if (existing) {
    return res.status(400).json({ error: 'Already submitted today\'s quiz' });
  }

  // Calculate score
  let score = 0;
  const results = [];

  questions?.forEach((q, i) => {
    const userAnswer = answers?.[i]?.answer;
    const isCorrect = userAnswer === q.correct_answer;
    if (isCorrect) score++;
    results.push({
      question: q.question,
      user_answer: userAnswer,
      correct_answer: q.correct_answer,
      is_correct: isCorrect
    });
  });

  // Calculate streak
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const { data: yesterdayScore } = await supabase
    .from('pmf_quiz_scores')
    .select('streak')
    .eq('user_id', req.user.id)
    .eq('quiz_date', yesterdayStr)
    .single();

  const streak = yesterdayScore ? (yesterdayScore.streak + 1) : 1;

  // Save score
  await supabase.from('pmf_quiz_scores').insert({
    user_id: req.user.id,
    score,
    total: questions?.length || 5,
    quiz_date: today,
    streak
  });

  // Fun message based on score
  let message = '';
  if (score === 5) message = 'அருமை! நீங்கள் குடும்ப நிபுணர்! / Perfect! You\'re a family expert! 🏆';
  else if (score >= 3) message = 'சாபாஷ்! / Well done! 🌟';
  else if (score >= 1) message = 'நல்ல முயற்சி! / Good try! Keep learning! 💪';
  else message = 'கவலை வேண்டாம்! நாளை மீண்டும் முயற்சி! / Don\'t worry! Try again tomorrow! 🌱';

  return res.json({
    success: true,
    score,
    total: questions?.length || 5,
    streak,
    message,
    results,
    perfect: score === 5
  });
});

// ─────────────────────────────────────────
// GET /api/quiz/leaderboard
// Top scorers in the family
// ─────────────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  // Get family member IDs
  const { data: outgoing } = await supabase
    .from('pmf_relationships')
    .select('to_user_id')
    .eq('from_user_id', req.user.id)
    .eq('verification_status', 'verified');

  const { data: incoming } = await supabase
    .from('pmf_relationships')
    .select('from_user_id')
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'verified');

  const familyIds = new Set([req.user.id]);
  outgoing?.forEach(r => familyIds.add(r.to_user_id));
  incoming?.forEach(r => familyIds.add(r.from_user_id));

  // Get scores for this week
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];

  const { data: scores } = await supabase
    .from('pmf_quiz_scores')
    .select('user_id, score, streak, quiz_date, user:user_id(id, name, profile_photo)')
    .in('user_id', [...familyIds])
    .gte('quiz_date', weekAgoStr)
    .order('score', { ascending: false });

  // Aggregate by user
  const userScores = {};
  scores?.forEach(s => {
    if (!userScores[s.user_id]) {
      userScores[s.user_id] = {
        user: s.user,
        total_score: 0,
        games_played: 0,
        max_streak: 0
      };
    }
    userScores[s.user_id].total_score += s.score;
    userScores[s.user_id].games_played += 1;
    userScores[s.user_id].max_streak = Math.max(userScores[s.user_id].max_streak, s.streak);
  });

  const leaderboard = Object.values(userScores)
    .sort((a, b) => b.total_score - a.total_score)
    .slice(0, 10);

  return res.json({ success: true, leaderboard });
});

module.exports = router;
