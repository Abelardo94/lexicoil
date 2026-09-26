/**
 * Blueprint fidelity — blueprint self-check + exam vs blueprint validation.
 */
const { validateAdsUnique } = require('../prompts/partPostprocess.js');
const {
  GOETHE_B1_PRESENTATION_SLIDES,
  GOETHE_B1_LESEN_T3_EXAMPLE,
  GOETHE_B1_AD_KEYS,
  GOETHE_B1_SCHREIBEN_WORDS,
  GOETHE_A2_SCHREIBEN_WORDS,
} = require('../../library/goetheB1Constants.js');

const GOETHE_A2_AD_KEYS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F']);

const MODULE_EXAM_KEYS = Object.freeze({
  lesen: 'lesenParts',
  reading: 'readingParts',
  horen: 'horenParts',
  listening: 'listeningParts',
  schreiben: 'schreibenParts',
  writing: 'schreibenParts',
  sprechen: 'sprechenParts',
  speaking: 'sprechenParts',
});

function checkBlueprintFidelity(blueprint) {
  const issues = [];
  if (!blueprint?.modules?.length) {
    issues.push('no_modules');
    return { ok: false, issues };
  }

  const modIds = blueprint.modules.map((m) => m.id);
  const examType = blueprint.examType || '';

  if (examType === 'goethe') {
    if (!modIds.includes('schreiben')) issues.push('missing_schreiben');
    if (!modIds.includes('sprechen')) issues.push('missing_sprechen');
    const sch = blueprint.modules.find((m) => m.id === 'schreiben');
    const sp = blueprint.modules.find((m) => m.id === 'sprechen');
    const lv = blueprint.level || 'B1';
    const minSch = lv === 'A1' || lv === 'A2' ? 1 : lv === 'B2' || lv === 'C1' || lv === 'C2' ? 2 : 3;
    const minSp = lv === 'A1' || lv === 'A2' ? 2 : lv === 'B2' || lv === 'C1' || lv === 'C2' ? 2 : 3;
    if ((sch?.parts || []).length < minSch) issues.push(`schreiben_parts:${(sch?.parts || []).length}<${minSch}`);
    if ((sp?.parts || []).length < minSp) issues.push(`sprechen_parts:${(sp?.parts || []).length}<${minSp}`);
  }

  if (examType === 'cambridge') {
    const uoe = blueprint.modules.find((m) => m.id === 'use_of_english');
    const uoeParts = uoe?.parts?.length
      ? uoe.parts
      : (blueprint.modules.find((m) => m.id === 'lesen')?.parts || []);
    const slots = uoeParts.map((p) => p.slotType);
    for (const required of ['open_cloze', 'word_formation', 'sentence_transformation']) {
      if (!slots.includes(required)) issues.push(`missing_cambridge:${required}`);
    }
    const listen = blueprint.modules.find((m) => m.id === 'listening' || m.id === 'horen');
    const lSlots = (listen?.parts || []).map((p) => p.slotType);
    if (!lSlots.includes('dialogue_speakers')) issues.push('missing_cambridge:speaker_matching');
  }

  if (examType === 'dele') {
    if (!modIds.includes('sprechen')) issues.push('missing_sprechen');
  }

  return { ok: issues.length === 0, issues };
}

function normQuestionType(item) {
  const t = String(item?.type || item?.questionType || '').toLowerCase();
  if (t === 'multiple') return 'multiple_choice';
  if (t === 'match') return 'matching';
  if (['rf', 'tf', 'true_false', 'richtig_falsch', 'rfn', 'r_f_n'].includes(t)) return 'true_false';
  if (['yn', 'ja_nein', 'jn'].includes(t)) return 'ja_nein';
  if (['mc', 'mcq', 'abcd'].includes(t)) return 'multiple_choice';
  if (['person_match', 'person_multi', 'matching_speaker'].includes(t)) return 'matching';
  return t;
}

function normBlueprintTypeToken(token) {
  const t = String(token || '').toLowerCase();
  if (t === 'multiple') return 'multiple_choice';
  if (t === 'match') return 'matching';
  if (t === 'richtig_falsch' || t === 'true_false') return 'true_false';
  if (t === 'ja_nein' || t === 'yn') return 'ja_nein';
  return t;
}

function typeAllowedForBlueprint(item, allowed) {
  if (!allowed?.length) return true;
  const t = normQuestionType(item);
  return allowed.some((a) => normBlueprintTypeToken(a) === t);
}

