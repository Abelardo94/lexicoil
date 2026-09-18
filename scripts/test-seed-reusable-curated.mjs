#!/usr/bin/env node
/**
 * Seed path + blueprint resolution — curated seeder must follow --lang/--level.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  comboKey,
  examsFileFor,
  loadBlueprintForCombo,
  requiredPartKeys,
} from './lib/seedReusableCommon.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assert(label, cond) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
  console.log('OK:', label);
}

assert('de/B1 exams path', examsFileFor('de', 'B1').endsWith(`${path.sep}data${path.sep}exams${path.sep}de_B1.json`));
assert('en/B1 exams path', examsFileFor('en', 'B1').endsWith(`${path.sep}data${path.sep}exams${path.sep}en_B1.json`));
assert('es/B1 exams path', examsFileFor('es', 'B1').endsWith(`${path.sep}data${path.sep}exams${path.sep}es_B1.json`));

assert('de/B1 exams file exists', fs.existsSync(examsFileFor('de', 'B1')));
const deExams = JSON.parse(fs.readFileSync(examsFileFor('de', 'B1'), 'utf8'));
// Eran 12 cuando se escribio el test y hoy hay 19: el numero fijo se rompia sola vez que
// se anadia un examen. Se afirma el invariante, no el censo.
assert('de/B1 tiene al menos los 12 examenes de base', deExams.length >= 12);
assert('de/B1 sin ids repetidos', new Set(deExams.map((e) => e.id)).size === deExams.length);
assert(
  'todos los examenes de/B1 traen los 4 modulos completos',
  deExams.every(
    (e) =>
      (e.lesenParts || []).length === 5 &&
      (e.horenParts || []).length === 4 &&
      (e.schreibenParts || []).length === 3 &&
      (e.sprechenParts || []).length === 3,
  ),
);

const deBp = loadBlueprintForCombo('de', 'B1');
assert('de/B1 blueprint is goethe', deBp.examType === 'goethe');
const deKeys = requiredPartKeys(deBp);
assert('de/B1 has 5 lesen teile', deKeys.filter((k) => k.startsWith('lesen:')).length === 5);
assert('de/B1 has 4 horen teile', deKeys.filter((k) => k.startsWith('horen:')).length === 4);

const enBp = loadBlueprintForCombo('en', 'B1');
assert('en/B1 blueprint is cambridge', enBp.examType === 'cambridge');
const enKeys = requiredPartKeys(enBp);
assert('en/B1 has 6 lesen teile', enKeys.filter((k) => k.startsWith('lesen:')).length === 6);

const esBp = loadBlueprintForCombo('es', 'B1');
assert('es/B1 blueprint is dele', esBp.examType === 'dele');

assert('en/B1 combo key', comboKey('en', 'B1') === 'en_B1');

console.log('\nseed-reusable curated path tests passed.');
