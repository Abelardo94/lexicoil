#!/usr/bin/env node
/**
 * A2 autonomous generation session — budget-capped, cell-priority ordered.
 * Lesen T4 excluded (HOLD). Writes gate-logs/A2-AUTONOMOUS-SESSION-2026-08-02.md
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const SESSION_ID = '2026-08-02';
const REPORT_MD = path.join(ROOT, `batches/ready/gate-logs/A2-AUTONOMOUS-SESSION-${SESSION_ID}.md`);
const REPORT_JSON = path.join(ROOT, `batches/ready/gate-logs/A2-AUTONOMOUS-SESSION-${SESSION_ID}.json`);
const SESSION_START = new Date().toISOString();

/** Priority: lowest pool-verified + generated stock first. Lesen T4 excluded. */
const CELL_PLAN = [
  { module: 'schreiben', teil: 1, target: 2, targetPerCell: 2 },
  { module: 'schreiben', teil: 2, target: 2, targetPerCell: 2 },
  { module: 'sprechen', teil: 2, target: 1, targetPerCell: 2 },
  { module: 'sprechen', teil: 3, target: 1, targetPerCell: 2 },
  { module: 'sprechen', teil: 1, target: 1, targetPerCell: 2 },
  { module: 'lesen', teil: 3, target: 1, targetPerCell: 3 },
  { module: 'horen', teil: 4, target: 1, targetPerCell: 3 },
  { module: 'lesen', teil: 1, target: 1, targetPerCell: 3 },
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
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => re.test(f) && f.endsWith('.json')).length;
  };
  const records = loadPoolRecords('de', 'A2');
  const { total } = countTopicStock(records, module, teil, 'A2');
  return {
    poolVerified: countDir(poolVerifiedDir('A2'), schRe),
    generated: countDir(generatedDir('A2'), pvRe),
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

  console.log(`\n${'='.repeat(60)}\n▶ ${label} · target=${cell.target} · budget left ${formatCostUsd(BUDGET_USD - costBefore)}\n${'='.repeat(60)}`);

  const proc = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 30 * 1024 * 1024,
  });

  const output = `${proc.stdout || ''}${proc.stderr || ''}`;
  const costAfter = sessionCostUsd();
  const cellCost = Number((costAfter - costBefore).toFixed(6));

  const savedMatch = output.match(/OK\s+(\d+)\/(\d+)\s+partes|Publicada:|partes OK · (\d+)\/(\d+)/g);
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
};

console.log(`A2 autonomous session ${SESSION_ID}`);
console.log(`Budget cap: ${formatCostUsd(BUDGET_USD)} · Lesen T4 HOLD`);
console.log(`Stock snapshot (pre-run):`);
for (const c of CELL_PLAN) {
  const s = countCellStock(c.module, c.teil);
  console.log(`  ${c.module} T${c.teil}: pv=${s.poolVerified} gen=${s.generated} seed=${s.seedTotal}`);
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
  cellResults: state.cellResults,
  costLog: GENERATION_COST_LOG,
};

fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
fs.writeFileSync(REPORT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

let md = `# A2 Autonomous Generation Session — ${SESSION_ID}\n\n`;
md += `- **Started:** ${SESSION_START}\n`;
md += `- **Ended:** ${payload.endedAt}\n`;
md += `- **Budget cap:** ${formatCostUsd(BUDGET_USD)}\n`;
md += `- **Total cost:** ${formatCostUsd(totalCost)}\n`;
md += `- **Stop reason:** ${state.stopReason}\n`;
md += `- **Parts published:** ${state.publishedTotal}\n`;
md += `- **Lesen T4:** HOLD (not attempted)\n\n`;

md += `## Stock priority (pre-run)\n\n| Celda | pool-verified | generated | seed |\n|-------|---------------|-----------|------|\n`;
for (const c of CELL_PLAN) {
  const s = countCellStock(c.module, c.teil);
  md += `| ${c.module} T${c.teil} | ${s.poolVerified} | ${s.generated} | ${s.seedTotal} |\n`;
}

md += `\n## Generation results\n\n| Celda | Published | Cost | Topic | Exit | Notes |\n|-------|-----------|------|-------|------|-------|\n`;
for (const r of state.cellResults) {
  md += `| ${r.cell} | ${r.published} | ${formatCostUsd(r.cellCostUsd)} | ${r.topic ?? '—'} | ${r.exitCode} | ${r.systematicCut ? 'SYSTEMATIC CUT' : ''} |\n`;
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
md += `- Deploy/infra: unchanged (Netlify credits).\n\n`;
md += `## Raw JSON\n\n\`${path.relative(ROOT, REPORT_JSON).replace(/\\/g, '/')}\`\n`;

fs.writeFileSync(REPORT_MD, md, 'utf8');
console.log(`\nSession complete. Cost ${formatCostUsd(totalCost)} · published ${state.publishedTotal}`);
console.log(`Report: ${path.relative(ROOT, REPORT_MD).replace(/\\/g, '/')}`);
process.exit(state.criticalBugs.length && state.publishedTotal === 0 ? 1 : 0);
