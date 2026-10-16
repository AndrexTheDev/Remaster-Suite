#!/usr/bin/env node
/* ============================================================================
 * Test runner. `npm test` runs every suite; the suites are independent (no
 * shared ports, and only the acceptance matrix writes into tools/work), so they
 * run side by side, up to one job per CPU core.
 *
 *   node tools/run-tests.js                  all suites, in parallel
 *   node tools/run-tests.js --only dsp,audit  just those (names below)
 *   node tools/run-tests.js --serial         one at a time (the old order)
 *   RS_JOBS=1 node tools/run-tests.js        same as --serial
 *
 * Each suite's full output goes to tools/work/logs/<suite>.log (git-ignored).
 * The exit code is 1 if any suite fails, so the run can gate a commit.
 * ========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(__dirname, 'work', 'logs');
// order: the slowest suite first, so the parallel wall time is not set by a late start.
// `exclusive` suites assert wall-clock budgets (budget(), "renders at real time"): they
// run alone, after the parallel pool, so a neighbour's CPU load cannot fail them.
const SUITES = [
  { name: 'audit', file: 'tests/audit.test.js', exclusive: true },
  { name: 'acceptance', file: 'tools/acceptance.js' },
  { name: 'e2e', file: 'tests/e2e.test.js' },
  { name: 'dsp', file: 'tests/dsp.test.js' },
  { name: 'tuning', file: 'tests/tuning.test.js' },
  { name: 'web', file: 'tests/web.test.js' },
  { name: 'neural', file: 'tests/neural.test.js' },
];

const args = process.argv.slice(2);
const only = (() => {
  const i = args.indexOf('--only');
  return i >= 0 && args[i + 1] ? args[i + 1].split(',').map((s) => s.trim()) : null;
})();
const serial = args.includes('--serial');
const unknown = (only || []).filter((n) => !SUITES.some((s) => s.name === n));
if (unknown.length) {
  console.error('unknown suite(s): ' + unknown.join(', ') + '  (have: ' + SUITES.map((s) => s.name).join(', ') + ')');
  process.exit(2);
}
const selected = only ? SUITES.filter((s) => only.includes(s.name)) : SUITES;
const pooled = selected.filter((s) => !s.exclusive);
const alone = selected.filter((s) => s.exclusive);
const jobs = serial ? 1 : Math.max(1, Math.min(pooled.length, Number(process.env.RS_JOBS) || os.cpus().length));

fs.mkdirSync(LOGS, { recursive: true });

function runOne(suite) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const log = path.join(LOGS, suite.name + '.log');
    const out = fs.openSync(log, 'w');
    const child = cp.spawn(process.execPath, [path.join(ROOT, suite.file)], { cwd: ROOT, stdio: ['ignore', out, out] });
    child.on('close', (code) => {
      fs.closeSync(out);
      const secs = (Date.now() - t0) / 1000;
      const text = fs.readFileSync(log, 'utf8');
      resolve({ suite, code, secs, log, text });
    });
  });
}

async function main() {
  const t0 = Date.now();
  console.log('running ' + selected.length + ' suite(s), ' + jobs + ' at a time'
    + (alone.length ? ', then ' + alone.map((s) => s.name).join(', ') + ' alone' : '') + ': '
    + selected.map((s) => s.name).join(', '));
  const results = [];
  const report = (r) => {
    results.push(r);
    console.log('  ' + (r.code === 0 ? 'ok  ' : 'FAIL') + '  ' + r.suite.name.padEnd(11) + r.secs.toFixed(0).padStart(5) + ' s');
  };
  let next = 0;
  const worker = async () => {
    while (next < pooled.length) report(await runOne(pooled[next++]));
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  for (const suite of alone) report(await runOne(suite));

  const failed = results.filter((r) => r.code !== 0);
  for (const r of failed) {
    console.log('\n── ' + r.suite.name + ' failed (exit ' + r.code + ') · full log: ' + path.relative(ROOT, r.log));
    console.log(r.text.split('\n').filter((l) => !/^\s+at /.test(l)).slice(-40).join('\n'));
  }
  const wall = (Date.now() - t0) / 1000;
  const sum = results.reduce((a, r) => a + r.secs, 0);
  console.log('\n' + (failed.length ? failed.length + ' suite(s) FAILED' : 'all ' + results.length + ' suite(s) passed')
    + ' · wall ' + wall.toFixed(0) + ' s (sum of suites ' + sum.toFixed(0) + ' s)');
  process.exit(failed.length ? 1 : 0);
}

main();
