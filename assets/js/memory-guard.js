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
/**
 * @fileoverview Mobile memory budget guard — exposed as the global
 * `RSMemoryGuard` (`globalThis.RSMemoryGuard`). Reads Chromium's non-standard
 * `performance.memory` signal, where it exists, and derives the next safe
 * render-chunk length from it. Every entry point is null-safe and swallows
 * host errors: a missing signal returns `null`, a bad listener is caught, and
 * an absent `setInterval` degrades `watch()` to a no-op stop function.
 *
 * Loaded as a classic script (no ES-module syntax) so `index.html` can pull it
 * in with a plain `<script src>` and the Node suites can `require()` it, which
 * is why the API is assigned to both `global.RSMemoryGuard` and
 * `module.exports` at the bottom.
 *
 * @module RSMemoryGuard
 */
(function (global) {
  'use strict';

  /**
   * A heap snapshot, in bytes, plus the derived fill ratio.
   * @typedef {Object} HeapInfo
   * @property {number} used - `performance.memory.usedJSHeapSize` in bytes
   *   (never negative; `0` when the engine omits the field).
   * @property {number} limit - `performance.memory.jsHeapSizeLimit` in bytes;
   *   always `> 0`, otherwise the reading is rejected as unusable.
   * @property {number} ratio - `used / limit`, clamped to `0…1` — the number
   *   {@link RSMemoryGuard.suggestChunkSeconds} actually keys on.
   */

  /**
   * The guard's tunables, all optional at the call site (see
   * {@link RSMemoryGuard.DEFAULTS} for the shipped values).
   * @typedef {Object} GuardOptions
   * @property {number} [min=2] - shortest chunk the guard may ask for, in
   *   seconds. A caller's requested length is never raised, only shrunk to this
   *   floor.
   * @property {number|null} [max=null] - upper bound in seconds; `null` means
   *   "the caller's own base length", so the guard cannot grow a chunk.
   * @property {number} [highWaterRatio=0.70] - heap fill ratio at or above
   *   which shrinking starts (linear from here to `criticalRatio`).
   * @property {number} [criticalRatio=0.90] - heap fill ratio at or above which
   *   the guard jumps straight to `min` instead of ramping.
   * @property {HeapInfo|null} [heap] - a pre-read snapshot to decide with
   *   instead of reading live state; `null` (or omitted) means "no signal".
   */

  /**
   * Chromium's heap snapshot as `{used, limit, ratio}` (bytes, bytes, 0..1),
   * `null` on every engine that does not expose `performance.memory` at
   * all (Safari/iOS, Firefox) or reports something unusable — including a
   * throwing getter, which the `try`/`catch` turns into the same `null`.
   * @returns {HeapInfo|null} the snapshot, or `null` when there is no signal.
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

  /**
   * Chrome's coarse device-memory hint, in GiB (one of a handful of buckets
   * such as `0.5`, `4`, `8`). Informational only — no decision in this module
   * or in `engine.js` is made from it, because it is unavailable everywhere
   * else and reports the *device*, not the tab's current pressure.
   * @returns {number|null} the hint when the engine exposes a finite, positive
   *   value, otherwise `null`.
   */
  function deviceMemoryGB() {
    try {
      const v = global.navigator && global.navigator.deviceMemory;
      return typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * The shipped tunables — see {@link GuardOptions} for units and meaning.
   * Frozen in spirit (never mutated at runtime): callers override per call via
   * the `opts` argument, which is merged over a copy of this object.
   * @type {GuardOptions}
   */
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
   * @returns {number} the chunk length to use this time, in seconds — always
   *   within `[min, baseSeconds]`, and exactly `baseSeconds` whenever no heap
   *   signal is available (the honest mobile default).
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
   * @param {(info:HeapInfo|null)=>void} onPressure - called with every reading,
   *   including `null`s; exceptions it throws are swallowed.
   * @param {number} [intervalMs=1000] - poll interval in milliseconds, floored
   *   at 250 so a caller cannot turn this into a busy loop.
   * @returns {function(): void} `stop()` — clears the timer; safe to call more
   *   than once, and a no-op when the host has no `setInterval`.
   */
  function watch(onPressure, intervalMs) {
    if (typeof onPressure !== 'function' || !global.setInterval) return () => {};
    const id = global.setInterval(() => {
      try { onPressure(heapInfo()); } catch (e) { /* a bad listener must not kill the watchdog */ }
    }, Math.max(250, intervalMs || 1000));
    return () => { try { global.clearInterval(id); } catch (e) { /* ignore */ } };
  }

  /**
   * The public surface, assigned to `global.RSMemoryGuard` below.
   * @typedef {Object} RSMemoryGuardApi
   * @property {function(): (HeapInfo|null)} heapInfo
   * @property {function(): (number|null)} deviceMemoryGB
   * @property {function(number, GuardOptions=): number} suggestChunkSeconds
   * @property {function(function(HeapInfo|null): void, number=): function(): void} watch
   * @property {GuardOptions} DEFAULTS
   */

  /** @type {RSMemoryGuardApi} */
  const API = { heapInfo, deviceMemoryGB, suggestChunkSeconds, watch, DEFAULTS };
  global.RSMemoryGuard = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
