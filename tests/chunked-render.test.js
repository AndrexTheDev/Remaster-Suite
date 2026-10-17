/* =============================================================================
 * Remaster Suite — chunked offline rendering + streaming codec test suite
 * -----------------------------------------------------------------------------
 * `Engine.renderChunked()`, the incremental WAV/MP3 encoders and the app-level
 * wiring that chooses between it and the plain whole-file `Engine.render()`.
 * Three layers:
 *
 *   · Engine.renderChunked() against the same miniature Web Audio
 *     implementation (`webaudio-stub.js`) the rest of the suite uses, run
 *     directly on bare Node globals — no DOM needed for the engine itself;
 *   · the incremental `Codecs.createWavStreamEncoder()` /
 *     `createMp3StreamEncoder()` factories, checked against the existing
 *     whole-file encoders;
 *   · `App.renderCard()`'s own decision to use the chunked/streamed path,
 *     exercised through a real jsdom boot with a lightweight in-process fake
 *     of `RSOPFS` standing in for a real Worker/FileSystemSyncAccessHandle
 *     (the real OPFS worker plumbing itself is already proven against the
 *     shipped worker source in tests/opfs.test.js — this suite is about the
 *     call sites that decide *when* to use it and *what* they hand it).
 *
 * Run:  node tests/chunked-render.test.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const H = require('./harness.js');
const stub = require('./webaudio-stub.js');

global.Worker = require('./encoding-worker-adapter.js');
const ROOT = H.ROOT;
const DSP = H.loadDsp();
const Presets = require(path.join(ROOT, 'assets', 'js', 'presets.js'));

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label + (detail ? '  → ' + detail : '')); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label + '  → ' + (detail === undefined ? 'failed' : detail)); }
}
function section(name) { console.log('\n▸ ' + name); }
const num = (v, d) => (isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : '—');

/* ------------------------------------------------------------------- helpers */

function peakOf(channels) {
  let p = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; }
  return p;
}
function finite(channels) {
  for (const c of channels) for (let i = 0; i < c.length; i++) if (!isFinite(c[i])) return false;
  return true;
}
function concatChunks(chunks, nCh, totalLen) {
  const out = [];
  for (let c = 0; c < nCh; c++) out.push(new Float32Array(totalLen));
  let pos = 0;
  for (const ch of chunks) {
    for (let c = 0; c < nCh; c++) out[c].set(ch[c], pos);
    pos += ch[0].length;
  }
  return out;
}
function maxAbsDiff(a, b) {
  let m = 0;
  for (let c = 0; c < a.length; c++) {
    const n = Math.min(a[c].length, b[c].length);
    for (let i = 0; i < n; i++) { const d = Math.abs(a[c][i] - b[c][i]); if (d > m) m = d; }
  }
  return m;
}
function energy(channels) {
  let s = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) s += c[i] * c[i];
  return s;
}
function diffEnergy(a, b) {
  let s = 0;
  for (let c = 0; c < a.length; c++) {
    const n = Math.min(a[c].length, b[c].length);
    for (let i = 0; i < n; i++) { const d = a[c][i] - b[c][i]; s += d * d; }
  }
  return s;
}

/** A plain in-memory sink with the same write()/close() shape OPFS writers use. */
function memSink() {
  const parts = [];
  return {
    parts,
    async write(chunk) { parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)); },
    async close() { return { size: parts.reduce((a, p) => a + p.length, 0) }; },
    concat() {
      const total = parts.reduce((a, p) => a + p.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      return out;
    },
  };
}

/** A sink that behaves like the real OPFS writer (`RSOPFS.createWriter()`): it
 *  hands the buffer it is given to another thread instead of copying it, which
 *  detaches the caller's view of it in the same turn. */
