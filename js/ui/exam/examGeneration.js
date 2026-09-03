// ═══════════════════════════════════════════
// EXAM GENERATION
// ═══════════════════════════════════════════
function seenPoolIds(subject, level) {
  return (S.history || [])
    .filter((h) => h.lang === subject && h.level === level && h.poolId)
    .map((h) => h.poolId);
}
function normalizeCambridgeExam(d){
  if(!d||(!d.readingParts&&!d.listeningParts))return d;
  d.cambridgeFormat=true;
  d.lang=d.lang||'en';
  d.goetheFormat=true;
  if(!d.official){
    d.official={board:'Cambridge Assessment English',certificate:'B1 Preliminary (PET)',note:'Practice exam (AI-generated). Task types based on official Cambridge B1 Preliminary format.'};
  }
  if(!d.modules){
    d.modules={
      lesen:{title:'Reading',time:'45 minutes (Reading and Writing combined)'},
      horen:{title:'Listening',time:'approx. 30 minutes'},
      schreiben:{title:'Writing',time:'45 minutes (Reading and Writing combined)'},
      sprechen:{title:'Speaking',time:'12 minutes'}
    };
  }
  d.lesenParts=(d.readingParts||[]).map(p=>{
    const part={teil:p.part,arbeitszeit:p.time||'',instruction:p.instruction};
    if(p.items){
      part.items=p.items.map(it=>({id:it.id,signText:it.text,question:it.question,options:it.options,correct:it.correct}));
    }
    if(p.text){part.textTitle=p.textTitle;part.text=p.text;}
    if(p.speakers){
      part.textTitle=p.textTitle;
      part.text=p.speakers.map(s=>s.name+': '+s.text).join('\n\n');
    }
    if(p.options&&p.answers){
      part.ads=(p.options||[]).map(o=>({key:o.key,title:o.title,text:o.text}));
      part.questions=Object.entries(p.answers).map(([id,correct])=>{
        const person=(p.people||[]).find(x=>x.id===id);
        return{id,type:'match',question:person?.description||id,options:[...(p.options||[]).map(o=>o.key),'0'],correct};
      });
    }
    if(p.questions&&!part.questions)part.questions=p.questions;
    return part;
  });
  d.horenParts=(d.listeningParts||[]).map(p=>{
    const part={teil:p.part,plays:p.plays||2,instruction:p.instruction,context:p.context};
    if(p.segments){
      part.segments=p.segments.map((seg,si)=>({
        id:seg.id,
        label:seg.label||('Recording '+(si+1)),
        transcript:seg.transcript,
        question:seg.question,
        options:seg.options,
        correct:seg.correct
      }));
    }else if(p.notes){
      part.transcript=p.transcript;
      part.notesTitle=p.notes.title;
      part.noteFields=(p.notes.fields||[]).map(f=>({id:f.id,label:f.label,answer:f.answer}));
    }else{
      part.transcript=p.transcript;
      part.questions=p.questions;
    }
    return part;
  });
  d.schreibenParts=(d.writingParts||[]).map((p,i)=>{
    let task=p.instruction||'';
    if(p.promptEmail)task+='\n\n'+p.promptEmail;
    return{aufgabe:p.part||i+1,arbeitszeit:p.time||'',fieldId:p.fieldId||('write'+(i+1)),task,minWords:p.minWords,criteria:p.criteria,modelAnswer:p.modelAnswer||p.modelAnswerArticle,feedback:p.feedback};
  });
  d.sprechenParts=(d.speakingParts||[]).map((p,i)=>({
    teil:p.part||i+1,title:p.title,dauer:p.duration,fieldId:p.fieldId||('speak'+(i+1)),
    situation:p.situation,points:p.points||p.examinerQuestions,photoDescriptions:p.photoDescriptions,
    minExchanges:p.minExchanges,modelAnswer:p.modelAnswer,feedback:p.feedback
  }));
  return d;
}
function inferQuestionCorrect(q) {
  if (!q || typeof q !== 'object') return;
  if (q.correct != null && q.correct !== '') return;
  const pick = (...vals) => {
    for (const v of vals) {
      if (v != null && v !== '') return v;
    }
    return null;
  };
  const alias = pick(
    q.answer,
    q.solution,
    q.correctAnswer,
    q.expectedAnswer,
    q.rightAnswer,
    q.expected,
    q.key,
  );
  if (alias != null) q.correct = alias;
  if ((q.correct == null || q.correct === '') && Array.isArray(q.options)) {
    const flagged = q.options.filter(
      (o) => o && typeof o === 'object' && (o.correct === true || o.isCorrect === true),
    );
    if (flagged.length === 1) {
      const o = flagged[0];
      q.correct = o.key != null ? o.key : o.id != null ? o.id : o.label;
    }
  }
}
function coerceMcqOptions(q) {
  inferQuestionCorrect(q);
  if (!q || !Array.isArray(q.options) || !q.options.length) return;
  const type = String(q.type || 'multiple').toLowerCase();
  if (['rf', 'tf', 'richtig_falsch', 'true_false', 'yn', 'ja_nein', 'rfn', 'r_f_n', 'gap_fill', 'gap', 'matching', 'match', 'person_match', 'person_multi'].includes(type)) return;

  const ADS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const normalized = q.options.map((o, i) => {
    const fallbackKey = ADS[i] || String(i + 1);
    if (typeof o === 'string') {
      const m = o.match(/^([A-Za-z0-9]+)\)\s*(.*)$/s);
      if (m) return { key: m[1].toUpperCase(), text: (m[2] || '').trim() };
      return { key: fallbackKey, text: o.trim() };
    }
    if (o && typeof o === 'object') {
      const rawKey = o.key != null ? o.key : o.id;
      const key = rawKey != null
        ? String(rawKey).trim().replace(/^\s*([a-zA-Z0-9]+)\)\s*/, '$1').toUpperCase()
        : fallbackKey;
      const text = String(o.text ?? o.label ?? o.option ?? '').trim();
      return { ...o, key, text: text || key };
    }
    return { key: fallbackKey, text: String(o ?? '').trim() };
  });
  q.options = normalized;

  if (q.correct == null || q.correct === '') {
    const flagged = normalized.filter((o) => o && (o.correct === true || o.isCorrect === true));
    if (flagged.length === 1 && flagged[0].key) {
      q.correct = flagged[0].key;
      return;
    }
    return;
  }
  let corr = Array.isArray(q.correct) ? q.correct[0] : q.correct;
  const corrStr = String(corr ?? '').trim();
  if (!corrStr) return;
  const corrKey = corrStr.replace(/^\s*([a-zA-Z0-9]+)\)\s*/, '$1').toUpperCase();
  const keys = normalized.map((o) => o.key);
  if (keys.includes(corrKey)) {
    q.correct = corrKey;
    return;
  }
  if (/^\d+$/.test(corrStr)) {
    const n = Number(corrStr);
    const pick = n >= 1 && n <= normalized.length ? normalized[n - 1] : normalized[n];
    if (pick?.key) {
      q.correct = pick.key;
      return;
    }
  }
  const lc = corrStr.toLowerCase();
  const byText = normalized.find((o) => {
    const t = String(o.text || '').toLowerCase();
    return t === lc || (t && (t.includes(lc) || lc.includes(t)));
  });
  if (byText?.key) {
    q.correct = byText.key;
    return;
  }
  if (corrStr.length === 1 && keys.includes(corrStr.toUpperCase())) {
    q.correct = corrStr.toUpperCase();
  }
}
function parseOptionKeyFromEntry(o, i) {
  const ADS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (typeof o === 'string') {
    const m = o.match(/^([A-Za-z0-9]+)\)\s*(.*)$/s);
    if (m) return m[1].toUpperCase();
    const trimmed = o.trim().toUpperCase();
    if (/^[A-JM0]$/.test(trimmed)) return trimmed;
    return (ADS[i] || String(i + 1)).toUpperCase();
  }
  if (o && typeof o === 'object') {
    const rawKey = String(o.key ?? o.id ?? '').trim();
    if (/^[A-JM0]$/i.test(rawKey)) return rawKey.toUpperCase();
    const km = rawKey.match(/^([A-Za-z0-9]+)\)/);
    if (km && /^[A-JM0]$/i.test(km[1])) return km[1].toUpperCase();
    const text = String(o.text ?? o.label ?? '').trim();
    const tm = text.match(/^([A-Za-z0-9]+)\)/);
    if (tm && /^[A-JM0]$/i.test(tm[1])) return tm[1].toUpperCase();
    return (ADS[i] || String(i + 1)).toUpperCase();
  }
  return (ADS[i] || String(i + 1)).toUpperCase();
}
function ensureMatchingOptions(q, part) {
  const ADS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (part?.ads?.length) {
    q.options = part.ads.map((a, i) => ({
      key: ADS[i] || String(i + 1),
      text: String(a.title || a.text || a.key || `Anzeige ${ADS[i] || i + 1}`).trim(),
    }));
    if (!q.options.some((o) => o.key === '0')) {
      q.options.push({ key: '0', text: '0 – keine passende Anzeige' });
    }
    q._keyOnlyMatch = true;
  } else if (Array.isArray(q.options) && q.options.length) {
    const seen = new Set();
    q.options = q.options
      .map((o, i) => {
        if (typeof o === 'string') {
          const m = o.match(/^([A-Za-z0-9]+)\)\s*(.*)$/s);
          if (m) {
            return { key: m[1].toUpperCase(), text: m[2].trim() || m[1].toUpperCase() };
          }
          const trimmed = o.trim().toUpperCase();
          if (/^[A-JM0]$/.test(trimmed)) {
            return { key: trimmed, text: trimmed };
          }
          return { key: parseOptionKeyFromEntry(o, i), text: o.trim() };
        }
        if (o && typeof o === 'object') {
          const key = parseOptionKeyFromEntry(o, i);
          return { key, text: String(o.text ?? o.label ?? '').trim() || key };
        }
        return { key: ADS[i] || String(i + 1), text: String(o ?? '').trim() };
      })
      .filter((o) => {
        if (seen.has(o.key)) return false;
        seen.add(o.key);
        return true;
      });
  }
  if (q.correct != null && q.correct !== '') {
    const c = String(q.correct).trim();
    const m = c.match(/^([A-Za-z0-9]+)/);
    q.correct = m ? m[1].toUpperCase() : c.toUpperCase();
  }
  const t = String(q.type || '').toLowerCase();
  if (t === 'yn' || t === 'ja_nein' || t === 'rf' || t === 'tf' || t === 'richtig_falsch') return;
  if (part?.ads?.length || isKeyOnlyOptionList(q.options)) {
    q.type = 'matching';
    q._keyOnlyMatch = !!part?.ads?.length || isKeyOnlyOptionList(q.options);
  }
}
function normalizeGoetheQuestion(q,part,seg){
  inferQuestionCorrect(q);
  normalizeQuestionTypeField(q,part,seg);
  const rawType=String(q.type||'').toLowerCase();
  if(rawType==='matching'||rawType==='match'){
    ensureMatchingOptions(q,part);
    return;
  }
  if((!q.type||q.type==='multiple'||q.type==='multiple_choice')&&!(Array.isArray(q.options)&&q.options.length)){
    const c=String(q.correct??'').trim();
    if(/^(R|F|Richtig|Falsch|True|False|W|T)$/i.test(c))q.type='rf';
    else if(/^(J|N|Ja|Nein|Yes|No|Y)$/i.test(c))q.type='yn';
    else if(/^[A-J0]$/i.test(c)&&part?.ads?.length)q.type='matching';
    else if(part?.text||part?.textTitle)q.type='rf';
  }
  if(q.type==='matching'||q.type==='match'){
    ensureMatchingOptions(q,part);
    return;
  }
  coerceMcqOptions(q);
  if(q.type==='richtig_falsch'||q.type==='true_false'||q.type==='rf'||q.type==='tf'){q.type='rf';if(q.correct==='Richtig'||q.correct==='True')q.correct='R';else if(q.correct==='Falsch'||q.correct==='False')q.correct='F';}
  if(q.type==='ja_nein'||q.type==='yn'){q.type='yn';if(q.correct==='Ja')q.correct='J';else if(q.correct==='Nein')q.correct='N';}
  if((q.type==='rf'||q.type==='yn')&&(q.correct==null||q.correct===''))inferQuestionCorrect(q);
  if(q.type==='r_f_n')q.type='rfn';
  if(q.type==='person_match_abcd')q.type='abcd';
  if(q.type==='person_match')q.type='person_multi';
  if(q.type==='multiple_choice')q.type='multiple';
}
function questionTypeAnswerable(q, part){
  const t=String(q?.type||'multiple').toLowerCase();
  if(['rf','tf','richtig_falsch','true_false','yn','ja_nein','rfn','r_f_n','gap_fill'].includes(t)){
    return q.correct!=null&&q.correct!=='';
  }
  if(t==='person_multi'||t==='abcd'||t==='matching'||t==='match'){
    if(part?.ads?.length>=2){
      const c=String(Array.isArray(q.correct)?q.correct[0]:q.correct??'').trim().toUpperCase();
      return c==='0'||/^[A-J]$/.test(c);
    }
    return Array.isArray(q.options)&&q.options.length>0;
  }
  return Array.isArray(q.options)&&q.options.length>0;
}
function examHasUnanswerableQuestions(exam){
  if(!exam||typeof exam!=='object')return false;
  let bad=false;
  const checkQ=(q,part)=>{if(q&&!questionTypeAnswerable(q,part))bad=true;};
  (exam.lesenParts||[]).forEach(p=>{
    if(typeof lesenPartMissingAds==='function'&&lesenPartMissingAds(p))bad=true;
    (p.questions||[]).forEach(q=>checkQ(q,p));
    (p.items||[]).forEach(it=>{if(it.question||it.correct!=null||it.signText)checkQ(it,p);});
    (p.segments||[]).forEach(s=>(s.questions||[]).forEach(q=>checkQ(q,p)));
  });
  (exam.horenParts||[]).forEach(p=>{
    (p.questions||[]).forEach(checkQ);
    (p.segments||[]).forEach(s=>(s.questions||[]).forEach(checkQ));
  });
  return bad;
}
/** Drop or fix AI items that cannot be rendered; prefer a usable partial exam over hard failure. */
/** Normalize valid dual-passage Teil 2; reject ghost passageIds via personalPartIsUsable. */
function normalizeLesenT2Part(part){
  if(typeof LesenPassageIntegrity!=='undefined'&&LesenPassageIntegrity.normalizeLesenT2FromPassages){
    return LesenPassageIntegrity.normalizeLesenT2FromPassages(part);
  }
  return part;
}
function lesenT2PartIsValid(part){
  if(typeof LesenPassageIntegrity!=='undefined'&&LesenPassageIntegrity.lesenT2PartIsValid){
    normalizeLesenT2Part(part);
    return LesenPassageIntegrity.lesenT2PartIsValid(part);
  }
  return true;
}
function lesenTeil3IsUsable(part){
  if(!part||Number(part.teil)!==3)return false;
  if(typeof isLesenAdsMatchingPart==='function'&&!isLesenAdsMatchingPart(part))return false;
  const ads=(part.ads||[]).filter(a=>String(a.text||a.title||'').trim());
  if(ads.length<10)return false;
  const items=(part.items||[]).filter(it=>it.signText||it.question);
  return items.length>=3;
}
function lesenTeilIsUsable(exam,teil,blueprint){
  const part=(exam?.lesenParts||[]).find(p=>Number(p.teil)===Number(teil));
  if(!part)return false;
  if(!personalPartIsUsable(part,'lesen',blueprint))return false;
  const PF=getPoolFallbackHelpers();
  if(PF?.partMeetsItemCount&&!PF.partMeetsItemCount(part,'lesen',Number(teil),blueprint||null))return false;
  if(Number(teil)===2)return lesenT2PartIsValid(part);
  if(Number(teil)===3)return lesenTeil3IsUsable(part);
  if(Number(teil)===4)return lesenTeil4IsUsable(exam);
  return true;
}
function repairPersonalExamAnswerability(exam){
  if(!exam||typeof exam!=='object')return exam;
  if(typeof normalizeExam==='function')exam=normalizeExam(exam)||exam;
  const keepQ=(q,part)=>{
    if(!q)return false;
    normalizeGoetheQuestion(q,part);
    return questionTypeAnswerable(q,part);
  };
  (exam.lesenParts||[]).forEach(part=>{
    normalizeLesenT2Part(part);
    coalesceLesenForumOpinions(part);
    coalesceLesenAdsMatching(part,exam.lang);
    coalesceLesenPartQuestions(part);
    part.questions=(part.questions||[]).filter(q=>keepQ(q,part));
    part.items=(part.items||[]).filter(it=>{
      if(!it.question&&!it.statement&&it.correct==null&&!it.signText)return false;
      return keepQ(it,part);
    });
    if(typeof lesenPartMissingAds==='function'&&lesenPartMissingAds(part)){
      part.items=(part.items||[]).filter(it=>{
        const t=String(it.type||'').toLowerCase();
        return t!=='matching'&&t!=='match';
      });
    }
  });
  (exam.horenParts||[]).forEach(part=>{
    coalesceHorenPartSegments(part);
    (part.segments||[]).forEach(seg=>{
      seg.questions=(seg.questions||[]).filter(q=>{
        normalizeHorenQuestionFields(q);
        normalizeGoetheQuestion(q,part);
        return typeof horenQuestionHasSubstance==='function'?horenQuestionHasSubstance(q):questionTypeAnswerable(q);
      });
    });
    part.questions=(part.questions||[]).filter(q=>keepQ(q,part));
  });
  return exam;
}
/** Drop whole Teile that remain unusable after repair (partial generation tolerance). */
function personalPartIsUsable(part,mod,blueprint){
  if(!part||!goethePartHasContent(part,mod))return false;
  if(mod==='lesen'&&Number(part.teil)===2&&!lesenT2PartIsValid(part))return false;
  if(mod==='lesen'&&Number(part.teil)===3&&!lesenTeil3IsUsable(part))return false;
  const PF=getPoolFallbackHelpers();
  if(PF?.partMeetsItemCount&&!PF.partMeetsItemCount(part,mod,Number(part.teil),blueprint||null))return false;
  const shell={
    lang:'de',level:'B1',goetheFormat:true,
    lesenParts:[],horenParts:[],schreibenParts:[],sprechenParts:[]
  };
  const key=mod+'Parts';
  shell[key]=[JSON.parse(JSON.stringify(part))];
  repairPersonalExamAnswerability(shell);
  if(examHasUnanswerableQuestions(shell))return false;
  return goethePartHasContent(shell[key][0],mod);
}
function canonicalTeilLabel(teil){
  if(teil==null||!Number.isFinite(Number(teil)))return null;
  return `Teil ${Number(teil)}`;
}
function parseChunkLabel(lbl){
  const s=String(lbl||'');
  let mod='lesen';
  if(/hör|horen|listening/i.test(s))mod='horen';
  else if(/schreiben|writing/i.test(s))mod='schreiben';
  else if(/sprechen|speaking/i.test(s))mod='sprechen';
  else if(/reading|lesen/i.test(s))mod='lesen';
  const m=s.match(/Teil\s*(\d+)/i);
  const teil=m?Number(m[1]):null;
  return{mod,teil,canonical:canonicalTeilLabel(teil)};
}
function reconcileChunkMetaWithExam(exam){
  if(!exam)return;
  const present=new Set();
  const mark=(mod,t)=>{if(t!=null&&Number.isFinite(Number(t)))present.add(`${mod}:${Number(t)}`);};
  (exam.lesenParts||[]).forEach(p=>mark('lesen',p.teil));
  (exam.schreibenParts||[]).forEach(p=>mark('schreiben',p.teil??p.aufgabe));
  (exam.readingParts||[]).forEach(p=>mark('reading',p.teil));
  (exam.listeningParts||[]).forEach(p=>mark('listening',p.teil));
  const succeededSet=new Set();
  const failedSet=new Set();
  const notePresent=(mod,arr)=>{
    (arr||[]).forEach(p=>{
      const lbl=canonicalTeilLabel(p?.teil);
      if(lbl&&present.has(`${mod}:${Number(p.teil)}`))succeededSet.add(lbl);
    });
  };
  notePresent('lesen',exam.lesenParts);
  notePresent('horen',exam.horenParts);
  notePresent('schreiben',exam.schreibenParts);
  notePresent('reading',exam.readingParts);
  notePresent('listening',exam.listeningParts);
  for(const pr of exam._prunedTeile||[]){
    const{canonical}=parseChunkLabel(pr);
    if(canonical)failedSet.add(canonical);
    else failedSet.add(String(pr));
  }
  if(exam._chunkMeta){
    for(const lbl of exam._chunkMeta.succeeded||[]){
      const{mod,teil,canonical}=parseChunkLabel(lbl);
      if(!canonical)continue;
      if(teil!=null&&present.has(`${mod}:${teil}`))succeededSet.add(canonical);
      else failedSet.add(canonical);
    }
    for(const lbl of exam._chunkMeta.failed||[]){
      const{mod,teil,canonical}=parseChunkLabel(lbl);
      if(!canonical)continue;
      if(teil==null||!present.has(`${mod}:${teil}`))failedSet.add(canonical);
    }
  }
  for(const s of succeededSet)failedSet.delete(s);
  const sortTeil=(a,b)=>{
    const na=Number(String(a).replace(/\D/g,''))||0;
    const nb=Number(String(b).replace(/\D/g,''))||0;
    return na-nb;
  };
  const succeeded=[...succeededSet].sort(sortTeil);
  const failed=[...failedSet].sort(sortTeil);
  exam._succeededTeile=succeeded;
  exam._failedTeile=failed;
  exam._chunkMeta={
    total:exam._chunkMeta?.total??Math.max(succeeded.length+failed.length,succeeded.length),
    succeeded,
    failed,
  };
  if(failed.length)exam._partialGen=true;
}
function pruneBrokenExamParts(exam,skills){
  if(!exam||typeof exam!=='object')return exam;
  const mods=orderedPersonalSkills(skills||exam.vocabSkills||['lesen']);
  const removed=[];
  for(const mod of mods){
    const key=mod+'Parts';
    if(!Array.isArray(exam[key]))continue;
    exam[key]=exam[key].filter(p=>{
      const ok=personalPartIsUsable(p,mod);
      if(!ok){
        if(p?.teil!=null)removed.push(`Teil ${p.teil}`);
        else removed.push(mod);
      }
      return ok;
    });
    if(exam[key]?.length===0)delete exam[key];
  }
  if(removed.length)exam._prunedTeile=[...new Set(removed)];
  return exam;
}
window.pruneBrokenExamParts=pruneBrokenExamParts;
window.repairPersonalExamAnswerability=repairPersonalExamAnswerability;
window.examHasUnanswerableQuestions=examHasUnanswerableQuestions;
window.horenQuestionHasSubstance=horenQuestionHasSubstance;
function horenTeil1IsUsable(part){
  if(!part||Number(part.teil)!==1)return false;
  const PF=typeof PersonalLesenPoolFallback!=='undefined'?PersonalLesenPoolFallback:null;
  const countItems=PF?.countHorenPartItems||countHorenPartItemsLocal;
  if(countItems(part)!==10)return false;
  const segs=part.segments||[];
  if(segs.length!==5)return false;
  return segs.every(s=>(s.questions||[]).length===2&&String(s.transcript||'').trim());
}
function countHorenPartItemsLocal(part){
  if(!part)return 0;
  let n=0;
  for(const seg of part.segments||[])n+=(seg.questions||[]).length;
  n+=(part.questions||[]).length;
  return n;
}
function horenTeil4IsUsable(part){
  if(!part||Number(part.teil)!==4)return false;
  const PF=typeof PersonalLesenPoolFallback!=='undefined'?PersonalLesenPoolFallback:null;
  const countItems=PF?.countHorenPartItems||countHorenPartItemsLocal;
  if(countItems(part)!==8)return false;
  if(PF?.horenTeil4SpeakerCoherent&&!PF.horenTeil4SpeakerCoherent(part))return false;
  return true;
}
function horenTeilIsUsable(exam,teil,blueprint){
  const part=(exam?.horenParts||[]).find(p=>Number(p.teil)===Number(teil));
  if(!part)return false;
  if(!personalPartIsUsable(part,'horen',blueprint))return false;
  const PF=getPoolFallbackHelpers();
  if(PF?.partMeetsItemCount&&!PF.partMeetsItemCount(part,'horen',Number(teil),blueprint||null))return false;
  if(Number(teil)===1&&!horenTeil1IsUsable(part))return false;
  if(Number(teil)===4&&!horenTeil4IsUsable(part))return false;
  return true;
}
function horenTeilPresentAndValid(exam,teil,blueprint){
  const part=(exam?.horenParts||[]).find(p=>Number(p.teil)===Number(teil));
  if(!part||!goethePartHasContent(part,'horen'))return false;
  const shell={lang:'de',level:'B1',goetheFormat:true,horenParts:[JSON.parse(JSON.stringify(part))]};
  repairPersonalExamAnswerability(shell);
  const fixed=shell.horenParts[0];
  if(!goethePartHasContent(fixed,'horen'))return false;
  if(!horenTeilIsUsable({horenParts:[fixed]},teil,blueprint))return false;
  if(examHasUnanswerableQuestions(shell))return false;
  return true;
}
function lesenTeil4IsUsable(exam){
  const t4=(exam?.lesenParts||[]).find(p=>Number(p.teil)===4);
  return!!(t4&&personalPartIsUsable(t4,'lesen'));
}
async function retryMissingModulePartBeforePrune(exam,module,teil,configWords,configSkills,opts){
  if(!exam||opts?.source!=='ai')return exam;
  const mod=String(module||'lesen').toLowerCase();
  const teilN=Number(teil);
  if(!Number.isFinite(teilN))return exam;
  const PF=getPoolFallbackHelpers();
  // Only skip the AI retry for Teile the pool actually served; a pool-first Teil
  // the pool missed is generated like any other and deserves the retry.
  if(poolServedTeilsFor(exam,mod).includes(teilN))return exam;
  const skills=orderedPersonalSkills(configSkills||exam?.vocabSkills||[]);
  const skillOk=skills.includes(mod)||(mod==='horen'&&skills.includes('listening'));
  if(!skillOk)return exam;
  const partsKey=mod+'Parts';
  const teilUsable=mod==='horen'
    ?horenTeilIsUsable(exam,teilN,opts?.blueprint)
    :mod==='schreiben'
      ?schreibenTeilPresentAndValid(exam,teilN,opts?.blueprint)
      :lesenTeilIsUsable(exam,teilN,opts?.blueprint);
  if(teilUsable)return exam;
  if(typeof LexiCoilEngine==='undefined'||typeof LexiCoilEngine.generatePersonalExam!=='function')return exam;
  try{
    const el=document.getElementById('loaderSub');
    const modLabel=mod==='horen'?'Hören':mod==='schreiben'?'Schreiben':'Lesen';
    if(el)el.textContent=`Retrying ${modLabel} Teil ${teilN}…`;
    let bp=opts?.blueprint||null;
    if(!bp&&typeof ExamBlueprint!=='undefined'){
      try{bp=await ExamBlueprint.load(S.subject,S.level);}catch(_){}
    }
    const hooks=getGeneratorHooks((msg)=>{if(el&&msg)el.textContent=msg;});
    const regen=await LexiCoilEngine.generatePersonalExam(
      S.subject,S.level,configWords,[mod],hooks,
      {teilFilter:teilN,blueprint:bp,genTicket:exam._genTicket||S._activeGenTicket}
    );
    const topic=exam.topic||regen.topic||'Personal vocabulary review';
    const fresh=(regen[partsKey]||[]).find(p=>Number(p.teil)===teilN);
    const freshOk=mod==='horen'
      ?fresh&&horenTeilIsUsable({horenParts:[fresh]},teilN,bp)
      :mod==='schreiben'
        ?fresh&&schreibenTeilPresentAndValid({schreibenParts:[fresh]},teilN,bp)
        :fresh&&lesenTeilIsUsable({lesenParts:[fresh]},teilN,bp);
    if(!freshOk){
      lcDebug.warn('[personal]',modLabel,'Teil',teilN,'retry did not produce a usable part');
      return exam;
    }
    if(typeof ExamRenumber!=='undefined'&&ExamRenumber.mergeTeilPart){
      ExamRenumber.mergeTeilPart(exam,{[partsKey]:[fresh]},mod,teilN,opts?.blueprint||null);
      exam.vocabSkills=exam.vocabSkills||configSkills;
      if(typeof normalizeExam==='function'){
        return normalizeExam(exam,{skipPostprocess:!!exam._skipAnswerBalance})||exam;
      }
      return exam;
    }
    const merged=mergeExamParts(exam,regen,topic);
    merged.vocabSkills=exam.vocabSkills||configSkills;
    if(typeof normalizeExam==='function'){
      return normalizeExam(merged,{skipPostprocess:!!merged._skipAnswerBalance})||merged;
    }
    return merged;
  }catch(err){
    lcDebug.warn('[personal]',mod,'Teil',teilN,'pre-prune retry failed:',err);
    return exam;
  }
}
async function retryMissingLesenPartBeforePrune(exam,teil,configWords,configSkills,opts){
  return retryMissingModulePartBeforePrune(exam,'lesen',teil,configWords,configSkills,opts);
}
async function retryMissingPartsBeforePrune(exam,configWords,configSkills,opts){
  let out=exam;
  const PF=getPoolFallbackHelpers();
  const skills=orderedPersonalSkills(configSkills||exam?.vocabSkills||[]);
  if(skills.includes('lesen')){
    for(const teil of PF?.lesenBlueprintTeils(opts?.blueprint)||[1,2,3,4,5]){
      out=await retryMissingModulePartBeforePrune(out,'lesen',teil,configWords,configSkills,opts);
    }
  }
  if(skills.includes('horen')||skills.includes('listening')){
    for(const teil of PF?.horenBlueprintTeils(opts?.blueprint)||[1,2,3,4]){
      out=await retryMissingModulePartBeforePrune(out,'horen',teil,configWords,configSkills,opts);
    }
  }
  if(skills.includes('schreiben')){
    for(const teil of PF?.schreibenBlueprintTeils?.(opts?.blueprint)||[1,2,3]){
      out=await retryMissingModulePartBeforePrune(out,'schreiben',teil,configWords,configSkills,opts);
    }
  }
  return out;
}
async function retryMissingLesenPartsBeforePrune(exam,configWords,configSkills,opts){
  return retryMissingPartsBeforePrune(exam,configWords,configSkills,opts);
}
async function retryMissingLesenTeil4BeforePrune(exam,configWords,configSkills,opts){
  return retryMissingModulePartBeforePrune(exam,'lesen',4,configWords,configSkills,opts);
}
function lesenTeilPresentAndValid(exam,teil,blueprint){
  const part=(exam?.lesenParts||[]).find(p=>Number(p.teil)===Number(teil));
  if(!part||!goethePartHasContent(part,'lesen'))return false;
  const shell={lang:'de',level:'B1',goetheFormat:true,lesenParts:[JSON.parse(JSON.stringify(part))]};
  repairPersonalExamAnswerability(shell);
  const fixed=shell.lesenParts[0];
  if(!goethePartHasContent(fixed,'lesen'))return false;
  if(!lesenTeilIsUsable({lesenParts:[fixed]},teil,blueprint))return false;
  if(examHasUnanswerableQuestions(shell))return false;
  return true;
}
function getPoolFallbackHelpers(){
  if(typeof PersonalLesenPoolFallback!=='undefined')return PersonalLesenPoolFallback;
  try{return require('../engine/personalLesenPoolFallback.js');}catch(_){return null;}
}

