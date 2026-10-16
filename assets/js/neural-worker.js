/* ============================================================================= * Remaster Suite — offscreen ML worker
 * -----------------------------------------------------------------------------
 * The hybrid inference side chain runs *here*, never on the audio thread. The
 * AudioWorklet pours its 128-frame quanta into a lock-free ring buffer
 * (assets/js/ring-buffer.js, SharedArrayBuffer), this worker drains it in hops
 * of 512…2048 frames, runs the ONNX model on the block and pours the result
 * into the return ring. The worklet is never blocked, never waits, and the
 * ring reports the latency the side chain adds so the mixer can compensate.
 *
 * Inference is bound through onnxruntime-web (RSLibs.onnxRuntime): WebGPU is
 * the primary execution provider, with an automatic fallback to the WASM build
 * (multi-threaded SIMD where cross-origin isolation allows threads). Models
 * are loaded lazily through RSLibs.onnxModel — local first
 * (assets/vendor/models/), CDN fallback after.
 *
 * Protocol (structured-clone messages, all answers tagged with the request id):
 *
 *   main → worker
 *     { type: 'init', id, base, inputSab, outputSab, hopSize, passThrough }
 *     { type: 'loadModel', id, name, options }
 *     { type: 'loadDfn3', id, options }   (DeepFilterNet3 denoiser, 48 kHz)
 *     { type: 'start' }  { type: 'stop' }  { type: 'reset' }
 *     { type: 'stats', id }  { type: 'dispose' }
 *
 *   worker → main
 *     { type: 'ready', id, hopSize, capacity, channels, sampleRate }
 *     { type: 'loaded', id, name, provider, inputNames, outputNames }
 *     { type: 'loaded', id, name: 'dfn3', provider, tier, latency }
 *     { type: 'stats', id, framesIn, framesOut, pumps, inferences, busy }
 *     { type: 'disposed', id }
 *     { type: 'unavailable', id, name, reason }   (no runtime / no weights: not an error)
 *     { type: 'error', id?, message }
 *
 * DeepFilterNet3 (non-stationary noise removal) runs as a chunked, sequence-model
 * pipeline (assets/js/neural-dsp.js): three ONNX graphs — dfn3-enc, dfn3-erb-dec,
 * dfn3-df-dec — read from assets/vendor/models/. It adds `latency` samples; the
 * stream is primed so the ring still moves whole hops. The memory tier for the
 * super-resolution stage (compact on mobile or below 420 MB of free heap) is
 * decided here and reported with the load.
 *
 * Until a model is loaded the pump forwards blocks unchanged (`passThrough`,
 * the default), so the ring/latency machinery can be exercised end-to-end and
 * a missing model degrades to silence of the ML path, never to a crash.
 * ========================================================================== */
'use strict';

importScripts('ring-buffer.js');
importScripts('library-loader.js');
importScripts('neural-dsp.js');

const Ring = globalThis.RSRing;
const Libs = globalThis.RSLibs;
const Dsp = globalThis.RSNeural;

const DFN_MODELS = { enc: 'dfn3-enc', erbDec: 'dfn3-erb-dec', dfDec: 'dfn3-df-dec' };

const HOP_MIN = 512;
const HOP_MAX = 2048;

let inRing = null;
let outRing = null;
let session = null;
let ortRef = null;
let provider = 'none';
let hop = 1024;
let passThrough = true;
let running = false;
let busy = false;
let timer = 0;
let scratchIn = null;
let scratchOut = null;
let denoise = null;   // { streams, sessions, runner } once DeepFilterNet3 is loaded
let fifo = null;     // per channel: processed samples waiting for the ring (see dfnProcess)
let primeLen = 0;    // frame-rounding slack opening the FIFO (one 480-sample frame)
let tier = null;      // memory tier chosen at load time

const stats = { framesIn: 0, framesOut: 0, pumps: 0, inferences: 0, models: 0 };

/** Tensor → plain { data, dims }. WebGPU outputs may live on the GPU. */
async function readTensor(t) {
  const data = t.location === 'cpu' || !t.getData ? t.data : await t.getData();
  return { data: Float32Array.from(data), dims: t.dims.slice() };
}

