/* =============================================================================
 * Remaster Suite — DSP test suite (no browser required)
 *
 *   node tests/dsp.test.js
 *
 * Verifies the AudioWorklet restoration engine and the analysis/diagnosis
 * pipeline against synthetic but realistic material.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./harness.js');

const SR = 48000;
const RSDSP = H.loadDsp();
const Processor = H.loadProcessor(SR);

/* presets.js is a classic script (same file the browser loads) */
function loadPresets() {
  const code = fs.readFileSync(path.join(H.ROOT, 'assets', 'js', 'presets.js'), 'utf8');
  const sandbox = { console, Math, JSON, Float32Array, Object, Array, isFinite };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'presets.js' });
  return sandbox.RSPresets;
}
const RP = loadPresets();

/* ------------------------------------------------------------------ helpers */

function rms(sig) {
  let ms = 0;
  for (let i = 0; i < sig.length; i++) ms += sig[i] * sig[i];
  return Math.sqrt(ms / sig.length);
}
function peak(sig) {
  let p = 0;
  for (let i = 0; i < sig.length; i++) { const a = Math.abs(sig[i]); if (a > p) p = a; }
  return p;
}
function hasBad(sig) {
  for (let i = 0; i < sig.length; i++) if (!isFinite(sig[i])) return true;
  return false;
}
const band = (chans, f1, f2) =>
  RSDSP.bandMedian(RSDSP.spectrum(chans, SR, { fftSize: 8192, maxFrames: 120 }), f1, f2, []);

/** Realistic material built once and reused. */
const SIM = {
  garage: H.garageSim(RSDSP, SR, 14),
  cassette: H.cassetteSim(RSDSP, SR, 14),
  vinyl: H.vinylSim(RSDSP, SR, 14),
  lowbitrate: H.lowBitrateSim(RSDSP, SR, 14),
};
(() => {
  const env = H.songEnvelope(SR, 14, 0.08);
  const p = H.pink(SR, 14, 0.4, 3);
  const o = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) o[i] = p[i] * env[i] + Math.sin(i * 0.7) * 2e-5;
  SIM.clean = H.normalize(o, 0.8);
})();

const PARAMS = (id, metrics, power) => {
  const p = RP.buildParams(id, metrics, power === undefined ? RP.PRESETS[id].recommended : power);
  return Object.assign({}, H.DEFAULT_PARAMS, p);
};

/* ============================================================ engine tests */

H.section('engine · signal integrity');

{
  const sig = H.mix([H.tone(120, SR, 2, 0.3), H.tone(997, SR, 2, 0.2), H.pink(SR, 2, 0.1, 4)]);
  const out = H.render(Processor, [sig], Object.assign({}, H.DEFAULT_PARAMS, { power: 0 }))[0];
  let identical = true;
  for (let i = 0; i < sig.length; i++) if (Math.abs(out[i] - sig[i]) > 1e-7) { identical = false; break; }
  H.ok(identical, 'power = 0 is bit-transparent (true A/B reference)');
  H.ok(!hasBad(out), 'bypass path contains no NaN/Inf');

  const bypass = H.render(Processor, [sig], Object.assign({}, H.DEFAULT_PARAMS, {
    power: 1, bypass: 1, sub: 0.5, air: 0.5, exciter: 0.5,
  }))[0];
  H.ok(Math.abs(rms(bypass) - rms(sig)) < 1e-6, 'bypass parameter mutes processing completely');
}

{
  const silence = new Float32Array(SR * 2);
  const out = H.render(Processor, [silence], Object.assign({}, H.DEFAULT_PARAMS, {
    power: 1, sub: 1, air: 1, exciter: 1, dehiss: 1, declick: 1, reso: 1, glue: 1, warmth: 1,
    band0: 6, band5: 6, noiseFloor: -95, hissFloor: -110,
  }))[0];
  H.ok(!hasBad(out), 'silence in → valid silence out on a maximal setting (no NaN)');
  H.ok(peak(out) < 1e-3, 'engine does not invent signal out of silence');
}

{
  const loud = H.normalize(H.mix([H.tone(60, SR, 3, 0.6), H.tone(2000, SR, 3, 0.6), H.noise(SR, 3, 0.2, 6)]), 0.97);
  const out = H.render(Processor, [loud], Object.assign({}, H.DEFAULT_PARAMS, {
    power: 1, sub: 0.9, air: 1, exciter: 1, dehiss: 0.8, declick: 0.8, reso: 0.9, glue: 0.6,
    warmth: 0.65, band0: 9, band1: -9, band4: 9, band5: 9, tilt: 1,
  }))[0];
  H.ok(peak(out) <= 1.0001, 'never exceeds full scale even with every module at maximum', peak(out).toFixed(4));
  H.ok(!hasBad(out), 'extreme settings stay numerically stable');
}

