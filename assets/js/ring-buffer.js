/* ============================================================================= * Remaster Suite — lock-free ring buffer on SharedArrayBuffer
 * -----------------------------------------------------------------------------
 * The hybrid ML side chain moves audio between three contexts that must never
 * wait on each other:
 *
 *   AudioWorklet  — 128-frame quanta, real-time, must never block
 *   ML worker     — 512…2048-frame hops, asynchronous, may lag briefly
 *   main thread   — sets the whole thing up and tears it down
 *
 * This is the single-producer / single-consumer (SPSC) ring that connects them.
 * It is lock-free in the strict sense: no compare-and-swap loop, no mutex, no
 * Atomics.wait on the audio path. The producer alone writes the write index,
 * the consumer alone writes the read index; every cross-thread step is an
 * Atomics load/store pair, and the data is copied into the free region *before*
 * the new write index is published, so a reader can never observe a half-copied
 * block. Each counter is a monotonically increasing 32-bit frame count (wrapped
 * modulo 2^32, which reads back correctly through unsigned arithmetic), and the
 * data region is indexed with a power-of-two mask — no modulo in the hot loop.
 *
 * Memory layout (one SharedArrayBuffer):
 *
 *   [ 16 × Int32 control header | channels × capacity × Float32, planar ]
 *
 * Planar (one contiguous region per channel) keeps the AudioWorklet side
 * allocation-free: process() hands us one Float32Array per channel and we copy
 * frames with plain loops.
 *
 * Losslessness is the contract: `write` never overwrites frames the consumer has
 * not read yet and `read` never returns frames the producer has not published.
 * When a side is short, the call returns the exact number of frames moved and
 * the refused frames are counted in the overrun / underrun counters — dropped
 * never happens silently.
 *
 * Latency compensation: the consumer side reports `latencyFrames()` — the fill
 * level plus the fixed compensation the setup records (hop alignment and the
 * model's algorithmic delay) — so a mixer can delay the dry path by exactly the
 * amount the side chain lags instead of guessing.
 *
 * Loading — the file is a plain script with a CommonJS export:
 *   page:            <script src="assets/js/ring-buffer.js"></script>  → RSRing
 *   dedicated worker: importScripts('assets/js/ring-buffer.js')
 *   AudioWorklet:    audioWorklet.addModule('assets/js/ring-buffer.js')
 *                    (evaluates into the shared AudioWorkletGlobalScope)
 *   Node tests:      require('assets/js/ring-buffer.js')
 * ========================================================================== */
