/**
 * levelPlanner.mjs — shared level-aware topics, Teile, and seed paths for pool/vocab-bg.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './loadEnv.mjs';
import { normalizeLevel } from './batchPaths.mjs';
import { layoutForLevel } from './examLevelCells.mjs';

const require = createRequire(import.meta.url);
const { B1_TOPICS, normalizeB1Topic } = require(path.join(ROOT, 'js/data/b1Topics.js'));
const { A2_OFFICIAL_TOPICS, normalizeA2Topic } = require(path.join(ROOT, 'js/data/a2Topics.js'));
const { EN_B1_TOPICS, normalizeEnB1Topic } = require(path.join(ROOT, 'js/data/enB1Topics.js'));

/**
 * Topic slugs per level.
 * @param {string} level
 * @param {{ scope?: 'pool'|'gap'|'ui'|'official' }} [opts]
 * - pool (default): full B1 slug list (A2 seed tags, manifest, normalization)
 * - gap | ui | official: A2 → 5 Goethe axes only; B1/B2 → B1_TOPICS
 */
export function topicsForLevel(level = 'B1', opts = {}) {
  const lv = normalizeLevel(level);
  const scope = opts.scope || 'pool';
  const lang = String(opts.lang || 'de').toLowerCase();
  // English keeps its own closed list; German is untouched when lang is absent.
  if (lang === 'en') return [...EN_B1_TOPICS];
  if (lv === 'A2' && (scope === 'gap' || scope === 'ui' || scope === 'official')) {
    return [...A2_OFFICIAL_TOPICS];
  }
  return B1_TOPICS;
}

export function normalizeTopicForLevel(level, topic, lang = 'de') {
  if (String(lang).toLowerCase() === 'en') return normalizeEnB1Topic(topic);
  const lv = normalizeLevel(level);
  if (lv === 'A2') return normalizeA2Topic(topic);
  return normalizeB1Topic(topic);
}

export function seedPathsForLevel(lang = 'de', level = 'B1') {
  const lv = normalizeLevel(level);
  const l = String(lang).toLowerCase();
  return [
    `library/reusable-seed/${l}_${lv}.json`,
    `library/reusable-seed/${l}_${lv}.bank.json`,
  ];
}

export function generationModulesForLevel(level = 'B1') {
  const layout = layoutForLevel(level);
  return {
    lesen: [...layout.lesen],
    horen: [...layout.horen],
    schreiben: [...layout.schreibenTeils],
    sprechen: [...layout.sprechenTeils],
  };
}

/** vocab-bg generates lesen + hören only. */
export function bgModulesForLevel(level = 'B1') {
  const m = generationModulesForLevel(level);
  return { lesen: m.lesen, horen: m.horen };
}

export function moduleTeilsForLevel(module, level = 'B1') {
  const m = generationModulesForLevel(level);
  return m[String(module).toLowerCase()] || [];
}

export function smokeCellsForLevel(level = 'B1') {
  const layout = layoutForLevel(level);
  return [
    ...layout.lesen.map((t) => ({ module: 'lesen', teil: t })),
    ...layout.horen.map((t) => ({ module: 'horen', teil: t })),
    ...layout.schreibenTeils.map((t) => ({ module: 'schreiben', teil: t })),
    ...layout.sprechenTeils.map((t) => ({ module: 'sprechen', teil: t })),
  ];
}