/* ====================================================== feature tests: DSP */

H.section('engine · sub-harmonic synthesis (30–60 Hz)');
{
  const bass = H.mix([H.tone(90, SR, 3, 0.5), H.tone(180, SR, 3, 0.2)]);
  const off = H.render(Processor, [bass], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, sub: 0 }))[0];
  const on = H.render(Processor, [bass], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, sub: 0.8 }))[0];
  const gain = band([on], 42, 48) - band([off], 42, 48);
  H.ok(gain > 12, 'creates energy one octave below a 90 Hz bass line', gain.toFixed(1) + ' dB');
  const bassLoss = Math.abs(band([on], 85, 95) - band([off], 85, 95));
  H.ok(bassLoss < 6, 'leaves the original bass fundamental intact', bassLoss.toFixed(1) + ' dB');
  H.ok(Math.abs(rms(on) - rms(off)) / rms(off) < 0.6, 'sub gain stays musically sane');
}

H.section('engine · 8–16 kHz air synthesis');
{
  let dull = H.filter(RSDSP, H.pink(SR, 5, 0.35, 11), SR, 'lp', 5500, 0.707);
  dull = H.filter(RSDSP, dull, SR, 'lp', 7000, 0.707);
  dull = H.normalize(dull, 0.9);
  const off = H.render(Processor, [dull], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, air: 0, noiseFloor: -70 }))[0];
  const on = H.render(Processor, [dull], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, air: 0.8, noiseFloor: -70 }))[0];
  const hi = band([on], 9000, 13000) - band([off], 9000, 13000);
  H.ok(hi > 8, 'rebuilds 9–13 kHz content on band-limited material', hi.toFixed(1) + ' dB');
  const mid = Math.abs(band([on], 1000, 3000) - band([off], 1000, 3000));
  H.ok(mid < 4, 'does not disturb the midrange while doing so', mid.toFixed(1) + ' dB');
  H.ok(peak(on) <= 1.0001, 'air synthesis respects full scale');
}

H.section('engine · harmonic exciter');
{
  let dull = H.normalize(H.filter(RSDSP, H.pink(SR, 5, 0.35, 12), SR, 'lp', 7000, 0.707), 0.9);
  const off = H.render(Processor, [dull], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, exciter: 0 }))[0];
  const on = H.render(Processor, [dull], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, exciter: 0.9 }))[0];
  const up = band([on], 2600, 5200) - band([off], 2600, 5200);
  H.ok(up > 3, 'adds upper harmonics to dull material', up.toFixed(1) + ' dB');
}

H.section('engine · de-hiss (HF expander)');
{
  const hissOnly = H.noise(SR, 4, 0.006, 21);
  const off = H.render(Processor, [hissOnly], Object.assign({}, H.DEFAULT_PARAMS,
    { power: 1, dehiss: 0, noiseFloor: -44, hissFloor: -46 }))[0];
  const on = H.render(Processor, [hissOnly], Object.assign({}, H.DEFAULT_PARAMS,
    { power: 1, dehiss: 1, noiseFloor: -44, hissFloor: -46 }))[0];
  const cut = band([off], 6000, 12000) - band([on], 6000, 12000);
  H.ok(cut > 12, 'suppresses steady hiss between the notes', cut.toFixed(1) + ' dB');

  // and it must NOT eat the music: loud, continuous programme stays intact
  const music = H.pink(SR, 4, 0.35, 31);
  const mOff = H.render(Processor, [music], Object.assign({}, H.DEFAULT_PARAMS,
    { power: 1, dehiss: 0, noiseFloor: -70, hissFloor: -90 }))[0];
  const mOn = H.render(Processor, [music], Object.assign({}, H.DEFAULT_PARAMS,
    { power: 1, dehiss: 1, noiseFloor: -70, hissFloor: -90 }))[0];
  const loss = band([mOff], 6000, 12000) - band([mOn], 6000, 12000);
  H.ok(loss < 2.5, 'leans out of the way on clean, continuous music', loss.toFixed(1) + ' dB');
}

