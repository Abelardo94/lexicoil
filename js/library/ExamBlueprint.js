/**
 * Exam Blueprint — fixed official-like structure, dynamic library content.
 * Principle: structure is locked; questions/passages are selected from the bank.
 */
const ExamBlueprint = (() => {
  const INDEX = (() => {
    if (typeof LibraryCatalog !== 'undefined') return LibraryCatalog.buildBlueprintIndex();
    const idx = {};
    for (const lang of ['de', 'en', 'es']) {
      const type = lang === 'de' ? 'goethe' : lang === 'es' ? 'dele' : 'cambridge';
      for (const level of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) {
        idx[`${lang}_${level}`] = `${type}_${level}`;
      }
    }
    return idx;
  })();
  const CACHE = {};

  function key(lang, level) {
    return `${lang}_${level}`;
  }

  function blueprintPath(lang, level) {
    const id = INDEX[key(lang, level)];
    return id ? `library/blueprints/${id}.json` : null;
  }

  function hasBlueprint(lang, level) {
    return !!INDEX[key(lang, level)];
  }

  async function load(lang, level) {
    const k = key(lang, level);
    if (CACHE[k]) return CACHE[k];
    const path = blueprintPath(lang, level);
    if (!path) return null;
    const res = await fetch(path);
    if (!res.ok) return null;
    CACHE[k] = await res.json();
    return CACHE[k];
  }

  function loadSync(lang, level) {
    return CACHE[key(lang, level)] || null;
  }

  function cacheBlueprint(lang, level, blueprint) {
    CACHE[key(lang, level)] = blueprint;
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function normType(q) {
    const t = String(q.questionType || q.type || '').toLowerCase();
    if (t === 'multiple' || t === 'mcq' || t === 'mc') return 'multiple_choice';
    if (t === 'match') return 'matching';
    if (t === 'richtig_falsch' || t === 'true_false') return 'richtig_falsch';
    return t;
  }

  function normToken(x) {
    const t = String(x || '').toLowerCase();
    if (t === 'multiple') return 'multiple_choice';
    if (t === 'match') return 'matching';
    if (t === 'richtig_falsch' || t === 'true_false') return 'richtig_falsch';
    return t;
  }

  function typeAllowed(q, allowed) {
    if (!allowed?.length) return true;
    const t = normType(q);
    return allowed.some((a) => normToken(a) === t);
  }

  function modulePool(bank, moduleId) {
    const mod = String(moduleId).toLowerCase();
    return (bank.questions || []).filter((q) => {
      const m = String(q.module || '').toLowerCase();
      if (mod === 'lesen' || mod === 'reading') return m === 'lesen' || m === 'reading';
      if (mod === 'horen' || mod === 'listening') return m === 'horen' || m === 'listening';
      if (mod === 'grammatik' || mod === 'use_of_english') {
        return m === 'grammatik' || m === 'grammar' || m === 'use_of_english';
      }
      if (mod === 'schreiben' || mod === 'writing') return m === 'schreiben' || m === 'writing';
      return m === mod;
    });
  }

  function passageIdOf(q) {
    if (typeof PassageResolver !== 'undefined') return PassageResolver.passageIdFromQuestion(q);
    return q?.passageId || q?.context?.passageId || null;
  }

  function groupCandidatesByPassage(candidates) {
    const byPassage = new Map();
    candidates.forEach((q) => {
      const pid = passageIdOf(q);
      if (!pid) return;
      if (!byPassage.has(pid)) byPassage.set(pid, []);
      byPassage.get(pid).push(q);
    });
    return byPassage;
  }

  /** Pick questions from one passage (Teil 1/5) or a matched pair (Teil 2). */
  function pickPassageAligned(candidates, partSpec, target) {
    const layout = partSpec.layout || '';
    if (layout !== 'passage_questions' || !candidates.length) return null;

    const byPassage = groupCandidatesByPassage(candidates);
    const passagesPerPart = partSpec.passagesPerPart || 1;

    if (passagesPerPart >= 2) {
      const sets = new Map();
      for (const [pid, qs] of byPassage) {
        const m = String(pid).match(/^(.+)-([ab])$/i);
        if (!m) continue;
        const base = m[1];
        if (!sets.has(base)) sets.set(base, { qa: [], qb: [] });
        const slot = m[2].toLowerCase() === 'a' ? 'qa' : 'qb';
        sets.get(base)[slot].push(...qs);
      }
      const pairs = [...sets.values()].filter((s) => s.qa.length && s.qb.length && s.qa.length + s.qb.length >= target);
      if (pairs.length) {
        const pair = shuffle(pairs)[0];
        return shuffle([...pair.qa, ...pair.qb]).slice(0, target);
      }
      const pids = [...byPassage.entries()].sort((a, b) => b[1].length - a[1].length);
      if (pids.length >= 2 && pids[0][1].length + pids[1][1].length >= target) {
        return shuffle([...pids[0][1], ...pids[1][1]]).slice(0, target);
      }
      return null;
    }

    const viable = [...byPassage.entries()].filter(([, qs]) => qs.length >= target);
    if (!viable.length) return null;
    const [, qs] = shuffle(viable)[0];
    return shuffle(qs).slice(0, target);
  }

  /** Pick questions grouped by passage for layout=segments (e.g. Hören T1: 5 segments × 2 items). */
  function pickSegmentsAligned(candidates, partSpec, target) {
    const layout = partSpec.layout || '';
    const segmentsTotal = partSpec.segmentsTotal;
    if (layout !== 'segments' || !segmentsTotal || !candidates.length) return null;

    const perSegment = Math.max(1, Math.round(target / segmentsTotal));
    const byPassage = groupCandidatesByPassage(candidates);

    // For mixed-type Teile (e.g. Hören T1: 1 RF + 1 MC per segment), enforce that each
    // passage group has at least one question of each required type. A group of 2 MCQ with
    // no RF is not viable — picking it would produce a 0RF+2MC segment that CHK-20 rejects.
    const questionTypes = partSpec.questionTypes || [];
    const needsTypeBalance = questionTypes.length >= 2;

    function pickBalanced(qs) {
      if (!needsTypeBalance) return shuffle(qs).slice(0, perSegment);
      // Collect one of each required type, then fill remaining slots from the rest.
      const result = [];
      const remaining = [...qs];
      for (const t of questionTypes) {
        const idx = remaining.findIndex(
          (q) => q.type === t || (t === 'richtig_falsch' && q.type === 'true_false'),
        );
        if (idx === -1) return null; // group lacks this type — not viable
        result.push(remaining.splice(idx, 1)[0]);
        if (result.length === perSegment) break;
      }
      while (result.length < perSegment && remaining.length) {
        result.push(remaining.shift());
      }
      return result.length === perSegment ? result : null;
    }

    const viable = [];
    for (const entry of byPassage.entries()) {
      const [pid, qs] = entry;
      if (qs.length < perSegment) continue;
      const sample = pickBalanced(shuffle([...qs]));
      if (sample) viable.push([pid, qs]);
    }
    if (viable.length < segmentsTotal) return null;

    const picked = [];
    for (const [, qs] of shuffle(viable).slice(0, segmentsTotal)) {
      const sample = pickBalanced(shuffle([...qs]));
      if (!sample) continue; // defensive — viable check above should prevent this
      picked.push(...sample);
    }
    return picked.length >= target ? picked.slice(0, target) : picked.length ? picked : null;
  }

  function pickFromPool(pool, partSpec, used, bank, filterFn, opts = {}) {
    const teil = partSpec.teil;
    const target = partSpec.itemsTotal || partSpec.questionsTotal?.max || partSpec.questionsTotal?.min || 4;
    let candidates = pool.filter(
      (q) =>
        !used.has(q.id) &&
        !(opts.excludeIds && opts.excludeIds.has(q.id)) &&
        !(opts.applyBurned !== false && typeof BurnedRegistry !== 'undefined' && BurnedRegistry.isBankQuestionBurned(bank, q)),
    );
    if (teil != null) {
      const byTeil = candidates.filter((q) => (q.teil || q.part) === teil);
      if (byTeil.length) candidates = byTeil;
    }
    if (partSpec.estimatedExamPart) {
      const bySlot = candidates.filter(
        (q) => q.estimatedExamPart === partSpec.estimatedExamPart || q.slot === partSpec.estimatedExamPart,
      );
      if (bySlot.length) candidates = bySlot;
    }
    candidates = candidates.filter((q) => typeAllowed(q, partSpec.questionTypes));
    if (filterFn) candidates = candidates.filter(filterFn);
    if (!candidates.length) {
      candidates = pool.filter(
        (q) =>
          !used.has(q.id) &&
          !(opts.excludeIds && opts.excludeIds.has(q.id)) &&
          !(opts.applyBurned !== false && typeof BurnedRegistry !== 'undefined' && BurnedRegistry.isBankQuestionBurned(bank, q)) &&
          typeAllowed(q, partSpec.questionTypes),
      );
      if (filterFn) candidates = candidates.filter(filterFn);
    }
    const modId = opts.moduleId || partSpec.moduleId || null;
    const calibration = opts.calibration;
    const IC = typeof ItemCalibration !== 'undefined' ? ItemCalibration : null;
    let picked = pickSegmentsAligned(candidates, partSpec, target);
    if (!picked?.length) picked = pickPassageAligned(candidates, partSpec, target);

    // ── Coherent T3 set (Lesen Teil 3 — ads matching) ─────────────────────────
    // INVARIANT: all 7 items must share the same A-J options list (one set).
    // Strategy: (1) find a complete coherent set in the bank; (2) if none, call
    // LesenPartGenerators.buildValidatedT3Part() which generates from blueprints;
    // (3) if no generator available (browser), leave picked empty → coverage fails
    // loudly → no Frankenstein ever reaches the served exam.
    if (!picked?.length && modId === 'lesen' && teil === 3) {
      // Group candidates by canonical options fingerprint (same A-J list = same set)
      const byFp = new Map();
      for (const q of candidates) {
        const opts7 = (q.options || []).filter(o => typeof o === 'string' && o.length > 2);
        if (opts7.length < 7) continue; // skip bare-key items
        const fp = opts7.map(o => String(o).trim()).join('|');
        if (!byFp.has(fp)) byFp.set(fp, []);
        byFp.get(fp).push(q);
      }
      const completeGroups = [...byFp.values()].filter(qs => qs.length >= 7);
      if (completeGroups.length) {
        picked = shuffle(completeGroups)[0].slice(0, 7);
      } else if (typeof LesenPartGenerators !== 'undefined' &&
                 typeof LesenPartGenerators.buildValidatedT3Part === 'function') {
        try {
          const batch = LesenPartGenerators.buildValidatedT3Part(
            opts._lesenExclude ? { exclude: opts._lesenExclude.t3 } : {}
          );
          picked = batch.questions;
          if (opts._lesenExclude && batch._blueprintSlug) {
            opts._lesenExclude.t3.add(batch._blueprintSlug);
          }
        } catch (err) {
          if (typeof lcDebug !== 'undefined') lcDebug.warn('[ExamBlueprint] T3 generator failed:', err);
        }
      }
      // If still empty: leave as [] → coverage.complete = false → exam rejected
    }

    // ── Coherent T4 set (Lesen Teil 4 — forum opinions) ───────────────────────
    // INVARIANT: all 7 items must come from a single blueprint/source with unique authors.
    // Regex recognises both bank IDs (-l-t4-SLUG-qN) and generator IDs (gen-q-4-PREFIX-N).
    if (!picked?.length && modId === 'lesen' && teil === 4) {
      function t4GroupKey(q) {
        const bankM = String(q.id || '').match(/-l-t4-(.+?)-q\d+$/i);
        if (bankM) return 'bank:' + bankM[1];
        const genM = String(q.id || '').match(/^gen-q-4-([a-z0-9]+)-\d+$/i);
        if (genM) return 'gen:' + genM[1];
        return null;
      }
      function t4GroupIsCoherent(items) {
        if (items.length < 7) return false;
        const texts = items.map(q => String(q.signText || '').trim());
        if (new Set(texts).size !== texts.length) return false;
        if (texts.some(t => t.split(/\s+/).filter(Boolean).length < 15)) return false;
        const authors = items.map(q => {
          const t = String(q.signText || '');
          const m = t.match(/^(?:Meinung von|Sagt)\s+([A-ZÄÖÜ][a-zäöüß]+)/);
          return m ? m[1] : (t.match(/^([A-ZÄÖÜ][a-zäöüß]+)/)?.[1] || '');
        });
        return new Set(authors.filter(Boolean)).size === authors.filter(Boolean).length;
      }
      const bySlug = new Map();
      for (const q of candidates) {
        const key = t4GroupKey(q);
        if (!key) continue;
        if (!bySlug.has(key)) bySlug.set(key, []);
        bySlug.get(key).push(q);
      }
      const viable = [...bySlug.values()].filter(qs => qs.length >= target && t4GroupIsCoherent(qs));
      if (viable.length) {
        picked = shuffle(viable)[0].slice(0, target);
      } else if (typeof LesenPartGenerators !== 'undefined' &&
                 typeof LesenPartGenerators.buildValidatedT4Part === 'function') {
        try {
          const batch = LesenPartGenerators.buildValidatedT4Part(
            opts._lesenExclude ? { exclude: opts._lesenExclude.t4 } : {}
          );
          picked = batch.questions;
          if (opts._lesenExclude && batch._blueprintSlug) {
            opts._lesenExclude.t4.add(batch._blueprintSlug);
          }
        } catch (err) {
          if (typeof lcDebug !== 'undefined') lcDebug.warn('[ExamBlueprint] T4 generator failed:', err);
        }
      }
      // If still empty: leave as [] → coverage.complete = false → exam rejected
    }

    // ── Coherent multiple-matching set (Cambridge Reading P2) ────────────────
    // INVARIANT: the 5 people and the 8 texts must come from ONE source batch;
    // mixing sets breaks the A-H option mapping. Group by question-id prefix
    // (…-qN) and pick a complete group only.
    if (!picked?.length && partSpec.slotType === 'person_text_matching') {
      const bySet = new Map();
      for (const q of candidates) {
        const m = String(q.id || '').match(/^(.*?)-q\d+$/i);
        if (!m) continue;
        if (!bySet.has(m[1])) bySet.set(m[1], []);
        bySet.get(m[1]).push(q);
      }
      const complete = [...bySet.values()].filter((qs) => qs.length >= target);
      if (complete.length) picked = shuffle(complete)[0].slice(0, target);
    }

    if (!picked?.length) {
      if (modId === 'lesen' && (teil === 3 || teil === 4)) {
        // Never fall through to individual-item shuffle for T3/T4 — coherence cannot be
        // guaranteed. Leave picked empty so coverage.complete = false signals the gap.
        picked = [];
      } else if (['mcq_gap_fill', 'open_cloze', 'person_text_matching', 'sentence_completion', 'interview_mcq'].includes(partSpec.slotType || '')) {
        // Cambridge set-coherent slots: a cloze must come whole from one passage and
        // a multiple-matching set from one batch. Random shuffle would Frankenstein
        // them — leave empty so coverage fails loudly instead.
        picked = [];
      } else if (modId === 'horen' && teil === 1) {
        // H1 requires segment-aligned picking (5 passages × 1RF+1MC each).
        // If pickSegmentsAligned failed (insufficient viable groups or wrong type balance),
        // do not fall through to random shuffle — coherence cannot be guaranteed.
        // Leave empty → coverage.complete = false → exam rejected upstream (same as L3/T4).
        picked = [];
      } else if (calibration && IC && candidates.length > target) {
        picked = IC.pickCalibrated(candidates, target, {
          module: modId || inferModuleFromPool(pool),
          teil,
          calibration,
          shuffleFn: shuffle,
        });
      } else {
        picked = shuffle(candidates).slice(0, target);
      }
    }
    picked = orderGapQuestions(picked, partSpec);
    picked.forEach((q) => used.add(q.id));
    return picked;
  }

  /**
   * Gap-bound tasks must follow the passage, not the pick order. The picker shuffles, which
   * is right for independent items but not for "choose the option for gap N": Cambridge
   * Reading P4/P5/P6 were arriving as gaps 3,5,1,2,4 while the text numbered them 1..5, so
   * the candidate had to hunt for each gap. Goethe B2/C1/C2 and DELE have gap slots too and
   * want the same order.
   *
   * Deliberately a no-op unless the intent is unambiguous: every question must yield a gap
   * number and they must all be distinct, otherwise the original order is kept.
   */
  function gapNumberOf(q) {
    const text = String(q?.question || q?.statement || q?.text || '');
    const m = text.match(/\bgap\s*(\d+)/i) || text.match(/\((\d+)\)/) || text.match(/\bhueco\s*(\d+)/i)
      || text.match(/\bL(?:ü|ue)cke\s*(\d+)/i);
    if (m) return Number(m[1]);
    const byId = String(q?.id || '').match(/-q(\d+)$/i);
    return byId ? Number(byId[1]) : null;
  }

  // Cambridge tasks that follow one text or recording in order without saying "gap": the
  // long-text questions track the paragraphs, sentence completion and the interview track
  // the audio. They were served as 1,5,3,4,2 / 6,5,1,3,2,4. Exact slotType on purpose —
  // Goethe interview_twice and DELE long_article are left as they are.
  const SEQUENTIAL_SLOTS = new Set(['long_text', 'sentence_completion', 'interview_mcq']);

  function sequenceNumberOf(q) {
    // Id only: a long-text question may quote "(2)" without it being a gap number.
    const byId = String(q?.id || '').match(/-q(\d+)$/i);
    return byId ? Number(byId[1]) : null;
  }

  function orderGapQuestions(questions, partSpec) {
    if (!Array.isArray(questions) || questions.length < 2) return questions;
    const slot = `${partSpec?.slotType || ''} ${partSpec?.taskFormat || ''}`.toLowerCase();
    const sequential = SEQUENTIAL_SLOTS.has(String(partSpec?.slotType || '').toLowerCase());
    if (!/gap|cloze/.test(slot) && !sequential) return questions;
    const numbered = questions.map((q) => ({ q, n: sequential ? sequenceNumberOf(q) : gapNumberOf(q) }));
    if (numbered.some((x) => x.n == null)) return questions;
    if (new Set(numbered.map((x) => x.n)).size !== numbered.length) return questions;
    return numbered.sort((a, b) => a.n - b.n).map((x) => x.q);
  }

  function inferModuleFromPool(pool) {
    const q = pool?.[0];
    return q?.module || null;
  }

  function getPassage(bank, passageId) {
    if (typeof PassageResolver !== 'undefined') {
      return PassageResolver.getPassageFromBank(bank, passageId);
    }
    return (bank.passages || []).find((p) => p.id === passageId) || null;
  }

  function resolvePassage(bank, q) {
    if (typeof PassageResolver !== 'undefined') {
      return PassageResolver.resolvePassageForQuestion(bank, q);
    }
    const pid = q.passageId || q.context?.passageId;
    return pid ? getPassage(bank, pid) : null;
  }

  function groupByPassage(questions, bank) {
    const enriched =
      typeof PassageResolver !== 'undefined'
        ? PassageResolver.enrichQuestionPassageIds(questions)
        : questions;
    const groups = new Map();
    enriched.forEach((q) => {
      const pid =
        (typeof PassageResolver !== 'undefined'
          ? PassageResolver.passageIdFromQuestion(q)
          : q.passageId) || `_solo_${q.id}`;
      if (!groups.has(pid)) groups.set(pid, []);
      groups.get(pid).push(q);
    });
    return { groups, enriched };
  }

  function toExamQuestion(q, idx) {
    const out = {
      id: `ql_${q.id || idx}`,
      type: q.type || 'multiple',
      question: q.question,
      correct: q.correct != null ? q.correct : q.correctAnswer,
      correctAnswer: q.correctAnswer != null ? q.correctAnswer : q.correct,
      explanation: q.explanation || '',
      grammarTags: q.grammarTags || [],
      topicTags: q.topicTags || [],
      vocabularyTags: q.vocabularyTags || [],
      difficulty: q.difficulty,
    };
    if (q.options?.length) out.options = [...q.options];
    if (q.signText) out.signText = q.signText;
    // Same as ExamBuilder.toExamQuestion: CHK-LEVEL gates publishing on per-question level.
    if (q.level) out.level = q.level;
    if (q.origin) out.origin = q.origin;
    return out;
  }

  function adsMatching() {
    if (typeof AdsMatching !== 'undefined') return AdsMatching;
    if (typeof globalThis !== 'undefined' && globalThis.AdsMatching) return globalThis.AdsMatching;
    if (typeof window !== 'undefined' && window.AdsMatching) return window.AdsMatching;
    return null;
  }

  function buildLesenPart(partSpec, questions, bank) {
    const layout = partSpec.layout || 'passage_questions';
    const { groups, enriched } = groupByPassage(questions, bank);
    const sharedPassage =
      typeof PassageResolver !== 'undefined'
        ? PassageResolver.resolvePassageForQuestions(bank, enriched)
        : null;

    const part = {
      teil: partSpec.teil,
      instruction: partSpec.instruction || partSpec.label,
      blueprintSlot: partSpec.slotType,
    };

    const AM = adsMatching();
    if (AM?.isAdsMatchingSpec(partSpec) && enriched.length) {
      return AM.buildAdsMatchingLesenPart(partSpec, enriched, toExamQuestion, bank);
    }

    if (layout === 'items' && enriched.length) {
      part.items = enriched.map((q, i) => {
        const passage = resolvePassage(bank, q) || sharedPassage;
        const eq = toExamQuestion(q, i);
        const pid =
          typeof PassageResolver !== 'undefined'
            ? PassageResolver.passageIdFromQuestion(q)
            : q.passageId;
        return {
          id: eq.id,
          type: eq.type,
          // For forum opinions (T4), each question carries its own individual opinion in
          // q.signText.  The shared passage.text is the forum intro, NOT the per-item text.
          // Prefer q.signText so individual opinions are preserved; only fall back to the
          // passage text when the question has no signText of its own (e.g. future layouts).
          signText: q.signText || q.text || passage?.text || '',
          passageId: pid || passage?.id || undefined,
          question: q.question,
          options: eq.options,
          correct: eq.correct,
          grammarTags: eq.grammarTags,
          topicTags: eq.topicTags,
          vocabularyTags: eq.vocabularyTags,
          difficulty: eq.difficulty,
          explanation: eq.explanation,
          origin: q.origin,
          translations: passage?.translations ? { ...passage.translations } : undefined,
        };
      });
      if (sharedPassage?.text) {
        part.textTitle = sharedPassage.title || '';
        part.text = sharedPassage.text;
        part.passageId = sharedPassage.id;
        if (sharedPassage.translations) part.translations = { ...sharedPassage.translations };
      }
      // When PassageResolver is unavailable (Node.js scripts context), sharedPassage is null.
      // For forum opinions (T4), the shared forum intro passage is in bank.passages[] keyed by
      // the questions' common passageId — resolve it directly so part.text = forum intro text
      // instead of falling through to the options-join fallback below.
      if (!part.text) {
        const repPid = enriched[0]?.passageId;
        const repP = repPid ? (bank.passages || []).find((p) => p.id === repPid) : null;
        if (repP?.text) {
          part.text = repP.text;
          part.textTitle = repP.title || '';
          part.passageId = repP.id;
        }
      }
      // NOTE: the sharedOpts.join('\n') fallback was removed here because for forum opinions
      // the options are ["a) Ja","b) Nein"] which should NOT become the passage text.
      // Any layout that genuinely needs the options as text can re-add it here with a guard.
      return part;
    }

    const [firstPid, firstQs] = [...groups.entries()][0] || ['', enriched];
    const groupEntries = [...groups.entries()].filter(([pid]) => !String(pid).startsWith('_solo_'));
    const passage =
      sharedPassage ||
      (firstPid && !firstPid.startsWith('_solo_') ? getPassage(bank, firstPid) : resolvePassage(bank, firstQs[0]));
    if (groupEntries.length > 1 && (partSpec.passagesPerPart >= 2 || layout === 'passage_questions')) {
      part.passages = groupEntries
        .map(([pid, qs]) => {
          const p = getPassage(bank, pid) || resolvePassage(bank, qs[0]);
          return p?.text ? { id: p.id, title: p.title || '', text: p.text } : null;
        })
        .filter(Boolean);
    }
    if (passage?.text) {
      part.textTitle = passage.title || '';
      part.text = passage.text;
      part.passageId = passage.id;
      if (passage.translations) part.translations = { ...passage.translations };
    }
    const allQs = enriched.length ? enriched : (firstQs.length ? firstQs : []);
    part.questions = allQs.map((q, i) => {
      const eq = toExamQuestion(q, i);
      const pid =
        typeof PassageResolver !== 'undefined'
          ? PassageResolver.passageIdFromQuestion(q)
          : q.passageId;
      if (pid) eq.passageId = pid;
      return eq;
    });
    return part;
  }

  function buildHorenPart(partSpec, questions, bank) {
    const { groups, enriched } = groupByPassage(questions, bank);
    const segments = [];
    const recWord = bank?.meta?.language === 'de' ? 'Aufnahme' : bank?.meta?.language === 'es' ? 'Grabación' : 'Recording';
    let si = 0;
    groups.forEach((qs, pid) => {
      const passage =
        pid && !pid.startsWith('_solo_') ? getPassage(bank, pid) : resolvePassage(bank, qs[0]);
      const transcript = passage?.text || qs[0]?.transcript || '';
      segments.push({
        id: `seg_${partSpec.teil}_${si}`,
        label: qs[0]?.segmentLabel || `${recWord} ${si + 1}`,
        transcript,
        passageId: passage?.id || (pid.startsWith('_solo_') ? undefined : pid),
        questions: qs.map((q, i) => {
          const eq = toExamQuestion(q, i);
          const qpid =
            typeof PassageResolver !== 'undefined'
              ? PassageResolver.passageIdFromQuestion(q)
              : q.passageId;
          if (qpid) eq.passageId = qpid;
          return eq;
        }),
        translations: passage?.translations ? { ...passage.translations } : undefined,
      });
      si++;
    });
    const partTranscript = segments.map((s) => s.transcript).filter(Boolean).join('\n\n');
    return {
      teil: partSpec.teil,
      instruction: partSpec.instruction || partSpec.label,
      blueprintSlot: partSpec.slotType,
      transcript: partTranscript || undefined,
      segments: segments.length
        ? segments
        : [{ id: `seg_${partSpec.teil}`, label: `${recWord} 1`, transcript: '', questions: [] }],
    };
  }

  function buildGrammatikPart(partSpec, questions) {
    return {
      teil: partSpec.teil,
      instruction: partSpec.instruction || partSpec.label,
      blueprintSlot: partSpec.slotType,
      questions: questions.map((q, i) => toExamQuestion(q, i)),
    };
  }

  function buildSchreibenPart(partSpec, questions) {
    const q = questions[0];
    const teil = Number(partSpec.teil ?? partSpec.aufgabe ?? 1);
    let words = partSpec.wordsTarget || { min: 80, max: 80 };
    if (typeof require !== 'undefined') {
      try {
        const { GOETHE_B1_SCHREIBEN_WORDS } = require('./goetheB1Constants.js');
        if (partSpec.taskFormat === 'informal_email' || teil === 1) words = GOETHE_B1_SCHREIBEN_WORDS[1];
        else if (partSpec.taskFormat === 'forum_opinion' || teil === 2) words = GOETHE_B1_SCHREIBEN_WORDS[2];
        else if (partSpec.taskFormat === 'semiformal_message' || teil === 3) words = GOETHE_B1_SCHREIBEN_WORDS[3];
      } catch (_) {
        /* optional constants */
      }
    }
    const taskText =
      q?.question ||
      (partSpec.label ? `${partSpec.label}: ${partSpec.instruction || 'Write your response.'}` : partSpec.instruction);
    if (!taskText) return null;
    return {
      aufgabe: partSpec.teil,
      fieldId: `write_bp_${partSpec.teil}`,
      task: taskText,
      minWords: words.min,
      maxWords: words.max,
      targetWords: words.target ?? words.min,
      mandatory: !!partSpec.mandatory,
      taskType: partSpec.taskTypes?.[0] || partSpec.slotType,
      blueprintSlot: partSpec.slotType,
      grammarTags: q?.grammarTags || [],
      topicTags: q?.topicTags || [],
    };
  }

  function buildSprechenPart(partSpec, questions, lang) {
    const q = questions[0];
    const isDe = lang === 'de';
    const part = {
      teil: partSpec.teil,
      title: partSpec.label || `Teil ${partSpec.teil}`,
      fieldId: `speak_bp_${partSpec.teil}`,
      situation: q?.question || partSpec.instruction || (isDe ? 'Bereiten Sie sich auf die mündliche Aufgabe vor.' : 'Prepare for the speaking task.'),
      points: partSpec.taskTypes || [],
      blueprintSlot: partSpec.slotType,
      grammarTags: q?.grammarTags || [],
      topicTags: q?.topicTags || [],
    };
    if (Number(partSpec.teil) === 2 && (partSpec.slides?.length || partSpec.presentationSlides)) {
      let slides = partSpec.slides;
      if (!slides?.length && typeof require !== 'undefined') {
        try {
          slides = require('./goetheB1Constants.js').GOETHE_B1_PRESENTATION_SLIDES;
        } catch (_) {
          slides = [];
        }
      }
      if (slides?.length) part.slides = slides.map((s) => ({ ...s }));
    }
    return part;
  }

  function buildUseOfEnglishPart(partSpec, questions, bank) {
    const layout = partSpec.layout || 'questions';
    if (layout === 'passage_questions' || layout === 'items') {
      return buildLesenPart(partSpec, questions, bank);
    }
    return buildGrammatikPart(partSpec, questions);
  }

  function routeModulePart(modId, partSpec, picked, bank, result) {
    const id = String(modId).toLowerCase();
    const lang = bank?.meta?.language || 'de';

    if (id === 'lesen' || id === 'reading') {
      if (!picked.length) return;
      result.lesenParts.push(buildLesenPart(partSpec, picked, bank));
    } else if (id === 'horen' || id === 'listening') {
      if (!picked.length) return;
      result.horenParts.push(buildHorenPart(partSpec, picked, bank));
    } else if (id === 'grammatik') {
      if (!picked.length) return;
      result.grammatikParts.push(buildGrammatikPart(partSpec, picked));
    } else if (id === 'use_of_english') {
      if (!picked.length) return;
      result.useOfEnglishParts.push(buildUseOfEnglishPart(partSpec, picked, bank));
    } else if (id === 'schreiben' || id === 'writing') {
      const sp = buildSchreibenPart(partSpec, picked);
      if (sp) result.schreibenParts.push(sp);
    } else if (id === 'sprechen' || id === 'speaking') {
      result.sprechenParts = result.sprechenParts || [];
      result.sprechenParts.push(buildSprechenPart(partSpec, picked, lang));
    }
  }

  /**
   * Assemble exam sections from blueprint + question bank.
   * Returns parts arrays and a coverage report (target vs filled).
   */
  function assemble(bank, blueprint, options = {}) {
    const used = new Set();
    const filterFn = options.filter || null;
    const difficultyRange = options.difficultyRange || null;
    const difficultyFilter = difficultyRange
      ? (q) => {
          if (q.difficulty == null) return true;
          return q.difficulty >= difficultyRange[0] && q.difficulty <= difficultyRange[1];
        }
      : null;
    const combinedFilter = filterFn && difficultyFilter
      ? (q) => filterFn(q) && difficultyFilter(q)
      : filterFn || difficultyFilter;

    const result = {
      lesenParts: [],
      horenParts: [],
      grammatikParts: [],
      useOfEnglishParts: [],
      schreibenParts: [],
      sprechenParts: [],
      selected: [],
      coverage: [],
    };

    for (const mod of blueprint.modules || []) {
      const pool = modulePool(bank, mod.id);
      for (const partSpec of mod.parts || []) {
        const target = partSpec.itemsTotal || partSpec.questionsTotal?.max || partSpec.questionsTotal?.min || 1;
        let picked = pickFromPool(pool, partSpec, used, bank, combinedFilter, {
          calibration: options.calibration,
          moduleId: mod.id,
          excludeIds: options.excludeIds,
          applyBurned: options.applyBurned,
        });
        if (!picked.length && difficultyFilter) {
          picked = pickFromPool(pool, partSpec, used, bank, filterFn, {
            calibration: options.calibration,
            moduleId: mod.id,
            excludeIds: options.excludeIds,
            applyBurned: options.applyBurned,
          });
        }
        const enrichedPicked =
          typeof PassageResolver !== 'undefined'
            ? PassageResolver.enrichQuestionPassageIds(picked)
            : picked;
        result.selected.push(...enrichedPicked);
        result.coverage.push({
          module: mod.id,
          teil: partSpec.teil,
          slotType: partSpec.slotType,
          taskFormat: partSpec.taskFormat,
          target,
          filled: enrichedPicked.length,
          complete: enrichedPicked.length >= (partSpec.questionsTotal?.min || target),
          wordsPerPassage: partSpec.wordsPerPassage || partSpec.wordsTarget || null,
        });

        routeModulePart(mod.id, partSpec, enrichedPicked, bank, result);
      }
    }

    return result;
  }

  function partTarget(partSpec) {
    return partSpec.itemsTotal || partSpec.questionsTotal?.max || partSpec.questionsTotal?.min || 1;
  }

  /** Build exam parts from pre-grouped picks (Phase 5 personalized assembly). */
  function finalizeAssembly(bank, blueprint, partEntries) {
    const result = {
      lesenParts: [],
      horenParts: [],
      grammatikParts: [],
      useOfEnglishParts: [],
      schreibenParts: [],
      sprechenParts: [],
      selected: [],
      coverage: [],
    };
    for (const entry of partEntries) {
      const { modId, partSpec, picked } = entry;
      const target = partTarget(partSpec);
      const enrichedPicked =
        typeof PassageResolver !== 'undefined' ? PassageResolver.enrichQuestionPassageIds(picked) : picked;
      result.selected.push(...enrichedPicked);
      result.coverage.push({
        module: modId,
        teil: partSpec.teil,
        slotType: partSpec.slotType,
        taskFormat: partSpec.taskFormat,
        target,
        filled: enrichedPicked.length,
        complete: enrichedPicked.length >= (partSpec.questionsTotal?.min || target),
        wordsPerPassage: partSpec.wordsPerPassage || partSpec.wordsTarget || null,
      });
      routeModulePart(modId, partSpec, enrichedPicked, bank, result);
    }
    return result;
  }

  function enumeratePartSlots(blueprint) {
    const slots = [];
    for (const mod of blueprint.modules || []) {
      for (const partSpec of mod.parts || []) {
        const target = partTarget(partSpec);
        for (let i = 0; i < target; i++) {
          slots.push({ modId: mod.id, partSpec, slotIndex: i });
        }
      }
    }
    return slots;
  }

  function coverageSummary(coverage) {
    const total = coverage.length;
    const complete = coverage.filter((c) => c.complete).length;
    return { total, complete, ratio: total ? complete / total : 0 };
  }

  return {
    INDEX,
    hasBlueprint,
    load,
    loadSync,
    cacheBlueprint,
    blueprintPath,
    assemble,
    finalizeAssembly,
    enumeratePartSlots,
    partTarget,
    coverageSummary,
    modulePool,
    pickFromPool,
    typeAllowed,
    ...(adsMatching() || {}),
  };
})();

if (typeof window !== 'undefined') window.ExamBlueprint = ExamBlueprint;
if (typeof module !== 'undefined') module.exports = ExamBlueprint;
