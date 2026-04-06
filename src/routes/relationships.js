const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const authMiddleware = require('../middleware/auth');
const { sendEmail, sendTelegram } = require('../services/notifications');
const { generateSuggestionsForUser } = require('../services/suggestionEngine');

router.use(authMiddleware);

// ─────────────────────────────────────────
// Reverse relation mapping
// ─────────────────────────────────────────
function getReverseRelation(relation_type, fromUserGender) {
  // fromUserGender = gender of the person who ADDED the relationship
  // This function answers: what is the FROM person to the TO person?

  // Parent-child reversal
  if (relation_type === 'son' || relation_type === 'daughter') {
    // FROM person is a parent → reverse is father or mother
    if (fromUserGender === 'female') return { type: 'mother', tamil: 'அம்மா' };
    return { type: 'father', tamil: 'அப்பா' };
  }

  // Child-parent reversal
  if (relation_type === 'father' || relation_type === 'mother') {
    // FROM person is a child → reverse is son or daughter based on FROM person's gender
    if (fromUserGender === 'female') return { type: 'daughter', tamil: 'மகள்' };
    return { type: 'son', tamil: 'மகன்' };
  }

  // Sibling reversal — depends on FROM person's gender
  if (relation_type === 'brother' || relation_type === 'sister') {
    // Niranjan (male) added Kavitha as sister
    // → Kavitha's view: Niranjan is her brother
    // FROM person is male → reverse is brother
    // FROM person is female → reverse is sister
    if (fromUserGender === 'female') return { type: 'sister',  tamil: 'அக்கா/தங்கை'   };
    return { type: 'brother', tamil: 'அண்ணன்/தம்பி' };
  }

  if (relation_type === 'spouse') return { type: 'spouse', tamil: 'மனைவி/கணவன்' };
  return { type: relation_type, tamil: relation_type };
}

// ─────────────────────────────────────────
// Helper — find user by phone
// ─────────────────────────────────────────
async function findUserByPhone(rawPhone) {
  const digits = rawPhone.replace(/\D/g, '');
  const { data: allUsers, error } = await supabase.from('pmf_users').select('*');
  if (error) return null;
  return allUsers?.find(u => {
    const stored = (u.phone || '').replace(/\D/g, '');
    return stored === digits || stored.endsWith(digits) || digits.endsWith(stored);
  }) || null;
}

// ─────────────────────────────────────────
// POST /api/relationships
// ─────────────────────────────────────────
router.post('/', async (req, res) => {
  const { to_user_phone, relation_type, relation_tamil,
          is_offline, offline_name, offline_gender, offline_user_id } = req.body;

  if (!relation_type) {
    return res.status(400).json({ error: 'relation_type is required' });
  }

  // ── OFFLINE / DECEASED MEMBER FLOW ──
  if (is_offline) {
    if (!offline_name && !offline_user_id) {
      return res.status(400).json({ error: 'offline_name is required for offline members' });
    }

    const { data: fromUser } = await supabase
      .from('pmf_users').select('id, name, phone, gender').eq('id', req.user.id).single();

    // Determine the offline_user_id to link to
    let resolvedOfflineUserId = offline_user_id || null;
    let resolvedName = offline_name || null;
    let resolvedGender = offline_gender || 'other';

    if (resolvedOfflineUserId && !resolvedName) {
      // Fetch name and gender from existing pmf_offline_users record
      const { data: existingUser } = await supabase
        .from('pmf_offline_users')
        .select('name, gender')
        .eq('id', resolvedOfflineUserId)
        .single();
      if (existingUser) {
        resolvedName = existingUser.name;
        resolvedGender = existingUser.gender || 'other';
      }
    }

    if (!resolvedOfflineUserId) {
      // No existing user confirmed — create new pmf_offline_users record
      const { data: newOfflineUser, error: ouError } = await supabase
        .from('pmf_offline_users')
        .insert({
          name: resolvedName.trim(),
          gender: resolvedGender,
          added_by: req.user.id,
        })
        .select().single();

      if (ouError) {
        console.error('Create offline user error:', ouError);
        return res.status(500).json({ error: 'Failed to create offline user: ' + ouError.message });
      }
      resolvedOfflineUserId = newOfflineUser.id;
    }

    // Create the relationship linked to pmf_offline_users
    const { data: relationship, error: createError } = await supabase
      .from('pmf_relationships')
      .insert({
        from_user_id: req.user.id,
        to_user_id: null,
        relation_type,
        relation_tamil,
        verification_status: 'verified',
        created_by: req.user.id,
        is_offline: true,
        offline_name: resolvedName,
        offline_gender: resolvedGender,
        offline_user_id: resolvedOfflineUserId,
      })
      .select().single();

    if (createError) {
      console.error('Offline relationship error:', createError);
      return res.status(500).json({ error: 'Failed to create offline relationship: ' + createError.message });
    }

    return res.json({
      success: true, relationship, offline: true,
      message: `${resolvedName} குடும்ப மரத்தில் சேர்க்கப்பட்டார்`
    });
  }

  // ── ONLINE MEMBER FLOW ──
  if (!to_user_phone) {
    return res.status(400).json({ error: 'to_user_phone is required' });
  }

  const toUser = await findUserByPhone(to_user_phone);

  if (!toUser) {
    const digits = to_user_phone.replace(/\D/g, '');
    await supabase.from('pmf_pending_invites')
      .delete().eq('from_user_id', req.user.id).eq('to_phone', digits);

    await supabase.from('pmf_pending_invites').insert({
      from_user_id: req.user.id, to_phone: digits,
      relation_type, relation_tamil, status: 'pending'
    });

    return res.status(404).json({
      error: 'No user found with that phone number. They need to register on frootze first.',
      invite_saved: true
    });
  }

  if (toUser.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot add yourself' });
  }

  const { data: existing } = await supabase
    .from('pmf_relationships')
    .select('id, verification_status')
    .or(`and(from_user_id.eq.${req.user.id},to_user_id.eq.${toUser.id}),and(from_user_id.eq.${toUser.id},to_user_id.eq.${req.user.id})`)
    .single();

  if (existing) {
    return res.status(400).json({
      error: existing.verification_status === 'verified'
        ? 'இந்த உறவு ஏற்கனவே உள்ளது / Relationship already exists'
        : 'கோரிக்கை ஏற்கனவே அனுப்பப்பட்டது / Request already sent'
    });
  }

  const { data: fromUser } = await supabase
    .from('pmf_users').select('id, name, phone, gender').eq('id', req.user.id).single();

  const { data: relationship, error: createError } = await supabase
    .from('pmf_relationships')
    .insert({
      from_user_id: req.user.id, to_user_id: toUser.id,
      relation_type, relation_tamil,
      verification_status: 'pending',
      created_by: req.user.id, is_offline: false
    })
    .select().single();

  if (createError) {
    console.error('Create relationship error:', createError);
    return res.status(500).json({ error: 'Failed to create relationship' });
  }

  const { data: message } = await supabase.from('pmf_messages').insert({
    from_user_id: req.user.id,
    message_type: 'personal',
    subject: '🌳 குடும்ப இணைப்பு கோரிக்கை / Family Connection Request',
    content: `${fromUser?.name} உங்களை தங்கள் ${relation_tamil} ஆக சேர்க்க கோருகிறார். frootze Dashboard-ல் ஏற்கவும் அல்லது நிராகரிக்கவும்.\n\n${fromUser?.name} has sent you a family connection request as ${relation_tamil}. Please accept or reject from your Dashboard.`
  }).select().single();

  if (message) {
    await supabase.from('pmf_message_recipients').insert({
      message_id: message.id, to_user_id: toUser.id, is_read: false
    });
  }

  const notifResults = { email: false, telegram: false };
  if (toUser.email) {
    const r = await sendEmail({ to_email: toUser.email, from_name: fromUser?.name, relation_tamil, type: 'request' });
    notifResults.email = r.success;
  }

  const digitsOnly = to_user_phone.replace(/\D/g, '').replace(/^91/, '');
  const waMsg = [
    `🌳 *frootze — குடும்ப இணைப்பு கோரிக்கை!*`,
    ``,
    `*${fromUser?.name}* உங்களை frootze குடும்ப மரத்தில் *${relation_tamil}* ஆக சேர்க்க கோரிக்கை அனுப்பியுள்ளார்.`,
    ``,
    `✅ ஏற்க உங்கள் Dashboard திறக்கவும்:`,
    `🔗 *https://frootze.com*`,
    ``,
    `_frootze — உங்கள் குடும்பம், உங்கள் வேர்கள்_ 🌳`
  ].join('\n');

  return res.json({
    success: true, relationship, notifications: notifResults,
    whatsapp_link: `https://wa.me/91${digitsOnly}?text=${encodeURIComponent(waMsg)}`
  });
});

