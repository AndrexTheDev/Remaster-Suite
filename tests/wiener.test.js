'use strict';
const assert = require('assert/strict');
const H = require('./harness');
const D = H.loadDsp();
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + e.message); }
}
for (const sr of [32000, 44100, 48000, 96000]) {
  check(`unity-mask WOLA and tail flush preserve every sample at ${sr} Hz`, () => {
    const x = H.noise(sr, .2, .2, 31), y = D.denoiseWiener([x], sr, { floorDb: 0 })[0];
    assert.equal(y.length, x.length);
    for (let i = 0; i < x.length; i++) assert(Math.abs(x[i] - y[i]) < 3e-8);
  });
}
check('one-sample file flushes correctly', () => {
  assert(Math.abs(D.denoiseWiener([new Float32Array([.5])], 48000, { floorDb: 0 })[0][0] - .5) < 1e-7);
});
check('bypass is exact and has zero latency', () => {
  const x = H.noise(48000, .1, .2, 32), f = new D.SpectralWiener(48000);
  for (const v of x) assert.equal(f.tick(v, 0), v);
});
check('engaged delay is exactly 1024 samples, including the first impulse', () => {
  const f = new D.SpectralWiener(48000, { floorDb: 0 });
  for (let i = 0; i < 1024; i++) assert(Math.abs(f.tick(i === 0 ? .5 : 0, 1)) < 1e-12);
  assert(Math.abs(f.tick(0, 1) - .5) < 1e-7);
});
check('reset and disable discard all old overlap tails', () => {
  const f = new D.SpectralWiener(48000);
  for (let i = 0; i < 2000; i++) f.tick(.5, 1);
  f.tick(0, 0);
  for (let i = 0; i < 4000; i++) assert.equal(f.tick(0, 1), 0);
});
check('silence and nonfinite input cannot poison state', () => {
  const f = new D.SpectralWiener(48000);
  f.tick(NaN, 1); f.tick(Infinity, 1);
  for (let i = 0; i < 4000; i++) assert.equal(f.tick(0, 1), 0);
});
check('configuration and unequal channels are rejected', () => {
  for (const opts of [{ floorDb: NaN }, { floorDb: -80 }, { alpha: 1 }])
    assert.throws(() => new D.SpectralWiener(48000, opts), RangeError);
  assert.throws(() => new D.SpectralWiener(0), RangeError);
  assert.throws(() => D.denoiseWiener([new Float32Array(2), new Float32Array(3)], 48000), RangeError);
});
check('stereo channels have independent noise and overlap state', () => {
  const x = H.noise(48000, .1, .2, 33), zero = new Float32Array(x.length);
  const [left, right] = D.denoiseWiener([x, zero], 48000);
  assert(left.some(v => v !== 0)); assert(right.every(v => v === 0));
});
check('streaming and whole-file wrapper are sample-identical', () => {
  const x = H.noise(48000, .2, .2, 34), f = new D.SpectralWiener(48000);
  f.setNoise(.01);
  const y = D.denoiseWiener([x], 48000, { noiseRms: .01 })[0];
  for (let i = 0; i < x.length + 1024; i++) {
    const v = f.tick(i < x.length ? x[i] : 0, 1);
    if (i >= 1024) assert.equal(Math.fround(v), y[i - 1024]);
  }
});
for (const lag of [-8, -2, 0, 2, 8]) {
  check(`bounded correlation reports lag ${lag} without hiding the raw score`, () => {
    const x = H.noise(48000, 1, .2, 35), y = new Float32Array(x.length);
    for (let i = 0; i < y.length; i++) if (i - lag >= 0 && i - lag < x.length) y[i] = x[i - lag];
    const r = D.siSdrAligned(x, y, 8);
    assert.equal(r.lag, lag); assert.equal(r.overlap, x.length - Math.abs(lag));
    assert(r.aligned > 120); if (lag) assert(r.raw < 0);
  });
}
check('correlation handles silence, constants and invalid inputs explicitly', () => {
  for (const x of [new Float32Array(128), new Float32Array(128).fill(.2)]) {
    const r = D.siSdrAligned(x, x);
    assert.equal(r.lag, 0); assert(Number.isNaN(r.correlation)); assert(Number.isNaN(r.aligned));
  }
  const x = new Float32Array(32);
  assert.throws(() => D.alignSignals(x, new Float32Array([NaN])), RangeError);
  assert.throws(() => D.alignSignals(x, x, -1), RangeError);
  assert.throws(() => D.alignSignals(x, x, 2049), RangeError);
});
check('worklet declares spectral delay only on the broadband path', () => {
  const P = H.loadProcessor(48000), x = new Float32Array(4096);
  const run = params => H.renderEx(P, [x], Object.assign({}, H.DEFAULT_PARAMS, { dehiss: 1, autoLevel: 0 }, params));
  assert.equal(run({ hissMax: 0 }).latency, 1024);
  assert.equal(run({ hissMax: 8 }).latency, 0);
  assert.equal(run({ dehiss: 0 }).latency, 0);
});
(async () => {
  const WA = require('./webaudio-stub'); WA.install(globalThis);
  globalThis.requestAnimationFrame = fn => setTimeout(() => fn(performance.now()), 16);
  globalThis.cancelAnimationFrame = clearTimeout;
  const Engine = require('../assets/js/engine');
  const P = H.loadProcessor(48000), engine = new Engine();
  async function checkAsync(name, fn) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + ': ' + e.message); }
  }
  await checkAsync('whole-file export flushes and removes the known STFT delay', async () => {
    const x = H.noise(48000, .1, .2, 36), padded = new Float32Array(x.length + 1024);
    padded.set(x);
    const params = Object.assign({}, H.DEFAULT_PARAMS, { dehiss: 1, autoLevel: 0 });
    const expected = H.renderEx(P, [padded], params).out[0].subarray(1024);
    const out = await engine.render([x], 48000, params);
    assert.equal(out.channels[0].length, x.length); assert.equal(out.buffer.length, x.length);
    for (let i = 0; i < x.length; i++) assert(Math.abs(expected[i] - out.channels[0][i]) < 1e-7);
  });
  await checkAsync('chunked span export flushes the same spectral tail', async () => {
    const x = H.noise(48000, .1, .2, 38);
    const params = Object.assign({}, H.DEFAULT_PARAMS, { dehiss: 1, autoLevel: 0 });
    const full = await engine.render([x], 48000, params);
    const chunked = await engine.renderChunked([x], 48000, params, { chunkSeconds: 1 });
    assert.deepEqual(chunked.channels[0], full.channels[0]);
  });
  await checkAsync('bypassed export does not trim undelayed audio', async () => {
    const x = H.noise(48000, .1, .2, 37);
    const params = Object.assign({}, H.DEFAULT_PARAMS, { dehiss: 1, bypass: 1 });
    const out = await engine.render([x], 48000, params);
    assert.deepEqual(out.channels[0], x);
  });
  await checkAsync('stopped live graph is suspended and init resumes the same context', async () => {
    const ctx = await engine.init(); engine.stop(); await engine._idleSuspension;
    assert.equal(ctx.state, 'suspended'); assert.equal(await engine.init(), ctx); assert.equal(ctx.state, 'running');
  });
  await checkAsync('rapid pause/resume serializes the pending live suspension', async () => {
    engine.setBuffer(engine.ctx.createBuffer(1, 48000, 48000)); await engine.play();
    engine.pause(); await engine.play(); assert(engine.playing); assert.equal(engine.ctx.state, 'running');
    engine.stop(); await engine._idleSuspension;
  });
  await checkAsync('stop resets worklet history before another recording is played', async () => {
    let resets = 0; const send = engine.node.port.postMessage;
    engine.node.port.postMessage = message => { if (message.type === 'reset') resets++; send.call(engine.node.port, message); };
    engine.stop(); await engine._idleSuspension; assert.equal(resets, 1);
  });
  console.log(`Wiener/alignment: ${passed} passed, ${failed} failed`);
  if (!failed) console.log(`ALL TESTS PASSED (${passed})`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
