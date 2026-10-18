/* =============================================================================
 * Remaster Suite — optional neural pipeline test suite
 * -----------------------------------------------------------------------------
 * Exercises three things, without ever needing a real .onnx file or a real
 * GPU (neither exists in this CI environment, and the whole point of the
 * design is that it must not need either):
 *
 *   1. neural-worker.js's own math (T-frame alignment, the ERB filterbank,
 *      the Bluestein-based arbitrary-length STFT/ISTFT DeepFilterNet3's real
 *      960-sample frame needs) — loaded exactly as shipped, via `require()`,
 *      the same "export the shipped internals" convention opfs-manager.js's
 *      worker source already uses.
 *   2. The clean-fallback contract: with no weights installed (the state of
 *      this repository, and of a fresh user profile), probing and every
 *      model call must resolve to `{applied:false, reason:...}` — never
 *      throw, never hang — both from the worker's own functions and from
 *      neural-controller.js's main-thread wrapper (which also has no `Worker`
 *      global to talk to under plain Node, a second, independent reason the
 *      same contract has to hold).
 *   3. The mobile/NPU additions: `isMobileUA()`/`probeWebNN()` capability
 *      detection, `selectVariant()`'s mobile-first quantised-weight
 *      preference, `createSession()`'s WebNN-before-WebGPU execution-
 *      provider order on mobile, and the thermal/memory throttle fallback
 *      (`withTimeout`/`classifyInferenceError`/`resolveInferenceFailure` in
 *      the worker, `onHardwareFallback()` in neural-controller.js) — all
 *      exercised with fake `navigator.ml`/`ort`/`Worker` stand-ins, because
 *      none of the real APIs exist under plain Node either.
 *   4. The worklet's Stage-7 coupling (`NeuralAirCurve` in
 *      remaster-processor.js): default-off, additive-only, and inert on an
 *      all-zero or never-posted curve — run through the real worklet source
 *      with the same harness the DSP suite uses.
 *
 * Run:  node tests/neural.test.js
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

const RSNeuralWorker = require(path.join(ROOT, 'assets', 'js', 'neural-worker.js'));
const RSNeural = require(path.join(ROOT, 'assets', 'js', 'neural-controller.js'));
const DSP = H.loadDsp();

/* ====================================================================== *
 * 1 · worker-internal math
 * ====================================================================== */

function testAlignment() {
  section('neural · T-frame alignment (multiples of 4)');
  const bad = [];
  // n=0 is deliberately floored to 1 frame first (there is no such thing as a
  // zero-frame session.run()), so it aligns to 4, not to 0 — every n from 1 up
  // follows the plain "round up to the next multiple of 4" rule.
  for (let n = 1; n <= 20; n++) {
    const a = RSNeuralWorker.alignT(n);
    if (a % 4 !== 0) bad.push(n + '→' + a);
    if (a < n) bad.push(n + '→' + a + ' (shrank)');
    if (a - n >= 4) bad.push(n + '→' + a + ' (overshot by a whole period)');
  }
  ok(bad.length === 0, 'every T from 1 to 20 rounds up to the nearest multiple of 4', bad.join(', '));
  ok(RSNeuralWorker.alignT(0) === 4, 'T=0 is floored to one frame first, then aligned (never zero frames into a session)');
  ok(RSNeuralWorker.alignT(4) === 4 && RSNeuralWorker.alignT(8) === 8, 'an already-aligned T is left alone');

  section('neural · row-major pad/trim round-trip (what every model wrapper does around session.run)');
  const T = 7, cols = 3, Talign = RSNeuralWorker.alignT(T);
  const flat = new Float32Array(T * cols);
  for (let i = 0; i < flat.length; i++) flat[i] = i + 1;
  const padded = RSNeuralWorker.padRowsTo(flat, T, cols, Talign);
  ok(padded.length === Talign * cols, 'padded buffer has the aligned row count', padded.length + ' vs ' + (Talign * cols));
  ok(padded.subarray(0, T * cols).every((v, i) => v === flat[i]), 'the original rows are untouched');
  ok(padded.subarray(T * cols).every((v) => v === 0), 'the padding rows are zero, not garbage');
  const trimmed = RSNeuralWorker.trimRowsTo(padded, Talign, cols, T);
  ok(trimmed.length === T * cols && Array.from(trimmed).every((v, i) => v === flat[i]),
    'trimming the padded buffer back down recovers exactly the original data');
  const T4 = 8;
  const flat4 = new Float32Array(T4 * cols).fill(5);
  ok(RSNeuralWorker.padRowsTo(flat4, T4, cols, T4) === flat4, 'padRowsTo is a no-op when T is already aligned');
  ok(RSNeuralWorker.trimRowsTo(flat4, T4, cols, T4) === flat4, 'trimRowsTo is a no-op when T is already aligned');
}

function testErbFilterbank() {
  section('neural · ERB filterbank (DeepFilterNet3\'s 32-band grouping, and the mel-ish proxy reuse)');
  const nBins = 481, nBands = 32;
  const fb = RSNeuralWorker.buildErbFilterbank(nBins, nBands, 48000, 960, 1);
  ok(fb.nBands === nBands && fb.nBins === nBins, 'reports the shape it was asked to build');
  ok(fb.edges.length === nBands + 1 && fb.edges[0] === 0 && fb.edges[nBands] === nBins,
    'edges span the whole bin range, start to end', fb.edges.join(','));
  let monotone = true, gaps = 0;
  for (let i = 1; i < fb.edges.length; i++) { if (fb.edges[i] < fb.edges[i - 1]) monotone = false; if (fb.edges[i] === fb.edges[i - 1]) gaps++; }
  ok(monotone, 'band edges never go backwards');
  ok(gaps === 0, 'no band is left empty (every band gets at least its minimum width)');
  const w = (i) => fb.edges[i + 1] - fb.edges[i];
  ok(w(20) >= w(2), 'bands grow with frequency, the way ERB spacing should', w(2) + ' → ' + w(20));
  const flatSpec = new Float32Array(nBins).fill(1);
  const bands = new Float32Array(nBands);
  for (let b = 0; b < nBands; b++) { let s = 0; for (let i = 0; i < nBins; i++) s += fb.fwd[b * nBins + i] * flatSpec[i]; bands[b] = s; }
  ok(bands.every((v) => Math.abs(v - 1) < 1e-5), 'averaging a flat spectrum over any band returns 1, not a partial sum');
}

function testFftAny() {
  section('neural · fftAny (Bluestein reduction) against a direct DFT, power-of-two and not');
  function naiveDft(re, im) {
    const n = re.length, or_ = new Float64Array(n), oi = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let sr = 0, si = 0;
      for (let j = 0; j < n; j++) {
        const ang = -2 * Math.PI * k * j / n, c = Math.cos(ang), s = Math.sin(ang);
        sr += re[j] * c - im[j] * s; si += re[j] * s + im[j] * c;
      }
      or_[k] = sr; oi[k] = si;
    }
    return { re: or_, im: oi };
  }
  const sizes = [5, 7, 13, 64, 960, 2048]; // 64 and 2048 are the power-of-two fast path
  const worst = {};
  for (const n of sizes) {
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.73) + 0.3 * Math.cos(i * 1.31) - 0.1;
    const got = { re: Float32Array.from(re), im: Float32Array.from(im) };
    RSNeuralWorker.fftAny(got.re, got.im, DSP, n);
    const ref = naiveDft(re, im);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(got.re[i] - ref.re[i]), Math.abs(got.im[i] - ref.im[i]));
    worst[n] = maxErr;
  }
  const allSmall = Object.values(worst).every((e) => e < 0.01);
  ok(allSmall, 'fftAny matches a direct O(n²) DFT to float32 precision at every size tried',
    Object.entries(worst).map(([n, e]) => n + ':' + e.toExponential(1)).join(' '));
}

function testStftRoundTrip() {
  section('neural · STFT/ISTFT round-trip at the real model frame sizes');
  const sr = 48000;
  const sig = new Float32Array(sr);
  for (let i = 0; i < sig.length; i++) sig[i] = Math.sin(2 * Math.PI * 440 * i / sr) + 0.2 * Math.sin(2 * Math.PI * 3000 * i / sr);

  // DeepFilterNet3's own frame: 960 samples, 480 hop, Vorbis window, 481 bins —
  // not a power of two, the exact case fftAny's Bluestein path exists for.
  const winV = RSNeuralWorker.vorbisWindow(960);
  const st = RSNeuralWorker.stft(sig, 960, 480, winV);
  ok(st.nBins === 481 && st.frames > 0, 'DFN3 framing: 481 bins, at least one frame', st.nBins + ' bins, ' + st.frames + ' frames');
  const back = RSNeuralWorker.istft(st.re, st.im, st.frames, 960, 480, winV, sig.length);
  let err960 = 0;
  for (let i = 960; i < sig.length - 960; i++) err960 = Math.max(err960, Math.abs(back[i] - sig[i]));
  ok(err960 < 1e-4, 'perfect-reconstruction round trip at the DFN3 frame size (interior samples)', 'max err ' + err960.toExponential(2));

  // BS-RoFormer's own frame: 2048 samples → 1025 bins, a power of two (fast path)
  const winH = RSNeuralWorker.hannWindow(2048);
  const st2 = RSNeuralWorker.stft(sig, 2048, 512, winH);
  ok(st2.nBins === 1025, 'BS-RoFormer framing: 1025 bins', String(st2.nBins));
  const back2 = RSNeuralWorker.istft(st2.re, st2.im, st2.frames, 2048, 512, winH, sig.length);
  let err2048 = 0;
  for (let i = 2048; i < sig.length - 2048; i++) err2048 = Math.max(err2048, Math.abs(back2[i] - sig[i]));
  ok(err2048 < 1e-4, 'perfect-reconstruction round trip at the BS-RoFormer frame size (interior samples)', 'max err ' + err2048.toExponential(2));
}

/* ====================================================================== *
 * 2 · the clean-fallback contract (no weights installed — the state of
 * this repository and of a fresh user profile)
 * ====================================================================== */

