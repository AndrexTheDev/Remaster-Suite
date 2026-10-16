'use strict';
/* =============================================================================
 * Remaster Suite — measurement toolkit
 * -----------------------------------------------------------------------------
 * Not part of the app. It exists so a probe is five lines long instead of
 * fifty, and it is *committed* — the probes it serves are the evidence for the
 * restoration claims, and evidence that lives only in a gitignored directory
 * does not survive a fresh checkout.
 *
 *   const U = require('./util.js');
 *   const { H, RSDSP, SR, db, truePeakDb, enc, dec } = U;
 *
 * H is tests/harness.js (the production worklet and dsp-utils, headless).
 * ffmpeg: the sandbox has no system build; tools/setup.sh installs one from npm
 * into ~/.toolkit and symlinks it into PATH (see the note there).
 * ========================================================================== */const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const H = require(path.join(ROOT, 'tests', 'harness.js'));
const RSDSP = H.loadDsp();
const SR = 48000;
const WORK = path.join(__dirname, 'work');
fs.mkdirSync(WORK, { recursive: true });

const db = (x) => 20 * Math.log10(Math.max(Math.abs(x), 1e-20));
const lin = (d) => Math.pow(10, d / 20);

/* ---------------------------------------------------------------------------
 * 4× oversampled true peak. A windowed-sinc interpolator (32 taps, Hann) —
 * the same job the worklet's limiter detector does, so "dBTP" means the same
 * thing in a probe as in the app.
 * ------------------------------------------------------------------------ */
let TP_TAPS = null;
function tpTaps() {
  if (TP_TAPS) return TP_TAPS;
  const N = 32, t = new Float64Array(N * 4);
  for (let p = 0; p < 4; p++) {
    for (let n = 0; n < N; n++) {
      const x = (n - N / 2 + 1 - p / 4) * Math.PI;
      const s = Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x;
      const w = 0.5 + 0.5 * Math.cos(2 * Math.PI * (n - N / 2 + 0.5) / N);
      t[p * N + n] = s * w;
    }
    let sum = 0;
    for (let n = 0; n < N; n++) sum += t[p * N + n];
    for (let n = 0; n < N; n++) t[p * N + n] /= sum;
  }
  TP_TAPS = t;
  return t;
}
function truePeak(chans) {
  const t = tpTaps();
  let peak = 0;
  for (const ch of chans) {
    for (let i = 0; i < ch.length; i++) {
      for (let p = 0; p < 4; p++) {
        let acc = 0;
        for (let n = 0; n < 32; n++) {
          const j = i + n - 31;
          if (j >= 0 && j < ch.length) acc += ch[j] * t[p * 32 + n];
        }
        const a = acc < 0 ? -acc : acc;
        if (a > peak) peak = a;
      }
    }
  }
  return peak;
}
const truePeakDb = (chans) => db(truePeak(chans));

/* ---------------------------------------------------------------------------
 * Loudness, the EBU way enough to compare two renders: K-weighted power over
 * the whole file, no gating (probes compare files, they do not certify them).
 * ------------------------------------------------------------------------ */
function kWeight(ch) {
  // stage 1: high shelf (+4 dB above ~1.5 kHz), stage 2: high-pass at 38 Hz
  const b = new Float64Array(4), a = new Float64Array(4);
  const out = new Float32Array(ch.length);
  // coefficients from the RBJ cookbook, sub-20 Hz rows dropped (see R128)
  const shelf = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
  const hp = [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621];
  const stages = [shelf, hp];
  let x = ch;
  for (const c of stages) {
    const [b0, b1, b2, a1, a2] = c;
    let z1 = 0, z2 = 0;
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const o = b0 * v + z1;
      z1 = b1 * v - a1 * o + z2;
      z2 = b2 * v - a2 * o;
      y[i] = o;
    }
    x = y;
  }
  for (let i = 0; i < out.length; i++) out[i] = x[i];
  return out;
}
function lufs(chans) {
  let e = 0, n = 0;
  for (const ch of chans) {
    const w = kWeight(ch);
    for (let i = 0; i < w.length; i++) e += w[i] * w[i];
    n += w.length;
  }
  return -0.691 + 10 * Math.log10(e / Math.max(1, n));
}

/* ---------------------------------------------------------------------------
 * WAVE I/O — float32 in, float32 out; ffmpeg does the codecs.
 * ------------------------------------------------------------------------ */
