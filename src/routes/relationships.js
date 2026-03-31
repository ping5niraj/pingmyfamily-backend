const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const authMiddleware = require('../middleware/auth');
const { sendEmail, sendTelegram } = require('../services/notifications');

router.use(authMiddleware);

// ─────────────────────────────────────────
// Reverse relation mapping
// ─────────────────────────────────────────
function getReverseRelation(relation_type, fromUserGender, childGender) {
  // fromUserGender = gender of person who added the relation
  // childGender    = gender of the person whose reverse label we are computing

  if (relation_type === 'son' || relation_type === 'daughter') {
    // Parent added child → reverse is father/mother based on parent's gender
    if (fromUserGender === 'female') return { type: 'mother', tamil: 'அம்மா' };
    return { type: 'father', tamil: 'அப்பா' };
  }

  if (relation_type === 'father' || relation_type === 'mother') {
    // Child added parent → reverse is son/daughter based on CHILD's gender
    // childGender here = from_user's gender (the child who added the parent)
    if (childGender === 'female') return { type: 'daughter', tamil: 'மகள்' };
    return { type: 'son', tamil: 'மகன்' };
  }

  if (relation_type === 'brother') return { type: 'brother', tamil: 'அண்ணன்/தம்பி' };
  if (relation_type === 'sister')  return { type: 'sister',  tamil: 'அக்கா/தங்கை'  };
  if (relation_type === 'spouse')  return { type: 'spouse',  tamil: 'மனைவி/கணவன்'  };
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
          is_offline, offline_name, offline_gender } = req.body;

  if (!relation_type) {
    return res.status(400).json({ error: 'relation_type is required' });
  }

  // ── OFFLINE / DECEASED MEMBER FLOW ──
  if (is_offline) {
    if (!offline_name) {
      return res.status(400).json({ error: 'offline_name is required for offline members' });
    }

    const { data: fromUser } = await supabase
      .from('pmf_users').select('id, name, phone, gender').eq('id', req.user.id).single();

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
        offline_name: offline_name.trim(),
        offline_gender: offline_gender || 'other'
      })
      .select().single();

    if (createError) {
      console.error('Offline relationship error:', createError);
      return res.status(500).json({ error: 'Failed to create offline relationship' });
    }

    return res.json({
      success: true, relationship, offline: true,
      message: `${offline_name} குடும்ப மரத்தில் சேர்க்கப்பட்டார்`
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
    // relation_type = what FROM user (e.g. Sangeetha) called the TO user (e.g. Mani)
    // Reverse = what is FROM user to TO user?
    // To determine son vs daughter: we need FROM user's gender (Sangeetha's gender)
    // fromUserGender = who added the relation (e.g. Mani's gender — the parent)
    // toUserGender   = from_user's gender (Sangeetha) — determines son/daughter
    const reversed = getReverseRelation(r.relation_type, r.from_user?.gender, r.from_user?.gender);
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
  const visited = new Set();
  const nodeMap = new Map(); // key = unique id, value = node

  async function traverse(userId, generation, relationFromRoot, relationTamilFromRoot) {
    if (visited.has(userId)) return;
    if (generation > 4 || generation < -2) return;
    visited.add(userId);

    // Fetch all verified relationships where this user is the FROM side
    const { data: rels } = await supabase
      .from('pmf_relationships')
      .select(`id, relation_type, relation_tamil, verification_status,
        is_offline, offline_name, offline_gender,
        to_user:to_user_id(id, name, phone, kutham, gender)`)
      .eq('from_user_id', userId)
      .eq('verification_status', 'verified');

    for (const rel of rels || []) {
      const isGrandparent = rel.relation_type.startsWith('grandfather') ||
                            rel.relation_type.startsWith('grandmother');
      const isGrandchild  = rel.relation_type === 'grandson' ||
                            rel.relation_type === 'granddaughter';
      const isParent      = rel.relation_type === 'father' || rel.relation_type === 'mother';
      const isChild       = rel.relation_type === 'son' || rel.relation_type === 'daughter';
      const isAncestor    = isParent || isGrandparent;
      const isDescendant  = isChild || isGrandchild;

      // Generation delta from current node
      const genDelta = isGrandparent ? 2
                     : isGrandchild  ? -2
                     : isParent      ? 1
                     : isChild       ? -1
                     : 0;

      const nextGen = generation + genDelta;

      if (nextGen > 4 || nextGen < -2) continue;

      // Determine relation label relative to ROOT user
      // e.g. if Mani is father of Niranjan, and Mani adds his father →
      // that person is grandfather of Niranjan
      const relLabel = getExtendedLabel(relationFromRoot, rel.relation_type);

      if (rel.is_offline) {
        // Use name+gender+addedBy as dedup key to avoid showing same person twice
        const nodeId = `offline-${userId}-${(rel.offline_name||'').toLowerCase().replace(/\s/g,'-')}`;
        if (!nodeMap.has(nodeId)) {
          nodeMap.set(nodeId, {
            id: nodeId,
            name: rel.offline_name,
            kutham: null,
            relation_type: relLabel.type,
            relation_tamil: relLabel.tamil,
            generation: nextGen,
            is_offline: true,
            offline_gender: rel.offline_gender,
            verified: true,
            added_by: userId
          });
        }
      } else if (rel.to_user && rel.to_user.id !== rootId) {
        const nodeId = rel.to_user.id;
        if (!nodeMap.has(nodeId)) {
          nodeMap.set(nodeId, {
            id: nodeId,
            name: rel.to_user.name,
            kutham: rel.to_user.kutham,
            relation_type: relLabel.type,
            relation_tamil: relLabel.tamil,
            generation: nextGen,
            is_offline: false,
            verified: true,
            added_by: userId
          });
        }

        // Recurse up/down the chain for all ancestor/descendant relations
        if (isAncestor || isDescendant) {
          await traverse(rel.to_user.id, nextGen, relLabel.type, relLabel.tamil);
        }
        // Also recurse into grandparent nodes to find their parents
        // This allows 3rd/4th generation to appear correctly
        else if (isGrandparent || isGrandchild) {
          await traverse(rel.to_user.id, nextGen, relLabel.type, relLabel.tamil);
        }
      }
    }
  }

  await traverse(rootId, 0, null, null);

  return res.json({
    success: true,
    nodes: Array.from(nodeMap.values()),
    root_id: rootId
  });
});

// ─────────────────────────────────────────
// Extended label resolver
// Given root→intermediate relation and intermediate→target relation,
// returns the correct label for root→target
// ─────────────────────────────────────────
function getExtendedLabel(rootToMid, midToTarget) {
  // Direct relation (root is the from_user)
  if (!rootToMid) {
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
    };
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

    // Uncle/Aunt
    'father→brother':   { type: 'uncle_elder',   tamil: 'பெரியப்பா/சித்தப்பா' },
    'father→sister':    { type: 'aunt_paternal',  tamil: 'அத்தை'                },
    'mother→brother':   { type: 'uncle_maternal', tamil: 'மாமா'                 },
    'mother→sister':    { type: 'aunt_maternal',  tamil: 'சித்தி'               },
  };

  return EXTENDED[chain] || { type: midToTarget, tamil: midToTarget };
}

module.exports = router;
