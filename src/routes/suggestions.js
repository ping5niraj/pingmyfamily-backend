const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// ─────────────────────────────────────────
// Tamil label map
// ─────────────────────────────────────────
const TAMIL_MAP = {
  father:               'அப்பா',
  mother:               'அம்மா',
  son:                  'மகன்',
  daughter:             'மகள்',
  brother:              'அண்ணன்/தம்பி',
  sister:               'அக்கா/தங்கை',
  spouse:               'கணவன்/மனைவி',
  grandfather_paternal: 'தாத்தா (அப்பா பக்கம்)',
  grandmother_paternal: 'பாட்டி (அப்பா பக்கம்)',
  grandfather_maternal: 'தாத்தா (அம்மா பக்கம்)',
  grandmother_maternal: 'பாட்டி (அம்மா பக்கம்)',
  great_grandfather:    'கொள்ளுத் தாத்தா',
  great_grandmother:    'கொள்ளுப் பாட்டி',
  uncle_paternal:       'பெரியப்பா/சித்தப்பா',
  aunt_paternal:        'அத்தை',
  uncle_maternal:       'மாமா',
  aunt_maternal:        'சித்தி',
  nephew:               'மருமகன்',
  niece:                'மருமகள்',
  son_in_law:           'மருமகன்',
  daughter_in_law:      'மருமகள்',
  father_in_law:        'மாமனார்',
  mother_in_law:        'மாமியார்',
  brother_in_law:       'மைத்துனன்',
  sister_in_law:        'நாத்தனார்',
  cousin:               'உறவினர்',
  grandson:             'பேரன்',
  granddaughter:        'பேத்தி',
};

// ─────────────────────────────────────────
// Inference chain — A→B + B→C = A→C
// ─────────────────────────────────────────
const INFER = {
  // Parent's parent
  'father→father':               { type: 'grandfather_paternal', tamil: 'தாத்தா (அப்பா பக்கம்)' },
  'father→mother':               { type: 'grandmother_paternal', tamil: 'பாட்டி (அப்பா பக்கம்)'  },
  'mother→father':               { type: 'grandfather_maternal', tamil: 'தாத்தா (அம்மா பக்கம்)' },
  'mother→mother':               { type: 'grandmother_maternal', tamil: 'பாட்டி (அம்மா பக்கம்)'  },

  // Grandparent's parent
  'grandfather_paternal→father': { type: 'great_grandfather', tamil: 'கொள்ளுத் தாத்தா' },
  'grandfather_paternal→mother': { type: 'great_grandmother', tamil: 'கொள்ளுப் பாட்டி'  },
  'grandmother_paternal→father': { type: 'great_grandfather', tamil: 'கொள்ளுத் தாத்தா' },
  'grandmother_paternal→mother': { type: 'great_grandmother', tamil: 'கொள்ளுப் பாட்டி'  },
  'grandfather_maternal→father': { type: 'great_grandfather', tamil: 'கொள்ளுத் தாத்தா' },
  'grandfather_maternal→mother': { type: 'great_grandmother', tamil: 'கொள்ளுப் பாட்டி'  },
  'grandmother_maternal→father': { type: 'great_grandfather', tamil: 'கொள்ளுத் தாத்தா' },
  'grandmother_maternal→mother': { type: 'great_grandmother', tamil: 'கொள்ளுப் பாட்டி'  },

  // Parent's sibling
  'father→brother':              { type: 'uncle_paternal', tamil: 'பெரியப்பா/சித்தப்பா' },
  'father→sister':               { type: 'aunt_paternal',  tamil: 'அத்தை'               },
  'mother→brother':              { type: 'uncle_maternal', tamil: 'மாமா'                },
  'mother→sister':               { type: 'aunt_maternal',  tamil: 'சித்தி'              },

  // Sibling's child
  'brother→son':                 { type: 'nephew', tamil: 'மருமகன்' },
  'brother→daughter':            { type: 'niece',  tamil: 'மருமகள்' },
  'sister→son':                  { type: 'nephew', tamil: 'மருமகன்' },
  'sister→daughter':             { type: 'niece',  tamil: 'மருமகள்' },

  // Child's child
  'son→son':                     { type: 'grandson',      tamil: 'பேரன்'  },
  'son→daughter':                { type: 'granddaughter', tamil: 'பேத்தி' },
  'daughter→son':                { type: 'grandson',      tamil: 'பேரன்'  },
  'daughter→daughter':           { type: 'granddaughter', tamil: 'பேத்தி' },

  // Spouse relations
  'spouse→father':               { type: 'father_in_law',  tamil: 'மாமனார்'    },
  'spouse→mother':               { type: 'mother_in_law',  tamil: 'மாமியார்'   },
  'spouse→brother':              { type: 'brother_in_law', tamil: 'மைத்துனன்'  },
  'spouse→sister':               { type: 'sister_in_law',  tamil: 'நாத்தனார்'  },
  'spouse→son':                  { type: 'son',            tamil: 'மகன்'       },
  'spouse→daughter':             { type: 'daughter',       tamil: 'மகள்'       },

  // Uncle/aunt's child = cousin
  'uncle_paternal→son':          { type: 'cousin', tamil: 'உறவினர் (அண்ணன்/தம்பி)' },
  'uncle_paternal→daughter':     { type: 'cousin', tamil: 'உறவினர் (அக்கா/தங்கை)'  },
  'aunt_paternal→son':           { type: 'cousin', tamil: 'உறவினர் (அண்ணன்/தம்பி)' },
  'aunt_paternal→daughter':      { type: 'cousin', tamil: 'உறவினர் (அக்கா/தங்கை)'  },
  'uncle_maternal→son':          { type: 'cousin', tamil: 'மச்சான்'  },
  'uncle_maternal→daughter':     { type: 'cousin', tamil: 'மச்சினி'  },
  'aunt_maternal→son':           { type: 'cousin', tamil: 'மச்சான்'  },
  'aunt_maternal→daughter':      { type: 'cousin', tamil: 'மச்சினி'  },

  // In-law chains
  'son→spouse':                  { type: 'daughter_in_law', tamil: 'மருமகள்' },
  'daughter→spouse':             { type: 'son_in_law',      tamil: 'மருமகன்' },
  'brother→spouse':              { type: 'sister_in_law',   tamil: 'நாத்தனார்/மைத்துனி' },
  'sister→spouse':               { type: 'brother_in_law',  tamil: 'மைத்துனன்' },
};

