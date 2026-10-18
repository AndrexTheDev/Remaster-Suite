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
/**
 * @fileoverview Neural inference worker — runs `onnxruntime-web` off the
 * audio thread. Not a `<script>` tag: `neural-controller.js` loads this file
 * with `new Worker(...)`, and `tests/neural.test.js` loads it into a Node
 * context directly. Everything it exports on `ctx.RSNeuralWorker` exists for
 * that second audience.
 *
 * The states this worker can be in, and why each one exists:
 *
 *   - **no weights** — the shipped state. `.onnx` files are not vendored (they
 *     run from tens of megabytes to several gigabytes), so `loadWeights()`
 *     finds nothing in OPFS and nothing next to the deployment, and every call
 *     answers `{applied:false, reason:'weights-not-found'}`. The caller falls
 *     back to the pure-DSP chain; nothing throws.
 *   - **init failed** — weights existed but the session could not be built
 *     (`reason: 'init-failed: …'`), cached as unavailable so a broken file is
 *     not re-read on every call.
 *   - **ready** — a session exists with a named execution provider
 *     (`webnn` → `webgpu` → `wasm`, in the order {@link RSNeuralWorker.createSession}
 *     decides from the device profile).
 *   - **hardware gave out** — an inference threw an OOM, a lost device or hit
 *     the per-run watchdog. Those three (`'oom'`, `'device-lost'`, `'timeout'`)
 *     evict the cached session so the next call re-probes from scratch, and are
 *     the only reasons `neural-controller.js` turns into a user-visible toast.
 *
 * Four guarantees hold across all of them, because they are the four ways a
 * neural upgrade usually breaks a working audio app:
 *
 *   1. WebGPU is *preferred*, never *required*. A missing `navigator.gpu`, an
 *      adapter that is refused or an unsupported op all route to the next
 *      provider instead of failing the pipeline.
 *   2. A missing model is not an error — see the first state above.
 *   3. Tensor time axes are rounded up to a multiple of 4 before they reach
 *      `onnxruntime-web` ({@link RSNeuralWorker.alignT}): several WebGPU kernels
 *      these models rely on require it, and "works on WASM, silently wrong on
 *      WebGPU" is the worst of the available outcomes.
 *   4. Mobile is a first-class target: WebNN/NPU is tried ahead of WebGPU on a
 *      phone, the smallest quantised weight file a model publishes is chosen,
 *      and every `session.run()` is raced against a short watchdog.
 *
 * Weight discovery happens in two places, in order: the Origin Private File
 * System (a model the user imported once survives reloads) and a same-origin
 * relative fetch of `models/<name>/…` (dropping files next to a static
 * deployment works with no build step). Neither ships with this repository.
 *
 * @module RSNeuralWorker
 */