// ─────────────────────────────────────────
// GET /api/relationships/mine
// Now includes kutham for color coding
// ─────────────────────────────────────────
router.get('/mine', async (req, res) => {

  // Get current user's kutham for reference
  const { data: currentUser } = await supabase
    .from('pmf_users')
    .select('id, name, gender, kutham')
    .eq('id', req.user.id)
    .single();

  const { data: outgoing } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil, verification_status, created_at,
      is_offline, offline_name, offline_gender,
      to_user:to_user_id(id, name, phone, kutham),
      from_user:from_user_id(id, gender, kutham)`)
    .eq('from_user_id', req.user.id)
    .order('created_at', { ascending: false });

  const { data: incoming } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil, verification_status, created_at,
      is_offline, offline_name, offline_gender,
      to_user:from_user_id(id, name, phone, kutham),
      from_user:from_user_id(id, gender, kutham)`)
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'verified')
    .order('created_at', { ascending: false });

  const { data: pendingMyAction } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil, verification_status,
      to_user:from_user_id(id, name, phone)`)
    .eq('to_user_id', req.user.id)
    .eq('verification_status', 'pending');

  const outgoingVerified = (outgoing || [])
    .filter(r => r.verification_status === 'verified')
    .map(r => ({
      ...r,
      to_user: r.is_offline
        ? { id: `offline-${r.id}`, name: r.offline_name, phone: null,
            is_offline: true, offline_gender: r.offline_gender, kutham: null }
        : r.to_user
    }));

  const incomingVerified = (incoming || []).map(r => {
    const reversed = getReverseRelation(r.relation_type, r.from_user?.gender);
    return { ...r, relation_type: reversed.type, relation_tamil: reversed.tamil };
  });

  const allVerified = [...outgoingVerified, ...incomingVerified];

  return res.json({
    success: true,
    my_relationships: allVerified,
    pending_verification: pendingMyAction || [],
    current_user_kutham: currentUser?.kutham || null,
    summary: {
      total_verified: allVerified.length,
      pending_sent: (outgoing || []).filter(r => r.verification_status === 'pending').length,
      pending_my_action: (pendingMyAction || []).length
    }
  });
});

// ─────────────────────────────────────────
// POST /api/relationships/verify
// ─────────────────────────────────────────
router.post('/verify', async (req, res) => {
  const { relationship_id } = req.body;

  const { data: rel } = await supabase
    .from('pmf_relationships')
    .select('*, from_user:from_user_id(id, name, email)')
    .eq('id', relationship_id)
    .eq('to_user_id', req.user.id)
    .single();

  if (!rel) return res.status(404).json({ error: 'Request not found' });

  await supabase.from('pmf_relationships')
    .update({ verification_status: 'verified', verified_at: new Date().toISOString() })
    .eq('id', relationship_id);

  const { data: acceptor } = await supabase
    .from('pmf_users').select('name').eq('id', req.user.id).single();

  // Trigger suggestion generation for both users after verification
  try {
    await generateSuggestionsForUser(req.user.id);
    await generateSuggestionsForUser(rel.from_user?.id);
  } catch (e) {
    console.error('Suggestion generation error (non-fatal):', e.message);
  }

  if (rel.from_user?.email) {
    await sendEmail({
      to_email: rel.from_user.email, from_name: acceptor?.name,
      relation_tamil: rel.relation_tamil, type: 'accepted'
    });
  }

  return res.json({ success: true, message: 'உறவு சரிபார்க்கப்பட்டது / Relationship verified' });
});

// ─────────────────────────────────────────
// POST /api/relationships/reject
// ─────────────────────────────────────────
router.post('/reject', async (req, res) => {
  const { relationship_id } = req.body;
  await supabase.from('pmf_relationships')
    .update({ verification_status: 'rejected' })
    .eq('id', relationship_id)
    .eq('to_user_id', req.user.id);
  return res.json({ success: true, message: 'நிராகரிக்கப்பட்டது / Rejected' });
});

// ─────────────────────────────────────────
// GET /api/relationships/tree/:user_id
// Extended family tree — 4 generations above, 2 below
// Includes offline/deceased members added by relatives
// ─────────────────────────────────────────
router.get('/tree/:user_id', async (req, res) => {
  const rootId = req.params.user_id;

  // Generation from ROOT's perspective for each relation type
  const GEN_FROM_ROOT = {
    // Root's direct relations
    great_grandfather: 3, great_grandmother: 3,
    grandfather_paternal: 2, grandmother_paternal: 2,
    grandfather_maternal: 2, grandmother_maternal: 2,
    father: 1, mother: 1,
    father_in_law: 1, mother_in_law: 1,
    uncle_paternal: 1, uncle_maternal: 1, uncle_elder: 1, uncle_younger: 1,
    aunt_paternal: 1, aunt_maternal: 1, aunt_by_marriage: 1,
    brother: 0, sister: 0, spouse: 0,
    brother_in_law: 0, sister_in_law: 0, co_brother: 0, cousin: 0,
    son: -1, daughter: -1,
    son_in_law: -1, daughter_in_law: -1,
    nephew: -1, niece: -1, stepson: -1, stepdaughter: -1,
    grandson: -2, granddaughter: -2,
  };

  // For nodes reached through intermediaries (gen offset from intermediary)
  const GEN_DELTA = {
    father: 1, mother: 1,
    grandfather_paternal: 2, grandmother_paternal: 2,
    grandfather_maternal: 2, grandmother_maternal: 2,
    great_grandfather: 3, great_grandmother: 3,
    son: -1, daughter: -1,
    grandson: -2, granddaughter: -2,
    spouse: 0, brother: 0, sister: 0,
    father_in_law: 1, mother_in_law: 1,
    brother_in_law: 0, sister_in_law: 0,
    son_in_law: -1, daughter_in_law: -1,
    nephew: -1, niece: -1,
    uncle_paternal: 1, aunt_paternal: 1,
    uncle_maternal: 1, aunt_maternal: 1,
  };

  const RECURSE = new Set(['father','mother','son','daughter',
    'grandfather_paternal','grandmother_paternal',
    'grandfather_maternal','grandmother_maternal',
    'great_grandfather','great_grandmother',
    'grandson','granddaughter']);

  // nodeMap: id → {id, name, kutham, relation_type, relation_tamil, generation, is_offline}
  const nodeMap = new Map();
  const visited = new Set([rootId]); // root is always visited, never added as node

  // Step 1: Get ALL root's direct relationships (both outgoing and incoming)
  const { data: directOut } = await supabase
    .from('pmf_relationships')
    .select('id, relation_type, relation_tamil, is_offline, offline_name, offline_gender, to_user_id')
    .eq('from_user_id', rootId)
    .eq('verification_status', 'verified');

  const { data: directIn } = await supabase
    .from('pmf_relationships')
    .select('id, relation_type, relation_tamil, from_user_id')
    .eq('to_user_id', rootId)
    .eq('verification_status', 'verified')
    .eq('is_offline', false);

  // Map of userId → generation for direct relations
  const directGenMap = new Map();

  // Tamil label map — always use these instead of DB stored values
  const DIRECT_TAMIL = {
    father: 'அப்பா', mother: 'அம்மா',
    son: 'மகன்', daughter: 'மகள்',
    brother: 'அண்ணன்/தம்பி', sister: 'அக்கா/தங்கை',
    spouse: 'மனைவி/கணவன்',
    grandfather_paternal: 'தாத்தா (அப்பா பக்கம்)', grandmother_paternal: 'பாட்டி (அப்பா பக்கம்)',
    grandfather_maternal: 'தாத்தா (அம்மா பக்கம்)', grandmother_maternal: 'பாட்டி (அம்மா பக்கம்)',
    grandson: 'பேரன்', granddaughter: 'பேத்தி',
    nephew: 'மருமகன்', niece: 'மருமகள்',
    uncle_paternal: 'பெரியப்பா/சித்தப்பா', aunt_paternal: 'அத்தை',
    uncle_maternal: 'மாமா', aunt_maternal: 'சித்தி',
    son_in_law: 'மருமகன்', daughter_in_law: 'மருமகள்',
    father_in_law: 'மாமனார்', mother_in_law: 'மாமியார்',
    brother_in_law: 'மைத்துனன்', sister_in_law: 'நாத்தனார்',
    cousin: 'உறவினர்',
    great_grandfather: 'கொள்ளுத்தாத்தா', great_grandmother: 'கொள்ளுப்பாட்டி',
  };

  // Process outgoing direct relations
  for (const rel of (directOut || [])) {
    const gen = GEN_FROM_ROOT[rel.relation_type] ?? 0;
    if (gen < -2 || gen > 3) continue;

    if (rel.is_offline) {
      const nodeId = `offline-root-${(rel.offline_name||'').replace(/\s/g,'-').toLowerCase()}`;
      nodeMap.set(nodeId, {
        id: nodeId, name: rel.offline_name, kutham: null,
        relation_type: rel.relation_type, relation_tamil: rel.relation_tamil,
        generation: gen, is_offline: true, offline_gender: rel.offline_gender,
      });
    } else if (rel.to_user_id) {
      directGenMap.set(rel.to_user_id, gen);
      if (!nodeMap.has(rel.to_user_id)) {
        const { data: u } = await supabase.from('pmf_users').select('id, name, kutham').eq('id', rel.to_user_id).single();
        if (u) nodeMap.set(u.id, { id: u.id, name: u.name, kutham: u.kutham,
          relation_type: rel.relation_type,
          relation_tamil: DIRECT_TAMIL[rel.relation_type] || rel.relation_tamil,
          generation: gen, is_offline: false, relationship_id: rel.id });
      }
      visited.add(rel.to_user_id);
    }
  }

  // Process incoming direct relations (others added root)
  // e.g. Mani added Niranjan as 'son' → Mani is Niranjan's 'father' (gen+1)
  const REV_TYPE = {
    son: 'father', daughter: 'mother',
    father: 'son', mother: 'daughter',
    brother: 'brother', sister: 'sister', spouse: 'spouse',
    grandson: 'grandfather_paternal', granddaughter: 'grandmother_paternal',
    grandfather_paternal: 'grandson', grandmother_paternal: 'granddaughter',
    grandfather_maternal: 'grandson', grandmother_maternal: 'granddaughter',
    nephew: 'uncle_paternal', niece: 'aunt_paternal',
    uncle_paternal: 'nephew', aunt_paternal: 'niece',
    uncle_maternal: 'nephew', aunt_maternal: 'niece',
    father_in_law: 'son_in_law', mother_in_law: 'daughter_in_law',
    son_in_law: 'father_in_law', daughter_in_law: 'mother_in_law',
    brother_in_law: 'brother_in_law', sister_in_law: 'sister_in_law',
  };

  for (const rel of (directIn || [])) {
    if (!rel.from_user_id) continue;
    const revType = REV_TYPE[rel.relation_type] || rel.relation_type;
    const gen = GEN_FROM_ROOT[revType] ?? 0;
    if (gen < -2 || gen > 3) continue;

    if (!directGenMap.has(rel.from_user_id)) {
      directGenMap.set(rel.from_user_id, gen);
    }
    if (!nodeMap.has(rel.from_user_id)) {
      const { data: u } = await supabase
        .from('pmf_users').select('id, name, kutham, gender').eq('id', rel.from_user_id).single();
      if (u) {
        // Gender-aware reversal for parent→child relations
        let finalType = revType;
        if (rel.relation_type === 'father' || rel.relation_type === 'mother') {
          finalType = u.gender === 'female' ? 'daughter' : 'son';
        } else if (rel.relation_type === 'brother' || rel.relation_type === 'sister') {
          finalType = u.gender === 'female' ? 'sister' : 'brother';
        } else if (rel.relation_type === 'grandfather_paternal' || rel.relation_type === 'grandfather_maternal') {
          finalType = u.gender === 'female' ? 'granddaughter' : 'grandson';
        } else if (rel.relation_type === 'grandmother_paternal' || rel.relation_type === 'grandmother_maternal') {
          finalType = u.gender === 'female' ? 'granddaughter' : 'grandson';
        }
        const finalTamil = DIRECT_TAMIL[finalType] || finalType;
        nodeMap.set(u.id, { id: u.id, name: u.name, kutham: u.kutham,
          relation_type: finalType, relation_tamil: finalTamil,
          generation: gen, is_offline: false, relationship_id: rel.id });
        visited.add(rel.from_user_id);
      }
    }
  }

  // Step 2: Recurse into ALL gen-1 nodes to get gen 2, 3
  // This includes mother, father, in-laws — so their parents (gen 2) appear
  for (const [userId, baseGen] of directGenMap) {
    if (Math.abs(baseGen) < 1) continue; // only recurse into non-current gen

    // Get the root's relation type to this intermediary (for label inference)
    const intermediaryNode = nodeMap.get(userId);
    const rootToIntermediary = intermediaryNode?.relation_type;

    const { data: subRels } = await supabase
      .from('pmf_relationships')
      .select('id, relation_type, relation_tamil, is_offline, offline_name, offline_gender, to_user_id')
      .eq('from_user_id', userId)
      .eq('verification_status', 'verified');

    for (const rel of (subRels || [])) {
      const delta  = GEN_DELTA[rel.relation_type] ?? 0;
      const nextGen = baseGen + delta;
      if (nextGen < -2 || nextGen > 3) continue;
      if (nextGen === 0) continue; // skip current gen via traversal (avoid re-adding root's peers)

      // Infer correct Tamil label from root's perspective
      const inferredLabel = rootToIntermediary
        ? getExtendedLabel(rootToIntermediary, rel.relation_type)
        : { type: rel.relation_type, tamil: rel.relation_tamil };

      if (rel.is_offline) {
        const nodeId = `offline-${userId}-${(rel.offline_name||'').replace(/\s/g,'-').toLowerCase()}`;
        if (!nodeMap.has(nodeId)) {
          nodeMap.set(nodeId, {
            id: nodeId, name: rel.offline_name, kutham: null,
            relation_type: inferredLabel.type, relation_tamil: inferredLabel.tamil,
            generation: nextGen, is_offline: true, offline_gender: rel.offline_gender,
          });
        }
      } else if (rel.to_user_id && !visited.has(rel.to_user_id)) {
        visited.add(rel.to_user_id);
        if (!nodeMap.has(rel.to_user_id)) {
          const { data: u } = await supabase.from('pmf_users').select('id, name, kutham').eq('id', rel.to_user_id).single();
          if (u) {
            nodeMap.set(u.id, { id: u.id, name: u.name, kutham: u.kutham,
              relation_type: inferredLabel.type, relation_tamil: inferredLabel.tamil,
              generation: nextGen, is_offline: false, relationship_id: rel.id });
          }
        }
      }
    }
  }

  // Step 3: Recurse one more level for gen-1 nodes to find gen-2 nodes
  // Use nodeMap.has() to prevent duplicates — single source of truth
  const step2Nodes = Array.from(nodeMap.values()).filter(n => 
    Math.abs(n.generation) === 1 && !n.is_offline
  );
  for (const node of step2Nodes) {
    if (visited.has(node.id)) continue; // already traversed
    visited.add(node.id);

    const { data: subRels } = await supabase
      .from('pmf_relationships')
      .select('id, relation_type, relation_tamil, is_offline, offline_name, offline_gender, to_user_id')
      .eq('from_user_id', node.id)
      .eq('verification_status', 'verified');

    for (const rel of (subRels || [])) {
      const delta   = GEN_DELTA[rel.relation_type] ?? 0;
      const nextGen = node.generation + delta;
      if (nextGen < -2 || nextGen > 3) continue;
      if (nextGen === 0) continue; // skip current gen
      if (visited.has(rel.to_user_id)) continue; // strict dedup

      // Infer correct Tamil label from root's perspective
      const inferredLabel = node.relation_type
        ? getExtendedLabel(node.relation_type, rel.relation_type)
        : { type: rel.relation_type, tamil: rel.relation_tamil };

      if (rel.is_offline) {
        const nodeId = `offline-${node.id}-${(rel.offline_name||'').replace(/\s/g,'-').toLowerCase()}`;
        if (!nodeMap.has(nodeId)) {
          nodeMap.set(nodeId, {
            id: nodeId, name: rel.offline_name, kutham: null,
            relation_type: inferredLabel.type, relation_tamil: inferredLabel.tamil,
            generation: nextGen, is_offline: true, offline_gender: rel.offline_gender,
          });
        }
      } else if (rel.to_user_id && rel.to_user_id !== rootId && !nodeMap.has(rel.to_user_id)) {
        visited.add(rel.to_user_id);
        const { data: u } = await supabase.from('pmf_users').select('id, name, kutham').eq('id', rel.to_user_id).single();
        if (u) {
          nodeMap.set(u.id, { id: u.id, name: u.name, kutham: u.kutham,
            relation_type: inferredLabel.type, relation_tamil: inferredLabel.tamil,
            generation: nextGen, is_offline: false, relationship_id: rel.id });
        }
      }
    }
  }

  return res.json({ success: true, nodes: Array.from(nodeMap.values()), root_id: rootId });
});


// ─────────────────────────────────────────
// Extended label resolver
// Given root→intermediate relation and intermediate→target relation,
// returns the correct label for root→target
// ─────────────────────────────────────────
function getExtendedLabel(rootToMid, midToTarget) {
  const DIRECT = {
    father:               { type: 'father',               tamil: 'அப்பா'                    },
    mother:               { type: 'mother',               tamil: 'அம்மா'                    },
    son:                  { type: 'son',                  tamil: 'மகன்'                     },
    daughter:             { type: 'daughter',             tamil: 'மகள்'                     },
    brother:              { type: 'brother',              tamil: 'அண்ணன்/தம்பி'            },
    sister:               { type: 'sister',               tamil: 'அக்கா/தங்கை'             },
    spouse:               { type: 'spouse',               tamil: 'மனைவி/கணவன்'             },
    grandfather_paternal: { type: 'grandfather_paternal', tamil: 'தாத்தா (அப்பா பக்கம்)'  },
    grandmother_paternal: { type: 'grandmother_paternal', tamil: 'பாட்டி (அப்பா பக்கம்)'  },
    grandfather_maternal: { type: 'grandfather_maternal', tamil: 'தாத்தா (அம்மா பக்கம்)'  },
    grandmother_maternal: { type: 'grandmother_maternal', tamil: 'பாட்டி (அம்மா பக்கம்)'  },
    grandson:             { type: 'grandson',             tamil: 'பேரன்'                    },
    granddaughter:        { type: 'granddaughter',        tamil: 'பேத்தி'                   },
    nephew:               { type: 'nephew',               tamil: 'மருமகன்'                  },
    niece:                { type: 'niece',                tamil: 'மருமகள்'                  },
    uncle_paternal:       { type: 'uncle_paternal',       tamil: 'பெரியப்பா/சித்தப்பா'     },
    uncle_maternal:       { type: 'uncle_maternal',       tamil: 'மாமா'                     },
    aunt_paternal:        { type: 'aunt_paternal',        tamil: 'அத்தை'                    },
    aunt_maternal:        { type: 'aunt_maternal',        tamil: 'சித்தி'                   },
    son_in_law:           { type: 'son_in_law',           tamil: 'மருமகன்'                  },
    daughter_in_law:      { type: 'daughter_in_law',      tamil: 'மருமகள்'                  },
    father_in_law:        { type: 'father_in_law',        tamil: 'மாமனார்'                  },
    mother_in_law:        { type: 'mother_in_law',        tamil: 'மாமியார்'                 },
    brother_in_law:       { type: 'brother_in_law',       tamil: 'மைத்துனன்'               },
    sister_in_law:        { type: 'sister_in_law',        tamil: 'நாத்தனார்'                },
    cousin:               { type: 'cousin',               tamil: 'உறவினர்'                  },
  };

  // Direct relation (root is the from_user) — no intermediary
  if (!rootToMid) {
    return DIRECT[midToTarget] || { type: midToTarget, tamil: midToTarget };
  }

  // Extended chain resolution
  const chain = `${rootToMid}→${midToTarget}`;
  const EXTENDED = {
    // Parent → their parent = grandparent of root
    'father→father':    { type: 'grandfather_paternal', tamil: 'தாத்தா (அப்பா பக்கம்)' },
    'father→mother':    { type: 'grandmother_paternal', tamil: 'பாட்டி (அப்பா பக்கம்)'  },
    'mother→father':    { type: 'grandfather_maternal', tamil: 'தாத்தா (அம்மா பக்கம்)' },
    'mother→mother':    { type: 'grandmother_maternal', tamil: 'பாட்டி (அம்மா பக்கம்)'  },

    // Parent → their grandparent = great-grandparent of root
    'father→grandfather_paternal': { type: 'great_grandfather', tamil: 'கொள்ளுத்தாத்தா' },
    'father→grandmother_paternal': { type: 'great_grandmother', tamil: 'கொள்ளுப்பாட்டி' },
    'father→grandfather_maternal': { type: 'great_grandfather', tamil: 'கொள்ளுத்தாத்தா' },
    'father→grandmother_maternal': { type: 'great_grandmother', tamil: 'கொள்ளுப்பாட்டி' },
    'mother→grandfather_paternal': { type: 'great_grandfather', tamil: 'கொள்ளுத்தாத்தா' },
    'mother→grandmother_paternal': { type: 'great_grandmother', tamil: 'கொள்ளுப்பாட்டி' },
    'mother→grandfather_maternal': { type: 'great_grandfather', tamil: 'கொள்ளுத்தாத்தா' },
    'mother→grandmother_maternal': { type: 'great_grandmother', tamil: 'கொள்ளுப்பாட்டி' },

    // Grandparent → their parent = great-grandparent of root
    'grandfather_paternal→father': { type: 'great_grandfather', tamil: 'கொள்ளுத்தாத்தா' },
    'grandfather_paternal→mother': { type: 'great_grandmother', tamil: 'கொள்ளுப்பாட்டி' },
    'grandmother_paternal→father': { type: 'great_grandfather', tamil: 'கொள்ளுத்தாத்தா' },
    'grandmother_paternal→mother': { type: 'great_grandmother', tamil: 'கொள்ளுப்பாட்டி' },
    'grandfather_maternal→father': { type: 'great_grandfather', tamil: 'கொள்ளுத்தாத்தா' },
    'grandfather_maternal→mother': { type: 'great_grandmother', tamil: 'கொள்ளுப்பாட்டி' },
    'grandmother_maternal→father': { type: 'great_grandfather', tamil: 'கொள்ளுத்தாத்தா' },
    'grandmother_maternal→mother': { type: 'great_grandmother', tamil: 'கொள்ளுப்பாட்டி' },

    // Grandparent → their grandparent = great-great-grandparent of root
    'grandfather_paternal→grandfather_paternal': { type: 'great_great_grandfather', tamil: 'கொள்ளுத்தாத்தா' },
    'grandfather_paternal→grandmother_paternal': { type: 'great_great_grandmother', tamil: 'கொள்ளுப்பாட்டி'  },
    'grandmother_paternal→grandfather_paternal': { type: 'great_great_grandfather', tamil: 'கொள்ளுத்தாத்தா' },
    'grandmother_paternal→grandmother_paternal': { type: 'great_great_grandmother', tamil: 'கொள்ளுப்பாட்டி'  },

    // Children chain
    'son→son':          { type: 'grandson',      tamil: 'பேரன்'  },
    'son→daughter':     { type: 'granddaughter', tamil: 'பேத்தி' },
    'daughter→son':     { type: 'grandson',      tamil: 'பேரன்'  },
    'daughter→daughter':{ type: 'granddaughter', tamil: 'பேத்தி' },

    // Child's nephew/niece = grandchild (niece/nephew stored from child's sibling perspective)
    'son→nephew':       { type: 'grandson',      tamil: 'பேரன்'  },
    'son→niece':        { type: 'granddaughter', tamil: 'பேத்தி' },
    'daughter→nephew':  { type: 'grandson',      tamil: 'பேரன்'  },
    'daughter→niece':   { type: 'granddaughter', tamil: 'பேத்தி' },

    // Child's spouse = son/daughter in law
    'son→spouse':       { type: 'daughter_in_law', tamil: 'மருமகள்' },
    'daughter→spouse':  { type: 'son_in_law',      tamil: 'மருமகன்' },

    // Child's grandparent relations (stored outgoing from child)
    'son→grandmother_maternal':      { type: 'grandmother_maternal', tamil: 'பாட்டி (அம்மா பக்கம்)'  },
    'son→grandfather_maternal':      { type: 'grandfather_maternal', tamil: 'தாத்தா (அம்மா பக்கம்)' },
    'son→grandmother_paternal':      { type: 'grandmother_paternal', tamil: 'பாட்டி (அப்பா பக்கம்)'  },
    'son→grandfather_paternal':      { type: 'grandfather_paternal', tamil: 'தாத்தா (அப்பா பக்கம்)' },
    'daughter→grandmother_maternal': { type: 'grandmother_maternal', tamil: 'பாட்டி (அம்மா பக்கம்)'  },
    'daughter→grandfather_maternal': { type: 'grandfather_maternal', tamil: 'தாத்தா (அம்மா பக்கம்)' },
    'daughter→grandmother_paternal': { type: 'grandmother_paternal', tamil: 'பாட்டி (அப்பா பக்கம்)'  },
    'daughter→grandfather_paternal': { type: 'grandfather_paternal', tamil: 'தாத்தா (அப்பா பக்கம்)' },

    // Uncle/Aunt
    'father→brother':   { type: 'uncle_elder',   tamil: 'பெரியப்பா/சித்தப்பா' },
    'father→sister':    { type: 'aunt_paternal',  tamil: 'அத்தை'                },
    'mother→brother':   { type: 'uncle_maternal', tamil: 'மாமா'                 },
    'mother→sister':    { type: 'aunt_maternal',  tamil: 'சித்தி'               },

    // Sibling's child = nephew/niece
    'brother→son':      { type: 'nephew', tamil: 'மருமகன்' },
    'brother→daughter': { type: 'niece',  tamil: 'மருமகள்' },
    'sister→son':       { type: 'nephew', tamil: 'மருமகன்' },
    'sister→daughter':  { type: 'niece',  tamil: 'மருமகள்' },

    // Spouse chains
    'spouse→father':    { type: 'father_in_law',  tamil: 'மாமனார்'   },
    'spouse→mother':    { type: 'mother_in_law',  tamil: 'மாமியார்'  },
    'spouse→brother':   { type: 'brother_in_law', tamil: 'மைத்துனன்' },
    'spouse→sister':    { type: 'sister_in_law',  tamil: 'நாத்தனார்' },
    'spouse→son':       { type: 'son',            tamil: 'மகன்'      },
    'spouse→daughter':  { type: 'daughter',       tamil: 'மகள்'      },
  };

  return EXTENDED[chain] || DIRECT[midToTarget] || { type: midToTarget, tamil: midToTarget };
}

// ─────────────────────────────────────────
// GET /api/relationships/chain-detect
// Detects connection chain between current user and a target phone
// Query: ?to_phone=9943125881
// ─────────────────────────────────────────
router.get('/chain-detect', async (req, res) => {
  const { to_phone } = req.query;
  const fromUserId = req.user.id;

  if (!to_phone) return res.status(400).json({ error: 'to_phone is required' });

  // Step 1: Find target user by phone
  const targetUser = await findUserByPhone(to_phone);
  if (!targetUser) return res.json({ success: true, target_found: false, message: 'User not registered on frootze' });
  if (targetUser.id === fromUserId) return res.json({ success: true, target_found: false, message: 'Cannot add yourself' });

  // Step 2: Get current user's full tree (2 levels deep)
  const { data: fromUser } = await supabase.from('pmf_users').select('id, name, gender, kutham').eq('id', fromUserId).single();

  // Step 3: Get all of current user's verified relationships (level 1)
  const { data: level1Rels } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil, is_offline,
      to_user:to_user_id(id, name, phone, gender, kutham)`)
    .eq('from_user_id', fromUserId)
    .eq('verification_status', 'verified')
    .eq('is_offline', false);

  const { data: level1Incoming } = await supabase
    .from('pmf_relationships')
    .select(`id, relation_type, relation_tamil,
      from_user:from_user_id(id, name, phone, gender, kutham)`)
    .eq('to_user_id', fromUserId)
    .eq('verification_status', 'verified');

  // Build level 1 connections map: userId → { user, relationType, relTamil }
  const level1Map = new Map();

  for (const r of (level1Rels || [])) {
    if (r.to_user) {
      level1Map.set(r.to_user.id, { user: r.to_user, rel_type: r.relation_type, rel_tamil: r.relation_tamil });
    }
  }
  for (const r of (level1Incoming || [])) {
    if (r.from_user && !level1Map.has(r.from_user.id)) {
      const rev = getReverseRelation(r.relation_type, r.from_user.gender);
      level1Map.set(r.from_user.id, { user: r.from_user, rel_type: rev.type, rel_tamil: rev.tamil });
    }
  }

  // Step 4: Check if target is directly in level 1
  if (level1Map.has(targetUser.id)) {
    const direct = level1Map.get(targetUser.id);
    return res.json({
      success: true,
      target_found: true,
      already_connected: true,
      chain: [
        { user: { id: fromUser.id, name: fromUser.name }, relation_to_next: null, connected: true },
        { user: { id: targetUser.id, name: targetUser.name }, relation_to_next: direct.rel_type, rel_tamil: direct.rel_tamil, connected: true }
      ],
      suggested_relation: null,
      message: 'Already connected directly'
    });
  }

  // Step 5: Check level 2 — for each level1 person, get their relationships
  for (const [midId, midData] of level1Map) {
    const { data: level2Rels } = await supabase
      .from('pmf_relationships')
      .select(`id, relation_type, relation_tamil, is_offline,
        to_user:to_user_id(id, name, phone, gender, kutham)`)
      .eq('from_user_id', midId)
      .eq('verification_status', 'verified')
      .eq('is_offline', false);

    const { data: level2Incoming } = await supabase
      .from('pmf_relationships')
      .select(`id, relation_type, relation_tamil,
        from_user:from_user_id(id, name, phone, gender, kutham)`)
      .eq('to_user_id', midId)
      .eq('verification_status', 'verified');

    // Check if target is in level2 outgoing
    for (const r of (level2Rels || [])) {
      if (r.to_user && r.to_user.id === targetUser.id) {
        const suggested = inferRelation(midData.rel_type, r.relation_type);
        return res.json({
          success: true,
          target_found: true,
          already_connected: false,
          chain: [
            { user: { id: fromUser.id, name: fromUser.name }, relation_to_next: midData.rel_type, rel_tamil: midData.rel_tamil, connected: true },
            { user: { id: midData.user.id, name: midData.user.name }, relation_to_next: r.relation_type, rel_tamil: r.relation_tamil, connected: true },
            { user: { id: targetUser.id, name: targetUser.name }, relation_to_next: null, connected: false }
          ],
          suggested_relation: suggested,
          intermediaries_missing: []
        });
      }
    }

    // Check level2 incoming
    for (const r of (level2Incoming || [])) {
      if (r.from_user && r.from_user.id === targetUser.id) {
        const rev = getReverseRelation(r.relation_type, r.from_user.gender);
        const suggested = inferRelation(midData.rel_type, rev.type);
        return res.json({
          success: true,
          target_found: true,
          already_connected: false,
          chain: [
            { user: { id: fromUser.id, name: fromUser.name }, relation_to_next: midData.rel_type, rel_tamil: midData.rel_tamil, connected: true },
            { user: { id: midData.user.id, name: midData.user.name }, relation_to_next: rev.type, rel_tamil: rev.tamil, connected: true },
            { user: { id: targetUser.id, name: targetUser.name }, relation_to_next: null, connected: false }
          ],
          suggested_relation: suggested,
          intermediaries_missing: []
        });
      }
    }
  }

  // Step 5b: Check level 3 via SPOUSE of level2 connections
  // e.g. Sri Janani → Kavitha(sister) → Niranjan(brother) → Tamil Selvi(spouse)
  for (const [midId, midData] of level1Map) {
    const { data: level2All } = await supabase
      .from('pmf_relationships')
      .select('id, relation_type, relation_tamil, to_user:to_user_id(id, name, phone, gender, kutham)')
      .eq('from_user_id', midId)
      .eq('verification_status', 'verified')
      .eq('is_offline', false);

    for (const r2 of (level2All || [])) {
      if (!r2.to_user || r2.to_user.id === fromUserId) continue;
      const mid2Id = r2.to_user.id;
      const mid2Rel = inferRelation(midData.rel_type, r2.relation_type);

      // Now check mid2's relationships for target
      const { data: level3Rels } = await supabase
        .from('pmf_relationships')
        .select('id, relation_type, relation_tamil, to_user:to_user_id(id, name, phone, gender, kutham)')
        .eq('from_user_id', mid2Id)
        .eq('verification_status', 'verified')
        .eq('is_offline', false);

      for (const r3 of (level3Rels || [])) {
        if (r3.to_user && r3.to_user.id === targetUser.id) {
          const suggested = inferRelation(mid2Rel.type, r3.relation_type);
          return res.json({
            success: true,
            target_found: true,
            already_connected: false,
            chain: [
              { user: { id: fromUser.id, name: fromUser.name }, relation_to_next: midData.rel_type, rel_tamil: midData.rel_tamil, connected: true },
              { user: { id: midData.user.id, name: midData.user.name }, relation_to_next: mid2Rel.type, rel_tamil: mid2Rel.tamil, connected: true },
              { user: { id: r2.to_user.id, name: r2.to_user.name }, relation_to_next: r3.relation_type, rel_tamil: r3.relation_tamil, connected: true },
              { user: { id: targetUser.id, name: targetUser.name }, relation_to_next: null, connected: false }
            ],
            suggested_relation: suggested,
            intermediaries_missing: []
          });
        }
      }

      // Check level3 incoming
      const { data: level3Inc } = await supabase
        .from('pmf_relationships')
        .select('id, relation_type, relation_tamil, from_user:from_user_id(id, name, phone, gender, kutham)')
        .eq('to_user_id', mid2Id)
        .eq('verification_status', 'verified');

      for (const r3 of (level3Inc || [])) {
        if (r3.from_user && r3.from_user.id === targetUser.id) {
          const rev3 = getReverseRelation(r3.relation_type, r3.from_user.gender);
          const suggested = inferRelation(mid2Rel.type, rev3.type);
          return res.json({
            success: true,
            target_found: true,
            already_connected: false,
            chain: [
              { user: { id: fromUser.id, name: fromUser.name }, relation_to_next: midData.rel_type, rel_tamil: midData.rel_tamil, connected: true },
              { user: { id: midData.user.id, name: midData.user.name }, relation_to_next: mid2Rel.type, rel_tamil: mid2Rel.tamil, connected: true },
              { user: { id: r2.to_user.id, name: r2.to_user.name }, relation_to_next: rev3.type, rel_tamil: rev3.tamil, connected: true },
              { user: { id: targetUser.id, name: targetUser.name }, relation_to_next: null, connected: false }
            ],
            suggested_relation: suggested,
            intermediaries_missing: []
          });
        }
      }
    }
  }

  // Step 6: No chain found — return target user only
  return res.json({
    success: true,
    target_found: true,
    already_connected: false,
    chain: null,
    suggested_relation: null,
    message: 'No family connection found within 2 levels'
  });
});

