/**
 * Shared option-letter ↔ explanation resync (KEEP SINGLE SOURCE OF TRUTH).
 *
 * Used by:
 *   - js/engine/prompts/partPostprocess.js  (balanceAnswerPositions)
 *   - scripts/lib/balanceMcq.mjs            (rotateToTarget)
 *
 * Natural language varies; we apply several context patterns rather than one
 * brittle "Option a)" regex. Letter-only rewrites inside those contexts.
 *
 * Loads as CommonJS (Node) and as a browser script (window.ExplanationOptionResync).
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.ExplanationOptionResync = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Build replace specs for rewriting letter `from` → `to` inside option contexts.
   * Order matters: more specific (with `)`) before bare `\b`.
   * @param {string} from  single a|b|c
   * @param {string} to    single a|b|c
   */
  function buildResyncReplacers(from, to) {
    const f = from;
    const t = to;
    return [
      // "Option a)" / "option b)"
      {
        id: 'option_paren',
        re: new RegExp(`([Oo]ption\\s*)${f}(\\))`, 'g'),
        repl: `$1${t}$2`,
      },
      // "Option a" / "was Option c korrekt macht" (no closing paren)
      {
        id: 'option_bare',
        re: new RegExp(`([Oo]ption\\s*)${f}\\b(?!\\s*\\))`, 'g'),
        repl: `$1${t}`,
      },
      // "die Option a" / "Die Option b"
      {
        id: 'die_option',
        re: new RegExp(`(\\b[Dd]ie\\s+[Oo]ption\\s*)${f}\\b`, 'g'),
        repl: `$1${t}`,
      },
      // "Antwort a" / "Antwort b)"
      {
        id: 'antwort',
        re: new RegExp(`([Aa]ntwort\\s*)${f}\\b`, 'g'),
        repl: `$1${t}`,
      },
      // "Alternative a"
      {
        id: 'alternative',
        re: new RegExp(`([Aa]lternative\\s*)${f}\\b`, 'g'),
        repl: `$1${t}`,
      },
      // "Buchstabe a"
      {
        id: 'buchstabe',
        re: new RegExp(`([Bb]uchstabe\\s*)${f}\\b`, 'g'),
        repl: `$1${t}`,
      },
      // "a ist korrekt/richtig" (letter leading)
      {
        id: 'letter_ist',
        re: new RegExp(`\\b${f}(\\s+ist\\s+(?:richtig|korrekt))\\b`, 'gi'),
        repl: `${t}$1`,
      },
      // "ist a korrekt/richtig"
      {
        id: 'ist_letter',
        re: new RegExp(`(\\bist\\s+)${f}(\\s+(?:richtig|korrekt)\\b)`, 'gi'),
        repl: `$1${t}$2`,
      },
    ];
  }

  /**
   * If explanation names an option letter in a known context and that letter
   * moved during shuffle, rewrite `oldLetter` → `newLetter`.
   * No-op when explanation has no such reference (the normal case).
   */
  function resyncExplanationOptionLetter(explanation, oldLetter, newLetter) {
    const expl = String(explanation || '');
    const from = String(oldLetter || '')
      .toLowerCase()
      .replace(/[^a-c]/g, '')
      .slice(0, 1);
    const to = String(newLetter || '')
      .toLowerCase()
      .replace(/[^a-c]/g, '')
      .slice(0, 1);
    if (!expl || !from || !to || from === to) return explanation;

    let out = expl;
    for (const { re, repl } of buildResyncReplacers(from, to)) {
      out = out.replace(re, repl);
    }
    return out;
  }

  /**
   * Detect option-letter mentions in explanation (for audit / retroactive repair).
   * @returns {{ letter: string, patternId: string, match: string, index: number }[]}
   */
  function findExplanationOptionLetters(explanation) {
    const text = String(explanation || '');
    const hits = [];
    const seen = new Set();
    for (const letter of ['a', 'b', 'c']) {
      for (const { id, re } of buildResyncReplacers(letter, letter)) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const key = `${m.index}:${letter}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ letter, patternId: id, match: m[0], index: m.index });
        }
      }
    }
    hits.sort((a, b) => a.index - b.index);
    return hits;
  }

  /**
   * Retroactive: rewrite every option-letter mention in explanation to `correctLetter`
   * when it disagrees. Does not touch options/correct — explanation text only.
   * @returns {{ explanation: string, changed: boolean, fixes: object[] }}
   */
  function alignExplanationOptionLetters(explanation, correctLetter) {
    const want = String(correctLetter || '')
      .toLowerCase()
      .replace(/[^a-c]/g, '')
      .slice(0, 1);
    const expl = String(explanation || '');
    if (!expl || !want) return { explanation: expl, changed: false, fixes: [] };

    const hits = findExplanationOptionLetters(expl);
    const fixes = [];
    let out = expl;
    const wrongLetters = [...new Set(hits.map((h) => h.letter).filter((l) => l !== want))];
    for (const wrong of wrongLetters) {
      const before = out;
      out = resyncExplanationOptionLetter(out, wrong, want);
      if (out !== before) {
        fixes.push({ from: wrong, to: want });
      }
    }
    return { explanation: out, changed: out !== expl, fixes };
  }

  /**
   * Every place an explanation names an option by its letter, in ANY of the contexts below.
   * resyncExplanationOptionLetter only moves ONE letter (the key), so after a shuffle the
   * distractors an explanation discusses ("they don't discuss the weather (a)") kept pointing
   * at their old positions. English generators write "(a)", which no replacer above knew, so
   * there even the key was left stale.
   * `at(m)` gives the letter's offset in the text; overlapping hits ("Option (a)") are deduped
   * by that offset so a letter is rewritten once.
   */
  function buildLetterRefPatterns() {
    const last = (m) => m.index + m[0].length - 1;
    return [
      // "Option a" / "option b)" / "Option (c)" / "die Option a" / "Antwort b" / "Alternative a" / "Buchstabe c"
      // Unicode lookahead: with [A-Za-z0-9] the "f" of "Option für" read as an option letter.
      { re: /\b(?:[Oo]ption|[Aa]ntwort|[Aa]lternative|[Bb]uchstabe)\s*\(?[a-hA-H](?![\p{L}\p{N}])/gu, at: last },
      // "a ist korrekt/richtig"
      { re: /\b[a-hA-H](?=\s+ist\s+(?:richtig|korrekt)\b)/gi, at: (m) => m.index },
      // "ist a korrekt/richtig"
      { re: /\bist\s+[a-hA-H](?=\s+(?:richtig|korrekt)\b)/gi, at: last },
      // "(a)" — the English habit: "doesn't express excitement (a)"
      { re: /\([a-hA-H]\)/g, at: (m) => m.index + 1 },
    ];
  }

  /** @returns {{ letter: string, raw: string, index: number }[]} letter refs in text order. */
  function findExplanationLetterRefs(explanation) {
    const text = String(explanation || '');
    const byIndex = new Map();
    for (const { re, at } of buildLetterRefPatterns()) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const index = at(m);
        byIndex.set(index, text[index]);
      }
    }
    return [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, raw]) => ({ letter: raw.toLowerCase(), raw, index }));
  }

  /**
   * Rewrite ALL option-letter refs at once through `mapping` (old letter → new letter, both
   * lowercase). One pass, so a→b and b→a cannot chain into each other. Case is preserved
   * ("Option A" stays uppercase). Letters absent from `mapping` are left alone.
   */
  function remapExplanationOptionLetters(explanation, mapping) {
    const text = String(explanation || '');
    if (!text || !mapping) return explanation;
    const refs = findExplanationLetterRefs(text);
    if (!refs.length) return explanation;
    let out = '';
    let last = 0;
    for (const { letter, raw, index } of refs) {
      const to = mapping[letter];
      if (!to || to === letter) continue;
      out += text.slice(last, index) + (raw === raw.toUpperCase() ? to.toUpperCase() : to);
      last = index + 1;
    }
    if (last === 0) return explanation;
    return out + text.slice(last);
  }

  return {
    resyncExplanationOptionLetter,
    findExplanationOptionLetters,
    alignExplanationOptionLetters,
    buildResyncReplacers,
    findExplanationLetterRefs,
    remapExplanationOptionLetters,
  };
});
