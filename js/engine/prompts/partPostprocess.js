/**
 * partPostprocess — post-proceso DETERMINISTA para secciones generadas por IA,
 * para que salgan con la misma calidad que los exámenes completos.
 *
 *  - balanceAnswerPositions(questions): reparte la opción correcta entre A/B/C…
 *    (evita el "todo B"). Determinista: posición objetivo = i % nº de opciones.
 *  - validateAdsUnique(items): en Teil 3 (matching de anuncios) cada anuncio (clave
 *    distinta de "0") debe usarse como máximo una vez; devuelve los conflictos.
 *
 * Funciona con el formato de la app: options=[{key,text}], correct="B".
 *
 * Option-letter explanation resync: SINGLE SOURCE in explanationOptionResync.js
 * (shared with scripts/lib/balanceMcq.mjs — do not fork the regex list here).
 */

function resolveResyncApi() {
  if (typeof require === 'function') {
    try {
      return require('./explanationOptionResync.js');
    } catch (_) {
      /* browser script tag path */
    }
  }
  if (typeof globalThis !== 'undefined' && globalThis.ExplanationOptionResync) {
    return globalThis.ExplanationOptionResync;
  }
  return null;
}

// All option letters move when the key is moved, so every letter the explanation names has to
// be remapped, not only the key's. Falls back to the key-only resync if a cached older
// explanationOptionResync.js (without the remap) is what the browser loaded.
const partPostprocessRemapLetters = (function () {
  const api = resolveResyncApi();
  if (api && typeof api.remapExplanationOptionLetters === 'function') {
    return (explanation, mapping) => api.remapExplanationOptionLetters(explanation, mapping);
  }
  if (api && typeof api.resyncExplanationOptionLetter === 'function') {
    return (explanation, mapping, oldKey, newKey) => api.resyncExplanationOptionLetter(explanation, oldKey, newKey);
  }
  // Last resort no-op (should not happen if script order is correct).
  return (explanation) => explanation;
})();

function balanceAnswerPositions(questions) {
  if (!Array.isArray(questions)) return { changed: 0 };
  let changed = 0;
  let mcqIndex = 0;
  for (const q of questions) {
    const type = String(q.type || '').toLowerCase();
    if (type !== 'multiple_choice' && type !== 'multiple') continue;
    const opts = Array.isArray(q.options) ? q.options : null;
    if (!opts || opts.length < 2) continue;
    // Solo opciones tipo {key,text}
    if (typeof opts[0] !== 'object' || opts[0] == null) continue;

    const correctKey = Array.isArray(q.correct) ? q.correct[0] : q.correct;
    const correctIdx = opts.findIndex((o) => String(o.key) === String(correctKey));
    if (correctIdx < 0) continue;

    const targetIdx = mcqIndex % opts.length;
    mcqIndex++;
    if (targetIdx === correctIdx) continue; // ya está donde toca

    const oldLetter = String(correctKey);
    // Reordena: mueve el texto correcto a targetIdx, el resto conserva su orden relativo.
    const texts = opts.map((o) => o.text);
    const correctText = texts[correctIdx];
    const rest = texts.filter((_, i) => i !== correctIdx);
    const newTexts = [];
    // newIndexOf[j] = where the text that was at j ends up (the distractors shift too).
    const restOrigIdx = texts.map((_, i) => i).filter((i) => i !== correctIdx);
    const newIndexOf = [];
    let r = 0;
    for (let i = 0; i < opts.length; i++) {
      if (i === targetIdx) {
        newTexts[i] = correctText;
        newIndexOf[correctIdx] = i;
      } else {
        newIndexOf[restOrigIdx[r]] = i;
        newTexts[i] = rest[r++];
      }
    }
    // Reasigna las mismas claves (A,B,C…) en orden a los textos reordenados.
    const keys = opts.map((o) => String(o.key).toLowerCase());
    opts.forEach((o, i) => { o.text = newTexts[i]; });
    q.correct = String(opts[targetIdx].key);
    if (q.correctAnswer !== undefined) q.correctAnswer = q.correct;
    if (q.explanation) {
      const mapping = {};
      keys.forEach((k, j) => { mapping[k] = keys[newIndexOf[j]]; });
      q.explanation = partPostprocessRemapLetters(q.explanation, mapping, oldLetter, q.correct);
    }
    changed++;
  }
  return { changed };
}

function validateAdsUnique(items) {
  // items: array de matching (Teil 3). Cada item tiene correct = clave de anuncio.
  const used = new Map();
  const conflicts = [];
  (items || []).forEach((it) => {
    const k = String(Array.isArray(it.correct) ? it.correct[0] : it.correct);
    if (k === '0' || k === '' || k === 'undefined') return; // "0" (sin anuncio) puede repetirse
    if (used.has(k)) conflicts.push({ key: k, items: [used.get(k), it.itemNumber || it.id] });
    else used.set(k, it.itemNumber || it.id);
  });
  return { ok: conflicts.length === 0, conflicts };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { balanceAnswerPositions, validateAdsUnique };
}
if (typeof window !== 'undefined') {
  window.PartPostprocess = { balanceAnswerPositions, validateAdsUnique };
}
