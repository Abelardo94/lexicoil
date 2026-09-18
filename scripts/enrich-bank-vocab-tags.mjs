#!/usr/bin/env node
/**
 * Fill vocabularyTags (questions) and passageVocab (passages) in a question bank.
 * Usage: node scripts/enrich-bank-vocab-tags.mjs --lang de --level B1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { extractVocabularyFromText } from './lib/enrichBatchMetadata.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Lemmatizer = require(path.join(ROOT, 'js/engine/validation/lemmatizer.js'));

const STOP = new Set([
  'sein', 'haben', 'werden', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem',
  'und', 'oder', 'aber', 'nicht', 'auch', 'sie', 'er', 'es', 'wir', 'ihr', 'ich', 'du', 'man', 'mit', 'von',
  'zu', 'auf', 'in', 'an', 'für', 'bei', 'nach', 'vor', 'über', 'unter', 'durch', 'als', 'wenn', 'weil', 'dass',
  'ob', 'so', 'noch', 'nur', 'schon', 'sehr', 'mehr', 'kann', 'können', 'muss', 'müssen', 'soll', 'sollen',
  'will', 'wollen', 'wird', 'wurde', 'worden', 'hat', 'hatte', 'sind', 'war', 'waren', 'wurden', 'könnte',
  'müsste', 'dieser', 'diese', 'dieses', 'jeder', 'jede', 'alle', 'viel', 'wenig', 'gut', 'neu', 'alt',
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const lang = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'de';
  const level = args.includes('--level') ? args[args.indexOf('--level') + 1] : 'B1';
  const dry = args.includes('--dry');
  return { lang, level, dry };
}

function loadB1LemmaSet(lang, level) {
  const file = path.join(ROOT, 'library', 'vocab', lang, `${level}.json`);
  if (!fs.existsSync(file)) return new Set();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Set((data.lemmas || []).map((w) => String(w).toLowerCase()));
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-zäöüß\-]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function lemmaOf(token, lang) {
  const low = token.toLowerCase();
  if (STOP.has(low)) return null;
  const lem = Lemmatizer.normalizeLemma(low, lang);
  if (!lem || STOP.has(lem)) return null;
  return lem;
}

function scoreLemma(lemma, b1Set) {
  if (!lemma || lemma.length < 3) return -1;
  if (STOP.has(lemma)) return -1;
  if (lemma.length < 4 && !['gehen', 'essen', 'lesen', 'hoen', 'fahren', 'stehen'].includes(lemma)) return -1;
  let score = lemma.length >= 6 ? 2 : 1;
  if (b1Set.has(lemma)) score += 3;
  return score;
}

function extractFromText(text, lang, b1Set, max) {
  // Shared DE pipeline (v2 lemma/caps); other langs keep legacy path
  if (String(lang || 'de').toLowerCase().startsWith('de')) {
    return extractVocabularyFromText(text, max).map((w) => String(w));
  }
  const scored = new Map();
  for (const tok of tokenize(text)) {
    const lemma = lemmaOf(tok, lang);
    if (!lemma) continue;
    const s = scoreLemma(lemma, b1Set);
    if (s < 0) continue;
    const prev = scored.get(lemma) || 0;
    if (s > prev) scored.set(lemma, s);
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([w]) => w);
}

function passageById(bank) {
  const map = new Map();
  (bank.passages || []).forEach((p) => map.set(p.id, p));
  return map;
}

function enrichPassages(bank, lang, b1Set) {
  let updated = 0;
  for (const p of bank.passages || []) {
    if ((p.passageVocab || []).length >= 10) continue;
    const words = extractFromText(p.text, lang, b1Set, 20);
    if (words.length < 3) {
      const fallback = tokenize(p.text)
        .map((t) => lemmaOf(t, lang))
        .filter(Boolean)
        .filter((w, i, a) => a.indexOf(w) === i);
      if (fallback.length >= 3) p.passageVocab = fallback.slice(0, 10);
      continue;
    }
    p.passageVocab = words.length >= 10 ? words : words.concat(
      tokenize(p.text)
        .map((t) => lemmaOf(t, lang))
        .filter(Boolean)
        .filter((w) => !words.includes(w)),
    ).slice(0, 10);
    updated++;
  }
  return updated;
}

const OPTION_KEY_RE = /^\s*([A-Za-z])\s*[).\-:\]]/;

/**
 * En matching (Teil 3) las opciones son los anuncios del bloque ENTERO: las ocho
 * o diez son identicas para todas las preguntas del bloque. Solo la correcta
 * pertenece a esta pregunta; las demas son ruido compartido.
 */
