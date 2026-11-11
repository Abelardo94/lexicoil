// node tts-fingerprint.mjs <worktree> : count + hash of every German TTS job (voice|text) the app
// would request for the served de/A2 and de/B1 exams. Same numbers in two worktrees = no cached
// clip is invalidated by the change between them.
import crypto from 'node:crypto';
const W = process.argv[2].replace(/\\/g, '/');
process.chdir(W);
const { resolveServedExams } = await import('file:///' + W + '/scripts/lib/servedExams.mjs');
const { collectExamTtsJobs } = await import('file:///' + W + '/scripts/lib/ttsJobs.mjs');
const out = [];
for (const lv of ['A2', 'B1']) {
  const r = await resolveServedExams('de', lv);
  const jobs = r.exams.flatMap((e) => collectExamTtsJobs(e, 'de')).map((j) => j.voice + '|' + j.text).sort();
  out.push(`${lv}: ${jobs.length} clips, huella ${crypto.createHash('sha1').update(jobs.join('\n')).digest('hex').slice(0, 12)}`);
}
console.log(W.split('/').pop(), '·', out.join(' · '));