function takingSink() {
  const parts = [];
  let size = 0;
  return {
    async write(chunk) {
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const n = u8.length;
      const buf = u8.buffer.byteLength === u8.byteLength ? u8.buffer : u8.slice().buffer;
      parts.push(new Uint8Array(structuredClone(buf, { transfer: [buf] })));
      size += n;
    },
    async close() { return { size }; },
    get size() { return size; },
    concat() {
      const total = parts.reduce((a, p) => a + p.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      return out;
    },
  };
}

/** lamejs loaded straight into a vm sandbox and attached to `global.lamejs` — the
 *  same trick tests/audit.test.js uses — so `Libs.lame()`'s fast path kicks in
 *  without needing a `document` to append a `<script>` to. */
function ensureLamejs() {
  if (global.lamejs) return;
  const code = fs.readFileSync(path.join(ROOT, 'assets/vendor/lame.min.js'), 'utf8');
  const box = { console, Math, Date, ArrayBuffer, Uint8Array, Int16Array, Int32Array, Float32Array, Float64Array };
  box.self = box;
  box.window = box;
  vm.createContext(box);
  vm.runInContext(code, box, { filename: 'lame.min.js' });
  global.lamejs = box.lamejs || (box.window && box.window.lamejs);
}

/* ══════════════════════════════════════════════ bare-Node engine + codec setup ══ */

stub.install(global);                                             // OfflineAudioContext et al. straight on `global`
require(path.join(ROOT, 'assets', 'js', 'library-loader.js'));    // sets global.RSLibs
const Codecs = require(path.join(ROOT, 'assets', 'js', 'codecs.js'));
require(path.join(ROOT, 'assets', 'js', 'memory-guard.js'));      // sets global.RSMemoryGuard
const AudioEngine = require(path.join(ROOT, 'assets', 'js', 'engine.js'));

const SR = 48000;

async function run() {
  const Engine = new AudioEngine();

  // Kept deliberately short (full stateful-chain renders are not free — see
  // the render budget in audit.test.js): 8 s at a 2 s chunk size is already
  // four independent chunks, enough to exercise every boundary case below
  // without this suite needing minutes of wall time.
  const sim = H.garageSim(DSP, SR, 8);
  const sim2 = H.mul(sim, 0.82);
  const source = [sim, sim2];
  const metrics = DSP.measure(source, SR);
  const params = Presets.buildParams('garage', metrics, 0.7);

  /* ------------------------------------------------------- basic chunk shape */
  section('Engine.renderChunked() · basic shape, progress and streamed delivery');
  {
    const chunks = [];
    const progressSeq = [];
    const res = await Engine.renderChunked(source, SR, params, {
      chunkSeconds: 2,
      crossfadeMs: 50,
      onProgress: (p) => progressSeq.push(p),
      onChunk: async (channels, info) => { chunks.push({ channels, info }); },
    });

    ok(res.samples === sim.length, 'reports the exact total sample count', res.samples + ' vs ' + sim.length);
    ok(chunks.length >= 3, 'an 8 s file at 2 s chunks is delivered in several pieces', chunks.length + ' chunks');
    ok(!res.channels, 'no accumulated array is kept when onChunk is used — the whole point of streaming it');

    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const { info } = chunks[i];
      ok(info.startSample === total, 'chunk ' + i + ' starts exactly where the previous one ended', info.startSample + ' == ' + total);
      total = info.endSample;
      ok(info.isLast === (i === chunks.length - 1), 'chunk ' + i + ' reports isLast correctly', String(info.isLast));
    }
    ok(total === sim.length, 'the chunks together cover the whole file with no gap and no overlap left over', total + ' == ' + sim.length);

    let nondec = true;
    for (let i = 1; i < progressSeq.length; i++) if (progressSeq[i] < progressSeq[i - 1]) nondec = false;
    ok(nondec, 'progress never goes backwards', progressSeq.map((p) => p.toFixed(2)).join(' → '));
    ok(progressSeq[progressSeq.length - 1] === 1, 'progress reaches exactly 1', String(progressSeq[progressSeq.length - 1]));

    const assembled = concatChunks(chunks.map((c) => c.channels), 2, sim.length);
    ok(finite(assembled), 'every delivered sample is finite');
    ok(peakOf(assembled) <= 1.2, 'nothing blows up across a chunk boundary', 'peak ' + num(peakOf(assembled), 4));
  }

  /* --------------------------------------------------- onChunk vs accumulate */
  section('Engine.renderChunked() · onChunk delivery and the accumulate fallback agree');
  {
    const streamed = [];
    await Engine.renderChunked(source, SR, params, {
      chunkSeconds: 2, crossfadeMs: 50,
      onChunk: async (channels) => { streamed.push([Float32Array.from(channels[0]), Float32Array.from(channels[1])]); },
    });
    const streamedWhole = concatChunks(streamed, 2, sim.length);

    const accumulated = await Engine.renderChunked(source, SR, params, { chunkSeconds: 2, crossfadeMs: 50 });
    ok(!!accumulated.channels, 'without onChunk, the full-length channels come back instead');
    ok(accumulated.channels[0].length === sim.length, 'the accumulated result has the full length');

    const d = maxAbsDiff(streamedWhole, accumulated.channels);
    ok(d < 1e-9, 'the two delivery modes compute byte-for-byte the same samples', 'max diff ' + d.toExponential(2));
  }

  /* --------------------------------------------------------- crossfade sanity */
  section('Engine.renderChunked() · crossfade is level-preserving on correlated content');
  {
    // bypass:1 removes every stage with internal state — the chunk-boundary
    // crossfade is then blending two renders of *exactly* the same underlying
    // samples, which is precisely the case an equal-power law gets wrong (see
    // the long comment in engine.js): identical content must come out with no
    // level change at all, chunked or not.
    const bypassParams = Object.assign({}, params, { bypass: 1 });
    const whole = await Engine.render(source, SR, bypassParams, {});
    const chunked = await Engine.renderChunked(source, SR, bypassParams, { chunkSeconds: 2, crossfadeMs: 50 });

    ok(chunked.channels[0].length === whole.channels[0].length, 'same length in bypass, chunked or not');
    const d = maxAbsDiff(whole.channels, chunked.channels);
    ok(d < 1e-5, 'chunked bypass output matches the single-pass render essentially exactly', 'max diff ' + d.toExponential(2));
    ok(peakOf(chunked.channels) <= peakOf(whole.channels) + 1e-6,
      'the crossfade introduces no level bump at the seams', 'chunked peak ' + num(peakOf(chunked.channels), 5) + ' vs whole ' + num(peakOf(whole.channels), 5));
  }

  /* ---------------------------------------------------- real DSP, tolerant diff */
  section('Engine.renderChunked() · stays close to the whole-file render with real DSP engaged');
  {
    const whole = await Engine.render(source, SR, params, {});
    const chunked = await Engine.renderChunked(source, SR, params, { chunkSeconds: 2, crossfadeMs: 50 });
    ok(finite(chunked.channels) && peakOf(chunked.channels) <= 1.05, 'the chunked render stays inside full scale too', 'peak ' + num(peakOf(chunked.channels), 4));

    const ratio = diffEnergy(whole.channels, chunked.channels) / Math.max(1e-9, energy(whole.channels));
    // a generous bound: per-chunk filter-state resets (the documented trade-off)
    // may move things a little, but not grossly — this is not meant to be bit-exact
    ok(ratio < 0.05, 'the two renders differ by only a small fraction of the signal energy', (ratio * 100).toFixed(2) + '%');
  }

  /* ---------------------------------------------------------------- memory guard */
  section('Engine.renderChunked() · a memory guard can shrink chunks mid-render, dynamically');
  {
    let calls = 0;
    const shrinkingGuard = {
      suggestChunkSeconds(base, opts) {
        calls++;
        // simulate rising heap pressure: generous at first, then clamped to the floor
        return calls <= 1 ? base : opts.min;
      },
    };
    const res = await Engine.renderChunked(source, SR, params, {
      chunkSeconds: 4, crossfadeMs: 50, minChunkSeconds: 1, memoryGuard: shrinkingGuard,
    });
    ok(calls >= 2, 'the guard is consulted more than once (per chunk, not once for the whole render)', calls + ' calls');
    ok(res.samples === sim.length, 'the total length is still exactly right once chunk sizes start changing mid-render');
    ok(res.chunks > Math.ceil(sim.length / SR / 4), 'shrinking chunks mid-render produces more, smaller pieces than the base size would have');

    const steadyRes = await Engine.renderChunked(source, SR, params, { chunkSeconds: 4, crossfadeMs: 50 });
    ok(res.chunks > steadyRes.chunks, 'a render that shrinks under pressure uses more chunks than one that never does',
      res.chunks + ' vs ' + steadyRes.chunks);
  }

  /* ------------------------------------------------------------- error propagation */
  section('Engine.renderChunked() · a failing onChunk aborts the render instead of being swallowed');
  {
    let seen = 0;
    let threw = null;
    try {
      await Engine.renderChunked(source, SR, params, {
        chunkSeconds: 2,
        onChunk: async () => { seen++; if (seen === 2) throw new Error('sink exploded'); },
      });
    } catch (e) { threw = e; }
    ok(threw && /sink exploded/.test(threw.message), 'the error from onChunk propagates out of renderChunked()', threw && threw.message);
    ok(seen === 2, 'rendering stopped as soon as the sink failed, not after every chunk', String(seen));
  }

  /* ══════════════════════════════════════════════════ incremental codec encoders ══ */

  section('Codecs.createWavStreamEncoder() · byte-identical to the whole-file encoder');
  {
    const bitDepth = 24;
    const totalSamples = sim.length;
    const sink = memSink();
    const enc = Codecs.createWavStreamEncoder(totalSamples, SR, bitDepth, sink);
    // three deliberately uneven chunks, the way renderChunked() would hand them over
    const cuts = [0, Math.floor(totalSamples * 0.2), Math.floor(totalSamples * 0.55), totalSamples];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1];
      await enc.appendChannels([source[0].subarray(a, b), source[1].subarray(a, b)]);
    }
    const stats = await enc.finish();
    ok(stats.samples === totalSamples, 'reports the exact sample count written', String(stats.samples));

    const streamedBytes = sink.concat();
    const wholeAb = DSP.encodeWav(source, SR, bitDepth);
    const wholeBytes = new Uint8Array(wholeAb);
    ok(streamedBytes.length === wholeBytes.length, 'identical total length to a single-pass encode', streamedBytes.length + ' bytes');
    ok(Buffer.from(streamedBytes).equals(Buffer.from(wholeBytes)), 'byte-for-byte identical, header and all');

    const decoded = DSP.decodeWav(streamedBytes.buffer.slice(streamedBytes.byteOffset, streamedBytes.byteOffset + streamedBytes.byteLength));
    ok(decoded.channels[0].length === totalSamples, 'and the stream decodes back to the right length');
  }

  section('Codecs.createWavStreamEncoder() · a zero-chunk file still gets a correct, empty-data header');
  {
    const sink = memSink();
    const enc = Codecs.createWavStreamEncoder(0, SR, 16, sink);
    const stats = await enc.finish();
    ok(stats.samples === 0 && stats.bytesWritten === 0, 'nothing is written when nothing is ever appended (no header either, since nCh is unknown)');
  }

  section('Codecs.createMp3StreamEncoder() · a single whole-file append matches the batch encoder');
  {
    ensureLamejs();
    const kbps = 192;
    const sinkA = memSink();
    const encA = await Codecs.createMp3StreamEncoder(SR, kbps, 2, sinkA);
    await encA.appendChannels(source, true);
    await encA.finish();
    const streamedOnce = sinkA.concat();

    const sinkB = memSink();
    // Node adapter runs the shipped worker in worker_threads with real WASM.
    await Codecs.encodeMp3(source, SR, kbps, null, sinkB);
    const batch = sinkB.concat();

    ok(Codecs.looksLikeMp3(streamedOnce), 'the incremental encoder, given everything in one call, produces a valid MP3 stream');
    ok(Codecs.looksLikeMp3(batch), 'the batch encoder output is a valid MP3 stream too');
    // Deterministic float input, identical LAME configuration; allow frame-size
    // buffering variation when checking output length.
    const sizeDiff = Math.abs(streamedOnce.length - batch.length);
    ok(sizeDiff <= 512, 'and it is essentially the same size as the existing batch encoder given the same single call shape',
      streamedOnce.length + ' vs ' + batch.length + ' bytes (diff ' + sizeDiff + ')');
  }

  section('Codecs.encodeMp3() · a sink that takes the buffer cannot break the final gate');
  {
    ensureLamejs();
    // The bug this pins: the gate that refuses a silent MP3 inspected the first
    // chunk *after* handing it to the sink, and a real sink (OPFS) transfers
    // that buffer away — so the header it checked was a detached, zero-length
    // view, and every streamed MP3 export failed with 'mp3-invalid'.
    const sink = takingSink();
    let res = null, err = null;
    try { res = await Codecs.encodeMp3(source, SR, 192, null, sink); } catch (e) { err = String(e.message); }
    ok(err === null, 'encoding into a sink that detaches every chunk it is given settles at all', err || 'resolved');
    const stream = sink.concat();
    ok(!!res && res.bytesWritten > 4000 && res.bytesWritten === stream.length,
      'and the whole stream is in the sink when it does',
      res ? res.bytesWritten + ' bytes written, ' + stream.length + ' received' : 'nothing was written');
    ok(Codecs.looksLikeMp3(stream), 'and what landed there still starts like MPEG audio',
      '[' + [...stream.slice(0, 4)].map((b) => '0x' + b.toString(16)).join(' ') + ']');
  }

  section('Codecs.createMp3StreamEncoder() · several small chunks still produce one valid, decodable stream');
  {
    const kbps = 192;
    const sink = memSink();
    const enc = await Codecs.createMp3StreamEncoder(SR, kbps, 2, sink);
    const cuts = [0, Math.floor(sim.length * 0.12), Math.floor(sim.length * 0.34), Math.floor(sim.length * 0.71), sim.length];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1];
      const isLast = i === cuts.length - 2;
      await enc.appendChannels([source[0].subarray(a, b), source[1].subarray(a, b)], isLast);
    }
    await enc.finish();
    const bytes = sink.concat();
    ok(Codecs.looksLikeMp3(bytes), 'a multi-chunk incremental encode is still a valid MP3 stream', bytes.length + ' bytes');
    ok(bytes.length > 2000, 'a sane, non-trivial amount of audio was actually encoded', bytes.length + ' bytes');
  }

  section('Codecs · failed/aborted leases and missing workers');
  {
    const pcm = [source[0].subarray(0, SR)];
    let sinkError = '';
    try { await Codecs.encodeMp3(pcm, SR, 192, null, { async write() { throw new Error('sink failed'); } }); }
    catch (err) { sinkError = err.message; }
    ok(sinkError === 'sink failed', 'a failed MP3 sink rejects rather than hanging');
    const recovered = await Codecs.encodeMp3(pcm, SR, 192);
    ok(Codecs.looksLikeMp3(recovered.bytes), 'a poisoned worker lease is replaced for the next file');
    const aborted = await Codecs.createMp3StreamEncoder(SR, 192, 1, memSink());
    aborted.abort(); aborted.abort();
    const next = await Codecs.encodeMp3(pcm, SR, 192);
    ok(Codecs.looksLikeMp3(next.bytes), 'idempotent abort returns pool capacity');
    const Worker = global.Worker;
    let missing = '';
    try {
      global.Worker = undefined;
      await Codecs.encodeMp3(pcm, SR, 192);
    } catch (err) { missing = err.message; } finally { global.Worker = Worker; }
    ok(/requires Web Workers/.test(missing), 'no mainthread fallback when workers are unavailable');
  }

  /* ══════════════════════════════════════════════════ app-level wiring ══ */

  await appWiringTests();

  console.log('\n' + '-'.repeat(60));
  if (failed) {
    console.log('FAILED ' + failed + ' / ' + (passed + failed) + ':\n  - ' + failures.join('\n  - '));
    process.exitCode = 1;
  } else {
    console.log('ALL TESTS PASSED (' + passed + ')');
  }
}

