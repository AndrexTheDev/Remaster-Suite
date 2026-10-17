/* =============================================================================
 * Remaster Suite — main-thread handle onto neural-worker.js
 * -----------------------------------------------------------------------------
 * A thin Promise wrapper around the dedicated Worker in `neural-worker.js`,
 * in the same spirit as `RSOPFS`'s relationship to its own worker: the main
 * thread never touches onnxruntime-web, WebGPU or a tensor directly, it only
 * calls a method and gets a plain result object back.
 *
 * Every call here resolves — it never rejects. A worker that fails to start,
 * a message that times out, or a model that is not installed all come back
 * as the same shape the worker itself uses, `{applied: false, reason}`, so a
 * call site (`engine.js`, `app.js`) needs exactly one `if (!result.applied)`
 * to fall back to the pure DSP path, never a try/catch.
 *
 * A subset of those reasons — `oom`, `device-lost`, `timeout` — are not just
 * "nothing installed", they mean a call actually started on real hardware
 * and that hardware gave up mid-inference: a memory/thermal throttle event,
 * exactly what the mobile brief's requirement 3 describes. Those are
 * reported twice: once in the resolved result (so the pure-DSP fallback it
 * already triggers needs no new code), and once through
 * `onHardwareFallback(cb)`, a tiny pub/sub `app.js` uses to surface exactly
 * one quiet UI toast instead of leaving the user to wonder why a render
 * "went plain" with no explanation.
 * ========================================================================== */
/**
 * @fileoverview Main-thread handle onto the neural worker, exposed as the
 * global `RSNeural` (`globalThis.RSNeural`).
 *
 * Owns the whole call lifecycle: lazy worker spawn, one request id per call, a
 * 120 s per-call timeout, promise settlement, and the lifetime of the pending
 * map. Nothing about inference itself lives here — the worker does that — and
 * nothing about *using* a result lives here either: call sites read
 * {@link NeuralResult} and fall back to pure DSP on `applied === false`.
 *
 * Contract, in one sentence: **every method resolves, none rejects.** A
 * missing worker, a dead postMessage, a timeout, a model that was never
 * installed and a hardware limit all arrive at the caller as the same
 * {@link NeuralResult} shape, so no call site needs a `try`/`catch` to stay
 * alive.
 *
 * @module RSNeural
 */