function getExamValidator() {
  if (typeof ExamValidator !== 'undefined') return new ExamValidator();
  if (typeof require !== 'undefined') return new (require('./ExamValidator.js'))();
  throw new Error('ExamValidator unavailable');
}

function getAnswerKeyVerifier() {
  if (typeof AnswerKeyVerifier !== 'undefined') return new AnswerKeyVerifier();
  if (typeof require !== 'undefined') return new (require('./AnswerKeyVerifier.js'))();
  throw new Error('AnswerKeyVerifier unavailable');
}

function examPartForTeil(exam, modId, teil) {
  const key = MODULE_EXAM_KEYS[String(modId).toLowerCase()];
  if (!key) return null;
  const parts = exam[key] || [];
  const n = Number(teil);
  return parts.find((p) => Number(p.teil ?? p.aufgabe) === n) ?? null;
}

function examHasModuleParts(exam, modId) {
  const key = MODULE_EXAM_KEYS[String(modId).toLowerCase()];
  if (!key) return false;
  return (exam[key] || []).some((p) => p && typeof p === 'object');
}

/**
 * Personal / section exams may include only one module or a subset of Teile.
 * A subset of Teile must be declared (`_sectionPart` / `_partialGen`): inferring it
 * from a missing Teil made every incomplete exam "partial", so part_missing never fired.
 * Only whole missing modules are still inferred (single-module practice exams).
 */
function inferPartialExamDelivery(exam, blueprint) {
  if (!exam || typeof exam !== 'object') return false;
  if (exam._sectionPart === true || exam._partialGen === true) return true;
  if (!blueprint?.modules?.length) return false;
  let modulesWithParts = 0;
  for (const mod of blueprint.modules) {
    if (examHasModuleParts(exam, String(mod.id || '').toLowerCase())) modulesWithParts += 1;
  }
  return modulesWithParts > 0 && modulesWithParts < blueprint.modules.length;
}

function wrapPartForModule(part, modId) {
  const mod = String(modId).toLowerCase();
  if (mod === 'lesen' || mod === 'reading') return { lesenParts: [part] };
  if (mod === 'horen' || mod === 'listening') return { horenParts: [part] };
  return {};
}

function countScorableItems(part, modId) {
  const wrapper = wrapPartForModule(part, modId);
  if (!Object.keys(wrapper).length) return 0;
  let n = 0;
  const v = getExamValidator();
  v._walk(wrapper, () => {
    n += 1;
  });
  return n;
}

function countPassagesInPart(part, bpPart) {
  const slot = String(bpPart?.slotType || part?.slotType || part?.blueprintSlot || '').toLowerCase();
  const expectedSegments = bpPart?.segmentsTotal;
  const layout = String(bpPart?.layout || '');

  if (slot.includes('forum') || slot.includes('opinion')) {
    const fromItems = (part.items || []).filter((it) => (it.signText || it.text || '').trim()).length;
    if (fromItems) return fromItems;
    const fromQuestions = (part.questions || []).filter((q) =>
      String(q.signText || q.text || '').trim(),
    ).length;
    if (fromQuestions) return fromQuestions;
    return part.text?.trim() ? 1 : 0;
  }
  if (slot.includes('ads_matching') || slot === 'ads_matching') {
    const expPassages = Number(bpPart?.passagesPerPart || 0);
    if (expPassages >= 2 && Array.isArray(part.passages) && part.passages.length) {
      const withText = part.passages.filter((p) => {
        const t = typeof p === 'string' ? p : p?.text;
        return String(t || '').trim();
      }).length;
      return withText || part.passages.length;
    }
    if (part.ads?.length) return 1;
    return 0;
  }
  if (Array.isArray(part.passages) && part.passages.length) {
    const withText = part.passages.filter((p) => {
      const t = typeof p === 'string' ? p : p?.text;
      return String(t || '').trim();
    }).length;
    if (withText) return withText;
    return part.passages.length;
  }
  if (Array.isArray(part.texts) && part.texts.length >= 2) {
    return part.texts.filter((t) => String(t || '').trim()).length || part.texts.length;
  }
  const altText = part.textB || part.text2 || part.secondText;
  if (part.text?.trim() && String(altText || '').trim()) return 2;
  if (Array.isArray(part.segments) && part.segments.length) {
    const expectedSegments = bpPart?.segmentsTotal;
    if (expectedSegments != null) {
      const n = Number(expectedSegments);
      if (n === 1) {
        if (part.transcript?.trim()) return 1;
        return part.segments.some((s) => String(s?.transcript || '').trim()) ? 1 : 0;
      }
      const keys = new Set();
      part.segments.forEach((s, i) => {
        if (!String(s?.transcript || '').trim()) return;
        const key =
          s.passageId ||
          s.id ||
          String(s.label || '')
            .replace(/\s*\d+\s*$/, '')
            .trim() ||
          `seg_${i}`;
        keys.add(String(key));
      });
      if (keys.size) return keys.size;
      return part.transcript?.trim() ? 1 : 0;
    }
    const withTranscript = part.segments.filter((s) => String(s?.transcript || '').trim()).length;
    return withTranscript || (part.transcript?.trim() ? 1 : 0);
  }

  if (layout === 'passage_questions' && Number(bpPart?.passagesPerPart || 0) >= 2) {
    const ids = new Set();
    (part.questions || []).forEach((q) => {
      const pid = q.passageId || q.context?.passageId;
      if (pid) ids.add(String(pid));
    });
    (part.items || []).forEach((it) => {
      const pid = it.passageId || it.context?.passageId;
      if (pid) ids.add(String(pid));
    });
    if (ids.size) return ids.size;
  }

  const texts = new Set();
  if (part.text?.trim()) texts.add(part.text.trim().slice(0, 240));
  (part.passages || []).forEach((p) => {
    const t = typeof p === 'string' ? p : p?.text || '';
    const pid = typeof p === 'object' && p ? p.id || p.passageId : null;
    if (t.trim()) texts.add(String(pid || t.trim().slice(0, 240)));
  });
  if (texts.size) return texts.size;
  if (part.transcript?.trim()) return 1;
  return part.text?.trim() ? 1 : 0;
}

