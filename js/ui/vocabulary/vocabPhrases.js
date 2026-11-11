// ═══════════════════════════════════════════
// VOCAB PHRASES — gap fill + sentence reorder
// ═══════════════════════════════════════════
function vpWordLabel(fc, subject) {
  if (!fc) return '';
  if (typeof ManualVocab !== 'undefined' && ManualVocab.enrichFlashcard) ManualVocab.enrichFlashcard(fc, subject);
  const word =
    typeof vocabHubDisplayWord === 'function' ? vocabHubDisplayWord(fc, subject) : String(fc.word || '');
  return typeof esc === 'function' ? esc(word) : word;
}

function vpOptionLabel(option, pool, subject) {
  const o = String(option || '').trim();
  const fc = pool.find((f) => String(f.word || '').trim().toLowerCase() === o.toLowerCase());
  if (fc) return vpWordLabel(fc, subject);
  return typeof esc === 'function' ? esc(o) : o;
}

function vpLemmaTranslation(targetWord, pool) {
  const w = String(targetWord || '').trim().toLowerCase();
  const fc = (pool || []).find((f) => String(f.word || '').trim().toLowerCase() === w);
  if (!fc || typeof fcCardTranslation !== 'function') return '';
  const tr = fcCardTranslation(fc);
  return tr && tr !== '—' ? tr : '';
}

function vpPhraseTranslation(p, pool) {
  const ai = String(p?.translation || '').trim();
  if (ai) return ai;
  return vpLemmaTranslation(p?.targetWord, pool);
}

function vpFeedbackTrLine(targetWord, pool, phrase) {
  const tr = vpPhraseTranslation(phrase || { targetWord }, pool);
  return tr ? '<div class="ve-feedback-tr">' + esc(tr) + '</div>' : '';
}

