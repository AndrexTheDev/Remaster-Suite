/* =============================================================================
 * Remaster Suite — the SharedArrayBuffer ring
 * -----------------------------------------------------------------------------
 * One circular buffer of 32-bit float audio, shared between the thread that
 * produces a stage's output and the thread (or worklet) that consumes it. The
 * producer writes with plain stores into a `SharedArrayBuffer`; the consumer
 * reads with plain loads; the two indices and every counter are updated with
 * `Atomics`, which is what makes the hand-off well defined across threads
 * instead of a data race that happens to work on one machine.
 *
 * The layout is fixed and deliberately boring, because two independent readers
 * of the same memory have to agree about it without a decoder ring:
 *
 *   byte 0                  128-byte control block (32 Int32 slots)
 *   byte 128                channel 0 samples, `capacity` float32, then
 *                           channel 1, … up to `channels`
 *
 * The control block holds a magic word and a version, so a buffer created by a
 * different revision of this file is refused instead of misinterpreted. The
 * capacity is always a power of two: the indices are free-running counters and
 * the slot is `index & (capacity - 1)`, which is exact across the counter's own
 * wrap and costs one AND instead of a division.
 *
 * This is a single-producer / single-consumer ring. That is not a limitation
 * to work around — it is the shape of every stage this app has: one worker
 * producing denoised chunks, one consumer assembling them into the graph's
 * input. A multi-producer ring would need a different (and slower) protocol
 * for no benefit here.
 *
 * When the host has no `SharedArrayBuffer` (a page without cross-origin
 * isolation, an old browser), `create()` still returns a working ring backed
 * by a plain `ArrayBuffer`: the same API, the same bookkeeping, no cross-thread
 * sharing. The stage above it then runs the two halves in one thread, which is
 * slower but correct — and, importantly, the counters keep telling the truth,
 * so a missing SAB cannot silently turn into a missing check.
 * ========================================================================== */
/**
 * @fileoverview The audio ring buffer — exposed as the global `RSRingBuffer`.
 *
 * A lock-free, single-producer/single-consumer circular buffer of float32
 * audio in a `SharedArrayBuffer`, with a plain-buffer fallback for hosts
 * without one. Used by `neural-controller.js` to carry a neural stage's
 * output to the render pipeline without ever growing a whole extra copy of
 * the signal.
 *
 * @module RSRingBuffer
 */
