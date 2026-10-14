/* =============================================================================
 * Remaster Suite — headless test harness
 * -----------------------------------------------------------------------------
 * Loads the production AudioWorklet DSP and the shared DSP utility library into
 * a sandbox so both can be exercised from plain Node without a browser.
 *
 * Run with:  node tests/dsp.test.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const procCache = new Map();
let procFactory = null;

/** Load the AudioWorkletProcessor class (optionally at a given sample rate). */
function loadProcessor(sr) {
  const rate = sr || 48000;
  if (procCache.has(rate)) return procCache.get(rate);
  if (!procFactory) {
    const code = fs.readFileSync(path.join(ROOT, 'assets', 'worklets', 'remaster-processor.js'), 'utf8');
    procFactory = vm.runInThisContext(
      `(function(sampleRate, AudioWorkletProcessor, registerProcessor) {\n${code}\n})`,
      { filename: 'remaster-processor.js' }
    );
  }
  const registry = {};
  class AudioWorkletProcessorStub {
    constructor() { this.port = { postMessage() {}, onmessage: null }; }
  }
  procFactory(rate, AudioWorkletProcessorStub, (name, cls) => { registry[name] = cls; });
  const P = registry['remaster-processor'];
  if (!P) throw new Error('remaster-processor was not registered');
  procCache.set(rate, P);
  return P;
}

let dspCache = null;

/** Load the shared DSP utilities exactly as the browser loads them. */
function loadDsp() {
  if (dspCache) return dspCache;
  dspCache = require(path.join(ROOT, 'assets', 'js', 'dsp-utils.js'));
  return dspCache;
}

const DEFAULT_PARAMS = {
  power: 1, bypass: 0, sub: 0, subRatio: 0.5, exciter: 0, air: 0, dehiss: 0,
  declip: 0, declipLevel: -0.1, declick: 0, reso: 0, glue: 0, warmth: 0, tilt: 0,
  band0: 0, band1: 0, band2: 0, band3: 0, band4: 0, band5: 0,
  noiseFloor: -70, autoLevel: 1,
  // the per-song stages (see remaster-processor.js): a high-pass corner, the
  // sibilance control, the mono-maker, the glue timing, the de-hisser split and
  // the twelve bands of the corrective EQ
  infraHP: 0, deess: 0, bassMono: 0, glueTime: 0.5, hissF: 3200, tpCeil: 0,
  eq0: 0, eq1: 0, eq2: 0, eq3: 0, eq4: 0, eq5: 0,
  eq6: 0, eq7: 0, eq8: 0, eq9: 0, eq10: 0, eq11: 0,
};

/**
 * Render `input` through the worklet in 128-frame quanta, and report the
 * latency the processor declares for those parameters (in samples). A stage
 * with look-ahead (the de-clicker) delays the output while it is engaged, so a
 * caller that intends to measure what the chain *changed* has to shift the dry
 * side by `latency` first.
 * @param {object} Processor  class returned by loadProcessor()
 * @param {Float32Array[]} input
 * @param {object} params     flat parameter map
 * @returns {{out: Float32Array[], latency: number}}
 */
function renderEx(Processor, input, params, blockSize) {
  const bs = blockSize || 128;
  /* `input` is a *list* of channels. Handed a bare Float32Array — the shape
   * `U.enc(...)[0]` and `U.dec(...)` look like after an index — this function
   * used to map over the *samples*, allocating a full-length array per sample
   * and dying of an out-of-memory abort with no JS frame in the trace. It cost
   * half an hour once; it says so now. */
  if (typeof input[0] === 'number') throw new TypeError('renderEx: input must be an array of channels, got a bare sample array');
  const proc = new Processor({ processorOptions: { channels: input.length } });
  const frames = input[0].length;
  const out = input.map((c) => new Float32Array(frames));
  const arrays = {};
  const names = new Set(Object.keys(DEFAULT_PARAMS).concat(Object.keys(params)));
  for (const k of names) arrays[k] = Float32Array.from([params[k] !== undefined ? params[k] : DEFAULT_PARAMS[k]]);
  for (let pos = 0; pos < frames; pos += bs) {
    const n = Math.min(bs, frames - pos);
    const inBlocks = input.map((c) => c.subarray(pos, pos + n));
    const outBlocks = out.map((c) => c.subarray(pos, pos + n));
    proc.process([inBlocks], [outBlocks], arrays);
  }
  return { out, latency: proc.latency || 0 };
}

/** Render and return the output channels only. See renderEx for the latency. */
function render(Processor, input, params, blockSize) {
  return renderEx(Processor, input, params, blockSize).out;
}

/* ------------------------------------------------------------ signal makers */

function tone(freq, sr, seconds, amp) {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * freq * i / sr) * (amp === undefined ? 0.5 : amp);
  return out;
}

function mix(signals) {
  const n = Math.min(...signals.map((s) => s.length));
  const out = new Float32Array(n);
  for (const s of signals) for (let i = 0; i < n; i++) out[i] += s[i];
  return out;
}

