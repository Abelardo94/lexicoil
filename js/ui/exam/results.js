// ═══════════════════════════════════════════
// SUBMIT EXAM + CORRECTION
// ═══════════════════════════════════════════
const OPTION_LETTER_TYPES = new Set(['multiple', 'match', 'matching', 'abcd']);
const RF_TYPES = new Set(['rf', 'tf', 'richtig_falsch', 'true_false']);
/** Free-text answers: shown verbatim. gap_fill covers Cambridge open cloze and
 *  sentence completion, whose answer is a word or phrase ("swimming pool"), not
 *  an option letter — it carries options:[] in all 36 en/B1 items and none in
 *  de/*. Listing it as an option-letter type sent it down the letter branch,
 *  which found no option to label and fell back to .toUpperCase(). */
const FREE_TEXT_TYPES = new Set(['gap_fill', 'gap']);

function optionLetter(opt) {
  if (typeof IsAnswerKeyRenderable !== 'undefined' && IsAnswerKeyRenderable.optKey) {
    return IsAnswerKeyRenderable.optKey(opt);
  }
  if (opt && typeof opt === 'object') {
    const raw = opt.key != null ? opt.key : opt.id;
    if (raw != null) return String(raw).trim();
    return String(opt.text || '').slice(0, 1);
  }
  if (typeof opt === 'string') {
    if (opt.length === 1) return opt;
    const m = opt.match(/^([A-Za-z0-9])\)\s*/);
    if (m) return m[1];
    return opt;
  }
  return String(opt ?? '');
}

function lettersMatch(a, b) {
  return String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
}

function findOptionByVal(q, val) {
  const opts = q?.options;
  if (!opts?.length || val == null || val === '') return null;
  return opts.find((o) => lettersMatch(optionLetter(o), val)) ?? null;
}

function formatLetterOptionLabel(opt, rawVal, isDE) {
  if (opt && typeof opt === 'object') {
    const key = String(opt.key ?? optionLetter(opt)).toUpperCase();
    const title = String(opt.title || opt.text || opt.label || '').trim();
    if (key === '0') return isDE ? '0 (keine Zuordnung)' : '0 (no match)';
    if (title && title.toLowerCase() !== key.toLowerCase()) return `${key} — ${title}`;
    return key;
  }
  if (typeof opt === 'string') {
    if (opt.length === 1) return opt.toUpperCase();
    const m = opt.match(/^([A-Za-z0-9])\)\s*(.*)$/);
    if (m) {
      const k = m[1].toUpperCase();
      const rest = (m[2] || '').trim();
      if (rest.toUpperCase() === 'X') return `${k} — X`;
      if (rest && rest.toLowerCase() !== k.toLowerCase()) return `${k} — ${rest}`;
      return k;
    }
    return opt;
  }
  return String(rawVal ?? '');
}

function enrichMatchingQFromPart(q, part) {
  if (!q || String(q.type) !== 'matching' || !part?.ads?.length) return q;
  const hasRichOpts = (q.options || []).some((o) => o && typeof o === 'object' && (o.title || o.text));
  if (hasRichOpts) return q;
  const opts = part.ads.map((a, i) => {
    const raw = a.key != null ? String(a.key) : String.fromCharCode(97 + i);
    const key = raw.length === 1 ? raw.toUpperCase() : raw;
    const title = String(a.title || '').trim();
    const text = String(a.text || a.title || '').trim();
    return { key, title, text: title || text };
  });
  const keys = new Set(opts.map((o) => String(o.key).toUpperCase()));
  if (!keys.has('0') && !keys.has('G')) {
    opts.push({ key: '0', title: 'X', text: 'X' });
  }
  q.options = opts;
  return q;
}

function ansLabel(q, val, isDE) {
  if (!val) return '—';
  if (q.type === 'yn' || q.type === 'ja_nein') return val === 'J' || val === 'Ja' ? 'Ja' : val === 'N' || val === 'Nein' ? 'Nein' : val;
  if (q.type === 'rfn') return val === 'R' ? (isDE ? 'Richtig' : 'True') : val === 'F' ? (isDE ? 'Falsch' : 'False') : val === 'N' ? (isDE ? 'Nicht im Text' : 'Not in text') : val;
  if (q.type === 'person_multi') {
    try { const a = JSON.parse(val); if (Array.isArray(a)) return a.join(', '); } catch (_) {}
    return val;
  }
  // Before the R/T/F fallbacks below: a one-word cloze answer like "for" or "t"
  // must not be relabelled "True"/"False".
  if (FREE_TEXT_TYPES.has(q.type)) return String(val);
  if (OPTION_LETTER_TYPES.has(q.type)) {
    const opt = findOptionByVal(q, val);
    if (opt != null) return formatLetterOptionLabel(opt, val, isDE);
    if (val === '0' || String(val) === '0') return isDE ? '0 (keine Zuordnung)' : '0 (no match)';
    return String(val).toUpperCase();
  }
  if (RF_TYPES.has(q.type)) {
    if (val === 'R' || val === 'T') return isDE ? 'Richtig' : 'True';
    if (val === 'F') return isDE ? 'Falsch' : 'False';
    return val;
  }
  if (val === 'R' || val === 'T') return isDE ? 'Richtig' : 'True';
  if (val === 'F') return isDE ? 'Falsch' : 'False';
  return val;
}
function correctLabel(q, isDE) {
  if (Array.isArray(q.correct)) return q.correct.join(', ');
  // Open cloze with more than one right word: show them all ("because / as / since").
  if (FREE_TEXT_TYPES.has(q.type) && Array.isArray(q.acceptedAnswers) && q.acceptedAnswers.length) {
    return [q.correct, ...q.acceptedAnswers].map((a) => String(a ?? '').trim()).filter(Boolean)
      .filter((a, i, all) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i).join(' / ');
  }
  return ansLabel(q, q.correct, isDE);
}
function countSpeakExchanges(text, isDE) {
  const re = isDE ? /^\s*Ich\s*:/gim : /^\s*Me\s*:/gim;
  return (text.match(re) || []).length;
}
function getSchreibenAns(p){
  if(p.formFields)return p.formFields.map((_,i)=>document.getElementById(p.fieldId+'_'+i)?.value.trim()||'').join('\n');
  return document.getElementById(p.fieldId)?.value.trim()||'';
}
function writingLengthHint(schreiben, writeAns, isDE) {
  const de = isDE ?? (S.examData?.lang === 'de');
  if (schreiben.formFields) {
    const filled = schreiben.formFields.filter((_, i) => {
      const el = document.getElementById(schreiben.fieldId + '_' + i);
      return el?.value.trim();
    }).length;
    const total = schreiben.formFields.length;
    const lengthOk = filled >= total;
    const note = de
      ? `Orientativ: ${filled}/${total} Felder ausgefüllt${lengthOk ? ' (OK)' : ' (unvollständig)'}`
      : `Orientative: ${filled}/${total} fields filled${lengthOk ? ' (OK)' : ' (incomplete)'}`;
    return { words: filled, min: total, lengthOk, hint: note, note, orientative: true };
  }
  const words = writeAns.split(/\s+/).filter((x) => x).length;
  const min = schreiben.minWords || 40;
  const lengthOk = words >= min;
  let note;
  if (lengthOk) {
    note = de
      ? `Orientativ: ${words} Wörter (Minimum ${min} — Länge OK)`
      : `Orientative: ${words} words (minimum ${min} — length OK)`;
  } else if (words >= min * 0.6) {
    note = de
      ? `Orientativ: ${words}/${min} Wörter — etwas zu kurz`
      : `Orientative: ${words}/${min} words — slightly short`;
  } else {
    note = de
      ? `Orientativ: ${words}/${min} Wörter — zu kurz`
      : `Orientative: ${words}/${min} words — too short`;
  }
  return { words, min, lengthOk, hint: note, note, orientative: true };
}

