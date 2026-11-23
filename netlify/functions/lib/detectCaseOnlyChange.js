'use strict';

/**
 * Detect case-only edits and build changeSpans + capitalization proposal hints.
 */

const { onlyCaseChange } = require('./extractLearningFromCorrection.js');

const WORD_RE = /[\p{L}\p{M}]+(?:[''][\p{L}\p{M}]+)*/gu;
const CONTEXT_RADIUS = 40;

function normalizeWs(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function contextWindow(text, start, end) {
  const t = String(text || '');
  const before = t.slice(Math.max(0, start - CONTEXT_RADIUS), start);
  const after = t.slice(end, Math.min(t.length, end + CONTEXT_RADIUS));
  return { before, after };
}

function tokenizeWithIndex(text) {
  const t = String(text || '');
  const tokens = [];
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(t)) !== null) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function inferCapAction(oldWord, newWord) {
  const o = String(oldWord);
  const n = String(newWord);
  if (o.toLowerCase() !== n.toLowerCase()) return null;
  const oldCap = o[0] === o[0]?.toUpperCase();
  const newCap = n[0] === n[0]?.toUpperCase();
  if (!oldCap && newCap) return 'CAP';
  if (oldCap && !newCap) return 'DECAP';
  return 'CASE';
}

/**
 * @param {unknown} oldValue
 * @param {unknown} newValue
 * @returns {{ caseOnly: boolean, spans: object[] }}
 */
function detectChangeSpans(oldValue, newValue) {
  const oldT = typeof oldValue === 'string' ? oldValue : normalizeWs(String(oldValue ?? ''));
  const newT = typeof newValue === 'string' ? newValue : normalizeWs(String(newValue ?? ''));

  if (!onlyCaseChange(oldT, newT)) {
    return { caseOnly: false, spans: [] };
  }

  const oldTok = tokenizeWithIndex(oldT);
  const newTok = tokenizeWithIndex(newT);
  const spans = [];

  const n = Math.min(oldTok.length, newTok.length);
  for (let i = 0; i < n; i++) {
    const o = oldTok[i];
    const nv = newTok[i];
    if (o.word === nv.word) continue;
    if (o.word.toLowerCase() !== nv.word.toLowerCase()) {
      return { caseOnly: false, spans: [] };
    }
    const action = inferCapAction(o.word, nv.word);
    if (!action) continue;
    const ctx = contextWindow(oldT, o.start, o.end);
    spans.push({
      start: o.start,
      end: o.end,
      oldSurface: o.word,
      newSurface: nv.word,
      lemma: o.word.toLowerCase(),
      action,
      contextBefore: ctx.before,
      contextAfter: ctx.after,
      contextPattern: `${ctx.before}[${o.word}]${ctx.after}`.slice(0, 200),
    });
  }

  if (oldTok.length !== newTok.length) {
    return { caseOnly: false, spans: [] };
  }

  if (!spans.length && oldT !== newT) {
    spans.push({
      start: 0,
      end: oldT.length,
      oldSurface: oldT.slice(0, 80),
      newSurface: newT.slice(0, 80),
      lemma: oldT.slice(0, 40).toLowerCase(),
      action: 'CASE',
      contextBefore: '',
      contextAfter: '',
      contextPattern: oldT.slice(0, 120),
    });
  }

  return { caseOnly: spans.length > 0 || oldT !== newT, spans };
}

module.exports = {
  detectChangeSpans,
  CONTEXT_RADIUS,
};