async function testProbeAndFallback() {
  section('neural · capability probe never throws and reports the honest state of this environment');
  const p = await RSNeuralWorker.probe();
  ok(p && p.webgpu && typeof p.webgpu.available === 'boolean', 'reports a webgpu capability object');
  ok(p.webgpu.available === false, 'no WebGPU under plain Node — reported as such, not as a crash', JSON.stringify(p.webgpu));
  ok(p.wasmSimd === true, 'WASM-SIMD fallback is reported available (this worker always offers it)');
  ok(p && p.webnn && typeof p.webnn.available === 'boolean', 'reports a webnn capability object');
  ok(p.webnn.available === false, 'no navigator.ml under plain Node — reported as such, not as a crash', JSON.stringify(p.webnn));
  ok(typeof p.mobile === 'boolean', 'reports a mobile flag', String(p.mobile));
  ok(!!(p.models && p.models.deepfilternet3 && p.models.bsroformer && p.models.audiosr),
    'reports all three model slots', Object.keys(p.models || {}).join(', '));
  for (const key of ['deepfilternet3', 'bsroformer', 'audiosr']) {
    ok(p.models[key].available === false && typeof p.models[key].reason === 'string',
      key + ' honestly reports unavailable with a reason, no weights are shipped in this repo',
      JSON.stringify(p.models[key]));
  }

  section('neural · every model call falls back cleanly with no weights installed (requirement: no errors)');
  const sr = 48000;
  const sig = new Float32Array(sr);
  for (let i = 0; i < sig.length; i++) sig[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.3;
  const calls = [
    ['denoiseDFN3', () => RSNeuralWorker.denoiseDFN3(sig)],
    ['separateBSR', () => RSNeuralWorker.separateBSR(sig)],
    ['superresCurve', () => RSNeuralWorker.superresCurve(sig, [8000, 10000, 12500, 16000, 19000, 22000])],
  ];
  for (const [name, fn] of calls) {
    try {
      const r = await fn();
      ok(r && r.applied === false && typeof r.reason === 'string',
        name + '() resolves {applied:false, reason} instead of throwing', JSON.stringify(r));
    } catch (err) {
      ok(false, name + '() must never reject', String((err && err.message) || err));
    }
  }
  const oversized = await RSNeuralWorker.denoiseDFN3(new Float32Array(480001));
  ok(oversized.applied === false && oversized.reason === 'input-too-large',
    'direct denoiser calls are bounded before STFT tensors are allocated');

  section('neural · neural-controller.js (main-thread wrapper) — no Worker global under Node, same clean contract');
  const ctrlCalls = [
    ['probe', () => RSNeural.probe()],
    ['denoise', () => RSNeural.denoise(new Float32Array(100))],
    ['separate', () => RSNeural.separate(new Float32Array(100))],
    ['superres', () => RSNeural.superres(new Float32Array(100), [8000, 16000])],
  ];
  for (const [name, fn] of ctrlCalls) {
    try {
      const r = await fn();
      ok(r && typeof r === 'object', 'RSNeural.' + name + '() resolves to an object, never throws, never hangs', JSON.stringify(r).slice(0, 120));
      if (name !== 'probe') ok(r.applied === false, 'RSNeural.' + name + '() reports applied:false with no Worker to talk to');
    } catch (err) {
      ok(false, 'RSNeural.' + name + '() must never reject', String((err && err.message) || err));
    }
  }
  let threw = null;
  try { RSNeural.dispose(); } catch (e) { threw = e; }
  ok(threw === null, 'dispose() is safe to call even when no worker was ever created');
}

/* ====================================================================== *
 * 3 · mobile/WebNN capability detection, mobile-optimised weight
 * selection, and the thermal/memory throttle fallback (the three pieces
 * the mobile/NPU brief adds on top of the WebGPU/WASM baseline above)
 * ====================================================================== */

async function testMobileAndWebNN() {
  section('neural · isMobileUA() matches the brief\'s own detection regex');
  const realNavigator = global.navigator;
  function withUA(ua, fn) {
    Object.defineProperty(global, 'navigator', { value: Object.assign({}, realNavigator, { userAgent: ua }), configurable: true });
    try { return fn(); } finally { Object.defineProperty(global, 'navigator', { value: realNavigator, configurable: true }); }
  }
  ok(withUA('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', () => RSNeuralWorker.isMobileUA()) === true,
    'an Android UA is detected as mobile');
  ok(withUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', () => RSNeuralWorker.isMobileUA()) === true,
    'an iPhone UA is detected as mobile');
  ok(withUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120', () => RSNeuralWorker.isMobileUA()) === false,
    'a desktop Windows/Chrome UA is not detected as mobile');

  section('neural · probeWebNN() never throws and reports the honest state of this environment');
  const webnnOff = await RSNeuralWorker.probeWebNN();
  ok(webnnOff && webnnOff.available === false && webnnOff.deviceType === null,
    'no navigator.ml under plain Node — reported as unavailable, not a crash', JSON.stringify(webnnOff));
  {
    // simulate a browser that only accelerates on the NPU for 'npu' and
    // 'gpu' but not 'cpu' — confirms the NPU-first, then-GPU, then-CPU probe
    // order actually stops at the first device type that succeeds.
    const tried = [];
    Object.defineProperty(global, 'navigator', {
      value: Object.assign({}, realNavigator, {
        ml: { createContext: async ({ deviceType }) => { tried.push(deviceType); if (deviceType === 'cpu') throw new Error('no cpu backend'); return {}; } },
      }),
      configurable: true,
    });
    try {
      const r = await RSNeuralWorker.probeWebNN();
      ok(r.available === true && r.deviceType === 'npu', 'reports npu as soon as it succeeds, tries nothing further', JSON.stringify(r));
      ok(tried.join(',') === 'npu', 'never even attempted gpu/cpu once npu worked', tried.join(','));
    } finally { Object.defineProperty(global, 'navigator', { value: realNavigator, configurable: true }); }
  }
  {
    // npu and gpu both fail (e.g. a WebNN implementation that only backs
    // CPU) — probe falls through to cpu rather than reporting unavailable.
    Object.defineProperty(global, 'navigator', {
      value: Object.assign({}, realNavigator, {
        ml: { createContext: async ({ deviceType }) => { if (deviceType !== 'cpu') throw new Error('unsupported device type'); return {}; } },
      }),
      configurable: true,
    });
    try {
      const r = await RSNeuralWorker.probeWebNN();
      ok(r.available === true && r.deviceType === 'cpu', 'falls through npu/gpu failures down to a working cpu context', JSON.stringify(r));
    } finally { Object.defineProperty(global, 'navigator', { value: realNavigator, configurable: true }); }
  }

  section('neural · variantOrder() — INT4 on a phone, INT8 as the standard use, fp16/fp32 as the last resorts');
  const defAll = { files: { fp32: 'm.fp32.onnx', fp16: 'm.fp16.onnx', int8: 'm.int8.onnx', int4: 'm.int4.onnx' } };
  const defNoQuant = { files: { fp32: 'm.fp32.onnx', fp16: 'm.fp16.onnx' } };
  ok(RSNeuralWorker.selectVariant(defAll, { mobile: true, webgpu: { available: false, fp16: false } }) === 'int4',
    'mobile with every variant published picks int4, the smallest');
  ok(RSNeuralWorker.selectVariant({ files: { fp32: 'm.fp32.onnx', fp16: 'm.fp16.onnx', int8: 'm.int8.onnx' } },
    { mobile: true, webgpu: { available: false, fp16: false } }) === 'int8',
    'mobile without an int4 file falls back to int8, not straight to fp16/fp32');
  ok(RSNeuralWorker.selectVariant(defNoQuant, { mobile: true, webgpu: { available: true, fp16: true } }) === 'fp16',
    'mobile with no quantised files at all still gets fp16 when the adapter supports it, never straight to fp32');
  ok(RSNeuralWorker.selectVariant(defNoQuant, { mobile: true, webgpu: { available: false, fp16: false } }) === 'fp32',
    'mobile with neither quantised files nor fp16 support lands on fp32, same as desktop would');
  ok(RSNeuralWorker.selectVariant(defAll, { mobile: false, webgpu: { available: true, fp16: true } }) === 'int8',
    'desktop takes INT8 as the standard-use default, ahead of fp16 even on an fp16-capable adapter');
  ok(RSNeuralWorker.selectVariant(defAll, { mobile: false, webgpu: { available: false, fp16: false } }) === 'int8',
    'desktop without WebGPU still takes INT8 — quantisation is not a mobile-only path');
  ok(RSNeuralWorker.variantOrder(defAll, { mobile: false, webgpu: { available: true, fp16: true } }).join(',') === 'int8,fp16,fp32',
    'and the full desktop order is int8 → fp16 → fp32, so a channel with only the fp32 file still works',
    RSNeuralWorker.variantOrder(defAll, { mobile: false, webgpu: { available: true, fp16: true } }).join(','));
  ok(RSNeuralWorker.variantOrder(defAll, { mobile: true, webgpu: { available: false, fp16: false } }).join(',') === 'int4,int8,fp32',
    'the phone order is int4 → int8 → fp32 (fp16 only when the adapter advertises shader-f16)',
    RSNeuralWorker.variantOrder(defAll, { mobile: true, webgpu: { available: false, fp16: false } }).join(','));

  section('neural · createSession() execution-provider ordering — WebGPU first, WASM/SIMD last, everywhere');
  function fakeOrt(behaviour) {
    const attempts = [];
    return {
      attempts,
      InferenceSession: {
        create: async (bytes, opts) => {
          const ep = opts.executionProviders[0];
          const name = typeof ep === 'string' ? ep : ep.name;
          attempts.push(name);
          const outcome = behaviour[name];
          if (outcome === 'fail') throw new Error(name + ' unavailable');
          return { __provider: name };
        },
      },
    };
  }
  {
    const ort = fakeOrt({ webnn: 'ok', webgpu: 'ok', wasm: 'ok' });
    const r = await RSNeuralWorker.createSession(ort, new Uint8Array([1]),
      { mobile: true, webnn: { available: true, deviceType: 'npu' }, webgpu: { available: true, fp16: false } });
    ok(r.provider === 'webgpu' && ort.attempts.join(',') === 'webgpu',
      'a phone with both accelerators gets WebGPU first and stops there — the prompt\'s explicit preference', ort.attempts.join(','));
  }
  {
    const ort = fakeOrt({ webnn: 'ok', webgpu: 'fail', wasm: 'ok' });
    const r = await RSNeuralWorker.createSession(ort, new Uint8Array([1]),
      { mobile: true, webnn: { available: true, deviceType: 'npu' }, webgpu: { available: true, fp16: false } });
    ok(r.provider === 'webnn' && ort.attempts.join(',') === 'webgpu,webnn',
      'and a failed WebGPU attempt falls through to the NPU before it gives up on hardware', ort.attempts.join(','));
  }
  {
    const order = RSNeuralWorker.providerOrder({ webgpu: { available: true }, webnn: { available: false } });
    ok(order.join(',') === 'webgpu,wasm', 'with no NPU the chain is exactly WebGPU → WASM', order.join(','));
    const none = RSNeuralWorker.providerOrder({ webgpu: { available: false }, webnn: { available: false } });
    ok(none.join(',') === 'wasm', 'with no accelerator at all it is exactly WASM — no failed attempt is made first', none.join(','));
  }
  {
    const ort = fakeOrt({ webnn: 'ok', webgpu: 'ok', wasm: 'ok' });
    const r = await RSNeuralWorker.createSession(ort, new Uint8Array([1]),
      { mobile: false, webnn: { available: true, deviceType: 'gpu' }, webgpu: { available: true, fp16: true } });
    ok(r.provider === 'webgpu' && ort.attempts.join(',') === 'webgpu', 'desktop with both available still tries WebGPU first and stops there', ort.attempts.join(','));
  }
  {
    const ort = fakeOrt({ webnn: 'fail', webgpu: 'fail', wasm: 'ok' });
    const r = await RSNeuralWorker.createSession(ort, new Uint8Array([1]),
      { mobile: true, webnn: { available: true, deviceType: 'npu' }, webgpu: { available: true, fp16: false } });
    ok(r.provider === 'wasm' && ort.attempts.join(',') === 'webgpu,webnn,wasm', 'WASM is still the last-resort fallback when every accelerator fails — and it is tried last', ort.attempts.join(','));
  }
  {
    const ort = fakeOrt({ wasm: 'ok' });
    const r = await RSNeuralWorker.createSession(ort, new Uint8Array([1]), { mobile: false, webnn: { available: false }, webgpu: { available: false } });
    ok(r.provider === 'wasm' && ort.attempts.join(',') === 'wasm', 'neither accelerator available: goes straight to WASM with no failed attempts logged first', ort.attempts.join(','));
  }

  section('neural · inference watchdog timeout and OOM/device-lost classification (the thermal/memory throttle fallback)');
  {
    const fast = await RSNeuralWorker.withTimeout(Promise.resolve('done'), 50, 'x');
    ok(fast === 'done', 'withTimeout resolves normally when the wrapped promise beats the clock');
  }
  {
    let threwTimeout = null;
    try { await RSNeuralWorker.withTimeout(new Promise((resolve) => setTimeout(() => resolve('late'), 500)), 20, 'slow-op'); }
    catch (e) { threwTimeout = e; }
    ok(threwTimeout && threwTimeout.name === 'InferenceTimeoutError', 'withTimeout rejects before a slow promise ever settles', String(threwTimeout && threwTimeout.message));
    ok(RSNeuralWorker.classifyInferenceError(threwTimeout) === 'timeout', 'a timeout error classifies as the "timeout" hardware-limit reason');
  }
  const oomMessages = ['Out of memory', 'RESOURCE_EXHAUSTED: alloc failed', 'allocation failed for tensor', 'memory access out of bounds'];
  for (const msg of oomMessages) {
    ok(RSNeuralWorker.classifyInferenceError(new Error(msg)) === 'oom', 'classifies "' + msg + '" as oom');
  }
  ok(RSNeuralWorker.classifyInferenceError(Object.assign(new Error('array too large'), { name: 'RangeError' })) === 'oom',
    'a RangeError (typed-array allocation failure) also classifies as oom');
  ok(RSNeuralWorker.classifyInferenceError(new Error('WebGPU device was lost')) === 'device-lost', 'classifies a lost GPU device as device-lost');
  ok(RSNeuralWorker.classifyInferenceError(new Error('WebGL context lost')) === 'device-lost', 'classifies a lost context as device-lost');
  ok(RSNeuralWorker.classifyInferenceError(new Error('unexpected-output-shape')) === null,
    'an unrelated error (e.g. a real shape bug) is not misclassified as a hardware limit');

  section('neural · resolveInferenceFailure() evicts the cached session only for real hardware-limit reasons');
  RSNeuralWorker.sessionCache.set('fake-model-oom', { unavailable: false, session: {} });
  const reasonOom = RSNeuralWorker.resolveInferenceFailure('fake-model-oom', new Error('out of memory'));
  ok(reasonOom === 'oom', 'reports the oom reason');
  ok(RSNeuralWorker.sessionCache.has('fake-model-oom') === false, 'evicts the cached session after an oom failure — a retry re-probes instead of reusing a dead context');

  RSNeuralWorker.sessionCache.set('fake-model-generic', { unavailable: false, session: {} });
  const reasonGeneric = RSNeuralWorker.resolveInferenceFailure('fake-model-generic', new Error('unexpected-output-shape'));
  ok(reasonGeneric === 'inference-error: unexpected-output-shape', 'a non-hardware error keeps the existing descriptive reason text', reasonGeneric);
  ok(RSNeuralWorker.sessionCache.has('fake-model-generic') === true, 'a non-hardware error leaves the cached session in place — nothing wrong with the device itself');

  section('neural · in-job accelerator failure retries exactly where WASM can help');
  for (const reason of ['oom', 'device-lost', 'timeout']) {
    ok(RSNeuralWorker.shouldRetryOfficialOnWasm({ provider: 'webgpu' }, reason),
      reason + ' on WebGPU is eligible for one WASM retry');
  }
  ok(!RSNeuralWorker.shouldRetryOfficialOnWasm({ provider: 'wasm' }, 'oom'),
    'a WASM failure is never recursively retried');
  ok(!RSNeuralWorker.shouldRetryOfficialOnWasm({ provider: 'webgpu' }, 'inference-error: unexpected-output-shape'),
    'a graph or shape defect is not hidden by provider fallback');
  let releases = 0;
  await RSNeuralWorker.releaseOfficialDfn3Group({ sessions: {
    encoder: { release: async () => { releases++; } },
    erbDecoder: { release: async () => { releases++; } },
    dfDecoder: { release: async () => { releases++; } },
  } });
  ok(releases === 3, 'provider fallback releases every accelerator-owned graph session before WASM recreation', releases);
}

/* ====================================================================== *
 * 3b · neural-controller.js surfaces hardware-limit fallbacks through a
 * dedicated pub/sub channel app.js uses for its one quiet UI toast, kept
 * separate from the per-call {applied:false} result the render path itself
 * already handles with no new code
 * ====================================================================== */

async function testHardwareFallbackNotification() {
  section('neural · neural-controller.js onHardwareFallback() fires only for real hardware-limit reasons');

  class FakeWorker {
    constructor() { this.listeners = {}; }
    addEventListener(type, cb) { (this.listeners[type] = this.listeners[type] || []).push(cb); }
    postMessage(msg) {
      const result = FakeWorker.nextResult(msg);
      setTimeout(() => { for (const cb of (this.listeners.message || [])) cb({ data: { reqId: msg.reqId, result } }); }, 0);
    }
    terminate() { FakeWorker.terminated++; }
  }
  FakeWorker.terminated = 0;
  FakeWorker.nextResult = () => ({ applied: false, reason: 'weights-not-found' });

  const realWorker = global.Worker;
  global.Worker = FakeWorker;
  try {
    RSNeural.dispose(); // drop any cached worker reference from earlier tests so a fresh FakeWorker is constructed

    const seen = [];
    const unsubscribe = RSNeural.onHardwareFallback((reason) => seen.push(reason));

    FakeWorker.nextResult = () => ({ applied: false, reason: 'weights-not-found' });
    await RSNeural.denoise(new Float32Array(10));
    ok(seen.length === 0, 'a benign "nothing installed" reason does not fire the hardware-fallback notification');

    FakeWorker.nextResult = () => ({ applied: false, reason: 'oom' });
    const oomResult = await RSNeural.separate(new Float32Array(10));
    ok(oomResult.applied === false && oomResult.reason === 'oom', 'the call itself still resolves the normal {applied:false, reason} shape');
    ok(seen.join(',') === 'oom', 'an oom reason fires exactly one notification', seen.join(','));

    FakeWorker.nextResult = () => ({ applied: false, reason: 'device-lost' });
    await RSNeural.superres(new Float32Array(10), [8000]);
    FakeWorker.nextResult = () => ({ applied: false, reason: 'timeout' });
    await RSNeural.denoise(new Float32Array(10));
    ok(seen.join(',') === 'oom,device-lost,timeout', 'device-lost and timeout also fire the notification, in call order', seen.join(','));

    const ac = new AbortController();
    FakeWorker.nextResult = () => ({ applied: true, output: new Float32Array(10) });
    const cancelled = RSNeural.denoise(new Float32Array(10), { signal: ac.signal });
    const collateral = RSNeural.denoise(new Float32Array(10));
    ac.abort();
    const [cancelledResult, collateralResult] = await Promise.all([cancelled, collateral]);
    ok(cancelledResult.reason === 'aborted' && collateralResult.reason === 'worker-restarted',
      'aborting active ORT terminates its worker and settles every affected caller explicitly');
    ok(FakeWorker.terminated >= 1, 'active inference cancellation actually terminates the ORT worker', FakeWorker.terminated);
    const fresh = await RSNeural.denoise(new Float32Array(10));
    ok(fresh.applied === true, 'the next neural request starts a fresh worker after cancellation');

    unsubscribe();
    FakeWorker.nextResult = () => ({ applied: false, reason: 'oom' });
    await RSNeural.denoise(new Float32Array(10));
    ok(seen.join(',') === 'oom,device-lost,timeout', 'unsubscribing stops further notifications', seen.join(','));
  } finally {
    RSNeural.dispose();
    global.Worker = realWorker;
  }
}

/* ====================================================================== *
 * 4 · the worklet's Stage-7 coupling (NeuralAirCurve)
 * ====================================================================== */

function runNeuralProcessor(sr, signal, airNeuralAmount, curve) {
  const Processor = H.loadProcessor(sr);
  const proc = new Processor({ processorOptions: { channels: 1 } });
  if (curve) proc.port.onmessage({ data: { type: 'neuralAirCurve', bandsHz: curve.bandsHz, gainsDb: curve.gainsDb } });
  const bs = 128;
  const out = new Float32Array(signal.length);
  const names = ['power', 'bypass', 'air', 'airNeural', 'exciter', 'sub', 'dehiss', 'declip', 'declick',
    'reso', 'glue', 'warmth', 'tilt', 'width', 'azimuth'];
  const arrays = {};
  for (const n of names) arrays[n] = Float32Array.from([0]);
  arrays.power = Float32Array.from([1]);
  arrays.bypass = Float32Array.from([0]);
  arrays.airNeural = Float32Array.from([airNeuralAmount]);
  // `autoLevel` (see remaster-processor.js) is a separate, global RMS
  // loudness-matcher that is not part of what is under test here — left on,
  // it would partly undo any single stage's isolated gain change, which is
  // real, correct chain behaviour but the wrong thing to measure through
  // when the question is "does this one stage's own math do what it should".
  arrays.autoLevel = Float32Array.from([0]);
  for (let pos = 0; pos < signal.length; pos += bs) {
    const n = Math.min(bs, signal.length - pos);
    const inBlock = signal.subarray(pos, pos + n);
    const outBlock = out.subarray(pos, pos + n);
    proc.process([[inBlock]], [[outBlock]], arrays);
  }
  return out;
}

function bandRms(DSPmod, sig, sr, loHz, hiHz) {
  // crude band energy via the shared FFT, good enough to detect "more energy
  // showed up in this band", which is all these checks need
  const n = 4096;
  let sum = 0, frames = 0;
  for (let off = 0; off + n <= sig.length; off += n) {
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = sig[off + i];
    DSPmod.fft(re, im);
    const loBin = Math.round(loHz * n / sr), hiBin = Math.round(hiHz * n / sr);
    let e = 0;
    for (let b = loBin; b <= hiBin && b < n / 2; b++) e += re[b] * re[b] + im[b] * im[b];
    sum += e; frames++;
  }
  return frames ? Math.sqrt(sum / frames) : 0;
}

function testWorklet() {
  section('neural · Stage-7 coupling (NeuralAirCurve) in the real worklet');
  const sr = 48000;
  const noise = H.noise(sr, 2, 0.4, 101); // broadband so every neural band has something to re-shape
  const curve = { bandsHz: [8000, 10000, 12500, 16000, 19000, 22000], gainsDb: [6, 6, 6, 6, 6, 6] };

  const baseline = runNeuralProcessor(sr, noise, 0, null);
  const gatedOff = runNeuralProcessor(sr, noise, 0, curve); // curve posted but amount=0

  let maxDiffGated = 0;
  for (let i = 0; i < baseline.length; i++) maxDiffGated = Math.max(maxDiffGated, Math.abs(baseline[i] - gatedOff[i]));
  ok(maxDiffGated === 0, 'airNeural=0 is bit-identical whether or not a curve was posted (the default-off gate)',
    'max diff ' + maxDiffGated);

  const zeroCurve = { bandsHz: curve.bandsHz, gainsDb: [0, 0, 0, 0, 0, 0] };
  const zeroActive = runNeuralProcessor(sr, noise, 1, zeroCurve); // amount=1 but an all-zero curve
  let maxDiffZero = 0;
  for (let i = 0; i < baseline.length; i++) maxDiffZero = Math.max(maxDiffZero, Math.abs(baseline[i] - zeroActive[i]));
  ok(maxDiffZero === 0, 'an all-zero curve is a true identity, even with the trust dial fully up',
    'max diff ' + maxDiffZero);

  const boosted = runNeuralProcessor(sr, noise, 1, curve);
  const before = bandRms(DSP, baseline, sr, 8000, 20000);
  const after = bandRms(DSP, boosted, sr, 8000, 20000);
  ok(after > before * 1.3, 'a +6 dB curve measurably raises energy in the 8-20 kHz band it targets',
    (20 * Math.log10(before > 0 ? before : 1e-9)).toFixed(1) + ' → ' + (20 * Math.log10(after > 0 ? after : 1e-9)).toFixed(1) + ' dBFS-ish');

  // the trust dial is a genuine blend, not a switch. Measured on a wideband
  // noise bed through six overlapping peaking filters the relationship is not
  // a clean fraction of the dB gain (several filters already pile most of
  // their response up by amount=0.5), so this is isolated to one tone sitting
  // exactly on one filter's centre frequency instead, where the per-filter
  // blend math (`x + (y - x) * amount`) has an exact, checkable answer:
  // amount=0.5 must land at roughly `1 + (G-1)*0.5` of the full linear gain
  // `G`, clearly short of amount=1's full `G`.
  const toneHz = 10000; // one of NeuralAirCurve's own fixed application points
  const tone = H.tone(toneHz, sr, 1, 0.2);
  // curve points given at exactly NeuralAirCurve's own six fixed bands, so
  // `setCurve`'s interpolation is an exact pass-through with no bleed from
  // neighbouring bands onto this one — only the 10 kHz filter has any gain
  const toneCurve = { bandsHz: [8000, 10000, 12500, 16000, 19000, 22000], gainsDb: [0, 6, 0, 0, 0, 0] };
  const toneBase = runNeuralProcessor(sr, tone, 0, toneCurve);
  const toneFull = runNeuralProcessor(sr, tone, 1, toneCurve);
  const toneHalf = runNeuralProcessor(sr, tone, 0.5, toneCurve);
  const settleRms = (sig) => {
    const skip = Math.round(sr * 0.1); // let the filter settle first
    let s = 0, n = 0;
    for (let i = skip; i < sig.length; i++) { s += sig[i] * sig[i]; n++; }
    return Math.sqrt(s / n);
  };
  const rBase = settleRms(toneBase), rFull = settleRms(toneFull), rHalf = settleRms(toneHalf);
  const dbFull = 20 * Math.log10(rFull / rBase);
  const dbHalf = 20 * Math.log10(rHalf / rBase);
  ok(dbFull > 4.5 && dbFull < 6.5, 'amount=1 reproduces the full +6 dB design gain at the filter\'s own centre',
    dbFull.toFixed(2) + ' dB');
  ok(dbHalf > dbFull * 0.25 && dbHalf < dbFull * 0.85,
    'airNeural is a continuous blend, not an on/off switch — amount=0.5 lands strictly between off and full',
    '0 | half ' + dbHalf.toFixed(2) + ' | full ' + dbFull.toFixed(2) + ' dB');

  // an absurd model prediction must not be able to do more damage than a
  // gentle shelf could (see NEURAL_AIR_MAX_DB)
  const wildCurve = { bandsHz: curve.bandsHz, gainsDb: [80, 80, 80, 80, 80, 80] };
  const wild = runNeuralProcessor(sr, noise, 1, wildCurve);
  let peak = 0;
  for (let i = 0; i < wild.length; i++) peak = Math.max(peak, Math.abs(wild[i]));
  ok(isFinite(peak) && peak < 50, 'a wildly out-of-range curve is clamped, not left to blow up the output', 'peak ' + peak.toFixed(2));

  // low sample rates: the fixed band list must not crash a processor whose
  // Nyquist sits below some of them
  let threw = null;
  try { runNeuralProcessor(8000, H.noise(8000, 0.5, 0.3, 102), 1, curve); } catch (e) { threw = e; }
  ok(threw === null, 'a low sample rate (8 kHz) drops out-of-range bands instead of crashing',
    threw ? String(threw.message) : 'ok');

  // reset() clears the filter state but the curve itself must stay active —
  // a reset is a transport reset (e.g. the A/B switch), not "forget the model"
  {
    const Processor = H.loadProcessor(sr);
    const proc = new Processor({ processorOptions: { channels: 1 } });
    proc.port.onmessage({ data: { type: 'neuralAirCurve', bandsHz: curve.bandsHz, gainsDb: curve.gainsDb } });
    proc.port.onmessage({ data: { type: 'reset' } });
    ok(proc.chains[0].neuralAir.active === true, 'a transport reset does not discard an already-posted curve');
  }
}

/* ====================================================================== *
 * The model manager: first start, the CDN, the OPFS cache
 * ====================================================================== */

/** A model store with the same surface as `RSOPFS.models`, in memory. */
function fakeModelStore() {
  const files = new Map();          // 'model/file' -> Uint8Array
  const writes = [];
  return {
    files,
    writes,
    dir: 'models',
    path: (m, f) => 'models/' + m + '/' + f,
    async stat(m, f) {
      const b = files.get(m + '/' + f);
      return { exists: !!b, size: b ? b.length : 0, path: 'models/' + m + '/' + f };
    },
    async read(m, f) { const b = files.get(m + '/' + f); return b ? b.slice() : null; },
    async list(m) {
      const out = [];
      for (const [k, v] of files) {
        if (k.indexOf(m + '/') === 0) out.push({ name: k.slice(m.length + 1), size: v.length, path: 'models/' + k });
      }
      return out;
    },
    async remove(m, f) { files.delete(m + '/' + f); },
    async clear() { files.clear(); },
    async createWriter(m, f) {
      const parts = [];
      let size = 0;
      let closed = false;
      const rec = { key: 'models/' + m + '/' + f, chunks: 0 };
      writes.push(rec);
      return {
        key: rec.key,
        async write(chunk) {
          if (closed) throw new Error('writer already closed');
          const u8 = chunk instanceof Uint8Array ? chunk.slice() : new Uint8Array(chunk.slice(0));
          // the real store posts the buffer to its worker with `transfer`,
          // which detaches the caller's view — the loader has to have counted
          // its bytes before that happens, so the fake store detaches too
          try { structuredClone(chunk, { transfer: [chunk.buffer] }); } catch (e) { /* not transferable */ }
          parts.push(u8); size += u8.length; rec.chunks++;
        },
        async close() {
          closed = true;
          const all = new Uint8Array(size);
          let off = 0;
          for (const part of parts) { all.set(part, off); off += part.length; }
          files.set(m + '/' + f, all);
          return { size, key: rec.key };
        },
        async abort() { closed = true; parts.length = 0; size = 0; rec.aborted = true; },
      };
    },
  };
}

/**
 * A `fetch` that answers from a route table and streams the body in chunks, the
 * way a CDN does. Every requested URL is recorded.
 */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) {
      return { ok: false, status: 404, headers: { get: () => null } };
    }
    const bytes = r.bytes || new Uint8Array(Buffer.from(JSON.stringify(r.json || {})));
    let off = 0;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => {
          const n = String(name).toLowerCase();
          if (n === 'content-length') return r.length === null ? null : String(r.length === undefined ? bytes.length : r.length);
          if (n === 'content-type') return r.type || 'application/octet-stream';
          return null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              if (off >= bytes.length) return { done: true };
              const chunk = bytes.slice(off, Math.min(bytes.length, off + (r.chunk || 65536)));
              off += chunk.length;
              return { done: false, value: chunk };
            },
          };
        },
      },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      async json() { return r.json !== undefined ? r.json : JSON.parse(Buffer.from(bytes).toString('utf8')); },
    };
  };
  fn.calls = calls;
  return fn;
}