function wavWrite(file, chans, sr) {
  const nCh = chans.length, n = chans[0].length;
  const buf = Buffer.alloc(44 + n * nCh * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * nCh * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20);   // IEEE float
  buf.writeUInt16LE(nCh, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * nCh * 4, 28); buf.writeUInt16LE(nCh * 4, 32); buf.writeUInt16LE(32, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * nCh * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) { buf.writeFloatLE(chans[c][i], o); o += 4; }
  }
  fs.writeFileSync(file, buf);
  return file;
}
function wavRead(file) {
  const buf = fs.readFileSync(file);
  let o = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(o + 8);
      // ffmpeg writes WAVE_FORMAT_EXTENSIBLE for float data: the real tag is
      // the first two bytes of the sub-format GUID, and reading it as integer
      // PCM turns a clean sine into noise (found the hard way — the probe
      // reported +3 dB on an mp3 round trip that had not gained anything)
      if (format === 0xfffe) format = buf.readUInt16LE(o + 8 + 24);
      fmt = { format, channels: buf.readUInt16LE(o + 10),
        rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    } else if (id === 'data') { dataOff = o + 8; dataLen = size; break; }
    o += 8 + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('not a WAV: ' + file);
  const nCh = fmt.channels;
  const bytes = Math.min(dataLen, buf.length - dataOff);
  const n = Math.floor(bytes / (nCh * fmt.bits / 8));
  const out = Array.from({ length: nCh }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const p = dataOff + (i * nCh + c) * (fmt.bits / 8);
      if (fmt.format === 3) out[c][i] = buf.readFloatLE(p);
      else if (fmt.bits === 16) out[c][i] = buf.readInt16LE(p) / 32768;
      else if (fmt.bits === 24) out[c][i] = (buf.readIntLE(p, 3) << 8) / 2147483648;
      else if (fmt.bits === 32) out[c][i] = buf.readInt32LE(p) / 2147483648;
      else if (fmt.bits === 8) out[c][i] = (buf.readUInt8(p) - 128) / 128;
    }
  }
  return { chans: out, sr: fmt.rate };
}

/* ---------------------------------------------------------------------------
 * ffmpeg. The sandbox image has none (see tools/setup.sh for the one-liner
 * that installs a static build from npm); a probe that needs a codec should
 * fail loudly, not silently measure the wrong thing.
 * ------------------------------------------------------------------------ */
function ffmpegPath() {
  const env = process.env.FFMPEG;
  if (env && fs.existsSync(env)) return env;
  const local = path.join(process.env.HOME || '/home/user', '.toolkit', 'node_modules', '@ffmpeg-installer', 'linux-x64', 'ffmpeg');
  if (fs.existsSync(local)) return local;
  return 'ffmpeg';
}
/** true when a working ffmpeg is reachable (env, ~/.toolkit, or PATH) */
function hasFfmpeg() {
  try {
    const r = cp.spawnSync(ffmpegPath(), ['-version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
  } catch (e) { return false; }
}
function ffmpeg(args, opts) {
  const r = cp.spawnSync(ffmpegPath(), ['-hide_banner', '-nostdin', '-y'].concat(args),
    { encoding: 'utf8', maxBuffer: 1 << 28, ...(opts || {}) });
  if (r.error) throw new Error('ffmpeg unavailable: ' + r.error.message + ' (see tools/setup.sh)');
  if (r.status !== 0) throw new Error('ffmpeg failed (' + r.status + '):\n' + (r.stderr || '').split('\n').slice(-6).join('\n'));
  return r;
}

/**
 * Raised when a step needs a codec this sandbox does not have. The acceptance
 * run catches it per section and reports that section as SKIPPED, with the
 * reason, instead of aborting the whole matrix.
 */
class NoDecoder extends Error {
  constructor(msg) { super(msg); this.name = 'NoDecoder'; }
}

/** decode any file ffmpeg reads → Float32Array per channel at its own rate.
 * Without ffmpeg only WAV decodes (in memory, pure JS); an MP3 is refused. */
function dec(file) {
  if (!hasFfmpeg()) {
    if (/\.wav$/i.test(file)) return wavRead(file).chans;
    throw new NoDecoder('MP3 decode needs ffmpeg (' + path.basename(file) + '); lamejs only encodes');
  }
  const out = file.replace(/\.[^./]+$/, '') + '.dec.wav';
  ffmpeg(['-i', file, '-c:a', 'pcm_f32le', out]);
  const r = wavRead(out);
  return r.chans;
}

/**
 * Encode the way the app's export does — 16-bit into the encoder, MP3 out —
 * and hand back what a re-upload of that file decodes to. `chans` is the
 * channel array, `kbps` the bitrate, `file` where the MP3 goes.
 */
function enc(chans, kbps, file, sr) {
  const rate = sr || SR;
  // quantise first: lamejs is fed Int16 and the app's export is 16-bit
  const q = chans.map((c) => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = Math.max(-1, Math.min(1, c[i])); return o; });
  if (!hasFfmpeg()) {
    // no ffmpeg: the app's own encoder path (lamejs, 16-bit, app chunking) writes
    // the MP3; reading it back needs a decoder, which the sandbox does not have
    appMp3(q, kbps, file, rate);
    throw new NoDecoder('MP3 re-decode needs ffmpeg; lamejs wrote ' + path.basename(file));
  }
  const wav = wavWrite(WORK + '/enc-in.wav', q, rate);
  ffmpeg(['-i', wav, '-c:a', 'libmp3lame', '-b:a', kbps + 'k', '-ar', String(rate), file]);
  return dec(file);
}
/** the inverse: a file in, a 16-bit WAV out (the shape the app's importer sees) */
function encWav(chans, kbps, file, sr) {
  const rate = sr || SR;
  if (!hasFfmpeg()) { appMp3(chans, kbps, file, rate); return file; }
  const wav = wavWrite(WORK + '/enc-in.wav', chans, rate);
  ffmpeg(['-i', wav, '-c:a', 'libmp3lame', '-b:a', kbps + 'k', '-ar', String(rate), file]);
  return file;
}

/** the production worklet class */
/* ---------------------------------------------------------------------------
 * The app's *own* MP3 export, in Node.
 *
 * `enc()` above drives ffmpeg's LAME: the same encoder family, not the same
 * code. Measured on a bass-heavy 128 kbit/s export the two differ by 1.7 dB of
 * true peak and the app's own path is the worse one, so a claim about the file
 * the user keeps has to be measured through *this* path: lamejs out of
 * assets/vendor (loaded in a VM), the app's `toInt16` — TPDF dither at ±1 LSB,
 * clamp, round half away from zero — and the app's chunking, CHUNK =
 * max(1152 * 4, floor(rate * 1.5)), all of it mirrored from assets/js/codecs.js
 * (the audit pins the chunk expression in both files against each other, so this
 * copy cannot drift silently).
 * ------------------------------------------------------------------------ */
let LAME = null;
function lamejs() {
  if (LAME) return LAME;
  const ctx = {}; ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx; ctx.console = console;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'vendor', 'lame.min.js'), 'utf8'), ctx);
  LAME = ctx.lamejs;
  if (!LAME || !LAME.Mp3Encoder) throw new Error('lamejs did not load from assets/vendor/lame.min.js');
  return LAME;
}
/** codecs.toInt16, verbatim */
function toInt16Chunk(src, from, to) {
  const out = new Int16Array(Math.max(0, to - from));
  for (let i = 0; i < out.length; i++) {
    let v = src[from + i] * 32768 + (Math.random() + Math.random() - 1);
    if (v !== v || v === Infinity || v === -Infinity) v = 0;
    else if (v < -32768) v = -32768;
    else if (v > 32767) v = 32767;
    out[i] = v < 0 ? -Math.round(-v) : Math.round(v);
  }
  return out;
}
/**
 * Encode the way the app's export does — the app's encoder, the app's 16-bit
 * conversion and the app's chunk size — and return the file path.
 * @param {Float32Array[]} chans 1 or 2 channels
 * @param {number} kbps
 * @param {string} file where the MP3 goes
 * @param {number} [sr]
 */
