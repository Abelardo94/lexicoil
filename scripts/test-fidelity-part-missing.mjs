#!/usr/bin/env node
/**
 * An exam that lacks a Teil must fail with part_missing unless it says it is partial.
 *
 * inferPartialExamDelivery used to call any exam with a missing Teil "partial", and a
 * partial exam skips missing Teile — so part_missing could never fire and an incomplete
 * exam passed validate:fidelity green. Now a missing Teil has to be declared
 * (_partialGen / _sectionPart); whole missing modules are still inferred, because
 * single-module practice exams are legitimately built that way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveBlueprintForLangLevel } from './lib/examPipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { validateExamAgainstBlueprint, inferPartialExamDelivery } = require(
  path.join(ROOT, 'js/engine/validation/blueprintFidelity.js'),
);
const { normalizeExamStructure } = require(
  path.join(ROOT, 'js/engine/validation/normalizeExamStructure.js'),
);

function assert(label, cond) {
  if (!cond) {
    console.error('FAIL', label);
    process.exit(1);
  }
  console.log('OK  ', label);
}

const partMissing = (exam, bp) =>
  validateExamAgainstBlueprint(exam, bp).errors.filter((e) => e.startsWith('part_missing:'));

for (const [lang, level] of [
  ['de', 'B1'],
  ['en', 'B1'],
]) {
  const tag = `${lang}/${level}`;
  const bp = resolveBlueprintForLangLevel(lang, level);
  const served = JSON.parse(fs.readFileSync(path.join(ROOT, `data/exams/${lang}_${level}.json`), 'utf8'));
  const base = normalizeExamStructure(Array.isArray(served) ? served[0] : served.exam || served, { level });
  const clone = () => JSON.parse(JSON.stringify(base));

  assert(`${tag}: served exam is complete, not partial`, !inferPartialExamDelivery(base, bp));
  assert(`${tag}: served exam has no part_missing`, partMissing(base, bp).length === 0);

  const firstMod = bp.modules[0];
  const key = Object.keys(base).find(
    (k) => /Parts$/.test(k) && Array.isArray(base[k]) && base[k].length === (firstMod.parts || []).length,
  );
  const dropped = clone();
  const lost = dropped[key].pop();
  const teil = Number(lost.teil ?? lost.aufgabe);

  assert(`${tag}: one Teil dropped is no longer inferred partial`, !inferPartialExamDelivery(dropped, bp));
  assert(
    `${tag}: one Teil dropped -> part_missing:${String(firstMod.id).toLowerCase()}:teil=${teil}`,
    partMissing(dropped, bp).some((e) => e.endsWith(`:teil=${teil}`)),
  );

  const declared = { ...clone(), _partialGen: true };
  declared[key].pop();
  assert(`${tag}: same gap declared with _partialGen -> tolerated`, partMissing(declared, bp).length === 0);

  const oneModule = clone();
  for (const k of Object.keys(oneModule)) {
    if (/Parts$/.test(k) && k !== key) delete oneModule[k];
  }
  assert(`${tag}: single-module exam still inferred partial`, inferPartialExamDelivery(oneModule, bp));
  assert(`${tag}: single-module exam has no part_missing`, partMissing(oneModule, bp).length === 0);
}