// ─────────────────────────────────────────
// Relation inference: given chain A→B and B→C, return A→C label
// ─────────────────────────────────────────
function inferRelation(aToB, bToC) {
  const INFER = {
    // Sibling's children = nephew/niece
    'brother→son':        { type: 'nephew',   tamil: 'மருமகன்'              },
    'brother→daughter':   { type: 'niece',    tamil: 'மருமகள்'              },
    'sister→son':         { type: 'nephew',   tamil: 'மருமகன்'              },
    'sister→daughter':    { type: 'niece',    tamil: 'மருமகள்'              },

    // Parent's sibling = uncle/aunt
    'father→brother':     { type: 'uncle_paternal', tamil: 'பெரியப்பா/சித்தப்பா' },
    'father→sister':      { type: 'aunt_paternal',  tamil: 'அத்தை'               },
    'mother→brother':     { type: 'uncle_maternal', tamil: 'மாமா'                },
    'mother→sister':      { type: 'aunt_maternal',  tamil: 'சித்தி'              },

    // Parent's parent = grandparent
    'father→father':      { type: 'grandfather_paternal', tamil: 'தாத்தா (அப்பா பக்கம்)' },
    'father→mother':      { type: 'grandmother_paternal', tamil: 'பாட்டி (அப்பா பக்கம்)'  },
    'mother→father':      { type: 'grandfather_maternal', tamil: 'தாத்தா (அம்மா பக்கம்)' },
    'mother→mother':      { type: 'grandmother_maternal', tamil: 'பாட்டி (அம்மா பக்கம்)'  },

    // Child's child = grandchild
    'son→son':            { type: 'grandson',      tamil: 'பேரன்'   },
    'son→daughter':       { type: 'granddaughter', tamil: 'பேத்தி'  },
    'daughter→son':       { type: 'grandson',      tamil: 'பேரன்'   },
    'daughter→daughter':  { type: 'granddaughter', tamil: 'பேத்தி'  },

    // Spouse's parents = in-laws
    'spouse→father':      { type: 'father_in_law',    tamil: 'மாமனார்'     },
    'spouse→mother':      { type: 'mother_in_law',    tamil: 'மாமியார்'    },
    'spouse→brother':     { type: 'brother_in_law',   tamil: 'மைத்துனன்'  },
    'spouse→sister':      { type: 'sister_in_law',    tamil: 'நாத்தனார்'   },

    // Via uncle/aunt by blood → their spouse
    // e.g. Niranjan (uncle) → Tamil Selvi (his wife) = aunt by marriage for Sri Janani
    'uncle_paternal→spouse':  { type: 'aunt_by_marriage',   tamil: 'அத்தை (திருமண உறவு)' },
    'uncle_maternal→spouse':  { type: 'aunt_by_marriage',   tamil: 'மாமி'                 },
    'aunt_paternal→spouse':   { type: 'uncle_by_marriage',  tamil: 'மாமா (திருமண உறவு)'  },
    'aunt_maternal→spouse':   { type: 'uncle_by_marriage',  tamil: 'மாமா (திருமண உறவு)'  },

    // Via nephew/niece chain → their parent's spouse
    'nephew→spouse':      { type: 'aunt_by_marriage',   tamil: 'மாமி'     },
    'niece→spouse':       { type: 'aunt_by_marriage',   tamil: 'மாமி'     },

    // Reverse: spouse's nephew/niece = nephew/niece by marriage
    'spouse→nephew':      { type: 'nephew_by_marriage', tamil: 'மருமகன் (திருமண உறவு)' },
    'spouse→niece':       { type: 'niece_by_marriage',  tamil: 'மருமகள் (திருமண உறவு)' },
    'spouse→son':         { type: 'stepson',             tamil: 'மகன் (மணவுறவு)'        },
    'spouse→daughter':    { type: 'stepdaughter',        tamil: 'மகள் (மணவுறவு)'        },

    // Brother's wife / Sister's husband
    'brother→spouse':     { type: 'sister_in_law',      tamil: 'மைத்துனி / நாத்தனார்'  },
    'sister→spouse':      { type: 'brother_in_law',     tamil: 'மைத்துனன்'              },

    // Children → their spouse = son/daughter in law
    'son→spouse':         { type: 'daughter_in_law',    tamil: 'மருமகள்'  },
    'daughter→spouse':    { type: 'son_in_law',         tamil: 'மருமகன்'  },

    // Uncle/aunt's child = cousin
    'uncle_paternal→son':      { type: 'cousin', tamil: 'உறவினர் (அண்ணன்/தம்பி)' },
    'uncle_paternal→daughter': { type: 'cousin', tamil: 'உறவினர் (அக்கா/தங்கை)' },
    'aunt_paternal→son':       { type: 'cousin', tamil: 'உறவினர் (அண்ணன்/தம்பி)' },
    'aunt_paternal→daughter':  { type: 'cousin', tamil: 'உறவினர் (அக்கா/தங்கை)' },
    'uncle_maternal→son':      { type: 'cousin', tamil: 'மச்சான்'   },
    'uncle_maternal→daughter': { type: 'cousin', tamil: 'மச்சினி'   },
    'aunt_maternal→son':       { type: 'cousin', tamil: 'மச்சான்'   },
    'aunt_maternal→daughter':  { type: 'cousin', tamil: 'மச்சினி'   },
  };

  const key = `${aToB}→${bToC}`;
  return INFER[key] || { type: bToC, tamil: bToC, inferred: false };
}


