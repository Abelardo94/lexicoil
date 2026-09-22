#!/usr/bin/env node
/**
 * Sprint 5 — item calibration smoke tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

require(path.join(ROOT, 'js/library/PassageResolver.js'));
globalThis.PassageResolver = require(path.join(ROOT, 'js/library/PassageResolver.js'));
globalThis.ExamValidator = require(path.join(ROOT, 'js/engine/validation/ExamValidator.js'));
globalThis.ItemCalibration = require(path.join(ROOT, 'js/library/ItemCalibration.js'));

const ItemCalibration = globalThis.ItemCalibration;
const ExamBlueprint = require(path.join(ROOT, 'js/library/ExamBlueprint.js'));
globalThis.ExamBlueprint = ExamBlueprint;
const ExamBuilder = require(path.join(ROOT, 'js/library/ExamBuilder.js'));
const AnalyticsStore = require(path.join(ROOT, 'js/library/AnalyticsStore.js'));

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg);
    process.exit(1);
  }
  console.log('OK  ', msg);
}

ItemCalibration.clearCache();

assert(ItemCalibration.computePValue(7, 10) === 0.7, 'p-value computation');
assert(ItemCalibration.confidenceBand(20) === 'high', 'confidence high at 20');

const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'library/de/B1/questions.json'), 'utf8'));
const priors = ItemCalibration.seedPriorsFromBank(bank, { lang: 'de', level: 'B1' });
assert(Object.keys(priors.items).length === bank.questions.length, 'priors for all bank items');

const { execSync } = await import('node:child_process');
const os = await import('node:os');
// El calibrador escribia sobre library/de/B1/calibration.json del repo: correr la suite
// dejaba contenido trackeado modificado (version 18 -> 21). Se escribe en un temporal y se
// carga de ahi; loadSync compone root + library/<lang>/<level>/calibration.json.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lexicoil-calib-'));
const tmpOut = path.join(tmpRoot, 'library', 'de', 'B1', 'calibration.json');
execSync(
  'node scripts/calibrate-from-usage.mjs --lang de --level B1 --seed-priors '
    + `--usage data/usage/de_B1.sample.json --out "${tmpOut}"`,
  { cwd: ROOT, stdio: 'pipe' },
);

const cal = ItemCalibration.loadSync(fs.readFileSync, tmpRoot, 'de', 'B1');
assert(cal?.items?.l13?.pValue != null, 'merged empirical p-value for l13');
assert(cal.items.l13.attempts >= 5, 'l13 has sample attempts');

const rec = cal.items.l13;
assert(rec.pValue < 0.5, 'l13 empirically harder than prior');

const blueprint = JSON.parse(fs.readFileSync(path.join(ROOT, 'library/blueprints/goethe_B1.json'), 'utf8'));
ExamBlueprint.cacheBlueprint('de', 'B1', blueprint);

const assembledRandom = ExamBlueprint.assemble(bank, blueprint, { calibration: null });
const assembledCal = ExamBlueprint.assemble(bank, blueprint, { calibration: cal });
assert(assembledCal.selected.length === assembledRandom.selected.length, 'calibrated assembly same count');

const exam = ExamBuilder.buildFromBlueprint('de', 'B1', bank, blueprint, { calibration: cal });
assert(exam.lesenParts?.length >= 1, 'calibrated exam builds');

class MemStorage {
  constructor() {
    this.store = {};
  }
  getItem(k) {
    return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null;
  }
  setItem(k, v) {
    this.store[k] = String(v);
  }
}
global.localStorage = new MemStorage();
global.forEachGoetheQ = (d, fn) => {
  d.lesenParts?.forEach((p, pi) => {
    p.questions?.forEach((q) => fn(`lesen_${pi}`, q));
    p.items?.forEach((q, i) => fn(`lesen_${pi}`, { ...q, id: q.id || `item_${i}` }));
  });
};
global.goetheAnswersMatch = (u, c) => String(u || '').toLowerCase() === String(c || '').toLowerCase();

const goal = { id: 'cal_test', subject: 'de', level: 'B1' };
const examData = {
  lesenParts: [{ teil: 1, questions: [{ id: 'ql_l13', question: 'Q?', correct: 'a', teil: 3, grammarTags: [] }] }],
};
AnalyticsStore.recordExamResult(goal, {}, examData, { lesen_0_ql_l13: 'a' });
const profile = AnalyticsStore.getProfile(goal);
assert(profile.itemStats?.l13?.total === 1, 'AnalyticsStore records itemStats');

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\nSprint 5 calibration tests passed.');