const send = (msg) => { self.postMessage(msg); };
const fail = (id, err) => {
  send({ type: 'error', id: id, message: String((err && err.message) || err) });
};

/* A stage that cannot run in this environment (no onnxruntime, no weights) is
 * not an error: the worker says so once, and the page keeps the DSP chain. */
const unavailable = (id, name, err) => {
  send({ type: 'unavailable', id: id, name: name, reason: String((err && err.message) || err) });
};

function allocScratch() {
  scratchIn = [];
  scratchOut = [];
  for (let c = 0; c < inRing.channels; c++) {
    scratchIn.push(new Float32Array(hop));
    scratchOut.push(new Float32Array(hop));
  }
}

/* ------------------------------------------------------------------ setup */

function onInit(m) {
  if (!Ring.isSupported()) {
    fail(m.id, new Error('SharedArrayBuffer unavailable — the ML path needs cross-origin isolation'));
    return;
  }
  if (!m.inputSab || !m.outputSab) {
    fail(m.id, new Error('init: inputSab and outputSab are required'));
    return;
  }
  // URLs inside this worker resolve against the worker script, not the page —
  // the setup passes the page URL so RSLibs finds assets/vendor/… correctly.
  if (m.base) Libs.setBase(m.base);
  // the page's policy: the opt-in to third-party hosts (a worker has no storage),
  // the budget ceiling, and the load window the page watches (engine.initNeural)
  Libs.setOnline(!!m.online);
  if (m.budgetMax) Libs.setBudgetMax(m.budgetMax);
  if (m.budgetMs) Libs.setBudget(m.budgetMs);
  hop = Math.min(HOP_MAX, Math.max(HOP_MIN, m.hopSize | 0));
  passThrough = m.passThrough !== false;
  inRing = Ring.attach(m.inputSab);
  outRing = Ring.attach(m.outputSab);
  if (inRing.channels !== outRing.channels) {
    fail(m.id, new Error('init: ring buffers disagree on the channel count'));
    return;
  }
  if (inRing.sampleRate !== outRing.sampleRate) {
    fail(m.id, new Error('init: ring buffers disagree on the sample rate'));
    return;
  }
  allocScratch();
  send({
    type: 'ready', id: m.id, hopSize: hop,
    capacity: inRing.capacity, channels: inRing.channels, sampleRate: inRing.sampleRate,
  });
}

/**
 * Create the inference session: WebGPU first, WASM (multi-threaded SIMD where
 * the page is cross-origin isolated) as the automatic fallback. Which one won
 * is reported back — an honest `provider` field beats a hopeful one.
 */
async function openSession(bytes) {
  ortRef = await Libs.onnxRuntime();
  if (!ortRef) throw Object.assign(new Error('onnxruntime unavailable'), { code: 'UNAVAILABLE' });
  const env = ortRef.env && ortRef.env.wasm;
  if (env) {
    env.simd = true;
    const cores = (globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 4;
    env.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(cores, 8)) : 1;
  }
  try {
    const s = await ortRef.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
    provider = 'webgpu';
    return s;
  } catch (e) {
    const s = await ortRef.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    provider = 'wasm';
    return s;
  }
}

function releaseSessions(sessions) {
  for (const k of Object.keys(sessions || {})) {
    const s = sessions[k];
    if (s && typeof s.release === 'function') { try { s.release(); } catch (e) { /* best effort */ } }
  }
}

function makeStreams(runner) {
  const streams = [];
  for (let c = 0; c < inRing.channels; c++) streams.push(new Dsp.Dfn3Stream(runner, {}));
  return streams;
}

/**
 * DeepFilterNet3: three graphs, one stream per channel. The memory guard runs
 * before the models are opened, so the tier is known even if a load fails.
 */
