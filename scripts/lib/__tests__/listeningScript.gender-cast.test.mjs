/**
 * listeningScript.gender-cast.test.mjs
 * Voices follow the speaker's gender, not the order they speak in.
 *
 * Before: the first speaker took voice [0]. All three German voices were male, so every
 * German woman spoke with a man's voice; English dialogues opening with "Man:" gave him
 * Alice. And sentence openers with a colon ("Zum Schluss möchte ich betonen:") were read
 * as speaker labels — the label is stripped before synthesis, so the words were lost.
 *
 * Run: node scripts/lib/__tests__/listeningScript.gender-cast.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const LS = require(path.join(ROOT, 'js/bootstrap/listeningScript.js'));

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  OK   ${desc}`); passed++; }
  else { console.error(`  FAIL ${desc}`); failed++; }
}

// Las listas salen del modulo, no de una copia: este test comprueba que el reparto
// respeta el GENERO, no que las voces sean unas concretas. Al pasar el aleman a voces
// nativas (22 sep 2026) la copia cableada que habia aqui puso 5 comprobaciones en rojo
// sin que el reparto tuviera nada malo.
const FEMALE = {};
const MALE = {};
for (const lang of ['de', 'en']) {
  const t = LS.voicesByGender(lang);
  if (!t) throw new Error(`Sin tabla de voces por genero para ${lang}`);
  if (!t.f.length || !t.m.length) throw new Error(`Tabla de ${lang} incompleta: f=${t.f.length} m=${t.m.length}`);
  const solapan = t.f.filter((v) => t.m.includes(v));
  if (solapan.length) throw new Error(`${lang}: voz en los dos generos: ${solapan.join(', ')}`);
  FEMALE[lang] = new Set(t.f);
  MALE[lang] = new Set(t.m);
}
const voiceOf = (segs, sp) => segs.find((s) => s.speaker === sp)?.voice;

// ── gender, not order ──────────────────────────────────────────────────────
const en = LS.prepare('Man: Are you coming?\nWoman: Yes, I am.\nMan: Great.', 'en');
assert('EN "Man" first still gets a male voice', MALE.en.has(voiceOf(en, 'Man')));
assert('EN "Woman" gets a female voice', FEMALE.en.has(voiceOf(en, 'Woman')));

const de = LS.prepare('Anna: Hallo Tim.\nTim: Hallo Anna.\nSophie: Und ich?', 'de');
assert('DE Anna gets a female voice', FEMALE.de.has(voiceOf(de, 'Anna')));
assert('DE Sophie gets a female voice, not Anna\'s', FEMALE.de.has(voiceOf(de, 'Sophie')) && voiceOf(de, 'Sophie') !== voiceOf(de, 'Anna'));
assert('DE Tim gets a male voice', MALE.de.has(voiceOf(de, 'Tim')));

const titles = LS.prepare('Frau Keller: Guten Tag.\nHerr Brandt: Guten Tag.', 'de');
assert('DE "Frau …" female, "Herr …" male', FEMALE.de.has(voiceOf(titles, 'Frau Keller')) && MALE.de.has(voiceOf(titles, 'Herr Brandt')));

const decorated = ['● MARC', '«Lena', 'Lena (Tochter, 12 Jahre)', 'Moderator Müller', 'Moderatorin'];
assert('decorated labels read', decorated.map((l) => LS.speakerGender(l)).join(',') === 'm,f,f,m,f');

// ── single labelled turn ───────────────────────────────────────────────────
const single = LS.prepare('Man: It is freezing outside today!', 'en');
assert('single "Man:" turn is male and label-free', single.length === 1 && MALE.en.has(single[0].voice) && !/^Man/.test(single[0].text));

// ── sentence openers are not speakers ──────────────────────────────────────
const mod = LS.prepare('Moderator: Heute diskutieren wir: Homeoffice.\nAnna: Gut.\nModerator: Zum Schluss möchte ich betonen: Danke.', 'de');
const spoken = mod.map((s) => s.text).join(' ');
assert('"Heute diskutieren wir:" stays in the spoken text', spoken.includes('Heute diskutieren wir'));
assert('"Zum Schluss möchte ich betonen:" stays in the spoken text', spoken.includes('Zum Schluss möchte ich betonen'));
assert('no speaker named after a sentence opener', !mod.some((s) => /Heute|Zum Schluss/.test(s.speaker)));

// ── all real content: no clashes, no cross-gender casting ─────────────────
function horenTexts(lang) {
  const out = [];
  const exams = (() => {
    const dir = path.join(ROOT, 'library/published-exams', lang, 'B1');
    if (fs.existsSync(dir)) return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return j.exam || j; });
    return JSON.parse(fs.readFileSync(path.join(ROOT, `data/exams/${lang}_B1.json`), 'utf8'));
  })();
  for (const ex of exams) for (const p of ex.horenParts || []) {
    if (p.segments?.length) p.segments.forEach((s) => out.push(s.transcript || s.text || ''));
    else out.push(p.transcript || p.text || '');
  }
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, `library/reusable-seed/${lang}_B1.json`), 'utf8'));
  for (const r of (seed.records || seed).filter((x) => x.module === 'horen')) {
    if (r.segments?.length) r.segments.forEach((s) => out.push(s.transcript || s.text || ''));
    else out.push(r.passage?.transcript || r.passage?.text || '');
  }
  return out.filter(Boolean);
}
for (const lang of ['de', 'en']) {
  let clashes = 0, wrong = 0, dialogues = 0;
  for (const t of horenTexts(lang)) {
    const segs = LS.prepare(t, lang);
    const bySpeaker = {};
    for (const s of segs) bySpeaker[s.speaker] = s.voice;
    const speakers = Object.keys(bySpeaker);
    if (speakers.length > 1) {
      dialogues++;
      if (new Set(Object.values(bySpeaker)).size < speakers.length) clashes++;
    }
    for (const sp of speakers) {
      const g = LS.speakerGender(sp);
      if (g === 'f' && !FEMALE[lang].has(bySpeaker[sp])) wrong++;
      if (g === 'm' && !MALE[lang].has(bySpeaker[sp])) wrong++;
    }
  }
  assert(`${lang}: ${dialogues} dialogues, none with two speakers on one voice`, dialogues > 0 && clashes === 0);
  assert(`${lang}: every speaker with a known gender gets a voice of that gender`, wrong === 0);
}

console.log(`\nlisteningScript gender-cast: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