function isPartialFidelityCountIssue(msg) {
  return (
    String(msg || '').startsWith('passages_per_part_mismatch:') ||
    String(msg || '').startsWith('items_total_mismatch:')
  );
}

function pushBlueprintFidelityIssue(msg, partialExam, errors, warnings, partDetail) {
  if (partialExam && isPartialFidelityCountIssue(msg)) {
    if (!warnings.includes(msg)) warnings.push(msg);
    partDetail.warnings = partDetail.warnings || [];
    if (!partDetail.warnings.includes(msg)) partDetail.warnings.push(msg);
    return;
  }
  errors.push(msg);
  partDetail.issues.push(msg);
}

function expectedPassageCount(bpPart) {
  if (bpPart?.segmentsTotal != null) return Number(bpPart.segmentsTotal);
  if (bpPart?.passagesPerPart != null) return Number(bpPart.passagesPerPart);
  return null;
}

function collectPartQuestions(part) {
  const qs = [];
  // Mirror flattenExam / ExamValidator._walk: segments[] wins when present.
  if (Array.isArray(part?.segments) && part.segments.length > 0) {
    for (const seg of part.segments) {
      if (Array.isArray(seg?.questions)) qs.push(...seg.questions);
      for (const it of seg.items || []) {
        if (it?.correct != null || it?.question || it?.type) qs.push(it);
      }
    }
    return qs;
  }
  if (Array.isArray(part?.questions)) qs.push(...part.questions);
  if (Array.isArray(part?.items)) {
    for (const it of part.items) {
      if (Array.isArray(it?.questions)) qs.push(...it.questions);
      else if (it?.correct != null || it?.question || it?.text) qs.push(it);
    }
  }
  return qs;
}

function extractCorrectKey(item) {
  const raw = Array.isArray(item?.correct) ? item.correct[0] : item?.correct;
  if (raw == null || raw === '') return null;
  return String(raw).trim().toUpperCase();
}

/**
 * Blueprint-driven: Teil requires each non-'0' assignment key at most once (Goethe ads matching).
 */
function bpPartRequiresUniqueNonZeroKeys(bpPart) {
  if (!bpPart) return false;
  if (bpPart.uniqueAnswerKeys === false) return false;
  if (bpPart.uniqueAnswerKeys === true) return true;
  const slot = String(bpPart.slotType || bpPart.taskFormat || '').toLowerCase();
  if (slot.includes('ads_matching') || slot.includes('matching_ads')) return true;
  if (slot.includes('picture_matching') || slot.includes('picture_schedule')) return true;
  if (bpPart.pictureOptions != null && Number(bpPart.pictureOptions) > 0) return true;
  if (bpPart.adsTotal != null && Number(bpPart.adsTotal) > 0) return true;
  return false;
}