(function (global) {
  'use strict';

  /**
   * Repository-relative path of the dedicated worker script. Resolved against
   * `location.href` before use ({@link RSNeural.resolveUrl}), because a relative
   * `new Worker(...)` URL resolves against the document in browsers but the
   * tests exercise this module without a `location`.
   */
  const WORKER_URL = 'assets/js/neural-worker.js';
  /**
   * Per-call timeout in milliseconds. Generous on purpose: a first WASM
   * inference on a phone legitimately takes tens of seconds (driver compile),
   * and a timeout here is *reported*, never retried.
   * @type {number}
   */
  const CALL_TIMEOUT_MS = 120000;

  /**
   * The subset of {@link NeuralReason} values that mean *a call was attempted
   * and the hardware gave out*, rather than *nothing was installed* or *the
   * feature was torn down*. Only these fire {@link RSNeural.onHardwareFallback};
   * a quiet UI toast is for a phone that gave up mid-inference, not for a
   * feature the user never installed.
   * @type {Set<NeuralReason>}
   */
  const HARDWARE_LIMIT_REASONS = new Set(['oom', 'device-lost', 'timeout']);

  /**
   * The single live worker for this page, or `null` before the first call (and
   * again after {@link RSNeural.dispose}). Spawned lazily so a page that never
   * uses a neural feature opens zero extra threads.
   * @type {Worker|null}
   */
  let worker = null;
  /**
   * Monotonic request id. Never reused, so a late answer from a timed-out call
   * finds no {@link PendingSlot} for its id and is dropped instead of resolving
   * a newer call's promise.
   * @type {number}
   */
  let reqSeq = 0;
  /**
   * In-flight calls, keyed by request id: the resolver and the timeout handle
   * that must be cleared when the answer (or the failure) arrives.
   * @type {Map<number, PendingSlot>}
   */
  const pending = new Map();
  /**
   * Subscribers registered through {@link RSNeural.onHardwareFallback}.
   * @type {Set<function(string): void>}
   */
  const fallbackListeners = new Set();

  /**
   * One in-flight call, as kept in the `pending` map.
   * @typedef {Object} PendingSlot
   * @property {function(NeuralResult): void} resolve - settles the caller's
   *   promise; called exactly once per call, from whichever of the four exits
   *   (worker answer, worker error, timeout, dispose) happens first.
   * @property {number} timer - handle returned by `setTimeout`, cleared on every
   *   exit but the timeout itself.
   */

  /**
   * The single result shape every method on this module resolves with. The
   * worker's own vocabulary, deliberately not translated here: `applied` is the
   * only field a caller has to branch on, `reason` is what the UI shows and
   * what {@link NeuralReason} enumerates.
   * @typedef {Object} NeuralResult
   * @property {boolean} applied - `true` when the neural stage really ran and
   *   produced usable output; `false` for every fallback.
   * @property {NeuralReason|string} [reason] - present exactly when `applied` is
   *   `false`; see {@link NeuralReason} for the closed set, plus two dynamic
   *   spellings (`'post-failed: …'`, `'handler-error: …'`).
   * @property {Float32Array|Object} [output] - mono channel of denoised audio
   *   (`denoise()` only), same length as the input.
   * @property {Object<string, Float32Array>} [stems] - named stem buffers
   *   (`separate()` only); names come from the worker's BS-RoFormer handler.
   * @property {Float64Array|number[]} [gainsDb] - per-band gain curve in dB,
   *   one entry per band of the `bandsHz` array that was passed in
   *   (`superres()` only).
   */

  /**
   * The closed set of fallback reasons this module can produce or pass through.
   * Two of them are *not* in {@link HARDWARE_LIMIT_REASONS} on purpose:
   * `timeout` is a hardware limit (the call was attempted and the machine gave
   * out), while `worker-unavailable`, `worker-error`, `disposed` and
   * `weights-not-found` mean the work never started.
   * @typedef {'worker-unavailable'|'worker-error'|'post-failed'|'timeout'|
   *   'disposed'|'oom'|'device-lost'|'weights-not-found'|'init-failed'|
   *   'unexpected-output-shape'|'inference-error'} NeuralReason
   */

  /**
   * The reasons that arrive from the worker itself rather than from this
   * wrapper: `'oom'` and `'device-lost'` are classified from a thrown inference
   * error by the worker's own `resolveInferenceFailure()`, and
   * `'weights-not-found'` is what a model that was never installed answers.
   * They are listed here so the two halves of the contract can be diffed by
   * eye and by `tests/neural.test.js`.
   * @enum {string}
   */
  const WORKER_REASONS = Object.freeze({
    OOM: 'oom',
    DEVICE_LOST: 'device-lost',
    TIMEOUT: 'timeout',
    WEIGHTS_NOT_FOUND: 'weights-not-found',
  });

  /**
   * Fan a hardware-limit fallback out to every subscriber. A listener that
   * throws is swallowed: this is a notification channel, and a broken toast
   * must never break the render that triggered it.
   * @param {NeuralResult} result - the result about to be resolved; ignored
   *   unless `applied === false` and its reason is in
   *   {@link HARDWARE_LIMIT_REASONS}.
   * @returns {void}
   */
  function maybeNotifyFallback(result) {
    if (!result || result.applied !== false || !HARDWARE_LIMIT_REASONS.has(result.reason)) return;
    for (const cb of fallbackListeners) { try { cb(result.reason); } catch (e) { /* a bad listener must not break the pipeline */ } }
  }

  /**
   * The one way a call ends: notify (if it was a hardware limit), then resolve.
   * Ordering matters — the UI toast is emitted before the caller's promise
   * continues, so `app.js` never sees a finished render without its
   * explanation.
   * @param {function(NeuralResult): void} resolve - the pending call's resolver.
   * @param {NeuralResult} result - the final result.
   * @returns {void}
   */
  function settle(resolve, result) {
    maybeNotifyFallback(result);
    resolve(result);
  }

  /**
   * Absolutise a relative script path, so `new Worker(...)` works from a page
   * in a sub-folder (GitHub Pages project sites) as well as from the tests,
   * which run with no `location` at all.
   * @param {string} rel - repository-relative path.
   * @returns {string} an absolute URL, or `rel` unchanged when there is no
   *   `location` or the `URL` constructor rejects it.
   */
  function resolveUrl(rel) {
    if (!global.location) return rel;
    try { return new URL(rel, global.location.href).href; } catch (e) { return rel; }
  }

  /**
   * Spawn the worker on first use, or return the live one. Also installs the
   * two listeners that make a dead worker survivable: `message` settles the
   * matching {@link PendingSlot}, and `error` settles *all* of them with
   * `'worker-error'` — a crashed worker must not leave callers waiting for a
   * timeout that is two minutes away.
   * @returns {Worker|null} the worker, or `null` when the host has no `Worker`
   *   constructor or the construction threw (both are ordinary conditions in
   *   the Node suites and on locked-down browsers).
   */
  function ensureWorker() {
    if (worker) return worker;
    if (typeof global.Worker !== 'function') return null;
    try {
      worker = new global.Worker(resolveUrl(WORKER_URL));
    } catch (err) {
      worker = null;
      return null;
    }
    worker.addEventListener('message', (ev) => {
      const { reqId, result, error } = ev.data || {};
      const slot = pending.get(reqId);
      if (!slot) return;
      pending.delete(reqId);
      global.clearTimeout(slot.timer);
      settle(slot.resolve, error ? { applied: false, reason: error } : result);
    });
    worker.addEventListener('error', () => {
      // a worker-level error (e.g. a syntax error reached production) fails
      // every outstanding call cleanly rather than hanging them forever
      for (const [id, slot] of pending) {
        global.clearTimeout(slot.timer);
        settle(slot.resolve, { applied: false, reason: 'worker-error' });
        pending.delete(id);
      }
    });
    return worker;
  }

  /**
   * Post one request to the worker and resolve with its {@link NeuralResult}.
   * Never rejects; every failure path below resolves a fallback result instead.
   * @param {string} type - worker message type: `'probe'`, `'denoise'`,
   *   `'separate'`, `'superres'`.
   * @param {Object} [payload] - handler arguments, merged into the envelope
   *   alongside `type` and `reqId`.
   * @param {Transferable[]} [transfer] - buffers to hand over rather than copy;
   *   must contain the `ArrayBuffer`s of the signals in `payload`, or the
   *   worker receives a detached view.
   * @returns {Promise<NeuralResult>} the worker's result, or
   *   `{applied:false, reason}` for `'worker-unavailable'`, `'timeout'` or
   *   `'post-failed: …'`.
   */
  function call(type, payload, transfer) {
    return new Promise((resolve) => {
      const w = ensureWorker();
      if (!w) { resolve({ applied: false, reason: 'worker-unavailable' }); return; }
      const reqId = ++reqSeq;
      const timer = global.setTimeout(() => {
        pending.delete(reqId);
        settle(resolve, { applied: false, reason: 'timeout' });
      }, CALL_TIMEOUT_MS);
      pending.set(reqId, { resolve, timer });
      try {
        w.postMessage(Object.assign({ type, reqId }, payload), transfer || []);
      } catch (err) {
        pending.delete(reqId);
        global.clearTimeout(timer);
        resolve({ applied: false, reason: 'post-failed: ' + (err && err.message) });
      }
    });
  }

  /* ====================================================================== *
   * The model manager — first start, the CDN, and the OPFS cache
   * ====================================================================== */

  /**
   * Where a model's weight files live inside the OPFS root. The same string
   * `opfs-manager.js` writes under and `neural-worker.js` reads from; the
   * suite asserts that all three agree rather than trusting the comment.
   * @type {string}
   */
  const MODELS_DIR = 'models';

  /**
   * Every weight file this build knows how to fetch, per model key and
   * variant. The file names are the worker's own (`neural-worker.js`'s
   * `MODELS`), kept here as well because this module has to name the file
   * *before* a worker exists — and cross-checked by `tests/neural.test.js` so
   * the two lists cannot drift apart.
   * @type {Object<string, Object<string, string>>}
   */
  const MODEL_FILES = Object.freeze({
    deepfilternet3: Object.freeze({
      int8: 'deepfilternet3_int8.onnx',
      int4: 'deepfilternet3_int4.onnx',
      fp32: 'deepfilter.onnx',
      fp16: 'deepfilter.fp16.onnx',
    }),
  });

  /**
   * Variant preference, smallest-first: a phone gets INT4 when the channel
   * publishes it and INT8 otherwise, a desktop takes INT8 (the prompt's
   * "standard use" quantisation) and never falls back to fp32 on its own — a
   * 40 MB download is the user's decision, not a default.
   * @param {boolean} mobile - the device looks like a phone or tablet.
   * @returns {string[]} variant keys in try order.
   */
  function preferredVariants(mobile) {
    return mobile ? ['int4', 'int8'] : ['int8'];
  }

  /**
   * The project's own model channel. A deployment can point this anywhere —
   * `RSNeural.setModelSource()`, or `<meta name="rs-model-cdn" content="…">`
   * in the page — and the beta suite points it at a local fixture server to
   * prove the whole path without touching the internet.
   * @type {string}
   */
  const DEFAULT_MODEL_BASE = 'https://cdn.jsdelivr.net/gh/AndrexTheDev/Remaster-Suite@models';

  /**
   * Where weights are looked for, in order. `'models'` is a relative base and
   * deliberately second: a deployment that ships its own weights next to the
   * page answers that request without leaving the origin, and the CDN is the
   * standard path. Replaced wholesale by {@link RSNeural.setModelSource}.
   * @type {string[]}
   */
  let modelSources = [DEFAULT_MODEL_BASE, 'models'];

  /**
   * A deployment can point the channel somewhere else without editing this
   * file: `<meta name="rs-model-cdn" content="https://example.org/models">`.
   * Read once, at load — a meta tag that appears later is what
   * {@link RSNeural.setModelSource} is for.
   * @returns {void}
   */
  (function readMetaSource() {
    const d = global.document;
    if (!d || typeof d.querySelector !== 'function') return;
    const meta = d.querySelector('meta[name="rs-model-cdn"]');
    const content = meta && meta.getAttribute('content');
    if (content && content.trim()) modelSources = [content.trim()];
  })();

  /**
   * Resolve `<base>/<model>/<file>`. A base that already ends in a slash is
   * accepted, so `https://host/models/` and `https://host/models` mean the
   * same thing — the kind of difference that otherwise shows up as a 404 on a
   * doubled slash.
   * @param {string} base - the source base URL.
   * @param {string} model - model key.
   * @param {string} file - weight file name.
   * @returns {string} the absolute (or page-relative) URL to fetch.
   */
  function modelUrl(base, model, file) {
    return String(base).replace(/\/+$/, '') + '/' + model + '/' + file;
  }

  /**
   * One step of a model download, as handed to {@link RSNeural.onModelProgress}
   * listeners and to `ensureModel()`'s own `onProgress`.
   * @typedef {Object} ModelProgress
   * @property {string} model - model key.
   * @property {string} variant - `'int8'`, `'int4'`, …
   * @property {('download'|'done'|'failed')} phase - what is happening.
   * @property {number} loaded - bytes received so far.
   * @property {number} total - bytes expected (0 when the server sent no
   *   `Content-Length`).
   * @property {number} ratio - 0…1, `loaded/total` when the total is known and
   *   a saturating estimate otherwise — what a progress bar draws.
   * @property {string} [url] - the source being read, when there is one.
   */

  /**
   * What {@link RSNeural.ensureModel} resolves with. Always resolves — a
   * download that fails every source is an answer with a reason, never a
   * rejection, exactly like every other method on this module.
   * @typedef {Object} ModelStatus
   * @property {boolean} ready - the weight file is in OPFS and usable.
   * @property {string} key - model key.
   * @property {('opfs'|'network')} [source] - where it came from this time.
   * @property {string} [variant] - the variant that is now stored.
   * @property {string} [path] - `models/<model>/<file>`.
   * @property {number} [bytes] - its size.
   * @property {string} [url] - the URL it was downloaded from, when it was.
   * @property {string} [reason] - present when `ready` is false.
   */

  /**
   * Subscribers registered through {@link RSNeural.onModelProgress}.
   * @type {Set<function(ModelProgress): void>}
   */
  const modelListeners = new Set();
  /**
   * Downloads in flight, keyed `model:variant`, so two callers that ask for
   * the same model at the same moment share one download instead of racing
   * two into the same OPFS file.
   * @type {Map<string, Promise<ModelStatus>>}
   */
  const modelInflight = new Map();

  /**
   * Fan one progress step out to every listener and to the caller's own
   * callback. A listener that throws is swallowed: this is a progress bar, not
   * a step of the download.
   * @param {ModelProgress} p - the step.
   * @param {function(ModelProgress=): void} [own] - the caller's callback.
   * @returns {void}
   */
  function emitModelProgress(p, own) {
    if (typeof own === 'function') { try { own(p); } catch (e) { /* a UI callback must not break the download */ } }
    for (const cb of modelListeners) { try { cb(p); } catch (e) { /* same */ } }
  }

  /**
   * The model store, or `null` when this host has no `RSOPFS` at all. Read
   * lazily on every use so tests (and a page that loads the modules in another
   * order) can install the global after this file has been evaluated.
   * @returns {?ModelStore} `globalThis.RSOPFS.models`.
   */
  function modelStore() {
    const opfs = global.RSOPFS;
    return opfs && opfs.models ? opfs.models : null;
  }

  /**
   * Tell the worker to forget the sessions it built from a *negative* answer.
   * `getSession()` caches "no weights" so a missing model is not re-read on
   * every call — which would hide a model that has just been downloaded.
   * Best effort: with no worker running there is no cache to clear.
   * @returns {Promise<void>} resolves whether or not a worker answered.
   */
  async function resetWorkerSessions() {
    try { await call('reset', {}); } catch (e) { /* no worker, nothing cached */ }
  }

  /**
   * Stream one weight file from a URL into the model store, reporting progress
   * as it goes. Writes in the response's own chunks (a quantised model is a
   * few MB; a 64 KiB reader buffer would make thousands of round trips).
   *
   * Failure is all-or-nothing: a short read, an HTML error page and an empty
   * body each abort the write and delete the partial file, so a failed
   * download can never be mistaken for a cached model on the next start.
   * @param {string} url - where to read.
   * @param {string} key - model key.
   * @param {string} file - weight file name.
   * @param {string} variant - variant key, for the progress events.
   * @param {ModelStore} store - the model store.
   * @param {function(ModelProgress): void} emit - progress sink.
   * @returns {Promise<{bytes: number}>} the size that landed in OPFS.
   * @throws {Error} the HTTP status, the short read, or the body sanity
   *   failure — the caller records it and tries the next source.
   */
  async function downloadToStore(url, key, file, variant, store, emit) {
    const res = await global.fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 'no response') + ' · ' + url);
    const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
    if (/text\/html/i.test(type)) throw new Error('answered with HTML, not a model · ' + url);
    const total = Number((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-length')) || 0) || 0;
    const writer = await store.createWriter(key, file);
    let loaded = 0;
    let head = null;
    /** Write one chunk and report it. @param {Uint8Array} chunk - bytes. @returns {Promise<void>} */
    const put = async (chunk) => {
      if (!chunk || !chunk.length) return;
      // count before writing: the store hands the buffer to its worker with
      // `transfer`, which detaches the view we pass in — reading `.length`
      // afterwards would always be 0 and a whole download would look empty
      const n = chunk.length;
      if (!head) head = chunk.slice(0, 4);
      await writer.write(chunk);
      loaded += n;
      emit({ model: key, variant, phase: 'download', loaded, total,
        ratio: total ? Math.min(0.999, loaded / total) : Math.min(0.95, loaded / (loaded + 262144)), url });
    };
    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          await put(step.value instanceof Uint8Array ? step.value : new Uint8Array(step.value));
        }
      } else {
        const all = new Uint8Array(await res.arrayBuffer());
        for (let off = 0; off < all.length; off += 262144) await put(all.subarray(off, off + 262144));
      }
      if (!loaded) throw new Error('empty response · ' + url);
      // an HTML error page served with a 200 is the classic CDN failure; ONNX
      // is protobuf and never starts with '<'
      if (head && head[0] === 0x3c) throw new Error('the body is HTML, not a model · ' + url);
      if (total && loaded !== total) throw new Error('short read: ' + loaded + ' of ' + total + ' bytes · ' + url);
      await writer.close();
      return { bytes: loaded };
    } catch (err) {
      await writer.abort();
      throw err;
    }
  }

  /**
   * The body of {@link RSNeural.ensureModel}: check the cache, then try every
   * configured source for every preferred variant, then report.
   * @param {string} key - model key.
   * @param {Object} opts - the caller's options.
   * @returns {Promise<ModelStatus>} the outcome; never rejects.
   */
  async function runEnsureModel(key, opts) {
    const files = MODEL_FILES[key];
    if (!files) return { ready: false, key, reason: 'unknown-model: ' + key };
    const store = modelStore();
    if (!store) return { ready: false, key, reason: 'no-store' };
    const variants = opts.variant ? [opts.variant] : preferredVariants(!!opts.mobile);
    const missing = variants.filter((v) => !files[v]);
    if (missing.length === variants.length) return { ready: false, key, reason: 'unknown-variant: ' + variants.join(',') };

    // 1 · the cache: a file that is already there costs no network at all
    for (const variant of variants) {
      if (!files[variant]) continue;
      const st = await store.stat(key, files[variant]);
      if (st.exists && st.size > 0) {
        emitModelProgress({ model: key, variant, phase: 'done', loaded: st.size, total: st.size, ratio: 1 }, opts.onProgress);
        return { ready: true, key, source: 'opfs', variant, path: st.path, bytes: st.size };
      }
    }

    // 2 · the network: each source × each variant, first usable answer wins
    const errors = [];
    for (const variant of variants) {
      if (!files[variant]) continue;
      for (const base of modelSources) {
        const url = modelUrl(base, key, files[variant]);
        try {
          const { bytes } = await downloadToStore(url, key, files[variant], variant, store, (p) => emitModelProgress(p, opts.onProgress));
          await resetWorkerSessions();
          emitModelProgress({ model: key, variant, phase: 'done', loaded: bytes, total: bytes, ratio: 1, url }, opts.onProgress);
          return { ready: true, key, source: 'network', variant, path: store.path(key, files[variant]), bytes, url };
        } catch (err) {
          errors.push(String((err && err.message) || err));
        }
      }
    }
    const reason = 'download-failed: ' + (errors[0] || 'no source configured');
    emitModelProgress({ model: key, variant: variants[0], phase: 'failed', loaded: 0, total: 0, ratio: 0 }, opts.onProgress);
    return { ready: false, key, reason };
  }

  /**
   * Make sure a model's weights are in OPFS, downloading them if they are not.
   * This is the whole first-start story: the result is the same whether the
   * bytes were already on disk or arrived over the network just now, and a
   * failure is a `{ready:false, reason}` answer like every other fallback on
   * this module — never a rejection, never a half-written model left behind.
   * @param {string} [key='deepfilternet3'] - model key.
   * @param {Object} [opts] - options.
   * @param {string} [opts.variant] - force one variant instead of the
   *   device's preference order.
   * @param {boolean} [opts.mobile] - treat this as a phone (prefer INT4).
   *   Defaults to what `navigator` says.
   * @param {function(ModelProgress): void} [opts.onProgress] - per-chunk
   *   progress, in addition to the global listeners.
   * @returns {Promise<ModelStatus>} the outcome.
   */
  function ensureModel(key, opts) {
    const k = key || 'deepfilternet3';
    const o = opts || {};
    const mobile = typeof o.mobile === 'boolean' ? o.mobile : isMobileNavigator();
    const cacheKey = k + ':' + (o.variant || (mobile ? 'mobile' : 'desktop'));
    const running = modelInflight.get(cacheKey);
    if (running) return running;
    const p = runEnsureModel(k, Object.assign({}, o, { mobile }))
      .catch((err) => ({ ready: false, key: k, reason: 'download-failed: ' + (err && err.message || String(err)) }))
      .finally(() => { modelInflight.delete(cacheKey); });
    modelInflight.set(cacheKey, p);
    return p;
  }

  /**
   * Is this device a phone or tablet, from the same regex the worker uses?
   * Kept local because `ensureModel()` must answer before any worker exists.
   * @returns {boolean} `true` for a mobile user agent.
   */
  function isMobileNavigator() {
    const ua = (global.navigator && global.navigator.userAgent) || '';
    return /Mobi|Android|iPhone/i.test(ua);
  }

  /**
   * What is cached right now, without touching the network — the question the
   * settings row asks on boot.
   * @param {string} [key='deepfilternet3'] - model key.
   * @returns {Promise<{key: string, cached: boolean, variants: Object<string,
   *   {cached: boolean, size: number, path: string}>}>} the cache report; an
   *   empty `variants` map when this host has no model store.
   */
  async function modelStatus(key) {
    const k = key || 'deepfilternet3';
    const files = MODEL_FILES[k] || {};
    const store = modelStore();
    const variants = {};
    let cached = false;
    for (const variant of Object.keys(files)) {
      const st = store ? await store.stat(k, files[variant]) : { exists: false, size: 0, path: MODELS_DIR + '/' + k + '/' + files[variant] };
      variants[variant] = { cached: !!st.exists, size: st.size || 0, path: st.path };
      if (st.exists) cached = true;
    }
    return { key: k, cached, variants };
  }

  /**
   * The public surface, assigned to `global.RSNeural` below. Every method
   * resolves a {@link NeuralResult}; none of them ever rejects.
   * @typedef {Object} RSNeuralApi
   * @property {function(function(string): void): function(): void} onHardwareFallback
   * @property {function(): void} dispose
   * @property {function(): Promise<Object>} probe
   * @property {function(Float32Array): Promise<NeuralResult>} denoise
   * @property {function(Float32Array): Promise<NeuralResult>} separate
   * @property {function(Float32Array, number[]=): Promise<NeuralResult>} superres
   * @property {function(string=, Object=): Promise<ModelStatus>} ensureModel
   * @property {function(string=): Promise<Object>} modelStatus
   * @property {function(function(ModelProgress): void): function(): void} onModelProgress
   * @property {function((string|string[]|null)): string[]} setModelSource
   * @property {function(): string[]} getModelSource
   * @property {function(): boolean} canLoadModels
   * @property {Object} MODEL_FILES
   * @property {string} modelDir
   */

  /** @type {RSNeuralApi} */
  const API = {
    /**
     * Subscribe to hardware-limit fallbacks (`oom`/`device-lost`/`timeout` —
     * see HARDWARE_LIMIT_REASONS above). Returns an unsubscribe function.
     * Fires at most once per failing call, after that call's own promise has
     * already resolved `{applied:false, reason}` to its caller — this is
     * purely a notification channel for UI feedback, never part of the
     * )→ `if (!result.applied)`
     * @param {function(NeuralReason): void} cb - subscriber; called with the
     *   raw reason string. A non-function argument is tolerated and produces a
     *   no-op unsubscribe.
     * @returns {function(): void} `unsubscribe()` — idempotent.
     */
    onHardwareFallback(cb) {
      if (typeof cb !== 'function') return () => {};
      fallbackListeners.add(cb);
      return () => fallbackListeners.delete(cb);
    },

    /**
     * Tear the worker down and settle every in-flight call with
     * `'disposed'`. Used when the user turns the neural feature off; the next
     * call spawns a fresh worker, so the module stays usable afterwards. Safe
     * to call twice, and safe to call before any call was ever made.
     * @returns {void}
     */
    dispose() {
      if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
      for (const [id, slot] of pending) { global.clearTimeout(slot.timer); slot.resolve({ applied: false, reason: 'disposed' }); pending.delete(id); }
    },

    /**
     * Ask the worker what this device can do: WebGPU availability and, per
     * model, whether its weights exist. Always resolves; a malformed or missing
     * answer is normalised to `{webgpu:{available:false}, models:{}}` so the UI
     * can render a capability grid without a single guard clause.
     * @returns {Promise<{webgpu: {available: boolean, [key: string]: *},
     *   models: Object<string, *>}>} the capability report.
     */
    async probe() {
      const r = await call('probe', {});
      return r && typeof r === 'object' ? r : { webgpu: { available: false }, models: {} };
    },

    /**
     * Denoise one mono channel with DeepFilterNet3. The input is copied and the
     * copy is transferred, so the caller's buffer is never detached by the
     * hand-off — a caller that still wants to A/B against its own signal can.
     * @param {Float32Array} signal - mono samples, −1…1; any length.
     * @returns {Promise<NeuralResult>} `{applied:true, output}` with an equally
     *   long `Float32Array`, or a fallback result.
     */
    async denoise(signal) {
      const copy = Float32Array.from(signal);
      return call('denoise', { signal: copy }, [copy.buffer]);
    },

    /**
     * Split one mono channel into stems with BS-RoFormer. As with `denoise()`,
     * the samples are copied before they are transferred away.
     * @param {Float32Array} signal - mono samples, −1…1; any length.
     * @returns {Promise<NeuralResult>} `{applied:true, stems}` — one equal-length
     *   `Float32Array` per stem — or a fallback result.
     */
    async separate(signal) {
      const copy = Float32Array.from(signal);
      return call('separate', { signal: copy }, [copy.buffer]);
    },

    /**
     * Predict the gain curve Stage 7's air synthesiser should apply: one gain
     * in dB per band, for bands the caller measured as missing. Cheaper than
     * the two full-signal models and the one neural path that runs *next to* a
     * DSP stage rather than in front of a buffer.
     * @param {Float32Array} signal - mono samples, −1…1.
     * @param {number[]} [bandsHz] - the band centre frequencies the curve must
     *   describe, low to high; an empty list is passed through as-is.
     * @returns {Promise<NeuralResult>} `{applied:true, gainsDb}` — one dB value
     *   per entry of `bandsHz` — or a fallback result.
     */
    async superres(signal, bandsHz) {
      const copy = Float32Array.from(signal);
      return call('superres', { signal: copy, bandsHz: bandsHz || [] }, [copy.buffer]);
    },

    /**
     * Make sure a model's weights are on disk — see {@link RSNeural.ensureModel}.
     * @param {string} [key] - model key, `'deepfilternet3'` by default.
     * @param {Object} [opts] - `variant`, `mobile`, `onProgress`.
     * @returns {Promise<ModelStatus>} always resolves.
     */
    ensureModel,

    /**
     * What is cached right now, without any network access.
     * @param {string} [key] - model key.
     * @returns {Promise<Object>} the cache report.
     */
    modelStatus,

    /**
     * Subscribe to model-download progress (both directions: this module's own
     * `ensureModel()` calls and anything else that asks it to load). Returns
     * an unsubscribe function, idempotent like the other subscription here.
     * @param {function(ModelProgress): void} cb - subscriber.
     * @returns {function(): void} `unsubscribe()`.
     */
    onModelProgress(cb) {
      if (typeof cb !== 'function') return () => {};
      modelListeners.add(cb);
      return () => modelListeners.delete(cb);
    },

    /**
     * Where weights are fetched from. Accepts one base URL, a list of them (in
     * try order) or `null`/`''` to disable the network entirely — an offline
     * deployment that ships its own `models/` folder next to the page can say
     * so and never touch a CDN.
     * @param {(string|string[]|null)} source - base URL(s); each is joined as
     *   `<base>/<model>/<file>`.
     * @returns {string[]} the source list now in effect.
     */
    setModelSource(source) {
      if (source === null || source === undefined || source === '') modelSources = [];
      else if (Array.isArray(source)) modelSources = source.filter((x) => typeof x === 'string' && x).slice();
      else if (typeof source === 'string') modelSources = [source];
      return modelSources.slice();
    },

    /**
     * The source list currently in effect.
     * @returns {string[]} a copy, so a caller cannot mutate the loader's list.
     */
    getModelSource() { return modelSources.slice(); },

    /**
     * Can this host download and keep a model at all? True when a source is
     * configured and the model store exists; the settings row uses it to
     * decide whether "no model installed" is a dead end or an offer.
     * @returns {boolean} `true` when a download could be attempted.
     */
    canLoadModels() { return modelSources.length > 0 && !!modelStore(); },

    /** The weight file names per model and variant (read-only). */
    MODEL_FILES,
    /** The OPFS directory the loader writes into (`'models'`). */
    modelDir: MODELS_DIR,
  };

  /** @type {RSNeuralApi} */
  global.RSNeural = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
