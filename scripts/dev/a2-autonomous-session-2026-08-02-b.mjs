#!/usr/bin/env node
/**
 * A2 autonomous generation session (continuation) — budget-capped, stock-priority.
 * Lesen T4 excluded (HOLD). Lesen T1 fix applied pre-run (prompt + retry).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, loadEnvFile } from '../lib/loadEnv.mjs';
import {
  GENERATION_COST_LOG,
  readGenerationCostLog,
  filterGenerationCostSince,
  formatCostUsd,
} from '../lib/generationCostLog.mjs';
import { loadPoolRecords, countTopicStock } from '../lib/poolGapPlanner.mjs';
import { generatedDir, poolVerifiedDir } from '../lib/batchPaths.mjs';

loadEnvFile();

const require = createRequire(import.meta.url);
const { A2_OFFICIAL_TOPICS } = require(path.join(ROOT, 'js/data/a2Topics.js'));

const BUDGET_USD = 3.0;
const SESSION_ID = '2026-08-02-b';
const REPORT_MD = path.join(ROOT, `batches/ready/gate-logs/A2-AUTONOMOUS-SESSION-${SESSION_ID}.md`);
const REPORT_JSON = path.join(ROOT, `batches/ready/gate-logs/A2-AUTONOMOUS-SESSION-${SESSION_ID}.json`);
const RUN_LOG = path.join(ROOT, `batches/ready/gate-logs/a2-autonomous-session-${SESSION_ID}-run.log`);
const SESSION_START = new Date().toISOString();

/** Priority by lowest gemini stock (pre-run 2026-08-02-b). Lesen T4 excluded. */
const CELL_PLAN = [
  { module: 'lesen', teil: 3, target: 2, targetPerCell: 3 },
  { module: 'sprechen', teil: 2, target: 1, targetPerCell: 2 },
  { module: 'sprechen', teil: 3, target: 1, targetPerCell: 2 },
  { module: 'lesen', teil: 1, target: 1, targetPerCell: 3 },
  { module: 'horen', teil: 4, target: 1, targetPerCell: 3 },
  { module: 'sprechen', teil: 1, target: 1, targetPerCell: 2 },
  { module: 'lesen', teil: 2, target: 1, targetPerCell: 3 },
  { module: 'horen', teil: 1, target: 1, targetPerCell: 3 },
  { module: 'horen', teil: 3, target: 1, targetPerCell: 3 },
  { module: 'horen', teil: 2, target: 1, targetPerCell: 3 },
];