function validateUniqueAssignmentKeys(items, partLabel) {
  const errors = [];
  const used = new Map();
  for (const it of items || []) {
    const k = extractCorrectKey(it);
    if (k == null || k === '0') continue;
    const id = it?.id || it?.number || it?.itemNumber || '';
    if (used.has(k)) {
      errors.push(`answer_key_not_unique:${partLabel},key=${k},first=${used.get(k)},duplicate=${id}`);
    } else {
      used.set(k, id);
    }
  }
  return errors;
}

const TF_DISTRIBUTION_TYPES = new Set(['true_false', 'ja_nein', 'richtig_falsch']);

function normalizeDistributionAnswer(item) {
  const k = extractCorrectKey(item);
  if (!k) return null;
  if (['R', 'RICHTIG', 'TRUE', 'T', 'W', 'WAHR'].includes(k)) return 'true';
  if (['F', 'FALSCH', 'FALSE', 'N'].includes(k)) return 'false';
  if (['J', 'JA', 'Y', 'YES'].includes(k)) return 'yes';
  if (['NEIN', 'NO'].includes(k)) return 'no';
  return k.toLowerCase();
}

function partHasTfDistributionCheck(bpPart) {
  const allowed = (bpPart?.questionTypes || []).map(normBlueprintTypeToken);
  if (allowed.some((t) => TF_DISTRIBUTION_TYPES.has(t))) return true;
  const slot = String(bpPart?.slotType || bpPart?.taskFormat || '').toLowerCase();
  return slot.includes('richtig_falsch') || slot.includes('forum_opinion') || slot.includes('ja_nein');
}

function validateAnswerDistribution(items, bpPart, partLabel) {
  if (!partHasTfDistributionCheck(bpPart)) return [];
  const answers = [];
  for (const it of items || []) {
    const t = normQuestionType(it);
    if (!TF_DISTRIBUTION_TYPES.has(t) && t !== 'richtig_falsch') continue;
    const norm = normalizeDistributionAnswer(it);
    if (norm) answers.push(norm);
  }
  if (answers.length < 3) return [];
  const unique = new Set(answers);
  if (unique.size === 1) {
    return [`answer_distribution_degenerate:${partLabel},value=${answers[0]},count=${answers.length}`];
  }
  return [];
}

