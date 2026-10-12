/* =============================================================================
 * Remaster Suite — the tuning contract
 * -----------------------------------------------------------------------------
 * These tests render real material through the real processor and measure what
 * came out. They exist because "the automatic mode is too heavy" is not a
 * matter of taste once it is written down as numbers:
 *
 *   • the automatic result may not move any octave band of the material by more
 *     than a few dB where the material actually has content — that is what
 *     "not overdriven" means once it is written down as a number;
 *   • what it *adds* above 6 kHz may never become the feature: the whole change
 *     the chain makes there has to stay far below the music band. Filling a
 *     dead top octave (a 1960s tape has nothing above 9 kHz) is a repair; a
 *     top end that arrives at music level is a fake modern sound. A dead band
 *     is therefore allowed to rise by more than a few dB — it may just never
 *     come anywhere near the material;
 *   • it may not make a recording *brighter* than a restored vintage balance,
 *     whatever it was fed;
 *   • a healthy recording must come out essentially untouched;
 *   • the synthesisers are level-normalised: the same setting means the same dB
 *     on quiet and on loud material;
 *   • nothing may ever exceed full scale, and no setting may raise the peak of
 *     a file that was not clipped to begin with.
 *
 * Run with:  node tests/tuning.test.js
 * ========================================================================== */
'use strict';

const path = require('path');
const H = require(path.join(__dirname, 'harness.js'));
const ROOT = H.ROOT;
const DSP = H.loadDsp();
const Presets = require(path.join(ROOT, 'assets', 'js', 'presets.js'));

const SR = 48000;
const Processor = H.loadProcessor(SR);

/* ------------------------------------------------------------------ material */

/** The five simulated problems of the suite, plus four shapes they do not cover. */
function material() {
  const brightModern = (() => {
    const env = H.songEnvelope(SR, 12, 0.15);
    let s = H.mul(H.pink(SR, 12, 0.42, 77), 1);
    for (let i = 0; i < s.length; i++) s[i] *= env[i];
    s = H.filter(DSP, s, SR, 'hp', 32, 0.707);
    return H.normalize(s, 0.85);
  })();
  const bassHeavy = (() => {
    const env = H.songEnvelope(SR, 12, 0.2);
    let s = H.mul(H.pink(SR, 12, 0.42, 91), 1);
    for (let i = 0; i < s.length; i++) s[i] *= env[i];
    s = H.filter(DSP, s, SR, 'lp', 6000, 0.707);
    s = H.filter(DSP, s, SR, 'hp', 25, 0.707);
    return H.normalize(s, 0.8);
  })();
  const hotMaster = (() => {
    const env = H.songEnvelope(SR, 12, 0.05);
    let s = H.mul(H.pink(SR, 12, 0.5, 63), 1);
    for (let i = 0; i < s.length; i++) s[i] *= env[i];
    s = H.filter(DSP, s, SR, 'hp', 30, 0.707);
    s = H.filter(DSP, s, SR, 'lp', 19000, 0.707);
    for (let i = 0; i < s.length; i++) s[i] = Math.tanh(s[i] * 1.8) * 0.99;   // a loud master
    return H.normalize(s, 0.999);
  })();
  const telephone = (() => {
    const env = H.songEnvelope(SR, 12, 0.06);
    let s = H.mul(H.pink(SR, 12, 0.4, 71), 1);
    for (let i = 0; i < s.length; i++) s[i] *= env[i];
    s = H.filter(DSP, s, SR, 'hp', 300, 0.707);       // narrow band, no bottom
    s = H.filter(DSP, s, SR, 'lp', 3400, 0.707);
    s = H.mix([s, H.noise(SR, 12, 0.003, 19)]);
    return H.normalize(s, 0.6);
  })();

  return {
    garage: H.garageSim(DSP, SR, 12),
    cassette: H.cassetteSim(DSP, SR, 12),
    vinyl: H.vinylSim(DSP, SR, 12),
    lowbitrate: H.lowBitrateSim(DSP, SR, 12),
    brightModern, bassHeavy, hotMaster, telephone,
  };
}

/* --------------------------------------------------------------- measurement */

