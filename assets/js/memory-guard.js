/* =============================================================================
 * Remaster Suite — mobile memory budget guard
 * -----------------------------------------------------------------------------
 * `performance.memory` (`usedJSHeapSize` / `jsHeapSizeLimit`) is a Chromium-
 * only, non-standard API. It exists on desktop Chrome/Edge and on Android
 * Chrome/WebView, but *not* on iOS — every browser on iOS, "Chrome for iOS"
 * included, is WebKit under the hood and exposes nothing like it — and not on
 * Firefox either. This module is honest about that limit: when the signal is
 * unavailable, `suggestChunkSeconds()` hands back the caller's own requested
 * size unchanged, trusting its fixed default instead of guessing.
 *
 * That is deliberately safe, not a gap: the actual, cross-platform "never
 * crash a phone" guarantee comes from `engine.js`'s `renderChunked()` always
 * working in small, bounded chunks in the first place, never the whole file
 * at once — this watchdog is a second, Chromium-specific layer that shrinks
 * those chunks *further* when it can actually see heap pressure building. It
 * is a best-effort improvement where the signal exists, never the only thing
 * standing between a long render and a crash.
 * ========================================================================== */
(function (global) {
  'use strict';

  /**
   * Chromium's heap snapshot as `{used, limit, ratio}` (bytes, bytes, 0..1),
   * or `null` on every engine that does not expose `performance.memory` at
   * all (Safari/iOS, Firefox) or reports something unusable.
   */
  function heapInfo() {
    try {
      const perf = global.performance;
      const mem = perf && perf.memory;
      if (!mem || !isFinite(mem.jsHeapSizeLimit) || mem.jsHeapSizeLimit <= 0) return null;
      const used = isFinite(mem.usedJSHeapSize) ? mem.usedJSHeapSize : 0;
      const limit = mem.jsHeapSizeLimit;
      return { used, limit, ratio: Math.max(0, Math.min(1, used / limit)) };
    } catch (e) {
      return null;
    }
  }

  /** Chrome's coarse device-memory hint in GiB (one of a handful of buckets), or `null`. */
  function deviceMemoryGB() {
    try {
      const v = global.navigator && global.navigator.deviceMemory;
      return typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
    } catch (e) {
      return null;
    }
  }

  const DEFAULTS = {
    min: 2,               // seconds — a chunk is never shrunk smaller than this
    max: null,             // seconds — ceiling; defaults to the caller's own base
    highWaterRatio: 0.70,  // heap ratio at/above which shrinking starts
    criticalRatio: 0.90,   // heap ratio at/above which the guard jumps straight to `min`
  };

  /**
   * Given the chunk length (seconds) a caller would *like* to render next,
   * return the length it should actually use this time: unchanged when there
   * is no heap-pressure signal at all, ratcheted down toward `min` as the
   * heap fills past `highWaterRatio`, and pinned at `min` once it crosses
   * `criticalRatio`.
   * @param {number} baseSeconds
   * @param {{min?:number,max?:number,highWaterRatio?:number,criticalRatio?:number,heap?:object|null}} [opts]
   *   `heap` lets a caller pass an already-read `heapInfo()` snapshot (or an
   *   explicit `null`/fake one for testing) instead of reading live state.
   */
  function suggestChunkSeconds(baseSeconds, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const max = o.max || baseSeconds;
    const base = Math.max(o.min, Math.min(max, baseSeconds));
    const info = Object.prototype.hasOwnProperty.call(o, 'heap') ? o.heap : heapInfo();
    if (!info) return base;
    if (info.ratio >= o.criticalRatio) return o.min;
    if (info.ratio <= o.highWaterRatio) return base;
    // linear ramp: `base` at highWaterRatio down to `min` at criticalRatio
    const span = Math.max(1e-6, o.criticalRatio - o.highWaterRatio);
    const t = (info.ratio - o.highWaterRatio) / span;
    const shrunk = base - (base - o.min) * t;
    return Math.max(o.min, Math.min(base, shrunk));
  }

  /**
   * Poll heap pressure on an interval and call `onPressure(info)` with each
   * `heapInfo()` reading (possibly `null`). Returns a stop function; never
   * throws, never leaves a timer running past that call.
   * @param {(info:object|null)=>void} onPressure
   * @param {number} [intervalMs]
   */
  function watch(onPressure, intervalMs) {
    if (typeof onPressure !== 'function' || !global.setInterval) return () => {};
    const id = global.setInterval(() => {
      try { onPressure(heapInfo()); } catch (e) { /* a bad listener must not kill the watchdog */ }
    }, Math.max(250, intervalMs || 1000));
    return () => { try { global.clearInterval(id); } catch (e) { /* ignore */ } };
  }

  const API = { heapInfo, deviceMemoryGB, suggestChunkSeconds, watch, DEFAULTS };
  global.RSMemoryGuard = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
