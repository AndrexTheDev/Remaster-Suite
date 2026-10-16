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
(function (global) {
  'use strict';

  const WORKER_URL = 'assets/js/neural-worker.js';
  const CALL_TIMEOUT_MS = 120000; // inference can legitimately take a while on WASM

  // Reasons that mean "a call was attempted and the hardware itself gave
  // out" rather than "nothing was installed" (`weights-not-found`) or "the
  // feature was turned off/torn down" (`disposed`, `worker-unavailable`).
  const HARDWARE_LIMIT_REASONS = new Set(['oom', 'device-lost', 'timeout']);

  let worker = null;
  let reqSeq = 0;
  const pending = new Map();
  const fallbackListeners = new Set();

  /** Notify any `onHardwareFallback` subscribers when a result's reason is a hardware-limit one. */
  function maybeNotifyFallback(result) {
    if (!result || result.applied !== false || !HARDWARE_LIMIT_REASONS.has(result.reason)) return;
    for (const cb of fallbackListeners) { try { cb(result.reason); } catch (e) { /* a bad listener must not break the pipeline */ } }
  }

  /** Resolve a pending call's promise, firing the hardware-fallback notification first if warranted. */
  function settle(resolve, result) {
    maybeNotifyFallback(result);
    resolve(result);
  }

  function resolveUrl(rel) {
    if (!global.location) return rel;
    try { return new URL(rel, global.location.href).href; } catch (e) { return rel; }
  }

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

  const API = {
    /**
     * Subscribe to hardware-limit fallbacks (`oom`/`device-lost`/`timeout` —
     * see HARDWARE_LIMIT_REASONS above). Returns an unsubscribe function.
     * Fires at most once per failing call, after that call's own promise has
     * already resolved `{applied:false, reason}` to its caller — this is
     * purely a notification channel for UI feedback, never part of the
     * render's own fallback logic, which needs no new code to keep working.
     */
    onHardwareFallback(cb) {
      if (typeof cb !== 'function') return () => {};
      fallbackListeners.add(cb);
      return () => fallbackListeners.delete(cb);
    },

    /** Terminate the worker (e.g. the user turned the feature off). */
    dispose() {
      if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
      for (const [id, slot] of pending) { global.clearTimeout(slot.timer); slot.resolve({ applied: false, reason: 'disposed' }); pending.delete(id); }
    },

    /** Capability + model-availability report; always resolves. */
    async probe() {
      const r = await call('probe', {});
      return r && typeof r === 'object' ? r : { webgpu: { available: false }, models: {} };
    },

    /** Denoise one mono channel with DeepFilterNet3; `{applied, output}` or `{applied:false, reason}`. */
    async denoise(signal) {
      const copy = Float32Array.from(signal);
      return call('denoise', { signal: copy }, [copy.buffer]);
    },

    /** Stem-separate one mono channel with BS-RoFormer; `{applied, stems:{...}}` or fallback. */
    async separate(signal) {
      const copy = Float32Array.from(signal);
      return call('separate', { signal: copy }, [copy.buffer]);
    },

    /** Predict a per-band dB gain curve for Stage 7's air synthesiser; `{applied, gainsDb}` or fallback. */
    async superres(signal, bandsHz) {
      const copy = Float32Array.from(signal);
      return call('superres', { signal: copy, bandsHz: bandsHz || [] }, [copy.buffer]);
    },
  };

  global.RSNeural = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