// Mapa de helpers por módulo (los que ya exporta personalLesenPoolFallback).
function _modulePoolHelpers(PF, module) {
  const m = String(module).toLowerCase();
  if (m === 'lesen' || m === 'reading') return {
    key: 'lesenParts',
    teils: PF.lesenBlueprintTeils, toPart: PF.reusablePartToLesenPart,
    insert: PF.insertLesenTeil, valid: (e, t, b) => lesenTeilPresentAndValid(e, t, b),
  };
  if (m === 'horen' || m === 'listening') return {
    key: 'horenParts',
    teils: PF.horenBlueprintTeils, toPart: PF.reusablePartToHorenPart,
    insert: PF.insertHorenTeil, valid: (e, t, b) => horenTeilPresentAndValid(e, t, b),
  };
  if (m === 'schreiben' || m === 'writing') return {
    key: 'schreibenParts',
    teils: PF.schreibenBlueprintTeils, toPart: PF.reusablePartToSchreibenPart,
    insert: PF.insertSchreibenTeil, valid: (e, t, b) => schreibenTeilPresentAndValid(e, t, b),
  };
  if (m === 'sprechen' || m === 'speaking') return {
    key: 'sprechenParts',
    teils: PF.sprechenBlueprintTeils, toPart: PF.reusablePartToSprechenPart,
    insert: PF.insertSprechenTeil, valid: (e, t, b) => sprechenTeilPresentAndValid(e, t, b),
  };
  return null;
}

function _recordSeenPart(lang, level, module, partId) {
  if (!partId) return;
  if (!Array.isArray(S.history)) S.history = [];
  S.history.push({ lang, level, partId, partModule: module, date: Date.now(), source: 'part' });
  try { if (typeof saveProfile === 'function') saveProfile(); } catch (_) {}
}

/** Collect partIds from a full exam (official, pool, or personal multi-part). */
function _extractPartIdsFromExam(exam) {
  if (!exam || typeof exam !== 'object') return [];
  const lang = exam.lang || S.subject;
  const level = exam.level || S.level;
  const slots = [
    ['lesen', 'lesenParts'],
    ['horen', 'horenParts'],
    ['schreiben', 'schreibenParts'],
    ['sprechen', 'sprechenParts'],
  ];
  const out = [];
  for (const [mod, key] of slots) {
    for (const p of exam[key] || []) {
      if (!p || typeof p !== 'object') continue;
      const partId = p.partId || p._partId || p._contentProvenance?.partId || null;
      if (partId) out.push({ lang, level, module: mod, partId: String(partId) });
    }
  }
  const meta = exam._meta?.partIds;
  if (meta && typeof meta === 'object') {
    for (const [k, pid] of Object.entries(meta)) {
      if (!pid) continue;
      const mod = String(k).replace(/Parts?$/i, '').toLowerCase();
      if (['lesen', 'horen', 'schreiben', 'sprechen'].includes(mod)) {
        out.push({ lang, level, module: mod, partId: String(pid) });
      }
    }
  }
  return out;
}

