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
    const base = String(name || 'audio').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'audio';
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

  /**
   * Stream a WAV file into any sink that offers `write(chunk)` / `close()`
   * (an `RSOPFS` writer, or the same shape in memory) — the header and every
   * PCM slice are produced and written one at a time, so a 20-minute 24-bit
   * stereo master (≈350 MB) never exists as a single `ArrayBuffer` on the
   * main thread the way `encodeWav()` above would build it.
   * @param {Float32Array[]} channels
   * @param {number} sr
   * @param {16|24|32} bitDepth
   * @param {{write:(chunk:Uint8Array)=>Promise<void>}} sink
   * @param {(p:number)=>void} [onProgress] 0..1
   */
  async function encodeWavStream(channels, sr, bitDepth, sink, onProgress) {
    const nCh = Math.min(2, channels.length);
    const len = channels[0].length;
    const bytesPerSample = (bitDepth || 16) / 8;
    const blockAlign = nCh * bytesPerSample;
    const dataSize = len * blockAlign;

    await sink.write(new Uint8Array(DSP.wavHeader(nCh, sr, bitDepth || 16, dataSize)));

    // ~4 MB per chunk: large enough to amortise the per-chunk overhead of a
    // worker round-trip, small enough to keep peak memory bounded regardless
    // of the file's total length
    const samplesPerChunk = Math.max(4096, Math.floor((4 * 1024 * 1024) / Math.max(1, blockAlign)));
    for (let off = 0; off < len; off += samplesPerChunk) {
      const end = Math.min(len, off + samplesPerChunk);
      const chunk = DSP.wavChunk(channels, bitDepth || 16, off, end);
      await sink.write(chunk);
      if (onProgress) onProgress(end / len);
      if (end < len) await tick();
    }
    return { sampleRate: sr, samples: len, bytesWritten: 44 + dataSize };
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

  /**
   * Float → the integer scale lamejs actually encodes.
   *
   * This is not cosmetic. `lamejs.Mp3Encoder.encodeBuffer()` copies whatever it
   * is handed into a `Float32Array` and its ported LAME reads that array as PCM
   * on the 16-bit scale (proven: handing it integers and handing it the same
   * integers as floats produces byte-identical MP3s). Hand it normalised −1…+1
   * floats, as this function's caller used to, and every sample lands ≈ 90 dB
   * below full scale — the export is a valid, frame-aligned MP3 of digital
   * silence. So every sample that goes into the encoder passes through here.
   *
   * The chain output is 32-bit float, so the conversion is also where the word
   * length is decided: TPDF dither at ±1 LSB (two independent uniform draws,
   * triangular distribution) avoids the correlated quantization error that
   * plain truncation folds back into quiet, heavily repaired material.
   *
   * @param {Float32Array} src
   * @param {number} from first sample (inclusive)
   * @param {number} to   last sample (exclusive)
   * @returns {Int16Array}
   */
  function toInt16(src, from, to) {
    const start = from || 0;
    const end = to === undefined ? src.length : to;
    const out = new Int16Array(Math.max(0, end - start));
    for (let i = 0; i < out.length; i++) {
      let v = src[start + i] * 32768 + (Math.random() + Math.random() - 1);
      // a non-finite sample becomes silence, never a full-scale click
      if (v !== v || v === Infinity || v === -Infinity) v = 0;
      else if (v < -32768) v = -32768;
      else if (v > 32767) v = 32767;
      out[i] = v < 0 ? -Math.round(-v) : Math.round(v);
    }
    return out;
  }

  /** A 4-byte MPEG audio frame header (0xFFEx/0xFFFx), or an ID3 tag. */
  function looksLikeMp3(bytes) {
    if (!bytes || bytes.length < 4) return false;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;   // "ID3"
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  }

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
    "    if (typeof enc.encodeBuffer !== 'function') { self.postMessage({ ok: false, err: 'no-encodeBuffer' }); return; }",
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
   * A tiny accumulator with the same `write()` shape as an OPFS/memory sink —
   * lets `encodeMp3`/`encodeMp3MainThread` always stream their output through
   * one code path, whether or not the caller handed them a real sink.
   */
  function collectingSink() {
    const parts = [];
    let length = 0;
    return {
      parts,
      async write(chunk) { if (chunk && chunk.length) { parts.push(chunk); length += chunk.length; } },
      get length() { return length; },
    };
  }

  /**
   * Encode channels to MP3.
   * @param {Float32Array[]} channels 1 or 2 channels
   * @param {number} sr
   * @param {number} kbps
   * @param {(p:number)=>void} [onProgress] 0..1
   * @param {{write:(chunk:Uint8Array)=>Promise<void>}} [sink] stream the MP3
   *        straight into this sink (e.g. an `RSOPFS` writer) instead of
   *        returning it as one `Uint8Array` — the only way a long batch file
   *        does not sit fully encoded in the main thread's heap.
   */
  async function encodeMp3(channels, sr, kbps, onProgress, sink) {
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

    if (!worker) return encodeMp3MainThread(channels, rate, kbps, onProgress, sink);

    const out = sink || collectingSink();
    let firstChunk = null;
    let bytesWritten = 0;
    const once = () => new Promise((resolve, reject) => {
      worker.onmessage = (e) => (e.data && e.data.ok ? resolve(e.data.data) : reject(new Error('mp3 chunk failed')));
    });
    for (let off = 0; off < len; off += CHUNK) {
      const end = Math.min(len, off + CHUNK);
      const last = end >= len;
      // 16-bit chunks, handed over rather than copied: they are ours alone, and
      // the worker is the one place the PCM still exists at full length
      const l = toInt16(left, off, end);
      const r = right ? toInt16(right, off, end) : null;
      const transfer = r ? [l.buffer, r.buffer] : [l.buffer];
      worker.postMessage({ cmd: 'chunk', left: l, right: r, last }, transfer);
      const data = await once();
      if (data && data.byteLength) {
        const bytes = new Uint8Array(data);
        if (!firstChunk) firstChunk = bytes;
        bytesWritten += bytes.length;
        await out.write(bytes);
      }
      if (onProgress) onProgress(end / len);
      if (!last) await tick();
    }
    worker.terminate();
    return finishMp3Stream(out, firstChunk, bytesWritten, rate, len, sink);
  }

  /** Same thing without a worker (rare browsers / blocked blob workers). */
  async function encodeMp3MainThread(channels, rate, kbps, onProgress, sink) {
    const lamejs = await Libs.lame();
    const nCh = Math.min(2, channels.length);
    const enc = new lamejs.Mp3Encoder(nCh, rate, kbps);
    const len = channels[0].length;
    const left = channels[0];
    const right = nCh > 1 ? channels[1] : null;
    const out = sink || collectingSink();
    let firstChunk = null;
    let bytesWritten = 0;
    const CHUNK = Math.max(1152 * 4, Math.floor(rate * 1.5));
    for (let off = 0; off < len; off += CHUNK) {
      const end = Math.min(len, off + CHUNK);
      const l = toInt16(left, off, end);
      const r = right ? toInt16(right, off, end) : null;
      const mb = enc.encodeBuffer(l, r);
      if (mb.length) {
        const bytes = new Uint8Array(mb);
        if (!firstChunk) firstChunk = bytes;
        bytesWritten += bytes.length;
        await out.write(bytes);
      }
      if (end >= len) {
        const f = enc.flush();
        if (f.length) {
          const bytes = new Uint8Array(f);
          if (!firstChunk) firstChunk = bytes;
          bytesWritten += bytes.length;
          await out.write(bytes);
        }
      }
      if (onProgress) onProgress(end / len);
      await tick();
    }
    return finishMp3Stream(out, firstChunk, bytesWritten, rate, len, sink);
  }

  /**
   * Last gate before an MP3 is handed to the download: it has to be a stream,
   * and it has to be a stream that came from samples. Both checks exist because
   * the failure they catch is silent — a zero-byte or an audio-free file looks
   * like a successful export to everything except the ear.
   */
  function finishMp3(bytes, rate, samples) {
    if (!bytes || bytes.length < 128) throw new Error('mp3-empty');
    if (!looksLikeMp3(bytes)) throw new Error('mp3-invalid');
    return { bytes, sampleRate: rate, samples };
  }

  /**
   * Same gate as `finishMp3()`, for the streaming encoders: when no external
   * sink was supplied the internal `collectingSink()` is concatenated and
   * validated exactly as before (full backward compatibility); when the
   * caller streamed into their own sink, only the first produced chunk is
   * inspected — the full stream never needs reassembling in the heap just to
   * be validated.
   */
  function finishMp3Stream(out, firstChunk, bytesWritten, rate, samples, externalSink) {
    if (!firstChunk) throw new Error('mp3-empty');
    if (!looksLikeMp3(firstChunk)) throw new Error('mp3-invalid');
    if (externalSink) {
      if (bytesWritten < 128) throw new Error('mp3-empty');
      return { sampleRate: rate, samples, bytesWritten };
    }
    return finishMp3(concat(out.parts), rate, samples);
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

  /* ------------------------------------------------- incremental stream encoders */
  /*
   * `encodeWavStream()`/`encodeMp3()` above already stream their *output* in
   * bounded-size writes, but each of them still takes one whole-file
   * `channels` array as input — exactly what `Engine.renderChunked()` is
   * built to avoid ever materialising. The two factories below are the
   * missing half: a persistent encoder object fed one render chunk at a
   * time (`appendChannels()`), so the chunked render pipeline never needs
   * the full-length audio in memory on either side of the encode step.
   * Neither touches the existing whole-file functions above — those remain
   * exactly as tested, for every caller that still has (or wants) the whole
   * file in hand.
   */

  /**
   * An incremental WAV writer: knows the total sample count up front (so the
   * 44-byte header's sizes are right the first and only time it is written),
   * then accepts any number of `appendChannels()` calls of any chunk length.
   * @param {number} totalSamples the exact number of frames the finished file will hold
   * @param {number} sr
   * @param {16|24|32} bitDepth
   * @param {{write:(chunk:Uint8Array)=>Promise<void>}} sink
   */
  function createWavStreamEncoder(totalSamples, sr, bitDepth, sink) {
    const bd = bitDepth || 16;
    let nCh = null;
    let written = 0;
    let bytesWritten = 0;
    return {
      /** Appends one chunk's channels (1 or 2, any length, in order). */
      async appendChannels(channels) {
        if (nCh === null) {
          nCh = Math.min(2, channels.length);
          const bytesPerSample = bd / 8;
          const dataSize = Math.max(0, totalSamples) * nCh * bytesPerSample;
          await sink.write(new Uint8Array(DSP.wavHeader(nCh, sr, bd, dataSize)));
          bytesWritten += 44;
        }
        const n = channels[0].length;
        if (!n) return;
        const chunk = DSP.wavChunk(channels, bd, 0, n);
        await sink.write(chunk);
        bytesWritten += chunk.length;
        written += n;
      },
      /** No trailing bytes to flush for WAV — every chunk is already final. Returns the summary. */
      async finish() { return { sampleRate: sr, samples: written, bytesWritten }; },
    };
  }

  /**
   * An incremental MP3 encoder: the same worker-backed (main-thread
   * fallback otherwise) lamejs pipeline `encodeMp3()`/`encodeMp3MainThread()`
   * use, kept alive across repeated `appendChannels()` calls instead of
   * looping over one whole-file array itself.
   * @param {number} sr
   * @param {number} kbps
   * @param {number} nCh
   * @param {{write:(chunk:Uint8Array)=>Promise<void>}} sink
   */
  async function createMp3StreamEncoder(sr, kbps, nCh, sink) {
    const rate = MP3_RATES.indexOf(sr) === -1 ? mp3RateFor(sr) : sr;
    const ch = Math.min(2, Math.max(1, nCh || 1));
    const url = getWorkerUrl();
    const lameUrl = Libs ? await Libs.lameUrl() : 'assets/vendor/lame.min.js';

    let worker = null;
    if (url && global.Worker) {
      try {
        worker = new global.Worker(url);
        worker.postMessage({ cmd: 'init', url: lameUrl, nCh: ch, sr: rate, kbps });
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

    let mainEnc = null;
    if (!worker) mainEnc = new (await Libs.lame()).Mp3Encoder(ch, rate, kbps);

    let bytesWritten = 0;
    let finished = false;

    async function encodeOne(l, r, last) {
      if (worker) {
        const transfer = r ? [l.buffer, r.buffer] : [l.buffer];
        const resultP = new Promise((resolve, reject) => {
          worker.onmessage = (e) => (e.data && e.data.ok ? resolve(e.data.data) : reject(new Error('mp3 chunk failed')));
        });
        worker.postMessage({ cmd: 'chunk', left: l, right: r, last }, transfer);
        const data = await resultP;
        if (data && data.byteLength) {
          const bytes = new Uint8Array(data);
          bytesWritten += bytes.length;
          await sink.write(bytes);
        }
      } else {
        const mb = mainEnc.encodeBuffer(l, r);
        if (mb.length) { bytesWritten += mb.length; await sink.write(new Uint8Array(mb)); }
        if (last) {
          const f = mainEnc.flush();
          if (f.length) { bytesWritten += f.length; await sink.write(new Uint8Array(f)); }
        }
      }
    }

    return {
      rate,
      /**
       * Encode one render chunk's channels. `isLast` tells the encoder (and,
       * for the worker path, the lamejs instance it owns) this is the final
       * call — any internal buffering is flushed as part of it.
       */
      async appendChannels(channels, isLast) {
        if (finished) return;
        const left = toInt16(channels[0], 0, channels[0].length);
        const right = ch > 1 ? toInt16(channels[1] || channels[0], 0, channels[0].length) : null;
        await encodeOne(left, right, !!isLast);
        if (isLast) finished = true;
      },
      /** Terminate the worker (if any) and return the final byte count. Always call this once, even if the last `appendChannels()` already marked `isLast`. */
      async finish() {
        if (!finished) { await encodeOne(new Int16Array(0), ch > 1 ? new Int16Array(0) : null, true); finished = true; }
        if (worker) worker.terminate();
        return { sampleRate: rate, bytesWritten };
      },
    };
  }

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
    MP3_RATES, mp3RateFor, toInt16, looksLikeMp3,
    decodeArrayBuffer, decodeFile, decodeWithFFmpeg,
    encodeWav, encodeWavStream, encodeMp3, makeBuffer, readBlob, blobOf, mimeFor,
    createWavStreamEncoder, createMp3StreamEncoder,
    zip, download,
    outputName, formatBytes, formatDuration, formatRate, formatDb,
  };

  global.RSCodecs = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