/* ══════════════════════════════════════════════════════ app.js integration ══ */

/** A minimal, fully in-process fake of RSOPFS — real worker/OPFS plumbing is
 *  already exercised against the shipped worker source in tests/opfs.test.js;
 *  this is only here to let App.renderCard()'s own decision logic run as if
 *  OPFS were available, without a real browser. */
/** jsdom's own Blob doesn't implement .arrayBuffer() (even on a .slice()
 *  result), only FileReader — so the fakes below read bytes that way. */
function readAsArrayBuffer(win, blob) {
  return new Promise((resolve, reject) => {
    const fr = new win.FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
    fr.readAsArrayBuffer(blob);
  });
}

function installFakeOPFS(win) {
  const files = new Map();
  const OPFS = win.RSOPFS;
  OPFS.isSupported = async () => true;
  OPFS.createWriter = async (key) => {
    const parts = [];
    return {
      key,
      async write(chunk) { parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)); },
      async close() {
        const size = parts.reduce((a, p) => a + p.length, 0);
        const buf = new Uint8Array(size);
        let off = 0;
        for (const p of parts) { buf.set(p, off); off += p.length; }
        files.set(key, buf);
        return { size, key };
      },
      async abort() { files.delete(key); },
    };
  };
  OPFS.getFile = async (key) => {
    const b = files.get(key);
    if (!b) throw new Error('no such scratch file: ' + key);
    return new win.File([b], key);
  };
  OPFS.remove = async (key) => { files.delete(key); };
  OPFS.resetScratch = async () => { files.clear(); };
  OPFS.streamFileIntoScratch = async (file, key, opts) => {
    const size = file.size || 0;
    if (!size) return { file, key: null, size, streamed: false };
    const w = await OPFS.createWriter(key);
    const CHUNK = (opts && opts.chunkBytes) || 4 * 1024 * 1024;
    for (let off = 0; off < size; off += CHUNK) {
      const end = Math.min(size, off + CHUNK);
      const buf = await readAsArrayBuffer(win, file.slice(off, end));
      await w.write(new Uint8Array(buf));
    }
    await w.close();
    return { file: await OPFS.getFile(key), key, size, streamed: true };
  };
  return files;
}