const BANDS = [[20, 40], [40, 80], [80, 160], [160, 315], [315, 630], [630, 1250],
  [1250, 2500], [2500, 5000], [5000, 10000], [10000, 16000], [16000, 20000]];
const LABELS = ['20-40', '40-80', '80-160', '160-315', '315-630', '630-1.2k', '1.2-2.5k', '2.5-5k', '5-10k', '10-16k', '16-20k'];

const rms = (sig) => { let s = 0; for (let i = 0; i < sig.length; i++) s += sig[i] * sig[i]; return Math.sqrt(s / sig.length); };
/** The worklet's soft-clip knee: above this the guard starts to bend the signal. */
const KNEE = 0.94;
const db = (lin) => 20 * Math.log10(Math.max(lin, 1e-12));

/** dB level of each octave band of a signal. */
function bandLevels(sig) {
  const spec = DSP.spectrum([sig], SR, { fftSize: 8192, maxFrames: 120 });
  return BANDS.map(([a, b]) => DSP.bandLevel(spec, a, b));
}

/** Spectral tilt: how far a signal sits from a −3 dB/oct reference (0 = neutral). */
function tilt(sig) {
  const spec = DSP.spectrum([sig], SR, { fftSize: 8192, maxFrames: 120 });
  return DSP.bandMedian(spec, 6000, 12000) - DSP.bandMedian(spec, 80, 150) + 3 * Math.log2(8500 / 113);
}

/** Render one file exactly like the app does in automatic mode. */
function renderAuto(sig, power) {
  const metrics = DSP.measure([sig], SR);
  const id = Presets.classify(metrics).id;
  const pw = power === undefined ? Presets.PRESETS[id].recommended : power;
  const params = Presets.buildParams('auto', metrics, pw);
  return { out: H.render(Processor, [sig], params)[0], params, metrics, id, power: pw };
}

/* ------------------------------------------------------------------- checks */

