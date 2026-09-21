/**
 * Hash route parsing + level selector servability matrix (de/en × A1–C2).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const routerSrc = fs.readFileSync(path.join(ROOT, 'js/bootstrap/router.js'), 'utf8');

const sandbox = {
  window: { addEventListener: () => {} },
  document: {
    getElementById: () => null,
    addEventListener: () => {},
  },
  history: { replaceState: () => {}, pushState: () => {}, back: () => {} },
  S: { goals: [{ id: 'g1', subject: 'de', level: 'B1', slug: 'de-b1' }], wsTab: 'exams', savedExams: [], history: [] },
  findGoalBySlug: (s) => sandbox.S.goals.find((g) => g.slug === s) || null,
  normalizeWsTab: (t) => (t === 'vocabulary' ? 'vocabulary' : t === 'progress' ? 'progress' : 'exams'),
  getActiveScreenId: () => null,
  gateAppRoute: () => true,
  GoalStore: { slug: (g) => g.slug },
  esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  console,
};
sandbox.window = sandbox;
vm.runInNewContext(routerSrc, sandbox);

const router = sandbox.window.LcRouter;
assert.ok(router, 'LcRouter loaded');

assert.equal(router.normalizeHash('#/goal/de-b1/exams'), '#/goal/de-b1/exams');

const goalExams = router.parseHash('#/goal/de-b1/exams');
assert.equal(goalExams.screen, 'goalWorkspace');
assert.equal(goalExams.tab, 'exams');

const legacy = router.parseHash('#/workspace/de-b1');
assert.equal(legacy.screen, 'goalWorkspace');

const exam = router.parseHash('#/exam/12345');
assert.equal(exam.screen, 'exam');
assert.equal(exam.examId, '12345');

const table = router.routeTable();
assert.ok(table.length >= 12, 'route table covers all screens');

console.log('OK   hash route parsing');
console.log('OK   route table (' + table.length + ' entries)');

// ── Level availability matrix (de/en × A1–C2) ──
process.chdir(ROOT);
const LevelAvailability = require(path.join(ROOT, 'js/library/levelAvailability.js'));
const availPath = path.join(ROOT, 'data/exams/availability.json');
assert.ok(fs.existsSync(availPath), 'data/exams/availability.json missing — run npm run build:availability');
const availability = JSON.parse(fs.readFileSync(availPath, 'utf8'));
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const MATRIX_LANGS = ['de', 'en'];

// Production default: beta flag OFF — only manifest "live" combos are offered.
assert.equal(LevelAvailability.showBetaExamLevels(), false, 'LEXICOIL_SHOW_BETA_LEVELS off by default');
assert.equal(availability.de?.B1?.status, 'live', 'manifest: de B1 is live');
assert.equal(availability.de?.A2?.status, 'live', 'manifest: de A2 is live');
assert.equal(availability.de?.A2?.personalized, true, 'manifest: de A2 personalized on');
assert.equal(availability.de?.B1?.personalized, true, 'manifest: de B1 personalized on');
assert.equal(LevelAvailability.getLevelUiStatus('de', 'B1'), 'ready', 'getLevelUiStatus(de,B1) ready');
assert.equal(LevelAvailability.getLevelUiStatus('de', 'A2'), 'ready', 'getLevelUiStatus(de,A2) ready');
assert.equal(LevelAvailability.isPersonalizedAllowed('de', 'B1'), true, 'de B1 personalized allowed');
assert.equal(LevelAvailability.isPersonalizedAllowed('de', 'A2'), true, 'de A2 personalized allowed');
assert.equal(LevelAvailability.isQuickModuleAllowed('de', 'A2'), true, 'de A2 quick modules allowed');
assert.equal(LevelAvailability.isAiFeatureAllowed('de', 'A2'), true, 'de A2 AI features allowed');
assert.equal(LevelAvailability.isCuratedOnlyLevel, undefined, 'curatedOnly concept retired');
assert.equal(LevelAvailability.poolPreviewLimitFor('de', 'A2'), null, 'de A2 no pool preview cap');
assert.equal(LevelAvailability.isQuickModuleAllowed('de', 'B1'), true, 'de B1 quick modules allowed');
for (const betaLevel of ['A1', 'B2', 'C1', 'C2']) {
  assert.equal(availability.de?.[betaLevel]?.status, 'beta', `manifest: de ${betaLevel} stays beta`);
  assert.equal(LevelAvailability.getLevelUiStatus('de', betaLevel), 'soon', `de ${betaLevel} soon when beta off`);
  assert.equal(LevelAvailability.isExamLevelOffered('de', betaLevel), false, `de ${betaLevel} not offered`);
}
assert.equal(LevelAvailability.isExamLevelOffered('de', 'B1'), true, 'de B1 offered');
assert.equal(LevelAvailability.isExamLevelOffered('de', 'A2'), true, 'de A2 offered');
assert.equal(LevelAvailability.selectableLevels('de').sort().join(','), 'A2,B1', 'A2 and B1 selectable for de');
assert.equal(availability.en?.B1?.status, 'live', 'manifest: en B1 is live');
assert.equal(availability.en?.B1?.personalized, true, 'manifest: en B1 personalized on');
assert.equal(LevelAvailability.getLevelUiStatus('en', 'B1'), 'ready', 'getLevelUiStatus(en,B1) ready');
assert.equal(LevelAvailability.isPersonalizedAllowed('en', 'B1'), true, 'en B1 personalized allowed');
assert.equal(LevelAvailability.isQuickModuleAllowed('en', 'B1'), true, 'en B1 quick modules allowed');
assert.equal(LevelAvailability.isAiFeatureAllowed('en', 'B1'), true, 'en B1 AI features allowed');
assert.equal(LevelAvailability.isExamLevelOffered('en', 'B1'), true, 'en B1 offered');
assert.equal(LevelAvailability.selectableLevels('en').sort().join(','), 'B1', 'B1 selectable for en');

function manifestUiStatus(lang, level) {
  const st = availability[lang]?.[level]?.status || 'hidden';
  if (st === 'live') return 'ready';
  return 'soon';
}

function listLiveCombos(manifest) {
  const live = [];
  for (const lang of ['de', 'en', 'es']) {
    for (const level of LEVELS) {
      if (manifest[lang]?.[level]?.status === 'live') live.push(`${lang}/${level}`);
    }
  }
  return live;
}

function renderProfileLevelCardHtml(lang, code, status, selected) {
  const soon = status === 'soon';
  const sel = !soon && selected;
  const badge = LevelAvailability.levelBadgeHtml(status);
  return `<div class="level-card${sel ? ' selected' : ''}${soon ? ' level-card--soon' : ''}"><div class="lc-code">${code}<span class="level-card__badge">${badge}</span></div>${soon ? '<div class="level-card__hint">Tap to get notified</div>' : ''}</div>`;
}

function renderGoalLevelChipHtml(lang, level, status, selected) {
  const soon = status === 'soon';
  const sel = !soon && selected;
  return `<span class="goal-lvl${sel ? ' sel' : ''}${soon ? ' goal-lvl--soon' : ''}">${level}${soon ? '<small class="goal-lvl-soon">Próximamente</small>' : ''}</span>`;
}

let readyCount = 0;
let soonCount = 0;

for (const lang of MATRIX_LANGS) {
  for (const level of LEVELS) {
    const status = LevelAvailability.getLevelUiStatus(lang, level);
    assert.ok(['ready', 'live', 'soon'].includes(status), `${lang}/${level} has valid UI status`);

    const profileHtml = renderProfileLevelCardHtml(lang, level, status, false);
    const goalHtml = renderGoalLevelChipHtml(lang, level, status, false);

    assert.ok(profileHtml.length > 20, `${lang}/${level} profile card HTML not blank`);
    assert.ok(goalHtml.length > 10, `${lang}/${level} goal chip HTML not blank`);

    if (status === 'soon') {
      soonCount++;
      assert.match(profileHtml, /Próximamente|Coming soon/, `${lang}/${level} soon badge in profile grid`);
      assert.match(goalHtml, /Próximamente/, `${lang}/${level} Próximamente in goal wizard`);
      assert.match(profileHtml, /level-card--soon/, `${lang}/${level} disabled soon styling`);
      assert.equal(LevelAvailability.isLevelSelectable(lang, level), false, `${lang}/${level} not selectable`);
    } else {
      readyCount++;
      assert.doesNotMatch(profileHtml, /level-card--soon/, `${lang}/${level} selectable card not marked soon`);
      assert.equal(LevelAvailability.isLevelSelectable(lang, level), true, `${lang}/${level} selectable`);
    }
  }
}

assert.equal(LevelAvailability.getLevelUiStatus('de', 'B1'), manifestUiStatus('de', 'B1'), 'de B1 matches availability manifest');
assert.equal(LevelAvailability.getLevelUiStatus('de', 'B2'), manifestUiStatus('de', 'B2'), 'de B2 matches availability manifest');
assert.equal(LevelAvailability.getLevelUiStatus('en', 'B1'), manifestUiStatus('en', 'B1'), 'en B1 matches availability manifest');
const liveCombos = listLiveCombos(availability);
assert.ok(liveCombos.length >= 2, `live combos include de/B1 and de/A2 (got: ${liveCombos.join(', ')})`);
assert.ok(liveCombos.includes('de/B1'), 'de/B1 live');
assert.ok(liveCombos.includes('de/A2'), 'de/A2 live');
assert.ok(liveCombos.includes('en/B1'), 'en/B1 live');
assert.ok(readyCount >= liveCombos.length, 'ready count matches live combos');
assert.ok(soonCount >= 1, 'non-servable combos marked soon');

console.log('OK   level matrix de/en × A1–C2 (' + readyCount + ' ready/live, ' + soonCount + ' próximamente)');
console.log('All nav route tests passed.');
