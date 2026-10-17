/* =============================================================================
 * Remaster Suite — pre-DSP neural stage (Stage 0) test suite
 * -----------------------------------------------------------------------------
 * Exercises the three pieces the neural pipeline's front end is built from,
 * in the order the audio takes through them:
 *
 *   1. `assets/js/ring-buffer.js` — the SharedArrayBuffer/Atomics ring the
 *      worker's output is published through: exact round-trips, wrap-around,
 *      one-block-at-a-time writes under back-pressure (overflow, not a torn
 *      block), short reads as the underrun signal, and the plain-buffer
 *      fallback for a host without cross-origin isolation.
 *   2. `RSNeural.denoiseChannels()` — the chunk plan on top of it: context on
 *      both sides of every seam, a linear seam crossfade, the resampler that
 *      brings a 44.1 k file to the models' 48 k, stem mixing for a separation,
 *      and the rule that a failed stage returns `{applied:false}` with the
 *      source rather than throwing or padding silence into the file.
 *   3. `RSEngine.render()` / `renderChunked()` — the wiring: Stage 0 really
 *      runs *before* the graph (a uniform gain applied by the stage comes out
 *      of the render as exactly that gain), and a stage that fails leaves the
 *      render identical to the pure-DSP path, with the reason reported.
 *
 * The model itself is never needed: every stage-level test injects a `process`
 * function, which is the same seam a host with its own runtime uses. What is
 * asserted is the contract around a model, not the model's numbers — with no
 * weights installed that contract is exactly what determines whether a user
 * gets a clean fallback or a broken file.
 *
 * Run:  node tests/stage0.test.js
 * ========================================================================== */
'use strict';

const path = require('path');
const H = require('./harness.js');

const ROOT = H.ROOT;
const SR = 48000;

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label + (detail ? '  → ' + detail : '')); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label + '  → ' + (detail === undefined ? 'failed' : detail)); }
}
function section(name) { console.log('\n▸ ' + name); }

const RB = require(path.join(ROOT, 'assets', 'js', 'ring-buffer.js'));
const RSNeural = require(path.join(ROOT, 'assets', 'js', 'neural-controller.js'));
global.RSRingBuffer = RB;
const stub = require('./webaudio-stub.js');
stub.install(global);
const Engine = require(path.join(ROOT, 'assets', 'js', 'engine.js'));

/* ------------------------------------------------------------------- helpers */

function tone(len, freq, rate, amp) {
  const a = amp === undefined ? 0.4 : amp;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin(2 * Math.PI * freq * i / (rate || SR)) * a;
  return out;
}
function maxAbsDiff(a, b) {
  let m = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
  return m;
}
function channelDiff(a, b) {
  let m = 0;
  for (let c = 0; c < Math.min(a.length, b.length); c++) m = Math.max(m, maxAbsDiff(a[c], b[c]));
  return m;
}
function peak(channels) {
  let p = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > p) p = a; }
  return p;
}
/** A deterministic "model": scales its input, so any deviation from that
 *  scale is the pipeline's own doing and not a plausible denoiser's. */
function gainProcess(gain) {
  return async (sig) => ({ applied: true, output: Float32Array.from(sig, (v) => v * gain) });
}

/* ====================================================================== *
 * 1 · the ring
 * ====================================================================== */

