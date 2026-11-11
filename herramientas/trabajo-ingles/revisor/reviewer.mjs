// Cambridge B1 Preliminary item reviewer — calibration harness.
// Usage: node reviewer.mjs <model> [units.json] [outDir] [--limit N]
// Reads ANTHROPIC_API_KEY from the project .env (never printed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV = 'C:/Danilo/Programas/LEXICOIL/lexiloop/.env';
for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^ANTHROPIC_API_KEY=(.*)$/);
  if (m) process.env.ANTHROPIC_API_KEY = m[1].trim().replace(/^["']|["']$/g, '');
}

const [model = 'claude-opus-5', unitsFile = 'units.json', outDir = `out-${model}`] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const PRICES = { 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'claude-opus-5-5': [4, 20] };

const PROBLEM_TYPES = [
  'wrong_key',            // the marked answer is not the correct one
  'multiple_correct',     // another option (or another word, for open gaps) is also acceptable
  'no_correct',           // no option is correct
  'key_unsupported',      // the text/recording does not contain what the key needs
  'explanation_mismatch', // explanation contradicts the key or the text
  'duplicate_option',
  'above_level',          // vocabulary/grammar clearly beyond B1
  'unnatural_english',
  'format',               // breaks the Cambridge B1 Preliminary task format
  'other',
];

const Review = z.object({
  questions: z.array(z.object({
    id: z.string(),
    verdict: z.enum(['pass', 'fail']),
    problems: z.array(z.object({
      type: z.enum(PROBLEM_TYPES),
      detail: z.string(),
    })),
  })),
  part_problems: z.array(z.object({
    type: z.enum(PROBLEM_TYPES),
    detail: z.string(),
  })),
});

const SYSTEM = `You are a senior Cambridge English item reviewer for B1 Preliminary (PET). You check exam parts written by another model before they are published to learners.

For every question, decide pass or fail. Fail it only for a real defect a learner would suffer from:
- wrong_key: the marked answer is not the best answer according to the text or recording.
- multiple_correct: a second option is also defensible from the text; in a multiple-choice cloze, another option also fits the gap grammatically AND in meaning/collocation; in an open cloze or gap-fill, another common word also fits naturally. Open cloze (Reading Part 6) must gap grammatical/function words so that only one word fits; a content word as the key (a verb, noun or adjective with obvious synonyms) is a defect.
- no_correct: no option is correct.
- key_unsupported: the text or transcript does not actually contain the information the key relies on, or says the opposite.
- explanation_mismatch: the explanation contradicts the key, names a different option, or misquotes the text.
- duplicate_option: two options are identical or mean exactly the same.
- above_level: the item depends on vocabulary or grammar clearly beyond B1.
- unnatural_english: wording a native British speaker would find wrong or odd.
- format: the part breaks the B1 Preliminary task format.

Work like an examiner: for each question, read the relevant part of the text, then test EVERY option against it, not only the key. For matching parts, check that each person matches exactly one text. For gapped texts, check that no other sentence fits the gap.

Be precise, not picky. Stylistic preferences, slightly easy items and debatable wording that still has one clearly best answer are passes. Keys are letters (a, b, c…) mapping to options in order, or the missing word(s) for gap tasks. Answer in English, one short sentence per problem.`;

function renderUnit(u) {
  const qs = u.questions.map((q) => ({
    id: q.id,
    ...(q.segment ? { recording: q.segment } : {}),
    question: q.question,
    ...(q.options?.length ? { options: q.options } : {}),
    key: q.correct,
    explanation: q.explanation,
  }));
  return [
    `Part: ${u.module === 'reading' ? 'Reading' : 'Listening'} Part ${u.teil} (${u.slot})`,
    `Instruction: ${u.instruction}`,
    '',
    u.module === 'reading' ? 'TEXT:' : 'TRANSCRIPT:',
    u.text,
    '',
    'QUESTIONS (with the key and explanation to be checked):',
    JSON.stringify(qs, null, 1),
  ].join('\n');
}

const client = new Anthropic();
const units = JSON.parse(fs.readFileSync(path.join(here, unitsFile), 'utf8')).slice(0, LIMIT);
fs.mkdirSync(path.join(here, outDir), { recursive: true });

let inTok = 0, outTok = 0, done = 0, failed = 0;
async function reviewOne(u, i) {
  const outFile = path.join(here, outDir, `${String(i).padStart(3, '0')}.json`);
  if (fs.existsSync(outFile)) return;
  try {
    const res = await client.messages.parse({
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: zodOutputFormat(Review) },
      system: SYSTEM,
      messages: [{ role: 'user', content: renderUnit(u) }],
    });
    inTok += res.usage.input_tokens; outTok += res.usage.output_tokens;
    if (res.stop_reason === 'refusal' || !res.parsed_output) {
      failed++;
      fs.writeFileSync(outFile, JSON.stringify({ unitId: u.unitId, error: res.stop_reason || 'unparsed', usage: res.usage }, null, 1));
      return;
    }
    fs.writeFileSync(outFile, JSON.stringify({ unitId: u.unitId, review: res.parsed_output, usage: res.usage }, null, 1));
  } catch (e) {
    failed++;
    const kind = e instanceof Anthropic.RateLimitError ? 'rate_limit' : e instanceof Anthropic.APIError ? `api_${e.status}` : 'error';
    fs.writeFileSync(outFile + '.err', JSON.stringify({ unitId: u.unitId, error: kind, message: String(e.message).slice(0, 300) }));
  } finally {
    done++;
    if (done % 5 === 0 || done === units.length) console.log(`${model}: ${done}/${units.length} (errores ${failed})`);
  }
}

const CONC = 4;
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < units.length) { const i = next++; await reviewOne(units[i], i); }
}));
const [pi, po] = PRICES[model] || [0, 0];
console.log(`${model}: tokens in=${inTok} out=${outTok} · coste ≈ $${((inTok * pi + outTok * po) / 1e6).toFixed(3)} · errores ${failed}`);
