const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─────────────────────────────────────────
// Inference chain — A→B + B→C = A→C
// ─────────────────────────────────────────
const INFER = {
  'father→father':               { type: 'grandfather_paternal', tamil: 'தாத்தா (அப்பா பக்கம்)' },
  'father→mother':               { type: 'grandmother_paternal', tamil: 'பாட்டி (அப்பா பக்கம்)'  },
  'mother→father':               { type: 'grandfather_maternal', tamil: 'தாத்தா (அம்மா பக்கம்)' },
  'mother→mother':               { type: 'grandmother_maternal', tamil: 'பாட்டி (அம்மா பக்கம்)'  },
  'grandfather_paternal→father': { type: 'great_grandfather',    tamil: 'கொள்ளுத் தாத்தா'        },
  'grandfather_paternal→mother': { type: 'great_grandmother',    tamil: 'கொள்ளுப் பாட்டி'         },
  'grandmother_paternal→father': { type: 'great_grandfather',    tamil: 'கொள்ளுத் தாத்தா'        },
  'grandmother_paternal→mother': { type: 'great_grandmother',    tamil: 'கொள்ளுப் பாட்டி'         },
  'grandfather_maternal→father': { type: 'great_grandfather',    tamil: 'கொள்ளுத் தாத்தா'        },
  'grandfather_maternal→mother': { type: 'great_grandmother',    tamil: 'கொள்ளுப் பாட்டி'         },
  'grandmother_maternal→father': { type: 'great_grandfather',    tamil: 'கொள்ளுத் தாத்தா'        },
  'grandmother_maternal→mother': { type: 'great_grandmother',    tamil: 'கொள்ளுப் பாட்டி'         },
  'father→brother':              { type: 'uncle_paternal',       tamil: 'பெரியப்பா/சித்தப்பா'    },
  'father→sister':               { type: 'aunt_paternal',        tamil: 'அத்தை'                   },
  'mother→brother':              { type: 'uncle_maternal',       tamil: 'மாமா'                    },
  'mother→sister':               { type: 'aunt_maternal',        tamil: 'சித்தி'                  },
  'brother→son':                 { type: 'nephew',               tamil: 'மருமகன்'                 },
  'brother→daughter':            { type: 'niece',                tamil: 'மருமகள்'                 },
  'sister→son':                  { type: 'nephew',               tamil: 'மருமகன்'                 },
  'sister→daughter':             { type: 'niece',                tamil: 'மருமகள்'                 },
  'son→son':                     { type: 'grandson',             tamil: 'பேரன்'                   },
  'son→daughter':                { type: 'granddaughter',        tamil: 'பேத்தி'                  },
  'daughter→son':                { type: 'grandson',             tamil: 'பேரன்'                   },
  'daughter→daughter':           { type: 'granddaughter',        tamil: 'பேத்தி'                  },
  'spouse→father':               { type: 'father_in_law',        tamil: 'மாமனார்'                 },
  'spouse→mother':               { type: 'mother_in_law',        tamil: 'மாமியார்'                },
  'spouse→brother':              { type: 'brother_in_law',       tamil: 'மைத்துனன்'              },
  'spouse→sister':               { type: 'sister_in_law',        tamil: 'நாத்தனார்'               },
  'spouse→son':                  { type: 'son',                  tamil: 'மகன்'                    },
  'spouse→daughter':             { type: 'daughter',             tamil: 'மகள்'                    },
  'uncle_paternal→son':          { type: 'cousin',               tamil: 'உறவினர் (அண்ணன்/தம்பி)' },
  'uncle_paternal→daughter':     { type: 'cousin',               tamil: 'உறவினர் (அக்கா/தங்கை)'  },
  'aunt_paternal→son':           { type: 'cousin',               tamil: 'உறவினர் (அண்ணன்/தம்பி)' },
  'aunt_paternal→daughter':      { type: 'cousin',               tamil: 'உறவினர் (அக்கா/தங்கை)'  },
  'uncle_maternal→son':          { type: 'cousin',               tamil: 'மச்சான்'                 },
  'uncle_maternal→daughter':     { type: 'cousin',               tamil: 'மச்சினி'                 },
  'aunt_maternal→son':           { type: 'cousin',               tamil: 'மச்சான்'                 },
  'aunt_maternal→daughter':      { type: 'cousin',               tamil: 'மச்சினி'                 },
  'son→spouse':                  { type: 'daughter_in_law',      tamil: 'மருமகள்'                 },
  'daughter→spouse':             { type: 'son_in_law',           tamil: 'மருமகன்'                 },
  'brother→spouse':              { type: 'sister_in_law',        tamil: 'நாத்தனார்/மைத்துனி'     },
  'sister→spouse':               { type: 'brother_in_law',       tamil: 'மைத்துனன்'              },
};

const REV_TYPE = {
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

// ─────────────────────────────────────────
// Generate suggestions for a single user
// ─────────────────────────────────────────
async function generateSuggestionsForUser(userId) {
  if (!userId) return;

  const { data: myRels } = await supabase
    .from('pmf_relationships')
    .select('id, relation_type, to_user_id, from_user_id')
    .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
    .eq('verification_status', 'verified')
    .eq('is_offline', false);

  if (!myRels || myRels.length === 0) return;

  // Build my direct relation map
  const myRelMap = new Map();
  for (const rel of myRels) {
    if (rel.from_user_id === userId && rel.to_user_id) {
      myRelMap.set(rel.to_user_id, { type: rel.relation_type });
    } else if (rel.to_user_id === userId && rel.from_user_id) {
      const revType = REV_TYPE[rel.relation_type] || rel.relation_type;
      myRelMap.set(rel.from_user_id, { type: revType });
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
      if (targetUserId === userId) continue;
      if (myRelMap.has(targetUserId)) continue;

      const chainKey = `${myRelToThem.type}→${theirRel.relation_type}`;
      const inferred = INFER[chainKey];
      if (!inferred) continue;

      const dedupeKey = `${targetUserId}:${inferred.type}`;
      if (existingSet.has(dedupeKey)) continue;

      const { data: targetUser } = await supabase
        .from('pmf_users').select('id, name').eq('id', targetUserId).single();
      if (!targetUser) continue;

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
// Generate suggestions for entire network
// BFS from two seed users outward
// ─────────────────────────────────────────
async function generateSuggestionsForNetwork(userIdA, userIdB) {
  const visited = new Set();
  const queue = [userIdA, userIdB].filter(Boolean);

  while (queue.length > 0) {
    const uid = queue.shift();
    if (visited.has(uid)) continue;
    visited.add(uid);

    await generateSuggestionsForUser(uid);

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
}

module.exports = { generateSuggestionsForUser, generateSuggestionsForNetwork };