/**
 * Semantic per-Teil checks (answer-key uniqueness, TF distribution warnings).
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateLesenT3AdsStructure(part, bpPart, partLabel) {
  const errors = [];
  if (!bpPart || bpPart.slotType !== 'ads_matching') return errors;

  const ads = part?.ads || [];
  const adKeys = ads.map((a) => String(a.key || '').toUpperCase()).filter(Boolean);
  if (adKeys.length !== 10) {
    errors.push(`ads_count_mismatch:${partLabel},expected=10,received=${adKeys.length}`);
  }
  for (let i = 0; i < GOETHE_B1_AD_KEYS.length; i++) {
    if (adKeys[i] !== GOETHE_B1_AD_KEYS[i]) {
      errors.push(`ads_keys_mismatch:${partLabel},expected=${GOETHE_B1_AD_KEYS.join('')},received=${adKeys.join('')}`);
      break;
    }
  }

  const items = collectPartQuestions(part);
  const usesSideAds = adKeys.length === GOETHE_B1_AD_KEYS.length;
  if (usesSideAds) {
    const hasNoMatch = items.some((it) => {
      const c = String(it.correct ?? it.correctAnswer ?? '').trim().toUpperCase();
      return c === '0';
    });
    if (!hasNoMatch) {
      errors.push(`matching_missing_no_match_situation:${partLabel}`);
    }
  } else {
    for (const it of items) {
      const opts = (it.options || []).map((o) => String(typeof o === 'object' ? o.key : o).toUpperCase());
      if (!opts.includes('0')) {
        errors.push(`matching_missing_zero_option:${partLabel},id=${it.id || it.number || '?'}`);
      }
    }
  }

  const ex = part?.example || part?.solvedExample;
  if (bpPart.exampleSituation !== false) {
    if (!ex || !String(ex.situation || ex.question || ex.text || '').trim()) {
      errors.push(`ads_example_missing:${partLabel}`);
    } else if (String(ex.correct ?? ex.correctAnswer ?? '').trim().toUpperCase() !== '0') {
      errors.push(`ads_example_not_zero:${partLabel},correct=${ex.correct ?? ex.correctAnswer ?? '?'}`);
    }
  }

  return errors;
}

/** Goethe A2 Lesen Teil 4 — 6 ads (a–f), 5 situations, one no-match (X / g). */
function validateLesenT4AdsStructure(part, bpPart, partLabel) {
  const errors = [];
  if (!bpPart || bpPart.slotType !== 'ads_matching' || Number(bpPart.teil) !== 4) return errors;
  const expectedAds = Number(bpPart.adsTotal || 0);
  if (expectedAds !== GOETHE_A2_AD_KEYS.length) return errors;

  const ads = part?.ads || [];
  const adKeys = ads.map((a) => String(a.key || '').toUpperCase()).filter(Boolean);
  if (adKeys.length !== GOETHE_A2_AD_KEYS.length) {
    errors.push(`ads_count_mismatch:${partLabel},expected=${GOETHE_A2_AD_KEYS.length},received=${adKeys.length}`);
  }
  for (let i = 0; i < GOETHE_A2_AD_KEYS.length; i++) {
    if (adKeys[i] && adKeys[i] !== GOETHE_A2_AD_KEYS[i]) {
      errors.push(`ads_keys_mismatch:${partLabel},expected=${GOETHE_A2_AD_KEYS.join('')},received=${adKeys.join('')}`);
      break;
    }
  }

  const passages = part?.passages || [];
  const expPassages = Number(bpPart.passagesPerPart || expectedAds);
  if (passages.length !== expPassages) {
    errors.push(`ads_passages_mismatch:${partLabel},expected=${expPassages},received=${passages.length}`);
  }

  const items = collectPartQuestions(part);
  let xAnswers = 0;
  for (const it of items) {
    const opts = (it.options || []).map((o) => String(typeof o === 'object' ? o.key : o).toUpperCase());
    const hasX = opts.some((o) => o === 'G' || o.includes('X'));
    if (!hasX) {
      errors.push(`matching_missing_x_option:${partLabel},id=${it.id || it.number || '?'}`);
    }
    const corr = String(it.correct ?? it.correctAnswer ?? '')
      .trim()
      .toUpperCase();
    if (corr === 'G' || corr === 'X') xAnswers += 1;
  }
  if (xAnswers !== 1) {
    errors.push(`matching_x_answer_count:${partLabel},expected=1,received=${xAnswers}`);
  }

  return errors;
}

function validateSprechenPresentationSlides(part, bpPart, partLabel) {
  const errors = [];
  if (!bpPart || bpPart.taskFormat !== 'presentation' || Number(bpPart.teil) !== 2) return errors;
  const slides = part?.slides || [];
  if (slides.length !== GOETHE_B1_PRESENTATION_SLIDES.length) {
    errors.push(`presentation_slides_count:${partLabel},expected=${GOETHE_B1_PRESENTATION_SLIDES.length},received=${slides.length}`);
    return errors;
  }
  for (let i = 0; i < GOETHE_B1_PRESENTATION_SLIDES.length; i++) {
    const exp = GOETHE_B1_PRESENTATION_SLIDES[i];
    const got = slides[i] || {};
    const title = String(got.title || got.text || '').trim();
    if (Number(got.n ?? got.number) !== exp.n || title !== exp.title) {
      errors.push(`presentation_slide_mismatch:${partLabel},slide=${exp.n},expected=${exp.title},received=${title || '?'}`);
    }
  }
  return errors;
}

function validateSchreibenWordTargets(part, bpPart, partLabel, blueprintLevel) {
  const errors = [];
  if (!bpPart || bpPart.slotType !== 'writing_task') return errors;
  const teil = Number(bpPart.teil ?? part?.teil ?? part?.aufgabe);
  const lv = String(blueprintLevel || '').toUpperCase();
  const expected =
    bpPart.wordsTarget ||
    (lv === 'A2' ? GOETHE_A2_SCHREIBEN_WORDS[teil] : GOETHE_B1_SCHREIBEN_WORDS[teil]);
  if (!expected) return errors;

  if (lv === 'A2' && part?.teil == null) {
    errors.push(`schreiben_teil_missing:${partLabel}`);
  }

  const minW = Number(part?.minWords);
  const maxW = Number(part?.maxWords ?? part?.minWords);
  const targetW = Number(part?.targetWords ?? part?.minWords);
  if (minW !== expected.min) {
    errors.push(`schreiben_min_words:${partLabel},expected=${expected.min},received=${minW || '?'}`);
  }
  if (expected.max != null && maxW !== expected.max) {
    errors.push(`schreiben_max_words:${partLabel},expected=${expected.max},received=${maxW || '?'}`);
  }
  if (Number.isFinite(targetW) && expected.target != null && targetW !== expected.target) {
    errors.push(`schreiben_target_words:${partLabel},expected=${expected.target},received=${targetW}`);
  }
  return errors;
}

