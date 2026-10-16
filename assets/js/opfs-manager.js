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
(function (global) {
  'use strict';

  const SCRATCH_DIR = 'rs-scratch';

  /* ====================================================================== *
   * Pure helpers — no DOM, no OPFS. Shared between this (main-thread) file
   * and the worker by shipping their *source text* into the worker blob
   * (see `buildWorkerSource` below), so the ZIP bytes it produces and the
   * bytes a Node test can assert on come from one single implementation.
   * ====================================================================== */

  /** Reflected CRC-32 (ISO/IEC 13239, the one every ZIP uses). */
  function crc32Table() {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  }

  let CRC_TABLE = null;
  /**
   * Incremental CRC-32 — call once per chunk, carrying `crc` forward (start
   * at 0), so a multi-megabyte file's checksum never needs its bytes twice.
   * @param {Uint8Array} bytes
   * @param {number} crc running CRC *already* un-inverted (0 to start)
   * @returns {number} running CRC, feed it back in on the next chunk
   */
  function crc32Update(bytes, crc) {
    if (!CRC_TABLE) CRC_TABLE = crc32Table();
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /** MS-DOS date/time pair ZIP headers expect. */
  function dosDateTime(date) {
    const d = date || new Date();
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
    const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
    return { time: time & 0xffff, date: day & 0xffff };
  }

  /** UTF-8 bytes of a name, for the Unicode filename flag. */
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const esc = unescape(encodeURIComponent(str));
    const out = new Uint8Array(esc.length);
    for (let i = 0; i < esc.length; i++) out[i] = esc.charCodeAt(i);
    return out;
  }

  function pushU16(arr, v) { arr.push(v & 0xff, (v >> 8) & 0xff); }
  function pushU32(arr, v) { v = v >>> 0; arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }

  const ZIP_VERSION = 20;        // 2.0 — STORE + data descriptors, nothing exotic
  const FLAG_UTF8 = 0x0800;      // filenames are UTF-8
  const FLAG_DATA_DESCRIPTOR = 0x0008; // sizes/crc follow the data, not the header

  /**
   * ZIP local file header for an entry whose size/CRC are not known yet
   * (general-purpose bit 3 set — the streaming case: data is copied once,
   * the checksum falls out of that single pass, no second read needed).
   * @returns {Uint8Array}
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

  /** The 16-byte descriptor that follows a streamed entry's data. */
  function zipDataDescriptor(crc, size) {
    const a = [];
    pushU32(a, 0x08074b50);
    pushU32(a, crc);
    pushU32(a, size);
    pushU32(a, size);
    return Uint8Array.from(a);
  }

  /** ZIP central-directory record for one already-written entry. */
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

  /** End-of-central-directory record. */
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

  /** Classic (non-Zip64) ZIP32 hard limits — above this we refuse and the
   *  caller falls back to the in-memory JSZip path, which has the same
   *  practical ceiling anyway. */
  const ZIP32_MAX = 0xfffffffe;
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

  const PURE = {
    crc32Table, crc32Update, dosDateTime, utf8Bytes, pushU16, pushU32,
    zipLocalHeader, zipDataDescriptor, zipCentralHeader, zipEOCD,
    ZIP_VERSION, FLAG_UTF8, FLAG_DATA_DESCRIPTOR, ZIP32_MAX, fitsZip32,
  };

  /* ====================================================================== *
   * Worker source — the pure helpers above, shipped as text, plus the part
   * that actually touches OPFS (sync access handles only exist in workers).
   * ====================================================================== */

  function workerMain() {
    /* eslint-disable no-undef */
    let rootPromise = null;
    function root() {
      if (!rootPromise) rootPromise = self.navigator.storage.getDirectory();
      return rootPromise;
    }
    async function scratchDir() {
      const r = await root();
      return r.getDirectoryHandle('rs-scratch', { create: true });
    }

    const handles = new Map(); // id -> { sync, pos, key }
    let nextId = 1;

    async function openForWrite(key) {
      const dir = await scratchDir();
      const fh = await dir.getFileHandle(key, { create: true });
      const sync = await fh.createSyncAccessHandle();
      sync.truncate(0);
      const id = nextId++;
      handles.set(id, { sync, pos: 0, key });
      return id;
    }

    async function openForRead(key) {
      const dir = await scratchDir();
      const fh = await dir.getFileHandle(key, { create: false });
      const sync = await fh.createSyncAccessHandle();
      const id = nextId++;
      handles.set(id, { sync, pos: 0, key });
      return id;
    }

    function closeHandle(id, andFlush) {
      const h = handles.get(id);
      if (!h) return;
      try { if (andFlush) h.sync.flush(); } catch (e) { /* ignore */ }
      try { h.sync.close(); } catch (e) { /* ignore */ }
      handles.delete(id);
    }

    /** Copy one whole OPFS source file into the destination handle, CRC'd
     * as it goes, never holding more than one chunk at a time. */
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

    self.onmessage = async (ev) => {
      const msg = ev.data || {};
      const reply = (extra) => self.postMessage(Object.assign({ reqId: msg.reqId, ok: true }, extra));
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

    self.postMessage({ ready: true });
  }

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

  let worker = null;
  let workerUrl = null;
  let nextReqId = 1;
  const pending = new Map();
  let supportedPromise = null;

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
        resolve: (v) => { if (timer) global.clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) global.clearTimeout(timer); reject(e); },
      });
      const transfer = msg.buf ? [msg.buf] : undefined;
      w.postMessage(msg, transfer);
    });
  }

  function onProgress(reqId, fn) {
    pending.set('progress:' + reqId, fn);
    return () => pending.delete('progress:' + reqId);
  }

  /** Main-thread OPFS directory handle — no worker needed for plain reads. */
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

  /** Same surface as the OPFS writer, used when OPFS is unavailable. */
  function memoryWriter(key) {
    const parts = [];
    let size = 0;
    return {
      key,
      async write(chunk) {
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        parts.push(u8);
        size += u8.length;
      },
      async close() {
        const blob = new global.Blob(parts, { type: 'application/octet-stream' });
        MEMORY_FILES.set(key, blob);
        return { size, key };
      },
      async abort() { MEMORY_FILES.delete(key); },
    };
  }
  const MEMORY_FILES = new Map();

  /* ------------------------------------------------------------- public API */

  /**
   * A streaming sink: `write(chunk)` any number of times, then `close()`.
   * Backed by a `FileSystemSyncAccessHandle` inside the worker when OPFS is
   * available, otherwise an in-memory fallback with the same shape.
   * @param {string} key scratch file name (caller picks something unique)
   */
  async function createWriter(key) {
    const supported = await isSupported();
    if (!supported) return memoryWriter(key);
    const { id } = await call({ cmd: 'open', mode: 'write', key });
    let closed = false;
    return {
      key,
      async write(chunk) {
        if (closed) throw new Error('writer already closed');
        const buf = chunk instanceof ArrayBuffer ? chunk
          : chunk.buffer.byteLength === chunk.byteLength ? chunk.buffer
            : chunk.slice().buffer;
        await call({ cmd: 'write', id, buf }, 15000);
      },
      async close() {
        if (closed) return { size: 0, key };
        closed = true;
        const res = await call({ cmd: 'close', id }, 15000);
        return { size: res.size, key };
      },
      async abort() {
        if (closed) return;
        closed = true;
        await call({ cmd: 'abort', id }).catch(() => {});
      },
    };
  }

  /** The finished file as a native `File` — zero-copy, read lazily by whoever asks. */
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

  /** Delete one scratch file (render output, intermediate ZIP, …). Never throws. */
  async function remove(key) {
    try {
      const supported = await isSupported();
      if (!supported) { MEMORY_FILES.delete(key); return; }
      await call({ cmd: 'remove', key });
    } catch (e) { /* best effort */ }
  }

  /** Wipe every scratch file — called once at boot in case a previous tab
   * crashed mid-batch and left files behind (OPFS persists across reloads,
   * unlike heap memory, so it needs its own housekeeping). */
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
   * @param {Array<{name:string, key?:string, bytes?:Uint8Array, size?:number}>} entries
   * @param {string} outKey
   * @param {(info:{index:number,name:string,copied:number})=>void} [onFileProgress]
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
   * @param {File|Blob} file
   * @param {string} key scratch file name (caller picks something unique)
   * @param {{chunkBytes?:number, onProgress?:(p:number)=>void}} [opts]
   * @returns {Promise<{file:File, key:string|null, size:number, streamed:boolean}>}
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
    get scratchDirName() { return SCRATCH_DIR; },
  };

  global.RSOPFS = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
