#!/usr/bin/env node
/**
 * Personal Hören runtime — prompts shape, pool fallback, 422 unparseable.
 */
// Este test prueba el pick contra el store simulado. En local
// useLocalSeedInRuntime() es true por defecto y mezcla library/reusable-seed/de_B1.json,
// asi que el sorteo caia entre cientos de partes de disco y la recien anadida casi nunca
// salia. En produccion (NETLIFY=true) el seed local no se mezcla; aqui se fuerza lo mismo.
process.env.POOL_SOURCE = 'blobs';

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { extractJsonObject } = require(path.join(ROOT, 'netlify/functions/lib/proAiModes.js'));
const { addReusablePart, pickReusablePart } = require(path.join(
  ROOT,
  'netlify/functions/lib/reusablePartsStore.js',
));
const {
  horenBlueprintTeils,
  horenExpectedItemCount,
  countHorenPartItems,
  reusablePartToHorenPart,
  stripPoolPartsForIngest,
  insertHorenTeil,
} = require(path.join(ROOT, 'js/engine/personalLesenPoolFallback.js'));
const { loadBlueprintFileSync } = require(path.join(
  ROOT,
  'js/engine/validation/blueprintResolver.js',
));
const BlueprintPromptBinding = require(path.join(
  ROOT,
  'js/engine/prompts/blueprintPromptBinding.js',
));

function assert(label, cond) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
  console.log('OK:', label);
}

/** Igual que assert pero sin imprimir en verde — para comprobaciones dentro de un bucle. */
function assert_quiet(label, cond) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
}

function makeMockStore() {
  const blobs = new Map();
  // Sin getWithMetadata, casWriteJson no obtiene etag, cae a onlyIfNew sobre una clave que
  // ya existe y agota los 5 reintentos: cada pick acababa en el catch en vez de en el
  // camino de CAS. El mock lleva etags para que el test recorra lo que corre en produccion.
  const etags = new Map();
  let seq = 0;
  return {
    async setJSON(key, value, opts = {}) {
      if (opts.onlyIfNew && blobs.has(key)) return { modified: false };
      if (opts.onlyIfMatch && (etags.get(key) ?? null) !== opts.onlyIfMatch) {
        return { modified: false };
      }
      blobs.set(key, value);
      etags.set(key, `etag-${++seq}`);
      return { modified: true };
    },
    async get(key) {
      return blobs.get(key) ?? null;
    },
    async getWithMetadata(key) {
      if (!blobs.has(key)) return null;
      return { data: blobs.get(key), etag: etags.get(key) ?? null };
    },
    async delete(key) {
      blobs.delete(key);
      etags.delete(key);
    },
    async list({ prefix }) {
      const keys = [...blobs.keys()].filter((k) => k.startsWith(prefix));
      return { blobs: keys.map((key) => ({ key })) };
    },
  };
}

function mcq(id, q, correct, passageId) {
  return {
    id,
    type: 'multiple_choice',
    question: q,
    correct,
    passageId,
    options: [
      { key: 'a', text: 'Antwort A.' },
      { key: 'b', text: 'Antwort B.' },
      { key: 'c', text: 'Antwort C.' },
    ],
  };
}

function rf(id, q, correct = 'R', passageId) {
  return { id, type: 'richtig_falsch', question: q, correct, passageId };
}

function matching(id, q, correct) {
  return {
    id,
    type: 'matching',
    question: q,
    correct,
    options: ['a) M', 'b) A', 'c) B'],
  };
}

const goetheBp = loadBlueprintFileSync('goethe_B1');
assert('horen blueprint teils 1-4', horenBlueprintTeils(goetheBp).join(',') === '1,2,3,4');
assert('horen T1 expects 10 items', horenExpectedItemCount(1, goetheBp) === 10);
assert('horen T4 expects 8 items', horenExpectedItemCount(4, goetheBp) === 8);

const horenMod = goetheBp.modules.find((m) => m.id === 'horen');
const horenT1Ctx = {
  expectKey: 'horenParts',
  teil: 1,
  blueprintPart: horenMod.parts[0],
};
const rules = BlueprintPromptBinding.structuredOutputRules(horenT1Ctx);
assert('prompt rules require 5 segments for Hören T1', /EXACTLY 5/.test(rules) && /segments\[\]/.test(rules));

const horenT4Ctx = {
  expectKey: 'horenParts',
  teil: 4,
  blueprintPart: horenMod.parts[3],
};
const rulesT4 = BlueprintPromptBinding.structuredOutputRules(horenT4Ctx);
assert('prompt rules require 8 statements for Hören T4', /EXACTLY 8/.test(rulesT4));

const validT1 = {
  teil: 1,
  instruction: 'Kurze Texte',
  plays: 2,
  segments: Array.from({ length: 5 }, (_, i) => ({
    label: `Aufnahme ${i + 1}`,
    transcript: `Kurzer Hörtext Nummer ${i + 1} mit zwei Sätzen.`,
    questions: [rf(`h${i * 2 + 1}`, `Aussage ${i + 1}?`), mcq(`h${i * 2 + 2}`, `Frage ${i + 1}?`, 'b')],
  })),
};
assert('valid T1 has 5 segments', validT1.segments.length === 5);
assert('valid T1 has 10 items', countHorenPartItems(validT1) === 10);

