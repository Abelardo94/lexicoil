#!/usr/bin/env node
/**
 * Runs the whole engine suite and reports every result.
 *
 * `test:engine` was 70 commands joined with `&&`. The sixth
 * (test-vocab-personalization.mjs) has failed since before June 2026, so the
 * other 64 never ran: nobody knew whether they passed. A suite that stops at the
 * first failure reports one red and hides an unknown number of others, which is
 * the same "green from not looking" this repo keeps getting bitten by — only
 * here it is a red that hides the rest.
 *
 * The command list stays in package.json under `test:engine:chain`, verbatim and
 * unduplicated; this runner parses it from there.
 *
 *   node scripts/run-engine-tests.mjs                 # all of them, exit 1 if any fail
 *   node scripts/run-engine-tests.mjs --only vocab    # substring filter
 *   node scripts/run-engine-tests.mjs --timeout 180   # seconds per test (default 120)
 *   node scripts/run-engine-tests.mjs --json out.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib/loadEnv.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const only = flag('--only', null);
const timeoutMs = Number(flag('--timeout', 120)) * 1000;
const jsonOut = flag('--json', null);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const chain = pkg.scripts['test:engine:chain'];
if (!chain) {
  console.error('No existe el script "test:engine:chain" en package.json — es la lista de comandos.');
  process.exit(2);
}

let commands = chain.split('&&').map((s) => s.trim()).filter(Boolean);
if (only) commands = commands.filter((c) => c.includes(only));

console.log(`Suite del motor: ${commands.length} comandos\n`);

const results = [];
for (const [i, cmd] of commands.entries()) {
  const n = `${String(i + 1).padStart(2)}/${commands.length}`;
  const label = cmd.replace(/^node\s+scripts\//, '').replace(/\.mjs$|\.js$/, '');
  process.stdout.write(`${n}  ${label.padEnd(42)} `);

  const started = Date.now();
  const parts = cmd.split(/\s+/);
  const r = spawnSync(parts[0], parts.slice(1), {
    cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, shell: false,
  });
  const ms = Date.now() - started;

  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  const ok = !timedOut && r.status === 0;
  const output = `${r.stdout || ''}${r.stderr || ''}`;

  // The line that explains the failure, not the last line of a stack.
  const firstError = output.split(/\r?\n/)
    .find((l) => /^(Error|FAIL|AssertionError|\s*✗|\s*x\s)/i.test(l.trim()) || /\bFAIL\b/.test(l))
    || output.split(/\r?\n/).filter(Boolean).pop() || '';

  results.push({ cmd, label, ok, timedOut, status: r.status, ms, firstError: firstError.trim(), output });
  console.log(`${ok ? 'OK  ' : timedOut ? 'TIMEOUT' : 'FALLA'}  ${(ms / 1000).toFixed(1)}s`);
}

const failed = results.filter((r) => !r.ok);

console.log(`\n${'='.repeat(72)}`);
console.log(`${results.length - failed.length} en verde · ${failed.length} en rojo\n`);

if (failed.length) {
  console.log('EN ROJO:');
  for (const r of failed) {
    console.log(`\n  ${r.label}${r.timedOut ? '  (timeout)' : ''}`);
    console.log(`    ${r.firstError.slice(0, 200) || '(sin mensaje)'}`);
  }
  console.log();
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    ranAt: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results: results.map(({ output, ...r }) => r),
  }, null, 2));
  console.log(`Informe → ${jsonOut}`);
}

process.exit(failed.length ? 1 : 0);