function appMp3(chans, kbps, file, sr) {
  const rate = sr || SR;
  const nCh = Math.min(2, chans.length), len = chans[0].length;
  const enc = new (lamejs().Mp3Encoder)(nCh, rate, kbps || 320);
  const CHUNK = Math.max(1152 * 4, Math.floor(rate * 1.5));
  const parts = [];
  for (let off = 0; off < len; off += CHUNK) {
    const end = Math.min(len, off + CHUNK);
    const l = toInt16Chunk(chans[0], off, end);
    const r = nCh > 1 ? toInt16Chunk(chans[1], off, end) : null;
    const mb = enc.encodeBuffer(l, r);
    if (mb.length) parts.push(Buffer.from(mb));
    if (end === len) { const fl = enc.flush(); if (fl.length) parts.push(Buffer.from(fl)); }
  }
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

const loadProcessor = H.loadProcessor;

/**
 * The worklet with source patches applied — for probes that need to look
 * inside a stage (a global hook, an extra log). `patches` is an array of
 * [find, replace]; every find must match exactly once, so a probe can never
 * silently measure unpatched code.
 */
function loadProcessorEdited(patches, sr) {
  const file = path.join(ROOT, 'assets', 'worklets', 'remaster-processor.js');
  let code = fs.readFileSync(file, 'utf8');
  for (const [find, replace] of patches) {
    const n = code.split(find).length - 1;
    if (n !== 1) throw new Error('patch matched ' + n + ' times: ' + String(find).slice(0, 60));
    code = code.replace(find, replace);
  }
  const factory = vm.runInThisContext(
    '(function(sampleRate, AudioWorkletProcessor, registerProcessor) {\n' + code + '\n})',
    { filename: 'remaster-processor.edited.js' });
  const registry = {};
  class AudioWorkletProcessorStub {
    constructor() { this.port = { postMessage() {}, onmessage: null }; }
  }
  factory(sr || SR, AudioWorkletProcessorStub, (name, cls) => { registry[name] = cls; });
  return registry['remaster-processor'];
}

module.exports = {
  ROOT, H, RSDSP, SR, WORK, fs, ffmpeg, ffmpegPath, hasFfmpeg, NoDecoder,
  db, lin, lufs, truePeak, truePeakDb,
  wavWrite, wavRead, enc, encWav, dec, appMp3, lamejs,
  loadProcessor, loadProcessorEdited,
};