(function (global) {
  'use strict';

  /** @type {number} control block size in bytes (32 Int32 slots). */
  const HEADER_BYTES = 128;
  /** @type {number} slots in the control block. */
  const CONTROL_INTS = HEADER_BYTES / 4;
  /** @type {number} `'RSB1'` — identifies this exact layout. */
  const MAGIC = 0x52534231;
  /** @type {number} layout revision; a mismatch is refused, not guessed at. */
  const VERSION = 1;
  /** @type {number} smallest ring, in frames — below this the bookkeeping is silly. */
  const MIN_CAPACITY = 64;

  /**
   * Control-block slots, by name. Reading this object in the code below is the
   * only place the indices exist: `from()` and `create()` both start from it.
   */
  const SLOT = Object.freeze({
    magic: 0,
    version: 1,
    capacity: 2,
    channels: 3,
    write: 4,        // monotonic frames produced
    read: 5,         // monotonic frames consumed
    underflows: 6,   // consumer asked for frames the ring did not have
    overflows: 7,    // producer asked to write frames the ring had no room for
    pushed: 8,       // total frames written (wraps with the audio, not with time)
    popped: 9,       // total frames read
    highWater: 10,   // deepest the ring ever got, frames
    closed: 11,      // 1 once the producer is done — a consumer may finish
    waiters: 12,     // the Atomics.wait slot `writeBlocking()` sleeps on
    pushes: 13,      // number of complete blocks written
    pops: 14,        // number of complete (non-empty) reads
  });

  /**
   * Whether this host can back a ring with real shared memory.
   * @returns {boolean} `true` when `SharedArrayBuffer` and `Atomics` exist.
   */
  function isSupported() {
    return typeof global.SharedArrayBuffer === 'function' && typeof global.Atomics === 'object' && typeof global.Atomics.load === 'function';
  }

  /**
   * Round up to the next power of two, never below {@link MIN_CAPACITY}.
   * @param {number} n - requested capacity in frames.
   * @returns {number} the capacity a ring will really use.
   */
  function capacityFor(n) {
    let c = MIN_CAPACITY;
    const want = Math.max(MIN_CAPACITY, Math.floor(Number(n) || 0));
    while (c < want) c *= 2;
    return c;
  }

  /**
   * One ring. Construct through {@link RSRingBuffer.create} or
   * {@link RSRingBuffer.from}, never with `new` — the two entry points are what
   * decide whether the views are shared and who initialises the header.
   */
  class Ring {
    /**
     * @private
     * @param {ArrayBuffer|SharedArrayBuffer} buffer - the whole backing store.
     * @param {boolean} shared - whether `Atomics` may be used on it.
     * @param {boolean} owner - `true` for the side that writes the header.
     */
    constructor(buffer, shared, owner) {
      /** @type {ArrayBuffer|SharedArrayBuffer} the backing store itself. */
      this.buffer = buffer;
      /** @type {boolean} `true` when the memory is really shared. */
      this.shared = shared;
      /** @type {Int32Array} the control block. */
      this.control = new Int32Array(buffer, 0, CONTROL_INTS);
      const declaredCapacity = shared || owner ? this.control[SLOT.capacity] : 0;
      /** @type {number} usable frames per channel (power of two). */
      this.capacity = declaredCapacity > 0 ? declaredCapacity : 0;
      /** @type {number} channels this ring carries. */
      this.channels = this.control[SLOT.channels] || 0;
      /** @type {Float32Array[]} one view per channel. */
      this.data = [];
      if (this.capacity && this.channels) {
        for (let c = 0; c < this.channels; c++) {
          this.data.push(new Float32Array(buffer, HEADER_BYTES + c * this.capacity * 4, this.capacity));
        }
      }
    }

    /**
     * Read one control slot: atomically on shared memory, plainly otherwise.
     * @private
     * @param {number} slot - one of {@link SLOT}.
     * @returns {number} the current value.
     */
    _get(slot) { return this.shared ? global.Atomics.load(this.control, slot) : this.control[slot]; }

    /**
     * Write one control slot with the same rule as {@link Ring#_get}.
     * @private
     * @param {number} slot - one of {@link SLOT}.
     * @param {number} value - the value to store.
     * @returns {void}
     */
    _set(slot, value) {
      if (this.shared) global.Atomics.store(this.control, slot, value);
      else this.control[slot] = value;
    }

    /**
     * Add to a counter slot. On shared memory the increment is a real atomic
     * add; on the fallback it is one plain read-modify-write, which is safe
     * because there is only ever one thread.
     * @private
     * @param {number} slot - a counter slot.
     * @param {number} by - how much to add (may be negative).
     * @returns {number} the value after the add.
     */
    _add(slot, by) {
      if (this.shared) return global.Atomics.add(this.control, slot, by);
      this.control[slot] += by;
      return this.control[slot];
    }

    /**
     * Frames currently readable.
     * @returns {number} available frames, `0 … capacity`.
     */
    available() {
      const used = (this._get(SLOT.write) - this._get(SLOT.read)) | 0;
      return used < 0 ? 0 : Math.min(this.capacity, used);
    }

    /**
     * Frames currently writable.
     * @returns {number} free frames, `0 … capacity`.
     */
    free() { return this.capacity - this.available(); }

    /**
     * Copy one block of frames into every channel, if it fits. Never blocks
     * and never partially writes: either the whole block lands or the call
     * returns `0` and counts an overflow.
     * @param {Float32Array[]|Float32Array} channels - one array per ring
     *   channel (a single array is accepted for a single-channel ring).
     * @param {number} [frames] - how many frames to write; defaults to the
     *   first channel's length.
     * @returns {number} the frames written (`0` when the ring was too full).
     */
    write(channels, frames) {
      const list = Array.isArray(channels) ? channels : [channels];
      const n = Math.max(0, Math.min(frames === undefined ? (list[0] ? list[0].length : 0) : frames, this.capacity));
      if (n === 0 || list.length < this.channels) return 0;
      if (this._get(SLOT.closed)) { this._add(SLOT.overflows, 1); return 0; }
      if (this.free() < n) { this._add(SLOT.overflows, 1); return 0; }
      const w = this._get(SLOT.write);
      const start = w & (this.capacity - 1);
      const first = Math.min(n, this.capacity - start);
      for (let c = 0; c < this.channels; c++) {
        const dst = this.data[c];
        const src = list[c];
        dst.set(src.subarray(0, first), start);
        if (first < n) dst.set(src.subarray(first, n), 0);
      }
      // publish only after the samples are in place: the store is the release
      this._set(SLOT.write, w + n);
      this._add(SLOT.pushed, n);
      this._add(SLOT.pushes, 1);
      const used = this.available();
      if (used > this._get(SLOT.highWater)) this._set(SLOT.highWater, used);
      return n;
    }

    /**
     * Wait until a block fits, then write it. This is the worker-side call:
     * `Atomics.wait` is forbidden on a browser's main thread, and there is no
     * reason for a UI thread to ever sleep on a full ring. The wait is bounded
     * — a consumer that has gone away must not wedge the producer for ever.
     * @param {Float32Array[]|Float32Array} channels - one array per channel.
     * @param {number} [frames] - frames to write.
     * @param {number} [timeoutMs=2000] - how long to wait for room, at most.
     * @returns {number} frames written, or `0` on timeout/closed.
     */
    writeBlocking(channels, frames, timeoutMs) {
      const list = Array.isArray(channels) ? channels : [channels];
      const n = Math.max(0, Math.min(frames === undefined ? (list[0] ? list[0].length : 0) : frames, this.capacity));
      if (n === 0) return 0;
      const deadline = (global.Date ? global.Date.now() : 0) + (timeoutMs === undefined ? 2000 : timeoutMs);
      while (this.free() < n) {
        if (this._get(SLOT.closed)) return 0;
        if (!this.shared) return 0;                       // single-threaded: nobody will free it
        const left = deadline - (global.Date ? global.Date.now() : 0);
        if (left <= 0) { this._add(SLOT.overflows, 1); return 0; }
        // wait until the consumer has read something (it bumps `waiters`)
        global.Atomics.wait(this.control, SLOT.waiters, this._get(SLOT.waiters), Math.min(left, 500));
      }
      return this.write(list, n);
    }

    /**
     * Copy up to `maxFrames` frames out of every channel. Never blocks and
     * never pads: a short read is returned as a short read, so the caller
     * decides what an underrun means (the render pipeline throws the stage
     * away and falls back, it does not write silence into the file).
     * @param {Float32Array[]} dst - one destination per channel, at least
     *   `maxFrames` long.
     * @param {number} maxFrames - how many frames the caller can take.
     * @returns {number} frames actually read (`0` when the ring was empty).
     */
    read(dst, maxFrames) {
      const avail = this.available();
      const n = Math.min(Math.max(0, maxFrames | 0), avail);
      if (n === 0) {
        if (this._get(SLOT.closed) === 0) this._add(SLOT.underflows, 1);
        return 0;
      }
      const r = this._get(SLOT.read);
      const start = r & (this.capacity - 1);
      const first = Math.min(n, this.capacity - start);
      for (let c = 0; c < this.channels; c++) {
        const src = this.data[c];
        const out = dst[c];
        if (!out) continue;
        out.set(src.subarray(start, start + first), 0);
        if (first < n) out.set(src.subarray(0, n - first), first);
      }
      this._set(SLOT.read, r + n);
      this._add(SLOT.popped, n);
      this._add(SLOT.pops, 1);
      // wake a producer that is waiting for room
      if (this.shared) {
        this._add(SLOT.waiters, 1);
        global.Atomics.notify(this.control, SLOT.waiters, 1);
      }
      return n;
    }

    /**
     * The ring's own accounting — what the render pipeline reports and what the
     * tests assert on. Every number is read from the control block, so a
     * consumer looking at a worker's ring sees the worker's counts.
     * @returns {{capacity: number, channels: number, available: number,
     *   pushed: number, popped: number, underflows: number, overflows: number,
     *   highWater: number, pushes: number, pops: number, closed: boolean,
     *   shared: boolean}} a snapshot.
     */
    stats() {
      return {
        capacity: this.capacity,
        channels: this.channels,
        available: this.available(),
        pushed: this._get(SLOT.pushed),
        popped: this._get(SLOT.popped),
        underflows: this._get(SLOT.underflows),
        overflows: this._get(SLOT.overflows),
        highWater: this._get(SLOT.highWater),
        pushes: this._get(SLOT.pushes),
        pops: this._get(SLOT.pops),
        closed: this._get(SLOT.closed) === 1,
        shared: this.shared,
      };
    }

    /**
     * Declare that no more frames are coming. A consumer that reads dry after
     * this has finished, not underrun, so the underflow counter stays quiet.
     * Wakes a producer blocked in {@link Ring#writeBlocking}.
     * @returns {void}
     */
    close() {
      this._set(SLOT.closed, 1);
      if (this.shared) {
        this._add(SLOT.waiters, 1);
        global.Atomics.notify(this.control, SLOT.waiters);
      }
    }

    /**
     * Empty the ring and zero every counter — a fresh take on the same memory,
     * without allocating a new buffer between renders.
     * @returns {void}
     */
    reset() {
      for (const slot of [SLOT.write, SLOT.read, SLOT.underflows, SLOT.overflows,
        SLOT.pushed, SLOT.popped, SLOT.highWater, SLOT.closed, SLOT.pushes, SLOT.pops]) {
        this._set(slot, 0);
      }
      if (this.shared) {
        this._add(SLOT.waiters, 1);
        global.Atomics.notify(this.control, SLOT.waiters);
      }
    }
  }

  /**
   * Create a ring.
   * @param {Object} opts - the ring's shape.
   * @param {number} opts.capacityFrames - requested frames per channel; rounded
   *   up to a power of two, at least 64.
   * @param {number} [opts.channels=1] - how many channels the ring carries.
   * @param {boolean} [opts.shared] - force the memory kind; by default shared
   *   when the host has `SharedArrayBuffer`, plain otherwise.
   * @returns {Ring} the producer's end (the consumer gets it from
   *   {@link RSRingBuffer.from} or from a structured clone).
   */
  function create(opts) {
    const o = opts || {};
    const channels = Math.max(1, Math.min(8, Math.round(o.channels || 1)));
    const capacity = capacityFor(o.capacityFrames);
    const shared = o.shared === undefined ? isSupported() : !!o.shared && isSupported();
    const bytes = HEADER_BYTES + channels * capacity * 4;
    const buffer = shared ? new global.SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    const ring = new Ring(buffer, shared, true);
    ring.capacity = capacity;
    ring.channels = channels;
    ring.control[SLOT.magic] = MAGIC;
    ring.control[SLOT.version] = VERSION;
    ring.control[SLOT.capacity] = capacity;
    ring.control[SLOT.channels] = channels;
    ring.data = [];
    for (let c = 0; c < channels; c++) {
      ring.data.push(new Float32Array(buffer, HEADER_BYTES + c * capacity * 4, capacity));
    }
    return ring;
  }

  /**
   * Attach to a ring somebody else created — the consumer's half of the story,
   * and how a worker gets a ring that arrived in a message.
   * @param {(ArrayBuffer|SharedArrayBuffer|Ring)} buffer - the backing store
   *   (or an existing ring, whose store is reused).
   * @returns {?Ring} the attached ring, or `null` when the header is not a
   *   ring this revision understands.
   */
  function from(buffer) {
    const store = buffer && buffer.buffer && buffer.control ? buffer.buffer : buffer;
    if (!store || typeof store.byteLength !== 'number' || store.byteLength < HEADER_BYTES) return null;
    const shared = typeof global.SharedArrayBuffer === 'function' && store instanceof global.SharedArrayBuffer;
    const probe = new Int32Array(store, 0, CONTROL_INTS);
    if (probe[SLOT.magic] !== MAGIC || probe[SLOT.version] !== VERSION) return null;
    const ring = new Ring(store, shared, false);
    if (!ring.capacity || !ring.channels) return null;
    return ring;
  }

  /**
   * The public surface, assigned to `global.RSRingBuffer` below. Every member
   * degrades instead of throwing: a browser too old for shared memory still
   * gets a working ring, just not a shared one.
   * @typedef {Object} RSRingBufferApi
   * @property {function(): boolean} isSupported
   * @property {function(Object): Ring} create
   * @property {function((ArrayBuffer|SharedArrayBuffer|Ring)): ?Ring} from
   * @property {function(number): number} capacityFor
   * @property {number} MIN_CAPACITY
   * @property {number} HEADER_BYTES
   * @property {number} VERSION
   * @property {Object} SLOT
   */

  /** @type {RSRingBufferApi} */
  const API = { isSupported, create, from, capacityFor, MIN_CAPACITY, HEADER_BYTES, VERSION, SLOT };
  global.RSRingBuffer = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
