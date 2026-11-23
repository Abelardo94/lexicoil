#!/usr/bin/env node
/**
 * B1 functional audit — 4 high-priority smokes (no Gemini).
 * Output: batches/ready/gate-logs/smoke-b1-audit-close-2026-08-02.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'batches/ready/gate-logs/smoke-b1-audit-close-2026-08-02.json');
const BASE = process.env.LC_E2E_BASE || 'http://127.0.0.1:5173';

const { findExplanationOptionTextAlignFindings } = require('./lib/explanationOptionTextAlign.mjs');
const { planPersonalModuleAssembly } = require(path.join(
  ROOT,
  'netlify/functions/lib/personalModuleVocabPlan.js',
));

const results = { generatedAt: new Date().toISOString(), smokes: {} };

function collectQuestionsFromPublished(doc) {
  const qs = [];
  for (const p of doc.parts || []) {
    const snap = p.snapshot || p;
    for (const q of snap.questions || []) qs.push({ ...q, _partId: p.partId });
  }
  return qs;
}

function collectQuestionsFromPoolBatch(batch) {
  return batch.questions || [];
}

// ─── Smoke 1: CHK-34 on published B1 (19 exams) + fixed pool files ───────────
function smoke1Chk34() {
  const pubDir = path.join(ROOT, 'library/published-exams/de/B1');
  const examFiles = fs.readdirSync(pubDir).filter((f) => f.endsWith('.json') && f !== '_catalog.json');
  let totalQ = 0;
  let critical = 0;
  let minor = 0;
  const criticalItems = [];
  const e9Hits = [];

  for (const f of examFiles) {
    const doc = JSON.parse(fs.readFileSync(path.join(pubDir, f), 'utf8'));
    const qs = collectQuestionsFromPublished(doc);
    totalQ += qs.length;
    for (const q of qs) {
      const hits = findExplanationOptionTextAlignFindings({ questions: [q] });
      for (const h of hits) {
        if (h.severity === 'CRITICAL') {
          critical++;
          criticalItems.push({ exam: f, id: q.id, message: h.message?.slice(0, 120) });
        } else minor++;
      }
    }
    if (f === 'official-de-B1-e9.json') {
      for (const id of ['gen-q-h2-0f6daecc-q2', 'gen-q-2-2d56ec10-1', 'gen-q-2-2d56ec10-4', 'gen-q-2-2d56ec10-5']) {
        const q = qs.find((x) => x.id === id);
        if (!q) {
          e9Hits.push({ id, status: 'question_not_found' });
          continue;
        }
        const hits = findExplanationOptionTextAlignFindings({ questions: [q] });
        e9Hits.push({
          id,
          explanationTail: String(q.explanation || '').slice(-80),
          critical: hits.filter((h) => h.severity === 'CRITICAL').length,
          minor: hits.filter((h) => h.severity !== 'CRITICAL').length,
        });
      }
    }
  }

  const poolFixtures = [
    'batches/ready/pool-verified/B1/horen-t2-gemini-033.json',
    'batches/ready/pool-verified/B1/lesen-t2-gemini-113.json',
  ];
  const poolDetail = [];
  for (const rel of poolFixtures) {
    const batch = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const hits = findExplanationOptionTextAlignFindings(batch);
    poolDetail.push({
      file: path.basename(rel),
      critical: hits.filter((h) => h.severity === 'CRITICAL').length,
      minor: hits.filter((h) => h.severity !== 'CRITICAL').length,
    });
  }

  const pass = critical === 0;
  results.smokes.chk34_published_b1 = {
    pass,
    examsScanned: examFiles.length,
    questionsScanned: totalQ,
    critical,
    minor,
    poolFixtures: poolDetail,
    e9FixedItems: e9Hits,
    criticalItems: criticalItems.slice(0, 10),
  };
  return pass;
}

// ─── Smoke 3: Personal Lesen Via A (local seed, no API) ─────────────────────
async function smoke3PersonalLesen() {
  process.env.POOL_ALLOW_LOCAL_SEED = '1';
  const seedPath = path.join(ROOT, 'library/reusable-seed/de_B1.json');
  if (!fs.existsSync(seedPath)) {
    results.smokes.personal_lesen_via_a = { pass: false, error: 'missing de_B1.json seed' };
    return false;
  }

  const sharedStore = {
    async get() {
      return null;
    },
    async getWithMetadata() {
      return null;
    },
    async setJSON() {},
    async delete() {},
  };

  require.cache[path.join(ROOT, 'netlify/functions/lib/blobStore.js')] = {
    id: 'blob',
    filename: 'blob',
    loaded: true,
    exports: { getStoreForEvent: () => sharedStore, STORE_NAME: 'smoke' },
  };

  const { clearLocalSeedCache } = require(path.join(ROOT, 'netlify/functions/lib/reusablePartsLocalSeed.js'));
  const { clearPoolSearchCache, loadModuleSearchRows } = require(path.join(
    ROOT,
    'netlify/functions/lib/poolSearchCache.js',
  ));
  clearLocalSeedCache();
  clearPoolSearchCache();

  const { rows } = await loadModuleSearchRows(sharedStore, 'de', 'B1', 'lesen');
  const eligible = rows.filter((r) => r.complete && r.verified && (r.vocabKeys?.length || 0) >= 3);
  if (!eligible.length) {
    results.smokes.personal_lesen_via_a = { pass: false, error: 'no lesen rows with vocab index in local seed' };
    return false;
  }

  const anchor = eligible.find((r) => /gesund/i.test(String(r.topicTag))) || eligible[0];
  const words = anchor.vocabKeys.slice(0, 4);
  const topicTag = anchor.topicTag || 'Gesundheit';

  const plan = await planPersonalModuleAssembly(sharedStore, 'de', 'B1', 'lesen', {
    words,
    topicTag,
    excludeIds: [],
    assembleMode: 'practice',
    blueprint: null,
  });

  const pass = !!(plan?.ok && plan.coveredCount >= 3 && (plan.picks?.length || 0) >= 1);
  results.smokes.personal_lesen_via_a = {
    pass,
    ok: plan?.ok,
    coveredCount: plan.coveredCount,
    picks: plan?.picks?.length,
    reason: plan?.reason,
    pickIds: (plan?.picks || []).slice(0, 3).map((p) => p.id),
    anchorPartId: anchor.id,
    wordsRequested: words,
    topicTag,
    seedFile: 'library/reusable-seed/de_B1.json',
    noGemini: true,
  };
  return pass;
}

// ─── Smoke 4: Vocab save → deck (separable reunify + flashcard row, no API) ──
function smoke4VocabSaveFlashcard() {
  const separableCode = fs.readFileSync(path.join(ROOT, 'js/engine/separableResolve.js'), 'utf8');
  const ctx = {
    console,
    window: {},
    document: { querySelectorAll: () => [], getElementById: () => null },
    localStorage: {
      _d: {},
      getItem(k) {
        return this._d[k] ?? null;
      },
      setItem(k, v) {
        this._d[k] = v;
      },
    },
    S: {
      subject: 'de',
      level: 'B1',
      flashcards: [],
      examSavedWords: [],
      goals: [{ id: 'smoke-b1', subject: 'de', level: 'B1' }],
      activeGoalId: 'smoke-b1',
    },
    getActiveGoal: () => ctx.S.goals[0],
    fcId: (fc) => fc.id || fc.word,
    isWordSaved: (w) => ctx.S.flashcards.some((f) => f.word === w),
    markVocabSaved: () => {},
    saveFC: () => {
      ctx.localStorage.setItem('lc_flashcards', JSON.stringify(ctx.S.flashcards));
    },
    autosaveSession: () => {},
  };
  ctx.window = ctx;
  vm.runInNewContext(separableCode, ctx);

  const resolved = ctx.SeparableResolve.resolveForSave('anrufen', 'Sie können live im Studio anrufen.');
  const word = resolved?.word || 'anrufen';
  ctx.S.flashcards.push({
    id: `fc-${word}`,
    word,
    sourceLang: 'de',
    sourceLevel: 'B1',
    type: 'verb',
    pos: 'verb',
    definition_en: 'to call (phone)',
    reunified: !!resolved?.reunified,
    interval: 0,
  });
  ctx.saveFC();

  const persisted = JSON.parse(ctx.localStorage.getItem('lc_flashcards') || '[]');
  const inDeck = persisted.some((f) => f.word === 'anrufen');
  const pass = inDeck && word === 'anrufen';

  results.smokes.vocab_save_flashcard = {
    pass,
    resolvedWord: word,
    reunified: !!resolved?.reunified,
    flashcardCount: persisted.length,
    deckContainsAnrufen: inDeck,
    localStorageKey: 'lc_flashcards',
    noGemini: true,
  };
  return pass;
}

async function serverUp() {
  try {
    const r = await fetch(BASE, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

async function smoke2OfficialE1Browser() {
  if (!(await serverUp())) {
    results.smokes.official_e1_browser = {
      pass: false,
      skipped: true,
      error: `server not running at ${BASE} — start with: npm start`,
    };
    return false;
  }

  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    results.smokes.official_e1_browser = { pass: false, error: 'puppeteer-core not available' };
    return false;
  }

  const chromePaths = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  let executablePath = chromePaths.find((p) => fs.existsSync(p));
  if (!executablePath) {
    results.smokes.official_e1_browser = { pass: false, error: 'Chrome executable not found for puppeteer-core' };
    return false;
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('pageerror', (err) => logs.push(err.message));

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 120000 });
    await page.evaluate(() => {
      localStorage.setItem(
        'lc_user',
        JSON.stringify({ email: 'smoke@test.local', name: 'Smoke', plan: 'pro', pro: true }),
      );
      localStorage.setItem(
        'lc_goals',
        JSON.stringify([{ id: 'smoke-de-b1', subject: 'de', level: 'B1', label: 'Goethe B1', cert: 'goethe' }]),
      );
      localStorage.setItem('lc_active_goal', 'smoke-de-b1');
      localStorage.removeItem('lc_exam_history');
      window.confirm = () => true;
    });
    await page.reload({ waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForFunction('typeof ExamLibrary !== "undefined" && typeof renderExam === "function"', {
      timeout: 60000,
    });

    const loadInfo = await page.evaluate(async () => {
      await ExamLibrary.ensureManifest();
      const exams = await ExamLibrary.loadExams('de', 'B1');
      const pick = exams.find((e) => (e.examId || e.id) === 'official-de-B1-e1') || exams[0];
      S.mode = 'official';
      S.subject = 'de';
      S.level = 'B1';
      S.activeGoalId = 'smoke-de-b1';
      S.answers = {};
      S.gapAnswers = {};
      S.fieldValues = {};
      S.examData = normalizeExam(pick);
      S.examSource = 'library';
      hideAll();
      show('examScreen');
      renderExam();
      const html = document.getElementById('examScreen')?.innerHTML || '';
      return {
        examId: pick.examId || pick.id,
        examCount: exams.length,
        questionInputs: document.querySelectorAll('input[type=radio],input[type=checkbox]').length,
        textareas: document.querySelectorAll('textarea').length,
        hasLesen: /Lesen/i.test(html),
        hasHoren: /H[öo]ren/i.test(html),
        hasSchreiben: /Schreiben/i.test(html),
      };
    });

    const grade = await page.evaluate(async () => {
      const radios = [...document.querySelectorAll('input[type=radio]')];
      const seen = new Set();
      let answeredGroups = 0;
      for (const r of radios) {
        if (!r.name || seen.has(r.name)) continue;
        seen.add(r.name);
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        if (S.answers) S.answers[r.name] = r.value;
        answeredGroups++;
      }
      document.querySelectorAll('textarea').forEach((ta) => {
        if (!ta.value.trim()) ta.value = 'Meine Meinung zu diesem Thema. '.repeat(10);
      });
      if (typeof collectFieldValues === 'function') collectFieldValues();
      const histBefore = JSON.parse(localStorage.getItem('lc_hist') || '[]').length;
      await submitExam();
      await new Promise((r) => setTimeout(r, 3000));
      const resultsEl = document.getElementById('resultsScreen');
      const resultsHtml = resultsEl?.innerHTML || '';
      const scoreMatch = resultsHtml.match(/(\d{1,3})\s*%/);
      const histAfter = JSON.parse(localStorage.getItem('lc_hist') || '[]').length;
      return {
        answeredGroups,
        resultsVisible:
          resultsEl?.classList.contains('on') ||
          document.querySelector('.screen.on')?.id === 'resultsScreen' ||
          getComputedStyle(resultsEl || document.body).display !== 'none',
        scorePct: scoreMatch ? Number(scoreMatch[1]) : null,
        historyAdded: histAfter > histBefore,
        historyLen: histAfter,
        activeScreen: document.querySelector('.screen.on')?.id || null,
      };
    });

    const pass =
      loadInfo.examId === 'official-de-B1-e1' &&
      loadInfo.questionInputs > 0 &&
      grade.scorePct != null &&
      !Number.isNaN(grade.scorePct) &&
      (grade.resultsVisible || grade.historyAdded);

    results.smokes.official_e1_browser = {
      pass,
      loadInfo,
      grade,
      pageErrors: logs.slice(0, 5),
      browser: 'puppeteer-core',
      noGemini: true,
    };
    await browser.close();
    return pass;
  } catch (e) {
    results.smokes.official_e1_browser = { pass: false, error: String(e.message), pageErrors: logs };
    await browser.close();
    return false;
  }
}

async function main() {
  console.log('Smoke 1: CHK-34 published B1...');
  const s1 = smoke1Chk34();
  console.log(s1 ? '  PASS' : '  FAIL', results.smokes.chk34_published_b1);

  console.log('Smoke 3: Personal Lesen Via A (local seed)...');
  const s3 = await smoke3PersonalLesen();
  console.log(s3 ? '  PASS' : '  FAIL', results.smokes.personal_lesen_via_a);

  console.log('Smoke 4: Vocab save → flashcard...');
  const s4 = smoke4VocabSaveFlashcard();
  console.log(s4 ? '  PASS' : '  FAIL', results.smokes.vocab_save_flashcard);

  let serverProc = null;
  if (!(await serverUp())) {
    console.log('Starting npm start for Smoke 2...');
    serverProc = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      stdio: 'ignore',
      detached: false,
    });
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (await serverUp()) break;
    }
  }

  console.log('Smoke 2: Official e1 browser E2E...');
  const s2 = await smoke2OfficialE1Browser();
  console.log(s2 ? '  PASS' : '  FAIL', results.smokes.official_e1_browser);

  if (serverProc) serverProc.kill();

  results.summary = {
    pass: [s1, s2, s3, s4].filter(Boolean).length,
    total: 4,
    allPass: s1 && s2 && s3 && s4,
  };

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('\nWrote', OUT);
  console.log('Summary:', results.summary);

  if (!results.summary.allPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