// ─────────────────────────────────────────
// GET /api/relationships/network/:user_id
// Full network graph — BFS traversal of all connections
// OUTGOING ONLY — no reverse logic, no derived relations
// Returns nodes + edges for visualization
// Max depth: 15 levels, visited set prevents loops
// ─────────────────────────────────────────
router.get('/network/:user_id', async (req, res) => {
  const rootId = req.params.user_id;
  const visited = new Set();
  const nodeMap = new Map(); // id → node object
  const edges   = [];        // { from, to, relation_type, relation_tamil, verified }
  const queue   = [rootId];  // BFS queue
  let depth     = 0;
  const MAX_DEPTH = 15;

  // Fetch root user details
  const { data: rootUser } = await supabase
    .from('pmf_users')
    .select('id, name, kutham, gender, profile_photo, date_of_birth')
    .eq('id', rootId)
    .single();

  if (!rootUser) return res.status(404).json({ error: 'User not found' });

  nodeMap.set(rootId, {
    id: rootId,
    name: rootUser.name,
    kutham: rootUser.kutham,
    gender: rootUser.gender,
    profile_photo: rootUser.profile_photo,
    is_root: true,
    is_offline: false,
  });

  // BFS — level by level
  while (queue.length > 0 && depth < MAX_DEPTH) {
    const levelSize = queue.length;
    depth++;

    for (let i = 0; i < levelSize; i++) {
      const userId = queue.shift();
      if (visited.has(userId)) continue;
      visited.add(userId);

      // Fetch outgoing verified relationships
      const { data: outgoing } = await supabase
        .from('pmf_relationships')
        .select(`
          id, relation_type, relation_tamil, verification_status,
          is_offline, offline_name, offline_gender,
          to_user:to_user_id(id, name, kutham, gender, profile_photo)
        `)
        .eq('from_user_id', userId)
        .in('verification_status', ['verified', 'pending']);

      for (const rel of (outgoing || [])) {
        const verified = rel.verification_status === 'verified';

        if (rel.is_offline) {
          // Offline/deceased node
          const offlineId = `offline-${rel.id}`;
          if (!nodeMap.has(offlineId)) {
            nodeMap.set(offlineId, {
              id: offlineId,
              name: rel.offline_name,
              kutham: null,
              gender: rel.offline_gender,
              profile_photo: null,
              is_offline: true,
              is_root: false,
            });
          }
          edges.push({
            from: userId,
            to: offlineId,
            relation_type: rel.relation_type,
            relation_tamil: rel.relation_tamil,
            verified,
          });
        } else if (rel.to_user) {
          const toId = rel.to_user.id;
          if (!nodeMap.has(toId)) {
            nodeMap.set(toId, {
              id: toId,
              name: rel.to_user.name,
              kutham: rel.to_user.kutham,
              gender: rel.to_user.gender,
              profile_photo: rel.to_user.profile_photo,
              is_offline: false,
              is_root: false,
            });
          }
          edges.push({
            from: userId,
            to: toId,
            relation_type: rel.relation_type,
            relation_tamil: rel.relation_tamil,
            verified,
          });
          // Add to queue if not visited
          if (!visited.has(toId)) queue.push(toId);
        }
      }

    }
  }

  // Deduplicate edges (A→B and B→A may both exist)
  const edgeSet = new Set();
  const uniqueEdges = edges.filter(e => {
    const key1 = `${e.from}-${e.to}-${e.relation_type}`;
    if (edgeSet.has(key1)) return false;
    edgeSet.add(key1);
    return true;
  });

  return res.json({
    success: true,
    root_id: rootId,
    nodes: Array.from(nodeMap.values()),
    edges: uniqueEdges,
    depth_reached: depth,
  });
});


