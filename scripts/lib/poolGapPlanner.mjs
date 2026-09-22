/**
 * poolGapPlanner.mjs — elige tema + vocab según escasez real en reusable-seed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './loadEnv.mjs';
import { loadWeakLemmas } from './lesenTemplatePrompt.mjs';
import {
  moduleTeilsForLevel,
  normalizeTopicForLevel,
  seedPathsForLevel,
  topicsForLevel,
} from './levelPlanner.mjs';

export function loadPoolRecords(lang = 'de', level = 'B1') {
  const records = [];
  for (const rel of seedPathsForLevel(lang, level)) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const rows = Array.isArray(data.records) ? data.records : [];
    for (const r of rows) {
      if (String(r.lang || lang).toLowerCase() !== lang) continue;
      if (String(r.level || level).toUpperCase() !== level) continue;
      if (r.disabled) continue;
      if (!r.complete || !r.verified) continue;
      // Same servability bar as build-pool-stock-manifest / exam-part pool pick.
      if (!(r.sem1VerifiedAt || r.sem1Skipped)) continue;
      records.push(r);
    }
  }
  return records;
}

export function moduleTeils(module, blueprintTeils, level = 'B1') {
  const m = String(module).toLowerCase();
  if (blueprintTeils?.length) return blueprintTeils;
  return moduleTeilsForLevel(m, level);
}

function topicScopeForGap(level, opts = {}) {
  if (opts.topicScope) return opts.topicScope;
  return 'gap';
}

/** Count verified parts per canonical topic for one module+teil cell. */
export function countTopicStock(records, module, teil, level = 'B1', opts = {}) {
  const mod = String(module).toLowerCase();
  const tN = Number(teil);
  const scope = topicScopeForGap(level, opts);
  const topicList = topicsForLevel(level, { scope, lang: opts.lang });
  const counts = Object.fromEntries(topicList.map((t) => [t, 0]));
  let untagged = 0;

  for (const r of records) {
    if (String(r.module).toLowerCase() !== mod) continue;
    if (Number(r.teil) !== tN) continue;
    const topic = normalizeTopicForLevel(level, r.topicTag, opts.lang);
    if (topic && counts[topic] !== undefined) counts[topic]++;
    else untagged++;
  }

  return { counts, untagged, total: Object.values(counts).reduce((a, b) => a + b, 0) + untagged };
}

/** Rank topics for a cell: highest deficit first, then lowest count. */
export function rankTopicGaps(records, module, teil, targetPerCell = 3, level = 'B1', opts = {}) {
  const { counts } = countTopicStock(records, module, teil, level, opts);
  const scope = topicScopeForGap(level, opts);
  const topicList = topicsForLevel(level, { scope, lang: opts.lang });
  return topicList.map((topic) => {
    const count = counts[topic] || 0;
    const deficit = Math.max(0, targetPerCell - count);
    return { topic, count, deficit };
  }).sort((a, b) => b.deficit - a.deficit || a.count - b.count || a.topic.localeCompare(b.topic));
}

export function pickScarcestTopic(records, module, teil, opts = {}) {
  const {
    targetPerCell = 3,
    excludeTopics = [],
    excludeSet = null,
    level = 'B1',
  } = opts;
  const gapOpts = { topicScope: topicScopeForGap(level, opts), lang: opts.lang };
  const topicList = topicsForLevel(level, { scope: gapOpts.topicScope, lang: opts.lang });
  const exclude = excludeSet || new Set(
    (excludeTopics || []).map((t) => normalizeTopicForLevel(level, t, opts.lang)).filter(Boolean),
  );
  const ranked = rankTopicGaps(records, module, teil, targetPerCell, level, gapOpts);
  const candidates = ranked.filter((r) => !exclude.has(r.topic));
  if (!candidates.length) {
    if (opts.noFallback) return null;
    const pool = ranked;
    const bestDeficit = pool[0]?.deficit ?? 0;
    const bestCount = pool.filter((r) => r.deficit === bestDeficit).reduce(
      (min, r) => Math.min(min, r.count),
      pool[0]?.count ?? 0,
    );
    const ties = pool.filter((r) => r.deficit === bestDeficit && r.count === bestCount);
    const pick = ties[Math.floor(Math.random() * ties.length)] || pool[0];
    return pick?.topic || topicList[Math.floor(Math.random() * topicList.length)];
  }
  const pool = candidates;
  const bestDeficit = pool[0]?.deficit ?? 0;
  const bestCount = pool.filter((r) => r.deficit === bestDeficit).reduce(
    (min, r) => Math.min(min, r.count),
    pool[0]?.count ?? 0,
  );
  const ties = pool.filter((r) => r.deficit === bestDeficit && r.count === bestCount);
  const pick = ties[Math.floor(Math.random() * ties.length)] || pool[0];
  return pick?.topic || topicList[Math.floor(Math.random() * topicList.length)];
}