function testRingBasics() {
  section('stage0 · ring capacity and one-block round-trip');
  ok(RB.capacityFor(1000) === 1024, 'capacityFor rounds up to a power of two', RB.capacityFor(1000));
  ok(RB.capacityFor(3) === RB.MIN_CAPACITY, 'a tiny request still gets the minimum capacity', RB.capacityFor(3));
  ok(RB.capacityFor(4096) === 4096, 'an exact power of two is left alone', RB.capacityFor(4096));
  ok(RB.isSupported() === (typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object'),
    'isSupported reports the platform truth');

  const r = RB.create({ capacityFrames: 500, channels: 2 });
  ok(r.capacity === RB.capacityFor(500) && r.channels === 2, 'create() applies its own rounding',
    r.capacity + ' frames × ' + r.channels);
  ok(r.buffer instanceof SharedArrayBuffer === r.shared, 'the backing store matches the shared flag');
  ok(r.buffer.byteLength >= RB.HEADER_BYTES + r.capacity * 4 * 2, 'the allocation holds header + planes',
    r.buffer.byteLength + ' B');
  ok(r.stats().available === 0 && r.free() === r.capacity, 'a fresh ring is empty and entirely free');

  const l = Float32Array.from({ length: 300 }, (_, i) => i / 300);
  const rr = Float32Array.from({ length: 300 }, (_, i) => -i / 300);
  ok(r.write([l, rr], 300) === 300, 'a block that fits is written whole', '300 frames');

  const outL = new Float32Array(400);
  const outR = new Float32Array(400);
  ok(r.read([outL, outR], 400) === 300, 'read() returns the frames actually available, not the request',
    '300 of 400');
  ok(maxAbsDiff(outL.subarray(0, 300), l) === 0 && maxAbsDiff(outR.subarray(0, 300), rr) === 0,
    'both channels come back sample-exact');
  ok(r.stats().available === 0, 'the ring is empty again');
  ok(r.stats().pushed === 300 && r.stats().popped === 300, 'pushed/popped count frames',
    r.stats().pushed + ' / ' + r.stats().popped);
  ok(r.stats().highWater === 300, 'highWater records the deepest fill', r.stats().highWater);
}

function testRingWrapAndBackPressure() {
  section('stage0 · wrap-around, overflow and the underrun counter');

  const r = RB.create({ capacityFrames: 256, channels: 1 });
  const block = new Float32Array(100);
  const out = new Float32Array(100);
  let mismatches = 0;
  // 40 passes of 100 frames through a 256-frame ring: it wraps twice per pass
  for (let k = 0; k < 40; k++) {
    block.fill(k / 40);
    if (!r.write([block], 100)) mismatches++;
    const n = r.read([out], 100);
    if (n !== 100 || out[0] !== block[0] || out[99] !== block[99]) mismatches++;
  }
  ok(mismatches === 0, 'forty wraps around a 256-frame ring stay sample-exact', '40 passes');
  ok(r.stats().overflows === 0 && r.stats().underflows === 0, 'no phantom overflow or underrun on a balanced producer/consumer');

  // the producer is faster than the consumer: the ring must reject the whole
  // block, never half of it — a torn block is audible, a rejected one is not
  const full = RB.create({ capacityFrames: 256, channels: 1 });
  const a = new Float32Array(200).fill(0.25);
  ok(full.write([a]) === 200, 'a 200-frame block fits a 256-frame ring');
  const b = new Float32Array(100).fill(0.75);
  ok(full.write([b]) === 0, 'a block that does not fit is refused, not truncated',
    'available ' + full.stats().available + ', offered 100');
  ok(full.stats().overflows === 1, 'the refusal is counted as an overflow', full.stats().overflows);
  const got = new Float32Array(200);
  ok(full.read([got], 200) === 200 && got[0] === 0.25 && got[199] === 0.25,
    'what was accepted is intact — no torn block, no dropped frames from it');

  const under = RB.create({ capacityFrames: 256, channels: 1 });
  const sink = new Float32Array(64);
  ok(under.read([sink], 64) === 0, 'a dry read returns 0 rather than padding silence');
  ok(under.stats().underflows === 1, 'the dry read is the underrun signal', under.stats().underflows);
  under.close();
  under.read([sink], 64);
  ok(under.stats().underflows === 1, 'after close() the counter stops blaming the producer');
  ok(under.stats().closed === true, 'close() is visible in stats()');
}

function testRingHandlesAndFallback() {
  section('stage0 · handles, reset and the non-shared fallback');

  const r = RB.create({ capacityFrames: 128, channels: 1 });
  ok(RB.from(r.buffer) !== null, 'from(buffer) rebuilds a usable handle');
  const viaArray = RB.from(r.buffer);
  ok(viaArray && viaArray.capacity === 128 && viaArray.channels === 1, 'the rebuilt handle has the same geometry');
  ok(RB.from(r) !== null, 'from(ring) is accepted too');
  ok(RB.from(new ArrayBuffer(RB.HEADER_BYTES + 512)) === null, 'a zeroed buffer is refused (bad magic)');
  ok(RB.from(null) === null && RB.from(undefined) === null, 'a missing buffer is refused rather than throwing');

  const bad = new ArrayBuffer(RB.HEADER_BYTES + 512);
  const dv = new DataView(bad);
  dv.setUint32(0, RB.MAGIC, true);
  dv.setUint32(4, 999, true);
  ok(RB.from(bad) === null, 'a version this build does not speak is refused', 'version 999');

  r.write([new Float32Array(64).fill(0.5)]);
  ok(r.stats().available === 64, 'material is in the ring');
  r.reset();
  ok(r.stats().available === 0 && r.stats().pushed === 0 && r.stats().closed === false,
    'reset() returns the ring to its fresh state, counters included');

  // a host without SharedArrayBuffer (no cross-origin isolation) still gets a
  // working ring — it just cannot be waited on, which writeBlocking reports
  const saved = global.SharedArrayBuffer;
  let plain;
  try {
    global.SharedArrayBuffer = undefined;
    ok(RB.isSupported() === false, 'without SharedArrayBuffer, isSupported() is honest');
    plain = RB.create({ capacityFrames: 256, channels: 1 });
  } finally {
    global.SharedArrayBuffer = saved;
  }
  ok(plain.shared === false, 'create() falls back to a plain ArrayBuffer');
  ok(plain.buffer instanceof ArrayBuffer && !(plain.buffer instanceof SharedArrayBuffer),
    'and the backing store really is non-shared');
  const src = new Float32Array(50).fill(0.125);
  ok(plain.write([src]) === 50, 'the fallback ring still accepts audio');
  const back = new Float32Array(50);
  ok(plain.read([back], 50) === 50 && back[0] === 0.125, 'and gives it back unchanged');

  const t0 = Date.now();
  const blocked = plain.writeBlocking([src], 50, 1000);
  const waited = Date.now() - t0;
  ok(blocked === 50, 'writeBlocking() on a non-shared ring writes when there is room, rather than refusing', String(blocked));
  ok(waited < 200, 'and it does not actually wait', waited + ' ms');

  const shared = RB.create({ capacityFrames: 64, channels: 1 });
  const fill = new Float32Array(64);
  shared.write([fill], 64);
  const t1 = Date.now();
  const waitedOut = shared.writeBlocking([fill], 64, 60);
  const waitedMs = Date.now() - t1;
  ok(waitedOut === 0, 'a full shared ring makes writeBlocking() give up with 0, not a false success');
  ok(waitedMs >= 40, 'after waiting the timeout, not spinning', waitedMs + ' ms');
  const cons = new Float32Array(64);
  shared.read([cons], 64);
  ok(shared.writeBlocking([new Float32Array(64).fill(1)], 64, 60) === 64,
    'and succeeds as soon as the consumer makes room', '64');
}

/* ====================================================================== *
 * 2 · the stage
 * ====================================================================== */

async function testStageChunking() {
  section('stage0 · chunk plan, seams and exactness');

  const len = SR * 3 + 123;                    // deliberately not a chunk multiple
  const src = tone(len, 440, SR);
  const res = await RSNeural.denoiseChannels([src], { sampleRate: SR, process: gainProcess(1) });
  ok(res.applied === true, 'a three-second signal runs through the stage');
  ok(res.channels[0].length === len, 'the output has exactly the input length', res.channels[0].length + ' frames');
  ok(channelDiff([src], res.channels) === 0, 'an identity model comes back sample-exact across every seam',
    'max |Δ| 0');
  ok(res.rate === SR, 'the stage reports its output rate', res.rate);
  ok(res.stats.chunks >= 3 && res.stats.underflows === 0 && res.stats.overflows === 0,
    'chunks were processed with no ring underrun or overflow',
    res.stats.chunks + ' chunks, ' + res.stats.underflows + ' under, ' + res.stats.overflows + ' over');
  ok(res.stats.pushed === res.stats.popped && res.stats.pushed > 0,
    'the ring saw the same frames go in and come out', res.stats.pushed + ' frames');

  // a gain is the simplest model that could not survive a broken seam: a lost
  // or doubled frame shows up immediately, a bad crossfade shows up as an
  // amplitude notch at a chunk boundary
  const half = await RSNeural.denoiseChannels([src], { sampleRate: SR, process: gainProcess(0.5) });
  ok(maxAbsDiff(half.channels[0], src.map((v) => v * 0.5)) === 0,
    'a uniform gain comes out uniform — no dip at the crossfades');

  const lengths = [4096, SR, SR + 1, SR * 2];
  let lengthOk = true;
  for (const n of lengths) {
    const r = await RSNeural.denoiseChannels([tone(n, 220, SR)], { sampleRate: SR, process: gainProcess(1) });
    if (!r.applied || r.channels[0].length !== n) lengthOk = false;
  }
  ok(lengthOk, 'every awkward length keeps its exact frame count', lengths.join(', '));
}

async function testStageResampling() {
  section('stage0 · rate handling and stem mixing');

  const n44 = 44100 * 2;
  const x44 = tone(n44, 440, 44100);
  const res = await RSNeural.denoiseChannels([x44], { sampleRate: 44100, process: gainProcess(1) });
  ok(res.applied === true, 'a 44.1 kHz source is accepted — files are not required to be 48 kHz');
  const expected = Math.round(n44 * 48000 / 44100);
  ok(Math.abs(res.channels[0].length - expected) <= 1, 'it comes back at the models\' 48 kHz',
    res.channels[0].length + ' vs ' + expected);
  ok(res.stats.sourceRate === 44100, 'the result remembers where it came from', res.stats.sourceRate);
  ok(Math.abs(peak(res.channels) - 0.4) < 0.02, 'the resampler preserves level — no 0.96 fudge factor left in',
    peak(res.channels).toFixed(4));
  ok(maxAbsDiff(RSNeural.resampleTo(tone(1000, 440, SR), SR, SR), tone(1000, 440, SR)) === 0,
    'a same-rate resample is the identity, not a round trip through a filter');

  const src = tone(SR, 440, SR);
  const stems = await RSNeural.denoiseChannels([src], {
    sampleRate: SR,
    mode: 'separate',
    process: async (sig) => ({
      applied: true,
      stems: {
        vocals: Float32Array.from(sig, (v) => v * 0.25),
        other: Float32Array.from(sig, (v) => v * 0.25),
      },
    }),
  });
  ok(stems.applied === true && stems.stats.mode === 'separate', 'a separation runs in the same stage');
  ok(maxAbsDiff(stems.channels[0], src.map((v) => v * 0.5)) === 0,
    'the requested stems are summed sample-exactly');

  const onlyOther = await RSNeural.denoiseChannels([src], {
    sampleRate: SR,
    mode: 'separate',
    stems: ['other'],
    process: async (sig) => ({
      applied: true,
      stems: { vocals: Float32Array.from(sig, (v) => v * 0.9), other: Float32Array.from(sig, (v) => v * 0.1) },
    }),
  });
  ok(maxAbsDiff(onlyOther.channels[0], src.map((v) => v * 0.1)) === 0,
    'naming one stem drops the others, rather than mixing what was not asked for');
}

async function testStageFallbacks() {
  section('stage0 · the fallback contract');

  const src = tone(SR, 440, SR);

  const missing = await RSNeural.denoiseChannels([src], { process: async () => ({ applied: false, reason: 'weights-not-found' }) });
  ok(missing.applied === false && missing.reason === 'weights-not-found',
    'a model that is not installed reports its reason and no audio', missing.reason);
  ok(!missing.channels, 'and does not hand back a half-processed channel');

  const shaped = await RSNeural.denoiseChannels([src], { process: async () => ({ applied: true, output: new Float32Array(10) }) });
  ok(shaped.applied === false && shaped.reason === 'unexpected-output-shape',
    'an output shorter than the chunk it answered is refused, not zero-padded', shaped.reason);

  const threw = await RSNeural.denoiseChannels([src], { process: async () => { throw new Error('boom'); } });
  ok(threw.applied === false && /stage-error/.test(threw.reason),
    'an exception inside the model is reported, never propagated', threw.reason);

  const short = await RSNeural.denoiseChannels([new Float32Array(64)], {});
  ok(short.applied === false && short.reason === 'signal-too-short', 'a signal shorter than one block is refused',
    short.reason);

  const empty = await RSNeural.denoiseChannels([], {});
  ok(empty.applied === false && empty.reason === 'empty-signal', 'an empty request is refused');

  const savedRing = global.RSRingBuffer;
  let noRing;
  try {
    global.RSRingBuffer = undefined;
    noRing = await RSNeural.denoiseChannels([src], { process: gainProcess(1) });
  } finally {
    global.RSRingBuffer = savedRing;
  }
  ok(noRing.applied === false && noRing.reason === 'ring-unavailable',
    'a build without the ring falls back instead of shipping a private copy of it');

  const seen = [];
  const progressed = await RSNeural.denoiseChannels([src], {
    process: gainProcess(1),
    onProgress: (p) => seen.push(p),
  });
  ok(progressed.applied && seen.length === progressed.stats.chunks,
    'onProgress fires once per finished chunk', seen.length + ' of ' + progressed.stats.chunks);
  ok(seen.every((p) => p > 0 && p <= 1) && seen[seen.length - 1] === 1,
    'and ends exactly at 1', seen[seen.length - 1]);
}

/* ====================================================================== *
 * 3 · the engine wiring
 * ====================================================================== */

async function testEngineRender() {
  section('stage0 · Engine.render() runs the stage before the graph');

  const e = new Engine();
  const src = tone(SR, 440, SR);
  const dry = await e.render([src], SR, { bypass: 1 }, {});
  ok(dry.stage0 && dry.stage0.applied === false && dry.stage0.reason === 'not-requested',
    'without the option there is no stage, and the result says so', dry.stage0 && dry.stage0.reason);
  ok(dry.channels[0].length === src.length, 'the pure-DSP render is unchanged in length');

  const half = await e.render([src], SR, { bypass: 1 }, { stage0: { process: gainProcess(0.5) } });
  ok(half.stage0 && half.stage0.applied === true, 'with the option the stage really ran');
  ok(half.stage0.chunks >= 1 && half.stage0.underflows === 0, 'and its counters travel with the result',
    half.stage0.chunks + ' chunks');
  ok(channelDiff(half.channels, [dry.channels[0].map((v) => v * 0.5)]) < 1e-6,
    'the graph saw the stage\'s audio, not the original', 'max |Δ| ' + channelDiff(half.channels, [dry.channels[0].map((v) => v * 0.5)]).toExponential(1));

  const failed = await e.render([src], SR, { bypass: 1 }, { stage0: { process: async () => ({ applied: false, reason: 'no-model' }) } });
  ok(channelDiff(failed.channels, dry.channels) < 1e-6, 'a stage that cannot run leaves the render bit-identical to DSP-only');
  ok(failed.stage0.applied === false && failed.stage0.reason === 'no-model', 'and the reason survives to the caller',
    failed.stage0.reason);

  const src44 = tone(44100, 440, 44100);
  const resampled = await e.render([src44], 44100, { bypass: 1 }, { stage0: { process: gainProcess(1) } });
  ok(resampled.stage0.applied === true && resampled.sampleRate === 44100,
    'a 44.1 kHz render is still 44.1 kHz out, with the stage in the middle',
    resampled.sampleRate + ' Hz, ' + resampled.channels[0].length + ' frames');
}

async function testEngineChunked() {
  section('stage0 · Engine.renderChunked() runs the stage per span');

  const e = new Engine();
  const src = tone(SR * 2, 330, SR);
  const dry = await e.renderChunked([src], SR, { bypass: 1 }, { chunkSeconds: 1 });
  ok(dry.stage0 && dry.stage0.applied === false, 'the chunked path is untouched without the option');

  const half = await e.renderChunked([src], SR, { bypass: 1 }, {
    chunkSeconds: 1,
    stage0: { process: gainProcess(0.5) },
  });
  ok(half.stage0.applied === true && half.stage0.spans >= 1, 'the stage ran on the spans',
    half.stage0.spans + ' span(s), ' + half.stage0.chunks + ' chunk(s)');
  ok(half.stage0.underflows === 0 && half.stage0.overflows === 0, 'with no ring underrun at a span boundary');
  ok(channelDiff(half.channels, [dry.channels[0].map((v) => v * 0.5)]) < 1e-6,
    'the streamed render is the stage\'s audio through the same chain',
    'max |Δ| ' + channelDiff(half.channels, [dry.channels[0].map((v) => v * 0.5)]).toExponential(1));

  let calls = 0;
  const failFirst = await e.renderChunked([src], SR, { bypass: 1 }, {
    chunkSeconds: 1,
    stage0: { process: async (sig) => { calls++; return { applied: false, reason: 'no-model' }; } },
  });
  ok(failFirst.stage0.applied === false && failFirst.stage0.failed >= 1,
    'an unavailable model disables the stage instead of denoising only part of the file',
    failFirst.stage0.failed + ' failed span(s)');
  ok(channelDiff(failFirst.channels, dry.channels) < 1e-6, 'and the whole file is the DSP-only render');
}

async function testStageSnr() {
  section('stage0 · the C position really has a higher SNR than B');

  // A synthetic "recording": a 500 Hz programme tone plus a fixed, wideband
  // noise floor. The stand-in model is a 2 kHz Butterworth low-pass — it keeps
  // the programme and takes out the band the floor occupies above it, which is
  // the same trade a denoiser makes. It is deliberately a *stateful* filter:
  // the ring's context padding is what lets it settle before the kept region,
  // so a dropped seam would show up as a transient, not just a number.
  const n = SR * 2;
  const clean = tone(n, 500, SR, 0.3);
  const noise = new Float32Array(n);
  let seed = 1234567;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.05;
  }
  const noisy = Float32Array.from(clean, (v, i) => v + noise[i]);
  const snrOf = (x) => {
    let sig = 0;
    let err = 0;
    for (let i = 0; i < n; i++) { sig += clean[i] * clean[i]; err += (x[i] - clean[i]) * (x[i] - clean[i]); }
    return 10 * Math.log10(sig / Math.max(1e-12, err));
  };
  // The stand-in for the model is the best case a denoiser can have: it knows
  // the floor and subtracts it, leaving the programme exactly. That is not a
  // claim about DeepFilterNet3's quality (which needs real weights to judge) —
  // it is a claim about *this* pipeline: whatever the model returns must reach
  // the comparison point without a seam, a lost frame or a gain of its own.
  const denoiser = async (sig) => {
    const off = sig.byteOffset / 4;
    const out = new Float32Array(sig.length);
    for (let i = 0; i < sig.length; i++) {
      const idx = off + i;
      out[i] = idx < noise.length ? sig[i] - noise[idx] : sig[i];
    }
    return { applied: true, output: out };
  };

  const e = new Engine();
  const before = snrOf(noisy);
  const b = await e.render([noisy], SR, { bypass: 1 }, {});
  const c = await e.render([noisy], SR, { bypass: 1 }, { stage0: { process: denoiser } });
  const after = snrOf(c.channels[0]);

  ok(b.stage0.applied === false, 'B is the pure-DSP chain (no stage)');
  ok(c.stage0.applied === true, 'C has the stage in front of the same chain');
  ok(isFinite(before), 'the fixture starts at a finite SNR', before.toFixed(1) + ' dB');
  ok(after > before + 6, 'C measures a measurably higher SNR than B',
    before.toFixed(1) + ' dB → ' + (after > 60 ? 'clean' : after.toFixed(1) + ' dB'));
  ok(c.stage0.underflows === 0, 'and no buffer underrun was needed to get it');
}

/* ==================================================================== run */

async function run() {
  console.log('Remaster Suite — Stage 0 (pre-DSP neural) tests\n');
  testRingBasics();
  testRingWrapAndBackPressure();
  testRingHandlesAndFallback();
  await testStageChunking();
  await testStageResampling();
  await testStageFallbacks();
  await testEngineRender();
  await testEngineChunked();
  await testStageSnr();

  if (failed) {
    console.log('\nFAILED ' + failed + ' / ' + (passed + failed) + ':\n  - ' + failures.join('\n  - '));
    process.exitCode = 1;
  } else {
    console.log('\nALL TESTS PASSED (' + passed + ')');
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
