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
 * ========================================================================== */
(function (global) {
  'use strict';

  const WORKER_URL = 'assets/js/neural-worker.js';
  const CALL_TIMEOUT_MS = 120000; // inference can legitimately take a while on WASM

  let worker = null;
  let reqSeq = 0;
  const pending = new Map();

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
      slot.resolve(error ? { applied: false, reason: error } : result);
    });
    worker.addEventListener('error', () => {
      // a worker-level error (e.g. a syntax error reached production) fails
      // every outstanding call cleanly rather than hanging them forever
      for (const [id, slot] of pending) {
        global.clearTimeout(slot.timer);
        slot.resolve({ applied: false, reason: 'worker-error' });
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
        resolve({ applied: false, reason: 'timeout' });
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