function validateHorenMcqThreeOptions(items, partLabel) {
  const errors = [];
  for (const item of items) {
    const opts = item?.options || [];
    if (opts.length !== 3) {
      errors.push(`horen_t2_options_count:${partLabel},id=${item.id || item.number || '?'},expected=3,received=${opts.length}`);
      continue;
    }
    const keys = opts.map((o, i) => {
      const raw = typeof o === 'object' ? o.key || o.text : o;
      const m = String(raw || '')
        .trim()
        .match(/^([a-c])\)/i);
      return (m ? m[1] : String.fromCharCode(97 + i)).toLowerCase();
    });
    if (keys.join('') !== 'abc') {
      errors.push(`horen_t2_options_keys:${partLabel},id=${item.id || item.number || '?'},expected=abc,received=${keys.join('')}`);
    }
  }
  return errors;
}

/** Body of a lettered option, or '' when the option is just its own key. */
function letteredOptionBody(opt) {
  if (opt && typeof opt === 'object') {
    const key = String(opt.key ?? opt.id ?? '').trim();
    const text = String(opt.text ?? opt.label ?? opt.title ?? '').trim();
    if (!text) return '';
    return text.toUpperCase() === key.toUpperCase() ? '' : text;
  }
  const raw = String(opt ?? '').trim();
  const m = raw.match(/^([a-jA-J0])\)\s*(.*)$/s);
  const body = (m ? m[2] : raw).trim();
  if (!body) return '';
  if (m && body.toUpperCase() === m[1].toUpperCase()) return '';
  return body;
}

/**
 * A matching or gapped task must give the candidate something to choose between. Two Part 4
 * passages reached a published en/B1 exam with options ["a) A", ..., "h) H"]: the eight
 * candidate sentences were never generated, so the task could not be answered at all, and
 * every count-based check passed it because there were exactly eight options.
 *
 * The pool legitimately lives in ads[] for some shapes (Goethe Lesen T3, Cambridge Reading
 * P2) and the per-item options are then just key stubs — so a real ads[] clears the part.
 */
function validateLetteredPoolHasText(part, items, partLabel) {
  const errors = [];
  const adsWithText = (part?.ads || []).filter((a) => letteredOptionBody(a)).length;
  if (adsWithText >= 2) return errors;
  for (const item of items) {
    const opts = item?.options || [];
    if (opts.length < 2) continue;
    if (opts.some((o) => letteredOptionBody(o))) continue;
    errors.push(
      `options_without_text:${partLabel},id=${item.id || item.number || '?'},options=${opts.length}`,
    );
  }
  return errors;
}

function validateSprechenTaskContent(part, bpPart, partLabel) {
  const errors = [];
  const taskType = part?.taskType || bpPart?.taskTypes?.[0];
  if (!taskType || String(taskType).toLowerCase() === 'none') {
    errors.push(`sprechen_task_type_missing:${partLabel}`);
  }
  const situation = String(part?.situation || part?.task || '').trim();
  if (!situation || /^sin contenido$/i.test(situation)) {
    errors.push(`sprechen_situation_missing:${partLabel}`);
  }
  const topic = part?.topic || part?.topicTags?.[0];
  if (!topic || String(topic).trim() === '') {
    errors.push(`sprechen_topic_missing:${partLabel}`);
  }
  return errors;
}

/** Goethe A2 Hören Teil 2 — 9 pictures (a–i), 5 weekday matching, unique keys. */
function validateHorenPictureMatchingStructure(part, bpPart, partLabel) {
  const errors = [];
  if (!bpPart || !String(bpPart.slotType || '').includes('picture_matching')) return errors;
  const segs = part?.segments || [];
  const seg = segs[0] || part;
  const pictures = seg?.pictures || part?.pictures || [];
  if (pictures.length !== 9) {
    errors.push(`picture_count_mismatch:${partLabel},expected=9,received=${pictures.length}`);
  }
  const keys = pictures.map((p) => String(p.key || '').toLowerCase()).filter(Boolean);
  const expected = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  for (let i = 0; i < expected.length; i++) {
    if (keys[i] !== expected[i]) {
      errors.push(`picture_keys_mismatch:${partLabel},expected=${expected.join('')},received=${keys.join('')}`);
      break;
    }
  }
  const items = collectPartQuestions(part);
  if (items.length !== 5) {
    errors.push(`picture_matching_items:${partLabel},expected=5,received=${items.length}`);
  }
  for (const it of items) {
    if ((it.options || []).length) {
      errors.push(`picture_matching_has_options:${partLabel},id=${it.id || '?'}`);
    }
  }
  return errors;
}