function mul(sig, g) { const o = new Float32Array(sig.length); for (let i = 0; i < sig.length; i++) o[i] = sig[i] * g; return o; }

function noise(sr, seconds, amp, seed) {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  let s = seed || 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 4294967296) * 2 - 1) * amp;
  }
  return out;
}

function pink(sr, seconds, amp, seed) {
  // simple 1/f noise via cascaded one-poles (Paul Kellet's economy filter)
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  let s = seed || 999;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const white = (s / 4294967296) * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.0990460;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    out[i] = (b0 + b1 + b2 + white * 0.1848) * amp;
  }
  return out;
}

/** Apply a biquad (from RSDSP) to a whole array. */
function filter(RSDSP, sig, sr, type, freq, q) {
  const bq = new RSDSP.Biquad();
  if (type === 'lp') bq.setLowpass(sr, freq, q); else bq.setHighpass(sr, freq, q);
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = bq.process(sig[i]);
  return out;
}

/** xorshift32 — a proper RNG for impulse injection (LCG low bits are useless) */
function rng(seed) {
  let s = (seed || 88172645) >>> 0;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * A realistic "song" envelope: intro, phrases, a quiet breakdown, a real gap
 * (silence between songs — that is where the analyser gets to see the noise
 * floor) and an outro.
 */
function songEnvelope(sr, seconds, floor) {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  const base = floor === undefined ? 0.05 : floor;
  const gapStart = seconds * 0.56, gapEnd = gapStart + Math.min(1.4, seconds * 0.12);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const phrase = 0.66 + 0.34 * Math.sin(2 * Math.PI * t / 7.3);
    const breakdown = t > seconds * 0.34 && t < seconds * 0.34 + seconds * 0.07 ? 0.22 : 1;
    const gap = (t > gapStart && t < gapEnd) ? 0.012 : 1;
    const intro = Math.min(1, t / (seconds * 0.05));
    const outro = Math.min(1, (seconds - t) / (seconds * 0.07));
    out[i] = Math.max(0, (base + (1 - base) * phrase * breakdown * Math.min(intro, outro)) * gap);
  }
  return out;
}

/** Simulate a 1960s-70s one-mic garage recording: dull top, thin bass, hiss. */
function garageSim(RSDSP, sr, seconds) {
  const env = songEnvelope(sr, seconds, 0.05);
  let s = mul(pink(sr, seconds, 0.42, 7), 1);
  for (let i = 0; i < s.length; i++) s[i] *= env[i];
  s = filter(RSDSP, s, sr, 'lp', 4200, 0.707);
  s = filter(RSDSP, s, sr, 'lp', 5200, 0.707);          // rolled-off top end
  s = filter(RSDSP, s, sr, 'hp', 150, 0.707);           // no bottom end
  // honky room resonances around 320 Hz and 1.1 kHz
  const tone = (f, a) => {
    const t = tone_(f, sr, seconds, a);
    for (let i = 0; i < t.length; i++) t[i] *= env[i];
    return t;
  };
  s = mix([s, tone(320, 0.09), tone(1100, 0.05)]);
  s = mix([s, noise(sr, seconds, 0.0035, 42)]);         // tape/room hiss ≈ −49 dBFS
  s = mix([s, mul(tone_(50, sr, seconds, 0.02), 1)]);   // mains hum
  s = addCrackle(s, 2.5, 0.30, 5);
  return normalize(s, 0.72);
}

/** Cassette: narrow-ish band, strong steady hiss, gentle top-end roll-off. */
function cassetteSim(RSDSP, sr, seconds) {
  const env = songEnvelope(sr, seconds, 0.05);
  let s = mul(pink(sr, seconds, 0.42, 21), 1);
  for (let i = 0; i < s.length; i++) s[i] *= env[i];
  s = filter(RSDSP, s, sr, 'lp', 11000, 0.707);
  s = filter(RSDSP, s, sr, 'hp', 45, 0.707);
  s = mix([s, noise(sr, seconds, 0.0060, 43)]);         // loud tape hiss ≈ −44 dBFS
  s = addCrackle(s, 0.05, 0.08, 6);
  return normalize(s, 0.70);
}

/** Vinyl rip: rumble, hum, crackle, full but slightly soft top end. */
/**
 * The record that is most of a private archive: an old, crackly, slightly hissy
 * transfer that was later pushed through a 128 kbit/s encoder. Three problems at
 * once — crackle, hiss and a codec brick wall — which is exactly the case a
 * single profile cannot serve, because whichever one wins the vote, the
 * treatments the other two need are capped by it.
 *
 * The codec is modelled the way the other sims model it: the encoder's own
 * low-pass (three poles at 14.8 kHz) plus the tiny amount of noise it adds.
 * (Verified against a real lamejs 128 kbit/s round trip: brickwall 1.00 both.)
 */
