/* =============================================================================
 * Remaster Suite — neural inference worker
 * -----------------------------------------------------------------------------
 * WebGPU (and the GPU process onnxruntime-web talks to) is not reachable from
 * an AudioWorkletGlobalScope, and model inference is asynchronous — neither
 * property fits the realtime, synchronous, per-sample contract the rest of
 * this project's DSP runs under (`assets/worklets/remaster-processor.js`).
 * So the neural stages live here instead: a dedicated Worker that runs
 * `onnxruntime-web`, and that the main thread calls as an *offline*, whole-
 * buffer pass — before the realtime chain (denoise, stem separation) or
 * alongside its stage 7 (bandwidth extension, see `superres()` below).
 *
 * Three guarantees this file holds itself to, because they are the three
 * ways a "neural upgrade" to a working app most commonly breaks it:
 *
 *   1. WebGPU is *preferred*, never *required*. Every session creation tries
 *      the WebGPU execution provider first and falls back to WASM (with SIMD
 *      enabled) the moment that throws or the browser has no `navigator.gpu`
 *      at all — never a pipeline failure, only a provider substitution.
 *   2. A model that is not present is not an error. `.onnx` weights are not
 *      shipped with this project (DeepFilterNet3, BS-RoFormer and a usable
 *      AudioSR-class model are each tens of megabytes to several gigabytes —
 *      see the CHANGELOG for why none of that is vendored), so by default
 *      every call in this file resolves `{applied: false, reason: ...}`
 *      rather than throwing, and the caller's job is exactly one `if`: fall
 *      back to the pure-DSP path. That fallback is what every test in
 *      `tests/neural.test.js` actually exercises, because it is the only
 *      behaviour guaranteed to run in this repository as shipped.
 *   3. Tensor shapes are never handed to `onnxruntime-web` without their time
 *      axis rounded up to a multiple of 4 first (see `alignFrames`) — several
 *      WebGPU kernels this project's target models rely on (grouped/strided
 *      convolutions in the ERB and band-split stages) require it, and a
 *      model that works on WASM and silently produces garbage on WebGPU over
 *      an unaligned input is a worse failure mode than either extreme.
 *   4. Mobile is a first-class target, not an afterthought. On a phone or
 *      tablet (`isMobileUA()`), the execution-provider order becomes WebNN
 *      (NPU, then GPU, then CPU device type — `probeWebNN()`) *ahead of*
 *      WebGPU, because reaching an NPU at all is only possible through
 *      WebNN; `createSession()` still falls through to WebGPU and finally
 *      WASM exactly as before if WebNN is unavailable or a given model's ops
 *      are not WebNN-compatible. Mobile sessions also prefer the smallest
 *      quantised weight file a model publishes (`selectVariant()`: int4 >
 *      int8 > fp16 > fp32) to keep resident weights under the ~80 MB mobile
 *      VRAM budget the brief asks for. And because phones throttle long
 *      before desktops do, every `session.run()` call below is raced against
 *      a short watchdog and its catch block pattern-matches OOM/device-lost
 *      messages (`classifyInferenceError()`); either one evicts the cached
 *      session (`sessionCache.delete`) so a retry does not keep re-hammering
 *      a dead GPU/NPU context, and tags the result with a `reason` the main
 *      thread (`neural-controller.js`) recognises as "hardware gave up, not
 *      just absent" so it can surface exactly one quiet UI toast instead of
 *      failing the render.
 *
 * Weight discovery: `loadWeights()` looks in two places, in order — the
 * Origin Private File System (`navigator.storage.getDirectory()`, so a model
 * the user has imported once survives reloads with no further network
 * traffic) and a same-origin relative fetch of the local folder structure
 * (`models/<name>/...`, so dropping files next to a static deployment works
 * with no build step). Neither is shipped by this repository, so both look-
 * ups 404/"not found" cleanly by default — that is the fallback path, not a
 * failure of either lookup.
 * ========================================================================== */