function validatePartSemanticRules(part, bpPart, modId, teil, blueprintLevel) {
  const partLabel = `${String(modId).toLowerCase()}:teil=${Number(teil)}`;
  const items = collectPartQuestions(part);
  const errors = [];
  const warnings = [];

  if (bpPart && bpPartRequiresUniqueNonZeroKeys(bpPart)) {
    errors.push(...validateUniqueAssignmentKeys(items, partLabel));
  }

  if (String(modId).toLowerCase() === 'lesen' && Number(teil) === 3) {
    errors.push(...validateLesenT3AdsStructure(part, bpPart, partLabel));
  }
  if (String(modId).toLowerCase() === 'lesen' && Number(teil) === 4 && bpPart?.slotType === 'ads_matching') {
    errors.push(...validateLesenT4AdsStructure(part, bpPart, partLabel));
  }
  if (String(modId).toLowerCase() === 'sprechen' && Number(teil) === 2) {
    errors.push(...validateSprechenPresentationSlides(part, bpPart, partLabel));
  }
  if (String(modId).toLowerCase() === 'schreiben') {
    errors.push(...validateSchreibenWordTargets(part, bpPart, partLabel, blueprintLevel));
  }
  if (String(modId).toLowerCase() === 'horen' && Number(teil) === 2 && bpPart?.slotType === 'picture_matching') {
    errors.push(...validateHorenPictureMatchingStructure(part, bpPart, partLabel));
  }
  if (String(modId).toLowerCase() === 'horen' && Number(teil) === 2 && bpPart?.questionTypes?.includes('multiple_choice')) {
    errors.push(...validateHorenMcqThreeOptions(items, partLabel));
  }
  if (String(modId).toLowerCase() === 'sprechen') {
    errors.push(...validateSprechenTaskContent(part, bpPart, partLabel));
  }

  errors.push(...validateLetteredPoolHasText(part, items, partLabel));

  warnings.push(...validateAnswerDistribution(items, bpPart, partLabel));

  return { errors, warnings };
}

function collectAnswerKeyErrors(exam) {
  const verifier = getAnswerKeyVerifier();
  if (typeof verifier.collectStructuralKeyErrors === 'function') {
    return verifier.collectStructuralKeyErrors(exam);
  }
  const v = getExamValidator();
  const errors = [];
  v._walk(exam, (item, path, kind, part) => {
    if (!v._itemHasCorrect(item) && kind !== 'gap') {
      errors.push(v._missingKeyError(item, path, part));
      return;
    }
    let err = null;
    if (kind === 'mcq') err = v._validateMcq(item, path, part);
    else if (kind === 'match') err = v._validateMatch(item, path, part);
    else if (kind === 'gap') err = v._validateGap(item, path);
    if (err) errors.push(err);
  });
  return errors;
}

/**
 * @param {object} exam
 * @param {object} blueprint
 * @param {{ examLabel?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], details: object[] }}
 */
