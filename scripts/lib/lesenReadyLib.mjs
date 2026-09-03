/**
 * Lesen parts that pass POOL-2 + calidad + léxico (exam-ready).
 * Source of truth: batches/generated/ · mirror: batches/ready/lesen/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBatch } from './normalizeBatch.mjs';
import { validatePart } from './partGate.mjs';
import { buildLesenSeedRecordFromBatch } from './publishToPool.mjs';
import { checkLesenBatchQuality } from './lesenBatchQuality.mjs';
import { checkLexical } from './lexicalCheck.mjs';
import { isPartPoolReady } from '../audit-pass-2.mjs';
import { extractStructuralMold } from './structuralMoldDedup.mjs';
import { GENERATED_DIR, POOL_FILE } from './batchPaths.mjs';
import { ROOT } from './loadEnv.mjs';

export { GENERATED_DIR, ROOT };

export function parseLesenTeil(filename) {
  const tPart = filename.replace(/\.json$/i, '').split('-').find((p) => /^t\d$/i.test(p));
  return tPart ? Number(tPart.slice(1)) : null;
}

export async function discoverPool2ReadyLesen(generatedDir = GENERATED_DIR) {
  const poolIds = new Set();
  if (fs.existsSync(POOL_FILE)) {
    const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    for (const r of pool.records || pool) if (r?.id) poolIds.add(r.id);
  }
  const byTeil = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  if (!fs.existsSync(generatedDir)) return byTeil;

  for (const file of fs.readdirSync(generatedDir).sort()) {
    if (!/^lesen-t[1-5]-/i.test(file) || !file.endsWith('.json') || file.startsWith('.')) continue;
    const teil = parseLesenTeil(file);
    if (!teil) continue;
    const id = file.replace(/\.json$/i, '');
    if (poolIds.has(id)) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(generatedDir, file), 'utf8'));
    const batch = normalizeBatch(raw, { module: 'lesen', teil, lang: 'de', level: 'B1' });
    const vGate = await validatePart(batch, {
      semantic: false,
      skipSem2: true,
      skipNormalize: true,
      skipDedup: true,
      module: 'lesen',
      teil,
      lang: 'de',
      level: 'B1',
      structuralCorpusDir: generatedDir,
    });
    if (vGate.ok) byTeil[teil].push(file);
  }
  return byTeil;
}

export async function auditLesenPart(file, teil, generatedDir = GENERATED_DIR) {
  const raw = JSON.parse(fs.readFileSync(path.join(generatedDir, file), 'utf8'));
  const batch = normalizeBatch(raw, { module: 'lesen', teil, lang: 'de', level: 'B1' });
  const qual = checkLesenBatchQuality(batch, teil);
  const lex = checkLexical(batch);
  const vGate = await validatePart(batch, {
    semantic: false,
    skipSem2: true,
    skipNormalize: true,
    skipDedup: true,
    module: 'lesen',
    teil,
    lang: 'de',
    level: 'B1',
    structuralCorpusDir: null,
  });
  const record = buildLesenSeedRecordFromBatch(batch, { lang: 'de', level: 'B1', teil, idPrefix: 'audit' });
  record.id = batch.id || file.replace(/\.json$/i, '');
  const poolGate = await isPartPoolReady(record, { semantic: false, skipSem2: true });

  const fails = [];
  if (!qual.ok) fails.push(...qual.issues.slice(0, 2).map((i) => `calidad:${i.slice(0, 80)}`));
  if (!lex.ok) fails.push(...lex.issues.slice(0, 1).map((i) => `lex:${i.slice(0, 80)}`));
  if (!vGate.ok) fails.push(`gate:${vGate.blocking?.[0]?.id}`);
  if (!poolGate.ok) fails.push(`pool:${poolGate.blocking?.[0]?.id}`);

  const perfect = fails.length === 0;
  let opinion = 'SUBIR — pasa todos los filtros';
  if (!perfect) {
    const wordCopy = fails.some((f) => /copia|word|≥3 palabras|mcq_distinct|CHK-28/i.test(f));
    const caps = fails.some((f) => /CHK-14/i.test(f));
    const lexB2 = fails.some((f) => /léxico|lex:|B2|CHK-6/i.test(f));
    const expl = fails.some((f) => /CHK-18|explanation/i.test(f));
    if (wordCopy && [2, 5].includes(teil)) opinion = 'DESCARTAR — word-copy/mcq; más barato regenerar que reparar LLM';
    else if (caps) opinion = 'REPARAR caps (normalizeBatch ya aplicado — si persiste CHK-14, DESCARTAR)';
    else if (lexB2) opinion = 'DESCARTAR — léxico B2+ difícil de arreglar sin regenerar pasaje';
    else if (expl) opinion = 'REPARAR explanation (local) o DESCARTAR si es sistemático';
    else if (fails.some((f) => f.startsWith('calidad'))) opinion = 'DESCARTAR — fallo pedagógico estructural';
    else opinion = 'REVISAR — ' + fails.join('; ');
  }

  return { file, teil, perfect, fails, opinion, mold: extractStructuralMold(batch, teil) };
}

/** Full audit of POOL-2-ready Lesen files in generated/. */
export async function auditAllPool2ReadyLesen(generatedDir = GENERATED_DIR) {
  const pool2 = await discoverPool2ReadyLesen(generatedDir);
  const all = [];
  for (const teil of [1, 2, 3, 4, 5]) {
    for (const file of pool2[teil] || []) {
      if (!fs.existsSync(path.join(generatedDir, file))) continue;
      all.push(await auditLesenPart(file, teil, generatedDir));
    }
  }
  return { pool2, all };
}