const SYSTEMATIC_PATTERNS = [
  { id: 'topic_off_axis', re: /Tema inválido para A2|tema.*(?:Freizeit|Bildung|Arbeit|Ernährung)/i, note: 'Tema fuera de 5 ejes oficiales A2' },
  { id: 'checklist_b1_leak', re: /10 questions \(sN-q1 RF|exactamente 3 questions con "teil":1, "teil":2, "teil":3|7× richtig_falsch/i, note: 'Checklist B1 inyectada en prompt A2/B2' },
  { id: 'workshop_gate', re: /Workshop.*(?:rechaz|PROHIB|blacklist|anglicism)/i, note: 'Workshop no comunicado en prompt / gate anglicism' },
  { id: 'options_missing_repeat', re: /options_missing/g, note: 'MCQ sin options (Gemini/prompt)' },
  { id: 'question_alias', re: /questionText|resolveQuestionStem|stem.*empty/i, note: 'Campo question vs alias' },
  { id: 'content_topic_batch', re: /content_topic_mismatch.*passage/i, note: 'content_topic per-passage (umbrella)' },
];

function sessionCostUsd() {
  const entries = filterGenerationCostSince(readGenerationCostLog(), SESSION_START);
  return Number(entries.reduce((s, e) => s + (Number(e.costUsd) || 0), 0).toFixed(6));
}

function countCellStock(module, teil) {
  const pvRe = new RegExp(`^${module}-t${teil}-.*\\.json$`, 'i');
  const schRe = module === 'schreiben' ? /^schreiben-.*\.json$/i : pvRe;
  const countDir = (dir, re) => {
    if (!fs.existsSync(dir)) return { total: 0, gemini: 0 };
    const files = fs.readdirSync(dir).filter((f) => re.test(f) && f.endsWith('.json'));
    return { total: files.length, gemini: files.filter((f) => f.includes('gemini')).length };
  };
  const records = loadPoolRecords('de', 'A2');
  const { total } = countTopicStock(records, module, teil, 'A2');
  const pv = countDir(poolVerifiedDir('A2'), schRe);
  const gen = countDir(generatedDir('A2'), pvRe);
  return {
    poolVerified: pv.total,
    geminiPv: pv.gemini,
    generated: gen.total,
    seedTotal: total,
  };
}

function classifyFailure(output, prevReason) {
  const reasons = [];
  for (const p of SYSTEMATIC_PATTERNS) {
    if (p.re.test(output)) reasons.push(p.id);
  }
  const optsMissing = (output.match(/options_missing/g) || []).length;
  if (optsMissing >= 2) reasons.push('options_missing_repeat');
  const gateMatch = output.match(/gate[=:]\s*(\S+)|Problemas:\s*\n\s*-\s*(\S+)/i);
  const gate = gateMatch?.[1] || gateMatch?.[2] || null;
  const reasonKey = reasons.sort().join('|') || gate || 'unknown';
  const repeat = Boolean(prevReason && prevReason === reasonKey);
  const heavyRepeat = optsMissing >= 2 || (output.match(/content_topic_mismatch/g) || []).length >= 2;
  return { reasonKey, reasons, gate, systematic: reasons.length > 0 && (repeat || heavyRepeat) };
}

function runCell(cell, state) {
  const label = `${cell.module} T${cell.teil}`;
  const cellStart = new Date().toISOString();
  const costBefore = sessionCostUsd();

  const args = [
    'scripts/pool-fill-teil.mjs',
    '--module', cell.module,
    '--teil', String(cell.teil),
    '--level', 'A2',
    '--target', String(cell.target),
    '--target-per-cell', String(cell.targetPerCell),
    '--publish',
    '--reset',
    '--max-attempts', String(Math.min(cell.target * 4, 8)),
    '--fix-retries', '1',
    '--max-api-calls', '12',
    '--rotate-every', '1',
  ];

  const header = `\n${'='.repeat(60)}\n▶ ${label} · target=${cell.target} · budget left ${formatCostUsd(BUDGET_USD - costBefore)}\n${'='.repeat(60)}\n`;
  console.log(header);
  fs.appendFileSync(RUN_LOG, header);

  const proc = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 30 * 1024 * 1024,
  });

  const output = `${proc.stdout || ''}${proc.stderr || ''}`;
  fs.appendFileSync(RUN_LOG, output);

  const costAfter = sessionCostUsd();
  const cellCost = Number((costAfter - costBefore).toFixed(6));

  const published = (output.match(/Publicada:/g) || []).length;
  const topicMatch = output.match(/Siguiente tema sugerido: (\S+)|Tema: (\S+)/);
  const topic = topicMatch?.[1] || topicMatch?.[2] || null;
  const topicOk = !topic || A2_OFFICIAL_TOPICS.includes(topic);

  const fail = classifyFailure(output, state.lastFailReason?.[label]);
  if (!state.lastFailReason) state.lastFailReason = {};
  state.lastFailReason[label] = fail.reasonKey;

  const entry = {
    cell: label,
    module: cell.module,
    teil: cell.teil,
    target: cell.target,
    exitCode: proc.status,
    published,
    topic,
    topicOfficial: topicOk,
    cellCostUsd: cellCost,
    sessionCostUsdAfter: costAfter,
    fail,
    systematicCut: fail.systematic,
    outputTail: output.split('\n').slice(-25).join('\n'),
    at: cellStart,
  };

  if (fail.systematic) {
    state.criticalBugs.push({
      cell: label,
      pattern: fail.reasons,
      reasonKey: fail.reasonKey,
      gate: fail.gate,
      evidence: output.split('\n').filter((l) => /FAIL|Problemas|options_missing|content_topic|Tema inválido|Workshop/i.test(l)).slice(0, 12),
      outputSample: output.slice(-4000),
    });
  }

  state.cellResults.push(entry);
  state.publishedTotal += published;
  return entry;
}

const state = {
  cellResults: [],
  criticalBugs: [],
  publishedTotal: 0,
  stopReason: null,
  lastFailReason: {},
  fixesApplied: [
    {
      id: 'lesen_t1_mcq_rf_leak',
      status: 'fixed_not_verified_with_spend',
      files: [
        'plantillas-lesen-a2/lesen-teil1.md',
        'scripts/lib/lesenTemplatePrompt.mjs',
        'scripts/generate-lesen-part-gemini.mjs',
      ],
      note: 'Pre-run fix: forbid correct true/false + trigger clean regen on options_missing',
    },
  ],
};

fs.mkdirSync(path.dirname(RUN_LOG), { recursive: true });
fs.writeFileSync(RUN_LOG, `A2 autonomous session ${SESSION_ID} started ${SESSION_START}\n`, 'utf8');

console.log(`A2 autonomous session ${SESSION_ID} (continuation)`);
console.log(`Budget cap: ${formatCostUsd(BUDGET_USD)} · Lesen T4 HOLD`);
console.log(`Stock snapshot (pre-run):`);
for (const c of CELL_PLAN) {
  const s = countCellStock(c.module, c.teil);
  console.log(`  ${c.module} T${c.teil}: pv=${s.poolVerified} gemini_pv=${s.geminiPv} gen=${s.generated}`);
}