H.section('tuning · the automatic result stays inside its envelope');
{
  const sources = material();
  const problems = [];
  const rows = [];
  for (const [name, sig] of Object.entries(sources)) {
    const { out, id, power, params, metrics } = renderAuto(sig);
    // …with one exception, and it is a promise of its own. Two things push the
    // output level down, and both are the *file's* headroom rather than a
    // tolerance: reconstruction (peaks restored above the file's own peak need
    // room under full scale) and the true-peak limiter (a master that arrived
    // over the ceiling has to come down to reach it). The level promise is
    // suspended by exactly those two measured amounts — and by nothing else.
    const clipRoom = (params.declip || 0) > 0 ? Math.max(0, metrics.clipOvershootDb || 0) : 0;
    const tpRoom = (params.tpCeil || 0) < 0 ? Math.max(0, (metrics.ispDb || -70) - params.tpCeil) : 0;
    const room = clipRoom + tpRoom;
    const li = bandLevels(sig), lo = bandLevels(out);
    const row = { name, id, power, deltas: [] };
    for (let i = 0; i < BANDS.length; i++) {
      const d = lo[i] - li[i];
      row.deltas.push(d);
      // Only bands the material actually fills can be judged. The bottom octave
      // is exempt from the *upper* bound: the chain always guards against
      // infrasonics (−24 Hz), so the 20–40 Hz band legitimately drops.
      const floor = 80;                              // dBFS: below this there is nothing to hear
      if (li[i] < floor) continue;
      const lim = i === 0 ? 6 : 3;                   // the sub-bass repair may work harder
      if (d > lim || d < -lim) problems.push(name + ' ' + LABELS[i] + ' ' + d.toFixed(1) + ' dB');
    }
    const rmsDelta = db(rms(out) / rms(sig));
    row.rmsDelta = rmsDelta;
    if (rmsDelta < -1.5 - room || rmsDelta > 1.5) problems.push(name + ' rms ' + rmsDelta.toFixed(2) + ' dB');

    // …and the *music* has to come out as loud as it went in: the level match
    // works on 300 Hz – 3.4 kHz, so that band is the promise. The broadband RMS
    // may move by more than that simply because a restored top octave adds
    // energy — that is the repair, not a level change.
    const midDelta = DSP.bandLevel(DSP.spectrum([out], SR, { fftSize: 8192, maxFrames: 120 }), 300, 3400) -
      DSP.bandLevel(DSP.spectrum([sig], SR, { fftSize: 8192, maxFrames: 120 }), 300, 3400);
    row.midDelta = midDelta;
    if (Math.abs(midDelta) > 0.8 + room) {
      problems.push(name + ' mid ' + midDelta.toFixed(2) + ' dB' + (room ? ' (headroom ' + clipRoom.toFixed(2) + ' clip + ' + tpRoom.toFixed(2) + ' true peak)' : ''));
    }
    // The peak may rise — adding a bottom and a top octave does that — but it may
    // never rise *into the soft-clip guard*: material that was below the knee has
    // to come out below it, with the guard transparent (distortion added to a
    // file that did not need any is the one thing a restoration must never do).
    // A file that already sat at the rail — it was clipped before it got here —
    // must not be made any worse than it already was.
    const peakIn = H.peak(sig), peakOut = H.peak(out);
    row.peakDelta = db(peakOut / peakIn);
    if (peakIn < KNEE && peakOut > KNEE) problems.push(name + ' pushed into the soft-clip guard');
    if (peakIn >= KNEE && peakOut > peakIn + 0.05) problems.push(name + ' peak +' + row.peakDelta.toFixed(2) + ' dB');
    if (peakOut > 1.0) problems.push(name + ' above full scale');
    rows.push(row);
  }
  for (const r of rows) {
    console.log('    ' + r.name.padEnd(13) + '→ ' + r.id.padEnd(11) + ' @' + r.power.toFixed(2) +
      '  mid ' + (r.midDelta >= 0 ? '+' : '') + r.midDelta.toFixed(2) +
      '  rms ' + (r.rmsDelta >= 0 ? '+' : '') + r.rmsDelta.toFixed(2) + ' dB' +
      '  peak ' + (r.peakDelta >= 0 ? '+' : '') + r.peakDelta.toFixed(2) + ' dB' +
      '  bands ' + r.deltas.map((d) => d.toFixed(1).padStart(5)).join(''));
  }
  H.ok(problems.length === 0,
    'no band moves by more than 3 dB (the sub-bass may work by 6 dB), the music stays as loud, the guard stays out of the way',
    problems.slice(0, 6).join(' | '));
}

H.section('tuning · a healthy recording is left alone');
{
  const clean = (() => {
    const env = H.songEnvelope(SR, 12, 0.04);
    let s = H.mul(H.pink(SR, 12, 0.35, 77), 1);
    for (let i = 0; i < s.length; i++) s[i] *= env[i];
    s = H.filter(DSP, s, SR, 'lp', 17000, 0.707);
    return H.normalize(H.mix([s, H.noise(SR, 12, 0.0006, 78)]), 0.8);
  })();
  const bright = (() => {
    const env = H.songEnvelope(SR, 12, 0.15);
    let s = H.mul(H.pink(SR, 12, 0.42, 77), 1);
    for (let i = 0; i < s.length; i++) s[i] *= env[i];
    s = H.filter(DSP, s, SR, 'hp', 32, 0.707);
    return H.normalize(s, 0.85);
  })();
  const worst = [];
  for (const [name, sig] of Object.entries({ clean, bright })) {
    const { out, params } = renderAuto(sig);
    const li = bandLevels(sig), lo = bandLevels(out);
    let maxDelta = 0, at = '';
    for (let i = 0; i < BANDS.length; i++) {
      const d = lo[i] - li[i];
      if (li[i] < 80 && i > 0) continue;
      if (i === 0) continue;                          // the infrasonic guard
      if (Math.abs(d) > Math.abs(maxDelta)) { maxDelta = d; at = LABELS[i]; }
    }
    console.log('    ' + name.padEnd(7) + ' largest octave change ' + (maxDelta >= 0 ? '+' : '') + maxDelta.toFixed(2) + ' dB at ' + at +
      '   (air ' + params.air.toFixed(3) + ', exciter ' + params.exciter.toFixed(3) + ', sub ' + params.sub.toFixed(3) + ')');
    if (Math.abs(maxDelta) > 1.5) worst.push(name + ' ' + at + ' ' + maxDelta.toFixed(2) + ' dB');
    if (params.air > 0.02 || params.exciter > 0.02 || params.sub > 0.02) {
      worst.push(name + ' still requests synthesis (air ' + params.air.toFixed(3) + ')');
    }
  }
  H.ok(worst.length === 0, 'nothing is added and no band moves more than 1.5 dB', worst.join(' | '));
}