export function loadWeakDetail(lang, level) {
  const file = path.join(ROOT, 'data', 'coverage', `weak-${lang}_${level}.json`);
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(data.detail)) return data.detail;
  return (data.weakLemmas || []).map((lemma) => ({ lemma, parts: 0 }));
}

/** Rotate through weakest lemmas (fewest pool hits first). */
export function pickRotatingWords(lang, level, opts = {}) {
  const count = Math.max(1, Number(opts.count) || 10);
  let cursor = Math.max(0, Number(opts.cursor) || 0);
  const detail = loadWeakDetail(lang, level);
  if (!detail.length) {
    const weak = loadWeakLemmas(lang, level);
    if (!weak?.length) {
      throw new Error(
        `Sin lemas flojos para ${lang}/${level}. Ejecuta: node scripts/vocab-coverage-report.mjs --lang ${lang} --level ${level}`,
      );
    }
    const ordered = [...weak];
    const words = [];
    for (let i = 0; i < count; i++) words.push(ordered[(cursor + i) % ordered.length]);
    return { words, nextCursor: cursor + count };
  }

  const ordered = [
    ...detail.filter((d) => !d.parts).sort((a, b) => String(a.lemma).localeCompare(String(b.lemma))),
    ...detail.filter((d) => d.parts > 0).sort((a, b) => a.parts - b.parts || String(a.lemma).localeCompare(String(b.lemma))),
  ];
  const words = [];
  for (let i = 0; i < count; i++) {
    words.push(String(ordered[(cursor + i) % ordered.length].lemma).toLowerCase());
  }
  return { words, nextCursor: cursor + count };
}

export function buildCellGapReport(lang, level, module, teil, targetPerCell = 3) {
  const records = loadPoolRecords(lang, level);
  const gapOpts = { topicScope: topicScopeForGap(level), lang };
  const ranked = rankTopicGaps(records, module, teil, targetPerCell, level, gapOpts);
  const { untagged, total } = countTopicStock(records, module, teil, level, gapOpts);
  const missing = ranked.filter((r) => r.deficit > 0);
  return { module, teil, targetPerCell, ranked, untagged, total, missing };
}

export function checkpointKey(lang, level, module, teil) {
  const t = teil != null ? `:T${teil}` : '';
  return `${lang}_${level}:${String(module).toLowerCase()}${t}`;
}

export const POOL_FILL_CHECKPOINT = path.join(ROOT, 'batches', '.pool-fill-checkpoint.json');

export function loadPoolFillCheckpoint(key) {
  if (!fs.existsSync(POOL_FILL_CHECKPOINT)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(POOL_FILL_CHECKPOINT, 'utf8'));
    return data?.key === key ? data : null;
  } catch {
    return null;
  }
}

export function savePoolFillCheckpoint(data) {
  fs.mkdirSync(path.dirname(POOL_FILL_CHECKPOINT), { recursive: true });
  fs.writeFileSync(POOL_FILL_CHECKPOINT, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function clearPoolFillCheckpoint() {
  try {
    if (fs.existsSync(POOL_FILL_CHECKPOINT)) fs.unlinkSync(POOL_FILL_CHECKPOINT);
  } catch {
    /* ignore */
  }
}
