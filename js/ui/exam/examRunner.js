// ═══════════════════════════════════════════
// INCREMENTAL AUTOSAVE (debounced in_progress + guest sessionStorage)
// ═══════════════════════════════════════════
const EXAM_AUTOSAVE_MS = 2000;
let _examAutosaveTimer = null;
let _examAutosaveHooksBound = false;

function isLoggedInExamUser() {
  return typeof Auth !== 'undefined' && typeof Auth.hasSession === 'function' && Auth.hasSession();
}

function guestAutosaveKey() {
  const id = S.examData?._savedId || S.examData?._flightId;
  return id ? `lc_exam_progress_${id}` : 'lc_exam_progress_active';
}

function writeGuestExamProgress() {
  if (!S.examData || isLoggedInExamUser()) return;
  try {
    sessionStorage.setItem(
      guestAutosaveKey(),
      JSON.stringify({
        id: S.examData._savedId || S.examData._flightId || Date.now(),
        savedAt: Date.now(),
        answers: { ...S.answers },
        gapAnswers: { ...S.gapAnswers },
        fieldValues: typeof captureExamFieldValues === 'function' ? captureExamFieldValues() : {},
        examMeta: {
          topic: S.examData.topic,
          level: S.examData.level,
          lang: S.examData.lang,
          goalId: S.activeGoalId,
          mode: S.mode,
        },
      }),
    );
  } catch (_) {}
}

function flushExamAutosave() {
  if (_examAutosaveTimer) {
    clearTimeout(_examAutosaveTimer);
    _examAutosaveTimer = null;
  }
  if (!S.examData || S.isDemo || S.quickMod) return;
  if (typeof saveCurrentExam === 'function') {
    saveCurrentExam('in_progress', { silent: true });
  }
  if (!isLoggedInExamUser()) writeGuestExamProgress();
  if (typeof autosaveSession === 'function') autosaveSession();
}

function scheduleExamAutosave() {
  if (!S.examData || S.isDemo || S.quickMod) return;
  if (_examAutosaveTimer) clearTimeout(_examAutosaveTimer);
  _examAutosaveTimer = setTimeout(flushExamAutosave, EXAM_AUTOSAVE_MS);
}

function bindExamAutosaveLifecycle() {
  if (_examAutosaveHooksBound) return;
  _examAutosaveHooksBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushExamAutosave();
  });
  window.addEventListener('pagehide', flushExamAutosave);
}

async function registerOfficialExamTimer(limitMin) {
  if (typeof startOfficialExamTimer !== 'function') return;
  if (typeof Auth !== 'undefined' && typeof Auth.hasSession === 'function' && !Auth.hasSession()) return;
  const examSavedId = S.examData?._savedId || S.examData?._flightId;
  if (!examSavedId) return;
  try {
    const data = await startOfficialExamTimer({
      examSavedId,
      limitMinutes: limitMin,
      goalId: S.activeGoalId || S.examData?.goalId || null,
    });
    if (data?.timerSessionId) S.officialTimerSession = data;
  } catch (_) {
    /* server timer is advisory — exam continues */
  }
}

// ═══════════════════════════════════════════
// TIMER
// ═══════════════════════════════════════════
function startTimer(min){stopTimer();S.timerSec=min*60;S.timerEndsAt=Date.now()+S.timerSec*1000;updTimer();S.timerInt=setInterval(tickExamTimer,1000);}
function resumeTimerFromEndsAt(endsAt){
  stopTimer();
  if(!endsAt)return;
  S.timerEndsAt=endsAt;
  S.timerSec=Math.max(0,Math.ceil((endsAt-Date.now())/1000));
  updTimer();
  if(S.timerSec<=0){if(confirm('⏰ Time is up! Submit now?'))submitExam();return;}
  S.timerInt=setInterval(tickExamTimer,1000);
}
function tickExamTimer(){
  S.timerSec=Math.max(0,Math.ceil(((S.timerEndsAt||Date.now())-Date.now())/1000));
  updTimer();
  if(S.timerSec<=0){stopTimer();if(confirm('⏰ Time is up! Submit now?'))submitExam();}
}
function stopTimer(){if(S.timerInt){clearInterval(S.timerInt);S.timerInt=null;}}
function updTimer(){const el=document.getElementById('timerVal');if(!el)return;const m=Math.floor(S.timerSec/60),s=S.timerSec%60;el.textContent=m+':'+(s<10?'0':'')+s;el.className='timer-val'+(S.timerSec<300?' warn':'')+(S.timerSec<60?' crit':'');}

function unbindExamScrollTop(){
  if(S._examScrollCleanup){S._examScrollCleanup();S._examScrollCleanup=null;}
  document.documentElement.classList.remove('exam-scroll-active');
  const btn=document.getElementById('examScrollTopBtn');
  if(btn)btn.remove();
}
function bindExamScrollTop(){
  unbindExamScrollTop();
  document.documentElement.classList.add('exam-scroll-active');
  const btn=document.createElement('button');
  btn.id='examScrollTopBtn';
  btn.type='button';
  btn.className='exam-scroll-top';
  btn.setAttribute('aria-label','Scroll to top');
  btn.textContent='↑';
  btn.onclick=()=>window.scrollTo({top:0,behavior:'smooth'});
  document.body.appendChild(btn);
  const onScroll=()=>{
    const root=document.documentElement;
    const nearBottom=root.scrollHeight-root.scrollTop-root.clientHeight<120;
    btn.classList.toggle('visible',nearBottom&&root.scrollTop>300);
  };
  window.addEventListener('scroll',onScroll,{passive:true});
  onScroll();
  S._examScrollCleanup=()=>{window.removeEventListener('scroll',onScroll);};
}