function comboSim(RSDSP, sr, seconds) {
  const env = songEnvelope(sr, seconds, 0.05);
  let s = mul(pink(sr, seconds, 0.40, 81), 1);
  for (let i = 0; i < s.length; i++) s[i] *= env[i];
  s = filter(RSDSP, s, sr, 'lp', 17000, 0.707);          // the record
  s = filter(RSDSP, s, sr, 'hp', 28, 0.707);             // a turntable's bottom
  s = mix([s, mul(noise(sr, seconds, 1, 82), 0.0030)]);  // surface noise
  s = addCrackle(s, 10, 0.9, 83);
  s = mix([s, mul(noise(sr, seconds, 1, 84), 0.0050)]);  // transfer hiss
  s = filter(RSDSP, s, sr, 'lp', 14800, 0.60);           // the encoder it went through
  s = filter(RSDSP, s, sr, 'lp', 14800, 0.60);
  s = filter(RSDSP, s, sr, 'lp', 14800, 0.60);
  s = mix([s, mul(noise(sr, seconds, 1, 85), 0.00005)]);
  return normalize(s, 0.72);
}
function vinylSim(RSDSP, sr, seconds) {
  const env = songEnvelope(sr, seconds, 0.04);
  let s = mul(pink(sr, seconds, 0.40, 31), 1);
  for (let i = 0; i < s.length; i++) s[i] *= env[i];
  s = filter(RSDSP, s, sr, 'lp', 14000, 0.707);
  s = filter(RSDSP, s, sr, 'lp', 9000, 0.55);           // vinyl keeps little above 10 kHz
  s = filter(RSDSP, s, sr, 'hp', 30, 0.707);
  s = mix([s, mul(tone_(50, sr, seconds, 0.035), 1), mul(tone_(150, sr, seconds, 0.012), 1)]);
  s = mix([s, noise(sr, seconds, 0.0018, 44)]);         // surface noise
  s = addCrackle(s, 9, 0.85, 8);                        // crackle ≈ 9 events/s
  return normalize(s, 0.74);
}

/** Low-bitrate / muffled digital: hard band limit, no noise to speak of. */
function lowBitrateSim(RSDSP, sr, seconds) {
  const env = songEnvelope(sr, seconds, 0.25);
  let s = mul(pink(sr, seconds, 0.40, 51), 1);
  for (let i = 0; i < s.length; i++) s[i] *= env[i];
  s = filter(RSDSP, s, sr, 'lp', 11000, 0.55);
  // codec brick wall (like a 128 kbit/s MP3 low-pass at ≈15 kHz)
  s = filter(RSDSP, s, sr, 'lp', 14800, 0.60);
  s = filter(RSDSP, s, sr, 'lp', 14800, 0.60);
  s = filter(RSDSP, s, sr, 'lp', 14800, 0.60);
  s = mix([s, noise(sr, seconds, 0.00004, 45)]);
  return normalize(s, 0.68);
}

function tone_(freq, sr, seconds, amp) { return tone(freq, sr, seconds, amp); }

/** Sparse broadband impulses — vinyl crackle / digital drop-outs. */
function addCrackle(sig, perSecond, amp, seed) {
  const out = Float32Array.from(sig);
  const rand = rng(seed);
  const sr = 48000;
  const count = Math.round(perSecond * (sig.length / sr));
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rand() * (sig.length - 8));
    const sign = rand() < 0.5 ? -1 : 1;
    const a = amp * (0.4 + rand() * 1.6) * sign;
    // pops are 1–3 samples of broadband energy
    out[idx] += a;
    out[idx + 1] += a * 0.55;
    if (rand() < 0.4) out[idx + 2] += a * 0.25;
  }
  return out;
}

function normalize(sig, peak) {
  let mx = 0;
  for (let i = 0; i < sig.length; i++) mx = Math.max(mx, Math.abs(sig[i]));
  const g = (peak || 0.9) / (mx || 1);
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] * g;
  return out;
}

/* ------------------------------------------------------------- test helpers */

let passed = 0, failed = 0;
const failures = [];

function ok(cond, label, info) {
  if (cond) { passed++; console.log(`  \u2713 ${label}`); }
  else {
    failed++; failures.push(label);
    console.log(`  \u2717 ${label}${info !== undefined ? '  → ' + info : ''}`);
  }
}

function section(name) { console.log(`\n\u25B8 ${name}`); }

function peak(sig) {
  let p = 0;
  for (let i = 0; i < sig.length; i++) { const a = Math.abs(sig[i]); if (a > p) p = a; }
  return p;
}

function summarize() {
  console.log(`\n${'-'.repeat(60)}`);
  console.log(failed === 0
    ? `ALL TESTS PASSED (${passed})`
    : `${failed} FAILED / ${passed} passed`);
  if (failed) { console.log('failed: ' + failures.join(', ')); process.exitCode = 1; }
  return failed === 0;
}

module.exports = {
  renderEx,
  ROOT, loadProcessor, loadDsp, render, DEFAULT_PARAMS,
  tone, noise, pink, mix, mul, filter, rng, peak, songEnvelope, addCrackle, normalize,
  garageSim, cassetteSim, vinylSim, lowBitrateSim, comboSim,
  ok, section, summarize, stats: () => ({ passed, failed }),
};
