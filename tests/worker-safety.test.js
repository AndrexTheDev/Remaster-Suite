'use strict';
const assert = require('assert/strict');
const fs = require('fs'), vm = require('vm'), path = require('path');
const code = fs.readFileSync(path.join(__dirname, '../assets/js/codecs.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function setup(WorkerOverride) {
  const workers = [];
  class Worker {
    constructor() { this.dead = false; workers.push(this); }
    postMessage() { queueMicrotask(() => { if (this.onmessage) this.onmessage({ data: { ok: true, data: new ArrayBuffer(0) } }); }); }
    terminate() { this.dead = true; }
  }
  const box = vm.createContext({ Worker: WorkerOverride || Worker, WebAssembly, Uint8Array, Float32Array, ArrayBuffer,
    navigator: { hardwareConcurrency: 3 },
    setTimeout: (fn, ms) => setTimeout(fn, ms === 15000 ? 30 : ms === 30000 ? 80 : ms), clearTimeout });
  vm.runInContext(code, box);
  return { box, workers, lease: signal => box.RSCodecs.createMp3StreamEncoder(48000, 192, 1, { async write() {} }, { signal }) };
}
let passed = 0, failed = 0;
async function check(name, fn) {
  const keepAlive = setInterval(() => {}, 1000);
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + e.message); }
  finally { clearInterval(keepAlive); }
}
(async () => {
  await check('pre-aborted leases allocate no worker', async () => {
    const s = setup(), c = new AbortController(); c.abort();
    await assert.rejects(s.lease(c.signal), { name: 'AbortError' }); assert.equal(s.workers.length, 0);
  });
  await check('queued cancellation rejects promptly and does not steal the next lease', async () => {
    const s = setup(), a = await s.lease(), b = await s.lease(), c = new AbortController();
    const waiting = s.lease(c.signal); c.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    await a.finish(); const next = await s.lease(); assert.equal(s.workers.length, 2);
    next.abort(); b.abort();
  });
  await check('15-second queue deadline is distinct from worker response failure (accelerated clocks)', async () => {
    const s = setup(), a = await s.lease(), b = await s.lease();
    await assert.rejects(s.lease(), { name: 'TimeoutError' }); a.abort(); b.abort();
  });
  await check('30-second idle disposal recycles WASM heaps (accelerated clocks)', async () => {
    const s = setup(), a = await s.lease(); await a.finish();
    await sleep(110); assert(s.workers[0].dead);
    const b = await s.lease(); assert.equal(s.workers.length, 2); b.abort();
  });
  await check('reused workers cannot be terminated by their old idle deadline', async () => {
    const s = setup(), a = await s.lease(); await a.finish();
    const b = await s.lease(); await sleep(110); assert(!s.workers[0].dead); b.abort();
  });
  await check('active AbortSignal terminates its lease exactly once', async () => {
    const s = setup(), c = new AbortController(), a = await s.lease(c.signal);
    s.workers[0].postMessage = () => {}; // an actual outstanding request
    const pending = a.appendChannels([new Float32Array(128)], false);
    await Promise.resolve(); c.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    a.abort(); assert(s.workers[0].dead);
    const b = await s.lease(); b.abort();
  });
  await check('blocked Worker construction is an explicit fallback-eligible failure', async () => {
    const s = setup(class { constructor() { throw new Error('CSP'); } });
    await assert.rejects(s.lease(), { name: 'EncodingUnavailableError' });
  });
  await check('missing WebAssembly is detected before worker allocation', async () => {
    const s = setup(); s.box.WebAssembly = undefined;
    await assert.rejects(s.lease(), { name: 'EncodingUnavailableError' }); assert.equal(s.workers.length, 0);
  });
  await check('cancellation during broken-worker replacement returns the unclaimed lease', async () => {
    const s = setup(), a = await s.lease(), b = await s.lease(), c = new AbortController();
    try {
      const waiting = s.lease(c.signal);
      a.abort(); // replacement is created now, but delivery waits for a microtask
      c.abort();
      await assert.rejects(waiting, { name: 'AbortError' });
      assert.equal(s.workers.length, 3);
      await sleep(110);
      assert(s.workers[2].dead, 'unclaimed replacement must return to idle disposal');
    } finally { b.abort(); }
  });
  const { withDeadline } = require('./beta/cdp.js');
  await check('successful CDP polls cancel their diagnostic deadline', async () => {
    let calls=0;
    assert.equal(await withDeadline(Promise.resolve(42), 5, () => { calls++; }),42);
    await sleep(20); assert.equal(calls,0);
  });
  await check('rejected CDP polls also cancel their diagnostic deadline', async () => {
    let calls=0;
    await assert.rejects(withDeadline(Promise.reject(new Error('request failed')), 5, () => { calls++; }), /request failed/);
    await sleep(20); assert.equal(calls,0);
  });
  await check('a genuinely stalled CDP poll still runs and reports timeout diagnostics', async () => {
    let calls=0;
    await assert.rejects(withDeadline(new Promise(() => {}), 5, () => { calls++; throw new Error('diagnostic timeout'); }), /diagnostic timeout/);
    assert.equal(calls,1);
  });
  console.log(failed ? `FAILED (${failed})` : `ALL TESTS PASSED (${passed})`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