/** Register all parts from a started full exam — unified with personal seenPartIds. */
function _recordSeenPartsFromExam(exam) {
  const parts = _extractPartIdsFromExam(exam);
  if (!parts.length) return;
  if (!Array.isArray(S.history)) S.history = [];
  const seen = new Set(
    S.history
      .filter((h) => h.partId && h.partModule)
      .map((h) => `${h.lang}|${h.level}|${h.partModule}|${h.partId}`),
  );
  for (const row of parts) {
    if (!row.partId || !row.module) continue;
    const key = `${row.lang}|${row.level}|${row.module}|${row.partId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    S.history.push({
      lang: row.lang,
      level: row.level,
      partId: row.partId,
      partModule: row.module,
      date: Date.now(),
      source: 'exam',
    });
  }
  try { if (typeof saveProfile === 'function') saveProfile(); } catch (_) {}
}

/**
 * Ensambla un módulo completo desde el pool (Phase B: planificador ≥3 palabras).
 * Cuota personal solo tras ensamblado verificado (commitPersonalPoolQuota).
 */
async function assembleModuleFromPool(module, words, lang, level, opts = {}) {
  const { topicTag = null } = opts;
  const PF = getPoolFallbackHelpers();
  const minVisible =
    typeof PersonalPoolVocabGate !== 'undefined'
      ? PersonalPoolVocabGate.PERSONAL_VOCAB_MIN_VISIBLE
      : 3;
  if (!PF || typeof fetchExamModulePlan !== 'function' || typeof fetchExamPartById !== 'function') {
    return null;
  }
  const H = _modulePoolHelpers(PF, module);
  if (!H) return null;

  let blueprint = null;
  try { blueprint = await ExamBlueprint.load(lang, level); } catch (_) {}
  const teils = (H.teils ? H.teils(blueprint) : null) || [];
  if (!teils.length) return null;

  const requested = (words || []).map((w) => String(w).toLowerCase()).filter(Boolean);
  const poolRequestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `pool-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  let plan;
  try {
    plan = await fetchExamModulePlan(lang, level, module, {
      words: requested,
      topicTag,
      excludeIds: seenPartIds(lang, level, module),
    });
  } catch (e) {
    if (e.code === 'personal_pool_quota_exceeded' || e.code === 'login_required' || e.code === 'rate_limited') {
      throw e;
    }
    plan = { ok: false, reason: 'plan_failed' };
  }

  const logPlan = {
    event: 'personal_module_vocab_plan',
    ok: plan?.ok,
    reason: plan?.reason,
    coveredCount: plan?.coveredCount,
    requestedTopic: topicTag,
    words: requested,
    module,
    lang,
    level,
    topicPass: plan?.topicPass,
    missingTeile: plan?.missingTeile,
    relaxedTeile: plan?.relaxedTeile,
  };
  if (typeof lcDebug !== 'undefined' && lcDebug.log) lcDebug.log('[personal]', logPlan);
  else console.log('[personal]', logPlan);

  if (!plan?.ok || !plan.picks?.length) {
    let emptyReason = plan?.reason || 'topic_empty';
    if (emptyReason === 'vocab_insufficient_coverage' || (plan?.coveredCount != null && plan.coveredCount < minVisible)) {
      emptyReason = 'vocab_insufficient_coverage';
    }
    return {
      exam: null,
      emptyReason,
      coverage: plan?.coveredCount != null ? { covered: plan.coveredCount, requested: requested.length } : null,
      coveredWords: plan?.coveredWords || [],
      missingTeile: plan?.missingTeile || teils,
      relaxedTeile: plan?.relaxedTeile || [],
      topicTag,
      planTelemetry: logPlan,
    };
  }

  if (plan.textVerified && plan.decision === 'reject') {
    return {
      exam: null,
      emptyReason: 'vocab_insufficient_coverage',
      coverage: {
        covered: plan.textCoveredCount ?? 0,
        requested: requested.length,
      },
      coveredWords: plan.textCoveredWords || [],
      missingTeile: plan.missingTeile || teils,
      relaxedTeile: plan.relaxedTeile || [],
      topicTag,
      planTelemetry: { ...logPlan, decision: 'reject', textCoveredCount: plan.textCoveredCount },
    };
  }

  const exam = {
    lang,
    level,
    goetheFormat: true,
    vocabPersonal: true,
    poolSource: true,
    [H.key]: [],
  };
  if (topicTag) {
    exam.topic = topicTag;
    exam.topicTag = topicTag;
  }

  const coveredLemmas = new Set((plan.coveredWords || []).map((w) => String(w).toLowerCase()));
  const missingTeile = [...(plan.missingTeile || [])];
  const relaxedTeile = [...(plan.relaxedTeile || [])];

  for (const pick of plan.picks) {
    if (!pick?.id) continue;
    const data = await fetchExamPartById(lang, level, module, pick.id);
    if (!data?.part) {
      missingTeile.push(pick.teil);
      continue;
    }

    const servedTopic = resolveCanonicalB1Topic(pick.topicTag || data.part.topicTag) || null;
    let part = H.toPart(data.part, blueprint);
    if (!part) {
      missingTeile.push(pick.teil);
      continue;
    }
    part._poolTopicTag = servedTopic;
    part._topicRelaxed = !!pick.topicRelaxed;
    part._partId = data.id || pick.id;
    const shell = { lang, level, goetheFormat: true, vocabPersonal: true, [H.key]: [part] };
    if (typeof repairPersonalExamAnswerability === 'function') repairPersonalExamAnswerability(shell);
    part = shell[H.key][0];
    if (!H.valid({ [H.key]: [part] }, pick.teil, blueprint)) {
      missingTeile.push(pick.teil);
      continue;
    }

    H.insert(exam, part, pick.teil);
    for (const w of pick.covered || []) coveredLemmas.add(String(w).toLowerCase());

    if (typeof ExamRenumber !== 'undefined' && ExamRenumber.renumberExam) {
      ExamRenumber.renumberExam(exam, blueprint || null);
    }
  }

  if (!(exam[H.key] || []).length) {
    return {
      exam: null,
      emptyReason: 'vocab_insufficient_coverage',
      coverage: { covered: coveredLemmas.size, requested: requested.length },
      coveredWords: [...coveredLemmas],
      missingTeile,
      relaxedTeile,
      topicTag,
      planTelemetry: logPlan,
    };
  }

  applyPersonalTargetUsage(exam, words);

  const serverTextCount = plan.textVerified ? (plan.textCoveredCount ?? 0) : null;
  const serverDecision = plan.textVerified ? plan.decision : null;
  const verified = lcVocabCoverage(exam, words);
  const textFound = serverTextCount != null ? serverTextCount : verified.found;
  const decision =
    serverDecision ||
    (textFound <= 0 ? 'reject' : textFound >= minVisible ? 'serve_now' : 'serve_partial');

  if (decision === 'reject' || textFound < 1) {
    return {
      exam: null,
      emptyReason: 'vocab_insufficient_coverage',
      coverage: { covered: textFound, requested: verified.total },
      coveredWords: plan.textCoveredWords || exam.targetUsageVerified || [],
      missingTeile,
      relaxedTeile,
      topicTag,
      planTelemetry: { ...logPlan, verifyFound: textFound, minVisible, decision },
    };
  }

  exam._personalTextDecision = decision;
  exam._personalTextVerifiedCount = textFound;
  exam._personalVocabMinVisible = minVisible;
  if (decision === 'serve_partial') exam._personalCoveragePartial = true;

  const poolMod = String(module).toLowerCase();
  if (
    (poolMod === 'lesen' || poolMod === 'horen') &&
    typeof commitPersonalPoolQuota === 'function'
  ) {
    try {
      await commitPersonalPoolQuota(poolMod, poolRequestId);
    } catch (err) {
      if (err?.code === 'personal_pool_quota_exceeded') throw err;
      lcDebug.warn('[personal] pool quota commit failed:', err);
    }
  }

  for (const pick of plan.picks) {
    if (pick?.id) _recordSeenPart(lang, level, module, pick.id);
  }

  return {
    exam,
    coverage: { covered: verified.found, requested: verified.total },
    coveredWords: exam.targetUsageVerified || [...coveredLemmas],
    missingTeile: [...new Set(missingTeile)],
    relaxedTeile,
    topicTag,
    planTelemetry: logPlan,
  };
}

const _MODULE_PART_KEY={
  lesen:'lesenParts',horen:'horenParts',
  schreiben:'schreibenParts',sprechen:'sprechenParts',
  reading:'lesenParts',listening:'horenParts',
  writing:'schreibenParts',speaking:'sprechenParts'
};

async function fillMissingLesenTeileFromPool(exam,lang,level,blueprint,configSkills){
  if(!orderedPersonalSkills(configSkills||exam?.vocabSkills||[]).includes('lesen'))return exam;
  const PF=getPoolFallbackHelpers();
  if(!PF||typeof fetchExamPart!=='function')return exam;
  const teils=PF.lesenBlueprintTeils(blueprint);
  exam._teilFromPool=Array.isArray(exam._teilFromPool)?[...exam._teilFromPool]:[];
  exam._genReport=exam._genReport&&typeof exam._genReport==='object'?exam._genReport:{};
  exam._genReport.poolFallback=Array.isArray(exam._genReport.poolFallback)?exam._genReport.poolFallback:[];
  exam._genReport.aiTeile=Array.isArray(exam._genReport.aiTeile)?exam._genReport.aiTeile:[];
  for(const teil of teils){
    if(lesenTeilPresentAndValid(exam,teil,blueprint)){
      if(!exam._teilFromPool.includes(teil)&&!(exam.lesenParts||[]).some(p=>Number(p.teil)===teil&&p._fromPool)){
        exam._genReport.aiTeile.push(teil);
      }
      continue;
    }
    const exclude=seenPartIds(lang,level,'lesen');
    let poolPart=null;
    try{
      poolPart=await fetchExamPart(lang,level,'lesen',exclude,teil);
    }catch(err){
      lcDebug.warn('[personal] pool fetch failed T'+teil,err);
    }
    if(!poolPart){
      lcDebug.warn('[personal] no pool part for lesen T'+teil);
      continue;
    }
    let lesenPart=PF.reusablePartToLesenPart(poolPart);
    if(!lesenPart)continue;
    const shell={lang,level,goetheFormat:true,vocabPersonal:true,lesenParts:[lesenPart]};
    repairPersonalExamAnswerability(shell);
    lesenPart=shell.lesenParts[0];
    if(!lesenTeilPresentAndValid({lesenParts:[lesenPart]},teil,blueprint)){
      lcDebug.warn('[personal] pool part rejected for lesen T'+teil);
      continue;
    }
    PF.insertLesenTeil(exam,lesenPart,teil);
    if(!exam._teilFromPool.includes(teil))exam._teilFromPool.push(teil);
    exam._genReport.poolFallback.push({module:'lesen',teil,partId:poolPart.id||null});
    lcDebug.log('[personal] lesen T'+teil+' served from pool',poolPart.id||'');
    if(typeof ExamRenumber!=='undefined'&&ExamRenumber.renumberExam){
      ExamRenumber.renumberExam(exam,blueprint||null);
    }
  }
  exam._teilFromPool=[...new Set(exam._teilFromPool.map(Number))].sort((a,b)=>a-b);
  return exam;
}
async function fillMissingHorenTeileFromPool(exam,lang,level,blueprint,configSkills){
  const skills=orderedPersonalSkills(configSkills||exam?.vocabSkills||[]);
  if(!skills.includes('horen')&&!skills.includes('listening'))return exam;
  const PF=getPoolFallbackHelpers();
  if(!PF||typeof fetchExamPart!=='function')return exam;
  const teils=PF.horenBlueprintTeils(blueprint);
  exam._teilFromPool=Array.isArray(exam._teilFromPool)?[...exam._teilFromPool]:[];
  exam._genReport=exam._genReport&&typeof exam._genReport==='object'?exam._genReport:{};
  exam._genReport.poolFallback=Array.isArray(exam._genReport.poolFallback)?exam._genReport.poolFallback:[];
  exam._genReport.aiTeile=Array.isArray(exam._genReport.aiTeile)?exam._genReport.aiTeile:[];
  for(const teil of teils){
    if(horenTeilPresentAndValid(exam,teil,blueprint)){
      if(!exam._teilFromPool.includes(teil)&&!(exam.horenParts||[]).some(p=>Number(p.teil)===teil&&p._fromPool)){
        exam._genReport.aiTeile.push(teil);
      }
      continue;
    }
    const exclude=seenPartIds(lang,level,'horen');
    let poolPart=null;
    try{
      poolPart=await fetchExamPart(lang,level,'horen',exclude,teil);
    }catch(err){
      lcDebug.warn('[personal] pool fetch failed horen T'+teil,err);
    }
    if(!poolPart){
      lcDebug.warn('[personal] no pool part for horen T'+teil);
      continue;
    }
    let horenPart=PF.reusablePartToHorenPart(poolPart,blueprint);
    if(!horenPart)continue;
    const shell={lang,level,goetheFormat:true,vocabPersonal:true,horenParts:[horenPart]};
    repairPersonalExamAnswerability(shell);
    horenPart=shell.horenParts[0];
    if(!horenTeilPresentAndValid({horenParts:[horenPart]},teil,blueprint)){
      lcDebug.warn('[personal] pool part rejected for horen T'+teil);
      continue;
    }
    if(typeof ExamRenumber!=='undefined'&&ExamRenumber.mergeTeilPart){
      ExamRenumber.mergeTeilPart(exam,{horenParts:[horenPart]},'horen',teil,blueprint||null);
    }else{
      PF.insertHorenTeil(exam,horenPart,teil);
    }
    if(!exam._teilFromPool.includes(teil))exam._teilFromPool.push(teil);
    exam._genReport.poolFallback.push({module:'horen',teil,partId:poolPart.id||null});
    lcDebug.log('[personal] horen T'+teil+' served from pool',poolPart.id||'');
    if(typeof ExamRenumber!=='undefined'&&ExamRenumber.renumberExam){
      ExamRenumber.renumberExam(exam,blueprint||null);
    }
  }
  exam._teilFromPool=[...new Set(exam._teilFromPool.map(Number))].sort((a,b)=>a-b);
  return exam;
}
function schreibenTeilPresentAndValid(exam,teil,blueprint){
  const part=(exam?.schreibenParts||[]).find(p=>Number(p.teil??p.aufgabe)===Number(teil));
  if(!part)return false;
  const PF=getPoolFallbackHelpers();
  if(PF?.schreibenTeilIsValid)return PF.schreibenTeilIsValid(part,teil,blueprint);
  const task=String(part.task||part.instruction||'').trim();
  return task.length>=40&&Number(part.minWords)>0;
}
function sprechenTeilPresentAndValid(exam,teil,blueprint){
  const part=(exam?.sprechenParts||[]).find(p=>Number(p.teil)===Number(teil));
  if(!part)return false;
  const PF=getPoolFallbackHelpers();
  if(PF?.sprechenTeilIsValid)return PF.sprechenTeilIsValid(part,teil,blueprint);
  const situation=String(part.situation||part.task||part.instruction||part.prompt||'').trim();
  return situation.length>=40;
}
async function fillMissingSchreibenTeileFromPool(exam,lang,level,blueprint,configSkills){
  if(!orderedPersonalSkills(configSkills||exam?.vocabSkills||[]).includes('schreiben'))return exam;
  const PF=getPoolFallbackHelpers();
  if(!PF||typeof fetchExamPart!=='function')return exam;
  const teils=PF.schreibenBlueprintTeils?.(blueprint)||[1,2,3];
  exam._teilFromPool=Array.isArray(exam._teilFromPool)?[...exam._teilFromPool]:[];
  exam._genReport=exam._genReport&&typeof exam._genReport==='object'?exam._genReport:{};
  exam._genReport.poolFallback=Array.isArray(exam._genReport.poolFallback)?exam._genReport.poolFallback:[];
  exam._genReport.aiTeile=Array.isArray(exam._genReport.aiTeile)?exam._genReport.aiTeile:[];
  for(const teil of teils){
    if(schreibenTeilPresentAndValid(exam,teil,blueprint)){
      if(!exam._teilFromPool.includes(teil)&&!(exam.schreibenParts||[]).some(p=>Number(p.teil??p.aufgabe)===teil&&p._fromPool)){
        exam._genReport.aiTeile.push(teil);
      }
      continue;
    }
    let poolPart=null;
    try{
      poolPart=await fetchExamPart(lang,level,'schreiben',seenPartIds(lang,level,'schreiben'),teil);
    }catch(err){
      lcDebug.warn('[personal] pool fetch failed schreiben T'+teil,err);
    }
    if(!poolPart){
      lcDebug.warn('[personal] no pool part for schreiben T'+teil);
      continue;
    }
    const schPart=PF.reusablePartToSchreibenPart?.(poolPart,blueprint);
    if(!schPart||!schreibenTeilPresentAndValid({schreibenParts:[schPart]},teil,blueprint)){
      lcDebug.warn('[personal] pool part rejected for schreiben T'+teil);
      continue;
    }
    PF.insertSchreibenTeil(exam,schPart,teil);
    if(!exam._teilFromPool.includes(teil))exam._teilFromPool.push(teil);
    exam._genReport.poolFallback.push({module:'schreiben',teil,partId:poolPart.id||null});
    lcDebug.log('[personal] schreiben T'+teil+' served from pool',poolPart.id||'');
  }
  exam._teilFromPool=[...new Set(exam._teilFromPool.map(Number))].sort((a,b)=>a-b);
  return exam;
}
async function fillMissingSprechenTeileFromPool(exam,lang,level,blueprint,configSkills){
  if(!orderedPersonalSkills(configSkills||exam?.vocabSkills||[]).includes('sprechen'))return exam;
  const PF=getPoolFallbackHelpers();
  if(!PF||typeof fetchExamPart!=='function')return exam;
  const teils=PF.sprechenBlueprintTeils?.(blueprint)||[1,2,3];
  exam._teilFromPool=Array.isArray(exam._teilFromPool)?[...exam._teilFromPool]:[];
  exam._genReport=exam._genReport&&typeof exam._genReport==='object'?exam._genReport:{};
  exam._genReport.poolFallback=Array.isArray(exam._genReport.poolFallback)?exam._genReport.poolFallback:[];
  exam._genReport.aiTeile=Array.isArray(exam._genReport.aiTeile)?exam._genReport.aiTeile:[];
  for(const teil of teils){
    if(sprechenTeilPresentAndValid(exam,teil,blueprint)){
      if(!exam._teilFromPool.includes(teil)&&!(exam.sprechenParts||[]).some(p=>Number(p.teil)===teil&&p._fromPool)){
        exam._genReport.aiTeile.push(teil);
      }
      continue;
    }
    let poolPart=null;
    try{
      poolPart=await fetchExamPart(lang,level,'sprechen',seenPartIds(lang,level,'sprechen'),teil);
    }catch(err){
      lcDebug.warn('[personal] pool fetch failed sprechen T'+teil,err);
    }
    if(!poolPart){
      lcDebug.warn('[personal] no pool part for sprechen T'+teil);
      continue;
    }
    const spPart=PF.reusablePartToSprechenPart?.(poolPart,blueprint);
    if(!spPart||!sprechenTeilPresentAndValid({sprechenParts:[spPart]},teil,blueprint)){
      lcDebug.warn('[personal] pool part rejected for sprechen T'+teil);
      continue;
    }
    PF.insertSprechenTeil(exam,spPart,teil);
    if(!exam._teilFromPool.includes(teil))exam._teilFromPool.push(teil);
    exam._genReport.poolFallback.push({module:'sprechen',teil,partId:poolPart.id||null});
    lcDebug.log('[personal] sprechen T'+teil+' served from pool',poolPart.id||'');
  }
  exam._teilFromPool=[...new Set(exam._teilFromPool.map(Number))].sort((a,b)=>a-b);
  return exam;
}
async function fillMissingModuleTeileFromPool(exam,lang,level,blueprint,configSkills){
  exam=await fillMissingLesenTeileFromPool(exam,lang,level,blueprint,configSkills);
  exam=await fillMissingHorenTeileFromPool(exam,lang,level,blueprint,configSkills);
  exam=await fillMissingSchreibenTeileFromPool(exam,lang,level,blueprint,configSkills);
  exam=await fillMissingSprechenTeileFromPool(exam,lang,level,blueprint,configSkills);
  return exam;
}
/** Teile the pool actually served for `module`, read back from the generation report. */
function poolServedTeilsFor(exam,module){
  const mod=String(module||'').toLowerCase()==='horen'||String(module||'').toLowerCase()==='listening'?'horen':'lesen';
  const entries=exam?._genReport?.poolFallback;
  if(!Array.isArray(entries))return[];
  return[...new Set(entries
    .filter(e=>String(e?.module||'').toLowerCase()===mod)
    .map(e=>Number(e?.teil))
    .filter(Number.isFinite))];
}
/** Shape filterPersonalAiChunks expects: which Teile are already covered by the pool. */
function poolServedTeilsSpec(exam){
  return{horen:poolServedTeilsFor(exam,'horen'),lesen:poolServedTeilsFor(exam,'lesen')};
}
async function preloadHorenPoolFirstTeils(exam,lang,level,blueprint){
  const PF=getPoolFallbackHelpers();
  if(!PF||typeof fetchExamPart!=='function')return exam;
  const poolTeils=PF.horenPoolFirstTeils?PF.horenPoolFirstTeils(lang):(PF.HOREN_POOL_FIRST_TEILS||[1,4]);
  let out=exam||{lang,level,goetheFormat:true,horenParts:[]};
  out._teilFromPool=Array.isArray(out._teilFromPool)?[...out._teilFromPool]:[];
  out._genReport=out._genReport&&typeof out._genReport==='object'?out._genReport:{};
  out._genReport.poolFallback=Array.isArray(out._genReport.poolFallback)?out._genReport.poolFallback:[];
  for(const teil of poolTeils){
    if(horenTeilPresentAndValid(out,teil,blueprint))continue;
    let poolPart=null;
    try{
      poolPart=await fetchExamPart(lang,level,'horen',seenPartIds(lang,level,'horen'),teil);
    }catch(err){
      lcDebug.warn('[personal] horen pool preload T'+teil+' failed:',err);
    }
    if(!poolPart){
      lcDebug.warn('[personal] no pool part for horen T'+teil+' (preload)');
      continue;
    }
    let horenPart=PF.reusablePartToHorenPart(poolPart,blueprint);
    if(!horenPart)continue;
    const shell={lang,level,goetheFormat:true,vocabPersonal:true,horenParts:[horenPart]};
    repairPersonalExamAnswerability(shell);
    horenPart=shell.horenParts[0];
    if(!horenTeilPresentAndValid({horenParts:[horenPart]},teil,blueprint)){
      lcDebug.warn('[personal] pool preload rejected horen T'+teil);
      continue;
    }
    if(typeof ExamRenumber!=='undefined'&&ExamRenumber.mergeTeilPart){
      ExamRenumber.mergeTeilPart(out,{horenParts:[horenPart]},'horen',teil,blueprint||null);
    }else{
      PF.insertHorenTeil(out,horenPart,teil);
    }
    if(!out._teilFromPool.includes(teil))out._teilFromPool.push(teil);
    out._genReport.poolFallback.push({module:'horen',teil,partId:poolPart.id||null,preload:true});
    lcDebug.log('[personal] horen T'+teil+' preloaded from pool',poolPart.id||'');
  }
  out._teilFromPool=[...new Set(out._teilFromPool.map(Number))].sort((a,b)=>a-b);
  return out;
}
async function preloadLesenPoolFirstTeils(exam,lang,level,blueprint){
  const PF=getPoolFallbackHelpers();
  if(!PF||typeof fetchExamPart!=='function')return exam;
  const poolTeils=PF.lesenPoolFirstTeils?PF.lesenPoolFirstTeils(lang):(PF.LESEN_POOL_FIRST_TEILS||[2]);
  let out=exam||{lang,level,goetheFormat:true,lesenParts:[]};
  out._teilFromPool=Array.isArray(out._teilFromPool)?[...out._teilFromPool]:[];
  out._genReport=out._genReport&&typeof out._genReport==='object'?out._genReport:{};
  out._genReport.poolFallback=Array.isArray(out._genReport.poolFallback)?out._genReport.poolFallback:[];
  for(const teil of poolTeils){
    if(lesenTeilPresentAndValid(out,teil,blueprint))continue;
    let poolPart=null;
    try{
      poolPart=await fetchExamPart(lang,level,'lesen',seenPartIds(lang,level,'lesen'),teil);
    }catch(err){
      lcDebug.warn('[personal] lesen pool preload T'+teil+' failed:',err);
    }
    if(!poolPart){
      lcDebug.warn('[personal] no pool part for lesen T'+teil+' (preload)');
      continue;
    }
    let lesenPart=PF.reusablePartToLesenPart(poolPart);
    if(!lesenPart)continue;
    const shell={lang,level,goetheFormat:true,vocabPersonal:true,lesenParts:[lesenPart]};
    repairPersonalExamAnswerability(shell);
    lesenPart=shell.lesenParts[0];
    if(!lesenTeilPresentAndValid({lesenParts:[lesenPart]},teil,blueprint)){
      lcDebug.warn('[personal] pool preload rejected lesen T'+teil);
      continue;
    }
    if(typeof ExamRenumber!=='undefined'&&ExamRenumber.mergeTeilPart){
      ExamRenumber.mergeTeilPart(out,{lesenParts:[lesenPart]},'lesen',teil,blueprint||null);
    }else{
      PF.insertLesenTeil(out,lesenPart,teil);
    }
    if(!out._teilFromPool.includes(teil))out._teilFromPool.push(teil);
    out._genReport.poolFallback.push({module:'lesen',teil,partId:poolPart.id||null,preload:true});
    lcDebug.log('[personal] lesen T'+teil+' preloaded from pool',poolPart.id||'');
  }
  out._teilFromPool=[...new Set(out._teilFromPool.map(Number))].sort((a,b)=>a-b);
  return out;
}
function personalModuleTeilsComplete(exam,skills,blueprint){
  const PF=getPoolFallbackHelpers();
  const ordered=orderedPersonalSkills(skills||exam?.vocabSkills||[]);
  if(ordered.includes('lesen')){
    for(const teil of PF?.lesenBlueprintTeils(blueprint)||[1,2,3,4,5]){
      if(!lesenTeilPresentAndValid(exam,teil,blueprint))return false;
    }
  }
  if(ordered.includes('horen')||ordered.includes('listening')){
    for(const teil of PF?.horenBlueprintTeils(blueprint)||[1,2,3,4]){
      if(!horenTeilPresentAndValid(exam,teil,blueprint))return false;
    }
  }
  if(ordered.includes('schreiben')){
    for(const teil of PF?.schreibenBlueprintTeils?.(blueprint)||[1,2,3]){
      if(!schreibenTeilPresentAndValid(exam,teil,blueprint))return false;
    }
  }
  return true;
}
function attachPersonalCoverage(exam,words){
  if(!exam||!words?.length)return exam;
  const Cov=typeof PersonalExamCoverage!=='undefined'?PersonalExamCoverage:null;
  if(Cov?.attachPersonalExamCoverage)return Cov.attachPersonalExamCoverage(exam,words);
  return exam;
}
function showPersonalCoverageToast(exam,words){
  if(!words?.length)return;
  const Cov=typeof PersonalExamCoverage!=='undefined'?PersonalExamCoverage:null;
  if(!Cov?.formatPersonalCoverageMessage)return;
  const cov=exam._coverageOverall||Cov.computePersonalExamCoverage(exam,words).overall;
  const lang=exam?.lang||S?.subject||'de';
  lcToast(Cov.formatPersonalCoverageMessage(exam,{overall:cov},lang),'info',9000);
}
function examCopyForPoolIngest(exam,topic){
  const copy=buildPoolExamCopy(exam,topic||genericPoolTopic(S.subject,S.level));
  const PF=getPoolFallbackHelpers();
  if(PF)return PF.stripPoolPartsForIngest(copy);
  if(Array.isArray(copy.lesenParts)){
    copy.lesenParts=copy.lesenParts.filter(p=>!p._fromPool);
    if(!copy.lesenParts.length)delete copy.lesenParts;
  }
  delete copy._teilFromPool;
  return copy;
}
function sanitizeExamText(text){
  if(text==null||typeof text!=='string')return'';
  return text
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/?[^>]+>/g,'')
    .replace(/\r\n/g,'\n');
}
function isLesenForumOpinionsPart(part){
  if(!part||Number(part.teil)!==4)return false;
  const slot=String(part.blueprintSlot||part.slotType||'').toLowerCase();
  if(slot.includes('forum')||slot.includes('opinion'))return true;
  const instr=String(part.instruction||'').toLowerCase();
  if(/meinungen.*(?:20|21)|ja oder nein|yes or no|stimmt die person/i.test(instr))return true;
  return(part.items||[]).some(it=>{
    const c=String(it.correct??'').trim();
    return(it.signText||it.text)&&/^(J|N|Ja|Nein|Yes|No)$/i.test(c);
  });
}
function coalesceLesenForumOpinions(part){
  if(!isLesenForumOpinionsPart(part))return;
  part.blueprintSlot=part.blueprintSlot||'forum_opinions';
  part.slotType=part.slotType||'forum_opinions';
  if(!part.items?.length&&part.questions?.length){
    part.items=part.questions
      .filter(q=>q&&(q.signText||q.text||q.question))
      .map((q,i)=>({
        id:q.id||String(20+i),
        signText:q.signText||q.text||'',
        question:(q.signText||q.text)?(q.question||q.statement||''):(q.question||q.statement||q.signText||q.text||''),
        type:'ja_nein',
        correct:q.correct??q.correctAnswer,
      }));
    part.questions=(part.questions||[]).filter(q=>!q.signText&&!q.text);
  }
  const startNum=Number(part.teil)===4?20:1;
  (part.items||[]).forEach((item,i)=>{
    if(!item.signText&&item.text)item.signText=item.text;
    if(!item.signText&&item.body)item.signText=item.body;
    if(!item.signText&&item.content)item.signText=item.content;
    if(Number(part.teil)===4||!item.id||/^l\d/i.test(String(item.id)))item.id=String(startNum+i);
    if(!item.type||item.type==='multiple'||item.type==='multiple_choice')item.type='ja_nein';
    if(item.signText&&item.question&&/stimmt|ja oder nein|agree|dem thema zu/i.test(String(item.question))){
      delete item.question;
    }
    delete item.options;
    normalizeGoetheQuestion(item,part);
  });
  if(part.text&&!part.textTitle)part.textTitle=part.text.slice(0,120);
  if(part.items?.length)delete part.text;
}
function coalesceLesenPartQuestions(part){
  if(!part)return;
  const slot=String(part.blueprintSlot||part.slotType||'').toLowerCase();
  // Same blueprint guard as isLesenAdsMatchingPart. This function promotes items[] into
  // questions[] and, for anything with a passage, types them rf — the Goethe Lesen T1 shape.
  // Cambridge Reading P1 (signs_notices_mcq) has neither R/F nor Ja/Nein keys, so its items
  // fell through to that last `part.text||part.textTitle` branch and were appended as True/
  // False copies while items[] stayed put: the part rendered twice, once correctly as 3-option
  // MCQ and once as ten phantom True/False questions.
  if(/mcq|multiple_choice|long_text|open_cloze/.test(slot)&&!/matching|ads/.test(slot))return;
  const existing=part.questions||[];
  const promoted=[];
  (part.items||[]).forEach((item,i)=>{
    const rawType=String(item.type||'').toLowerCase();
    const forumLike=!!item.signText&&(slot.includes('forum')||slot.includes('opinion')||rawType==='ja_nein'||rawType==='yn');
    const matchingLike=!!(item.signText||item.question||item.statement)&&(slot.includes('ads')||slot.includes('matching')||['matching','match','person_match','person_multi','abcd'].includes(rawType));
    if(forumLike||matchingLike){
      if(!item.type||item.type==='multiple'||item.type==='multiple_choice'){
        const c=String(item.correct??item.correctAnswer??'').trim();
        if(/^(J|N|Ja|Nein|Yes|No|Y)$/i.test(c))item.type='yn';
        else if(matchingLike)item.type=matchingLike&&rawType!=='multiple'?(rawType==='abcd'?'abcd':'matching'):'matching';
      }
      normalizeGoetheQuestion(item,part);
      return;
    }
    const stem=item.question||item.statement;
    if(!stem)return;
    const q={
      id:item.id||`l${part.teil||1}q${i+1}`,
      type:item.type,
      question:stem,
      correct:item.correct??item.correctAnswer,
      options:item.options,
    };
    if(slot.includes('richtig')||slot.includes('blog'))q.type='rf';
    if(!q.type||q.type==='multiple'||q.type==='multiple_choice'){
      const c=String(q.correct??'').trim();
      if(/^(R|F|Richtig|Falsch|True|False|W|T)$/i.test(c))q.type='rf';
      else if(/^(J|N|Ja|Nein|Yes|No|Y)$/i.test(c))q.type='yn';
      else if(slot.includes('richtig')||slot.includes('blog'))q.type='rf';
      else if(part.text||part.textTitle)q.type='rf';
    }
    normalizeGoetheQuestion(q,part);
    if(q.options?.length||q.type==='rf'||q.type==='yn'||q.type==='matching'||q.type==='abcd'){
      if(q.type==='matching'||q.type==='abcd')return;
      promoted.push(q);
    }
  });
  if(!promoted.length)return;
  part.questions=[...existing,...promoted];
  part.items=(part.items||[]).filter(item=>!(item.question||item.statement)||item.signText);
}
function isLesenAdsMatchingPart(part){
  if(!part)return false;
  if(Number(part.teil)===4){
    const slot=String(part.blueprintSlot||part.slotType||'').toLowerCase();
    if(slot.includes('forum')||slot.includes('opinion'))return false;
  }
  const slot=String(part.blueprintSlot||part.slotType||'').toLowerCase();
  if(slot.includes('ads')||(slot.includes('matching')&&Number(part.teil)===3))return true;
  // The blueprint knows the task; trust it over the shape heuristic below. Cambridge marks
  // every answer with a letter, so `correct:"A"` on an item that carries a sign or a passage
  // is NOT evidence of a matching task the way it is in Goethe Lesen T3 — without this,
  // Reading P1 (signs MCQ), P3 (long text MCQ) and P5 (MCQ cloze) all classify as ads
  // matching, get a shared ad pool built from one item, and lose their own options. Slots
  // that really are matching (person_text_matching, gapped_text) keep the letter route.
  if(/mcq|multiple_choice|long_text|open_cloze/.test(slot)&&!/matching|ads/.test(slot))return false;
  if(part.ads?.length)return true;
  const items=part.items||[];
  if(!items.length)return false;
  return items.some(it=>{
    const t=String(it.type||'').toLowerCase();
    const c=String(it.correct??'').trim();
    return t==='matching'||t==='match'||((it.signText||it.text)&&/^[A-J0]$/i.test(c));
  });
}
function normalizeLesenAdRecord(a,i,ADS){
  if(typeof a==='string'){
    const parsed=typeof AdsMatching!=='undefined'?AdsMatching.parseAdOptionLine(a):null;
    if(parsed)return parsed;
    return{key:ADS[i]||String(i+1),title:'',text:a.trim()};
  }
  if(!a||typeof a!=='object')return{key:ADS[i]||String(i+1),title:'',text:''};
  return{
    key:String(a.key??a.id??ADS[i]??i+1).trim().replace(/^\s*([a-zA-Z0-9]+)\)\s*/,'$1').toUpperCase(),
    title:String(a.title||a.headline||'').trim(),
    text:String(a.text||a.body||a.content||a.description||'').trim(),
  };
}
function synthesizeLesenInstruction(part,lang){
  const teil=Number(part?.teil)||1;
  const ER=typeof ExamRenumber!=='undefined'?ExamRenumber:null;
  const range=ER?.teilRange?.(null,'lesen',teil,part)||ER?.DEFAULT_RANGES?.lesen?.[teil];
  const start=range?.start??(teil===1?1:teil===2?7:teil===3?13:teil===4?20:27);
  const end=range?.end??start+(range?.expected??6)-1;
  const de=lang!=='en'&&lang!=='es';
  if(teil===1){
    return de
      ?`Lesen Sie den Text und die Aufgaben ${start} bis ${end}. Wählen Sie: Sind die Aussagen Richtig oder Falsch?`
      :`Read the text and tasks ${start} to ${end}. Choose: True or False?`;
  }
  if(teil===2){
    return de
      ?`Lesen Sie die beiden Texte und die Aufgaben ${start} bis ${end}. Wählen Sie bei jeder Aufgabe die richtige Lösung a, b oder c.`
      :`Read both texts and tasks ${start} to ${end}. Choose the correct answer a, b or c for each task.`;
  }
  if(teil===3){
    const adLo=String(part.ads?.[0]?.key||'a').toLowerCase();
    const adHi=String(part.ads?.[part.ads.length-1]?.key||'j').toLowerCase();
    return de
      ?`Lesen Sie die Situationen ${start} bis ${end} und die Anzeigen ${adLo} bis ${adHi}. Welche Anzeige passt zu welcher Situation? Eine Anzeige passt nicht. Wenn es keine passende Anzeige gibt, schreiben Sie 0.`
      :`Read situations ${start} to ${end} and ads ${adLo} to ${adHi}. Which ad matches each situation? One ad does not match. If no ad fits, write 0.`;
  }
  if(teil===4){
    return de
      ?`Lesen Sie die Meinungen ${start} bis ${end} zu einem Thema. Stimmt die Person dem Thema zu? Wählen Sie: Ja oder Nein.`
      :`Read opinions ${start} to ${end} on a topic. Does the person agree? Choose Yes or No.`;
  }
  if(teil===5){
    return de
      ?`Lesen Sie den Text (z. B. eine Hausordnung oder Anweisungen) und die Aufgaben ${start} bis ${end}. Wählen Sie bei jeder Aufgabe die richtige Lösung a, b oder c.`
      :`Read the text and tasks ${start} to ${end}. Choose the correct answer a, b or c for each task.`;
  }
  return '';
}
function ensureLesenPartInstruction(part,lang){
  if(String(part?.instruction||'').trim())return;
  const synth=synthesizeLesenInstruction(part,lang);
  if(synth)part.instruction=synth;
}
function rebuildLesenAdsMatchingInstruction(part,lang){
  if(!part?.items?.length||!part.ads?.length)return;
  const de=lang!=='en'&&lang!=='es';
  // Outside German, only FILL a missing instruction — never replace an authored one.
  // The Goethe wording ("eine Anzeige passt nicht", "schreiben Sie 0") describes Lesen T3
  // specifically: Cambridge Part 2 leaves three texts unused and offers no "0" option. On
  // top of that, isLesenAdsMatchingPart() also matches Cambridge parts that are not
  // matching tasks at all (signs/notices, long text, gapped text), so overwriting their
  // blueprint instruction told the candidate to do a task that was not on screen.
  if(!de&&String(part.instruction||'').trim())return;
  const start=part.items[0].id;
  const end=part.items[part.items.length-1].id;
  const adLo=String(part.ads[0].key).toLowerCase();
  const adHi=String(part.ads[part.ads.length-1].key).toLowerCase();
  part.instruction=de
    ?`Lesen Sie die Situationen ${start} bis ${end} und die Anzeigen ${adLo} bis ${adHi}. `+
     'Welche Anzeige passt zu welcher Situation? Eine Anzeige passt nicht. '+
     'Wenn es keine passende Anzeige gibt, schreiben Sie 0.'
    :`Read questions ${start} to ${end} and texts ${adLo.toUpperCase()} to ${adHi.toUpperCase()}. `+
     'Decide which text is the most suitable for each person.';
}
function promoteLesenAdsMatchingQuestions(part){
  if(part.items?.length||!part.ads?.length||!part.questions?.length)return false;
  const startNum=Number(part.teil)===3?13:1;
  const isMatchQ=(q)=>{
    if(!q)return false;
    const t=String(q.type||'').toLowerCase();
    if(['matching','match','abcd'].includes(t))return true;
    const c=String(q.correct??q.correctAnswer??'').trim();
    return(q.question||q.text||q.signText)&&/^[A-J0]$/i.test(c);
  };
  const matching=part.questions.filter(isMatchQ);
  if(matching.length<3)return false;
  part.items=matching.map((q,i)=>({
    id:q.id||String(startNum+i),
    signText:q.signText||q.text||q.question||'',
    type:'matching',
    correct:q.correct??q.correctAnswer,
  }));
  part.questions=part.questions.filter(q=>!matching.includes(q));
  return true;
}
function inferLesenT3HasNoMatchPart(part){
  const pool=[...(part.items||[]),...(part.questions||[])];
  if(pool.some(it=>String(it?.correct??it?.correctAnswer??'').trim()==='0'))part._t3HasNoMatch=true;
}
function coalesceLesenAdsMatching(part,lang){
  if(!isLesenAdsMatchingPart(part))return;
  const ADS='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  part.blueprintSlot=part.blueprintSlot||'ads_matching';
  if(!part.ads?.length){
    for(const src of[part.advertisements,part.anzeigen,part.classifiedAds]){
      if(Array.isArray(src)&&src.length){
        part.ads=src.map((a,i)=>normalizeLesenAdRecord(a,i,ADS));
        break;
      }
    }
  }
  if(!part.ads?.length&&Array.isArray(part.options)&&part.options[0]&&typeof part.options[0]==='object'&&(part.options[0].text||part.options[0].title)){
    part.ads=part.options.map((a,i)=>normalizeLesenAdRecord(a,i,ADS));
  }
  if(typeof AdsMatching!=='undefined'){
    const pool=[...(part.questions||[]),...(part.items||[])];
    if(!part.ads?.length){
      const built=AdsMatching.buildAdsFromBankQuestions(pool);
      if(built.length>=3)part.ads=built;
    }
  }
  if(part.ads?.length){
    part.ads=part.ads
      .map((a,i)=>normalizeLesenAdRecord(a,i,ADS))
      .filter(a=>a.text||a.title)
      .map((a,i)=>({...a,key:ADS[i]||String(i+1)}));
  }
  promoteLesenAdsMatchingQuestions(part);
  const startNum=Number(part.teil)===3?13:1;
  (part.items||[]).forEach((item,i)=>{
    if(!item.signText&&!item.text&&item.question){
      const q=String(item.question).trim();
      if(q.length>15&&!/welche anzeige|which ad|qué anuncio|passende anzeige/i.test(q)){
        item.signText=q;
        item.question='';
      }
    }
    if(!item.signText&&item.text)item.signText=item.text;
    if(!item.id||/^l\d/i.test(String(item.id))||Number(part.teil)===3)item.id=String(startNum+i);
    if(!item.type||item.type==='multiple'||item.type==='multiple_choice')item.type='matching';
    if(part.ads?.length)delete item.options;
  });
  if(part.items?.length){
    part.questions=(part.questions||[]).filter(q=>{
      const t=String(q?.type||'').toLowerCase();
      return!['matching','match','abcd'].includes(t);
    });
  }
  if(part.items?.length&&part.ads?.length){
    rebuildLesenAdsMatchingInstruction(part,lang);
  }
  inferLesenT3HasNoMatchPart(part);
  (part.items||[]).forEach(item=>normalizeGoetheQuestion(item,part));
}
function lesenPartMissingAds(part){
  if(!isLesenAdsMatchingPart(part))return false;
  if(part.ads?.length>=2)return false;
  // Ads embedded in item.options (curated bank format) — items are still answerable
  const items=part.items||[];
  if(items.some(it=>Array.isArray(it.options)&&it.options.length>=2))return false;
  return true;
}
function normalizeHorenQuestionFields(q){
  if(!q||typeof q!=='object')return;
  if(!q.options&&Array.isArray(q.choices))q.options=q.choices;
  if(!q.question&&q.statement)q.question=q.statement;
  if(!q.question&&q.text)q.question=q.text;
  if(!q.question&&q.prompt)q.question=q.prompt;
}
function horenOptionHasSubstance(opt){
  if(opt==null)return false;
  if(typeof opt==='string'){
    const m=opt.match(/^([A-Za-z0-9]+)\)\s*(.*)$/s);
    const body=(m?m[2]:opt).trim();
    if(!body)return false;
    if(m&&body.toUpperCase()===m[1].toUpperCase())return false;
    return body.length>1&&!/^[A-D0]$/i.test(body);
  }
  if(typeof opt==='object'){
    const text=String(opt.text??opt.label??opt.option??'').trim();
    const key=String(opt.key??opt.id??'').trim().toUpperCase();
    if(!text)return false;
    if(key&&text.toUpperCase()===key)return false;
    if(/^[A-D0]$/i.test(text))return false;
    return true;
  }
  return false;
}
function horenQuestionHasSubstance(q){
  if(!q||typeof q!=='object')return false;
  const type=String(q.type||'multiple').toLowerCase();
  // gap_fill/gap answer with a word, so they carry options:[] and are judged by
  // the key alone — same as rf/yn. Without them here they fell through to the
  // MCQ rule below (>=2 substantial options) and every Cambridge Listening
  // Part 3 sentence-completion item was filtered out of the exam.
  if(['rf','tf','richtig_falsch','true_false','yn','ja_nein','rfn','r_f_n','gap_fill','gap'].includes(type)){
    return q.correct!=null&&q.correct!=='';
  }
  const opts=q.options||q.choices||[];
  const substantial=opts.filter(horenOptionHasSubstance);
  if(['matching','match','abcd'].includes(type)){
    const stem=String(q.question||q.statement||'').trim();
    if(!stem)return false;
    if(q._keyOnlyMatch&&q.correct!=null&&q.correct!=='')return true;
    if(substantial.length>=1)return true;
    return opts.length>=2&&q.correct!=null&&q.correct!=='';
  }
  return substantial.length>=2;
}
function isKeyOnlyOptionList(options){
  if(!Array.isArray(options)||!options.length)return false;
  return options.every(o=>{
    if(typeof o==='string'){
      const m=o.match(/^([A-Za-z0-9]+)\)\s*(.*)$/s);
      const key=(m?m[1]:o).trim();
      const body=(m?m[2]:'').trim();
      if(body&&body.length>1&&body.toUpperCase()!==key.toUpperCase())return false;
      return /^[A-JM0]$/i.test(key);
    }
    if(o&&typeof o==='object'){
      const key=String(o.key??'').trim();
      const text=String(o.text??o.label??'').trim();
      if(text&&text.length>1&&(!key||text.toUpperCase()!==key.toUpperCase()))return false;
      return /^[A-JM0]$/i.test(key||text);
    }
    return false;
  });
}
function optionListKeys(options){
  return(options||[]).map(o=>{
    if(typeof o==='string'){
      const m=o.match(/^([A-Za-z0-9]+)\)/);
      return(m?m[1]:o).trim().toUpperCase();
    }
    return String(o?.key??'').trim().toUpperCase();
  }).filter(Boolean);
}
function isSpeakerAssignmentQuestion(q,part,seg){
  const keys=optionListKeys(q.options);
  if(!keys.length)return false;
  if(keys.includes('M')&&keys.every(k=>/^[MAB0]$/i.test(k)))return true;
  if(seg?.speakerLegend?.length)return true;
  const teil=Number(part?.teil);
  const slot=String(part?.blueprintSlot||part?.slotType||'').toLowerCase();
  if(teil===4&&slot.includes('discussion')&&keys.some(k=>/^[MAB]$/i.test(k)))return true;
  return false;
}
function isReservedMatchingQuestion(q,part,seg){
  if(!q||typeof q!=='object')return false;
  if(isSpeakerAssignmentQuestion(q,part,seg))return true;
  if(typeof HorenPictureMatching!=='undefined'&&HorenPictureMatching.isPictureMatchingPart(part))return true;
  if(seg?.pictures?.length>=9)return true;
  if(part?.ads?.length>=2&&(q.signText||(q.correct!=null&&!q.options?.length)))return true;
  if(typeof isLesenAdsMatchingPart==='function'&&isLesenAdsMatchingPart(part)&&(q.signText||q.text))return true;
  const opts=q.options||[];
  if(!opts.length)return false;
  return isKeyOnlyOptionList(opts);
}
/** Hören T1/T2 a/b/c with full option text — not speaker or ad assignment. */
function isTextMcqQuestion(q,part,seg){
  if(isReservedMatchingQuestion(q,part,seg))return false;
  const qt=String(q.questionType||'').toLowerCase();
  if(qt==='multiple_choice'||qt==='multiple')return true;
  const rawType=String(q.type||'').toLowerCase();
  if(rawType==='multiple'||rawType==='multiple_choice')return true;
  const opts=q.options||[];
  if(!opts.length)return false;
  const keys=optionListKeys(opts);
  if(keys.length>=2&&keys.every(k=>/^[A-D]$/i.test(k))){
    return opts.filter(horenOptionHasSubstance).length>=2;
  }
  return false;
}
function normalizeQuestionTypeField(q,part,seg){
  if(!q||typeof q!=='object')return;
  const qt=String(q.questionType||'').toLowerCase();
  if(qt){
    if((qt==='multiple_choice'||qt==='multiple')&&isTextMcqQuestion(q,part,seg)){
      q.type='multiple';
    }else if(!q.type||q.type==='multiple_choice'){
      if(qt==='true_false'||qt==='richtig_falsch')q.type='rf';
      else if(qt==='multiple_choice'||qt==='multiple')q.type='multiple';
    }
    delete q.questionType;
  }
  if((q.type==='matching'||q.type==='match')&&isTextMcqQuestion(q,part,seg)){
    q.type='multiple';
    delete q._keyOnlyMatch;
    coerceMcqOptions(q);
  }else if(q.type==='multiple_choice'){
    q.type='multiple';
    delete q._keyOnlyMatch;
  }
}
function extractSpeakerNamesFromTranscript(transcript){
  const seen=new Set();
  const names=[];
  if(!transcript)return names;
  for(const line of String(transcript).split(/\n/)){
    const m=line.match(/^\s*([^:\n]{2,55}):\s+/);
    if(!m)continue;
    const name=m[1].trim();
    const dedupe=name.toLowerCase().replace(/\s+/g,' ');
    if(seen.has(dedupe))continue;
    seen.add(dedupe);
    names.push(name);
  }
  return names;
}
function collectOptionKeysFromQuestions(questions){
  const keys=new Set();
  for(const q of questions||[]){
    for(const o of q.options||[]){
      const k=typeof o==='string'?o.trim().toUpperCase():String(o?.key??'').trim().toUpperCase();
      if(/^[A-JM0]$/.test(k))keys.add(k);
    }
  }
  const order=['M','A','B','C','D','E','F','G','H','I','J','0'];
  return order.filter(k=>keys.has(k));
}
function buildHorenSpeakerMap(transcript,optionKeys,part,seg){
  const map=new Map();
  let names=[];
  const sp=seg?.speakers||part?.speakers;
  if(Array.isArray(sp)){
    names=sp.map(s=>typeof s==='string'?s:(s?.name||s?.label||'')).filter(Boolean);
  }
  if(!names.length)names=extractSpeakerNamesFromTranscript(transcript);
  if(!names.length)return map;
  const keys=optionKeys.length?optionKeys:['M','A','B'];
  const modIdx=names.findIndex(n=>/moderator/i.test(n));
  if(keys.includes('M')){
    map.set('M',modIdx>=0?names[modIdx]:'Moderator/in');
    const guests=names.filter((_,i)=>i!==modIdx);
    keys.filter(k=>k!=='M'&&k!=='0').forEach((k,i)=>{if(guests[i])map.set(k,guests[i]);});
  }else{
    keys.filter(k=>k!=='0').forEach((k,i)=>{if(names[i])map.set(k,names[i]);});
  }
  return map;
}
function enrichHorenSpeakerMatching(seg,part){
  if(!seg)return;
  const transcript=seg.transcript||part?.transcript||'';
  const questions=seg.questions||[];
  const needsEnrich=questions.some(q=>{
    const t=String(q.type||'').toLowerCase();
    return['matching','match','abcd','person_match'].includes(t)||isKeyOnlyOptionList(q.options);
  });
  if(!needsEnrich)return;
  const optionKeys=collectOptionKeysFromQuestions(questions);
  const speakerMap=buildHorenSpeakerMap(transcript,optionKeys,part,seg);
  if(!speakerMap.size)return;
  seg.speakerLegend=[...speakerMap.entries()].map(([k,name])=>`${k} = ${name}`);
  const ADS='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for(const q of questions){
    const opts=q.options||[];
    if(!opts.length)continue;
    if(isTextMcqQuestion(q,part,seg))continue;
    if(!isKeyOnlyOptionList(opts)&&!['matching','match','abcd','person_match'].includes(String(q.type||'').toLowerCase()))continue;
    q.options=opts.map((o,i)=>{
      const key=parseOptionKeyFromEntry(o,i);
      const labeled=speakerMap.get(key);
      const raw=typeof o==='object'?String(o.text??o.label??'').trim():'';
      const text=labeled||(raw&&raw.toUpperCase()!==key?raw:'');
      return{key,text:text||labeled||key};
    });
    q.type='matching';
    q._keyOnlyMatch=false;
  }
}
function coalesceHorenSegmentQuestions(seg,part){
  if(!seg)return;
  normalizeHorenQuestionFields(seg);
  if(typeof HorenPictureMatching!=='undefined'&&HorenPictureMatching.isPictureMatchingPart(part)){
    const applied=HorenPictureMatching.applyPicturesToHorenSegment(seg,seg.pictures||part?.passage?.pictures);
    Object.assign(seg,applied);
  }
  if(seg.question&&!seg.questions?.length){
    seg.questions=[{
      id:seg.id||'hq1',
      type:seg.type||'multiple_choice',
      question:seg.question,
      options:seg.options||seg.choices,
      correct:seg.correct,
    }];
  }
  if(Array.isArray(seg.items)&&seg.items.length){
    if(!seg.questions)seg.questions=[];
    seg.items.forEach((item,i)=>{
      if(!item||typeof item!=='object')return;
      seg.questions.push({
        id:item.id||`hq${seg.questions.length+1}`,
        type:item.type,
        question:item.question||item.statement,
        options:item.options||item.choices,
        correct:item.correct??item.correctAnswer,
      });
    });
    delete seg.items;
  }
  enrichHorenSpeakerMatching(seg,part);
  seg.questions=(seg.questions||[]).map(q=>{
    normalizeHorenQuestionFields(q);
    if(!q.type||q.type==='multiple'||q.type==='multiple_choice'){
      const c=String(q.correct??'').trim();
      if(/^(R|F|Richtig|Falsch|True|False|W|T)$/i.test(c))q.type='rf';
      else if(/^(J|N|Ja|Nein|Yes|No|Y)$/i.test(c))q.type='yn';
      else if(isKeyOnlyOptionList(q.options))q.type='matching';
      else if(isTextMcqQuestion(q,part,seg))q.type='multiple';
    }
    normalizeGoetheQuestion(q,part,seg);
    if(q.type==='matching'&&!q._keyOnlyMatch&&isKeyOnlyOptionList(q.options)){
      enrichHorenSpeakerMatching(seg,part);
    }
    return q;
  }).filter(q=>horenQuestionHasSubstance(q));
}
function coalesceHorenPartSegments(part){
  if(!part)return;
  if(part.segments?.length){
    part.segments.forEach(seg=>coalesceHorenSegmentQuestions(seg,part));
    return;
  }
  const qs=(part.questions||[]).map(q=>({...q}));
  if(!qs.length&&!part.transcript)return;
  part.segments=[{
    label:part.context||'Aufnahme 1',
    transcript:part.transcript||part.audioScript||'',
    questions:qs,
  }];
  coalesceHorenSegmentQuestions(part.segments[0],part);
  delete part.questions;
  delete part.transcript;
  delete part.audioScript;
}
function sanitizeGoetheParts(d){
  const fixT=t=>typeof t==='string'?sanitizeExamText(t):t;
  const ADS='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  (d.lesenParts||[]).forEach((part,pi)=>{
    if(part.text)part.text=fixT(part.text);
    if(part.textTitle)part.textTitle=fixT(part.textTitle);
    if(part.textWithGaps)part.textWithGaps=part.textWithGaps.map(fixT);
    part.teil=part.teil??pi+1;
    coalesceLesenForumOpinions(part);
    coalesceLesenAdsMatching(part,d.lang||'de');
    const PF=getPoolFallbackHelpers();
    if(PF?.coalesceLesenAdsMatchingPart)PF.coalesceLesenAdsMatchingPart(part);
    else if(PF?.ensureLesenT3Example)PF.ensureLesenT3Example(part);
    ensureLesenPartInstruction(part,d.lang||'de');
    if(part.ads)part.ads.forEach((a,i)=>{a.key=ADS[i]||String(i+1);if(!a.title)a.title='';if(!a.text)a.text='';a.title=fixT(a.title);a.text=fixT(a.text);});
    coalesceLesenPartQuestions(part);
    (part.options||[]).forEach(o=>{if(o.text)o.text=fixT(o.text);});
    (part.persons||[]).forEach(p=>{if(p.text)p.text=fixT(p.text);if(p.name)p.name=fixT(p.name);});
    (part.opinions||[]).forEach(o=>{if(o.text)o.text=fixT(o.text);if(o.name)o.name=fixT(o.name);});
    (part.items||[]).forEach(item=>{if(item.signText)item.signText=fixT(item.signText);if(item.text)item.text=fixT(item.text);if(item.type==='matching'||item.type==='match')normalizeGoetheQuestion(item,part);});
    if(part.items?.length&&!part.items.some(it=>it.signText||it.text)&&part.ads?.length){
      if(!part.questions)part.questions=[];
      part.items.forEach((item,i)=>{
        if(!item.question)return;
        const q={id:item.id||`l${pi+1}s${i+1}`,type:item.type||'matching',question:item.question,options:item.options,correct:item.correct};
        normalizeGoetheQuestion(q,part);
        part.questions.push(q);
      });
      part.items=[];
    }
    (part.questions||[]).forEach((q,i)=>{if(!q.id)q.id='l'+(pi*10+i+1);normalizeGoetheQuestion(q,part);});
    (part.items||[]).forEach((item,i)=>{if(!item.id)item.id='l'+(pi*10+i+1);});
    (part.segments||[]).forEach(seg=>{(seg.questions||[]).forEach(q=>normalizeGoetheQuestion(q,part));});
  });
  (d.horenParts||[]).forEach((part,pi)=>{
    part.teil=part.teil??pi+1;
    part.plays=part.plays||2;
    if(!part.instruction)part.instruction=part.context||'';
    coalesceHorenPartSegments(part);
    if(part.transcript)part.transcript=fixT(part.transcript);
    if(!part.segments&&(part.audios||part.recordings)){
      part.segments=(part.audios||part.recordings).map((a,i)=>({
        label:a.label||a.title||`Aufnahme ${i+1}`,
        transcript:a.transcript||a.text||'',
        questions:a.questions||[],
      }));
      delete part.audios;
      delete part.recordings;
    }
    if(!part.noteFields&&part.notes){
      if(Array.isArray(part.notes)){
        part.noteFields=part.notes.map((n,i)=>({
          id:n.id||'note'+(i+1),
          label:n.label||n.question||n,
          answer:n.answer||'',
        }));
      }else if(part.notes.fields){
        part.noteFields=part.notes.fields;
      }
      delete part.notes;
    }
    if(!part.questions&&part.content?.questions)part.questions=part.content.questions;
    (part.segments||[]).forEach((seg,si)=>{
      if(!seg.id)seg.id='h'+(pi*10+si+1);
      if(seg.transcript)seg.transcript=fixT(seg.transcript);
      coalesceHorenSegmentQuestions(seg,part);
      (seg.questions||[]).forEach((q,qi)=>{if(!q.id)q.id=`h${pi+1}_${si+1}_${qi+1}`;});
    });
    (part.questions||[]).forEach((q,i)=>{if(!q.id)q.id='h'+(pi*10+i+1);normalizeGoetheQuestion(q,part);});
  });
  (d.schreibenParts||[]).forEach((p,i)=>{
    p.aufgabe=p.aufgabe??i+1;
    p.fieldId=p.fieldId||'write'+(i+1);
    if(!p.task)p.task=p.instruction||p.prompt||'';
    p.task=fixT(p.task);
    if(!p.criteria)p.criteria=[];
  });
  (d.sprechenParts||[]).forEach((p,i)=>{
    p.teil=p.teil??i+1;
    p.fieldId=p.fieldId||'speak'+(i+1);
    p.title=p.title||(d.lang==='de'?'Sprechen':'Speaking')+' '+(i+1);
    if(!p.situation)p.situation=p.instruction||p.prompt||p.context||'';
    if(!p.points)p.points=p.prompts||p.examinerQuestions||[];
    if(typeof p.points==='string')p.points=[p.points];
  });
  return d;
}
/**
 * Hoist nested assembled shape `{ exam: { lesenParts… } }` and stamp
 * `_contentProvenance` from `_meta.sources` / `_meta.partIds` (or existing stamps).
 * Never infer sourceFile from array index alone.
 */