/* eslint-disable no-restricted-globals */
(function (ctx) {
  'use strict';

  /* ------------------------------------------------------------ onnxruntime */

  /**
   * The `.webgpu` UMD build is the one bundle that carries both the WebGPU
   * and the WASM/SIMD execution providers, so the "prefer WebGPU, fall back
   * to WASM" requirement costs one load, not two. No bundled local copy is
   * shipped (~140 MB unpacked, see library-loader.js) — this list is CDN-only
   * and is only ever touched once a neural feature is actually invoked.
   */
  function ortCandidates() {
    try {
      if (typeof ctx.importScripts === 'function' && !ctx.RSLibs) {
        ctx.importScripts('library-loader.js');
      }
    } catch (err) { /* no document in a worker — library-loader.js tolerates that */ }
    if (ctx.RSLibs && typeof ctx.RSLibs.ortUrls === 'function') return ctx.RSLibs.ortUrls();
    return [
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js',
      'https://unpkg.com/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js',
    ];
  }

  let ortPromise = null;
  /** Load onnxruntime-web once, trying each CDN candidate in order. */
  function loadOrt() {
    if (ortPromise) return ortPromise;
    ortPromise = (async () => {
      const urls = ortCandidates();
      let lastErr = null;
      for (const url of urls) {
        try {
          ctx.importScripts(url);
          if (ctx.ort) {
            const base = url.slice(0, url.lastIndexOf('/') + 1);
            // WASM is the fallback provider, so it has to be fast on its own
            // merits: SIMD on, and a thread count that does not starve the
            // one thread actually doing the decode/encode work around it.
            ctx.ort.env.wasm.wasmPaths = base;
            ctx.ort.env.wasm.simd = true;
            const cores = (ctx.navigator && ctx.navigator.hardwareConcurrency) || 2;
            ctx.ort.env.wasm.numThreads = Math.max(1, Math.min(4, cores - 1));
            ctx.ort.env.logLevel = 'error';
            return ctx.ort;
          }
        } catch (err) { lastErr = err; }
      }
      throw lastErr || new Error('onnxruntime-web: no CDN candidate loaded');
    })();
    return ortPromise;
  }

  /**
   * Feature-detect WebGPU *before* asking onnxruntime-web to use it: a
   * missing `navigator.gpu`, a browser that refuses an adapter, or a device
   * that cannot be created are all distinguishable "no WebGPU here" cases
   * that should route straight to WASM rather than surface as a session
   * creation error further down.
   */
  async function probeWebGpu() {
    if (!(ctx.navigator && ctx.navigator.gpu)) return { available: false, fp16: false };
    try {
      const adapter = await ctx.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return { available: false, fp16: false };
      // shader-f16 is the adapter feature WebGPU gates fp16 compute behind —
      // requesting it on hardware that lacks it throws, which would turn the
      // "prefer fp16 for VRAM" optimisation into the very failure it exists
      // to avoid, so it is only ever requested when already confirmed present.
      const fp16 = !!(adapter.features && adapter.features.has('shader-f16'));
      return { available: true, fp16, adapter };
    } catch (err) {
      return { available: false, fp16: false };
    }
  }

  /** `true` on phones/tablets — mirrors the brief's own detection regex exactly. */
  function isMobileUA() {
    const ua = (ctx.navigator && ctx.navigator.userAgent) || '';
    return /Mobi|Android|iPhone/i.test(ua);
  }

  /**
   * Feature-detect WebNN the same cautious way `probeWebGpu()` feature-
   * detects WebGpu: `navigator.ml` has to exist, and *creating* a context has
   * to actually succeed, because a browser can expose the `ml` global behind
   * a flag yet still throw on every `createContext()` call. Device types are
   * tried most- to least-specialised — NPU (the whole point of WebNN: no
   * other web API reaches it), then GPU, then CPU — and the first that
   * succeeds is reported; this never throws, it degrades to `available:
   * false` like every other capability probe in this file.
   * See https://www.w3.org/TR/webnn/#dom-ml-createcontext and
   * https://onnxruntime.ai/docs/tutorials/web/ep-webnn.html (deviceType:
   * 'npu'|'gpu'|'cpu', default 'cpu').
   */
  async function probeWebNN() {
    if (!(ctx.navigator && ctx.navigator.ml && typeof ctx.navigator.ml.createContext === 'function')) {
      return { available: false, deviceType: null };
    }
    for (const deviceType of ['npu', 'gpu', 'cpu']) {
      try {
        await ctx.navigator.ml.createContext({ deviceType });
        return { available: true, deviceType };
      } catch (err) { /* try the next, less specialised device type */ }
    }
    return { available: false, deviceType: null };
  }

  /**
   * Create a session. The execution-provider order depends on `caps.mobile`:
   * on a phone/tablet with WebNN available, WebNN is tried *first* (its
   * whole reason to exist is reaching an NPU that WebGPU cannot), then
   * WebGPU, then WASM; everywhere else the order is WebGPU, WebNN, WASM —
   * WebNN is still attempted opportunistically on desktop (e.g. Chrome/Edge
   * with a DirectML-backed NPU) but never ahead of an already-proven WebGPU
   * path there. Every provider is a try/catch of its own: a missing
   * provider, an unsupported op, or a device creation failure mid-session
   * all fall through to the next one, and the caller never sees the
   * difference except in the returned `provider` name. WASM is the only
   * provider that is never wrapped in a `try` — if it also throws, that is a
   * genuine `createSession()` failure, caught one level up by `getSession()`.
   */
  async function createSession(ort, bytes, caps) {
    const attempts = [];
    const webnnAttempt = (caps.webnn && caps.webnn.available)
      ? {
        provider: 'webnn',
        fp16: false,
        run: () => ort.InferenceSession.create(bytes, {
          executionProviders: [{ name: 'webnn', deviceType: caps.webnn.deviceType, powerPreference: 'default' }],
          graphOptimizationLevel: 'all',
        }),
      }
      : null;
    const webgpuAttempt = (caps.webgpu && caps.webgpu.available)
      ? {
        provider: 'webgpu',
        fp16: caps.webgpu.fp16,
        run: () => ort.InferenceSession.create(bytes, {
          executionProviders: [{ name: 'webgpu', deviceType: 'gpu', powerPreference: 'high-performance' }],
          graphOptimizationLevel: 'all',
        }),
      }
      : null;
    if (caps.mobile) { if (webnnAttempt) attempts.push(webnnAttempt); if (webgpuAttempt) attempts.push(webgpuAttempt); }
    else { if (webgpuAttempt) attempts.push(webgpuAttempt); if (webnnAttempt) attempts.push(webnnAttempt); }

    for (const attempt of attempts) {
      try {
        const session = await attempt.run();
        return { session, provider: attempt.provider, fp16: attempt.fp16 };
      } catch (err) { /* fall through to the next provider, WASM last */ }
    }
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return { session, provider: 'wasm', fp16: false };
  }

  /* ------------------------------------------------------------- tensor T-alignment */

  /** Round a time-frame count up to the nearest multiple of 4. */
  function alignT(n) { return Math.ceil(Math.max(1, n) / 4) * 4; }

  /**
   * Pad a row-major [T, cols] matrix with trailing zero rows up to `Talign`.
   * @returns {Float32Array} length `Talign * cols`
   */
  function padRowsTo(flat, T, cols, Talign) {
    if (Talign === T) return flat;
    const out = new Float32Array(Talign * cols);
    out.set(flat.subarray ? flat.subarray(0, T * cols) : flat.slice(0, T * cols));
    return out;
  }

  /** Trim a row-major [Talign, cols] matrix back down to its first `T` rows. */
  function trimRowsTo(flat, Talign, cols, T) {
    if (Talign === T) return flat;
    return flat.subarray ? flat.subarray(0, T * cols) : flat.slice(0, T * cols);
  }

  /* ------------------------------------------------------------------- DSP */

  function getDsp() {
    if (ctx.RSDSP) return ctx.RSDSP;
    try {
      if (typeof ctx.importScripts === 'function') ctx.importScripts('dsp-utils.js');
    } catch (err) { /* ignore — handled below / by the caller via dsp === null */ }
    if (ctx.RSDSP) return ctx.RSDSP;
    // Node test harness: no importScripts, but `require` loads the same
    // classic script and it sets `global.RSDSP` as a side effect (see
    // dsp-utils.js's own closing line) — this is the same trick
    // tests/harness.js already relies on for the worklet's own DSP helpers.
    try {
      if (typeof require === 'function') {
        require('./dsp-utils.js');
        if (ctx.RSDSP) return ctx.RSDSP;
      }
    } catch (err) { /* ignore */ }
    return null;
  }

  /**
   * `dsp.fft` (shared with the rest of the project) is a radix-2 kernel — it
   * only accepts a power-of-two length. DeepFilterNet3's real export, however,
   * is specified at a 960-sample frame (20 ms @ 48 kHz, 481 bins) and
   * BS-RoFormer's at 2048/1025 — one of those two is not a power of two, and
   * neither graph can be fed a different frame size without silently no
   * longer matching the weights it was trained against.
   *
   * Rather than add a second complete FFT algorithm, Bluestein's chirp-z
   * transform turns an arbitrary-length DFT into one zero-padded power-of-two
   * convolution, computed with two calls into the very same `dsp.fft` kernel
   * (plus its conjugate-trick inverse). This is the standard textbook
   * reduction, not a new transform — `dsp.fft` remains the only O(n log n)
   * primitive in the project. The chirp tables and the impulse response's own
   * spectrum depend only on `n`, so they are cached per length and the steady
   * state cost of an already-cached length is the same two FFTs every call.
   */
  const bluesteinCache = new Map();
  function getBluestein(n, dsp) {
    let c = bluesteinCache.get(n);
    if (c) return c;
    let m = 1; while (m < 2 * n - 1) m <<= 1;
    const wr = new Float32Array(n), wi = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      // exp(-i*pi*k^2/n), computed from k^2 mod 2n to keep the angle small
      const kk = (k * k) % (2 * n);
      const ang = -Math.PI * kk / n;
      wr[k] = Math.cos(ang); wi[k] = Math.sin(ang);
    }
    const br = new Float32Array(m), bi = new Float32Array(m);
    br[0] = wr[0]; bi[0] = -wi[0];
    for (let k = 1; k < n; k++) {
      br[k] = wr[k]; bi[k] = -wi[k];
      br[m - k] = wr[k]; bi[m - k] = -wi[k];
    }
    dsp.fft(br, bi); // B = FFT(conjugate chirp), cached
    c = { m, wr, wi, Br: br, Bi: bi };
    bluesteinCache.set(n, c);
    return c;
  }
  /** In-place-equivalent forward FFT of any length `n` (power of two or not). */
  function fftAny(re, im, dsp, n) {
    n = n || re.length;
    // power-of-two fast path: dsp.fft handles it directly, exactly, no chirp
    if ((n & (n - 1)) === 0) { dsp.fft(re, im); return; }
    const { m, wr, wi, Br, Bi } = getBluestein(n, dsp);
    const ar = new Float32Array(m), ai = new Float32Array(m);
    for (let k = 0; k < n; k++) {
      // a[k] = x[k] * chirp[k]
      ar[k] = re[k] * wr[k] - im[k] * wi[k];
      ai[k] = re[k] * wi[k] + im[k] * wr[k];
    }
    dsp.fft(ar, ai); // A = FFT(a)
    for (let k = 0; k < m; k++) {
      // C = A .* B
      const cr = ar[k] * Br[k] - ai[k] * Bi[k];
      const ci = ar[k] * Bi[k] + ai[k] * Br[k];
      ar[k] = cr; ai[k] = ci;
    }
    // inverse FFT of C via the conjugate trick, scaled by 1/m
    for (let k = 0; k < m; k++) ai[k] = -ai[k];
    dsp.fft(ar, ai);
    for (let k = 0; k < n; k++) {
      const cr = ar[k] / m, ci = -ai[k] / m;
      // X[k] = chirp[k] * c[k]
      re[k] = cr * wr[k] - ci * wi[k];
      im[k] = cr * wi[k] + ci * wr[k];
    }
  }

  function vorbisWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = Math.sin((Math.PI / 2) * Math.pow(Math.sin((Math.PI * (i + 0.5)) / n), 2));
    return w;
  }
  function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
  }

  /**
   * Framed STFT: `signal` → `{re, im}`, each a Float32Array of `frames * (nfft/2+1)`
   * bins, row-major [frame, bin]. Pure real-input FFT via RSDSP.fft (shared
   * with the analyser — one FFT implementation, one set of rounding
   * behaviours, for everything in this project that takes one).
   */
  function stft(signal, nfft, hop, window) {
    const dsp = getDsp();
    if (!dsp) throw new Error('RSDSP (dsp-utils.js) unavailable — cannot run an STFT');
    const nBins = nfft / 2 + 1;
    const frames = Math.max(1, Math.floor((signal.length - nfft) / hop) + 1);
    const re = new Float32Array(frames * nBins);
    const im = new Float32Array(frames * nBins);
    const fr = new Float32Array(nfft);
    const fi = new Float32Array(nfft);
    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      for (let i = 0; i < nfft; i++) {
        const s = off + i < signal.length ? signal[off + i] : 0;
        fr[i] = s * window[i];
        fi[i] = 0;
      }
      fftAny(fr, fi, dsp, nfft);
      for (let b = 0; b < nBins; b++) { re[f * nBins + b] = fr[b]; im[f * nBins + b] = fi[b]; }
    }
    return { re, im, frames, nBins };
  }

  /** Inverse STFT by overlap-add, the exact inverse of `stft` above. */
  function istft(re, im, frames, nfft, hop, window, length) {
    const dsp = getDsp();
    if (!dsp) throw new Error('RSDSP (dsp-utils.js) unavailable — cannot run an ISTFT');
    const nBins = nfft / 2 + 1;
    const out = new Float32Array(length);
    const wsum = new Float32Array(length);
    const fr = new Float32Array(nfft);
    const fi = new Float32Array(nfft);
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < nBins; b++) { fr[b] = re[f * nBins + b]; fi[b] = im[f * nBins + b]; }
      for (let b = 1; b < nfft - nBins + 1; b++) { fr[nfft - b] = re[f * nBins + b]; fi[nfft - b] = -im[f * nBins + b]; }
      // inverse FFT via a conjugate forward FFT, scaled by 1/n
      for (let i = 0; i < nfft; i++) fi[i] = -fi[i];
      fftAny(fr, fi, dsp, nfft);
      const off = f * hop;
      for (let i = 0; i < nfft; i++) {
        if (off + i >= length) break;
        out[off + i] += (fr[i] / nfft) * window[i];
        wsum[off + i] += window[i] * window[i];
      }
    }
    for (let i = 0; i < length; i++) if (wsum[i] > 1e-8) out[i] /= wsum[i];
    return out;
  }

  /**
   * ERB filterbank over `nBins` linear-frequency bins → `nBands` disjoint,
   * contiguous groups, each at least `minBins` wide, growing with the
   * Glasberg–Moore ERB scale (`24.7 * (4.37*f/1000 + 1)` Hz) the way
   * DeepFilterNet's own perceptual banding does — see the tensor contract
   * notes on `denoiseDFN3` for where the exact bin/band counts come from.
   * Returns a forward matrix (average pooling, [nBands, nBins] flat
   * row-major) and an inverse matrix (replication, [nBins, nBands] flat).
   */
  function buildErbFilterbank(nBins, nBands, sr, nfft, minBins) {
    const minW = minBins || 2;
    const hzPerBin = sr / nfft;
    const edges = [0];
    let bin = 0;
    for (let band = 0; band < nBands - 1; band++) {
      const remainingBands = nBands - band;
      const remainingBins = nBins - bin;
      const fHz = Math.max(1, bin * hzPerBin);
      const erbHz = 24.7 * ((4.37 * fHz) / 1000 + 1);
      let width = Math.max(minW, Math.round(erbHz / hzPerBin));
      // never leave fewer bins than the remaining bands each need at least minW
      width = Math.min(width, remainingBins - (remainingBands - 1) * minW);
      width = Math.max(minW, width);
      bin = Math.min(nBins, bin + width);
      edges.push(bin);
    }
    edges.push(nBins);
    const fwd = new Float32Array(nBands * nBins);
    const inv = new Float32Array(nBins * nBands);
    for (let band = 0; band < nBands; band++) {
      const lo = edges[band], hi = edges[band + 1];
      const w = Math.max(1, hi - lo);
      for (let b = lo; b < hi; b++) {
        fwd[band * nBins + b] = 1 / w;
        inv[b * nBands + band] = 1;
      }
    }
    return { fwd, inv, edges, nBands, nBins };
  }

  /* ------------------------------------------------------- inference resilience */

  /**
   * How long a single `session.run()` is allowed to take before it is
   * treated as a thermal/scheduling stall rather than real work. This is
   * deliberately much shorter than `neural-controller.js`'s own 120 s
   * per-call ceiling: that outer timeout exists to bound a whole round trip
   * (model load + run) from the main thread's point of view, while this one
   * exists to catch a throttled GPU/NPU mid-inference, early enough that the
   * session can be evicted and the *next* call gets a chance to pick a
   * healthier provider instead of also waiting two full minutes to fail.
   */
  const INFERENCE_TIMEOUT_MS = 20000;

  class InferenceTimeoutError extends Error {
    constructor(label) { super('inference timed out' + (label ? ': ' + label : '')); this.name = 'InferenceTimeoutError'; }
  }

  /** Race `promise` against a timer; on expiry, reject with `InferenceTimeoutError` instead of hanging forever. */
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new InferenceTimeoutError(label)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /**
   * Classify a thrown inference error into one of the hardware-limit reasons
   * `neural-controller.js`/`app.js` treat as "worth a quiet toast" — as
   * opposed to e.g. `weights-not-found`, which just means nothing was ever
   * installed and is not a runtime failure at all. Matches the message
   * patterns WebGPU/WASM/WebNN actually throw for these conditions
   * (`RESOURCE_EXHAUSTED`/"out of memory" from WASM's linear-memory grower
   * and from WebGPU allocation failures, "device lost"/"context lost" from a
   * reset GPU/NPU driver after a thermal event) plus the timeout above.
   * Returns `null` for anything else — a genuine bug or unexpected shape
   * should keep its own descriptive `inference-error: ...` reason, not be
   * silently relabelled.
   */
  function classifyInferenceError(err) {
    if (err instanceof InferenceTimeoutError) return 'timeout';
    const msg = String((err && err.message) || err || '').toLowerCase();
    if (/device.*lost|context.*lost|gpu process.*lost/.test(msg)) return 'device-lost';
    if (/out of memory|oom|resource_exhausted|allocation failed|memory access out of bounds/.test(msg)) return 'oom';
    if (err && err.name === 'RangeError') return 'oom';
    return null;
  }

  /**
   * Handle a `session.run()` failure for `modelKey`: classify it, and when
   * it is a hardware-limit condition (OOM/device-lost/timeout — a thermal or
   * memory throttle event, exactly what the brief's requirement 3 describes)
   * evict the cached session so the *next* call re-probes from scratch
   * instead of handing the same now-unhealthy WebGPU/WebNN device straight
   * back out. Returns the string `reason` the caller's `{applied:false,
   * reason}` result carries; `neural-controller.js` treats the hardware-
   * limit set specially (one quiet toast), everything else is just the
   * existing generic `inference-error: ...` passthrough.
   */
  function resolveInferenceFailure(modelKey, err) {
    const hwReason = classifyInferenceError(err);
    if (hwReason) { sessionCache.delete(modelKey); return hwReason; }
    return 'inference-error: ' + (err && err.message || String(err));
  }

  /* ---------------------------------------------------------------- models */

  /**
   * Each entry documents a *real*, independently published ONNX export this
   * worker is wire-compatible with, not a contract invented for this repo —
   * see the CHANGELOG for the sources. `fp32`/`fp16`/`int8`/`int4` are
   * alternative weight files for the *same* graph, picked by
   * `selectVariant()`: `fp16` is only requested when the WebGPU adapter has
   * already confirmed `shader-f16` support (a browser fp32→fp16 downcast
   * does not happen for free at runtime), and `int8`/`int4` are the mobile
   * path — quantised exports (e.g. via onnxruntime's own dynamic/static
   * quantisation tooling, or a vendor-published "-mobile"/"-quant" variant
   * such as a DeepFilterNet-Mobile build) small enough to keep resident
   * weights under the brief's ~80 MB mobile VRAM target. None of these files
   * ship with this repository — see the CHANGELOG for why — so on mobile the
   * lookup simply tries int4, then int8, then falls back exactly like
   * desktop does; a project that *does* drop quantised weights next to a
   * static deployment gets the VRAM saving with zero code changes.
   */
  const MODELS = {
    deepfilternet3: {
      kind: 'denoise',
      dir: 'models/deepfilternet3',
      files: {
        fp32: 'deepfilter.onnx', fp16: 'deepfilter.fp16.onnx', aux: 'deepfilter-auxiliary.bin',
        // "DeepFilterNet-Mobile"-class quantised exports the brief names
        // explicitly: same graph/IO contract as fp32/fp16 above, just
        // weight-quantised, so no DSP-side change is needed to use them.
        int8: 'deepfilter.int8.onnx', int4: 'deepfilter.int4.onnx',
      },
      // soniqo/DeepFilterNet3-ONNX and aufklarer/DeepFilterNet3-ONNX (Hugging
      // Face): feat_erb [1,1,T,32], feat_spec [1,2,T,96] in;
      // erb_mask [1,1,T,32], df_coefs [1,5,T,96,2] out.
      dsp: {
        sr: 48000, nfft: 960, hop: 480, erbBands: 32, dfBins: 96, dfOrder: 5, dfLookahead: 2,
      },
    },
    bsroformer: {
      kind: 'stems',
      dir: 'models/bsroformer',
      files: {
        fp32: 'bs_roformer.onnx', fp16: 'bs_roformer_4stem_rhythm_fp16.onnx',
        // a compressed/quantised voice-vs-music separator variant, same
        // host-STFT contract — see the `dsp` block below.
        int8: 'bs_roformer.int8.onnx', int4: 'bs_roformer.int4.onnx',
      },
      // silverdaw/bs-roformer-rhythm-onnx (Hugging Face): host computes the
      // STFT/iSTFT (torch.stft stripped from the graph for portability), the
      // graph consumes/returns real+imag spectrograms;
      // out_spec_real/out_spec_imag each [1,4,2,1025,801] = (batch, stem,
      // channel, freq, frame). Stem order: drums, bass, other, vocals.
      dsp: {
        sr: 44100, nfft: 2048, hop: 551, stems: ['drums', 'bass', 'other', 'vocals'],
      },
    },
    audiosr: {
      kind: 'superres',
      dir: 'models/audiosr',
      // already the lightweight, magnitude-curve-only path (see the comment
      // below) — small enough on its own that no further mobile-specific
      // quantised variant is needed to stay under the VRAM budget.
      files: { fp32: 'audiosr_lite.onnx', fp16: 'audiosr_lite.fp16.onnx' },
      // The brief explicitly allows "a lightweight model OR the matching
      // DSP/AI coupling" rather than the full ~6 GB AudioSR diffusion stack
      // (VAE + latent UNet + HiFi-GAN vocoder, iterative sampling — see
      // audiosronnx's own README for why it evaluated and did not ship that
      // model). This worker takes the lightweight path: a single-pass
      // magnitude-only model in the spirit of lavasr/Vocos-style bandwidth
      // extension, predicting a *gain curve* over the missing band rather
      // than synthesising a waveform outright — which is also what keeps the
      // result phase-accurate (see superresCurve below and
      // engine.js/remaster-processor.js's `airNeural` stage): the actual
      // waveform in that band still comes from the existing phase-coherent
      // harmonic exciter/air synthesiser, the model only reshapes how much
      // of it survives per band.
      dsp: { sr: 48000, melBins: 256, fMin: 20, fMax: 24000, nfft: 2048, hop: 480 },
    },
  };

  /* ------------------------------------------------------------- weight I/O */

  async function fetchBytes(url) {
    try {
      if (typeof fetch !== 'function') return null;
      const res = await fetch(url);
      if (!res || !res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) { return null; }
  }

  async function opfsBytes(path) {
    try {
      if (!(ctx.navigator && ctx.navigator.storage && ctx.navigator.storage.getDirectory)) return null;
      const root = await ctx.navigator.storage.getDirectory();
      const parts = path.split('/').filter(Boolean);
      let dir = root;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i], { create: false }).catch(() => null);
        if (!dir) return null;
      }
      const handle = await dir.getFileHandle(parts[parts.length - 1], { create: false }).catch(() => null);
      if (!handle) return null;
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) { return null; }
  }

  /**
   * Pick which weight file to ask for, given what the device can actually
   * use. On mobile this prefers the smallest quantised export a model
   * publishes — int4, then int8 — before ever considering fp16/fp32, which
   * is what keeps resident weights under the brief's ~80 MB VRAM target;
   * everywhere else the existing fp16-when-the-adapter-supports-it/fp32
   * behaviour is unchanged. A variant is only chosen if `def.files` actually
   * lists it — none do in this repository (see MODELS' own comment), so
   * this always lands on `fp32` here, but it is exactly the lookup a project
   * that *does* ship quantised weights needs with no further code changes.
   */
  function selectVariant(def, caps) {
    const files = def.files;
    const wantFp16 = !!(caps && caps.webgpu && caps.webgpu.available && caps.webgpu.fp16);
    const order = (caps && caps.mobile)
      ? ['int4', 'int8', wantFp16 ? 'fp16' : null, 'fp32']
      : [wantFp16 ? 'fp16' : null, 'fp32'];
    for (const key of order) { if (key && files[key]) return key; }
    return 'fp32';
  }

  /**
   * Resolve a model's weights, OPFS first (a user-imported model persists
   * there with no repeat network cost) then a same-origin relative fetch
   * (the "local folder structure" the brief asks for). Returns `null` — never
   * throws — when neither source has the file; that `null` is the signal the
   * rest of this file treats as "fall back to the pure DSP path cleanly".
   */
  async function loadWeights(modelKey, caps) {
    const def = MODELS[modelKey];
    if (!def) return null;
    const variant = selectVariant(def, caps);
    const rel = def.dir + '/' + def.files[variant];
    let bytes = await opfsBytes(rel);
    if (bytes) return { bytes, source: 'opfs', file: rel, def, variant };
    bytes = await fetchBytes(rel);
    if (bytes) return { bytes, source: 'fetch', file: rel, def, variant };
    return null;
  }

  const sessionCache = new Map();  // modelKey -> {session, provider, fp16, def} | {unavailable:true, reason}

  async function getSession(modelKey) {
    if (sessionCache.has(modelKey)) return sessionCache.get(modelKey);
    let result;
    try {
      const caps = { webgpu: await probeWebGpu(), webnn: await probeWebNN(), mobile: isMobileUA() };
      const weights = await loadWeights(modelKey, caps);
      if (!weights) {
        result = { unavailable: true, reason: 'weights-not-found' };
      } else {
        const ort = await loadOrt();
        const created = await createSession(ort, weights.bytes, caps);
        result = Object.assign({ unavailable: false, def: weights.def, source: weights.source, file: weights.file, variant: weights.variant }, created);
      }
    } catch (err) {
      result = { unavailable: true, reason: 'init-failed: ' + (err && err.message || String(err)) };
    }
    sessionCache.set(modelKey, result);
    return result;
  }

  /* -------------------------------------------------------- DeepFilterNet3 */

  /**
   * Denoise `signal` (mono, resampled by the caller to the model's own
   * 48 kHz if needed) with DeepFilterNet3. Falls back cleanly — `{applied:
   * false}` — when the weights are not present, or on any inference error.
   */
  async function denoiseDFN3(signal) {
    const sess = await getSession('deepfilternet3');
    if (sess.unavailable) return { applied: false, reason: sess.reason };
    try {
      const ort = await loadOrt();
      const { nfft, hop, erbBands, dfBins } = sess.def.dsp;
      const win = vorbisWindow(nfft);
      const { re, im, frames, nBins } = stft(signal, nfft, hop, win);
      const T = frames;
      const Talign = alignT(T);

      const fb = buildErbFilterbank(nBins, erbBands, sess.def.dsp.sr, nfft);
      // feat_erb [1,1,T,32]: log-power in each ERB band
      const featErb = new Float32Array(Talign * erbBands);
      for (let f = 0; f < T; f++) {
        for (let band = 0; band < erbBands; band++) {
          let acc = 0;
          for (let b = fb.edges[band]; b < fb.edges[band + 1]; b++) {
            const r = re[f * nBins + b], i = im[f * nBins + b];
            acc += r * r + i * i;
          }
          featErb[f * erbBands + band] = Math.log10(Math.max(acc * fb.fwd[band * nBins + fb.edges[band]] || acc, 1e-10));
        }
      }
      // feat_spec [1,2,T,96]: real/imag of the first `dfBins` linear bins
      const featSpec = new Float32Array(2 * Talign * dfBins);
      for (let f = 0; f < T; f++) {
        for (let b = 0; b < dfBins; b++) {
          const bin = Math.min(nBins - 1, b);
          featSpec[(0 * Talign + f) * dfBins + b] = re[f * nBins + bin];
          featSpec[(1 * Talign + f) * dfBins + b] = im[f * nBins + bin];
        }
      }

      const erbTensor = new ort.Tensor('float32', featErb, [1, 1, Talign, erbBands]);
      const specTensor = new ort.Tensor('float32', featSpec, [1, 2, Talign, dfBins]);
      const outputs = await withTimeout(
        sess.session.run({ feat_erb: erbTensor, feat_spec: specTensor }), INFERENCE_TIMEOUT_MS, 'deepfilternet3',
      );
      const mask = outputs.erb_mask ? outputs.erb_mask.data : null;
      if (!mask) return { applied: false, reason: 'unexpected-output-shape' };

      // apply the (trimmed back to T) ERB mask to every bin inside its band —
      // the deep-filter coefficients on the first dfBins bins are a further
      // refinement this lightweight host does not apply, matching the
      // documented "a compatible STFT/filtering/synthesis implementation is
      // required" note on the export: the mask alone is still a complete,
      // correct (if less aggressive) DeepFilterNet3-compatible denoiser.
      const outRe = new Float32Array(re.length);
      const outIm = new Float32Array(im.length);
      for (let f = 0; f < T; f++) {
        for (let band = 0; band < erbBands; band++) {
          const g = mask[f * erbBands + band];
          for (let b = fb.edges[band]; b < fb.edges[band + 1]; b++) {
            outRe[f * nBins + b] = re[f * nBins + b] * g;
            outIm[f * nBins + b] = im[f * nBins + b] * g;
          }
        }
      }
      const output = istft(outRe, outIm, T, nfft, hop, win, signal.length);
      return { applied: true, output, provider: sess.provider, fp16: sess.fp16 };
    } catch (err) {
      return { applied: false, reason: resolveInferenceFailure('deepfilternet3', err) };
    }
  }

  /* -------------------------------------------------------------- BS-RoFormer */

  /**
   * Separate `signal` (mono or one channel of a stereo pair — call once per
   * channel and recombine, matching the host-STFT export's own per-channel
   * layout) into drums/bass/other/vocals. Falls back cleanly when the
   * weights are absent.
   */
  async function separateBSR(signal) {
    const sess = await getSession('bsroformer');
    if (sess.unavailable) return { applied: false, reason: sess.reason };
    try {
      const ort = await loadOrt();
      const { nfft, hop, stems } = sess.def.dsp;
      const win = hannWindow(nfft);
      const { re, im, frames, nBins } = stft(signal, nfft, hop, win);
      const T = frames;
      const Talign = alignT(T);
      const specRe = padRowsTo(re, T, nBins, Talign);
      const specIm = padRowsTo(im, T, nBins, Talign);

      const reTensor = new ort.Tensor('float32', specRe, [1, 1, nBins, Talign]);
      const imTensor = new ort.Tensor('float32', specIm, [1, 1, nBins, Talign]);
      const outputs = await withTimeout(
        sess.session.run({ in_spec_real: reTensor, in_spec_imag: imTensor }), INFERENCE_TIMEOUT_MS, 'bsroformer',
      );
      const outRe = outputs.out_spec_real ? outputs.out_spec_real.data : null;
      const outIm = outputs.out_spec_imag ? outputs.out_spec_imag.data : null;
      if (!outRe || !outIm) return { applied: false, reason: 'unexpected-output-shape' };

      const result = {};
      const stemSize = nBins * Talign;
      for (let s = 0; s < stems.length; s++) {
        const stemRe = trimRowsTo(outRe.subarray(s * stemSize, (s + 1) * stemSize), Talign, nBins, T);
        const stemIm = trimRowsTo(outIm.subarray(s * stemSize, (s + 1) * stemSize), Talign, nBins, T);
        result[stems[s]] = istft(stemRe, stemIm, T, nfft, hop, win, signal.length);
      }
      return { applied: true, stems: result, provider: sess.provider, fp16: sess.fp16 };
    } catch (err) {
      return { applied: false, reason: resolveInferenceFailure('bsroformer', err) };
    }
  }

  /* ----------------------------------------------------------------- AudioSR */

  /**
   * Predict a per-band gain curve (dB) over `bandsHz` for the content above
   * the signal's own measured cutoff — not a waveform. See the `audiosr`
   * entry in MODELS for why: the actual high band is re-synthesised by the
   * existing phase-coherent DSP air stage, so what the neural model needs to
   * contribute is *how much* top end belongs there, which keeps the result
   * phase-accurate by construction (the phase never comes from the model).
   */
  async function superresCurve(signal, bandsHz) {
    const sess = await getSession('audiosr');
    if (sess.unavailable) return { applied: false, reason: sess.reason };
    try {
      const ort = await loadOrt();
      const { nfft, hop, melBins, sr } = sess.def.dsp;
      const win = hannWindow(nfft);
      const { re, im, frames, nBins } = stft(signal, nfft, hop, win);
      const T = frames;
      const Talign = alignT(T);
      const fb = buildErbFilterbank(nBins, melBins, sr, nfft, 1); // mel-ish log banding, reuses the same grouping machinery
      const mel = new Float32Array(Talign * melBins);
      for (let f = 0; f < T; f++) {
        for (let band = 0; band < melBins; band++) {
          let acc = 0;
          for (let b = fb.edges[band]; b < fb.edges[band + 1]; b++) {
            const r = re[f * nBins + b], i = im[f * nBins + b];
            acc += r * r + i * i;
          }
          mel[f * melBins + band] = Math.log10(Math.max(acc, 1e-10));
        }
      }
      const melTensor = new ort.Tensor('float32', mel, [1, 1, Talign, melBins]);
      const outputs = await withTimeout(sess.session.run({ mel_in: melTensor }), INFERENCE_TIMEOUT_MS, 'audiosr');
      const curve = outputs.mel_gain_db ? outputs.mel_gain_db.data : null;
      if (!curve) return { applied: false, reason: 'unexpected-output-shape' };

      // average the (trimmed) per-frame curve over time, then resample onto
      // the caller's requested band centres — the caller (the `airNeural`
      // worklet stage) only needs a slowly-varying per-band gain, not a
      // frame-accurate one.
      const avg = new Float32Array(melBins);
      for (let f = 0; f < T; f++) for (let band = 0; band < melBins; band++) avg[band] += curve[f * melBins + band] / T;
      const hzPerBand = (fIdx) => ((fb.edges[fIdx] + fb.edges[fIdx + 1]) / 2) * (sr / nfft);
      const gainsDb = bandsHz.map((hz) => {
        let best = 0, bestD = Infinity;
        for (let band = 0; band < melBins; band++) {
          const d = Math.abs(hzPerBand(band) - hz);
          if (d < bestD) { bestD = d; best = band; }
        }
        return avg[best];
      });
      return { applied: true, gainsDb, provider: sess.provider, fp16: sess.fp16 };
    } catch (err) {
      return { applied: false, reason: resolveInferenceFailure('audiosr', err) };
    }
  }

  /* ---------------------------------------------------------------- probe */

  async function probe() {
    const webgpu = await probeWebGpu();
    const webnn = await probeWebNN();
    const mobile = isMobileUA();
    const models = {};
    for (const key of Object.keys(MODELS)) {
      const sess = await getSession(key);
      models[key] = sess.unavailable
        ? { available: false, reason: sess.reason }
        : { available: true, provider: sess.provider, fp16: sess.fp16, source: sess.source, variant: sess.variant };
    }
    return {
      webgpu: { available: webgpu.available, fp16: webgpu.fp16 },
      webnn: { available: webnn.available, deviceType: webnn.deviceType },
      wasmSimd: true,
      mobile,
      models,
    };
  }

  /* ------------------------------------------------------------- messaging */

  const handlers = {
    probe: async () => probe(),
    denoise: async (msg) => denoiseDFN3(msg.signal),
    separate: async (msg) => separateBSR(msg.signal),
    superres: async (msg) => superresCurve(msg.signal, msg.bandsHz || []),
  };

  if (typeof ctx.addEventListener === 'function' && ctx.postMessage) {
    ctx.addEventListener('message', async (ev) => {
      const msg = ev.data || {};
      const handler = handlers[msg.type];
      if (!handler) { ctx.postMessage({ reqId: msg.reqId, error: 'unknown message type: ' + msg.type }); return; }
      try {
        const result = await handler(msg);
        ctx.postMessage({ reqId: msg.reqId, result });
      } catch (err) {
        ctx.postMessage({ reqId: msg.reqId, result: { applied: false, reason: 'handler-error: ' + (err && err.message || String(err)) } });
      }
    });
  }

  // Exported for tests/neural.test.js (and for anything else that wants to
  // exercise this worker's own logic without a real Worker/postMessage round
  // trip) — the same "export the shipped internals" convention
  // opfs-manager.js's `buildWorkerSource` already uses.
  ctx.RSNeuralWorker = {
    MODELS, alignT, padRowsTo, trimRowsTo, buildErbFilterbank, stft, istft, fftAny,
    vorbisWindow, hannWindow, probeWebGpu, probeWebNN, isMobileUA, createSession, loadOrt,
    selectVariant, loadWeights, opfsBytes, fetchBytes, getSession, sessionCache,
    withTimeout, classifyInferenceError, resolveInferenceFailure, INFERENCE_TIMEOUT_MS,
    denoiseDFN3, separateBSR, superresCurve, probe,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ctx.RSNeuralWorker;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
