/* =============================================================================
 * Remaster Suite — OPFS scratch storage test suite
 * -----------------------------------------------------------------------------
 * `opfs-manager.js` is the one module this project cannot exercise through
 * jsdom: `FileSystemSyncAccessHandle` does not exist outside a real browser
 * worker. So this suite builds a small, faithful OPFS simulator (an in-memory
 * directory of growable byte buffers, the same create/read/write/truncate/
 * flush/close surface the spec defines) and runs the *actual shipped worker
 * source* — the exact string `opfs-manager.js` hands to `new Worker(...)` in
 * a browser — inside a Node `vm` context against that simulator. The result
 * is a real exercise of the open/write/close, probe and streaming-ZIP code
 * paths, not a reimplementation of them.
 *
 * Run:  node tests/opfs.test.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./harness.js');

const ROOT = H.ROOT;

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label + (detail ? '  → ' + detail : '')); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label + '  → ' + (detail === undefined ? 'failed' : detail)); }
}
function section(name) { console.log('\n▸ ' + name); }

/* ====================================================================== *
 * A minimal, spec-shaped OPFS simulator
 * ====================================================================== */

function makeFakeOPFS() {
  const files = new Map();      // key -> { bytes: Uint8Array, size: number, locked: boolean }

  function growTo(rec, size) {
    if (rec.bytes.length >= size) return;
    const next = new Uint8Array(Math.max(size, rec.bytes.length * 2 || 1024));
    next.set(rec.bytes);
    rec.bytes = next;
  }

  function syncHandleFor(key) {
    let rec = files.get(key);
    if (!rec) { rec = { bytes: new Uint8Array(0), size: 0 }; files.set(key, rec); }
    return {
      write(view, opts) {
        const at = (opts && opts.at) || 0;
        growTo(rec, at + view.length);
        rec.bytes.set(view, at);
        rec.size = Math.max(rec.size, at + view.length);
        return view.length;
      },
      read(buf, opts) {
        const at = (opts && opts.at) || 0;
        const n = Math.max(0, Math.min(buf.length, rec.size - at));
        if (n > 0) buf.set(rec.bytes.subarray(at, at + n));
        return n;
      },
      truncate(n) { rec.size = n; growTo(rec, n); },
      flush() {},
      close() {},
      getSize() { return rec.size; },
    };
  }

  const dir = {
    async getFileHandle(key, opts) {
      if (!files.has(key)) {
        if (!(opts && opts.create)) throw new Error('NotFoundError: ' + key);
        files.set(key, { bytes: new Uint8Array(0), size: 0 });
      }
      return {
        name: key,
        async createSyncAccessHandle() { return syncHandleFor(key); },
        async getFile() {
          const rec = files.get(key);
          const bytes = rec ? rec.bytes.subarray(0, rec.size) : new Uint8Array(0);
          return new Blob([bytes]);
        },
      };
    },
    async removeEntry(key) { files.delete(key); },
    async *keys() { yield* files.keys(); },
  };

  return {
    files,
    navigatorStorage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) },
  };
}

/* ====================================================================== *
 * A fake dedicated Worker that runs the *real* worker source in a vm
 * context wired up to the fake OPFS above.
 * ====================================================================== */

function makeFakeWorkerClass(workerSource, fakeOPFS) {
  return class FakeWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      const workerSelf = {
        navigator: { storage: fakeOPFS.navigatorStorage },
        FileSystemFileHandle: class { createSyncAccessHandle() {} },
        postMessage: (data) => {
          if (this.onmessage) {
            // real workers deliver asynchronously — queueMicrotask keeps the
            // ordering guarantees the main-thread facade relies on
            queueMicrotask(() => this.onmessage({ data }));
          }
        },
        addEventListener() {},
      };
      const sandbox = {
        self: workerSelf,
        Promise, Map, Set, Uint8Array, Uint32Array, Array,
        TextEncoder, TextDecoder,
        console,
        Blob,
      };
      vm.createContext(sandbox);
      vm.runInContext(workerSource, sandbox, { filename: 'opfs-worker.js' });
      this._self = workerSelf;
    }
    postMessage(msg) {
      // the facade may transfer an ArrayBuffer; vm contexts do not share
      // Uint8Array/ArrayBuffer identity across contexts in all Node builds,
      // so re-host the payload's binary data through the outer realm's types
      queueMicrotask(() => this._self.onmessage && this._self.onmessage({ data: msg }));
    }
    terminate() {}
  };
}

/** Fresh `RSOPFS` module instance wired to one fake OPFS + fake Worker pair. */
function freshOPFS(fakeOPFS) {
  const modPath = path.join(ROOT, 'assets', 'js', 'opfs-manager.js');
  delete require.cache[require.resolve(modPath)];
  const RSOPFS = require(modPath);
  global.Worker = makeFakeWorkerClass(RSOPFS.buildWorkerSource(), fakeOPFS);
  setGlobalNavigator({ storage: fakeOPFS.navigatorStorage });
  return RSOPFS;
}

/** Node ≥ 21 ships a read-only global `navigator` — redefine it for the test. */
function setGlobalNavigator(value) {
  Object.defineProperty(global, 'navigator', { value, configurable: true, writable: true });
}