function hoistNestedExamParts(d){
  if(!d||typeof d!=='object'||!d.exam||typeof d.exam!=='object')return d;
  for(const k of['lesenParts','horenParts','schreibenParts','sprechenParts','modules','official']){
    if((d[k]==null||(Array.isArray(d[k])&&!d[k].length))&&d.exam[k]!=null){
      d[k]=d.exam[k];
    }
  }
  return d;
}
function stripSourceExt(name){
  return String(name||'').trim().replace(/\.json$/i,'');
}
function sourceFileFromPartId(partId){
  const id=String(partId||'').trim();
  if(!id)return '';
  // schreiben-gemini-009-t1 → schreiben-gemini-009
  return id.replace(/-t[1-5]$/i,'');
}
function attachContentProvenance(d){
  if(!d||typeof d!=='object')return d;
  const sources=d._meta&&d._meta.sources?d._meta.sources:{};
  const partIds=d._meta&&d._meta.partIds?d._meta.partIds:{};
  const topics=d._meta&&d._meta.topics?d._meta.topics:{};
  const stampQs=(list,base)=>{
    (list||[]).forEach(q=>{
      if(!q||typeof q!=='object')return;
      const qid=q.id!=null?String(q.id):'';
      if(!qid)return;
      q._contentProvenance={
        sourceFile:base.sourceFile||null,
        module:base.module,
        teil:base.teil,
        questionId:qid,
        passageId:q.passageId!=null?String(q.passageId):(base.passageId||null),
      };
    });
  };
  const stampModule=(parts,module)=>{
    (parts||[]).forEach(p=>{
      if(!p||typeof p!=='object')return;
      const teil=Number(p.teil);
      const key=`${module}_${teil}`;
      const existing=p._contentProvenance&&typeof p._contentProvenance==='object'?p._contentProvenance:null;
      let sourceFile=stripSourceExt(existing&&existing.sourceFile||p.sourceFile||'');
      if(!sourceFile&&sources[key])sourceFile=stripSourceExt(sources[key]);
      if(!sourceFile&&partIds[key])sourceFile=sourceFileFromPartId(partIds[key]);
      if(!sourceFile&&p.partId)sourceFile=sourceFileFromPartId(p.partId);
      const partId=(existing&&existing.partId)||partIds[key]||p.partId||sourceFile||null;
      let passageId=p.passageId!=null?String(p.passageId):null;
      if(!passageId){
        const fromQ=(p.questions||[]).find(q=>q&&q.passageId);
        if(fromQ)passageId=String(fromQ.passageId);
      }
      if(!passageId&&Array.isArray(p.passages)&&p.passages[0]){
        const pp=p.passages[0];
        if(pp&&typeof pp==='object')passageId=pp.passageId!=null?String(pp.passageId):(pp.id!=null?String(pp.id):null);
      }
      if(!p.passageId&&passageId)p.passageId=passageId;
      if(!p.topicTag&&topics[key]!=null&&topics[key]!=='')p.topicTag=topics[key];
      if(!p.sourceFile&&sourceFile)p.sourceFile=sourceFile;
      if(!p.partId&&partId)p.partId=partId;
      const base={
        sourceFile:sourceFile||null,
        module,
        teil:Number.isFinite(teil)?teil:null,
        partId:partId?String(partId):null,
        passageId,
      };
      p._contentProvenance={
        sourceFile:base.sourceFile,
        module:base.module,
        teil:base.teil,
        partId:base.partId,
        passageId:base.passageId,
      };
      (p.passages||[]).forEach(pp=>{
        if(!pp||typeof pp!=='object')return;
        const pid=pp.passageId!=null?String(pp.passageId):(pp.id!=null?String(pp.id):null);
        pp._contentProvenance={
          sourceFile:base.sourceFile,
          module:base.module,
          teil:base.teil,
          partId:base.partId,
          passageId:pid,
        };
      });
      stampQs(p.questions,base);
      stampQs(p.items,base);
      (p.segments||[]).forEach(seg=>{
        stampQs(seg&&seg.questions,base);
      });
    });
  };
  stampModule(d.lesenParts,'lesen');
  stampModule(d.horenParts,'horen');
  stampModule(d.schreibenParts,'schreiben');
  stampModule(d.sprechenParts,'sprechen');
  return d;
}
function normalizeGoetheExam(d){
  if(!d)return d;
  d=hoistNestedExamParts(d);
  if(d.lesenParts?.length){
    d.lesenParts=dedupeModulePartsByTeil(d.lesenParts);
  }
  if(d.lesenParts||d.horenParts||d.schreibenParts||d.sprechenParts){
    d.goetheFormat=true;
    d.lang=d.lang||'de';
    sanitizeGoetheParts(d);
    attachContentProvenance(d);
    if(typeof normalizeExamStructure==='function'){
      d=normalizeExamStructure(d,{level:d.level||S.level});
    }
    if(!d.modules){
      const lv=d.level||'B1';
      d.modules={
        lesen:{title:'Lesen',time:lv==='A1'?'25 Minuten':'65 Minuten'},
        horen:{title:'Hörverstehen',time:lv==='A1'?'ca. 20 Minuten':'40 Minuten'},
        schreiben:{title:'Schreiben',time:lv==='A1'?'20 Minuten':'60 Minuten'},
        sprechen:{title:'Sprechen',time:lv==='A1'?'ca. 15 Minuten':'15 Minuten (zwei Teilnehmende)'}
      };
    }
    if(!d.official){
      if(d.lang==='es'){
        const cert={A1:'DELE A1',A2:'DELE A2',B1:'DELE B1',B2:'DELE B2',C1:'DELE C1',C2:'DELE C2'};
        d.official={board:'Instituto Cervantes',certificate:cert[d.level]||'DELE',note:'Examen de práctica (generado por IA). Formato oficial DELE '+d.level+'.'};
      }else{
        const cert={A1:'Start Deutsch 1',A2:'Start Deutsch 2',B1:'Goethe-Zertifikat B1',B2:'Goethe-Zertifikat B2',C1:'Goethe-Zertifikat C1',C2:'Goethe-Zertifikat C2'};
        d.official={board:'Goethe-Institut',certificate:cert[d.level]||'Goethe-Zertifikat',note:'Modellsatz (KI-generiert). Aufgabentypen basieren auf dem offiziellen Goethe-Zertifikat '+d.level+'.'};
      }
    }
  }
  return d;
}
function getPartPostprocess(){
  if(typeof PartPostprocess!=='undefined')return PartPostprocess;
  return null;
}
/** Drop duplicate ad assignments (keep first; "0" may repeat). Mirrors partQualityGate. */
function discardDuplicateAdItems(items){
  const seen=new Set();
  const kept=[];
  const removed=[];
  for(const it of(items||[])){
    const k=String(Array.isArray(it.correct)?it.correct[0]:it.correct).toUpperCase();
    if(k==='0'||k===''){
      kept.push(it);
      continue;
    }
    if(seen.has(k))removed.push(it);
    else{
      seen.add(k);
      kept.push(it);
    }
  }
  return{kept,removed};
}
function balanceQuestionList(questions){
  const pp=getPartPostprocess();
  if(!pp||!Array.isArray(questions)||!questions.length)return 0;
  return pp.balanceAnswerPositions(questions).changed||0;
}
/** Balance MCQ keys + dedupe Lesen Teil 3 ads (same gates as exam-part.js). */
function applyPersonalExamPostprocess(d){
  if(!d||typeof d!=='object')return d;
  const pp=getPartPostprocess();
  if(!pp)return d;
  let balanced=0;
  const walkQuestions=(qs)=>{
    if(!Array.isArray(qs)||!qs.length)return;
    balanced+=balanceQuestionList(qs);
  };
  const fixAdsPart=(part)=>{
    if(!isLesenAdsMatchingPart(part))return;
    const items=part.items;
    if(!Array.isArray(items)||!items.length)return;
    const check=pp.validateAdsUnique(items);
    if(check.ok)return;
    const{kept,removed}=discardDuplicateAdItems(items);
    if(!kept.length){
      lcDebug.warn('[exam] ads dedupe would wipe Teil',part.teil,'— keeping original items');
      return;
    }
    part.items=kept;
    if(removed.length){
      part._adsDuplicatesStripped=(part._adsDuplicatesStripped||0)+removed.length;
    }
  };
  const normalizePartQuestions=(part)=>{
    (part.questions||[]).forEach(q=>normalizeQuestionTypeField(q,part));
    (part.items||[]).forEach(q=>normalizeQuestionTypeField(q,part));
    (part.segments||[]).forEach(seg=>(seg.questions||[]).forEach(q=>normalizeQuestionTypeField(q,part,seg)));
  };
  (d.lesenParts||[]).forEach(part=>{
    normalizePartQuestions(part);
    walkQuestions(part.questions);
    walkQuestions((part.items||[]).filter(it=>{
      const t=String(it.type||'').toLowerCase();
      return t==='multiple'||t==='multiple_choice';
    }));
    fixAdsPart(part);
    (part.segments||[]).forEach(seg=>walkQuestions(seg.questions));
  });
  (d.horenParts||[]).forEach(part=>{
    normalizePartQuestions(part);
    walkQuestions(part.questions);
    (part.segments||[]).forEach(seg=>walkQuestions(seg.questions));
  });
  if(balanced)d._answerPositionsBalanced=balanced;
  if(typeof ExamRenumber!=='undefined'&&ExamRenumber.renumberExam){
    ExamRenumber.renumberExam(d);
  }
  return d;
}
function normalizeExam(d,opts){
  if(!d||typeof d!=='object')return null;
  const lang=typeof resolveExamLang==='function'?resolveExamLang(d,S.subject):(d.lang==='de'?'de':d.lang==='es'?'es':'en');
  d={...d,level:d.level||S.level,lang};
  if(lang==='es'){
    d=typeof normalizeSpanishExam==='function'?normalizeSpanishExam(d):d;
  }else if(d.readingParts||d.listeningParts){
    d=normalizeCambridgeExam(d);
  }
  let out=normalizeGoetheExam(d);
  const skipPost=!!((opts&&opts.skipPostprocess)||d._skipAnswerBalance);
  if(!skipPost)out=applyPersonalExamPostprocess(out);
  return out;
}
function goethePartHasContent(part,mod){
  if(!part||typeof part!=='object')return false;
  if(mod==='lesen')return!!(part.items?.length||part.text||part.ads?.length||part.questions?.length||part.opinions?.length||part.textWithGaps?.length||part.persons?.length);
  if(mod==='horen')return!!(part.segments?.length||part.questions?.length||part.noteFields?.length||part.transcript);
  if(mod==='schreiben')return!!(part.task||part.instruction||part.prompt);
  if(mod==='sprechen')return!!(part.situation||part.points?.length||part.prompts?.length||part.examinerQuestions?.length||part.cardText||part.task);
  return false;
}
function isExamBlueprintComplete(d){
  if(!d||typeof d!=='object')return false;
  if(d.demo||d.guidedDemo||d.vocabPersonal)return true;
  if(d.blueprintComplete===true)return true;
  if(d.blueprintComplete===false)return false;
  if(Array.isArray(d.blueprintCoverage)&&d.blueprintCoverage.length){
    return d.blueprintCoverage.every(c=>c.complete);
  }
  if(d.goetheFormat){
    const mods=['lesen','horen','schreiben','sprechen'];
    return mods.every(m=>{
      const parts=d[m+'Parts']||[];
      return parts.some(p=>goethePartHasContent(p,m));
    });
  }
  return true;
}
function isExamRenderable(d){
  if(!d||typeof d!=='object')return false;
  if(d.goetheFormat){
    const lp=(d.lesenParts||[]).some(p=>goethePartHasContent(p,'lesen'));
    const hp=(d.horenParts||[]).some(p=>goethePartHasContent(p,'horen'));
    const sp=(d.sprechenParts||[]).some(p=>goethePartHasContent(p,'sprechen'));
    const wp=(d.schreibenParts||[]).some(p=>goethePartHasContent(p,'schreiben'));
    if(d.vocabPersonal||d.libraryBuilt)return lp||hp||sp||wp;
    return lp&&hp;
  }
  if(d.readingParts?.length||d.listeningParts?.length||d.lesenParts?.length||d.horenParts?.length){
    const rp=(d.readingParts||d.lesenParts||[]).some(p=>p&&(p.text||p.items?.length||p.questions?.length||p.parts?.length));
    const lp=(d.listeningParts||d.horenParts||[]).some(p=>p&&(p.text||p.transcript||p.segments?.length||p.questions?.length));
    return rp||lp;
  }
  if(d.lesen?.text&&Array.isArray(d.lesen.questions)&&d.lesen.questions.length)return true;
  if(d.horen&&Array.isArray(d.horen.questions)&&d.horen.questions.length)return true;
  if(d.schreiben?.task)return true;
  if(d.sprechen&&Array.isArray(d.sprechen.points)&&d.sprechen.points.length)return true;
  if(d.gapfill&&Array.isArray(d.gapfill.sentences)&&d.gapfill.sentences.length)return true;
  return false;
}
function showExamError(e){
  backToWorkspace('exams');
  if(e.code==='quota_exceeded'){showQuotaExceededModal(e);return;}
  if(e.code==='ai_credits_exhausted'){
    if(typeof showAiCreditsExhausted==='function')showAiCreditsExhausted(e);
    else lcToast('Not enough AI credits for this exam (3 required).','warn',6000);
    return;
  }
  if(e.code==='timeout'||e.code==='gateway_timeout'){
    lcToast('Exam generation timed out. Please try again in 30 seconds.','warn',5000);
    return;
  }
  if(e.code==='exam_low_quality'){
    lcToast('AI returned low-quality content. Please try again — it usually works on the second attempt.','warn',5000);
    return;
  }
  if(e.code==='exam_invalid'){
    lcToast('AI returned an exam with invalid answer keys. Please try again.','warn',5000);
    return;
  }
  if(e.code==='exam_incomplete'){
    lcToast('We couldn\'t assemble a complete exam right now. Please try again later.','error',6000);
    return;
  }
  const msg=e.message||'Unknown error';
  if(/json|parse|unterminated/i.test(msg)){
    lcToast('AI returned incomplete data. Please try again.','error',5000);
    return;
  }
  lcToast(`Error generating exam: ${msg}`,'error',5000);
}
async function startQuick(mod){
  if(!S.subject)S.subject='de';
  if(!S.level)S.level='B1';
  if(typeof isQuickModuleAllowed==='function'&&!isQuickModuleAllowed(S.subject,S.level)){
    backToWorkspace('exams');
    lcToast(typeof LevelAvailability!=='undefined'?LevelAvailability.quickModulesUnavailableMessage(S.subject,S.level):'Quick modules are not available for this level yet.','warn',7000);
    return;
  }
  S.quickMod=mod;S.answers={};S.gapAnswers={};
  hideAll();show('loadingScreen');
  document.getElementById('loaderTitle').textContent='Generating quick module…';
  document.getElementById('loaderSub').textContent='One module, instant results — free, no quota used';
  const topic=await pickTopicForSubject();
  const prepMsg='Content is being prepared for this level. Try another language/level.';
  try{
    if(!engineReady())throw new Error('Content engine not loaded');
    const skillMap={reading:['lesen'],listening:['horen'],writing:['schreiben'],gapfill:['lesen']};
    const skills=skillMap[mod]||['lesen'];
    if(typeof QuestionLibrary!=='undefined'&&QuestionLibrary.hasLibrary(S.subject,S.level)){
      S.examData=await QuestionLibrary.buildExam(S.subject,S.level,{skills});
      S.examData=stripExamToSkills(S.examData,skills);
      S.examData.quickMod=mod;
      S.examSource='question-library';
      if(typeof normalizeExam==='function')S.examData=normalizeExam(S.examData);
      renderExam();
      return;
    }
    if(typeof liveAiDisabled==='function'&&liveAiDisabled(S.subject,S.level)){
      backToWorkspace('exams');
      lcToast(prepMsg,'warn',6000);
      return;
    }
    S.examData=await LexiCoilEngine.generateQuickExercise(S.subject,S.level,mod,topic,getGeneratorHooks());
    S.examSource='ai';
    if(typeof normalizeExam==='function')S.examData=normalizeExam(S.examData);
    renderExam();
    if(S.examSource==='ai'&&!S.examData.vocabPersonal&&!S.examData.reusedItems){
      void contributeExamToStaging(S.subject,S.level,S.examData.topic||genericPoolTopic(S.subject,S.level),S.examData,{minCoverage:0});
    }
  }catch(e){backToWorkspace('exams');lcToast('Quick module failed: '+e.message,'error');}
}