for (const cell of CELL_PLAN) {
  const spent = sessionCostUsd();
  if (spent >= BUDGET_USD) {
    state.stopReason = 'budget_cap';
    console.log(`\n⛔ Budget cap reached (${formatCostUsd(spent)} >= ${formatCostUsd(BUDGET_USD)})`);
    break;
  }

  const prevBug = state.criticalBugs.find((b) => b.cell === `${cell.module} T${cell.teil}`);
  if (prevBug) continue;

  const result = runCell(cell, state);
  if (result.systematicCut) {
    console.log(`\n⛔ Systematic bug on ${result.cell} — cutting cell (${result.fail.reasonKey})`);
  }

  if (sessionCostUsd() >= BUDGET_USD) {
    state.stopReason = 'budget_cap';
    break;
  }
}

if (!state.stopReason) state.stopReason = 'plan_complete';

const totalCost = sessionCostUsd();
const payload = {
  sessionId: SESSION_ID,
  startedAt: SESSION_START,
  endedAt: new Date().toISOString(),
  budgetUsd: BUDGET_USD,
  totalCostUsd: totalCost,
  stopReason: state.stopReason,
  publishedTotal: state.publishedTotal,
  criticalBugs: state.criticalBugs,
  fixesApplied: state.fixesApplied,
  cellResults: state.cellResults,
  costLog: GENERATION_COST_LOG,
};

fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
fs.writeFileSync(REPORT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

let md = `# A2 Autonomous Generation Session — ${SESSION_ID}\n\n`;
md += `Continuación de sesión autónoma A2. Generación + publicación vía \`pool-fill-teil.mjs --publish\`, tope **$3.00 USD**, **Lesen T4 en HOLD**.\n\n`;
md += `- **Started:** ${SESSION_START}\n`;
md += `- **Ended:** ${payload.endedAt}\n`;
md += `- **Budget cap:** ${formatCostUsd(BUDGET_USD)}\n`;
md += `- **Total cost:** ${formatCostUsd(totalCost)}\n`;
md += `- **Stop reason:** ${state.stopReason}\n`;
md += `- **Parts published:** ${state.publishedTotal}\n`;
md += `- **Lesen T4:** HOLD (not attempted)\n\n`;

md += `## Stock priority (pre-run)\n\nConteo real por celda (gemini en pool-verified). Orden: menor stock primero.\n\n`;
md += `| Celda | pv | gemini_pv | generated | seed |\n|-------|-----|-----------|-----------|------|\n`;
for (const c of CELL_PLAN) {
  const s = countCellStock(c.module, c.teil);
  md += `| ${c.module} T${c.teil} | ${s.poolVerified} | ${s.geminiPv} | ${s.generated} | ${s.seedTotal} |\n`;
}

md += `\n## Generation results\n\n| Celda | Published | Cost | Topic | Exit | Notes |\n|-------|-----------|------|-------|------|-------|\n`;
for (const r of state.cellResults) {
  const notes = [];
  if (r.systematicCut) notes.push('SYSTEMATIC CUT');
  if (r.topic && !r.topicOfficial) notes.push('TOPIC OFF-AXIS');
  md += `| ${r.cell} | ${r.published} | ${formatCostUsd(r.cellCostUsd)} | ${r.topic ?? '—'} | ${r.exitCode} | ${notes.join('; ') || '—'} |\n`;
}

if (state.fixesApplied.length) {
  md += `\n## Fixes pre-aplicados (esta sesión)\n\n`;
  for (const f of state.fixesApplied) {
    md += `### ${f.id}\n\n`;
    md += `- **Status:** ${f.status}\n`;
    md += `- **Files:** ${f.files.map((x) => `\`${x}\``).join(', ')}\n`;
    md += `- **Note:** ${f.note}\n\n`;
  }
}

if (state.criticalBugs.length) {
  md += `\n## Critical bugs (systematic)\n\n`;
  for (const b of state.criticalBugs) {
    md += `### ${b.cell}\n\n`;
    md += `- **Patterns:** ${b.pattern.join(', ') || b.reasonKey}\n`;
    md += `- **Gate:** ${b.gate ?? '—'}\n\n`;
    md += `Evidence:\n\`\`\`\n${(b.evidence || []).join('\n')}\n\`\`\`\n\n`;
  }
} else {
  md += `\n## Critical bugs\n\nNone flagged as systematic (repeat pattern).\n\n`;
}

md += `## Pending / decisions\n\n`;
md += `- Lesen T4: still HOLD (batch-level content_topic design not implemented).\n`;
md += `- Deploy/infra: unchanged (Netlify credits).\n`;
md += `- Lesen T1 fix: commit pendiente de OK del usuario.\n\n`;
md += `## Artifacts\n\n`;
md += `- Run log: \`${path.relative(ROOT, RUN_LOG).replace(/\\/g, '/')}\`\n`;
md += `- Raw JSON: \`${path.relative(ROOT, REPORT_JSON).replace(/\\/g, '/')}\`\n`;

fs.writeFileSync(REPORT_MD, md, 'utf8');
console.log(`\nSession complete. Cost ${formatCostUsd(totalCost)} · published ${state.publishedTotal}`);
console.log(`Report: ${path.relative(ROOT, REPORT_MD).replace(/\\/g, '/')}`);
process.exit(state.criticalBugs.length && state.publishedTotal === 0 ? 1 : 0);