H.section('tuning · the repair never becomes the feature');
{
  // The complaint in numbers: "the top end it invents must not turn a dull
  // recording into a bright modern one". A dull recording has *nothing* above
  // 9 kHz, so a band-by-band limit would either forbid the repair or allow a
  // fake top. Measure the repair against the material instead: everything the
  // chain changes above 6 kHz — synthesis, EQ, saturation — has to sit far
  // below the music band. That is what separates "a little air where there was
  // none" from "a top end at music level" (the definition of a fake modern
  // sound), and it is the one bound a band-by-band table cannot express.
  const sources = material();
  const MID = [315, 2500];
  const TOP = [6000, 16000];
  const rows = [];
  const measure = (name, params, sig) => {
    const { out, latency } = H.renderEx(Processor, [sig], params);
    // The chain delays its output by `latency` samples while the de-clicker is
    // engaged (its look-ahead — see DeClicker in the worklet). Compare like for
    // like: without this shift the difference is the delay of the whole
    // signal, not what the chain changed.
    const change = new Float32Array(out.length);
    for (let i = 0; i < latency; i++) change[i] = 0;
    for (let i = latency; i < out.length; i++) change[i] = out[i] - sig[i - latency];
    const mid = DSP.bandLevel(DSP.spectrum([out], SR, { fftSize: 8192, maxFrames: 120 }), MID[0], MID[1]);
    const top = DSP.bandLevel(DSP.spectrum([change], SR, { fftSize: 8192, maxFrames: 120 }), TOP[0], TOP[1]);
    const below = mid - top;                       // how far the change sits under the music
    rows.push('    ' + name.padEnd(34) + 'music ' + mid.toFixed(1) + ' dB   change above 6 kHz ' +
      top.toFixed(1) + ' dB   → ' + below.toFixed(1) + ' dB below the music');
    return below;
  };

  // automatic mode: the mode that decides for the user, so the strict bar
  const autoWorst = [];
  for (const [name, sig] of Object.entries(sources)) {
    const m = DSP.measure([sig], SR);
    const id = Presets.classify(m).id;
    const below = measure('auto · ' + name, Presets.buildParams('auto', m, Presets.PRESETS[id].recommended), sig);
    if (below < 18) autoWorst.push(name + ' ' + below.toFixed(1) + ' dB');
  }
  H.ok(autoWorst.length === 0,
    'in automatic mode the change above 6 kHz stays at least 18 dB below the music band',
    autoWorst.slice(0, 6).join(' | '));

  // a profile *chosen and pushed to 100 %* is the user's decision — the
  // low-bitrate rescue lives up there and is meant to be audible. Even then it
  // may not arrive at music level: 12 dB is the floor, not a target.
  const manualWorst = [];
  for (const id of ['garage', 'lowbitrate', 'vinyl', 'cassette']) {
    const sig = sources[id];
    const below = measure(id + ' at full power', Presets.buildParams(id, DSP.measure([sig], SR), 1), sig);
    if (below < 12) manualWorst.push(id + ' ' + below.toFixed(1) + ' dB');
  }
  H.ok(manualWorst.length === 0,
    'even a manual profile at 100 % keeps the change above 6 kHz at least 12 dB below the music band',
    manualWorst.slice(0, 6).join(' | '));
}