// ─────────────────────────────────────────
// PUT /api/relationships/:id
// Edit an existing relationship type
// Only the creator (from_user_id) can edit
// ─────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { relation_type } = req.body;

  if (!relation_type) {
    return res.status(400).json({ error: 'relation_type is required' });
  }

  const tamilMap = {
    father: 'அப்பா',
    mother: 'அம்மா',
    son: 'மகன்',
    daughter: 'மகள்',
    brother: 'அண்ணன்/தம்பி',
    sister: 'அக்கா/தங்கை',
    spouse: 'கணவன்/மனைவி',
    grandfather_paternal: 'தாத்தா (அப்பா பக்கம்)',
    grandmother_paternal: 'பாட்டி (அப்பா பக்கம்)',
    grandfather_maternal: 'தாத்தா (அம்மா பக்கம்)',
    grandmother_maternal: 'பாட்டி (அம்மா பக்கம்)',
    uncle_paternal: 'பெரியப்பா/சித்தப்பா',
    aunt_paternal: 'அத்தை',
    uncle_maternal: 'மாமா',
    aunt_maternal: 'சித்தி',
    nephew: 'மருமகன்',
    niece: 'மருமகள்',
    son_in_law: 'மருமகன்',
    daughter_in_law: 'மருமகள்',
    father_in_law: 'மாமனார்',
    mother_in_law: 'மாமியார்',
    brother_in_law: 'மைத்துனன்',
    sister_in_law: 'நாத்தனார்',
    cousin: 'உறவினர்',
    grandson: 'பேரன்',
    granddaughter: 'பேத்தி',
  };

  const relation_tamil = tamilMap[relation_type] || relation_type;

  try {
    // Verify this relationship exists and current user is one of the parties
    const { data: existing } = await supabase
      .from('pmf_relationships')
      .select('id, from_user_id, to_user_id')
      .eq('id', id)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Relationship not found' });
    }

    const isParty =
      existing.from_user_id === req.user.id ||
      existing.to_user_id === req.user.id;

    if (!isParty) {
      return res.status(403).json({ error: 'You can only edit relationships you are part of' });
    }

    const { data, error } = await supabase
      .from('pmf_relationships')
      .update({ relation_type, relation_tamil })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      relationship: data,
      message: 'உறவு புதுப்பிக்கப்பட்டது / Relationship updated'
    });
  } catch (err) {
    console.error('Edit relationship error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /api/relationships/linked-chain/:user_id
// குடும்ப வலைதளம் — Family LinkedIn
// Returns direct relations only (9 types: blood line + spouse)
// No inference — exactly as stored in DB
// Used for progressive expand-on-click chain view
// ─────────────────────────────────────────

const LINKEDIN_RELATIONS = new Set([
  'father', 'mother',
  'son', 'daughter',
  'brother', 'sister',
  'spouse',
]);

const LINKEDIN_TAMIL = {
  father:   'அப்பா',
  mother:   'அம்மா',
  son:      'மகன்',
  daughter: 'மகள்',
  brother:  'அண்ணன்/தம்பி',
  sister:   'அக்கா/தங்கை',
  spouse:   'கணவன்/மனைவி',
};

router.get('/linked-chain/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    // Get the user's own profile
    const { data: rootUser } = await supabase
      .from('pmf_users')
      .select('id, name, gender, kutham, profile_photo, date_of_birth')
      .eq('id', user_id)
      .single();

    if (!rootUser) return res.status(404).json({ error: 'User not found' });

    // Get outgoing verified relations (user added them)
    const { data: outgoing } = await supabase
      .from('pmf_relationships')
      .select(`
        id, relation_type, relation_tamil, verification_status,
        to_user:to_user_id(id, name, gender, kutham, profile_photo, date_of_birth)
      `)
      .eq('from_user_id', user_id)
      .eq('verification_status', 'verified')
      .eq('is_offline', false);

    // Get incoming verified relations (they added user)
    const { data: incoming } = await supabase
      .from('pmf_relationships')
      .select(`
        id, relation_type, relation_tamil, verification_status,
        from_user:from_user_id(id, name, gender, kutham, profile_photo, date_of_birth)
      `)
      .eq('to_user_id', user_id)
      .eq('verification_status', 'verified')
      .eq('is_offline', false);

    const relations = [];
    const seenUserIds = new Set();

    // Process outgoing — use stored relation_type as-is
    for (const rel of (outgoing || [])) {
      if (!rel.to_user) continue;
      if (!LINKEDIN_RELATIONS.has(rel.relation_type)) continue;
      if (seenUserIds.has(rel.to_user.id)) continue;
      seenUserIds.add(rel.to_user.id);

      relations.push({
        relationship_id: rel.id,
        relation_type: rel.relation_type,
        relation_tamil: LINKEDIN_TAMIL[rel.relation_type] || rel.relation_tamil,
        user: rel.to_user,
      });
    }

    // Process incoming — reverse the relation type
    const REV = {
      son: 'father', daughter: 'mother',
      father: 'son', mother: 'daughter',
      brother: 'brother', sister: 'sister',
      spouse: 'spouse',
    };

    for (const rel of (incoming || [])) {
      if (!rel.from_user) continue;
      if (!LINKEDIN_RELATIONS.has(rel.relation_type)) continue;
      if (seenUserIds.has(rel.from_user.id)) continue;

      // Gender-aware reversal
      let revType = REV[rel.relation_type] || rel.relation_type;
      const gender = rel.from_user.gender;
      if (rel.relation_type === 'father' || rel.relation_type === 'mother') {
        revType = gender === 'female' ? 'daughter' : 'son';
      } else if (rel.relation_type === 'son' || rel.relation_type === 'daughter') {
        revType = gender === 'female' ? 'mother' : 'father';
      } else if (rel.relation_type === 'brother' || rel.relation_type === 'sister') {
        revType = gender === 'female' ? 'sister' : 'brother';
      }

      if (!LINKEDIN_RELATIONS.has(revType)) continue;
      seenUserIds.add(rel.from_user.id);

      relations.push({
        relationship_id: rel.id,
        relation_type: revType,
        relation_tamil: LINKEDIN_TAMIL[revType] || revType,
        user: rel.from_user,
      });
    }

    return res.json({
      success: true,
      user: rootUser,
      relations,
      has_more: relations.length > 0,
    });

  } catch (err) {
    console.error('Linked chain error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /api/relationships/linkedin-tree/:user_id
// குடும்ப வலைதளம் — Complete tree in one API call
// BFS traversal — backend owns all logic
// Returns { nodes[], edges[] } — frontend is pure renderer
//
// DATA MAPS — single source of truth
// To add a new relation: add to REL_GEN only. Nothing else changes.
// ─────────────────────────────────────────

const LINKEDIN_REL_GEN = {
  great_grandfather:    3,
  great_grandmother:    3,
  grandfather_paternal: 2,
  grandmother_paternal: 2,
  grandfather_maternal: 2,
  grandmother_maternal: 2,
  father:               1,
  mother:               1,
  uncle_paternal:       1,
  uncle_maternal:       1,
  aunt_paternal:        1,
  aunt_maternal:        1,
  father_in_law:        1,
  mother_in_law:        1,
  brother:              0,
  sister:               0,
  spouse:               0,
  brother_in_law:       0,
  sister_in_law:        0,
  son:                 -1,
  daughter:            -1,
  nephew:              -1,
  niece:               -1,
  son_in_law:          -1,
  daughter_in_law:     -1,
  grandson:            -2,
  granddaughter:       -2,
};

const LINKEDIN_TAMIL_MAP = {
  great_grandfather:    'கொள்ளுத்தாத்தா',
  great_grandmother:    'கொள்ளுப்பாட்டி',
  grandfather_paternal: 'தாத்தா (அப்பா பக்கம்)',
  grandmother_paternal: 'பாட்டி (அப்பா பக்கம்)',
  grandfather_maternal: 'தாத்தா (அம்மா பக்கம்)',
  grandmother_maternal: 'பாட்டி (அம்மா பக்கம்)',
  father:               'அப்பா',
  mother:               'அம்மா',
  uncle_paternal:       'பெரியப்பா/சித்தப்பா',
  uncle_maternal:       'மாமா',
  aunt_paternal:        'அத்தை',
  aunt_maternal:        'சித்தி',
  father_in_law:        'மாமனார்',
  mother_in_law:        'மாமியார்',
  brother:              'அண்ணன்/தம்பி',
  sister:               'அக்கா/தங்கை',
  spouse:               'கணவன்/மனைவி',
  brother_in_law:       'மைத்துனன்',
  sister_in_law:        'நாத்தனார்',
  son:                  'மகன்',
  daughter:             'மகள்',
  nephew:               'மருமகன்',
  niece:                'மருமகள்',
  son_in_law:           'மருமகன்',
  daughter_in_law:      'மருமகள்',
  grandson:             'பேரன்',
  granddaughter:        'பேத்தி',
};

// Reverse relation map — for incoming relations
const LINKEDIN_REV_MAP = {
  son:              'father',
  daughter:         'mother',
  father:           'son',
  mother:           'daughter',
  brother:          'brother',
  sister:           'sister',
  spouse:           'spouse',
  nephew:           'uncle_paternal',
  niece:            'aunt_paternal',
  uncle_paternal:   'nephew',
  aunt_paternal:    'niece',
  uncle_maternal:   'nephew',
  aunt_maternal:    'niece',
  grandson:         'grandfather_paternal',
  granddaughter:    'grandmother_paternal',
  grandfather_paternal: 'grandson',
  grandmother_paternal: 'granddaughter',
  grandfather_maternal: 'grandson',
  grandmother_maternal: 'granddaughter',
  son_in_law:       'father_in_law',
  daughter_in_law:  'mother_in_law',
  father_in_law:    'son_in_law',
  mother_in_law:    'daughter_in_law',
  brother_in_law:   'brother_in_law',
  sister_in_law:    'sister_in_law',
  great_grandfather: 'great_grandson',
  great_grandmother: 'great_granddaughter',
};

router.get('/linkedin-tree/:user_id', async (req, res) => {
  const rootId = req.params.user_id;
  const MAX_GEN = parseInt(req.query.maxGen) || 3;  // configurable depth
  const MIN_GEN = parseInt(req.query.minGen) || -2; // configurable depth

  try {
    // Get root user
    const { data: rootUser } = await supabase
      .from('pmf_users')
      .select('id, name, gender, kutham, profile_photo, date_of_birth')
      .eq('id', rootId)
      .single();

    if (!rootUser) return res.status(404).json({ error: 'User not found' });

    // BFS state
    const seen   = new Set([rootId]); // tracks nodes added to results
    const queued = new Set([rootId]); // tracks nodes added to queue — prevents duplicate processing
    const queue  = [{ userId: rootId, generation: 0 }];
    const userGenMap = new Map([[rootId, 0]]);

    // Result containers
    const nodes = [{
      id: rootId,
      name: rootUser.name,
      gender: rootUser.gender,
      kutham: rootUser.kutham,
      profile_photo: rootUser.profile_photo,
      date_of_birth: rootUser.date_of_birth,
      is_offline: false,
      generation: 0,
      relation_type: null,
      relation_tamil: null,
      verified: true,
      is_root: true,
    }];

    const edges = [];

    // BFS loop — no hardcoded levels, driven entirely by data maps
    while (queue.length > 0) {
      const { userId, generation } = queue.shift();

      // Fetch outgoing verified relations
      const { data: outgoing } = await supabase
        .from('pmf_relationships')
        .select(`
          id, relation_type, relation_tamil, verification_status,
          is_offline, offline_name, offline_gender, offline_user_id,
          offline_user:offline_user_id(id, name, gender, kutham),
          to_user:to_user_id(id, name, gender, kutham, profile_photo, date_of_birth)
        `)
        .eq('from_user_id', userId)
        .eq('verification_status', 'verified');

      // Fetch incoming verified relations
      const { data: incoming } = await supabase
        .from('pmf_relationships')
        .select(`
          id, relation_type, relation_tamil, verification_status,
          from_user:from_user_id(id, name, gender, kutham, profile_photo, date_of_birth)
        `)
        .eq('to_user_id', userId)
        .eq('verification_status', 'verified')
        .eq('is_offline', false);

      // Process outgoing relations
      for (const rel of (outgoing || [])) {
        // Look up generation offset from data map — no hardcoding
        const genOffset = LINKEDIN_REL_GEN[rel.relation_type];
        if (genOffset === undefined) continue; // unknown relation — skip cleanly

        // Calculate absolute generation from root
        const targetGen = generation + genOffset;

        // Boundary check — driven by config parameters, not hardcoded
        if (targetGen > MAX_GEN || targetGen < MIN_GEN) continue;

        if (rel.is_offline) {
          // Use offline_user_id as the unique key — proper dedup by UUID
          const offlineUser = rel.offline_user;
          const offlineId = rel.offline_user_id || `offline-${rel.id}`;
          if (seen.has(offlineId)) continue;
          seen.add(offlineId);
          nodes.push({
            id: offlineId,
            name: offlineUser?.name || rel.offline_name,
            gender: offlineUser?.gender || rel.offline_gender,
            kutham: offlineUser?.kutham || null,
            profile_photo: null,
            date_of_birth: null,
            is_offline: true,
            generation: targetGen,
            relation_type: rel.relation_type,
            relation_tamil: LINKEDIN_TAMIL_MAP[rel.relation_type] || rel.relation_tamil,
            verified: true,
            is_root: false,
          });
          edges.push({
            from_id: userId,
            to_id: offlineId,
            relation_type: rel.relation_type,
            relation_tamil: LINKEDIN_TAMIL_MAP[rel.relation_type] || rel.relation_tamil,
            verified: true,
            generation_from: generation,
            generation_to: targetGen,
          });
          continue;
        }

        if (!rel.to_user) continue;
        const targetId = rel.to_user.id;
        if (seen.has(targetId)) continue;
        seen.add(targetId);
        userGenMap.set(targetId, targetGen);

        nodes.push({
          id: targetId,
          name: rel.to_user.name,
          gender: rel.to_user.gender,
          kutham: rel.to_user.kutham,
          profile_photo: rel.to_user.profile_photo,
          date_of_birth: rel.to_user.date_of_birth,
          is_offline: false,
          generation: targetGen,
          relation_type: rel.relation_type,
          relation_tamil: LINKEDIN_TAMIL_MAP[rel.relation_type] || rel.relation_tamil,
          verified: true,
          is_root: false,
        });

        edges.push({
          from_id: userId,
          to_id: targetId,
          relation_type: rel.relation_type,
          relation_tamil: LINKEDIN_TAMIL_MAP[rel.relation_type] || rel.relation_tamil,
          verified: true,
          generation_from: generation,
          generation_to: targetGen,
        });

        // Continue BFS only if within bounds and not already queued
        if (targetGen > MIN_GEN && targetGen < MAX_GEN && !queued.has(targetId)) {
          queued.add(targetId);
          queue.push({ userId: targetId, generation: targetGen });
        }
      }

      // Process incoming relations — reverse them
      for (const rel of (incoming || [])) {
        if (!rel.from_user) continue;

        // Reverse the relation type using data map — no hardcoding
        const revType = LINKEDIN_REV_MAP[rel.relation_type];
        if (!revType) continue;

        const genOffset = LINKEDIN_REL_GEN[revType];
        if (genOffset === undefined) continue;

        const targetGen = generation + genOffset;
        if (targetGen > MAX_GEN || targetGen < MIN_GEN) continue;

        const targetId = rel.from_user.id;
        if (seen.has(targetId)) continue;
        seen.add(targetId);
        userGenMap.set(targetId, targetGen);

        // Gender-aware reversal for son/daughter
        let finalType = revType;
        const gender = rel.from_user.gender;
        if (rel.relation_type === 'father' || rel.relation_type === 'mother') {
          finalType = gender === 'female' ? 'daughter' : 'son';
        } else if (rel.relation_type === 'son' || rel.relation_type === 'daughter') {
          finalType = gender === 'female' ? 'mother' : 'father';
        } else if (rel.relation_type === 'brother' || rel.relation_type === 'sister') {
          finalType = gender === 'female' ? 'sister' : 'brother';
        }

        nodes.push({
          id: targetId,
          name: rel.from_user.name,
          gender: rel.from_user.gender,
          kutham: rel.from_user.kutham,
          profile_photo: rel.from_user.profile_photo,
          date_of_birth: rel.from_user.date_of_birth,
          is_offline: false,
          generation: targetGen,
          relation_type: finalType,
          relation_tamil: LINKEDIN_TAMIL_MAP[finalType] || finalType,
          verified: rel.verification_status === 'verified',
          is_root: false,
        });

        edges.push({
          from_id: targetId,
          to_id: userId,
          relation_type: rel.relation_type,
          relation_tamil: LINKEDIN_TAMIL_MAP[rel.relation_type] || rel.relation_tamil,
          verified: rel.verification_status === 'verified',
          generation_from: targetGen,
          generation_to: generation,
        });

        if (targetGen > MIN_GEN && targetGen < MAX_GEN && !queued.has(targetId)) {
          queued.add(targetId);
          queue.push({ userId: targetId, generation: targetGen });
        }
      }
    }

    // ── Option 2: Split cross-generation edges ──────────────────────────
    // Problem: An edge from generation 0 → generation 2 (e.g. Current → Past Gen 2)
    //          has its label placed at the midpoint of the line.
    //          That midpoint falls exactly on top of the Past Gen 1 row nodes,
    //          hiding the label completely behind intermediate node cards.
    //
    // Fix: Any edge that skips more than 1 generation is broken into
    //      sequential hops through intermediate nodes that already exist
    //      in the nodes array.
    //
    // Example:
    //   Tamil Selvi (gen 0) → Pappammal (gen 2)   [skips gen 1]
    //   Becomes:
    //   Tamil Selvi (gen 0) → Mani N (gen 1)       [label: மகன்/மகள்]
    //   Mani N (gen 1)      → Pappammal (gen 2)    [label: அப்பா/அம்மா]
    //
    // Each short hop stays entirely within its own V_GAP — label never
    // overlaps any node card.
    //
    // How intermediary nodes are found:
    //   Build a map of generation → list of nodes in that generation.
    //   For a skipping edge from gen A to gen B, find a node in gen A+step
    //   that is already in the nodes array (already part of the family tree).
    //   Chain through each intermediate generation until reaching the target.
    // ────────────────────────────────────────────────────────────────────

    const finalEdges = splitCrossGenEdges(edges, nodes);

    return res.json({
      success: true,
      root_id: rootId,
      nodes,
      edges: finalEdges,
      config: { max_gen: MAX_GEN, min_gen: MIN_GEN },
    });

  } catch (err) {
    console.error('LinkedIn tree error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// splitCrossGenEdges
// Breaks edges that skip generations into sequential hops.
// Each hop goes exactly 1 generation — label always lands in the
// V_GAP between rows, never behind a node card.
//
// Input:  edges[]  — raw edges from BFS (may skip generations)
//         nodes[]  — all nodes in the tree (used to find intermediaries)
// Output: edges[]  — all edges span exactly 1 generation
// ─────────────────────────────────────────
function splitCrossGenEdges(edges, nodes) {
  // Build generation → node list map for fast lookup
  const genNodeMap = {};
  for (const node of nodes) {
    const g = node.generation;
    if (!genNodeMap[g]) genNodeMap[g] = [];
    genNodeMap[g].push(node);
  }

  // Build id → node map for fast lookup
  const nodeById = {};
  for (const node of nodes) {
    nodeById[node.id] = node;
  }

  const result = [];

  for (const edge of edges) {
    const genFrom = edge.generation_from;
    const genTo   = edge.generation_to;
    const diff    = Math.abs(genTo - genFrom);

    // Edge spans exactly 1 generation — no split needed
    if (diff <= 1) {
      result.push(edge);
      continue;
    }

    // Edge skips generations — split into hops
    // Direction: +1 going into the past (higher gen), -1 going into future (lower gen)
    const step = genTo > genFrom ? 1 : -1;

    let currentFromId  = edge.from_id;
    let currentFromGen = genFrom;

    let splitSuccessful = true;

    while (currentFromGen !== genTo) {
      const nextGen = currentFromGen + step;

      // Find a node in nextGen that connects this hop
      // Priority: find the actual to_node if it's at nextGen,
      // otherwise find any node in nextGen that is an ancestor/descendant
      let nextNode = null;

      if (nextGen === genTo) {
        // Last hop — connect directly to the target
        nextNode = nodeById[edge.to_id];
      } else {
        // Intermediate hop — find any node at nextGen
        // Prefer nodes that are on the direct path (same side of tree)
        const candidatesAtNextGen = genNodeMap[nextGen] || [];
        if (candidatesAtNextGen.length === 0) {
          // No node at this intermediate generation — cannot split cleanly
          // Fall back to keeping the original long edge
          splitSuccessful = false;
          break;
        }
        // Pick the first available candidate at this generation
        // (in a well-formed family tree this will be the correct intermediary)
        nextNode = candidatesAtNextGen[0];
      }

      if (!nextNode) {
        splitSuccessful = false;
        break;
      }

      // Push a single-generation hop edge
      result.push({
        from_id:          currentFromId,
        to_id:            nextNode.id,
        relation_type:    edge.relation_type,
        relation_tamil:   edge.relation_tamil,
        verified:         edge.verified,
        generation_from:  currentFromGen,
        generation_to:    nextGen,
      });

      currentFromId  = nextNode.id;
      currentFromGen = nextGen;
    }

    if (!splitSuccessful) {
      // Could not find clean path — keep original edge as fallback
      result.push(edge);
    }
  }

  return result;
}

// ─────────────────────────────────────────
// GET /api/offline-users/search
// Search existing offline users in the family network
// Used in AddRelative to prevent duplicate offline nodes
// Query: ?name=Pappammal&user_id=<current_user_id>
// ─────────────────────────────────────────
router.get('/offline-users/search', async (req, res) => {
  const { name, user_id } = req.query;
  if (!name || name.trim().length < 2) {
    return res.json({ success: true, results: [] });
  }

  try {
    // Find offline users in this user's family network
    // by searching pmf_offline_users by name match
    const { data, error } = await supabase
      .from('pmf_offline_users')
      .select(`
        id, name, gender, kutham,
        added_by_user:added_by(id, name)
      `)
      .ilike('name', `%${name.trim()}%`)
      .limit(10);

    if (error) throw error;

    return res.json({
      success: true,
      results: (data || []).map(u => ({
        id: u.id,
        name: u.name,
        gender: u.gender,
        kutham: u.kutham,
        added_by: u.added_by_user?.name || 'Unknown',
      })),
    });
  } catch (err) {
    console.error('Offline search error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

