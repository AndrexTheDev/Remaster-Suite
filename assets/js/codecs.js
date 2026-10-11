/* =============================================================================
 * Remaster Suite — file in, file out
 * -----------------------------------------------------------------------------
 * Decoding : Web Audio (hardware independent) → optional FFmpeg.wasm rescue.
 * Encoding : WAV 16/24/32-bit written by hand (no dependency at all) and MP3 up
 *            to 320 kbps through lamejs, which runs inside a Web Worker so a
 *            long file never freezes the interface.
 * Packing  : JSZip, one click for the whole batch.
 * ========================================================================== */
(function (global) {
  'use strict';

  const DSP = global.RSDSP;
  const Libs = global.RSLibs;

  /* MPEG-1/2 Layer III only knows these sample rates. */
  const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  /* ------------------------------------------------------------- small helpers */

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  /** Nearest sample rate that the MP3 encoder can actually work with. */
  function mp3RateFor(sr) {
    let best = 44100, bestD = Infinity;
    for (const r of MP3_RATES) {
      const d = Math.abs(Math.log2(r / sr));
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  function formatBytes(bytes, lang) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const s = (v < 10 ? v.toFixed(1) : Math.round(v)).toString();
    return (lang === 'de' ? s.replace('.', ',') : s) + ' ' + units[i];
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (x) => (x < 10 ? '0' + x : '' + x);
    return (h ? h + ':' + pad(m) : m) + ':' + pad(ss);
  }

  function formatRate(sr, lang) {
    const k = sr / 1000;
    const s = (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1));
    return (lang === 'de' ? s.replace('.', ',') : s) + ' kHz';
  }

  function formatDb(v, lang) {
    if (!isFinite(v)) return '—';
    const s = v.toFixed(1);
    return (v > 0 ? '+' : '') + (lang === 'de' ? s.replace('.', ',') : s) + ' dB';
  }

  /** Handy file name for the result. */
  function outputName(name, ext, suffix) {
    const base = String(name || 'audio').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
    return base + (suffix === undefined ? ' (restored)' : suffix) + '.' + ext;
  }

  /* ------------------------------------------------------------------ decoding */

  /**
   * Read a File/Blob into an ArrayBuffer. `Blob.arrayBuffer()` is missing in
   * older Safari and in some embedded web views, so FileReader is the fallback.
   */
  function readBlob(blob) {
    if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    if (global.FileReader) {
      return new Promise((resolve, reject) => {
        const fr = new global.FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error || new Error('read failed'));
        fr.readAsArrayBuffer(blob);
      });
    }
    if (global.Response) return new global.Response(blob).arrayBuffer();
    return Promise.reject(new Error('cannot read file'));
  }

  let decodeCtxCache = null;
  let liveDecodeCtx = null;
  function decodeContext(sr) {
    const rate = clamp(sr || 44100, 8000, 96000);
    const Ctor = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!Ctor) return null;
    // an offline context decodes just as well as a live one — and needs no
    // user gesture, no output device and no permission
    return new Ctor(1, 1024, rate);
  }

  /**
   * Very old browsers (Safari before 14.1) have no decodeAudioData() on the
   * offline context; a suspended live context decodes fine there. It is created
   * once and closed again as soon as we are done.
   */
  function decodeInLiveContext(arrayBuffer, sr) {
    const Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) throw new Error('no audio context for decoding');
    if (!liveDecodeCtx) {
      try { liveDecodeCtx = new Ctor({ sampleRate: clamp(sr || 44100, 8000, 96000) }); }
      catch (e) { liveDecodeCtx = new Ctor(); }
    }
    return new Promise((resolve, reject) => {
      const p = liveDecodeCtx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
      if (p && p.then) p.catch(reject);
    });
  }

  /**
   * Decode an ArrayBuffer to an AudioBuffer at the given (or detected) rate.
   * @param {ArrayBuffer} arrayBuffer
   * @param {number} [sr] target sample rate
   */
  async function decodeArrayBuffer(arrayBuffer, sr) {
    const rate = sr || 44100;
    const ctx = decodeContext(rate);
    // decodeAudioData detaches its input in some browsers → hand it a copy
    if (ctx) {
      try {
        return await ctx.decodeAudioData(arrayBuffer.slice(0));
      } catch (err) {
        if (err && /OfflineAudioContext|decodeAudioData/i.test(String(err.name || err.message))) {
          return decodeInLiveContext(arrayBuffer, rate);
        }
        throw err;
      }
    }
    return decodeInLiveContext(arrayBuffer, rate);
  }

  /**
   * Optional rescue path: hand the file to FFmpeg.wasm, get a WAV back, decode
   * that. Only ever used when the browser itself refuses the file.
   */
  async function decodeWithFFmpeg(file, sr) {
    if (!Libs) throw new Error('no library loader');
    const factory = await Libs.ffmpegFactory();
    if (!factory) throw new Error('ffmpeg unavailable');
    const ff = factory({
      corePath: Libs.ffmpegCore.corePath,
      mainName: 'main',
      log: false,
      logger: () => {},
    });
    await ff.load();
    ff.FS('writeFile', 'in_' + (file.name || 'audio'), new Uint8Array(await readBlob(file)));
    await ff.run('-i', 'in_' + (file.name || 'audio'), '-f', 'wav', '-ar', String(sr || 44100), 'out.wav');
    const data = ff.FS('readFile', 'out.wav');
    try { ff.FS('unlink', 'in_' + (file.name || 'audio')); ff.FS('unlink', 'out.wav'); } catch (e) { /* fine */ }
    return decodeArrayBuffer(data.buffer.slice(0), sr || 44100);
  }

  /**
   * Decode a File/Blob, preserving the source sample rate when it can be read
   * from the container header.
   * @returns {Promise<{buffer:AudioBuffer, sampleRate:number, detected:boolean, rescued:boolean}>}
   */
  async function decodeFile(file, opts) {
    const o = opts || {};
    const buf = await readBlob(file);
    let detected = false;
    let sr = o.sampleRate || 0;
    if (!sr && DSP && DSP.detectSampleRate) {
      try {
        const r = DSP.detectSampleRate(buf);
        if (r && r >= 8000 && r <= 192000) { sr = r; detected = true; }
      } catch (e) { sr = 0; }
    }
    if (!sr) sr = 44100;

    try {
      const buffer = await decodeArrayBuffer(buf, sr);
      return { buffer, sampleRate: buffer.sampleRate || sr, detected, rescued: false };
    } catch (err1) {
      // second try at a universally supported rate, then the FFmpeg rescue
      try {
        const buffer = await decodeArrayBuffer(buf, 48000);
        return { buffer, sampleRate: buffer.sampleRate || 48000, detected, rescued: false };
      } catch (err2) {
        if (o.allowFFmpeg === false) throw err2;
        const buffer = await decodeWithFFmpeg(file, sr);
        return { buffer, sampleRate: buffer.sampleRate || sr, detected, rescued: true };
      }
    }
  }

  /** An AudioBuffer built from plain channel arrays (for the live monitor). */
  let bufferCtx = null;
  let bufferCtxRate = 0;
  function makeBuffer(channels, sampleRate) {
    const Ctor = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!Ctor) return null;
    const sr = Math.max(8000, Math.min(192000, Math.round(sampleRate || 44100)));
    try {
      if (!bufferCtx || bufferCtxRate !== sr) {
        bufferCtx = new Ctor(Math.max(1, Math.min(2, channels.length)), 128, sr);
        bufferCtxRate = sr;
      }
      const buf = bufferCtx.createBuffer(channels.length, channels[0].length, sr);
      for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c, 0);
      return buf;
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ encoding */

  /**
   * WAV via the tested writer — 16, 24 or 32-bit float.
   * Returns raw bytes: blobs are only built when something is actually saved,
   * which keeps the memory footprint of a batch as small as possible.
   */
  function encodeWav(channels, sr, bitDepth) {
    const ab = DSP.encodeWav(channels, sr, bitDepth || 16);
    return new Uint8Array(ab);
  }

  /** Wrap bytes in a Blob for downloading. */
  function blobOf(bytes, mime) {
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }

  function mimeFor(name) {
    if (/\.mp3$/i.test(name)) return 'audio/mpeg';
    if (/\.wav$/i.test(name)) return 'audio/wav';
    return 'application/octet-stream';
  }

  /* --- MP3: lamejs, streamed through a worker so the UI stays alive --------- */

  const WORKER_SRC = [
    "let lame = null, enc = null, nCh = 2;",
    "self.onmessage = function (e) {",
    "  const d = e.data;",
    "  if (d.cmd === 'init') {",
    "    try { importScripts(d.url); } catch (err) { self.postMessage({ ok: false, err: 'import:' + err }); return; }",
    "    if (typeof lamejs === 'undefined') { self.postMessage({ ok: false, err: 'no lamejs' }); return; }",
    "    nCh = d.nCh;",
    "    try { enc = new lamejs.Mp3Encoder(nCh, d.sr, d.kbps); }",
    "    catch (err2) { self.postMessage({ ok: false, err: 'init:' + err2 }); return; }",
    "    self.postMessage({ ok: true });",
    "    return;",
    "  }",
    "  if (d.cmd === 'chunk' && enc) {",
    "    const parts = [];",
    "    const view = nCh === 2 ? d.right : null;",
    "    const mb = enc.encodeBuffer(d.left, view);",
    "    if (mb.length) parts.push(mb);",
    "    if (d.last) { const f = enc.flush(); if (f.length) parts.push(f); }",
    "    const total = parts.reduce(function (a, b) { return a + b.length; }, 0);",
    "    const out = new Uint8Array(total);",
    "    let off = 0;",
    "    for (const p of parts) { out.set(p, off); off += p.length; }",
    "    self.postMessage({ ok: true, data: out.buffer }, [out.buffer]);",
    "  }",
    "};",
  ].join('\n');

  let workerUrl = null;
  function getWorkerUrl() {
    if (workerUrl) return workerUrl;
    try {
      workerUrl = global.URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
    } catch (e) { workerUrl = null; }
    return workerUrl;
  }

  /**
   * Encode channels to MP3.
   * @param {Float32Array[]} channels 1 or 2 channels
   * @param {number} sr
   * @param {number} kbps
   * @param {(p:number)=>void} [onProgress] 0..1
   */
  async function encodeMp3(channels, sr, kbps, onProgress) {
    const nCh = Math.min(2, channels.length);
    const len = channels[0].length;
    const rate = MP3_RATES.indexOf(sr) === -1 ? mp3RateFor(sr) : sr;
    const left = channels[0];
    const right = nCh > 1 ? channels[1] : null;
    const CHUNK = Math.max(1152 * 4, Math.floor(rate * 1.5));

    const url = getWorkerUrl();
    const lameUrl = Libs ? await Libs.lameUrl() : 'assets/vendor/lame.min.js';

    let worker = null;
    if (url && global.Worker) {
      try {
        worker = new global.Worker(url);
        worker.postMessage({ cmd: 'init', url: lameUrl, nCh, sr: rate, kbps });
        await new Promise((resolve, reject) => {
          const to = global.setTimeout(() => reject(new Error('worker timeout')), 15000);
          worker.onmessage = (e) => {
            global.clearTimeout(to);
            if (e.data && e.data.ok) resolve(true); else reject(new Error(e.data && e.data.err));
          };
        });
      } catch (err) {
        try { worker.terminate(); } catch (e) { /* ignore */ }
        worker = null;
      }
    }

    if (!worker) return encodeMp3MainThread(channels, rate, kbps, onProgress);

    const parts = [];
    const once = () => new Promise((resolve, reject) => {
      worker.onmessage = (e) => (e.data && e.data.ok ? resolve(e.data.data) : reject(new Error('mp3 chunk failed')));
    });
    for (let off = 0; off < len; off += CHUNK) {
      const end = Math.min(len, off + CHUNK);
      const last = end >= len;
      // slice copies: the worker must not see a shared, moving buffer
      worker.postMessage({
        cmd: 'chunk',
        left: left.slice(off, end),
        right: right ? right.slice(off, end) : null,
        last,
      });
      const data = await once();
      if (data && data.byteLength) parts.push(new Uint8Array(data));
      if (onProgress) onProgress(end / len);
      if (!last) await tick();
    }
    worker.terminate();
    return { bytes: concat(parts), sampleRate: rate };
  }

  /** Same thing without a worker (rare browsers / blocked blob workers). */
  async function encodeMp3MainThread(channels, rate, kbps, onProgress) {
    const lamejs = await Libs.lame();
    const nCh = Math.min(2, channels.length);
    const enc = new lamejs.Mp3Encoder(nCh, rate, kbps);
    const len = channels[0].length;
    const left = channels[0];
    const right = nCh > 1 ? channels[1] : null;
    const parts = [];
    const CHUNK = Math.max(1152 * 4, Math.floor(rate * 1.5));
    for (let off = 0; off < len; off += CHUNK) {
      const end = Math.min(len, off + CHUNK);
      const l = left.subarray(off, end);
      const r = right ? right.subarray(off, end) : null;
      const mb = enc.encodeBuffer(l, r);
      if (mb.length) parts.push(new Uint8Array(mb));
      if (end >= len) {
        const f = enc.flush();
        if (f.length) parts.push(new Uint8Array(f));
      }
      if (onProgress) onProgress(end / len);
      await tick();
    }
    return { bytes: concat(parts), sampleRate: rate };
  }

  /** Join the MP3 fragments into one contiguous block. */
  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  const tick = () => new Promise((r) => global.setTimeout(r, 0));

  /* -------------------------------------------------------------------- zipping */

  /**
   * Build a ZIP from finished results.
   * @param {Array<{name:string, bytes:Uint8Array}>} entries
   * @param {(p:number)=>void} [onProgress]
   * @returns {Promise<Uint8Array>}
   */
  async function zip(entries, onProgress) {
    const JSZip = await Libs.jszip();
    const zipFile = new JSZip();
    const names = new Set();
    for (const e of entries) {
      let n = e.name;
      let i = 2;
      while (names.has(n)) { n = e.name.replace(/(\.[^.]+)$/, ' (' + i + ')$1'); i++; }
      names.add(n);
      const isWav = /\.wav$/i.test(n);
      zipFile.file(n, e.bytes, {
        compression: isWav ? 'DEFLATE' : 'STORE',
        compressionOptions: isWav ? { level: 1 } : undefined,
      });
    }
    if (entries.readme) zipFile.file('README.txt', entries.readme);
    // 'uint8array' (not 'blob') keeps JSZip on its plain byte path — no FileReader,
    // no intermediate blob copies — and lets the caller decide how to save it
    const bytes = await zipFile.generateAsync(
      { type: 'uint8array' },
      (meta) => { if (onProgress) onProgress(meta.percent / 100); },
    );
    return bytes;
  }

  /* ------------------------------------------------------------------ download */

  function download(data, filename) {
    const blob = data instanceof Blob ? data : blobOf(data, mimeFor(filename));
    const url = global.URL.createObjectURL(blob);
    const a = global.document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    global.document.body.appendChild(a);
    a.click();
    global.setTimeout(() => {
      a.remove();
      global.URL.revokeObjectURL(url);
    }, 4000);
    return filename;
  }

  const API = {
    MP3_RATES, mp3RateFor,
    decodeArrayBuffer, decodeFile, decodeWithFFmpeg,
    encodeWav, encodeMp3, makeBuffer, readBlob, blobOf, mimeFor,
    zip, download,
    outputName, formatBytes, formatDuration, formatRate, formatDb,
  };

  global.RSCodecs = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