function validateExamAgainstBlueprint(exam, blueprint, options = {}) {
  const errors = [];
  const warnings = [];
  const details = [];
  const label = options.examLabel || exam.topic || exam.id || 'exam';
  const partialExam =
    options.partialExam === false
      ? false
      : options.partialExam === true || inferPartialExamDelivery(exam, blueprint);

  if (!exam || typeof exam !== 'object') {
    return { ok: false, errors: ['exam_not_object'], details: [] };
  }
  if (!blueprint?.modules?.length) {
    return { ok: false, errors: ['blueprint_missing_modules'], details: [] };
  }

  for (const mod of blueprint.modules) {
    const modId = String(mod.id || '').toLowerCase();
    const examKey = MODULE_EXAM_KEYS[modId];
    if (!examKey) continue;
    if (partialExam && !examHasModuleParts(exam, modId)) continue;

    for (const bpPart of mod.parts || []) {
      const teil = Number(bpPart.teil ?? bpPart.aufgabe);
      const part = examPartForTeil(exam, modId, teil);
      const partLabel = `${modId}:teil=${teil}`;
      const partDetail = {
        module: modId,
        teil,
        slotType: bpPart.slotType,
        issues: [],
      };

      if (!part) {
        const msg = `part_missing:${partLabel}`;
        if (partialExam) {
          continue;
        }
        errors.push(msg);
        partDetail.issues.push(msg);
        details.push(partDetail);
        continue;
      }

      const expectedItems = bpPart.itemsTotal ?? bpPart.questionsTotal?.min ?? bpPart.questionsTotal?.max;
      if (expectedItems != null) {
        let received = countScorableItems(part, modId);
        if (modId === 'schreiben' || modId === 'writing') {
          received = part.task || part.taskText || part.fieldId ? 1 : received;
        }
        if (modId === 'sprechen' || modId === 'speaking') {
          received = part.fieldId || part.prompts?.length || part.points?.length ? 1 : received;
        }
        if (received !== Number(expectedItems)) {
          const msg = `items_total_mismatch:${partLabel},expected=${expectedItems},received=${received}`;
          pushBlueprintFidelityIssue(msg, partialExam, errors, warnings, partDetail);
          partDetail.itemsTotal = { expected: Number(expectedItems), received };
        }
      }

      const expPassages = expectedPassageCount(bpPart);
      if (expPassages != null) {
        const receivedPassages = countPassagesInPart(part, bpPart);
        if (receivedPassages !== expPassages) {
          const msg = `passages_per_part_mismatch:${partLabel},expected=${expPassages},received=${receivedPassages}`;
          pushBlueprintFidelityIssue(msg, partialExam, errors, warnings, partDetail);
          partDetail.passagesPerPart = { expected: expPassages, received: receivedPassages };
        }
      }

      const wrapper = wrapPartForModule(part, modId);
      const v = getExamValidator();
      v._walk(wrapper, (item, path, kind, walkPart) => {
        if (!v._itemHasCorrect(item) && kind !== 'gap') {
          const msg = v._missingKeyError(item, path, walkPart);
          errors.push(msg);
          partDetail.issues.push(msg);
          return;
        }
        const allowed = bpPart.questionTypes || [];
        if (allowed.length && kind !== 'gap') {
          if (!typeAllowedForBlueprint(item, allowed)) {
            const t = normQuestionType(item);
            const msg = `question_type_not_allowed:${partLabel},id=${item.id || path},type=${t},allowed=${allowed.join('|')}`;
            errors.push(msg);
            partDetail.issues.push(msg);
          }
        }
        if (kind === 'mcq') {
          const qType = normQuestionType(item);
          const skipOptsCheck = ['true_false', 'ja_nein', 'richtig_falsch'].includes(qType);
          if (!skipOptsCheck && Array.isArray(item.options) && item.options.length) {
            const optErr = v._validateMcqOptions(item.options, path);
            if (optErr && !errors.includes(optErr)) {
              errors.push(optErr);
              partDetail.issues.push(optErr);
            }
          }
        }
      });

      const semantic = validatePartSemanticRules(part, bpPart, modId, teil, blueprint.level);
      for (const msg of semantic.errors) {
        if (!errors.includes(msg)) errors.push(msg);
        partDetail.issues.push(msg);
      }
      for (const msg of semantic.warnings) {
        if (!warnings.includes(msg)) warnings.push(msg);
        partDetail.warnings = partDetail.warnings || [];
        if (!partDetail.warnings.includes(msg)) partDetail.warnings.push(msg);
      }

      details.push(partDetail);
    }
  }

  for (const keyErr of collectAnswerKeyErrors(exam)) {
    if (!errors.includes(keyErr)) errors.push(keyErr);
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], details };
}

if (typeof module !== 'undefined') {
  module.exports = {
    checkBlueprintFidelity,
    validateExamAgainstBlueprint,
    validatePartSemanticRules,
    validateUniqueAssignmentKeys,
    validateLesenT3AdsStructure,
    validateSprechenPresentationSlides,
    validateSchreibenWordTargets,
    bpPartRequiresUniqueNonZeroKeys,
    collectPartQuestions,
    normQuestionType,
    countScorableItems,
    countPassagesInPart,
    examHasModuleParts,
    inferPartialExamDelivery,
    MODULE_EXAM_KEYS,
  };
}
if (typeof window !== 'undefined') {
  window.BlueprintFidelity = {
    checkBlueprintFidelity,
    validateExamAgainstBlueprint,
    validatePartSemanticRules,
  };
}
