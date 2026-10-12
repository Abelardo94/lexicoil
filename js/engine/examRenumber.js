/**
 * Global exam numbering per module — official Goethe/Cambridge ranges, no duplicate numbers.
 * Works in browser + Netlify (CommonJS export).
 */
const ExamRenumber = (() => {
  const DEFAULT_RANGES = {
    lesen: {
      1: { start: 1, end: 6, expected: 6 },
      2: { start: 7, end: 12, expected: 6 },
      3: { start: 13, end: 19, expected: 7 },
      4: { start: 20, end: 26, expected: 7 },
      5: { start: 27, end: 30, expected: 4 },
    },
    horen: {
      1: { start: 1, end: 10, expected: 10 },
      2: { start: 11, end: 15, expected: 5 },
      3: { start: 16, end: 22, expected: 7 },
      4: { start: 23, end: 30, expected: 8 },
    },
  };

  /** DEFAULT_RANGES is the Goethe layout. Cambridge B1 Preliminary numbers
   *  Reading 1–32 over six parts and Listening 1–25 over four, so falling back
   *  to the Goethe table left gaps (Reading jumped 5→7→13→20→27), a duplicate
   *  (Listening reused 16) and — since Goethe has no Teil 6 — restarted Reading
   *  Part 6 at 1, colliding with Part 1. Same numbers buildModuleRanges() derives
   *  from library/blueprints/cambridge_B1.json, kept here because the normalize
   *  path renumbers synchronously and has no blueprint loaded. */
  const CAMBRIDGE_RANGES = {
    lesen: {
      1: { start: 1, end: 5, expected: 5 },
      2: { start: 6, end: 10, expected: 5 },
      3: { start: 11, end: 15, expected: 5 },
      4: { start: 16, end: 20, expected: 5 },
      5: { start: 21, end: 26, expected: 6 },
      6: { start: 27, end: 32, expected: 6 },
    },
    horen: {
      1: { start: 1, end: 7, expected: 7 },
      2: { start: 8, end: 13, expected: 6 },
      3: { start: 14, end: 19, expected: 6 },
      4: { start: 20, end: 25, expected: 6 },
    },
  };

  /** Goethe-Zertifikat A2: Lesen and Hören are both 4 Teile × 5 items, 1–20
   *  (library/blueprints/goethe_A2.json). On DEFAULT_RANGES, A2 Lesen T1 claimed 1–6,
   *  T2 started at 7 and T3 at 13, so a 20-item module was numbered like B1's 30. */
  const GOETHE_A2_RANGES = {
    lesen: {
      1: { start: 1, end: 5, expected: 5 },
      2: { start: 6, end: 10, expected: 5 },
      3: { start: 11, end: 15, expected: 5 },
      4: { start: 16, end: 20, expected: 5 },
    },
    horen: {
      1: { start: 1, end: 5, expected: 5 },
      2: { start: 6, end: 10, expected: 5 },
      3: { start: 11, end: 15, expected: 5 },
      4: { start: 16, end: 20, expected: 5 },
    },
  };

  /** Goethe B1 stays on DEFAULT_RANGES exactly as before; Cambridge and Goethe A2 opt in. */
  function rangeTableFor(exam) {
    const bpId = String(exam?.blueprintId || '').toLowerCase();
    const lang = String(exam?.lang || '').toLowerCase();
    if (bpId.startsWith('cambridge') || (!bpId && lang === 'en')) return CAMBRIDGE_RANGES;
    if (bpId === 'goethe-a2') return GOETHE_A2_RANGES;
    return DEFAULT_RANGES;
  }

  function parseRangeFromInstruction(instruction) {
    const m = String(instruction || '').match(/(\d+)\s*(?:bis|–|-|to)\s*(\d+)/i);
    if (!m) return null;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return { start, end, expected: end - start + 1 };
  }

  function partExpectedCount(partSpec) {
    if (!partSpec) return null;
    return partSpec.itemsTotal ?? partSpec.questionsTotal?.max ?? partSpec.questionsTotal?.min ?? null;
  }

  /** Official item number ranges per Teil, derived from blueprint instructions or cumulative totals. */
  function buildModuleRanges(blueprint, modId) {
    const mod = blueprint?.modules?.find((x) => x.id === modId);
    if (!mod?.parts?.length) return { ...(DEFAULT_RANGES[modId] || {}) };

    const ranges = {};
    let cumStart = 1;
    for (const p of [...mod.parts].sort((a, b) => Number(a.teil) - Number(b.teil))) {
      const teil = Number(p.teil);
      const parsed = parseRangeFromInstruction(p.instruction);
      const expected = partExpectedCount(p) || parsed?.expected || 1;
      if (parsed) {
        ranges[teil] = { start: parsed.start, end: parsed.end, expected };
        cumStart = parsed.end + 1;
      } else {
        ranges[teil] = { start: cumStart, end: cumStart + expected - 1, expected };
        cumStart += expected;
      }
    }
    return ranges;
  }

  function teilRange(blueprint, modId, teil, part, table) {
    const fallback = table || DEFAULT_RANGES;
    const ranges = blueprint ? buildModuleRanges(blueprint, modId) : fallback[modId] || {};
    const t = Number(teil) || 1;
    if (ranges[t]) return ranges[t];
    // Goethe-shaped heuristics: only meaningful against the Goethe table.
    if (modId === 'lesen' && fallback === DEFAULT_RANGES) {
      if (isForumOpinionsPart(part) || (t === 4 && (part?.items || []).length)) return DEFAULT_RANGES.lesen[4];
      if (isAdsMatchingPart(part) || t === 3) return DEFAULT_RANGES.lesen[3];
    }
    return fallback[modId]?.[t] || { start: 1, end: 99, expected: countScorableInPart(part, modId) };
  }

  function isForumOpinionsPart(part) {
    if (!part) return false;
    const slot = String(part.blueprintSlot || part.slotType || '').toLowerCase();
    if (slot.includes('forum') || slot.includes('opinion')) return true;
    if (Number(part.teil) === 4 && (part.items || []).some((it) => it.signText || it.text)) return true;
    return false;
  }

  function isAdsMatchingPart(part) {
    if (!part) return false;
    const slot = String(part.blueprintSlot || part.slotType || '').toLowerCase();
    if (slot.includes('ads') || slot.includes('matching')) return true;
    return !!(part.ads?.length && (part.items || []).some((it) => it.signText || it.text));
  }

  function horenUsesSegmentQuestions(part) {
    return !!(part?.segments?.length && part.segments.some((seg) => (seg.questions || []).length));
  }

  function countScorableInPart(part, mod) {
    if (!part) return 0;
    let n = 0;
    if (mod === 'lesen') {
      n += (part.questions || []).length;
      n += (part.items || []).filter((it) => it.signText || it.text || it.question || it.correct != null).length;
    } else if (mod === 'horen') {
      if (horenUsesSegmentQuestions(part)) {
        for (const seg of part.segments) n += (seg.questions || []).length;
      } else {
        n += (part.questions || []).length;
      }
    }
    return n;
  }

  function scorableItems(part, mod) {
    const out = [];
    if (mod === 'lesen') {
      const items = (part.items || []).filter((it) => it.signText || it.text || it.question || it.correct != null);
      if (items.length) out.push(...items);
      if (part.questions?.length) out.push(...part.questions);
    } else if (mod === 'horen') {
      if (horenUsesSegmentQuestions(part)) {
        for (const seg of part.segments) out.push(...(seg.questions || []));
      } else if (part.questions?.length) {
        out.push(...part.questions);
      }
    }
    return out;
  }

  function assignItemNumber(item, num) {
    item.id = String(num);
    item.number = num;
    item.nr = num;
    item.nummer = num;
    if (typeof item.question === 'string' && /^\d+\.\s/.test(item.question)) {
      item.question = item.question.replace(/^\d+\.\s*/, '');
    }
    if (typeof item.statement === 'string' && /^\d+\.\s/.test(item.statement)) {
      item.statement = item.statement.replace(/^\d+\.\s*/, '');
    }
  }

  function renumberList(list, startNum) {
    if (!Array.isArray(list) || !list.length) return startNum;
    list.forEach((item, i) => assignItemNumber(item, startNum + i));
    return startNum + list.length;
  }

  function patchInstructionRange(instruction, start, count) {
    if (!instruction || count < 1) return instruction;
    const end = start + count - 1;
    let s = String(instruction);
    s = s.replace(
      /(Meinungen|Aufgaben|Situationen|Aussagen|Texte|opinions)\s+(\d+)\s*(?:bis|–|-|to)\s*(\d+)/gi,
      (_m, label) => `${label} ${start} bis ${end}`,
    );
    s = s.replace(/(\d+)\s*(?:bis|–|-|to)\s*(\d+)/gi, (m, a, b) => {
      const lo = Number(a);
      const hi = Number(b);
      if (hi - lo >= 2 || lo === start || hi >= start) {
        return `${start} bis ${end}`;
      }
      return m;
    });
    s = s.replace(/EXACTLY\s+\d+\s+items?/gi, `EXACTLY ${count} item${count === 1 ? '' : 's'}`);
    s = s.replace(/\b(\d+)\s+(Fragen|questions|items|Meinungen)\b/gi, (m, n, w) => {
      if (Number(n) > count) return `${count} ${w}`;
      return m;
    });
    return s;
  }

  function renumberLesenPart(part, blueprint, table) {
    if (!part) return;
    const range = teilRange(blueprint, 'lesen', part.teil, part, table);
    const start = range.start;
    let cursor = start;
    if (part.items?.length) {
      const scorable = part.items.filter((it) => it.signText || it.text || it.question || it.correct != null);
      const passive = part.items.filter((it) => !(it.signText || it.text || it.question || it.correct != null));
      cursor = renumberList(scorable, start);
      part.items = [...scorable, ...passive];
    }
    if (part.questions?.length) cursor = renumberList(part.questions, cursor);
    const count = countScorableInPart(part, 'lesen');
    if (part.instruction && count > 0) {
      part.instruction = patchInstructionRange(part.instruction, start, count);
    }
    part._itemCount = count;
    part._numberRange = { start, end: start + count - 1, officialEnd: range.end };
  }

  function renumberHorenPart(part, blueprint, table) {
    if (!part) return;
    const range = teilRange(blueprint, 'horen', part.teil, part, table);
    const start = range.start;
    let cursor = start;
    if (part.segments?.length) {
      for (const seg of part.segments) {
        cursor = renumberList(seg.questions || [], cursor);
      }
    } else if (part.questions?.length) {
      cursor = renumberList(part.questions, cursor);
    }
    const count = countScorableInPart(part, 'horen');
    if (part.instruction && count > 0) {
      part.instruction = patchInstructionRange(part.instruction, start, count);
    }
    part._itemCount = count;
    part._numberRange = { start, end: start + count - 1, officialEnd: range.end };
  }

  function collectModuleNumbers(exam, mod) {
    const key = mod + 'Parts';
    const nums = [];
    for (const part of exam[key] || []) {
      for (const item of scorableItems(part, mod)) {
        const n = Number(item.number ?? item.nr ?? item.nummer ?? item.id);
        if (Number.isFinite(n)) nums.push(n);
      }
    }
    return nums;
  }

  function assertUniqueModuleNumbers(exam, mod) {
    const nums = collectModuleNumbers(exam, mod);
    const seen = new Set();
    const dupes = [];
    for (const n of nums) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    if (dupes.length && typeof lcDebug !== 'undefined') {
      lcDebug.warn(`[renumber] duplicate ${mod} numbers:`, [...new Set(dupes)]);
    }
    return dupes.length === 0;
  }

  function blueprintExpectedCount(blueprint, mod, teil) {
    if (!blueprint?.modules) return DEFAULT_RANGES[mod]?.[teil]?.expected ?? null;
    const m = blueprint.modules.find((x) => x.id === mod);
    const p = (m?.parts || []).find((x) => Number(x.teil) === Number(teil));
    if (!p) return DEFAULT_RANGES[mod]?.[teil]?.expected ?? null;
    return partExpectedCount(p);
  }

  function collectDeficits(exam, blueprint) {
    const deficits = [];
    if (!exam || !blueprint) return deficits;
    for (const [key, mod] of [
      ['lesenParts', 'lesen'],
      ['horenParts', 'horen'],
    ]) {
      for (const part of exam[key] || []) {
        const expected = blueprintExpectedCount(blueprint, mod, part.teil);
        if (expected == null) continue;
        const actual = countScorableInPart(part, mod);
        if (actual < expected) {
          deficits.push({
            module: mod,
            teil: Number(part.teil),
            expected,
            actual,
            missing: expected - actual,
            key,
          });
        }
      }
    }
    return deficits;
  }

  function renumberExam(exam, blueprint) {
    if (!exam || typeof exam !== 'object') return exam;
    const table = rangeTableFor(exam);
    for (const part of exam.lesenParts || []) renumberLesenPart(part, blueprint, table);
    for (const part of exam.horenParts || []) renumberHorenPart(part, blueprint, table);
    for (const part of exam.readingParts || []) renumberLesenPart(part, blueprint, table);
    for (const part of exam.listeningParts || []) renumberHorenPart(part, blueprint, table);
    assertUniqueModuleNumbers(exam, 'lesen');
    assertUniqueModuleNumbers(exam, 'horen');
    if (blueprint) exam._itemDeficits = collectDeficits(exam, blueprint);
    return exam;
  }

  function itemFingerprint(item) {
    return String(item.question || item.statement || item.signText || item.text || item.id || '')
      .trim()
      .toLowerCase()
      .slice(0, 120);
  }

  function appendScorableItems(targetPart, sourcePart, mod, maxAdd) {
    if (!targetPart || !sourcePart || maxAdd <= 0) return 0;
    const existing = new Set(scorableItems(targetPart, mod).map(itemFingerprint));
    let added = 0;

    const tryList = (list, assignTo) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (added >= maxAdd) return;
        const fp = itemFingerprint(item);
        if (!fp || existing.has(fp)) continue;
        assignTo.push({ ...item });
        existing.add(fp);
        added += 1;
      }
    };

    if (mod === 'lesen') {
      if (!targetPart.items) targetPart.items = [];
      if (!targetPart.questions) targetPart.questions = [];
      const srcScorable = (sourcePart.items || []).filter(
        (it) => it.signText || it.text || it.question || it.correct != null,
      );
      tryList(srcScorable, targetPart.items);
      tryList(sourcePart.questions, targetPart.questions);
    } else if (mod === 'horen') {
      if (sourcePart.segments?.length) {
        if (!targetPart.segments?.length) targetPart.segments = [{ questions: [] }];
        const tgtSeg = targetPart.segments[0];
        if (!tgtSeg.questions) tgtSeg.questions = [];
        for (const seg of sourcePart.segments) tryList(seg.questions, tgtSeg.questions);
      }
      if (!targetPart.questions) targetPart.questions = [];
      tryList(sourcePart.questions, targetPart.questions);
    }
    return added;
  }

  function mergeItemsById(listA, listB) {
    const map = new Map();
    for (const it of listA || []) {
      if (it && it.id != null) map.set(String(it.id), it);
    }
    for (const it of listB || []) {
      if (it && it.id != null) map.set(String(it.id), it);
    }
    return [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  function mergeTeilPart(target, source, mod, teil, blueprint) {
    if (!target || !source) return target;
    const key = mod + 'Parts';
    const srcPart = (source[key] || []).find((p) => Number(p.teil) === Number(teil));
    if (!srcPart) return target;
    if (!target[key]) target[key] = [];
    const idx = target[key].findIndex((p) => Number(p.teil) === Number(teil));
    const existing = idx >= 0 ? target[key][idx] : null;
    const merged = existing ? { ...existing } : { ...srcPart, teil: Number(teil) };
    const exCount = countScorableInPart(existing, mod);
    const expected = blueprintExpectedCount(blueprint, mod, teil) || exCount;
    const need = Math.max(0, expected - exCount);

    if (need > 0) {
      appendScorableItems(merged, srcPart, mod, need);
    } else if (srcPart.items?.length || existing?.items?.length) {
      merged.items = mergeItemsById(existing?.items, srcPart.items);
    } else if (countScorableInPart(srcPart, mod) > exCount) {
      if (srcPart.questions?.length) merged.questions = srcPart.questions;
      if (srcPart.segments?.length) merged.segments = srcPart.segments;
    }

    if (!existing?.text && srcPart.text) merged.text = srcPart.text;
    if (!existing?.textTitle && srcPart.textTitle) merged.textTitle = srcPart.textTitle;
    if (!existing?.transcript && srcPart.transcript) merged.transcript = srcPart.transcript;
    if (!existing?.ads?.length && srcPart.ads?.length) merged.ads = srcPart.ads;
    if (srcPart.instruction && !existing?.instruction) merged.instruction = srcPart.instruction;

    if (idx >= 0) target[key][idx] = merged;
    else target[key].push(merged);
    return target;
  }

  return Object.freeze({
    renumberExam,
    collectDeficits,
    mergeTeilPart,
    mergeItemsById,
    appendScorableItems,
    countScorableInPart,
    scorableItems,
    patchInstructionRange,
    buildModuleRanges,
    teilRange,
    blueprintExpectedCount,
    rangeTableFor,
    DEFAULT_RANGES,
    GOETHE_A2_RANGES,
  });
})();

if (typeof window !== 'undefined') window.ExamRenumber = ExamRenumber;
if (typeof module !== 'undefined') module.exports = ExamRenumber;