// ═══════════════════════════════════════════
// EXAM GENERATION — LexiCoil engine v2
// ═══════════════════════════════════════════
const EXAM_PART_KEYS=['lesenParts','horenParts','schreibenParts','sprechenParts','readingParts','listeningParts','writingParts','speakingParts'];
function extractJsonBlock(raw){
  let s=String(raw).replace(/```json\s*|```/gi,'').trim();
  const start=s.indexOf('{');
  if(start<0)throw new Error('No JSON object in AI response');
  s=s.slice(start);
  let depth=0,inStr=false,esc=false;
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(inStr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')inStr=false;continue;}
    if(c==='"')inStr=true;
    else if(c==='{')depth++;
    else if(c==='}'){depth--;if(depth===0)return s.slice(0,i+1);}
  }
  return s;
}
function salvageJson(text){
  /** @deprecated Prefer structured engine output (phase 03); kept for legacy AI JSON repair. */
  let json=extractJsonBlock(text);
  for(let n=0;n<24;n++){
    try{return JSON.parse(json);}catch(e){
      if(!/unterminated|unexpected end|position/i.test(e.message))throw e;
      const ob=(json.match(/\{/g)||[]).length-(json.match(/\}/g)||[]).length;
      const oa=(json.match(/\[/g)||[]).length-(json.match(/\]/g)||[]).length;
      if(ob>0||oa>0){json=json.replace(/,\s*$/,'')+']'.repeat(Math.max(0,oa))+'}'.repeat(Math.max(0,ob));continue;}
      const cut=json.lastIndexOf(',');
      if(cut>10)json=json.slice(0,cut);else throw e;
    }
  }
  throw new Error('Could not parse AI JSON');
}
function parseExamJson(raw){return salvageJson(raw);}
function moduleKeyFromPartKey(key){
  return String(key||'')
    .replace(/Parts$/,'')
    .replace(/^reading$/,'lesen')
    .replace(/^listening$/,'horen')
    .replace(/^writing$/,'schreiben')
    .replace(/^speaking$/,'sprechen');
}
function mergeTwoLesenPartsByTeil(prev,p){
  const ER=typeof ExamRenumber!=='undefined'?ExamRenumber:null;
  const teil=Number(p.teil??prev.teil);
  const nPrev=(prev.items?.length||0)+(prev.questions?.length||0);
  const nP=(p.items?.length||0)+(p.questions?.length||0);
  const primary=nP>=nPrev?p:prev;
  const merged={...prev,...p,teil,items:ER?.mergeItemsById?ER.mergeItemsById(prev.items,p.items):[...(prev.items||[]),...(p.items||[])]};
  merged.textTitle=primary.textTitle||prev.textTitle||p.textTitle;
  merged.instruction=primary.instruction||prev.instruction||p.instruction;
  merged.blueprintSlot=primary.blueprintSlot||prev.blueprintSlot;
  merged.slotType=primary.slotType||prev.slotType;
  if(Number(teil)===3||isLesenAdsMatchingPart(primary)||isLesenAdsMatchingPart(prev)){
    merged.ads=(primary.ads?.length?primary.ads:null)||prev.ads||p.ads;
  }else{
    delete merged.ads;
  }
  if(isLesenForumOpinionsPart(merged)){
    merged.questions=(merged.questions||[]).filter(q=>!q.signText&&!q.text);
  }
  return merged;
}
function dedupeModulePartsByTeil(parts){
  if(!parts?.length)return parts||[];
  const byTeil=new Map();
  const orphans=[];
  for(const p of parts){
    const t=Number(p.teil);
    if(!Number.isFinite(t)){orphans.push(p);continue;}
    const prev=byTeil.get(t);
    if(!prev){byTeil.set(t,p);continue;}
    byTeil.set(t,mergeTwoLesenPartsByTeil(prev,p));
  }
  return[...[...byTeil.entries()].sort((a,b)=>a[0]-b[0]).map(([,p])=>p),...orphans];
}
function mergeExamParts(...parts){
  const topic=parts[parts.length-1];
  const chunks=parts.slice(0,-1);
  let merged={};
  const ER=typeof ExamRenumber!=='undefined'?ExamRenumber:null;
  for(const part of chunks){
    const keys=Object.keys(part).filter(k=>EXAM_PART_KEYS.includes(k));
    lcDebug.log('[merge] chunk keys:',keys,keys.map(k=>Array.isArray(part[k])?part[k].length+' items':typeof part[k]));
    for(const[k,v]of Object.entries(part)){
      if(k==='targetUsage'&&Array.isArray(v)&&Array.isArray(merged[k]))merged[k]=[...(merged[k]||[]),...v];
      else if(EXAM_PART_KEYS.includes(k)&&Array.isArray(v)){
        if(ER?.mergeTeilPart){
          for(const p of v){
            const mod=moduleKeyFromPartKey(k);
            if(p&&p.teil!=null&&Number.isFinite(Number(p.teil))){
              ER.mergeTeilPart(merged,{[k]:[p]},mod,Number(p.teil),null);
            }else{
              merged[k]=[...(merged[k]||[]),p];
            }
          }
        }else{
          merged[k]=[...(merged[k]||[]),...v];
        }
      }
      else if(!(k in merged)||typeof v!=='object'||v===null||Array.isArray(v))merged[k]=v;
      else if(k==='modules')merged[k]={...merged[k],...v};
    }
  }
  for(const k of EXAM_PART_KEYS){
    if(Array.isArray(merged[k]))merged[k]=dedupeModulePartsByTeil(merged[k]);
  }
  lcDebug.log('[merge] final keys:',Object.keys(merged).filter(k=>EXAM_PART_KEYS.includes(k)).map(k=>k+':'+(Array.isArray(merged[k])?merged[k].length:'?')));
  for(const k of EXAM_PART_KEYS){
    if(!Array.isArray(merged[k]))continue;
    merged[k].forEach(p=>{
      if(Number(p.teil)===4&&p.items?.length){
        lcDebug.log('[merge] lesen teil4 items:',p.items.length,'ids:',p.items.map(i=>i.id).join(','));
      }
    });
  }
  return{...merged,topic:merged.topic||topic,level:merged.level||S.level,lang:merged.lang||S.subject};
}
function normalizeChunkObj(chunk,obj){
  if(!obj||Array.isArray(obj))return obj;
  const key=chunk.expectKey;
  if(obj.parts&&Array.isArray(obj.parts)&&key){
    const o={topic:obj.topic,level:obj.level,lang:obj.lang};
    o[key]=obj.parts;
    return o;
  }
  if(key==='lesenParts'&&(obj.teil1||obj.teil2)){
    return{...obj,lesenParts:[obj.teil1,obj.teil2].filter(Boolean)};
  }
  if(key&&obj[key]&&!Array.isArray(obj[key])&&typeof obj[key]==='object'){
    obj={...obj,[key]:[obj[key]]};
  }
  if((key==='horenParts'||key==='listeningParts')&&!obj[key]&&(obj.segments||obj.transcript||obj.noteFields)){
    obj={...obj,[key]:[{...obj}]};
  }
  if(key==='lesenParts'&&!obj[key]&&(obj.items||obj.text||obj.questions)){
    obj={...obj,lesenParts:[{...obj}]};
  }
  if(key==='readingParts'&&!obj[key]&&(obj.items||obj.text||obj.questions)){
    obj={...obj,readingParts:[{...obj}]};
  }
  return obj;
}
function validateChunkObj(chunk,obj){
  obj=normalizeChunkObj(chunk,obj);
  if(!obj||Array.isArray(obj)||typeof obj!=='object')throw new Error('chunk not an object');
  const key=chunk.expectKey;
  if(key&&Array.isArray(obj[key])){
    for(const p of obj[key]){
      if(Number(p?.teil)===2&&typeof LesenPassageIntegrity!=='undefined'){
        normalizeLesenT2Part(p);
        if(!LesenPassageIntegrity.lesenT2PartIsValid(p)){
          throw new Error('lesen_teil2_invalid_passages');
        }
      }
    }
  }
  if(!key)return obj;
  if(Array.isArray(obj[key])&&obj[key].length>0)return obj;
  if(Array.isArray(obj[key])&&obj[key].length===0){
    lcDebug.warn('[exam] chunk returned empty array for',key,'— accepting anyway');
    return obj;
  }
  const aliases={
    horenParts:['listeningParts','audioparts','listening','horen'],
    listeningParts:['horenParts','audioparts','listening','horen'],
    lesenParts:['readingParts','reading','lesen'],
    readingParts:['lesenParts','reading','lesen'],
    schreibenParts:['writingParts','writing','schreiben'],
    writingParts:['schreibenParts','writing','schreiben'],
    sprechenParts:['speakingParts','speaking','sprechen'],
    speakingParts:['sprechenParts','speaking','sprechen'],
  };
  for(const alt of(aliases[key]||[])){
    if(Array.isArray(obj[alt])&&obj[alt].length>0){
      lcDebug.warn('[exam] chunk used alias',alt,'for',key,'— remapping');
      obj[key]=obj[alt];
      return obj;
    }
  }
  throw new Error('missing '+key);
}
function getGeneratorHooks(onStep,hookOpts){
  hookOpts=hookOpts||{};
  let ticketMaxChunks=8;
  let activeGenTicket=null;
  return{
    callAI,
    onStep:onStep||((msg)=>{
      const el=document.getElementById('loaderSub');
      if(el&&msg)el.textContent=msg;
    }),
    onChunkResult:hookOpts.onChunkResult||(()=>{}),
    parseExamJson,
    validateChunkObj,
    mergeExamParts,
    startExamTicket:async(scope,maxChunks)=>{
      ticketMaxChunks=maxChunks||ticketMaxChunks;
      activeGenTicket=await startExamGeneration(scope,maxChunks);
      if(typeof S!=='undefined')S._activeGenTicket=activeGenTicket;
      return activeGenTicket;
    },
    refreshExamTicket:async(_scope,_maxChunks)=>{
      if(!activeGenTicket)throw new Error('no active generation ticket');
      if(typeof renewExamGeneration==='function'){
        activeGenTicket=await renewExamGeneration(activeGenTicket);
      }
      if(typeof S!=='undefined')S._activeGenTicket=activeGenTicket;
      return activeGenTicket;
    },
    releaseExamGeneration,
    normalizeExam:typeof normalizeExam==='function'?normalizeExam:(x)=>x
  };
}
async function refundActiveGenTicket(){
  const ticket=(typeof S!=='undefined'&&S._activeGenTicket)||(S.examData&&S.examData._genTicket);
  if(!ticket||typeof releaseExamGeneration!=='function')return null;
  try{
    const rel=await releaseExamGeneration(ticket);
    if(typeof S!=='undefined'){
      S._activeGenTicket=null;
      if(S.examData)delete S.examData._genTicket;
    }
    return rel;
  }catch(err){
    lcDebug.warn('[personal] quota refund failed:',err);
    return null;
  }
}
const PERSONAL_MODULE_ORDER=['lesen','horen','schreiben','sprechen'];
function orderedPersonalSkills(skills){
  const set=new Set((skills||[]).map(s=>String(s).toLowerCase()));
  return PERSONAL_MODULE_ORDER.filter(s=>set.has(s));
}
function personalModuleLabel(skill,subject){
  const ui=typeof examUiStrings==='function'?examUiStrings(subject==='de'?'de':subject==='es'?'es':'en'):{reading:'Reading',listening:'Listening',writing:'Writing',speaking:'Speaking'};
  if(skill==='lesen')return ui.reading;
  if(skill==='horen')return ui.listening;
  if(skill==='schreiben')return ui.writing;
  if(skill==='sprechen')return ui.speaking;
  return skill;
}
function renderPersonalGenProgress(report){
  const el=document.getElementById('personalGenProgress');
  if(!el)return;
  if(!report||(!report.modules?.length&&!report.teile?.length)){
    el.style.display='none';
    el.innerHTML='';
    return;
  }
  el.style.display='block';
  const modLines=(report.modules||[]).map(m=>{
    const lbl=personalModuleLabel(m.skill,S.subject);
    const cls=m.ok?'ok':'fail';
    const note=m.ok?'✓':'✗ skipped';
    return `<li class="${cls}">${esc(lbl)} — ${note}</li>`;
  }).join('');
  const teileLines=(report.teile||[]).map(t=>{
    const cls=t.status==='ok'?'ok':'fail';
    const mark=t.status==='ok'?'✓':'✗';
    return `<li class="${cls}">${mark} ${esc(t.label)}</li>`;
  }).join('');
  el.innerHTML=`<ul class="personal-gen-progress__list">${modLines}${teileLines}</ul>`;
}
function updatePersonalLoader(moduleIdx,moduleTotal,moduleLabel,report){
  const title=document.getElementById('loaderTitle');
  const sub=document.getElementById('loaderSub');
  if(title)title.textContent=`Generating ${moduleLabel}… (${moduleIdx}/${moduleTotal})`;
  if(sub)sub.textContent='This may take ~1–2 min per module.';
  renderPersonalGenProgress(report);
}
function personalGenFailMessage(err){
  if(err?.quotaReleased){
    return 'Could not generate the exam. Your monthly credit has been refunded — it does not count as a generated exam.';
  }
  const modErr=err?.genReport?.modules?.find(m=>!m.ok)?.error;
  const detail=modErr||err?.message||'Generation failed';
  return `Could not generate the exam: ${detail}. If your quota still looks deducted, reload the page; it should have been refunded automatically.`;
}
function initPersonalGenReport(skills){
  return{skills:[...skills],modules:[],teile:[],failedModules:[],failedTeile:[],succeededTeile:[]};
}
function recordPersonalChunkResult(report,skill,chunkResult){
  if(!report||!chunkResult)return;
  report.teile.push({skill,label:chunkResult.label,status:chunkResult.status});
  if(chunkResult.status==='ok')report.succeededTeile.push(chunkResult.label);
  else report.failedTeile.push(chunkResult.label);
}
function storePersonalGenRetry(words,skills,goalId,exam,report){
  S.personalGenRetry={
    words:[...(words||[])],
    skills:[...(skills||[])],
    goalId:goalId||S.activeGoalId,
    partialExam:exam?JSON.parse(JSON.stringify(exam)):null,
    failedModules:[...(report?.failedModules||[])],
    failedTeile:[...(report?.failedTeile||[])],
    succeededTeile:[...(report?.succeededTeile||[])]
  };
}
async function generatePersonalExamAiSerial(configWords,configSkills,configGoalId,personalGenOpts,tier){
  if(!isAllowLiveGenEnabled()){
    throw Object.assign(new Error(liveAiGenerationBlockedMessage()),{code:'live_gen_disabled'});
  }
  let skills=orderedPersonalSkills(configSkills);
  if(skills.length>1){
    lcDebug.warn('[personal] multiple modules requested — using first only:',skills);
    skills=skills.slice(0,1);
  }
  if(!skills.length)throw new Error('No modules selected.');
  let accumulated=null;
  const report=initPersonalGenReport(skills);
  let anyQuotaReleased=false;
  let blueprint=personalGenOpts.blueprint;
  for(let i=0;i<skills.length;i++){
    const skill=skills[i];
    const label=personalModuleLabel(skill,S.subject);
    updatePersonalLoader(i+1,skills.length,label,report);
    if(i>0&&typeof canUseAiGeneration==='function'&&!canUseAiGeneration()){
      report.failedModules.push(skill);
      report.modules.push({skill,ok:false,error:'ai_credits_exhausted'});
      continue;
    }
    const hooks=getGeneratorHooks(
      (msg)=>{const el=document.getElementById('loaderSub');if(el&&msg)el.textContent=msg;},
      {onChunkResult:(r)=>recordPersonalChunkResult(report,skill,r)}
    );
    try{
      if((skill==='horen'||skill==='listening')&&!blueprint&&typeof ExamBlueprint!=='undefined'){
        try{blueprint=await ExamBlueprint.load(S.subject,S.level);}catch(_){}
      }
      if(skill==='horen'||skill==='listening'){
        accumulated=await preloadHorenPoolFirstTeils(accumulated,S.subject,S.level,blueprint);
      }
      if(skill==='lesen'||skill==='reading'){
        accumulated=await preloadLesenPoolFirstTeils(accumulated,S.subject,S.level,blueprint);
      }
      const exam=await LexiCoilEngine.generatePersonalExam(
        S.subject,S.level,configWords,[skill],hooks,
        {...personalGenOpts,blueprint,poolServedTeils:poolServedTeilsSpec(accumulated)}
      );
      report.modules.push({skill,ok:true});
      const topic=accumulated?.topic||exam.topic||'Personal vocabulary review';
      accumulated=accumulated?mergeExamParts(accumulated,exam,topic):exam;
      if(exam._genTicket&&typeof S!=='undefined')S._activeGenTicket=exam._genTicket;
    }catch(modErr){
      if(modErr.quotaReleased)anyQuotaReleased=true;
      report.failedModules.push(skill);
      report.modules.push({skill,ok:false,error:modErr.message});
      if(modErr.chunkMeta?.failed)report.failedTeile.push(...modErr.chunkMeta.failed);
      lcDebug.warn('[personal] module failed:',skill,modErr);
    }
  }
  renderPersonalGenProgress(report);
  if(!accumulated){
    const rel=await refundActiveGenTicket();
    throw Object.assign(new Error('All selected modules failed to generate.'),{
      code:'all_modules_failed',
      genReport:report,
      quotaReleased:!!rel?.released||anyQuotaReleased
    });
  }
  if(typeof isExamRenderable==='function'&&!isExamRenderable(accumulated)){
    const rel=await refundActiveGenTicket();
    throw Object.assign(new Error('No usable exam parts were generated.'),{
      code:'all_modules_failed',
      genReport:report,
      quotaReleased:!!rel?.released||anyQuotaReleased
    });
  }
  accumulated.vocabSkills=configSkills;
  if(report.failedTeile.length||report.failedModules.length){
    accumulated._partialGen=true;
    accumulated._failedTeile=[...new Set(report.failedTeile)];
    accumulated._succeededTeile=[...new Set(report.succeededTeile)];
    accumulated._genReport=report;
  }
  return{exam:accumulated,source:'ai',genReport:report};
}
function parseTeilNumbersFromGenLabels(labels){
  const out=[];
  for(const lbl of labels||[]){
    const s=String(lbl);
    const m=s.match(/Teil\s*(\d+)/i);
    if(m)out.push(Number(m[1]));
  }
  return[...new Set(out.filter(Number.isFinite))];
}
async function retryFailedPersonalParts(){
  const st=S.personalGenRetry;
  if(!st){lcToast('Nothing to retry.','warn');return;}
  if(!canGenerate()){showUpgrade();return;}
  const failedTeilNums=parseTeilNumbersFromGenLabels(st.failedTeile);
  let skills;
  if(failedTeilNums.length){
    skills=orderedPersonalSkills(st.skills).slice(0,1);
  }else if(st.failedModules.length){
    skills=st.failedModules;
  }else{
    skills=orderedPersonalSkills(st.skills).filter(s=>!(st.partialExam&&personalModuleHasContent(st.partialExam,s)));
  }
  if(!skills.length){lcToast('All parts already generated.','info');return;}
  hideAll();show('loadingScreen');
  document.getElementById('loaderTitle').textContent='Retrying failed parts…';
  const useHybrid=isPersonalLesenHybridEnabled(skills,S.subject,S.level);
  document.getElementById('loaderSub').textContent=useHybrid
    ?'Hybrid retry: pool + Gemini factory…'
    :'This may take ~1–2 min per module.';
  try{
    const personalGenOpts={
      teilFilter:failedTeilNums.length?failedTeilNums:(S.lastPersonalConfig?.teilFilter??_examConfig.teilChoice??'all'),
      topic:st.partialExam?.topicTag||st.partialExam?.topic,
    };
    if(typeof ExamBlueprint!=='undefined'){
      try{const bp=await ExamBlueprint.load(S.subject,S.level);if(bp)personalGenOpts.blueprint=bp;}catch(_){}
    }
    const built=useHybrid
      ?await generatePersonalLesenHybrid(st.words,personalGenOpts,'pro')
      :await generatePersonalExamAiSerial(st.words,skills,st.goalId,personalGenOpts,'pro');
    let exam=built.exam;
    if(st.partialExam){
      exam=mergeExamParts(st.partialExam,built.exam,st.partialExam.topic||built.exam.topic);
      exam.vocabSkills=st.skills;
    }
    const goalRef=st.goalId?S.goals.find(g=>g.id===st.goalId):getActiveGoal();
    await finalizePersonalExam(st.words,st.skills,st.goalId,goalRef,exam,built.source);
  }catch(e){
    hideAll();
    if(e.code==='exam_invalid'&&e.answerKeyVerify){
      S.examData=null;
      goHome();
      lcToast('Answer-key verification failed. The AI exam was rejected and was not saved to the pool. Try generating again.','error',8000);
      return;
    }
    goHome();
    lcToast('Retry failed: '+e.message,'error',6000);
  }
}
function personalModuleHasContent(exam,skill){
  if(!exam)return false;
  const keys={
    lesen:['lesenParts','lesen'],
    horen:['horenParts','horen'],
    schreiben:['schreibenParts','schreiben'],
    sprechen:['sprechenParts','sprechen']
  }[skill]||[];
  return keys.some(k=>Array.isArray(exam[k])&&exam[k].length>0);
}
window.retryFailedPersonalParts=retryFailedPersonalParts;
function engineReady(){
  return typeof LexiCoilEngine!=='undefined'&&typeof KnowledgeEngine!=='undefined'&&typeof PromptBuilder!=='undefined'&&typeof LexiCoilDomain!=='undefined';
}
async function generateExamChunks(topic,onStep){
  if(!engineReady())throw new Error('Content engine not loaded');
  const specExtra={};
  const genOpts={};
  const bpEnabled=typeof ExamGenerator!=='undefined'&&ExamGenerator.aiPathBlueprintsEnabled?.();
  if(bpEnabled&&typeof ExamBlueprint!=='undefined'){
    try{
      const bp=await ExamBlueprint.load(S.subject,S.level);
      if(bp){
        specExtra.metadata={blueprint:bp};
        genOpts.useBlueprint=true;
      }
    }catch(bpErr){lcDebug.warn('[exam] blueprint preload failed:',bpErr);}
  }
  return LexiCoilEngine.generateExam(S.subject,S.level,topic,getGeneratorHooks(onStep),{specExtra,...genOpts});
}
const POOL_COVERAGE_THRESHOLD=0.8;
const POOL_CONTRIBUTE_COVERAGE=0.6;
function applyPersonalTargetUsage(exam,words){
  if(!exam||!words?.length)return exam;
  if(typeof TargetUsage!=='undefined')TargetUsage.applyVerified(exam,words);
  return exam;
}
function lcVocabCoverage(exam,words){
  if(!exam||!words?.length)return {ratio:0,found:0,total:0};
  if(exam.targetUsageVerified?.length){
    const found=exam.targetUsageVerified.length;
    return {ratio:found/words.length,found,total:words.length};
  }
  if(Array.isArray(exam.targetUsage)&&exam.targetUsage.length&&typeof TargetUsage!=='undefined'){
    const verified=TargetUsage.verifyTargetUsage(exam,exam.targetUsage);
    const found=verified.length;
    return {ratio:found/words.length,found,total:words.length};
  }
  const blob=JSON.stringify(exam).toLowerCase();
  let found=0;
  words.forEach(w=>{
    if(blob.includes(String(w).toLowerCase()))found++;
  });
  return {ratio:found/words.length,found,total:words.length};
}
function lcExamHasPlaceholders(exam){
  const text=JSON.stringify(exam||{});
  const n=(text.match(/\.\.\.|Option [A-D]"|"Text here"|"Question here"|Ein Text ueber|Ein Text über|An article about/gi)||[]).length;
  return n>5;
}
function buildPoolExamCopy(exam,topic){
  const copy=JSON.parse(JSON.stringify(exam));
  delete copy.vocabPersonal;delete copy.vocabWords;delete copy.vocabSkills;
  delete copy.personalizedExam;delete copy.targetUsage;delete copy.targetUsageVerified;
  delete copy.goalId;delete copy._savedId;delete copy._flightId;
  delete copy.poolSource;delete copy.poolId;delete copy.guidedDemo;
  delete copy._partialGen;delete copy._chunkMeta;delete copy._genReport;
  delete copy._failedTeile;delete copy._succeededTeile;delete copy._prunedTeile;delete copy._genTicket;
  copy.topic=topic;
  return copy;
}
function examHasStorableParts(exam){
  if(!exam||typeof exam!=='object')return false;
  return['lesen','horen','schreiben','sprechen'].some(m=>{
    const arr=exam[m+'Parts'];
    return Array.isArray(arr)&&arr.some(p=>goethePartHasContent(p,m));
  });
}
/** Staging/reuse gate — section exams (Lesen-only, etc.) are valid; do not require full mock exam shape. */
function lcExamPassesStructuralGate(exam){
  if(!examHasStorableParts(exam))return false;
  if(lcExamHasPlaceholders(exam))return false;
  return true;
}
function lcValidatorStrict(){
  if(typeof window!=='undefined'&&window.LC_VALIDATOR_STRICT==='1')return true;
  return false;
}
function lcExamPassesValidator(exam,opts){
  if(typeof ExamValidator==='undefined')return true;
  const strict=opts?.strict??lcValidatorStrict();
  const r=new ExamValidator().validate(exam,{strict,blueprint:opts?.blueprint});
  if(!r.valid)lcDebug.warn('[exam] validation failed:',r.errors,r.warnings?.length?`(warnings: ${r.warnings.join(', ')})`:'');
  return r.valid;
}
function pruneEmptyGoetheParts(exam,skills){
  if(!exam||typeof exam!=='object')return exam;
  const mods=skills?.length?orderedPersonalSkills(skills):['lesen','horen','schreiben','sprechen'];
  for(const mod of mods){
    const key=mod+'Parts';
    if(!Array.isArray(exam[key]))continue;
    exam[key]=exam[key].filter(p=>goethePartHasContent(p,mod));
    if(!exam[key].length)delete exam[key];
  }
  return exam;
}
async function lcValidateExamOnServer(exam,opts){
  const isPartialFidelityCountIssue=(msg)=>/^(passages_per_part_mismatch:|items_total_mismatch:)/.test(String(msg||''));
  const isPartialPersonalValidationIssue=(msg)=>isPartialFidelityCountIssue(msg)||/^ads_example_missing:/.test(String(msg||''));
  const failUnavailable=(reason,extra={})=>({
    valid:false,
    skipped:true,
    errors:[reason||'validation_unavailable'],
    exam:undefined,
    ...extra,
  });
  try{
    const partialExam=!!(
      opts?.partialExam ||
      exam?._sectionPart ||
      exam?._partialGen ||
      exam?.vocabPersonal ||
      (Array.isArray(exam?.vocabSkills)&&exam.vocabSkills.length===1)
    );
    const fn=typeof lcApiFetch==='function'?lcApiFetch:fetch;
    const res=await fn('/.netlify/functions/claude-chat',{
      method:'POST',
      credentials:'include',
      headers:typeof aiAuthHeaders==='function'?aiAuthHeaders():{'Content-Type':'application/json'},
      body:JSON.stringify({
        validateExam:true,
        exam,
        partialExam,
        verifyAnswerKeys:!!(opts&&opts.verifyAnswerKeys),
        discardFailedItems:!!(opts&&opts.discardFailedItems),
      })
    });
    const data=await res.json().catch(()=>({}));
    if(res.status===503&&(data.error==='live_gen_disabled'||data.error==='verify_unavailable')){
      lcDebug.warn('[exam] server validation unavailable:',data.error,data.reason||data.message);
      return failUnavailable(data.error==='verify_unavailable'?'verify_unavailable':'live_gen_disabled');
    }
    if(res.ok&&data.valid){
      if(data.verifySkipped){
        lcDebug.warn('[exam] server validation skipped verification');
        return failUnavailable('verify_skipped');
      }
      return{
        valid:true,
        exam:data.exam||exam,
        discarded:Number(data.discarded)||0,
        skipped:false,
      };
    }
    if(res.status===422&&(data.error==='exam_invalid'||data.error==='exam_empty_after_verify')){
      const softOnly=partialExam&&Array.isArray(data.validationErrors)&&data.validationErrors.every(isPartialPersonalValidationIssue);
      if(!softOnly)lcDebug.warn('[exam] server validation rejected:',data.validationErrors||data.message);
      else lcDebug.log('[exam] partial fidelity warnings (non-blocking):',data.validationErrors);
      return{
        valid:softOnly,
        errors:data.validationErrors||[data.message],
        discarded:Number(data.discarded)||0,
        emptyAfterVerify:data.error==='exam_empty_after_verify',
        exam:softOnly?exam:undefined,
        skipped:false,
      };
    }
    lcDebug.warn('[exam] server validation unexpected response:',res.status,data.error||data.message);
    return failUnavailable(data.error||`http_${res.status}`);
  }catch(e){
    lcDebug.warn('[exam] server validation unavailable:',e.message);
    return failUnavailable(e.message||'validation_unavailable');
  }
}
function lcExamPassesQualityGate(exam,words,minCoverage){
  if(!exam||(typeof isExamRenderable==='function'&&!isExamRenderable(exam)))return false;
  if(!lcExamPassesValidator(exam))return false;
  if(lcExamHasPlaceholders(exam))return false;
  if(words?.length){
    const cov=lcVocabCoverage(exam,words);
    if(cov.ratio<(minCoverage??POOL_CONTRIBUTE_COVERAGE))return false;
  }
  return true;
}
function genericPoolTopic(lang,level){
  return `${certLbl(lang,level)} practice exam`;
}
async function contributeExamToStaging(lang,level,topic,exam,opts){
  if(!exam||exam.vocabPersonal||exam.vocabWords?.length||exam.reusedItems)return null;
  if(typeof saveExamPartsToStaging!=='function')return null;
  if(!lcExamPassesStructuralGate(exam))return null;
  const words=opts?.words;
  const minCov=opts?.minCoverage??0;
  const complete=typeof isExamBlueprintComplete==='function'&&isExamBlueprintComplete(exam);
  const passesQuality=lcExamPassesQualityGate(exam,words,minCov);
  const verified=!!(opts?.verified||(S.examSource==='ai'));
  try{
    const data=await saveExamPartsToStaging(lang,level,exam,{complete:complete&&passesQuality,autoApprove:false,verified});
    if(data?.error)lcDebug.warn('[staging] ingest rejected:',data.error,data.details);
    return data?.error ? data : data;
  }catch(err){lcDebug.warn('[staging] remote ingest failed:',err);return {error:err.message||'network'};}
}
async function contributeExamToPool(lang,level,topic,exam,opts){
  const directPool=typeof directPoolContribEnabled==='function'&&directPoolContribEnabled();
  let stagingResult=null;
  if(typeof S!=='undefined'&&S.examSource==='ai'&&!directPool){
    stagingResult=await contributeExamToStaging(lang,level,topic,exam,opts);
  }
  if(typeof lcStrategyBEnabled==='function'&&lcStrategyBEnabled()&&!directPool)return stagingResult;
  if(typeof saveExamToPool!=='function'||!exam)return;
  const words=opts?.words;
  const minCov=opts?.minCoverage??(words?.length?POOL_CONTRIBUTE_COVERAGE:0);
  if(!lcExamPassesQualityGate(exam,words,minCov))return;
  const clean=buildPoolExamCopy(exam,topic||genericPoolTopic(lang,level));
  try{await saveExamToPool(lang,level,clean.topic,clean);}catch(_){}
  return stagingResult;
}
window.contributeExamToPool=contributeExamToPool;
window.contributeExamToStaging=contributeExamToStaging;
window.lcVocabCoverage=lcVocabCoverage;
function logAiGeneration(payload){
  const fn=typeof lcApiFetch==='function'?lcApiFetch:fetch;
  void fn('/.netlify/functions/generation-log',{
    method:'POST',
    credentials:'include',
    headers:typeof aiAuthHeaders==='function'?aiAuthHeaders():{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  }).catch(()=>{});
}
window.logAiGeneration=logAiGeneration;
function stripExamToSkills(exam,skills){
  if(!exam||!skills?.length)return exam;
  const s=new Set(skills);
  if(exam.goetheFormat||S.subject==='de'||S.subject==='es'){
    if(!s.has('lesen')){exam.lesenParts=[];delete exam.lesen;}
    if(!s.has('horen')){exam.horenParts=[];delete exam.horen;}
    if(!s.has('schreiben')){exam.schreibenParts=[];delete exam.schreiben;}
    if(!s.has('sprechen')){exam.sprechenParts=[];delete exam.sprechen;}
  }else{
    if(!s.has('lesen')){exam.readingParts=[];delete exam.reading;}
    if(!s.has('horen')){exam.listeningParts=[];delete exam.listening;}
    if(!s.has('schreiben')){exam.writingParts=[];delete exam.writing;}
    if(!s.has('sprechen')){exam.speakingParts=[];delete exam.speaking;}
  }
  return exam;
}

async function generateWeaknessExam(goalId){
  const goal=goalId?S.goals.find(g=>g.id===goalId):getActiveGoal();
  if(!goal){showAddGoalWizard();return;}
  if(typeof requireProOnlyAction==='function'&&!requireProOnlyAction('personal_exam',{message:'Personalized weakness exams require Pro.'}))return;
  if(!canGenerate()){showUpgrade();return;}
  const servible=typeof isLevelServable==='function'&&isLevelServable(goal.subject,goal.level);
  if(typeof QuestionLibrary==='undefined'||(!QuestionLibrary.hasLibrary(goal.subject,goal.level)&&!servible)){
    lcToast('Personalized weakness exams require a servible question library for this level.','warn');return;
  }
  confirmQuotaUse(()=>runWeaknessExam(goal));
}
async function runWeaknessExam(goal){
  S.activeGoalId=goal.id;
  syncGoalToProfile(goal);
  saveGoals();
  S.subject=goal.subject;
  S.level=goal.level;
  S.mode='practice';
  S.isDemo=false;
  S.answers={};
  S.gapAnswers={};
  S.quickMod=null;
  initExamSession('practice');
  hideAll();
  show('loadingScreen');
  document.getElementById('loaderTitle').textContent='Building personalized exam…';
  document.getElementById('loaderSub').textContent='70% weakness focus · 30% mixed reinforcement (library, no AI)…';
  try{
    S.examData=await QuestionLibrary.buildWeaknessExam(goal.subject,goal.level,goal);
    S.examData.weaknessExam=true;
    S.examData.personalizedExam=!!S.examData.personalizedSplit;
    S.examData.goalId=goal.id;
    S.examSource='question-library';
    if(typeof normalizeExam==='function')S.examData=normalizeExam(S.examData);
    renderExam();
  }catch(e){
    hideAll();
    openGoalWorkspace(goal.id,'exams');
    lcToast('Weakness exam failed: '+e.message,'error',5000);
  }
}
async function launchHorenGame(words, lang, level, opts = {}){
  const creditCost=typeof listeningGameCreditCost==='function'?listeningGameCreditCost():2;
  hideAll();
  show('loadingScreen');
  const lt=document.getElementById('loaderTitle');
  const ls=document.getElementById('loaderSub');
  if(lt)lt.textContent=typeof vocabT==='function'?vocabT().preparingListening:'Preparing listening game…';
  if(ls)ls.textContent=typeof vocabT==='function'?vocabT().preparingListeningSub(creditCost):'AI is preparing short listening clips ('+creditCost+' credits)';
  let round=null;
  let usedAi=false;
  const canTryAi=typeof canUseListeningGame==='function'?canUseListeningGame():true;
  if(canTryAi&&typeof requireAiCredits==='function'&&requireAiCredits('listening_game',{message:'The listening game uses '+creditCost+' credits when AI audio is generated.'})){
    try{
      if(typeof generateListeningGameWithAI!=='function')throw new Error('Listening game unavailable');
      round=await generateListeningGameWithAI(words,{lang,level,topic:opts.topic||''});
      usedAi=round&&round.billed===true&&((round.rounds&&round.rounds.length)||round.passage);
    }catch(e){
      round=null;
      if(e.code==='ai_credits_exhausted'){
        if(typeof showAiCreditsExhausted==='function')showAiCreditsExhausted();
      }else if(typeof lcToast==='function'){
        lcToast(e.message||'Listening game unavailable. No credits were used.','warn',7000);
      }
    }
  }
  hide('loadingScreen');
  show('horenGameScreen');
  if(typeof applyHorenGameChrome==='function')applyHorenGameChrome();
  const el=document.getElementById('horenGameMount');
  if(!el||typeof HorenGame==='undefined'){lcToast('Listening game unavailable.','warn');return;}
  const uiLang=typeof resolveActiveVocabUiLang==='function'?resolveActiveVocabUiLang():(typeof resolveVocabUiLang==='function'?resolveVocabUiLang():'en');
  const pool=Array.isArray(opts.pool)?opts.pool:[];
  const hgHandlers={
    onComplete(result){
      if(typeof AnalyticsStore!=='undefined'&&typeof AnalyticsStore.recordWordResults==='function'){
        try{AnalyticsStore.recordWordResults((typeof getActiveGoal==='function')?getActiveGoal():null, result.detail);}catch(_){}
      }
      const g=(typeof getActiveGoal==='function')?getActiveGoal():null;
      const rot=S._hgActivityWords||[];
      if(g&&rot.length&&typeof VocabBatching!=='undefined'&&VocabBatching.recordActivityUsage){
        VocabBatching.recordActivityUsage(g,'listening_game',rot);
        S._hgActivityWords=null;
      }
    },
    onExit(){exitHorenGame();},
  };
  function legacyRoundFromClient(r){
    return{
      roundIndex:1,
      passage:r.passage,
      displayWords:r.displayWords,
      appeared:r.appeared,
      absent:r.absent,
      audioBase64:r.audioBase64,
      audioMime:r.audioMime,
      valid:true,
    };
  }
  if(round&&(round.rounds?.length||round.passage)){
    const aiRounds=round.rounds?.length?round.rounds:[legacyRoundFromClient(round)];
    const hgConfig={
      rounds:aiRounds,
      aiSession:true,
      mode:'ai',
      topic:round.topic,
      lang,
      level,
      pool,
      uiLang,
    };
    S._hgLastConfig=hgConfig;
    S._hgLastHandlers=hgHandlers;
    HorenGame.mountAiSession(el, hgConfig, hgHandlers);
    const goal=(typeof getActiveGoal==='function')?getActiveGoal():null;
    if(usedAi&&typeof SavedListeningGames!=='undefined'&&SavedListeningGames.persistAfterGeneration){
      SavedListeningGames.persistAfterGeneration({
        goal,
        lang,
        level,
        topic:round.topic||opts.topic||'',
        rounds:aiRounds,
        words,
        pool,
        uiLang,
      });
    }
    return;
  }
  if(typeof lcToast==='function'){
    lcToast('Free listening: 3 word rounds (browser TTS). AI mode needs netlify dev + API keys.','warn',7000);
  }
  const sessionConfig={words,lang,level,pool,uiLang,sessionRounds:3,sessionMode:true};
  S._hgLastConfig=sessionConfig;
  S._hgLastHandlers=hgHandlers;
  HorenGame.mountSession(el, sessionConfig, hgHandlers);
}
function exitHorenGame(){
  if(typeof backToWorkspace==='function')backToWorkspace('vocabulary');
  else if(typeof goHome==='function')goHome();
}
function startHorenGameFromHub(){
  const goal=(typeof getActiveGoal==='function')?getActiveGoal():null;
  if(goal&&typeof isAiFeatureAllowed==='function'&&!isAiFeatureAllowed(goal.subject,goal.level)){
    lcToast('Listening game is not available for this level yet.','warn',7000);
    return;
  }
  ensureFcIds();
  const pool=typeof getSelectedFC==='function'?getSelectedFC():[];
  let words=pool.length?pool.map(c=>c.word):[];
  if(!words.length&&goal&&Array.isArray(S.flashcards)){
    words=S.flashcards.filter(f=>f.sourceLang===goal.subject).map(f=>f.word);
  }
  words=[...new Set(words.map(w=>String(w||'').trim()).filter(Boolean))];
  if(words.length<3){lcToast('Select at least 3 words for the listening game.','warn');return;}
  if(typeof VocabBatching!=='undefined'&&VocabBatching.selectForActivity){
    const sel=VocabBatching.selectForActivity(words,'listening_game',goal);
    words=sel.words;
    S._hgActivityWords=words.slice();
    if(goal&&typeof saveGoals==='function')saveGoals();
  }
  const topic=typeof _vocabHub!=='undefined'&&_vocabHub.listenTopic?String(_vocabHub.listenTopic).trim():'';
  launchHorenGame(words, goal?goal.subject:(S.subject||'de'), goal?goal.level:(S.level||'B1'), {topic,pool});
}
window.exitHorenGame=exitHorenGame;
window.startHorenGameFromHub=startHorenGameFromHub;
async function tryPersonalPoolOrLibrary(configWords,configSkills,configGoalId,goalRef){
  if(typeof canUsePoolExam==='function'&&!canUsePoolExam()){
    return null;
  }
  if(typeof fetchExamFromPool==='function'){
    document.getElementById('loaderSub').textContent='Looking for a matching exam…';
    try{
      const pooled=await fetchExamFromPool(S.subject,S.level,seenPoolIds(S.subject,S.level));
      if(pooled?.found&&pooled.exam&&!(typeof BurnedRegistry!=='undefined'&&BurnedRegistry.examTouchesBurned(pooled.exam))){
        const check=validateExamCandidate(pooled.exam);
        let candidate=check.ok?check.normalized:null;
        if(candidate){
          candidate=stripExamToSkills(JSON.parse(JSON.stringify(candidate)),configSkills);
          const cov=lcVocabCoverage(candidate,configWords);
          if(cov.ratio>=POOL_COVERAGE_THRESHOLD&&isExamRenderable(candidate)&&lcExamPassesValidator(candidate)&&!lcExamHasPlaceholders(candidate)){
            candidate.vocabPersonal=true;
            candidate.vocabWords=configWords;
            candidate.vocabSkills=configSkills;
            candidate.poolSource=true;
            candidate.poolId=pooled.id||null;
            if(configGoalId||S.activeGoalId)candidate.goalId=configGoalId||S.activeGoalId;
            candidate.topic='Personal: '+configWords.slice(0,3).join(', ')+(configWords.length>3?'…':'');
            return {exam:candidate,source:'pool',poolId:pooled.id||null};
          }
        }
      }
    }catch(poolErr){lcDebug.warn('[personal] pool fetch failed:',poolErr);}
  }
  if(typeof QuestionLibrary!=='undefined'&&QuestionLibrary.hasLibrary(S.subject,S.level)){
    document.getElementById('loaderSub').textContent=`Assembling from library — ${configWords.length} words…`;
    const exam=await QuestionLibrary.buildPersonalExam(S.subject,S.level,configWords,configSkills);
    return {exam,source:'question-library'};
  }
  return null;
}
async function finalizePersonalExam(configWords,configSkills,configGoalId,goalRef,exam,source){
  const hybridMeta=exam&&source==='ai'?{
    _hybridSource:exam._hybridSource,
    _hybridPlan:exam._hybridPlan,
    _hybridTrace:exam._hybridTrace,
    _hybridValidated:exam._hybridValidated,
    _hybridFallbacks:exam._hybridFallbacks,
  }:null;
  if(typeof ManualVocab!=='undefined'&&ManualVocab.canonicalizeForGeneration){
    try{
      const canon=await ManualVocab.canonicalizeForGeneration(configWords,S.subject,S.level||'B1');
      if(canon.words?.length)configWords=canon.words;
      if(canon.corrections?.length){
        lcToast('Spelling corrected in deck: '+canon.corrections.slice(0,2).map(c=>c.from+'→'+c.to).join(', ')+(canon.corrections.length>2?'…':''),'info',6000);
        canon.corrections.forEach(({from,to})=>{
          const fc=(S.flashcards||[]).find(f=>f.word===from&&f.sourceLang===S.subject);
          if(fc&&ManualVocab.applySpellingFixToFlashcard)ManualVocab.applySpellingFixToFlashcard(fc,S.subject,to);
        });
        if(canon.corrections.length)saveFC();
      }
    }catch(_){}
  }
  S.examData=exam;
  S.examSource=source;
  stripExamToSkills(S.examData,configSkills);
  S.examData.vocabPersonal=true;
  S.examData.vocabWords=configWords;
  S.examData.vocabSkills=configSkills;
  if(configGoalId||S.activeGoalId)S.examData.goalId=configGoalId||S.activeGoalId;
  if(!S.examData.topic||S.examData.topic==='Personal vocabulary review'){
    if(S.examData._displayTopic)S.examData.topic=S.examData._displayTopic;
    else S.examData.topic='Personal: '+configWords.slice(0,3).join(', ')+(configWords.length>3?'…':'');
  }
  applyPersonalTargetUsage(S.examData,configWords);
  let personalBlueprint=null;
  if(typeof ExamBlueprint!=='undefined'){
    try{personalBlueprint=await ExamBlueprint.load(S.subject,S.level);}catch(_){}
  }
  if(S.examSource==='question-library'&&(!isExamRenderable(S.examData)||!lcExamPassesValidator(S.examData,{strict:false}))){
    throw new Error('Library assembly produced an invalid exam.');
  }
  const skipAnswerBalance=S.examSource==='ai';
  if(skipAnswerBalance)S.examData._skipAnswerBalance=true;
  if(typeof normalizeExam==='function')S.examData=normalizeExam(S.examData,{skipPostprocess:skipAnswerBalance});
  if(hybridMeta){
    Object.assign(S.examData,hybridMeta);
    if(hybridMeta._hybridTrace&&Object.keys(hybridMeta._hybridTrace).length){
      S.examData._hybridTrace=hybridMeta._hybridTrace;
    }
  }
  S.examData=repairPersonalExamAnswerability(S.examData);
  const hybridFactory=S.examData?._hybridSource==='factory';
  if(S.examSource==='ai'&&!hybridFactory){
    S.examData=await retryMissingPartsBeforePrune(S.examData,configWords,configSkills,{
      source:'ai',blueprint:personalBlueprint,
    });
    S.examData=repairPersonalExamAnswerability(S.examData);
    S.examData=await fillMissingModuleTeileFromPool(
      S.examData,S.subject,S.level,personalBlueprint,configSkills
    );
    S.examData=repairPersonalExamAnswerability(S.examData);
    if(typeof normalizeExam==='function'){
      S.examData=normalizeExam(S.examData,{skipPostprocess:!!S.examData._skipAnswerBalance})||S.examData;
    }
  }
  pruneBrokenExamParts(S.examData,configSkills);
  reconcileChunkMetaWithExam(S.examData);
  if(S.examData._failedTeile?.length)S.examData._partialGen=true;
  if(!isExamRenderable(S.examData)){
    throw Object.assign(new Error('No valid exam parts could be generated.'),{code:'exam_invalid'});
  }
  if(examHasUnanswerableQuestions(S.examData)){
    S.examData=repairPersonalExamAnswerability(S.examData);
    pruneEmptyGoetheParts(S.examData,configSkills);
    if(examHasUnanswerableQuestions(S.examData)||!isExamRenderable(S.examData)){
      throw Object.assign(new Error('Generated exam has questions without answer options.'),{code:'exam_invalid'});
    }
  }
  if(typeof lcValidateExamOnServer==='function'&&S.examSource==='ai'){
    const skipHybridRevalidation=!!hybridFactory;
    const srv=skipHybridRevalidation
      ?{valid:true,skipped:false,exam:S.examData}
      :await lcValidateExamOnServer(S.examData,{
      verifyAnswerKeys:!hybridFactory,
      discardFailedItems:true,
      partialExam:!!(
        S.examData?._sectionPart||
        S.examData?._partialGen||
        S.examData?.vocabPersonal||
        configSkills?.length===1
      ),
    });
    if(srv.exam){
      for(const k of['lesenParts','horenParts','schreibenParts','sprechenParts','readingParts','listeningParts']){
        if(Array.isArray(srv.exam[k]))S.examData[k]=srv.exam[k];
      }
      if(typeof normalizeExam==='function'){
        S.examData=normalizeExam(S.examData,{skipPostprocess:true})||S.examData;
      }
      S.examData=repairPersonalExamAnswerability(S.examData);
      pruneEmptyGoetheParts(S.examData,configSkills);
      reconcileChunkMetaWithExam(S.examData);
      if(typeof ExamRenumber!=='undefined'&&ExamRenumber.renumberExam){
        let bp=null;
        if(typeof ExamBlueprint!=='undefined'){
          try{bp=await ExamBlueprint.load(S.subject,S.level);}catch(_){}
        }
        ExamRenumber.renumberExam(S.examData,bp||null);
        const deficits=ExamRenumber.collectDeficits(S.examData,bp);
        if(deficits.length&&S.examData?.vocabPersonal){
          S.examData=await fillMissingModuleTeileFromPool(
            S.examData,S.subject,S.level,bp,configSkills
          );
          S.examData=repairPersonalExamAnswerability(S.examData);
          if(typeof normalizeExam==='function'){
            S.examData=normalizeExam(S.examData,{skipPostprocess:true})||S.examData;
          }
          ExamRenumber.renumberExam(S.examData,bp||null);
          const stillShort=ExamRenumber.collectDeficits(S.examData,bp);
          if(stillShort.length)lcDebug.warn('[personal] parts still short after pool:',stillShort);
        }else if(deficits.length&&typeof ExamRefill!=='undefined'&&ExamRefill.refillAllDeficits){
          try{
            const hooks=getGeneratorHooks((msg)=>{const el=document.getElementById('loaderSub');if(el&&msg)el.textContent=msg;});
            const refillResult=await ExamRefill.refillAllDeficits({
              exam:S.examData,
              deficits,
              subject:S.subject,
              level:S.level,
              blueprint:bp,
              configWords,
              hooks,
              genTicket:S.examData._genTicket,
              validateFn:lcValidateExamOnServer,
              onProgress:(msg)=>{const el=document.getElementById('loaderSub');if(el&&msg)el.textContent=msg;},
            });
            S.examData=repairPersonalExamAnswerability(S.examData);
            if(refillResult.remaining>0){
              lcDebug.warn('[personal] parts still short after refill:',refillResult.remaining);
            }
          }catch(refillErr){lcDebug.warn('[personal] deficit refill failed:',refillErr);}
        }
      }
    }
    if(srv.discarded>0){
      lcToast(
        `${srv.discarded} question${srv.discarded===1?'':'s'} failed verification and ${srv.discarded===1?'was':'were'} removed.`,
        'warn',
        7000
      );
    }
    if(srv.skipped){
      S.examData=null;
      throw Object.assign(
        new Error('Could not verify the generated exam. Please try again.'),
        {code:'validation_unavailable',quotaRefund:true}
      );
    }
    if(!srv.valid&&!srv.exam){
      const hybridDeliver=hybridFactory&&isExamRenderable(S.examData);
      if(!hybridDeliver){
        S.examData=null;
        throw Object.assign(
          new Error(srv.emptyAfterVerify
            ? 'No verifiable exam content remained after answer-key checks.'
            : 'Generated exam failed verification.'),
          {code:'exam_invalid',answerKeyVerify:!!srv.emptyAfterVerify,quotaRefund:true}
        );
      }
      lcDebug.warn('[personal] hybrid server validation notes (continuing):',srv.errors);
    }
    if(!srv.valid){
      const partialDeliver=!!(
        S.examData?._sectionPart||
        S.examData?._partialGen||
        S.examData?.vocabPersonal||
        configSkills?.length===1
      );
      if(!(partialDeliver&&isExamRenderable(S.examData))){
        S.examData=null;
        throw Object.assign(
          new Error('No verifiable exam content remained after answer-key checks.'),
          {code:'exam_invalid',answerKeyVerify:true,quotaRefund:true}
        );
      }
      lcDebug.log('[personal] partial exam fidelity notes:',srv.errors);
    }
    if(!isExamRenderable(S.examData)){
      S.examData=null;
      throw Object.assign(
        new Error('No valid exam parts could be generated.'),
        {code:'exam_invalid',quotaRefund:true}
      );
    }
    delete S.examData._skipAnswerBalance;
    S.examData=applyPersonalExamPostprocess(S.examData);
  }
  const preservePoolCov=(source==='pool'&&exam._coverageOverall)?{...exam._coverageOverall}:null;
  if(configWords?.length){
    attachPersonalCoverage(S.examData,configWords);
    if(preservePoolCov)S.examData._coverageOverall=preservePoolCov;
    showPersonalCoverageToast(S.examData,configWords);
  }
  if(Array.isArray(S.examData?._hybridFallbacks)&&S.examData._hybridFallbacks.length){
    lcDebug.warn('[personal] hybrid fallbacks (internal):',S.examData._hybridFallbacks);
  }
  const coverage=S.examData._coverageOverall||lcVocabCoverage(S.examData,configWords);
  if(S.examSource==='ai'&&personalModuleTeilsComplete(S.examData,configSkills,personalBlueprint)){
    delete S.examData._partialGen;
    S.examData._failedTeile=[];
    S.personalGenRetry=null;
  }
  if(S.examSource==='ai'){
    const depersonalized=examCopyForPoolIngest(S.examData,genericPoolTopic(S.subject,S.level));
    const hasAiParts=!!(depersonalized.lesenParts?.length||depersonalized.horenParts?.length||depersonalized.schreibenParts?.length||depersonalized.sprechenParts?.length);
    if(hasAiParts&&lcExamPassesStructuralGate(depersonalized)){
      try{
        const ing=await contributeExamToPool(S.subject,S.level,depersonalized.topic,depersonalized,{minCoverage:0,verified:true});
        if(ing?.saved>0){
          const msg=ing.autoApproved>0
            ?`${ing.saved} Teil${ing.saved===1?'':'e'} saved for reuse (${ing.autoApproved} live for other learners).`
            :`${ing.saved} Teil${ing.saved===1?'':'e'} queued for review in admin.`;
          lcToast(msg,'info',6000);
        }else if(ing?.error){
          lcToast(`Exam ready, but reuse pool save failed (${ing.error}). Are you logged in?`,'warn',8000);
        }else if(typeof directPoolContribEnabled!=='function'||!directPoolContribEnabled()){
          lcDebug.warn('[staging] no parts ingested',ing);
          lcToast('Exam ready, but no parts were saved to the reuse pool.','warn',8000);
        }
      }catch(stgErr){lcDebug.warn('[staging] contribute failed:',stgErr);}
    }
  }else if(lcExamPassesQualityGate(S.examData,configWords,POOL_CONTRIBUTE_COVERAGE)){
    void contributeExamToPool(S.subject,S.level,genericPoolTopic(S.subject,S.level),S.examData,{words:configWords,minCoverage:POOL_CONTRIBUTE_COVERAGE});
  }
  if(typeof VocabBatching!=='undefined'&&goalRef){
    const rotWords=S.lastPersonalConfig?.personalRotationWords||configWords;
    VocabBatching.recordActivityUsage(goalRef,'personal',rotWords,{skills:configSkills});
    const plan=VocabBatching.getActivityPlan(goalRef,'personal',configSkills);
    if(plan){
      const cov=VocabBatching.coverage(plan);
      if(!cov.finished){
        lcToast(VocabBatching.summary(plan,S.subject)+'. Use “Next batch” on results when ready.','info',8000);
      }
    }
  }
  if(source==='ai'){
    void logAiGeneration({
      lang:S.subject,level:S.level,source,topic:S.examData.topic,
      vocabWords:configWords,coverage:coverage.ratio,valid:true,examData:S.examData
    });
  }
  if(S.examData._partialGen){
    storePersonalGenRetry(configWords,configSkills,configGoalId,S.examData,S.examData._genReport);
    const failed=S.examData._failedTeile||[];
    const msg=failed.length
      ?`Some parts could not be generated (${failed.slice(0,5).join(', ')}${failed.length>5?'…':''}). Retry from the banner. Successful parts are saved for reuse.`
      :'Some parts could not be generated. You can retry failed parts from the banner.';
    lcToast(msg,'warn',8000);
  }else{
    S.personalGenRetry=null;
  }
  if(typeof LcAnalytics!=='undefined')LcAnalytics.trackPersonalizedExamGenerated(configSkills);
  renderExam();
  if(S.examData?.vocabPersonal){
    try{if(typeof autoSaveExam==='function')autoSaveExam();}catch(_){}
  }
  if(source==='ai'&&S.examData?._genTicket&&typeof deliverExamGeneration==='function'){
    try{
      await deliverExamGeneration(S.examData._genTicket);
    }catch(delErr){lcDebug.warn('[personal] deliverGeneration failed:',delErr);}
    delete S.examData._genTicket;
    if(typeof S!=='undefined')S._activeGenTicket=null;
  }
}
// Exámenes 100% desde pool (sin IA en runtime). La IA se conserva para juegos.
function isAllowLiveGenEnabled(){
  if(typeof window==='undefined')return false;
  const v=window.ALLOW_LIVE_GEN;
  return v==='1'||v===1||v===true;
}
function liveAiGenerationBlockedMessage(){
  return 'Live AI exam generation is temporarily unavailable. Practice exams use curated pool content only.';
}
function isExamPoolOnly(){
  if(typeof window!=='undefined'){
    if(window.EXAM_POOL_ONLY===undefined)window.EXAM_POOL_ONLY=true;
    const requested=!!(window.EXAM_POOL_ONLY??true);
    if(!requested&&!isAllowLiveGenEnabled())return true;
    return requested;
  }
  return true;
}
const PERSONAL_POOL_FIRST_SKILLS=new Set(['lesen','reading','horen','listening']);
/** Goethe de levels with Lesen/Hören pool-first (A2 parity with B1). */
const PERSONAL_POOL_FIRST_LEVELS=new Set(['A2','B1']);
/**
 * Languages billed as pool-first (0 credits) rather than personal_exam (4).
 *
 * Serving from the pool is already enabled per-language in
 * personalLesenPoolFallback.POOL_FIRST_TEILS_BY_LANG; this set is the *billing*
 * decision, which is stricter: charging 0 is only honest once the pool can
 * cover a whole module on its own. en/B1 stock is ~3 variants per slot, so its
 * misses still fall back to paid generation — add 'en' here when the pool
 * reaches the 30-per-slot target.
 */
const PERSONAL_POOL_FIRST_BILLING_LANGS=new Set(['de']);
/** Credit action for a personal module when live generation is required. */
function personalGenCreditAction(skills){
  const ordered=orderedPersonalSkills(skills||['lesen']);
  if(ordered.length!==1)return'personal_exam';
  const s=ordered[0];
  if(s==='schreiben'||s==='writing')return'personal_schreiben';
  if(s==='sprechen'||s==='speaking')return'personal_sprechen_gen';
  if(isPersonalLesenHybridEnabled(skills,S.subject,S.level))return'personal_exam';
  return null;
}
function canUsePersonalModuleGen(skills,lang,level){
  if(typeof isPersonalModulePoolFirst==='function'&&isPersonalModulePoolFirst(skills,lang,level)){
    const ordered=orderedPersonalSkills(skills||['lesen']);
    const s=ordered[0];
    const mod=(s==='horen'||s==='listening')?'horen':'lesen';
    return typeof canUsePersonalPoolModule==='function'?canUsePersonalPoolModule(mod):false;
  }
  if(!isPaidPlan())return false;
  const action=personalGenCreditAction(skills);
  if(!action)return typeof canGenerate==='function'?canGenerate():false;
  return typeof hasAiCreditsFor==='function'?hasAiCreditsFor(action):false;
}
if(typeof window!=='undefined'){
  window.personalGenCreditAction=personalGenCreditAction;
  window.canUsePersonalModuleGen=canUsePersonalModuleGen;
}
function isPersonalModulePoolFirst(skills,lang,level){
  if(!PERSONAL_POOL_FIRST_BILLING_LANGS.has(String(lang||'').slice(0,2).toLowerCase()))return false;
  if(!PERSONAL_POOL_FIRST_LEVELS.has(String(level||'').toUpperCase()))return false;
  const ordered=orderedPersonalSkills(skills||['lesen']);
  if(ordered.length!==1)return false;
  return PERSONAL_POOL_FIRST_SKILLS.has(ordered[0]);
}
function isPersonalLesenPoolFirst(skills,lang,level){
  const ordered=orderedPersonalSkills(skills||['lesen']);
  if(ordered.length!==1)return false;
  const s=ordered[0];
  return isPersonalModulePoolFirst(skills,lang,level)&&(s==='lesen'||s==='reading');
}
function isPersonalHorenPoolFirst(skills,lang,level){
  const ordered=orderedPersonalSkills(skills||['lesen']);
  if(ordered.length!==1)return false;
  const s=ordered[0];
  return isPersonalModulePoolFirst(skills,lang,level)&&(s==='horen'||s==='listening');
}
function isPersonalSchreibenPoolFirst(skills,lang,level){
  const ordered=orderedPersonalSkills(skills||['lesen']);
  if(ordered.length!==1)return false;
  const s=ordered[0];
  return isPersonalModulePoolFirst(skills,lang,level)&&(s==='schreiben'||s==='writing');
}
function isPersonalSprechenPoolFirst(skills,lang,level){
  const ordered=orderedPersonalSkills(skills||['lesen']);
  if(ordered.length!==1)return false;
  const s=ordered[0];
  return isPersonalModulePoolFirst(skills,lang,level)&&(s==='sprechen'||s==='speaking');
}
/** Lesen B1 DE hybrid when live gen is on. Disabled for pool-first Lesen B1 DE. */
function isPersonalLesenHybridEnabled(skills,lang,level){
  if(isPersonalLesenPoolFirst(skills,lang,level))return false;
  if(isExamPoolOnly()||!isAllowLiveGenEnabled())return false;
  if(typeof window!=='undefined'&&window.EXAM_HYBRID===false)return false;
  if(String(lang||'').toLowerCase()!=='de')return false;
  if(!PERSONAL_POOL_FIRST_LEVELS.has(String(level||'').toUpperCase()))return false;
  if(typeof fetchHybridExamPlan!=='function'||typeof executeHybridLesenExam!=='function')return false;
  const ordered=orderedPersonalSkills(skills||['lesen']);
  if(ordered.length!==1)return false;
  const s=ordered[0];
  return s==='lesen'||s==='reading';
}
function personalPoolEmptyMessage(topic, lang, module) {
  const isDE = String(lang || '').toLowerCase() === 'de';
  const mod = String(module || 'lesen').toLowerCase();
  if (mod === 'horen' || mod === 'listening') {
    if (isDE) return 'Im Pool ist noch kein Hören-Inhalt verfügbar. Probiere es später erneut.';
    return 'No listening content in the pool yet. Try again later.';
  }
  if (mod === 'schreiben' || mod === 'writing') {
    if (isDE) return 'Im Pool ist noch kein Schreiben-Inhalt verfügbar. Probiere es später erneut.';
    return 'No writing content in the pool yet. Try again later.';
  }
  if (isDE) {
    return `Für „${topic}“ ist im Pool noch kein Lesen-Inhalt verfügbar. Probiere ein anderes Thema (z. B. Bildung oder Technik).`;
  }
  return `No reading content in the pool for "${topic}" yet. Try another topic (e.g. Bildung or Technik).`;
}
function personalPoolVocabNoMatchMessage(lang) {
  const uiLang = typeof resolveVocabUiLang === 'function' ? resolveVocabUiLang() : '';
  if (uiLang === 'es') {
    return 'No pudimos generar contenido con exactamente estas palabras — probá con menos palabras, otras palabras, o dejanos elegir automáticamente.';
  }
  const isDE = String(lang || '').toLowerCase() === 'de';
  if (isDE) {
    return 'Wir konnten keinen Inhalt finden, der genau diese Wörter enthält — probier weniger oder andere Wörter, oder lass uns automatisch wählen.';
  }
  return 'We could not assemble content that uses exactly these words — try fewer or different words, or let us pick automatically.';
}
function personalPoolVocabInsufficientMessage(lang, found, minVisible) {
  const need = minVisible != null ? minVisible : 3;
  const uiLang = typeof resolveVocabUiLang === 'function' ? resolveVocabUiLang() : '';
  if (uiLang === 'es') {
    return `No hay suficiente contenido en el pool para incluir al menos ${need} de tus palabras (${found ?? 0} encontradas). Probá otro tema o más tarde — no se consumió tu cuota.`;
  }
  const isDE = String(lang || '').toLowerCase() === 'de';
  if (isDE) {
    return `Im Pool fehlt passender Inhalt für mindestens ${need} deiner Wörter (${found ?? 0} gefunden). Probiere ein anderes Thema oder später — deine Kontingent wurde nicht verbraucht.`;
  }
  return `Not enough pool content to include at least ${need} of your words (${found ?? 0} found). Try another topic or later — your quota was not used.`;
}
function personalPoolMissingTeileMessage(missingTeile, topic, lang) {
  const isDE = String(lang || '').toLowerCase() === 'de';
  const labels = (missingTeile || []).map((t) => `Teil ${t}`).join(', ');
  if (isDE) {
    return labels
      ? `Für „${topic}“ fehlen noch ${labels}. Du übst mit den Teilen, die verfügbar sind.`
      : `Einige Teile fehlen noch für „${topic}“. Du übst mit dem, was verfügbar ist.`;
  }
  return labels
    ? `Missing for "${topic}": ${labels}. Practice with the parts that are available.`
    : `Some parts are missing for "${topic}". Practice with what's available.`;
}
function personalPoolTopicRelaxedMessage(topic, lang) {
  const isDE = String(lang || '').toLowerCase() === 'de';
  if (isDE) {
    return `Für „${topic}“ gibt es noch nicht genug Aufgaben in allen Teilen — wir zeigen passende Alternativen aus dem Pool.`;
  }
  return `Not enough "${topic}" tasks in every part yet — showing suitable alternatives from the pool.`;
}
function resolvePersonalLesenTeils(teilFilter){
  const defaultTeils=[1,2,3,4,5];
  if(teilFilter==null||teilFilter===''||teilFilter==='all')return defaultTeils;
  if(Array.isArray(teilFilter)){
    const picked=[...new Set(teilFilter.map((t)=>Number(t)).filter(Number.isFinite))].sort((a,b)=>a-b);
    return picked.length?picked:defaultTeils;
  }
  const t=Number(teilFilter);
  return Number.isFinite(t)?[t]:defaultTeils;
}
function resolveCanonicalB1Topic(raw){
  if(typeof B1Topics!=='undefined'&&typeof B1Topics.normalizeB1Topic==='function'){
    const canon=B1Topics.normalizeB1Topic(raw);
    if(canon)return canon;
  }
  if(typeof B1Topics!=='undefined'&&B1Topics.isValidB1Topic?.(raw))return String(raw).trim();
  return null;
}
async function pickPersonalHybridTopic(personalGenOpts){
  const fromOpts=resolveCanonicalB1Topic(personalGenOpts?.topic);
  if(fromOpts)return fromOpts;
  if(typeof LexiCoilEngine!=='undefined'&&typeof LexiCoilEngine.pickTopic==='function'){
    try{
      const picked=await LexiCoilEngine.pickTopic(S.subject,S.level);
      const canon=resolveCanonicalB1Topic(picked);
      if(canon)return canon;
    }catch(_){/* fallback below */}
  }
  if(typeof B1Topics!=='undefined'&&B1Topics.B1_TOPICS?.length){
    return B1Topics.B1_TOPICS[Math.floor(Math.random()*B1Topics.B1_TOPICS.length)];
  }
  return 'Umwelt';
}
function hybridPersonalUiMessages(lang){
  const isDE=String(lang||'').toLowerCase()==='de';
  if(isDE){
    return{
      loaderTitle:'Dein personalisiertes Examen wird erstellt…',
      loaderSub:'Wir integrieren dein Vokabular — das kann etwa eine Minute dauern.',
      banner:'Dein Examen wird personalisiert…',
      pendingSection:'Wird personalisiert…',
    };
  }
  return{
    loaderTitle:'Generating your personalized exam…',
    loaderSub:'Integrating your vocabulary — this may take about a minute.',
    banner:'Personalizing your exam…',
    pendingSection:'Personalizing…',
  };
}
/** Reveal pacing: slower when Gemini runs (credibility + headroom), faster when pool-only. */
const HYBRID_REVEAL_MS_WITH_LIVE=6500;
const HYBRID_REVEAL_MS_POOL_ONLY=2500;
function hybridRevealIntervalMs(liveTeilCount){
  return Number(liveTeilCount)>0?HYBRID_REVEAL_MS_WITH_LIVE:HYBRID_REVEAL_MS_POOL_ONLY;
}
function hybridSleep(ms){
  return new Promise((resolve)=>setTimeout(resolve,ms));
}
function hybridLesenPartReady(exam,teil){
  const part=(exam?.lesenParts||[]).find((p)=>Number(p.teil)===Number(teil));
  return!!(part&&!part._hybridPending&&goethePartHasContent(part,'lesen'));
}
/** Keep hybrid progressive content instead of silently swapping to library/pool. */
function recoverHybridProgressiveExam(configWords,configSkills,aiErr){
  const raw=aiErr?.hybridExam||S.examData;
  if(!raw)return null;
  const exam=JSON.parse(JSON.stringify(raw));
  exam.lesenParts=(exam.lesenParts||[]).filter(
    (p)=>p&&!p._hybridPending&&goethePartHasContent(p,'lesen')
  );
  if(!exam.lesenParts.length)return null;
  exam.lang=exam.lang||S.subject;
  exam.level=exam.level||S.level;
  exam.goetheFormat=true;
  exam.vocabPersonal=true;
  exam.vocabWords=configWords;
  exam.vocabSkills=configSkills||['lesen'];
  exam._hybridSource='factory';
  exam._hybridValidated=false;
  delete exam._hybridLoading;
  delete exam._hybridPendingTeils;
  const missing=[1,2,3,4,5].filter(
    (t)=>!exam.lesenParts.some((p)=>Number(p.teil)===t)
  );
  if(missing.length){
    exam._partialGen=true;
    exam._failedTeile=missing.map((t)=>`Teil ${t}`);
  }
  if(aiErr?.validation?.errors?.length)exam._hybridValidationNotes=aiErr.validation.errors;
  if(aiErr?.genReport?.failedTeile?.length){
    exam._failedTeile=[...new Set([...(exam._failedTeile||[]),...aiErr.genReport.failedTeile])];
    exam._partialGen=true;
  }
  return exam;
}
function buildHybridProgressiveExamView(readyExam,allTeils,revealedTeils,configWords,configSkills){
  const shell=JSON.parse(JSON.stringify(readyExam||{}));
  shell.lang=shell.lang||S.subject;
  shell.level=shell.level||S.level;
  shell.goetheFormat=true;
  shell.vocabPersonal=true;
  shell.vocabWords=configWords;
  shell.vocabSkills=configSkills;
  const teilList=[...allTeils].map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  const revealed=new Set([...(revealedTeils||[])].map(Number));
  shell._hybridLoading=revealed.size<teilList.length;
  shell._hybridPendingTeils=teilList.filter((t)=>!revealed.has(t));
  shell._skipAnswerBalance=true;
  shell.lesenParts=[];
  for(const teil of teilList){
    const part=(readyExam?.lesenParts||[]).find((p)=>Number(p.teil)===teil);
    if(revealed.has(teil)&&part&&goethePartHasContent(part,'lesen')){
      shell.lesenParts.push(JSON.parse(JSON.stringify(part)));
    }else{
      shell.lesenParts.push({teil,_hybridPending:true,instruction:''});
    }
  }
  return shell;
}
function refreshHybridProgressiveExam(readyExam,allTeils,revealedTeils,configWords,configSkills,lang){
  S.examData=buildHybridProgressiveExamView(readyExam,allTeils,revealedTeils,configWords,configSkills);
  if(typeof normalizeExam==='function'){
    S.examData=normalizeExam(S.examData,{skipPostprocess:true})||S.examData;
  }
  if(typeof PersonalExamCoverage!=='undefined'&&PersonalExamCoverage.attachPersonalExamCoverage&&readyExam&&revealedTeils?.size){
    PersonalExamCoverage.attachPersonalExamCoverage(S.examData,configWords);
  }
  hideAll();
  if(typeof renderExam==='function')renderExam();
}
async function runHybridUniformReveal({
  allTeils,lang,configWords,configSkills,generateFn,revealIntervalMs,
}){
  const teilList=[...allTeils].map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  const intervalMs=Math.max(800,Number(revealIntervalMs)||HYBRID_REVEAL_MS_WITH_LIVE);
  const revealed=new Set();
  let readyExam=null;
  let genError=null;
  let genDone=false;
  const startMs=Date.now();
  const refresh=()=>refreshHybridProgressiveExam(readyExam,teilList,revealed,configWords,configSkills,lang);
  refresh();
  const genPromise=(async()=>{
    try{
      return await generateFn((exam)=>{readyExam=exam;});
    }catch(err){
      genError=err;
      throw err;
    }finally{
      genDone=true;
    }
  })();
  const revealPromise=(async()=>{
    for(let i=0;i<teilList.length;i++){
      const teil=teilList[i];
      const slotAt=startMs+(i+1)*intervalMs;
      await hybridSleep(Math.max(0,slotAt-Date.now()));
      for(;;){
        if(genError)throw genError;
        if(hybridLesenPartReady(readyExam,teil))break;
        if(genDone)break;
        await hybridSleep(200);
      }
      if(hybridLesenPartReady(readyExam,teil)){
        revealed.add(teil);
        refresh();
      }
    }
  })();
  try{
    const execResult=await genPromise;
    await revealPromise;
    return execResult;
  }catch(err){
    throw err;
  }
}
function showHybridProgressiveExam(exam,configWords,configSkills,pendingTeils,lang){
  const allTeils=(exam?.lesenParts||[]).map((p)=>Number(p.teil)).concat(pendingTeils||[]);
  const unique=[...new Set(allTeils.map(Number))].sort((a,b)=>a-b);
  const revealed=new Set(unique.filter((t)=>!(pendingTeils||[]).includes(t)));
  refreshHybridProgressiveExam(exam,unique,revealed,configWords,configSkills,lang);
}
function hybridExecuteTimeoutMs(){
  if(typeof ChunkRunner!=='undefined'&&ChunkRunner.EXAM_CHUNK_TIMEOUT_MS){
    return ChunkRunner.EXAM_CHUNK_TIMEOUT_MS;
  }
  return 55000;
}
async function generatePersonalLesenHybrid(configWords,personalGenOpts,tier){
  if(!isAllowLiveGenEnabled()){
    throw Object.assign(new Error(liveAiGenerationBlockedMessage()),{code:'live_gen_disabled'});
  }
  if(typeof fetchHybridExamPlan!=='function'||typeof executeHybridLesenExam!=='function'){
    throw new Error('Hybrid exam client not loaded');
  }
  if(typeof startExamGeneration!=='function')throw new Error('startExamGeneration unavailable');
  const lang=S.subject;
  const level=S.level;
  const callTimeoutMs=hybridExecuteTimeoutMs();
  const uiMsg=hybridPersonalUiMessages(lang);
  const report=initPersonalGenReport(['lesen']);
  updatePersonalLoader(1,1,personalModuleLabel('lesen',lang),report);
  const titleEl=document.getElementById('loaderTitle');
  const subEl=document.getElementById('loaderSub');
  if(titleEl)titleEl.textContent=uiMsg.loaderTitle;
  if(subEl)subEl.textContent=uiMsg.loaderSub;
  const topic=await pickPersonalHybridTopic(personalGenOpts);
  lcDebug.log('[personal] hybrid chunked generation',{topic,lang,level,callTimeoutMs});
  const teils=resolvePersonalLesenTeils(personalGenOpts?.teilFilter);
  let plan;
  let meta;
  try{
    ({plan,meta}=await fetchHybridExamPlan({
      module:'lesen',
      teils,
      topic,
      vocab:configWords,
      lang,
      level,
    }));
  }catch(planErr){
    throw Object.assign(planErr instanceof Error?planErr:new Error(String(planErr)),{code:planErr.code||'exam_plan_failed'});
  }
  const liveCells=plan.toGenerate||[];
  const liveCount=Math.max(1,liveCells.length);
  const revealIntervalMs=hybridRevealIntervalMs(liveCells.length);
  lcDebug.log('[personal] hybrid reveal pacing',{liveCells:liveCells.length,revealIntervalMs});
  let genTicket;
  try{
    genTicket=await startExamGeneration('personal_exam',liveCount);
    if(typeof S!=='undefined')S._activeGenTicket=genTicket;
  }catch(ticketErr){
    if(ticketErr.code==='ai_credits_exhausted')throw ticketErr;
    throw ticketErr;
  }
  let execResult;
  let partialExam=null;
  let partialTrace=null;
  const hybridCallOpts={
    genTicket,
    topic,
    vocab:configWords,
    lang,
    level,
    module:'lesen',
    plan,
    planMeta:meta,
    timeoutMs:callTimeoutMs,
  };
  const allPlanTeils=[...new Set([
    ...(plan.fromPool||[]).map((c)=>Number(c.teil)),
    ...(plan.toGenerate||[]).map((c)=>Number(c.teil)),
    ...teils,
  ])].filter(Number.isFinite).sort((a,b)=>a-b);
  try{
    execResult=await runHybridUniformReveal({
      allTeils:allPlanTeils,
      lang,
      configWords,
      configSkills:['lesen'],
      revealIntervalMs,
      generateFn:async(onProgress)=>{
        execResult=await executeHybridLesenExam({
          ...hybridCallOpts,
          skipLive:true,
          validateExam:!liveCells.length,
        });
        partialExam=execResult.exam;
        partialTrace=execResult.trace;
        onProgress(partialExam);
        for(const cell of plan.fromPool||[]){
          const poolHit=(partialTrace.pool||[]).find((p)=>Number(p.teil)===Number(cell.teil));
          recordPersonalChunkResult(report,'lesen',{
            label:`Lesen Teil ${cell.teil}`,
            status:poolHit?.ok?'ok':'fail',
          });
        }
        for(let i=0;i<liveCells.length;i++){
          const cell=liveCells[i];
          const isLast=i===liveCells.length-1;
          execResult=await executeHybridLesenExam({
            ...hybridCallOpts,
            onlyLiveTeil:cell.teil,
            includePool:false,
            partialExam,
            partialTrace,
            validateExam:isLast,
          });
          partialExam=execResult.exam;
          partialTrace=execResult.trace;
          onProgress(partialExam);
        }
        return execResult;
      },
    });
  }catch(execErr){
    const rel=await refundActiveGenTicket();
    if(rel?.released)execErr.quotaReleased=true;
    throw execErr;
  }
  if(S.examData){
    delete S.examData._hybridLoading;
    delete S.examData._hybridPendingTeils;
  }
  const exam=execResult.exam;
  const trace=execResult.trace||execResult.exam?._hybridTrace||{};
  exam._genTicket=execResult.genTicket||genTicket;
  exam._hybridPlan=execResult.plan||plan;
  exam._hybridTrace=trace;
  exam._hybridSource='factory';
  exam._hybridValidated=!!execResult.validation?.valid;
  exam.topic=exam.topic||topic;
  exam.topicTag=exam.topicTag||topic;
  for(const cell of plan.toGenerate||[]){
    const live=(trace.live||[]).find((l)=>Number(l.teil)===Number(cell.teil));
    recordPersonalChunkResult(report,'lesen',{
      label:`Lesen Teil ${cell.teil}`,
      status:live?.ok?'ok':'fail',
    });
    if(!live?.ok)report.failedTeile.push(`Lesen Teil ${cell.teil}`);
  }
  const hybridOk=!!execResult.validation?.valid;
  const validationErrors=execResult.validation?.errors||[];
  report.modules.push({skill:'lesen',ok:hybridOk,hybrid:true});
  renderPersonalGenProgress(report);
  if(!hybridOk)lcDebug.warn('[personal] hybrid validation notes:',validationErrors);
  const teilCount=(exam.lesenParts||[]).filter((p)=>goethePartHasContent(p,'lesen')).length;
  if(typeof isExamRenderable!=='function'||!isExamRenderable(exam)||teilCount<1){
    const rel=await refundActiveGenTicket();
    throw Object.assign(new Error('Hybrid exam failed validation.'),{
      code:'exam_invalid',
      validation:execResult.validation,
      hybridExam:exam,
      quotaReleased:!!rel?.released,
      genReport:report,
    });
  }
  exam._hybridValidated=hybridOk;
  if(!hybridOk){
    exam._hybridValidationNotes=validationErrors;
    const missing=[1,2,3,4,5].filter(
      (t)=>!(exam.lesenParts||[]).some((p)=>Number(p.teil)===t&&goethePartHasContent(p,'lesen'))
    );
    if(missing.length){
      exam._partialGen=true;
      exam._failedTeile=missing.map((t)=>`Teil ${t}`);
    }
  }
  const fallbacks=(trace.live||[]).filter((l)=>l.fallback);
  if(fallbacks.length){
    exam._hybridFallbacks=fallbacks.map((f)=>f.teil);
    lcDebug.warn('[personal] hybrid section fallbacks:',exam._hybridFallbacks);
  }
  exam.vocabSkills=['lesen'];
  return{exam,source:'ai',genReport:report,hybrid:true};
}
if(typeof window!=='undefined'){
  window.isAllowLiveGenEnabled=isAllowLiveGenEnabled;
  window.isExamPoolOnly=isExamPoolOnly;
  window.isPersonalLesenPoolFirst=isPersonalLesenPoolFirst;
  window.isPersonalHorenPoolFirst=isPersonalHorenPoolFirst;
  window.isPersonalSchreibenPoolFirst=isPersonalSchreibenPoolFirst;
  window.isPersonalSprechenPoolFirst=isPersonalSprechenPoolFirst;
  window.isPersonalModulePoolFirst=isPersonalModulePoolFirst;
  window.isPersonalLesenHybridEnabled=isPersonalLesenHybridEnabled;
  if(window.EXAM_POOL_ONLY===undefined)window.EXAM_POOL_ONLY=true;
}
async function generatePersonalExam(words,skills,goalId,opts){
  let configWords=words;
  let configSkills=skills;
  let configGoalId=goalId;
  const skipBatching=!!(opts&&opts.skipBatching);
  const goalRef=configGoalId?S.goals.find(g=>g.id===configGoalId):getActiveGoal();
  const checkLang=goalRef?.subject||S.subject||'de';
  const checkLevel=goalRef?.level||S.level||document.getElementById('fcPersonalLevel')?.value||'B1';
  if(typeof isPersonalizedAllowed==='function'&&!isPersonalizedAllowed(checkLang,checkLevel)){
    lcToast(typeof LevelAvailability!=='undefined'?LevelAvailability.personalizedUnavailableMessage(checkLang,checkLevel):'Personalized practice is not available for this level yet.','warn',7000);
    return;
  }
  if(skipBatching&&goalRef&&typeof VocabBatching!=='undefined'){
    const skills=orderedPersonalSkills(configSkills||goalRef.vocabPlan?.skills||['lesen']);
    VocabBatching.migrateVocabPlanToActivity(goalRef,skills);
    const plan=VocabBatching.getActivityPlan(goalRef,'personal',skills)||goalRef.vocabPlan;
    const batch=plan?VocabBatching.nextBatch(plan):null;
    if(!batch){lcToast('All vocabulary batches completed.','success');return;}
    configWords=batch;
    configSkills=skills;
    S.subject=goalRef.subject;S.level=goalRef.level;S.activeGoalId=goalRef.id;syncGoalToProfile(goalRef);
  }else   if(!configWords){
    const cards=getSelectedFC();
    if(cards.length<2){lcToast('Select at least 2 words.','warn');return;}
    const langs=[...new Set(cards.map(c=>c.sourceLang).filter(l=>l==='de'||l==='en'||l==='es'))];
    if(langs.length>1){lcToast('Select words from one language only.','warn');return;}
    S.subject=langs[0]||'de';
    S.level=document.getElementById('fcPersonalLevel')?.value||inferLevelFromCards(cards)||'B1';
    configWords=cards.map(c=>c.word);
    configSkills=['lesen'];
  }else{
    const goal=configGoalId?S.goals.find(g=>g.id===configGoalId):getActiveGoal();
    if(goal){S.subject=goal.subject;S.level=goal.level;S.activeGoalId=goal.id;syncGoalToProfile(goal);}
  }
  configSkills=orderedPersonalSkills(configSkills||['lesen']);
  const tier=typeof canUsePersonalizedTier==='function'?canUsePersonalizedTier():'free';
  const poolOnly=isExamPoolOnly();
  const poolFirstModule=isPersonalModulePoolFirst(configSkills,S.subject,S.level);
  const usePoolAssembly=poolOnly||poolFirstModule;
  const hybridEnabled=isPersonalLesenHybridEnabled(configSkills,S.subject,S.level);
  lcDebug.log('[personal] generation mode',{
    poolOnly,
    poolFirstModule,
    usePoolAssembly,
    hybridEnabled,
    allowLive:isAllowLiveGenEnabled(),
    EXAM_POOL_ONLY:typeof window!=='undefined'?window.EXAM_POOL_ONLY:undefined,
    ALLOW_LIVE_GEN:typeof window!=='undefined'?window.ALLOW_LIVE_GEN:undefined,
    lang:S.subject,
    level:S.level,
    skills:configSkills,
  });
  if(!usePoolAssembly&&!canUsePersonalModuleGen(configSkills,S.subject,S.level)){
    if(typeof isPaidPlan==='function'&&!isPaidPlan())showUpgrade();
    else if(typeof showAiCreditsExhausted==='function')showAiCreditsExhausted();
    else showUpgrade();
    return;
  }
  if(usePoolAssembly){
    for(const module of configSkills){
      if(isPersonalLesenPoolFirst([module],S.subject,S.level)){
        if(typeof requirePersonalPoolModule==='function'&&!requirePersonalPoolModule('lesen'))return;
      }else if(isPersonalHorenPoolFirst([module],S.subject,S.level)){
        if(typeof requirePersonalPoolModule==='function'&&!requirePersonalPoolModule('horen'))return;
      }
    }
  }
  let libraryMatchCount;
  let personalRotationWords=null;
  if(typeof VocabBatching!=='undefined'&&!skipBatching){
    if(typeof QuestionLibrary!=='undefined'&&QuestionLibrary.hasLibrary(S.subject,S.level)){
      try{
        const bank=await LibraryLoader.load(S.subject,S.level);
        libraryMatchCount=(bank.questions||[]).filter(q=>ExamBuilder.questionContainsWords(q,bank,configWords)).length;
      }catch(_){libraryMatchCount=undefined;}
    }
    if(goalRef){
      const fullDeck=[...new Set((configWords||[]).map(w=>String(w||'').trim()).filter(Boolean))];
      VocabBatching.migrateVocabPlanToActivity(goalRef,configSkills);
      const sel=VocabBatching.selectForActivity(fullDeck,'personal',goalRef,{skills:configSkills});
      if(sel.words?.length){
        personalRotationWords=sel.words.slice();
        configWords=sel.words;
      }
      saveGoals();
    }
  }
  S.mode='practice';S.isDemo=false;S.answers={};S.gapAnswers={};S.quickMod=null;
  initExamSession('practice');
  S.lastPersonalConfig={words:configWords,skills:configSkills,goalId:configGoalId||S.activeGoalId,teilFilter:opts?.teilFilter??_examConfig.teilChoice??'all',topic:opts?.topic??_examConfig.topicChoice??null,personalRotationWords};
  if(typeof VocabBatching!=='undefined'&&typeof HorenGame!=='undefined'&&VocabBatching.shouldUseGame(configWords,configSkills,libraryMatchCount)){
    launchHorenGame(configWords,S.subject,S.level);return;
  }
  hideAll();show('loadingScreen');
  const moduleCount=configSkills.length;
  document.getElementById('loaderTitle').textContent=moduleCount>1
    ?`Generating ${personalModuleLabel(configSkills[0],S.subject)}… (1/${moduleCount})`
    :'Building your personal mock exam…';
  document.getElementById('loaderSub').textContent=usePoolAssembly
    ?(S.subject==='de'
      ?'Dein personalisiertes Examen wird aus dem Pool zusammengestellt…'
      :'Assembling your personalized exam from the pool…')
    :isPersonalLesenHybridEnabled(configSkills,S.subject,S.level)
      ?(S.subject==='de'
        ?'Wir integrieren dein Vokabular — das kann etwa eine Minute dauern.'
        :'Integrating your vocabulary — this may take about a minute.')
      :'This may take ~1–2 min per module.';
  renderPersonalGenProgress(initPersonalGenReport(configSkills));
  try{
    let built=null;

    // ── Pool assembly: instant serve from reusable parts (no live AI) ──
    if (usePoolAssembly) {
      // P0-4: canonicalize user vocabulary before pool search
      if (typeof ManualVocab !== 'undefined' && ManualVocab.canonicalizeForGeneration && configWords?.length) {
        try {
          const canon = await ManualVocab.canonicalizeForGeneration(configWords, S.subject, S.level);
          if (Array.isArray(canon?.words) && canon.words.length) configWords = canon.words;
        } catch (_) { /* keep original words */ }
      }
      const personalTopic = await pickPersonalHybridTopic({
        topic: opts?.topic || goalRef?.topic || S.lastPersonalConfig?.topic,
      });
      console.log('[personal] pool assembly', {
        poolFirstModule,
        poolOnly,
        topic: personalTopic,
        words: configWords,
        skills: configSkills,
        lang: S.subject,
        level: S.level,
      });
      const combined = {
        lang: S.subject,
        level: S.level,
        goetheFormat: true,
        vocabPersonal: true,
        poolSource: true,
        topic: personalTopic,
        topicTag: personalTopic,
      };
      const coveredAll = new Set();
      let requestedTotal = configWords.length;
      const missingAll = [];
      const relaxedAll = [];
      let anyParts = false;
      let poolEmptyReason = null;
      let anyPartialCoverage = false;

      for (const module of configSkills) {
        let res;
        try {
          res = await assembleModuleFromPool(module, configWords, S.subject, S.level, {
            topicTag: personalTopic,
          });
        } catch (e) {
          if (e.code === 'personal_pool_quota_exceeded') {
            hideAll();
            const mod = e.module || module;
            if (typeof showPersonalPoolQuotaExceeded === 'function') showPersonalPoolQuotaExceeded(mod, e);
            if (_examConfig.goalId) {
              show('examConfigScreen');
              showExamConfigFootbar(true);
              renderExamConfigurator();
            } else show('flashcardScreen');
            return;
          }
          if (e.code === 'login_required') {
            hideAll();
            if (typeof lcToast === 'function') lcToast('Sign in to use personalized pool exams.', 'warn', 6000);
            if (typeof openAuth === 'function') openAuth('login');
            return;
          }
          throw e;
        }
        const key = _MODULE_PART_KEY[module] || `${module}Parts`;
        if (!res?.exam?.[key]?.length) {
          if (res?.emptyReason === 'vocab_insufficient_coverage') poolEmptyReason = 'vocab_insufficient_coverage';
          else if (res?.emptyReason === 'vocab_no_match') poolEmptyReason = 'vocab_no_match';
          continue;
        }
        anyParts = true;
        combined[key] = res.exam[key];
        if (res.exam._personalCoveragePartial || res.exam._personalTextDecision === 'serve_partial') {
          anyPartialCoverage = true;
        }
        (res.coveredWords || []).forEach((w) => coveredAll.add(String(w).toLowerCase()));
        if (res.coverage) requestedTotal = Math.max(requestedTotal, res.coverage.requested || configWords.length);
        (res.missingTeile || []).forEach((t) => missingAll.push({ module, teil: t }));
        (res.relaxedTeile || []).forEach((r) => {
          const teil = typeof r === 'object' ? r.teil : r;
          const actualTopic = typeof r === 'object' ? r.actualTopic : null;
          relaxedAll.push({ module, teil, actualTopic });
        });
      }

      if (!anyParts) {
        hideAll();
        const emptyMod = configSkills[0] || 'lesen';
        const minVis =
          typeof PersonalPoolVocabGate !== 'undefined'
            ? PersonalPoolVocabGate.PERSONAL_VOCAB_MIN_VISIBLE
            : 3;
        const toastMsg =
          poolEmptyReason === 'vocab_insufficient_coverage'
            ? personalPoolVocabInsufficientMessage(S.subject, null, minVis)
            : poolEmptyReason === 'vocab_no_match' && configWords?.length
              ? personalPoolVocabNoMatchMessage(S.subject)
              : personalPoolEmptyMessage(personalTopic, S.subject, emptyMod);
        lcToast(toastMsg, 'warn', 8000);
        if (
          poolEmptyReason === 'vocab_insufficient_coverage' &&
          typeof reportPersonalPoolCoverageFailure === 'function'
        ) {
          reportPersonalPoolCoverageFailure({
            requestedTopic: personalTopic,
            module: emptyMod,
            reason: 'vocab_insufficient_coverage',
            words: configWords,
            teils: emptyMod === 'horen' ? [1, 2, 3, 4] : [1, 2, 3, 4, 5],
          });
        }
        if (_examConfig.goalId) {
          show('examConfigScreen');
          showExamConfigFootbar(true);
          renderExamConfigurator();
        } else show('flashcardScreen');
        return;
      }

      combined._coverageOverall = {
        found: coveredAll.size,
        total: configWords.length,
        words: [...coveredAll],
        missing: configWords.filter((w) => !coveredAll.has(String(w).toLowerCase())),
        ratio: configWords.length ? coveredAll.size / configWords.length : 0,
      };
      if (anyPartialCoverage) {
        combined._personalCoveragePartial = true;
        combined._personalTextDecision = 'serve_partial';
        combined._personalVocabMinVisible =
          typeof PersonalPoolVocabGate !== 'undefined'
            ? PersonalPoolVocabGate.PERSONAL_VOCAB_MIN_VISIBLE
            : 3;
      }
      if (missingAll.length) {
        combined._partialGen = true;
        combined._missingTeile = missingAll.map((m) => `${m.module} T${m.teil}`);
        combined._poolMissingTeile = missingAll;
      }
      if (relaxedAll.length) {
        combined._poolTopicRelaxed = true;
        combined._poolRelaxedTeile = relaxedAll;
      }
      combined._poolRequestedTopic = personalTopic;
      combined.topicTag = personalTopic;
      const topicStock =
        typeof PersonalTopicStock !== 'undefined'
          ? PersonalTopicStock.stockForPersonalExam(combined, S.subject)
          : typeof PersonalLesenTopicStock !== 'undefined'
            ? PersonalLesenTopicStock
            : null;
      if (topicStock?.formatPersonalExamDisplayTitle) {
        combined._displayTopic = topicStock.formatPersonalExamDisplayTitle(combined, S.subject);
      } else {
        combined._displayTopic = personalTopic;
      }
      combined.topic = combined._displayTopic;

      await finalizePersonalExam(configWords, configSkills, configGoalId, goalRef, combined, 'pool');

      if (missingAll.length && typeof lcToast === 'function') {
        lcToast(
          personalPoolMissingTeileMessage(missingAll.map((m) => m.teil), personalTopic, S.subject),
          'warn',
          7000,
        );
      } else if (relaxedAll.length && typeof lcToast === 'function') {
        const honest = topicStock?.topicHonestyBanner
          ? topicStock.topicHonestyBanner(combined, S.subject)
          : personalPoolTopicRelaxedMessage(personalTopic, S.subject);
        lcToast(honest, 'warn', 8000);
      }
      return;
    }
    // ── fin pool assembly ──

    const tierAi=tier==='pro'||tier==='trial';
    if(tierAi){
      try{
        if(!engineReady())throw new Error('Content engine not loaded');
        const personalGenOpts={
          teilFilter:opts?.teilFilter??_examConfig.teilChoice??'all',
        };
        if(typeof ExamBlueprint!=='undefined'){
          try{
            const bp=await ExamBlueprint.load(S.subject,S.level);
            if(bp)personalGenOpts.blueprint=bp;
          }catch(bpErr){lcDebug.warn('[personal] blueprint preload failed:',bpErr);}
        }
        if(isPersonalLesenHybridEnabled(configSkills,S.subject,S.level)){
          built=await generatePersonalLesenHybrid(configWords,personalGenOpts,tier);
        }else{
          built=await generatePersonalExamAiSerial(configWords,configSkills,configGoalId,personalGenOpts,tier);
        }
      }catch(aiErr){
        const canFallbackLibrary=
          aiErr.code==='ai_credits_exhausted'||
          aiErr.code==='exam_invalid'||
          aiErr.code==='all_modules_failed'||
          /failed validation/i.test(String(aiErr.message||''));
        if(canFallbackLibrary){
          if(aiErr.code==='all_modules_failed'){
            hideAll();
            goHome();
            lcToast(personalGenFailMessage(aiErr),'error',8000);
            return;
          }
          if(aiErr.code==='ai_credits_exhausted'&&typeof showAiCreditsExhausted==='function'){
            showAiCreditsExhausted(aiErr.autoRechargeFailed?{autoRechargeFailed:true,reason:aiErr.reason}:undefined);
          }else if(aiErr.code==='exam_invalid'){
            const recovered=recoverHybridProgressiveExam(configWords,configSkills,aiErr);
            if(recovered){
              built={exam:recovered,source:'ai',hybrid:true};
              lcDebug.warn('[personal] keeping hybrid exam after validation failure');
            }else{
              lcDebug.warn('[personal] AI exam invalid, trying library fallback:',aiErr.message);
            }
          }
          if(!built)built=await tryPersonalPoolOrLibrary(configWords,configSkills,configGoalId,goalRef);
          if(!built){
            if(aiErr.code==='ai_credits_exhausted'){
              hideAll();
              if(_examConfig.goalId){show('examConfigScreen');showExamConfigFootbar(true);renderExamConfigurator();}
              else show('flashcardScreen');
              return;
            }
            throw aiErr;
          }
          if(aiErr.code==='exam_invalid'&&!built?.hybrid){
            lcToast('AI exam could not be validated; assembled from the question library instead.','warn',7000);
          }else if(built?.hybrid&&built.exam?._partialGen){
            lcToast(S.subject==='de'
              ? 'Einige Teile konnten nicht validiert werden — dein personalisiertes Examen bleibt erhalten.'
              : 'Some parts could not be validated — your personalized exam is kept.','warn',8000);
          }
        }else throw aiErr;
      }
    }else{
      built=await tryPersonalPoolOrLibrary(configWords,configSkills,configGoalId,goalRef);
      if(!built){
        hideAll();
        if(typeof showUpgrade==='function')showUpgrade();
        lcToast('No exam in the pool/library matches your words. Upgrade to Pro to generate one with AI.','warn',7000);
        if(_examConfig.goalId){show('examConfigScreen');showExamConfigFootbar(true);renderExamConfigurator();}
        else show('flashcardScreen');
        return;
      }
    }
    await finalizePersonalExam(configWords,configSkills,configGoalId,goalRef,built.exam,built.source);
  }catch(e){
    if(tier==='pro'||tier==='trial'){
      void logAiGeneration({
        lang:S.subject,level:S.level,source:'ai',topic:null,
        vocabWords:configWords||[],coverage:null,valid:false,examData:null
      });
    }
    const rel=await refundActiveGenTicket();
    if(rel?.released)e.quotaReleased=true;
    hideAll();
    if(e.code==='all_modules_failed'||e.code==='quota_insufficient_modules'){
      hideAll();
      goHome();
      lcToast(
        e.code==='all_modules_failed'?personalGenFailMessage(e):e.message,
        'error',
        8000
      );
      return;
    }
    if(e.code==='exam_invalid'&&(e.answerKeyVerify||e.quotaRefund)){
      const renderableHybrid=S.examData&&S.examData.vocabPersonal
        &&Array.isArray(S.examData.lesenParts)
        &&S.examData.lesenParts.some(p=>p&&!p._hybridPending)
        &&typeof isExamRenderable==='function'&&isExamRenderable(S.examData);
      if(renderableHybrid){
        delete S.examData._hybridLoading;
        delete S.examData._hybridPendingTeils;
        hideAll();
        if(typeof renderExam==='function')renderExam();
        lcToast(S.subject==='de'
          ? 'Einige Teile konnten nicht verifiziert werden — du kannst mit dem vorhandenen Examen weitermachen.'
          : 'Some parts could not be verified — you can continue with the exam you have.','warn',8000);
        return;
      }
      S.examData=null;
      hideAll();
      goHome();
      lcToast(e.quotaReleased
        ? 'Could not deliver the exam. Your credit has been refunded — it does not count as a generated exam.'
        : 'Answer-key verification removed all questions. Try generating again.','error',8000);
      return;
    }
    if(e.code==='validation_unavailable'||e.code==='live_gen_disabled'){
      S.examData=null;
      hideAll();
      goHome();
      lcToast(e.quotaReleased
        ? 'Could not verify the generated exam. Your credit has been refunded — please try again.'
        : (e.message||'Could not verify the generated exam. Please try again.'),'error',8000);
      return;
    }
    if(e.code==='timeout'){
      S.examData=null;
      hideAll();
      goHome();
      lcToast(e.quotaReleased
        ? 'Hybrid generation timed out (~55s per Teil). Your credit has been refunded — try again with fewer words.'
        : 'Hybrid generation timed out (~55s per Teil). Try again with fewer words or later.','error',8000);
      return;
    }
    if(!isExamPoolOnly()&&e.code==='exam_invalid'&&(tier==='pro'||tier==='trial')){
      try{
        const fallback=await tryPersonalPoolOrLibrary(configWords,configSkills,configGoalId,goalRef);
        if(fallback){
          await finalizePersonalExam(configWords,configSkills,configGoalId,goalRef,fallback.exam,fallback.source);
          lcToast('AI section had invalid questions; assembled from the question library instead.','warn',7000);
          return;
        }
      }catch(fbErr){lcDebug.warn('[personal] library fallback after exam_invalid failed:',fbErr);}
    }
    if(_examConfig.goalId){
      show('examConfigScreen');
      showExamConfigFootbar(true);
      renderExamConfigurator();
    }else show('flashcardScreen');
    lcToast(
      e.code==='exam_invalid'
        ? (e.quotaReleased
          ? 'Section could not be validated. Your AI credits were refunded.'
          : 'Personal exam failed: '+e.message)
        : 'Personal exam failed: '+e.message,
      'error',8000);
  }
}

function generateNextVocabBatch(goalId){
  const gid=goalId||S.activeGoalId;
  generatePersonalExam(null,null,gid,{skipBatching:true});
}
window.generateNextVocabBatch=generateNextVocabBatch;

function inferLevelFromCards(cards){
  const levels=cards.map(c=>c.sourceExam?.level).filter(Boolean);
  if(!levels.length)return null;
  const freq={};
  levels.forEach(l=>{freq[l]=(freq[l]||0)+1;});
  return Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0];
}

function getSelectedFC(){
  ensureFcIds();
  if(!S.fcSelected.size)return[];
  return S.flashcards.filter(f=>S.fcSelected.has(fcId(f)));
}

function toggleFCSelect(id,ev){
  if(ev){ev.stopPropagation();}
  if(S.fcSelected.has(id))S.fcSelected.delete(id);else S.fcSelected.add(id);
  updFCSelectUI();
  const card=document.getElementById('fc_'+id);
  if(card)card.classList.toggle('fc-selected',S.fcSelected.has(id));
}

function selectAllFC(){
  ensureFcIds();
  getDeckViewCards().forEach(f=>S.fcSelected.add(fcId(f)));
  renderFC(false);
}

function selectDueFC(){
  ensureFcIds();
  S.fcSelected.clear();
  getDeckViewCards().forEach(f=>{if(isDue(f))S.fcSelected.add(fcId(f));});
  renderFC(false);
}

function selectLastExamFC(){
  ensureFcIds();
  const withExam=getDeckViewCards().filter(f=>f.sourceExam?.id);
  if(!withExam.length){
    notify('No words from an exam yet — use Practice Mode and save words.','warn');
    return;
  }
  const latest=withExam.sort((a,b)=>(b.sourceExam.id||0)-(a.sourceExam.id||0))[0];
  const examId=latest.sourceExam.id;
  S.fcSelected.clear();
  withExam.filter(f=>f.sourceExam.id===examId).forEach(f=>S.fcSelected.add(fcId(f)));
  renderFC(false);
}

function clearFCSelect(){
  S.fcSelected.clear();
  renderFC(false);
}

function updFCSelectUI(){
  const n=S.fcSelected.size;
  const cnt=document.getElementById('fcSelCount');
  const pb=document.getElementById('fcPersonalBadge');
  const eb=document.getElementById('fcExamBadge');
  const btn=document.getElementById('btnPersonalExam');
  if(cnt)cnt.textContent=n;
  if(pb)pb.textContent=n+' word'+(n===1?'':'s');
  if(eb)eb.textContent=n+' selected';
  if(btn){
    const proOnly=typeof canUsePersonalized==='function'&&!canUsePersonalized();
    btn.disabled=n<4||(!proOnly&&!canGenerate());
    btn.textContent=proOnly?'Upgrade for personalized exams →':'Generate personal mock exam →';
  }
  const lv=inferLevelFromCards(getSelectedFC());
  const sel=document.getElementById('fcPersonalLevel');
  if(sel&&lv)sel.value=lv;
}

// ═══════════════════════════════════════════
// SECTION PRACTICE — reusable parts + AI fallback
// ═══════════════════════════════════════════

/** IDs of parts already seen by the user for a given (lang, level, module).
 *  Unified registry: full exams (source:'exam') + personal sections (source:'part'). */
function seenPartIds(lang,level,module){
  return [...new Set(
    (S.history||[])
      .filter(h=>h.lang===lang&&h.level===level&&h.partModule===module&&h.partId)
      .map(h=>h.partId)
  )];
}

const _MODULE_LABEL={
  lesen:'Lesen',horen:'Hören',schreiben:'Schreiben',sprechen:'Sprechen',
  reading:'Reading',listening:'Listening',writing:'Writing',speaking:'Speaking'
};

/**
 * Convert a reusable part payload into a minimal single-module exam object
 * that can be passed to renderExam() / examRunner.
 */
function partToSectionExam(part,lang,level){
  const module=part.module||'lesen';
  const teil=part.teil??1;
  const passageText =part.passage?.text ||'';
  const passageTitle=part.passage?.title||'';
  const questions   =Array.isArray(part.questions)?part.questions:[];
  const instruction =part.instruction||'';

  const examPart={teil,questions,instruction};

  if(module==='lesen'||module==='reading'){
    examPart.textTitle=passageTitle;
    examPart.text=passageText;
  }else if(module==='horen'||module==='listening'){
    examPart.transcript=passageText;
    examPart.context   =passageTitle;
    examPart.plays     =2;
  }else if(module==='schreiben'||module==='writing'){
    examPart.prompt=passageText;
  }else if(module==='sprechen'||module==='speaking'){
    examPart.prompt=passageText;
  }

  const partsKey=_MODULE_PART_KEY[module]||'lesenParts';
  const label=_MODULE_LABEL[module]||module;
  return{
    lang:lang||part.lang||S.subject,
    level:level||part.level||S.level,
    topic:`${label} – Teil ${teil}`,
    goetheFormat:true,
    _sectionPart:true,
    _partId:part.id,
    _partModule:module,
    [partsKey]:[examPart]
  };
}

/**
 * Practice a single exam section (module):
 *   1. Try the reusable-parts store (free, instant).
 *   2. If nothing available, fall back to AI generation (uses AI credits).
 *   3. If AI is also unavailable, show a graceful empty-state message.
 *
 * @param {string} module   - e.g. 'lesen', 'horen', 'schreiben', 'sprechen'
 * @param {string} [goalId] - optional goal to associate the session with
 */
async function generateSectionExam(module,goalId){
  const lang =S.subject||'de';
  const level=S.level  ||'B1';
  const label=_MODULE_LABEL[module]||module;

  S.mode     ='practice';
  S.isDemo   =false;
  S.answers  ={};
  S.gapAnswers={};
  S.quickMod =null;
  if(goalId||S.activeGoalId){
    const ref=(goalId?S.goals.find(g=>g.id===goalId):null)||getActiveGoal();
    if(ref){S.subject=ref.subject;S.level=ref.level;S.activeGoalId=ref.id;syncGoalToProfile(ref);}
  }
  initExamSession('practice');

  hideAll();show('loadingScreen');
  document.getElementById('loaderTitle').textContent=`${label} practice…`;
  document.getElementById('loaderSub').textContent  ='Looking for a cached section…';

  // ── 1. Try reusable part ────────────────────────────────────────────────
  let part=null;
  if(typeof fetchExamPart==='function'){
    try{
      const exclude=seenPartIds(lang,level,module);
      part=await fetchExamPart(lang,level,module,exclude);
    }catch(e){
      lcDebug.warn('[section] fetchExamPart error:',e);
    }
  }

  if(part){
    const exam=partToSectionExam(part,lang,level);
    if(typeof normalizeExam==='function')exam&&Object.assign(exam,normalizeExam(exam)||{});
    S.examData  =exam;
    S.examSource='part';
    if(goalId||S.activeGoalId)S.examData.goalId=goalId||S.activeGoalId;
    // Track in history so this part is excluded next time
    const histEntry={
      lang,level,
      partId:part.id,
      partModule:module,
      date:Date.now(),
      source:'part'
    };
    if(!Array.isArray(S.history))S.history=[];
    S.history.push(histEntry);
    try{if(typeof saveProfile==='function')saveProfile();}catch(_){}
    renderExam();
    return;
  }

  // ── 2. AI fallback (costs AI credits) ─────────────────────────────────
  const canAi=typeof canUseAiGeneration==='function'?canUseAiGeneration():
              (typeof canGenerate==='function'?canGenerate():false);

  if(canAi&&isAllowLiveGenEnabled()){
    document.getElementById('loaderSub').textContent=`No cached section found — generating with AI (3 AI credits)…`;
    try{
      const personalGenOpts={
        teilFilter:S.lastPersonalConfig?.teilFilter??_examConfig.teilChoice??'all',
      };
      if(typeof ExamBlueprint!=='undefined'){
        try{const bp=await ExamBlueprint.load(lang,level);if(bp)personalGenOpts.blueprint=bp;}catch(_){}
      }
      const built=await generatePersonalExamAiSerial([],[module],goalId,personalGenOpts,'free');
      if(built&&built.exam){
        built.exam._sectionPart=true;
        built.exam._partModule=module;
        await finalizePersonalExam([],[module],goalId,
          goalId?S.goals.find(g=>g.id===goalId):getActiveGoal(),
          built.exam,built.source);
        return;
      }
    }catch(aiErr){
      lcDebug.warn('[section] AI fallback failed:',aiErr);
      void refundActiveGenTicket();
      // fall through to empty-state
    }
  }

  // ── 3. Empty state — graceful, no error ───────────────────────────────
  hideAll();goHome();
  lcToast(
    `No ${label} practice section is available right now. Check back later or generate a personalized exam.`,
    'info',7000
  );
}

window.generateSectionExam=generateSectionExam;
window.partToSectionExam  =partToSectionExam;
window.fillMissingLesenTeileFromPool=fillMissingLesenTeileFromPool;
window.fillMissingHorenTeileFromPool=fillMissingHorenTeileFromPool;
window.fillMissingSchreibenTeileFromPool=fillMissingSchreibenTeileFromPool;
window.fillMissingSprechenTeileFromPool=fillMissingSprechenTeileFromPool;
window.seenPartIds        =seenPartIds;
window._recordSeenPartsFromExam=_recordSeenPartsFromExam;
window.assembleModuleFromPool=assembleModuleFromPool;
