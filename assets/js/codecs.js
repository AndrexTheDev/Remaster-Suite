/* =============================================================================
 * Remaster Suite — file in, file out
 * -----------------------------------------------------------------------------
 * Decoding : Web Audio (hardware independent) → optional FFmpeg.wasm rescue.
 * Encoding : WAV 16/24/32-bit written by hand (no dependency at all) and MP3 up
 *            to 320 kbps through lamejs, which runs inside a Web Worker so a
 *            long file never freezes the interface.
 * Packing  : JSZip, one click for the whole batch.
 * ========================================================================== */
/**
 * @fileoverview File in, file out — exposed as the global `RSCodecs`
 * (`globalThis.RSCodecs`).
 *
 * Decoding: Web Audio first (hardware-independent, no dependency), with an
 * optional FFmpeg.wasm rescue for a container the browser itself refuses.
 * Encoding: WAV at 16, 24 or 32-bit float, written by hand, and MP3 up to
 * 320 kbps through lamejs — in a Web Worker when there is one, on the main
 * thread otherwise, but always in bounded chunks so a long file never freezes
 * the interface and never sits encoded in the heap.
 * Packing: JSZip for the in-memory path, `RSOPFS.packZip` for the streamed one.
 *
 * Two families of encoders live here and both are kept: the whole-file
 * functions (`encodeWav`, `encodeMp3`) that take a complete channel array, and
 * the incremental ones (`createWavStreamEncoder`, `createMp3StreamEncoder`)
 * that a chunked render feeds one chunk at a time.
 *
 * @module RSCodecs
 */