async function onLoadDfn3(m) {
  const sessions = {};
  try {
    if (!inRing) throw new Error('loadDfn3: init must come first');
    if (inRing.sampleRate !== Dsp.DFN3.sr) {
      throw new Error('DeepFilterNet3 runs at ' + Dsp.DFN3.sr + ' Hz; the ring carries ' + inRing.sampleRate + ' Hz');
    }
    tier = Dsp.chooseModelTier(Dsp.readEnvironment(globalThis));

    // Acquisition: the runtime import and the three model files. This is the
    // part the page watches — a silent stall (a host that accepts the connection
    // and then stops) is cut by the page, one budget after the last message.
    // Progress is reported as the acquisition moves, so a slow but moving load
    // is never cut. Session creation below is CPU work and is not timed.
    send({ type: 'acquiring', id: m.id, name: 'dfn3', budgetMs: Libs.budget });
    Libs.setProgress((p) => send({ type: 'progress', id: m.id, name: 'dfn3', stage: p.stage }));
    const budget = Libs.newBudget();                  // one budget for the whole acquisition
    ortRef = await Libs.onnxRuntime();
    if (!ortRef) throw Object.assign(new Error('onnxruntime unavailable'), { code: 'UNAVAILABLE' });
    const bytes = {};
    for (const key of Object.keys(DFN_MODELS)) {
      bytes[key] = await Libs.onnxModel(DFN_MODELS[key], Object.assign({}, m.options, { budget: budget }));
    }
    Libs.setProgress(null);
    send({ type: 'acquired', id: m.id, name: 'dfn3' });

    for (const key of Object.keys(DFN_MODELS)) sessions[key] = await openSession(bytes[key]);
    const runner = async (kind, feeds) => {
      const feedMap = {};
      for (const k of Object.keys(feeds)) {
        feedMap[k] = new ortRef.Tensor('float32', feeds[k].data, feeds[k].dims);
      }
      const out = await sessions[kind].run(feedMap);
      const res = {};
      for (const k of Object.keys(out)) res[k] = await readTensor(out[k]);
      return res;
    };
    releaseSessions(denoise && denoise.sessions);
    denoise = { sessions: sessions, runner: runner, streams: makeStreams(runner) };
    // The stream returns whole 480-sample frames and its own `latency` is already
    // inside its output. The worker takes one hop per tick, so the FIFO is opened
    // with one frame of silence: it can then never run dry. The total delay the
    // worker adds is the stream latency plus that one frame.
    primeLen = Dsp.DFN3.hop;
    fifo = [];
    for (let c = 0; c < inRing.channels; c++) fifo.push(new Float32Array(primeLen));
    stats.models += Object.keys(sessions).length;
    send({
      type: 'loaded', id: m.id, name: 'dfn3', provider: provider,
      tier: tier.tier, latency: denoise.streams[0].latency + primeLen,
      inputNames: [], outputNames: [],
    });
  } catch (err) {
    Libs.setProgress(null);
    releaseSessions(sessions);               // a half-opened set is not kept
    if (Libs.isUnavailable(err)) unavailable(m.id, 'dfn3', err);
    else fail(m.id, err);
  }
}

async function onLoadModel(m) {
  try {
    if (!m.name) throw new Error('loadModel: name is required');
    const bytes = await Libs.onnxModel(m.name, m.options);
    const s = await openSession(bytes);
    if (session && typeof session.release === 'function') {
      try { session.release(); } catch (e) { /* best effort */ }
    }
    session = s;
    stats.models++;
    send({
      type: 'loaded', id: m.id, name: m.name, provider: provider,
      inputNames: s.inputNames || [], outputNames: s.outputNames || [],
    });
  } catch (err) {
    if (Libs.isUnavailable(err)) unavailable(m.id, m.name, err);
    else fail(m.id, err);
  }
}

/* -------------------------------------------------------------- inference */

/** One hop per channel through DeepFilterNet3; the stream owns the framing. */
async function dfnProcess() {
  for (let c = 0; c < scratchIn.length; c++) {
    const out = await denoise.streams[c].process(scratchIn[c]);
    const f = fifo[c];
    const grown = new Float32Array(f.length + out.length);
    grown.set(f, 0);
    grown.set(out, f.length);
    const take = Math.min(hop, grown.length);
    scratchOut[c].set(grown.subarray(0, take));
    if (take < hop) scratchOut[c].fill(0, take);
    fifo[c] = grown.subarray(take);
  }
  stats.inferences++;
}

