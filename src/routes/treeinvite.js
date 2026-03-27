const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'pingmyfamily_secret_2026';

// Auth middleware
const auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
};

// ─────────────────────────────────────────
// INFERENCE ENGINE
// Given how the invitee (Mama) relates to Niranjan,
// infer how Mama relates to each of Niranjan's family members
// ─────────────────────────────────────────
const INFERENCE_MAP = {
  // self_relation: how Mama relates to Niranjan
  // member_relation: how member relates to Niranjan
  // result: how Mama should relate to that member

  // Mama is Niranjan's cousin (machan/cousin)
  cousin: {
    father:               { type: 'uncle_paternal',   tamil: 'பெரியப்பா/சித்தப்பா' },
    mother:               { type: 'aunt_paternal',    tamil: 'பெரியம்மா/சித்தி'     },
    spouse:               { type: 'cousin_spouse',    tamil: 'மச்சான் மனைவி'        },
    brother:              { type: 'cousin',            tamil: 'மச்சான்/அண்ணன்'       },
    sister:               { type: 'cousin_sister',    tamil: 'அக்கா/மச்சி'          },
    son:                  { type: 'nephew',            tamil: 'மருமகன்'              },
    daughter:             { type: 'niece',             tamil: 'மருமகள்'              },
    grandfather_paternal: { type: 'great_uncle',       tamil: 'தாத்தா'               },
    grandmother_paternal: { type: 'great_aunt',        tamil: 'பாட்டி'               },
  },

  // Mama is Niranjan's brother
  brother: {
    father:               { type: 'father',            tamil: 'அப்பா'               },
    mother:               { type: 'mother',            tamil: 'அம்மா'               },
    spouse:               { type: 'sister_in_law',     tamil: 'நாத்தனார்'            },
    sister:               { type: 'sister',            tamil: 'அக்கா/தங்கை'         },
    son:                  { type: 'nephew',             tamil: 'மருமகன்'             },
    daughter:             { type: 'niece',              tamil: 'மருமகள்'             },
    grandfather_paternal: { type: 'grandfather',        tamil: 'தாத்தா'              },
    grandmother_paternal: { type: 'grandmother',        tamil: 'பாட்டி'              },
  },

  // Mama is Niranjan's sister
  sister: {
    father:               { type: 'father',            tamil: 'அப்பா'               },
    mother:               { type: 'mother',            tamil: 'அம்மா'               },
    spouse:               { type: 'brother_in_law',    tamil: 'மைத்துனன்'            },
    brother:              { type: 'brother',            tamil: 'அண்ணன்/தம்பி'        },
    son:                  { type: 'nephew',             tamil: 'மருமகன்'             },
    daughter:             { type: 'niece',              tamil: 'மருமகள்'             },
    grandfather_paternal: { type: 'grandfather',        tamil: 'தாத்தா'              },
    grandmother_paternal: { type: 'grandmother',        tamil: 'பாட்டி'              },
  },

  // Mama is Niranjan's son
  son: {
    father:               { type: 'grandfather',       tamil: 'தாத்தா'              },
    mother:               { type: 'grandmother',       tamil: 'பாட்டி'              },
    spouse:               { type: 'mother',            tamil: 'அம்மா'               },
    brother:              { type: 'uncle',             tamil: 'சித்தப்பா/பெரியப்பா' },
    sister:               { type: 'aunt',              tamil: 'அத்தை/சித்தி'        },
  },

  // Mama is Niranjan's daughter
  daughter: {
    father:               { type: 'grandfather',       tamil: 'தாத்தா'              },
    mother:               { type: 'grandmother',       tamil: 'பாட்டி'              },
    spouse:               { type: 'father',            tamil: 'அப்பா'               },
    brother:              { type: 'uncle',             tamil: 'சித்தப்பா/பெரியப்பா' },
    sister:               { type: 'aunt',              tamil: 'அத்தை/சித்தி'        },
  },

  // Mama is Niranjan's uncle (maternal)
  uncle_maternal: {
    father:               { type: 'brother_in_law',   tamil: 'மைத்துனன்'            },
    mother:               { type: 'sister',           tamil: 'அக்கா/தங்கை'          },
    spouse:               { type: 'nephew_spouse',    tamil: 'மருமகள்'              },
    son:                  { type: 'nephew',           tamil: 'மருமகன்'              },
    daughter:             { type: 'niece',            tamil: 'மருமகள்'              },
  },

  // Mama is Niranjan's aunt (paternal)
  aunt_paternal: {
    father:               { type: 'brother',          tamil: 'அண்ணன்/தம்பி'         },
    mother:               { type: 'sister_in_law',    tamil: 'நாத்தனார்'             },
    son:                  { type: 'nephew',           tamil: 'மருமகன்'              },
    daughter:             { type: 'niece',            tamil: 'மருமகள்'              },
  },
};