(function (global) {
  'use strict';

  const MAGIC = 0x52534231;             // 'RSB1' — recognises a buffer of ours
  const VERSION = 1;
  const HEADER_INTS = 16;
  const HEADER_BYTES = HEADER_INTS * 4;

  /* Control cells (Int32). Indices are stored as raw bits and read back with
   * `>>> 0`, so the counters may wrap at 2^32 frames (≈ 24.8 h at 48 kHz) and
   * the unsigned difference stays correct. */
  const MAGIC_I = 0;
  const VERSION_I = 1;
  const CAPACITY_I = 2;
  const CHANNELS_I = 3;
  const WRITE_I = 4;                    // producer only
  const READ_I = 5;                     // consumer only
  const OVERRUNS_I = 6;                 // frames refused by write()
  const UNDERRUNS_I = 7;                // frames refused by read()
  const TARGET_FILL_I = 8;              // fill the pipeline aims to hold
  const LATENCY_COMP_I = 9;             // fixed compensation, in frames
  const SAMPLE_RATE_I = 10;

  const MIN_CAPACITY = 64;
  const MAX_CAPACITY = 1 << 22;         // 4 194 304 frames ≈ 87 s at 48 kHz
  const MAX_CHANNELS = 32;

  /** SharedArrayBuffer + Atomics are the whole foundation. */
  function isSupported() {
    return typeof SharedArrayBuffer === 'function'
      && typeof Atomics === 'object' && Atomics !== null
      && typeof Atomics.load === 'function' && typeof Atomics.store === 'function';
  }

  /**
   * Atomics.wait is legal on workers (and in Node), but the browser main thread
   * and the audio rendering thread refuse to block. Probe once, remember the
   * answer, and let the wait helpers degrade to plain polling there.
   */
  let canWait = null;
  function waitCell(ctrl, index, value, timeout) {
    if (canWait === false) return 'unsupported';
    try {
      const r = Atomics.wait(ctrl, index, value, timeout);
      canWait = true;
      return r;
    } catch (e) {
      canWait = false;
      return 'unsupported';
    }
  }

  function requirePow2(n, what) {
    if ((n & (n - 1)) !== 0 || n <= 0) throw new RangeError(what + ' must be a power of two');
    return n;
  }

  class RingBuffer {
    /** Wrap an existing SharedArrayBuffer. Use attach() so the header is checked. */
    constructor(sab) {
      this.sab = sab;
      this.ctrl = new Int32Array(sab, 0, HEADER_INTS);
      this.capacity = Atomics.load(this.ctrl, CAPACITY_I) >>> 0;
      this.channels = Atomics.load(this.ctrl, CHANNELS_I) >>> 0;
      this.mask = this.capacity - 1;
      this.data = new Float32Array(sab, HEADER_BYTES, this.capacity * this.channels);
    }

    /**
     * Allocate a new buffer and its header. `capacity` is in frames per channel
     * and must be a power of two (the index wrap is a mask).
     * @param {object} o  { capacity, channels, sampleRate, targetFill, latencyCompensation }
     */
    static create(o) {
      if (!isSupported()) {
        throw new Error('SharedArrayBuffer/Atomics unavailable (needs cross-origin isolation)');
      }
      const opts = o || {};
      const capacity = requirePow2(opts.capacity === undefined ? 8192 : opts.capacity | 0, 'capacity');
      if (capacity < MIN_CAPACITY || capacity > MAX_CAPACITY) {
        throw new RangeError('capacity out of range (' + MIN_CAPACITY + '…' + MAX_CAPACITY + ')');
      }
      const channels = opts.channels === undefined ? 2 : opts.channels | 0;
      if (channels < 1 || channels > MAX_CHANNELS) {
        throw new RangeError('channels out of range (1…' + MAX_CHANNELS + ')');
      }
      const sab = new SharedArrayBuffer(HEADER_BYTES + capacity * channels * 4);
      const ctrl = new Int32Array(sab, 0, HEADER_INTS);
      Atomics.store(ctrl, MAGIC_I, MAGIC);
      Atomics.store(ctrl, VERSION_I, VERSION);
      Atomics.store(ctrl, CAPACITY_I, capacity);
      Atomics.store(ctrl, CHANNELS_I, channels);
      Atomics.store(ctrl, SAMPLE_RATE_I, (opts.sampleRate | 0) || 48000);
      Atomics.store(ctrl, TARGET_FILL_I, opts.targetFill | 0);
      Atomics.store(ctrl, LATENCY_COMP_I, opts.latencyCompensation | 0);
      return new RingBuffer(sab);
    }

    /** Attach the other side (or a later context) to an existing buffer. */
    static attach(sab) {
      if (!isSupported()) {
        throw new Error('SharedArrayBuffer/Atomics unavailable (needs cross-origin isolation)');
      }
      if (typeof SharedArrayBuffer === 'function' && !(sab instanceof SharedArrayBuffer)) {
        throw new TypeError('attach: not a SharedArrayBuffer');
      }
      const head = new Int32Array(sab, 0, HEADER_INTS);
      if (Atomics.load(head, MAGIC_I) !== MAGIC) throw new TypeError('attach: not a Remaster ring buffer');
      if ((Atomics.load(head, VERSION_I) >>> 0) !== VERSION) throw new TypeError('attach: ring buffer version mismatch');
      const capacity = Atomics.load(head, CAPACITY_I) >>> 0;
      const channels = Atomics.load(head, CHANNELS_I) >>> 0;
      if (capacity < MIN_CAPACITY || capacity > MAX_CAPACITY || (capacity & (capacity - 1)) !== 0) {
        throw new TypeError('attach: corrupt capacity');
      }
      if (channels < 1 || channels > MAX_CHANNELS) throw new TypeError('attach: corrupt channel count');
      if (sab.byteLength !== HEADER_BYTES + capacity * channels * 4) {
        throw new TypeError('attach: buffer size does not match its header');
      }
      return new RingBuffer(sab);
    }

    /* --------------------------------------------------------------- state */

    get sampleRate() { return Atomics.load(this.ctrl, SAMPLE_RATE_I) | 0; }

    /** Fill the exchange aims to hold, in frames (latency insurance). */
    get targetFill() { return Atomics.load(this.ctrl, TARGET_FILL_I) | 0; }
    set targetFill(frames) { Atomics.store(this.ctrl, TARGET_FILL_I, frames | 0); }

    /** Fixed part of the reported latency (hop alignment + model delay). */
    get latencyCompensation() { return Atomics.load(this.ctrl, LATENCY_COMP_I) | 0; }
    set latencyCompensation(frames) { Atomics.store(this.ctrl, LATENCY_COMP_I, frames | 0); }

    /** Frames published and not yet read. */
    available() {
      const w = Atomics.load(this.ctrl, WRITE_I) >>> 0;
      const r = Atomics.load(this.ctrl, READ_I) >>> 0;
      const used = (w - r) >>> 0;
      return used > this.capacity ? this.capacity : used;
    }

    /** Frames the producer may still write. */
    free() { return this.capacity - this.available(); }

    /** Frames the exchange has refused: dropped by write(), not invented by read(). */
    overruns() { return Atomics.load(this.ctrl, OVERRUNS_I) >>> 0; }
    underruns() { return Atomics.load(this.ctrl, UNDERRUNS_I) >>> 0; }

    /**
     * The delay the exchange currently introduces, in frames: everything still
     * in flight plus the fixed compensation the setup recorded. A mixer that
     * delays its dry path by this much stays aligned with the ML side chain.
     */
    latencyFrames() { return this.available() + this.latencyCompensation; }
    latencyMs() {
      const sr = this.sampleRate;
      return sr > 0 ? (this.latencyFrames() * 1000) / sr : 0;
    }

    /* ---------------------------------------------------- producer side */

    /**
     * Publish up to `frames` frames from planar channel arrays (one per
     * channel). Never touches frames the consumer has not read yet; if the
     * request does not fit, only the fitting prefix is copied, the refused
     * frames are added to the overrun counter and the return value says how
     * many moved.
     * @param {Float32Array[]} src  one array per channel
     * @param {number} [frames]     frames to move (default: all of src[0])
     * @param {number} [srcOffset]  first source frame (default 0)
     * @returns {number} frames written
     */
    write(src, frames, srcOffset) {
      const chans = this.channels;
      const off = srcOffset | 0;
      if (!src || src.length < chans) throw new TypeError('write: one source array per channel');
      const n = frames === undefined ? src[0].length - off : frames | 0;
      if (n <= 0) return 0;
      const ctrl = this.ctrl;
      const w = Atomics.load(ctrl, WRITE_I) >>> 0;
      const r = Atomics.load(ctrl, READ_I) >>> 0;
      const used = (w - r) >>> 0;
      const free = used >= this.capacity ? 0 : this.capacity - used;
      const m = n > free ? free : n;
      if (m < n) Atomics.add(ctrl, OVERRUNS_I, n - m);
      if (m === 0) return 0;

      const cap = this.capacity;
      const mask = this.mask;
      const data = this.data;
      const start = w & mask;
      const first = m < cap - start ? m : cap - start;
      for (let c = 0; c < chans; c++) {
        const s = src[c];
        if (!s || s.length < off + m) throw new TypeError('write: channel ' + c + ' has too few frames');
        const base = c * cap;
        for (let i = 0; i < first; i++) data[base + start + i] = s[off + i];
        for (let i = first; i < m; i++) data[base + i - first] = s[off + i];
      }
      // publish: the data above is complete before the new write index is visible
      Atomics.store(ctrl, WRITE_I, (w + m) | 0);
      Atomics.notify(ctrl, WRITE_I);
      return m;
    }

    /* ---------------------------------------------------- consumer side */

    /**
     * Take up to `frames` frames into planar channel arrays. Returns only
     * frames the producer has published — never invented ones — and counts a
     * short read against the underrun counter.
     * @param {Float32Array[]} dst  one array per channel
     * @param {number} [frames]     frames to move (default: all of dst[0])
     * @param {number} [dstOffset]  first destination frame (default 0)
     * @returns {number} frames read
     */
    read(dst, frames, dstOffset) {
      const chans = this.channels;
      const off = dstOffset | 0;
      if (!dst || dst.length < chans) throw new TypeError('read: one destination array per channel');
      const n = frames === undefined ? dst[0].length - off : frames | 0;
      if (n <= 0) return 0;
      const ctrl = this.ctrl;
      const w = Atomics.load(ctrl, WRITE_I) >>> 0;
      const r = Atomics.load(ctrl, READ_I) >>> 0;
      const used = (w - r) >>> 0;
      const have = used > this.capacity ? this.capacity : used;
      const m = n > have ? have : n;
      if (m < n) Atomics.add(ctrl, UNDERRUNS_I, n - m);
      if (m === 0) return 0;

      const cap = this.capacity;
      const mask = this.mask;
      const data = this.data;
      const start = r & mask;
      const first = m < cap - start ? m : cap - start;
      for (let c = 0; c < chans; c++) {
        const d = dst[c];
        if (!d || d.length < off + m) throw new TypeError('read: channel ' + c + ' has too few frames');
        const base = c * cap;
        for (let i = 0; i < first; i++) d[off + i] = data[base + start + i];
        for (let i = first; i < m; i++) d[off + i] = data[base + i - first];
      }
      Atomics.store(ctrl, READ_I, (r + m) | 0);
      Atomics.notify(ctrl, READ_I);
      return m;
    }

    /**
     * Block until `frames` frames are available (or the timeout expires).
     * Real blocking on workers, immediate polling on the main thread and in an
     * AudioWorklet — the return value is the same either way.
     * @returns {boolean} true when available() >= frames
     */
    waitForFrames(frames, timeoutMs) {
      const need = frames | 0;
      const budget = timeoutMs === undefined ? 1000 : Math.max(0, timeoutMs);
      const t0 = Date.now();
      for (;;) {
        if (this.available() >= need) return true;
        const remain = budget - (Date.now() - t0);
        if (remain <= 0 || canWait === false) return this.available() >= need;
        const w = Atomics.load(this.ctrl, WRITE_I);
        if (this.available() >= need) return true;
        waitCell(this.ctrl, WRITE_I, w, remain);
      }
    }

    /**
     * Block until `frames` frames of space are free. Mirrors waitForFrames for
     * the producer side (e.g. the ML worker filling the return ring).
     * @returns {boolean} true when free() >= frames
     */
    waitForSpace(frames, timeoutMs) {
      const need = frames | 0;
      const budget = timeoutMs === undefined ? 1000 : Math.max(0, timeoutMs);
      const t0 = Date.now();
      for (;;) {
        if (this.free() >= need) return true;
        const remain = budget - (Date.now() - t0);
        if (remain <= 0 || canWait === false) return this.free() >= need;
        const r = Atomics.load(this.ctrl, READ_I);
        if (this.free() >= need) return true;
        waitCell(this.ctrl, READ_I, r, remain);
      }
    }

    /**
     * Empty the ring and zero the counters. Only while both sides stand still
     * (no producer and no consumer mid-call) — the setup/teardown path uses it,
     * the streaming path never does.
     */
    reset() {
      const ctrl = this.ctrl;
      Atomics.store(ctrl, WRITE_I, 0);
      Atomics.store(ctrl, READ_I, 0);
      Atomics.store(ctrl, OVERRUNS_I, 0);
      Atomics.store(ctrl, UNDERRUNS_I, 0);
      Atomics.notify(ctrl, WRITE_I);
      Atomics.notify(ctrl, READ_I);
    }
  }

  const API = {
    RingBuffer,
    create: (o) => RingBuffer.create(o),
    attach: (sab) => RingBuffer.attach(sab),
    isSupported,
    HEADER_INTS,
    HEADER_BYTES,
  };

  global.RSRing = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
