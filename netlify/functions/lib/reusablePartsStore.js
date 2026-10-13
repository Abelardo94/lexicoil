'use strict';

/**
 * Reusable-parts store — Netlify Blobs.
 *
 * A "reusable part" is a self-contained exam section (one module/teil combo)
 * that can be served instantly without AI generation.
 *
 * Key layout (all in the shared 'lexicoil-data' store):
 *   reusable_part:{lang}:{level}:{module}:{id}        — full part payload
 *   reusable_part_idx:{lang}:{level}:{module}:{id}    — lightweight index entry
 *
 * This is intentionally parallel to (and does not touch) the exam pool.
 */

const { randomUUID } = require('crypto');
const { casWriteJson } = require('./casBlob.js');
const { partPassesPassageDedupe } = require('./passageDedupe.js');
const { applyPartIndex } = require('./partIndex.js');
const { partPassesPublishGate } = require('./partPublishGate.js');
const { partPassesAssembleMode } = require('./officialQuarantine.js');
const { normalizeB1Topic } = require('../../../js/data/b1Topics.js');
const {
  loadModuleSearchRows,
  filterRows,
  filterRowsByTopicTag,
  scoreRowsForVocab,
  resolveRowPart,
  vocabKeysFromPart,
  clearPoolSearchCache,
} = require('./poolSearchCache.js');

const MAX_PER_TEIL = 50;   // max stored parts per (lang, level, module, teil)
const MAX_PER_SLOT = MAX_PER_TEIL; // legacy export name
const PART_SAMPLE   = 20;  // how many to consider when picking
const BURN_THRESHOLD = 50; // servedCount above which a part is treated as "well-used"
const CURRENT_SCHEMA_VERSION = 2;

// ─── Key helpers ─────────────────────────────────────────────────────────────

function partPayloadKey(lang, level, module, id) {
  return `reusable_part:${lang}:${level}:${module}:${id}`;
}