/** One hop through the model, one channel at a time (shape [1, hop]). */
async function infer() {
  const inputName = (session.inputNames && session.inputNames[0]) || 'input';
  const outputName = (session.outputNames && session.outputNames[0]) || 'output';
  for (let c = 0; c < scratchIn.length; c++) {
    const tensor = new ortRef.Tensor('float32', scratchIn[c], [1, hop]);
    const feeds = {};
    feeds[inputName] = tensor;
    const out = await session.run(feeds);
    const data = (out[outputName] && out[outputName].data) || scratchIn[c];
    const n = Math.min(data.length, hop);
    for (let i = 0; i < n; i++) scratchOut[c][i] = data[i];
    // a model that returns fewer frames than it was given keeps the dry tail
    for (let i = n; i < hop; i++) scratchOut[c][i] = scratchIn[c][i];
    stats.inferences++;
  }
}

function dryCopy() {
  for (let c = 0; c < scratchIn.length; c++) {
    const s = scratchIn[c];
    const d = scratchOut[c];
    for (let i = 0; i < hop; i++) d[i] = s[i];
  }
}

function schedule() {
  if (!running) return;
  const ms = Math.max(2, Math.round((hop * 1000) / Math.max(1, (inRing && inRing.sampleRate) || 48000)));
  timer = setTimeout(tick, ms);
}

async function tick() {
  stats.pumps++;
  try {
    // drain every whole hop that is waiting, not one per timer tick: the timer
    // runs at roughly hop / sampleRate, so a one-hop tick falls behind the audio
    // clock by a few percent and the monitor's bridge underruns
    while (!busy && inRing && outRing && inRing.available() >= hop && outRing.free() >= hop) {
      busy = true;
      const got = inRing.read(scratchIn, hop);
      if (got === hop) {
        if (denoise) await dfnProcess();
        else if (session) await infer();
        else if (passThrough) dryCopy();
        else for (let c = 0; c < scratchOut.length; c++) scratchOut[c].fill(0);
        const w = outRing.write(scratchOut, hop);
        stats.framesOut += w;
      }
      stats.framesIn += got;
      busy = false;
    }
  } catch (err) {
    busy = false;
    fail(undefined, err);
  }
  schedule();
}

function onStart() {
  if (running) return;
  running = true;
  schedule();
}

function onStop() {
  running = false;
  if (timer) { clearTimeout(timer); timer = 0; }
}

function onReset() {
  onStop();
  if (inRing) inRing.reset();
  if (outRing) outRing.reset();
  if (denoise) denoise.streams = makeStreams(denoise.runner);
  stats.framesIn = 0;
  stats.framesOut = 0;
  stats.pumps = 0;
  stats.inferences = 0;
}

function onStats(m) {
  send({
    type: 'stats', id: m.id,
    framesIn: stats.framesIn, framesOut: stats.framesOut,
    pumps: stats.pumps, inferences: stats.inferences,
    provider: provider, busy: busy, running: running,
    denoiser: denoise ? 'dfn3' : 'none', tier: tier ? tier.tier : null,
    denoiseLatency: denoise ? denoise.streams[0].latency + primeLen : 0,
    inputFill: inRing ? inRing.available() : 0,
    outputFill: outRing ? outRing.available() : 0,
    inputLatency: inRing ? inRing.latencyFrames() : 0,
    outputLatency: outRing ? outRing.latencyFrames() : 0,
  });
}

function onDispose(m) {
  onStop();
  if (session && typeof session.release === 'function') {
    try { session.release(); } catch (e) { /* best effort */ }
  }
  session = null;
  if (denoise) releaseSessions(denoise.sessions);
  denoise = null;
  inRing = null;
  outRing = null;
  send({ type: 'disposed', id: m.id });
}

self.onmessage = function (ev) {
  const m = ev.data || {};
  switch (m.type) {
    case 'init': onInit(m); break;
    case 'loadModel': onLoadModel(m); break;
    case 'loadDfn3': onLoadDfn3(m); break;
    case 'start': onStart(); break;
    case 'stop': onStop(); break;
    case 'reset': onReset(); break;
    case 'stats': onStats(m); break;
    case 'dispose': onDispose(m); break;
    default: fail(m.id, new Error('unknown message: ' + String(m.type))); break;
  }
};