/** Run `fn` with `globalThis.RSOPFS` / `globalThis.fetch` replaced, then put
 *  the originals back whatever happens. */
async function withGlobals(replacement, fn) {
  const hadRSOPFS = Object.prototype.hasOwnProperty.call(global, 'RSOPFS');
  const prevRSOPFS = global.RSOPFS;
  const prevFetch = global.fetch;
  const prevNav = global.navigator;
  try {
    if ('RSOPFS' in replacement) global.RSOPFS = replacement.RSOPFS;
    if ('fetch' in replacement) global.fetch = replacement.fetch;
    if ('navigator' in replacement) Object.defineProperty(global, 'navigator', { value: replacement.navigator, configurable: true });
    return await fn();
  } finally {
    if (hadRSOPFS) global.RSOPFS = prevRSOPFS; else delete global.RSOPFS;
    global.fetch = prevFetch;
    if ('navigator' in replacement) Object.defineProperty(global, 'navigator', { value: prevNav, configurable: true });
  }
}

async function testModelContracts() {
  section('neural · real-session model contracts are validated before inference');
  const dfn = RSNeuralWorker.MODELS.deepfilternet3;
  const valid = RSNeuralWorker.validateSessionContract({
    inputNames: ['feat_erb', 'feat_spec'],
    outputNames: ['erb_mask', 'df_coefs'],
  }, dfn);
  ok(valid.ok === true, 'the frozen DeepFilterNet graph contract is accepted');

  const stateful = RSNeuralWorker.validateSessionContract({
    inputNames: ['feat_erb', 'feat_spec', 'hidden_state'],
    outputNames: ['erb_mask', 'df_coefs'],
  }, dfn);
  ok(stateful.ok === false && stateful.extraInputs.includes('hidden_state'),
    'an export with an unsupported recurrent-state input is rejected before session.run', stateful.reason);

  const renamed = RSNeuralWorker.validateSessionContract({
    inputNames: ['features_erb', 'feat_spec'],
    outputNames: ['mask', 'df_coefs'],
  }, dfn);
  ok(renamed.ok === false && renamed.missingInputs.includes('feat_erb') && renamed.missingOutputs.includes('erb_mask'),
    'renamed inputs and outputs produce a precise model-contract-mismatch', renamed.reason);

  const noMetadata = RSNeuralWorker.validateSessionContract({}, dfn);
  ok(noMetadata.ok === false && /no input metadata/.test(noMetadata.reason) && /no output metadata/.test(noMetadata.reason),
    'a runtime session without metadata is not guessed compatible', noMetadata.reason);

  for (const key of ['deepfilternet3', 'bsroformer', 'audiosr']) {
    const io = RSNeuralWorker.MODELS[key].io;
    ok(io && io.inputs.length > 0 && io.outputs.length > 0,
      key + ' publishes an explicit input/output contract');
  }

  const fs = require('fs');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'models', 'sources', 'deepfilternet3.json'), 'utf8'));
  const shippedManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'models', 'manifest.json'), 'utf8'));
  const musicFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'wailing-wailers.json'), 'utf8'));
  const musicBytes = fs.readFileSync(path.join(ROOT, musicFixture.file));
  const pipeline = dfn.officialPipeline;
  ok(lock.upstreamCommit === 'd375b2d8309e0935d165700c91da9de862a99c31' && /MIT/.test(lock.license),
    'the official upstream commit and redistributable license are frozen');
  const musicHash = require('crypto').createHash('sha256').update(musicBytes).digest('hex');
  ok(musicBytes.length === musicFixture.bytes && musicHash === musicFixture.sha256,
    'the uploaded Wailing Wailers real-music fixture is byte-for-byte locked', musicHash);
  ok(musicBytes.subarray(0, 3).toString('ascii') === 'ID3',
    'the real-music fixture has an MP3/ID3 container rather than a renamed test payload');
  ok(musicFixture.decoded.sampleRate === 48000 && musicFixture.decoded.channels === 2
    && musicFixture.decoded.durationSeconds > 180,
    'the real-music fixture contract records a full stereo song at the model rate');
  ok(musicFixture.baseline.hissTiltStepDb > 5 && musicFixture.baseline.crackleIndex > 0.2
    && musicFixture.baseline.clipEvidence < 0.001,
    'the song baseline captures multiple restoration problems without inventing clipping evidence');
  ok(shippedManifest.schema === 1 && shippedManifest.models.deepfilternet3.variants.official.artifacts.length === 3,
    'the same-origin production manifest publishes the official three-graph variant');
  const runtimeDir = path.join(ROOT, 'assets', 'vendor', 'onnxruntime-web');
  const runtimePins = {
    'ort.webgpu.min.js': '8443389bf14b34582ea40c590b5007bb652d6ac07dd76829a5bd82d2372e6895',
    'ort-wasm-simd-threaded.jsep.mjs': '2fb14505d39926e4c544de8c57fe59a2f2bc74caba6f71890be9afecc5046758',
    'ort-wasm-simd-threaded.jsep.wasm': '185b0861a6cd6cbdfb057289338090436483cc59e10a7bc83bd167b15531a51b',
  };
  for (const [file, hash] of Object.entries(runtimePins)) {
    const actual = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(runtimeDir, file))).digest('hex');
    ok(actual === hash, 'bundled ONNX Runtime 1.20.1 artifact is pinned: ' + file);
  }
  ok(RSNeuralWorker.ortCandidates()[0] === '../vendor/onnxruntime-web/ort.webgpu.min.js',
    'the worker tries the bundled runtime before any CDN rescue mirror');
  ok(lock.graphs.length === 3 && Object.keys(pipeline.graphs).length === 3,
    'DeepFilterNet3 is honestly represented as a three-graph pipeline, not a fictitious monolith');
  for (const graph of lock.graphs) {
    const declared = pipeline.graphs[graph.role];
    ok(declared && declared.file === graph.file && declared.inputs.join(',') === graph.inputs.join(',') && declared.outputs.join(',') === graph.outputs.join(','),
      graph.role + ' graph boundary agrees between the source lock and worker');
    ok(graph.bytes > 1000000 && /^[0-9a-f]{64}$/.test(graph.sha256),
      graph.role + ' has a pinned size and SHA-256');
    const shipped = fs.readFileSync(path.join(ROOT, 'models', 'deepfilternet3', graph.file));
    const actualHash = require('crypto').createHash('sha256').update(shipped).digest('hex');
    const manifestArtifact = shippedManifest.models.deepfilternet3.variants.official.artifacts.find((a) => a.file === graph.file);
    ok(shipped.length === graph.bytes && actualHash === graph.sha256,
      graph.role + ' shipped bytes match the frozen upstream size and hash');
    ok(manifestArtifact && manifestArtifact.bytes === graph.bytes && manifestArtifact.sha256 === graph.sha256,
      graph.role + ' production manifest matches the source lock');
  }
  const groupManifest = { schema: 1, models: { deepfilternet3: {
    version: lock.version, license: lock.license, upstreamCommit: lock.upstreamCommit,
    variants: { official: { artifacts: lock.graphs.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })) } },
  } } };
  ok(RSNeural.MODEL_GROUPS.deepfilternet3.official.length === 3,
    'the controller registers the official variant as one indivisible artifact group');
  ok(RSNeural.setModelManifest(groupManifest) === 3,
    'a complete official three-graph manifest is accepted as three verified artifacts');
  const installedGroup = RSNeural.getModelManifest().deepfilternet3.official;
  ok(installedGroup.artifacts.length === 3 && installedGroup.upstreamCommit === lock.upstreamCommit,
    'the active manifest retains all group hashes and provenance');
  groupManifest.models.deepfilternet3.variants.official.artifacts.pop();
  ok(RSNeural.setModelManifest(groupManifest) === 0,
    'an incomplete graph group is rejected instead of installing a partial model');
  RSNeural.setModelManifest({});

  const graphContracts = pipeline.graphs;
  const sessions = [graphContracts.encoder, graphContracts.erbDecoder, graphContracts.dfDecoder].map((io) => ({
    inputNames: io.inputs.slice(), outputNames: io.outputs.slice(), released: false,
    async release() { this.released = true; },
  }));
  let createIndex = 0;
  const fakeOrt = { InferenceSession: { create: async () => sessions[createIndex++] } };
  const made = await RSNeuralWorker.createOfficialDfn3Group(fakeOrt,
    { encoder: new Uint8Array([1]), erbDecoder: new Uint8Array([2]), dfDecoder: new Uint8Array([3]) },
    { webgpu: { available: false, fp16: false }, webnn: { available: false }, mobile: false });
  ok(made.provider === 'wasm' && Object.keys(made.sessions).length === 3,
    'the official graph group creates three contract-checked sessions on one provider');

  createIndex = 0;
  const badSessions = sessions.map((s, i) => i === 1 ? Object.assign({}, s, { inputNames: ['wrong'] }) : s);
  const badOrt = { InferenceSession: { create: async () => badSessions[createIndex++] } };
  let groupError = '';
  try {
    await RSNeuralWorker.createOfficialDfn3Group(badOrt,
      { encoder: new Uint8Array([1]), erbDecoder: new Uint8Array([2]), dfDecoder: new Uint8Array([3]) },
      { webgpu: { available: false, fp16: false }, webnn: { available: false }, mobile: false });
  } catch (err) { groupError = err.message; }
  ok(/model-contract-mismatch/.test(groupError),
    'one incompatible decoder rejects and tears down the complete session group', groupError);

  const drySafety = new Float32Array([0.1, -0.2, 0.3]);
  ok(RSNeuralWorker.validateNeuralAudio(drySafety, Float32Array.from(drySafety)).ok,
    'finite, length-exact neural PCM passes the output safety gate');
  ok(RSNeuralWorker.validateNeuralAudio(drySafety, new Float32Array(2)).reason === 'unexpected-output-shape',
    'a short neural output is rejected');
  ok(RSNeuralWorker.validateNeuralAudio(drySafety, new Float32Array([0, NaN, 0])).reason === 'non-finite-output',
    'NaN neural PCM is rejected');
  ok(RSNeuralWorker.validateNeuralAudio(drySafety, new Float32Array([0, 9, 0])).reason === 'unsafe-output-peak',
    'a neural noise bomb is rejected before DSP');
  ok(RSNeuralWorker.validateNeuralAudio(new Float32Array(64), new Float32Array(64).fill(0.2)).reason === 'unsafe-output-dc',
    'invented DC on silence is rejected');
  const quiet = new Float32Array(64).fill(0.02);
  const loudAlternating = Float32Array.from({ length: 64 }, (_, i) => i & 1 ? -0.5 : 0.5);
  ok(RSNeuralWorker.validateNeuralAudio(quiet, loudAlternating).reason === 'unsafe-output-rms',
    'distributed neural gain bombs are rejected even when peak and DC remain legal');

  const normRe = new Float32Array(481).fill(1), normIm = new Float32Array(481);
  const normFb = RSNeuralWorker.buildErbFilterbank(481, 32, 48000, 960, 1);
  const norm = RSNeuralWorker.normalizeDfn3Features(normRe, normIm, 1, 4, 481, normFb, 32, 96);
  ok(Math.abs(norm.featErb[0] - 1.485) < 1e-4,
    'ERB features use official −60 dB initial state, 0.99 EMA and /40 scaling', norm.featErb[0].toFixed(6));
  ok(Math.abs(norm.featSpec[0] - (1 / Math.sqrt(0.01099))) < 1e-4,
    'complex features use official 0.001 initial state and unit normalization', norm.featSpec[0].toFixed(6));
  ok(norm.featErb.subarray(32).every((v) => v === 0) && norm.featSpec.subarray(96, 4 * 96).every((v) => v === 0),
    'aligned padding remains zero after stateful normalization');
  const featureHash = require('crypto').createHash('sha256')
    .update(Buffer.from(norm.featErb.buffer)).update(Buffer.from(norm.featSpec.buffer)).digest('hex');
  ok(featureHash === '6d77caa560b7ee8be5fed7020d132615263a7f0b6a7b0d0fc016fca6814c52df',
    'the normalized feature tensor has a frozen golden hash', featureHash);

  const signal = new Float32Array(48000);
  for (let i = 0; i < signal.length; i++) signal[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / 48000);
  // Official delay compensation prepends the analyser's zero hop and appends
  // one FFT window to flush synthesis and DF lookahead.
  const framedSignal = new Float32Array(signal.length + 480 + 960);
  framedSignal.set(signal, 480);
  const T = RSNeuralWorker.alignT(RSNeuralWorker.stft(framedSignal, 960, 480, RSNeuralWorker.vorbisWindow(960)).frames);
  const mask = new Float32Array(T * 32).fill(1);
  const coefs = new Float32Array(T * 96 * 10);
  for (let f = 0; f < T; f++) for (let b = 0; b < 96; b++) coefs[(f * 96 + b) * 10 + 4] = 1;
  const tensor = (data) => ({ data });
  const inferenceGroup = {
    provider: 'wasm', fp16: false,
    ort: { Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } } },
    sessions: {
      encoder: { run: async () => ({ e0: tensor([]), e1: tensor([]), e2: tensor([]), e3: tensor([]), emb: tensor([]), c0: tensor([]) }) },
      erbDecoder: { run: async (feeds) => { ok(!!feeds.emb && !!feeds.e0 && !!feeds.e3, 'encoder tensors are routed directly into the ERB decoder'); return { m: tensor(mask) }; } },
      dfDecoder: { run: async (feeds) => { ok(!!feeds.emb && !!feeds.c0, 'encoder tensors are routed directly into the DF decoder'); return { coefs: tensor(coefs), '235': tensor(new Float32Array(T).fill(1)) }; } },
    },
  };
  const rendered = await RSNeuralWorker.denoiseOfficialDfn3(signal, inferenceGroup);
  ok(rendered.applied && rendered.pipeline === 'official' && rendered.output.length === signal.length,
    'the official encoder/dual-decoder path renders a length-exact signal');
  let maxDiff = 0;
  for (let i = 1920; i < signal.length - 1920; i++) maxDiff = Math.max(maxDiff, Math.abs(rendered.output[i] - signal[i]));
  ok(maxDiff < 1e-4, 'identity ERB mask and centred order-5 DF coefficients reconstruct the input', maxDiff.toExponential(2));
}