function vpToggleMeaning(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function startVocabPhrases(opts = {}) {
  const creditCost = typeof vocabPhrasesCreditCost === 'function' ? vocabPhrasesCreditCost() : 1;
  if (typeof requireAiCredits === 'function' && !requireAiCredits('vocab_phrases', { message: 'Phrase practice uses ' + creditCost + ' credit from your monthly allowance.' })) return;
  ensureFcIds();
  const pool = typeof getSelectedFC === 'function' ? getSelectedFC() : [];
  if (pool.length < 2) {
    lcToast('Select at least 2 words for phrase practice.', 'warn');
    return;
  }
  const words = pool.map((f) => String(f.word || '').trim()).filter(Boolean);
  const goal = typeof getActiveGoal === 'function' ? getActiveGoal() : null;
  let sessionWords = words;
  if (typeof VocabBatching !== 'undefined' && VocabBatching.selectForActivity) {
    const sel = VocabBatching.selectForActivity(words, 'vocab_phrases', goal);
    sessionWords = sel.words;
    S.vpActivityWords = sessionWords.slice();
    if (goal && typeof saveGoals === 'function') saveGoals();
  }
  const subject = goal?.subject || S.deckGoalFilter || S.subject || 'de';
  const level = goal?.level || S.level || 'B1';
  const uiLang =
    typeof resolveActiveVocabUiLang === 'function'
      ? resolveActiveVocabUiLang()
      : typeof translationLang === 'function'
        ? translationLang()
        : 'en';
  hideAll();
  show('loadingScreen');
  const lt = document.getElementById('loaderTitle');
  const ls = document.getElementById('loaderSub');
  if (lt) lt.textContent = typeof vocabT === 'function' ? vocabT().buildingPhrases : 'Building phrases…';
  if (ls) ls.textContent = typeof vocabT === 'function' ? vocabT().buildingPhrasesSub(creditCost) : 'AI is writing everyday sentences (' + creditCost + ' credit)';
  let phrases = [];
  try {
    if (typeof generateVocabPhrasesWithAI !== 'function') throw new Error('Phrases unavailable');
    phrases = await generateVocabPhrasesWithAI(sessionWords, {
      lang: subject,
      level,
      count: Math.min(5, sessionWords.length),
      uiLang,
    });
  } catch (e) {
    hideAll();
    vpBackFromPhrases();
    if (e.code === 'ai_credits_exhausted') {
      if (typeof showAiCreditsExhausted === 'function') showAiCreditsExhausted();
    } else {
      lcToast('Could not generate phrases: ' + (e.message || 'error'), 'error', 7000);
    }
    return;
  }
  S.vpPhrases = phrases;
  S.vpPool = pool;
  S.vpIndex = 0;
  S.vpPhase = 'gap';
  S.vpScore = 0;
  S.vpGapScore = 0;
  S.vpOrderScore = 0;
  S.vpFromVocab = !!opts.fromVocab;
  S.vpRetakePhraseId = null;
  if (typeof SavedVocabPhrases !== 'undefined' && SavedVocabPhrases.persistAfterGeneration) {
    S.vpSavedPhraseSetId = SavedVocabPhrases.persistAfterGeneration({
      goal,
      subject,
      level,
      uiLang,
      phrases,
      pool,
    });
  } else S.vpSavedPhraseSetId = null;
  hide('loadingScreen');
  if (typeof ActivityTrack !== 'undefined') ActivityTrack.beginSession('vocab_phrases', goal?.id, 'Phrase practice');
  show('vocabPhrasesScreen');
  if (typeof applyVocabPhrasesChrome === 'function') applyVocabPhrasesChrome();
  const vt = typeof vocabT === 'function' ? vocabT() : null;
  const lede = document.getElementById('vpLede');
  if (lede) {
    const gl = goal && typeof goalLabel === 'function' ? goalLabel(goal) : vt ? vt.yourDeck : 'Your deck';
    lede.textContent = vt ? vt.phrasesLede(gl, phrases.length, creditCost) : gl + ' · ' + phrases.length + ' phrases · ' + creditCost + ' credit';
  }
  renderVpPhrase();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function vpBackFromPhrases() {
  if (S.vpFromVocab && typeof backToWorkspace === 'function') backToWorkspace('vocabulary');
  else if (typeof goHome === 'function') goHome();
}

function exitVocabPhrases() {
  vpBackFromPhrases();
}

function launchVocabHubPhrases() {
  const goal = S.goals.find((g) => g.id === _vocabHub.goalId);
  if (!goal) return;
  const ids = vocabHubSelectedIds(goal);
  if (ids.length < 2) {
    lcToast('Select at least 2 words for phrases.', 'warn');
    return;
  }
  S.activeGoalId = goal.id;
  syncGoalToProfile(goal);
  saveGoals();
  ensureFcIds();
  S.fcSelected = new Set(ids);
  S.vpFromVocab = true;
  startVocabPhrases({ fromVocab: true });
}

function renderVpPhrase() {
  const vc = document.getElementById('vpContent');
  if (!vc) return;
  const vt = typeof vocabT === 'function' ? vocabT() : null;
  const phrases = S.vpPhrases || [];
  if (S.vpIndex >= phrases.length) {
    const total = phrases.length * 2;
    const pct = total ? Math.round((S.vpScore / total) * 100) : 0;
    flushOpenStudySession({ type: 'vocab_phrases', score: pct, label: 'Phrases · ' + pct + '%' });
    const savedId = S.vpRetakePhraseId || S.vpSavedPhraseSetId;
    if (savedId && typeof SavedVocabPhrases !== 'undefined' && SavedVocabPhrases.recordResult) {
      SavedVocabPhrases.recordResult(savedId, pct);
    }
    S.vpRetakePhraseId = null;
    S.vpSavedPhraseSetId = null;
    const rot = S.vpActivityWords || [];
    const g = typeof getActiveGoal === 'function' ? getActiveGoal() : null;
    if (g && rot.length && typeof VocabBatching !== 'undefined' && VocabBatching.recordActivityUsage) {
      VocabBatching.recordActivityUsage(g, 'vocab_phrases', rot);
      S.vpActivityWords = null;
    }
    vc.innerHTML =
      '<div class="ws-panel ve-results-panel"><div class="ve-big ' +
      (pct >= 70 ? 'pass' : pct >= 50 ? 'mid' : 'fail') +
      '">' +
      pct +
      '%</div><p class="exam-config-lede">' +
      (vt ? vt.stepsCorrect(S.vpScore, total) : S.vpScore + '/' + total + ' steps correct') +
      '</p><button class="btn-start" onclick="exitVocabPhrases()" style="max-width:220px;margin:16px auto 0">' +
      (vt ? vt.backToVocab : '← Back to vocabulary') +
      '</button></div>';
    return;
  }
  const p = phrases[S.vpIndex];
  const goal = typeof getActiveGoal === 'function' ? getActiveGoal() : null;
  const subject = goal?.subject || S.subject || 'de';
  document.getElementById('vpProg').textContent = vt ? vt.phraseOf(S.vpIndex + 1, phrases.length) : 'Phrase ' + (S.vpIndex + 1) + ' of ' + phrases.length;
  document.getElementById('vpBar').style.width = (S.vpIndex / phrases.length) * 100 + '%';
  const phaseLbl = document.getElementById('vpPhaseLbl');
  if (phaseLbl) phaseLbl.textContent = S.vpPhase === 'gap' ? (vt ? vt.gapPhase : 'Gap fill') : vt ? vt.orderPhase : 'Word order';
  if (S.vpPhase === 'gap') {
    renderVpGap(vc, p, subject);
  } else {
    renderVpOrder(vc, p);
  }
}

function renderVpGap(vc, p, subject) {
  const vt = typeof vocabT === 'function' ? vocabT() : null;
  const pool = S.vpPool || [];
  const meaning = vpPhraseTranslation(p, pool);
  const meaningId = 'vpMean_' + (S.vpIndex || 0);
  const meaningBtn = meaning
    ? '<button type="button" class="btn-sm vp-mean-btn" onclick="vpToggleMeaning(\'' +
      meaningId +
      '\')">' +
      (vt ? vt.showMeaning || 'Show meaning' : 'Show meaning') +
      '</button><div class="vp-phrase-mean" id="' +
      meaningId +
      '" style="display:none;margin-top:10px;font-size:14px;color:var(--text-secondary);font-style:italic">' +
      esc(meaning) +
      '</div>'
    : '';
  const distractors = vpPickGapOptions(p, pool);
  const optHtml = distractors
    .map((o) => {
      const label = vpOptionLabel(o, pool, subject);
      return '<button type="button" class="ve-opt opt vp-gap-opt" data-ans="' + esc(o) + '">' + label + '</button>';
    })
    .join('');
  vc.innerHTML =
    '<div class="ws-panel ve-question-panel"><p class="ve-prompt-lbl">' +
    (vt ? vt.completePhrase : 'Complete the phrase') +
    '</p><div class="ve-word vp-phrase">' +
    esc(p.display) +
    '</div>' +
    meaningBtn +
    '<p class="ve-meta">' +
    (vt ? vt.whichFits : 'Which word fits the blank?') +
    '</p></div><div class="ve-opts options" id="vpGapOpts" data-correct="' +
    esc(p.blankToken) +
    '" data-target="' +
    esc(p.targetWord) +
    '">' +
    optHtml +
    '</div>';
  document.getElementById('vpGapOpts')?.addEventListener('click', vpAnsGap, { once: false });
}

function vpPickGapOptions(p, pool) {
  const blank = String(p.blankToken || '').trim();
  const target = String(p.targetWord || '').trim();
  if (typeof VocabQuizUtils !== 'undefined' && VocabQuizUtils.pickPhraseGapOptions && VocabQuizUtils.buildWordMeta) {
    const meta = VocabQuizUtils.buildWordMeta(pool);
    const opts = VocabQuizUtils.pickPhraseGapOptions(blank, target, meta);
    if (opts.length >= 2) return opts;
  }
  const opts = [blank];
  const seen = new Set([blank.toLowerCase(), target.toLowerCase()]);
  const norm = typeof normWordType === 'function' ? normWordType : (t) => t || 'other';
  const targetPos = norm(pool.find((f) => String(f.word || '').trim().toLowerCase() === target.toLowerCase())?.type);
  for (const f of [...pool].sort(() => Math.random() - 0.5)) {
    const w = String(f.word || '').trim();
    if (!w || seen.has(w.toLowerCase())) continue;
    if (targetPos !== 'other' && norm(f.type || f.pos) !== targetPos) continue;
    seen.add(w.toLowerCase());
    opts.push(w);
    if (opts.length >= 4) break;
  }
  return opts.sort(() => Math.random() - 0.5).slice(0, 4);
}

function vpAnsGap(ev) {
  const el = ev.target.closest('.vp-gap-opt');
  if (!el || el.classList.contains('dis') || S.vpAnswered) return;
  const optsEl = document.getElementById('vpGapOpts');
  const corr = optsEl?.dataset.correct || '';
  const targetWord = optsEl?.dataset.target || '';
  const ans = el.dataset.ans || '';
  const pool = S.vpPool || [];
  document.querySelectorAll('.vp-gap-opt').forEach((o) => o.classList.add('dis'));
  const match = ans.trim().toLowerCase() === corr.trim().toLowerCase();
  if (match) {
    el.classList.add('correct');
    S.vpGapScore++;
    S.vpScore++;
  } else {
    el.classList.add('wrong');
    document.querySelectorAll('.vp-gap-opt').forEach((o) => {
      if ((o.dataset.ans || '').trim().toLowerCase() === corr.trim().toLowerCase()) o.classList.add('correct');
    });
  }
  S.vpAnswered = true;
  optsEl?.removeEventListener('click', vpAnsGap);
  const trLine = vpFeedbackTrLine(targetWord, pool, (S.vpPhrases || [])[S.vpIndex] || null);
  const vt = typeof vocabT === 'function' ? vocabT() : null;
  const fb =
    '<div class="ve-feedback ' +
    (match ? 'ok' : 'bad') +
    '"><div>' +
    (match ? (vt ? vt.correct : '✓ Correct!') : vt ? vt.wordWas : '✗ The word was:') +
    '</div><div class="ve-feedback-word">' +
    esc(corr) +
    '</div>' +
    trLine +
    '</div><button type="button" class="btn-start ve-next" onclick="vpNextGap()">' +
    (vt ? vt.orderWords : 'Order the words →') +
    '</button>';
  document.getElementById('vpContent')?.insertAdjacentHTML('beforeend', fb);
}

function vpNextGap() {
  S.vpAnswered = false;
  S.vpPhase = 'order';
  renderVpPhrase();
}

function renderVpOrder(vc, p) {
  const vt = typeof vocabT === 'function' ? vocabT() : null;
  const tokens = [...(p.tokens || [])];
  const shuffled = [...tokens].sort(() => Math.random() - 0.5);
  S.vpOrderPick = [];
  const chipHtml = shuffled
    .map(
      (t, i) =>
        '<button type="button" class="vp-tok-chip" data-tok="' +
        esc(t) +
        '" data-idx="' +
        i +
        '">' +
        esc(t) +
        '</button>',
    )
    .join('');
  vc.innerHTML =
    '<div class="ws-panel ve-question-panel"><p class="ve-prompt-lbl">' +
    (vt ? vt.putInOrder : 'Put the words in order') +
    '</p><p class="ve-meta">' +
    (vt ? vt.orderMeta : 'Tap words to build the sentence (German word order)') +
    '</p></div>' +
    '<div class="vp-order-built" id="vpOrderBuilt"></div>' +
    '<div class="vp-order-pool" id="vpOrderPool">' +
    chipHtml +
    '</div>' +
    '<div class="hg-actions" style="margin-top:16px"><button type="button" class="hg-btn" onclick="vpClearOrder()">' +
    (vt ? vt.clear : 'Clear') +
    '</button><button type="button" class="hg-btn hg-primary" onclick="vpCheckOrder()">' +
    (vt ? vt.checkOrder : 'Check order') +
    '</button></div>';
  document.getElementById('vpOrderPool')?.addEventListener('click', vpPickToken);
}

function vpPickToken(ev) {
  const el = ev.target.closest('.vp-tok-chip');
  if (!el || el.classList.contains('used')) return;
  const tok = el.dataset.tok || '';
  S.vpOrderPick = S.vpOrderPick || [];
  S.vpOrderPick.push(tok);
  el.classList.add('used');
  const built = document.getElementById('vpOrderBuilt');
  if (built) {
    built.innerHTML = S.vpOrderPick.map((t) => '<span class="vp-built-tok">' + esc(t) + '</span>').join(' ');
  }
}

function vpClearOrder() {
  S.vpOrderPick = [];
  document.querySelectorAll('.vp-tok-chip').forEach((c) => c.classList.remove('used'));
  const built = document.getElementById('vpOrderBuilt');
  if (built) built.innerHTML = '';
}

function vpCheckOrder() {
  const p = S.vpPhrases[S.vpIndex];
  const expected = (p.tokens || []).join(' ').replace(/\s+/g, ' ').trim();
  const actual = (S.vpOrderPick || []).join(' ').replace(/\s+/g, ' ').trim();
  const match = actual === expected;
  if (match) {
    S.vpOrderScore++;
    S.vpScore++;
  }
  const vc = document.getElementById('vpContent');
  const trLine = vpFeedbackTrLine(p.targetWord, S.vpPool || [], p);
  const vt = typeof vocabT === 'function' ? vocabT() : null;
  const fb =
    '<div class="ve-feedback ' +
    (match ? 'ok' : 'bad') +
    '"><div>' +
    (match ? (vt ? vt.perfectOrder : '✓ Perfect order!') : vt ? vt.correctOrder : '✗ Correct order:') +
    '</div><div class="ve-feedback-word">' +
    esc(p.full) +
    '</div>' +
    trLine +
    '</div><button type="button" class="btn-start ve-next" onclick="vpNextPhrase()">' +
    (S.vpIndex + 1 >= S.vpPhrases.length ? (vt ? vt.seeResults : 'See results →') : vt ? vt.nextPhrase : 'Next phrase →') +
    '</button>';
  vc?.insertAdjacentHTML('beforeend', fb);
  document.getElementById('vpOrderPool')?.replaceWith(document.createElement('div'));
}

function vpNextPhrase() {
  S.vpAnswered = false;
  S.vpPhase = 'gap';
  S.vpIndex++;
  S.vpOrderPick = [];
  renderVpPhrase();
}

window.vpToggleMeaning = vpToggleMeaning;
window.startVocabPhrases = startVocabPhrases;
window.launchVocabHubPhrases = launchVocabHubPhrases;
window.exitVocabPhrases = exitVocabPhrases;