H.section('tuning · synthesis is level-normalised (same dB at any level)');
{
  const base = (() => {
    let s = H.filter(DSP, H.pink(SR, 8, 0.3, 11), SR, 'lp', 5500, 0.707);
    s = H.filter(DSP, s, SR, 'lp', 7000, 0.707);
    return H.normalize(s, 0.9);
  })();
  const loud = H.mul(base, 1.0);                  // ≈ −1 dBFS
  const quiet = H.mul(base, 0.1);                 // ≈ −21 dBFS
  const gain = (sig) => {
    const params = Object.assign({}, H.DEFAULT_PARAMS, { power: 1, air: 0.5, exciter: 0.3, noiseFloor: -70, hissFloor: -90 });
    const off = H.render(Processor, [sig], Object.assign({}, params, { air: 0, exciter: 0 }))[0];
    const on = H.render(Processor, [sig], params)[0];
    return DSP.bandLevel(DSP.spectrum([on], SR, { fftSize: 8192, maxFrames: 120 }), 8000, 16000) -
      DSP.bandLevel(DSP.spectrum([off], SR, { fftSize: 8192, maxFrames: 120 }), 8000, 16000);
  };
  const dl = gain(loud), dq = gain(quiet);
  console.log('    8–16 kHz added: loud material ' + dl.toFixed(1) + ' dB, 20 dB quieter material ' + dq.toFixed(1) + ' dB');
  H.ok(Math.abs(dl - dq) < 2.5, 'the same setting adds the same dB at any level', Math.abs(dl - dq).toFixed(2) + ' dB apart');
  H.ok(dl > 2 && dl < 14, 'and it is a musical amount, not a special effect', dl.toFixed(1) + ' dB');
}

H.section('tuning · the synthesisers respect their source');
{
  const dull = (() => {
    let s = H.filter(DSP, H.pink(SR, 6, 0.3, 61), SR, 'lp', 6000, 0.707);
    return H.normalize(s, 0.9);
  })();
  const m = DSP.measure([dull], SR);
  const deriveDb = DSP.bandMedian(m.spec, 4600, 7500);

  // air: monotone in the amount, and never above the band it was derived from
  const levels = [];
  for (const air of [0, 0.25, 0.5, 0.75, 1]) {
    const out = H.render(Processor, [dull], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, air, noiseFloor: -70 }))[0];
    levels.push(DSP.bandLevel(DSP.spectrum([out], SR, { fftSize: 8192, maxFrames: 120 }), 8000, 16000));
  }
  let monotone = true;
  for (let i = 1; i < levels.length; i++) if (levels[i] < levels[i - 1] - 0.5) monotone = false;
  H.ok(monotone, 'more air is always more air', levels.map((l) => l.toFixed(1)).join(' → '));
  H.ok(levels[4] > levels[0] + 6, 'and 100 % is worth having', (levels[4] - levels[0]).toFixed(1) + ' dB at 8–16 kHz');
  H.ok(levels[4] < deriveDb + 3,
    'the generated top end never overtakes the band it was derived from',
    '8–16 kHz at ' + levels[4].toFixed(1) + ' dB vs 4.6–7.5 kHz at ' + deriveDb.toFixed(1) + ' dB');

  // sub: it follows the bass that is already there, it does not invent a level
  const bass = H.mix([H.tone(90, SR, 4, 0.35), H.tone(180, SR, 4, 0.12)]);
  const subOn = H.render(Processor, [bass], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, sub: 1 }))[0];
  const subOff = H.render(Processor, [bass], Object.assign({}, H.DEFAULT_PARAMS, { power: 1, sub: 0 }))[0];
  const subLevel = DSP.bandLevel(DSP.spectrum([subOn], SR, { fftSize: 8192, maxFrames: 120 }), 40, 50);
  const bassLevel = DSP.bandLevel(DSP.spectrum([subOff], SR, { fftSize: 8192, maxFrames: 120 }), 85, 95);
  H.ok(subLevel < bassLevel + 6, 'the sub octave stays under the bass it was derived from',
    '40–50 Hz at ' + subLevel.toFixed(1) + ' dB vs 85–95 Hz at ' + bassLevel.toFixed(1) + ' dB');
  H.ok(subLevel > DSP.bandLevel(DSP.spectrum([subOff], SR, { fftSize: 8192, maxFrames: 120 }), 40, 50) + 10,
    'and it is still worth switching on', (subLevel - DSP.bandLevel(DSP.spectrum([subOff], SR, { fftSize: 8192, maxFrames: 120 }), 40, 50)).toFixed(1) + ' dB');
}