async function testRealOrtGroup() {
  section('neural · real ONNX Runtime/WASM smoke test over the shipped graphs');
  const fs = require('fs');
  const ort = require('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const dir = path.join(ROOT, 'models', 'deepfilternet3');
  const opts = { executionProviders: ['wasm'] };
  const enc = await ort.InferenceSession.create(fs.readFileSync(path.join(dir, 'enc.onnx')), opts);
  const erb = await ort.InferenceSession.create(fs.readFileSync(path.join(dir, 'erb_dec.onnx')), opts);
  const df = await ort.InferenceSession.create(fs.readFileSync(path.join(dir, 'df_dec.onnx')), opts);
  try {
    const T = 4;
    const encoded = await enc.run({
      feat_erb: new ort.Tensor('float32', new Float32Array(T * 32), [1, 1, T, 32]),
      feat_spec: new ort.Tensor('float32', new Float32Array(2 * T * 96), [1, 2, T, 96]),
    });
    const masked = await erb.run({ emb: encoded.emb, e3: encoded.e3, e2: encoded.e2, e1: encoded.e1, e0: encoded.e0 });
    const filtered = await df.run({ emb: encoded.emb, c0: encoded.c0 });
    ok(masked.m.dims.join(',') === '1,1,4,32', 'real WASM ERB decoder returns [1,1,T,32]', masked.m.dims.join('×'));
    ok(filtered.coefs.dims.join(',') === '1,4,96,10', 'real WASM DF decoder returns order-5 complex coefficients', filtered.coefs.dims.join('×'));
    ok(filtered['235'].dims.join(',') === '1,4,1', 'real WASM DF decoder returns its auxiliary scalar output', filtered['235'].dims.join('×'));
    ok(Array.from(masked.m.data).every(Number.isFinite) && Array.from(filtered.coefs.data).every(Number.isFinite),
      'real model outputs are finite');

    const audio = new Float32Array(12000);
    for (let i = 0; i < audio.length; i++) audio[i] = 0.15 * Math.sin(2 * Math.PI * 440 * i / 48000) + 0.01 * Math.sin(2 * Math.PI * 7000 * i / 48000);
    const rendered = await RSNeuralWorker.denoiseOfficialDfn3(audio, {
      ort, provider: 'wasm', fp16: false, sessions: { encoder: enc, erbDecoder: erb, dfDecoder: df },
    });
    ok(rendered.applied === true && rendered.pipeline === 'official',
      'real shipped WASM graphs complete the full PCM inference path', JSON.stringify(rendered.output ? { pipeline: rendered.pipeline } : rendered));
    const realOutput = rendered.output || new Float32Array(0);
    ok(realOutput.length === audio.length && Array.from(realOutput).every(Number.isFinite),
      'real WASM inference returns finite, length-exact audio');
    let delta = 0, peak = 0;
    for (let i = 0; i < realOutput.length; i++) { delta += Math.abs(realOutput[i] - audio[i]); peak = Math.max(peak, Math.abs(realOutput[i])); }
    ok(realOutput.length === audio.length && delta > 0.01 && peak <= 1.5, 'real model output is applied and remains inside the safety ceiling', 'Δ ' + delta.toFixed(3) + ' · peak ' + peak.toFixed(3));
    const pcmHash = require('crypto').createHash('sha256')
      .update(Buffer.from(realOutput.buffer, realOutput.byteOffset, realOutput.byteLength)).digest('hex');
    ok(pcmHash === '0f397d29300de35c18f156ee9b14e82e5a106072616760b8dfd069e68d19801a', 'real model PCM has a frozen golden SHA-256', pcmHash);
  } finally {
    await enc.release(); await erb.release(); await df.release();
  }
}

async function testModelManager() {
  section('neural · the weight-file registry agrees with the worker (one file name, three modules)');

  ok(RSNeural.modelDir === 'models', 'the loader stores under `models/` in OPFS', RSNeural.modelDir);
  ok(RSNeural.MODEL_FILES.deepfilternet3.int8 === RSNeuralWorker.MODELS.deepfilternet3.files.int8
    && RSNeural.MODEL_FILES.bsroformer.fp16 === RSNeuralWorker.MODELS.bsroformer.files.fp16
    && RSNeural.MODEL_FILES.audiosr.fp16 === RSNeuralWorker.MODELS.audiosr.files.fp16,
    'every neural adapter uses the same published filenames in loader and worker',
    RSNeural.MODEL_FILES.deepfilternet3.int8);
  ok(RSNeural.MODEL_FILES.deepfilternet3.int4 === RSNeuralWorker.MODELS.deepfilternet3.files.int4,
    'and so is the INT4 name', RSNeural.MODEL_FILES.deepfilternet3.int4);
  ok(RSNeural.MODEL_FILES.deepfilternet3.int8 === 'deepfilternet3_int8.onnx',
    'the INT8 file is named as the brief names it', RSNeural.MODEL_FILES.deepfilternet3.int8);

  section('neural · ensureModel() on a first start — the CDN, the progress, the OPFS file');

  const modelBytes = new Uint8Array(300000);
  for (let i = 0; i < modelBytes.length; i++) modelBytes[i] = (i * 37 + 11) & 0xff;
  modelBytes[0] = 0x08;   // protobuf-looking, not '<'

  {
    const store = fakeModelStore();
    const fetchFn = fakeFetch({
      'https://cdn.test/models/deepfilternet3/deepfilternet3_int8.onnx': { bytes: modelBytes, chunk: 65536 },
    });
    const events = [];
    const off = RSNeural.onModelProgress((p) => events.push(p));
    const res = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3');
    });
    off();
    ok(res.ready === true && res.source === 'network', 'a cold start downloads the model and resolves ready', JSON.stringify(res));
    ok(res.variant === 'int8' && res.path === 'models/deepfilternet3/deepfilternet3_int8.onnx',
      'and it is stored as INT8 under models/', res.variant + ' · ' + res.path);
    ok(res.bytes === modelBytes.length, 'the reported size is the file size', String(res.bytes));
    const stored = store.files.get('deepfilternet3/deepfilternet3_int8.onnx');
    ok(!!stored && stored.length === modelBytes.length, 'the bytes really landed in the store', stored ? String(stored.length) : 'nothing');
    ok(!!stored && stored[0] === modelBytes[0] && stored[stored.length - 1] === modelBytes[modelBytes.length - 1],
      'and they are the downloaded bytes, first and last');
    ok(Array.from(store.files.keys()).every((name) => !/\.installing-/.test(name)),
      'successful promotion removes its private staging artifact');
    const dl = events.filter((e) => e.phase === 'download');
    ok(dl.length >= 4, 'progress was reported per chunk, not once at the end', dl.length + ' download events');
    ok(dl.every((e, i) => i === 0 || e.loaded >= dl[i - 1].loaded), 'the byte count never runs backwards');
    ok(dl[0].loaded < modelBytes.length && dl[dl.length - 1].ratio <= 1, 'and it starts below the total and never exceeds it',
      dl[0].loaded + ' … ' + dl[dl.length - 1].ratio.toFixed(3));
    ok(events[events.length - 1].phase === 'done' && events[events.length - 1].ratio === 1,
      'the last event is the finished one, at 100 %', events[events.length - 1].phase);
    ok(fetchFn.calls.length === 1, 'exactly one network request was made', fetchFn.calls.join(', '));
  }

  {
    const store = fakeModelStore();
    store.files.set('deepfilternet3/deepfilternet3_int8.onnx', modelBytes);
    const fetchFn = fakeFetch({});
    const res = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3');
    });
    ok(res.ready === true && res.source === 'opfs', 'a second start finds the cached file and resolves from OPFS', JSON.stringify(res));
    ok(fetchFn.calls.length === 0, 'and touches the network zero times', fetchFn.calls.join(', ') || 'no requests');
  }

  section('neural · variant fallback — INT4 where it exists, INT8 where it does not');

  {
    const store = fakeModelStore();
    const fetchFn = fakeFetch({
      'https://cdn.test/models/deepfilternet3/deepfilternet3_int8.onnx': { bytes: modelBytes, chunk: 65536 },
    });
    const res = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3', { mobile: true });
    });
    ok(res.ready === true && res.variant === 'int8',
      'a phone asks for INT4 first, gets a 404 and lands on INT8 instead of failing', res.variant || res.reason);
    ok(fetchFn.calls[0].indexOf('deepfilternet3_int4.onnx') !== -1 && fetchFn.calls[1].indexOf('deepfilternet3_int8.onnx') !== -1,
      'the requests were int4 first, then int8', fetchFn.calls.map((u) => u.split('/').pop()).join(' → '));
  }

  {
    const store = fakeModelStore();
    const fetchFn = fakeFetch({
      'https://cdn.test/models/deepfilternet3/deepfilternet3_int4.onnx': { bytes: modelBytes.slice(0, 1000) },
    });
    const res = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3', { variant: 'int4' });
    });
    ok(res.ready === true && res.variant === 'int4', 'an explicitly requested variant is the one that is fetched', res.variant || res.reason);
  }

  section('neural · atomic three-graph installation');
  {
    const names = ['enc.onnx', 'erb_dec.onnx', 'df_dec.onnx'];
    const artifacts = names.map((file, i) => {
      const bytes = new Uint8Array(1024 + i).fill(20 + i); bytes[0] = 8;
      return { file, bytes, sha256: require('crypto').createHash('sha256').update(bytes).digest('hex'), payload: bytes };
    });
    RSNeural.setModelManifest({ schema: 1, models: { deepfilternet3: { variants: { official: { artifacts: artifacts.map(({ file, bytes, sha256 }) => ({ file, bytes: bytes.length, sha256 })) } } } } });
    const store = fakeModelStore(), routes = {};
    for (const a of artifacts) routes['https://group.test/deepfilternet3/' + a.file] = { bytes: a.payload };
    const result = await withGlobals({ RSOPFS: { models: store }, fetch: fakeFetch(routes), navigator: { userAgent: 'desktop' } }, async () => {
      RSNeural.setModelSource(['https://group.test']);
      return RSNeural.ensureModel('deepfilternet3');
    });
    ok(result.ready && result.variant === 'official' && result.artifacts.length === 3,
      'all three verified graphs publish as one official variant');
    ok(artifacts.every((a) => store.files.has('deepfilternet3/' + a.file)),
      'the complete graph group is present after promotion');
    const cached = await withGlobals({ RSOPFS: { models: store }, fetch: fakeFetch({}), navigator: { userAgent: 'desktop' } },
      () => RSNeural.ensureModel('deepfilternet3'));
    ok(cached.ready && cached.source === 'opfs' && cached.verified,
      'the complete graph group validates from OPFS without network access');
    RSNeural.setModelManifest({});
  }

  section('neural · manifest discovery gates the download offer');

  {
    RSNeural.setModelManifest({});
    const store = fakeModelStore();
    const hash = require('crypto').createHash('sha256').update(modelBytes).digest('hex');
    const manifest = { schema: 1, models: { deepfilternet3: { variants: { int8: {
      file: 'deepfilternet3_int8.onnx', bytes: modelBytes.length, sha256: hash,
    } } } } };
    const fetchFn = fakeFetch({ 'https://bad.test/manifest.json': { json: { schema: 99 } }, 'https://good.test/manifest.json': { json: manifest } });
    const loaded = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn }, async () => {
      RSNeural.setModelSource(['https://bad.test', 'https://good.test']);
      ok(RSNeural.canLoadModels() === false, 'a URL alone does not make the neural download available');
      return RSNeural.loadModelManifest();
    });
    ok(loaded.ready && loaded.entries === 1 && loaded.source === 'https://good.test/manifest.json',
      'manifest discovery skips an incompatible channel and activates the first valid one', JSON.stringify(loaded));
    await withGlobals({ RSOPFS: { models: store } }, async () => {
      ok(RSNeural.canLoadModels() === true, 'a valid manifest plus model store enables downloading');
    });
    ok(fetchFn.calls.length === 2, 'manifest sources are tried in configured order', fetchFn.calls.join(' → '));
    const failed = await withGlobals({ fetch: fakeFetch({}) }, () => RSNeural.loadModelManifest('https://missing.test'));
    ok(!failed.ready && RSNeural.hasModelManifest() === false,
      'a failed refresh clears stale trust instead of retaining an old manifest', failed.reason);
  }

  section('neural · manifest integrity — size and SHA-256 gate both network and cache');

  {
    const hash = require('crypto').createHash('sha256').update(modelBytes).digest('hex');
    const accepted = RSNeural.setModelManifest({ models: { deepfilternet3: { variants: { int8: {
      file: 'deepfilternet3_int8.onnx', bytes: modelBytes.length, sha256: hash,
      version: 'dfn3-test-1', license: 'MIT', upstream: 'https://example.test/dfn',
      upstreamCommit: 'abc123', ortMin: '1.20.1', ortMaxTested: '1.20.1',
    } } } } });
    ok(accepted === 1, 'a valid, filename-pinned manifest entry is accepted');
    const store = fakeModelStore();
    const fetchFn = fakeFetch({
      'https://cdn.test/models/deepfilternet3/deepfilternet3_int8.onnx': { bytes: modelBytes, chunk: 65536 },
    });
    const first = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'desktop' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3');
    });
    ok(first.ready && first.verified === true && first.sha256 === hash,
      'a downloaded artifact is activated only after its SHA-256 matches', first.sha256);
    ok(first.metadata && first.metadata.version === 'dfn3-test-1' && first.metadata.license === 'MIT' && first.metadata.upstreamCommit === 'abc123',
      'the verified install persists version, license and upstream provenance', JSON.stringify(first.metadata));
    const persistedMetaBytes = store.files.get('deepfilternet3/deepfilternet3_int8.onnx.metadata.json');
    const persistedMeta = persistedMetaBytes ? JSON.parse(Buffer.from(persistedMetaBytes).toString('utf8')) : null;
    ok(persistedMeta && persistedMeta.sha256 === hash && persistedMeta.ortMin === '1.20.1',
      'the OPFS sidecar records integrity and runtime compatibility');
    const cached = await withGlobals({ RSOPFS: { models: store }, fetch: fakeFetch({}), navigator: { userAgent: 'desktop' } },
      () => RSNeural.ensureModel('deepfilternet3'));
    ok(cached.ready && cached.source === 'opfs' && cached.verified === true,
      'a later cache hit is revalidated against the same manifest');
    ok(cached.metadata && cached.metadata.version === 'dfn3-test-1',
      'cache status restores persisted model provenance without network access');

    const corrupt = modelBytes.slice(); corrupt[100] ^= 0xff;
    const badStore = fakeModelStore();
    const badFetch = fakeFetch({
      'https://cdn.test/models/deepfilternet3/deepfilternet3_int8.onnx': { bytes: corrupt },
    });
    const bad = await withGlobals({ RSOPFS: { models: badStore }, fetch: badFetch, navigator: { userAgent: 'desktop' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3');
    });
    ok(!bad.ready && /SHA-256 mismatch/.test(bad.reason), 'a same-size corrupted model is rejected by hash', bad.reason);
    ok(badStore.files.size === 0, 'a hash-rejected artifact is removed from OPFS');

    const updateStore = fakeModelStore();
    const previous = new Uint8Array([8, 1, 2, 3, 4]);
    updateStore.files.set('deepfilternet3/deepfilternet3_int8.onnx', previous.slice());
    const failedUpdate = await withGlobals({ RSOPFS: { models: updateStore }, fetch: badFetch, navigator: { userAgent: 'desktop' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3');
    });
    const stillActive = updateStore.files.get('deepfilternet3/deepfilternet3_int8.onnx');
    ok(!failedUpdate.ready && stillActive && Array.from(stillActive).join(',') === Array.from(previous).join(','),
      'a failed update leaves the previous active model byte-for-byte intact');
    ok(Array.from(updateStore.files.keys()).every((name) => !/\.installing-/.test(name)),
      'failed updates leave no staging artifact behind');

    const rejectedEntries = RSNeural.setModelManifest({ models: {
      deepfilternet3: { variants: {
        int8: { file: 'renamed.onnx', bytes: 1, sha256: '0'.repeat(64) },
        int4: { file: 'deepfilternet3_int4.onnx', bytes: 1024, sha256: '3'.repeat(64) },
      } },
      bsroformer: { version: 'test', upstream: 'https://example.test/bsr', variants: { fp16: {
        file: 'bs_roformer_4stem_rhythm_fp16.onnx', bytes: 1024, sha256: '1'.repeat(64),
      } } },
      audiosr: { version: 'test', license: 'MIT', upstream: 'https://example.test/audiosr', variants: { fp16: {
        file: 'audiosr_lite.fp16.onnx', bytes: 129 * 1024 * 1024, sha256: '2'.repeat(64),
      } } },
    } });
    const rejectionReasons = RSNeural.getModelManifestRejections().map((item) => item.reason).sort();
    ok(rejectedEntries === 0 && rejectionReasons.join(',') === 'filename-mismatch,missing-license,missing-quality-gate,size-budget',
      'manifests report why adapters, unlicensed weights, unqualified INT4 and oversized models were rejected',
      rejectionReasons.join(', '));
    RSNeural.setModelManifest({});
  }

  section('neural · a failed or cancelled download leaves nothing behind and never rejects');

  {
    const store = fakeModelStore();
    const fetchFn = fakeFetch({
      'https://cdn.test/models/deepfilternet3/deepfilternet3_int8.onnx': { bytes: modelBytes },
    });
    const ac = new AbortController(); ac.abort();
    const res = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'desktop' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3', { variant: 'int8', signal: ac.signal });
    });
    ok(!res.ready && res.reason === 'aborted' && fetchFn.calls.length === 0,
      'a pre-aborted model install performs no network request');
  }

  {
    const store = fakeModelStore();
    const fetchFn = fakeFetch({
      'https://cdn.test/models/deepfilternet3/deepfilternet3_int8.onnx': { bytes: modelBytes, chunk: 32768 },
    });
    const ac = new AbortController();
    const res = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'desktop' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3', { variant: 'int8', signal: ac.signal,
        onProgress: (p) => { if (p.phase === 'download' && p.loaded > 0) ac.abort(); } });
    });
    ok(!res.ready && res.reason === 'aborted', 'cancelling a streaming model download reports aborted, not download-failed');
    ok(store.files.size === 0 && store.writes.length === 1 && store.writes[0].aborted,
      'a cancelled download aborts and removes its private staging file');
  }

  {
    const store = fakeModelStore();
    const fetchFn = fakeFetch({});
    const res = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3');
    });
    ok(res.ready === false && /^download-failed/.test(res.reason), 'every source 404ing is an answer, not a rejection', res.reason);
    ok(store.files.size === 0, 'and no half-written model is left in the store', store.files.size + ' files');
  }

  {
    const store = fakeModelStore();
    const fetchFn = fakeFetch({
      'https://cdn.test/models/deepfilternet3/deepfilternet3_int8.onnx': { bytes: modelBytes, chunk: 65536, length: modelBytes.length + 4096 },
    });
    const res = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3');
    });
    ok(res.ready === false && /short read/.test(res.reason), 'a truncated body fails the download instead of caching a broken model', res.reason);
    ok(store.files.size === 0 && store.writes[0].aborted === true, 'and the partial file was aborted and deleted');
  }

  {
    const store = fakeModelStore();
    const html = new Uint8Array(Buffer.from('<!doctype html><h1>404 not really</h1>'));
    const fetchFn = fakeFetch({
      'https://cdn.test/models/deepfilternet3/deepfilternet3_int8.onnx': { bytes: html, type: 'text/html' },
    });
    const res = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3');
    });
    ok(res.ready === false && /HTML/i.test(res.reason), 'an error page served with a 200 is refused, not stored as a model', res.reason);
    ok(store.files.size === 0, 'and nothing is cached');
  }

  section('neural · concurrency, configuration and the cache report');

  {
    const store = fakeModelStore();
    const fetchFn = fakeFetch({
      'https://cdn.test/models/deepfilternet3/deepfilternet3_int8.onnx': { bytes: modelBytes, chunk: 65536 },
    });
    const both = await withGlobals({ RSOPFS: { models: store }, fetch: fetchFn, navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } }, async () => {
      RSNeural.setModelSource(['https://cdn.test/models']);
      const a = RSNeural.ensureModel('deepfilternet3');
      const b = RSNeural.ensureModel('deepfilternet3');
      ok(a === b, 'two calls in the same tick share one promise — one download, not two racing into one file');
      return Promise.all([a, b]);
    });
    ok(both[0].ready && both[1].ready && fetchFn.calls.length === 1,
      'and both resolve with the same single download', fetchFn.calls.length + ' request(s)');
  }

  {
    const store = fakeModelStore();
    store.files.set('deepfilternet3/deepfilternet3_int4.onnx', modelBytes.slice(0, 512));
    let res;
    await withGlobals({ RSOPFS: { models: store } }, async () => {
      res = await RSNeural.modelStatus('deepfilternet3');
      RSNeural.setModelSource([]);
      ok(RSNeural.canLoadModels() === false, 'an empty source list disables downloading');
      ok(RSNeural.getModelSource().length === 0, 'and getModelSource() reports it');
      const off = RSNeural.ensureModel('deepfilternet3');
      const failed = await off;
      ok(failed.ready === false && /download-failed/.test(failed.reason), 'ensureModel() then fails cleanly rather than guessing a URL', failed.reason);
      RSNeural.setModelSource('https://a.test/models/');
      ok(RSNeural.getModelSource()[0] === 'https://a.test/models/', 'a single string is accepted, trailing slash and all');
      RSNeural.setModelSource(['https://a.test/m', 'https://b.test/m']);
      ok(RSNeural.getModelSource().length === 2, 'a list is accepted, in order');
    });
    ok(res.cached === true && res.variants.int4.cached === true && res.variants.int4.size === 512,
      'modelStatus() reports what is cached without any network access', JSON.stringify(res.variants.int4));
    ok(res.variants.int8.cached === false, 'and reports the variant that is not there as not there');
  }

  section('neural · cache management, storage totals and update detection');
  {
    const store = fakeModelStore();
    const file = 'deepfilternet3_int8.onnx';
    const installed = new Uint8Array(2048).fill(7);
    const oldHash = require('crypto').createHash('sha256').update(installed).digest('hex');
    store.files.set('deepfilternet3/' + file, installed);
    store.files.set('deepfilternet3/' + file + '.metadata.json', new Uint8Array(Buffer.from(JSON.stringify({
      schema: 1, model: 'deepfilternet3', variant: 'int8', file, bytes: installed.length, sha256: oldHash, version: '1.0.0', license: 'MIT',
    }))));
    RSNeural.setModelManifest({ schema: 1, models: { deepfilternet3: { variants: { int8: {
      file, bytes: 2048, sha256: 'a'.repeat(64), version: '2.0.0', license: 'MIT',
    } } } } });
    await withGlobals({ RSOPFS: { models: store } }, async () => {
      const status = await RSNeural.modelStatus('deepfilternet3');
      ok(status.totalBytes === 2048 && status.variants.int8.updateAvailable === true,
        'status totals weight bytes and detects a manifest hash update', JSON.stringify(status.variants.int8));
      const all = await RSNeural.modelStorageStatus();
      ok(all.totalBytes === 2048 && all.models.deepfilternet3.cached,
        'the global storage report totals every installed model');
      const removed = await RSNeural.removeModel('deepfilternet3', 'int8');
      ok(removed.removed === true && !store.files.has('deepfilternet3/' + file),
        'removing one variant deletes its weight');
      ok(!store.files.has('deepfilternet3/' + file + '.metadata.json'),
        'removing one variant also deletes its provenance sidecar');
      const again = await RSNeural.removeModel('deepfilternet3', 'int8');
      ok(again.removed === false, 'removing an already absent variant is idempotent');
    });
    const unknown = await RSNeural.removeModel('deepfilternet3', 'nope');
    ok(unknown.removed === false && /unknown-variant/.test(unknown.reason),
      'an unknown variant is rejected without touching storage');
    RSNeural.setModelManifest({});
  }

  {
    const res = await withGlobals({ navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } }, async () => {
      delete global.RSOPFS;
      RSNeural.setModelSource(['https://cdn.test/models']);
      return RSNeural.ensureModel('deepfilternet3');
    });
    ok(res.ready === false && res.reason === 'no-store', 'with no model store at all the answer is `no-store`, not a throw', res.reason);
    ok(RSNeural.canLoadModels() === false, 'and canLoadModels() says so');
  }

  // leave the module as the rest of the suite expects to find it
  RSNeural.setModelSource(['https://cdn.jsdelivr.net/gh/AndrexTheDev/Remaster-Suite@models', 'models']);
}

async function main() {
  testAlignment();
  testErbFilterbank();
  testFftAny();
  testStftRoundTrip();
  await testProbeAndFallback();
  await testMobileAndWebNN();
  await testModelContracts();
  await testRealOrtGroup();
  await testModelManager();
  await testHardwareFallbackNotification();
  testWorklet();

  console.log('\n' + '-'.repeat(60));
  if (failed) {
    console.log('FAILED ' + failed + ' / ' + (passed + failed) + ':\n  - ' + failures.join('\n  - '));
    process.exitCode = 1;
  } else {
    console.log('ALL TESTS PASSED (' + passed + ')');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
