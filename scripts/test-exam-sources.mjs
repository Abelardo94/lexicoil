/**
 * Unit tests: exam source cascade ordering + validateExamCandidate helper.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(import.meta.url);
const {
  CASCADE_ORDER,
  fromPool,
  fromQuestionLibrary,
  fromExamLibrary,
  runExamSourceCascade,
} = require('../js/ui/exam/examSources.js');
const { validateExamCandidate } = require('../js/ui/exam/examValidation.js');

const SAMPLE_EXAM = {
  goetheFormat: true,
  lang: 'de',
  level: 'B1',
  lesenParts: [{ teil: 1, items: [{ id: 'l1', signText: 'Text', question: 'Q?', options: ['a', 'b'], correct: 0 }] }],
  horenParts: [{ teil: 1, segments: [{ id: 'h1', transcript: 'Hi', question: 'Q?', options: ['a', 'b'], correct: 0 }] }],
};

function mockDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      fetchExamFromPool: async () => null,
      QuestionLibrary: null,
      ExamLibrary: null,
      normalizeExam: (x) => x,
      validateExamCandidate: (raw) => ({ ok: true, normalized: raw }),
      isExamRenderable: () => true,
      lcStrategyBEnabled: () => false,
      setLoaderStep: (...args) => calls.push(['setLoaderStep', ...args]),
      lcDebug: { warn: () => {} },
      ...overrides,
    },
  };
}

assert.deepEqual(CASCADE_ORDER, ['pool', 'questionLibrary', 'examLibrary'], 'cascade order fixed');

// validateExamCandidate — null input
{
  global.normalizeExam = undefined;
  global.isExamRenderable = undefined;
  global.lcExamPassesValidator = undefined;
  assert.deepEqual(validateExamCandidate(null), { ok: false, normalized: null });
}

// validateExamCandidate — renderable check
{
  global.isExamRenderable = () => false;
  global.lcExamPassesValidator = () => true;
  const r = validateExamCandidate(SAMPLE_EXAM, { normalized: SAMPLE_EXAM });
  assert.equal(r.ok, false);
  global.isExamRenderable = () => true;
  global.lcExamPassesValidator = () => true;
  const ok = validateExamCandidate(SAMPLE_EXAM, { normalized: SAMPLE_EXAM });
  assert.equal(ok.ok, true);
}

// pool wins over library
{
  const { deps } = mockDeps({
    fetchExamFromPool: async () => ({ found: true, exam: SAMPLE_EXAM, topic: 'Pool topic', id: 'p1' }),
    QuestionLibrary: {
      hasLibrary: () => true,
      buildExam: async () => {
        throw new Error('should not reach question library');
      },
    },
    ExamLibrary: {
      hasLibrary: () => true,
      pickExam: async () => {
        throw new Error('should not reach exam library');
      },
    },
  });
  const hit = await fromPool({ subject: 'de', level: 'B1', seenIds: [] }, deps);
  assert.equal(hit.source, 'pool');
  assert.equal(hit.topic, 'Pool topic');
}

// question library when pool empty
{
  const { deps } = mockDeps({
    QuestionLibrary: {
      hasLibrary: () => true,
      buildExam: async () => ({ ...SAMPLE_EXAM, topic: 'QL topic' }),
    },
  });
  const hit = await fromQuestionLibrary({ subject: 'de', level: 'B1' }, deps);
  assert.equal(hit.source, 'question-library');
}

// strategy B uses question library for servable levels; blocks AI when all sources miss
{
  let qlCalled = false;
  const { deps } = mockDeps({
    lcStrategyBEnabled: () => true,
    QuestionLibrary: {
      hasLibrary: () => true,
      buildExam: async () => {
        qlCalled = true;
        return { ...SAMPLE_EXAM, topic: 'QL topic' };
      },
    },
    ExamLibrary: { hasLibrary: () => false },
  });
  const cascade = await runExamSourceCascade({ subject: 'de', level: 'B1', seenIds: [] }, deps);
  assert.equal(qlCalled, true);
  assert.equal(cascade.status, 'hit');
}

// strategy B blocks when servable but no source hit
{
  const { deps } = mockDeps({
    lcStrategyBEnabled: () => true,
    QuestionLibrary: { hasLibrary: () => false },
    ExamLibrary: { hasLibrary: () => false },
  });
  const cascade = await runExamSourceCascade({ subject: 'de', level: 'B1', seenIds: [] }, deps);
  assert.equal(cascade.status, 'blocked');
}

// A2 goes through the same cascade as any other level: the curatedOnly concept
// was retired on 21 Sep 2026, so pool and question library are no longer skipped.
{
  process.chdir(ROOT);
  const LevelAvailability = require(path.join(ROOT, 'js/library/levelAvailability.js'));
  global.LevelAvailability = LevelAvailability;
  assert.equal(LevelAvailability.isCuratedOnlyLevel, undefined, 'curatedOnly concept retired');
  let poolCalled = false;
  const { deps } = mockDeps({
    fetchExamFromPool: async () => {
      poolCalled = true;
      return { found: true, exam: SAMPLE_EXAM, topic: 'Pool', id: 'p1' };
    },
    QuestionLibrary: {
      hasLibrary: () => true,
      buildExam: async () => ({ ...SAMPLE_EXAM, topic: 'QL' }),
    },
    ExamLibrary: {
      hasLibrary: () => true,
      pickExam: async () => ({ ...SAMPLE_EXAM, topic: 'Static A2' }),
    },
  });
  const cascade = await runExamSourceCascade({ subject: 'de', level: 'A2', seenIds: [] }, deps);
  assert.equal(poolCalled, true, 'A2 now reaches the pool like any level');
  assert.equal(cascade.status, 'hit');
  assert.equal(cascade.result.source, 'pool');
}

console.log('OK   exam source cascade ordering');
console.log('OK   validateExamCandidate helper');
console.log('All examSources tests passed.');
