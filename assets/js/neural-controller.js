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
  };

  /** @type {RSNeuralApi} */
  global.RSNeural = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