const badT1 = {
  teil: 1,
  segments: [
    {
      label: 'Aufnahme 1',
      transcript: 'One block.',
      questions: Array.from({ length: 5 }, (_, i) => rf(`x${i}`, `Q${i}?`)),
    },
  ],
};
assert('bad T1 has only 5 items', countHorenPartItems(badT1) === 5);

const validT4 = {
  teil: 4,
  segments: [
    {
      label: 'Diskussion',
      transcript: 'Moderator: Hallo. Frau A: Ja. Herr B: Nein.',
      questions: Array.from({ length: 8 }, (_, i) =>
        matching(String(23 + i), `Wer sagt das? Aussage ${i + 1}.`, ['A', 'B', 'M'][i % 3]),
      ),
    },
  ],
};
assert('valid T4 has 8 items', countHorenPartItems(validT4) === 8);

const store = makeMockStore();
const t1Questions = [];
for (let s = 0; s < 5; s++) {
  const pid = `p-horen-t1-s${s}`;
  t1Questions.push(rf(String(s * 2 + 1), `RF ${s + 1}?`, 'F', pid));
  t1Questions.push(mcq(String(s * 2 + 2), `MC ${s + 1}?`, 'a', pid));
}
await addReusablePart(store, {
  id: 'pool-horen-t1',
  lang: 'de',
  level: 'B1',
  module: 'horen',
  teil: 1,
  passage: {
    text: Array.from({ length: 5 }, (_, i) => `Kurzer Text ${i + 1}.`).join('\n\n'),
  },
  questions: t1Questions,
  complete: true,
  verified: true,
  // partPassesPublishGate exige ademas la marca de SEM-1: complete+verified ya no basta
  // para servir. El fixture es anterior a ese requisito y por eso el pick devolvia null.
  sem1VerifiedAt: '2026-09-18T00:00:00.000Z',
});

const picked = await pickReusablePart(store, 'de', 'B1', 'horen', { teil: 1 });
assert('pick horen teil 1 returns pool id', picked?.id === 'pool-horen-t1');

// El gate al reves: una parte sin verificar por SEM-1 no puede salir servida.
await addReusablePart(store, {
  id: 'pool-horen-t1-sin-sem1',
  lang: 'de',
  level: 'B1',
  module: 'horen',
  teil: 1,
  passage: { text: Array.from({ length: 5 }, (_, i) => `Anderer Text ${i + 1}.`).join('\n\n') },
  questions: t1Questions,
  complete: true,
  verified: true,
});
for (let i = 0; i < 20; i++) {
  const p = await pickReusablePart(store, 'de', 'B1', 'horen', { teil: 1 });
  assert_quiet('parte sin sem1 nunca se sirve', p?.id !== 'pool-horen-t1-sin-sem1');
}
assert('parte sin sem1 nunca se sirve (20 tiradas)', true);
// excludeIds es preferencia, no veto: si al excluir no queda candidato, pickReusablePart
// vuelve sobre los excluidos (reusablePartsStore.js:392). Lo que nunca puede hacer es
// colar la parte que no pasa el gate.
const forzado = await pickReusablePart(store, 'de', 'B1', 'horen', {
  teil: 1,
  excludeIds: ['pool-horen-t1'],
});
assert('excluir la unica servible la devuelve igual, no la no verificada', forzado?.id === 'pool-horen-t1');

const poolT1 = reusablePartToHorenPart(picked.part, goetheBp);
assert('pool T1 converts to 5 segments', poolT1.segments?.length === 5);
assert('pool T1 converts to 10 items', countHorenPartItems(poolT1) === 10);

let exam = {
  lang: 'de',
  level: 'B1',
  goetheFormat: true,
  vocabPersonal: true,
  horenParts: [
    {
      teil: 2,
      instruction: 'T2',
      segments: [
        {
          transcript: 'Monolog.',
          questions: Array.from({ length: 5 }, (_, i) => mcq(String(11 + i), `Q${i}?`, 'a')),
        },
      ],
    },
    {
      teil: 3,
      instruction: 'T3',
      segments: [
        {
          transcript: 'Gespräch.',
          questions: Array.from({ length: 7 }, (_, i) => rf(String(16 + i), `A${i}?`)),
        },
      ],
    },
    {
      teil: 4,
      instruction: 'T4',
      segments: [
        {
          transcript: 'Diskussion.',
          questions: Array.from({ length: 8 }, (_, i) => matching(String(23 + i), `S${i}?`, 'A')),
        },
      ],
    },
  ],
};
insertHorenTeil(exam, poolT1, 1);
exam._teilFromPool = [1];
assert('fallback exam has 4 horen teile', exam.horenParts.length === 4);
assert('_teilFromPool includes 1', exam._teilFromPool.includes(1));
assert('pool T1 marked _fromPool', exam.horenParts.find((p) => Number(p.teil) === 1)?._fromPool);