// Normalize relation type for inference lookup
const normalizeForInference = (relType) => {
  if (['cousin', 'machan'].includes(relType)) return 'cousin';
  if (relType === 'brother') return 'brother';
  if (relType === 'sister') return 'sister';
  if (relType === 'son') return 'son';
  if (relType === 'daughter') return 'daughter';
  if (['uncle_maternal', 'mama'].includes(relType)) return 'uncle_maternal';
  if (['aunt_paternal', 'athai'].includes(relType)) return 'aunt_paternal';
  return null;
};

const inferRelation = (selfRelationType, memberRelationType) => {
  const key = normalizeForInference(selfRelationType);
  if (!key) return null;
  // Normalize member relation (remove paternal/maternal suffix for lookup)
  const memberKey = memberRelationType?.replace(/_paternal|_maternal/, '') || memberRelationType;
  return INFERENCE_MAP[key]?.[memberRelationType] || INFERENCE_MAP[key]?.[memberKey] || null;
};

// ─────────────────────────────────────────
// POST /api/tree-invite/send
// Niranjan sends tree invite to Mama
// ─────────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  const { to_phone, relation_type, relation_tamil } = req.body;
  if (!to_phone || !relation_type) {
    return res.status(400).json({ error: 'Phone and relation required' });
  }

  try {
    const token = crypto.randomBytes(20).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await supabase.from('pmf_tree_invites').insert({
      from_user_id: req.user.id,
      to_phone: to_phone.replace(/\s+/g, ''),
      token,
      relation_type,
      relation_tamil,
      status: 'pending',
      expires_at: expiresAt.toISOString(),
    });

    // Get inviter's name for WhatsApp message
    const { data: inviter } = await supabase
      .from('pmf_users')
      .select('name')
      .eq('id', req.user.id)
      .single();

    const inviteUrl = `https://frootze.com/tree-invite/${token}`;
    const waText =
      `🌳 ${inviter?.name} உங்களை frootze குடும்ப மரத்தில் சேர அழைக்கிறார்!\n\n` +
      `${inviter?.name} is inviting you to their family tree.\n\n` +
      `📋 அவரின் குடும்பத்தினரை பார்க்க / See their family members:\n` +
      `${inviteUrl}\n\n` +
      `ஒரே கிளிக்கில் குடும்பம் சேரலாம்! 🌳\nஇலவசம் · Free Forever`;

    const whatsappLink = `https://wa.me/91${to_phone.replace(/\D/g, '')}?text=${encodeURIComponent(waText)}`;

    return res.json({
      success: true,
      token,
      invite_url: inviteUrl,
      whatsapp_link: whatsappLink,
    });
  } catch (e) {
    console.error('Tree invite send error:', e);
    return res.status(500).json({ error: 'Failed to create invite' });
  }
});

// ─────────────────────────────────────────
// GET /api/tree-invite/:token
// Mama opens invite — get inviter's tree + inferred relations
// PUBLIC endpoint — no auth required
// ─────────────────────────────────────────
router.get('/:token', async (req, res) => {
  const { token } = req.params;

  try {
    // Get invite
    const { data: invite } = await supabase
      .from('pmf_tree_invites')
      .select('*')
      .eq('token', token)
      .single();

    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.status === 'expired') return res.status(410).json({ error: 'Invite expired' });
    if (new Date(invite.expires_at) < new Date()) {
      await supabase.from('pmf_tree_invites').update({ status: 'expired' }).eq('id', invite.id);
      return res.status(410).json({ error: 'Invite expired' });
    }

    // Get inviter's profile
    const { data: inviter } = await supabase
      .from('pmf_users')
      .select('id, name, profile_photo, kutham')
      .eq('id', invite.from_user_id)
      .single();

    // Get inviter's verified relationships
    const { data: relationships } = await supabase
      .from('pmf_relationships')
      .select(`
        id, relation_type, relation_tamil, is_offline, offline_name, offline_gender,
        to_user:to_user_id(id, name, profile_photo, kutham, gender)
      `)
      .eq('from_user_id', invite.from_user_id)
      .eq('verification_status', 'verified');

    // Build member list with inferred relations
    const members = (relationships || []).map(rel => {
      const inferred = inferRelation(invite.relation_type, rel.relation_type);
      return {
        id: rel.to_user?.id || `offline-${rel.id}`,
        name: rel.to_user?.name || rel.offline_name || '?',
        profile_photo: rel.to_user?.profile_photo || null,
        kutham: rel.to_user?.kutham || null,
        gender: rel.to_user?.gender || rel.offline_gender || null,
        is_offline: rel.is_offline,
        niranjan_relation_type: rel.relation_type,
        niranjan_relation_tamil: rel.relation_tamil,
        inferred_relation_type: inferred?.type || null,
        inferred_relation_tamil: inferred?.tamil || null,
        user_id: rel.to_user?.id || null,
      };
    });

    return res.json({
      success: true,
      invite: {
        token,
        relation_type: invite.relation_type,
        relation_tamil: invite.relation_tamil,
        expires_at: invite.expires_at,
      },
      inviter: {
        id: inviter?.id,
        name: inviter?.name,
        profile_photo: inviter?.profile_photo,
      },
      members,
    });
  } catch (e) {
    console.error('Tree invite get error:', e);
    return res.status(500).json({ error: 'Failed to load invite' });
  }
});

