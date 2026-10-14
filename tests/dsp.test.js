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
  // The stage tests run with the automatic level match switched off
  // (autoLevel: 0): they measure a single module, and the matcher would take
  // back the part of that module's change which falls inside its 300 Hz–3.4 kHz
  // loudness band — hiding the very effect under test. The matcher itself is
  // covered by the "loudness matching" and "processing power scaling" sections.
  const off = H.render(Processor, [dull], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, air: 0, noiseFloor: -70, autoLevel: 0 }))[0];
  const on = H.render(Processor, [dull], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, air: 0.8, noiseFloor: -70, autoLevel: 0 }))[0];
  const hi = band([on], 9000, 13000) - band([off], 9000, 13000);
  H.ok(hi > 8, 'rebuilds 9–13 kHz content on band-limited material', hi.toFixed(1) + ' dB');
  const mid = Math.abs(band([on], 1000, 3000) - band([off], 1000, 3000));
  H.ok(mid < 4, 'does not disturb the midrange while doing so', mid.toFixed(1) + ' dB');
  H.ok(peak(on) <= 1.0001, 'air synthesis respects full scale');
}

H.section('engine · harmonic exciter');
{
  let dull = H.normalize(H.filter(RSDSP, H.pink(SR, 5, 0.35, 12), SR, 'lp', 7000, 0.707), 0.9);
  const off = H.render(Processor, [dull], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, exciter: 0, autoLevel: 0 }))[0];
  const on = H.render(Processor, [dull], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, exciter: 0.9, autoLevel: 0 }))[0];
  const up = band([on], 2600, 5200) - band([off], 2600, 5200);
  H.ok(up > 3, 'adds upper harmonics to dull material', up.toFixed(1) + ' dB');
}

H.section('engine · de-hiss (HF expander)');
{
  const hissOnly = H.noise(SR, 4, 0.006, 21);
  const off = H.render(Processor, [hissOnly], Object.assign({}, H.DEFAULT_PARAMS,
    { power: 1, dehiss: 0, noiseFloor: -44, hissFloor: -46, autoLevel: 0 }))[0];
  const on = H.render(Processor, [hissOnly], Object.assign({}, H.DEFAULT_PARAMS,
    { power: 1, dehiss: 1, noiseFloor: -44, hissFloor: -46, autoLevel: 0 }))[0];
  const cut = band([off], 6000, 12000) - band([on], 6000, 12000);
  H.ok(cut > 12, 'suppresses steady hiss between the notes', cut.toFixed(1) + ' dB');

  // and it must NOT eat the music: loud, continuous programme stays intact
  const music = H.pink(SR, 4, 0.35, 31);
  const mOff = H.render(Processor, [music], Object.assign({}, H.DEFAULT_PARAMS,
    { power: 1, dehiss: 0, noiseFloor: -70, hissFloor: -90, autoLevel: 0 }))[0];
  const mOn = H.render(Processor, [music], Object.assign({}, H.DEFAULT_PARAMS,
    { power: 1, dehiss: 1, noiseFloor: -70, hissFloor: -90, autoLevel: 0 }))[0];
  const loss = band([mOff], 6000, 12000) - band([mOn], 6000, 12000);
  H.ok(loss < 2.5, 'leans out of the way on clean, continuous music', loss.toFixed(1) + ' dB');
}