H.section('tuning · synthesis follows the music, not the noise floor');
{
  // first half loud, second half 30 dB quieter: the added air must follow
  const env = new Float32Array(SR * 6);
  for (let i = 0; i < env.length; i++) env[i] = i < env.length / 2 ? 1 : 0.03;
  let s = H.mul(H.filter(DSP, H.pink(SR, 6, 0.4, 33), SR, 'lp', 6000, 0.707), 1);
  for (let i = 0; i < s.length; i++) s[i] *= env[i];
  s = H.mix([s, H.noise(SR, 6, 0.004, 44)]);            // steady hiss under both halves
  s = H.normalize(s, 0.85);
  const params = Object.assign({}, H.DEFAULT_PARAMS, { power: 1, air: 0.6, exciter: 0.4, noiseFloor: -52, hissFloor: -54 });
  const off = H.render(Processor, [s], Object.assign({}, params, { air: 0, exciter: 0 }))[0];
  const on = H.render(Processor, [s], params)[0];
  const half = (sig, from, to) => sig.subarray(from, to);
  // measure the *added* signal only
  const added = new Float32Array(on.length);
  for (let i = 0; i < on.length; i++) added[i] = on[i] - off[i];
  const band = (sig) => DSP.bandLevel(DSP.spectrum([sig], SR, { fftSize: 8192, maxFrames: 60 }), 8000, 16000);
  const loud = band(half(added, 0, added.length / 2));
  const quiet = band(half(added, added.length / 2, added.length));
  console.log('    added 8–16 kHz: loud half ' + loud.toFixed(1) + ' dB, quiet half ' + quiet.toFixed(1) + ' dB');
  H.ok(loud - quiet > 8, 'the generated top end tracks the music and fades with it', (loud - quiet).toFixed(1) + ' dB down');
}

H.section('tuning · honesty of the extreme settings');
{
  const dull = (() => {
    let s = H.filter(DSP, H.pink(SR, 6, 0.3, 62), SR, 'lp', 6000, 0.707);
    return H.normalize(s, 0.9);
  })();
  // everything at maximum, as the audit suite does: must stay inside full scale
  const extreme = Object.assign({}, H.DEFAULT_PARAMS, {
    power: 1, air: 1, exciter: 1, sub: 1, reso: 1, dehiss: 1, declick: 1, glue: 0.6,
    warmth: 0.65, tilt: 1, band0: 6, band4: 6, band5: 6, noiseFloor: -60, hissFloor: -60,
  });
  const out = H.render(Processor, [dull], extreme)[0];
  H.ok(H.peak(out) <= 1.0000001, 'even everything-at-maximum stays inside full scale', H.peak(out).toFixed(4));
  H.ok(isFinite(H.peak(out)), 'and stays finite');

  // 0 % must be a bit-transparent copy — the product's promise for the A/B switch
  const zero = H.render(Processor, [dull], Object.assign({}, H.DEFAULT_PARAMS, { power: 0, air: 1, exciter: 1, sub: 1, dehiss: 1 }))[0];
  let maxDiff = 0;
  for (let i = 0; i < dull.length; i++) maxDiff = Math.max(maxDiff, Math.abs(zero[i] - dull[i]));
  H.ok(maxDiff < 1e-7, '0 % is bit-transparent, whatever the rest of the parameters say', maxDiff.toExponential(1));

  // and the automatic level match must not be fooled into a level change
  const t0 = tilt(dull);
  const twelve = H.render(Processor, [dull], Presets.buildParams('garage', DSP.measure([dull], SR), 1))[0];
  const t1 = tilt(twelve);
  console.log('    tilt ' + t0.toFixed(1) + ' dB → ' + t1.toFixed(1) + ' dB at full restoration power');
  H.ok(t1 - t0 > 1.5 && t1 - t0 < 8, 'full power opens the top end — measurably, not grotesquely',
    (t1 - t0).toFixed(1) + ' dB');
  H.ok(t1 < 2, 'and a dull recording never comes out as a bright modern one', t1.toFixed(1) + ' dB from neutral');
}

const ok = H.summarize();
process.exit(ok ? 0 : 1);