// ─────────────────────────────────────────
// Core suggestion engine
// BFS from userId — find all connected users
// For each connected user, infer missing relations
// ─────────────────────────────────────────
async function generateSuggestionsForUser(userId) {
  // Get all this user's verified relations (outgoing)
  const { data: myRels } = await supabase
    .from('pmf_relationships')
    .select('id, relation_type, to_user_id, from_user_id')
    .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
    .eq('verification_status', 'verified')
    .eq('is_offline', false);

  if (!myRels || myRels.length === 0) return;

  // Build my direct relation map: relatedUserId → relation_type
  const myRelMap = new Map(); // userId → { relation_type, via_user_id }

  for (const rel of myRels) {
    if (rel.from_user_id === userId && rel.to_user_id) {
      myRelMap.set(rel.to_user_id, { type: rel.relation_type, via: null });
    } else if (rel.to_user_id === userId && rel.from_user_id) {
      // Reverse — they added me, so my relation to them is reverse
      const REV = {
        son: 'father', daughter: 'mother',
        father: 'son', mother: 'daughter',
        brother: 'brother', sister: 'sister', spouse: 'spouse',
        nephew: 'uncle_paternal', niece: 'aunt_paternal',
        uncle_paternal: 'nephew', aunt_paternal: 'niece',
        uncle_maternal: 'nephew', aunt_maternal: 'niece',
        grandson: 'grandfather_paternal', granddaughter: 'grandmother_paternal',
        grandfather_paternal: 'grandson', grandmother_paternal: 'granddaughter',
        grandfather_maternal: 'grandson', grandmother_maternal: 'granddaughter',
        son_in_law: 'father_in_law', daughter_in_law: 'mother_in_law',
        father_in_law: 'son_in_law', mother_in_law: 'daughter_in_law',
        brother_in_law: 'brother_in_law', sister_in_law: 'sister_in_law',
      };
      const revType = REV[rel.relation_type] || rel.relation_type;
      myRelMap.set(rel.from_user_id, { type: revType, via: null });
    }
  }

  // Get existing suggestions to avoid duplicates
  const { data: existingSuggestions } = await supabase
    .from('pmf_suggestions')
    .select('suggested_user_id, relation_type')
    .eq('for_user_id', userId)
    .in('status', ['pending', 'accepted']);

  const existingSet = new Set(
    (existingSuggestions || []).map(s => `${s.suggested_user_id}:${s.relation_type}`)
  );

  const suggestionsToInsert = [];

  // For each person I know, get their relations
  for (const [knownUserId, myRelToThem] of myRelMap) {
    const { data: theirRels } = await supabase
      .from('pmf_relationships')
      .select('id, relation_type, to_user_id, from_user_id')
      .eq('from_user_id', knownUserId)
      .eq('verification_status', 'verified')
      .eq('is_offline', false);

    for (const theirRel of (theirRels || [])) {
      const targetUserId = theirRel.to_user_id;
      if (!targetUserId) continue;
      if (targetUserId === userId) continue; // skip self
      if (myRelMap.has(targetUserId)) continue; // already know them

      // Infer: my relation to knownUser + knownUser's relation to target
      const chainKey = `${myRelToThem.type}→${theirRel.relation_type}`;
      const inferred = INFER[chainKey];
      if (!inferred) continue;

      const dedupeKey = `${targetUserId}:${inferred.type}`;
      if (existingSet.has(dedupeKey)) continue;

      // Get target user's name
      const { data: targetUser } = await supabase
        .from('pmf_users')
        .select('id, name')
        .eq('id', targetUserId)
        .single();

      if (!targetUser) continue;

      // Get via user's name
      const { data: viaUser } = await supabase
        .from('pmf_users')
        .select('name')
        .eq('id', knownUserId)
        .single();

      suggestionsToInsert.push({
        for_user_id: userId,
        suggested_user_id: targetUserId,
        suggested_name: targetUser.name,
        relation_type: inferred.type,
        relation_tamil: inferred.tamil,
        via_user_id: knownUserId,
        via_relation: myRelToThem.type,
        status: 'pending',
      });

      existingSet.add(dedupeKey);
    }
  }

  // Batch insert — ignore conflicts (UNIQUE constraint handles duplicates)
  if (suggestionsToInsert.length > 0) {
    await supabase
      .from('pmf_suggestions')
      .upsert(suggestionsToInsert, {
        onConflict: 'for_user_id,suggested_user_id,relation_type',
        ignoreDuplicates: true,
      });
  }
}