function matchingAnswerText(q) {
  const key = String(q.correct ?? q.correctAnswer ?? '').trim().toUpperCase();
  if (!key) return null;
  for (const opt of q.options || []) {
    const text = typeof opt === 'string' ? opt : opt?.text;
    if (!text) continue;
    const m = OPTION_KEY_RE.exec(text);
    if (m && m[1].toUpperCase() === key) return text;
  }
  return null;
}

function enrichQuestions(bank, lang, b1Set) {
  const passages = passageById(bank);
  let updated = 0;
  for (const q of bank.questions || []) {
    if ((q.vocabularyTags || []).length >= 3) continue;
    const passage = passages.get(q.passageId);

    // Primero, solo lo que distingue a ESTA pregunta de sus hermanas.
    const own = [q.question, q.transcript, q.signText];
    if (q.type === 'matching') {
      const answer = matchingAnswerText(q);
      if (answer) own.push(answer);
    } else {
      (q.options || []).forEach((o) => own.push(typeof o === 'string' ? o : o?.text));
    }
    const words = extractFromText(own.filter(Boolean).join(' '), lang, b1Set, 8);

    // El pasaje solo desempata. Metido en el blob principal gana por volumen y
    // todas las preguntas que cuelgan de el acaban con los mismos tags.
    if (words.length < 3) {
      const context = [passage?.text, ...(passage?.passageVocab || [])]
        .filter(Boolean)
        .join(' ');
      for (const w of extractFromText(context, lang, b1Set, 8)) {
        if (words.length >= 3) break;
        if (!words.includes(w)) words.push(w);
      }
    }

    if (words.length < 3) continue;
    q.vocabularyTags = words.slice(0, 6);
    updated++;
  }
  return updated;
}

function syncPassagesFile(bankPath, bank) {
  const passagesPath = bankPath.replace('questions.json', 'passages.json');
  const out = {
    meta: {
      language: bank.meta?.language || bank.meta?.lang,
      level: bank.meta?.level,
      version: bank.meta?.version || 1,
      generatedAt: new Date().toISOString().slice(0, 10),
    },
    passages: (bank.passages || []).map(({ id, module, title, text, passageVocab, teil }) => ({
      id,
      module,
      ...(teil != null ? { teil } : {}),
      title,
      text,
      passageVocab: passageVocab || [],
    })),
  };
  fs.writeFileSync(passagesPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

function main() {
  const { lang, level, dry } = parseArgs();
  const bankPath = path.join(ROOT, 'library', lang, level, 'questions.json');
  if (!fs.existsSync(bankPath)) {
    console.error(`Bank not found: ${bankPath}`);
    process.exit(1);
  }
  const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
  const b1Set = loadB1LemmaSet(lang, level);
  const pCount = enrichPassages(bank, lang, b1Set);
  const qCount = enrichQuestions(bank, lang, b1Set);
  console.log(`Enriched ${pCount} passages, ${qCount} questions (${lang}/${level})`);
  if (dry) return;
  if (pCount + qCount > 0) {
    const backup = bankPath.replace('.json', `.backup-${Date.now()}.json`);
    fs.copyFileSync(bankPath, backup);
    console.log(`Backup: ${backup}`);
    bank.meta = bank.meta || {};
    bank.meta.version = (bank.meta.version || 1) + 1;
    bank.meta.generatedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(bankPath, `${JSON.stringify(bank, null, 2)}\n`, 'utf8');
  }
  syncPassagesFile(bankPath, bank);
  const qs = bank.questions || [];
  const ps = bank.passages || [];
  const qFilled = qs.filter((q) => (q.vocabularyTags || []).length >= 3).length;
  const pFilled = ps.filter((p) => (p.passageVocab || []).length >= 10).length;
  console.log(`Coverage: ${qFilled}/${qs.length} questions, ${pFilled}/${ps.length} passages`);
}

main();
