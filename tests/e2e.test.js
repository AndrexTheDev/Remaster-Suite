/* =============================================================================
 * Remaster Suite — extended end-to-end scenarios
 * -----------------------------------------------------------------------------
 * Realistic user journeys, driven through the actual application in a DOM with a
 * miniature Web Audio implementation:
 *
 *   · five problem recordings through auto-diagnosis and the full pipeline
 *   · the single slider from 0 % to 100 % on real material
 *   · hand-picked profiles overriding the automatic choice
 *   · a ten-file batch, processed sequentially, packed into one ZIP
 *   · mono, stereo, 32 kHz, 96 kHz
 *   · hostile input: silence, clipping, DC offset, 1-sample file, noise only
 *   · neural DSP: FIR lowpass before super-resolution, the memory tier, and
 *     DeepFilterNet3 on damaged MP3 material (real graphs when present)
 *
 * Run:  node tests/e2e.test.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const H = require('./harness.js');
const stub = require('./webaudio-stub.js');

const ROOT = H.ROOT;
const DSP = H.loadDsp();
const Presets = require(path.join(ROOT, 'assets', 'js', 'presets.js'));

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label + (detail ? '  → ' + detail : '')); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label + '  → ' + (detail === undefined ? 'failed' : detail)); }
}
function section(name) { console.log('\n▸ ' + name); }
const num = (v, d) => (isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : '—');

/* ------------------------------------------------------------------- helpers */

const SR = 48000;

function boot() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => {
    const msg = String(err && err.message);
    if (/Not implemented: navigation|Could not parse CSS|getContext \(without installing the canvas/.test(msg)) return;
    throw err;
  });
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    url: 'https://remaster.local/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const win = dom.window;
  Object.defineProperty(win.navigator, 'language', { value: 'de', configurable: true });
  stub.install(win);
  win.URL.createObjectURL = () => 'blob:mock';
  win.URL.revokeObjectURL = () => {};
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  win.eval(fs.readFileSync(path.join(ROOT, 'assets/vendor/lame.min.js'), 'utf8'));
  for (const f of ['dsp-utils.js', 'presets.js', 'i18n.js', 'library-loader.js', 'codecs.js', 'analyzer.js', 'ring-buffer.js', 'neural-dsp.js', 'engine.js', 'ui.js', 'app.js']) {
    win.eval(fs.readFileSync(path.join(ROOT, 'assets/js', f), 'utf8'));
  }
  return win;
}

/** A WAV file object the app can decode, built from channel arrays. */
function wavFile(win, channels, sr, name, bits) {
  const ab = DSP.encodeWav(channels, sr, bits || 16);
  return new win.File([new Uint8Array(ab)], name, { type: 'audio/wav' });
}

function bandOf(channels, f1, f2, sr) {
  const spec = DSP.spectrum(channels, sr || SR, { fftSize: 8192, maxFrames: 120 });
  return DSP.bandMedian(spec, f1, f2);
}

function peakOf(channels) {
  let p = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; }
  return p;
}

function finite(channels) {
  for (const c of channels) for (let i = 0; i < c.length; i++) if (!isFinite(c[i])) return false;
  return true;
}

/** Read back what a card produced (byte arrays travel betweeen realms). */
async function bytesOf(win, result) {
  return result && result.bytes ? result.bytes : null;
}

/* ══════════════════════════════════════════════════════════════════ the suite ══ */

/* ───────────────────────────────────────────────── neural DSP regression ── */

const NEURAL = path.join(ROOT, 'assets', 'js', 'neural-dsp.js');
const NeuralDsp = require(NEURAL);
const NEURAL_WORKER = path.join(ROOT, 'assets', 'js', 'neural-worker.js');
const MODEL_DIR = path.join(ROOT, 'assets', 'vendor', 'models');
const DFN_FILES = ['dfn3-enc.onnx', 'dfn3-erb-dec.onnx', 'dfn3-df-dec.onnx'];

/** Deterministic white noise in [-amp, amp). */
function lcgNoise(n, amp, seed) {
  const out = new Float32Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = amp * ((s / 4294967296) * 2 - 1);
  }
  return out;
}

/** Formant-synthesised voice: pulse train at 120 Hz, three resonators, syllable envelope. */
function voiceLike(sr, seconds, seed) {
  const L = Math.round(sr * seconds);
  const out = new Float32Array(L);
  const noise = lcgNoise(L, 1, seed);
  const formants = [[700, 110], [1220, 120], [2600, 160]].map(([f, bw]) => {
    const r = Math.exp((-Math.PI * bw) / sr), th = (2 * Math.PI * f) / sr;
    return { a1: -2 * r * Math.cos(th), a2: r * r, g: 1 - r, y1: 0, y2: 0 };
  });
  let phase = 0;
  for (let i = 0; i < L; i++) {
    const t = i / sr;
    const env = Math.pow(Math.max(0, Math.sin(Math.PI * 4 * t)), 2);
    phase += 120 / sr;
    let y = 0;
    if (phase >= 1) { phase -= 1; y = 1; }
    y = y * env + 0.003 * noise[i] * env;
    for (const q of formants) {
      const v = q.g * y - q.a1 * q.y1 - q.a2 * q.y2;
      q.y2 = q.y1; q.y1 = v; y = v;
    }
    out[i] = y;
  }
  let pk = 0;
  for (let i = 0; i < L; i++) pk = Math.max(pk, Math.abs(out[i]));
  for (let i = 0; i < L; i++) out[i] = (out[i] * 0.5) / (pk || 1);
  return out;
}

/** Damaged-MP3 stand-in: voice-like programme behind a 128k-style brick wall at
 *  14.8 kHz. Returns { x, cutHz } with the cut measured by detectMp3Brickwall. */
function damagedMp3(DSPmod, sr, seconds, seed) {
  const L = Math.round(sr * seconds);
  const env = new Float32Array(L);
  for (let i = 0; i < L; i++) env[i] = 0.55 + 0.45 * Math.sin((2 * Math.PI * 1.7 * i) / sr);
  const base = voiceLike(sr, seconds, seed);
  const x = new Float32Array(L);
  for (let i = 0; i < L; i++) x[i] = 0.6 * base[i] * env[i];
  // programme material right up to the cut (a detector needs energy below the edge),
  // then the codec's brick wall: a steep linear-phase cut at 14.8 kHz, nothing above it
  const floor = lcgNoise(L, 0.01, seed + 7);
  const out = applyFirSafe(Float32Array.from(x, (v, i) => v + floor[i]), sr, 14800);
  // the spectrum of a damaged file is measured on the material itself
  const spec = DSPmod.spectrum([out], sr, { fftSize: 8192, maxFrames: 120 });
  const m = DSPmod.detectMp3Brickwall(spec);
  return { x: out, cutHz: m.detected ? m.hz : 0 };
}