// ─────────────────────────────────────────
// POST /api/suggestions/generate
// Called after a relationship is verified
// Generates suggestions for both users + their network
// ─────────────────────────────────────────
router.post('/generate', async (req, res) => {
  const { user_id_a, user_id_b } = req.body;
  if (!user_id_a || !user_id_b) {
    return res.status(400).json({ error: 'user_id_a and user_id_b required' });
  }

  try {
    // BFS — find all users connected to either A or B
    const visited = new Set();
    const queue = [user_id_a, user_id_b];

    while (queue.length > 0) {
      const uid = queue.shift();
      if (visited.has(uid)) continue;
      visited.add(uid);

      // Generate suggestions for this user
      await generateSuggestionsForUser(uid);

      // Find their connected users to also regenerate
      const { data: connRels } = await supabase
        .from('pmf_relationships')
        .select('from_user_id, to_user_id')
        .or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`)
        .eq('verification_status', 'verified')
        .eq('is_offline', false);

      for (const r of (connRels || [])) {
        const nextId = r.from_user_id === uid ? r.to_user_id : r.from_user_id;
        if (nextId && !visited.has(nextId)) queue.push(nextId);
      }
    }

    return res.json({ success: true, users_processed: visited.size });
  } catch (err) {
    console.error('Generate suggestions error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /api/suggestions/mine
// Get pending suggestions for current user
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
// Accept a suggestion → creates a pending relationship
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

    // Create the relationship
    const { error: relError } = await supabase
      .from('pmf_relationships')
      .upsert({
        from_user_id: req.user.id,
        to_user_id: suggestion.suggested_user_id,
        relation_type: suggestion.relation_type,
        relation_tamil: suggestion.relation_tamil,
        verification_status: 'pending',
        created_by: req.user.id,
        is_offline: false,
      }, { onConflict: 'from_user_id,to_user_id,relation_type', ignoreDuplicates: true });

    if (relError) throw relError;

    // Mark suggestion as accepted
    await supabase
      .from('pmf_suggestions')
      .update({ status: 'accepted' })
      .eq('id', req.params.id);

    return res.json({ success: true, message: 'உறவு கோரிக்கை அனுப்பப்பட்டது' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// POST /api/suggestions/:id/dismiss
// Dismiss a suggestion
// ─────────────────────────────────────────
router.post('/:id/dismiss', async (req, res) => {
  try {
    await supabase
      .from('pmf_suggestions')
      .update({ status: 'dismissed' })
      .eq('id', req.params.id)
      .eq('for_user_id', req.user.id);

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = { router, generateSuggestionsForUser };
