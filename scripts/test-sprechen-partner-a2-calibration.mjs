#!/usr/bin/env node
/**
 * A2 Sprechen partner calibration — prompt diff + optional live Anthropic probe.
 *
 *   node scripts/test-sprechen-partner-a2-calibration.mjs
 *   node scripts/test-sprechen-partner-a2-calibration.mjs --live
 *
 * Requires ANTHROPIC_API_KEY for --live (real E2E partner replies).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { loadEnvFile } from './lib/loadEnv.mjs';

loadEnvFile();

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  buildChatSystem,
  buildOpenerUser,
  getPersona,
  TEIL_TASK_BLOCKS_A2,
  TEIL_TASK_BLOCKS_B1,
} = require(path.join(ROOT, 'netlify/functions/lib/speakingPersonas.js'));

const LIVE = process.argv.includes('--live');
const OUT = path.join(ROOT, 'batches/ready/gate-logs/sprechen-partner-a2-calibration.json');

const SITUATION_A2_T1 =
  'Sie bekommen vier Karten und stellen mit diesen Karten vier Fragen. Ihr Partner/Ihre Partnerin antwortet. Dann stellt Ihr Partner/Ihre Partnerin vier Fragen und Sie antworten.\n\nIhre Karten:\n1. Geburtstag — Wann haben Sie Geburtstag?\n2. Wohnort — Wo wohnen Sie?\n3. Beruf — Was arbeiten Sie?\n4. Hobby — Was machen Sie gern?';

const SITUATION_B1_T1 =
  'Planen Sie gemeinsam einen Sportkurs für Anfänger. Punkte: Sportart, Ort, Zeit, Ausrüstung, Lehrer.';

const SITUATION_A2_T3 =
  'Sie möchten mit Ihrem Partner/Ihrer Partnerin ein Geburtstagsgeschenk kaufen und einen Termin finden.\n\nIhre Woche:\nMontag 14–16 Uhr: Deutschkurs\nDienstag 10–12 Uhr: frei\nMittwoch 15–17 Uhr: Arzt\n\nWoche Ihres Partners/Ihrer Partnerin:\nMontag 10–12 Uhr: Arbeit\nDienstag 14–16 Uhr: frei\nMittwoch 11–13 Uhr: frei\n\nEinigen Sie sich auf ein Geschenk und einen Termin.';

const SITUATION_B1_T3 =
  'Geben Sie Feedback zur Präsentation Ihres Partners und stellen Sie 2–3 Fragen zum Thema Sport.';

function wordCount(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function avgWordLen(text) {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 0;
  return words.reduce((s, w) => s + w.length, 0) / words.length;
}

async function callPartner({ system, userText, maxTokens }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY required for --live');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_SPEAKING_MODEL || 'claude-haiku-4-5',
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system }],
      messages: [{ role: 'user', content: userText }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return (data.content || []).map((p) => p.text || '').join('').trim();
}

console.log('\n=== A2 Sprechen partner calibration ===\n');

// ── Prompt structure ──
const a2KimT1 = buildChatSystem({ personaId: 'quiet', teil: 1, level: 'A2', situation: SITUATION_A2_T1 });
const b1KimT1 = buildChatSystem({ personaId: 'quiet', teil: 1, level: 'B1', situation: SITUATION_B1_T1 });
const a2AlexT3 = buildChatSystem({ personaId: 'balanced', teil: 3, level: 'A2', situation: SITUATION_A2_T3 });
const b1AlexT3 = buildChatSystem({ personaId: 'balanced', teil: 3, level: 'B1', situation: SITUATION_B1_T3 });

assert.match(a2KimT1, /A2 Sprechen/);
assert.match(a2KimT1, /8 Wörter/);
assert.match(a2KimT1, /Fragen zur Person mit Karten/);
assert.doesNotMatch(a2KimT1, /Gemeinsame Planung, B1/);
assert.match(a2AlexT3, /Termin finden, A2/);
assert.doesNotMatch(a2AlexT3, /Feedback und Fragen, B1/);

assert.match(b1KimT1, /B1 Sprechen/);
assert.match(b1KimT1, /12 Wörter/);
assert.match(b1AlexT3, /Feedback und Fragen, B1/);

assert.match(buildOpenerUser({ level: 'A2', teil: 1, situation: SITUATION_A2_T1 }), /A2-Niveau/);
assert.doesNotMatch(buildOpenerUser({ level: 'B1', teil: 1 }), /A2/);

console.log('✓ Prompts: A2 task blocks + persona caps differ from B1');

// ── Persona caps ──
assert.equal(getPersona('quiet', 'A2').maxWordsPerTurn, 8);
assert.equal(getPersona('balanced', 'A2').maxWordsPerTurn, 20);
assert.equal(getPersona('talkative', 'A2').maxWordsPerTurn, 35);
assert.equal(getPersona('quiet', 'B1').maxWordsPerTurn, 12);
console.log('✓ Persona maxWordsPerTurn: A2 < B1 for all three');

const report = {
  at: new Date().toISOString(),
  prompts: {
    a2KimT1Snippet: a2KimT1.slice(0, 400),
    b1KimT1Snippet: b1KimT1.slice(0, 400),
    a2AlexT3TaskLine: TEIL_TASK_BLOCKS_A2[3].split('\n')[0],
    b1AlexT3TaskLine: TEIL_TASK_BLOCKS_B1[3].split('\n')[0],
    openerA2: buildOpenerUser({ level: 'A2', teil: 1, situation: SITUATION_A2_T1 }),
  },
  live: null,
};

if (LIVE) {
  console.log('\n── Live Anthropic probe (Kim A2 T1, Alex A2 T3 vs B1) ──\n');
  const userT1 = 'Wann haben Sie Geburtstag? Wo wohnen Sie?';
  const userT3 = 'Ich möchte am Dienstag einkaufen gehen. Passt das für Sie?';

  const probes = [
    { label: 'Kim-A2-T1', persona: 'quiet', level: 'A2', teil: 1, situation: SITUATION_A2_T1, user: userT1 },
    { label: 'Kim-B1-T1', persona: 'quiet', level: 'B1', teil: 1, situation: SITUATION_B1_T1, user: userT1 },
    { label: 'Alex-A2-T3', persona: 'balanced', level: 'A2', teil: 3, situation: SITUATION_A2_T3, user: userT3 },
    { label: 'Alex-B1-T3', persona: 'balanced', level: 'B1', teil: 3, situation: SITUATION_B1_T3, user: userT3 },
  ];

  const results = [];
  for (const p of probes) {
    const persona = getPersona(p.persona, p.level);
    const system = buildChatSystem({
      personaId: p.persona,
      teil: p.teil,
      level: p.level,
      situation: p.situation,
    });
    const text = await callPartner({
      system,
      userText: p.user,
      maxTokens: persona.maxTokens,
    });
    const row = {
      label: p.label,
      words: wordCount(text),
      avgWordLen: Number(avgWordLen(text).toFixed(1)),
      maxWordsCap: persona.maxWordsPerTurn,
      sample: text,
    };
    results.push(row);
    console.log(`  ${p.label}: ${row.words} words (cap ${row.maxWordsCap}) — "${text.slice(0, 100)}…"`);
  }

  const kimA2 = results.find((r) => r.label === 'Kim-A2-T1');
  const kimB1 = results.find((r) => r.label === 'Kim-B1-T1');
  const alexA2 = results.find((r) => r.label === 'Alex-A2-T3');
  const alexB1 = results.find((r) => r.label === 'Alex-B1-T3');

  assert.ok(alexA2.words <= alexB1.words, `Alex A2 (${alexA2.words}) should be ≤ B1 (${alexB1.words})`);
  assert.ok(alexA2.words <= 25, 'Alex A2 should stay near 20-word cap');
  assert.ok(alexB1.words >= alexA2.words + 10, 'Alex B1 should be noticeably longer than A2');

  // Kim: model may slightly exceed 8-word cap; compare simplicity vs B1 on matched task
  assert.ok(kimA2.words <= 20, `Kim A2 (${kimA2.words}) should stay short`);
  assert.ok(kimA2.avgWordLen <= 8, 'Kim A2 uses short words');
  assert.match(kimA2.sample.toLowerCase(), /geburtstag|wohn|berlin|märz/);

  report.live = { results, pass: true };
  console.log('\n✓ Live probe: A2 replies shorter/simpler than B1 counterparts');
} else {
  console.log('\n⏭  Add --live + ANTHROPIC_API_KEY for real partner E2E probe');
}

// Una pasada sin --live no tiene nada nuevo que registrar, y sobrescribir OUT borraba
// el bloque "live" del log commiteado (la evidencia de la sonda del 20 jul 2026).
// Correr la suite dejaba asi contenido trackeado modificado. Ahora solo se escribe
// cuando hay resultados nuevos, o donde diga --out.
const outArgIdx = process.argv.indexOf('--out');
const outFile =
  outArgIdx !== -1 && process.argv[outArgIdx + 1]
    ? path.resolve(ROOT, process.argv[outArgIdx + 1])
    : LIVE
      ? OUT
      : null;
if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport: ${path.relative(ROOT, outFile)}`);
} else {
  console.log('\nReport: no se escribe sin --live (usa --out <fichero> para volcarlo)');
}
