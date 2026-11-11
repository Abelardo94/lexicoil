// GET /.netlify/functions/tts for every clip the served en/B1 exams ask for. GET only reads the
// cache (never synthesizes or charges): audio or {found:true,audioBase64} (>~1 KB) = present,
// {found:false} = missing.
import fs from 'node:fs';
const W = 'C:/Danilo/Programas/LEXICOIL/lexiloop-en12';
const { collectExamTtsJobs } = await import('file:///' + W + '/scripts/lib/ttsJobs.mjs');
const LANG = process.argv[2] || 'en'; const exams = process.argv.slice(3).flatMap((f) => { const s = JSON.parse(fs.readFileSync(W + '/data/exams/' + f + '.json', 'utf8')); return Array.isArray(s) ? s : s.exams; });
const seen = new Set(); const jobs = [];
exams.forEach((e, i) => { for (const j of collectExamTtsJobs(e, LANG)) { const k = j.voice + '|' + j.text; if (!seen.has(k)) { seen.add(k); jobs.push({ ...j, exam: i + 1 }); } } });
const res = { ok: 0, missing: [], error: [] }; const perExam = {};
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    const url = `https://www.lexicoil.com/.netlify/functions/tts?lang=${LANG}&voice=${encodeURIComponent(j.voice)}&text=${encodeURIComponent(j.text)}`;
    let kind;
    try {
      let r;
      for (let t = 0; t < 8; t++) { r = await fetch(url); if (r.status !== 429) break; await new Promise((ok) => setTimeout(ok, 4000 * (t + 1))); }
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.startsWith('audio/')) { kind = 'ok'; await r.arrayBuffer(); }
      else { const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} kind = j && j.found === true && String(j.audioBase64 || '').length > 1300 ? 'ok' : j && j.found === false ? 'missing' : 'error:' + r.status + ' ' + t.slice(0, 60); }
    } catch (e) { kind = 'error:' + e.message; }
    perExam[j.exam] = perExam[j.exam] || { ok: 0, bad: 0 };
    if (kind === 'ok') { res.ok++; perExam[j.exam].ok++; } else { perExam[j.exam].bad++; (kind === 'missing' ? res.missing : res.error).push(`e${j.exam} ${kind} ${j.text.slice(0, 50)}`); }
  }
}
await Promise.all(Array.from({ length: 2 }, worker));
console.log('clips', jobs.length, '· responden', res.ok, '· faltan', res.missing.length, '· errores', res.error.length);
console.log('por examen', JSON.stringify(perExam));
for (const x of [...res.missing, ...res.error].slice(0, 10)) console.log('  ', x);