// ═══════════════════════════════════════════
// RENDER EXAM
// ═══════════════════════════════════════════
function esc(s) {
  // C-1 fix: also escape quotes so attribute injection is impossible
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
/**
 * Escape, then put back <b> alone. The UI locale strings mark the literal prefixes the
 * candidate has to type — "Format <b>Ich:</b> / <b>Prüfer:</b>" — and the speaking hint
 * renders them through esc(), so students were reading the tags out loud instead of the
 * bold. Only <b> comes back, so nothing else in the string can turn into markup.
 */
function escKeepBold(s) {
  return esc(s).replace(/&lt;(\/?)b&gt;/g, '<$1b>');
}
/** Safe JS string literal for inline handlers (onclick, etc.). */
function jsLit(v) {
  return JSON.stringify(String(v ?? ''));
}
function stashPassageMeta(blockId, text, translations) {
  if (!text) return;
  S._passageMeta = S._passageMeta || {};
  S._passageMeta[blockId] = { text, translations: translations || {} };
}
function passageToolbarHtml(blockId, isPrac, ui) {
  if (!isPrac || isOfficialMode()) return '';
  const label = ui?.translatePassage || 'Translate passage';
  return `<div class="passage-translate-row" style="margin:10px 0 0"><button type="button" class="btn-sm" id="passBtn_${blockId}" onclick="translatePassage('${blockId}')">${esc(label)}</button></div><div class="passage-translation" id="passTrans_${blockId}" style="display:none;margin-top:10px;padding:12px;background:var(--surface2,rgba(127,127,127,.08));border-radius:8px;font-size:14px;line-height:1.65"></div>`;
}
function adminPassageReviewHtml(part, passageObj) {
  if (typeof AdminContentReview === 'undefined' || !AdminContentReview.passageBtnHtml) return '';
  return AdminContentReview.passageBtnHtml(part, passageObj);
}
function adminQuestionReviewHtml(q, part) {
  if (typeof AdminContentReview === 'undefined' || !AdminContentReview.questionBtnHtml) return '';
  return AdminContentReview.questionBtnHtml(q, part);
}
async function translatePassage(blockId) {
  const meta = S._passageMeta?.[blockId];
  const panel = document.getElementById('passTrans_' + blockId);
  const btn = document.getElementById('passBtn_' + blockId);
  if (!meta || !panel) return;
  const lang = typeof translationLang === 'function' ? translationLang() : S.vocabLang;
  const from = S.subject;
  const ui = typeof examUiStrings === 'function' ? examUiStrings(resolveExamLang(S.examData, S.subject)) : { translatingPassage: 'Translating…', translateFail: 'Could not translate this passage.' };
  const showTranslation = (text) => {
    const safe = typeof sanitizeExamText === 'function' ? sanitizeExamText(text) : text;
    panel.innerHTML = typeof formatReadableText === 'function' ? formatReadableText(safe, blockId + '_tr', false) : esc(safe).replace(/\n/g, '<br>');
    panel.style.display = 'block';
  };
  if (meta.translations?.[lang]) {
    const cached = meta.translations[lang];
    if (
      typeof PassageTranslate === 'undefined' ||
      !PassageTranslate.isPassageText(meta.text) ||
      PassageTranslate.isCompletePassageTranslation(meta.text, cached)
    ) {
      showTranslation(cached);
      return;
    }
  }
  panel.style.display = 'block';
  panel.textContent = ui.translatingPassage;
  if (btn) btn.disabled = true;
  try {
    let translation = null;
    const isPassage = typeof PassageTranslate !== 'undefined' && PassageTranslate.isPassageText(meta.text);
    if (!isPassage && typeof fetchVocabCache === 'function') {
      const hit = await fetchVocabCache(from, lang, meta.text);
      if (hit?.translation) translation = hit.translation;
    } else if (isPassage && typeof fetchVocabCache === 'function') {
      const hit = await fetchVocabCache(from, lang, meta.text);
      if (
        hit?.translation &&
        PassageTranslate.isCompletePassageTranslation(meta.text, hit.translation)
      ) {
        translation = hit.translation;
      }
    }
    if (!translation && typeof callAI === 'function') {
      const maxTok =
        typeof PassageTranslate !== 'undefined'
          ? PassageTranslate.passageOutputMaxTokens(meta.text.length)
          : 2500;
      const prompt =
        typeof PassageTranslate !== 'undefined'
          ? PassageTranslate.buildPassagePrompt(meta.text, from, lang)
          : `Translate the following ${from} exam passage to ${lang}. Return ONLY the translation, preserving paragraph and speaker line breaks. No notes.\n\n${meta.text}`;
      translation = await callAI(prompt, maxTok, {
        consumeQuota: true,
        aiAction: 'translation',
        timeoutMs: 60000,
      });
      if (
        translation &&
        typeof putVocabCache === 'function' &&
        (!isPassage || PassageTranslate.isCompletePassageTranslation(meta.text, translation))
      ) {
        await putVocabCache(from, lang, meta.text, translation, 'ai');
      }
    }
    if (!translation) {
      panel.textContent = ui.translateFail;
      return;
    }
    meta.translations[lang] = translation;
    showTranslation(translation);
  } catch (_) {
    panel.textContent = ui.translateFail;
  } finally {
    if (btn) btn.disabled = false;
  }
}
function renderOfficialHeader(d,isDE){
  if(!d.demo||!d.official)return '';
  const o=d.official;
  return `<div class="off-header"><div class="off-board">${o.board}</div><div class="off-cert">${o.certificate}</div><div class="off-note">${o.note}</div></div>`;
}
function renderGoetheModIntro(mod,key,ui){
  if(!mod)return '';
  return `<div class="off-mod-head"><h2>${ui.modWord} ${key}: ${mod.title}</h2><div class="off-mod-time">${mod.time}</div><p style="font-size:12px;color:var(--text-secondary);margin-top:8px;line-height:1.6">${ui.modHint}</p></div>`;
}
function segToQ(seg){
  const filterFn=typeof horenQuestionHasSubstance==='function'?horenQuestionHasSubstance:(typeof window!=='undefined'&&window.horenQuestionHasSubstance)||null;
  const keep=(q)=>filterFn?filterFn(q):true;
  const qs=seg.questions||[];
  if(qs.length)return qs.filter(keep);
  if(seg.question&&seg.options)return[{id:seg.id,type:'multiple',question:seg.question,options:seg.options,correct:seg.correct}].filter(keep);
  return[];
}
function itemToQ(item,idx){
  return{id:item.id,type:item.type||'multiple',question:(idx+1)+'  '+item.question,options:item.options,correct:item.correct};
}
function isLesenForumOpinionsPart(part){
  const slot=String(part?.blueprintSlot||part?.slotType||'').toLowerCase();
  if(slot.includes('forum')||slot.includes('opinion'))return true;
  if(Number(part?.teil)!==4)return false;
  const instr=String(part.instruction||'').toLowerCase();
  if(/meinungen.*(?:20|21)|ja oder nein|yes or no|stimmt die person/i.test(instr))return true;
  const items=part?.items||[];
  if(items.length>=5){
    return items.some(it=>{
      const t=String(it.type||'').toLowerCase();
      return(t==='yn'||t==='ja_nein')&&(it.signText||it.text);
    });
  }
  return(part.questions||[]).some(q=>{
    const c=String(q.correct??q.correctAnswer??'').trim();
    return(q.signText||q.text)&&/^(J|N|Ja|Nein|Yes|No)$/i.test(c);
  });
}
function lesenForumDisplayNum(item,idx,part){
  return scorableDisplayNum(item,idx,part);
}
/** Official display number for any scorable item (uses ExamRenumber metadata when present). */
function scorableDisplayNum(item,idx,part){
  const fromMeta=Number(item?.number??item?.nr??item?.nummer);
  if(Number.isFinite(fromMeta)&&fromMeta>=1)return String(fromMeta);
  const bareId=Number(item?.id);
  if(Number.isFinite(bareId)&&bareId>=1&&bareId<=99)return String(bareId);
  const start=part?._numberRange?.start;
  if(Number.isFinite(start))return String(start+idx);
  const teil=Number(part?.teil);
  if(teil===2)return String(7+idx);
  if(teil===3)return String(13+idx);
  if(teil===4)return String(20+idx);
  if(teil===5)return String(27+idx);
  return String(idx+1);
}
function inferLesenT3HasNoMatch(part){
  if(part._t3HasNoMatch)return true;
  const pool=[...(part.items||[]),...(part.questions||[])];
  return pool.some(it=>String(it?.correct??it?.correctAnswer??'').trim()==='0');
}
function lesenForumYnShouldHideQuestion(question){
  const q=String(question||'').trim();
  if(!q)return true;
  return /stimmt die person|ja oder nein|dem thema zu|agree with the topic|does the person agree/i.test(q);
}
function lesenItemIsAnswerable(item,part){
  if(!item)return false;
  const t=String(item.type||'').toLowerCase();
  if(t==='yn'||t==='ja_nein')return item.correct!=null||item.correctAnswer!=null;
  if(t==='matching'||t==='match')return item.correct!=null||item.correctAnswer!=null;
  if(part?.ads?.length>=2&&(item.signText||item.text||item.question)&&(item.correct!=null||item.correctAnswer!=null))return true;
  if(item.question&&(item.options?.length||item.correct!=null||item.correctAnswer!=null))return true;
  return false;
}
function lesenItemToAnswerQ(item,part,ui,idx){
  const t=String(item.type||'').toLowerCase();
  let type=item.type||'multiple';
  if(t==='ja_nein'||t==='yn')type='yn';
  else if(t==='matching'||t==='match')type='matching';
  const correct=item.correct??item.correctAnswer;
  let question=item.question||item.statement||'';
  if(type==='yn'&&isLesenForumOpinionsPart(part)&&item.signText&&!question)question='';
  else if(type==='yn'&&!question)question=ui?.lang==='de'?'Stimmt die Person dem Thema zu?':'Does the person agree?';
  const q={id:item.id,type,question,options:item.options,correct,explanation:item.explanation,grammarTags:item.grammarTags,vocabularyTags:item.vocabularyTags,difficulty:item.difficulty,passageId:item.passageId,_contentProvenance:item._contentProvenance};
  if(type==='matching'&&part?.ads?.length>=2&&(!q.options||!q.options.length)){
    q.options=part.ads.map((a,i)=>({key:String(a.key||String.fromCharCode(65+i)).toUpperCase(),text:a.title||a.text||''}));
    if(!q.options.some(o=>String(o.key)==='0'))q.options.push({key:'0',text:'0'});
    q._keyOnlyMatch=true;
  }else if(type==='matching'&&part?.ads?.length>=2&&q.options?.length){
    q._keyOnlyMatch=true;
  }
  return q;
}
function normalizeLesenT3Part(part){
  if(part._t3Normalized||part.ads||!part.items?.length)return;
  const firstOpts=part.items[0]?.options;
  if(!Array.isArray(firstOpts)||firstOpts.length<2||typeof firstOpts[0]!=='string')return;
  if(!/^[A-Z]\)/i.test(firstOpts[0]))return;
  // A matching task draws every item from ONE shared pool (Goethe Lesen T3 ads, Cambridge
  // Reading P2 texts / P4 sentences). Plain multiple choice gives each item its own options
  // and is structurally identical at this point — "A) …" strings with a letter answer — so
  // without this check the pool is built from item[0] alone and every other item silently
  // loses its own options. Cambridge P1/P3/P5 are exactly that shape.
  const pool=JSON.stringify(firstOpts);
  if(!part.items.every(it=>JSON.stringify(it.options||[])===pool))return;
  const hasCorrect=part.items.some(it=>String(it.type||'').toLowerCase()==='matching'||(it.correct!=null&&typeof it.correct==='string'&&/^[A-Za-z0]/i.test(it.correct)));
  if(!hasCorrect)return;
  const ads=[];
  let hasNoMatch=false;
  firstOpts.forEach(o=>{
    // "k) 0) Keine Zuordnung" or "0) ..." → no-match pill, not an ad
    if(/^[kK]\)\s*0\)/i.test(String(o))||/^0\)/i.test(String(o))){hasNoMatch=true;return;}
    const cleaned=String(o).replace(/\s*flojos>\.?\s*$/,'');
    const m=cleaned.match(/^([A-Za-z])\)\s*(.+)/);
    if(m&&m[1].toLowerCase()!=='k')ads.push({key:m[1].toUpperCase(),title:m[2].trim(),text:''});
  });
  if(!hasNoMatch)hasNoMatch=part.items.some(it=>String(it.correct||'')===('0'));
  if(ads.length<2)return;
  part.ads=ads;
  if(hasNoMatch)part._t3HasNoMatch=true;
  part._t3Normalized=true;
}
function isLesenAdsMatchingRender(part){
  if(isLesenForumOpinionsPart(part))return false;
  // Mirror of the blueprint guard in examGeneration.isLesenAdsMatchingPart: a part whose slot
  // is declared multiple choice or cloze is never an ads/matching layout, however its ads
  // array got populated upstream. Without this, Cambridge Reading P3 (long_text) still
  // rendered as "match the situation to a letter" because it arrived carrying stale ads.
  const slot=String(part?.blueprintSlot||part?.slotType||'').toLowerCase();
  if(/mcq|multiple_choice|long_text|open_cloze/.test(slot)&&!/matching|ads/.test(slot))return false;
  normalizeLesenT3Part(part);
  if(!(part?.ads?.length>=2))return false;
  // Items format (pool): items array with matching situations
  if((part.items||[]).some(it=>(it.signText||it.text||it.question)&&(it.correct!=null||String(it.type||'').toLowerCase()==='matching')))return true;
  // Questions format (library/published): separate questions array with matching type or letter answers
  if((part.questions||[]).some(q=>{
    const t=String(q.type||'').toLowerCase();
    if(['matching','match','abcd'].includes(t)&&(q.question||q.text))return true;
    const c=String(q.correct??q.correctAnswer??'').trim();
    return(q.question||q.text||q.signText)&&/^[A-J0]$/i.test(c);
  }))return true;
  return false;
}
function renderLesenAdsBlock(part,pi,isPrac,ui){
  const label=ui.lang==='de'?'Anzeigen':'Advertisements';
  return `<div class="pt-ads-block"><div class="pt-ads-header">${esc(label)}</div>${part.ads.map((a,i)=>{
    const k=String(a.key||String.fromCharCode(65+i)).toUpperCase();
    const body=a.title&&a.text?`${esc(a.title)} — ${wrapW(a.text,'lesen_'+pi+'_ad_'+k,isPrac)}`:wrapW(a.title||a.text||'','lesen_'+pi+'_ad_'+k,isPrac);
    return `<div class="pt-ad-item"><span class="pt-ad-key">${k})</span><span class="pt-ad-body">${body}</span></div>`;
  }).join('')}</div>`;
}
function renderHybridPendingLesenSection(part,ui){
  const msg=ui.lang==='de'?'Wird personalisiert…':'Personalizing…';
  return `<section class="module-wrap hybrid-pending-section" data-teil="${esc(String(part.teil||''))}"><div class="module-tag tag-lesen">${ui.reading} — ${ui.teil} ${part.teil||''}</div><div class="hybrid-pending-body" style="padding:36px 16px;text-align:center;color:var(--text-muted)"><div class="hybrid-pending-pulse" style="font-size:22px;line-height:1;margin-bottom:10px;opacity:.55">⋯</div><p style="font-size:13px;font-style:italic;margin:0">${esc(msg)}</p></div></section><hr class="section-div">`;
}
function isHorenPictureMatchingPart(part){
  if(typeof HorenPictureMatching!=='undefined'&&HorenPictureMatching.isPictureMatchingPart)return HorenPictureMatching.isPictureMatchingPart(part);
  const slot=String(part?.blueprintSlot||part?.slotType||'').toLowerCase();
  return slot.includes('picture_matching')||slot.includes('picture_schedule');
}
function horenSegmentPictures(seg,part){
  return seg?.pictures||part?.pictures||(part?.segments||[]).find(s=>s.pictures?.length)?.pictures||[];
}
function renderHorenPictureBank(pictures,pi,isPrac,ui){
  const pics=typeof HorenPictureMatching!=='undefined'?HorenPictureMatching.normalizePicturesBank(pictures):pictures;
  const hdr=ui.lang==='de'?'Aktivitäten a bis i':'Activities a to i';
  let h=`<aside class="horen-picture-bank" aria-label="${esc(hdr)}"><div class="horen-picture-header">${esc(hdr)}</div><div class="horen-picture-grid">`;
  pics.forEach(p=>{
    const key=String(p.key||'').toLowerCase();
    const lbl=p.label?String(p.label):'';
    h+=`<div class="horen-picture-item" data-activity-key="${esc(key)}" aria-label="${esc(key + (lbl ? ': ' + lbl : ''))}"><span class="pt-letter-pill horen-picture-key" aria-hidden="true">${esc(key)}</span>`;
    if(p.icon)h+=`<span class="horen-picture-icon" aria-hidden="true">${esc(p.icon)}</span>`;
    if(p.label)h+=`<span class="horen-picture-label">${wrapW(p.label,'horen_'+pi+'_pic_'+key,isPrac)}</span>`;
    h+=`</div>`;
  });
  return h+`</div></aside>`;
}
function renderHorenPictureMatchQuestion(q,num,mod,part,ui,isPrac,pictureKeys){
  const ak=`${mod}_${q.id}`;
  const saved=S.answers?.[ak]||'';
  const keys=pictureKeys||((typeof HorenPictureMatching!=='undefined')?HorenPictureMatching.PICTURE_KEYS_A2:['a','b','c','d','e','f','g','h','i']);
  let h=`<div class="pt-match-question horen-picture-match" data-ak="${esc(ak)}">`;
  h+=`<div class="pt-match-situation"><span class="pt-match-num">${esc(num)}.</span> ${esc(q.question)}</div>`;
  h+=`<div class="pt-match-pills">`;
  keys.forEach(letter=>{
    const sel=saved===letter;
    h+=`<button type="button" class="pt-letter-pill${sel?' selected':''}" onclick='ptSetMatch(${jsLit(ak)},${jsLit(letter)},this)'>${letter}</button>`;
  });
  h+=`</div>${adminQuestionReviewHtml(q,part)}</div>`;
  return h;
}
function renderGoetheLesenPart(part,pi,isPrac,ui){
  if(part._hybridPending)return renderHybridPendingLesenSection(part,ui);
  const hasContent=part.items?.length||part.text||part.ads?.length||part.questions?.length||part.opinions?.length||part.textWithGaps?.length||part.persons?.length;
  if(!hasContent){
    lcDebug.warn('[render] lesenPart',pi,'has no renderable content:',part);
    return`<section class="module-wrap"><div class="off-teil">${ui.reading} — ${ui.teil} ${part.teil||pi+1}</div><div style="padding:16px;color:var(--text-muted);font-size:13px;font-style:italic">${ui.partial}</div></section><hr class="section-div">`;
  }
  const modLabel=ui.reading;
  const teilLabel=ui.teil;
  const lesenStock=typeof PersonalTopicStock!=='undefined'
    ?PersonalTopicStock.forModule(S.subject||'de',S.level||'B1','lesen')
    :(typeof PersonalLesenTopicStock!=='undefined'?PersonalLesenTopicStock:null);
  const altNote=part._topicRelaxed&&lesenStock?.formatRelaxedTeilNote
    ?`<div class="personal-teil-alt-note">${esc(lesenStock.formatRelaxedTeilNote(part,ui.lang))}</div>`:'';
  let h=`<section class="module-wrap"><div class="module-tag tag-lesen">${modLabel} — ${teilLabel} ${part.teil}${part.arbeitszeit?' · '+part.arbeitszeit:''}</div>${altNote}<div class="off-instr">${esc(part.instruction)}</div>`;
  const mod='lesen_'+pi;
  const adsMatching=isLesenAdsMatchingRender(part);
  if(adsMatching){
    const sitHdr=ui.lang==='de'?'Situationen':'Situations';
    h+=`<div class="pt-t3-layout"><div class="pt-t3-main">`;
    // Gapped-text matching (Cambridge Reading P4) carries the passage the gaps belong to in
    // part.text. This branch returns before the generic part.text block below, so without
    // this the candidate matches sentences to gaps they cannot see. Only rendered when the
    // text actually has gap markers: in P2 part.text is a copy of the lettered pool itself,
    // and Goethe T3 has no passage, so neither renders it twice.
    if(part.text&&/\(\d+\)|_{3,}/.test(part.text)){
      const gapBlockId='lesen_'+pi+'_gapped';
      stashPassageMeta(gapBlockId,part.text,part.translations);
      h+=`<div class="text-display"><h3>${esc(part.textTitle||'')}</h3><div class="readable-text">${wrapW(part.text,gapBlockId,isPrac)}</div>${passageToolbarHtml(gapBlockId,isPrac,ui)}</div>`;
    }
    const ex=part.example||part.solvedExample;
    if(ex&&(ex.situation||ex.question||ex.text)){
      const exLbl=ex.label||(ui.lang==='de'?'Beispiel':'Example');
      h+=`<div class="off-sign off-sign-example"><div class="off-sign-label">${esc(exLbl)} ${ex.number!=null?esc(String(ex.number)):''}</div>${wrapW(ex.situation||ex.question||ex.text,'lesen_'+pi+'_ex',isPrac)}<div class="off-example-ans" style="margin-top:8px;font-size:13px;color:var(--text-muted)">${ui.lang==='de'?'Lösung:':'Answer:'} <b>0</b></div></div>`;
    }
    h+=`<div class="pt-situations-header">${esc(sitHdr)}</div>`;
    const adLetters=part.ads.map((a,i)=>String(a.key||String.fromCharCode(65+i)).toUpperCase());
    if(inferLesenT3HasNoMatch(part)&&!adLetters.includes('0'))adLetters.push('0');
    const situations=part.items?.length
      ?part.items
      :(part.questions||[]).filter(q=>String(q.type||'').toLowerCase()==='matching'||(q.question||q.text));
    situations.forEach((item,idx)=>{
      const num=scorableDisplayNum(item,idx,part);
      const situation=item.signText||item.text||item.question||'';
      const ak=`${mod}_${item.id||num}`;
      const saved=S.answers?.[ak]||'';
      h+=`<div class="pt-match-question" data-ak="${esc(ak)}">`;
      if(situation){h+=`<div class="pt-match-situation"><span class="pt-match-num">${esc(num)}.</span> ${wrapW(situation,'lesen_'+pi+'_sit_'+num,isPrac)}</div>`;}
      h+=`<div class="pt-match-pills">`;
      adLetters.forEach(letter=>{
        const sel=saved===letter;
        h+=`<button type="button" class="pt-letter-pill${sel?' selected':''}" onclick='ptSetMatch(${jsLit(ak)},${jsLit(letter)},this)'>${letter}</button>`;
      });
      h+=`</div>${adminQuestionReviewHtml(item,part)}</div>`;
    });
    h+=`</div><aside class="pt-t3-ads" aria-label="${esc(ui.lang==='de'?'Anzeigen':'Advertisements')}">`;
    h+=renderLesenAdsBlock(part,pi,isPrac,ui);
    h+=`</aside></div>`;
    return h+'</section><hr class="section-div">';
  }
  if(isLesenForumOpinionsPart(part)){
    if(part.textTitle)h+=`<div class="text-display"><h3>${esc(part.textTitle)}</h3></div>`;
    const forumItems=part.items?.length
      ?part.items
      :(part.questions||[]).filter(q=>q&&(q.signText||q.text)).map((q,i)=>({
        id:q.id!=null?q.id:String(20+i),
        signText:q.signText||q.text||'',
        question:q.question||'',
        type:'ja_nein',
        correct:q.correct??q.correctAnswer,
        explanation:q.explanation,
        vocabularyTags:q.vocabularyTags,
        grammarTags:q.grammarTags,
        difficulty:q.difficulty,
        passageId:q.passageId,
        _contentProvenance:q._contentProvenance,
      }));
    forumItems.forEach((item,idx)=>{
      const num=lesenForumDisplayNum(item,idx,part);
      if(item.signText||item.text){
        h+=`<div class="off-sign"><div class="off-sign-label">${esc(num)}</div>${wrapW(item.signText||item.text,'lesen_'+pi+'_sit_'+num,isPrac)}</div>`;
      }
      if(lesenItemIsAnswerable(item,part)){
        const q=lesenItemToAnswerQ(item,part,ui,idx);
        if(q.type==='yn'&&(item.signText||item.text)&&lesenForumYnShouldHideQuestion(q.question))q.question='';
        h+=renderQ(q,num,mod,ui.trueL,ui.falseL,ui.trueK,true,part);
      }
    });
    return h+'</section><hr class="section-div">';
  }
  const signBlock=part.items?.length&&part.items.every(it=>it.signText&&!it.question&&!lesenItemIsAnswerable(it,part));
  if(signBlock){
    part.items.forEach((item,idx)=>{
      const lbl=item.id||String.fromCharCode(65+idx);
      h+=`<div class="off-sign"><div class="off-sign-label">${esc(lbl)}</div>${wrapW(item.signText,'lesen_'+pi+'_sign_'+idx,isPrac)}</div>`;
    });
  }else if(part.items){
    part.items.forEach((item,idx)=>{
      if(item.signText||item.text){
        const lbl=item.id||('Text '+(idx+1));
        h+=`<div class="off-sign"><div class="off-sign-label">${esc(String(lbl))}</div>${wrapW(item.signText||item.text,'lesen_'+pi+'_sign_'+idx,isPrac)}</div>`;
      }
      if(lesenItemIsAnswerable(item,part)){
        const q=lesenItemToAnswerQ(item,part,ui,idx);
        if(q.type==='yn'&&item.signText&&!item.question)q.question='';
        h+=renderQ(q,scorableDisplayNum(item,idx,part),mod,ui.trueL,ui.falseL,ui.trueK,true);
      }else if(item.question&&(item.options?.length||item.correct)){
        h+=renderQ(itemToQ(item,idx),scorableDisplayNum(item,idx,part),mod,ui.trueL,ui.falseL,ui.trueK,true);
      }
    });
  }
  if(part.passages?.length>=2){
    part.passages.forEach((pp,pi2)=>{
      const txt=typeof pp==='string'?pp:(pp.text||'');
      if(!String(txt).trim())return;
      const pid=pp.passageId||pp.id||String.fromCharCode(65+pi2);
      const blockId='lesen_'+pi+'_'+pid;
      stashPassageMeta(blockId,txt,pp.translations);
      h+=`<div class="text-display"><h3>${esc(pp.textTitle||pp.title||('Text '+pid))}</h3><div class="readable-text">${wrapW(txt,blockId,isPrac)}</div>${passageToolbarHtml(blockId,isPrac,ui)}${adminPassageReviewHtml(part,pp)}</div>`;
    });
  }else if(part.text){
    const blockId='lesen_'+pi;
    stashPassageMeta(blockId,part.text,part.translations);
    h+=`<div class="text-display"><h3>${esc(part.textTitle||'')}</h3><div class="readable-text">${wrapW(part.text,'lesen_'+pi,isPrac)}</div>${passageToolbarHtml(blockId,isPrac,ui)}${adminPassageReviewHtml(part,part)}</div>`;
  }
  if(part.textWithGaps?.length){
    h+=`<div class="text-display"><h3>${esc(part.textTitle||'')}</h3>${part.textWithGaps.map((para,gi)=>`<div class="readable-text" style="margin-bottom:12px">${wrapW(para,'lesen_'+pi+'_gap_'+gi,isPrac)}</div>`).join('')}${adminPassageReviewHtml(part,part)}</div>`;
    if(part.options?.length){
      h+=`<div class="off-ads">${part.options.map(o=>`<div class="off-ad"><b>${esc(o.key)})</b> ${wrapW(o.text,'lesen_'+pi+'_opt_'+o.key,isPrac)}</div>`).join('')}</div>`;
    }
  }
  if(part.ads){
    const adLbl=ui.option;
    h+=`<div class="off-ads">${part.ads.map((a,i)=>{const k=String(a.key||String.fromCharCode(65+i)).toUpperCase();return`<div class="off-ad"><b>${adLbl} ${k}: ${esc(a.title)}</b>${wrapW(a.text,'lesen_'+pi+'_ad_'+k,isPrac)}</div>`;}).join('')}</div>`;
  }
  if(part.persons?.length){
    h+=`<div class="off-opinions">${part.persons.map((p,i)=>`<div class="off-ad"><b>${esc(p.name)}:</b> ${wrapW(p.text,'lesen_'+pi+'_person_'+i,isPrac)}</div>`).join('')}</div>`;
  }
  if(part.opinions){
    h+=`<div class="off-opinions">${part.opinions.map((o,i)=>`<div class="off-ad"><b>${esc(o.name)}:</b> ${wrapW(o.text,'lesen_'+pi+'_op_'+i,isPrac)}</div>`).join('')}</div>`;
  }
  if(part.questions)h+=part.questions.map((q,i)=>q.type==='gap_fill'?renderGapFillQ(q,scorableDisplayNum(q,i,part),mod,part,ui.lang==='de'):renderQ(q,scorableDisplayNum(q,i,part),mod,ui.trueL,ui.falseL,ui.trueK,true,part)).join('');
  return h+'</section><hr class="section-div">';
}
function renderGoetheHorenPart(part,pi,isPrac,ui){
  const hasContent=part.segments?.length||part.noteFields?.length||part.transcript||part.questions?.length;
  if(!hasContent){
    lcDebug.warn('[render] horenPart',pi,'has no renderable content:',part);
    return`<section class="module-wrap"><div class="off-teil">${ui.listening} — ${ui.teil} ${part.teil||pi+1}</div><div style="padding:16px;color:var(--text-muted);font-size:13px;font-style:italic">${ui.partialListen}</div></section><hr class="section-div">`;
  }
  const modLabel=ui.listening;
  const teilLabel=ui.teil;
  const mod='horen_'+pi;
  const plays=part.plays||2;
  const lang=ui.speechLang;
  let h=`<section class="module-wrap"><div class="module-tag tag-horen">${modLabel} — ${teilLabel} ${part.teil}</div><div class="off-instr">${esc(part.instruction)}</div>`;
  if(part.context)h+=`<p class="module-desc">${esc(part.context)}</p>`;
  if(part.speakers)h+=`<p class="module-desc" style="font-size:11px"><b>${part.speakers.map((s)=>esc(s)).join(' · ')}</b></p>`;
  const renderListen=(id,label)=>{
    const rem=S['listenPlays_'+id]??plays;
    const playTxt=ui.hearIntro(plays);
    const btnTxt=`${ui.play} (${rem})`;
  const noPlays=rem<=0;
    return `<div class="listen-box" id="listenBox_${id}"><div class="listen-info" id="listenInfo_${id}">${esc(label)}. ${playTxt}</div><div class="wave" id="listenWave_${id}">${'<div class="wb paused"></div>'.repeat(9)}</div><button class="btn-sm blue" id="listenBtn_${id}" onclick="playHorenPart('${id}')" style="margin:0 auto"${noPlays?' disabled':''}>${noPlays?ui.noPlays:btnTxt}</button>${!isPrac?`<div style="font-size:11px;color:var(--text-muted);margin-top:10px;font-style:italic">${ui.audioOnly}</div>`:''}</div>`;
  };
  const renderTranscript=(text,sec,translations,blockId,passageObj)=>{
    if(!text)return'';
    stashPassageMeta(blockId,text,translations);
    const summary=ui.showTranscript||(ui.lang==='de'?'Transkript anzeigen':'Show transcript');
    const reviewTarget=passageObj&&typeof passageObj==='object'
      ?passageObj
      :{text,title:part.textTitle||part.title||'',topicTag:part.topicTag,passageId:part.passageId,id:part.passageId};
    return `<details class="horen-transcript-details"><summary>${esc(summary)}<span class="tr-arrow">▼</span></summary><div class="transcript-body">${wrapW(text,sec,isPrac)}${passageToolbarHtml(blockId,isPrac,ui)}${adminPassageReviewHtml(part,reviewTarget)}</div></details>`;
  };
  if(part.segments){
    part.segments.forEach((seg,si)=>{
      h+=`<h3 style="font-size:13px;font-weight:700;margin:14px 0 8px">${esc(seg.label)}</h3>`;
      h+=renderListen(pi+'_'+si,seg.label);
      if(seg.speakerLegend?.length){
        const spLbl=ui.lang==='de'?'Sprecher':'Speakers';
        h+=`<p class="module-desc" style="font-size:12px;margin:8px 0 12px"><b>${spLbl}:</b> ${esc(seg.speakerLegend.join(' · '))}</p>`;
      }
      h+=renderTranscript(seg.transcript,'horen_'+pi+'_'+si,seg.translations,'horen_'+pi+'_'+si,seg);
      const picMatch=isHorenPictureMatchingPart(part)||horenSegmentPictures(seg,part).length>=9;
      if(picMatch){
        const pics=horenSegmentPictures(seg,part);
        h+=`<div class="horen-picture-layout">${renderHorenPictureBank(pics,pi+'_'+si,isPrac,ui)}<div class="horen-picture-questions">`;
        segToQ(seg).forEach((q,i)=>{
          h+=renderHorenPictureMatchQuestion(q,scorableDisplayNum(q,i,part),mod+'_'+si,part,ui,isPrac);
        });
        h+=`</div></div>`;
      }else{
        segToQ(seg).forEach((q,i)=>{h+=renderQ(q,scorableDisplayNum(q,i,part),mod+'_'+si,ui.trueL,ui.falseL,ui.trueK,true,part);});
      }
    });
  }else if(part.noteFields){
    h+=renderListen(String(pi),part.context||ui.recording);
    h+=renderTranscript(part.transcript,'horen_'+pi,part.translations,'horen_'+pi,part);
    h+=`<div class="off-notes" style="margin:14px 0"><h3 style="font-size:14px;margin-bottom:10px">${esc(part.notesTitle||'Notes')}</h3>`;
    part.noteFields.forEach(f=>{
      h+=`<div class="form-row"><label for="note_${f.id}">${esc(f.label)}</label><input class="form-input" id="note_${f.id}" placeholder="..." oninput="updProg()"></div>`;
    });
    h+=`</div>`;
  }else{
    h+=renderListen(String(pi),part.context||ui.recording);
    h+=renderTranscript(part.transcript,'horen_'+pi,part.translations,'horen_'+pi,part);
    if(part.questions)h+=part.questions.map((q,i)=>renderQ(q,scorableDisplayNum(q,i,part),mod,ui.trueL,ui.falseL,ui.trueK,true,part)).join('');
  }
  return h+'</section><hr class="section-div">';
}
function renderGoetheSchreibenPart(part,ui){
  let body=`<div class="write-brief"><div class="off-instr" style="border-left-color:var(--orange)">${esc(part.task)}</div><div class="criteria-chips" style="margin-top:12px">${(part.criteria||[]).map(c=>`<span class="criteria-chip">${c}</span>`).join('')}</div></div>`;
  if(part.formFields){
    body+=part.formFields.map((f,i)=>`<div class="form-row"><label for="${part.fieldId}_${i}">${f}</label><input class="form-input" id="${part.fieldId}_${i}" data-field="${esc(f)}" placeholder="..." oninput="updWGoethe()"></div>`).join('');
    body+=`<div class="word-meter" id="meter_${part.fieldId}">0 / ${part.formFields.length} ${ui.fields}</div>`;
  }else{
    body+=`<textarea class="write-field" id="${part.fieldId}" placeholder="${ui.writePh}" oninput="updWGoethe()"></textarea><div class="word-meter" id="meter_${part.fieldId}">0 ${ui.words}${part.minWords?' — min '+part.minWords:''}</div>`;
  }
  const modLabel=ui.writing;
  const aufLabel=ui.teil;
  return `<section class="module-wrap"><div class="module-tag tag-schreiben">${modLabel} — ${aufLabel} ${part.aufgabe}${part.arbeitszeit?' · '+part.arbeitszeit:''}</div>${body}</section><hr class="section-div">`;
}
function renderGoetheSprechenPart(part,ui){
  if(typeof SpeakingFlow!=='undefined')return SpeakingFlow.renderGoetheSprechenPart(part,ui);
  const briefing=typeof SprechenBriefing!=='undefined'?SprechenBriefing.briefingForPart(part):{intro:part.situation||'',bullets:part.points||part.prompts||[],slides:part.slides||[]};
  const displayIntro=briefing.intro||part.situation||'';
  const bullets=briefing.bullets||[];
  const slides=briefing.slides?.length?briefing.slides:part.slides||[];
  const modLabel=ui.speaking;
  const tagLine=typeof SpeakingFlow!=='undefined'&&SpeakingFlow.sprechenPartModuleTag?SpeakingFlow.sprechenPartModuleTag(part,ui):`${modLabel} — ${ui.teil} ${part.teil}${part.title&&!/^(teil|sprechen|speaking|part)\s*\d+$/i.test(String(part.title).trim())?': '+part.title:''}${part.dauer?' · '+part.dauer:''}`;
  const de=ui?.lang==='de';
  let h=`<section class="module-wrap"><div class="module-tag tag-sprechen">${esc(tagLine)}</div><div class="off-instr">${esc(displayIntro)}</div>`;
  if(part.cardText)h+=`<div class="off-card-scene"><b>${ui.card}</b> ${esc(part.cardText)}</div>`;
  if(part.photoDescriptions?.length){
    h+=`<div class="off-photos">${part.photoDescriptions.map(p=>`<div class="off-ad">${esc(p)}</div>`).join('')}</div>`;
  }
  if(slides.length){
    h+=`<div class="speak-points speak-slides">${slides.map(s=>`<div class="speak-point"><b>${esc(String(s.n??''))}.</b> ${esc(s.title||s.text||'')}</div>`).join('')}</div>`;
  }else if(bullets.length){
    const ptsLabel=de?'Punkte zum Besprechen':'Points to cover';
    h+=`<div class="speak-points-label">${esc(ptsLabel)}</div><ul class="speak-points speak-points-list">${bullets.map(p=>`<li class="speak-point">${esc(p)}</li>`).join('')}</ul>`;
  }
  h+=`<div style="font-size:12px;color:var(--text-muted);margin-bottom:7px">${ui.speakFmt}</div>${typeof renderSpeakingMicHtml==='function'?renderSpeakingMicHtml(part.fieldId,S.subject):`<textarea class="write-field" id="${part.fieldId}" style="min-height:160px" placeholder="${ui.me}" oninput="updProg()"></textarea>`}</section><hr class="section-div">`;
  return h;
}
function renderGoetheExam(d,isPrac,isQ){
  const ui=typeof examUiStrings==='function'?examUiStrings(resolveExamLang(d,S.subject)):examUiStrings('en');
  let secs='';
  const lesenParts=d.lesenParts||[],horenParts=d.horenParts||[],schreibenParts=d.schreibenParts||[],sprechenParts=d.sprechenParts||[];
  if(d.modules?.lesen&&lesenParts.length){
    secs+=renderGoetheModIntro(d.modules.lesen,ui.reading,ui);
    lesenParts.forEach((p,i)=>{secs+=renderGoetheLesenPart(p,i,isPrac,ui);});
  }
  if(d.modules?.horen&&horenParts.length){
    secs+=renderGoetheModIntro(d.modules.horen,ui.listening,ui);
    horenParts.forEach((p,i)=>{
      S['listenPlays_'+i]=p.plays||2;
      if(p.segments)p.segments.forEach((s,si)=>{S['listenPlays_'+i+'_'+si]=p.plays||2;});
      secs+=renderGoetheHorenPart(p,i,isPrac,ui);
    });
  }
  if(d.modules?.schreiben&&schreibenParts.length){
    secs+=renderGoetheModIntro(d.modules.schreiben,ui.writing,ui);
    schreibenParts.forEach(p=>{secs+=renderGoetheSchreibenPart(p,ui);});
  }
  if(d.modules?.sprechen&&sprechenParts.length){
    secs+=renderGoetheModIntro(d.modules.sprechen,ui.speaking,ui);
    sprechenParts.forEach(p=>{secs+=renderGoetheSprechenPart(p,ui);});
  }
  return secs;
}
function resolveListeningContext(id){
  const d=S.examData;
  const key=String(id);
  let text='',ttsVoice=null;
  if(id==='legacy'&&d?.horen){
    text=d.horen.transcript||'';
    ttsVoice=d.horen.ttsVoice;
  }else if(String(id).includes('_')){
    const[pi,si]=String(id).split('_').map(Number);
    const seg=d.horenParts?.[pi]?.segments?.[si];
    text=seg?.transcript||'';
    ttsVoice=seg?.ttsVoice;
  }else{
    const part=d.horenParts?.[id];
    text=part?.transcript||'';
    ttsVoice=part?.ttsVoice;
  }
  return{key,text,ttsVoice,examLang:d?.lang||S.subject||'en'};
}
async function playListeningPassage(id,ui,opts={}){
  if(typeof unlockWebAudio==='function')unlockWebAudio();
  const d=S.examData;if(!d)return;
  const ctx=resolveListeningContext(id);
  const{key,ttsVoice,examLang}=ctx;
  const rawText=String(ctx.text||'').trim();
  if(!rawText)return;
  // Lo que se sintetiza, sin la etiqueta de hablante: tiene que coincidir con
  // pregenerate-tts.mjs o la cache no acierta.
  const spokenText=typeof ListeningScript!=='undefined'?ListeningScript.singleVoiceText(rawText):rawText;
  const cacheText=typeof normalizeTtsQueryText==='function'?normalizeTtsQueryText(spokenText):spokenText;
  const playsKey=opts.playsKey||(id==='legacy'?'listenPlays':'listenPlays_'+key);
  if(S[playsKey]===undefined)S[playsKey]=2;
  if(S[playsKey]<=0)return;
  S[playsKey]--;
  const rem=S[playsKey];
  const waveId=opts.waveId||(id==='legacy'?'listenWave':'listenWave_'+key);
  const btnId=opts.btnId||(id==='legacy'?'listenBtn':'listenBtn_'+key);
  const infoId=opts.infoId||(id==='legacy'?'listenInfo':'listenInfo_'+key);
  const wave=document.getElementById(waveId);
  const btn=document.getElementById(btnId);
  const info=document.getElementById(infoId);
  const speechLang=ui?.speechLang||(examLang==='de'?'de-DE':examLang==='es'?'es-ES':'en-GB');
  const voice=ttsVoice||(typeof ttsVoiceForLang==='function'?ttsVoiceForLang(examLang):examLang);
  const startWave=()=>{if(wave)wave.querySelectorAll('.wb').forEach(b=>b.classList.remove('paused'));};
  const stopWave=()=>{if(wave)wave.querySelectorAll('.wb').forEach(b=>b.classList.add('paused'));};
  const updateControls=(playing)=>{
    if(!btn)return;
    if(playing){btn.textContent='■ Playing…';return;}
    if(rem<=0){btn.disabled=true;btn.textContent=ui?.noPlays||'No plays left';}
    else btn.textContent=`${ui?.play||'Play'} (${rem})`;
  };
  const onDone=()=>{stopWave();updateControls(false);if(opts.onDone)opts.onDone(rem);};
  startWave();updateControls(true);
  let played=false;
  const useMulti=typeof ListeningScript!=='undefined'&&ListeningScript.isMultiVoice(rawText);
  try{
    if(useMulti){
      const segments=ListeningScript.prepare(rawText,examLang);
      await playMultiVoiceSegments(segments,examLang,()=>onDone());
      played=true;
    }
    if(!played&&typeof fetchTtsAudio==='function'){
      const hit=await fetchTtsAudio(cacheText,voice,examLang);
      if(hit&&typeof playTtsHit==='function'){
        played=await playTtsHit(hit,onDone);
      }
    }
    if(!played&&typeof isPro==='function'&&isPro()&&typeof generateTtsAudio==='function'){
      const gen=await generateTtsAudio(cacheText,voice,examLang);
      if(gen&&typeof playTtsHit==='function'){
        played=await playTtsHit(gen,onDone);
      }
    }
  }catch(err){
    console.warn('[TTS] server audio failed, falling back to browser speech:',err);
  }
  if(!played){
    const finishBrowser=()=>{
      if(id==='legacy'){
        const ck=setInterval(()=>{
          if(!window.speechSynthesis?.speaking){clearInterval(ck);onDone();}
        },500);
      }else{
        setTimeout(onDone,Math.min(120000,rawText.length*55));
      }
    };
    if(typeof _speakWithBrowser==='function'){
      const ok=_speakWithBrowser(spokenText,examLang,finishBrowser);
      if(!ok&&typeof notify==='function'){
        notify('Audio unavailable in this browser. Install a German voice or try Chrome/Edge.','warn',7000);
        onDone();
      }
    }else if(typeof speak==='function'){
      speak(rawText,examLang);
      finishBrowser();
    }else{
      if(typeof notify==='function')notify('Audio playback is not available in this browser.','warn',6000);
      onDone();
    }
  }
}
async function playHorenPart(id){
  const d=S.examData;if(!d?.horenParts)return;
  const ui=typeof examUiStrings==='function'?examUiStrings(resolveExamLang(d,S.subject)):examUiStrings('en');
  await playListeningPassage(id,ui);
}
function updWGoethe(){updProg();const d=S.examData;if(!d?.schreibenParts)return;d.schreibenParts.forEach(p=>{const el=document.getElementById('meter_'+p.fieldId);if(!el)return;if(p.formFields){const filled=p.formFields.filter((_,i)=>document.getElementById(p.fieldId+'_'+i)?.value.trim()).length;el.textContent=filled+' / '+p.formFields.length+' Felder';el.className='word-meter'+(filled>=p.formFields.length?' ok':'');return;}const ta=document.getElementById(p.fieldId);if(!ta)return;const w=ta.value.trim().split(/\s+/).filter(x=>x).length,min=p.minWords||0;el.textContent=w+' Wörter'+(min?' — min '+min:'');el.className='word-meter'+(min&&w>=min?' ok':'');});}
function forEachGoetheLesenItems(p,pi,fn){
  normalizeLesenT3Part(p);
  const mod='lesen_'+pi;
  if(isLesenAdsMatchingRender(p)||isLesenForumOpinionsPart(p)){
    if(p.items?.length){
      p.items.forEach((item,idx)=>{if(lesenItemIsAnswerable(item,p))fn(mod,lesenItemToAnswerQ(item,p,null,idx));});
    }else{
      // Library format: questions array with matching type
      (p.questions||[]).filter(q=>String(q.type||'').toLowerCase()==='matching').forEach(q=>fn(mod,q));
    }
    return;
  }
  const signBlock=p.items?.length&&p.items.every(it=>it.signText&&!it.question&&!lesenItemIsAnswerable(it,p));
  if(!signBlock){
    p.items?.forEach((item,idx)=>{
      if(lesenItemIsAnswerable(item,p))fn(mod,lesenItemToAnswerQ(item,p,null,idx));
      else if(item.question)fn(mod,itemToQ(item,idx));
    });
  }
}
function forEachGoetheQ(d,fn){
  d.lesenParts?.forEach((p,pi)=>{
    const mod='lesen_'+pi;
    const meta={module:'lesen',teil:p.teil,part:p};
    forEachGoetheLesenItems(p,pi,(m,q)=>fn(m,q,meta));
    p.questions?.forEach(q=>fn(mod,q,meta));
  });
  d.horenParts?.forEach((p,pi)=>{
    const meta={module:'horen',teil:p.teil,part:p};
    if(p.segments?.length){
      // Eje-2 Fase B: segments es autoridad — iterar solo segments (elimina doble visita V-21)
      p.segments.forEach((s,si)=>{
        const segMeta={...meta,segment:si};
        segToQ(s).forEach(q=>fn('horen_'+pi+'_'+si,q,segMeta));
      });
    }else{
      // Sin segments: questions[] es la fuente (H4 plano, fallback)
      (p.questions||[]).forEach(q=>fn('horen_'+pi,q,meta));
    }
  });
}
function forEachGoetheNotes(d,fn){
  d.horenParts?.forEach((p,pi)=>{
    p.noteFields?.forEach(f=>fn('note',f,pi));
  });
}
function renderExam(){
  if(typeof AdminContentReview!=='undefined'&&AdminContentReview.resetTargets)AdminContentReview.resetTargets();

  if(S.examData&&typeof normalizeExam==='function'){
    S.examData=normalizeExam(S.examData);
  }
  const d=S.examData;
  if(typeof LcAnalytics!=='undefined'&&d&&!S.isDemo&&!S.quickMod&&!d.demo){
    const gaKey=(d._savedId||d._flightId||d.topic||'exam')+':'+(d.lang||S.subject)+':'+(d.level||S.level);
    if(S._gaExamStartedKey!==gaKey){
      S._gaExamStartedKey=gaKey;
      LcAnalytics.trackExamStarted(d.lang||S.subject,d.level||S.level);
    }
  }
  if(typeof BurnedRegistry!=='undefined'&&S.examData&&!S.isDemo&&S.examSource&&S.examSource!=='demo'&&!S.examData._fromSaved){try{BurnedRegistry.burnExam(S.examData);}catch(_){}}
  if(typeof _recordSeenPartsFromExam==='function'&&S.examData&&!S.isDemo&&S.examSource&&S.examSource!=='demo'&&!S.examData._fromSaved&&!S.examData._sectionPart){try{_recordSeenPartsFromExam(S.examData);}catch(_){}}
  hideAll();
  const goal=getActiveGoal();
  if(typeof ActivityTrack!=='undefined'){
    const qm=S.quickMod;
    const lbl=qm?'Quick '+qm:(isPracticeMode()?'Practice exam':'Official exam');
    ActivityTrack.beginSession(qm?'quick':'exam',goal?.id||S.activeGoalId,lbl);
  }
  S.examSavedWords=[];
  S._passageMeta={};
  if(!S.isDemo&&!S.quickMod){
    bindExamAutosaveLifecycle();
    if(!S.activeSession)initExamSession(S.mode);
    autosaveSession();
  }
  const isDE=d.lang==='de',isPrac=isPracticeMode(),isQ=!!S.quickMod,isOff=!!d.demo;
  const isOffMode=isOfficialMode();
  const scr=document.getElementById('examScreen');
  scr.innerHTML='';
  scr.style.display='block';
  scr.className=isOffMode?'mode-official':isPrac?'mode-practice':'';
  if(d.vocabPersonal&&d.vocabWords?.length&&typeof TargetUsage!=='undefined'&&!d.targetUsageVerified?.length){
    TargetUsage.applyVerified(d,d.vocabWords);
    S.examData=d;
  }
  const rfT=isDE?'Richtig':'True',rfF=isDE?'Falsch':'False',trK=isDE?'R':'T';
  const timerH=(isOffMode&&!isQ)?`<div class="timer-wrap"><span class="timer-val" id="timerVal">--:--</span></div>`:'';
  const practH=isPrac?`<div class="exam-prac-banner exam-mode-banner"><b>${isDE?'Übungsmodus':'Practice mode'}:</b> ${isDE?'Tippe auf Wörter für Übersetzung und Speichern. Gespeicherte Wörter sind farbcodiert —':'Tap words to translate and save. Saved words are color-coded —'} <span class="vocab-legend vocab-pos-noun">${isDE?'Nomen':'noun'}</span> <span class="vocab-legend vocab-pos-verb">${isDE?'Verb':'verb'}</span> <span class="vocab-legend vocab-pos-adjective">${isDE?'Adj':'adj'}</span> <span class="vocab-legend vocab-pos-adverb">${isDE?'Adv':'adv'}</span>.</div>`:'';
  const partialGenH=d._partialGen?`<div class="personal-gen-banner"><b>Partial generation</b> — some Teile were skipped.${d._failedTeile?.length?` Missing: ${esc(d._failedTeile.slice(0,4).join(', '))}${d._failedTeile.length>4?'…':''}.`:''} <button type="button" class="btn-sm accent" onclick="retryFailedPersonalParts()">Retry failed parts</button></div>`:'';
  const hybridBannerMsg=isDE?'Dein Examen wird personalisiert…':'Personalizing your exam…';
  const hybridLoadingH=d._hybridLoading?`<div class="personal-gen-banner hybrid-loading-banner"><b>${hybridBannerMsg}</b></div>`:'';
  const officialH=isOffMode?`<div class="exam-official-banner exam-mode-banner"><b>${isDE?'Official-Modus':'Official mode'}:</b> ${isDE?'Tippe auf ein Wort, um es zu markieren (nochmal tippen = entfernen). Keine Übersetzungen während des Exams — markierte Wörter siehst du danach in den Ergebnissen.':'Tap a word to mark it (tap again to unmark). No translations during the exam — review marked words on the results screen.'}</div>`:'';
  const demoH=d.guidedDemo?`<div class="demo-banner"><b>5-minute product demo</b> — Experience every module at reduced volume. Click words you miss to see vocabulary detection.</div>`:'';
  const uiLang=typeof resolveVocabUiLang==='function'?resolveVocabUiLang():'en';
  const langH=isPrac&&!isQ?`<div class="exam-lang-toolbar"><span class="exam-lang-label">${isDE?'Übersetzen:':'Translate to:'}</span>${vocabUiLangs().map(l=>`<button type="button" class="vt-lb ex-lb${uiLang===l.code?' active':''}" data-lang="${l.code}" onclick="setVocabUiLang('${l.code}',this)">${l.l}</button>`).join('')}</div>`:'';
  let secs='';
  // Quick modules run through here too: the branches below only understand the legacy
  // singular shapes (d.lesen/d.horen/…), which library-built exams do not have — they carry
  // lesenParts/horenParts/… instead. Gating this on !isQ left those exams with no renderer
  // at all and produced a silent blank body. stripExamToSkills() has already emptied the
  // parts of the modules not requested, and renderGoetheExam skips empty ones, so the quick
  // module still renders exactly one module.
  if(d.goetheFormat){
    secs=renderGoetheExam(d,isPrac,isQ);
    if(!secs.trim()&&!isExamRenderable(d)){
      backToWorkspace('exams');
      lcToast('This exam has no content. Please generate again.','error');
      return;
    }
  }else if(d.lesen&&(!isQ||S.quickMod==='reading')){
    const teil=d.lesen.teil||(isDE?'Leseverstehen':'Reading');
    const instr=d.lesen.instruction||(isDE?'Lies den Text sorgfältig und beantworte die Fragen.':'Read the text carefully and answer the questions.');
    const legacyUi=typeof examUiStrings==='function'?examUiStrings(resolveExamLang(d,S.subject)):examUiStrings('en');
    stashPassageMeta('lesen_legacy',d.lesen.text,d.lesen.translations);
    secs+=`<section class="module-wrap"><div class="module-tag tag-lesen">${esc(teil)}</div><h2 class="module-title">${isDE?'Leseverstehen':'Reading Comprehension'}</h2>${isOff?`<div class="off-instr">${esc(instr)}</div>`:`<p class="module-desc">${esc(instr)}</p>`}<div class="text-display"><h3>${esc(d.lesen.textTitle||'')}</h3><div class="readable-text">${wrapW(d.lesen.text,'lesen',isPrac)}</div>${passageToolbarHtml('lesen_legacy',isPrac,legacyUi)}</div>${(d.lesen.questions||[]).map((q,i)=>renderQ(q,i+1,'lesen',rfT,rfF,trK,isOff)).join('')}</section><hr class="section-div">`;
  }
  if(d.horen&&(!isQ||S.quickMod==='listening')){
    S.listenPlays=2;
    const isRL=!isPrac;
    const teil=d.horen.teil||(isDE?'Hörverstehen':'Listening');
    const instr=d.horen.instruction||d.horen.context;
    const legacyUi=typeof examUiStrings==='function'?examUiStrings(resolveExamLang(d,S.subject)):examUiStrings('en');
    stashPassageMeta('horen_legacy',d.horen.transcript,d.horen.translations);
    const lisH=`<div class="listen-box" id="listenBox"><div class="listen-info" id="listenInfo">${isDE?'Sie hören den Text <b>zweimal</b> (wie in der echten Prüfung).':'You can play this audio <b>2 times</b> (as in the real exam).'}</div><div class="wave" id="listenWave">${'<div class="wb paused"></div>'.repeat(9)}</div><button class="btn-sm blue" id="listenBtn" onclick="playListening()" style="margin:0 auto">${isDE?'Audio abspielen':'Play Audio'}</button><div style="font-size:11px;color:var(--text-muted);margin-top:10px;font-style:italic">${isDE?'Transkript nach beiden Wiedergaben verfügbar.':'Transcript available after both plays.'}</div></div><details class="horen-transcript-details" style="margin-bottom:14px"><summary style="font-size:12px;color:var(--text-muted);cursor:pointer;font-weight:600">${isDE?'Transkript anzeigen':'Show transcript'}</summary><div class="text-display" style="margin-top:8px"><div class="readable-text">${wrapW(d.horen.transcript,'horen',isPrac)}</div>${passageToolbarHtml('horen_legacy',isPrac,legacyUi)}</div></details>`;
    secs+=`<section class="module-wrap"><div class="module-tag tag-horen">${esc(teil)}</div><h2 class="module-title">${isDE?'Hörverstehen':'Listening'}</h2>${isOff?`<div class="off-instr">${esc(instr)}</div>`:`<p class="module-desc">${esc(d.horen.context||'')}</p>`}${lisH}${(d.horen.questions||[]).map((q,i)=>renderQ(q,i+1,'horen',rfT,rfF,trK,isOff)).join('')}</section><hr class="section-div">`;
  }
  if(d.gapfill&&(!isQ||S.quickMod==='gapfill')){
    secs+=renderGapSec(d.gapfill,isDE,isOff)+'<hr class="section-div">';
  }
  if(d.schreiben&&(!isQ||S.quickMod==='writing')){
    const teil=d.schreiben.teil||(isDE?'Schreiben':'Writing');
    const taskHtml=isOff?`<div class="write-brief"><h3>${isDE?'Aufgabe':'Task'}</h3><div class="off-instr" style="margin-bottom:0;border-left-color:var(--orange)">${esc(d.schreiben.task)}</div><div class="criteria-chips" style="margin-top:12px">${(d.schreiben.criteria||[]).map(c=>`<span class="criteria-chip">${esc(c)}</span>`).join('')}</div></div>`:`<div class="write-brief"><h3>${isDE?'Aufgabe':'Task'}</h3><p>${esc(d.schreiben.task)}</p><div class="criteria-chips">${(d.schreiben.criteria||[]).map(c=>`<span class="criteria-chip">${esc(c)}</span>`).join('')}</div></div>`;
    secs+=`<section class="module-wrap"><div class="module-tag tag-schreiben">${teil}</div><h2 class="module-title">${isDE?'Schreiben':'Writing'}</h2><p class="module-desc">${isDE?`Mindestens ${d.schreiben.minWords} Wörter.`:`Minimum ${d.schreiben.minWords} words.`}</p>${taskHtml}<textarea class="write-field" id="writeAns" placeholder="${isDE?'Schreiben Sie hier auf Deutsch...':'Write your text here in English...'}" oninput="updW()"></textarea><div class="word-meter" id="wordMeter">0 ${isDE?'Wörter':'words'} — min ${d.schreiben.minWords}</div></section><hr class="section-div">`;
  }
  if(d.sprechen&&!isQ){
    const lang=isDE?'de-DE':'en-GB';
    const teil=d.sprechen.teil||(isDE?'Sprechen':'Speaking');
    const speakFmt=isDE?`Ihre Antwort (mind. ${d.sprechen.minExchanges} Wechsel, Format <b>Ich:</b>):`:`Your response (min ${d.sprechen.minExchanges} exchanges, format <b>Me:</b>):`;
    const micHtml=typeof renderSpeakingMicHtml==='function'?renderSpeakingMicHtml('speakAns',S.subject):`<textarea class="write-field" id="speakAns" style="min-height:180px" placeholder="${isDE?'Ich:':'Me:'}" oninput="updProg()"></textarea>`;
    secs+=`<section class="module-wrap"><div class="module-tag tag-sprechen">${esc(teil)}</div><h2 class="module-title">${isDE?'Sprechen':'Speaking'}</h2><p class="module-desc">${esc(d.sprechen.situation||'')}</p><div class="speak-points">${(d.sprechen.points||[]).map(p=>`<div class="speak-point">${esc(p)}</div>`).join('')}</div><div class="starter-msg"><div class="starter-av">${isDE?'P':'E'}</div><div><div class="starter-who">${esc(d.sprechen.roleB||'')}</div><div class="starter-line">${esc(d.sprechen.starterLine||'')}</div></div></div><button class="btn-sm blue" onclick="speak(${jsLit(d.sprechen.starterLine||'')},${jsLit(lang)})" style="margin-bottom:10px">${isDE?'Anfangssatz anhören':'Hear starter line'}</button><div style="font-size:12px;color:var(--text-muted);margin-bottom:7px">${speakFmt}</div>${micHtml}</section>`;
  }
  const isDemo=!!d.demo||!!S.isDemo;
  const fromQuestionLibrary=S.examSource==='question-library';
  const fromPool=!!(d.poolSource||S.examSource==='pool'||S.examSource==='part'||S.examSource==='library');
  const isPool=fromQuestionLibrary||fromPool;
  const isPersonal=!!d.vocabPersonal;
  const bc=isDemo?'demo':isPool?'pool':isPersonal?'vocab':isQ?'quick':isPrac?'practice':'official',bl=isDemo?'Demo Exam':fromQuestionLibrary?'From library':fromPool?'From pool':isPersonal?'Personal Mock':isQ?('Quick: '+S.quickMod):isPrac?'Practice':'Official Exam';
  const titleTxt=esc(isOff?(d.official?.certificate||d.topic):(isPersonal?(d._displayTopic||('Personal · '+d.topic)):(isDE?'Deutsch':'English')+' — '+d.topic));
  const personalVerified=(d._coverageOverall?.found??d.targetUsageVerified?.length??0);
  const personalTotal=(d._coverageOverall?.total??d.vocabWords?.length)||0;
  const examLang=resolveExamLang(d,S.subject);
  const personalTopicStock=typeof PersonalTopicStock!=='undefined'
    ?PersonalTopicStock.stockForPersonalExam(d,examLang)
    :(typeof PersonalLesenTopicStock!=='undefined'?PersonalLesenTopicStock:null);
  const topicHonest=d._poolTopicRelaxed&&personalTopicStock?.topicHonestyBanner
    ?personalTopicStock.topicHonestyBanner(d,examLang):'';
  const minVisGate=d._personalVocabMinVisible??3;
  const partialWarn=(d._personalCoveragePartial||d._personalTextDecision==='serve_partial')&&typeof PersonalExamCoverage!=='undefined'&&PersonalExamCoverage.formatPersonalPartialWarning&&personalTotal
    ?PersonalExamCoverage.formatPersonalPartialWarning(d._coverageOverall||{found:personalVerified,total:personalTotal,words:d._coverageOverall?.words||[]},minVisGate,examLang)
    :'';
  const covSummary=typeof PersonalExamCoverage!=='undefined'&&PersonalExamCoverage.formatPersonalCoverageSummary&&personalTotal
    ?PersonalExamCoverage.formatPersonalCoverageSummary(d._coverageOverall||{found:personalVerified,total:personalTotal},examLang)
    :(isDE?`Dein personalisiertes Examen${personalTotal?` — ${personalVerified} von ${personalTotal} Wörtern`:''}`:`Your personalized exam${personalTotal?` — ${personalVerified} of ${personalTotal} words`:''}`);
  const personalBanner=isPersonal&&!d._hybridLoading?`<div class="card note-card personal-exam-banner${partialWarn?' personal-exam-banner--partial':''}" style="margin-bottom:16px"><b>${esc(covSummary)}</b>${partialWarn?`<span style="display:block;margin-top:8px;font-size:12px;color:var(--orange)">${esc(partialWarn)}</span>`:''}${topicHonest?`<span style="display:block;margin-top:6px;font-size:12px;color:var(--orange)">${esc(topicHonest)}</span>`:''}${personalVerified>0?`<span style="display:block;margin-top:6px;font-size:12px;color:var(--text-secondary)">${isDE?'Deine Wörter sind im Text hervorgehoben.':'Your words are highlighted in the text.'}</span>`:''}${personalVerified<personalTotal&&personalTotal>0&&!partialWarn?`<span style="display:block;margin-top:6px;font-size:12px;color:var(--text-secondary)">${isDE?'Erneut generieren, um mehr Wörter einzubauen.':'Generate again to integrate more words.'}</span>`:''}</div>`:'';
  const poolBanner=isPool?`<div style="background:var(--blue-bg);border:.5px solid rgba(93,184,232,.3);border-radius:var(--radius-lg);padding:10px 16px;margin-bottom:16px;font-size:12px;color:var(--text-secondary)">📚 Curated exam (counts toward monthly quota). Retake saved exams anytime without quota.</div>`:'';
  const bgVocabBanner=(()=>{if(!isPersonal||d._hybridLoading)return'';const parts=[...(d.lesenParts||[]),...(d.horenParts||[])];const bg=parts.filter(p=>p.bgGenerated&&p._fromPool);if(!bg.length)return'';const vocabSet=new Set((d.vocabWords||[]).map(w=>String(w).toLowerCase()));const words=[];bg.forEach(p=>(p.bgVocabLemmas||[]).forEach(w=>{if(vocabSet.has(String(w).toLowerCase())&&!words.some(x=>String(x).toLowerCase()===String(w).toLowerCase()))words.push(w);}));if(!words.length)return'';const shown=words.slice(0,3).map(w=>esc(w)).join(', ');const more=words.length>3?` (+${words.length-3} more)`:'';const lead=isDE?'✨ Automatisch aus deinem kürzlichen Vokabular generiert · auch im Pool':'✨ Auto-generated from your recent vocabulary · also in pool';const wl=isDE?`Wörter: ${shown}${more}`:`Words used: ${shown}${more}`;return`<div style="background:var(--blue-bg);border:.5px solid rgba(93,184,232,.3);border-radius:var(--radius-lg);padding:10px 16px;margin-bottom:16px;font-size:12px;color:var(--text-secondary)">${lead} — ${wl}</div>`;})();
  const saveExitH=!isQ?`<button class="btn-sm accent" onclick="saveAndExitExam()">Save &amp; exit</button>`:'';
  const submitCreditHint=typeof submitExamAiCreditHint==='function'?submitExamAiCreditHint(d):'';
  const submitLabel=submitCreditHint
    ?(isDE?`Abgeben und Ergebnisse (${submitCreditHint}) →`:`Submit and Get Results (${submitCreditHint}) →`)
    :(isDE?'Abgeben und Ergebnisse →':'Submit and Get Results →');
  const submitDisabled=d._hybridLoading?' disabled aria-disabled="true" title="'+(isDE?'Bitte warten, das Examen wird noch erstellt.':'Please wait — your exam is still being built.')+'"':'';
  scr.innerHTML=`${renderOfficialHeader(d,isDE)}${personalBanner}${partialGenH}${hybridLoadingH}${poolBanner}${bgVocabBanner}<div class="exam-topbar"><div class="exam-meta"><span class="exam-badge ${bc}">${bl}</span><span class="exam-badge">${d.level}</span><span class="exam-title">${titleTxt}</span>${timerH}</div><div class="exam-actions"><button class="btn-sm" onclick="goHome()">Home</button>${isPrac?`<button class="btn-sm purple" onclick="goFlashcards()">Deck (<span id="dkCnt">${getProfileFlashcards().length}</span>)</button>`:''}${saveExitH}<button class="btn-sm" onclick="saveCurrentExam()">Save</button></div></div><div class="progress-wrap"><div class="progress-row"><span>Progress</span><span id="pctTxt">0%</span></div><div class="progress-track"><div class="progress-fill" id="progFill" style="width:0%"></div></div></div>${demoH}${officialH}${practH}${langH}${secs}<div class="submit-bar"><button class="btn-sm" onclick="goHome()">Home</button><div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">${saveExitH}<button class="btn-sm" onclick="saveCurrentExam()">Save Exam</button><button class="btn-sm accent" id="submitBtn" onclick="submitExam()"${submitDisabled}>${submitLabel}</button></div></div>`;
  scr.querySelectorAll('input[type=radio]').forEach(r=>r.addEventListener('change',updProg));
  if(S._resumeFieldValues){restoreExamFieldValues(S._resumeFieldValues);S._resumeFieldValues=null;}
  restoreExamAnswers();
  updProg();
  if(typeof SpeakingFlow!=='undefined')SpeakingFlow.initForExam(d,S.subject);
  else if(typeof initSpeakingMicsForExam==='function')initSpeakingMicsForExam(d,S.subject);
  if(d.goetheFormat)updWGoethe();
  if(isOffMode&&!isQ){
    const resumeEnds=S._resumeTimerEndsAt;
    S._resumeTimerEndsAt=null;
    const ld=LEVELS[S.subject||'de'].find(l=>l.code===S.level)||{time:90};
    if(resumeEnds)resumeTimerFromEndsAt(resumeEnds);
    else startTimer(ld.time);
    void registerOfficialExamTimer(ld.time);
  }
  const sy=S._resumeScrollY;
  S._resumeScrollY=null;
  if(sy!=null)requestAnimationFrame(()=>window.scrollTo(0,sy));
  else window.scrollTo({top:0,behavior:'smooth'});
  bindExamScrollTop();
  if (typeof assignSavedExamIdentity === 'function') assignSavedExamIdentity(S.examData);
  else if (!S.examData._savedId && !S.examData._flightId) S.examData._flightId = Date.now();
  autosaveSession();
  if(typeof syncExamRouteUrl==='function')syncExamRouteUrl();
  if(typeof bindExamKeyboard==='function')bindExamKeyboard();
  if(typeof LcA11y!=='undefined')LcA11y.onScreenShown('examScreen');
  if(typeof refreshNotebookFab==='function')refreshNotebookFab();
}
async function playListening(){
  if(!S.examData?.horen||S.listenPlays<=0)return;
  const isDE=S.examData.lang==='de';
  const ui=typeof examUiStrings==='function'?examUiStrings(resolveExamLang(S.examData,S.subject)):examUiStrings('en');
  await playListeningPassage('legacy',ui,{
    onDone(rem){
      const btn=document.getElementById('listenBtn'),info=document.getElementById('listenInfo');
      if(rem>0){
        if(btn){btn.textContent=isDE?'▶ Erneut abspielen (1 übrig)':'▶ Play Again (1 left)';btn.disabled=false;}
        if(info)info.innerHTML=isDE?'<b>1 Wiedergabe übrig</b>':'<b>1 play remaining</b>';
      }else{
        if(btn){btn.textContent=isDE?'✓ Fertig':'✓ Done';btn.disabled=true;}
        if(info)info.innerHTML=isDE?'Audio beendet. Beantworten Sie die Fragen unten.':'Audio finished. Answer the questions below.';
        setTimeout(()=>{
          const lb=document.getElementById('listenBox');
          const tr=S.examData.horen.transcript||'';
          if(lb&&tr)lb.insertAdjacentHTML('afterend',`<details style="margin-bottom:14px"><summary style="font-size:12px;color:var(--text-muted);cursor:pointer;font-weight:600">${isDE?'Transkript anzeigen (Review)':'Show transcript (review)'}</summary><div class="text-display" style="margin-top:8px"><div class="readable-text">${esc(tr).replace(/\n/g,'<br>')}</div></div></details>`);
        },600);
      }
    },
  });
}
function gapInputEl(el){
  const gapId=el.getAttribute('data-gap-id');
  if(gapId!=null)S.gapAnswers[gapId]=el.value;
  updProg();
}
function gapQuickFill(inputId,gapId,val){
  const el=document.getElementById(inputId);
  if(el)el.value=val;
  if(gapId!=null)S.gapAnswers[gapId]=val;
  updProg();
}
function gapQuickFillFromBtn(btn){
  if(!btn)return;
  gapQuickFill(btn.getAttribute('data-input-id'),btn.getAttribute('data-gap-id'),btn.getAttribute('data-val'));
}
function renderGapSec(gf,isDE,isOff){
  const label=isOff?(gf.teil||(isDE?'Teil 3: Sprachbausteine':'Part 3: Language in Use')):(isDE?'Lückentext':'Fill in the Blanks');
  const gapLbl=isDE?'Lücke':'Gap';
  const s=(gf.sentences||[]).map((s,i)=>{
    const pts=s.text.split('[BLANK]');
    const inputId=`gap_${i}`;
    return `<div class="question-block"><div class="q-number">${gapLbl} ${i+1}</div><div style="font-size:14px;line-height:2.2;color:var(--text)">${esc(pts[0])}<input class="gap-input" id="${inputId}" data-gap-id="${esc(s.id)}" placeholder="___" oninput="gapInputEl(this)" autocomplete="off">${esc(pts[1]||'')}</div><div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:7px">${s.options.map(o=>`<button type="button" class="quick-btn" data-input-id="${esc(inputId)}" data-gap-id="${esc(s.id)}" data-val="${esc(o)}" onclick="gapQuickFillFromBtn(this)" style="font-size:11px;padding:3px 9px">${esc(o)}</button>`).join('')}</div></div>`;
  }).join('');
  const body=isOff?`<div class="off-instr">${esc(gf.instruction)}</div>`:`<p class="module-desc">${esc(gf.instruction)}</p>`;
  return `<section class="module-wrap"><div class="module-tag tag-gap">${label}</div><h2 class="module-title">${isDE?'Sprachbausteine':'Language in Use'}</h2>${body}${s}</section>`;
}
const _akr = typeof IsAnswerKeyRenderable !== 'undefined' ? IsAnswerKeyRenderable : null;
function optKey(opt) {
  if (_akr) return _akr.optKey(opt);
  if (opt && typeof opt === 'object') {
    const raw = opt.key != null ? opt.key : opt.id;
    if (raw != null) {
      const k = String(raw).trim().replace(/^\s*([a-zA-Z0-9]+)\)\s*/, '$1');
      return k.length === 1 ? k.toUpperCase() : k.toLowerCase();
    }
    return String(opt.text ?? opt.label ?? '').slice(0, 1).toUpperCase();
  }
  if (typeof opt !== 'string') return String(opt ?? '');
  if (opt.length === 1) return opt.toUpperCase();
  const m = opt.match(/^([A-Za-z0-9])\)?\s*/);
  if (m && (opt.includes(')') || opt.includes('=') || /^[A-Da-d]\)/.test(opt))) return m[1].toUpperCase();
  return opt;
}
function optLabel(opt){
  if(typeof opt==='string')return opt;
  if(opt&&typeof opt==='object'){
    const k=opt.key!=null?String(opt.key).trim().replace(/^\s*([a-zA-Z0-9]+)\)\s*/,'$1'):'';
    const t=String(opt.text??opt.label??opt.option??'').trim();
    if(k&&t)return `${k}) ${t}`;
    return t||k||'';
  }
  return String(opt??'');
}
function normalizeGradingToken(val) {
  if (_akr) return _akr.normalizeGradingToken(val);
  if (val == null || val === '') return '';
  const s = String(val).trim();
  const u = s.toLowerCase();
  if (u === 'ja' || u === 'j' || u === 'yes') return 'J';
  if (u === 'nein' || u === 'n' || u === 'no') return 'N';
  if (u === 'richtig' || u === 'r' || u === 'true' || u === 't') return 'R';
  if (u === 'falsch' || u === 'f' || u === 'false') return 'F';
  return s.toLowerCase();
}
function getRenderableAnswerKeys(q, part) {
  if (_akr) return _akr.getRenderableAnswerKeys(q, part);
  const type = String(q?.type || q?.questionType || '').toLowerCase();
  if (type === 'yn' || type === 'ja_nein') return ['J', 'N'];
  if (type === 'rfn' || type === 'r_f_n') return ['R', 'F', 'N'];
  if (type === 'rf' || type === 'tf' || type === 'richtig_falsch' || type === 'true_false') return ['R', 'F'];
  const opts = q.options || [];
  if (!opts.length) return [];
  return opts.map((o) => optKey(o)).filter(Boolean);
}
function isAnswerKeyRenderable(q, part) {
  if (_akr) return _akr.isAnswerKeyRenderable(q, part);
  const correct = q?.correct ?? q?.correctAnswer;
  if (correct == null || correct === '') return false;
  const keys = getRenderableAnswerKeys(q, part);
  if (!keys.length) {
    const type = String(q?.type || '').toLowerCase();
    return ['yn', 'ja_nein', 'rfn', 'r_f_n', 'rf', 'tf', 'richtig_falsch', 'true_false'].includes(type);
  }
  const ck = normalizeGradingToken(correct);
  return keys.some((k) => normalizeGradingToken(k) === ck);
}
function isStrictGradingEnabled() {
  return typeof window !== 'undefined' && window.LEXICOIL_STRICT_GRADING === true;
}
function registerInvalidGradingItem(d, meta, q) {
  if (!d) return;
  d._invalidItems = d._invalidItems || [];
  const entry = {
    module: meta?.module || 'unknown',
    teil: meta?.teil,
    id: q?.id,
    correct: q?.correct ?? q?.correctAnswer,
  };
  const dup = d._invalidItems.some(
    (x) => x.module === entry.module && Number(x.teil) === Number(entry.teil) && String(x.id) === String(entry.id),
  );
  if (!dup) d._invalidItems.push(entry);
}
function collectInvalidGradingItems(d) {
  d._invalidItems = [];
  forEachGoetheQ(d, (mod, q, meta) => {
    if (!isAnswerKeyRenderable(q, meta?.part)) registerInvalidGradingItem(d, meta, q);
  });
  return d._invalidItems;
}
function goetheAnswersMatch(user,correct){
  if(correct==null)return false;
  if(Array.isArray(correct)){
    if(correct.length===1)return normalizeGradingToken(user)===normalizeGradingToken(correct[0]);
    let u=[];
    try{u=typeof user==='string'&&user.startsWith('[')?JSON.parse(user):[];}catch(_){u=[];}
    if(!Array.isArray(u)||!u.length)u=String(user||'').split('|').map(s=>s.trim()).filter(Boolean);
    const cs=[...correct].map(String).sort();
    const us=[...u].map(String).sort();
    return cs.length===us.length&&cs.every((v,i)=>v===us[i]);
  }
  return normalizeGradingToken(user)===normalizeGradingToken(correct);
}
function togglePersonMatch(key,val,el){
  let sel=[];
  try{sel=JSON.parse(S.answers[key]||'[]');}catch(_){sel=[];}
  if(el.checked){if(!sel.includes(val))sel.push(val);}else sel=sel.filter(x=>x!==val);
  S.answers[key]=JSON.stringify(sel.sort());
  el.closest('.opt')?.classList.toggle('selected',el.checked);
  updProg();
}
function renderGapFillQ(q,num,mod,part,isDE){
  const opts=part.options||[];
  const head=isDE?`Lücke ${q.gap||num}`:`Gap ${q.gap||num}`;
  const ak=mod+'_'+q.id;
  // Open cloze (Cambridge Reading P6): the candidate writes one word, there is no option
  // pool. Rendering the usual <select> here produced a dropdown whose only entry was the
  // "— select —" placeholder, so the gap simply could not be answered.
  if(!opts.length){
    const saved=esc(S.answers?.[ak]||'');
    return `<div class="question-block"><div class="q-number">${head}</div><div class="q-text">${isDE?'Schreiben Sie EIN Wort:':'Write ONE word:'}</div><input type="text" class="gap-input" autocomplete="off" spellcheck="false" value="${saved}" oninput='S.answers[${jsLit(ak)}]=this.value.trim();updProg()'>${adminQuestionReviewHtml(q,part)}</div>`;
  }
  return `<div class="question-block"><div class="q-number">${head}</div><div class="q-text">${isDE?'Wählen Sie die passende Option:':'Choose the matching option:'}</div><select class="gap-select" onchange='S.answers[${jsLit(ak)}]=this.value;updProg()'><option value="">${isDE?'— wählen —':'— select —'}</option>${opts.map(o=>`<option value="${esc(o.key)}"${(S.answers?.[ak]===o.key)?' selected':''}>${esc(o.key)}) ${esc(o.text)}</option>`).join('')}</select>${adminQuestionReviewHtml(q,part)}</div>`;
}
function renderQ(q,num,mod,rfT,rfF,trK,isOff,part){
  const ak=`${mod}_${q.id}`;
  const head=`${num}. ${esc(q.question)}`;
  const sub='';
  const review=adminQuestionReviewHtml(q,part);
  if(q.type==='yn'||q.type==='ja_nein'){
    return `<div class="question-block"><div class="q-number">${head}</div>${sub}<div class="rf-row"><button type="button" class="rf-btn" onclick='setRF(${jsLit(ak)},${jsLit('J')},this,${jsLit('sel-r')})'>Ja</button><button type="button" class="rf-btn" onclick='setRF(${jsLit(ak)},${jsLit('N')},this,${jsLit('sel-f')})'>Nein</button></div>${review}</div>`;
  }
  if(q.type==='rfn'||q.type==='r_f_n'){
    return `<div class="question-block"><div class="q-number">${head}</div>${sub}<div class="rf-row" style="flex-wrap:wrap"><button type="button" class="rf-btn" onclick='setRFN(${jsLit(ak)},${jsLit('R')},this)'>R</button><button type="button" class="rf-btn" onclick='setRFN(${jsLit(ak)},${jsLit('F')},this)'>F</button><button type="button" class="rf-btn" onclick='setRFN(${jsLit(ak)},${jsLit('N')},this)'>N</button></div>${review}</div>`;
  }
  if(q.type==='rf'||q.type==='tf'||q.type==='richtig_falsch'||q.type==='true_false'){
    return `<div class="question-block"><div class="q-number">${head}</div>${sub}<div class="rf-row"><button type="button" class="rf-btn" onclick='setRF(${jsLit(ak)},${jsLit(trK)},this,${jsLit('sel-r')})'>${esc(rfT)}</button><button type="button" class="rf-btn" onclick='setRF(${jsLit(ak)},${jsLit('F')},this,${jsLit('sel-f')})'>${esc(rfF)}</button></div>${review}</div>`;
  }
  if(q.type==='person_multi'){
    let sel=[];
    try{sel=JSON.parse(S.answers[ak]||'[]');}catch(_){sel=[];}
    const multi=Array.isArray(q.correct)&&q.correct.length>1;
    return `<div class="question-block"><div class="q-number">${head}</div>${sub}<div class="options">${(q.options||[]).map(opt=>{
      const val=String(opt);
      if(multi){
        const on=sel.includes(val);
        return `<label class="opt${on?' selected':''}"><input type="checkbox"${on?' checked':''} onchange='togglePersonMatch(${jsLit(ak)},${jsLit(val)},this)'><span>${esc(opt)}</span></label>`;
      }
      return `<label class="opt"><input type="radio" name="${esc(ak)}" value="${esc(val)}" onchange='S.answers[${jsLit(ak)}]=this.value;this.closest(".options").querySelectorAll(".opt").forEach(o=>o.classList.remove("selected"));this.closest(".opt").classList.add("selected");updProg()'><span>${esc(opt)}</span></label>`;
    }).join('')}</div>${review}</div>`;
  }
  if(q.type==='matching'){
    const opts=q.options||[];
    if(q._keyOnlyMatch){
      const keys=opts.map(o=>typeof o==='string'?o.trim():optKey(o));
      if(keys.length){
        return `<div class="question-block"><div class="q-number">${head}</div>${sub}<div class="options options-matching-keys">${keys.map(val=>`<label class="opt opt-key"><input type="radio" name="${esc(ak)}" value="${esc(val)}" onchange='S.answers[${jsLit(ak)}]=this.value;this.closest(".options").querySelectorAll(".opt").forEach(o=>o.classList.remove("selected"));this.closest(".opt").classList.add("selected");updProg()'><span>${esc(val)}</span></label>`).join('')}</div>${review}</div>`;
      }
    }
  }
  const opts=q.options||[];
  if(!opts.length){
    // Sentence completion (Cambridge Listening Part 3) is gap_fill with an empty option
    // pool: the candidate types the missing word. renderGoetheHorenPart sends every
    // question straight here, so these six items used to end in the dead "no options"
    // line and could not be answered at all. The Lesen renderer already routes gap_fill
    // to renderGapFillQ, but that one drops q.question, and here the sentence IS the item.
    if(q.type==='gap_fill'){
      const saved=esc(S.answers?.[ak]||'');
      return `<div class="question-block"><div class="q-number">${head}</div>${sub}<input type="text" class="gap-input" autocomplete="off" spellcheck="false" value="${saved}" oninput='S.answers[${jsLit(ak)}]=this.value.trim();updProg()'>${review}</div>`;
    }
    // isOff means "official exam", not "German" — every caller below passes a hardcoded
    // true, so an English exam printed the German string. Key off the exam language.
    const noOpts=S.examData?.lang==='de'?'Keine Optionen':'No options';
    return `<div class="question-block"><div class="q-number">${head}</div>${sub}<div style="color:var(--text-muted);font-size:12px">${noOpts}</div>${review}</div>`;
  }
  return `<div class="question-block"><div class="q-number">${head}</div>${sub}<div class="options">${opts.map(opt=>{const val=optKey(opt);const label=optLabel(opt);return `<label class="opt"><input type="radio" name="${esc(ak)}" value="${esc(val)}" onchange='S.answers[${jsLit(ak)}]=this.value;this.closest(".options").querySelectorAll(".opt").forEach(o=>o.classList.remove("selected"));this.closest(".opt").classList.add("selected");updProg()'><span>${esc(label)}</span></label>`;}).join('')}</div>${review}</div>`;
}
function ptSetMatch(k,v,btn){S.answers[k]=v;btn.closest('.pt-match-pills').querySelectorAll('.pt-letter-pill').forEach(b=>b.classList.remove('selected'));btn.classList.add('selected');updProg();}
function setRF(k,v,btn,cls){S.answers[k]=v;btn.parentElement.querySelectorAll('.rf-btn').forEach(b=>b.classList.remove('sel-r','sel-f','sel-n'));btn.classList.add(cls);updProg();}
function setRFN(k,v,btn){S.answers[k]=v;btn.parentElement.querySelectorAll('.rf-btn').forEach(b=>b.classList.remove('sel-r','sel-f','sel-n'));if(v==='R')btn.classList.add('sel-r');else if(v==='F')btn.classList.add('sel-f');else btn.classList.add('sel-n');updProg();}
function updProg(){
  if(!S.examData)return;const d=S.examData;let total=0,done=0;
  if(d.goetheFormat){
    forEachGoetheQ(d,(mod,q)=>{total++;if(S.answers[mod+'_'+q.id])done++;});
    forEachGoetheNotes(d,(mod,f)=>{total++;if(document.getElementById('note_'+f.id)?.value.trim())done++;});
    d.schreibenParts?.forEach(p=>{
      total++;
      if(p.formFields){if(p.formFields.some((_,i)=>document.getElementById(p.fieldId+'_'+i)?.value.trim()))done++;}
      else if(document.getElementById(p.fieldId)?.value.trim())done++;
    });
    d.sprechenParts?.forEach(p=>{total++;if(document.getElementById(p.fieldId)?.value.trim())done++;});
  }else{
  if(d.lesen){total+=d.lesen.questions.length;done+=d.lesen.questions.filter(q=>S.answers['lesen_'+q.id]).length;}
  if(d.horen){total+=d.horen.questions.length;done+=d.horen.questions.filter(q=>S.answers['horen_'+q.id]).length;}
  if(d.gapfill){total+=d.gapfill.sentences.length;done+=d.gapfill.sentences.filter(s=>S.gapAnswers[s.id]?.trim()).length;}
  if(d.schreiben){total+=1;if(document.getElementById('writeAns')?.value.trim())done+=1;}
  if(d.sprechen){total+=1;if(document.getElementById('speakAns')?.value.trim())done+=1;}
  }
  const pct=total?Math.min(100,Math.round(done/total*100)):0;
  const f=document.getElementById('progFill'),l=document.getElementById('pctTxt');
  if(f)f.style.width=pct+'%';if(l)l.textContent=pct+'%';
  scheduleExamAutosave();
}
function updW(){
  const ta=document.getElementById('writeAns');if(!ta)return;
  const w=ta.value.trim().split(/\s+/).filter(x=>x).length,min=S.examData?.schreiben?.minWords||80;
  const el=document.getElementById('wordMeter');
  if(el){el.textContent=`${w} words — min ${min}`;el.className='word-meter'+(w>=min?' ok':'');}
  updProg();
}

window.ptSetMatch = ptSetMatch;
window.flushExamAutosave = flushExamAutosave;
window.scheduleExamAutosave = scheduleExamAutosave;
window.writeGuestExamProgress = writeGuestExamProgress;