H.section('engine · de-clicker');
{
  const base = H.normalize(H.filter(RSDSP, H.pink(SR, 4, 0.25, 33), SR, 'lp', 9000, 0.707), 0.55);
  const withPops = H.addCrackle(base, 10, 0.5, 71);
  const dirty = RSDSP.crackleDetect([withPops], SR);
  const clean = RSDSP.crackleDetect([base], SR);
  H.ok(dirty.index > clean.index + 0.3, 'crackle detector sees injected pops',
    clean.index.toFixed(2) + ' → ' + dirty.index.toFixed(2));

  const repaired = H.render(Processor, [withPops], Object.assign({}, H.DEFAULT_PARAMS,
    { power: 1, declick: 0.9 }))[0];
  const after = RSDSP.crackleDetect([repaired], SR);
  H.ok(after.index < dirty.index - 0.12, 'de-clicker lowers the measured crackle index',
    dirty.index.toFixed(2) + ' → ' + after.index.toFixed(2));

  // direct look at the spikes: how many samples stick out, and how far?
  const spikes = (sig) => {
    let rms = 0;
    for (let i = 0; i < sig.length; i++) rms += sig[i] * sig[i];
    rms = Math.sqrt(rms / sig.length);
    const lim = rms * 2.0;
    let count = 0, worst = 0;
    for (let i = 0; i < sig.length; i++) {
      const a = Math.abs(sig[i]);
      if (a > lim) { count++; if (a > worst) worst = a; }
    }
    return { count, worst, rms };
  };
  const before = spikes(withPops), aft = spikes(repaired), ref = spikes(base);
  H.ok(aft.worst < (before.worst + ref.worst) / 2, 'pop spikes are pulled down to near the clean level',
    before.worst.toFixed(3) + ' → ' + aft.worst.toFixed(3) + ' (clean material: ' + ref.worst.toFixed(3) + ')');
  // count samples sticking out above the *clean* material's own peak: a
  // dynamic repair cannot be perfect, but the outliers must be mostly gone
  let lim = 0;
  for (let i = 0; i < base.length; i++) lim = Math.max(lim, Math.abs(base[i]));
  lim *= 1.02;
  const hard = (sig) => { let c = 0; for (let i = 0; i < sig.length; i++) if (Math.abs(sig[i]) > lim) c++; return c; };
  H.ok(hard(repaired) < hard(withPops) * 0.65, 'most pop samples are repaired',
    hard(withPops) + ' → ' + hard(repaired) + ' (clean: ' + hard(base) + ')');
  H.ok(Math.abs(band([repaired], 1000, 3000) - band([withPops], 1000, 3000)) < 5,
    'de-clicker keeps the music body intact');
}

H.section('engine · dynamic de-resonator');
{
  // A room rings: every drum hit excites a resonance that decays over ~60 ms.
  const secs = 4, n = SR * secs;
  const body = new Float32Array(n);
  const ring = new Float32Array(n);
  const rd = Math.exp(-1 / (SR * 0.060));           // 60 ms decay
  let rp = 0, rAmp = 0;
  for (let i = 0; i < n; i++) {
    if (i % Math.round(SR / 5) === 0) { rAmp = 0.35; rp = 0; }
    rAmp *= rd;
    rp += 2 * Math.PI * 3000 / SR;
    ring[i] = Math.sin(rp) * rAmp;
    body[i] = Math.sin(i * 0.02) * 0.06 + H.noise(SR, 0.0001, 0.01, 5)[0] * 0;
  }
  const mixed = H.normalize(H.mix([body, ring]), 0.9);
  const off = H.render(Processor, [mixed], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, reso: 0 }))[0];
  const on = H.render(Processor, [mixed], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, reso: 0.9 }))[0];
  // ring energy must be measured in the time domain: a spectral median across
  // the whole file hides a transient that only rings 30 % of the time
  const ringRms = (sig) => {
    const bq = new RSDSP.Biquad(); bq.setLowpass(SR, 3000, 6);
    let ms = 0;
    for (let i = 0; i < sig.length; i++) { const v = bq.process(sig[i]); ms += v * v; }
    return Math.sqrt(ms / sig.length);
  };
  const cut = 20 * Math.log10(ringRms(off) / ringRms(on));
  H.ok(cut > 1.2, 'tames ringing room resonance', cut.toFixed(1) + ' dB');
  const bodyChange = band([on], 80, 300) - band([off], 80, 300);
  H.ok(Math.abs(bodyChange) < 4, 'leaves the drum body itself alone', bodyChange.toFixed(1) + ' dB');
}

H.section('engine · loudness matching');
{
  const dull = H.normalize(H.filter(RSDSP, H.pink(SR, 6, 0.3, 61), SR, 'lp', 6000, 0.707), 0.9);
  const out = H.render(Processor, [dull], PARAMS('garage', RSDSP.measure([dull], SR), 0.9))[0];
  const diff = 20 * Math.log10(rms(out) / rms(dull));
  H.ok(Math.abs(diff) < 4.7, 'restored version is loudness-matched to the original (±4.7 dB)', diff.toFixed(2) + ' dB');
  H.ok(peak(out) <= 1.0001, 'matched output stays inside full scale');
}