/** @deprecated use writingLengthHint — no numeric grade */
function gradeWriting(schreiben, writeAns) {
  return writingLengthHint(schreiben, writeAns);
}
function gradeSpeaking(sprechen, speakAns, isDE) {
  if (sprechen.minWords) {
    const words = speakAns.split(/\s+/).filter((x) => x).length;
    const min = sprechen.minWords;
    let score = words >= min ? 80 : words >= min * 0.6 ? 58 : 35;
    const note = isDE
      ? `Präsentation: ${words} Wörter (mindestens ${min}).`
      : `Presentation: ${words} words (minimum ${min}).`;
    return { score, note, words, min };
  }
  const exchanges = countSpeakExchanges(speakAns, isDE);
  const min = sprechen.minExchanges || 3;
  let score = 30;
  let note = isDE
    ? `Du hast ${exchanges} Antwort(en) mit „Ich:“ geschrieben (mindestens ${min}).`
    : `You wrote ${exchanges} reply line(s) starting with “Me:” (minimum ${min}).`;
  if (exchanges >= min && speakAns.length > 30) {
    score = 80;
    note += isDE ? ' Gute Länge — vergleiche mit dem Muster.' : ' Good length — compare with the model below.';
  } else if (exchanges >= min || speakAns.length > 40) {
    score = 62;
  }
  return { score, note, exchanges, min };
}
function buildCorrection(d, isDE, writeAns, speakAns, passPercent = 60) {
  const parts = [];
  const pushQ = (mod, title, items) => {
    if (!items.length) return;
    parts.push({ mod, title, items });
  };
  if (d.goetheFormat) {
    d.lesenParts?.forEach((p, pi) => {
      const items = [];
      const meta = { module: 'lesen', teil: p.teil, part: p };
      const pushLesenItem = (item, idx) => {
        if (!lesenItemIsAnswerable(item, p) && !item.question) return;
        const q = lesenItemIsAnswerable(item, p) ? lesenItemToAnswerQ(item, p, null, idx) : itemToQ(item, idx);
        enrichMatchingQFromPart(q, p);
        if (!isAnswerKeyRenderable(q, p)) {
          registerInvalidGradingItem(d, meta, q);
          return;
        }
        const user = S.answers['lesen_' + pi + '_' + q.id];
        const label = q.question || (item.signText ? String(item.id || idx + 1) : q.question);
        items.push({ ok: goetheAnswersMatch(user, q.correct) || acceptedAnswerMatch(user, q), q: label, yours: ansLabel(q, user, isDE), correct: correctLabel(q, isDE), explanation: q.explanation || '', grammarTags: q.grammarTags || [] });
      };
      if (isLesenAdsMatchingRender(p) || isLesenForumOpinionsPart(p)) {
        p.items?.forEach((item, idx) => pushLesenItem(item, idx));
      } else {
        const signBlock = p.items?.length && p.items.every(it => it.signText && !it.question && !lesenItemIsAnswerable(it, p));
        if (!signBlock) p.items?.forEach((item, idx) => pushLesenItem(item, idx));
      }
      (p.questions || []).forEach((q) => {
        if (!isAnswerKeyRenderable(q, p)) {
          registerInvalidGradingItem(d, meta, q);
          return;
        }
        enrichMatchingQFromPart(q, p);
        const user = S.answers['lesen_' + pi + '_' + q.id];
        items.push({ ok: goetheAnswersMatch(user, q.correct) || acceptedAnswerMatch(user, q), q: q.gap?`Lücke ${q.gap}`:q.question, yours: ansLabel(q, user, isDE), correct: correctLabel(q, isDE), explanation: q.explanation || '', grammarTags: q.grammarTags || [] });
      });
      pushQ('lesen', `${isDE ? 'Lesen' : 'Reading'} — ${isDE ? 'Teil' : 'Part'} ${p.teil}`, items);
    });
    d.horenParts?.forEach((p, pi) => {
      const meta = { module: 'horen', teil: p.teil, part: p };
      // Eje-2 Fase B: segments es autoridad cuando existe; questions[] es fallback.
      // Elimina la doble sección de corrección (V-21) para partes con segments.
      if (p.segments?.length) {
        p.segments.forEach((s, si) => {
          const label = p.segments.length > 1
            ? `${isDE ? 'Hörverstehen' : 'Listening'} — ${isDE ? 'Teil' : 'Part'} ${p.teil} (${s.label})`
            : `${isDE ? 'Hörverstehen' : 'Listening'} — ${isDE ? 'Teil' : 'Part'} ${p.teil}`;
          pushQ(
            'horen',
            label,
            segToQ(s).flatMap((q) => {
              if (!isAnswerKeyRenderable(q, p)) {
                registerInvalidGradingItem(d, meta, q);
                return [];
              }
              const mod = 'horen_' + pi + '_' + si;
              const user = S.answers[mod + '_' + q.id];
              return [{ ok: goetheAnswersMatch(user, q.correct) || acceptedAnswerMatch(user, q), q: q.question, yours: ansLabel(q, user, isDE), correct: correctLabel(q, isDE), explanation: q.explanation || '', grammarTags: q.grammarTags || [] }];
            })
          );
        });
      } else {
        // Sin segments: questions[] es la fuente (H4 plano)
        pushQ(
          'horen',
          `${isDE ? 'Hörverstehen' : 'Listening'} — ${isDE ? 'Teil' : 'Part'} ${p.teil}`,
          (p.questions || []).flatMap((q) => {
            if (!isAnswerKeyRenderable(q, p)) {
              registerInvalidGradingItem(d, meta, q);
              return [];
            }
            const user = S.answers['horen_' + pi + '_' + q.id];
            return [{ ok: goetheAnswersMatch(user, q.correct) || acceptedAnswerMatch(user, q), q: q.question, yours: ansLabel(q, user, isDE), correct: correctLabel(q, isDE), explanation: q.explanation || '', grammarTags: q.grammarTags || [] }];
          })
        );
      }
      if (p.noteFields) {
        pushQ(
          'horen',
          `${isDE ? 'Hörverstehen' : 'Listening'} — ${isDE ? 'Teil' : 'Part'} ${p.teil} (Notes)`,
          p.noteFields.map((f) => {
            const user = (document.getElementById('note_' + f.id)?.value || '').trim();
            const ok = user.toLowerCase() === String(f.answer).trim().toLowerCase();
            return { ok, q: f.label, yours: user || '—', correct: f.answer };
          })
        );
      }
    });
    const writingParts = (d.schreibenParts || []).map((p) => ({
      ...writingLengthHint(p, getSchreibenAns(p), isDE),
      part: p,
    }));
    const speakingParts = (d.sprechenParts || []).map((p) => ({
      ...(typeof buildOrientativeSpeakingHint === 'function'
        ? buildOrientativeSpeakingHint(p, document.getElementById(p.fieldId)?.value.trim() || '', isDE)
        : writingLengthHint({ minWords: p.minWords || 40 }, document.getElementById(p.fieldId)?.value.trim() || '', isDE)),
      part: p,
    }));
    return { parts, writingParts, speakingParts };
  }
  if (d.lesen) {
    pushQ(
      'lesen',
      isDE ? 'Leseverstehen' : 'Reading',
      d.lesen.questions.map((q, i) => {
        const user = S.answers['lesen_' + q.id];
        const ok = user === q.correct;
        return {
          ok,
          q: `Q${i + 1}: ${q.question}`,
          yours: ansLabel(q, user, isDE),
          correct: correctLabel(q, isDE),
        };
      })
    );
  }
  if (d.horen) {
    pushQ(
      'horen',
      isDE ? 'Hörverstehen' : 'Listening',
      d.horen.questions.map((q, i) => {
        const user = S.answers['horen_' + q.id];
        const ok = user === q.correct;
        return {
          ok,
          q: `Q${i + 1}: ${q.question}`,
          yours: ansLabel(q, user, isDE),
          correct: correctLabel(q, isDE),
        };
      })
    );
  }
  if (d.gapfill) {
    pushQ(
      'gapfill',
      isDE ? 'Lückentext' : 'Gap-Fill',
      d.gapfill.sentences.map((s, i) => {
        const user = (S.gapAnswers[s.id] || '').trim();
        const ok = user.toLowerCase() === s.answer.toLowerCase();
        return {
          ok,
          q: `Gap ${i + 1}: ${s.text.replace('[BLANK]', '___')}`,
          yours: user || '—',
          correct: s.answer,
        };
      })
    );
  }
  const writing = d.schreiben ? writingLengthHint(d.schreiben, writeAns, isDE) : null;
  const speaking = d.sprechen
    ? (typeof buildOrientativeSpeakingHint === 'function'
      ? buildOrientativeSpeakingHint(d.sprechen, speakAns, isDE)
      : writingLengthHint({ minWords: d.sprechen.minWords || 40 }, speakAns, isDE))
    : null;
  return { parts, writing, speaking };
}
function renderInvalidExamDataScreen(isDE, invalidItems) {
  show('resultsScreen');
  const scr = document.getElementById('resultsScreen');
  const title = isDE ? 'Prüfung nicht verfügbar (ungültige Daten)' : 'Exam unavailable (invalid data)';
  const body = isDE
    ? 'Diese Prüfung enthält Antwortschlüssel, die nicht mit den angezeigten Optionen übereinstimmen. Bitte kontaktieren Sie den Support.'
    : 'This exam contains answer keys that do not match the options shown. Please contact support.';
  const detail = (invalidItems || [])
    .map((it) => `${it.module} Teil ${it.teil} · id=${it.id} · correct=${it.correct}`)
    .join('<br>');
  scr.innerHTML = `${renderNavBackBtn('Exams')}<div class="card results-hero fail"><div class="res-label">${esc(title)}</div><p style="margin-top:12px;font-size:14px;line-height:1.6;color:var(--text-secondary)">${esc(body)}</p>${detail ? `<div style="margin-top:14px;font-size:12px;color:var(--text-muted);line-height:1.55">${detail}</div>` : ''}<button class="btn-sm accent" style="margin-top:16px" onclick="goHome()">Home</button></div>`;
}
function renderWritingAiBlock(wa, isDE) {
  const c = wa.correction;
  if (!c) return '';
  const basic = c.feedbackLevel === 'basic' || (!c.correctedText && c.errorCounts);
  const title = basic ? 'Orientative AI feedback' : 'Your corrected text';
  let h = `<div class="writing-ai-block"><h4 style="font-size:13px;font-weight:700;margin:0 0 10px">${title}</h4>`;
  if (c.totalScore != null) {
    h += `<p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px">Orientative score: <b>${c.totalScore}%</b></p>`;
  }
  if (!basic && c.rubric && typeof c.rubric === 'object') {
    const rubricLabels = isDE
      ? { erfuellung: 'Erfüllung', kohaerenz: 'Kohärenz', wortschatz: 'Wortschatz', strukturen: 'Strukturen' }
      : { erfuellung: 'Task fulfilment', kohaerenz: 'Coherence', wortschatz: 'Vocabulary', strukturen: 'Structures' };
    h += `<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Goethe rubric</div><ul style="font-size:12px;color:var(--text-secondary);line-height:1.65;padding-left:18px;margin:0 0 10px">`;
    for (const [k, label] of Object.entries(rubricLabels)) {
      if (c.rubric[k] != null) h += `<li>${esc(label)}: ${c.rubric[k]}/25</li>`;
    }
    h += '</ul>';
  }
  if (c.summary) h += `<p style="font-size:12px;color:var(--text-secondary);margin-bottom:10px">${esc(c.summary)}</p>`;
  if (basic && c.errorCounts && typeof c.errorCounts === 'object') {
    h += `<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Errors by type</div><ul style="font-size:12px;color:var(--text-secondary);line-height:1.65;padding-left:18px;margin:0 0 10px">`;
    Object.entries(c.errorCounts).forEach(([k, v]) => {
      if (Number(v) > 0) h += `<li>${esc(k)}: ${v}</li>`;
    });
    h += `</ul>`;
    if (typeof isPaidPlan === 'function' && !isPaidPlan()) {
      h += `<p style="font-size:11px;color:var(--text-muted);font-style:italic">Upgrade to Pro for line-by-line corrections and grammar points.</p>`;
    }
  }
  if (!basic && c.correctedText) {
    const diffFn = typeof highlightCorrectedDiff === 'function' ? highlightCorrectedDiff : null;
    h += `<div class="corr-diff readable-text" style="font-size:13px;line-height:1.7;margin-bottom:12px">${diffFn && wa.userText ? diffFn(wa.userText, c.correctedText) : esc(c.correctedText)}</div>`;
  }
  if (!basic && c.errors?.length) {
    h += `<ul style="font-size:12px;color:var(--text-secondary);line-height:1.65;padding-left:18px;margin:0 0 10px">`;
    c.errors.slice(0, 8).forEach((e) => {
      h += `<li><b>${esc(e.original || '')}</b> → ${esc(e.correction || '')}${e.explanation ? ` <span style="color:var(--text-muted)">(${esc(e.explanation)})</span>` : ''}</li>`;
    });
    h += `</ul>`;
  }
  if (!basic && c.grammarPoints?.length) {
    h += `<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${isDE ? 'Grammatik' : 'Grammar'}</div>`;
    c.grammarPoints.slice(0, 3).forEach((g) => {
      h += `<p style="font-size:12px;color:var(--text-secondary);margin:0 0 6px"><b>${esc(g.tag || '')}</b>: ${esc(g.explanation || '')}${g.example ? ` <em>${esc(g.example)}</em>` : ''}</p>`;
    });
  }
  h += '</div>';
  return h;
}
async function loadWritingAiCorrections(correction, d, isDE, entryId) {
  const host = document.getElementById('writingAiHost');
  if (correction.writingAi?.length) {
    if (host) host.innerHTML = correction.writingAi.map((wa) => renderWritingAiBlock(wa, isDE)).join('');
    return;
  }
  if (d._writingEvals?.length && d.schreibenParts?.length) {
    correction.writingAi = d.schreibenParts.map((p, i) => {
      const id = String(p.aufgabe ?? p.teil ?? i + 1);
      const ev =
        d._writingEvals.find((e) => String(e.id) === id) ||
        d._writingEvals[i] ||
        null;
      return {
        aufgabe: p.aufgabe ?? p.teil,
        task: p.task || p.instruction || '',
        userText: typeof getSchreibenAns === 'function' ? getSchreibenAns(p) : '',
        correction: ev,
      };
    }).filter((wa) => wa.correction);
    if (host && correction.writingAi.length) {
      host.innerHTML = correction.writingAi.map((wa) => renderWritingAiBlock(wa, isDE)).join('');
    }
    return;
  }
  if (typeof canUseWritingCorrection !== 'function' || !canUseWritingCorrection() || typeof correctWritingWithAI !== 'function') return;
  const lang = d.lang || S.subject || 'de';
  const level = d.level || S.level || 'B1';
  const jobs = [];
  if (d.schreibenParts?.length) {
    d.schreibenParts.forEach((p) => {
      const userText = getSchreibenAns(p);
      if (!userText.trim()) return;
      jobs.push({ aufgabe: p.aufgabe, task: p.task || p.instruction || '', userText, minWords: p.minWords });
    });
  } else if (d.schreiben) {
    const userText = document.getElementById('writeAns')?.value.trim() || '';
    if (userText.trim()) jobs.push({ aufgabe: 1, task: d.schreiben.task || '', userText, minWords: d.schreiben.minWords });
  }
  if (!jobs.length) return;
  if (host) host.innerHTML = `<div class="writing-ai-loading" style="font-size:12px;color:var(--text-muted);padding:10px 0">${isDE ? 'Corrigiendo con IA…' : 'AI correction in progress…'}</div>`;
  correction.writingAi = [];
  for (const job of jobs) {
    const result = await correctWritingWithAI(lang, level, job.task, job.userText, { minWords: job.minWords });
    if (result) correction.writingAi.push({ ...job, correction: result });
  }
  if (host) {
    host.innerHTML = correction.writingAi.length
      ? correction.writingAi.map((wa) => renderWritingAiBlock(wa, isDE)).join('')
      : '';
  }
  if (entryId) {
    const h = S.history.find((e) => e.id === entryId);
    if (h?.correction) {
      h.correction.writingAi = correction.writingAi;
      saveHist();
    }
  }
  if (S.lastResults?.correction) S.lastResults.correction.writingAi = correction.writingAi;
}
function renderCorrectionHtml(corr, d, isDE, passPercent = 60) {
  const passOk = (v) => v >= passPercent;
  const hasGoethe = corr.writingParts?.length || corr.speakingParts?.length;
  if (!corr.parts.length && !corr.writing && !corr.speaking && !hasGoethe) return '';
  let html = `<div class="corr-wrap"><h2 style="font-size:16px;font-weight:700;margin-bottom:4px">${isDE ? 'Detaillierte Korrektur' : 'Detailed correction'}</h2>`;
  corr.parts.forEach((sec) => {
    html += `<div class="corr-mod"><h3>${sec.title}</h3>`;
    sec.items.forEach((it) => {
      html += `<div class="corr-row ${it.ok ? 'ok' : 'bad'}"><div class="corr-q">${it.ok ? '✓' : '✗'} ${it.q}</div><div class="corr-ans">${isDE ? 'Deine Antwort' : 'Your answer'}: <b>${esc(it.yours)}</b></div>${it.ok ? '' : `<div class="corr-fix">${isDE ? 'Richtig' : 'Correct'}: ${esc(it.correct)}</div>`}</div>`;
    });
    html += '</div>';
  });
  const renderWritePart = (wp, title) => {
    const scoreLine = wp.score != null && !wp.orientative ? ` · ${wp.score}%` : '';
    const rowCls = wp.score != null && !wp.orientative ? (passOk(wp.score) ? 'ok' : 'bad') : 'mid';
    html += `<div class="corr-mod"><h3>${title}${scoreLine}</h3><div class="corr-row ${rowCls}"><div class="corr-ans">${esc(wp.note || wp.hint || '')}</div></div>`;
    if (wp.part.feedback?.length) {
      html += `<ul class="u-list-secondary">${wp.part.feedback.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`;
    }
    if (wp.part.modelAnswer) {
      html += `<div class="u-text-caption" style="margin-bottom:6px">${isDE ? 'Musterantwort' : 'Model answer'}</div><div class="corr-model">${esc(wp.part.modelAnswer)}</div>`;
    }
    html += '</div>';
  };
  const writingProHint = `<p class="writing-pro-hint" style="font-size:11px;color:var(--text-muted);margin-top:10px;font-style:italic">AI writing correction (1 credit) — sign in free</p>`;
  const writingAiHost = `<div id="writingAiHost" class="writing-ai-host"></div>`;
  const showWritingAi = typeof canUseWritingCorrection === 'function' && canUseWritingCorrection();
  if (corr.writingParts?.length) {
    corr.writingParts.forEach((wp) => renderWritePart(wp, `${isDE ? 'Schreiben' : 'Writing'} — Aufgabe ${wp.part.aufgabe}`));
    html += showWritingAi ? writingAiHost : writingProHint;
  } else if (corr.writing && d.schreiben) {
    html += `<div class="corr-mod"><h3>${isDE ? 'Schreiben' : 'Writing'} · ${corr.writing.score}%</h3><div class="corr-row ${passOk(corr.writing.score) ? 'ok' : 'bad'}"><div class="corr-ans">${esc(corr.writing.note)}</div></div>`;
    if (d.schreiben.feedback?.length) {
      html += `<div style="font-size:11px;color:var(--text-muted);margin:8px 0 6px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">${isDE ? 'Checkliste' : 'Checklist'}</div><ul style="font-size:12px;color:var(--text-secondary);line-height:1.7;padding-left:18px;margin-bottom:10px">${d.schreiben.feedback.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`;
    }
    if (d.schreiben.modelAnswer) {
      html += `<div class="u-text-caption" style="margin-bottom:6px">${isDE ? 'Musterantwort' : 'Model answer'}</div><div class="corr-model">${esc(d.schreiben.modelAnswer)}</div>`;
    }
    html += showWritingAi ? writingAiHost : writingProHint;
    html += '</div>';
  }
  if (corr.speakingParts?.length) {
    corr.speakingParts.forEach((sp) => {
      // Speaking that the AI did not evaluate carries no score: buildOrientativeSpeakingHint()
      // returns note/words/min only. Printing `· ${sp.score}%` gave "undefined%", and
      // passOk(undefined) is false, so an unscored part was painted as a failure. Same guard the
      // writing branch above already uses.
      const spScored = sp.score != null && !sp.orientative;
      html += `<div class="corr-mod"><h3>${isDE ? 'Sprechen' : 'Speaking'} — ${isDE ? 'Teil' : 'Part'} ${sp.part.teil}${spScored ? ` · ${sp.score}%` : ''}</h3><div class="corr-row ${spScored ? (passOk(sp.score) ? 'ok' : 'bad') : 'mid'}"><div class="corr-ans">${esc(sp.note)}</div></div>`;
      if (sp.part.feedback?.length) {
        html += `<ul style="font-size:12px;color:var(--text-secondary);line-height:1.7;padding-left:18px;margin:10px 0">${sp.part.feedback.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`;
      }
      if (sp.part.modelAnswer) {
        html += `<div class="u-text-caption" style="margin-bottom:6px">${isDE ? 'Musterdialog' : 'Model dialogue'}</div><div class="corr-model">${esc(sp.part.modelAnswer)}</div>`;
      }
      html += '</div>';
    });
  } else if (corr.speaking && d.sprechen) {
    html += `<div class="corr-mod"><h3>${isDE ? 'Sprechen' : 'Speaking'} · ${corr.speaking.score}%</h3><div class="corr-row ${passOk(corr.speaking.score) ? 'ok' : 'bad'}"><div class="corr-ans">${esc(corr.speaking.note)}</div></div>`;
    if (d.sprechen.feedback?.length) {
      html += `<ul style="font-size:12px;color:var(--text-secondary);line-height:1.7;padding-left:18px;margin:10px 0">${d.sprechen.feedback.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`;
    }
    if (d.sprechen.modelAnswer) {
      html += `<div class="u-text-caption" style="margin-bottom:6px">${isDE ? 'Musterdialog' : 'Model dialogue'}</div><div class="corr-model">${esc(d.sprechen.modelAnswer)}</div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}
async function submitExam(){
  stopTimer();
  const d=S.examData;if(!d)return;
  const isDE=d.lang==='de';
  const isDemo=!!d.demo||!!S.isDemo;
  let serverTimerResult=null;
  if(isOfficialMode()&&!isDemo&&typeof finishOfficialExamTimer==='function'&&S.officialTimerSession?.timerSessionId){
    const examSavedId=d._savedId||d._flightId;
    if(examSavedId){
      try{
        serverTimerResult=await finishOfficialExamTimer({
          examSavedId,
          timerSessionId:S.officialTimerSession.timerSessionId,
        });
      }catch(_){}
    }
  }
  const writeAns=document.getElementById('writeAns')?.value.trim()||'';
  const speakAns=document.getElementById('speakAns')?.value.trim()||'';
  const MG=typeof ModuleGrading!=='undefined'?ModuleGrading:null;
  let blueprint=d.blueprint||null;
  if(!blueprint&&typeof ExamBlueprint!=='undefined'){
    try{blueprint=await ExamBlueprint.load(d.lang||S.subject,d.level);}catch(_){}
  }
  const passPercent=MG?MG.getPassPercent(blueprint,d):60;
  const gradingScope=MG?MG.getGradingScope(blueprint,d):'legacy';
  const modular=gradingScope==='modular';
  const wholeExam=gradingScope==='whole-exam';
  const usePoints=wholeExam&&!!blueprint;
  const mkScorable=(c,t,modId)=>usePoints&&MG?MG.scorableModuleResultWithPoints(c,t,passPercent,blueprint,modId):MG?MG.scorableModuleResult(c,t,passPercent):null;
  let moduleResults={};
  let legacyCorrect=0,legacyTotal=0;
  let speakingEvals=null;
  if(d.goetheFormat){
    d._invalidItems=[];
    let lc=0,la=0,lp=0,hc=0,ha=0,hp=0;
    forEachGoetheQ(d,(mod,q,meta)=>{
      if(!isAnswerKeyRenderable(q,meta?.part)){
        registerInvalidGradingItem(d,meta,q);
        return;
      }
      const user=S.answers[mod+'_'+q.id];
      const answered=MG&&MG.isAnswerProvided?MG.isAnswerProvided(user):(user!=null&&String(user).trim()!=='');
      if(mod.startsWith('lesen_')){lp++;}
      else if(mod.startsWith('horen_')){hp++;}
      if(!answered)return;
      const ok=goetheAnswersMatch(user,q.correct)||acceptedAnswerMatch(user,q);
      if(mod.startsWith('lesen_')){la++;if(ok)lc++;}
      else if(mod.startsWith('horen_')){ha++;if(ok)hc++;}
    });
    if(isStrictGradingEnabled()&&d._invalidItems.length){
      console.error('[grading] invalid answer keys — strict mode',d._invalidItems);
      hideAll();
      renderInvalidExamDataScreen(isDE,d._invalidItems);
      return;
    }
    if(d._invalidItems.length)console.error('[grading] excluded ungradable items',d._invalidItems);
    d.horenParts?.forEach(p=>{
      p.noteFields?.forEach(f=>{
        hp++;
        const ans=(document.getElementById('note_'+f.id)?.value||'').trim().toLowerCase();
        if(!ans)return;
        ha++;
        if(ans===String(f.answer).trim().toLowerCase())hc++;
      });
    });
    if(la&&MG)moduleResults.lesen=MG.buildObjectiveModuleResult(lc,la,lp,passPercent);
    if(ha&&MG)moduleResults.horen=MG.buildObjectiveModuleResult(hc,ha,hp,passPercent);
    if(la){legacyCorrect+=lc;legacyTotal+=la;}
    if(ha){legacyCorrect+=hc;legacyTotal+=ha;}
    if(d.schreibenParts?.length||d.sprechenParts?.length){
      let writingEvals=null;
      const hasProdEval=(modular||wholeExam)&&!isDemo&&typeof evalProductionModulesWithAI==='function';
      if(hasProdEval){
        hideAll();show('loadingScreen');
        if(typeof setLoaderStep==='function')setLoaderStep(isDE?'Schreiben und Sprechen werden bewertet…':'Evaluating writing and speaking…',isDE?'KI-Prüfer bewertet Ihre Antworten':'AI examiner is reviewing your responses');
        const PEC=typeof ProductionEvalCore!=='undefined'?ProductionEvalCore:null;
        const prodEval=await evalProductionModulesWithAI({
          lang:d.lang||S.subject,
          level:d.level,
          passPercent,
          schreibenParts:d.schreibenParts||[],
          sprechenParts:d.sprechenParts||[],
          isDE,
        });
        writingEvals=prodEval.schreibenEvals||[];
        speakingEvals=prodEval.sprechenEvals||[];
        if(prodEval.ok&&MG){
          moduleResults=PEC?PEC.applyProductionEvalToModules(moduleResults,prodEval,passPercent,MG):moduleResults;
          if(usePoints&&MG){
            if(moduleResults.schreiben)moduleResults.schreiben=MG.enrichModulePoints(moduleResults.schreiben,blueprint,'schreiben');
            if(moduleResults.sprechen)moduleResults.sprechen=MG.enrichModulePoints(moduleResults.sprechen,blueprint,'sprechen');
          }
        }else{
          const schHints=(d.schreibenParts||[]).map(p=>writingLengthHint(p,getSchreibenAns(p),isDE));
          const spHints=(d.sprechenParts||[]).map(p=>(typeof buildOrientativeSpeakingHint==='function'?buildOrientativeSpeakingHint(p,document.getElementById(p.fieldId)?.value.trim()||'',isDE):writingLengthHint({minWords:p.minWords||40},document.getElementById(p.fieldId)?.value.trim()||'',isDE)));
          moduleResults=PEC?PEC.applyOrientativeFallback(moduleResults,{schreibenHints:schHints,sprechenHints:spHints,isDE},MG):moduleResults;
          if(!moduleResults.schreiben&&d.schreibenParts?.length&&MG)moduleResults.schreiben=MG.unevaluatedOrientativeResult(schHints.map(h=>h.hint).join(' · '),isDE);
          if(!moduleResults.sprechen&&d.sprechenParts?.length&&MG)moduleResults.sprechen=MG.unevaluatedOrientativeResult(spHints.map(h=>h.hint).join(' · '),isDE);
        }
        d._writingEvals=writingEvals;
        d._productionEvalFromCache=!!prodEval.fromCache;
      }else if(d.schreibenParts?.length){
        if(modular&&MG)moduleResults.schreiben=MG.unevaluatedOrientativeResult(writingLengthHint(d.schreibenParts[0],getSchreibenAns(d.schreibenParts[0]),isDE).hint,isDE);
        else{
          const ws=d.schreibenParts.map(p=>writingLengthHint(p,getSchreibenAns(p),isDE));
          moduleResults.schreiben=MG?MG.unevaluatedOrientativeResult(ws.map(w=>w.hint).join(' · '),isDE):undefined;
        }
      }
      if(!hasProdEval&&d.sprechenParts?.length){
        if(modular&&MG&&!isDemo){
          hideAll();show('loadingScreen');
          if(typeof setLoaderStep==='function')setLoaderStep('Evaluating speaking…','AI examiner is reviewing your responses');
          speakingEvals=await evalSpeakingWithAI(d.sprechenParts,isDE);
          const aiScores=(speakingEvals||[]).filter(s=>s.ai&&s.score!=null).map(s=>s.score);
          if(aiScores.length&&MG){
            const avg=Math.round(aiScores.reduce((a,b)=>a+b,0)/aiScores.length);
            moduleResults.sprechen=usePoints&&MG.aiEvaluatedModuleResultWithPoints?MG.aiEvaluatedModuleResultWithPoints(avg,passPercent,blueprint,'sprechen',{parts:speakingEvals}):MG.aiEvaluatedModuleResult(avg,passPercent,{parts:speakingEvals});
          }else if(MG){
            moduleResults.sprechen=MG.unevaluatedOrientativeResult((speakingEvals||[]).map(s=>s.note||s.hint).filter(Boolean).join(' · '),isDE);
          }
        }else if(isDemo&&MG){
          moduleResults.sprechen=MG.unevaluatedOrientativeResult(null,isDE);
        }
      }
    }
  }else{
  if(d.lesen){let c=0,a=0;d.lesen.questions.forEach(q=>{const ans=S.answers['lesen_'+q.id];if(MG&&MG.isAnswerProvided&&!MG.isAnswerProvided(ans))return;a++;if(ans===q.correct)c++;});legacyCorrect+=c;legacyTotal+=a;if(a&&MG)moduleResults.lesen=MG.buildObjectiveModuleResult(c,a,d.lesen.questions.length,passPercent);}
  if(d.horen){let c=0,a=0;d.horen.questions.forEach(q=>{const ans=S.answers['horen_'+q.id];if(MG&&MG.isAnswerProvided&&!MG.isAnswerProvided(ans))return;a++;if(ans===q.correct)c++;});legacyCorrect+=c;legacyTotal+=a;if(a&&MG)moduleResults.horen=MG.buildObjectiveModuleResult(c,a,d.horen.questions.length,passPercent);}
  if(d.gapfill){let c=0,a=0;d.gapfill.sentences.forEach(s=>{const ans=(S.gapAnswers[s.id]||'').trim();if(MG&&MG.isAnswerProvided&&!MG.isAnswerProvided(ans))return;a++;if(ans.toLowerCase()===s.answer.toLowerCase())c++;});legacyCorrect+=c;legacyTotal+=a;if(a&&MG)moduleResults.gapfill=MG.buildObjectiveModuleResult(c,a,d.gapfill.sentences.length,passPercent);}
  if(d.schreiben){
    const w=writingLengthHint(d.schreiben,writeAns,isDE);
    if(MG)moduleResults.schreiben=MG.unevaluatedOrientativeResult(w.hint,isDE);
  }
  if(d.sprechen){
    if(isDemo){
      const spHint=typeof buildOrientativeSpeakingHint==='function'?buildOrientativeSpeakingHint(d.sprechen,speakAns,isDE):writingLengthHint({minWords:d.sprechen.minWords||40},speakAns,isDE);
      if(MG)moduleResults.sprechen=MG.unevaluatedOrientativeResult(spHint.note,isDE);
    }else{
      hideAll();show('loadingScreen');
      if(typeof setLoaderStep==='function')setLoaderStep('Evaluating speaking…','AI examiner is reviewing your response');
      const parts=[{...d.sprechen,fieldId:'speakAns'}];
      speakingEvals=await evalSpeakingWithAI(parts,isDE);
      const sp0=speakingEvals[0];
      if(sp0?.ai&&sp0.score!=null&&MG)moduleResults.sprechen=MG.aiEvaluatedModuleResult(sp0.score,passPercent);
      else if(MG)moduleResults.sprechen=MG.unevaluatedOrientativeResult(sp0?.note||sp0?.hint,isDE);
    }
  }
  }
  const summary=MG?MG.summarizeExam(moduleResults,{modular,passPercent,legacyCorrect,legacyTotal,blueprint,gradingScope,exam:d}):{legacyScore:legacyTotal?Math.round(legacyCorrect/legacyTotal*100):0,modulesPassed:0,modulesEvaluated:0,totalModules:0,globalPassed:false,informativeScorePct:null,passPercent,gradingScope:'legacy'};
  const score=MG?MG.computeDisplayScore(summary,moduleResults):(wholeExam?(summary.legacyScore??0):modular?(summary.informativeScorePct??summary.legacyScore):summary.legacyScore);
  const displayScore=Number.isFinite(Number(score))?Math.round(Number(score)):0;
  if(typeof LcAnalytics!=='undefined'&&!isDemo&&!S.quickMod){
    LcAnalytics.trackExamCompleted(d.lang||S.subject,d.level||S.level,displayScore);
  }
  const moduleScores=MG?MG.legacyFlatScores(moduleResults):{};
  const correction=buildCorrection(d,isDE,writeAns,speakAns,passPercent);
  let savedWords=[...(S.examSavedWords||[])];
  S.lastMarkedWords=S.activeSession?.markedWords?[...S.activeSession.markedWords]:[];
  const entry={id:Date.now(),date:new Date().toLocaleDateString(),topic:d.topic,level:d.level,lang:d.lang,score:displayScore,moduleScores,moduleResults,passPercentPerModule:passPercent,modulesPassed:summary.modulesPassed,modulesEvaluated:summary.modulesEvaluated,totalModules:summary.totalModules,globalPassed:summary.globalPassed,modularGrading:modular,gradingScope:summary.gradingScope||gradingScope,wholeExamGrading:wholeExam?{writtenPoints:summary.writtenPoints,writtenMax:summary.writtenMax,writtenMin:summary.writtenMin,speakingPoints:summary.speakingPoints,speakingMax:summary.speakingMax,speakingMin:summary.speakingMin}:null,mode:normalizeMode(S.mode),demo:!!d.demo,guidedDemo:!!d.guidedDemo,correction,savedWords,markedWords:S.lastMarkedWords.map(m=>m.word),examSource:S.examSource||null,poolId:S.examData?.poolId||null,invalidItems:d._invalidItems||[],writingEvals:d._writingEvals||null,speakingEvals:speakingEvals||null,productionEvalFromCache:!!d._productionEvalFromCache,serverTimeExceeded:!!serverTimerResult?.serverTimeExceeded,serverTimerValidated:!!serverTimerResult?.validated,serverElapsedSec:serverTimerResult?.serverElapsedSec??null,serverLimitSec:serverTimerResult?.serverLimitSec??null};
  if(typeof AnalyticsStore!=='undefined'){
    const goal=getActiveGoal()||S.goals.find(g=>g.id===d.goalId);
    entry.tagStats=AnalyticsStore.recordExamResult(goal,entry,d,S.answers);
  }
  if(typeof TargetUsage!=='undefined'&&S.flashcards?.length){
    const userWords=S.flashcards
      .filter((fc)=>fc.sourceLang===(d.lang||S.subject))
      .map((fc)=>fc.word)
      .filter(Boolean);
    if(userWords.length){
      const usage=TargetUsage.deriveTargetUsage(d,userWords);
      entry.vocabIntersection=usage;
      entry.vocabInExam=usage.map((u)=>u.word);
      entry.vocabNotInExam=userWords.filter(
        (w)=>!usage.some((u)=>u.word.toLowerCase()===w.toLowerCase()),
      );
    }
  }
  if(typeof ExamProfile!=='undefined')ExamProfile.tagItem(entry);
  S.history.unshift(entry);saveHist();
  const goal=getActiveGoal();
  const modeLbl=normalizeMode(S.mode)==='practice'?'Practice':'Official';
  const qm=S.quickMod;
  flushOpenStudySession({type:qm?'quick':'exam',goalId:goal?.id||S.activeGoalId,label:(qm?'Quick '+qm+' · ':modeLbl+' exam · ')+(d.topic||d.level||''),score:displayScore});
  const savedId=d._savedId||d._flightId;
  if(savedId){
    const si=S.savedExams.findIndex(e=>e.id===savedId);
    if(si>=0){
      S.savedExams[si]={...S.savedExams[si],status:'completed',score,moduleScores,moduleResults,passPercentPerModule:passPercent,globalPassed:summary.globalPassed,correction,savedWords,markedWords:S.lastMarkedWords.map(m=>m.word),writeAns,speakAns,speakingEvals,completedAt:Date.now()};
      saveSaved();
    }
  }
  S._officialInProgress=null;
  clearActiveSession();
  renderResults(displayScore,moduleResults,d,isDE,writeAns,speakAns,entry.id,correction,speakingEvals,savedWords,S.lastMarkedWords,entry,summary);
}

function getResultsWeakModules(moduleResults,passPercent,isDE){
  if(typeof ModuleGrading!=='undefined')return ModuleGrading.weakModules(moduleResults,passPercent,isDE);
  const labels={lesen:isDE?'Leseverstehen':'Reading',horen:isDE?'Hörverstehen':'Listening',gapfill:'Gap-Fill',schreiben:isDE?'Schreiben':'Writing',sprechen:isDE?'Sprechen':'Speaking'};
  return Object.entries(moduleResults||{}).filter(([,v])=>v?.evaluated&&v.scorePct!=null&&v.scorePct<passPercent).map(([k,v])=>({label:labels[k]||k,score:v.scorePct})).sort((a,b)=>a.score-b.score);
}
function getResultsRecommendedAction(score,summary,mods,deckN,practiceMode,passPercent){
  const goal=getActiveGoal()||S.goals[0];
  const weak=getResultsWeakModules(mods,passPercent,false);
  if(practiceMode&&deckN>=4)return{title:'Generate a personalized exam',desc:`You saved ${deckN} words from this session. Build a mock test from your weak vocabulary.`,cta:'Personalized exam →',run:workspaceAction('exams',()=>goal&&openExamConfigurator(goal.id))};
  if(practiceMode&&deckN>0)return{title:'Review saved vocabulary',desc:`${deckN} word${deckN!==1?'s':''} detected from mistakes. Strengthen them before your next exam.`,cta:'Review flashcards →',run:workspaceAction('vocabulary',()=>goal&&openDeckHub(goal.id))};
  if(weak.length)return{title:'Practice your weak modules',desc:`Focus on ${weak.map(w=>w.label).join(', ')} in practice mode and save words you miss.`,cta:'Practice again →',run:()=>startMockExam('practice')};
  if(summary?.gradingScope==='whole-exam'&&!summary.globalPassed)return{title:'Retake in practice mode',desc:'Practice written and speaking — both thresholds must be met.',cta:'Practice exam →',run:()=>startMockExam('practice')};
  if(summary&&!summary.globalPassed&&summary.modulesPassed<summary.totalModules)return{title:'Retake in practice mode',desc:'Focus on the modules you did not pass yet — save difficult words as you go.',cta:'Practice exam →',run:()=>startMockExam('practice')};
  if(score<passPercent)return{title:'Retake in practice mode',desc:'Save difficult words as you go — they become your personalized study plan.',cta:'Practice exam →',run:()=>startMockExam('practice')};
  return{title:'Take another mock exam',desc:'Keep building exam readiness with another official-format test.',cta:'Next exam →',run:()=>startMockExam('official')};
}
function renderVocabGameSection(entry,isDE){
  const intersection=entry?.vocabInExam||[];
  const notInExam=entry?.vocabNotInExam||[];
  if(!intersection.length&&!notInExam.length)return '';
  const lang={
    title:'Your vocabulary in this exam',
    found:'Your words that appeared',
    notFound:'Your words that did NOT appear',
    gamePrompt:'Do you remember seeing them?',
    none:'None of your saved words appeared in this exam',
  };
  if(!intersection.length){
    return `<div class="vocab-game-section">
      <h3>${lang.title}</h3>
      <p class="muted">${lang.none}</p>
    </div>`;
  }
  const foundPills=intersection
    .map((w)=>`<span class="vocab-pill vocab-found">${esc(w)}</span>`)
    .join('');
  const notFoundPills=notInExam.slice(0,10)
    .map((w)=>`<span class="vocab-pill vocab-not-found">${esc(w)}</span>`)
    .join('');
  return `<div class="vocab-game-section">
    <h3>${lang.title}</h3>
    <div class="vocab-game-block">
      <p class="vocab-game-label">${lang.found} (${intersection.length}) — ${lang.gamePrompt}</p>
      <div class="vocab-pills">${foundPills}</div>
    </div>
    ${notInExam.length?`<div class="vocab-game-block">
      <p class="vocab-game-label">${lang.notFound}</p>
      <div class="vocab-pills">${notFoundPills}</div>
    </div>`:''}
  </div>`;
}
function renderResults(score,moduleResults,d,isDE,writeAns,speakAns,entryId,correction,speakingEvals,savedWordsOverride,markedWordsOverride,histEntry,summaryOverride){
  hideAll();
  const MG=typeof ModuleGrading!=='undefined'?ModuleGrading:null;
  const passPercent=histEntry?.passPercentPerModule??(MG?MG.getPassPercent(null,d):60);
  let mods=histEntry?.moduleResults||null;
  if(!mods&&moduleResults&&typeof moduleResults==='object'&&Object.values(moduleResults)[0]?.evaluated!=null)mods=moduleResults;
  if(!mods&&MG)mods=MG.migrateLegacyModuleScores(histEntry?.moduleScores||moduleResults||{},passPercent);
  if(!mods)mods={};
  const modular=histEntry?.modularGrading??(MG?MG.isModularGoetheExam(d,histEntry?.blueprint||null):false);
  const gradingScope=histEntry?.gradingScope??summaryOverride?.gradingScope??(MG?MG.getGradingScope(histEntry?.blueprint||null,d):modular?'modular':'legacy');
  const wholeExam=gradingScope==='whole-exam';
  const blueprint=histEntry?.blueprint||d.blueprint||null;
  const summary=summaryOverride||(MG?MG.summarizeExam(mods,{modular:gradingScope==='modular',passPercent,blueprint,gradingScope,exam:d}):{globalPassed:score>=passPercent,modulesPassed:0,modulesEvaluated:0,totalModules:0,informativeScorePct:score,passPercent,gradingScope:'legacy'});
  const displayInfo=MG?MG.getDisplayScoreInfo(mods,summary,passPercent,isDE):null;
  const displayScore=displayInfo?.score??score;
  S.lastResults={score:displayScore,mods,d,isDE,correction,speakingEvals,summary,passPercent,gradingScope,displayInfo};
  show('resultsScreen');
  const scr=document.getElementById('resultsScreen');
  const cls=MG?MG.globalResultClass(summary):(displayScore>=passPercent?'pass':displayScore>=passPercent-20?'mid':'fail');
  const label=MG?MG.globalResultLabel(summary,isDE):(displayScore>=passPercent?(isDE?'Bestanden ✓':'Pass ✓'):displayScore>=passPercent-20?(isDE?'Knapp':'Close'):isDE?'Nicht bestanden':'Fail');
  const heroScore=displayInfo?.heroScore??(wholeExam?`${summary.writtenPoints??'—'}/${summary.writtenMax} · ${summary.speakingPoints??'—'}/${summary.speakingMax}`:modular&&summary.totalModules?`${summary.modulesPassed}/${summary.totalModules}`:`${displayScore}%`);
  const heroSub=displayInfo?.heroSub??(wholeExam&&MG?MG.wholeExamHeroSub(summary,isDE):modular&&summary.informativeScorePct!=null?(isDE?`Ø bewertete Module: ${summary.informativeScorePct}% · Schwelle ${passPercent}% pro Modul`:`Avg scored modules: ${summary.informativeScorePct}% · ${passPercent}% pass per module`):modular?(isDE?`Schwelle ${passPercent}% pro Modul`:`${passPercent}% pass per module`):'');
  const corrHtml=correction?renderCorrectionHtml(correction,d,isDE,passPercent):'';
  const speakHtml=typeof renderSpeakingResultsHtml==='function'?renderSpeakingResultsHtml(speakingEvals,isDE):'';
  const labels=MG?.MODULE_LABELS?.[isDE?'de':'en']||{lesen:isDE?'Leseverstehen':'Reading',horen:isDE?'Hörverstehen':'Listening',schreiben:isDE?'Schreiben':'Writing',sprechen:isDE?'Sprechen':'Speaking',gapfill:'Gap-Fill'};
  let modCards='';
  const msColor=(v)=>MG?MG.scoreColor(v,passPercent):(v>=passPercent?'var(--green)':v>=passPercent-10?'var(--warning,var(--orange))':v>=passPercent-20?'var(--orange)':'var(--red)');
  for(const key of['lesen','horen','gapfill','schreiben','sprechen']){
    const m=mods[key];
    if(!m)continue;
    const val=MG?MG.moduleDisplayValue(m,summary,passPercent):(m.evaluated&&m.scorePct!=null?`${m.scorePct}%`:'—');
    const status=MG?MG.moduleStatusLabel(m,isDE,summary):(m.passed?(isDE?'Bestanden':'Pass'):isDE?'Nicht bestanden':'Fail');
    const cardCls=MG?MG.moduleCardClass(m,summary):(m.evaluated?(m.passed?'mod-pass':'mod-fail'):'mod-pending');
    const colorVal=wholeExam&&m.points!=null?null:m.scorePct;
    modCards+=`<div class="card mod-score ${cardCls}"><div class="mod-score__val" style="color:${colorVal!=null?msColor(colorVal):'var(--text-primary)'}">${val}</div><div class="mod-score__status">${status}</div>${m.hint?`<div class="mod-score__hint" style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.4">${esc(m.hint)}</div>`:''}<div class="mod-score__lbl">${labels[key]||key}</div></div>`;
  }
  let wholeExamSummaryHtml='';
  if(wholeExam){
    const wLbl=isDE?'Schriftprüfung (Lesen+Hören+Schreiben)':'Written (Reading+Listening+Writing)';
    const sLbl=isDE?'Sprechen':'Speaking';
    const wOk=summary.writtenPassed;
    const sOk=summary.speakingPassed;
    wholeExamSummaryHtml=`<div class="results-detail whole-exam-summary"><h4>${isDE?'Gesamtergebnis':'Overall result'} (${esc(d.level||'')})</h4><ul class="results-weak-list"><li>${wLbl}: ${summary.writtenPoints??'—'}/${summary.writtenMax} ${isDE?'(mind.':'(min'} ${summary.writtenMin}) — ${wOk?(isDE?'✓ erreicht':'✓ met'):(isDE?'✗ nicht erreicht':'✗ not met')}</li><li>${sLbl}: ${summary.speakingPoints??'—'}/${summary.speakingMax} ${isDE?'(mind.':'(min'} ${summary.speakingMin}) — ${sOk?(isDE?'✓ erreicht':'✓ met'):(isDE?'✗ nicht erreicht':'✗ not met')}</li></ul></div>`;
  }
  let answerHtml='';
  if(d.goetheFormat){
    answerHtml=(d.schreibenParts||[]).map(p=>{const v=document.getElementById(p.fieldId)?.value.trim();return v?`<div class="text-display"><h3>${isDE?'Schreiben':'Writing'} — Aufgabe ${p.aufgabe}</h3><div class="readable-text" style="white-space:pre-wrap">${esc(v)}</div></div>`:'';}).join('');
    answerHtml+=(d.sprechenParts||[]).map(p=>{const v=document.getElementById(p.fieldId)?.value.trim();return v?`<div class="text-display"><h3>${isDE?'Sprechen':'Speaking'} — ${isDE?'Teil':'Part'} ${p.teil}</h3><div class="readable-text" style="white-space:pre-wrap">${esc(v)}</div></div>`:'';}).join('');
  }else{
    if(writeAns)answerHtml+=`<div class="text-display"><h3>${isDE?'Deine Antwort — Schreiben':'Your Writing Response'}</h3><div class="readable-text" style="white-space:pre-wrap">${esc(writeAns)}</div></div>`;
    if(speakAns)answerHtml+=`<div class="text-display"><h3>${isDE?'Deine Antwort — Sprechen':'Your Speaking Notes'}</h3><div class="readable-text" style="white-space:pre-wrap">${esc(speakAns)}</div></div>`;
  }
  const deckN=getProfileFlashcards().length;
  const savedWords=savedWordsOverride||S.examSavedWords||[];
  const weakMods=wholeExam?[]:getResultsWeakModules(mods,passPercent,isDE);
  const weakHtml=wholeExam?wholeExamSummaryHtml:weakMods.length?`<div class="results-detail"><h4>${isDE?'Schwache Bereiche':'Weak areas'}</h4><ul class="results-weak-list">${weakMods.map(w=>`<li>${esc(w.label)} — ${w.score}%</li>`).join('')}</ul></div>`:`<div class="results-detail"><h4>${isDE?'Schwache Bereiche':'Weak areas'}</h4><p class="u-text-xs u-text-secondary">${isDE?'Gute Leistung in den bewerteten Modulen.':'Strong performance across scored modules.'}</p></div>`;
  const markedList=markedWordsOverride||S.lastMarkedWords||[];
  const markedPosCls=typeof markedWordPosClass==='function'?markedWordPosClass:(w=>'');
  const markedHtml=markedList.length?`<div class="results-detail results-marked"><h4>${isDE?'Markierte Wörter nachsehen':'Review the words you marked'}</h4><p style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:10px">${isDE?'Im Official-Modus wurden markierte Wörter hier übersetzt — speichere sie optional in deinem Deck. Farben zeigen Wortart (Nomen, Verb …).':'In official mode, marked words are translated here — save any you want to your deck. Colors show word type (noun, verb …).'}</p>${markedList.map((m,i)=>{const w=typeof m==='string'?m:m.word;const posCls=markedPosCls(w);return`<div class="marked-word-row" id="markedRow_${i}"><span class="marked-word${posCls}">${esc(w)}</span><div class="marked-trans" id="markedTrans_${i}"><button type="button" class="btn-sm" onclick="expandMarkedWord('${encodeURIComponent(w)}',${i})">${isDE?'Übersetzung zeigen':'Show translation'}</button></div></div>`;}).join('')}</div>`:'';
  const vocabHtml=savedWords.length?`<div class="results-detail"><h4>Vocabulary detected</h4><ul class="results-vocab-list">${savedWords.slice(0,12).map(w=>`<li>${esc(w)}</li>`).join('')}${savedWords.length>12?`<li>+${savedWords.length-12} more</li>`:''}</ul></div>`:(isPracticeMode()?`<div class="results-detail"><h4>Vocabulary detected</h4><p class="u-text-xs u-text-secondary">Words you saved during practice appear in your deck.</p></div>`:'');
  const vocabGameHtml=renderVocabGameSection(histEntry,isDE);
  const goalForBatch=getActiveGoal();
  const batchPlan=
    typeof VocabBatching!=='undefined'&&goalForBatch
      ?VocabBatching.getActivityPlan(goalForBatch,'personal',S.lastPersonalConfig?.skills||['lesen'])||goalForBatch?.vocabPlan
      :null;
  const batchCov=batchPlan?VocabBatching.coverage(batchPlan):null;
  const nextBatchHtml=batchPlan&&batchCov&&!batchCov.finished?`<div class="results-detail"><h4>Vocabulary batches</h4><p class="u-text-xs u-text-secondary">${esc(VocabBatching.summary(batchPlan,S.subject||goalForBatch?.subject))}</p><button type="button" class="btn-sm accent" onclick="generateNextVocabBatch('${goalForBatch.id}')">Next batch →</button></div>`:'';
  const act=getResultsRecommendedAction(displayScore,summary,mods,deckN,isPracticeMode(),passPercent);
  _coachAction=act.run;
  const isDemoSession=!!d.guidedDemo;
  const guest=(typeof Auth!=='undefined'&&Auth.isGuest&&Auth.isGuest())||isDemoSession;
  const guestHtml=guest?`<div class="results-guest"><p><b>${isDemoSession?'Demo complete — save your preparation profile.':'Save your progress.'}</b> ${isDemoSession?'Create an account to keep vocabulary, personalized practice, exam history, and readiness tracking for '+esc(getPreparingFor())+'.':'Guest mode keeps results on this device only. Create a free account to sync exams, vocabulary, and scores across devices.'}</p><ul class="u-list-compact">${isDemoSession?'<li>Save detected vocabulary</li><li>Keep personalized practice</li><li>Track exam readiness</li><li>Review past mistakes</li>':''}</ul><button class="btn-sm accent" onclick="userMenuSignIn()">Create account to continue</button>${isDemoSession?` <button class="btn-sm" onclick="goFlashcards()">See demo flashcards</button>`:''}</div>`:'';
  const loopMsg=isPracticeMode()
    ?`Practice exam complete. Words you saved become evidence for your personalized study plan.`
    :markedList.length?`Official exam complete. Review the ${markedList.length} word${markedList.length===1?'':'s'} you marked below — save them to your deck for personalized practice.`
    :`Official exam complete. Next time, tap words you struggle with during the exam to review them here.`;
  const invalidItems=histEntry?.invalidItems||d._invalidItems||[];
  const invalidBanner=invalidItems.length?`<div class="card" style="margin-bottom:14px;border:.5px solid rgba(255,120,80,.35);background:rgba(255,120,80,.08);padding:12px 16px"><b>${isDE?`${invalidItems.length} Frage(n) wegen Datenfehler ausgeschlossen`:`${invalidItems.length} question(s) excluded due to data error`}</b><p style="font-size:12px;color:var(--text-secondary);margin:8px 0 0;line-height:1.55">${isDE?'Diese Aufgaben wurden nicht gewertet, weil der Antwortschlüssel nicht zu den angezeigten Optionen passt.':'These items were not scored because the answer key does not match the options shown.'}</p></div>`:'';
  const serverTimeBanner=histEntry?.serverTimeExceeded?`<div class="card" style="margin-bottom:14px;border:.5px solid rgba(255,180,60,.4);background:rgba(255,180,60,.1);padding:12px 16px"><b>⏱ ${isDE?'Offizielle Zeit überschritten':'Official time limit exceeded'}</b><p style="font-size:12px;color:var(--text-secondary);margin:8px 0 0;line-height:1.55">${isDE?'Die Server-Uhr hat die Prüfungszeit (inkl. Toleranz) überschritten. Ergebnis wird angezeigt, ist aber als außerhalb der Zeit markiert.':'Server clock exceeded the exam time limit (including grace). Your result is shown but marked as over time.'}${histEntry.serverElapsedSec!=null&&histEntry.serverLimitSec!=null?` <span style="color:var(--text-muted)">(${histEntry.serverElapsedSec}s / ${histEntry.serverLimitSec}s + grace)</span>`:''}</p></div>`:'';
  scr.innerHTML=`
    ${renderNavBackBtn('Exams')}
    ${invalidBanner}
    ${serverTimeBanner}
    <div class="card results-hero">
      <div class="res-score ${cls}">${heroScore}</div>
      <div class="res-label">${label} — ${d.level} ${d.lang==='de'?'🇩🇪':'🇬🇧'} ${esc(d.topic)}</div>
      ${heroSub?`<div class="res-sub" style="font-size:12px;color:var(--text-secondary);margin-top:6px">${heroSub}</div>`:''}
    </div>
    <div class="results-loop">
      <h4>Every mistake becomes your next lesson</h4>
      <p>${loopMsg}</p>
    </div>
    <div class="module-scores-grid">${modCards}</div>
    ${weakHtml}
    ${vocabGameHtml}
    ${nextBatchHtml}
    ${markedHtml}
    ${vocabHtml}
    <div class="results-action">
      <h4>Recommended next step</h4>
      <p>${esc(act.desc)}</p>
      <button class="btn-sm accent" onclick="runRecommendedAction()">${esc(act.cta)}</button>
      ${deckN>=4?`<button class="btn-sm" style="margin-left:8px" onclick="goFlashcards()">Personalized practice available</button>`:''}
    </div>
    ${guestHtml}
    ${answerHtml}
    ${speakHtml}
    ${corrHtml}
    <div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:22px">
      <button class="btn-sm accent" onclick="saveCurrentExam()">Save exam</button>
      <button class="btn-sm" onclick="shareExamUrl()">Copy exam link</button>
      ${isPracticeMode()&&savedWords.length?`<button class="btn-sm" onclick="goFlashcards()">Review ${savedWords.length} session words</button>`:''}
      <button class="btn-sm" onclick="downloadCorrectionPdf(S.lastResults.score,S.lastResults.mods,S.lastResults.d,S.lastResults.isDE,S.lastResults.correction,S.lastResults.speakingEvals)">Download PDF${typeof isPro==='function'&&!isPro()?' (Pro)':(typeof isPro==='function'&&isPro()&&typeof aiCreditCostSuffix==='function'&&!S.lastResults?.correction?.grammarCoaching?aiCreditCostSuffix('grammar_coaching'):'')}</button>
      <button class="btn-sm" onclick="goHistory()">View progress</button>
      <button class="btn-sm" onclick="goHome()">Dashboard</button>
    </div>`;
  const rid=entryId||d._savedId||d._flightId;
  if(typeof LcRouter!=='undefined'&&rid)LcRouter.replaceRoute('#/exam/'+rid+'/results','Results');
  window.scrollTo({top:0,behavior:'smooth'});
  if(correction&&(d.schreibenParts?.length||d.schreiben))loadWritingAiCorrections(correction,d,isDE,entryId);
}
function shareExamUrl(){
  saveCurrentExam();
  const url=typeof getShareableExamUrl==='function'?getShareableExamUrl():null;
  if(!url){lcToast('Save the exam first to get a share link.','warn');return;}
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(()=>lcToast('Exam link copied to clipboard.','success')).catch(()=>lcToast(url,'info',8000));
  }else lcToast(url,'info',8000);
}
