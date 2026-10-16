/* =============================================================================
 * Remaster Suite — mobile memory budget guard test suite
 * -----------------------------------------------------------------------------
 * `RSMemoryGuard` is pure logic wrapped around one non-standard, Chromium-only
 * browser API (`performance.memory`), so it is tested two ways:
 *
 *   · the real module, required straight into plain Node, proving the honest
 *     "no signal here" fallback actually happens (Node has no `.memory`);
 *   · the same module with a fake `performance.memory` (and, separately, an
 *     explicit `heap` snapshot passed straight to `suggestChunkSeconds()`) to
 *     exercise the shrink/clamp/hysteresis-adjacent behaviour deterministically.
 *
 * Run:  node tests/memory-guard.test.js
 * ========================================================================== */
'use strict';

const path = require('path');
const H = require('./harness.js');
const ROOT = H.ROOT;

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label + (detail ? '  → ' + detail : '')); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label + '  → ' + (detail === undefined ? 'failed' : detail)); }
}
function section(name) { console.log('\n▸ ' + name); }

function fresh() {
  const modPath = path.join(ROOT, 'assets', 'js', 'memory-guard.js');
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

function run() {
  /* ---------------------------------------------------------- no signal at all */
  section('heapInfo() · honest about what plain Node (and iOS Safari) cannot see');
  {
    const RSMemoryGuard = fresh();
    ok(RSMemoryGuard.heapInfo() === null, 'no performance.memory in plain Node → null, not a thrown error');
    ok(RSMemoryGuard.deviceMemoryGB() === null, 'no navigator.deviceMemory either → null');
    const base = RSMemoryGuard.suggestChunkSeconds(10);
    ok(base === 10, 'with no signal, the caller\'s own requested chunk size is trusted unchanged', String(base));
    ok(RSMemoryGuard.suggestChunkSeconds(0.1) === RSMemoryGuard.DEFAULTS.min, 'a sub-minimum request is still clamped up to the floor even with no signal');
    ok(RSMemoryGuard.suggestChunkSeconds(999, { max: 12 }) === 12, 'a request above an explicit ceiling is clamped down to it');
  }

  /* -------------------------------------------------------------- fake heap */
  section('heapInfo() · reads a Chromium-shaped performance.memory when one exists');
  {
    const RSMemoryGuard = fresh();
    const realPerf = global.performance;
    try {
      global.performance = { memory: { usedJSHeapSize: 300 * 1e6, jsHeapSizeLimit: 1000 * 1e6 } };
      const info = RSMemoryGuard.heapInfo();
      ok(!!info && Math.abs(info.ratio - 0.3) < 1e-9, 'ratio is used/limit', JSON.stringify(info));

      global.performance = { memory: { usedJSHeapSize: 1200 * 1e6, jsHeapSizeLimit: 1000 * 1e6 } };
      const over = RSMemoryGuard.heapInfo();
      ok(over.ratio === 1, 'an (impossible but seen in the wild) over-100% reading is clamped to 1, not reported raw');

      global.performance = { memory: { usedJSHeapSize: 10, jsHeapSizeLimit: 0 } };
      ok(RSMemoryGuard.heapInfo() === null, 'a zero/garbage limit is treated as no signal, not a divide-by-zero');

      global.performance = {};
      ok(RSMemoryGuard.heapInfo() === null, 'performance without .memory (Firefox, Safari) is null too');
    } finally {
      global.performance = realPerf;
    }
  }

  /* --------------------------------------------------------- shrink behaviour */
  section('suggestChunkSeconds() · shrinks toward the floor as pressure rises, one-way ratchet shape');
  {
    const RSMemoryGuard = fresh();
    const base = 10;
    const atRatio = (ratio) => RSMemoryGuard.suggestChunkSeconds(base, { heap: { ratio } });

    ok(atRatio(0.10) === base, 'well below the high-water mark: unchanged', String(atRatio(0.10)));
    ok(atRatio(0.70) === base, 'exactly at the high-water mark: still unchanged (the ramp starts just past it)');
    const mid = atRatio(0.80);
    ok(mid < base && mid > RSMemoryGuard.DEFAULTS.min, 'between high-water and critical: shrunk, but not to the floor yet', mid.toFixed(2));
    const higher = atRatio(0.85);
    ok(higher < mid, 'closer to critical shrinks further still — the ramp is monotonic', higher.toFixed(2) + ' < ' + mid.toFixed(2));
    ok(atRatio(0.90) === RSMemoryGuard.DEFAULTS.min, 'at the critical mark: pinned at the floor');
    ok(atRatio(0.99) === RSMemoryGuard.DEFAULTS.min, 'past critical: still pinned at the floor, never negative or zero');

    const customBounds = RSMemoryGuard.suggestChunkSeconds(20, { heap: { ratio: 0.95 }, min: 3, max: 20 });
    ok(customBounds === 3, 'a caller-supplied floor is honoured, not the module default', String(customBounds));

    const neverBelowOne = RSMemoryGuard.suggestChunkSeconds(0.4, { heap: { ratio: 0.95 }, min: 0.1 });
    ok(neverBelowOne >= 0.1 && isFinite(neverBelowOne), 'the result is always finite and respects an unusually small floor');
  }

  /* ------------------------------------------------------------------- watch() */
  section('watch() · polls on an interval and always returns a working stop function');
  {
    const RSMemoryGuard = fresh();
    const realPerf = global.performance;
    global.performance = { memory: { usedJSHeapSize: 5, jsHeapSizeLimit: 10 } };
    const seen = [];
    // watch() floors the interval at 250 ms on purpose (never poll faster than
    // that) — the test waits past two of them rather than fighting the floor
    const stop = RSMemoryGuard.watch((info) => seen.push(info), 10);
    return new Promise((resolve) => {
      setTimeout(() => {
        stop();
        const countAtStop = seen.length;
        ok(countAtStop >= 1, 'the callback fired at least once', String(countAtStop));
        ok(seen.every((i) => i && isFinite(i.ratio)), 'every delivered snapshot is a real heapInfo() shape');
        setTimeout(() => {
          ok(seen.length === countAtStop, 'after stop() no further callbacks arrive', seen.length + ' === ' + countAtStop);
          global.performance = realPerf;

          const noopStop = RSMemoryGuard.watch('not a function', 10);
          ok(typeof noopStop === 'function', 'a bad listener still gets a safe, callable stop function back');
          noopStop();

          console.log('\n' + '-'.repeat(60));
          if (failed) {
            console.log('FAILED ' + failed + ' / ' + (passed + failed) + ':\n  - ' + failures.join('\n  - '));
            process.exitCode = 1;
          } else {
            console.log('ALL TESTS PASSED (' + passed + ')');
          }
          resolve();
        }, 300);
      }, 600);
    });
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