H.section('engine · processing power scaling');
{
  const dull = H.normalize(H.filter(RSDSP, H.pink(SR, 6, 0.3, 62), SR, 'lp', 6000, 0.707), 0.9);
  const m = RSDSP.measure([dull], SR);
  let prev = -Infinity, monotonic = true;
  const levels = [];
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const out = H.render(Processor, [dull], PARAMS('garage', m, p))[0];
    const lvl = band([out], 9000, 13000);
    levels.push(lvl);
    if (lvl < prev - 0.75) monotonic = false;
    prev = lvl;
  }
  H.ok(monotonic, 'the single intensity slider scales the effect smoothly',
    levels.map((l) => l.toFixed(1)).join(' → '));
  H.ok(levels[4] - levels[0] > 6, 'slider range is wide enough to matter',
    (levels[4] - levels[0]).toFixed(1) + ' dB');
}

H.section('engine · stereo integrity');
{
  const l = H.normalize(H.pink(SR, 4, 0.3, 81), 0.9);
  const r = H.normalize(H.mix([H.pink(SR, 4, 0.25, 82), H.tone(1000, SR, 4, 0.05)]), 0.85);
  const m = RSDSP.measure([l, r], SR);
  const out = H.render(Processor, [l, r], PARAMS('vinyl', m, 0.8));
  H.ok(out.length === 2 && out[0].length === l.length, 'processes stereo without re-ordering channels');
  const cIn = RSDSP.stereoCorrelation([l, r]);
  const cOut = RSDSP.stereoCorrelation(out);
  H.ok(Math.abs(cIn - cOut) < 0.25, 'stereo image is preserved', cIn.toFixed(2) + ' → ' + cOut.toFixed(2));
  H.ok(!hasBad(out[0]) && !hasBad(out[1]), 'both channels stay finite');
}

/* ==================================================== analysis / diagnosis */

H.section('analysis · measurement pipeline');
{
  const m = RSDSP.measure([SIM.vinyl], SR);
  H.ok(isFinite(m.noiseFloorDb) && m.noiseFloorDb < -25 && m.noiseFloorDb > -120,
    'noise floor is measured in a plausible range', m.noiseFloorDb.toFixed(1) + ' dBFS');
  H.ok(m.hfCutoff > 2000 && m.hfCutoff <= 24000, 'HF cut-off is measured', Math.round(m.hfCutoff) + ' Hz');
  H.ok(m.score >= 0 && m.score <= 100, 'quality score is 0–100', String(m.score));
  H.ok(m.snrDb > 0 && m.snrDb < 90, 'signal-to-noise ratio is plausible', m.snrDb.toFixed(1) + ' dB');
}

H.section('analysis · auto-diagnosis picks the right preset');
{
  const expect = {
    garage: 'garage', cassette: 'cassette', vinyl: 'vinyl', lowbitrate: 'lowbitrate', clean: 'general',
  };
  for (const key of Object.keys(expect)) {
    const m = RSDSP.measure([SIM[key]], SR);
    const d = RP.diagnose(m);
    H.ok(d.id === expect[key], `${key.padEnd(10)} → ${String(d.id).padEnd(10)} (issues: ${d.issues.join(', ')})`);
  }
}

H.section('analysis · adaptive auto-tuning');
{
  for (const key of ['garage', 'cassette', 'vinyl', 'lowbitrate', 'clean']) {
    const m = RSDSP.measure([SIM[key]], SR);
    const p = RP.buildParams('auto', m, 0.7);
    const finite = Object.keys(p).every((k) => isFinite(p[k]));
    const inRange = p.band0 >= -15 && p.band0 <= 15 && p.sub <= 1 && p.air <= 1 && p.dehiss <= 1;
    H.ok(finite && inRange, `auto preset produces valid parameters for ${key}`);
  }
}

/* =========================================================== format helpers */