H.section('engine · de-hiss, dosed by the measurement');
{
  // The whole point of a hiss repair is *where* it acts: the floor between the
  // notes has to come down, and the music has to stay where it was. A stage that
  // moves only the average is either doing nothing or damaging everything.
  const sim = H.garageSim(RSDSP, SR, 14);
  const metrics = RSDSP.measure([sim], SR);
  const law = RP.buildParams('auto', metrics, 1);
  const floor = (x) => {
    const n = 2048, buf = new Float64Array(n);
    const f1 = new RSDSP.Biquad(), f2 = new RSDSP.Biquad();
    f1.setHighpass(SR, 4000, 0.707); f2.setHighpass(SR, 4000, 0.707);
    let sum = 0, i = 0;
    const vals = [];
    for (let k = 0; k < x.length; k++) {
      const v = f2.process(f1.process(x[k]));
      const q = v * v;
      sum += q - buf[i]; buf[i] = q; i++; if (i >= n) i = 0;
      if (k % 512 === 0) vals.push(Math.sqrt(Math.max(sum, 0) / n));
    }
    vals.sort((a, b) => a - b);
    const q = (p) => 20 * Math.log10(Math.max(vals[Math.floor(vals.length * p)], 1e-12));
    return { p05: q(0.05), p50: q(0.50) };
  };
  H.ok(metrics.hissTiltStepDb > 3 && law.hissMax > 0.5,
    'the analyser measures how much of the top end is noise',
    metrics.hissTiltStepDb.toFixed(1) + ' dB step · hiss ' + metrics.hissAmount.toFixed(2)
    + ' → dehiss ' + law.dehiss.toFixed(2) + ', max ' + law.hissMax.toFixed(1) + ' dB');
  const dry = floor(sim);
  const off = floor(H.render(Processor, [sim], Object.assign({}, law, { dehiss: 0 }))[0]);
  const on = floor(H.render(Processor, [sim], law)[0]);
  H.ok(on.p05 < off.p05 - 3, 'the room tone between the notes comes down',
    off.p05.toFixed(1) + ' → ' + on.p05.toFixed(1) + ' dB HF floor (' + (off.p05 - on.p05).toFixed(1) + ' dB)');
  H.ok(Math.abs(on.p50 - off.p50) < 0.5, '…while the music itself does not move',
    off.p50.toFixed(1) + ' → ' + on.p50.toFixed(1) + ' dB');
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

H.section('engine · the de-hisser does not undo the de-clicker');
{
  // A worn record with hiss *and* crackle: both repairs are asked for at once,
  // and the de-clicker runs first because a pop is the most localised damage
  // there is (that is also the order the RX module guides prescribe). It has to:
  // a pop is broadband, so the de-hisser's top-end gate eats part of it and
  // leaves a remainder too small for the detector to be sure about — measured
  // here, the de-hisser alone pulled each pop's sample down to 18 % of its
  // height, and the 15 dB it left behind were invisible to the de-clicker
  // (f/s ≈ 1.2, under its 1.25 threshold). With the de-hisser in front, the same
  // fixture came out with 6 pops above the clean copy; behind, with 0.
  //
  // The de-hisser's own gate also has to survive the pops it now sees *after*
  // the repair: it closes slowly (250 ms — hiss is stationary, nothing about it
  // is fast) and opens fast (8 ms — a musical transient must not be dulled),
  // and its "nothing to attenuate" branch is a continuous crossfade instead of a
  // step at the last 0.1 % of its range.
  const env = H.songEnvelope(SR, 8, 0.05);          // quiet passages for the hiss to sit in
  let bed = H.filter(RSDSP, H.mul(H.pink(SR, 8, 0.40, 31), 1), SR, 'lp', 7000, 0.60);
  bed = H.filter(RSDSP, bed, SR, 'lp', 5000, 0.55);
  for (let i = 0; i < bed.length; i++) bed[i] *= env[i];
  const clean = H.normalize(bed, 0.74);
  const hissy = H.normalize(H.mix([clean, H.mul(H.noise(SR, 8, 0.020, 5), 1)]), 0.74);
  const pops = H.addCrackle(hissy, 9, 0.85, 8);
  const m = RSDSP.measure([pops], SR);
  const law = RP.buildParams('auto', m, 1);
  const crest = (sig) => RSDSP.crackleDetect([sig], SR);
  const dry = crest(pops);
  const chain = crest(H.render(Processor, [pops], law)[0]);
  const clickOnly = crest(H.render(Processor, [pops], Object.assign({}, law, { dehiss: 0 }))[0]);
  H.ok(law.dehiss > 0.05 && law.declick > 0.05,
    'the fixture asks for both repairs at once', 'dehiss ' + law.dehiss.toFixed(2) + ', declick ' + law.declick.toFixed(2));
  H.ok(chain.crestP98Db < dry.crestP98Db - 8,
    'the chain takes the pops out of the top end (crest p98 of the 8.5 kHz+ band)',
    dry.crestP98Db.toFixed(1) + ' → ' + chain.crestP98Db.toFixed(1) + ' dB');
  H.ok(chain.crestP98Db < clickOnly.crestP98Db + 1.5,
    '…and the de-hisser leaves the de-clicker the room to do it (it used to add 10 dB of its own transients here)',
    'chain ' + chain.crestP98Db.toFixed(1) + ' dB, de-clicker alone ' + clickOnly.crestP98Db.toFixed(1) + ' dB, dry ' + dry.crestP98Db.toFixed(1) + ' dB');
  H.ok(chain.index < dry.index - 0.5, 'which the crackle index agrees with',
    dry.index.toFixed(2) + ' → ' + chain.index.toFixed(2));
}

H.section('engine · de-clicker on a lossy rip');
{
  // The case from the beta report: a vinyl rip that arrived as a 128 kbit/s
  // MP3. An encoder does not keep the one to three samples a pop consists of —
  // it smears them across the window it codes in, so most of the click's energy
  // ends up *in front of* the spike a detector can fire on. This fixture
  // simulates exactly that (each pop spread over ±5 ms with a raised cosine,
  // the spike itself kept at height) so the test needs no encoder, and it
  // asserts what a listener notices: the pops end up *below* the music, a clean
  // file is left alone, and a drum kit does not pay for any of it.
  const MIN = () => Object.assign({}, H.DEFAULT_PARAMS, { power: 1, autoLevel: 0 });
  const rip = (() => {
    const seconds = 12, perSecond = 9, amp = 0.85;
    // a worn record: the music's own top end sits well under the pops, so a
    // click stands out in the band it lives in (which is the band the app's
    // crackle reading looks at too)
    let bed = H.filter(RSDSP, H.mul(H.pink(SR, seconds, 0.40, 31), 1), SR, 'lp', 7000, 0.60);
    bed = H.filter(RSDSP, bed, SR, 'lp', 5000, 0.55);
    const clean = H.normalize(bed, 0.74);
    // the measured shape of a codec's damage: the pop's energy lands within
    // −40…+40 samples of the spike (96 % of it), with the spike itself intact
    const half = Math.round(0.0009 * SR);
    const kernel = new Float64Array(2 * half + 1);
    for (let i = 0; i <= half; i++) {
      const w = 0.5 * (1 + Math.cos(Math.PI * i / half));
      kernel[half + i] = w; kernel[half - i] = w;
    }
    let ksum = 0; for (let i = 0; i < kernel.length; i++) ksum += kernel[i] * kernel[i];
    for (let i = 0; i < kernel.length; i++) kernel[i] /= Math.sqrt(ksum);
    const dirty = Float32Array.from(clean);
    const rand = H.rng(8);
    const positions = [];
    for (let n = 0; n < perSecond * seconds; n++) {
      const idx = Math.floor(rand() * (dirty.length - 2 * half - 4)) + half;
      const sign = rand() < 0.5 ? -1 : 1;
      const a = amp * (0.4 + rand() * 1.6) * sign;
      for (let k = -half; k <= half; k++) dirty[idx + k] += a * kernel[k + half] * 0.55;
      dirty[idx] += a * 0.85;                       // the spike survives the codec
      dirty[idx + 1] += a * 0.45;
      positions.push(idx);
    }
    return { clean, dirty, positions };
  })();

  const DOSE = 0.715;                               // the dose the automatic mode picks on a crackly rip
  const before = RSDSP.crackleDetect([rip.dirty], SR);
  const floor = RSDSP.crackleDetect([rip.clean], SR);
  H.ok(before.index > floor.index + 0.5, 'the lossy fixture reads as crackly, the clean one does not',
    floor.index.toFixed(2) + ' → ' + before.index.toFixed(2));

  const off = H.renderEx(Processor, [rip.dirty], MIN());
  const on = H.renderEx(Processor, [rip.dirty], Object.assign({}, MIN(), { declick: DOSE }));
  const cleanOff = H.renderEx(Processor, [rip.clean], MIN());
  const cleanOn = H.renderEx(Processor, [rip.clean], Object.assign({}, MIN(), { declick: DOSE }));
  H.ok(on.latency === 17 && off.latency === 0,
    'the stage declares the half-millisecond look-ahead it needs (17 samples at 48 kHz)',
    'engaged ' + on.latency + ', bypassed ' + off.latency);

  const after = RSDSP.crackleDetect([on.out[0]], SR);
  H.ok(after.index < before.index * 0.55, 'the smeared pops come down, not just the spike',
    before.index.toFixed(2) + ' → ' + after.index.toFixed(2) + ' (' + before.spikes + ' → ' + after.spikes + ' spike frames)');

  // …and does what is left still stand out? A click lives *above* the music, so
  // measure each pop's residual in the band a click occupies (4–12 kHz) against
  // the level of the same band in the file without pops — a broadband window
  // would mostly measure the low-frequency fill the repair puts where the pop
  // was, which is not what a listener hears as crackle.
  const hfBand = (sig) => {
    const [b0, b1, b2, a1, a2] = RSDSP.biquadHP(SR, 4000, 0.707);
    const stage = new RSDSP.Biquad(); stage.setLowpass(SR, 12000, 0.707);
    const out = new Float32Array(sig.length);
    let z1 = 0, z2 = 0;
    for (let i = 0; i < sig.length; i++) {
      const raw = sig[i];
      const x = Math.fround(b0 * raw + z1);
      z1 = b1 * raw - a1 * x + z2;
      z2 = b2 * raw - a2 * x;
      out[i] = stage.process(x);
    }
    return out;
  };
  const popLevels = (out, latency, reference) => {
    const residual = new Float32Array(out.length);
    for (let i = 0; i + latency < out.length; i++) residual[i] = out[i + latency] - reference[i];
    const rHF = hfBand(residual), cHF = hfBand(reference);
    const W = Math.round(0.012 * SR);
    const levels = rip.positions.map((p) => {
      let e = 0, music = 0, n = 0;
      for (let j = Math.max(0, p - W); j < Math.min(rHF.length, p + W); j++) {
        e += rHF[j] * rHF[j]; music += cHF[j] * cHF[j]; n++;
      }
      return 10 * Math.log10((e / n) / (music / n + 1e-20) + 1e-20);
    });
    levels.sort((a, b) => b - a);
    const nth = Math.max(1, Math.round(levels.length * 0.1));
    return levels.slice(0, nth).reduce((acc, v) => acc + v, 0) / nth;
  };
  const cleanOut = cleanOff.out[0];          // the same file without the pops
  const dryPops = popLevels(off.out[0], off.latency, cleanOut);
  const worstPop = popLevels(on.out[0], on.latency, cleanOut);
  console.log('    loudest tenth of the pops, relative to the music around them: '
    + dryPops.toFixed(1) + ' dB as uploaded → ' + worstPop.toFixed(1) + ' dB repaired');
  H.ok(worstPop < 0, 'even the loudest tenth of the pops ends up below the music',
    worstPop.toFixed(1) + ' dB (was ' + dryPops.toFixed(1) + ' dB)');
  H.ok(worstPop < dryPops - 7, 'and that is a real change, not a shift of the reference',
    dryPops.toFixed(1) + ' → ' + worstPop.toFixed(1) + ' dB');

  const rms = (sig) => { let a = 0; for (let i = 0; i < sig.length; i++) a += sig[i] * sig[i]; return Math.sqrt(a / sig.length); };
  const cleanMove = 20 * Math.log10(rms(cleanOn.out[0]) / rms(cleanOff.out[0]));
  H.ok(cleanMove > -0.1, 'a file without pops keeps its level', cleanMove.toFixed(3) + ' dB');

  // The de-clicker's window is wide, so the risk is a drum kit: a snare raises
  // the same crest statistic a pop does. Measured over the 2 ms after each hit.
  const kit = (() => {
    const seconds = 12, out = new Float32Array(SR * seconds), hits = [];
    const rand = H.rng(4242);
    const beat = 60 / 96;
    for (let b = 0; b * beat < seconds; b++) {
      const t = b * beat;
      if (b % 2 === 0) {
        const s = Math.round(t * SR);
        for (let i = 0; i < Math.round(0.18 * SR); i++) {
          const x = i / SR;
          out[s + i] += Math.sin(2 * Math.PI * (55 + 40 * Math.exp(-x * 40)) * i / SR) * Math.exp(-x * 26) * 0.55;
        }
      } else {
        const s = Math.round(t * SR);
        for (let i = 0; i < Math.round(0.25 * SR); i++) {
          const x = i / SR, env = Math.min(1, x / 0.0015) * Math.exp(-x * 22);
          out[s + i] += (((rand() * 2) - 1) * 0.42 + Math.sin(2 * Math.PI * 190 * i / SR) * 0.22) * env;
        }
        hits.push(s);
      }
      const h = Math.round((t + beat / 2) * SR);
      for (let i = 0; i < Math.round(0.045 * SR); i++) out[h + i] += ((rand() * 2) - 1) * Math.exp(-(i / SR) * 60) * 0.10;
    }
    let bed = H.mul(H.pink(SR, seconds, 0.28, 99), 1);
    const env = H.songEnvelope(SR, seconds, 0.05);
    for (let i = 0; i < bed.length; i++) bed[i] *= env[i];
    bed = H.filter(RSDSP, bed, SR, 'lp', 7000, 0.707);
    return { sig: H.normalize(H.mix([out, bed]), 0.85), hits };
  })();
  const kitOff = H.renderEx(Processor, [kit.sig], MIN());
  const kitOn = H.renderEx(Processor, [kit.sig], Object.assign({}, MIN(), { declick: DOSE }));
  let worstSnare = 0, touched = 0;
  for (const h of kit.hits) {
    let e = 0, n = 0, peak = 0;
    for (let k = 0; k < Math.round(0.002 * SR); k++) {
      const j = h + k;
      if (j + kitOn.latency >= kitOn.out[0].length) break;
      const d = kitOn.out[0][j + kitOn.latency] - kitOff.out[0][j];
      e += d * d; n++;
      const a = Math.abs(kitOff.out[0][j]); if (a > peak) peak = a;
    }
    const db = 20 * Math.log10(Math.sqrt(e / n) / (peak + 1e-12) + 1e-12);
    if (db < worstSnare || worstSnare === 0) worstSnare = db;
  }
  for (let i = 0; i + kitOn.latency < kitOn.out[0].length; i++) {
    if (Math.abs(kitOn.out[0][i + kitOn.latency] - kitOff.out[0][i]) > 0.002) touched++;
  }
  H.ok(worstSnare < -55, "a snare's attack is left alone (worst hit, 2 ms window)",
    worstSnare.toFixed(1) + ' dB below the hit');
  /* The threshold here is 0.002 absolute, which is -50 dB relative to a master
   * at 0.6 and is the same one the exposure question is asked with below. Its
   * meaning depends on the dose, and that is measured rather than assumed (on a
   * clean wide-band master, against the same render with the stage off):
   *
   *   dose 0.08 (what a healthy card asks)   0.06 % of samples · rms Δ -51 dB · HF 6-12 kHz -0.00 dB
   *   dose 0.30                              0.09 %            · rms Δ -32 dB · HF -0.00 dB
   *   dose 0.60 (the ceiling)                1.65 %            · rms Δ -23 dB · HF -0.04 dB
   *
   * i.e. the stage is a no-op on clean material until it is asked for a dose
   * only a worn record asks for, and even at the ceiling the HF bands move by
   * 0.04 dB. A quoted "touched" percentage is only meaningful with its
   * threshold and its dose beside it. */
  H.ok(touched < kit.sig.length * 0.08, 'and only a small part of the kit is touched at all',
    (100 * touched / kit.sig.length).toFixed(2) + ' % of samples');
}

H.section('engine · de-clipper on a clipped master');
{
  // Half of what the loudness war left behind is clipping — a flat top where the
  // waveform used to have a peak. The de-clipper estimates the peak from the
  // samples on either side of the run and fills the arc back in. The proof is a
  // fixture whose truth is known: a 997 Hz tone, clipped, so the reconstruction
  // can be compared sample by sample against the sine it came from.
  //
  // Two things make or break it in the chain, and both are asserted here:
  //   · the repair has to *survive* the rest of the chain — a reconstruction
  //     that reaches above the file's own peak needs the level matcher's
  //     headroom guard to give the level back, otherwise the soft-clip guard
  //     flattens exactly the peaks the de-clipper just restored;
  //   · the de-clicker downstream must not treat a plateau as a click. It did:
  //     a clipped plateau is a broadband discontinuity, the detector fires at
  //     its edge, and a window planned there reaches back into the plateau and
  //     pulls it down to a third of its level. Measured, that cost more than the
  //     de-clipper gained, so the plateau is now vetoed per sample.
  const CLIP = 0.99, SEC = 6, AMP = 1.25, FREQ = 997;
  const n = SR * SEC, truth = new Float32Array(n);
  for (let i = 0; i < n; i++) truth[i] = AMP * Math.sin(2 * Math.PI * FREQ * i / SR);
  const clipped = Float32Array.from(truth);
  for (let i = 0; i < n; i++) if (clipped[i] > CLIP) clipped[i] = CLIP; else if (clipped[i] < -CLIP) clipped[i] = -CLIP;
  // the tone is clipped on both halves of every period: the flat tops are long
  // and perfectly regular, which is the friendliest case for a reconstruction
  // and the easiest one to measure
  const SOLO = () => Object.assign({}, H.DEFAULT_PARAMS, { power: 1, autoLevel: 1 });
  const off = H.renderEx(Processor, [clipped], Object.assign({}, SOLO(), { declip: 0, declick: 0 }));
  const on = H.renderEx(Processor, [clipped], Object.assign({}, SOLO(), { declip: 0.72, declick: 0 }));
  H.ok(on.latency === 271 && off.latency === 0,
    'the de-clipper declares its 271 samples of look-ahead (5.6 ms, the longest run it will repair), and none when idle',
    'engaged ' + on.latency + ', bypassed ' + off.latency);

  // find one flat top in the middle of the file and look at what came out —
  // a *contiguous* run of one sign, which is what a clipped peak looks like
  let s0 = -1, len = 0;
  for (let i = SR; i < n - 1; i++) {
    const flatHere = Math.abs(clipped[i]) >= CLIP - 1e-6;
    const flatNext = Math.abs(clipped[i + 1]) >= CLIP - 1e-6 && (clipped[i + 1] > 0) === (clipped[i] > 0);
    if (flatHere && flatNext) { if (s0 < 0) s0 = i; len = i - s0 + 2; }
    else if (flatHere && s0 >= 0) { break; }
  }
  H.ok(s0 > 0 && len >= 5 && len <= 20, 'the fixture really has flat tops to repair',
    'run at ' + s0 + ' of ' + len + ' samples');
  const win = (o, lat) => {
    let lo = 9, hi = -9;
    for (let i = s0; i < s0 + len; i++) { const v = o.out[0][i + lat]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return { lo, hi };
  };
  const flat = win(off, 0), arc = win(on, on.latency);
  H.ok(flat.hi - flat.lo < 0.01, 'without the stage the flat top is exactly what it says on the tin',
    (1000 * (flat.hi - flat.lo)).toFixed(1) + ' ‰ of range');
  H.ok(arc.hi - arc.lo > 0.05, 'with it the plateau carries an arc again, not a rail',
    'range ' + (arc.hi - arc.lo).toFixed(4) + ' (was ' + (flat.hi - flat.lo).toFixed(4) + ')');
  H.ok(arc.hi <= 0.9995, 'and still fits under full scale — the headroom comes from the level matcher, not from clipping the repair',
    'peak ' + arc.hi.toFixed(4));

  // …and it is the *right* arc. The comparison is scale-free on purpose: the
  // guard legitimately turns a restored file down (that is the price of getting
  // the peaks back), so dividing a global scale out is the only way to ask
  // whether the *shape* is right. Against the truth the difference is 10 dB:
  // without the stage the damaged samples are a rail at 0.99, with it they
  // follow the sine to −34 dB.
  const shapeErr = (o) => {
    const lat = o.latency;
    let se = 0, ss = 0, sr2 = 0;
    for (const i of damaged) { if (i + lat >= n) continue; const e = o.out[0][i + lat], r = truth[i]; se += e * e; ss += e * r; sr2 += r * r; }
    const a = ss / se;
    let num = 0;
    for (const i of damaged) { if (i + lat >= n) continue; const e = a * o.out[0][i + lat] - truth[i]; num += e * e; }
    return 10 * Math.log10(num / sr2 + 1e-30);
  };
  const damaged = [];
  for (let i = SR; i < n; i++) if (Math.abs(clipped[i]) >= CLIP - 1e-6) damaged.push(i);
  const errOff = shapeErr(off), errOn = shapeErr(on);
  H.ok(errOn < errOff - 8 && errOn < -30,
    'and it is the right arc: the damaged samples follow the sine to within a per cent',
    'best-fit error over the flat tops ' + errOff.toFixed(1) + ' → ' + errOn.toFixed(1) + ' dB');

  // …and the reconstruction has to survive the *guard* too, which is the one
  // stage that can undo the whole repair: its knee starts 0.55 dB below full
  // scale, i.e. *below* the plateau of a clipped master, so a guard that does
  // not know how far the de-clipper reconstructed flattens the arc straight
  // back into a flat top. In the automatic mode the level matcher's headroom
  // duck hides most of that (the duck moves the arcs below the knee, at the
  // price of a file that is 1.7 dB quieter); with the matcher off it is the
  // whole repair. Measured with the knee fixed at the old value: −16.2 dB of
  // error in the plateau, i.e. barely better than not repairing at all; with
  // the knee moving with `declip.head` (what the stage has actually
  // reconstructed): −29.1 dB.
  const manual = H.renderEx(Processor, [clipped], Object.assign({}, SOLO(), { declip: 0.72, declick: 0, autoLevel: 0 }));
  const errManual = shapeErr(manual);
  H.ok(errManual < errOff - 8,
    'and the output guard does not undo it when the level matcher is off',
    'best-fit error over the flat tops ' + errOff.toFixed(1) + ' → ' + errManual.toFixed(1) + ' dB');
  H.ok(errManual < errOn + 1.5, 'the repair is the same repair in either mode',
    'auto level on ' + errOn.toFixed(1) + ' dB, off ' + errManual.toFixed(1) + ' dB');

  // the third harmonic is what a listener hears as the clipping buzz — the odd
  // symmetry of a flat top, and the number that has to move
  const h3 = (sig, lat) => {
    let sg = 0, s3 = 0;
    for (let i = SR; i < SR * 3; i++) {
      const w = 2 * Math.PI * FREQ * i / SR;
      sg += sig[i + lat] * Math.sin(w);
      s3 += sig[i + lat] * Math.sin(3 * w);
    }
    return 20 * Math.log10(Math.abs(s3 / sg) + 1e-12);
  };
  H.ok(h3(on.out[0], on.latency) < h3(off.out[0], 0) - 8,
    'the clipping buzz (third harmonic) drops with it',
    h3(off.out[0], 0).toFixed(1) + ' → ' + h3(on.out[0], on.latency).toFixed(1) + ' dB below the fundamental');

  // …and the *detector* that decides whether a file is clipped has to agree
  // with the ear, or the app calls its own repaired export clipped. Both halves
  // of its pair move: the share of samples in flat runs at the top drops by two
  // orders of magnitude, and the peak the run length implies is missing drops
  // from 2 dB to a tenth of one — which is what the evidence is made of. (The
  // share alone proves nothing: the smooth top of a *restored* arc reads as
  // 2–3-sample runs too, which is why the pair and not the share is quoted.)
  const statOf = (o, lat) => { const st = RSDSP.flatTopStep([o.out[0].slice(lat)], SR); return st.value(); };
  const sOff = statOf(off, 0), sOn = statOf(on, on.latency);
  H.ok(sOn.flatRatio < sOff.flatRatio * 0.02 && sOn.overshootDb < 0.2 && sOn.evidence < 0.02,
    'and the diagnosis reads it as repaired: flat share and implied missing peak both collapse',
    'flat ' + (100 * sOff.flatRatio).toFixed(2) + ' → ' + (100 * sOn.flatRatio).toFixed(2) + ' %, implied '
    + sOff.overshootDb.toFixed(2) + ' → ' + sOn.overshootDb.toFixed(2) + ' dB, evidence '
    + sOff.evidence.toFixed(2) + ' → ' + sOn.evidence.toFixed(2));

  // the de-clicker must leave the repaired arc alone — and, more importantly,
  // must leave a plateau alone when the de-clipper is *off*, which is the
  // regression this section exists for
  const both = H.renderEx(Processor, [clipped], Object.assign({}, SOLO(), { declip: 0.72, declick: 0.85 }));
  const clickOnly = H.renderEx(Processor, [clipped], Object.assign({}, SOLO(), { declip: 0, declick: 0.85 }));
  const flatClick = win(clickOnly, clickOnly.latency);
  H.ok(flatClick.hi - flatClick.lo < 0.01 && flatClick.lo > CLIP - 0.02,
    'the de-clicker does not repair a clipped plateau as if it were a click',
    'range ' + (flatClick.hi - flatClick.lo).toFixed(4) + ' at ' + flatClick.lo.toFixed(3));
  const arcBoth = win(both, both.latency);
  H.ok(arcBoth.hi - arcBoth.lo > 0.05 && arcBoth.lo > 0.6,
    'and leaves the de-clipper\'s repair standing when both stages run',
    'range ' + (arcBoth.hi - arcBoth.lo).toFixed(4) + ' at ' + arcBoth.lo.toFixed(3));
  H.ok(both.latency === 288, 'the two repair stages add up to 288 samples of reported latency',
    String(both.latency));
}

H.section('engine · de-clipper stays out of the way');
{
  // The other half of the job: material that was never clipped must not be
  // touched. A de-clipper that finds a peak where there is none is worse than
  // no de-clipper at all — it would round off every legitimate transient.
  const SOLO = (extra) => Object.assign({}, H.DEFAULT_PARAMS, { power: 1, autoLevel: 1 }, extra);
  const flatOf = (sig) => { const st = RSDSP.flatTopStep([sig], SR); st.step.slice(0, st.step.units); return st.value(); };
  const loud = H.normalize(H.pink(SR, 6, 0.45, 11), 0.995);            // loud, but nothing reaches the rail
  const vinyl = H.addCrackle(H.normalize(H.filter(RSDSP, H.pink(SR, 6, 0.40, 31), SR, 'lp', 9000, 0.55), 0.9), 7, 0.85, 5);
  const tape = H.cassetteSim(RSDSP, SR, 6);
  for (const [tag, sig] of [['a loud master that never clipped', loud], ['a vinyl rip with pops', vinyl], ['a cassette transfer', tape]]) {
    const m = RSDSP.measure([sig], SR);
    H.ok(m.clipEvidence < 0.02,
      'no clipping evidence on ' + tag,
      'flat ' + (100 * m.clipFlatRatio).toFixed(4) + ' %, implied ' + m.clipOvershootDb.toFixed(2) + ' dB, evidence ' + m.clipEvidence.toFixed(3));
    const P = RP.buildParams('auto', m, RP.PRESETS[RP.classify(m).id].recommended);
    H.ok(!(P.declip > 0), 'and the automatic dose stays at zero for ' + tag,
      'declip ' + P.declip.toFixed(3) + ' (evidence ' + m.clipEvidence.toFixed(3) + ')');
  }
  // …and even *forced* on (the profile's manual position) it does nothing: no
  // run is ever long enough to look like a flat top, so there is nothing to
  // repair and the output is the input
  const off = H.renderEx(Processor, [loud], SOLO({ declip: 0, declick: 0 }));
  const on = H.renderEx(Processor, [loud], SOLO({ declip: 0.95, declick: 0 }));
  H.ok(Math.abs(flatOf(on.out[0]).flatRatio - flatOf(off.out[0]).flatRatio) < 2e-5,
    'the stage is dormant even when it is switched on for material without clipping',
    (100 * flatOf(off.out[0]).flatRatio).toFixed(4) + ' % → ' + (100 * flatOf(on.out[0]).flatRatio).toFixed(4) + ' %');
}

H.section('engine · true-peak limiter (the export ceiling)');
{
  // The last defect a master can have, and the one that only shows up after the
  // export: samples under full scale do not mean the *waveform* is under it. A
  // signal that turns around between two samples reaches higher between them,
  // and a codec that has to encode an overdriven waveform distorts it. Every
  // streaming target is therefore a true-peak target (−1 dBTP, −2 dBTP above
  // −14 LUFS), and the app measures the file's own true peak as `ispDb`.
  //
  // Three things are asserted here: that the ceiling is held *and measured* —
  // the detector is the same estimator the measurement uses, so the two agree
  // by construction — that a file which does not need the limiter pays nothing
  // for it, and that the gain is shared between the channels, because a limiter
  // that works per channel pulls the image sideways whenever one side is louder.
  const MIN = () => Object.assign({}, H.DEFAULT_PARAMS, { power: 1, autoLevel: 0 });
  const hot = (() => {
    const seconds = 6;
    const env = H.songEnvelope(SR, seconds, 0.05);
    let x = H.mul(H.pink(SR, seconds, 0.45, 17), 1);
    for (let i = 0; i < x.length; i++) x[i] *= env[i];
    x = H.mix([x, H.mul(H.tone(60, SR, seconds, 0.2), 1), H.mul(H.tone(3000, SR, seconds, 0.1), 1)]);
    const s = H.normalize(x, 1.0);                      // a master at the rail
    for (let i = 0; i < s.length; i++) {
      const v = s[i];
      s[i] = v > 0.94 ? 0.94 + 0.06 * Math.tanh((v - 0.94) / 0.06)
        : v < -0.94 ? -0.94 + 0.06 * Math.tanh((v + 0.94) / 0.06) : v;
    }
    return s;
  })();
  const free = H.renderEx(Processor, [hot], MIN());
  H.ok(free.latency === 0, 'a ceiling of 0 dB switches the stage off entirely — no delay, no gain',
    'latency ' + free.latency);
  const freeIsp = RSDSP.measure([free.out[0]], SR).ispDb;

  const limit = (ceil) => H.renderEx(Processor, [hot], Object.assign({}, MIN(), { tpCeil: ceil }));
  const at = {};
  for (const ceil of [-1, -2]) {
    const r = limit(ceil);
    at[ceil] = { r, isp: RSDSP.measure([r.out[0]], SR).ispDb, peak: H.peak(r.out[0]) };
    // 72 samples of gain window (1.5 ms) + 16 samples of interpolator reach:
    // the kernel is symmetric, so half of it is on the far side of the interval
    // it judges (see ISP_TAPS).
    H.ok(r.latency === 88, 'the stage reports its look-ahead (88 samples at 48 kHz: 1.5 ms plus the interpolator)',
      'ceiling ' + ceil + ' → ' + r.latency);
    H.ok(at[ceil].isp <= ceil + 0.15,
      'the file arrives under the ' + ceil + ' dBTP ceiling the limiter was given',
      'true peak measured ' + at[ceil].isp.toFixed(2) + ' dBTP (was ' + freeIsp.toFixed(2) + ' dBTP unlimited)');
  }
  // …and it takes only what the peaks need: a limiter that pulls the whole file
  // down by the overshoot would make every loud master noticeably quieter than
  // the file that came in, which is not restoration either
  const rmsOf = (a) => { let e = 0; for (let i = 0; i < a.length; i++) e += a[i] * a[i]; return Math.sqrt(e / a.length); };
  const takenDb = 20 * Math.log10(rmsOf(at[-1].r.out[0]) / rmsOf(free.out[0]));
  H.ok(takenDb > -1.5 && takenDb < 0.2, 'and takes only the headroom the peaks need, not the whole file',
    takenDb.toFixed(2) + ' dB of level');

  // Nothing that is already below the ceiling may pay for the stage, and the
  // claim is exact rather than approximate: the gain stays at 1.000000 and the
  // output is the input, delayed. Two caveats about *how* that is measured,
  // both properties of the chain rather than of the limiter:
  //   · auto-level off — with it on, the matcher compares dry and wet block
  //     energy, and its dry reference moves when a stage adds latency, so it
  //     settles a few hundredths of a decibel away from the unlimited render;
  //   · the first second skipped — the master A/B crossfade ramps from dry to
  //     wet over ~0.2 s, and that blend is exactly where a differently delayed
  //     dry reference is audible (measured: 2e-2 at 2.5 ms, 1e-5 by 0.6 s).
  const quiet = H.mul(hot, 0.25);
  const qOff = H.renderEx(Processor, [quiet], MIN());
  const qOn = H.renderEx(Processor, [quiet], Object.assign({}, MIN(), { tpCeil: -1 }));
  let worst = 0;
  for (let i = SR; i + qOn.latency < qOn.out[0].length; i++) {
    const d = Math.abs(qOn.out[0][i + qOn.latency] - qOff.out[0][i]);
    if (d > worst) worst = d;
  }
  H.ok(worst < 1e-6, 'a file 12 dB below the ceiling comes through the stage untouched',
    'largest difference ' + worst.toExponential(1) + ' (24 bit is 6e-8)');

  // both channels through one gain: with a loud left and a quiet right, the
  // ratio between them has to survive the limiting, or the image walks
  const L = hot, R = H.mul(hot, 0.10);
  const pairOff = H.renderEx(Processor, [L, R], MIN());
  const pairOn = H.renderEx(Processor, [L, R], Object.assign({}, MIN(), { tpCeil: -2 }));
  const ratio = (chans, lat) => {
    let sl = 0, sr = 0;
    for (let i = SR; i + lat < chans[0].length; i++) { sl += chans[0][i + lat] * chans[0][i + lat]; sr += chans[1][i + lat] * chans[1][i + lat]; }
    return 10 * Math.log10(sl / (sr + 1e-30));
  };
  const drift = Math.abs(ratio(pairOn.out, pairOn.latency) - ratio(pairOff.out, 0));
  H.ok(drift < 0.2, 'and the same gain is applied to both channels — the image does not move',
    'L/R ratio moved by ' + drift.toFixed(3) + ' dB');
  H.ok(RSDSP.measure([pairOn.out[0], pairOn.out[1]], SR).ispDb <= -2 + 0.15,
    'a stereo pair is held under the ceiling too',
    RSDSP.measure([pairOn.out[0], pairOn.out[1]], SR).ispDb.toFixed(2) + ' dBTP');

  // The whole repair chain on one file, and a check on the *output* rather than
  // on what one stage intended: this is the combination that exposed a NaN.
  // Every stage that holds its output back adds to the chain's delay, and the
  // chain's dry reference has to be as long as the sum — it was sized for the
  // two repair stages before the limiter existed, so with all three engaged the
  // reference read *before* its buffer, which is `undefined`, which is NaN by
  // the time it reaches the mix. Measured: NaN audio for the first 2.7 s of a
  // loud master, until the master crossfade reached exactly 1.
  const everything = Object.assign({}, H.DEFAULT_PARAMS, {
    power: 1, autoLevel: 1, declip: 0.65, declipLevel: -0.13, declick: 0.6,
    dehiss: 0.16, glue: 0.09, tpCeil: -2,
  });
  const full = H.renderEx(Processor, [hot], everything);
  let nonFinite = 0;
  for (let i = 0; i < full.out[0].length; i++) if (!isFinite(full.out[0][i])) nonFinite++;
  H.ok(nonFinite === 0, 'with every repair stage engaged the output is finite — every sample of delay is covered',
    nonFinite + ' non-finite samples, latency ' + full.latency);
  H.ok(full.latency === 271 + 17 + 88, 'and the three look-aheads add up to one number the caller can trust',
    String(full.latency) + ' samples (271 de-clip + 17 de-click + 88 limiter)');
  H.ok(RSDSP.measure([full.out[0]], SR).ispDb <= -2 + 0.15, 'the chain as a whole still lands under the ceiling',
    RSDSP.measure([full.out[0]], SR).ispDb.toFixed(2) + ' dBTP');
}

H.section('engine · the repairs do not depend on the level');
{
  // The same recording digitised 20 dB down is the same recording: the finished
  // file has to be the same file, 20 dB down. Every threshold inside a repair
  // that is written as an *absolute* number breaks this, and it breaks it in the
  // worst possible way — a quiet transfer simply gets less repair than a loud
  // one, with nothing in the interface saying so. Two of them were found this
  // way: the de-clicker's level gate (f between 0.008 and 0.05, so a −24 dBFS
  // transfer kept 63 pops where a full-scale one kept 6 — the detector's ratio
  // statistic was literally identical at both levels, p50 1.08) and the
  // de-hisser's reference clamp (t1 ≤ 0.01, i.e. −40 dBFS: on any louder file
  // the gate's level key read "this is music" everywhere and the stage stopped
  // cutting at all — the two finished files were 12.6 dB apart, 33.5 dB
  // without the clamp). The synthesis stages are deliberately *not* level-free
  // (a master sitting at −0.4 dBFS must not receive another 3 dB of bass, see
  // `headroom`), so this test isolates the repairs.
  const env = H.songEnvelope(SR, 6, 0.05);
  let bed = H.filter(RSDSP, H.mul(H.pink(SR, 6, 0.40, 31), 1), SR, 'lp', 8000, 0.60);
  for (let i = 0; i < bed.length; i++) bed[i] *= env[i];
  const clean = H.normalize(bed, 0.62);
  const hissy = H.normalize(H.mix([clean, H.mul(H.noise(SR, 6, 0.014, 5), 1)]), 0.62);
  const pops = H.addCrackle(hissy, 9, 0.85, 8);
  const K = 0.1;                                       // −20 dB
  const repairs = { tpCeil: 0, exciter: 0, air: 0, sub: 0, glue: 0, warmth: 0, tilt: 0, reso: 0 };
  const renderAt = (g) => {
    const sig = Float32Array.from(pops, (x) => x * g);
    const m = RSDSP.measure([sig], SR);
    const P = Object.assign({}, RP.buildParams('auto', m, 1), repairs);
    const out = H.render(Processor, [sig], P)[0];
    return { out, P, index: RSDSP.crackleDetect([out], SR).index };
  };
  const a = renderAt(1), b = renderAt(K);
  H.ok(a.P.dehiss > 0.4 && a.P.declick > 0.4 && b.P.dehiss > 0.4 && b.P.declick > 0.4,
    'the fixture asks for both repairs at both levels',
    'dehiss ' + a.P.dehiss.toFixed(2) + '/' + b.P.dehiss.toFixed(2) + ', declick ' + a.P.declick.toFixed(2) + '/' + b.P.declick.toFixed(2));
  H.ok(a.index < 0.4 && b.index < 0.4, 'and both repairs reach the same verdict',
    'crackle index ' + a.index.toFixed(2) + ' / ' + b.index.toFixed(2));
  let e = 0, rr = 0;
  for (let i = 0; i < a.out.length; i++) { const d = b.out[i] - K * a.out[i]; e += d * d; rr += (K * a.out[i]) * (K * a.out[i]); }
  const residual = 10 * Math.log10(e / rr);
  H.ok(residual < -30, 'the two finished files are the same file 20 dB down',
    residual.toFixed(1) + ' dB of level-normalised residual (was −12.6 dB while the de-hisser reference was clamped)');
}

/* ═════════════════════════════════════════════════════════════════════════════
 * engine · the true-peak claim, measured by somebody else
 *
 * The app promises the export holds −1 dBTP (or −2 when it is loud). "True
 * peak" is a statement about what the waveform does *between* the samples, so
 * checking it with the app's own interpolator would only prove that the app
 * agrees with itself. This section carries its own meter — a 48-tap
 * Blackman-windowed sinc at eight phases, i.e. more taps, a different window and
 * twice the phase resolution of the one the app builds — and puts the two
 * numbers side by side.
 *
 * Why it exists: the app's old estimator was a seven-tap sinc, and on a bright
 * transient-heavy master it read 0.5 dB *low*. Measured against ffmpeg's
 * ebur128 as well, the export came out at −1.60 dBTP while the app reported
 * −2.10 — 0.4 dB above the ceiling it had just been told to hold, with the
 * limiter's gain computed from the very same estimate. Both places now build the
 * same 32-tap kernel; ffmpeg agrees with them to 0.00–0.03 dB on tonal, squashed
 * and percussive material (see scratch/tp-check.js).
 * ═══════════════════════════════════════════════════════════════════════════ */
H.section('engine · the true-peak claim, measured by somebody else');
{
  /* an independent interpolator: 48 taps, Blackman window, eight phases */
  const REF_TAPS = 48, REF_PH = 8;
  const refTable = [];
  for (let q = 1; q < REF_PH; q++) {
    const taps = new Float64Array(REF_TAPS);
    for (let n = 0; n < REF_TAPS; n++) {
      const x = (n - (REF_TAPS / 2 - 1)) - q / REF_PH;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * (n + 0.5) / REF_TAPS)
        + 0.08 * Math.cos(4 * Math.PI * (n + 0.5) / REF_TAPS);
      taps[n] = sinc * w;
    }
    let sum = 0;
    for (let n = 0; n < REF_TAPS; n++) sum += taps[n];
    for (let n = 0; n < REF_TAPS; n++) taps[n] /= sum;
    refTable.push(taps);
  }
  const refPeakDb = (sig) => {
    const half = REF_TAPS / 2;
    let pk = 0;
    for (let i = half; i < sig.length - half; i++) {
      const a = Math.abs(sig[i]);
      if (a > pk) pk = a;
      for (let q = 1; q < REF_PH; q++) {
        const t = refTable[q - 1];
        let v = 0;
        for (let n = 0; n < REF_TAPS; n++) v += sig[i - half + 1 + n] * t[n];
        const av = v < 0 ? -v : v;
        if (av > pk) pk = av;
      }
    }
    return 20 * Math.log10(Math.max(pk, 1e-9));
  };

  const rnd = H.rng(9);
  let perc = H.filter(RSDSP, H.pink(SR, 6, 0.30, 5), SR, 'hp', 300, 0.7);
  for (let t = 0; t < 6 * 8; t++) {                     // bright hits, 8 per second
    const at = Math.floor((0.1 + t / 8) * SR);
    const amp = 0.55 + 0.45 * rnd();
    for (let i = 0; i < 900 && at + i < perc.length; i++) {
      perc[at + i] += amp * Math.exp(-i / 120) * Math.sin(2 * Math.PI * (3200 + 5200 * i / 900) * (i / SR));
    }
  }
  perc = H.normalize(perc, 0.99);

  const m = RSDSP.measure([perc], SR);
  H.ok(m.ispDb > m.peakDb + 0.02,
    'a bright transient master really does peak between the samples',
    'sample peak ' + m.peakDb.toFixed(2) + ' vs inter-sample ' + m.ispDb.toFixed(2) + ' dBFS');
  H.ok(Math.abs(m.ispDb - refPeakDb(perc)) < 0.15,
    'and the reading agrees with an independent interpolator',
    m.ispDb.toFixed(2) + ' vs ' + refPeakDb(perc).toFixed(2) + ' dBFS');

  const P = Object.assign({}, H.DEFAULT_PARAMS,
    { power: 1, bypass: 0, tpCeil: -2, refDb: m.peakDb, noiseFloor: -80, hissFloor: -90 });
  const limited = H.render(Processor, [perc], P)[0];
  const lm = RSDSP.measure([limited], SR);
  const ref = refPeakDb(limited);
  H.ok(lm.ispDb <= -2 + 0.05 && ref <= -2 + 0.05,
    '…so the ceiling is held on the hardest material, by both meters',
    'app ' + lm.ispDb.toFixed(3) + ', independent ' + ref.toFixed(3) + ' dBTP against a −2 dBTP target');
  H.ok(lm.ispDb <= m.ispDb - 0.5,
    '…and the file that needed the limiter came down by the overshoot it had',
    (m.ispDb - lm.ispDb).toFixed(2) + ' dB');
}

/* ═════════════════════════════════════════════════════════════════════════════
 * engine · nothing in the app depends on how loud the file is
 *
 * The chain is built on one promise: what a recording sounds like does not
 * change when you turn the fader down. The repairs are checked above; this is
 * the other two halves of the app — the *analysis* that decides what to do, and
 * the stages that are neither a repair nor an absolute target (the glue, the
 * analogue warmth, the harmonic synthesisers).
 *
 * Three absolute constants were found this way, all of the same kind — a number
 * that only makes sense for a file at full scale, sitting in the middle of a
 * statistic that is supposed to describe the waveform:
 *
 *   · the inter-sample peak walk only visited samples above an absolute 0.5, so
 *     a file 20 dB down reported "no inter-sample peak" (−240 dB) and the
 *     analyser handed the sample peak on as the true peak;
 *   · the flat-top detector's tolerance was an absolute 0.0025, so a quieter
 *     copy of the *same* recording looked like a *more* clipped one — the
 *     samples differ by 20 dB less, runs survive the tolerance longer, and the
 *     implied overshoot (and with it the de-clip dose) followed the upload's
 *     volume;
 *   · the spectrum's floor was an absolute −120 dBFS, which clamped a quiet
 *     file's top octave 20 dB early: the measured codec cliff of one fixture
 *     moved 1 740 Hz and shrank from 18.5 dB to 13.4 dB between the two levels;
 *   · the exciter's noise reference was capped at an absolute 0.02, which only
 *     bites on a loud file: the same dose generated 44 dB less harmonic content
 *     on a quiet copy of the vinyl fixture.
 *
 * The synthesis stages earn the same rule, with one documented exception: the
 * true-peak limiter holds the export to an *absolute* ceiling (−1/−2 dBTP), and
 * a limiter that followed the fader would be a broken limiter. Everything with
 * a threshold that is a matter of taste reads `refDb` — the file's own peak —
 * so the same slider means the same thing on a quiet transfer and a loud
 * master. At full scale `refLin` is 1 and the thresholds are the numbers they
 * always were.
 * ═══════════════════════════════════════════════════════════════════════════ */
H.section('engine · the analysis and the synthesis do not depend on the level');
{
  const K = 0.1;                                        // −20 dB
  const FIX = {
    lowbitrate: H.lowBitrateSim(RSDSP, SR, 8),
    vinyl: H.vinylSim(RSDSP, SR, 8),
  };
  /* Metrics that *are* a level: they must move by exactly 20 dB. Everything
   * else has to be bit-identical. */
  const LEVELS = ['peakDb', 'loudness', 'noiseFloorDb', 'hfNoiseFloorDb', 'musicLevelDb',
    'hissRefDb', 'ispDb', 'dcOffsetDb', 'clipLevelDb', 'deriveDb'];
  const drift = [];
  for (const tag of Object.keys(FIX)) {
    const loudSig = FIX[tag], quietSig = Float32Array.from(loudSig, (x) => x * K);
    const a = RSDSP.measure([loudSig], SR), b = RSDSP.measure([quietSig], SR);
    for (const k of Object.keys(a)) {
      const x = a[k], y = b[k];
      if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) continue;
      const want = LEVELS.indexOf(k) >= 0 ? x - 20 : x;
      if (Math.abs(y - want) > 0.02) drift.push(tag + '.' + k + ' ' + x.toFixed(2) + '→' + y.toFixed(2));
    }
  }
  H.ok(drift.length === 0, 'the analysis reads the same file at any level',
    drift.slice(0, 3).join(', ') || Object.keys(FIX).length + ' fixtures, every metric');

  const OFF = Object.assign({}, H.DEFAULT_PARAMS, {
    power: 1, autoLevel: 1, tpCeil: 0, declip: 0, declick: 0, dehiss: 0, reso: 0,
    hum: 0, hum2: 0, hum3: 0, sub: 0, exciter: 0, air: 0, glue: 0, warmth: 0, tilt: 0,
    width: 0, deess: 0, infraHP: 0, bassMono: 0, boxG1: 0, boxG2: 0,
    band0: 0, band1: 0, band2: 0, band3: 0, band4: 0, band5: 0,
    eq0: 0, eq1: 0, eq2: 0, eq3: 0, eq4: 0, eq5: 0, eq6: 0, eq7: 0, eq8: 0, eq9: 0, eq10: 0, eq11: 0,
  });
  /* …and the file's own peak is a property of the *file*, like the noise floor:
   * it has to follow the level, or a stage that reads it would be measuring the
   * upload instead of the recording. */
  const PER_FILE = ['noiseFloor', 'hissFloor', 'declipLevel', 'refDb'];
  const worst = {};
  for (const tag of Object.keys(FIX)) {
    const loudSig = FIX[tag], quietSig = Float32Array.from(loudSig, (x) => x * K);
    const A = RP.buildParams('auto', RSDSP.measure([loudSig], SR), 0.7);
    const B = RP.buildParams('auto', RSDSP.measure([quietSig], SR), 0.7);
    const refL = Object.assign({}, OFF), refQ = Object.assign({}, OFF);
    for (const k of PER_FILE) { refL[k] = A[k]; refQ[k] = B[k]; }
    for (const st of ['glue', 'warmth', 'exciter', 'air', 'band5']) {
      if (!(A[st] > 0)) continue;
      const oL = H.render(Processor, [loudSig], Object.assign({}, refL, { [st]: A[st] }))[0];
      const oQ = H.render(Processor, [quietSig], Object.assign({}, refQ, { [st]: B[st] }))[0];
      let e = 0, rr = 0;
      for (let i = 0; i < oL.length; i++) { const d = oL[i] - oQ[i] / K; e += d * d; rr += oL[i] * oL[i]; }
      const r = 10 * Math.log10(e / rr);
      const key = tag + ' ' + st;
      if (worst[st] === undefined || r > worst[st][1]) worst[st] = [key, r];
    }
  }
  const bad = Object.keys(worst).filter((st) => worst[st][1] > -50);
  H.ok(Object.keys(worst).length >= 3 && bad.length === 0,
    'the stages that are neither a repair nor a target mean the same thing at any level',
    bad.length ? bad.map((st) => worst[st][0] + ' ' + worst[st][1].toFixed(1) + ' dB').join(', ')
      : Object.keys(worst).map((st) => st + ' ' + worst[st][1].toFixed(0)).join(' dB, ') + ' dB');

  /* …and the one exception is documented as an exception: the limiter holds an
   * absolute ceiling, so the same file 20 dB down comes out 20 dB down. */
  const loudSig = FIX.lowbitrate, quietSig = Float32Array.from(loudSig, (x) => x * K);
  const target = Object.assign({}, OFF, { tpCeil: -1, refDb: 0, noiseFloor: -80, hissFloor: -90 });
  const pL = RSDSP.measure([H.render(Processor, [loudSig], target)[0]], SR);
  const pQ = RSDSP.measure([H.render(Processor, [quietSig], target)[0]], SR);
  H.ok(Math.abs((pQ.peakDb + 20) - pL.peakDb) < 0.5 || pQ.peakDb < -20,
    'the true-peak ceiling is the one target that *does* depend on the absolute level',
    'peak ' + pL.peakDb.toFixed(1) + ' vs ' + pQ.peakDb.toFixed(1) + ' dBFS');
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
  const off = H.render(Processor, [mixed], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, reso: 0, autoLevel: 0 }))[0];
  const on = H.render(Processor, [mixed], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, reso: 0.9, autoLevel: 0 }))[0];
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
  // …and what is left of it once the automatic level match has taken back the
  // part of the change that lands inside its loudness band. The slider has to
  // deliver a clearly audible top-end span, not a theoretical one.
  H.ok(levels[4] - levels[0] > 5, 'slider range is wide enough to matter',
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

H.section('measurement · a broken file never becomes NaN parameters');
{
  // A WAV of float samples can contain anything, including NaNs. One NaN poisons
  // every IIR filter for the rest of the file (the state stays NaN), so the chain
  // must never be handed parameters built from a non-finite measurement — the
  // user would get a silent, "perfectly remastered" file. The measurement marks
  // such a file, still reports a finite score, and presets.js refuses to pass
  // anything non-finite on.
  const bad = new Float32Array(SR * 2);
  for (let i = 0; i < bad.length; i++) bad[i] = Math.sin(i * 0.01) * 0.2;
  bad[137] = NaN;                                   // one corrupt sample
  const m = RSDSP.measure([bad], SR);
  H.ok(m.nonFinite === true, 'the measurement notices a file that is not made of numbers',
    'nonFinite=' + m.nonFinite + ' · peak ' + m.peakDb.toFixed(1) + ' dB');
  H.ok(isFinite(m.score), 'and still reports a finite score instead of NaN %', m.score + ' / 100');

  const params = RP.buildParams('auto', m, 0.8);
  const badParams = Object.entries(params).filter(([, v]) => typeof v === 'number' && !isFinite(v));
  H.ok(badParams.length === 0, 'every parameter built from that measurement is finite',
    Object.keys(params).length + ' parameters · ' + (badParams.length ? badParams[0][0] : 'clean'));

  // …and the guard does not fire on real recordings
  const sims = [H.garageSim(RSDSP, SR, 8), H.cassetteSim(RSDSP, SR, 8),
    H.vinylSim(RSDSP, SR, 8), H.lowBitrateSim(RSDSP, SR, 8)];
  H.ok(sims.every((sig) => RSDSP.measure([sig], SR).nonFinite === false),
    'the four problem recordings measure as numeric');
}

/* ═════════════════════════════════════════ the sliced measurement (progress) ══ */

/* the analyser reads the very same globals the page does */
global.RSDSP = RSDSP;
global.RSPresets = RP;
const Analyzer = require(path.join(H.ROOT, 'assets', 'js', 'analyzer.js'));

/** The async sections below are the only ones that yield; keep them in one place. */
async function slicedSections() {

H.section('measurement · the sliced form is the same measurement');
{
  // The UI runs `measureAsync`/`analyzeAsync` so a phone can paint a progress bar
  // while a long file is measured. That is only allowed to be a *driving* change:
  // the numbers have to be identical to the synchronous reference, bit for bit.
  const SIM2 = {
    garage: H.garageSim(RSDSP, SR, 6),
    cassette: H.cassetteSim(RSDSP, SR, 6),
    vinyl: H.vinylSim(RSDSP, SR, 6),
    lowbitrate: H.lowBitrateSim(RSDSP, SR, 6),
  };
  const FIELDS = ['score', 'peakDb', 'loudness', 'noiseFloorDb', 'hfNoiseFloorDb', 'dynamicRangeDb',
    'crackleIndex', 'correlation', 'clipRatio', 'hfCutoff', 'tilt', 'topLoss', 'brickwall',
    'dullIndex', 'deriveGapDb', 'hissAmount', 'hissDeficitDb', 'snrDb', 'hfSnrDb', 'vinylAmount',
    'tapeAmount', 'noiseSlope', 'noiseFlatness', 'noiseRumble', 'noiseConfidence', 'mudScore',
    'harshness', 'airiness', 'bassRoll', 'subDeficit', 'cliffDb', 'cliffHz', 'specEndHz',
    'bandLimited', 'musicLevelDb', 'hfEnergyLoss', 'deriveDb', 'hfDropDb', 'crestDb'];
  let diff = [];
  for (const [name, sig] of Object.entries(SIM2)) {
    const sync = RSDSP.measure([sig], SR);
    const async_ = await RSDSP.measureAsync([sig], SR);
    for (const f of FIELDS) if (sync[f] !== async_[f]) diff.push(name + ' ' + f);
    for (let b = 0; b < sync.bandExcess.length; b++) {
      if (sync.bandExcess[b] !== async_.bandExcess[b]) diff.push(name + ' bandExcess[' + b + ']');
    }
    if (sync.spec.db.length !== async_.spec.db.length) diff.push(name + ' spectrum length');
    for (let k = 0; k < sync.spec.db.length; k += 97) {
      if (sync.spec.db[k] !== async_.spec.db[k]) { diff.push(name + ' spectrum bin ' + k); break; }
    }
  }
  H.ok(diff.length === 0, 'every metric of the sliced measurement equals the synchronous one',
    diff.slice(0, 5).join(', '));

  // …and the whole analysis, including the window, the envelopes and the chips
  const sim = SIM2.garage;
  const buffer = {
    sampleRate: SR, numberOfChannels: 1, duration: sim.length / SR,
    getChannelData: () => sim,
  };
  const syncA = Analyzer.analyze(buffer, { previewSeconds: 40, buckets: 1400 });
  const asyncA = await Analyzer.analyzeAsync(buffer, { previewSeconds: 40, buckets: 1400 });
  const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  H.ok(deepEqual(syncA.metrics, asyncA.metrics) && syncA.window.start === asyncA.window.start
    && deepEqual(syncA.chips, asyncA.chips) && deepEqual(syncA.diag, asyncA.diag),
    'the sliced analysis returns the same window, metrics, chips and diagnosis');
  H.ok(deepEqual(Array.from(syncA.envelope.max), Array.from(asyncA.envelope.max))
    && deepEqual(Array.from(syncA.windowEnvelope.rms), Array.from(asyncA.windowEnvelope.rms)),
    'both waveform envelopes are identical too');
}

H.section('measurement · progress is honest and the loop stays alive');
{
  const sig = H.vinylSim(RSDSP, SR, 8);
  const marks = [];
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 4);      // proves the loop yields
  const out = await RSDSP.measureAsync([sig], SR, (p, label) => marks.push({ p, label }), {});
  clearInterval(timer);
  H.ok(marks.length > 10, 'a several-second file is reported many times, not in one jump',
    marks.length + ' reports');
  H.ok(marks[0].p === 0 && marks[marks.length - 1].p === 1, 'progress runs from 0 to 100 %',
    marks[0].p + ' → ' + marks[marks.length - 1].p);
  H.ok(marks.every((m, i) => i === 0 || m.p >= marks[i - 1].p - 1e-9), 'progress never goes backwards');
  H.ok(marks.every((m) => typeof m.label === 'string' && m.label.length > 2), 'every report names a stage',
    Array.from(new Set(marks.map((m) => m.label))).join(', '));
  H.ok(ticks > 3, 'the event loop gets control back while measuring', ticks + ' timer ticks');
  H.ok(out.score === RSDSP.measure([sig], SR).score, 'and the result is still the same measurement');

  // the stage names are what the UI shows before it translates them
  const stages = [];
  await Analyzer.analyzeAsync({ sampleRate: SR, numberOfChannels: 1, duration: sig.length / SR, getChannelData: () => sig },
    { previewSeconds: 30, buckets: 400 }, (p, stage) => stages.push(stage));
  const known = ['measure', 'diagnose', 'window', 'envelope'];
  H.ok(stages.every((st) => known.indexOf(st) !== -1) && stages.indexOf('measure') === 0
    && stages.indexOf('envelope') !== -1, 'the analysis reports its own stages', Array.from(new Set(stages)).join(', '));
}

}                                    // end of the async sections

/* ------------------------------------------------------------------- done */

slicedSections()
  .then(() => {
    const okAll = H.summarize();
    process.exit(okAll ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