(function (global) {
  'use strict';

  const DSP = global.RSDSP;
  const Libs = global.RSLibs;

  /**
   * Every sample rate MPEG-1/2 Layer III knows. The MP3 encoder cannot be
   * asked for anything else, so a source at another rate is *encoded* at the
   * nearest member of this list — see {@link RSCodecs.mp3RateFor}.
   * @type {number[]}
   */
  const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  /**
   * What decoding produced.
   * @typedef {Object} DecodeResult
   * @property {AudioBuffer} buffer - the decoded audio.
   * @property {number} sampleRate - the rate it really decoded at (the
   *   container's own rate when the header could be read).
   * @property {boolean} detected - `true` when the rate came from the file's
   *   own header rather than from the caller or the 44100 Hz default.
   * @property {boolean} rescued - `true` when the browser refused the file and
   *   FFmpeg.wasm produced it instead.
   */

  /**
   * What a whole-file encoder returns.
   * @typedef {Object} EncodeResult
   * @property {Uint8Array} [bytes] - the encoded file, when the caller did not
   *   pass a sink.
   * @property {number} sampleRate - the rate the encoder really used (for MP3
   *   this is the nearest {@link RSCodecs.MP3_RATES} member).
   * @property {number} samples - source frames encoded.
   * @property {number} [bytesWritten] - byte count, present on the streamed
   *   path where the bytes themselves went straight to the sink.
   */

  /**
   * An incremental encoder: feed it render chunks, then finish once. Both
   * factories in this module return this shape.
   * @typedef {Object} StreamEncoder
   * @property {function(Float32Array[], (boolean|undefined)=): Promise<void>} appendChannels
   *   - encode one chunk's channels, in file order.
   * @property {function(): Promise<Object>} finish - flush and return the
   *   summary; must be called exactly once, and is idempotent.
   * @property {number} [rate] - the rate actually used (the MP3 encoder only).
   */

  /* ---------------------------------------------------------------- small helpers */

  /**
   * Clamp a number into an inclusive range.
   * @param {number} x - value to clamp.
   * @param {number} lo - lower bound.
   * @param {number} hi - upper bound.
   * @returns {number} the clamped value.
   */
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  /**
   * Nearest sample rate the MP3 encoder can actually work with, measured in
   * octaves (a logarithmic distance, so 44.1 → 48 kHz is as far as 44.1 →
   * 40.5 would be, and the chosen rate is the closest one musically).
   * @param {number} sr - the source rate in Hz.
   * @returns {number} one of {@link RSCodecs.MP3_RATES}; 44100 Hz for a
   *   nonsense input.
   */
  function mp3RateFor(sr) {
    let best = 44100, bestD = Infinity;
    for (const r of MP3_RATES) {
      const d = Math.abs(Math.log2(r / sr));
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  /**
   * Format a byte count the way the UI shows it: one decimal below 10 units,
   * whole numbers above, and the German decimal comma where that applies.
   * @param {number} bytes - the size in bytes.
   * @param {string} lang - `'de'` or `'en'`.
   * @returns {string} e.g. `'1,4 MB'` or `'812 KB'`.
   */
  function formatBytes(bytes, lang) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const s = (v < 10 ? v.toFixed(1) : Math.round(v)).toString();
    return (lang === 'de' ? s.replace('.', ',') : s) + ' ' + units[i];
  }

  /**
   * Format a duration as `m:ss`, or `h:mm:ss` from one hour up — the form the
   * card, the ZIP readme and the progress bar all use, so a time is never
   * written two ways on one screen.
   * @param {number} seconds - the duration; negative and fractional values are
   *   rounded sensibly rather than rejected.
   * @returns {string} the formatted duration.
   */
  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    /**
     * Two-digit field, zero-padded.
     * @param {number} x - a minutes/seconds value, 0…59.
     * @returns {string} the padded text (at least two characters).
     */
    const pad = (x) => (x < 10 ? '0' + x : '' + x);
    return (h ? h + ':' + pad(m) : m) + ':' + pad(ss);
  }

  /**
   * Format a sample rate in kHz, dropping the decimal when it is zero (so
   * `48000` reads `48 kHz`, not `48,0 kHz`).
   * @param {number} sr - sample rate in Hz.
   * @param {string} lang - `'de'` or `'en'`.
   * @returns {string} e.g. `'48 kHz'` or `'44,1 kHz'`.
   */
  function formatRate(sr, lang) {
    const k = sr / 1000;
    const s = (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1));
    return (lang === 'de' ? s.replace('.', ',') : s) + ' kHz';
  }

  /**
   * Format a level in dB with an explicit sign, and an em dash for a value
   * that is not finite — `−∞ dBFS` reads as missing, not as a number.
   * @param {number} v - the level in dB.
   * @param {string} lang - `'de'` or `'en'`.
   * @returns {string} e.g. `'+3,2 dB'` or `'—'`.
   */
  function formatDb(v, lang) {
    if (!isFinite(v)) return '—';
    const s = v.toFixed(1);
    return (v > 0 ? '+' : '') + (lang === 'de' ? s.replace('.', ',') : s) + ' dB';
  }

  /**
   * A handy, filesystem-safe name for the result: the original base name,
   * path-hostile characters replaced, plus the default `' (restored)'` marker
   * (which is what makes a batch's output files recognisable next to the
   * originals) and the new extension.
   * @param {string} name - the source file's name.
   * @param {string} ext - the new extension, without the dot.
   * @param {string} [suffix=' (restored)'] - marker to insert before the
   *   extension; an empty string keeps the original name.
   * @returns {string} the output file name.
   */
  function outputName(name, ext, suffix) {
    const base = String(name || 'audio').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'audio';
    return base + (suffix === undefined ? ' (restored)' : suffix) + '.' + ext;
  }

  /* ------------------------------------------------------------------ decoding */

  /**
   * Read a File/Blob into an ArrayBuffer. `Blob.arrayBuffer()` is missing in
   * older Safari and in some embedded web views, so FileReader is the fallback,
   * and a `Response` is the last resort.
   * @param {Blob} blob - the file to read.
   * @returns {Promise<ArrayBuffer>} its bytes.
   * @throws {Error} `'cannot read file'` when the host has none of the three
   *   APIs.
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

  /**
   * The suspended live context used only by {@link RSCodecs.decodeInLiveContext}
   * on browsers whose offline context cannot decode (Safari before 14.1).
   * Created at most once and closed when decoding is done.
   * @type {AudioContext|null}
   */
  let liveDecodeCtx = null;
  /**
   * Build a throwaway offline context to decode with. An offline context
   * decodes exactly as well as a live one and needs no user gesture, no output
   * device and no permission — which is why the drop handler can analyse a file
   * without anything having been played yet.
   * @param {number} [sr] - desired rate in Hz, clamped to 8000…96000.
   * @returns {OfflineAudioContext|null} a 1-channel context, or `null` on a
   *   browser with neither offline constructor (the caller then falls back to
   *   the live path).
   */
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
   * @param {ArrayBuffer} arrayBuffer - the file's bytes; a copy is decoded, so
   *   the caller's buffer survives the detaching some browsers do.
   * @param {number} [sr] - desired rate in Hz, clamped to 8000…96000.
   * @returns {Promise<AudioBuffer>} the decoded audio.
   * @throws {Error} `'no audio context for decoding'` when the browser has no
   *   `AudioContext` at all, and whatever `decodeAudioData` reports otherwise.
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
   * Never loses the caller's bytes: `decodeAudioData` detaches its input in
   * some browsers, so it is handed a copy.
   * @param {ArrayBuffer} arrayBuffer - the file's bytes.
   * @param {number} [sr=44100] - the rate to decode at.
   * @returns {Promise<AudioBuffer>} the decoded audio.
   * @throws {Error} the decoder's own error, except on the Safari-old case
   *   where it is retried in a live context first.
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
   * that. Only ever used when the browser itself refuses the file, and it is
   * single-threaded on purpose — no cross-origin isolation needed, so it works
   * on plain static hosting.
   * @param {Blob} file - the file the browser refused.
   * @param {number} [sr] - rate to ask FFmpeg to convert to.
   * @returns {Promise<AudioBuffer>} the decoded audio.
   * @throws {Error} `'no library loader'` without `RSLibs`, `'ffmpeg
   *   unavailable'` when the CDN is unreachable, and FFmpeg's own error
   *   otherwise.
   */
  async function decodeWithFFmpeg(file, sr) {
    if (!Libs) throw new Error('no library loader');
    const factory = await Libs.ffmpegFactory();
    if (!factory) throw new Error('ffmpeg unavailable');
    const ff = factory({
      corePath: Libs.ffmpegCore.corePath,
      mainName: 'main',
      log: false,
      /**
       * Swallow FFmpeg's log stream: the rescue path is a fallback, and its
       * chatter must not reach the user's console.
       * @returns {void}
       */
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
   * from the container header. Three attempts, in order: the detected rate, a
   * universally supported 48 kHz, and finally the FFmpeg rescue — so a file
   * that merely has an unusual rate is never sent to FFmpeg for it.
   * @param {Blob} file - the dropped file.
   * @param {Object} [opts] - decode options.
   * @param {number} [opts.sampleRate] - force a rate instead of detecting one.
   * @param {boolean} [opts.allowFFmpeg=true] - `false` keeps the rescue path out
   *   of the way entirely (the tests do this to assert the browser's own
   *   refusal instead of downloading FFmpeg).
   * @returns {Promise<DecodeResult>} the buffer, its rate, and whether the rate
   *   was detected and whether FFmpeg produced it.
   * @throws {Error} the last decode error when all three paths failed.
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

  /**
   * The offline context reused for building monitoring buffers, plus the rate
   * it was built at — a buffer can only be created by a context of the same
   * rate, so a rate change means a new context.
   * @type {OfflineAudioContext|null}
   */
  let bufferCtx = null;
  /** @type {number} */
  let bufferCtxRate = 0;
  /**
   * Wrap plain channel arrays in an `AudioBuffer`, for the live monitor. The
   * context is cached because creating one per call would leak; a rate change
   * (a mixed batch of 44.1 and 48 kHz files) rebuilds it.
   * @param {Float32Array[]} channels - 1 or 2 channels, equal lengths.
   * @param {number} sampleRate - the buffer's rate in Hz, clamped to
   *   8000…192000.
   * @returns {AudioBuffer|null} the buffer, or `null` when the browser cannot
   *   create one (the caller then renders without a live monitor instead of
   *   failing).
   */
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
   * WAV via the tested writer — 16, 24 or 32-bit float. Returns raw bytes:
   * blobs are only built when something is actually saved, which keeps the
   * memory footprint of a batch as small as possible.
   * @param {Float32Array[]} channels - 1 or 2 channels.
   * @param {number} sr - sample rate in Hz for the header.
   * @param {(16|24|32)} [bitDepth=16] - word length; 32 means 32-bit float.
   * @returns {Uint8Array} the complete WAV file.
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
   * @param {Float32Array[]} channels - 1 or 2 channels, whole file.
   * @param {number} sr - sample rate in Hz.
   * @param {(16|24|32)} bitDepth - word length; 32 means 32-bit float.
   * @param {{write: function(Uint8Array): Promise<void>}} sink - where the
   *   header and each ~4 MB PCM slice go (an `RSOPFS` writer, or the same shape
   *   in memory).
   * @param {function(number): void} [onProgress] - called per written slice
   *   with a 0…1 share of the file.
   * @returns {Promise<{sampleRate: number, samples: number, bytesWritten: number}>}
   *   the summary, without ever holding the whole file.
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

  /**
   * Wrap bytes in a `Blob` for downloading.
   * @param {(Uint8Array|ArrayBuffer)} bytes - the payload.
   * @param {string} [mime='application/octet-stream'] - the blob's type.
   * @returns {Blob} the blob.
   */
  function blobOf(bytes, mime) {
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }

  /**
   * The MIME type for a file name — enough for a download to land in the right
   * place, and deliberately conservative: anything unknown is a byte stream.
   * @param {string} name - the output file name.
   * @returns {string} `'audio/mpeg'`, `'audio/wav'` or
   *   `'application/octet-stream'`.
   */
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
   * @param {Float32Array} src - samples to convert, −1…1.
   * @param {number} [from=0] - first sample, inclusive.
   * @param {number} [to=src.length] - last sample, exclusive.
   * @returns {Int16Array} the same span on the 16-bit scale, dithered.
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

  /**
   * Whether a byte block starts like MP3: an `ID3` tag, or a four-byte MPEG
   * audio frame sync (`0xFFEx`/`0xFFFx`). The cheapest honest check there is —
   * it catches the failure that matters, a stream that was never audio.
   * @param {(Uint8Array|ArrayBuffer)} bytes - the block to inspect.
   * @returns {boolean} `true` when the first bytes look like MP3.
   */
  function looksLikeMp3(bytes) {
    if (!bytes || bytes.length < 4) return false;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;   // "ID3"
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  }

  /**
   * Source text of the MP3 encoding worker: loads lamejs inside the worker
   * (`importScripts` on the URL `RSLibs.lameUrl()` resolved), builds one
   * `Mp3Encoder`, then encodes chunk after chunk, transferring each result
   * buffer back. Kept as a string because it is turned into a blob URL — the
   * same trick `RSOPFS` uses for its own worker.
   * @type {string}
   */
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

  /**
   * The blob URL of {@link WORKER_SRC}, created once per page. Cached because
   * creating (and revoking) a URL per file would churn the object registry, and
   * never revoked because the worker may be spawned again at any time.
   * @type {string|null}
   */
  let workerUrl = null;
  /**
   * Blob URL of the MP3 worker, or `null` when the host refuses to create one
   * (no `URL.createObjectURL`, a blocked blob URL) — the caller then encodes on
   * the main thread instead of failing.
   * @returns {string|null} the worker URL.
   */
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
   * @returns {{parts: Uint8Array[], write: function(Uint8Array): Promise<void>, length: number}}
   *   the sink; `parts` and `length` are its accumulated state.
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
   * @returns {Promise<EncodeResult>} the encoded bytes (when no sink was
   *   given), the rate really used, and the source frame count.
   * @throws {Error} `'mp3-empty'` / `'mp3-invalid'` from the final gate —
   *   never a silently silent file.
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
    /**
     * Await the worker's answer to one `chunk` message. The handler is
     * replaced per chunk rather than queued, which is what keeps this
     * strictly request/response even though `onmessage` is a single slot.
     * @returns {Promise<ArrayBuffer|Uint8Array>} the encoded bytes of one
     *   chunk.
     */
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

  /**
   * The same encoding without a worker — for browsers where blob workers are
   * blocked (some embedded web views) or `lamejs` can only be resolved on the
   * main thread. Fed the same chunks, and gated by the same checks, so its
   * output is interchangeable with the worker path.
   * @param {Float32Array[]} channels - 1 or 2 channels.
   * @param {number} rate - an already-validated {@link RSCodecs.MP3_RATES}
   *   member (the caller maps the source rate first).
   * @param {number} kbps - target bitrate.
   * @param {function(number): void} [onProgress] - 0…1 progress.
   * @param {Object} [sink] - optional streaming sink.
   * @returns {Promise<EncodeResult>} the result.
   */
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
   * @param {Uint8Array} bytes - the complete MP3.
   * @param {number} rate - the rate it was encoded at.
   * @param {number} samples - source frames encoded.
   * @returns {{bytes: Uint8Array, sampleRate: number, samples: number}} the result.
   * @throws {Error} `'mp3-empty'` for a stream under 128 bytes, `'mp3-invalid'`
   *   when it does not start like MPEG audio.
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
   * @param {Object} out - the internal collecting sink (read only when no
   *   external sink was supplied).
   * @param {Uint8Array|null} firstChunk - the first chunk the encoder produced;
   *   `null` means nothing was produced at all.
   * @param {number} bytesWritten - total bytes written to the sink.
   * @param {number} rate - the rate encoded at.
   * @param {number} samples - source frames encoded.
   * @param {Object} [externalSink] - present when the caller streamed into its
   *   own sink; then no reassembly happens.
   * @returns {EncodeResult} the summary.
   * @throws {Error} `'mp3-empty'` / `'mp3-invalid'` exactly as `finishMp3()`.
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

  /**
   * Join the MP3 fragments into one contiguous block. Used only on the
   * in-memory path — a streamed export never reassembles its parts.
   * @param {Uint8Array[]} parts - the fragments, in order.
   * @returns {Uint8Array} one block holding all of them.
   */
  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  /**
   * Yield to the event loop for one macrotask. Called between encode chunks
   * (and between written WAV slices) so the UI can paint a progress bar and the
   * GC can run while a long file is being written — without it the tab would
   * simply be frozen for the duration of an export.
   * @returns {Promise<void>} resolves on the next turn.
   */
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
   * @param {number} totalSamples - the exact number of frames the finished file
   *   will hold; the header's sizes are written once, from this number, which is
   *   why it has to be known up front (a chunked render is: the length is
   *   computed from the source and the rates before the first chunk).
   * @param {number} sr - sample rate in Hz.
   * @param {(16|24|32)} bitDepth - word length; 32 means 32-bit float.
   * @param {{write: function(Uint8Array): Promise<void>}} sink - the writer to
   *   stream into.
   * @returns {StreamEncoder} the encoder; the header is written with the first
   *   `appendChannels()` call, so an empty render still produces a valid file.
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
   * @param {number} sr - source rate; mapped to a legal MP3 rate with
   *   {@link RSCodecs.mp3RateFor} when it is not one already.
   * @param {number} kbps - target bitrate (32…320).
   * @param {number} nCh - channel count, 1 or 2.
   * @param {{write: function(Uint8Array): Promise<void>}} sink - the writer to
   *   stream into.
   * @returns {Promise<StreamEncoder>} the encoder, with its `rate` property set
   *   to the rate actually used. Spawning the worker (and loading lamejs inside
   *   it) happens here, so the first `appendChannels()` is pure encoding.
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

    /**
     * Encode one PCM window — through the worker when there is one, on the
     * main thread otherwise — and count what came back, so the caller can
     * estimate the finished file's size.
     * @param {Int16Array} l - left channel, 16-bit, transferred when a worker
     *   is used (the array must not be touched afterwards in that case).
     * @param {?Int16Array} r - right channel, or `null` for mono.
     * @param {boolean} last - `true` for the final window, which makes the
     *   encoder flush.
     * @returns {Promise<void>} resolves once the chunk's bytes are written.
     */
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
   * Build a ZIP in memory from finished results. WAV members are deflated at
   * level 1 (they compress a little, and level 1 costs almost nothing); MP3
   * members are stored, because re-compressing already-compressed audio only
   * burns time. Duplicate names get an index suffix instead of overwriting each
   * other, so a batch of `take.wav` files keeps every result.
   * @param {Array<{name: string, bytes: Uint8Array}>} entries - the members.
   * @param {function(number): void} [onProgress] - 0…1 progress, driven by
   *   JSZip's own metadata.
   * @returns {Promise<Uint8Array>} the archive bytes.
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

  /**
   * Hand a finished file to the browser as a download. The object URL is
   * revoked after a delay — immediately would break Firefox's download, never
   * would leak the blob — and the anchor is removed again.
   * @param {(Uint8Array|Blob)} data - the payload; a `Blob` is passed through
   *   untouched, so a streamed OPFS `File` never gets copied for this.
   * @param {string} filename - the name the browser should save under.
   * @returns {string} that same name, so a caller can log what it saved.
   */
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

  /**
   * The public surface, assigned to `global.RSCodecs` below.
   * @typedef {Object} RSCodecsApi
   * @property {number[]} MP3_RATES
   * @property {function(number): number} mp3RateFor
   * @property {function(Float32Array, number=, number=): Int16Array} toInt16
   * @property {function((Uint8Array|ArrayBuffer)): boolean} looksLikeMp3
   * @property {function(ArrayBuffer, number=): Promise<AudioBuffer>} decodeArrayBuffer
   * @property {function(Blob, Object=): Promise<DecodeResult>} decodeFile
   * @property {function(Blob, number=): Promise<AudioBuffer>} decodeWithFFmpeg
   * @property {function(Float32Array[], number, (16|24|32)=): Uint8Array} encodeWav
   * @property {function(Float32Array[], number, (16|24|32), Object, function(number)=): Promise<Object>} encodeWavStream
   * @property {function(Float32Array[], number, number, function(number)=, Object=): Promise<EncodeResult>} encodeMp3
   * @property {function(Float32Array[], number): (AudioBuffer|null)} makeBuffer
   * @property {function(Blob): Promise<ArrayBuffer>} readBlob
   * @property {function((Uint8Array|ArrayBuffer), string=): Blob} blobOf
   * @property {function(string): string} mimeFor
   * @property {function(number, number, (16|24|32), Object): StreamEncoder} createWavStreamEncoder
   * @property {function(number, number, number, Object): Promise<StreamEncoder>} createMp3StreamEncoder
   * @property {function(Array<Object>, function(number)=): Promise<Uint8Array>} zip
   * @property {function((Uint8Array|Blob), string): string} download
   * @property {function(string, string, string=): string} outputName
   * @property {function(number, string): string} formatBytes
   * @property {function(number): string} formatDuration
   * @property {function(number, string): string} formatRate
   * @property {function(number, string): string} formatDb
   */

  /** @type {RSCodecsApi} */
  const API = {
    MP3_RATES, mp3RateFor, toInt16, looksLikeMp3,
    decodeArrayBuffer, decodeFile, decodeWithFFmpeg,
    encodeWav, encodeWavStream, encodeMp3, makeBuffer, readBlob, blobOf, mimeFor,
    createWavStreamEncoder, createMp3StreamEncoder,
    zip, download,
    outputName, formatBytes, formatDuration, formatRate, formatDb,
  };

  /** @type {RSCodecsApi} */
  global.RSCodecs = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