const ingest = stripPoolPartsForIngest({
  ...exam,
  horenParts: [
    ...exam.horenParts,
    { teil: 99, _fromPool: false, segments: [{ transcript: 'AI', questions: [rf('z1', 'Q?')] }] },
  ],
});
assert('ingest strips pool horen parts', ingest.horenParts?.length === 4);

const chatSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/claude-chat.js'), 'utf8');
assert(
  'claude-chat returns 422 exam_chunk_unparseable',
  chatSrc.includes("error: 'exam_chunk_unparseable'") && chatSrc.includes('jsonResponse(422'),
);

const truncated = '{"horenParts":[{"teil":4,"segments":[{"transcript":"Mod';
assert('extractJsonObject null on truncated horen JSON', extractJsonObject(truncated) === null);

// ── en/B1 (Cambridge) — blueprint-driven counts + pool-first T1/T4 ─────────
const cambridgeBp = loadBlueprintFileSync('cambridge_B1');
assert('en cambridge horen teils 1-4', horenBlueprintTeils(cambridgeBp).join(',') === '1,2,3,4');
assert('cambridge horen T1 expects 7', horenExpectedItemCount(1, cambridgeBp) === 7);
assert('cambridge horen T4 expects 6', horenExpectedItemCount(4, cambridgeBp) === 6);

const enStore = makeMockStore();
const enT1Questions = Array.from({ length: 7 }, (_, i) =>
  mcq(String(i + 1), `Listening Q${i + 1}?`, 'a', `p-en-t1-${i}`),
);
await addReusablePart(enStore, {
  id: 'pool-en-horen-t1',
  lang: 'en',
  level: 'B1',
  module: 'horen',
  teil: 1,
  passage: { text: 'Seven short extracts for B1 Preliminary Part 1.' },
  segments: [
    {
      label: 'Part 1',
      transcript: 'Seven short extracts for B1 Preliminary Part 1.',
      questions: enT1Questions,
    },
  ],
  questions: enT1Questions,
  complete: true,
  verified: true,
  sem1VerifiedAt: '2026-09-18T00:00:00.000Z',
});

const enT4Questions = Array.from({ length: 6 }, (_, i) =>
  matching(String(i + 1), `Speaker match ${i + 1}?`, ['A', 'B', 'C'][i % 3]),
);
await addReusablePart(enStore, {
  id: 'pool-en-horen-t4',
  lang: 'en',
  level: 'B1',
  module: 'horen',
  teil: 4,
  segments: [{ label: 'Discussion', transcript: 'Two speakers discuss plans.', questions: enT4Questions }],
  questions: enT4Questions,
  complete: true,
  verified: true,
  sem1VerifiedAt: '2026-09-18T00:00:00.000Z',
});

const enPickedT1 = await pickReusablePart(enStore, 'en', 'B1', 'horen', { teil: 1 });
assert('en pick horen T1', enPickedT1?.id === 'pool-en-horen-t1');
const enPoolT1 = reusablePartToHorenPart(enPickedT1.part, cambridgeBp);
assert('en pool T1 item count', countHorenPartItems(enPoolT1) === 7);

const enPickedT4 = await pickReusablePart(enStore, 'en', 'B1', 'horen', { teil: 4 });
const enPoolT4 = reusablePartToHorenPart(enPickedT4.part, cambridgeBp);
assert('en pool T4 item count', countHorenPartItems(enPoolT4) === 6);

let enExam = {
  lang: 'en',
  level: 'B1',
  cambridgeFormat: true,
  horenParts: [
    {
      teil: 2,
      segments: [
        {
          transcript: 'Monologue for sentence completion.',
          questions: Array.from({ length: 6 }, (_, i) => mcq(String(i + 1), `Gap ${i + 1}?`, 'a')),
        },
      ],
    },
    {
      teil: 3,
      segments: [
        {
          transcript: 'Conversation.',
          questions: Array.from({ length: 6 }, (_, i) => mcq(String(i + 1), `MC ${i + 1}?`, 'b')),
        },
      ],
    },
  ],
};
insertHorenTeil(enExam, enPoolT1, 1);
insertHorenTeil(enExam, enPoolT4, 4);
enExam._teilFromPool = [1, 4];
enExam.horenParts.sort((a, b) => Number(a.teil) - Number(b.teil));

assert('en exam has 4 horen teile', enExam.horenParts.length === 4);
assert('en pool teils marked', enExam._teilFromPool.join(',') === '1,4');
assert(
  'en horen teile complete',
  enExam.horenParts.every((p) => countHorenPartItems(p) === horenExpectedItemCount(Number(p.teil), cambridgeBp)),
);

// exam-part.js resolves blueprint by lang_level (not hardcoded de/B1)
const examPartSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/exam-part.js'), 'utf8');
assert('exam-part loadBlueprint uses lang_level index', examPartSrc.includes('idx[`${lang}_${level}`]'));

console.log('\nPersonal Hören runtime tests passed.');