function applyFirSafe(x, sr, fc) {
  return NeuralDsp.applyFir(x, NeuralDsp.linearPhaseLowpass(fc, sr, 255));
}

function biquadLp(x, sr, f, q) {
  const w = (2 * Math.PI * f) / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const b0 = (1 - c) / 2, b1 = 1 - c, b2 = (1 - c) / 2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  return biquad(x, b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
}
function biquadHp(x, sr, f, q) {
  const w = (2 * Math.PI * f) / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const b0 = (1 + c) / 2, b1 = -(1 + c), b2 = (1 + c) / 2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  return biquad(x, b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
}
function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** |H(f)| in dB of a tap set, by direct evaluation. */
function firDb(h, sr, f) {
  let re = 0, im = 0;
  for (let n = 0; n < h.length; n++) {
    const w = (-2 * Math.PI * f * n) / sr;
    re += h[n] * Math.cos(w); im += h[n] * Math.sin(w);
  }
  return 20 * Math.log10(Math.hypot(re, im) + 1e-30);
}

/** Energy (dB) of a signal inside [f1, f2], from a Hann-windowed FFT average. */
function bandDb(DSPmod, x, sr, f1, f2) {
  const spec = DSPmod.spectrum([x], sr, { fftSize: 4096, maxFrames: 200 });
  let p = 0, n = 0;
  for (let k = 0; k < spec.n; k++) {
    const f = spec.freq[k];
    if (f >= f1 && f < f2) { p += Math.pow(10, spec.db[k] / 10); n++; }
  }
  return n ? 10 * Math.log10(p / n + 1e-30) : -300;
}

/** Peak lag (samples) of y against x inside [−maxLag, maxLag]. */
function lagBetween(y, x, maxLag, from, to) {
  let best = -Infinity, bl = 0;
  for (let L = -maxLag; L <= maxLag; L++) {
    let s = 0;
    for (let i = from; i < to; i++) s += y[i + L] * x[i];
    if (s > best) { best = s; bl = L; }
  }
  return bl;
}

/** Load the ML worker into a Node VM with the real graphs and a shim ORT. */
function makeWorkerContext(ort) {
  const vm = require('vm');
  const msgs = [];
  const ctx = {
    console, setTimeout, clearTimeout, performance, Math, JSON, Promise, Error,
    navigator: { userAgent: 'node-harness' },
    crossOriginIsolated: true,
    fetch: async (url) => {
      const m = String(url).match(/vendor\/models\/([^/?#]+)$/);
      if (!m || !fs.existsSync(path.join(MODEL_DIR, m[1]))) return { ok: false, status: 404 };
      const b = fs.readFileSync(path.join(MODEL_DIR, m[1]));
      return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
    },
    ort: {
      env: { wasm: {} },
      // the worker's arrays belong to the VM realm; onnxruntime checks instanceof
      // against this realm, so the data is copied across before it reaches ORT
      Tensor: function Tensor(type, data, dims) { return new ort.Tensor(type, Float32Array.from(data), dims); },
      InferenceSession: {
        create: async (bytes) => ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['cpu'] }),
      },
    },
  };
  ctx.self = ctx;
  ctx.postMessage = (m) => msgs.push(m);
  ctx.importScripts = (name) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', name), 'utf8'), ctx, { filename: name });
  vm.createContext(ctx);
  ctx.importScripts('ring-buffer.js');
  ctx.importScripts('library-loader.js');
  ctx.importScripts('neural-dsp.js');
  vm.runInContext(fs.readFileSync(NEURAL_WORKER, 'utf8'), ctx, { filename: 'neural-worker.js' });
  return { ctx, msgs };
}

async function waitFor(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = pred();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

/** Stream mono audio through the worker's rings and collect what comes back. */
async function runWorkerOverRings(ctx, msgs, signal, sr) {
  const hop = 1024;
  const input = ctx.RSRing.create({ capacity: 8192, channels: 1, sampleRate: sr });
  const output = ctx.RSRing.create({ capacity: 8192, channels: 1, sampleRate: sr, targetFill: hop, latencyCompensation: hop });
  ctx.onmessage({ data: { type: 'init', id: 1, inputSab: input.sab, outputSab: output.sab, hopSize: hop, passThrough: false } });
  ctx.onmessage({ data: { type: 'loadDfn3', id: 2 } });
  const loaded = await waitFor(() => msgs.find((m) => m.id === 2 && (m.type === 'loaded' || m.type === 'error')), 60000);
  if (!loaded || loaded.type !== 'loaded') return { loaded, out: null };
  ctx.onmessage({ data: { type: 'start' } });

  const latency = loaded.latency;
  const total = signal.length + latency;
  const feedTotal = total + 2 * hop;            // a partial last hop needs padding to be emitted
  const got = new Float32Array(total);
  let fed = 0, read = 0;
  const deadline = Date.now() + 120000;
  while (read < total && Date.now() < deadline) {
    if (fed < feedTotal) {
      const n = Math.min(512, feedTotal - fed, input.free());
      if (n > 0) {
        const chunk = new Float32Array(n);
        for (let i = 0; i < n; i++) chunk[i] = fed + i < signal.length ? signal[fed + i] : 0;
        input.write([chunk], n, 0);
        fed += n;
      }
    }
    const avail = Math.min(output.available(), total - read);
    if (avail > 0) {
      const dst = [new Float32Array(avail)];
      output.read(dst, avail, 0);
      got.set(dst[0], read);
      read += avail;
    } else {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  ctx.onmessage({ data: { type: 'stats', id: 3 } });
  const reply = await waitFor(() => msgs.find((m) => m.id === 3 && m.type === 'stats'), 5000);
  ctx.onmessage({ data: { type: 'stop' } });
  const stat = reply;
  const error = msgs.find((m) => m.type === 'error');
  return { loaded, out: got.subarray(latency, latency + signal.length), latency, stat, error };
}

async function neuralRegression(ort) {
  const Dsp = NeuralDsp;
  const modelsReady = DFN_FILES.every((f) => fs.existsSync(path.join(MODEL_DIR, f)));
  let ortReady = !!ort;
  if (!ort) { try { ort = require('onnxruntime-node'); ortReady = true; } catch (e) { ortReady = false; } }

  /* ─ FIR lowpass H_LP and the memory tier (pure, always run) ─ */
  section('neural · linear-phase FIR lowpass H_LP before super-resolution');
  {
    const SRv = 48000, fc = 14800;
    const h = Dsp.linearPhaseLowpass(fc, SRv, 255);
    const sym = h.every((v, i) => Math.abs(v - h[h.length - 1 - i]) < 1e-12);
    ok(sym && h.length === 255, 'taps are exactly symmetric (linear phase, group delay (N−1)/2 = 127 samples)');
    ok(Math.abs(firDb(h, SRv, 0)) < 1e-6, 'unity DC gain', firDb(h, SRv, 0).toFixed(6) + ' dB');
    const pass = Math.max(...[1000, 6000, 10000, 12500, 13500].map((f) => Math.abs(firDb(h, SRv, f))));
    ok(pass < 0.01, 'pass band flat to 0.01 dB below 13.5 kHz', pass.toFixed(4) + ' dB');
    const stop = Math.max(...[16000, 17000, 18000, 20000, 23000].map((f) => firDb(h, SRv, f)));
    ok(stop < -60, 'stop band ≥ 60 dB down from 16 kHz on', stop.toFixed(1) + ' dB');
    let threw = false;
    try { Dsp.linearPhaseLowpass(30000, SRv, 255); } catch (e) { threw = true; }
    ok(threw, 'an fc above Nyquist is refused, not silently clipped');
    threw = false;
    try { Dsp.linearPhaseLowpass(fc, SRv, 128); } catch (e) { threw = true; }
    ok(threw, 'an even tap count is refused (no integer group delay)');

    // a tone well inside the pass band comes out with no delay and no level change
    const tone = new Float32Array(48000);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / SRv);
    const y = Dsp.applyFir(tone, h);
    const lag = lagBetween(y, tone, 4, 4000, 44000);
    ok(lag === 0, 'FIR output is delay-compensated (lag 0 samples)', 'lag ' + lag);
    let e1 = 0, e2 = 0;
    for (let i = 4000; i < 44000; i++) { e1 += tone[i] * tone[i]; e2 += y[i] * y[i]; }
    ok(Math.abs(10 * Math.log10(e2 / e1)) < 0.05, '1 kHz level is untouched by the lowpass', (10 * Math.log10(e2 / e1)).toFixed(3) + ' dB');
  }

  section('neural · memory guard: compact tier on mobile or below 420 MB heap');
  {
    ok(Dsp.chooseModelTier({ mobile: true, heapLimitMB: 4096, usedHeapMB: 100 }).tier === 'compact', 'mobile always gets the compact NovaSR tier');
    const low = Dsp.chooseModelTier({ mobile: false, heapLimitMB: 512, usedHeapMB: 200 });
    ok(low.tier === 'compact' && low.reason === 'heap', 'free heap below 420 MB switches to compact', low.availableHeapMB.toFixed(0) + ' MB free');
    const edge = Dsp.chooseModelTier({ mobile: false, heapLimitMB: 920, usedHeapMB: 500 });
    ok(edge.tier === 'full', 'exactly 420 MB free stays on the full model', edge.availableHeapMB.toFixed(0) + ' MB free');
    const big = Dsp.chooseModelTier({ mobile: false, heapLimitMB: 4096, usedHeapMB: 500 });
    ok(big.tier === 'full' && big.reason === 'default', 'a desktop with ample heap uses the full model');
    const unknown = Dsp.chooseModelTier({ mobile: false });
    ok(unknown.tier === 'full' && isNaN(unknown.availableHeapMB), 'an unreadable heap does not force the compact tier');
  }

  /* ─ FFT, ERB bank and the latency contract (pure, always run) ─ */
  section('neural · FFT, ERB bank and the stream latency contract');
  {
    const n = 960, re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9); im[i] = 0.1 * Math.sin(i * 0.05); }
    const f = Dsp.fft(re, im);
    let err = 0;
    for (let k = 0; k < n; k += 13) {
      let a = 0, b = 0;
      for (let t = 0; t < n; t++) {
        const ang = (-2 * Math.PI * k * t) / n;
        a += re[t] * Math.cos(ang) - im[t] * Math.sin(ang);
        b += re[t] * Math.sin(ang) + im[t] * Math.cos(ang);
      }
      err = Math.max(err, Math.abs(a - f.re[k]), Math.abs(b - f.im[k]));
    }
    ok(err < 1e-8, 'mixed-radix FFT (960 = 2⁶·3·5) matches the direct DFT', 'max error ' + err.toExponential(1));
    const bank = Dsp.erbFilterBank(48000, 960, 32, 2);
    ok(bank.length === 32 && bank.reduce((a, b) => a + b, 0) === 481 && bank.every((w) => w >= 2),
      'ERB bank: 32 bands covering all 481 bins, at least two bins each');
    ok(Dsp.normAlpha(48000, 480, 1) === 0.99, 'normalisation constant α = 0.99 (norm_tau 1 s, hop 10 ms)');
    ok(Dsp.DFN3.latency === (Dsp.DFN3.chunk + 2 + 3) * 480, 'declared latency is (chunk + look-ahead + 3) hops',
      Dsp.DFN3.latency + ' samples');

    // clean path (model says "clean speech", no mask): exact reconstruction, delayed by exactly the latency
    const clean = async (kind, feeds) => {
      if (kind !== 'enc') return { m: { data: new Float32Array(0), dims: [1, 1, 0, 32] }, coefs: { data: new Float32Array(0), dims: [1, 0, 96, 10] } };
      const S = feeds.feat_erb.dims[2];
      return { lsnr: { data: new Float32Array(S).fill(40), dims: [1, S, 1] }, emb: { data: new Float32Array(0), dims: [1, S, 512] }, e0: { data: new Float32Array(0), dims: [1, 64, S, 32] }, e1: { data: new Float32Array(0), dims: [1, 64, S, 16] }, e2: { data: new Float32Array(0), dims: [1, 64, S, 8] }, e3: { data: new Float32Array(0), dims: [1, 64, S, 8] }, c0: { data: new Float32Array(0), dims: [1, 64, S, 96] } };
    };
    const sig = lcgNoise(48000 * 3, 0.1, 99);
    const stream = new Dsp.Dfn3Stream(clean, {});
    const out = await stream.processSignal(sig, 512);
    let worst = 0;
    for (let i = 60000; i < 130000; i++) worst = Math.max(worst, Math.abs(out[i] - sig[i]));
    ok(worst < 1e-4, 'with no mask applied the STFT path is transparent', 'max error ' + worst.toExponential(1));
    const raw = new Dsp.Dfn3Stream(clean, {});
    // a noise floor above the silence gate, so the stream is not in digital silence
    const impulse = lcgNoise(120000, 0.001, 5); impulse[30000] += 0.5;
    const rawOut = []; for (let i = 0; i < impulse.length; i += 512) rawOut.push(await raw.process(impulse.subarray(i, Math.min(impulse.length, i + 512))));
    const flat = new Float32Array(impulse.length); let at = 0; for (const b of rawOut) { flat.set(b, at); at += b.length; }
    let pk = 0; for (let i = 0; i < flat.length; i++) if (Math.abs(flat[i]) > Math.abs(flat[pk])) pk = i;
    ok(pk - 30000 === Dsp.DFN3.latency, 'stream delay matches the declared latency, sample for sample', 'measured ' + (pk - 30000));
  }

  /* ─ DeepFilterNet3 on damaged MP3 material (needs the model files and onnxruntime-node) ─ */
  const skipReason = !modelsReady ? 'DeepFilterNet3 ONNX files not in assets/vendor/models/ (see its README)'
    : !ortReady ? 'onnxruntime-node is not installed (npm install)' : null;

  section('neural · DeepFilterNet3 on damaged MP3 material');
  if (skipReason) {
    console.log('  – skipped: ' + skipReason);
  } else {
    const runner = async (kind, feeds) => {
      const names = { enc: ['feat_erb', 'feat_spec'], erbDec: ['emb', 'e3', 'e2', 'e1', 'e0'], dfDec: ['emb', 'c0'] };
      const file = { enc: 'dfn3-enc.onnx', erbDec: 'dfn3-erb-dec.onnx', dfDec: 'dfn3-df-dec.onnx' }[kind];
      const sess = await loadSession(file);
      const f = {};
      for (const k of names[kind]) f[k] = new ort.Tensor('float32', feeds[k].data, feeds[k].dims);
      const out = await sess.run(f);
      const r = {};
      for (const k of Object.keys(out)) r[k] = { data: Float32Array.from(out[k].data), dims: out[k].dims.slice() };
      return r;
    };
    const sessions = {};
    async function loadSession(file) {
      if (!sessions[file]) sessions[file] = ort.InferenceSession.create(path.join(MODEL_DIR, file), { executionProviders: ['cpu'] });
      return sessions[file];
    }
    const DS = 48000;
    const dmg = damagedMp3(DSP, DS, 3, 17);
    ok(dmg.cutHz > 13500 && dmg.cutHz < 16000, 'the damaged file’s brick wall is measured near 14.8 kHz', (dmg.cutHz / 1000).toFixed(2) + ' kHz');
    const noisy = new Float32Array(dmg.x.length);
    const burst = lcgNoise(dmg.x.length, 0.02, 4);
    for (let i = 0; i < noisy.length; i++) noisy[i] = dmg.x[i] + (i > dmg.x.length * 0.4 && i < dmg.x.length * 0.6 ? burst[i] : 0);
    const streamDfn = new Dsp.Dfn3Stream(runner, {});
    const den = await streamDfn.processSignal(noisy, 512);
    // the burst is non-stationary: the denoiser should take a bite out of it
    const b0 = Math.round(dmg.x.length * 0.4) + 4800, b1 = Math.round(dmg.x.length * 0.6) - 4800;
    let eIn = 0, eOut = 0;
    for (let i = b0; i < b1; i++) { eIn += (noisy[i] - dmg.x[i]) ** 2; eOut += (den[i] - dmg.x[i]) ** 2; }
    ok(eOut < eIn, 'the denoiser reduces the non-stationary burst', (10 * Math.log10(eOut / eIn)).toFixed(1) + ' dB vs the noisy input');
    ok(den.every((v) => Number.isFinite(v)), 'DeepFilterNet3 output is finite everywhere');
    let peak = 0; for (let i = 0; i < den.length; i++) peak = Math.max(peak, Math.abs(den[i]));
    ok(peak <= 1.0, 'output stays inside full scale (no clipping, no noise bomb)', 'peak ' + peak.toFixed(3));
    const hfIn = bandDb(DSP, noisy, DS, dmg.cutHz + 1500, 23000);
    const hfOut = bandDb(DSP, den, DS, dmg.cutHz + 1500, 23000);
    ok(hfOut <= Math.max(hfIn + 3, -70), 'the denoiser adds nothing above the codec cut (no HF artefacts)',
      'in ' + hfIn.toFixed(1) + ' → out ' + hfOut.toFixed(1) + ' dB');
    const sil = new Float32Array(DS * 2);
    const silOut = await new Dsp.Dfn3Stream(runner, {}).processSignal(sil, 512);
    let silPk = 0; for (let i = 0; i < silOut.length; i++) silPk = Math.max(silPk, Math.abs(silOut[i]));
    ok(silPk === 0, 'digital silence stays digital silence', 'peak ' + silPk);

    // voiced speech through the model keeps its level: the model does not gate it away
    const v = voiceLike(DS, 2, 21);
    const vOut = await new Dsp.Dfn3Stream(runner, {}).processSignal(v, 512);
    let e1 = 0, e2 = 0;
    for (let i = 24000; i < v.length - 24000; i++) { e1 += v[i] * v[i]; e2 += vOut[i] * vOut[i]; }
    ok(Math.sqrt(e2 / e1) > 0.6, 'clean voiced material keeps at least 60 % of its level', 'ratio ' + Math.sqrt(e2 / e1).toFixed(2));
  }

  section('neural · ML worker end to end, real graphs through the rings');
  if (skipReason) {
    console.log('  – skipped: ' + skipReason);
  } else {
    const { ctx, msgs } = makeWorkerContext(ort);
    const sig = voiceLike(48000, 2, 8);
    const res = await runWorkerOverRings(ctx, msgs, sig, 48000);
    ok(res.loaded && res.loaded.type === 'loaded', 'the worker loads the three DeepFilterNet3 graphs from assets/vendor/models/',
      res.loaded && res.loaded.type === 'error' ? res.loaded.message : 'ok');
    ok(!res.error, 'the worker runs without error while streaming', res.error ? res.error.message : 'clean');
    if (res.out) {
      ok(res.loaded.latency === Dsp.DFN3.latency + Dsp.DFN3.hop, 'the worker reports its full latency (stream + one frame of FIFO slack)', res.loaded.latency + ' samples');
      ok(['full', 'compact'].indexOf(res.loaded.tier) >= 0, 'the memory tier is reported with the load', res.loaded.tier);
      ok(res.out.every((v) => Number.isFinite(v)), 'worker output is finite');
      const lag = lagBetween(res.out, sig, 300, 30000, 60000);
      ok(Math.abs(lag) <= 2, 'worker output is aligned once the reported latency is removed', 'lag ' + lag);
      let e1 = 0, e2 = 0;
      for (let i = 30000; i < res.out.length - 30000; i++) { e1 += sig[i] * sig[i]; e2 += res.out[i] * res.out[i]; }
      ok(e2 > 0 && Math.sqrt(e2 / e1) > 0.5, 'worker output carries the program (not a muted path)', 'ratio ' + Math.sqrt(e2 / e1).toFixed(2));
      ok(res.stat && res.stat.denoiser === 'dfn3', 'worker stats report the DeepFilterNet3 path active');
    }
  }
}

async function run() {
  const win = boot();
  await new Promise((r) => setTimeout(r, 40));
  const App = win.RSApp;

  /* ------------------------------------------------------------------------ */
  section('scenario · five problem recordings, one automatic diagnosis each');
  const sims = {
    garage: H.garageSim(DSP, SR, 12),
    cassette: H.cassetteSim(DSP, SR, 12),
    vinyl: H.vinylSim(DSP, SR, 12),
    lowbitrate: H.lowBitrateSim(DSP, SR, 12),
    clean: (() => {
      const env = H.songEnvelope(SR, 12, 0.04);
      let s = H.mul(H.pink(SR, 12, 0.35, 77), 1);
      for (let i = 0; i < s.length; i++) s[i] *= env[i];
      s = H.filter(DSP, s, SR, 'lp', 17000, 0.707);
      s = H.mix([s, H.noise(SR, 12, 0.0006, 78)]);
      return H.normalize(s, 0.8);
    })(),
  };
  const expectations = { garage: 'garage', cassette: 'cassette', vinyl: 'vinyl', lowbitrate: 'lowbitrate', clean: 'general' };

  for (const [key, sim] of Object.entries(sims)) {
    const file = wavFile(win, [sim, sim], SR, key + '.wav');
    await App.addFiles([file]);
    const card = App.State.cards[App.State.cards.length - 1];
    const detected = card.analysis ? card.analysis.preset : '?';
    ok(!!card.analysis && detected === expectations[key], 'auto-diagnosis: ' + key, detected + ' (' + num(card.analysis.score, 0) + '/100)');
    const sentence = card.el.diagnosis.textContent;
    ok(sentence.length > 30 && sentence.indexOf('{') === -1, '  …with a readable sentence', sentence.slice(0, 52) + '…');
    ok(card.after && card.after.chips && card.afterScore >= card.analysis.score - 5,
      '  …and a preview that does not make it worse', num(card.analysis.score, 0) + ' → ' + num(card.afterScore, 0));
    const res = await App.renderCard(card, { force: true });
    const decoded = DSP.decodeWav((await bytesOf(win, res)).buffer);
    ok(finite(decoded.channels) && peakOf(decoded.channels) <= 1, '  …and a full render inside full scale',
      'peak ' + num(peakOf(decoded.channels), 4));
    ok(decoded.channels[0].length === sim.length, '  …at exactly the same length',
      decoded.channels[0].length + ' samples');
  }

  section('scenario · what the restoration actually does to each problem');
  {
    const card = (name) => App.State.cards.find((c) => c.name === name + '.wav');

    const g = card('garage');
    let res = await App.renderCard(g, { force: true });
    let out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    const hf = [bandOf([sims.garage], 9000, 15000), bandOf(out, 9000, 15000)];
    ok(hf[1] > hf[0] + 4, 'garage: the missing top end comes back', num(hf[0]) + ' → ' + num(hf[1]) + ' dB');
    // Below the mains hum: the sub octave is built in the same 30–60 Hz region
    // the 50 Hz hum lives in, so the band is read *under* it and the hum itself is
    // checked separately, with the same detector the app uses to decide whether to
    // notch at all. (Measuring 32–58 Hz would add the two opposite repairs
    // together — a restored sub octave and a removed hum — and call it bass.)
    const lf = [bandOf([sims.garage], 25, 40), bandOf(out, 25, 40)];
    ok(lf[1] > lf[0] + 2, 'garage: deep bass is synthesised', num(lf[0]) + ' → ' + num(lf[1]) + ' dB');
    const humBefore = DSP.measure([sims.garage], SR).hum50;
    const humAfter = DSP.measure(out, SR).hum50;
    ok(humAfter < humBefore - 3, 'garage: the 50 Hz mains hum is removed',
      num(humBefore) + ' → ' + num(humAfter) + ' dB above its own neighbourhood');
    const box = [bandOf([sims.garage], 300, 360), bandOf(out, 300, 360)];
    ok(box[1] < box[0] + 1, 'garage: the boxy 320 Hz resonance is not amplified', num(box[0]) + ' → ' + num(box[1]) + ' dB');

    const v = card('vinyl');
    res = await App.renderCard(v, { force: true });
    out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    const na = DSP.noiseAnalysis([sims.vinyl], SR);
    const nb = DSP.noiseAnalysis(out, SR);
    const snrBefore = na.musicDb - na.floorDb, snrAfter = nb.musicDb - nb.floorDb;
    ok(snrAfter > snrBefore - 1, 'vinyl: the music-to-noise distance is not made worse',
      num(snrBefore) + ' → ' + num(snrAfter) + ' dB');
    const crest = [DSP.crackleDetect([sims.vinyl], SR).crestP98Db, DSP.crackleDetect(out, SR).crestP98Db];
    ok(crest[1] < crest[0] - 1, 'vinyl: crackle spikes are measurably tamed',
      num(crest[0]) + ' → ' + num(crest[1]) + ' dB crest');

    const c = card('cassette');
    res = await App.renderCard(c, { force: true });
    out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    const hiss = [bandOf([sims.cassette], 12000, 16000) - bandOf([sims.cassette], 1000, 3000),
      bandOf(out, 12000, 16000) - bandOf(out, 1000, 3000)];
    ok(hiss[1] > hiss[0] - 1, 'cassette: the top end is not opened up into pure hiss',
      num(hiss[0]) + ' → ' + num(hiss[1]) + ' dB relative');

    const l = card('lowbitrate');
    res = await App.renderCard(l, { force: true });
    out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    const air = [bandOf([sims.lowbitrate], 14000, 17000), bandOf(out, 14000, 17000)];
    ok(air[1] > air[0] + 6, 'low bitrate: content above the codec cliff is rebuilt',
      num(air[0]) + ' → ' + num(air[1]) + ' dB');

    const clean = card('clean');
    res = await App.renderCard(clean, { force: true });
    out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    let inSq = 0, outSq = 0, diffSq = 0;
    for (let i = 0; i < out[0].length; i++) {
      inSq += sims.clean[i] ** 2;
      outSq += out[0][i] ** 2;
      diffSq += (out[0][i] - sims.clean[i]) ** 2;
    }
    const levelDb = 10 * Math.log10(outSq / inSq);
    const changeDb = 10 * Math.log10(diffSq / inSq);
    ok(Math.abs(levelDb) < 4, 'clean file: the level is preserved', num(levelDb) + ' dB');
    const body = [bandOf([sims.clean], 300, 3000), bandOf(out, 300, 3000)];
    ok(Math.abs(body[1] - body[0]) < 3, 'clean file: the body of the music is left alone',
      num(body[0]) + ' → ' + num(body[1]) + ' dB');
    ok(changeDb < 6, 'clean file: the processing stays in proportion',
      num(changeDb) + ' dB difference energy');
    const hfClean = [bandOf([sims.clean], 9000, 15000), bandOf(out, 9000, 15000)];
    ok(hfClean[1] < hfClean[0] + 6, 'clean file: the top end is not overstated',
      num(hfClean[0]) + ' → ' + num(hfClean[1]) + ' dB');
  }

  section('scenario · an over-compressed modern master is called out');
  {
    const env = H.songEnvelope(SR, 12, 0.02);
    let loud = H.mul(H.pink(SR, 12, 0.35, 88), 1);
    for (let i = 0; i < loud.length; i++) loud[i] *= 0.75 + 0.25 * env[i];   // narrow envelope
    loud = H.filter(DSP, loud, SR, 'hp', 35, 0.707);
    loud = H.filter(DSP, loud, SR, 'lp', 15000, 0.707);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.tanh(loud[i] * 6) * 0.9;    // hard limiting
    loud = H.normalize(loud, 0.9);
    const file = wavFile(win, [loud, loud], SR, 'loud-master.wav');
    await App.addFiles([file]);
    const card = App.State.cards[App.State.cards.length - 1];
    const issues = card.analysis.diag.issues;
    ok(card.analysis.metrics.dynamicRangeDb < 14, 'the squashed master measures as low in dynamics',
      num(card.analysis.metrics.dynamicRangeDb) + ' dB');
    ok(issues.indexOf('squashed') !== -1 || issues.indexOf('clipping') !== -1,
      '…and the diagnosis says so', issues.join(', '));
    const res = await App.renderCard(card, { force: true });
    const out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    ok(finite(out) && peakOf(out) <= 1, '…and it is still rendered cleanly', 'peak ' + num(peakOf(out), 4));
    ok(DSP.measure([out], SR).dynamicRangeDb >= card.analysis.metrics.dynamicRangeDb - 2,
      '…without squashing the dynamics further',
      num(card.analysis.metrics.dynamicRangeDb) + ' → ' + num(DSP.measure([out], SR).dynamicRangeDb) + ' dB');
    ok(App.P.params(card).warmth < 0.25, '…and without adding saturation to a limited master',
      'warmth ' + num(App.P.params(card).warmth, 3));
  }

  section('scenario · the single slider, from 0 % to 100 %');
  {
    const card = App.State.cards.find((c) => c.name === 'garage.wav');
    card.preset = 'garage';
    card.power = 0;
    let res = await App.renderCard(card, { force: true });
    let out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    let maxDiff = 0;
    for (let i = 0; i < out[0].length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[0][i] - sims.garage[i]));
    ok(maxDiff < 1e-4, '0 % is the original, sample for sample', 'largest difference ' + maxDiff.toExponential(1));

    const series = [];
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      card.power = p;
      res = await App.renderCard(card, { force: true });
      const dec = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
      // the sub octave is read below the mains line the notch has to take out
      series.push({ p, hf: bandOf(dec, 9000, 15000), sub: bandOf(dec, 32, 45), peak: peakOf(dec), finite: finite(dec) });
    }
    const rising = series.every((s, i) => i === 0 || s.hf >= series[i - 1].hf - 0.5);
    ok(rising, 'the top-end synthesis grows with the slider',
      series.map((s) => Math.round(s.hf)).join(' / ') + ' dB');
    ok(series[4].hf > series[3].hf && series[3].hf > series[2].hf, 'and it keeps growing at the top half');
    const subRising = series.every((s, i) => i === 0 || s.sub >= series[i - 1].sub - 0.5);
    ok(subRising, 'the sub-bass follows the slider too', series.map((s) => Math.round(s.sub)).join(' / ') + ' dB');
    ok(series.every((s) => s.finite && s.peak <= 1.0), 'every power setting stays inside full scale',
      'peaks ' + series.map((s) => s.peak.toFixed(3)).join(' / '));
  }

  section('scenario · manual profiles override the automatic choice');
  {
    const dull = App.State.cards.find((c) => c.name === 'garage.wav');
    const hissy = App.State.cards.find((c) => c.name === 'cassette.wav');
    dull.power = 0.7;
    hissy.power = 0.7;

    // on dull material, the profile decides how much top end is rebuilt
    const hf = {};
    for (const id of ['lowbitrate', 'general', 'vinyl']) {
      dull.preset = id;
      const res = await App.renderCard(dull, { force: true });
      const out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
      hf[id] = bandOf(out, 9000, 15000);
    }
    ok(hf.lowbitrate > hf.general + 6, 'the bitrate profile rebuilds far more top end than the general one',
      num(hf.lowbitrate) + ' dB vs ' + num(hf.general) + ' dB');
    ok(hf.lowbitrate > hf.vinyl + 6, 'the vinyl profile stays deliberately conservative',
      num(hf.vinyl) + ' dB vs ' + num(hf.lowbitrate) + ' dB');
    dull.preset = null;

    // repair amounts come from the profile — unless the measurement overrules them
    hissy.preset = 'vinyl';
    const byVinyl = App.P.params(hissy);
    hissy.preset = 'cassette';
    const byCassette = App.P.params(hissy);
    hissy.preset = 'general';
    const byGeneral = App.P.params(hissy);
    hissy.preset = null;
    ok(byVinyl.declick > byGeneral.declick + 0.2, 'the vinyl profile de-clicks far harder',
      num(byVinyl.declick, 2) + ' vs ' + num(byGeneral.declick, 2));
    ok(byCassette.dehiss > byGeneral.dehiss + 0.1, 'the cassette profile de-hisses far harder',
      num(byCassette.dehiss, 2) + ' vs ' + num(byGeneral.dehiss, 2));

    // every file names the problems that were actually built into it
    const expected = {
      'garage.wav': ['dullTop', 'crackle'],
      'cassette.wav': ['hiss'],
      'vinyl.wav': ['crackle'],
      'lowbitrate.wav': ['codec'],
      'clean.wav': ['healthy'],
    };
    const wrong = [];
    for (const [name, issues] of Object.entries(expected)) {
      const card2 = App.State.cards.find((c) => c.name === name);
      const found = card2.analysis.diag.issues;
      const hit = issues.every((i) => found.indexOf(i) !== -1);
      if (!hit) wrong.push(name + ' → ' + found.join(','));
    }
    ok(wrong.length === 0, 'every file names the problems that were built into it', wrong.join(' | ') || 'all five match');
  }

  section('scenario · mono, 32 kHz and 96 kHz sources');
  {
    const cases = [
      ['mono-32k.wav', [H.cassetteSim(DSP, 32000, 6)], 32000],
      ['stereo-96k.wav', [H.garageSim(DSP, 96000, 6), H.garageSim(DSP, 96000, 6)], 96000],
    ];
    for (const [name, channels, sr] of cases) {
      const file = wavFile(win, channels, sr, name);
      await App.addFiles([file]);
      const card = App.State.cards[App.State.cards.length - 1];
      ok(!!card.analysis && card.analysis.sampleRate === sr, name + ': analysed at its own rate',
        card.analysis ? card.analysis.sampleRate + ' Hz' : 'failed');
      const res = await App.renderCard(card, { force: true });
      const decoded = DSP.decodeWav((await bytesOf(win, res)).buffer);
      ok(decoded.sr === sr && decoded.channels.length === channels.length,
        name + ': exported at its own rate and channel count',
        decoded.sr + ' Hz, ' + decoded.channels.length + ' ch');
      ok(finite(decoded.channels) && peakOf(decoded.channels) <= 1, name + ': output is sane',
        'peak ' + num(peakOf(decoded.channels), 4));
      ok(Math.abs(decoded.channels[0].length - channels[0].length) <= 1, name + ': length preserved');
    }
  }

  section('scenario · hostile input, no crash, no noise bomb');
  {
    const silent = new Float32Array(SR * 2);
    const clipped = new Float32Array(SR * 2);
    for (let i = 0; i < clipped.length; i++) clipped[i] = Math.max(-1, Math.min(1, Math.sin(i * 0.02) * 3));
    const dc = new Float32Array(SR * 2).fill(0.4);
    const noiseOnly = H.noise(SR, 3, 0.2, 99);
    const oneSample = new Float32Array([0.5]);
    const cases = [
      ['silence.wav', [silent]],
      ['clipped.wav', [clipped]],
      ['dc-offset.wav', [dc, dc]],
      ['noise-only.wav', [noiseOnly, noiseOnly]],
      ['one-sample.wav', [oneSample]],
    ];
    for (const [name, channels] of cases) {
      const file = wavFile(win, channels, SR, name);
      await App.addFiles([file]);
      const card = App.State.cards[App.State.cards.length - 1];
      const analysed = !!card.analysis;
      ok(analysed, 'hostile input: ' + name + ' is analysed', card.status);
      if (!analysed) continue;
      let res = null;
      try { res = await App.renderCard(card, { force: true }); } catch (err) { res = null; }
      ok(!!res, '  …renders without throwing');
      if (!res) continue;
      const decoded = DSP.decodeWav((await bytesOf(win, res)).buffer);
      const peak = peakOf(decoded.channels);
      ok(finite(decoded.channels), '  …produces finite samples');
      ok(peak <= 1.0, '  …stays inside full scale', 'peak ' + num(peak, 4));
      if (name === 'silence.wav') ok(peak < 1e-6, '  …and silence stays silent', 'peak ' + peak.toExponential(1));
      if (name === 'one-sample.wav') ok(decoded.channels[0].length === 1, '  …one sample in, one sample out');
      if (name === 'dc-offset.wav') ok(peak < 0.9, '  …DC offset is not amplified into a loud thump',
        'peak ' + num(peak, 3));
    }
  }

  section('scenario · a ten-file batch, processed one after another');
  {
    App.clearAll();
    const files = [];
    for (let i = 0; i < 10; i++) {
      const sim = [H.garageSim, H.cassetteSim, H.vinylSim, H.lowBitRateSim || H.lowBitrateSim][i % 4](DSP, SR, 4);
      files.push(wavFile(win, [sim, sim], SR, 'batch-' + (i + 1) + '.wav'));
    }
    const t0 = Date.now();
    await App.addFiles(files);
    ok(App.State.cards.length === 10, 'ten cards created', App.State.cards.length + ' cards');
    ok(App.State.cards.every((c) => !!c.analysis), 'all ten analysed',
      ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    ok(App.State.cards.every((c) => c.buffer === null), 'no card keeps the full decode in memory');
    ok(App.State.cards.every((c) => c.previewBuffer && c.previewBuffer.duration <= 41), 'each card holds only a preview buffer');

    const memory = App.State.cards.reduce((n, c) => n + c.previewBuffer.length * 2 * 4, 0);
    ok(memory < 40e6, 'the whole batch lives in well under 40 MB of audio memory', (memory / 1e6).toFixed(1) + ' MB');

    // Process All
    App.State.power = 0.7;
    await App.processAll();
    ok(App.State.cards.every((c) => c.status === 'done' && c.result && c.result.bytes.length > 1000),
      'every file was rendered and encoded', App.State.cards[0].result.bytes.length + ' bytes each');
    ok(App.State.cards.every((c) => c.result.name.indexOf('.wav') !== -1), 'names carry the right extension');

    // ZIP
    const NodeJSZip = require(path.join(ROOT, 'assets/vendor/jszip.min.js'));
    win.RSLibs.jszip = async () => {
      function ZipShim() { this.real = new NodeJSZip(); }
      ZipShim.prototype.file = function (name, data, opts) {
        const bytes = data && typeof data.length === 'number' && data.buffer ? new Uint8Array(data) : data;
        return this.real.file(name, bytes, opts);
      };
      ZipShim.prototype.generateAsync = function (opts, cb) { return this.real.generateAsync(opts, cb); };
      return ZipShim;
    };
    let captured = null;
    const realDownload = win.RSCodecs.download;
    win.RSCodecs.download = (data, name) => { captured = { bytes: data, name }; return name; };
    await App.downloadZip();
    win.RSCodecs.download = realDownload;
    ok(!!captured && /\.zip$/.test(captured.name), 'a ZIP was produced', captured && captured.name);
    const zip = await NodeJSZip.loadAsync(captured.bytes);
    const audioEntry = Object.keys(zip.files).filter((n) => /\.wav$/.test(n));
    ok(audioEntry.length === 10, 'the ZIP holds all ten files', String(audioEntry.length));
    const readme = await zip.file('README.txt').async('string');
    ok((readme.match(/^  profile  :/gm) || []).length === 10, 'the readme documents all ten');
    ok(/79KsqtJJdhKFJ9woxnYgtf3nq7HxQveafWBCtC3mxWi8/.test(readme), 'the readme carries the tip addresses');

    const total = audioEntry.reduce((n, n2) => n + zip.files[n2]._data.uncompressedSize, 0);
    ok(total > 1e6, 'the archive really contains audio', (total / 1e6).toFixed(1) + ' MB');
  }

  section('scenario · MP3 batch export');
  {
    App.State.format = 'mp3';
    App.State.mp3Rate = 256;
    const card = App.State.cards[0];
    const res = await App.renderCard(card, { force: true });
    const mp3 = res.bytes;
    ok(/\.mp3$/.test(res.name) && mp3.length > 4000, 'MP3 produced', (mp3.length / 1024).toFixed(0) + ' KB');
    ok(mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0, 'the stream starts on a frame boundary',
      '0x' + mp3[0].toString(16) + mp3[1].toString(16));
    // walk the stream frame by frame, the way a decoder does
    const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const RATES = [44100, 48000, 32000];
    let off = 0, frames = 0, broken = 0, sizes = new Set();
    while (off + 4 < mp3.length) {
      if (mp3[off] !== 0xff || (mp3[off + 1] & 0xe0) !== 0xe0) { broken++; break; }
      const b2 = mp3[off + 2];
      const kbps = BITRATES[(b2 >> 4) & 0xf];
      const rateIdx = (b2 >> 2) & 0x3;
      if (!kbps || rateIdx === 3) { broken++; break; }
      const frameSize = Math.floor((144 * kbps * 1000) / RATES[rateIdx]) + ((b2 >> 1) & 1);
      sizes.add(frameSize);
      frames++;
      off += frameSize;
    }
    ok(frames > 20 && broken === 0, 'every frame starts where the previous one ended', frames + ' frames, ' + broken + ' breaks');
    ok(sizes.size <= 2, 'frame size is constant apart from padding', [...sizes].join(', ') + ' bytes');
    ok(mp3.length - off < 2100, 'the stream ends on a frame boundary', (mp3.length - off) + ' bytes left over');
    App.State.format = 'wav';
  }

  section('scenario · the interface keeps up');
  {
    const card = App.State.cards[0];
    card.el.power.value = '100';
    card.el.power.dispatchEvent(new win.Event('input'));
    ok(card.power === 1, 'per-file slider updates the card state');
    card.el.power.value = '30';
    card.el.power.dispatchEvent(new win.Event('input'));
    ok(Math.abs(card.power - 0.3) < 1e-9, '…and back down');

    card.el.preset.value = 'vinyl';
    card.el.preset.dispatchEvent(new win.Event('change'));
    ok(App.P.params(card).declick > 0.3, 'per-file profile change reaches the parameter map',
      'declick ' + num(App.P.params(card).declick, 2));

    win.document.querySelector('#abSwitch button[data-ab="original"]').click();
    ok(App.State.ab === 'original', 'A/B switch moves to the original');
    win.document.querySelector('#abSwitch button[data-ab="compare"]').click();
    ok(App.State.ab === 'compare', 'A/B switch can self-compare');
    win.document.querySelector('#abSwitch button[data-ab="restored"]').click();
    ok(App.State.ab === 'restored', 'A/B switch returns to the restoration');

    win.RSApp.removeCard(card);
    ok(App.State.cards.length === 9 && win.document.querySelectorAll('#fileList .card').length === 9,
      'a card can be removed from the list');
    win.document.querySelector('#btnClear').click();
    ok(App.State.cards.length === 0 && win.document.querySelectorAll('#fileList .card').length === 0,
      'the list can be cleared completely');
  }

  await neuralRegression();

  console.log('\n' + '-'.repeat(60));
  console.log(failed ? failed + ' FAILED / ' + passed + ' passed' : 'ALL TESTS PASSED (' + passed + ')');
  if (failures.length) console.log('failed: ' + failures.join(', '));
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error('\ne2e suite crashed:\n', err);
  process.exit(1);
});
