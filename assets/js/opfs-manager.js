/* =============================================================================
 * Remaster Suite — Origin Private File System (OPFS) scratch storage
 * -----------------------------------------------------------------------------
 * The browser caps how much audio a tab may hold as plain `ArrayBuffer`s —
 * roughly 420 MB on a phone, 900 MB on a desktop (see `app.js#CONFIG.
 * softMemoryMB`). A batch of a dozen 24-bit WAV masters blows past that the
 * moment every rendered file is kept in a JS array while the ZIP is built.
 *
 * This module gives the renderer and the batch exporter a disk-backed scratch
 * pad instead: the Origin Private File System, written to with
 * `FileSystemSyncAccessHandle` — the one part of OPFS fast and synchronous
 * enough for this, and (by spec) only available inside a dedicated Worker, so
 * that is where all of it lives. The main thread never sees more than one
 * bounded chunk (≈1 MB) at a time; the rest sits on disk until it is either
 * streamed into the next stage or handed to the browser as a download.
 *
 * Three things are exposed on `RSOPFS`:
 *   - `createWriter(key)`   a sink that accepts chunks and streams them into
 *                           an OPFS file (used by the streaming WAV/MP3
 *                           encoders in codecs.js).
 *   - `getFile(key)`        the finished file as a native `File` — handing a
 *                           `File` to `URL.createObjectURL` or to JSZip never
 *                           duplicates its bytes into the JS heap.
 *   - `packZip(entries,…)`  assembles a ZIP (STORE, streamed, data
 *                           descriptors — no re-compression, no full-file
 *                           buffering) entirely OPFS-file → OPFS-file inside
 *                           the worker.
 *
 * Every entry point degrades gracefully: browsers without OPFS/worker support
 * get an in-memory stand-in with the exact same surface, so call sites never
 * need to branch on support — `isSupported()` only matters for deciding
 * whether the user gets the soft-memory warning.
 * ========================================================================== */
/**
 * @fileoverview Origin Private File System scratch storage — exposed as the
 * global `RSOPFS` (`globalThis.RSOPFS`).
 *
 * The browser caps how much audio a tab may hold as plain `ArrayBuffer`s
 * (roughly 420 MB on a phone, 900 MB on a desktop — see `app.js`'s
 * `CONFIG.softMemoryMB`). A batch of a dozen 24-bit WAV masters blows past
 * that the moment every rendered file is kept in a JS array while the ZIP is
 * built, so this module gives the renderer and the batch exporter a
 * disk-backed scratch pad instead: the Origin Private File System, written
 * with `FileSystemSyncAccessHandle` — the one part of OPFS fast and
 * synchronous enough for this, and (by specification) only available inside a
 * dedicated Worker, which is why all of it lives there.
 *
 * Three things are exposed on `RSOPFS`:
 *   - `createWriter(key)` — a sink that takes chunks and streams them into an
 *     OPFS file (used by the streaming WAV/MP3 encoders in `codecs.js`).
 *   - `getFile(key)` — the finished file as a native `File`; handing a `File`
 *     to `URL.createObjectURL` or to JSZip never duplicates its bytes into the
 *     JS heap.
 *   - `packZip(entries, outKey, onFileProgress)` — assemble a ZIP (STORE,
 *     streamed, data descriptors — no re-compression, no full-file buffering)
 *     entirely OPFS-file → OPFS-file inside the worker.
 *
 * The worker's *source text* is built here, from the very functions in this
 * file ({@link RSOPFS.buildWorkerSource}), so the ZIP bytes it produces and
 * the bytes the Node suite asserts on come from one single implementation.
 *
 * Every entry point degrades gracefully: a browser without OPFS/worker
 * support gets an in-memory stand-in with the exact same surface, so call
 * sites never branch on support — `isSupported()` only matters for deciding
 * whether the user sees the soft-memory warning.
 *
 * @module RSOPFS
 */