// ─────────────────────────────────────────
// POST /api/tree-invite/:token/submit
// Mama submits his selections
// REQUIRES AUTH — Mama must be registered
// ─────────────────────────────────────────
router.post('/:token/submit', auth, async (req, res) => {
  const { token } = req.params;
  const { selections } = req.body;
  // selections: [{ user_id, relation_type, relation_tamil }]

  if (!selections || selections.length === 0) {
    return res.status(400).json({ error: 'No selections provided' });
  }

  try {
    // Get invite
    const { data: invite } = await supabase
      .from('pmf_tree_invites')
      .select('*')
      .eq('token', token)
      .single();

    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invite expired' });
    }

    const results = [];

    // Step 1: Add relationship between Mama and Niranjan
    const { data: existingRel } = await supabase
      .from('pmf_relationships')
      .select('id')
      .eq('from_user_id', req.user.id)
      .eq('to_user_id', invite.from_user_id)
      .single();

    if (!existingRel) {
      await supabase.from('pmf_relationships').insert({
        from_user_id: req.user.id,
        to_user_id: invite.from_user_id,
        relation_type: invite.relation_type,
        relation_tamil: invite.relation_tamil,
        verification_status: 'pending',
        created_by: req.user.id,
      });
    }

    // Step 2: For each selected member, create relationship request
    for (const sel of selections) {
      if (!sel.user_id || sel.user_id.startsWith('offline-')) continue;

      // Check if relationship already exists
      const { data: existing } = await supabase
        .from('pmf_relationships')
        .select('id')
        .eq('from_user_id', req.user.id)
        .eq('to_user_id', sel.user_id)
        .single();

      if (!existing) {
        await supabase.from('pmf_relationships').insert({
          from_user_id: req.user.id,
          to_user_id: sel.user_id,
          relation_type: sel.relation_type,
          relation_tamil: sel.relation_tamil,
          verification_status: 'pending',
          created_by: req.user.id,
        });

        // Send notification to that member
        await supabase.from('pmf_messages').insert({
          from_user_id: req.user.id,
          subject: 'புதிய உறவு கோரிக்கை / New Relationship Request',
          content: `${req.user.name || 'Someone'} உங்கள் ${sel.relation_tamil} என்று கோருகிறார். / wants to connect as your ${sel.relation_tamil}.`,
          message_type: 'relationship_request',
        }).then(async (msgRes) => {
          if (msgRes.data?.[0]?.id) {
            await supabase.from('pmf_message_recipients').insert({
              message_id: msgRes.data[0].id,
              recipient_id: sel.user_id,
            });
          }
        }).catch(() => {});

        results.push({ user_id: sel.user_id, status: 'requested' });
      } else {
        results.push({ user_id: sel.user_id, status: 'already_exists' });
      }
    }

    // Mark invite as accepted
    await supabase.from('pmf_tree_invites')
      .update({ status: 'accepted' })
      .eq('id', invite.id);

    return res.json({
      success: true,
      message: `${results.filter(r => r.status === 'requested').length} relationship requests sent!`,
      results,
    });
  } catch (e) {
    console.error('Tree invite submit error:', e);
    return res.status(500).json({ error: 'Failed to submit selections' });
  }
});

module.exports = router;