function partIndexKey(lang, level, module, id) {
  return `reusable_part_idx:${lang}:${level}:${module}:${id}`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function pickRandom(arr, n) {
  const copy = [...arr];
  const out = [];
  while (copy.length && out.length < n) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

/**
 * List all index entries for (lang, level, module), sorted oldest-first.
 * Returns lightweight rows — does NOT load the full payloads.
 */
async function listPartsIndex(store, lang, level, module) {
  if (!store || typeof store.list !== 'function') return [];
  const prefix = `reusable_part_idx:${lang}:${level}:${module}:`;
  let listed;
  try {
    listed = await store.list({ prefix });
  } catch (_) {
    return [];
  }
  const blobs = listed?.blobs || [];
  const entries = [];
  for (const blob of blobs) {
    try {
      const row = await store.get(blob.key, { type: 'json' });
      if (row?.partKey && row?.id) {
        entries.push({
          indexKey: blob.key,
          partKey:  row.partKey,
          id:       row.id,
          teil:     row.teil,
          complete: row.complete,
          verified: row.verified,
          createdAt:   row.createdAt || 0,
          servedCount: row.servedCount || 0,
          disabled:    row.disabled === true,
          contributor: row.contributor || null,
        });
      }
    } catch (_) {
      /* skip corrupt row */
    }
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt);
}

/** Remove oldest entries when any teil bucket exceeds MAX_PER_TEIL. */
async function rotatePartsByTimestamp(store, lang, level, module, entries) {
  const byTeil = new Map();
  for (const row of entries) {
    const t = Number(row.teil);
    const key = Number.isFinite(t) ? t : '_';
    if (!byTeil.has(key)) byTeil.set(key, []);
    byTeil.get(key).push(row);
  }
  let deleted = 0;
  for (const [teilKey, group] of byTeil) {
    if (group.length <= MAX_PER_TEIL) continue;
    const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt);
    const toRemove = sorted.slice(0, group.length - MAX_PER_TEIL);
    for (const row of toRemove) {
      try {
        await store.delete(row.partKey);
        await store.delete(row.indexKey);
        deleted++;
      } catch (_) { /* ignore */ }
    }
    if (toRemove.length) {
      const label = teilKey === '_' ? '?' : teilKey;
      console.info(`[parts-store] rotated ${toRemove.length} for ${lang}/${level}/${module} T${label}`);
    }
  }
  return deleted;
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Persist a new reusable part and update the append-only index.
 * Returns { partKey, idxKey, id }.
 *
 * Expected shape of `part`:
 *   { lang, level, module, teil, passage, questions, complete, verified,
 *     schemaVersion?, itemCount?, targetCount?, contributor?, createdAt?, id?,
 *     topicTag?, vocabIndex?, topicSlug? }
 */
async function addReusablePart(store, part, options = {}) {
  const deferRotate = options.deferRotate === true;
  const lang    = String(part.lang   || '').toLowerCase();
  const level   = String(part.level  || '').toUpperCase();
  const module  = String(part.module || '').toLowerCase();
  const id      = part.id || randomUUID();
  const now     = Date.now();

  const payload = {
    schemaVersion: part.schemaVersion || CURRENT_SCHEMA_VERSION,
    id,
    lang,
    level,
    module,
    teil:        part.teil      ?? null,
    passage:     part.passage   || null,
    questions:   Array.isArray(part.questions) ? part.questions : [],
    ads:         Array.isArray(part.ads) ? part.ads : (part.passage?.ads || null),
    example:     part.example || part.solvedExample || null,
    segments:    Array.isArray(part.segments) ? part.segments : null,
    instruction: part.instruction || null,
    complete:    !!part.complete,
    verified:    !!part.verified,
    itemCount:   part.itemCount    ?? (Array.isArray(part.questions) ? part.questions.length : 0),
    targetCount: part.targetCount  ?? (Array.isArray(part.questions) ? part.questions.length : 0),
    contributor: part.contributor  || null,
    createdAt:   part.createdAt    || now,
    disabled:    false,
    servedCount: 0,
  };

  if (part.task != null) payload.task = part.task;
  if (part.minWords != null) payload.minWords = part.minWords;
  if (part.maxWords != null) payload.maxWords = part.maxWords;
  if (part.fieldId != null) payload.fieldId = part.fieldId;
  if (part.taskFormat != null) payload.taskFormat = part.taskFormat;
  if (Array.isArray(part.criteria)) payload.criteria = part.criteria;
  if (part.topicTag != null) payload.topicTag = part.topicTag;
  if (part.topicSlug != null) payload.topicSlug = part.topicSlug;
  if (part.topic != null) payload.topic = part.topic;
  if (part.sem1VerifiedAt != null) payload.sem1VerifiedAt = part.sem1VerifiedAt;
  if (part.sem1Skipped != null) payload.sem1Skipped = part.sem1Skipped;
  if (part.reviewVerifiedAt != null) payload.reviewVerifiedAt = part.reviewVerifiedAt;
  if (part.reviewVerifiedBy != null) payload.reviewVerifiedBy = part.reviewVerifiedBy;
  if (Array.isArray(part.vocabIndex) && part.vocabIndex.length) {
    payload.vocabIndex = part.vocabIndex;
    if (part.vocabIndexVersion != null) payload.vocabIndexVersion = part.vocabIndexVersion;
  }

  applyPartIndex(payload, {
    lang,
    level,
    topicTag: part.topicTag || null,
  });

  const pKey = partPayloadKey(lang, level, module, id);
  const iKey = partIndexKey(lang, level, module, id);

  await store.setJSON(pKey, payload);

  const idxPayload = {
    partKey:     pKey,
    id,
    teil:        payload.teil,
    complete:    payload.complete,
    verified:    payload.verified,
    createdAt:   payload.createdAt,
    contributor: payload.contributor,
    disabled:    false,
    servedCount: 0,
    topicTag:    payload.topicTag || null,
    topicSlug:   payload.topicSlug || payload.topic || null,
    vocabKeys:   vocabKeysFromPart(payload),
  };
  const idxRes = await store.setJSON(iKey, idxPayload, { onlyIfNew: true });
  if (idxRes && idxRes.modified === false) {
    console.warn(`[parts-store] duplicate add id=${id} ${lang}/${level}/${module}`);
  }

  if (!deferRotate) {
    const entries = await listPartsIndex(store, lang, level, module);
    await rotatePartsByTimestamp(store, lang, level, module, entries);
  }

  clearPoolSearchCache(lang, level, module);
  return { partKey: pKey, idxKey: iKey, id };
}

/** Run rotation once per module after batch seed (avoids O(n²) list on each add). */
async function rotateReusablePartsForModule(store, lang, level, module) {
  const entries = await listPartsIndex(store, lang, level, module);
  return rotatePartsByTimestamp(store, lang, level, module, entries);
}

/**
 * Return the full payload of a single part, or null if not found.
 */
async function getReusablePart(store, lang, level, module, id) {
  const key = partPayloadKey(
    String(lang).toLowerCase(),
    String(level).toUpperCase(),
    String(module).toLowerCase(),
    id,
  );
  try {
    return await store.get(key, { type: 'json' });
  } catch (_) {
    return null;
  }
}

/**
 * Admin listing: full metadata for every part in the slot.
 * `module` is optional — if omitted, lists across all modules for lang/level.
 */
async function listReusablePartsAdmin(store, lang, level, module) {
  const normLang   = String(lang   || '').toLowerCase();
  const normLevel  = String(level  || '').toUpperCase();
  const normModule = module ? String(module).toLowerCase() : null;

  async function loadFromPrefix(prefix) {
    let listed;
    try { listed = await store.list({ prefix }); } catch (_) { return []; }
    const blobs = listed?.blobs || [];
    const out = [];
    for (const blob of blobs) {
      try {
        const row = await store.get(blob.key, { type: 'json' });
        if (!row?.partKey) continue;
        const part = await store.get(row.partKey, { type: 'json' });
        if (!part) continue;
        out.push(_summaryRow(row, part, part.lang || normLang, part.level || normLevel));
      } catch (_) { /* skip */ }
    }
    return out;
  }

  if (!normLang && !normLevel) {
    return (await loadFromPrefix('reusable_part_idx:'))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  if (!normModule) {
    const prefix = normLang && normLevel
      ? `reusable_part_idx:${normLang}:${normLevel}:`
      : normLang
        ? `reusable_part_idx:${normLang}:`
        : `reusable_part_idx:`;
    return (await loadFromPrefix(prefix))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  const entries = await listPartsIndex(store, normLang, normLevel, normModule);
  const out = [];
  for (const row of entries) {
    try {
      const part = await store.get(row.partKey, { type: 'json' });
      if (!part) continue;
      out.push(_summaryRow(row, part, normLang, normLevel));
    } catch (_) { /* skip */ }
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function _summaryRow(row, part, lang, level) {
  return {
    id:          row.id,
    lang:        part.lang        || lang,
    level:       part.level       || level,
    module:      part.module      || '',
    teil:        part.teil        ?? null,
    complete:    !!part.complete,
    verified:    !!part.verified,
    itemCount:   part.itemCount   || 0,
    targetCount: part.targetCount || 0,
    contributor: part.contributor || null,
    createdAt:   part.createdAt   || row.createdAt || 0,
    servedCount: part.servedCount || 0,
    disabled:    part.disabled    === true,
  };
}

/**
 * Enable or disable a stored part.
 * Returns true on success, false if the part was not found.
 */
async function setReusablePartDisabled(store, lang, level, module, id, disabled) {
  const key = partPayloadKey(
    String(lang).toLowerCase(),
    String(level).toUpperCase(),
    String(module).toLowerCase(),
    id,
  );
  let part;
  try {
    part = await store.get(key, { type: 'json' });
  } catch (_) { return false; }
  if (!part) return false;
  part.disabled = !!disabled;
  await store.setJSON(key, part);
  return true;
}

/**
 * Delete a part and its index entry.
 * Returns true on success (or if blobs didn't exist).
 */
async function removeReusablePart(store, lang, level, module, id) {
  const pKey = partPayloadKey(
    String(lang).toLowerCase(),
    String(level).toUpperCase(),
    String(module).toLowerCase(),
    id,
  );
  const iKey = partIndexKey(
    String(lang).toLowerCase(),
    String(level).toUpperCase(),
    String(module).toLowerCase(),
    id,
  );
  try {
    await store.delete(pKey);
    await store.delete(iKey);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Pick a random non-disabled part for the given slot, avoiding excludeIds.
 * Increments servedCount via CAS.
 *
 * Returns { id, part } or null if nothing is available.
 *
 * Options:
 *   excludeIds     {string[]}  IDs to skip (already seen by the user).
 *   usedPassages   {object[]}  Passages already picked for this exam ({ passageId?, text? }).
 */
async function pickReusablePart(store, lang, level, module, {
  excludeIds = [], usedPassages = [], teil = null, assembleMode = 'practice',
} = {}) {
  const normLang   = String(lang).toLowerCase();
  const normLevel  = String(level).toUpperCase();
  const normModule = String(module).toLowerCase();

  const { rows } = await loadModuleSearchRows(store, normLang, normLevel, normModule);
  const available = filterRows(rows, { teil, assembleMode });
  if (!available.length) return null;

  const exclude = new Set(excludeIds);
  const recent = available.length > PART_SAMPLE ? available.slice(-PART_SAMPLE) : available;
  let sampled = pickRandom(recent, Math.min(recent.length, PART_SAMPLE));
  let candidates = sampled.filter((row) => !exclude.has(row.id));
  if (!candidates.length) candidates = sampled;

  const loaded = [];
  for (const row of candidates) {
    const part = await resolveRowPart(store, row);
    if (
      part &&
      partPassesPublishGate(part) &&
      partPassesAssembleMode(part, assembleMode) &&
      partPassesPassageDedupe(part, usedPassages)
    ) {
      loaded.push({
        key: row.partKey || partPayloadKey(normLang, normLevel, normModule, row.id),
        part,
        id: row.id,
        row,
      });
    }
  }
  if (!loaded.length) return null;

  const fresh = loaded.filter((e) => (e.part.servedCount || 0) <= BURN_THRESHOLD);
  const pool  = fresh.length ? fresh : loaded;
  const chosen = pool[Math.floor(Math.random() * pool.length)];

  if (!store || !chosen.key || chosen.row.source === 'seed') {
    return { id: chosen.id, part: chosen.part };
  }

  try {
    return await casWriteJson(
      store,
      chosen.key,
      (current) => {
        const base    = current || chosen.part;
        const payload = {
          ...base,
          servedCount:  (base.servedCount  || 0) + 1,
          lastServedAt: Date.now(),
        };
        return {
          payload,
          result: { id: chosen.id, part: payload },
        };
      },
      { logTag: '[parts-serve]' },
    );
  } catch (_) {
    const part = {
      ...chosen.part,
      servedCount:  (chosen.part.servedCount  || 0) + 1,
      lastServedAt: Date.now(),
    };
    await store.setJSON(chosen.key, part);
    return { id: chosen.id, part };
  }
}

/**
 * Pick a verified part for (topicTag × teil), lowest servedCount first.
 */
async function pickReusablePartByTopic(store, lang, level, module, opts = {}) {
  const {
    excludeIds = [],
    teil = null,
    topicTag = null,
    assembleMode = 'practice',
    excludeOfficialReserved = false,
  } = opts;
  const want = normalizeB1Topic(topicTag);
  if (!want) return null;

  const normLang = String(lang).toLowerCase();
  const normLevel = String(level).toUpperCase();
  const normModule = String(module).toLowerCase();

  const { rows } = await loadModuleSearchRows(store, normLang, normLevel, normModule);
  let available = filterRows(rows, { teil, excludeIds, assembleMode, excludeOfficialReserved });
  available = filterRowsByTopicTag(available, want, { normalizeB1Topic });
  if (!available.length) return null;

  available.sort(
    (a, b) => (a.servedCount || 0) - (b.servedCount || 0) || Math.random() - 0.5,
  );
  const row = available[0];
  const part = await resolveRowPart(store, row);
  if (!partPassesPublishGate(part) || !partPassesAssembleMode(part, assembleMode)) return null;

  const result = {
    id: row.id,
    part,
    coveredWords: [],
    coverage: null,
    topic: row.topicSlug || part.topic || null,
    topicTag: row.topicTag || part.topicTag || want,
    source: row.source === 'seed' ? 'local-seed' : 'blob',
  };

  if (!store || !row.partKey || row.source === 'seed') return result;

  try {
    return await casWriteJson(
      store,
      row.partKey,
      (current) => {
        const base = current || part;
        const payload = { ...base, servedCount: (base.servedCount || 0) + 1, lastServedAt: Date.now() };
        return { payload, result: { ...result, part: payload } };
      },
      { logTag: '[parts-serve-topic]' },
    );
  } catch (_) {
    const payload = { ...part, servedCount: (part.servedCount || 0) + 1, lastServedAt: Date.now() };
    if (row.partKey) await store.setJSON(row.partKey, payload);
    return { ...result, part: payload };
  }
}

/**
 * Igual que pickReusablePart pero elige la parte que MÁS lemas pedidos cubre.
 * words: lemas ya normalizados (passageVocab.lemmatizeWords).
 * excludeTopics: temas a evitar para diversidad intra-módulo (desempate).
 * Devuelve { id, part, coveredWords, coverage:{covered,requested}, topic }.
 */
async function pickReusablePartByVocab(store, lang, level, module, opts = {}) {
  const {
    excludeIds = [], teil = null, words = [], excludeTopics = [], topicTag = null,
    assembleMode = 'practice',
  } = opts;
  const normLang   = String(lang).toLowerCase();
  const normLevel  = String(level).toUpperCase();
  const normModule = String(module).toLowerCase();
  const wantTopic = topicTag ? normalizeB1Topic(topicTag) : null;

  const { rows } = await loadModuleSearchRows(store, normLang, normLevel, normModule);
  let available = filterRows(rows, { teil, excludeIds, assembleMode });
  let topicRelaxed = false;
  if (wantTopic && available.length) {
    const strict = available.filter((r) => normalizeB1Topic(r.topicTag) === wantTopic);
    if (strict.length) available = strict;
    else topicRelaxed = true;
  }
  if (!available.length) return null;

  const wantLemmas = (words || []).map((w) => String(w).toLowerCase()).filter(Boolean);
  if (!wantLemmas.length) {
    if (wantTopic) {
      const byTopic = await pickReusablePartByTopic(store, lang, level, module, {
        excludeIds, teil, topicTag, assembleMode,
      });
      if (byTopic) return byTopic;
    }
    const fallback = await pickReusablePart(store, lang, level, module, { excludeIds, teil, assembleMode });
    if (fallback && wantTopic) fallback.topicRelaxed = true;
    return fallback;
  }

  const scored = scoreRowsForVocab(available, { words: wantLemmas, excludeTopics });
  if (!scored.length) return null;

  const chosen = scored[0];
  const row = chosen.row;
  const part = await resolveRowPart(store, row);
  if (!partPassesPublishGate(part) || !partPassesAssembleMode(part, assembleMode)) return null;

  const servedTopic = normalizeB1Topic(row.topicTag || part.topicTag);
  if (wantTopic && servedTopic && servedTopic !== wantTopic) topicRelaxed = true;

  const result = {
    id: row.id,
    part,
    coveredWords: chosen.covered,
    coverage: { covered: chosen.covered.length, requested: new Set(wantLemmas).size },
    topic: row.topicSlug || part.topic || null,
    topicTag: row.topicTag || part.topicTag || null,
    topicRelaxed,
    source: row.source === 'seed' ? 'local-seed' : 'blob',
  };

  if (!store || !row.partKey || row.source === 'seed') {
    return result;
  }

  try {
    return await casWriteJson(
      store,
      row.partKey,
      (current) => {
        const base = current || part;
        const payload = { ...base, servedCount: (base.servedCount || 0) + 1, lastServedAt: Date.now() };
        return { payload, result: { ...result, part: payload } };
      },
      { logTag: '[parts-serve-vocab]' },
    );
  } catch (_) {
    const payload = { ...part, servedCount: (part.servedCount || 0) + 1, lastServedAt: Date.now() };
    await store.setJSON(row.partKey, payload);
    return { ...result, part: payload };
  }
}

module.exports = {
  MAX_PER_TEIL,
  MAX_PER_SLOT,
  PART_SAMPLE,
  BURN_THRESHOLD,
  partPayloadKey,
  partIndexKey,
  addReusablePart,
  rotateReusablePartsForModule,
  getReusablePart,
  listPartsIndex,
  listReusablePartsAdmin,
  setReusablePartDisabled,
  removeReusablePart,
  pickReusablePart,
  pickReusablePartByTopic,
  pickReusablePartByVocab,
};
