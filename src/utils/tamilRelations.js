// ============================================================
// Tamil Relationship Names Map
// Used everywhere relationships are stored or displayed
// ============================================================

const RELATION_MAP = {
  // Core 7 (what user directly enters)
  father:   { tamil: 'Appa',      english: 'Father',      opposite: 'son_of',    generation: +1 },
  mother:   { tamil: 'Amma',      english: 'Mother',      opposite: 'son_of',    generation: +1 },
  spouse:   { tamil: 'Manam',     english: 'Spouse',      opposite: 'spouse',    generation:  0 },
  brother:  { tamil: 'Annan',     english: 'Brother',     opposite: 'sibling',   generation:  0 },
  sister:   { tamil: 'Akka',      english: 'Sister',      opposite: 'sibling',   generation:  0 },
  son:      { tamil: 'Magan',     english: 'Son',         opposite: 'parent',    generation: -1 },
  daughter: { tamil: 'Magal',     english: 'Daughter',    opposite: 'parent',    generation: -1 },

  // Inferred (system generates these)
  grandfather_paternal: { tamil: 'Thatha',    english: 'Grandfather',      generation: +2 },
  grandmother_paternal: { tamil: 'Paati',     english: 'Grandmother',      generation: +2 },
  grandfather_maternal: { tamil: 'Thatha',    english: 'Maternal Grandfather', generation: +2 },
  grandmother_maternal: { tamil: 'Paati',     english: 'Maternal Grandmother', generation: +2 },
  uncle_elder:          { tamil: 'Periyappa', english: 'Elder Uncle',      generation: +1 },
  uncle_younger:        { tamil: 'Chittappa', english: 'Younger Uncle',    generation: +1 },
  uncle_maternal:       { tamil: 'Mama',      english: 'Maternal Uncle',   generation: +1 },
  aunt_paternal:        { tamil: 'Athai',     english: 'Paternal Aunt',    generation: +1 },
  aunt_maternal:        { tamil: 'Chithi',    english: 'Maternal Aunt',    generation: +1 },
  cousin_male:          { tamil: 'Machan',    english: 'Cousin',           generation:  0 },
  cousin_female:        { tamil: 'Maami',     english: 'Cousin Sister',    generation:  0 },
  grandson:             { tamil: 'Peran',     english: 'Grandson',         generation: -2 },
  granddaughter:        { tamil: 'Pethi',     english: 'Granddaughter',    generation: -2 },
  brother_in_law:       { tamil: 'Maitthunan', english: 'Brother-in-law',  generation:  0 },
  sister_in_law:        { tamil: 'Naathanar', english: 'Sister-in-law',   generation:  0 },
  co_brother:           { tamil: 'Sakaali',   english: 'Co-brother',       generation:  0 },
  father_in_law:        { tamil: 'Maaman',    english: 'Father-in-law',    generation: +1 },
  mother_in_law:        { tamil: 'Maami',     english: 'Mother-in-law',    generation: +1 },
};

// Core 7 that users can directly add
const CORE_RELATIONS = ['father', 'mother', 'spouse', 'brother', 'sister', 'son', 'daughter'];

function getTamilName(relationType) {
  return RELATION_MAP[relationType]?.tamil || relationType;
}

function getEnglishName(relationType) {
  return RELATION_MAP[relationType]?.english || relationType;
}

function isValidCoreRelation(relationType) {
  return CORE_RELATIONS.includes(relationType);
}

module.exports = { RELATION_MAP, CORE_RELATIONS, getTamilName, getEnglishName, isValidCoreRelation };