H.section('codecs · WAV writer / reader round-trip');
{
  const sig = H.mix([H.tone(440, SR, 1, 0.5), H.tone(1300, SR, 1, 0.2)]);
  for (const bits of [16, 24, 32]) {
    const buf = RSDSP.encodeWav([sig], SR, bits);
    const dec = RSDSP.decodeWav(buf);
    let maxErr = 0;
    for (let i = 0; i < sig.length; i++) maxErr = Math.max(maxErr, Math.abs(dec.channels[0][i] - sig[i]));
    const tol = bits === 16 ? 1 / 32000 : bits === 24 ? 1 / 8000000 : 1e-6;
    H.ok(dec.sr === SR && dec.channels.length === 1 && maxErr < tol,
      `${bits}-bit WAV round-trips (max error ${maxErr.toExponential(1)})`);
  }
  const stereo = RSDSP.encodeWav([sig, H.mul(sig, 0.5)], SR, 16);
  const dec2 = RSDSP.decodeWav(stereo);
  H.ok(dec2.channels.length === 2, 'stereo WAV keeps both channels');
}

H.section('codecs · source sample-rate detection');
{
  const wav44 = RSDSP.encodeWav([H.tone(440, SR, 0.1, 0.1)], 44100, 16);
  H.ok(RSDSP.detectSampleRate(wav44) === 44100, 'WAV header → 44100 Hz');

  // FLAC STREAMINFO
  const flac = new Uint8Array(64);
  flac.set([0x66, 0x4c, 0x61, 0x43], 0);            // "fLaC"
  flac[4] = 0;                                       // STREAMINFO, not last
  flac[5] = 0; flac[6] = 0; flac[7] = 34;            // block size
  const srBits = 96000;
  flac[4 + 4 + 10] = (srBits >> 12) & 0xff;
  flac[4 + 4 + 11] = (srBits >> 4) & 0xff;
  flac[4 + 4 + 12] = (srBits & 0x0f) << 4;
  H.ok(RSDSP.detectSampleRate(flac.buffer) === 96000, 'FLAC STREAMINFO → 96000 Hz');

  // OggS + vorbis identification header
  const ogg = new Uint8Array(64);
  ogg.set([0x4f, 0x67, 0x67, 0x53], 0);              // "OggS"
  ogg.set([0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], 28); // "vorbis"
  const dv = new DataView(ogg.buffer);
  dv.setUint32(28 + 12, 48000, true);
  H.ok(RSDSP.detectSampleRate(ogg.buffer) === 48000, 'Ogg Vorbis → 48000 Hz');

  // MP4 ftyp + mdhd
  const mp4 = new Uint8Array(80);
  mp4.set([0x66, 0x74, 0x79, 0x70], 4);              // "ftyp"
  mp4.set([0x6d, 0x64, 0x68, 0x64], 32);             // "mdhd"
  new DataView(mp4.buffer).setUint32(32 + 8 + 8, 44100, false);
  H.ok(RSDSP.detectSampleRate(mp4.buffer) === 44100, 'MP4/M4A mdhd → 44100 Hz');
}

H.section('codecs · JSZip + lamejs availability (vendored fallbacks)');
{
  const zipPath = path.join(H.ROOT, 'assets', 'vendor', 'jszip.min.js');
  const lamePath = path.join(H.ROOT, 'assets', 'vendor', 'lame.min.js');
  H.ok(fs.existsSync(zipPath), 'assets/vendor/jszip.min.js is present');
  H.ok(fs.existsSync(lamePath), 'assets/vendor/lame.min.js is present');
  if (fs.existsSync(lamePath)) {
    const sandbox = { window: {}, self: {}, globalThis: {}, console, Math, Date, performance: { now: () => Date.now() } };
    sandbox.window = sandbox; sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(lamePath, 'utf8'), sandbox, { filename: 'lame.min.js' });
    const lame = sandbox.lamejs || (sandbox.window && sandbox.window.lamejs);
    H.ok(!!(lame && lame.Mp3Encoder), 'lamejs exposes Mp3Encoder');
    if (lame && lame.Mp3Encoder) {
      const enc = new lame.Mp3Encoder(1, 44100, 192);
      const n = 44100;
      const buf = new Int16Array(n);
      for (let i = 0; i < n; i++) buf[i] = Math.round(Math.sin(i * 0.05) * 12000);
      const out = [];
      for (let i = 0; i < n; i += 1152) {
        const c = enc.encodeBuffer(buf.subarray(i, i + 1152));
        if (c.length) out.push(Buffer.from(c));
      }
      const fin = enc.flush();
      if (fin.length) out.push(Buffer.from(fin));
      const mp3 = Buffer.concat(out);
      H.ok(mp3.length > 1000 && (mp3[0] !== 0xff || (mp3[1] & 0xe0) === 0xe0),
        `lamejs produces a valid MP3 stream (${mp3.length} bytes)`);
    }
  }
}

/* ------------------------------------------------------------------- done */

const okAll = H.summarize();
process.exit(okAll ? 0 : 1);