async function run() {
  /* -------------------------------------------------------- pure ZIP bytes */
  section('pure helpers · hand-built ZIP round-trips through real tools');
  {
    const RSOPFS = require(path.join(ROOT, 'assets', 'js', 'opfs-manager.js'));
    const P = RSOPFS.PURE;

    ok(P.crc32Update(new TextEncoder().encode('123456789'), 0) === 0xcbf43926,
      'CRC-32 matches the standard check value for "123456789"');

    function buildZip(entries) {
      const dt = P.dosDateTime(new Date());
      const chunks = []; let pos = 0; const central = [];
      for (const e of entries) {
        const nameBytes = P.utf8Bytes(e.name);
        const localOffset = pos;
        const header = P.zipLocalHeader(nameBytes, dt);
        chunks.push(header); pos += header.length;
        const crc = P.crc32Update(e.data, 0);
        chunks.push(e.data); pos += e.data.length;
        const desc = P.zipDataDescriptor(crc, e.data.length);
        chunks.push(desc); pos += desc.length;
        central.push(P.zipCentralHeader(nameBytes, dt, crc, e.data.length, localOffset));
      }
      const cdStart = pos;
      for (const c of central) { chunks.push(c); pos += c.length; }
      const eocd = P.zipEOCD(central.length, pos - cdStart, cdStart);
      chunks.push(eocd); pos += eocd.length;
      const out = new Uint8Array(pos); let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    }

    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
    const zipBytes = buildZip([
      { name: 'audio/remaster (restored).wav', data: big },
      { name: 'ümlaut äöü.txt', data: new TextEncoder().encode('unicode name test') },
      { name: 'README.txt', data: new TextEncoder().encode('done') },
    ]);

    ok(P.fitsZip32([{ size: 10 }, { size: 20 }]), 'small batches fit the classic ZIP32 format');
    ok(!P.fitsZip32([{ size: P.ZIP32_MAX + 1 }]), 'an oversized single entry is rejected up front');

    const JSZip = require(path.join(ROOT, 'assets', 'vendor', 'jszip.min.js'));
    const zip = await JSZip.loadAsync(Buffer.from(zipBytes));
    const names = Object.keys(zip.files);
    ok(names.length === 3, 'JSZip sees all three entries', names.join(', '));
    const audio = await zip.files['audio/remaster (restored).wav'].async('uint8array');
    ok(audio.length === big.length && Buffer.from(audio).equals(Buffer.from(big)),
      'the large entry round-trips byte-for-byte', audio.length + ' bytes');
    const unicodeName = names.find((n) => n.indexOf('ümlaut') !== -1);
    ok(!!unicodeName, 'a UTF-8 filename survives', unicodeName);

    // cross-check with a completely independent ZIP reader
    fs.writeFileSync('/tmp/rs-opfs-test.zip', Buffer.from(zipBytes));
    try {
      const { execFileSync } = require('child_process');
      const listing = execFileSync('unzip', ['-l', '/tmp/rs-opfs-test.zip'], { encoding: 'utf8' });
      ok(/3 files/.test(listing), 'unzip(1) agrees: three files', listing.trim().split('\n').pop());
      execFileSync('unzip', ['-t', '/tmp/rs-opfs-test.zip']);
      ok(true, 'unzip(1) test mode finds no CRC errors');
    } catch (e) {
      ok(false, 'unzip(1) cross-check', e.message);
    } finally {
      fs.unlinkSync('/tmp/rs-opfs-test.zip');
    }
  }

  /* --------------------------------------------------- simulated worker I/O */
  section('worker · streaming writer round-trips through the simulated OPFS');
  {
    const fakeOPFS = makeFakeOPFS();
    const RSOPFS = freshOPFS(fakeOPFS);

    const supported = await RSOPFS.isSupported();
    ok(supported === true, 'capability probe succeeds against the simulator');

    const writer = await RSOPFS.createWriter('render-1');
    const a = new Uint8Array(1024).fill(7);
    const b = new Uint8Array(2048).fill(9);
    await writer.write(a);
    await writer.write(b);
    const closed = await writer.close();
    ok(closed.size === a.length + b.length, 'writer reports the true byte count', closed.size);

    const file = await RSOPFS.getFile('render-1');
    const bytes = new Uint8Array(await file.arrayBuffer());
    ok(bytes.length === a.length + b.length, 'getFile() returns the full length');
    ok(bytes.slice(0, 1024).every((v) => v === 7) && bytes.slice(1024).every((v) => v === 9),
      'bytes landed in write order, nothing dropped or reordered');

    await RSOPFS.remove('render-1');
    let removed = false;
    try { await RSOPFS.getFile('render-1'); } catch (e) { removed = true; }
    ok(removed, 'remove() actually deletes the scratch file');
  }

  section('worker · abort() cleans up a failed write');
  {
    const fakeOPFS = makeFakeOPFS();
    const RSOPFS = freshOPFS(fakeOPFS);
    const writer = await RSOPFS.createWriter('render-aborted');
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.abort();
    let gone = false;
    try { await RSOPFS.getFile('render-aborted'); } catch (e) { gone = true; }
    ok(gone, 'an aborted render leaves no scratch file behind');
  }

  section('worker · packZip streams OPFS file → OPFS file');
  {
    const fakeOPFS = makeFakeOPFS();
    const RSOPFS = freshOPFS(fakeOPFS);

    const sizes = [5 * 1024 * 1024 + 17, 3, 0, 9999];
    const keys = [];
    for (let i = 0; i < sizes.length; i++) {
      const key = 'render-' + i;
      const w = await RSOPFS.createWriter(key);
      const data = new Uint8Array(sizes[i]);
      for (let j = 0; j < data.length; j++) data[j] = (j * 31 + i) & 0xff;
      // write in several chunks, like the real WAV/MP3 streamers do
      const CH = 777777;
      for (let off = 0; off < data.length; off += CH) await w.write(data.subarray(off, Math.min(data.length, off + CH)));
      await w.close();
      keys.push({ key, data });
    }

    let lastProgress = null;
    const result = await RSOPFS.packZip(
      keys.map((k, i) => ({ name: 'track-' + i + '.wav', key: k.key, size: sizes[i] }))
        .concat([{ name: 'README.txt', bytes: new TextEncoder().encode('ten files, zero copies') }]),
      'out.zip',
      (info) => { lastProgress = info; }
    );
    ok(result.size > 0, 'packZip reports a total size', result.size);
    ok(!!lastProgress, 'progress callback fired at least once', JSON.stringify(lastProgress));

    const zipFile = await RSOPFS.getFile('out.zip');
    const zipBytes = Buffer.from(await zipFile.arrayBuffer());
    const JSZip = require(path.join(ROOT, 'assets', 'vendor', 'jszip.min.js'));
    const zip = await JSZip.loadAsync(zipBytes);
    const names = Object.keys(zip.files);
    ok(names.length === sizes.length + 1, 'the archive holds every source file plus the README', names.join(', '));
    for (let i = 0; i < keys.length; i++) {
      const got = await zip.files['track-' + i + '.wav'].async('uint8array');
      ok(Buffer.from(got).equals(Buffer.from(keys[i].data)), 'track ' + i + ' is byte-identical after the round trip', got.length + ' bytes');
    }
    const readme = await zip.files['README.txt'].async('string');
    ok(readme === 'ten files, zero copies', 'the inline README entry round-trips too');

    fs.writeFileSync('/tmp/rs-opfs-pack.zip', zipBytes);
    try {
      const { execFileSync } = require('child_process');
      execFileSync('unzip', ['-t', '/tmp/rs-opfs-pack.zip']);
      ok(true, 'unzip(1) finds the packed archive structurally sound');
    } catch (e) {
      ok(false, 'unzip(1) on the packed archive', e.message);
    } finally {
      fs.unlinkSync('/tmp/rs-opfs-pack.zip');
    }
  }

  section('worker · an oversized batch is refused up front, not mid-stream');
  {
    const fakeOPFS = makeFakeOPFS();
    const RSOPFS = freshOPFS(fakeOPFS);
    let threw = null;
    try {
      await RSOPFS.packZip([{ name: 'huge.wav', key: 'nope', size: RSOPFS.PURE.ZIP32_MAX + 1 }], 'out.zip');
    } catch (e) { threw = e; }
    ok(threw && /too-large/.test(threw.message), 'an over-limit batch rejects before touching the worker', threw && threw.message);
  }

  /* ------------------------------------------------------------ fallback */
  section('fallback · no OPFS, no Worker — the in-memory sink behaves the same');
  {
    setGlobalNavigator(undefined);
    delete global.Worker;
    const modPath = path.join(ROOT, 'assets', 'js', 'opfs-manager.js');
    delete require.cache[require.resolve(modPath)];
    const RSOPFS = require(modPath);

    const supported = await RSOPFS.isSupported();
    ok(supported === false, 'isSupported() is false with no navigator.storage and no Worker');

    const writer = await RSOPFS.createWriter('mem-1');
    await writer.write(new Uint8Array([1, 2, 3, 4]));
    await writer.write(new Uint8Array([5, 6]));
    const closed = await writer.close();
    ok(closed.size === 6, 'the memory fallback still reports the right size');

    const file = await RSOPFS.getFile('mem-1');
    const bytes = new Uint8Array(await file.arrayBuffer());
    ok(bytes.length === 6 && bytes[0] === 1 && bytes[5] === 6, 'and the right bytes, in order');

    let threw = null;
    try { await RSOPFS.packZip([{ name: 'a', key: 'mem-1' }], 'out.zip'); } catch (e) { threw = e; }
    ok(threw && /opfs-unavailable/.test(threw.message), 'packZip refuses cleanly when OPFS is unavailable — callers fall back to RSCodecs.zip');
  }

  console.log('\n' + '-'.repeat(60));
  if (failed) {
    console.log('FAILED ' + failed + ' / ' + (passed + failed) + ':\n  - ' + failures.join('\n  - '));
    process.exitCode = 1;
  } else {
    console.log('ALL TESTS PASSED (' + passed + ')');
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