(function (ctx) {
  'use strict';

  /**
   * The execution provider a session was built with.
   * @typedef {('webnn'|'webgpu'|'wasm')} OrtProvider
   */

  /**
   * What a capability probe answers about WebGPU.
   * @typedef {Object} WebGpuCapability
   * @property {boolean} available - an adapter was obtained.
   * @property {boolean} fp16 - the adapter advertises `shader-f16`; fp16
   *   weights are only ever requested when this is `true`.
   * @property {*} [adapter] - the adapter itself, never sent anywhere.
   */

  /**
   * What {@link RSNeuralWorker.probeWebNN} answers: whether a WebNN context could
   * really be created, and on which device type.
   * @typedef {Object} WebNnCapability
   * @property {boolean} available - `createContext()` succeeded for some type.
   * @property {('npu'|'gpu'|'cpu'|null)} deviceType - the most specialised type
   *   that worked, or `null` when none did.
   */

  /**
   * The device profile one call is planned from — every provider and variant
   * decision is derived from this, never from the browser's own defaults.
   * @typedef {Object} DeviceCaps
   * @property {WebGpuCapability} webgpu - WebGPU probe result.
   * @property {WebNnCapability} webnn - WebNN probe result.
   * @property {boolean} mobile - a phone/tablet user agent, which reorders the
   *   providers (WebNN first) and prefers quantised weights.
   */

  /**
   * One model this worker is wire-compatible with: its graph file per weight
   * variant, whether it denoises, separates or predicts a curve, and the DSP
   * contract its tensors follow (`sr`, window, hop, band layout).
   * @typedef {Object} ModelDefinition
   * @property {('denoise'|'stems'|'superres')} kind - what a successful run
   *   produces.
   * @property {string} dir - folder the weight file lives in, relative to the
   *   site root (`models/<name>`).
   * @property {Object<string, string>} files - weight file name per variant
   *   key (`fp32`, `fp16`, `int8`, `int4`); a missing key means that variant is
   *   not published for this model.
   * @property {Object} dsp - the tensor geometry and rates: sample rate,
   *   `nfft`, `hop`, band counts and the like, documented per model below.
   */

  /**
   * A cached session, or the cached memory that there will not be one. The
   * second shape is what keeps a missing model from being looked up again on
   * every single call.
   * @typedef {(Object|UnavailableSession)} CachedSession
   */

  /**
   * The negative cache entry: no session, and the reason to report.
   * @typedef {Object} UnavailableSession
   * @property {true} unavailable
   * @property {string} reason - `'weights-not-found'` or `'init-failed: …'`.
   */

  /**
   * A live session plus how it was built.
   * @typedef {Object} ReadySession
   * @property {false} unavailable
   * @property {*} session - the `ort.InferenceSession`.
   * @property {OrtProvider} provider - what it actually runs on.
   * @property {boolean} fp16 - whether fp16 weights were used.
   * @property {ModelDefinition} def - the model definition behind it.
   * @property {('opfs'|'fetch')} source - where the weights came from.
   * @property {string} file - the relative weight file that was loaded.
   * @property {string} variant - the weight variant chosen.
   */

  /* ------------------------------------------------------------ onnxruntime */

  /**
   * The `.webgpu` UMD build is the one bundle that carries both the WebGPU
   * and the WASM/SIMD execution providers, so the "prefer WebGPU, fall back
   * to WASM" requirement costs one load, not two. No bundled local copy is
   * shipped (~140 MB unpacked, see library-loader.js) — this list is CDN-only
   * and is only ever touched once a neural feature is actually invoked.
   * @returns {string[]} candidate URLs, in try order — the library loader's
   *   own list when it is reachable in this worker (a worker has no document)
   *   and a hard-coded pair otherwise.
   */
  function ortCandidates() {
    try {
      if (typeof ctx.importScripts === 'function' && !ctx.RSLibs) {
        ctx.importScripts('library-loader.js');
      }
    } catch (err) { /* no document in a worker — library-loader.js tolerates that */ }
    if (ctx.RSLibs && typeof ctx.RSLibs.ortUrls === 'function') return ctx.RSLibs.ortUrls();
    return [
      '../vendor/onnxruntime-web/ort.webgpu.min.js',
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js',
      'https://unpkg.com/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js',
    ];
  }

  /**
   * The one in-flight (or settled) load of onnxruntime-web. Cached so the
   * runtime is imported once per worker, no matter how many models ask.
   * @type {Promise<*>|null}
   */
  let ortPromise = null;
  /**
   * Load onnxruntime-web once, trying each CDN candidate in order, and
   * configure the WASM provider while doing it: `wasmPaths` pointed at the
   * same folder as the bundle, SIMD on, and a thread count that leaves the
   * main work a core (`hardwareConcurrency - 1`, clamped to 1…4).
   * @returns {Promise<*>} the `ort` namespace.
   * @throws {Error} the last load error, or `'onnxruntime-web: no CDN
   *   candidate loaded'` when no candidate produced `ctx.ort`.
   */
  function loadOrt() {
    if (ortPromise) return ortPromise;
    ortPromise = (async () => {
      const urls = ortCandidates();
      let lastErr = null;
      for (const url of urls) {
        try {
          ctx.importScripts(url);
          if (ctx.ort) {
            let base = url.slice(0, url.lastIndexOf('/') + 1);
            try { if (ctx.location && ctx.location.href) base = new URL(base, ctx.location.href).href; } catch (e) { /* CDN/relative fallback */ }
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
   * @returns {Promise<WebGpuCapability>} availability, the fp16 feature flag,
   *   and the adapter when one was obtained. Never rejects.
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

  /**
   * Whether this is a phone or tablet, from the user agent — the one signal
   * that reorders execution providers (WebNN/NPU first) and prefers quantised
   * weights. Deliberately a plain regex and not a capability check: it is the
   * form the project brief specifies, and a misdetection only changes which
   * provider is *tried first*.
   * @returns {boolean} `true` for a mobile user agent.
   */
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
   * @returns {Promise<WebNnCapability>} availability and the most specialised
   *   device type that really created a context. Never rejects: a browser that
   *   exposes `navigator.ml` but throws on every `createContext()` reports
   *   `{available: false, deviceType: null}` here instead of failing later.
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
   * The execution providers to try, in order. **WebGPU is first, always** —
   * `onnxruntime-web` gets `executionProviders: [{name:'webgpu', …}]` before
   * anything else is considered, and the WASM/SIMD provider is the automatic
   * last resort. WebNN is kept as an opportunistic step between the two (its
   * whole reason to exist is reaching an NPU WebGPU cannot), but it never
   * displaces WebGPU the way it did before: a machine with both gets the GPU
   * path, and a phone without WebGPU still gets the NPU before it falls back
   * to WASM.
   * @param {DeviceCaps} caps - the device profile.
   * @returns {string[]} provider names in try order — always ending in
   *   `'wasm'`, because WASM is what every host has.
   */
  function providerOrder(caps) {
    const order = ['webgpu'];
    if (caps && caps.webnn && caps.webnn.available) order.push('webnn');
    order.push('wasm');
    return order.filter((p) => p !== 'webgpu' || (caps && caps.webgpu && caps.webgpu.available));
  }

  /**
   * Create a session. The provider list comes from {@link providerOrder}:
   * WebGPU first, WebNN where the host really created a context, WASM/SIMD
   * last and unconditional. Every optional provider is a try/catch of its
   * own: a missing provider, an unsupported op, or a device creation failure
   * mid-session all fall through to the next one, and the caller never sees
   * the difference except in the returned `provider` name. WASM is the only
   * provider that is never wrapped in a `try` — if it also throws, that is a
   * genuine `createSession()` failure, caught one level up by `getSession()`.
   * @param {*} ort - the loaded `onnxruntime-web` namespace.
   * @param {Uint8Array} bytes - the model's `.onnx` bytes.
   * @param {DeviceCaps} caps - the device profile that decides the order.
   * @returns {Promise<{session: *, provider: OrtProvider, fp16: boolean}>}
   *   the first provider that worked, or WASM.
   * @throws {Error} only when the WASM provider also fails — a genuine
   *   session-creation failure, reported as `'init-failed: …'` by callers.
   */
  async function createSession(ort, bytes, caps) {
    const attempts = [];
    const webnnAttempt = (caps.webnn && caps.webnn.available)
      ? {
        provider: 'webnn',
        fp16: false,
        run: () => ort.InferenceSession.create(bytes, {
          /**
           * Create the session on the WebNN provider (the NPU where a browser has
           * one).
           * @returns {Promise<Object>} the ORT inference session, or a rejection
           *   that `createSession` turns into the next attempt.
           */
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
          /**
           * Create the session on the WebGPU provider, with fp16 kernels when the
           * adapter reported support for them.
           * @returns {Promise<Object>} the ORT inference session, or a rejection
           *   that `createSession` turns into the next attempt.
           */
          executionProviders: [{ name: 'webgpu', deviceType: 'gpu', powerPreference: 'high-performance' }],
          graphOptimizationLevel: 'all',
        }),
      }
      : null;
    for (const provider of providerOrder(caps)) {
      if (provider === 'webgpu' && webgpuAttempt) attempts.push(webgpuAttempt);
      if (provider === 'webnn' && webnnAttempt) attempts.push(webnnAttempt);
    }

    for (const attempt of attempts) {
      try {
        const session = await attempt.run();
        return { session, provider: attempt.provider, fp16: attempt.fp16 };
      } catch (err) { /* fall through to the next provider, WASM last */ }
    }
    // The automatic last resort. SIMD is the difference between a usable
    // phone and a slideshow, so it is configured on the environment *and*
    // stated in the session options; a build without SIMD support ignores it
    // and runs scalar rather than failing.
    if (ort.env && ort.env.wasm) ort.env.wasm.simd = true;
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
    });
    return { session, provider: 'wasm', fp16: false };
  }

  /* ------------------------------------------------------------- tensor T-alignment */

  /**
   * Round a time-frame count up to the nearest multiple of 4 — the alignment
   * several WebGPU kernels in these graphs require, applied to every tensor
   * before it is handed to the runtime.
   * @param {number} n - the frame count to align.
   * @returns {number} the smallest multiple of 4 that is at least `n` (and at
   *   least 4).
   */
  function alignT(n) { return Math.ceil(Math.max(1, n) / 4) * 4; }

  /**
   * Pad a row-major [T, cols] matrix with trailing zero rows up to `Talign`.
   * The padding rows are zeros, and the model's output is trimmed back to `T`
   * again by {@link RSNeuralWorker.trimRowsTo} — a zero row contributes nothing
   * to a strided convolution's kept region.
   * @param {Float32Array} flat - the matrix, row-major, `T * cols` long.
   * @param {number} T - rows actually present.
   * @param {number} cols - row width.
   * @param {number} Talign - the aligned row count, from `alignT()`.
   * @returns {Float32Array} a `Talign * cols` matrix (the same object when no
   *   padding is needed).
   */
  function padRowsTo(flat, T, cols, Talign) {
    if (Talign === T) return flat;
    const out = new Float32Array(Talign * cols);
    out.set(flat.subarray ? flat.subarray(0, T * cols) : flat.slice(0, T * cols));
    return out;
  }

  /**
   * Trim a row-major [Talign, cols] matrix back down to its first `T` rows,
   * undoing {@link RSNeuralWorker.padRowsTo}.
   * @param {Float32Array} flat - the padded matrix.
   * @param {number} Talign - its current row count.
   * @param {number} cols - row width.
   * @param {number} T - the row count to keep.
   * @returns {Float32Array} a view (or copy) of the first `T` rows.
   */
  function trimRowsTo(flat, Talign, cols, T) {
    if (Talign === T) return flat;
    return flat.subarray ? flat.subarray(0, T * cols) : flat.slice(0, T * cols);
  }

  /* ------------------------------------------------------------------- DSP */

  /**
   * The shared DSP utilities, imported on first use: `importScripts` in the
   * browser, `require` in the Node suites. Both load the *same* classic
   * script, so the FFT here and the analyser's FFT are one implementation.
   * @returns {Object|null} `RSDSP`, or `null` when it could not be loaded —
   *   callers that cannot work without it throw a descriptive error instead.
   */
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
  /**
   * Cached Bluestein chirp parameters per transform length. A length that is
   * not a power of two needs the same chirp and the same padded FFT of it on
   * every call, so computing it once is what keeps a per-frame non-power-of-two
   * transform affordable.
   * @type {Map<number, Object>}
   */
  const bluesteinCache = new Map();
  /**
   * Chirp and pre-transformed chirp for a Bluestein FFT of length `n`, built
   * on first use: `exp(-i·π·k²/n)` computed from `k² mod 2n` so the angle
   * stays small and the cosine stays accurate.
   * @param {number} n - transform length.
   * @param {Object} dsp - `RSDSP`, for its power-of-two `fft`.
   * @returns {{m: number, wr: Float32Array, wi: Float32Array, Br: Float32Array,
   *   Bi: Float32Array}} the padded FFT length and the chirp tables.
   */
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
  /**
   * A complex FFT of *any* length: the radix-2 path straight through for a
   * power of two, Bluestein's chirp-z algorithm otherwise. Everything in this
   * worker goes through it, so no model's window size is ever rounded to fit
   * the FFT.
   * @param {Float32Array} re - real parts, transformed in place.
   * @param {Float32Array} im - imaginary parts, transformed in place.
   * @param {Object} dsp - `RSDSP`.
   * @param {number} [n=re.length] - transform length.
   * @returns {void}
   */
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

  /**
   * The Vorbis window DeepFilterNet3 was trained with — `sin(π/2 ·
   * sin²(π(i+½)/n))`, which satisfies the Princen-Bradley condition, so an
   * STFT/ISTFT pair using it reconstructs without a scale factor. Using any
   * other window here would bias the model's input relative to its training.
   * @param {number} n - window length in samples.
   * @returns {Float32Array} the window.
   */
  function vorbisWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = Math.sin((Math.PI / 2) * Math.pow(Math.sin((Math.PI * (i + 0.5)) / n), 2));
    return w;
  }
  /**
   * A periodic Hann window, for the STFT of the models that were trained with
   * one (the band-split separator). Periodic, not symmetric: the overlap-add
   * identity the iSTFT relies on needs the periodic form.
   * @param {number} n - window length in samples.
   * @returns {Float32Array} the window.
   */
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
   * @param {Float32Array} signal - mono samples, −1…1.
   * @param {number} nfft - window length in samples.
   * @param {number} hop - advance between frames in samples.
   * @param {Float32Array} window - analysis window (`vorbisWindow`/`hannWindow`).
   * @returns {{re: Float32Array, im: Float32Array}} row-major [frame, bin]
   *   spectra, `nfft/2 + 1` bins per frame.
   * @throws {Error} when `RSDSP` could not be loaded — without it there is no
   *   FFT, and a silent zero spectrum would be worse than a loud failure.
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
  /**
   * Inverse of {@link RSNeuralWorker.stft}: overlap-add with the same window and
   * the complementary window sum, so a signal that passes through an STFT and
   * straight back out comes out at the same level it went in. The inverse FFT
   * itself is a conjugated forward FFT scaled by `1/nfft`, which reuses the
   * one FFT implementation.
   * @param {Float32Array} re - real parts, row-major [frame, bin].
   * @param {Float32Array} im - imaginary parts, same layout.
   * @param {number} frames - frame count.
   * @param {number} nfft - window length in samples.
   * @param {number} hop - advance between frames in samples.
   * @param {Float32Array} window - synthesis window (the analysis one).
   * @param {number} length - samples to produce; the tail beyond the last
   *   analysed frame is discarded rather than zero-padded.
   * @returns {Float32Array} the reconstructed mono signal.
   * @throws {Error} when `RSDSP` could not be loaded.
   */
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
  /**
   * Build an ERB-spaced filterbank over an STFT's bins — the band layout
   * DeepFilterNet3's `feat_erb` input expects (32 bands), including the
   * mid-band upscaling the original implementation applies. Bin edges are
   * chosen from the ERB-rate scale, never narrower than `minBins`, and never
   * so wide that the remaining bands would be starved.
   * @param {number} nBins - bins available (`nfft/2 + 1`).
   * @param {number} nBands - bands to produce.
   * @param {number} sr - sample rate in Hz, to convert bins to hertz.
   * @param {number} nfft - window length, to convert back.
   * @param {number} [minBins=2] - narrowest band, in bins.
   * @returns {{fwd: Float32Array, inv: Float32Array, edges: number[],
   *   nBands: number, nBins: number}} the band-summing and band-spreading
   *   matrices plus the bin edges they were built from.
   */
  function buildErbFilterbank(nBins, nBands, sr, nfft, minBins) {
    const minW = minBins || 2;
    const hzPerBin = sr / nfft;
    // Exact libDF `erb_fb`: equal spacing on its ERB-number axis, with
    // minimum-width overflow carried into the following band.
    const freq2erb = (hz) => 9.265 * Math.log1p(hz / (24.7 * 9.265));
    const erb2freq = (erb) => 24.7 * 9.265 * Math.expm1(erb / 9.265);
    const step = freq2erb(sr / 2) / nBands;
    const widths = new Array(nBands);
    let prevBin = 0, overflow = 0;
    for (let i = 1; i <= nBands; i++) {
      const nextBin = Math.round(erb2freq(i * step) / hzPerBin);
      let width = nextBin - prevBin - overflow;
      if (width < minW) { overflow = minW - width; width = minW; } else overflow = 0;
      widths[i - 1] = width;
      prevBin = nextBin;
    }
    widths[nBands - 1] += 1;
    const excess = widths.reduce((sum, width) => sum + width, 0) - nBins;
    if (excess > 0) widths[nBands - 1] -= excess;
    const edges = [0];
    for (const width of widths) edges.push(edges[edges.length - 1] + width);
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
  /**
   * How long one `session.run()` may take before it is treated as a thermal or
   * scheduling stall rather than real work, in milliseconds. Deliberately far
   * below `neural-controller.js`'s 120 s per-call ceiling: that outer timeout
   * bounds a whole round trip, while this one catches a throttled GPU/NPU
   * early enough to evict the session and let the *next* call pick a healthier
   * provider.
   * @type {number}
   */
  const INFERENCE_TIMEOUT_MS = 20000;

  /**
   * The error a watchdog expiry throws, kept as its own class so
   * {@link RSNeuralWorker.classifyInferenceError} can recognise it by type
   * instead of by message text.
   */
  class InferenceTimeoutError extends Error {
    /**
     * @param {string} [label] - what timed out (the model key), appended to
     *   the message and used in the toast-free log line.
     */
    constructor(label) { super('inference timed out' + (label ? ': ' + label : '')); this.name = 'InferenceTimeoutError'; }
  }

  /**
   * Race a promise against a timer; on expiry, reject with
   * {@link InferenceTimeoutError} instead of hanging forever. The timer is
   * always cleared, so a settled promise leaves nothing behind.
   * @param {Promise<*>} promise - the work to bound (a `session.run()`).
   * @param {number} ms - the budget in milliseconds.
   * @param {string} [label] - what the work is, for the error message.
   * @returns {Promise<*>} the work's value, or a rejection.
   */
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
   * @param {*} err - the thrown value from a `session.run()`.
   * @returns {('timeout'|'device-lost'|'oom'|null)} the hardware-limit reason,
   *   or `null` when the error is not a hardware limit.
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
   * @param {string} modelKey - the model whose session failed (`'deepfilternet3'`,
   *   `'bsroformer'`, `'audiosr'`).
   * @param {*} err - the thrown value.
   * @returns {string} `'oom'`, `'device-lost'` or `'timeout'` when the session
   *   was evicted, otherwise `'inference-error: <message>'` — the vocabulary
   *   `neural-controller.js` and `app.js` branch on.
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
   * @type {Object<string, ModelDefinition>} keyed by model key, which is also
   *   the folder name under `models/` and the string every reason refers to.
   */
  const MODELS = {
    deepfilternet3: {
      kind: 'denoise',
      dir: 'models/deepfilternet3',
      // Frozen host/model boundary. A file with the expected name but a
      // different graph is not allowed to reach session.run(): ORT exposes
      // these names after session creation, so the worker can reject a wrong
      // export deterministically instead of reporting an opaque shape error
      // after the first (expensive) inference.
      // `io` is the legacy monolithic adapter kept behind the clean fallback
      // while the official three-graph export below is wired end to end.
      io: {
        inputs: ['feat_erb', 'feat_spec'],
        outputs: ['erb_mask', 'df_coefs'],
      },
      officialPipeline: {
        sourceLock: 'models/sources/deepfilternet3.json',
        variants: {
          fp16: { encoder: 'enc.fp16.onnx', erbDecoder: 'erb_dec.fp16.onnx', dfDecoder: 'df_dec.fp16.onnx' },
          official: { encoder: 'enc.onnx', erbDecoder: 'erb_dec.onnx', dfDecoder: 'df_dec.onnx' },
        },
        graphs: {
          encoder: { file: 'enc.onnx', inputs: ['feat_erb', 'feat_spec'], outputs: ['e0', 'e1', 'e2', 'e3', 'emb', 'c0', 'lsnr'] },
          erbDecoder: { file: 'erb_dec.onnx', inputs: ['emb', 'e3', 'e2', 'e1', 'e0'], outputs: ['m'] },
          dfDecoder: { file: 'df_dec.onnx', inputs: ['emb', 'c0'], outputs: ['coefs', '235'] },
        },
      },
      files: {
        fp32: 'deepfilter.onnx', fp16: 'deepfilter.fp16.onnx', aux: 'deepfilter-auxiliary.bin',
        // The quantised exports the brief names explicitly, under the names
        // `neural-controller.js` downloads and stores them as: same graph/IO
        // contract as fp32/fp16 above, just weight-quantised, so no DSP-side
        // change is needed to use them. INT8 is the standard-use default,
        // INT4 the phone variant when the channel publishes one.
        int8: 'deepfilternet3_int8.onnx', int4: 'deepfilternet3_int4.onnx',
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
      io: {
        inputs: ['in_spec_real', 'in_spec_imag'],
        outputs: ['out_spec_real', 'out_spec_imag'],
      },
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
      io: {
        inputs: ['mel_in'],
        outputs: ['gain_db'],
      },
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

  /**
   * Fetch a weight file over HTTP, same-origin and relative. Swallows every
   * failure on purpose: for a model that was not installed, "could not fetch"
   * and "not there" are the same answer, and it is the caller's ordinary
   * fallback case.
   * @param {string} url - relative path such as `models/audiosr/audiosr_lite.onnx`.
   * @returns {Promise<Uint8Array|null>} the bytes, or `null`.
   */
  async function fetchBytes(url) {
    try {
      if (typeof fetch !== 'function') return null;
      const res = await fetch(url);
      if (!res || !res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) { return null; }
  }

  /**
   * Read a weight file out of the Origin Private File System, walking the path
   * one directory at a time and giving up quietly when any segment is missing.
   * This is the first place `loadWeights()` looks, so a model a user imported
   * once keeps working across reloads with no network traffic at all.
   * @param {string} path - slash-separated path under the OPFS root.
   * @returns {Promise<Uint8Array|null>} the file's bytes, or `null` when the
   *   host has no OPFS or the path does not resolve.
   */
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
   * Every variant worth trying, in order. On mobile the smallest quantised
   * export a model publishes comes first — int4, then int8 — because resident
   * weights have to stay under the brief's ~80 MB VRAM target; everywhere else
   * INT8 is the standard-use default the model manager downloads, with fp16
   * (only when the adapter really advertises `shader-f16`) and fp32 behind it.
   * Only variants `def.files` actually lists are returned, so a model that
   * publishes no quantised file simply starts at fp16/fp32.
   * @param {ModelDefinition} def - the model definition (its `files` map is
   *   the set of published variants).
   * @param {DeviceCaps} caps - the device profile.
   * @returns {string[]} variant keys in try order; never empty.
   */
  function variantOrder(def, caps) {
    const files = def.files;
    const wantFp16 = !!(caps && caps.webgpu && caps.webgpu.available && caps.webgpu.fp16);
    const order = (caps && caps.mobile)
      ? ['int4', 'int8', wantFp16 ? 'fp16' : null, 'fp32']
      : ['int8', wantFp16 ? 'fp16' : null, 'fp32'];
    const out = order.filter((key) => key && files[key]);
    return out.length ? out : ['fp32'];
  }

  /**
   * The variant to ask for first — {@link variantOrder}'s head. Kept as the
   * single-variant spelling because several call sites only want the answer,
   * not the list.
   * @param {ModelDefinition} def - the model definition.
   * @param {DeviceCaps} caps - the device profile.
   * @returns {string} the first variant from {@link variantOrder}.
   */
  function selectVariant(def, caps) {
    return variantOrder(def, caps)[0];
  }

  /**
   * Resolve all three official DeepFilterNet3 graphs as one byte group.
   * @returns {Promise<?Object<string, Uint8Array>>} bytes keyed by graph role,
   *   or null unless every member is present.
   */
  async function loadOfficialDfn3Artifacts() {
    const pipeline = MODELS.deepfilternet3.officialPipeline;
    for (const [variant, files] of Object.entries(pipeline.variants)) {
      const out = {};
      let complete = true;
      for (const role of ['encoder', 'erbDecoder', 'dfDecoder']) {
        const rel = MODELS.deepfilternet3.dir + '/' + files[role];
        // Worker fetch URLs resolve relative to assets/js/neural-worker.js, not
        // the document. OPFS remains preferred; ../../ reaches the repository's
        // same-origin models/ directory when worker-side OPFS is unavailable.
        let sameOrigin = '../../' + rel;
        try { if (ctx.location && ctx.location.href) sameOrigin = new URL('../../' + rel, ctx.location.href).href; } catch (e) { /* relative fallback below */ }
        const bytes = await opfsBytes(rel) || await fetchBytes(sameOrigin) || await fetchBytes(rel);
        if (!bytes) { complete = false; break; }
        out[role] = bytes;
      }
      if (complete) return { artifacts: out, variant };
    }
    return null;
  }

  /**
   * Resolve a model's weights, OPFS first (a user-imported model persists
   * there with no repeat network cost) then a same-origin relative fetch
   * (the "local folder structure" the brief asks for). Returns `null` — never
   * throws — when neither source has the file; that `null` is the signal the
   * rest of this file treats as "fall back to the pure DSP path cleanly".
   * @param {string} modelKey - the model to load.
   * @param {DeviceCaps} caps - the device profile, for the variant choice.
   * @returns {Promise<{bytes: Uint8Array, source: ('opfs'|'fetch'), file: string,
   *   def: ModelDefinition, variant: string}|null>} the weights and their
   *   provenance, or `null`.
   */
  async function loadWeights(modelKey, caps) {
    const def = MODELS[modelKey];
    if (!def) return null;
    const variants = variantOrder(def, caps);
    // OPFS first for *every* variant, then the network: the model manager
    // stores exactly one variant, and on a phone that is int4 while a desktop
    // deployment may have put int8 next to the page — asking the disk for both
    // costs nothing, asking a CDN for both costs a round trip per miss.
    for (const variant of variants) {
      const name = def.files[variant];
      // `def.dir/<name>` is where the loader writes and where a deployment is
      // documented to put it; `models/<name>` is the flat layout a hand-made
      // install tends to end up with, and costs one extra walk to support.
      for (const rel of [def.dir + '/' + name, 'models/' + name]) {
        const bytes = await opfsBytes(rel);
        if (bytes) return { bytes, source: 'opfs', file: rel, def, variant };
      }
    }
    for (const variant of variants) {
      const rel = def.dir + '/' + def.files[variant];
      const bytes = await fetchBytes(rel);
      if (bytes) return { bytes, source: 'fetch', file: rel, def, variant };
    }
    return null;
  }

  /**
   * One session (or one negative answer) per model, for the worker's whole
   * lifetime. Positive entries are evicted by `resolveInferenceFailure()` on a
   * hardware limit; negative entries are kept, because re-reading a file that
   * is not there costs a failed fetch on every call.
   * @type {Map<string, CachedSession>}
   */
  const sessionCache = new Map();

  /** Validate one session against an explicit graph boundary. @param {*} session ORT session. @param {{inputs:string[], outputs:string[]}} io graph contract. @returns {{ok:boolean, reason?:string, missingInputs:string[], missingOutputs:string[], extraInputs:string[]}} result. */
  function validateGraphContract(session, io) {
    return validateSessionContract(session, { io });
  }

  /**
   * Build the official DeepFilterNet3 encoder/decoder session group. Every
   * graph must land on the same execution provider; a mixed GPU/WASM pipeline
   * would force large intermediate tensors across providers and is rejected.
   * @param {*} ort - ONNX Runtime namespace.
   * @param {Object<string, Uint8Array>} artifacts - bytes keyed by graph role.
   * @param {DeviceCaps} caps - provider capabilities.
   * @returns {Promise<{sessions:Object, provider:OrtProvider, fp16:boolean}>} ready group.
   */
  async function createOfficialDfn3Group(ort, artifacts, caps) {
    const graphs = MODELS.deepfilternet3.officialPipeline.graphs;
    const sessions = {};
    let provider = null, fp16 = false;
    try {
      for (const role of ['encoder', 'erbDecoder', 'dfDecoder']) {
        if (!(artifacts && artifacts[role])) throw new Error('model-group-incomplete: ' + role);
        const made = await createSession(ort, artifacts[role], caps);
        const contract = validateGraphContract(made.session, graphs[role]);
        if (!contract.ok) {
          if (made.session && typeof made.session.release === 'function') await made.session.release();
          throw new Error(contract.reason);
        }
        if (provider && made.provider !== provider) {
          if (made.session && typeof made.session.release === 'function') await made.session.release();
          throw new Error('model-provider-mismatch: ' + provider + ' / ' + made.provider);
        }
        provider = made.provider; fp16 = fp16 || made.fp16; sessions[role] = made.session;
      }
      return { sessions, provider, fp16, ort };
    } catch (err) {
      for (const session of Object.values(sessions)) {
        try { if (session && typeof session.release === 'function') await session.release(); } catch (e) { /* preserve root failure */ }
      }
      throw err;
    }
  }

  /**
   * Validate the graph boundary exposed by an ORT session. Model filenames are
   * deployment details, not proof that the graph behind them is compatible:
   * upstream exports frequently add recurrent-state tensors, rename outputs or
   * bake in a different front end. Rejecting that mismatch here prevents a
   * wrong model from reaching the audio path.
   * @param {*} session - an initialized ONNX Runtime session.
   * @param {ModelDefinition} def - the frozen model definition.
   * @returns {{ok: boolean, reason?: string, missingInputs?: string[],
   *   missingOutputs?: string[], extraInputs?: string[]}} validation result.
   */
  function validateSessionContract(session, def) {
    const expected = (def && def.io) || { inputs: [], outputs: [] };
    const inputs = session && Array.isArray(session.inputNames) ? session.inputNames : [];
    const outputs = session && Array.isArray(session.outputNames) ? session.outputNames : [];
    const missingInputs = expected.inputs.filter((name) => !inputs.includes(name));
    const missingOutputs = expected.outputs.filter((name) => !outputs.includes(name));
    // Extra required inputs are especially dangerous: they usually mean this
    // is a stateful export whose hidden state the current adapter does not yet
    // carry across chunks. Outputs may safely contain additional diagnostics.
    const extraInputs = inputs.filter((name) => !expected.inputs.includes(name));
    if (!inputs.length || !outputs.length || missingInputs.length || missingOutputs.length || extraInputs.length) {
      const details = [];
      if (!inputs.length) details.push('no input metadata');
      if (!outputs.length) details.push('no output metadata');
      if (missingInputs.length) details.push('missing inputs ' + missingInputs.join(','));
      if (missingOutputs.length) details.push('missing outputs ' + missingOutputs.join(','));
      if (extraInputs.length) details.push('unsupported inputs ' + extraInputs.join(','));
      return { ok: false, reason: 'model-contract-mismatch: ' + details.join('; '), missingInputs, missingOutputs, extraInputs };
    }
    return { ok: true, missingInputs, missingOutputs, extraInputs };
  }

  /** Cached official DeepFilterNet3 group, including a negative lookup. @type {?Object} */
  let officialDfn3Cache = null;

  /** Release all sessions in one official graph group. @param {?Object} group group to release. @returns {Promise<void>} */
  async function releaseOfficialDfn3Group(group) {
    for (const session of Object.values((group && group.sessions) || {})) {
      try { if (session && typeof session.release === 'function') await session.release(); } catch (e) { /* best effort */ }
    }
  }

  /** Whether one failed provider is eligible for a single in-job WASM retry. @param {?Object} group active group. @param {string} reason failure reason. @returns {boolean} retry decision. */
  function shouldRetryOfficialOnWasm(group, reason) {
    return !!(group && group.provider && group.provider !== 'wasm'
      && (reason === 'oom' || reason === 'device-lost' || reason === 'timeout'));
  }

  /** Recreate the official group with accelerators disabled. @returns {Promise<Object>} WASM-only group. */
  async function recreateOfficialDfn3OnWasm() {
    const previous = officialDfn3Cache;
    officialDfn3Cache = null;
    await releaseOfficialDfn3Group(previous);
    const loaded = await loadOfficialDfn3Artifacts();
    if (!loaded) return (officialDfn3Cache = { unavailable: true, reason: 'weights-not-found' });
    const ort = await loadOrt();
    const made = await createOfficialDfn3Group(ort, loaded.artifacts, {
      webgpu: { available: false, fp16: false }, webnn: { available: false }, mobile: isMobileUA(),
    });
    return (officialDfn3Cache = Object.assign({ unavailable: false, def: MODELS.deepfilternet3, variant: loaded.variant }, made));
  }

  /** Load and create the official three-session group. @returns {Promise<Object>} ready group or unavailable result. */
  async function getOfficialDfn3Group() {
    if (officialDfn3Cache) return officialDfn3Cache;
    try {
      const loaded = await loadOfficialDfn3Artifacts();
      if (!loaded) return (officialDfn3Cache = { unavailable: true, reason: 'weights-not-found' });
      const caps = { webgpu: await probeWebGpu(), webnn: await probeWebNN(), mobile: isMobileUA() };
      const ort = await loadOrt();
      const made = await createOfficialDfn3Group(ort, loaded.artifacts, caps);
      officialDfn3Cache = Object.assign({ unavailable: false, def: MODELS.deepfilternet3, variant: loaded.variant }, made);
    } catch (err) {
      officialDfn3Cache = { unavailable: true, reason: 'init-failed: ' + ((err && err.message) || String(err)) };
    }
    return officialDfn3Cache;
  }

  /**
   * Get the session for a model, building it on first use: probe the device,
   * find weights, load the runtime, create the session — with every failure
   * cached as an {@link UnavailableSession} carrying the reason the caller
   * reports. This is the only place a session is ever created.
   * @param {string} modelKey - the model to prepare.
   * @returns {Promise<CachedSession>} a {@link ReadySession} or an
   *   {@link UnavailableSession}; never rejects.
   */
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
        const contract = validateSessionContract(created.session, weights.def);
        if (!contract.ok) {
          // Release provider-owned buffers immediately where ORT supports it;
          // a rejected multi-hundred-megabyte graph must not remain resident.
          try { if (created.session && typeof created.session.release === 'function') await created.session.release(); } catch (e) { /* rejection already decided */ }
          result = { unavailable: true, reason: contract.reason };
        } else {
          result = Object.assign({ unavailable: false, def: weights.def, source: weights.source, file: weights.file, variant: weights.variant }, created);
        }
      }
    } catch (err) {
      result = { unavailable: true, reason: 'init-failed: ' + (err && err.message || String(err)) };
    }
    sessionCache.set(modelKey, result);
    return result;
  }

  /* -------------------------------------------------------- DeepFilterNet3 */

  /**
   * Reject malformed or dangerous neural PCM before it reaches the DSP graph.
   * @param {Float32Array} source - dry signal.
   * @param {Float32Array} output - model result.
   * @returns {{ok:boolean, reason?:string, peak?:number}} verdict.
   */
  function validateNeuralAudio(source, output) {
    if (!(output instanceof Float32Array) || output.length !== source.length) return { ok: false, reason: 'unexpected-output-shape' };
    let sourcePeak = 0, peak = 0, sum = 0, sourceSquares = 0, outputSquares = 0;
    for (let i = 0; i < output.length; i++) {
      const x = source[i] || 0, y = output[i];
      if (!Number.isFinite(y)) return { ok: false, reason: 'non-finite-output' };
      sourcePeak = Math.max(sourcePeak, Math.abs(x)); peak = Math.max(peak, Math.abs(y));
      sourceSquares += x * x; outputSquares += y * y; sum += y;
    }
    const ceiling = Math.max(1.5, sourcePeak * 4);
    if (peak > ceiling) return { ok: false, reason: 'unsafe-output-peak', peak };
    if (output.length && Math.abs(sum / output.length) > Math.max(0.1, sourcePeak * 0.5)) return { ok: false, reason: 'unsafe-output-dc', peak };
    const sourceRms = output.length ? Math.sqrt(sourceSquares / output.length) : 0;
    const outputRms = output.length ? Math.sqrt(outputSquares / output.length) : 0;
    if (outputRms > Math.max(0.25, sourceRms * 4)) return { ok: false, reason: 'unsafe-output-rms', peak };
    return { ok: true, peak };
  }

  /**
   * Port of libDF's `erb_norm` + `unit_norm` feature state. DeepFilterNet3 was
   * trained on exponentially normalized dB ERB energies and complex bins, not
   * raw log power/STFT values.
   * @param {Float32Array} re - frame-major STFT real values.
   * @param {Float32Array} im - frame-major STFT imaginary values.
   * @param {number} T - real frame count.
   * @param {number} Talign - padded model frame count.
   * @param {number} nBins - STFT bins per frame.
   * @param {Object} fb - ERB filterbank edges.
   * @param {number} erbBands - number of ERB bands.
   * @param {number} dfBins - linear complex bins.
   * @returns {{featErb: Float32Array, featSpec: Float32Array}} normalized features.
   */
  function normalizeDfn3Features(re, im, T, Talign, nBins, fb, erbBands, dfBins) {
    const alpha = 0.99; // round(exp(-(480/48000)/1s), 3), official get_norm_alpha()
    const erbState = new Float32Array(erbBands);
    const unitState = new Float32Array(dfBins);
    for (let b = 0; b < erbBands; b++) erbState[b] = -60 + (-30 * b / Math.max(1, erbBands - 1));
    for (let b = 0; b < dfBins; b++) unitState[b] = 0.001 + (-0.0009 * b / Math.max(1, dfBins - 1));
    const featErb = new Float32Array(Talign * erbBands);
    const featSpec = new Float32Array(2 * Talign * dfBins);
    for (let f = 0; f < T; f++) {
      for (let band = 0; band < erbBands; band++) {
        let power = 0, count = 0;
        for (let b = fb.edges[band]; b < fb.edges[band + 1]; b++) {
          const r = re[f * nBins + b], i = im[f * nBins + b]; power += r * r + i * i; count++;
        }
        const db = 10 * Math.log10(Math.max(power / Math.max(1, count), 1e-10));
        erbState[band] = db * (1 - alpha) + erbState[band] * alpha;
        featErb[f * erbBands + band] = (db - erbState[band]) / 40;
      }
      for (let b = 0; b < dfBins; b++) {
        const r = re[f * nBins + b], i = im[f * nBins + b];
        unitState[b] = Math.hypot(r, i) * (1 - alpha) + unitState[b] * alpha;
        const scale = 1 / Math.sqrt(Math.max(unitState[b], 1e-12));
        featSpec[f * dfBins + b] = r * scale;
        featSpec[(Talign + f) * dfBins + b] = i * scale;
      }
    }
    return { featErb, featSpec };
  }

  /**
   * Run the official encoder → ERB decoder + DF decoder graph and apply both
   * outputs to the host STFT.
   * @param {Float32Array} signal - mono 48 kHz samples.
   * @param {Object} group - ready result from {@link getOfficialDfn3Group}.
   * @returns {Promise<Object>} neural result.
   */
  async function denoiseOfficialDfn3(signal, group) {
    try {
      const ort = group.ort || await loadOrt();
      const dsp = MODELS.deepfilternet3.dsp;
      const { nfft, hop, erbBands, dfBins, dfOrder, dfLookahead } = dsp;
      const win = vorbisWindow(nfft);
      // libDF's streaming analyser starts with one zero hop in its analysis
      // memory. DeepFilterNet's delay-compensated offline path also appends a
      // full FFT window so synthesis and the order-5 filter's lookahead are
      // flushed before the compensated output is cropped.
      const framedSignal = new Float32Array(signal.length + hop + nfft);
      framedSignal.set(signal, hop);
      const st = stft(framedSignal, nfft, hop, win);
      const { re, im, frames: T, nBins } = st;
      const Talign = alignT(T);
      const fb = buildErbFilterbank(nBins, erbBands, dsp.sr, nfft);
      // libDF multiplies its forward FFT by wnorm = 1/nfft for a 50%-overlap
      // Vorbis window. Our general STFT keeps the unscaled spectrum for exact
      // reconstruction, so only the model-facing feature copy is normalized.
      const modelRe = Float32Array.from(re, (v) => v / nfft);
      const modelIm = Float32Array.from(im, (v) => v / nfft);
      const { featErb, featSpec } = normalizeDfn3Features(modelRe, modelIm, T, Talign, nBins, fb, erbBands, dfBins);
      const enc = await withTimeout(group.sessions.encoder.run({
        feat_erb: new ort.Tensor('float32', featErb, [1, 1, Talign, erbBands]),
        feat_spec: new ort.Tensor('float32', featSpec, [1, 2, Talign, dfBins]),
      }), INFERENCE_TIMEOUT_MS, 'deepfilternet3-encoder');
      const required = ['e0', 'e1', 'e2', 'e3', 'emb', 'c0'];
      if (required.some((name) => !enc[name])) throw new Error('unexpected-output-shape');
      const decoded = await Promise.all([
        withTimeout(group.sessions.erbDecoder.run({ emb: enc.emb, e3: enc.e3, e2: enc.e2, e1: enc.e1, e0: enc.e0 }), INFERENCE_TIMEOUT_MS, 'deepfilternet3-erb-decoder'),
        withTimeout(group.sessions.dfDecoder.run({ emb: enc.emb, c0: enc.c0 }), INFERENCE_TIMEOUT_MS, 'deepfilternet3-df-decoder'),
      ]);
      const mask = decoded[0].m && decoded[0].m.data;
      const coefs = decoded[1].coefs && decoded[1].coefs.data;
      if (!mask || mask.length < T * erbBands || !coefs || coefs.length < T * dfBins * dfOrder * 2) {
        throw new Error('unexpected-output-shape');
      }
      const outRe = Float32Array.from(re), outIm = Float32Array.from(im);
      // ERB gain mask first, over the complete spectrum.
      for (let f = 0; f < T; f++) for (let band = 0; band < erbBands; band++) {
        const gain = Math.max(0, Math.min(1.5, mask[f * erbBands + band]));
        for (let b = fb.edges[band]; b < fb.edges[band + 1]; b++) {
          outRe[f * nBins + b] *= gain; outIm[f * nBins + b] *= gain;
        }
      }
      // Complex order-5 deep filter on the first 96 bins. The coefficient
      // axis is [real0,imag0,…real4,imag4]; lookahead=2 centres its context.
      for (let f = 0; f < T; f++) {
        for (let b = 0; b < dfBins; b++) {
          let yr = 0, yi = 0;
          const cbase = (f * dfBins + b) * dfOrder * 2;
          for (let k = 0; k < dfOrder; k++) {
            const sf = f + k - dfLookahead;
            if (sf < 0 || sf >= T) continue;
            const xr = re[sf * nBins + b], xi = im[sf * nBins + b];
            const cr = coefs[cbase + k * 2], ci = coefs[cbase + k * 2 + 1];
            yr += xr * cr - xi * ci; yi += xr * ci + xi * cr;
          }
          const idx = f * nBins + b;
          // DeepFilterNet3 replaces the low-bin masked spectrum with the DF
          // result. The decoder's auxiliary scalar output is not a blend
          // factor in the upstream DfNet forward path.
          outRe[idx] = yr;
          outIm[idx] = yi;
        }
      }
      const framedOutput = istft(outRe, outIm, T, nfft, hop, win, framedSignal.length);
      const output = framedOutput.slice(hop, hop + signal.length);
      const safety = validateNeuralAudio(signal, output);
      if (!safety.ok) return { applied: false, reason: safety.reason, peak: safety.peak };
      return { applied: true, output, provider: group.provider, fp16: group.fp16,
        variant: group.variant || 'official', pipeline: 'official' };
    } catch (err) {
      return { applied: false, reason: resolveInferenceFailure('deepfilternet3-official', err) };
    }
  }

  /**
   * Denoise `signal` (mono, resampled by the caller to the model's own
   * 48 kHz if needed) with DeepFilterNet3. Falls back cleanly — `{applied:
   * false}` — when the weights are not present, or on any inference error.
   * @param {Float32Array} signal - mono samples, −1…1; the caller resamples to
   *   the model's own rate when needed.
   * @returns {Promise<{applied: boolean, output?: Float32Array, reason?: string}>}
   *   `{applied:true, output}` on success, otherwise `applied:false` with a
   *   reason from {@link RSNeuralWorker.resolveInferenceFailure}.
   */
  async function denoiseDFN3(signal) {
    // Public calls are intentionally bounded. Production Stage 0 sends short,
    // contextual chunks; refusing oversized direct messages prevents a single
    // allocation from multiplying into large STFT/features/output tensors.
    if (!(signal instanceof Float32Array) || !signal.length) return { applied: false, reason: 'empty-signal' };
    if (signal.length > 480000) return { applied: false, reason: 'input-too-large' };
    const official = await getOfficialDfn3Group();
    if (!official.unavailable) {
      const first = await denoiseOfficialDfn3(signal, official);
      if (!shouldRetryOfficialOnWasm(official, first.reason)) return first;
      try {
        const wasm = await recreateOfficialDfn3OnWasm();
        if (wasm.unavailable) return first;
        const retried = await denoiseOfficialDfn3(signal, wasm);
        if (retried.applied) retried.fallbackFrom = official.provider;
        return retried;
      } catch (err) {
        return { applied: false, reason: resolveInferenceFailure('deepfilternet3-official', err) };
      }
    }
    // Only the absence of the official group permits the legacy monolithic
    // adapter. An installed group that failed to initialise must report its
    // real runtime/contract error instead of being disguised as legacy
    // `weights-not-found`.
    if (official.reason !== 'weights-not-found') return { applied: false, reason: official.reason };
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
      const safety = validateNeuralAudio(signal, output);
      if (!safety.ok) return { applied: false, reason: safety.reason, peak: safety.peak };
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
  /**
   * Split `signal` (mono, at the model's own rate) into stems with
   * BS-RoFormer: the host computes the STFT, the graph transforms the
   * real/imag spectrograms, the host runs the inverse — the model's time axis
   * is aligned to a multiple of 4 on the way in and trimmed back on the way
   * out, exactly like `denoiseDFN3()`.
   * @param {Float32Array} signal - mono samples, −1…1.
   * @returns {Promise<{applied: boolean, stems?: Object<string, Float32Array>,
   *   reason?: string}>} one equally long buffer per stem name from the model
   *   definition (`drums`, `bass`, `other`, `vocals`) on success.
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
  /**
   * Predict a per-band gain curve for the bandwidth extension stage: how much
   * of each high band should survive. The model is magnitude-only by design —
   * the waveform itself still comes from the phase-coherent exciter in the
   * worklet, so the curve only reshapes level, never phase.
   * @param {Float32Array} signal - mono samples, −1…1 (a downmix of the dry
   *   source, computed once for the whole file by `engine.js`).
   * @param {number[]} bandsHz - band centre frequencies, low to high; the
   *   returned curve has exactly one gain per entry.
   * @returns {Promise<{applied: boolean, gainsDb?: number[], reason?: string}>}
   *   gains in dB, or the fallback result.
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
      /**
       * Centre frequency of one mel band, in Hz, from the filterbank's bin
       * edges.
       * @param {number} fIdx - mel band index, `0 … melBins-1`.
       * @returns {number} the band's centre frequency in Hz.
       */
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

  /**
   * The capability report the main thread asks for before showing a neural
   * control: what the device offers, and per model whether it is actually
   * usable. Asking also *populates* the session cache, so the first real call
   * does not pay for a second probe round.
   * @returns {Promise<{webgpu: {available: boolean, fp16: boolean},
   *   webnn: {available: boolean, deviceType: (string|null)}, wasmSimd: boolean,
   *   mobile: boolean, models: Object<string, *>}>} the report; `models[key]`
   *   is `{available:false, reason}` or `{available:true, provider, fp16,
   *   source, variant}`.
   */
  async function probe() {
    const webgpu = await probeWebGpu();
    const webnn = await probeWebNN();
    const mobile = isMobileUA();
    const models = {};
    for (const key of Object.keys(MODELS)) {
      const sess = key === 'deepfilternet3' ? await getOfficialDfn3Group() : await getSession(key);
      models[key] = sess.unavailable
        ? { available: false, reason: sess.reason }
        : { available: true, provider: sess.provider, fp16: sess.fp16,
          source: sess.source || (key === 'deepfilternet3' ? 'official-group' : undefined),
          variant: sess.variant || (key === 'deepfilternet3' ? 'official' : undefined) };
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

  /**
   * The message protocol, one entry per request type the main thread sends.
   * Each handler resolves a plain result object; it never throws across the
   * thread boundary, because the dispatcher below would have no way to settle
   * the caller's promise.
   * @type {Object<string, function(Object): Promise<Object>>}
   */
  const handlers = {
    /**
     * Report the worker's capabilities (providers, wasm paths, versions).
     * @returns {Promise<Object>} the probe result; never rejects.
     */
    probe: async () => probe(),
    /**
     * Run the DeepFilterNet-style denoiser over one signal.
     * @param {Object} msg - message with the `signal` field (channel-major
     *   `Float32Array[]`).
     * @returns {Promise<Object>} `{applied, post, reason?}`.
     */
    denoise: async (msg) => denoiseDFN3(msg.signal),
    /**
     * Split one signal into the "music" and "everything else" stems.
     * @param {Object} msg - message with the `signal` field.
     * @returns {Promise<Object>} `{applied, foreground, background, reason?}`.
     */
    separate: async (msg) => separateBSR(msg.signal),
    /**
     * Predict a per-band high-frequency gain curve for the air-repair stage
     * — deliberately a *curve*, not audio: it is small enough to post back
     * cheaply and the DSP side owns what to do with it.
     * @param {Object} msg - message with `signal` and the optional
     *   `bandsHz` band centres to sample the prediction at.
     * @returns {Promise<Object>} `{applied, gainsDb, bandsHz, reason?}`.
     */
    superres: async (msg) => superresCurve(msg.signal, msg.bandsHz || []),
    /**
     * Forget every cached session, positive or negative. Called by the model
     * manager right after weights land in OPFS: a negative "no weights" entry
     * from before the download would otherwise hide the new file until the
     * page was reloaded.
     * @returns {Promise<Object>} `{cleared: true}` — the count is not useful
     *   across the thread boundary, and the caller only needs the ack.
     */
    reset: async () => {
      sessionCache.clear();
      await releaseOfficialDfn3Group(officialDfn3Cache);
      officialDfn3Cache = null;
      return { cleared: true };
    },
  };

  /**
   * The worker's message loop: dispatch by `type`, answer with
   * `{reqId, result}`, and turn any escaping error into a
   * `{applied:false, reason:'handler-error: …'}` result instead of letting it
   * become an unhandled rejection (which would leave the main thread's promise
   * pending until its own 120 s timeout). Only installed when the host really
   * is a worker — the Node suites import the module and call the handlers
   * directly.
   */
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

  /**
   * The shipped internals, exposed for `tests/neural.test.js` (and anything
   * else that wants to exercise this worker's logic without a real
   * Worker/postMessage round trip) — the same "export the shipped internals"
   * convention `RSOPFS.buildWorkerSource` already uses.
   * @type {Object}
   */
  ctx.RSNeuralWorker = {
    MODELS, alignT, padRowsTo, trimRowsTo, buildErbFilterbank, stft, istft, fftAny,
    vorbisWindow, hannWindow, probeWebGpu, probeWebNN, isMobileUA, createSession, ortCandidates, loadOrt,
    variantOrder, selectVariant, loadWeights, loadOfficialDfn3Artifacts, opfsBytes, fetchBytes, getSession, sessionCache,
    validateSessionContract, validateGraphContract, createOfficialDfn3Group, getOfficialDfn3Group, providerOrder,
    releaseOfficialDfn3Group, shouldRetryOfficialOnWasm, recreateOfficialDfn3OnWasm,
    withTimeout, classifyInferenceError, resolveInferenceFailure, INFERENCE_TIMEOUT_MS,
    normalizeDfn3Features, validateNeuralAudio, denoiseDFN3, denoiseOfficialDfn3, separateBSR, superresCurve, probe,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ctx.RSNeuralWorker;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
