// ============================================================
// PingMyFamily — Inference Engine
// Auto-calculates extended family from direct relationships
// Phase 1: PostgreSQL only (no Neo4j)
// ============================================================

const supabase = require('../supabase');
const { getTamilName } = require('./tamilRelations');

// ─── Main Inference Runner ─────────────────────────────────
// Call this after any new verified relationship is added
async function runInference(userId) {
  try {
    // Get all verified direct relationships for this user
    const { data: directRels, error } = await supabase
      .from('pmf_relationships')
      .select('*')
      .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
      .eq('verification_status', 'verified');

    if (error) throw error;
    if (!directRels || directRels.length === 0) return;

    const inferred = [];

    // Build a simple map: userId → [{ relatedId, relationType }]
    const relMap = buildRelationMap(directRels, userId);

    // ── Rule 1: Father's Father = Paternal Grandfather ──────
    const fathers = getRelated(relMap, userId, 'father');
    for (const fatherId of fathers) {
      const fathersParents = getRelated(relMap, fatherId, 'father');
      for (const gfId of fathersParents) {
        if (gfId !== userId) {
          inferred.push(makeInferred(userId, gfId, 'grandfather_paternal', +2, [fatherId]));
        }
      }
      const fathersMothers = getRelated(relMap, fatherId, 'mother');
      for (const gmId of fathersMothers) {
        if (gmId !== userId) {
          inferred.push(makeInferred(userId, gmId, 'grandmother_paternal', +2, [fatherId]));
        }
      }

      // ── Rule 2: Father's Brother = Uncle ──────────────────
      const fathersBrothers = getRelated(relMap, fatherId, 'brother');
      for (const uncleId of fathersBrothers) {
        if (uncleId !== userId) {
          inferred.push(makeInferred(userId, uncleId, 'uncle_elder', +1, [fatherId]));
        }
      }

      // ── Rule 3: Father's Sister = Paternal Aunt ───────────
      const fathersSisters = getRelated(relMap, fatherId, 'sister');
      for (const auntId of fathersSisters) {
        if (auntId !== userId) {
          inferred.push(makeInferred(userId, auntId, 'aunt_paternal', +1, [fatherId]));
        }
      }
    }

    // ── Rule 4: Mother's Father = Maternal Grandfather ──────
    const mothers = getRelated(relMap, userId, 'mother');
    for (const motherId of mothers) {
      const mothersParents = getRelated(relMap, motherId, 'father');
      for (const gfId of mothersParents) {
        if (gfId !== userId) {
          inferred.push(makeInferred(userId, gfId, 'grandfather_maternal', +2, [motherId]));
        }
      }

      // ── Rule 5: Mother's Brother = Maternal Uncle (Mama) ──
      const mothersBrothers = getRelated(relMap, motherId, 'brother');
      for (const mamaId of mothersBrothers) {
        if (mamaId !== userId) {
          inferred.push(makeInferred(userId, mamaId, 'uncle_maternal', +1, [motherId]));
        }
      }

      // ── Rule 6: Mother's Sister = Maternal Aunt (Chithi) ──
      const mothersSisters = getRelated(relMap, motherId, 'sister');
      for (const chithiId of mothersSisters) {
        if (chithiId !== userId) {
          inferred.push(makeInferred(userId, chithiId, 'aunt_maternal', +1, [motherId]));
        }
      }
    }

    // ── Rule 7: Brother's / Sister's children = Nephew/Niece
    const siblings = [
      ...getRelated(relMap, userId, 'brother'),
      ...getRelated(relMap, userId, 'sister')
    ];
    for (const sibId of siblings) {
      const sibSons = getRelated(relMap, sibId, 'son');
      for (const nephewId of sibSons) {
        if (nephewId !== userId) {
          inferred.push(makeInferred(userId, nephewId, 'cousin_male', 0, [sibId]));
        }
      }
      const sibDaughters = getRelated(relMap, sibId, 'daughter');
      for (const nieceId of sibDaughters) {
        if (nieceId !== userId) {
          inferred.push(makeInferred(userId, nieceId, 'cousin_female', 0, [sibId]));
        }
      }
    }

    // ── Rule 8: Spouse's parents = In-laws ────────────────
    const spouses = getRelated(relMap, userId, 'spouse');
    for (const spouseId of spouses) {
      const spousesFathers = getRelated(relMap, spouseId, 'father');
      for (const filId of spousesFathers) {
        if (filId !== userId) {
          inferred.push(makeInferred(userId, filId, 'father_in_law', +1, [spouseId]));
        }
      }
      const spousesMothers = getRelated(relMap, spouseId, 'mother');
      for (const milId of spousesMothers) {
        if (milId !== userId) {
          inferred.push(makeInferred(userId, milId, 'mother_in_law', +1, [spouseId]));
        }
      }
    }

    // ── Save all inferred to DB ────────────────────────────
    if (inferred.length > 0) {
      const { error: upsertError } = await supabase
        .from('pmf_inferred')
        .upsert(inferred, { onConflict: 'from_user_id,to_user_id,relation_type' });

      if (upsertError) {
        console.error('Inference upsert error:', upsertError);
      } else {
        console.log(`Inference: saved ${inferred.length} relationships for user ${userId}`);
      }
    }

  } catch (err) {
    console.error('Inference engine error:', err);
  }
}

// ─── Helpers ──────────────────────────────────────────────

function buildRelationMap(rels, currentUserId) {
  const map = {};

  for (const rel of rels) {
    // from → to
    if (!map[rel.from_user_id]) map[rel.from_user_id] = [];
    map[rel.from_user_id].push({ id: rel.to_user_id, type: rel.relation_type });

    // to → from (reverse — so we can traverse both directions)
    if (!map[rel.to_user_id]) map[rel.to_user_id] = [];
    map[rel.to_user_id].push({ id: rel.from_user_id, type: rel.relation_type });
  }

  return map;
}

function getRelated(map, userId, relationType) {
  if (!map[userId]) return [];
  return map[userId]
    .filter(r => r.type === relationType)
    .map(r => r.id);
}

function makeInferred(fromId, toId, relationType, generation, derivedVia) {
  return {
    from_user_id: fromId,
    to_user_id: toId,
    relation_type: relationType,
    relation_tamil: getTamilName(relationType),
    generation,
    derived_via: derivedVia
  };
}

module.exports = { runInference };