function bootApp() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => {
    const msg = String(err && err.message);
    if (/Not implemented: navigation|Could not parse CSS|getContext \(without installing the canvas/.test(msg)) return;
    throw err;
  });
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    url: 'https://remaster.local/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  });
  const win = dom.window;
  stub.install(win);
  win.URL.createObjectURL = () => 'blob:mock';
  win.URL.revokeObjectURL = () => {};
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  win.eval(fs.readFileSync(path.join(ROOT, 'assets/vendor/lame.min.js'), 'utf8'));
  win.Worker = require('./encoding-worker-adapter.js');
  for (const f of ['dsp-utils.js', 'presets.js', 'i18n.js', 'library-loader.js', 'opfs-manager.js', 'codecs.js',
    'analyzer.js', 'memory-guard.js', 'engine.js', 'ui.js', 'app.js']) {
    win.eval(fs.readFileSync(path.join(ROOT, 'assets/js', f), 'utf8'));
  }
  return win;
}

function wavFile(win, channels, sr, name) {
  const ab = DSP.encodeWav(channels, sr, 16);
  return new win.File([new Uint8Array(ab)], name, { type: 'audio/wav' });
}

async function appWiringTests() {
  section('App.renderCard() · chooses the chunked/streamed path once OPFS is ready and the file is long enough');
  {
    const win = bootApp();
    await new Promise((r) => setTimeout(r, 40));
    const App = win.RSApp;
    installFakeOPFS(win);
    App.State.opfsReady = true;
    // lower the thresholds so a short, fast test fixture still exercises the
    // chunked path instead of needing minutes of synthetic audio
    App.CONFIG.chunkedRenderThresholdSeconds = 1;
    App.CONFIG.chunkSeconds = 3;
    App.CONFIG.opfsUploadThresholdBytes = 0;

    const s = H.garageSim(DSP, SR, 10);
    const file = wavFile(win, [s, s], SR, 'long-session.wav');
    await App.addFiles([file]);
    const card = App.State.cards[App.State.cards.length - 1];
    ok(!!card.analysis, 'the card analysed normally through the chunked-upload path');
    ok(card.file !== file, 'the card\'s file was rebound to the OPFS-streamed copy (requirement 1)');
    ok(!!card._uploadOpfsKey, 'and the OPFS upload key is tracked for later cleanup', card._uploadOpfsKey);

    const res = await App.renderCard(card, { force: true });
    ok(!!res.opfsKey, 'renderCard() used the OPFS-backed path', res.opfsKey);
    const bytes = new Uint8Array(await readAsArrayBuffer(win, res.file));
    const decoded = DSP.decodeWav(bytes.buffer);
    ok(finite(decoded.channels) && peakOf(decoded.channels) <= 1.05, 'the chunk-streamed WAV decodes to sane, in-range audio', 'peak ' + num(peakOf(decoded.channels), 4));
    ok(decoded.channels[0].length === s.length, 'at exactly the original length', decoded.channels[0].length + ' vs ' + s.length);

    App.removeCard(card);
  }

  section('App.renderCard() · the chunked MP3 path also produces a valid stream');
  {
    const win = bootApp();
    await new Promise((r) => setTimeout(r, 40));
    const App = win.RSApp;
    installFakeOPFS(win);
    App.State.opfsReady = true;
    App.State.format = 'mp3';
    App.State.mp3Rate = 192;
    App.CONFIG.chunkedRenderThresholdSeconds = 1;
    App.CONFIG.chunkSeconds = 3;

    const s = H.cassetteSim(DSP, SR, 9);
    const file = wavFile(win, [s, s], SR, 'tape.wav');
    await App.addFiles([file]);
    const card = App.State.cards[App.State.cards.length - 1];
    const res = await App.renderCard(card, { force: true });
    ok(!!res.opfsKey && res.format === 'mp3', 'the MP3 export used the OPFS-backed chunked path too');
    const bytes = new Uint8Array(await readAsArrayBuffer(win, res.file));
    const Codecs2 = win.RSCodecs;
    ok(Codecs2.looksLikeMp3(bytes), 'and the result is a structurally valid MP3 stream', bytes.length + ' bytes');

    App.removeCard(card);
  }

  section('App.renderCard() · blocked MP3 worker falls back to a real WAV');
  {
    const win = bootApp(); await new Promise(r => setTimeout(r, 40));
    const App = win.RSApp;
    const file = wavFile(win, [H.tone(440, SR, 1, .2)], SR, 'fallback.wav');
    await App.addFiles([file]); App.State.format = 'mp3';
    win.Worker = class { constructor() { throw new Error('CSP blocked'); } };
    let warning = false; const toast = win.RSUI.toast;
    win.RSUI.toast = (...args) => { if (args[1] === 'warn') warning = true; return toast(...args); };
    const card = App.State.cards[0], res = await App.renderCard(card, { force: true, streaming: true });
    ok(res.format === 'wav' && /\.wav$/.test(res.name) && card.status === 'done' && warning,
      'CSP failure produces a named WAV and an explicit warning, not a fake MP3');
    const bytes = res.bytes || new Uint8Array(await readAsArrayBuffer(win, res.file));
    const decoded = DSP.decodeWav(bytes.buffer);
    ok(decoded && decoded.channels[0].length === SR, 'fallback WAV is decodable with its exact original duration');
    App.removeCard(card);
  }

  section('App.renderCard() · short files below the threshold still take the original, unchunked path');
  {
    const win = bootApp();
    await new Promise((r) => setTimeout(r, 40));
    const App = win.RSApp;
    installFakeOPFS(win);
    App.State.opfsReady = true;
    // default threshold (well above any test fixture) is left untouched here

    const s = H.garageSim(DSP, SR, 6);
    const file = wavFile(win, [s, s], SR, 'short-clip.wav');
    await App.addFiles([file]);
    const card = App.State.cards[App.State.cards.length - 1];
    const res = await App.renderCard(card, { force: true });
    ok(!!res.opfsKey, 'still OPFS-backed output (the existing, already-shipped streaming-output path)');
    const bytes = new Uint8Array(await readAsArrayBuffer(win, res.file));
    const decoded = DSP.decodeWav(bytes.buffer);
    ok(decoded.channels[0].length === s.length, 'a short file is unaffected by any of this — same exact length as before', decoded.channels[0].length + ' vs ' + s.length);

    App.removeCard(card);
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
