'use strict';

const { normalizeB1Topic } = require('../../../js/data/b1Topics.js');
const { planPersonalModuleAssembly, listTeilCandidates } = require('./personalModuleVocabPlan.js');
const { loadModuleSearchRows, resolveRowPart } = require('./poolSearchCache.js');
const { scorePersonalPartTextMatches } = require('./personalPartTextMatches.js');
const { useLocalSeedInRuntime } = require('./poolSourceMode.js');
const { lemmatizeWords } = require('./passageVocab.js');

/**
 * Admin / ops: per-Teil plan debug against live Blobs (production pool source).
 */
async function buildPersonalPlanProbe(store, opts) {
  const {
    lang = 'de',
    level = 'B1',
    module = 'horen',
    surfaces = [],
    topicTag = null,
    blueprint = null,
  } = opts;
  const userWords = surfaces.map(String).filter(Boolean);
  const lemmas = lemmatizeWords(userWords, lang);
  const mod = String(module).toLowerCase();
  const { rows } = await loadModuleSearchRows(store, lang, level, mod);
  const teils = mod === 'horen' ? [1, 2, 3, 4] : [1, 2, 3, 4, 5];
  const perTeil = {};

  for (const teil of teils) {
    const { candidates, topicRelaxedPool } = await listTeilCandidates(store, lang, level, mod, teil, {
      words: lemmas,
      topicTag,
      excludeIds: [],
      assembleMode: 'practice',
      strictTopic: true,
    });
    const top = [];
    for (const c of candidates.slice(0, 8)) {
      const row = rows.find((r) => r.id === c.id);
      let textMatches = null;
      let textError = null;
      if (!row) textError = 'row_not_found';
      else {
        const part = await resolveRowPart(store, row);
        if (!part) textError = 'part_load_failed';
        else {
          const hit = scorePersonalPartTextMatches(part, userWords, { lang, level });
          textMatches = { count: hit.count, words: hit.words };
        }
      }
      top.push({
        id: c.id,
        indexScore: c.score,
        indexCovered: c.covered,
        topicTag: c.topicTag,
        textMatches,
        textError,
      });
    }
    perTeil[teil] = { topicRelaxedPool, candidateCount: candidates.length, top };
  }

  const plan = await planPersonalModuleAssembly(store, lang, level, mod, {
    words: lemmas,
    userWords,
    topicTag,
    excludeIds: [],
    blueprint,
    verifyText: true,
  });

  return {
    runtime: {
      useLocalSeedInRuntime: useLocalSeedInRuntime(),
      poolSource: useLocalSeedInRuntime() ? 'local_seed+blobs' : 'blobs_only',
    },
    moduleRowCount: rows.length,
    surfacesSent: userWords,
    lemmasForIndex: lemmas,
    perTeil,
    plan: {
      ok: plan.ok,
      reason: plan.reason,
      coveredCount: plan.coveredCount,
      textCoveredCount: plan.textCoveredCount,
      textVerified: plan.textVerified,
      decision: plan.decision,
      topicPass: plan.topicPass,
      picks: plan.picks,
    },
  };
}

module.exports = { buildPersonalPlanProbe };