(function (global) {
  'use strict';

  /** Directory name inside the OPFS root that holds every scratch file. */
  const SCRATCH_DIR = 'rs-scratch';

  /**
   * One entry of a `packZip()` call: either a scratch file (`key`) or literal
   * bytes (`bytes`) — never both.
   * @typedef {Object} ZipEntry
   * @property {string} name - file name inside the archive, UTF-8 encoded.
   * @property {string} [key] - scratch file to stream in, when the payload is
   *   already on disk (the case that keeps the heap small).
   * @property {Uint8Array} [bytes] - literal payload, for small generated
   *   files such as a README.
   * @property {number} [size] - byte count, used only by the Zip32 fit check
   *   for entries given as `key` (a `bytes` entry's length is read directly).
   */

  /**
   * The `pack` command the worker executes: which entries to write, where the
   * finished archive goes, and the request id the reply carries.
   * @typedef {Object} PackMessage
   * @property {number} reqId - request id, echoed back in the reply.
   * @property {string} outKey - scratch file the archive is written to.
   * @property {ZipEntry[]} entries - the entries, in archive order.
   */

  /**
   * A streaming sink. Write any number of chunks in order, then `close()` once
   * — or `abort()` to drop the partial file instead of publishing it.
   * @typedef {Object} ScratchWriter
   * @property {string} key - the scratch file name this writer fills.
   * @property {function((Uint8Array|ArrayBuffer)): Promise<void>} write - append
   *   one chunk; rejects with `'writer already closed'` after close/abort.
   * @property {function(): Promise<{size: number, key: string}>} close - flush
   *   and publish; the result is what `getFile(key)` can then hand out.
   * @property {function(): Promise<void>} abort - discard the partial file and
   *   delete it from scratch storage; idempotent.
   */

  /**
   * The result of {@link RSOPFS.streamFileIntoScratch}: the file to use from
   * here on, plus what happened to it.
   * @typedef {Object} StreamedFile
   * @property {File} file - the OPFS copy when it was streamed, otherwise the
   *   caller's own `File`/`Blob` unchanged.
   * @property {string|null} key - scratch key to pass to `getFile`/`remove`, or
   *   `null` when nothing was copied (the in-memory fallback paths).
   * @property {number} size - byte count of the file.
   * @property {boolean} streamed - `true` when the bytes really went to OPFS in
   *   bounded slices, `false` when the original file was handed straight back.
   */

  /* ====================================================================== *
   * Pure helpers — no DOM, no OPFS. Shared between this (main-thread) file
   * and the worker by shipping their *source text* into the worker blob
   * (see `buildWorkerSource` below), so the ZIP bytes it produces and the
   * bytes a Node test can assert on come from one single implementation.
   * ====================================================================== */

  /**
   * Build the 256-entry lookup table for the reflected CRC-32 polynomial
   * `0xEDB88320` — the variant every ZIP file uses (ISO/IEC 13239).
   * @returns {Uint32Array} the table, entries already unsigned.
   */
  function crc32Table() {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  }

  /**
   * Lazily built CRC table (a 1 KiB allocation that a session without a ZIP
   * never pays for).
   * @type {Uint32Array|null}
   */
  let CRC_TABLE = null;
  /**
   * Incremental CRC-32 — call once per chunk, carrying `crc` forward (start at
   * 0), so a multi-megabyte file's checksum never needs its bytes twice. The
   * value is folded in and out of its inverted form on every call, which is
   * what lets one chunk's result be the next chunk's seed.
   * @param {Uint8Array} bytes - the next slice of the file.
   * @param {number} crc - running CRC *already* un-inverted (`0` to start).
   * @returns {number} the running CRC, to feed back in on the next chunk.
   */
  function crc32Update(bytes, crc) {
    if (!CRC_TABLE) CRC_TABLE = crc32Table();
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * Convert a date to the packed MS-DOS date/time pair ZIP headers expect —
   * 1980-based year, 2-second resolution, local time. Handed in explicitly so
   * a test can pin one archive's bytes.
   * @param {Date} [date=new Date()] - the timestamp to convert.
   * @returns {{time: number, date: number}} both 16-bit fields.
   */
  function dosDateTime(date) {
    const d = date || new Date();
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
    const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
    return { time: time & 0xffff, date: day & 0xffff };
  }

  /**
   * UTF-8 encode a file name. `TextEncoder` where it exists, and the classic
   * percent-escape round trip as the fallback for engines that predate it.
   * @param {string} str - the name to encode.
   * @returns {Uint8Array} its UTF-8 bytes.
   */
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const esc = unescape(encodeURIComponent(str));
    const out = new Uint8Array(esc.length);
    for (let i = 0; i < esc.length; i++) out[i] = esc.charCodeAt(i);
    return out;
  }

  /**
   * Append a 16-bit little-endian value to a byte array.
   * @param {number[]} arr - destination, appended to in place.
   * @param {number} v - the value; only its low 16 bits are used.
   * @returns {void}
   */
  function pushU16(arr, v) { arr.push(v & 0xff, (v >> 8) & 0xff); }
  /**
   * Append a 32-bit little-endian value to a byte array.
   * @param {number[]} arr - destination, appended to in place.
   * @param {number} v - the value; coerced to unsigned first.
   * @returns {void}
   */
  function pushU32(arr, v) { v = v >>> 0; arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }

  /**
   * "Version needed to extract": 2.0 sentinel — this packer uses STORE plus
   * data descriptors and nothing exotic.
   * @type {number}
   */
  const ZIP_VERSION = 20;
  /**
   * General-purpose bit 11: file names are UTF-8, not CP437. Set on every
   * entry, so a batch of German file names unpacks correctly everywhere.
   * @type {number}
   */
  const FLAG_UTF8 = 0x0800;
  /**
   * General-purpose bit 3: sizes and CRC follow the data instead of sitting in
   * the local header. This is what makes the streaming case possible — the
   * payload is read once, the checksum falls out of that single pass.
   * @type {number}
   */
  const FLAG_DATA_DESCRIPTOR = 0x0008;

  /**
   * ZIP local file header for an entry whose size/CRC are not known yet
   * (general-purpose bit 3 set — the streaming case: data is copied once, the
   * checksum falls out of that single pass, no second read needed).
   * @param {Uint8Array} nameBytes - UTF-8 file name.
   * @param {{time: number, date: number}} dt - packed MS-DOS timestamp.
   * @returns {Uint8Array} the 30-byte header plus the name.
   */
  function zipLocalHeader(nameBytes, dt) {
    const a = [];
    pushU32(a, 0x04034b50);
    pushU16(a, ZIP_VERSION);
    pushU16(a, FLAG_UTF8 | FLAG_DATA_DESCRIPTOR);
    pushU16(a, 0);                        // method 0 = store
    pushU16(a, dt.time);
    pushU16(a, dt.date);
    pushU32(a, 0);                        // crc32 — in the descriptor
    pushU32(a, 0);                        // compressed size — in the descriptor
    pushU32(a, 0);                        // uncompressed size — in the descriptor
    pushU16(a, nameBytes.length);
    pushU16(a, 0);                        // no extra field
    const out = new Uint8Array(a.length + nameBytes.length);
    out.set(a, 0);
    out.set(nameBytes, a.length);
    return out;
  }

  /**
   * The 16-byte data descriptor that follows a streamed entry's payload —
   * signature, CRC and size written twice, as the format requires.
   * @param {number} crc - CRC-32 of the entry's bytes.
   * @param {number} size - byte count of the entry's bytes.
   * @returns {Uint8Array} the descriptor.
   */
  function zipDataDescriptor(crc, size) {
    const a = [];
    pushU32(a, 0x08074b50);
    pushU32(a, crc);
    pushU32(a, size);
    pushU32(a, size);
    return Uint8Array.from(a);
  }

  /**
   * ZIP central-directory record for one already-written entry. The central
   * directory is what an unzip tool reads first, so every field here has to
   * agree with what the local header claimed.
   * @param {Uint8Array} nameBytes - UTF-8 file name (same bytes as local).
   * @param {{time: number, date: number}} dt - the same timestamp as local.
   * @param {number} crc - CRC-32 of the payload.
   * @param {number} size - payload length in bytes.
   * @param {number} localOffset - byte offset of the entry's local header.
   * @returns {Uint8Array} the 46-byte record plus the name.
   */
  function zipCentralHeader(nameBytes, dt, crc, size, localOffset) {
    const a = [];
    pushU32(a, 0x02014b50);
    pushU16(a, ZIP_VERSION);               // version made by
    pushU16(a, ZIP_VERSION);               // version needed
    pushU16(a, FLAG_UTF8 | FLAG_DATA_DESCRIPTOR);
    pushU16(a, 0);
    pushU16(a, dt.time);
    pushU16(a, dt.date);
    pushU32(a, crc);
    pushU32(a, size);
    pushU32(a, size);
    pushU16(a, nameBytes.length);
    pushU16(a, 0);                         // extra field length
    pushU16(a, 0);                         // comment length
    pushU16(a, 0);                         // disk number start
    pushU16(a, 0);                         // internal attributes
    pushU32(a, 0);                         // external attributes
    pushU32(a, localOffset);
    const out = new Uint8Array(a.length + nameBytes.length);
    out.set(a, 0);
    out.set(nameBytes, a.length);
    return out;
  }

  /**
   * The end-of-central-directory record: entry count, central directory size
   * and offset — everything an unzip tool needs to find the index without
   * scanning backwards for a signature.
   * @param {number} count - number of entries in the archive.
   * @param {number} cdSize - size of the central directory in bytes.
   * @param {number} cdOffset - where the central directory starts.
   * @returns {Uint8Array} the 22-byte record (no archive comment).
   */
  function zipEOCD(count, cdSize, cdOffset) {
    const a = [];
    pushU32(a, 0x06054b50);
    pushU16(a, 0);
    pushU16(a, 0);
    pushU16(a, count);
    pushU16(a, count);
    pushU32(a, cdSize);
    pushU32(a, cdOffset);
    pushU16(a, 0);                         // no comment
    return Uint8Array.from(a);
  }

  /**
   * Classic (non-Zip64) ZIP32 hard limit, `2^32 - 2`. Above this the packer
   * refuses and the caller falls back to the in-memory JSZip path, which has
   * the same practical ceiling anyway.
   * @type {number}
   */
  const ZIP32_MAX = 0xfffffffe;
  /**
   * Whether an entry list still fits ZIP32: at most 65534 entries, no single
   * payload at the limit, and a total that stays below it once 128 bytes of
   * headers and descriptor slack per entry are counted.
   * @param {ZipEntry[]} entries - the entries about to be packed.
   * @returns {boolean} `true` when a classic ZIP can hold them.
   */
  function fitsZip32(entries) {
    if (entries.length > 0xfffe) return false;
    let total = 0;
    for (const e of entries) {
      const size = e.size || 0;
      if (size > ZIP32_MAX) return false;
      total += size + 128; // headers/descriptor slack
    }
    return total <= ZIP32_MAX;
  }

  /**
   * The pure half of this module — no DOM, no OPFS, no worker — exported so
   * the Node suite can assert on the ZIP bytes themselves. The worker's source
   * text is assembled from these very functions, so testing them *is* testing
   * what the browser packs.
   * @typedef {Object} ZipPureHelpers
   * @property {function(): Uint32Array} crc32Table
   * @property {function(Uint8Array, number): number} crc32Update
   * @property {function(Date=): {time: number, date: number}} dosDateTime
   * @property {function(string): Uint8Array} utf8Bytes
   * @property {function(number[], number): void} pushU16
   * @property {function(number[], number): void} pushU32
   * @property {function(Uint8Array, Object): Uint8Array} zipLocalHeader
   * @property {function(number, number): Uint8Array} zipDataDescriptor
   * @property {function(Uint8Array, Object, number, number, number): Uint8Array} zipCentralHeader
   * @property {function(number, number, number): Uint8Array} zipEOCD
   * @property {number} ZIP_VERSION
   * @property {number} FLAG_UTF8
   * @property {number} FLAG_DATA_DESCRIPTOR
   * @property {number} ZIP32_MAX
   * @property {function(ZipEntry[]): boolean} fitsZip32
   */

  /** @type {ZipPureHelpers} */
  const PURE = {
    crc32Table, crc32Update, dosDateTime, utf8Bytes, pushU16, pushU32,
    zipLocalHeader, zipDataDescriptor, zipCentralHeader, zipEOCD,
    ZIP_VERSION, FLAG_UTF8, FLAG_DATA_DESCRIPTOR, ZIP32_MAX, fitsZip32,
  };

  /* ====================================================================== *
   * Worker source — the pure helpers above, shipped as text, plus the part
   * that actually touches OPFS (sync access handles only exist in workers).
   * ====================================================================== */

  /**
   * The worker's entire main program, serialised into the blob by
   * {@link RSOPFS.buildWorkerSource}. It runs on `self` and speaks a tiny
   * message protocol (`probe`, `open`, `write`, `close`, `abort`, `remove`,
   * `resetScratch`, `pack`), each request answered with
   * `{reqId, ok: true, …}` or `{reqId, ok: false, err}` — never by throwing
   * across the thread boundary.
   *
   * Why the indirection: a `FileSystemSyncAccessHandle` can only be created
   * inside a dedicated worker, so the code has to live there. Shipping it as
   * *text* built from this file keeps one implementation for browser and test;
   * it is why the pure helpers above are separate functions with no closures.
   * @returns {void}
   */
  function workerMain() {
    /* eslint-disable no-undef */
    /**
     * Cached OPFS root promise — `getDirectory()` is async, and every command
     * needs the same root, so it is awaited once per worker.
     * @type {Promise<FileSystemDirectoryHandle>|null}
     */
    let rootPromise = null;
    /**
     * The OPFS root directory handle, resolved once.
     * @returns {Promise<FileSystemDirectoryHandle>} the storage root.
     */
    function root() {
      if (!rootPromise) rootPromise = self.navigator.storage.getDirectory();
      return rootPromise;
    }
    /**
     * The scratch directory, created on first use.
     * @returns {Promise<FileSystemDirectoryHandle>} `rs-scratch` under the root.
     */
    async function scratchDir() {
      const r = await root();
      return r.getDirectoryHandle('rs-scratch', { create: true });
    }

    /**
     * Open scratch files, keyed by a per-worker numeric id: the sync handle
     * plus how far it has been written, so `write` can append without the
     * caller tracking offsets across the thread boundary.
     * @type {Map<number, {sync: FileSystemSyncAccessHandle, pos: number, key: string}>}
     */
    const handles = new Map();
    /** Monotonic handle id; never reused, so a stale id cannot hit a new file. */
    let nextId = 1;

    /**
     * Create (or truncate) a scratch file for writing and register a handle.
     * @param {string} key - file name inside the scratch directory.
     * @returns {Promise<number>} the handle id to send back to the main thread.
     */
    async function openForWrite(key) {
      const dir = await scratchDir();
      const fh = await dir.getFileHandle(key, { create: true });
      const sync = await fh.createSyncAccessHandle();
      sync.truncate(0);
      const id = nextId++;
      handles.set(id, { sync, pos: 0, key });
      return id;
    }

    /**
     * Open an existing scratch file for reading and register a handle.
     * @param {string} key - file name inside the scratch directory.
     * @returns {Promise<number>} the handle id.
     */
    async function openForRead(key) {
      const dir = await scratchDir();
      const fh = await dir.getFileHandle(key, { create: false });
      const sync = await fh.createSyncAccessHandle();
      const id = nextId++;
      handles.set(id, { sync, pos: 0, key });
      return id;
    }

    /**
     * Flush (optionally) and close a registered handle, then forget it. Every
     * error is swallowed: closing twice, or closing a file the OS already
     * released, must not surface as a failed user action.
     * @param {number} id - the handle id.
     * @param {boolean} andFlush - `true` to flush buffered writes first (the
     *   `close` command does; `abort` does not).
     * @returns {void}
     */
    function closeHandle(id, andFlush) {
      const h = handles.get(id);
      if (!h) return;
      try { if (andFlush) h.sync.flush(); } catch (e) { /* ignore */ }
      try { h.sync.close(); } catch (e) { /* ignore */ }
      handles.delete(id);
    }

    /**
     * Copy one whole OPFS source file into the destination handle, CRC'd as it
     * goes, never holding more than one chunk (1 MiB) at a time — the memory
     * guarantee that makes a multi-gigabyte batch possible.
     * @param {FileSystemSyncAccessHandle} srcSync - source handle, read-only use.
     * @param {FileSystemSyncAccessHandle} destSync - destination handle.
     * @param {number} destPos - byte offset in the destination to write at.
     * @param {function(number): void} [onBytes] - progress callback, called per
     *   chunk with the cumulative byte count.
     * @returns {{crc: number, size: number}} the checksum and size that go into
     *   the entry's data descriptor.
     */
    function streamCopy(srcSync, destSync, destPos, onBytes) {
      const CHUNK = 1 << 20; // 1 MiB
      const buf = new Uint8Array(CHUNK);
      let crc = 0;
      let size = 0;
      let readPos = 0;
      for (;;) {
        const n = srcSync.read(buf, { at: readPos });
        if (!n) break;
        const view = n === buf.length ? buf : buf.subarray(0, n);
        crc = crc32Update(view, crc);
        destSync.write(view, { at: destPos + size });
        size += n;
        readPos += n;
        if (onBytes) onBytes(size);
      }
      return { crc, size };
    }

    /**
     * Build one complete ZIP: local header, streamed payload, data descriptor
     * and central-directory record per entry, then the central directory and
     * the EOCD. Nothing but one chunk per entry ever sits in memory.
     * @param {RSOPFS.PackMessage} msg - the `pack` command.
     * @returns {Promise<{size: number}>} the archive size in bytes.
     */
    async function doPack(msg) {
      const entries = msg.entries || [];
      const dt = dosDateTime(new Date());
      const outId = await openForWrite(msg.outKey);
      const out = handles.get(outId);
      const central = [];
      let pos = 0;
      try {
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const nameBytes = utf8Bytes(e.name);
          const localOffset = pos;
          const header = zipLocalHeader(nameBytes, dt);
          out.sync.write(header, { at: pos });
          pos += header.length;

          let crc = 0, size = 0;
          if (e.key) {
            const srcId = await openForRead(e.key);
            const src = handles.get(srcId);
            try {
              const r = streamCopy(src.sync, out.sync, pos, (copied) => {
                self.postMessage({ type: 'progress', reqId: msg.reqId, index: i, name: e.name, copied });
              });
              crc = r.crc; size = r.size;
            } finally {
              closeHandle(srcId, false);
            }
          } else {
            const bytes = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes || []);
            crc = crc32Update(bytes, 0);
            size = bytes.length;
            out.sync.write(bytes, { at: pos });
          }
          pos += size;

          const desc = zipDataDescriptor(crc, size);
          out.sync.write(desc, { at: pos });
          pos += desc.length;

          central.push(zipCentralHeader(nameBytes, dt, crc, size, localOffset));
        }

        const cdStart = pos;
        for (const rec of central) { out.sync.write(rec, { at: pos }); pos += rec.length; }
        const eocd = zipEOCD(central.length, pos - cdStart, cdStart);
        out.sync.write(eocd, { at: pos }); pos += eocd.length;
        out.sync.flush();
        return { size: pos };
      } finally {
        closeHandle(outId, true);
      }
    }

    /**
     * The worker's command dispatcher. Every branch answers with a message
     * (success or failure) rather than throwing, because an unhandled rejection
     * here would leave the main thread waiting for a reply that never comes.
     * @param {MessageEvent} ev - the request; `ev.data.cmd` selects the branch.
     * @returns {Promise<void>} resolves after the reply was posted.
     */
    self.onmessage = async (ev) => {
      const msg = ev.data || {};
      /** Post a success reply for the request in flight.
       *  @param {Object} [extra] - fields to merge into the reply. */
      const reply = (extra) => self.postMessage(Object.assign({ reqId: msg.reqId, ok: true }, extra));
      /** Post a failure reply; the message is stringified so it survives the
       *  structured clone across the thread boundary.
       *  @param {*} err - the thrown value. */
      const fail = (err) => self.postMessage({ reqId: msg.reqId, ok: false, err: String((err && err.message) || err) });
      try {
        switch (msg.cmd) {
          case 'probe': {
            const ok = typeof self.FileSystemFileHandle !== 'undefined'
              && typeof self.FileSystemFileHandle.prototype.createSyncAccessHandle === 'function'
              && !!(self.navigator && self.navigator.storage && self.navigator.storage.getDirectory);
            reply({ supported: ok });
            break;
          }
          case 'open': {
            const id = msg.mode === 'read' ? await openForRead(msg.key) : await openForWrite(msg.key);
            reply({ id });
            break;
          }
          case 'write': {
            const h = handles.get(msg.id);
            if (!h) throw new Error('no such handle');
            const u8 = new Uint8Array(msg.buf);
            h.sync.write(u8, { at: h.pos });
            h.pos += u8.length;
            reply({ pos: h.pos });
            break;
          }
          case 'close': {
            const h = handles.get(msg.id);
            const size = h ? h.pos : 0;
            closeHandle(msg.id, true);
            reply({ size });
            break;
          }
          case 'abort': {
            const h = handles.get(msg.id);
            const key = h && h.key;
            closeHandle(msg.id, false);
            if (key) { try { (await scratchDir()).removeEntry(key); } catch (e) { /* ignore */ } }
            reply({});
            break;
          }
          case 'remove': {
            try { (await scratchDir()).removeEntry(msg.key); } catch (e) { /* already gone */ }
            reply({});
            break;
          }
          case 'resetScratch': {
            try {
              const dir = await scratchDir();
              const names = [];
              for await (const name of dir.keys()) names.push(name);
              for (const n of names) { try { await dir.removeEntry(n); } catch (e) { /* ignore */ } }
            } catch (e) { /* ignore */ }
            reply({});
            break;
          }
          case 'pack': {
            const result = await doPack(msg);
            reply(result);
            break;
          }
          default:
            throw new Error('unknown command: ' + msg.cmd);
        }
      } catch (err) {
        fail(err);
      }
    };

    /** Tells the main thread the worker is listening, before any request. */
    self.postMessage({ ready: true });
  }

  /**
   * Assemble the worker's source text: the ZIP constants, the *source text* of
   * every pure helper, and `workerMain()` itself, invoked once. Building it
   * from `Function.prototype.toString()` is what keeps a single implementation
   * of the ZIP bytes for browser and test.
   * @returns {string} a complete classic-script worker source.
   */
  function buildWorkerSource() {
    const constsSrc = 'const ZIP_VERSION = ' + ZIP_VERSION + ', FLAG_UTF8 = ' + FLAG_UTF8
      + ', FLAG_DATA_DESCRIPTOR = ' + FLAG_DATA_DESCRIPTOR + ';\nlet CRC_TABLE = null;\n';
    const pureSrc = [
      crc32Table, crc32Update, dosDateTime, utf8Bytes, pushU16, pushU32,
      zipLocalHeader, zipDataDescriptor, zipCentralHeader, zipEOCD,
    ].map((fn) => fn.toString()).join('\n');
    return constsSrc + pureSrc + '\n(' + workerMain.toString() + ')();\n';
  }

  /* ====================================================================== *
   * Main-thread facade
   * ====================================================================== */

  /**
   * The one worker instance, or `null` before the first call and after a host
   * that cannot spawn one (`Worker`/`Blob`/`URL.createObjectURL` missing).
   * @type {Worker|null}
   */
  let worker = null;
  /**
   * Object URL of the worker blob, kept alive for the page's lifetime so the
   * worker is never revoked under its own feet.
   * @type {string|null}
   */
  let workerUrl = null;
  /** Monotonic request id, so a timed-out request's late reply is ignored. */
  let nextReqId = 1;
  /**
   * In-flight requests by id, plus the `'progress:<id>'` slots registered by
   * {@link RSOPFS.onProgress}.
   * @type {Map<(number|string), {resolve: Function, reject: Function}>}
   */
  const pending = new Map();
  /**
   * Cached answer of the capability probe — the probe spawns a worker and
   * round-trips a message, so it is done once per page.
   * @type {Promise<boolean>|null}
   */
  let supportedPromise = null;

  /**
   * Spawn the worker on first use (blob URL, so no extra file is served), and
   * route its messages: `progress` frames go to the per-request listener from
   * {@link RSOPFS.onProgress}, `ready` is ignored, and everything else settles
   * the matching {@link pending} entry.
   * @returns {Worker|null} the worker, or `null` when the host cannot make one.
   */
  function spawnWorker() {
    if (worker) return worker;
    if (typeof global.Worker !== 'function' || typeof global.Blob !== 'function') return null;
    try {
      workerUrl = global.URL.createObjectURL(new global.Blob([buildWorkerSource()], { type: 'application/javascript' }));
      worker = new global.Worker(workerUrl);
      worker.onmessage = (ev) => {
        const data = ev.data || {};
        if (data.type === 'progress') {
          const p = pending.get('progress:' + data.reqId);
          if (p) p(data);
          return;
        }
        if (data.ready) return;
        const req = pending.get(data.reqId);
        if (!req) return;
        pending.delete(data.reqId);
        if (data.ok === false) req.reject(new Error(data.err || 'opfs worker error'));
        else req.resolve(data);
      };
      worker.onerror = () => { /* individual requests reject on their own timeout */ };
    } catch (e) {
      worker = null;
    }
    return worker;
  }

  /**
   * Send one command and resolve with its reply, with an optional timeout.
   * The `buf` field, when present, is *transferred* rather than copied, so a
   * 1 MiB write does not double its memory on the way into the worker.
   * @param {Object} msg - the command (`cmd` field) plus its parameters.
   * @param {number} [timeoutMs] - reject after this long; `0`/omitted means no
   *   timeout (a long ZIP pack must not be cut off).
   * @returns {Promise<Object>} the worker's reply object.
   */
  function call(msg, timeoutMs) {
    const w = spawnWorker();
    if (!w) return Promise.reject(new Error('no worker available'));
    const reqId = nextReqId++;
    msg.reqId = reqId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? global.setTimeout(() => {
        pending.delete(reqId);
        reject(new Error('opfs timeout: ' + msg.cmd));
      }, timeoutMs) : null;
      pending.set(reqId, {
        /**
         * Settle the pending request and disarm its timeout.
         * @param {*} v - the worker's reply payload.
         * @returns {void}
         */
        resolve: (v) => { if (timer) global.clearTimeout(timer); resolve(v); },
        /**
         * Reject the pending request and disarm its timeout.
         * @param {Error} e - the failure the worker (or the timer) reported.
         * @returns {void}
         */
        reject: (e) => { if (timer) global.clearTimeout(timer); reject(e); },
      });
      const transfer = msg.buf ? [msg.buf] : undefined;
      w.postMessage(msg, transfer);
    });
  }

  /**
   * Register a progress listener for one in-flight request id.
   * @param {number} reqId - the request to watch.
   * @param {function({index: number, name: string, copied: number}): void} fn
   *   - called per copied chunk during a streamed `pack`.
   * @returns {function(): void} `off()` — removes the listener.
   */
  function onProgress(reqId, fn) {
    pending.set('progress:' + reqId, fn);
    return () => pending.delete('progress:' + reqId);
  }

  /**
   * The scratch directory handle on the *main* thread — plain reads (`getFile`)
   * need no sync access handle, hence no worker.
   * @param {boolean} create - `true` to create the directory when missing
   *   (writing), `false` to fail instead (reading).
   * @returns {Promise<FileSystemDirectoryHandle>} the scratch directory.
   * @throws {Error} `'OPFS unavailable'` when the host has no OPFS at all.
   */
  async function scratchDirHandle(create) {
    if (!global.navigator || !global.navigator.storage || !global.navigator.storage.getDirectory) {
      throw new Error('OPFS unavailable');
    }
    const root = await global.navigator.storage.getDirectory();
    return root.getDirectoryHandle(SCRATCH_DIR, { create: !!create });
  }

  /**
   * Feature + capability probe, cached. Resolves `false` the moment any part
   * of the chain (OPFS root, sync access handles, dedicated workers) is
   * missing — Safari < 16.4, Firefox < 111, private-browsing quotas, etc.
   * @returns {Promise<boolean>} never rejects: every failure path resolves
   *   `false`, which is exactly the signal the caller turns into the
   *   in-memory fallback (keep the heap small) instead of an error.
   */
  function isSupported() {
    if (supportedPromise) return supportedPromise;
    supportedPromise = (async () => {
      try {
        if (!global.navigator || !global.navigator.storage || typeof global.navigator.storage.getDirectory !== 'function') return false;
        const res = await call({ cmd: 'probe' }, 4000);
        return !!res.supported;
      } catch (e) {
        return false;
      }
    })();
    return supportedPromise;
  }

  /* -------------------------------------------------------- memory fallback */

  /**
   * The in-memory stand-in for {@link RSOPFS.createWriter}, used whenever OPFS
   * is unavailable. Chunks are kept in a plain array and joined into one `Blob`
   * on close, which is the same *behaviour* as the OPFS writer — only without
   * the disk behind it, so the soft-memory ceiling still applies.
   * @param {string} key - scratch key; it only labels the resulting blob.
   * @returns {ScratchWriter} the sink.
   */
  function memoryWriter(key) {
    const parts = [];
    let size = 0;
    return {
      key,
      /**
       * Append one chunk to the in-memory list.
       * @param {(Uint8Array|ArrayBuffer)} chunk - the bytes to append.
       * @returns {Promise<void>} resolves when the copy is kept.
       */
      async write(chunk) {
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        parts.push(u8);
        size += u8.length;
      },
      /**
       * Freeze the collected parts into one Blob — the in-memory fallback's
       * equivalent of closing a real file — and return its size.
       * @returns {Promise<{size:number, key:string}>} bytes written and key.
       */
      async close() {
        const blob = new global.Blob(parts, { type: 'application/octet-stream' });
        MEMORY_FILES.set(key, blob);
        return { size, key };
      },
      async abort() { MEMORY_FILES.delete(key); },
    };
  }
  /**
   * The fallback store: scratch key → finished `Blob`. Only used when OPFS is
   * unavailable, and read back by `getFile()` in that same case.
   * @type {Map<string, Blob>}
   */
  const MEMORY_FILES = new Map();

  /* ------------------------------------------------------------- public API */

  /**
   * A streaming sink: `write(chunk)` any number of times, then `close()`.
   * Backed by a `FileSystemSyncAccessHandle` inside the worker when OPFS is
   * available, otherwise an in-memory fallback with the same shape.
   * @param {string} key - scratch file name (the caller picks something
   *   unique per job; `app.js` derives it from the file's index and name).
   * @returns {Promise<ScratchWriter>} the sink; it is already open here, so a
   *   caller can start writing without a further round trip.
   * @throws {Error} only when the OPFS path is supported but the worker refuses
   *   to open the file (quota exhausted, for example) — that failure is real
   *   and the caller reports it, instead of silently buffering in memory.
   */
  async function createWriter(key) {
    const supported = await isSupported();
    if (!supported) return memoryWriter(key);
    const { id } = await call({ cmd: 'open', mode: 'write', key });
    let closed = false;
    return {
      key,
      /**
       * Write one chunk through the worker's file handle.
       * @param {(Uint8Array|ArrayBuffer)} chunk - the bytes to append.
       * @returns {Promise<void>} resolves when the worker confirmed the write;
       *   rejects when the writer was already closed.
       */
      async write(chunk) {
        if (closed) throw new Error('writer already closed');
        const buf = chunk instanceof ArrayBuffer ? chunk
          : chunk.buffer.byteLength === chunk.byteLength ? chunk.buffer
            : chunk.slice().buffer;
        await call({ cmd: 'write', id, buf }, 15000);
      },
      /**
       * Close the handle and ask the worker for the final size. Idempotent: a
       * second call reports `0` bytes rather than failing, because a caller
       * that closes twice must not lose the file it already wrote.
       * @returns {Promise<{size:number, key:string}>} the file's final size.
       */
      async close() {
        if (closed) return { size: 0, key };
        closed = true;
        const res = await call({ cmd: 'close', id }, 15000);
        return { size: res.size, key };
      },
      /**
       * Give up on a half-written file and delete it. Best-effort by design:
       * an abort during teardown has nowhere to report a failure.
       * @returns {Promise<void>} always resolves.
       */
      async abort() {
        if (closed) return;
        closed = true;
        await call({ cmd: 'abort', id }).catch(() => {});
      },
    };
  }

  /**
   * Hand back a finished scratch file as a native `File`. Zero-copy on the
   * OPFS path: the bytes stay on disk and are read lazily by whoever consumes
   * the `File` (`URL.createObjectURL`, JSZip, a download).
   * @param {string} key - scratch key written by `createWriter()`.
   * @returns {Promise<File>} the file.
   * @throws {Error} `'no such scratch file: <key>'` when nothing was written
   *   under that key (a caller bug, and a loud one on purpose).
   */
  async function getFile(key) {
    const supported = await isSupported();
    if (!supported) {
      const blob = MEMORY_FILES.get(key);
      if (!blob) throw new Error('no such scratch file: ' + key);
      return new global.File([blob], key, { type: blob.type });
    }
    const dir = await scratchDirHandle(false);
    const fh = await dir.getFileHandle(key, { create: false });
    return fh.getFile();
  }

  /**
   * Delete one scratch file (render output, intermediate ZIP, input copy).
   * Best effort by contract: a failed delete must never fail the user's export,
   * and the next boot's `resetScratch()` cleans up anything left behind.
   * @param {string} key - scratch key to delete.
   * @returns {Promise<void>} resolves whether or not anything was deleted.
   */
  async function remove(key) {
    try {
      const supported = await isSupported();
      if (!supported) { MEMORY_FILES.delete(key); return; }
      await call({ cmd: 'remove', key });
    } catch (e) { /* best effort */ }
  }

  /** Wipe every scratch file — called once at boot in case a previous tab
   * crashed mid-batch and left files behind (OPFS persists across reloads,
   * unlike heap memory, so it needs its own housekeeping).
   * @returns {Promise<void>} resolves even when the wipe failed — the call is
   *   housekeeping, not a step of the user's job.
   */
  async function resetScratch() {
    try {
      const supported = await isSupported();
      if (!supported) { MEMORY_FILES.clear(); return; }
      await call({ cmd: 'resetScratch' }, 10000);
    } catch (e) { /* best effort */ }
  }

  /**
   * Stream-assemble a ZIP (STORE, data descriptors) straight from OPFS
   * sources into an OPFS destination — the main thread only ever sees the
   * small `{size}` summary, never the archive's bytes.
   * @param {ZipEntry[]} entries - the archive's contents, in order; entries
   *   given as `key` are streamed from scratch storage, never into the heap.
   * @param {string} outKey - scratch key the archive itself is written to.
   * @param {function({index: number, name: string, copied: number}): void} [onFileProgress]
   *   - progress per copied chunk of the entry at `index`.
   * @returns {Promise<{size: number}>} the archive's size in bytes.
   * @throws {Error} `'opfs-unavailable'` when there is no OPFS at all (the
   *   caller falls back to JSZip), `'batch-too-large-for-zip32'` when the entry
   *   list exceeds what a classic ZIP can address, and `'no worker available'`
   *   when the worker could not be spawned.
   */
  async function packZip(entries, outKey, onFileProgress) {
    const supported = await isSupported();
    if (!supported) throw new Error('opfs-unavailable');
    if (!PURE.fitsZip32(entries)) throw new Error('batch-too-large-for-zip32');
    const msg = { cmd: 'pack', outKey, entries: entries.map((e) => ({ name: e.name, key: e.key, bytes: e.bytes })) };
    const w = spawnWorker();
    if (!w) throw new Error('no worker available');
    const id = nextReqId++;
    msg.reqId = id;
    const off = onFileProgress ? onProgress(id, onFileProgress) : null;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage(msg);
      });
    } finally {
      if (off) off();
    }
  }

  /**
   * Copy a freshly-picked `File`/`Blob` straight into OPFS scratch storage,
   * reading it in bounded slices (`file.slice(off, end).arrayBuffer()`)
   * instead of the one `file.arrayBuffer()` call a naive upload handler would
   * make — a 96 kHz FLAC or a multi-hour DJ mix can be hundreds of MB to a
   * few GB, and that single call would need the *entire* upload resident in
   * the main thread's heap just to start writing it anywhere. Falls back to
   * handing the original `file` straight back, untouched, the moment OPFS or
   * the worker is unavailable (or the file is empty) — exactly the shape
   * every other entry point in this module already uses, so a call site
   * never has to branch on support itself.
   * @param {File|Blob} file - the user's file, straight from the drop handler.
   * @param {string} key - scratch file name (caller picks something unique).
   * @param {Object} [opts] - copy options.
   * @param {number} [opts.chunkBytes=4194304] - slice size, floored at 256 KiB;
   *   larger slices mean fewer round trips, smaller ones a smaller peak heap.
   * @param {function(number): void} [opts.onProgress] - called with a 0…1
   *   share after every written slice.
   * @returns {Promise<StreamedFile>} the file to use from here on, and whether
   *   it was really streamed.
   * @throws {Error} whatever the write failed with (quota, a device removed
   *   mid-copy) after the partial scratch file was aborted and deleted.
   */
  async function streamFileIntoScratch(file, key, opts) {
    const o = opts || {};
    const size = file ? (file.size || 0) : 0;
    const supported = await isSupported();
    if (!supported || !size || typeof file.slice !== 'function') {
      return { file, key: null, size, streamed: false };
    }
    const CHUNK = Math.max(256 * 1024, o.chunkBytes || (4 * 1024 * 1024));
    const writer = await createWriter(key);
    try {
      let off = 0;
      while (off < size) {
        const end = Math.min(size, off + CHUNK);
        const buf = await file.slice(off, end).arrayBuffer();
        await writer.write(new Uint8Array(buf));
        off = end;
        if (o.onProgress) o.onProgress(off / size);
      }
      await writer.close();
    } catch (err) {
      await writer.abort();
      throw err;
    }
    const opfsFile = await getFile(key);
    return { file: opfsFile, key, size, streamed: true };
  }

  /**
   * The public surface, assigned to `global.RSOPFS` below. Every member
   * degrades instead of throwing wherever a browser is simply too old.
   * @typedef {Object} RSOPFSApi
   * @property {ZipPureHelpers} PURE - the ZIP byte helpers, exported for
   *   Node-side unit testing of the archive bytes.
   * @property {function(): string} buildWorkerSource - the shipped worker
   *   source text, so the tests exercise exactly what the browser runs.
   * @property {function(): Promise<boolean>} isSupported
   * @property {function(string): Promise<ScratchWriter>} createWriter
   * @property {function(string): Promise<File>} getFile
   * @property {function(string): Promise<void>} remove
   * @property {function(): Promise<void>} resetScratch
   * @property {function(ZipEntry[], string, function(Object)=): Promise<{size: number}>} packZip
   * @property {function((File|Blob), string, Object=): Promise<StreamedFile>} streamFileIntoScratch
   * @property {string} scratchDirName - read-only name of the scratch directory.
   */

  /** @type {RSOPFSApi} */
  const API = {
    PURE,                 // exported for Node-side unit testing of the zip bytes
    buildWorkerSource,     // exported so tests exercise the *shipped* worker code
    isSupported,
    createWriter,
    getFile,
    remove,
    resetScratch,
    packZip,
    streamFileIntoScratch,
    /** @returns {string} the scratch directory's name inside the OPFS root. */
    get scratchDirName() { return SCRATCH_DIR; },
  };

  /** @type {RSOPFSApi} */
  global.RSOPFS = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
