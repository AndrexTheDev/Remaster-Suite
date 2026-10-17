/* =============================================================================
 * Remaster Suite — Harmonic Restoration Engine
 * =============================================================================
 * AudioWorkletProcessor implementing the full restoration chain:
 *
 *   input ─┬───────────────────────────────────────────────┐ (dry)
 *          │                                               │
 *          ├─ DC guard ─ Static EQ bank (6 bands)           │
 *          ├─ Dynamic de-resonator (6 probing bands)       │
 *          ├─ Harmonic exciter (3 bands, even + odd)       │
 *          ├─ Air synthesizer 8–16 kHz (+ de-esser)        │
 *          ├─ Sub-harmonic synthesizer 30–60 Hz            │
 *          ├─ Tape/vinyl de-hiss (HF downward expander)    │
 *          ├─ De-clicker (impulse repair)                  │
 *          ├─ Glue compressor + analog warmth              │
 *          ├─ Tilt tone control + output infra-sonic HPF   │
 *          └─ Auto level match ───────────────────────────►├── wet
 *                                                          │
 *                              out = dry + power·(wet − dry)
 *
 * All filters are minimum-phase IIR → the engine is zero-latency, which is what
 * makes the A/B (Original ⇄ Restored) switch click-free and sample accurate.
 *
 * The very same file runs live (AudioWorkletNode) and offline
 * (OfflineAudioContext), so preview and export are bit-identical.
 *
 * PERFORMANCE NOTES
 *  • Audio-rate: only what must run per sample (biquads, oscillators).
 *  • Control-rate: every envelope, gain computer and gate runs decimated
 *    (4–8×) and is linearly interpolated per sample → no zipper noise, and
 *    ~3× faster than naive per-sample control.
 *  • No allocation inside process(); no Math.pow/log in the sample loop.
 * ========================================================================== */

'use strict';

const TWO_PI = 2 * Math.PI;

/* The twelve centres of the per-song corrective EQ, in hertz. They are the same
 * numbers assets/js/dsp-utils.js measures the bands at (EQ_CENTERS) — the curve
 * is computed on exactly the frequencies it is applied to — and they are
 * log-spaced ≈0.68 octave apart at Q 1.4, so neighbouring bands overlap into a
 * smooth curve instead of twelve separate bumps. */
const CEQ_F = [50, 80, 125, 200, 320, 500, 800, 1250, 2000, 3200, 5000, 8000];
const CEQ_Q = 1.4;

/* Output ceiling: the final safety stage saturates at 0.9975 (−0.02 dBFS), so a
 * 16-bit export can never pin a sample at the rail, whatever the input does. */
const KNEE = 0.94;
const CEILING = 0.9975;
const RANGE = CEILING - KNEE;

/* ---------------------------------------------------------------- synthesis
 * Overall mix of the two harmonic generators per unit of their parameter
 * (0…1). These are the calibrated numbers behind "even at 100 % it never
 * sounds processed": the *rendered* envelope they must produce is asserted in
 * tests/tuning.test.js, so they cannot be changed by accident.
 * -------------------------------------------------------------------------- */
const EXC_MIX = 2.8;
const AIR_MIX = 1.0;

/* -------------------------------------------------------------------------- */
/* small math helpers                                                          */
/* -------------------------------------------------------------------------- */

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

/** Cheap, monotonic tanh approximation (max error ≈ 1.2e-3, ~3× faster). */
function ftanh(x) {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 + 1e-12), 0, 1);
  return t * t * (3 - 2 * t);
}

/* -------------------------------------------------------------------------- */
/* biquad (transposed direct form II, RBJ cookbook)                            */
/* -------------------------------------------------------------------------- */

class Biquad {
  constructor() { this.reset(); this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; }
  reset() { this.z1 = 0; this.z2 = 0; }
  _norm(b0, b1, b2, a0, a1, a2) {
    const inv = 1 / a0;
    this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv;
    this.a1 = a1 * inv; this.a2 = a2 * inv;
  }
  setLowpass(sr, f, q) {
    const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    this._norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  setHighpass(sr, f, q) {
    const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    this._norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  setBandpass(sr, f, q) {
    const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    this._norm(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }
  setPeak(sr, f, q, gainDb) {
    const A = Math.pow(10, gainDb / 40);
    const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    this._norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  setLowShelf(sr, f, q, gainDb) {
    const A = Math.pow(10, gainDb / 40);
    const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
    const c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
    const sq = 2 * Math.sqrt(A) * al;
    this._norm(A * ((A + 1) - (A - 1) * c + sq), 2 * A * ((A - 1) - (A + 1) * c),
      A * ((A + 1) - (A - 1) * c - sq), (A + 1) + (A - 1) * c + sq,
      -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sq);
  }
  setHighShelf(sr, f, q, gainDb) {
    const A = Math.pow(10, gainDb / 40);
    const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
    const c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
    const sq = 2 * Math.sqrt(A) * al;
    this._norm(A * ((A + 1) + (A - 1) * c + sq), -2 * A * ((A - 1) + (A + 1) * c),
      A * ((A + 1) + (A - 1) * c - sq), (A + 1) - (A - 1) * c + sq,
      2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sq);
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/* -------------------------------------------------------------------------- */
/* control-rate helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Envelope follower. `decim` makes it control-rate: the internal math only runs
 * every `decim` samples (time constants stay correct), which is inaudible for
 * envelopes but considerably cheaper.
 */
/**
 * RMS over the last `n` samples — the *exact* measurement the analyser makes of
 * the same two bands (it integrates 2048 samples of the filtered signal per
 * frame). An envelope follower was the obvious way to key a gate, and with a
 * 3 ms/70 ms pair it keys transients nicely — but it reads peak-ish levels of
 * the band, not the band's level, so a threshold measured as a band RMS in the
 * analyser and applied to an envelope in the worklet meant two different numbers
 * with an arbitrary constant between them. Both sides now integrate the same
 * window of the same band, so "the top end is 9 dB above where this recording
 * sits when it is quiet" is a statement that actually transfers.
 */
class SlidingRms {
  constructor(n) {
    this.n = n;
    this.buf = new Float32Array(n);
    this.i = 0;
    this.sum = 0;
    this.v = 0;
  }
  reset() { this.buf.fill(0); this.i = 0; this.sum = 0; this.v = 0; }
  tick(x) {
    const q = x * x;
    this.sum += q - this.buf[this.i];
    this.buf[this.i] = q;
    this.i++;
    if (this.i >= this.n) this.i = 0;
    this.v = Math.sqrt(Math.max(this.sum, 0) / this.n);
    return this.v;
  }
}

class EnvFollower {
  constructor(sr, attackSec, releaseSec, decim) {
    this.d = decim || 1;
    this.n = 0;
    this.v = 0;
    this.set(sr, attackSec, releaseSec);
  }
  set(sr, attackSec, releaseSec) {
    const r = sr / this.d;
    this.aa = Math.exp(-1 / (r * Math.max(attackSec, 1e-5)));
    this.rr = Math.exp(-1 / (r * Math.max(releaseSec, 1e-5)));
  }
  tick(x) {
    if (this.n > 0) { this.n--; return this.v; }
    this.n = this.d - 1;
    const c = x > this.v ? this.aa : this.rr;
    this.v = x + c * (this.v - x);
    return this.v;
  }
}

/**
 * Linearly interpolated control signal: the target is set at control rate,
 * the output is read every sample (removes any zipper noise).
 */
class Ramp {
  constructor(decim, initial) {
    this.d = decim; this.n = 0; this.v = initial || 0; this.t = initial || 0; this.step = 0;
  }
  reset(v) { this.v = v; this.t = v; this.n = 0; this.step = 0; }
  set(target) { this.t = target; }
  /** call once per sample */
  tick() {
    if (this.n <= 0) { this.n = this.d; this.step = (this.t - this.v) / this.d; }
    this.n--;
    this.v += this.step;
    return this.v;
  }
}

/* -------------------------------------------------------------------------- */
/* DC blocker                                                                  */
/* -------------------------------------------------------------------------- */

class DCBlocker {
  constructor(sr, fc) { this.r = Math.exp(-TWO_PI * (fc || 16) / sr); this.reset(); }
  reset() { this.x1 = 0; this.y1 = 0; }
  process(x) {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x; this.y1 = y;
    return y;
  }
}

/* -------------------------------------------------------------------------- */
/* dynamic de-resonator (per probing band)                                     */
/* -------------------------------------------------------------------------- */

const RESO_DECIM = 8;

class ResoBand {
  constructor(sr, freq, q) {
    this.bp = new Biquad();
    this.bp.setBandpass(sr, freq, q);
    this.env = new EnvFollower(sr, 0.004, 0.070, RESO_DECIM);
    this.avg = new EnvFollower(sr, 0.700, 0.700, RESO_DECIM);
    this.ramp = new Ramp(RESO_DECIM, 1);
    this.sense = 1.15;   // how far above the running average counts as "ringing"
    this.depth = 0;
    this.band = 0;
    this.g = 1;
  }
  reset() {
    this.bp.reset(); this.env.v = 0; this.avg.v = 0; this.ramp.reset(1);
    this.band = 0; this.g = 1;
  }
  /**
   * @returns {number} per-sample interpolated gain for the band signal;
   * the caller removes the excess energy with  y -= band * (1 - gain)
   */
  tick(x) {
    const b = this.bp.process(x);
    this.band = b;
    if (this.depth <= 0.0001) { this.g = 1; this.ramp.reset(1); return 1; }
    const e = this.env.tick(b < 0 ? -b : b);
    const a = this.avg.tick(e);
    let G = 1;
    if (a > 1e-7) {
      const over = e / (a * this.sense);
      if (over > 1) {
        const target = 1 / Math.sqrt(over);          // energy-matched target
        const x = 1 - Math.min(1, target);           // how far it must come down
        // concave law: decisive on real ringing, gentle in between
        G = 1 - this.depth * (x * 0.35 + Math.sqrt(x) * 0.65);
      }
    }
    this.ramp.set(G);
    this.g = this.ramp.tick();
    return this.g;
  }
}

/* -------------------------------------------------------------------------- */
/* harmonic exciter band (band-limit → saturate → re-band-limit)               */
/* -------------------------------------------------------------------------- */

const EXC_DECIM = 8;

/**
 * Ceiling of the harmonic generator, relative to the band it is fed from.
 * The generated overtones may reach this fraction of the source band's own
 * envelope (+0 dB = as loud as the band itself). Beyond that the exciter stops
 * being a restorer and starts being an effect. Because the ceiling follows the
 * source, it holds for any parameter setting, any preset and any material.
 */
const EXC_CAP = 0.85;

class ExciterBand {
  constructor(sr, inFreq, inQ, outFreq, outQ) {
    this.pre = new Biquad(); this.pre.setBandpass(sr, inFreq, inQ);
    this.post = new Biquad(); this.post.setBandpass(sr, outFreq, outQ);
    this.env = new EnvFollower(sr, 0.008, 0.090, EXC_DECIM);
    this.sig = 0;
    this.prog = 0;
    this.gLo = 0;
    this.gInv = 1;
  }
  reset() { this.pre.reset(); this.post.reset(); this.env.v = 0; this.sig = 0; this.prog = 0; }
  /** programme-presence gate: harmonics follow the music, never the noise */
  setNoise(noiseLin, refLin) {
    // Harmonic generation follows the music. The reference is the measured
    // noise floor, and it is capped so a noisy estimate can never mute the
    // effect — but the cap is *relative to the file's own peak* (see `refDb`).
    // Absolute, a cap at 0.02 bites only on a loud file: on the vinyl fixture
    // the reference came out 0.0214 at full scale and 0.002 14 at −20 dBFS, so
    // the gate sat at a different level *relative to the music* and the same
    // dose generated a measurably different amount of harmonics (−44 dB
    // between the two renders). For a file at full scale `refLin` is 1 and the
    // cap is exactly the old 0.02.
    this.gLo = clamp(noiseLin * 1.5, 1e-6, 0.02 * refLin);
    this.gInv = 1 / Math.max(this.gLo * 5.0, 1e-9);
  }
  /** @returns {number} generated harmonic signal */
  tick(x, drive, even) {
    const s = this.pre.process(x);
    const m = s < 0 ? -s : s;
    const e = this.env.tick(m);
    if (this.env.n === EXC_DECIM - 1) this.prog = smoothstep(this.gLo, this.gLo + 1 / this.gInv, e);
    this.sig = e;
    // Level-normalise the *input* of the nonlinearity (see AirSynth.tick): the
    // harmonics are then generated from a band signal of defined level and
    // scaled back by the band envelope, so the same parameter setting means the
    // same thing on a quiet and on a loud master.
    const norm = this.prog / Math.max(e, this.gLo * 4);
    const sn = s * norm;                     // ≈ ±1 sized band signal
    // odd harmonics (3f, 5f…) from symmetric saturation,
    // even harmonics (2f, 4f…) from the signed-square branch
    const odd = ftanh(sn * drive);
    const ev = sn * (sn < 0 ? -sn : sn) * 1.35;
    let h = this.post.process(odd * (1 - even * 0.75) + ev * (even * 1.15)) * e;
    // memoryless, source-referenced ceiling (see EXC_CAP): transparent below
    // the ceiling, asymptotic above it, and never louder than EXC_CAP × band
    const cap = e * EXC_CAP;
    if (cap > 1e-12) {
      const ah = h < 0 ? -h : h;
      if (ah > cap * 0.25) h = h / (1 + (ah - cap * 0.25) / (cap * 1.75));
    } else h = 0;
    return h;
  }
}

/* -------------------------------------------------------------------------- */
/* air synthesizer (8–16 kHz regenerator) with de-esser                        */
/* -------------------------------------------------------------------------- */

const AIR_DECIM = 8;

/**
 * Ceiling of the air synthesiser (8–16 kHz), relative to the 4.5–7.5 kHz band
 * it derives from. This single number is what keeps a dull 1960s recording from
 * being turned into a bright, fizzy modern one: when the source has almost
 * nothing left up there, there is almost nothing to derive from, and the
 * synthesiser stays quiet instead of inventing a top end. −6 dB ≈ 0.5.
 */
const AIR_CAP = 0.5;

class AirSynth {
  constructor(sr) {
    // Two harmonic sources so the 8–16 kHz band can be rebuilt even from very
    // dull material:
    //   • high band (≈4.6–7.5 kHz) → squared → 2nd order harmonics = 9–15 kHz
    //   • low  band (≈2.2–5.0 kHz) → cubed  → 3rd order harmonics = 6.6–15 kHz
    this.sr = sr;
    this.pre = new Biquad(); this.pre.setBandpass(sr, 6000, 0.85);
    this.preLo = new Biquad(); this.preLo.setBandpass(sr, 3300, 0.55);
    this.hp = new Biquad(); this.hp.setHighpass(sr, 8200, 0.60);
    this.lp = new Biquad(); this.lp.setLowpass(sr, Math.min(15500, sr * 0.42), 0.707);
    this.srcHz = 0;
    this.deess = new Biquad(); this.deess.setBandpass(sr, 6600, 1.3);
    this.env = new EnvFollower(sr, 0.004, 0.070, AIR_DECIM);   // presence
    this.dEnv = new EnvFollower(sr, 0.004, 0.070, AIR_DECIM);  // sibilance (fast)
    this.dAvg = new EnvFollower(sr, 0.400, 0.400, AIR_DECIM);  // sibilance (slow)
    this.dRamp = new Ramp(AIR_DECIM, 1);
    this.prog = 0;
    this.gLo = 0;
    this.gInv = 1;
  }
  reset() {
    this.pre.reset(); this.preLo.reset(); this.hp.reset(); this.lp.reset();
    this.deess.reset(); this.env.v = 0; this.dEnv.v = 0; this.dAvg.v = 0;
    this.dRamp.reset(1); this.prog = 0;
  }
  setNoise(noiseLin, refLin) {
    // …capped relative to the file's own peak for the same reason as the
    // exciter's (see above): an absolute cap is a level-dependent policy.
    this.gLo = clamp(noiseLin * 1.5, 1e-6, 0.02 * refLin);
    this.gInv = 1 / Math.max(this.gLo * 5.0, 1e-9);
  }
  /**
   * Where to derive from. A bitrate low-pass cuts the spectrum at its own
   * cliff, and the fixed 6 kHz band sits above the cliff on a very low bitrate
   * file — there is nothing left there to derive anything from. The law passes
   * the measured cliff, so the synthesizer always works from the band that
   * survived.
   */
  setSource(hz) {
    // a non-finite source frequency would poison every coefficient below
    const f = Math.min(6000, Math.max(2200, isFinite(hz) ? hz : 6000));
    if (f === this.srcHz) return;
    this.srcHz = f;
    this.pre.setBandpass(this.sr, f, 0.85);
    this.preLo.setBandpass(this.sr, f * 0.55, 0.55);
  }
  /** de-essing gain: ducks synthesis on hot sibilance */
  control(x) {
    const s = this.deess.process(x);
    const e = this.dEnv.tick(s < 0 ? -s : s);
    const a = this.dAvg.tick(e);
    let g = 1;
    if (a > 1e-7) {
      const over = e / (a * 3.0);
      if (over > 1) g = clamp(1 / Math.sqrt(over), 0.35, 1);
    }
    this.dRamp.set(g);
    return this.dRamp.tick();
  }
  /** @returns {number} regenerated 8–16 kHz signal
   *  @param {number} room how far above the source band the result may reach */
  tick(x, drive, room) {
    const sHi = this.pre.process(x);
    const sLo = this.preLo.process(x);
    const mag = (sHi < 0 ? -sHi : sHi) + 0.65 * (sLo < 0 ? -sLo : sLo);
    const e = this.env.tick(mag);
    if (this.env.n === AIR_DECIM - 1) this.prog = smoothstep(this.gLo, this.gLo + 1 / this.gInv, e);

    // ── level-normalised harmonic generation ──────────────────────────────
    // Squaring a band produces a signal whose level is the *square* of the
    // input level; cubing it, the cube. Left as-is, how much air is generated
    // depends on how loud the material is — which is what made a dull recording
    // suddenly sound brighter than a loud one, and what forced the old design
    // into heavy limiting. Normalising the band signal first and scaling the
    // harmonics back by the band envelope makes the generated band a fixed
    // ratio of the band it came from: same dB, loud or quiet.
    const norm = this.prog / Math.max(e, this.gLo * 4);
    const nHi = sHi * norm;                        // ≈ ±1 sized band signal
    // modest pre-boost before cubing: the 3rd-order products are what reach
    // 8–16 kHz when the source is dull, and the output band pass discards the
    // low-order products that the boost also creates
    let nLo = sLo * norm * 2.2;
    if (nLo > 1.5) nLo = 1.5; else if (nLo < -1.5) nLo = -1.5;
    const h2 = nHi * nHi * 1.7;                    // 2nd order harmonics
    const h3 = nLo * nLo * nLo * 1.15;             // 3rd order harmonics
    let d = (h2 + h3) * drive * e;
    if (d > 4) d = 4; else if (d < -4) d = -4;     // safety clamp
    let y = this.lp.process(this.hp.process(d));
    // Source-referenced ceiling: the synthesised band may never grow louder than
    // AIR_CAP × the band it was derived from. Transparent below a quarter of the
    // ceiling; above it the limiter is memoryless, so it cannot pump.
    // `room` is a rate parameter: a missing or non-finite value must fall back
    // to the shipped ceiling rather than switch the band off (NaN × e = NaN,
    // and the branch below would then return silence)
    const roomCap = isFinite(room) ? room : AIR_CAP;
    const cap = e * roomCap;
    if (cap > 1e-12) {
      const ay = y < 0 ? -y : y;
      if (ay > cap * 0.25) y = y / (1 + (ay - cap * 0.25) / (cap * 1.75));
    } else y = 0;
    return y;
  }
}

/* -------------------------------------------------------------------------- */
/* neural air curve (Stage 7 coupling): applies a dB correction curve that a   */
/* separate, optional neural model predicted offline, on top of the DSP air   */
/* synthesiser above. It never generates a waveform of its own — only a small */
/* fixed bank of peaking filters shaped by numbers that arrive over the port  */
/* — so the existing phase-correct AirSynth stays the only thing that puts    */
/* energy into 8–24 kHz; this stage can only re-shape it.                     */
/* -------------------------------------------------------------------------- */

/** Fixed application points, independent of whatever bands the model used. */
const NEURAL_AIR_BANDS = [8000, 10000, 12500, 16000, 19000, 22000];
const NEURAL_AIR_Q = 1.1;
/** A prediction error may never do more damage than a gentle shelf could. */
const NEURAL_AIR_MAX_DB = 12;

/** Linear interpolation of an arbitrary (possibly unsorted) curve at `f`. */
function interpCurve(xs, ys, f) {
  const n = xs.length;
  if (!n) return 0;
  if (n === 1) return ys[0];
  // assume xs is ascending (true for every caller in this file); degrade to
  // a linear scan rather than requiring the caller to pre-sort
  if (f <= xs[0]) return ys[0];
  if (f >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i++) {
    if (f <= xs[i]) {
      const x0 = xs[i - 1], x1 = xs[i];
      const t = x1 > x0 ? (f - x0) / (x1 - x0) : 0;
      return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
    }
  }
  return ys[n - 1];
}

class NeuralAirCurve {
  constructor(sr) {
    this.sr = sr;
    // Nyquist-safe subset: at 44.1/48 kHz all six survive, lower rates drop
    // the ones that would sit above setPeak's own clamp.
    this.bands = NEURAL_AIR_BANDS.filter((f) => f < sr * 0.47);
    this.filters = this.bands.map(() => new Biquad());
    this.gains = new Float32Array(this.bands.length); // all-zero == identity
    this.active = false; // only a curve with a non-trivial gain sets this
  }
  reset() { for (const b of this.filters) b.reset(); }
  /**
   * @param {number[]} bandsHz centres the curve was predicted at (any count,
   *   any spacing — the neural worker's own band choice)
   * @param {number[]} gainsDb matching dB correction at each centre
   */
  setCurve(bandsHz, gainsDb) {
    if (!Array.isArray(bandsHz) || !Array.isArray(gainsDb) || !bandsHz.length || bandsHz.length !== gainsDb.length) {
      this.active = false;
      return;
    }
    let any = false;
    for (let i = 0; i < this.bands.length; i++) {
      let g = interpCurve(bandsHz, gainsDb, this.bands[i]);
      if (!isFinite(g)) g = 0;
      g = clamp(g, -NEURAL_AIR_MAX_DB, NEURAL_AIR_MAX_DB);
      this.gains[i] = g;
      if (Math.abs(g) > 0.01) any = true;
      this.filters[i].setPeak(this.sr, this.bands[i], NEURAL_AIR_Q, g);
    }
    this.active = any;
  }
  /**
   * @param {number} x
   * @param {number} amount 0..1 trust dial (the `airNeural` parameter): 0 is
   *   bit-identical to the curve never having arrived at all.
   */
  tick(x, amount) {
    if (!this.active || !(amount > 0.0001)) return x;
    let y = x;
    for (const b of this.filters) y = b.process(y);
    return x + (y - x) * amount;
  }
}

/* -------------------------------------------------------------------------- */
/* sub-harmonic synthesizer (octave down, lands in 30–60 Hz)                   */
/* -------------------------------------------------------------------------- */

const SUB_DECIM = 4;

/**
 * Level of the synthesised sub octave, as a share of the tracked bass band's
 * envelope. 0.55 is roughly a "half again as much bottom" mix; the point is
 * that it *follows the source* instead of being an absolute oscillator level
 * that slams on quiet bass and disappears on loud bass.
 */
const SUB_CAP = 0.70;

class SubSynth {
  constructor(sr) {
    this.sr = sr;
    // steep 6th-order guard so pitch tracking only ever sees the bass fundamental
    this.lp1 = new Biquad(); this.lp1.setLowpass(sr, 95, 0.54);
    this.lp2 = new Biquad(); this.lp2.setLowpass(sr, 95, 0.707);
    this.lp3 = new Biquad(); this.lp3.setLowpass(sr, 95, 1.31);
    this.outLP = new Biquad(); this.outLP.setLowpass(sr, 88, 0.707);
    this.srcHz = 95;
    this.env = new EnvFollower(sr, 0.006, 0.150, SUB_DECIM);
    this.gate = new Ramp(SUB_DECIM, 0);
    this.phase = 0;
    this.freq = 55;
    this.fTarget = 55;
    this.schmitt = 0;
    this.counter = 0;
    this.gLo = 1e-5;
  }
  reset() {
    this.lp1.reset(); this.lp2.reset(); this.lp3.reset(); this.outLP.reset();
    this.env.v = 0; this.gate.reset(0); this.phase = 0; this.schmitt = 0;
  }
  setNoise(noiseLin) { this.gLo = Math.max(noiseLin * 2.5, 1e-6); }
  /**
   * Where to look for the fundamental. 95 Hz is the design corner: that is
   * where a recording's own fundamental lives, and looking higher would double
   * the second harmonic of a normal bass line. A recording whose bottom octave
   * is *empty* has nothing there to track, so the corner moves up to the band
   * that does carry the bass — its octave (200 Hz → 100 Hz) is then a note the
   * recording can actually carry. Measured on a file high-passed at 200 Hz:
   * at the fixed corner the synthesiser stayed silent (34–58 Hz −96.7 → −95.9
   * dBFS); from 240 Hz it fills 60–200 Hz by 5.4 dB.
   */
  setSource(hz) {
    const f = Math.max(60, Math.min(260, hz || 95));
    if (Math.abs(f - this.srcHz) < 0.5) return;
    this.srcHz = f;
    this.lp1.setLowpass(this.sr, f, 0.54);
    this.lp2.setLowpass(this.sr, f, 0.707);
    this.lp3.setLowpass(this.sr, f, 1.31);
    this.outLP.setLowpass(this.sr, f * 0.93, 0.707);
  }
  /** @returns {number} sub-harmonic signal at one octave below the bass */
  tick(x, ratio) {
    const s = this.lp3.process(this.lp2.process(this.lp1.process(x)));
    const e = this.env.tick(s < 0 ? -s : s);

    // Schmitt-trigger pitch tracking on the isolated bass band
    const hyst = Math.max(e * 0.35, this.gLo * 0.5);
    this.counter++;
    if (this.schmitt === 0 && s > hyst) { this.schmitt = 1; this._edge(); }
    else if (this.schmitt === 1 && s < -hyst) { this.schmitt = 0; this._edge(); }
    // glide toward the tracked note (stable on note changes)
    this.freq += (this.fTarget - this.freq) * 0.0012;
    this.gate.set(smoothstep(this.gLo, this.gLo * 3.0, e));
    const f = clamp(this.freq * ratio, 22, 95);
    this.phase += TWO_PI * f / this.sr;
    if (this.phase > TWO_PI) this.phase -= TWO_PI;
    const g = this.gate.tick();
    if (g <= 1e-5) return 0;
    // Source-referenced level: the synthesised octave follows the tracked bass
    // envelope, so a recording whose bottom octave is already intact can never
    // receive a second, louder one. SUB_CAP is the sub's share of the bass band.
    const amp = e * SUB_CAP;
    return this.outLP.process(Math.sin(this.phase) * amp) * g;
  }
  _edge() {
    const period = this.counter;
    this.counter = 0;
    if (period < 4 || period > this.sr) return;
    const f = 1 / (2 * (period / this.sr));           // fundamental of the bass note
    if (f > 18 && f < 250) this.fTarget = clamp(f, 30, 160);
  }
}

/* -------------------------------------------------------------------------- */
/* De-esser: dynamic sibilance control (see the class below)                    */
/* -------------------------------------------------------------------------- */

/**
 * How long a detected sibilant stays corrected, in milliseconds.
 *
 * The gate is a fast/slow ratio of the 5.2–9.5 kHz band: the fast envelope
 * (2 ms attack, 30 ms release) against the slow one (60 ms attack, 250 ms
 * release). That catches the *onset* of an "s" and nothing else — inside a real
 * sibilant, which lasts 60–150 ms, the slow envelope catches up within ~60 ms,
 * the ratio drops back under `sense` and the correction stops. Measured on a
 * fixture with 120 ms "s" bursts 8 dB above the trend: at dose 0.45 the burst's
 * own band level moved by 0.15 dB (acceptance matrix, sibilance row) — the stage
 * was correcting the first third of every "s" and letting the rest through.
 *
 * The hold keeps the last detected cut alive for the length of a sibilant, so
 * the whole "s" is tamed, and releases over `DEESS_REL_MS` afterwards so the
 * gain cannot step and click. It only ever extends a correction that the ratio
 * key asked for: music with no sibilance never triggers it.
 */
const DEESS_HOLD_MS = 140;
const DEESS_REL_MS = 60;
/** Attack of the *filter gain* (not of the detector), in milliseconds. */
const DEESS_ATK_MS = 3;
/** Length of one detector frame, in milliseconds — the same window the analyser
 *  uses for `sibPeakDb`, so stage and measurement answer the same question. */
const DEESS_FRAME_MS = 10;
/** How long the file's own band ratio is averaged over, in seconds. */
const DEESS_AVG_SEC = 2;
/** dB above that average where a frame starts to count, and the dB at which the
 *  correction is complete. */
const DEESS_TRIG_DB = 1.5;
const DEESS_FULL_DB = 5;
/** The repaired band: two peaks rather than one. A single peak wide enough to
 *  cover 5.2–9.5 kHz (Q ≈ 0.85) reaches down to 3 kHz and dulls the vocal body
 *  by a decibel during every "s" (measured); a single peak narrow enough to
 *  leave 3–4 kHz alone (Q ≈ 1.5) misses a third of the band. Two narrower peaks
 *  cover it between them with less spill on either side. */
const DEESS_HZ = 6400;
const DEESS_HZ2 = 8800;
const DEESS_Q = 1.3;
/** dB of cut in each of the two peaks, at full dose and a fully triggered
 *  detector. Twice the peak count of a single-band de-esser is not twice the
 *  cut: the band's average attenuation across 5–10 kHz comes out at roughly a
 *  third of this figure, which is the number the acceptance matrix measures. */
const DEESS_MAX_DB = 15;

/**
 * Sibilance is not a level, it is a *ratio*: the 5–9.5 kHz band sitting well
 * above the level that band has been holding. That is why this stage is keyed
 * on the fast/slow ratio of its own band and not on an absolute threshold — a
 * quiet "s" and a loud "s" are the same problem, and the stage treats them
 * alike, whatever the recording's level is.
 *
 * The repair is subtractive: the band is measured, a gain is computed for it,
 * and that much of the band is taken out of the signal. Nothing outside
 * 5–9.5 kHz is touched, so a de-essed vocal keeps its body and only loses the
 * spit. The amount comes from the measurement (how sibilant this song actually
 * is); the gate comes from the ratio, so a song with no sibilance pays nothing.
 */
class DeEsser {
  constructor(sr) {
    this.sr = sr;
    /* Detector: two bands, 5.2–9.5 kHz and the 2.4–4 kHz "body" region, compared
     * per 10 ms frame. Sibilance is a *balance* defect — an "s" is the top band
     * standing well above the file's own body — and the comparison is what makes
     * the detector specific. Two earlier versions keyed on the sibilance band
     * alone, first as a fast/slow envelope ratio and then with a hold on top of
     * it, and both measured the same wrong thing: any transient in the band is a
     * fast/slow excess. With the real auto parameters on the acceptance fixture
     * the stage was active 79 % of the time on material whose "s" bursts occupy
     * 12 %, and it took the file's whole top end down with it (the analyser's
     * median sibilance excess went from +1.1 dB to −0.4 dB: a de-esser that
     * dulls a recording is not a repair).
     *
     * The ratio is measured against *the file's own typical ratio*, tracked over
     * ~2 s. A singer's "s" stands 6–10 dB above that; broadband hiss raises both
     * bands and leaves the ratio alone; a moving envelope moves both bands with
     * it. This mirrors the analyser's `sibPeakDb`, which is the number the dose
     * is computed from, so the stage and the measurement answer the same
     * question. */
    this.hiB = new Biquad(); this.hiB.setBandpass(sr, 7000, 0.9);
    this.refB = new Biquad(); this.refB.setBandpass(sr, 3200, 0.9);
    this.frame = Math.max(64, Math.round(sr * DEESS_FRAME_MS / 1000));
    this.n = 0;
    this.sumHi = 0;
    this.sumRef = 0;
    /* the file's own balance, ~2 s, updated once per frame */
    this.slowDb = null;
    this.slowCoef = Math.exp(-1 / Math.max(1, 100 * DEESS_AVG_SEC));
    this.cut = 0;
    this.hold = 0;
    this.holdLen = Math.max(1, Math.round(sr * DEESS_HOLD_MS / 1000));
    /* −80 dBFS of band level: below that the "ratio" is the noise floor's shape */
    this.slowFloor = -80;
    this.relCoef = Math.exp(-1 / Math.max(1, sr * DEESS_REL_MS / 1000));
    this.atkCoef = Math.exp(-1 / Math.max(1, sr * DEESS_ATK_MS / 1000));
    this.peak = new Biquad();
    this.peak2 = new Biquad();
    this.gDb = 0;
    this.lastDb = null;
    this.applied = 0;
  }
  reset() {
    this.hiB.reset(); this.refB.reset(); this.peak.reset(); this.peak2.reset();
    this.n = 0; this.sumHi = 0; this.sumRef = 0;
    this.slowDb = null; this.cut = 0; this.hold = 0;
    this.gDb = 0; this.lastDb = null; this.applied = 0;
  }
  tick(x, amount) {
    if (amount <= 0.0001) {
      if (this.gDb !== 0) {
        this.gDb = 0;
        this.peak.setPeak(this.sr, DEESS_HZ, DEESS_Q, 0);
        this.peak2.setPeak(this.sr, DEESS_HZ2, DEESS_Q, 0);
        this.lastDb = 0;
      }
      this.cut = 0; this.hold = 0;
      return x;
    }
    /* ---- detection, once per 10 ms frame ---- */
    const h = this.hiB.process(x);
    const r = this.refB.process(x);
    this.sumHi += h * h;
    this.sumRef += r * r;
    if (++this.n >= this.frame) {
      const hiDb = 10 * Math.log10(this.sumHi / this.n + 1e-20);
      const refDb = 10 * Math.log10(this.sumRef / this.n + 1e-20);
      const ratio = hiDb - refDb;
      if (this.slowDb === null) this.slowDb = ratio;
      else this.slowDb = ratio + this.slowCoef * (this.slowDb - ratio);
      /* the body band has to be doing something, or the ratio is just the noise
       * floor's shape; and the excess has to clear the estimate's own noise */
      let target = 0;
      if (refDb > this.slowFloor && this.slowDb !== null) {
        const excess = ratio - this.slowDb;
        target = clamp((excess - DEESS_TRIG_DB) / DEESS_FULL_DB, 0, 1);
      }
      if (target > 0) {
        if (target > this.cut) this.cut = target;
        this.hold = this.holdLen;
      } else if (this.hold > 0) {
        this.hold -= this.frame;
      } else {
        this.cut = 0;
      }
      this.n = 0; this.sumHi = 0; this.sumRef = 0;
    } else if (this.hold > 0) {
      this.hold--;
    } else if (this.cut > 0) {
      this.cut *= this.relCoef;
    }
    /* ---- the gain, and the filter it drives ---- */
    this.applied = -amount * this.cut * DEESS_MAX_DB;
    const c = this.applied < this.gDb ? this.atkCoef : this.relCoef;
    this.gDb = this.applied + c * (this.gDb - this.applied);
    if (this.lastDb === null || Math.abs(this.gDb - this.lastDb) > 0.005) {
      this.peak.setPeak(this.sr, DEESS_HZ, DEESS_Q, this.gDb);
      this.peak2.setPeak(this.sr, DEESS_HZ2, DEESS_Q, this.gDb);
      this.lastDb = this.gDb;
    }
    return this.peak2.process(this.peak.process(x));
  }
}

/* -------------------------------------------------------------------------- */
/* HF de-hiss: linkwitz-riley 4th order split + downward expander              */
/* -------------------------------------------------------------------------- */

const HISS_DECIM = 8;
/**
 * How fast the de-hisser's gate may *follow its own key*.
 *
 * Both are time constants on the correction (the dB the gate takes out), applied
 * at the decimated update rate. Closing is slower than opening — but it used to
 * be 250 ms on an argument about *pops*: the key is a 2048-sample (43 ms)
 * sliding RMS of 4–16 kHz, and a pop is a broadband burst whose energy
 * *dominates that window* out of all proportion to its length (twenty samples at
 * full scale against 2048 of music at −34 dB: +14 dB of apparent tilt for 43 ms),
 * so a gate that follows its key sample-by-sample slams shut at every pop and
 * leaves a 43 ms hole: measured then, 38 HF frames above 15 dB of crest against 3
 * with the de-hisser off.
 *
 * That measurement was taken with the de-hisser *in front* of the de-clicker.
 * Since the order was turned around ("noise repair, most impulsive first" — see
 * process()), a pop no longer reaches this key as a bare spike: the level term
 * vetoes the tilt term's spike anyway (a burst drives `e` above t1, lvl → 1,
 * cutLevel → 0, and the *smaller* of the two wins), and the de-clicker repairs
 * what is left *behind* this stage. Re-measured on the same fixture the old
 * claim used — a vinyl simulation with 108 injected pops — the pop witnesses are
 * identical at 60 ms, at 250 ms and with the de-hisser switched off: the HF crest
 * witness is 101 frames on the upload and **1** after the chain, and the
 * independent pop meter (its own RBJ 4 kHz band at the fixture's own pop
 * positions) reads **−15.66 dB** over the clean copy. What the closing lag still
 * costs is the repair itself — measured on the hiss fixtures at the doses the
 * law asks for, as the band the repair owns:
 *
 *   close      100 ms of gate lag    hiss-owned band   music-owned   loud
 *   250 ms      (as it was)                  6.06 dB      −0.02 dB   −0.24 dB
 *   120 ms                                   7.26         +0.07      −0.24
 *    60 ms      (as it is now)               7.94         +0.18      −0.23
 *    30 ms                                   8.32         +0.30      −0.23
 *
 * — +1.9 dB of the noise for ≤0.2 dB of the music's own top end in frames the
 * noise does not own, and nothing else moves. Opening has to stay fast (8 ms):
 * opening is what keeps a musical transient from being dulled.
 */
const HISS_CLOSE_MS = 60;
const HISS_OPEN_MS = 8;
/**
 * The band the top end is compared with when looking for hiss (700 Hz – 3 kHz).
 * The analyser measures the *same* two bands — 4–16 kHz against this one — so the
 * tilt difference it reports is a number this stage can subtract. They have to
 * stay in step: see HISS_MID_HZ in assets/js/dsp-utils.js.
 */
const HISS_MID_HZ = 1450;
const HISS_MID_Q = 0.63;
/** Lower edge of the band the analyser measures as "the top end" (4–16 kHz). */
const HISS_KEY_HZ = 4000;
/**
 * How much of the requested cut the floor regime delivers as a *shelf* above the
 * repair corner, on top of what the split can do.
 *
 * The split cannot deliver the amount it asks for, and the reason is structural:
 * `low + high` is the Linkwitz-Riley allpass, so `low + high·g` also sums back a
 * *unit-magnitude copy* of the whole signal at the gate's gain, and the low
 * branch's remainder subtracts from it. Measured as a static transfer with the
 * gate held closed (probe hiss13, white noise at the floor, request −22 dB):
 * −5.8 dB at 4 kHz, −10.3 at 6 kHz, −13.8 at 8 kHz, −18.1 at 12 kHz — 26 %, 47 %,
 * 63 %, 82 % of the request, with the deficit concentrated right above the
 * crossover, which is where the hiss of a worn record actually sits. A steeper
 * split (LR8) buys 1.0–1.4 dB at 6–8 kHz, a lower crossover 0–1 dB on the worn
 * record: neither is the lever (probe hiss10).
 *
 * Making the split steeper is therefore not the lever. On the §2 acceptance
 * fixture's own pause frames (probe hiss24, median per-band level over the 49
 * frames whose top end is the noise's) the chain used to leave 11 / 16 / 17 / 17
 * / 17 / 18 / 21 dB above the clean copy at 1/2/3/4/6/8/12 kHz and now leaves 9 /
 * 12 / 12 / 11 / 8 / 8 / 10 — the repair doubles where the defect lives, and the
 * app's own two numbers on the output move with it: tilt step 5.82 → 0.00 dB,
 * hissAmount 1.00 → 0.39. The fraction itself is from a 4-fixture × 4-dose sweep
 * (probe hiss19): the pause floor keeps falling until 0.75 and stops moving after
 * it, while the *tilt* of the pauses — the number the diagnosis acts on — crosses
 * the music's own tilt at 0.75 on both hard fixtures (+0.34 dB off on the
 * synthetic bed+hiss, +0.71 on the worn record) and over-corrects beyond it
 * (−2.2 / −1.2 dB, i.e. pauses duller than the music). Music frames are untouched
 * by every value: the shelf only opens where the gate has already proven there is
 * nothing but floor (see the two witnesses in tick()), and a forced dose on loud
 * continuous music comes out bit-identical to the same render with this term
 * removed (tests/dsp.test.js).
 */
const HISS_FLOOR_RATIO = 0.75;
/** Width of each mains notch, in hertz (see HumNotch.prepare). */
const HUM_BW_HZ = 3;
/** Relative floor under a de-clip run — see the run tracker in DeClipper.tick. */
const DECLIP_RUN_FLOOR = 0.985;
/** dB of notch at 100 % dose — the unit a measured mains excess is expressed in. */
const HUM_DB_PER_DOSE = 42;

class DeHiss {
  constructor(sr, xover) {
    this.sr = sr;
    this.xover = xover || 3200;
    // Linkwitz-Riley split: the low band is what is left of the signal, the
    // high band is both the gate key and what the gate attenuates. The split is
    // not free — LR4 low + high is flat in magnitude but not in phase, so
    // re-adding the two branches changes the waveform (and its peak) even when
    // the gate is wide open. tick() therefore returns the input itself when
    // there is nothing to attenuate, and uses the reconstruction only for the
    // samples that are actually being repaired.
    this.lp1 = new Biquad(); this.lp1.setLowpass(sr, xover, 0.7071);
    this.lp2 = new Biquad(); this.lp2.setLowpass(sr, xover, 0.7071);
    this.hp1 = new Biquad(); this.hp1.setHighpass(sr, xover, 0.7071);
    this.hp2 = new Biquad(); this.hp2.setHighpass(sr, xover, 0.7071);
    // The *key* is a separate, fixed band: the analyser measures the hiss tilt
    // as 4–16 kHz against a 1.45 kHz band reference, and the key here has to see
    // exactly those two bands for the measured number to mean anything. The
    // repair branch above is where the gate acts, and that one moves with the
    // measurement (setXover) — where to subtract is a per-file decision, what
    // "the top end is 7 dB above the music" means is not.
    this.k1 = new Biquad(); this.k1.setHighpass(sr, HISS_KEY_HZ, 0.707);
    this.k2 = new Biquad(); this.k2.setHighpass(sr, HISS_KEY_HZ, 0.707);
    // The gate is keyed on the *tilt* of the top end, not on its level: the
    // 1.45 kHz band rides with the programme, the 4–16 kHz band rides with it
    // too as long as it holds music — and stops riding when what is up there is
    // noise. Measuring the same two bands here as the analyser does is what makes
    // the measured number (dB of top end that is not programme) something this
    // stage can actually subtract — and *same* means the same filters, which is
    // why the mid band is two cascaded bandpasses like the analyser's `ma`/`mb`
    // and not one. A single bandpass at this Q has visibly wider skirts and its
    // upper one reaches into the 4 kHz+ band the *hiss* lives in: measured on the
    // acceptance fixture, one filter reads the quiet frames' tilt 4.38 dB lower
    // than the cascade (−1.85 dB over the whole file), i.e. the key under-asked
    // by the very noise it was looking for, and the mid band was 16 dB inflated
    // by the noise in the frames the noise owns.
    this.mid1 = new Biquad(); this.mid1.setBandpass(sr, HISS_MID_HZ, HISS_MID_Q);
    this.mid2 = new Biquad(); this.mid2.setBandpass(sr, HISS_MID_HZ, HISS_MID_Q);
    this.rmsHf = new SlidingRms(2048);       // same window as the analyser's frames
    this.rmsMid = new SlidingRms(2048);
    this.tickCount = 0;
    this.gate = new Ramp(HISS_DECIM, 1);
    this.t1 = 1e-6;
    this.inv = 1;
    this.tiltRef = 0;          // the programme's own HF − MID tilt (measured)
    this.maxCut = 0;           // how much of the top end may be taken (measured)
    this.cutDb = 0;            // the cut the gate has actually taken (smoothed, see tick)
    // the floor regime's shelf: how much of the repair is "this is only floor",
    // its gain in dB, and the last gain the coefficients were built for (the
    // filter's identity is exactly 0 dB, so a gain that has not moved by an
    // audible step needs no new coefficients)
    this.floorW = 0;
    this.shDb = 0;
    this.shApplied = 1e9;
    this.sh = new Biquad();
  }
  reset() {
    this.lp1.reset(); this.lp2.reset(); this.hp1.reset(); this.hp2.reset();
    this.k1.reset(); this.k2.reset();
    this.mid1.reset(); this.mid2.reset();
    this.sh.reset();
    this.shApplied = 1e9;
    this.floorW = 0; this.shDb = 0;
    this.rmsHf.reset(); this.rmsMid.reset();
    this.gate.reset(1);
  }
  /**
   * Move the split. The crossover is a *measurement*: a cassette's hiss starts
   * around 2.5 kHz (and so does the band that has to be sacrificed to remove
   * it), while a bright digital file with a 6 kHz floor needs the split above
   * that floor. Filter coefficients are only recomputed when it moves.
   */
  setXover(f) {
    // The measured hiss start may be anywhere up to 8 kHz, but the *repair* may
    // only extend down from the band the analyser measures the tilt in (4 kHz+,
    // see HISS_KEY_HZ): the gate is keyed on that band and the measured amount
    // belongs to it, so a split above it would subtract a number that was never
    // measured. A split below it is a genuine per-file win — tape hiss that
    // starts at 2.2 kHz is repaired from 2.2 kHz up instead of from 3.2 kHz.
    const x = clamp(f || 3200, 2000, HISS_KEY_HZ);
    if (Math.abs(x - this.xover) < 1) return;
    this.xover = x;
    this.lp1.setLowpass(this.sr, x, 0.7071); this.lp2.setLowpass(this.sr, x, 0.7071);
    this.hp1.setHighpass(this.sr, x, 0.7071); this.hp2.setHighpass(this.sr, x, 0.7071);
    // The floor regime's shelf sits on the *same* corner: the deficit it makes
    // up is the split's own (−6 dB at the corner, closing by about a dB per
    // octave above it), so a shelf anywhere else would fill a hole that is not
    // there. The gain is not touched here — the next tick rebuilds it.
    this.shApplied = 1e9;
  }
  setNoise(hfNoiseLin) {
    // The absolute reference: where the HF band sits, as an RMS of the same band
    // and the same 2048-sample window, in the passages where there is no music to
    // hide behind. It bounds the repair from below — the level term can never
    // silence music that is well above the measured noise floor, whatever the
    // tilt says.
    // The reference is a band RMS measured exactly like the key below — same
    // band, same 2048-sample window (see the analyser's hfQuietRmsDb) — so it
    // needs no *absolute* ceiling. A ceiling at 0.01 (−40 dBFS) is a policy,
    // not a sanity bound, and it changed the stage's behaviour on everything
    // louder than −49 dBFS: the reference came out up to 9× too low, the level
    // term `lvl` then read "this is music" wherever the top end sat above
    // −40 dBFS, `max(cutLevel − 6, 0)` collapsed to 0 and the gate stopped
    // cutting *at all* — in every passage, not just the loud ones. Measured on
    // one recording rendered at 0 dBFS and at −20 dBFS: with the ceiling the
    // finished files differ by −12.6 dB (rms of the difference, level-
    // normalised), without it by −33.5 dB, i.e. this one constant decided the
    // whole chain's level invariance. The stage then also did less the louder
    // the file was, which is the opposite of what a de-hisser has to do.
    // The bound that remains is a sanity bound: an HF band RMS above −6 dBFS
    // means the file is nothing but noise, and then there is no music to
    // protect and nothing to subtract.
    this.t1 = clamp(hfNoiseLin * 2.8, 1e-7, 0.5);
    this.inv = 1 / Math.max(this.t1 * 4.0, 1e-9);
  }
  /**
   * @param {number} tiltDb  the programme's own HF − MID tilt, in dB (measured)
   * @param {number} maxCutDb the measured tilt step: the most top end that may be
   *                          taken out, i.e. the amount of it that is noise
   */
  setTilt(tiltDb, maxCutDb) {
    this.tiltRef = isFinite(tiltDb) ? tiltDb : 0;
    this.maxCut = isFinite(maxCutDb) ? clamp(maxCutDb, 0, 24) : 0;
  }
  tick(x, strength) {
    if (strength <= 0.0001) { this.gate.set(1); this.gate.tick(); return x; }
    const low = this.lp2.process(this.lp1.process(x));
    const high = this.hp2.process(this.hp1.process(x));
    const e = this.rmsHf.tick(this.k2.process(this.k1.process(x)));
    const em2 = this.rmsMid.tick(this.mid2.process(this.mid1.process(x)));
    this.tickCount++;
    if (this.tickCount % HISS_DECIM === 0) {
      // How much top end is left that the programme cannot explain?
      //   · the tilt term says how much *more* top end there is than the music
      //     itself carries — in dB, so it is the repair amount directly;
      //   · the level term says how far the HF band is below the measured noise
      //     floor + 9 dB, which is what stops the stage from ever diving into
      //     music that is simply quiet;
      // the *smaller* of the two wins, which is what makes the stage transparent
      // whenever either one says "there is nothing wrong here".
      // Without a measured tilt step there is nothing to subtract *by tilt* — then
      // the level key alone decides, which is the plain expander the stage has
      // always been (and which is all that can be said about a file whose top end
      // nobody has measured).
      const tiltNow = (e > 1e-9 && em2 > 1e-9) ? 20 * Math.log10(e / em2) : this.tiltRef;
      // Without a measured tilt step there is nothing to subtract *by tilt*,
      // and the level key alone decides — the plain expander this stage has
      // always been for a caller who knows there is hiss and says so. That
      // fallback is a policy the *law* must not rely on: for a file whose top
      // end is stationary (a dull pad, a synthesizer bed) the quiet-frame floor
      // and the programme are the same number, so the level key cannot tell
      // hiss from music and would cut either way. The automatic doses therefore
      // only ask for the de-hisser when the measurement found a tilt step
      // (see presets.js) — the module keeps the expander for the manual path.
      // ── what this term cannot see (round 15, measured) ──────────────────
      // The automatic dose's depth *is* the tilt step the measurement found, and
      // this term is what decides. A *broadband* floor — a 128 kbit/s arrival's
      // own top end in a quiet passage — lifts the 4 kHz+ band and the 1.45 kHz
      // reference together, so tiltNow − tiltRef stays at 0.0 dB while the level
      // key below allows 19–20 dB of cut. The stage is therefore transparent
      // there: on the acceptance fixture's quiet-passage pop the arrival's floor
      // sits 22.2 dB above the clean copy's own top end and this stage takes
      // 1.3 dB of it at p10 and nothing at the median block. Where a frame's
      // tilt *does* sit above the reference — 0.26 s later on the same fixture —
      // the same burst comes out 15.2 dB down (window −48.1 → −63.3 dB with the
      // stage toggled). Reading it would mean a local instead of a file-wide
      // reference, i.e. a *depth* policy, not a bug fix: the automatic dose is
      // deliberately the measured step (see the dsp suite's "the floor regime
      // delivers what was measured", and the matrix rows "the arrival's own top
      // end at the pops the row above still counts"; probes wr9, wr10, wr12).
      //
      // Round 16 priced the obvious answer — let the *level* term decide on the
      // frames where this one reads nothing, capped at the measured step — and
      // it does not pay. It buys ~9 dB on the worn record's arrival floor (and
      // 0.2–0.9 dB more pause floor on the dsp hiss fixture), but the app then
      // names a *new* defect on its own exports: `dullTop` on the hiss, cassette,
      // vinyl and worn rows, which used to read `hiss`/`healthy` there. The
      // reason is structural: the level key cannot tell a top end that is quiet
      // from a top end that is *floor*, and this term is blind to a floor that
      // lifts both key bands together. Doing it properly needs a *content*
      // witness — whether the top end is shaped like programme or like noise —
      // i.e. an analyser metric, not a retune of this stage. Numbers: CHANGELOG,
      // round 16 (probes wr14/wr15; wr13 is void — an instrument slip).
      //
      // Round 17 built that content witness — the *shape* inside the key band
      // (11 kHz against 5.5 kHz, per 2048-frame) — and measured all three
      // candidates for it to the end:
      //   · it *does* separate analog hiss from programme with room to spare
      //     (+1.8 … +2.1 dB on the acceptance hiss fixture's noise-owned frames
      //     against −3.2 … −4.9 on its music-owned ones) — but it is redundant
      //     with this term: in every one of the 88 frames it opened on that
      //     fixture (87 of 87 on the worn record) `cutTilt` was already at the
      //     measured step, i.e. a flat top end *is* the tilt anomaly this term
      //     looks for;
      //   · at the worn record's residue it reads *programme* (−4.5 dB against
      //     the clean copy's own −4.6) — correctly: a lossy codec's error is
      //     shaped like the music it encoded, so the floor there is not flat;
      //   · and the third candidate, "the tilt is stationary when it is floor",
      //     is dead outright: the tilt's p90−p10 across that quiet passage is
      //     17.2 dB, wider than elsewhere in the file (14.6), because the
      //     encoder's error follows the content's dynamics.
      // Net of the witness and the arbitration: +0.19 dB on the hiss fixture's
      // quiet floor, 0.00 at the worn record's pop, ≤0.3 dB wiggles elsewhere.
      // That is noise, so neither is in the tree — the residual 2/72 is the
      // arrival's own floor, shaped like its music, and it stays documented.
      //
      // Round 20 measured the statistic a *band-level* repair would have to key
      // on — the HF excess over the local programme (64-sample blocks, the
      // reference being its own median over ±0.5 s, probe wr35.js) — and it is
      // what closes the question rather than opening it. The pops' own
      // neighbourhoods read p50 11.9 / p90 15.6 dB on arrival and 2.3 / 4.0
      // through the chain, i.e. at the clicks-free copy's own control level
      // (2.0 / 2.7): the floor is already repaired as far as the programme
      // allows. And the *music* reads the same statistic higher than the defect
      // does — hi-hats 3/s p50 **20.4** dB, a kick+snare+hat groove 6.0 (p90
      // 16.4), twelve "s" bursts 9.8 — so a gate on it would cut cymbals and
      // sibilants harder than it cuts the codec's smear. A cymbal and a codec
      // burst are the same signal to every band statistic this file computes;
      // the residue is the arrival's, and the row that says so is the honest
      // answer (acceptance §1, the worn record's boundary row).
      const cutTilt = this.maxCut > 0.01 ? clamp(tiltNow - this.tiltRef, 0, this.maxCut) : 60;
      const lvl = smoothstep(this.t1, this.t1 + 1 / this.inv, e);
      const cutLevel = lvl > 1e-6 ? -20 * Math.log10(lvl) : 60;
      // The correction the key asks for…
      const cutTarget = Math.min(cutTilt, Math.max(cutLevel - 6, 0));
      // …and the correction the gate is *allowed* to have taken so far: closing
      // over HISS_CLOSE_MS (60 ms — the pops this used to protect against are
      // repaired by the de-clicker in front of this stage, and the lag is what
      // costs the repair its depth), opening quickly (a transient must not be
      // dulled). The steady state is the same number the key asked for, so a
      // measured tilt still means what it says.
      const rate = cutTarget > this.cutDb
        ? 1 - Math.exp(-HISS_DECIM / (this.sr * HISS_CLOSE_MS * 0.001))
        : 1 - Math.exp(-HISS_DECIM / (this.sr * HISS_OPEN_MS * 0.001));
      this.cutDb += (cutTarget - this.cutDb) * rate;
      this.gate.set(Math.pow(10, -this.cutDb / 20));
      // ── is this frame *only* floor?
      // Two witnesses, both already computed here, and both have to agree:
      //   · `1 - lvl` — the key band (4 kHz+) sits at or below the measured HF
      //     floor, i.e. the level key sees no music at all (lvl is that key's
      //     own smoothstep against t1, whose top end is +9 dB above the floor);
      //   · `cutTilt / maxCut` — the tilt anomaly is at the value the
      //     measurement found, i.e. the whole of what was measured as noise is
      //     present.
      // The product is what gives the shelf its permission: a quiet *musical*
      // passage fails the first term (its own top end lifts `e`), a half-hissy
      // one fails the second (mid-band programme lowers tiltNow, and the term is
      // proportional, not a switch), and a loud one fails both.
      const floorT = this.maxCut > 0.01 ? clamp(cutTilt / this.maxCut, 0, 1) * (1 - lvl) : 0;
      this.floorW += (floorT - this.floorW) * rate;
      // The shelf's gain, in dB (negative = cut), smoothed with the gate's own
      // attack/release so the two move together: a hard step here would be a
      // step in the waveform, the same reason the `s` window below exists.
      const shT = -this.cutDb * HISS_FLOOR_RATIO * this.floorW;
      this.shDb += (shT - this.shDb) * rate;
      if (Math.abs(this.shDb - this.shApplied) > 0.02) {
        this.shApplied = this.shDb;
        this.sh.setHighShelf(this.sr, this.xover, 0.7071, this.shDb);
      }
    }
    // The amount is applied in *decibels*, not as a linear crossfade: "half the
    // repair" has to mean −6 dB of the noise, and a linear blend of the gate
    // gains is not that (it is far less at the bottom of the range, which is
    // exactly why the de-hisser used to move the HF floor by 3 dB when the
    // measurement had asked for 10).
    const g = this.gate.tick();
    const cutNow = g > 1e-6 ? -20 * Math.log10(g) : 60;
    const gEff = Math.pow(10, -(cutNow * strength) / 20);
    // Nothing to attenuate: mix *none* of the reconstruction in. This is what
    // keeps the stage *transparent* rather than "almost transparent" — run
    // through the LR4 reconstruction at every sample, the sum of the two
    // branches rotated the phase of the top end, which lifted the internal peak
    // of a dense loud master by +4.7 dB and made the soft-clip guard (and the
    // level matcher behind it) pull the whole file down. The de-hisser is a
    // repair: it may only touch samples that need repairing.
    //
    // …but the crossfade has to be *continuous*. The gate crosses the
    // transparent end of its range every time it moves — the level term opens
    // it on a broadband burst, the tilt term closes it again as the burst
    // leaves the key's window — and a hard `if (g >= 0.9999) return x` is a
    // step in the waveform at every one of those crossings, i.e. the stage
    // generates exactly the kind of edge the de-clicker downstream exists to
    // repair. Measured on the worn record with 108 injected pops, in the full
    // chain: 12 HF frames above 15 dB of crest with the branch, 7 with the
    // crossfade (the de-clicker on its own leaves 6). The window is the last
    // 0.1 % of the gate's range, so the amount the measurement asked for is
    // unchanged to within 0.01 dB.
    const s = gEff >= 1 ? 0 : gEff <= 0.999 ? 1 : (1 - gEff) / 0.001;
    if (s === 0) return x;
    const split = low + high * gEff;
    // …and where the two witnesses above have proven the frame is floor only,
    // the shelf closes the gap between what the split delivers and what was
    // measured. Cascaded after the split rather than in place of it: the modes
    // are then "top end only, leak-limited" (music present) and "top end plus
    // the floor regime" (nothing but floor), and the crossfade between them is
    // the ramp on floorW/shDb, not a switch.
    const shaped = (this.floorW > 0.001 && this.shDb < -0.01) ? this.sh.process(split) : split;
    return x + (shaped - x) * s;
  }
}

/* -------------------------------------------------------------------------- */
/* de-clipper (flat-topped peaks: overdriven masters, clipped transfers)       */
/* -------------------------------------------------------------------------- */

/**
 * De-clipper — the one repair a "loud master" needs and cannot get anywhere
 * else in this chain.
 *
 * Hard clipping is not noise: the waveform was cut off at a level and the
 * samples above it are simply gone. What is left is a *flat top*, and that is
 * both the signature and the problem — a flat top is a step in the second
 * derivative of a signal that had a peak there, which is why a clipped master
 * sounds hard and "crackly" on transients even after every other stage has
 * been through it. No amount of EQ or dynamics puts the peak back.
 *
 * Detection is the whole difficulty, because a *loud* waveform looks the same
 * as a clipped one: measure a 997 Hz sine at 1.25 that was never clipped and its
 * samples near the peak sit within a few 1e-4 of each other for a couple of
 * samples, exactly like a plateau. Two facts separate them, and this stage uses
 * both:
 *
 *   · the plateau of a clipped recording sits at the *peak level of the file* —
 *     the clipping is what the peak is — while a merely loud signal has more
 *     room above its own flat-looking samples (the analysis measures that level
 *     and hands it over as `declipLevel`, which is why this stage needs a
 *     parameter and not a constant);
 *   · the plateau *length* carries how much was cut off. A sine of amplitude A
 *     clipped at T stays at or above T for as long as cos(ω·t) ≥ T/A, so the run
 *     of n samples implies A = T / cos(ω·n/2) — 1.25 for the 997 Hz example
 *     above (2.0 dB of missing peak), 1.6 for a 60 Hz bass (4.2 dB), and 0.07 dB
 *     for the sine that was never clipped. Below half a decibel of implied loss
 *     there is nothing to repair, which is exactly what the false-positive test
 *     checks.
 *
 * Short plateaus now use a masked covariance AR(4..8) model learned from up to
 * 512 immediately preceding observations and up to 128 clean exit samples.
 * Every regression row touching a clipped sample is excluded. A raw observation
 * ring is separate from the mutable reconstruction ring, so LPC never learns
 * its own guesses. The same time-reversible fit predicts from both boundaries.
 * Bad fits, insufficient seeds, divergent predictions and large disagreement
 * retain the old Hermite/period fallback rather than inventing a crest.
 *
 * The AR estimates are joined to the two real boundary samples by a cubic
 * Hermite bridge with the observed one-sided derivatives; its smoothstep
 * residual weight has zero value and slope at both endpoints. Damaged samples
 * are projected onto the convex signed interval (rail, 4*rail], with an epsilon
 * that survives Float32 rounding. This is a sample constraint, not a claim of
 * globally optimal continuous-time recovery. Unclipped observations are kept.
 *
 * Extended plateaus retain the earlier periodic or order-16 CBAR fallback.
 * The fixed look-ahead still covers 25 ms plus trailing context; latency does
 * not depend on which model succeeds. Detection is performed on raw PCM,
 * before DC filtering, so the measured rail is not shifted by filter state.
 * Float32 rounding is accounted for when comparing it with a dB-derived rail.
 *
 * Reconstructed absolute peaks are held until reset. The processor derives a
 * stereo-linked attenuation before its output guard, even with autoLevel off,
 * so raising the hidden peaks does not merely clip them again at export.
 * Missing information is not universally recoverable: the quality guarantee
 * is limited to measured fixtures, not arbitrary clipped speech/music.
 */
class DeClipper {
  constructor(sr) {
    this.sr = sr;
    // Short-crest ceiling: AR/Hermite candidates below this length, with the
    // historical period/cubic reconstruction retained as a safe fallback.
    this.shortMax = Math.max(8, Math.round(sr * 0.0056));
    // CBAR's ceiling: how long an "extended" plateau this stage will still
    // attempt, autoregressively. 25 ms is the half-cycle of a 20 Hz tone —
    // below the bottom of hearing — clipped flat, which bounds the case a
    // real recording can actually present without being a different kind of
    // damage altogether (a stuck fader, a dead channel).
    this.maxRun = Math.max(this.shortMax, Math.round(sr * 0.025));
    // The AR model's order, and how many samples of context it is fit from
    // (8× the order — enough for a stable Levinson–Durbin estimate without
    // reaching so far back/forward that the "local" model stops being local).
    this.order = 16;
    this.ctxLen = this.order * 8;
    // The stage's total look-ahead: the longest run it may have to hold back
    // plus the trailing context CBAR needs after it, with a small margin.
    this.look = this.maxRun + this.ctxLen + 2;
    const L = this.look + 8;
    this.ring = new Float32Array(L);          // incoming samples, waiting
    this.source = new Float32Array(L);        // immutable observations for local AR fitting
    // Which of the waiting samples this stage has reconstructed. The de-clicker
    // downstream reads it: a *reconstructed* peak is broadband and spiky, and a
    // de-clicker looking for clicks would happily eat it again — measured on a
    // clipped master, the de-clicker alone pulled the flat tops down to a third
    // of their level, which is worse than leaving them. The flag travels with
    // the sample (the marking is retroactive, so even the samples in front of a
    // run are covered by the time they are emitted).
    this.mark = new Uint8Array(L);
    this.arc = new Float64Array(this.shortMax + 8);   // the Hermite arc, reused
    this.w = 0;
    this.marked = false;                      // was the sample just emitted ours?
    this.after = 0;                           // the sample that ended the current run
    this.th = 0.9;                            // set by prepare(): the clip level
    // How far above the plateau this stage has reconstructed, as a linear
    // factor. It is the *floor* under the guard's lift: a caller that does not
    // know the measured headroom still gets a reconstruction that survives the
    // guard, and a passage with no clipping lets the figure decay again.
    this.head = 1;
    this.restoredPeak = 0; // absolute, held until reset: global headroom, not a peak flattener
    this.lastSign = 0;
    // run tracking
    this.armed = false;                       // inside a candidate plateau
    this.runStart = 0;
    this.runLen = 0;
    this.runPeak = 0;                         // the highest |sample| seen this run — the floor's reference
    this.prev = 0;
    this.pos = 0;                             // absolute sample counter
    // the last few zero crossings, for the local period (half a period apart)
    this.cross = new Int32Array(9);
    this.crossN = 0;
    this.crossW = 0;

    /* ── CBAR's own state: a trailing history of unclipped audio for the
     * forward model, a frozen copy of it taken the instant a run turns out to
     * be an "extended" one, and a rolling collector for the audio that arrives
     * after the run ends, which the backward model is fit from. Collection
     * happens over several ticks — `look` is sized so those samples are still
     * sitting in the ring, unemitted, by the time it completes. */
    this.hist = new Float64Array(this.ctxLen);
    this.histW = 0;
    this.histN = 0;
    this.preCtx = new Float64Array(this.ctxLen);
    this.preCtxN = 0;
    this.post = new Float64Array(this.ctxLen);
    this.postN = 0;
    this.cbarPending = false;
    this.cbarStart = 0;
    this.cbarLen = 0;
    this.cbarSgn = 1;
    this.cbarPeak = 0;
    this.xf = new Float64Array(this.maxRun);
    this.xb = new Float64Array(this.maxRun);
    // scratch for the LPC fit and the zero-input extrapolation, reused by
    // both the forward and the backward call so a run costs one allocation,
    // not four, however long it is
    this._acf = new Float64Array(this.order + 1);
    this._coef = new Float64Array(this.order);
    this._tmp = new Float64Array(this.order);
    this._buf = new Float64Array(this.order);
    this._revCtx = new Float64Array(this.ctxLen);
    this._revOut = new Float64Array(this.maxRun);
    // Low-order covariance LPC for short crests. Masked windows are contiguous
    // observations; never train across a clipped gap or on a previous repair.
    this.shortOrder = 8;
    this.shortContext = new Float64Array(512);
    this.shortContextN = 0;
    this.shortMatrix = new Float64Array(72); // 8 x (8 + RHS), Gaussian solve
    this.shortCoef = new Float64Array(8);
    this.shortState = new Float64Array(8);
    this.shortFitThreshold = 1;
    this.shortAmount = 0;
    this.cbarShort = false;
  }
  reset() {
    this.ring.fill(0); this.source.fill(0); this.mark.fill(0);
    this.w = 0; this.marked = false; this.armed = false; this.runStart = 0; this.runLen = 0;
    this.runPeak = 0;
    this.head = 1; this.restoredPeak = 0;
    this.prev = 0; this.pos = 0; this.crossN = 0; this.crossW = 0;
    this.hist.fill(0); this.histW = 0; this.histN = 0;
    this.preCtx.fill(0); this.preCtxN = 0;
    this.post.fill(0); this.postN = 0;
    this.cbarPending = false; this.cbarShort = false;
    this.shortContext.fill(0); this.shortContextN = 0;
    this.shortCoef.fill(0); this.shortState.fill(0); this.shortMatrix.fill(0);
  }
  /** Local period from the last crossing intervals, or 0 when they are irregular. */
  period() {
    const n = this.crossN;
    if (n < 5) return 0;
    const k = (this.crossW - 1 + 9) % 9;      // newest
    let sum = 0, sum2 = 0, cnt = 0;
    for (let i = 1; i < n; i++) {
      const a = this.cross[(k - i + 1 + 9) % 9];
      const b = this.cross[(k - i + 9) % 9];
      const d = a - b;
      sum += d; sum2 += d * d; cnt++;
    }
    if (!cnt) return 0;
    const mean = sum / cnt;
    const sd = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
    if (mean < 2 || sd / mean > 0.35) return 0;         // not periodic enough to model
    return 2 * mean;
  }
  /** Append one confirmed-unclipped sample to CBAR's trailing context window. */
  pushHist(x) {
    this.hist[this.histW] = x;
    this.histW = (this.histW + 1) % this.ctxLen;
    if (this.histN < this.ctxLen) this.histN++;
  }
  /** Unroll the circular history buffer into `dst`, oldest sample first. */
  linearizeHist(dst) {
    const n = this.histN, CL = this.ctxLen;
    for (let i = 0; i < n; i++) dst[i] = this.hist[(this.histW - n + i + CL * 4) % CL];
  }
  /**
   * Levinson–Durbin recursion: fits order-`p` AR coefficients into `aOut`
   * (xhat[n] ≈ Σ aOut[k]·x[n-1-k], minimising the one-step prediction error)
   * from the autocorrelation `r[0..p]`. Guaranteed stable — every reflection
   * coefficient lands inside the unit circle whenever `r` is a genuine
   * autocorrelation sequence — which is exactly the property the zero-input
   * extrapolation below leans on.
   */
  levinson(r, p, aOut, tmp) {
    let e = r[0] > 1e-12 ? r[0] : 1e-12;
    for (let i = 0; i < p; i++) aOut[i] = 0;
    for (let i = 0; i < p; i++) {
      let acc = r[i + 1];
      for (let j = 0; j < i; j++) acc -= aOut[j] * r[i - j];
      const k = e > 1e-12 ? acc / e : 0;
      for (let j = 0; j < i; j++) tmp[j] = aOut[j] - k * aOut[i - 1 - j];
      for (let j = 0; j < i; j++) aOut[j] = tmp[j];
      aOut[i] = k;
      e *= (1 - k * k);
      if (e < 1e-9) e = 1e-9;
    }
  }
  /**
   * Fit an order-`p` AR model to `ctx[0..n)` (oldest first) and run it forward
   * as a zero-input filter for `len` samples, into `out`. Called on the real
   * pre-run context for the forward half of a repair, and on the *reversed*
   * post-run context for the backward half — one routine, because a backward
   * extrapolation is a forward one on time-reversed audio.
   */
  extrapolateForward(ctx, n, p, out, len) {
    const acf = this._acf, coef = this._coef, tmp = this._tmp, buf = this._buf;
    for (let lag = 0; lag <= p; lag++) {
      let s = 0;
      for (let i = 0; i < n - lag; i++) s += ctx[i] * ctx[i + lag];
      acf[lag] = s;
    }
    acf[0] *= 1 + 1e-6;                       // tiny diagonal load: numerical safety only
    this.levinson(acf, p, coef, tmp);
    for (let k = 0; k < p; k++) buf[k] = (n - 1 - k >= 0) ? ctx[n - 1 - k] : 0;
    for (let i = 0; i < len; i++) {
      let pred = 0;
      for (let k = 0; k < p; k++) pred += coef[k] * buf[k];
      if (!isFinite(pred)) pred = 0;
      else if (pred > 4) pred = 4; else if (pred < -4) pred = -4;   // sanity bound, never audible
      out[i] = pred;
      for (let k = p - 1; k > 0; k--) buf[k] = buf[k - 1];
      buf[0] = pred;
    }
  }
  /** Fit a time-reversible AR model (up to eight poles) from adjacent *observed* clean windows.
   * Clipped samples invalidate the entire regression row, not just its target.
   * A diagonal load and partial pivoting bound the solve; a residual gate refuses
   * noise/transients with no predictable local waveform. No per-run allocation.
   * @param {number} rail - observed clipping magnitude.
   * @param {number} [p=this.shortOrder] - order supported by both clean seed spans.
   * @returns {boolean} whether a supported model was found.
   */
  fitShortAR(rail, p = this.shortOrder) {
    const stride = p + 1, m = this.shortMatrix;
    m.fill(0);
    let rows = 0, energy = 0;
    const threshold = Math.min(rail * (1 - 1e-5), this.shortFitThreshold);
    for (let side = 0; side < 2; side++) {
      const x = side ? this.post : this.shortContext, n = side ? this.postN : this.shortContextN;
      for (let i = p; i < n; i++) {
        let valid = true;
        for (let j = 0; j <= p; j++) if (Math.abs(x[i - j]) >= threshold) valid = false;
        if (!valid) continue;
        // Forward and backward rows share one stationary local model. This
        // avoids fitting an ill-supported second predictor to a tiny exit gap.
        for (let dir = 0; dir < 2; dir++) {
          const target = dir ? x[i - p] : x[i];
          energy += target * target; rows++;
          for (let j = 0; j < p; j++) {
            const v = dir ? x[i - p + j + 1] : x[i - j - 1];
            for (let k = 0; k < p; k++)
              m[j * stride + k] += v * (dir ? x[i - p + k + 1] : x[i - k - 1]);
            m[j * stride + p] += v * target;
          }
        }
      }
    }
    if (rows < p * 8 || energy < 1e-10) return false;
    let trace = 0;
    for (let j = 0; j < p; j++) trace += m[j * stride + j];
    const load = Math.max(1e-14, trace / p * 1e-14);
    for (let j = 0; j < p; j++) m[j * stride + j] += load;
    for (let j = 0; j < p; j++) {
      let pivot = j;
      for (let k = j + 1; k < p; k++) if (Math.abs(m[k * stride + j]) > Math.abs(m[pivot * stride + j])) pivot = k;
      if (Math.abs(m[pivot * stride + j]) < load * 0.01) return false;
      for (let k = 0; k <= p; k++) {
        const v = m[j * stride + k]; m[j * stride + k] = m[pivot * stride + k]; m[pivot * stride + k] = v;
      }
      const d = m[j * stride + j];
      for (let k = j; k <= p; k++) m[j * stride + k] /= d;
      for (let k = 0; k < p; k++) if (k !== j) {
        const v = m[k * stride + j];
        for (let l = j; l <= p; l++) m[k * stride + l] -= v * m[j * stride + l];
      }
    }
    for (let j = 0; j < p; j++) {
      this.shortCoef[j] = m[j * stride + p];
      if (!Number.isFinite(this.shortCoef[j]) || Math.abs(this.shortCoef[j]) > 128) return false;
    }
    let error = 0;
    for (let side = 0; side < 2; side++) {
      const x = side ? this.post : this.shortContext, n = side ? this.postN : this.shortContextN;
      for (let i = p; i < n; i++) {
        let valid = true;
        for (let j = 0; j <= p; j++) if (Math.abs(x[i - j]) >= threshold) valid = false;
        if (!valid) continue;
        for (let dir = 0; dir < 2; dir++) {
          let predicted = 0;
          for (let j = 0; j < p; j++) predicted += this.shortCoef[j] * (dir ? x[i - p + j + 1] : x[i - j - 1]);
          error += ((dir ? x[i - p] : x[i]) - predicted) ** 2;
        }
      }
    }
    return error / energy < 0.01;
  }
  /** Cubic Hermite bridge through real boundary samples with their measured
   * one-sided tangents. Slopes are per sample, not normalized-time derivatives.
   * @param {number} t - normalized position, 0..1.
   * @param {number} a - left boundary value.
   * @param {number} b - right boundary value.
   * @param {number} da - left derivative.
   * @param {number} db - right derivative.
   * @param {number} span - boundary distance in samples.
   * @returns {number} interpolated value.
   */
  hermiteBridge(t, a, b, da, db, span) {
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * span * da
      + (-2 * t3 + 3 * t2) * b + (t3 - t2) * span * db;
  }
  /** Convex AR/Hermite blend. The smoothstep edge weight and its first
   * derivative vanish at both observed boundaries, preserving their tangents
   * for any bounded smooth interpolation of the AR predictions.
   * @param {number} t - normalized position.
   * @param {number} a - observed left value.
   * @param {number} b - observed right value.
   * @param {number} da - observed left slope per sample.
   * @param {number} db - observed right slope per sample.
   * @param {number} span - gap length plus one.
   * @param {number} predicted - bidirectional AR estimate at t.
   * @returns {number} blended estimate before sample-wise convex projection.
   */
  shortBridge(t, a, b, da, db, span, predicted) {
    const h = this.hermiteBridge(t, a, b, da, db, span);
    const edge = Math.max(0, Math.min(1, Math.min(t, 1 - t) * span / 2));
    const gate = edge * edge * (3 - 2 * edge);
    return h + gate * (predicted - h);
  }
  /** Short-plateau AR extrapolation from both clean boundaries, blended into
   * a Hermite bridge with a C1 edge gate, then projected onto the convex clip
   * half-space at the damaged samples. All predictions are vetted before writes.
   * Projection constrains samples, not an unknown continuous original waveform.
   * @returns {boolean} whether this run was reconstructed from AR evidence.
   */
  repairShortAR() {
    const L = this.source.length, originalStart = this.cbarStart, originalLen = this.cbarLen;
    const sign = this.cbarSgn, rail = this.cbarPeak;
    let start = originalStart, len = originalLen;
    while (len && Math.abs(this.source[start % L]) < rail * (1 - 1e-5)) { start++; len--; }
    while (len && Math.abs(this.source[(start + len - 1) % L]) < rail * (1 - 1e-5)) len--;
    if (len < 2) return false;
    const state = this.shortState, coef = this.shortCoef, end = start + len;
    // Use the largest supported order, down to four poles. Closely spaced
    // peaks may leave fewer than eight clean seeds but still support a useful
    // lower-order model; never initialize a predictor with clipped samples.
    let preClean = 0, postClean = 0;
    const availablePost = this.postN + originalStart + originalLen - end;
    for (let j = 0; j < this.shortOrder && j < start; j++) {
      if (Math.abs(this.source[(start - 1 - j + L) % L]) >= rail * (1 - 1e-5)) break;
      preClean++;
    }
    for (let j = 0; j < this.shortOrder && j < availablePost; j++) {
      if (Math.abs(this.source[(end + j) % L]) >= rail * (1 - 1e-5)) break;
      postClean++;
    }
    const p = Math.min(this.shortOrder, preClean, postClean);
    if (p < 4 || !this.fitShortAR(rail, p)) return false;
    for (let direction = 0; direction < 2; direction++) {
      for (let j = 0; j < p; j++) state[j] = this.source[(direction ? end + j : start - 1 - j + L) % L];
      const out = direction ? this.xb : this.xf;
      for (let k = 0; k < len; k++) {
        let v = 0;
        for (let j = 0; j < p; j++) v += coef[j] * state[j];
        if (!Number.isFinite(v) || Math.abs(v) > rail * 4) return false;
        out[direction ? len - 1 - k : k] = v;
        for (let j = p - 1; j > 0; j--) state[j] = state[j - 1];
        state[0] = v;
      }
    }
    let disagreement = 0, magnitude = 0, peak = rail;
    const a = this.source[(start - 1 + L) % L], b = this.source[end % L];
    const da = a - this.source[(start - 2 + L) % L], db = this.source[(end + 1) % L] - b;
    for (let k = 0; k < len; k++) {
      disagreement += (this.xf[k] - this.xb[k]) ** 2;
      magnitude += this.xf[k] ** 2 + this.xb[k] ** 2;
      const t = (k + 1) / (len + 1), w = 0.5 * (1 + Math.cos(Math.PI * t));
      const predicted = w * this.xf[k] + (1 - w) * this.xb[k];
      const v = sign * this.shortBridge(t, a, b, da, db, len + 1, predicted);
      // Euclidean projection onto [rail + epsilon, 4 * rail] in signed space.
      // A finite margin survives Float32 rounding; no == rail "repair".
      this.arc[k] = Math.max(rail + Math.max(1e-7, rail * 1e-6), Math.min(rail * 4, v));
      if (this.arc[k] > peak) peak = this.arc[k];
    }
    if (disagreement > magnitude * 0.25 || 20 * Math.log10(peak / rail) <= 1.2 - 0.7 * this.shortAmount) return false;
    // Undo the fallback only after the AR candidate passed every safety gate.
    for (let k = 0; k < originalLen; k++) this.ring[(originalStart + k) % L] = this.source[(originalStart + k) % L];
    for (let k = 0; k < len; k++) this.ring[(start + k) % L] = sign * this.arc[k];
    for (let k = -2; k < len + 2; k++) this.mark[(start + k + L) % L] = 1;
    this.head = Math.max(this.head, peak / rail);
    this.restoredPeak = Math.max(this.restoredPeak, peak);
    return true;
  }
  /** Reconstruct the plateau [start, start+len-1] in the ring (short runs: Hermite/period model). */
  repairHermite(start, len, amount) {
    const L = this.ring.length;
    const i0 = (start + L) % L;
    const flat = Math.abs(this.ring[i0]);
    if (!(flat > 0.02)) return false;
    /* Two kinds of evidence, and the depth follows whichever one applies.
     *
     * Where the local period is trustworthy, the plateau length *solves* for the
     * missing peak: a sine of amplitude A clipped at T stays at or above T for
     * T/A ≤ cos(ω·len/2), so the length gives A exactly. The stage caps that at
     * 6 dB, which is a sanity bound on a case that can be measured, not a
     * conservatism about it.
     *
     * Where it is not (broadband material: music, noise, cymbals) the length is
     * weak evidence and the reconstruction is a bound — 0.9 + 0.25 dB per sample
     * of run, capped at 3 dB.
     *
     * What the depth may *not* be is a fraction of either. It used to be
     * `min(cap, implied) × (0.5 + 0.5 × amount)`, which contradicts the line
     * above it ("the amount moves this threshold, not the depth of a repair that
     * has already been decided on") and caps the whole stage at 2.6 dB of
     * reconstruction however strong the evidence is. On the documented case — a
     * 997 Hz tone at 1.245 clipped at 0.75, i.e. 4.4 dB of missing peak — the
     * period says 4.27 dB, the stage restored 2.58 dB, and the ground-truth
     * error did not move at all (−17.2 dB repaired against −17.2 dB unrepaired,
     * measured with the chain otherwise neutral). The amount belongs in the
     * threshold; the shape belongs to the evidence. */
    /* Two models, and the louder one wins.
     *
     * Where the material is periodic enough to have a period, the plateau length
     * solves for the missing peak: a sine of amplitude A clipped at T stays at or
     * above T for T/A ≤ cos(ω·len/2), so the length gives A directly. That is
     * exact — on a 997 Hz tone at 1.25 clipped at 0.99, the ground-truth error
     * over the plateaus goes from −22.0 dB unrepaired to −29.0 dB repaired.
     *
     * Where it is not (music, noise, cymbals) the run length alone is weak
     * evidence, and the stage used to answer it with a pure function of the
     * length — `0.9 + 0.25` per sample. That came apart on a hard-clipped pink
     * fixture, where the peak actually hidden above the rail was measured over
     * 28 000 runs: 0.47 dB at one sample, 1.12 at two, 1.56 at three, 1.75 at
     * five, 1.91 at eight, 2.05 at thirty. The old curve read 1.15 / 1.40 / 1.65
     * / 2.15 / 3.00 — an overshoot on every short run, and short runs are 60 % of
     * them. Measured, the reconstruction left the file *further* from the
     * original than the flat top it replaced (−11.7 → −10.6 dB).
     *
     * The waveform already answers the question. The samples on either side of a
     * run, and the slopes between them, define exactly one cubic that passes
     * through both ends with both tangents (Hermite). Its height over the run is
     * what the missing peak has to be, and it is shape-aware in the way that
     * matters: a deep crest bulges, while a *shallow crossing* — where the
     * waveform merely clips its way through the rail on the way up — barely
     * rises, so the reconstruction follows its neighbours instead of inventing an
     * apex that was never there. On the same fixture the one- and two-sample runs
     * come out at +1.0 and +1.2 dB against measured truths of +0.47 and +1.12 dB.
     * The same cubic is also the *shape* of the arc, which makes it meet the
     * neighbouring samples with a matching slope — the raised cosine it replaced
     * arrived with a kink at both ends, which is a broadband discontinuity of its
     * own and exactly what this stage is supposed to be removing.
     *
     * The Hermite needs no period, no table and no calibration constant. The
     * period model stays because for a *tonal* peak the sampled neighbours
     * under-read the slope (the crossing falls between samples) and there the
     * period is the better witness. Whichever model predicts more is the one
     * taken, each with its own ceiling: 6 dB where a period vouches for the
     * answer, 3 dB where the waveform alone does. */
    const iA = (start - 1 + L) % L;
    const sgn = this.ring[i0] < 0 ? -1 : 1;
    const m0 = flat - this.ring[iA] * sgn;
    const m1 = this.after * sgn - flat;                   // per sample, in the run's frame
    let peak = 0;
    for (let k = 0; k < len; k++) {
      const u = (k + 0.5) / len;
      const v = len * (m0 * (u * u * u - 2 * u * u + u) + m1 * (u * u * u - u * u));
      this.arc[k] = v;
      if (v > peak) peak = v;
    }
    const hermiteDb = peak > 1e-7 ? 20 * Math.log10(1 + peak / flat) : 0;
    let implied, cap, useHermite;
    const p = this.period();
    if (p > 0) {
      cap = 6.0;
      const w = (2 * Math.PI / p) * len * 0.5;
      implied = 20 * Math.log10(1 / Math.cos(w < 1.4 ? w : 1.4));
      /* Height *and shape* come from one model, never one from each. A test
       * that measures the reconstruction against a known original is dominated
       * by the *consistency* of the shape, not by the accuracy of any single
       * arc: a best-fit scale absorbs a systematic under-reach across the whole
       * file and leaves only the shape error, so arcs that are sometimes early
       * and sometimes late fail where arcs that are always slightly short pass.
       * Measured on the 997 Hz fixture: the Hermite's own shape with the period
       * model's height reads −26.3 dB, the same model supplying both reads
       * −32 dB. The period model's shape is symmetric because the crest of a
       * clipped tone is; the Hermite's is not, because the two slopes it is
       * handed are sampled at different points of the wave. */
      if (hermiteDb > implied) { implied = hermiteDb; useHermite = true; } else useHermite = false;
    } else {
      cap = 3.0;
      implied = hermiteDb;
      useHermite = true;
    }
    if (implied > cap) implied = cap;
    // how sure the detector has to be — the amount moves this threshold alone
    if (!(implied > 1.2 - 0.7 * amount)) return false;
    const applied = implied;
    const target = flat * Math.pow(10, applied / 20);
    this.restoredPeak = Math.max(this.restoredPeak, target);
    /* What the guard has to let through for this repair to survive it. The
     * reconstruction is *above* the plateau by construction, and the plateau is
     * at the file's peak level — so without this the guard's knee (which starts
     * 0.55 dB below full scale) would flatten the arc straight back into the
     * flat top it came from. Measured on a 997 Hz tone clipped at 0.99 that
     * implies +2 dB: unrepaired −15.4 dB of error in the plateau, repaired
     * with the knee in its way −15.4 dB (i.e. *nothing*), repaired with the
     * knee lifted −33.9 dB.
     */
    const ratio = target / flat;
    if (ratio > this.head) this.head = ratio;
    const rise = target - flat;
    const norm = useHermite && peak > 1e-7 ? rise / peak : 0;
    for (let k = 0; k < len; k++) {
      const v = flat + (norm > 0
        ? norm * this.arc[k]
        : rise * Math.cos(Math.PI * (k + 0.5 - len * 0.5) / len));
      this.ring[(start + k + L) % L] = sgn * v;
    }
    // …and mark the repair with two samples of margin on either side, so the
    // de-clicker leaves the whole reconstructed peak alone (the joins of an arc
    // are broadband too)
    for (let k = -2; k < len + 2; k++) this.mark[(start + k + L) % L] = 1;
    return true;
  }
  /**
   * Reconstruct a plateau longer than shortMax when the local period is
   * trustworthy (see period()): the same length-solved raised-cosine arc
   * repairHermite falls back to for a tonal crest, with no ceiling on `len`.
   * The formula — a sine of amplitude A clipped at T stays at or above T for
   * T/A ≤ cos(ω·len/2) — does not get weaker as the run gets longer; it is
   * exact for any length up to half the signal's own period, which is also
   * the hard ceiling on how long a same-sign run can ever be, so there is no
   * case here the formula was not already true for.
   *
   * repairHermite's cubic is deliberately *not* tried here even though it is
   * also available: it is one polynomial fit through two boundary tangents,
   * and the longer the span the further that single arc has to extrapolate
   * past what two sampled slopes actually support — exactly backwards from
   * the raised cosine, whose height is pinned by the run length (independent
   * evidence) at every sample, not just the two ends. The period model's
   * shape is also symmetric because the crest of a clipped tone is, where a
   * cubic through two differently-sampled slopes is not (see repairHermite).
   */
  repairPeriodic(start, len, p) {
    const L = this.ring.length;
    const i0 = (start + L) % L;
    // the run's own measured peak, not its first sample: the peak-relative
    // run-continuation floor (tick(), §3) deliberately arms a little before
    // the waveform reaches the true rail, so ring[i0] alone can under-read it
    // on a run that armed early — this.runPeak is read here synchronously,
    // before anything else can touch it (unlike finishCBAR, this runs inline
    // the instant the run closes, so there is nothing stale to snapshot).
    const flat = this.runPeak > 0 ? this.runPeak : Math.abs(this.ring[i0]);
    if (!(flat > 0.02)) return false;
    const sgn = this.ring[i0] < 0 ? -1 : 1;
    const w = (2 * Math.PI / p) * len * 0.5;
    const implied = Math.min(6.0, 20 * Math.log10(1 / Math.cos(w < 1.4 ? w : 1.4)));
    const target = flat * Math.pow(10, implied / 20);
    this.restoredPeak = Math.max(this.restoredPeak, target);
    const ratio = target / flat;
    if (ratio > this.head) this.head = ratio;    // same guard-lift as repairHermite, same reason
    const rise = target - flat;
    for (let k = 0; k < len; k++) {
      const v = flat + rise * Math.cos(Math.PI * (k + 0.5 - len * 0.5) / len);
      this.ring[(start + k + L) % L] = sgn * v;
    }
    for (let k = -2; k < len + 2; k++) this.mark[(start + k + L) % L] = 1;
    return true;
  }
  /**
   * Finish a pending CBAR reconstruction: fit the forward model from the
   * frozen pre-run context, the backward model from whatever post-run context
   * was collected (it may be short — another clip arriving early, or the file
   * ending — and the fit degrades gracefully rather than failing), cross-fade
   * the two extrapolations across the gap, and floor the result at the
   * measured clip rail before writing it into the ring.
   */
  finishCBAR() {
    if (this.cbarShort) {
      this.cbarPending = false; this.cbarShort = false;
      this.repairShortAR();
      return;
    }
    const len = this.cbarLen, start = this.cbarStart, sgn = this.cbarSgn;
    const L = this.ring.length;
    const preN = this.preCtxN, postN = this.postN;
    this.cbarPending = false;
    // an order fit from fewer than 3× its own samples is not a fit, it is a
    // guess — scale the order down with the context and give up on a side
    // (not the whole repair) once there is nothing honest left to fit
    const pF = preN >= 12 ? Math.min(this.order, Math.max(2, Math.floor(preN / 3))) : 0;
    const pB = postN >= 12 ? Math.min(this.order, Math.max(2, Math.floor(postN / 3))) : 0;
    // the rail this run sat at is its own *peak* magnitude, not its first
    // sample: the peak-relative floor that tracks an extended run (see tick(),
    // §3) deliberately arms a little before the waveform actually reaches the
    // rail, so the first sample of a long run can read several per cent under
    // it — using it as "the" clip level would floor the whole reconstruction
    // there instead of at the rail it is actually supposed to represent.
    const flat = this.cbarPeak;
    if (!(flat > 0.02) || (pF === 0 && pB === 0)) {
      // neither side can be modelled (the run sits at the very start of the
      // file, or back to back with another one): leave the plateau at the
      // rail rather than invent a shape from nothing — a flat top is still
      // the honest answer when there is no evidence for anything else — but
      // mark it, so the de-clicker downstream still leaves it alone.
      for (let k = -2; k < len + 2; k++) this.mark[(start + k + L) % L] = 1;
      return;
    }
    const xf = this.xf, xb = this.xb;
    if (pF > 0) this.extrapolateForward(this.preCtx, preN, pF, xf, len);
    if (pB > 0) {
      const rc = this._revCtx;
      for (let i = 0; i < postN; i++) rc[i] = this.post[postN - 1 - i];
      this.extrapolateForward(rc, postN, pB, this._revOut, len);
      for (let i = 0; i < len; i++) xb[len - 1 - i] = this._revOut[i];
    }
    let maxRatio = 1;
    for (let k = 0; k < len; k++) {
      let v;
      if (pF > 0 && pB > 0) {
        // equal-power-ish raised-cosine cross-fade: 1/0 at the start of the
        // gap (all forward, the half the forward model is actually built
        // from), 0/1 at the end (all backward), smooth through the middle so
        // neither extrapolation's own join ever arrives as a step
        const t = len > 1 ? k / (len - 1) : 0.5;
        const wF = 0.5 * (1 + Math.cos(Math.PI * t));
        v = wF * xf[k] + (1 - wF) * xb[k];
      } else if (pF > 0) v = xf[k];
      else v = xb[k];
      // the constraint: CBAR is *blind* about the shape above the rail but not
      // about the amplitude at it — every sample in this span really did sit
      // at or beyond the measured clip level, so the model may only ever add
      // to that, never predict the repair back under the clipping it replaces
      const proj = sgn > 0 ? Math.max(v, flat) : Math.min(v, -flat);
      this.ring[(start + k + L) % L] = proj;
      const r2 = Math.abs(proj) / flat;
      if (r2 > maxRatio) maxRatio = r2;
    }
    if (maxRatio > this.head) this.head = maxRatio;
    this.restoredPeak = Math.max(this.restoredPeak, flat * maxRatio);
    for (let k = -2; k < len + 2; k++) this.mark[(start + k + L) % L] = 1;
  }
  tick(x, amount, level) {
    if (amount <= 0.0001 || level <= 0.02) {
      this.th = 1;                                       // dormant: a run can never match
      this.armed = false;
      this.cbarPending = false;
      return x;
    }
    // dB → linear thresholds are double precision, decoded PCM is Float32.
    // A nominal 0.35 rail can read 0.349999994 and must still be detected.
    level *= 1 - 1e-6;
    // ── 1 · track the local period from the zero crossings ─────────────────
    if ((x > 0 && this.prev <= 0) || (x < 0 && this.prev >= 0)) {
      if (this.crossN) {
        const k = (this.crossW - 1 + 9) % 9;
        const d = this.pos - this.cross[k];
        if (d > this.sr / 24) {                          // > 2 kHz: forget the history
          this.crossN = 0;
        }
      }
      this.cross[this.crossW] = this.pos;
      this.crossW = (this.crossW + 1) % 9;
      if (this.crossN < 9) this.crossN++;
    }
    this.prev = x;

    const ax = x < 0 ? -x : x;

    // ── 2 · feed a pending CBAR repair's trailing context, if one is open ──
    // the backward model needs real audio *after* the run, collected over the
    // ticks that follow it while `look` keeps the run itself from being
    // emitted yet
    if (this.cbarPending) {
      if (ax >= level) {
        // the context ran straight into the next clipped run: finish with
        // whatever was collected rather than let a flat top teach the model
        this.finishCBAR();
      } else {
        if (this.postN < this.ctxLen) this.post[this.postN++] = x;
        if (this.postN >= this.ctxLen) this.finishCBAR();
      }
    }

    /* ── 3 · contiguous same-sign candidates above the measured rail ──────
     * The peak-relative floor prevents a coarse threshold from swallowing an
     * exit ramp. The level test also remains mandatory: confirmed uncorrupted
     * observations below theta must not be absorbed into a repair. */
    if (this.armed) {
      if (x * this.lastSign > 0 && ax >= level && ax >= this.runPeak * DECLIP_RUN_FLOOR) {
        this.runLen++;
        if (ax > this.runPeak) this.runPeak = ax;
        if (this.runLen > this.maxRun) this.armed = false;     // too long to be a peak: bail out, unrepaired, as always
      } else {
        this.armed = false;
        /* The sample that *ended* the run is the current one, and it is not in
         * the ring yet — the ring is written after this branch. Handing it to
         * the repair directly is the difference between a Hermite through the
         * run's two real neighbours and one through the sample's slot from
         * hundreds of samples ago: measured, the latter put a tangent of −0.99
         * into the cubic on a 997 Hz tone and turned a correct +2 dB arc into a
         * 3 dB one, dropping the ground-truth error from −29.0 to −15.7 dB. */
        this.after = x;
        if (this.runLen <= this.shortMax) {
          this.repairHermite(this.runStart, this.runLen, amount); // evidence-preserving fallback
          if (this.cbarPending) this.finishCBAR();
          this.cbarPending = true; this.cbarShort = true;
          this.cbarStart = this.runStart; this.cbarLen = this.runLen;
          this.cbarSgn = this.lastSign; this.cbarPeak = this.runPeak;
          this.shortFitThreshold = level; this.shortAmount = amount;
          this.shortContextN = Math.min(512, this.runStart, this.source.length - this.runLen - 2);
          for (let j = 0; j < this.shortContextN; j++) {
            const index = this.runStart - this.shortContextN + j;
            this.shortContext[j] = this.source[(index + this.source.length) % this.source.length];
          }
          this.postN = 0; this.post[this.postN++] = x;
        } else if (this.period() > 0) {
          // an extended but *periodic* plateau: the length-solves-for-the-peak
          // formula repairHermite already uses for a tonal crest is exact at
          // any length (a clipped sine's flat run can never exceed half its
          // own period, so the length is direct evidence of the rest of that
          // half-cycle, not a weaker version of it the longer the run gets) —
          // see repairPeriodic() for why the Hermite cubic is skipped here.
          this.repairPeriodic(this.runStart, this.runLen, this.period());
        } else {
          // an extended, *non*-periodic plateau (broadband overload, noise):
          // there is no waveform to solve for, so fall back to a blind
          // forward/backward AR model instead of inventing a period that
          // is not there. The frozen trailing history (untouched since
          // before the run started — it is only fed while this stage is
          // *not* armed, see §4) becomes the forward context, and the sample
          // that just ended the run is the first sample of the backward one
          if (this.cbarPending) this.finishCBAR();          // two long runs back to back
          this.preCtxN = this.histN;
          this.linearizeHist(this.preCtx);
          this.cbarPending = true; this.cbarShort = false;
          this.cbarStart = this.runStart;
          this.cbarLen = this.runLen;
          this.cbarSgn = this.lastSign;
          this.cbarPeak = this.runPeak;
          this.postN = 0;
          this.post[this.postN++] = x;
          if (this.postN >= this.ctxLen) this.finishCBAR();
        }
        // the run just closed is gone either way; this same sample may still
        // be the first one of the *next* run
        if (ax >= level) {
          this.armed = true;
          this.runStart = this.pos;
          this.runLen = 1;
          this.runPeak = ax;
          this.lastSign = x < 0 ? -1 : 1;
        }
      }
    } else if (ax >= level) {
      this.armed = true;
      this.runStart = this.pos;
      this.runLen = 1;
      this.runPeak = ax;
      this.lastSign = x < 0 ? -1 : 1;
    }

    // ── 4 · trailing context for the *next* run's forward model — fed from
    // every sample that is not itself part of a live clipped run, so the
    // model is never trained on the flat top it will later have to explain
    if (!this.armed) this.pushHist(x);

    this.ring[this.w] = x;
    this.source[this.w] = x;
    const L = this.ring.length;
    const r = (this.w - this.look + L) % L;
    const out = this.ring[r];
    this.marked = this.mark[r] === 1;
    this.mark[r] = 0;
    this.w = (this.w + 1) % L;
    this.pos++;
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* de-clicker (vinyl crackle / digital impulse repair)                         */
/* -------------------------------------------------------------------------- */

/**
 * De-clicker (vinyl crackle, impulse repair — and the class it does *not* see,
 * the dropout, measured at the end of this header).
 *
 * A pop old enough to be on a record is short — one to three samples of
 * broadband energy — and that is what every de-clicker looks for. What arrives
 * here has usually been through a consumer encoder as well, and that changes
 * the job: encoding smears the three samples across the window the codec works
 * in. Measured on a vinyl rip at 128 kbit/s (216 pops injected before the
 * encoder, decoded again after it), the pop's energy sits within −40…+40
 * samples of the spike it came from — 96 % of it, with the centroid four
 * samples *after* the spike — and the spike survives at full height.
 *
 * That shape is what a causal repair cannot handle. Replacing the waveform with
 * the *ground truth* (the same music without the click) from the detected peak
 * onwards leaves the measured crackle index at 0.63–0.68 however long the
 * window is, and letting the repair fade *in* over the spike is worse still: a
 * partial depth on a step-like residual *is* a step, so a faded causal window
 * measured 1.00 — the repair becomes the click it was removing. Repairing the
 * whole extent at full depth from the peak leaves the smear that precedes it,
 * and that smear is two thirds of the energy.
 *
 * So this stage looks ahead. It detects on the sample that arrives, plans the
 * repair around it — `pre` samples in front, `post` behind — and lets the
 * sample wait in a delay line until the plan reaches it. On the same fixture at
 * the automatic dose that took the crackle index from 0.665 (the best a
 * single-sample repair can do: 297 spike frames) to 0.232 (22 frames; the same
 * music encoded without the pops reads 0.062), and the residual around each pop
 * dropped by 8–10 dB. The price is `look` samples of delay — 0.35 ms — while
 * the stage is engaged; the master dry/wet crossfade delays its dry side by the
 * same amount so the A/B switch stays phase-coherent, and the processor reports
 * the figure as `this.latency`. It is *not* prediction: nothing comes out
 * before it goes in.
 *
 * The repair itself is the classic one: the flagged samples are mixed towards a
 * 24 dB/octave 4 kHz prediction *of the repaired signal*, so what replaces a
 * pop is the low-frequency continuation of the music around it. Musical
 * transients are the risk — a snare hit also raises the detector's crest
 * statistic — but a drum kit is long next to a pop: measured on a 96 BPM kit
 * with 16 snares, the stage at the automatic dose changes the 2 ms around a
 * snare by −84 dB, against −31 dB for the single-sample repair it replaces.
 *
 * ── the class this stage does not see, measured (round 11) ───────────────────────
 * A click is an impulse *added* to the music; a *dropout* is a hole, and this
 * header used to claim digital dropouts without ever measuring one. Measured
 * now, with a mute planted every 1/9 s on a bright bed (LP 9000 + hiss; probes
 * dc5–dc9, and the acceptance tool's two `dropouts` rows):
 *
 *   mute length        1     2     5    12    25    60    120 samples
 *   0.3–4 kHz vs clean +1.4  +1.0  +0.4 −0.2  −6.8  −9.8 −12.8 dB
 *   the plan mask      0.00  0.00  0.00 0.00  0.00  0.00  0.00
 *
 * A short gap is *not* a defect at all — the band-limited signal heals it, which
 * is why the class only starts at about 25 samples — and this stage fires on
 * none of it: the witness watches the high band, and there the 4 kHz prediction
 * smears both edges of a gap, so the ratio reads 1.24–1.94 at 2–25 samples
 * against a knee that wants ≈ 2.2. Two replacement witnesses were measured
 * against music's own floor and both fail: a body-band envelope dip reads 0.70
 * at the holes and **0.032** on a plain clean bed (a phrase boundary is deeper
 * than any hole), and the ratio *falling* — which a mute does produce (0.48 at
 * 25 samples, 0.04 at 120) — has music's own p0.01 at **0.03**, i.e. music
 * reaches as deep as the deepest gap. The fill would also need a longer delay
 * line than the 0.35 ms of look-ahead above, or the un-filled head would be
 * left as a step — the click this stage exists to remove. So the class is a
 * measured bound rather than a claim, pinned by the audit's `dropouts` section
 * and by the acceptance matrix's `dropouts` rows.
 */
class DeClicker {
  constructor(sr) {
    this.sr = sr;
    // The window, in samples. `pre` is what the look-ahead has to be able to
    // reach back to; `rise`/`fall` are the crossfades that keep the window from
    // ending in a step of its own.
    this.pre = Math.max(2, Math.round(sr * 0.00033));
    this.post = Math.max(4, Math.round(sr * 0.00100));
    /* ── the window the *ring-out* needs (round 19) ─────────────────────────
     * A stylus click does not stop at the click: it excites the cartridge's own
     * resonance, and what is left after the spike is 0.5 … 3 ms of damped
     * *tone* at 8–12 kHz. The repair window above covers the spike and the first
     * millisecond of that ring; past it the tone runs on, and a second-
     * difference witness cannot see it — the third witness is a *roughness*
     * measure, and a smooth 9 kHz tone is music to it however loud it is. What
     * can be seen is the tone itself: over `tail` samples behind the detection
     * the signal is fitted against a damped sinusoid, exp(-k/τ)·(a·cos ωk +
     * b·sin ωk), over a grid of τ (0.4 … 4 ms) and of ω (6 … 13 kHz at 250 Hz,
     * refined by a parabola), and the fit that explains the most of the window's
     * energy is subtracted from the output for up to 3τ (8 ms at most).
     *
     * The fit window is the whole trade. Measured on the ring family (τ 0.6 /
     * 1.5 / 2.5 ms, 9/s at 9 kHz, 72 clicks each, probes tools/work/wr29-31.js):
     * with a 0.35 ms window — what the old look-ahead allowed — the frequency
     * lands 88–151 Hz off and the ring-out only comes down from +11.9 to +10.4 dB
     * over the clean copy; with 1.0 ms it lands 12–28 Hz off and the same reading
     * is +4.1 dB, the onset falls from +17.7 to +1.6 dB and the app's own crackle
     * index over the file from 0.512 to 0.000. What licenses the removal is the
     * fit's own *explained share* R² — a damped tone explains 0.26 … 0.48 of the
     * window on the ring family (p10 … p90) and 0.008 … 0.097 on everything that
     * is a performance (hi-hats, a kick/snare/hat pattern, twelve "s" bursts, a
     * clean bed) — so R² ≥ 0.2 is the gate, and it is measured on both
     * populations rather than assumed. */
    this.tail = Math.max(8, Math.round(sr * 0.00100));
    this.look = this.pre + 1 + this.tail;
    this.rise = Math.max(2, Math.round(sr * 0.00017));
    this.fall = Math.max(2, Math.round(sr * 0.00033));
    const L = this.look + this.post + 4;
    this.ring = new Float32Array(L);          // the incoming samples, waiting
    this.plan = new Float32Array(L);          // …and how far each of them is repaired
    this.mark = new Uint8Array(L);            // …and which came from the de-clipper
    this.prevIn = 0;                          // for the flat-top test below
    /* ── the *third* witness: the roughness of the sample itself ───────────
     * The two witnesses above are first-order — the size of the residual, and
     * its one-sidedness — and that is where the stage's floor lives: a pop that
     * is only twice the music's own 4 kHz activity reads ratio 1.9 and asym
     * 0.31, exactly like the tallest peak of a band-limited bed, so the map
     * cannot fire on it however carefully the knee is placed (measured on the
     * acceptance fixture: three of 72 pops stay, and the audit's floor row shows
     * that reaching them by moving the map costs the drum kit 24 dB of its
     * 55 dB guard). What those two statistics do not ask is what the *waveform*
     * is allowed to do between two samples. Content below 9 kHz has a hard
     * ceiling on its second difference — |D2| ≤ (2·sin(π·f/fs))²·A, i.e. 0.35·A
     * there — while a one-sample delta produces |D2| = 2a at its own sample
     * whatever the bed is doing. Measured (probes tools/work/sp1.js, sp2.js,
     * sp3.js), in σ of the *local* D2 over the 96 samples before the sample in
     * hand:
     *
     *   the three survivors, four beds 5–12 kHz  8.3 … 11.4 σ
     *   the pops the ratio already catches       12 … 30 σ
     *   a drum machine + bed                     0.008 % of samples ≥ 5 σ
     *   the audit's wide clean master            0.000 % ≥ 4 σ
     *   the clipped hot master (§18)             0.001 % ≥ 4 σ, 0.000 % ≥ 5
     *   a loud tape-hiss bed                     0.001 % ≥ 5 σ
     *   the acceptance tool's performance        14 samples in 8 s ≥ 5 σ, 0 ≥ 8
     *   a 200-sample square wave                 2 % (a square *is* a click train)
     *
     * The last line is the honest boundary, and it is the same one the burst
     * fixture in the acceptance tool has always had: a signal made of sample-level
     * steps is a train of clicks in every statistic here, and the stage repairs
     * it. Everything else — noise at any bandwidth, a tone, a bass line, a
     * clipped rail, a snare with a body and a tail — sits at 2–3 σ, because the
     * statistic is a ratio to the *local* roughness of the same band, so it is
     * scale-free and bandwidth-free by construction. */
    this.prevIn2 = 0;                         // …and the one before that
    this.plateauPrev = false;                 // …and whether those two were clip plateaus
    this.reconPrev = false;
    this.r2W = 96;                            // the σ window, 2 ms
    this.r2ring = new Float64Array(this.r2W);
    this.r2sum = 0;
    this.r2i = 0;
    this.r2count = 0;
    this.ev = [];                             // detections waiting for their fit window
    this.rings = [];                          // …and the ring models being subtracted
    this.n = 0;                               // the absolute index of the sample in hand
    this.w = 0;
    this.inp = 0;
    this.dryOut = 0;                          // the input this stage is working from
    // The detector's prediction is fed with the *raw* input: it has to see the
    // click before the repair window opens, so it cannot wait for the repaired
    // signal to come back to it the way the repairer's own prediction does.
    this.dp1 = new Biquad(); this.dp1.setLowpass(sr, 4000, 0.707);
    this.dp2 = new Biquad(); this.dp2.setLowpass(sr, 4000, 0.707);
    // The repairer's prediction: 24 dB/oct low pass, fed with the *repaired*
    // signal so that a replaced sample can never leak back into the filter state
    this.pred = new Biquad(); this.pred.setLowpass(sr, 4000, 0.707);
    this.pred2 = new Biquad(); this.pred2.setLowpass(sr, 4000, 0.707);
    this.fast = new EnvFollower(sr, 1 / sr, 0.0006, 1);   // instant attack: 1-sample spikes
    this.slow = new EnvFollower(sr, 0.004, 0.025, 1);
    /* ── the *shape* of the deviation: the second witness ──────────────────
     * The fast/slow ratio above answers "how far above its own recent average
     * is this sample", and it under-reads exactly the pops that arrive where
     * the music carries energy in the same band: a one-sample spike is diluted
     * by the slow envelope's average, so the same pop reads ratio 7 in a quiet
     * bar and 2.3 in a bright one. What it *looks like* there is the second
     * witness, and it is the classic one: an impulse is a **unipolar**
     * deviation of the sample from its own low-frequency continuation, while
     * the music's own HF residual is zero-mean noise. Over the last couple of
     * milliseconds the two polarities of the signed residual are occupied to
     * the same depth for noise — `asym` near 0 — and to very different depths
     * for a spike, so `asym` near 1 is a click and 0.2 is music. Measured on
     * the audit fixture (pink low-passed at 9 kHz, pops at 9 per second): the
     * settled pop reads 0.85 median, 0.66 at the tenth percentile; the same
     * material without pops crosses 0.4 in 0.8 % of its samples; a snare
     * attack, which raises the *signal's* envelope as well — its HF is part of
     * the hit, not a spike on top of it — reads 0.18 median. Two milliseconds
     * is the window that separates those three: at 1 ms the music's own noise
     * crosses 0.4 four times as often (3.8 %), at 4 ms a second excursion
     * inside the window cancels the first and the pops' own reading falls back
     * into the noise's (measured). */
    this.dHi = 0;
    this.dLo = 0;
    this.shapeRate = Math.exp(-1 / (sr * 0.002));
    // How much of this signal lives above 4 kHz *on average* — the reference the
    // level gate below measures a spike against (a one-second average of the slow
    // envelope, seeded from the first sample so the first second is right).
    this.ref = 0;
    this.refRate = 1 - Math.exp(-1 / (sr * 1.0));
    // The detector's own warm-up, in samples (see tick). Both envelopes start
    // at zero, so their *ratio* starts at infinity and the detector would call
    // the first samples of every file a click; and even seeded, the fast
    // envelope's 0.6 ms attack against the slow one's 4 ms attack holds the
    // ratio above the threshold for the first ten milliseconds. So the stage
    // *listens* for its first samples and repairs nothing in them.
    this.warm = Math.max(32, Math.round(sr * 0.00133));
    this.warmLeft = this.warm;
    this.seedMax = 0;
  }
  reset() {
    this.dp1.reset(); this.dp2.reset(); this.pred.reset(); this.pred2.reset();
    this.fast.v = 0; this.slow.v = 0;
    this.dHi = 0; this.dLo = 0;
    this.ring.fill(0); this.plan.fill(0); this.mark.fill(0);
    this.w = 0; this.inp = 0; this.dryOut = 0; this.prevIn = 0;
    this.prevIn2 = 0; this.plateauPrev = false; this.reconPrev = false;
    this.r2ring.fill(0); this.r2sum = 0; this.r2i = 0; this.r2count = 0;
    this.ev.length = 0; this.rings.length = 0; this.n = 0;
    this.ref = 0;
    this.warmLeft = this.warm;
    this.seedMax = 0;
  }
  /** How much of the sample `o` samples away from a click is repaired. */
  shape(o) {
    const up = (o + this.pre) / this.rise;
    const down = (this.post - o) / this.fall;
    const g = up < down ? up : down;
    return g < 0 ? 0 : g > 1 ? 1 : g;
  }
  /** A sample already in the delay line, by its absolute index. */
  at(abs) {
    const L = this.ring.length;
    return this.ring[(this.w - (this.n - abs) + 2 * L) % L];
  }
  /* ── what the window behind a detection is, in one number ────────────────
   * The fitted model: r(k) = exp(-k/τ)·(a·cos ωk + b·sin ωk), k measured from
   * the detection. The amplitude is the *matched* one — A = Σ w·y·e^{-jωk} /
   * Σ w² with w(k) = exp(-k/τ), a complex division that never inverts a matrix,
   * so a short window stays well conditioned — and the candidate whose
   * explained energy |A|²·Σw² is largest wins. The share of the window that
   * model accounts for, R², is what licenses the removal: a click's ring is one
   * damped tone, a hi-hat or a snare is noise, and noise explains a tenth of
   * itself with one tone at best. Measured (probes wr29/wr30/wr31): rings
   * 0.26 … 0.48 over the family's windows, music 0.008 … 0.097 — the gate below
   * sits in that gap. */
  fitTail(pos, strength) {
    const sr = this.sr, tail = this.tail;
    let yy = 0;
    for (let k = 2; k <= tail; k++) { const y = this.at(pos + k); yy += y * y; }
    if (!(yy > 1e-12)) return null;
    const dec = new Float64Array(tail + 1);
    let best = null;
    for (const tauMs of [0.4, 0.6, 1.0, 1.5, 2.5, 4]) {
      const tauS = sr * tauMs * 1e-3, d = Math.exp(-1 / tauS);
      let w2 = 0, e = 1;
      for (let k = 0; k <= tail; k++) { dec[k] = e; if (k >= 2) w2 += e * e; e *= d; }
      for (let f = 6000; f <= 13000; f += 250) {
        const w = 2 * Math.PI * f / sr, c = Math.cos(w), sn = Math.sin(w);
        let sc = 0, ss = 0, cw = 1, sw = 0;
        for (let k = 0; k <= tail; k++) {
          if (k >= 2) { const g = dec[k], y = this.at(pos + k); sc += g * cw * y; ss += g * sw * y; }
          const nc = cw * c - sw * sn, ns = cw * sn + sw * c; cw = nc; sw = ns;
        }
        const a = 2 * sc / (w2 + 1e-30), b = 2 * ss / (w2 + 1e-30);
        const expl = (a * a + b * b) * w2 / 4;
        if (!best || expl > best.expl) best = { expl: expl, a: a, b: b, f: f, d: d, tauS: tauS };
      }
    }
    const r2 = best.expl / yy;
    const amp = Math.sqrt(best.a * best.a + best.b * best.b);
    if (r2 < 0.2 || !(amp > 1e-6)) return null;
    const len = Math.min(Math.round(sr * 0.008), Math.round(3 * best.tauS));
    return { pos: pos, a: best.a * strength, b: best.b * strength,
      w: 2 * Math.PI * best.f / sr, tauS: best.tauS, len: len, fade: Math.max(4, Math.round(sr * 0.001)), r2: r2 };
  }
  tick(x, amount, reconstructed, clipLevel) {
    if (amount <= 0.0001) {
      this.inp = x; this.dryOut = x;
      this.prevIn2 = this.prevIn; this.prevIn = x;
      this.plateauPrev = false; this.reconPrev = false;
      /* The delay line stays current while the stage is bypassed — engaging it
       * mid-file must not fit a window of stale samples — and whatever the tail
       * stage was holding is dropped. */
      this.ring[this.w] = x; this.plan[this.w] = 0; this.mark[this.w] = 0;
      this.w = (this.w + 1) % this.ring.length; this.n++;
      this.ev.length = 0; this.rings.length = 0;
      return x;
    }
    // ── 1 · the detector, on the sample that just arrived ──────────────────
    const pd = this.dp2.process(this.dp1.process(x));
    const d = x - pd;
    const ad = d < 0 ? -d : d;
    const f = this.fast.tick(ad);
    const s = this.slow.tick(ad);
    // …and its *shape*: the recent extremes of the signed residual, each on its
    // own short release. For the music's own HF they are equal and opposite;
    // for an impulse one of them is the spike and the other is only the noise
    // around it (see the constructor for the measurements).
    this.dHi = d > this.dHi ? d : this.dHi * this.shapeRate;
    this.dLo = d < this.dLo ? d : this.dLo * this.shapeRate;
    const asym = Math.abs(this.dHi + this.dLo) / (this.dHi - this.dLo + 1e-12);
    // a click is a *short* broadband burst: the fast envelope spikes far above
    // the slow one, while musical transients raise both together
    const ratio = f / (s + 1e-9);
    let k = clamp((ratio - 1.25) / 1.5, 0, 1);
    /* ── the detector's own warm-up ─────────────────────────────────────────
     * A ratio of two envelopes that are both on their way up from zero is not
     * the ratio of this statistic, and this is where it showed: at the first
     * sample `f / (s + 1e-9)` is 1e9, the detector called it a click, and the
     * repair replaced the head of the file with the low-pass prediction of a
     * signal that had not arrived yet — which is silence. The two feed each
     * other (`this.inp` is fed from the *repaired* output) and the file lost
     * its first ~256 samples: measured on a plain pink bed, the chain's output
     * was exactly 0.000 for the first 256 samples, and only the dry/wet
     * crossfade of the master power kept that from being heard — which is
     * itself the head-of-render bug this warm-up was found beside. Seeding the
     * envelopes from the first residual is not enough: the fast envelope's
     * 0.6 ms attack against the slow one's 4 ms holds the ratio at 3–8 for the
     * next ten milliseconds (measured), i.e. a pop-sized confidence on quiet
     * music. So the first 1.3 ms is spent *listening*: the largest residual in
     * that window – by then the 4 kHz filters have long settled – becomes the
     * starting point of both envelopes, and the ratio starts at 1 where the
     * file's own HF activity sits. A pop after that window is still a spike
     * against that seed, and the cost is stated: an event inside the first
     * 1.3 ms is not repaired. */
    if (this.warmLeft > 0) {
      this.warmLeft--;
      if (ad > this.seedMax) this.seedMax = ad;
      if (this.warmLeft === 0) { this.fast.v = this.seedMax; this.slow.v = this.seedMax; this.ref = this.seedMax; }
      k = 0;
    }
    // How sure the detector is that there was anything *there* to repair. This
    // gate has to be relative to the file, not to a fixed number: a transfer
    // digitised at −24 dBFS is the same record as one at −3, and an absolute
    // floor (f between 0.008 and 0.05) made the stage mute on the quiet one —
    // measured on the worn record, the dose that leaves 6 of 108 pops above a
    // clean copy at full scale left **63** of them above it at −24 dBFS, with
    // the detector's ratio statistic literally unchanged (it is scale-free:
    // p50 1.08, p99 2.3, max 6.7 at both levels). The thresholds therefore
    // scale with the file's own HF activity, which is the very same 0.111 that
    // the old constants were measured against — so a full-scale file behaves
    // exactly as it did, and a quiet one behaves like the record it is.
    this.ref += (s - this.ref) * (this.ref > 0 ? this.refRate : 1);
    const act = this.ref > 1e-3 ? this.ref : 1e-3;      // never below −60 dBFS
    k *= clamp((f - 0.072 * act) / (0.45 * act), 0, 1);
    // ── what the amount means here ────────────────────────────────────────
    // It is *how sure the detector has to be*, not how much of the click is
    // allowed to stay. Scaling the repair depth by the amount (the law before
    // this one) meant that at the automatic dose — 0.71 on a crackly record —
    // every detected pop kept 29 % of its amplitude in the file: the worst
    // tenth of the pops came out 9.5 dB above the music at the automatic
    // strength against 2.6 dB at full strength, with the same pops detected in
    // both runs. A pop that survives at −9 dB is still a pop, so the knob moves
    // the *threshold* instead: a detected click is repaired, and a lower
    // setting asks the detector for more confidence before it touches anything.
    /* A shape that is an impulse asks for less of that confidence: the ratio
     * under-reads a spike, so where `asym` says the deviation is one-sided the
     * detector does not have to be as sure by the ratio alone — by a quarter of
     * the scale at full strength, half that at the automatic dose, and nothing
     * on the music's own symmetric HF (measured: the audit fixture's quietest
     * pop reads ratio 2.3, i.e. 0.08 of the repair, and lands at −1.5…−4.4 dB
     * over the bed once its shape is heard; the same law moves the drum kit's
     * touched fraction from 3.2 % to 4.4 % and its worst snare window from
     * −66 to −62 dB against the −55 dB guard). */
    /* ── where this detector stops, measured ───────────────────────────────
     * At the automatic dose (0.71) the map above plus the knee below only let a
     * spike through once the ratio reads ≈ 2.2, and everything quieter than that
     * is the file's own music as far as this stage is concerned. A fixture with
     * the pops' amplitude spread over the same 0.34…1.70 the acceptance tool
     * uses leaves its *three quietest* pops in place: they read ratio 1.86–2.02
     * with asym 0.30–0.33 — below the 0.32…0.52 band that would discount the
     * threshold for this shape, so the shape term is worth 0.007 here, not the
     * 0.18 it could be. Measured in four beds, from one low-passed at 5 kHz to
     * one open at 12 kHz: 51–52 of 54 pops repaired, and *the same two or three*
     * left in every bed, so the floor belongs to the statistic and not to a
     * fixture. The trade, measured on the two fixtures that guard the stage:
     *
     *   map as shipped (1.25 / 1.5)   kit snare −62.1 dB ·  4.4 % of the kit ·  2.7 % of a clean master
     *   lowered to ≈ 2.0 (1.10/1.20)  kit snare −37.7 dB · 30.5 %           · 30.3 %
     *   lowered to ≈ 1.9 (1.05/0.90)  kit snare −13.6 dB · 61.6 %           · 81.7 %
     *
     * (dsp.test.js holds the snare at −55 dB and the clean master is the audit's
     * wide-band fixture.) The *shape* half of the same condition is priced too,
     * because it is the one lever that table does not cover: the survivors read
     * asym 0.30–0.33, under the 0.32…0.52 band, so their discount is worth
     * 0.007 rather than the 0.18 it could be — and moving the band down to where
     * they would collect it is not a lever either. Measured on the audit row's
     * own bed (54 pops; the row re-measures all of this):
     *
     *   shape band 0.32…0.52 · weight 0.25 (shipped)   4.37 % of the kit ·  2.74 % of a clean master · 3 left
     *   shape band 0.28…0.36 · weight 0.50            21.81 %           · 20.20 %               · 3 left
     *
     * — five times the kit price and seven times the master price for the same
     * three pops. What they would have to *read* is arithmetic on this stage's
     * own constants: firing needs `k ≥ 1 − 0.5·amount`, so the knee wants ratio
     * ≈ 2.22 at the automatic dose and ≈ 2.04 at the largest amount a profile can
     * hand the stage (0.95, the cap), while the leftovers read 2.03, 1.86 and
     * 1.80 — the strongest sits exactly on the edge of a full-strength dose, the
     * other two below any dose a profile can ask for. Reaching the quietest pops
     * of that fixture therefore costs the snare 24 dB of the 55 it has and
     * rewrites a third of a clean master, which is why the floor is written down
     * here rather than moved: those pops are, in this statistic,
     * indistinguishable from music.
     *
     * What the floor leaves is on the same row — measured with the acceptance
     * tool's own window (4–12 kHz, the popped 65 samples, the clean copy as the
     * reference), and, since the third witness closed it, measured there on the
     * *control* render with the witness switched off, so the numbers stay the
     * price of the map rather than a description of the shipped stage: the pops
     * the gate cannot reach stand 6.1 dB worst / 3.4 dB
     * median *over* the clean copy — they are spikes on a bed that is quiet
     * there, which is exactly why the ratio under-reads them — while the pops the
     * stage does repair land 9.0 dB *under* it, because a 4 kHz prediction cannot
     * put back the top end it replaced over the 0.33 ms it reaches in front of a
     * spike and the 1 ms behind it. The floor is where those two numbers trade: a
     * handful of clicks the statistic cannot separate from music, against a fifth
     * of every clean master dulled by 9 dB per pop, and the row re-measures all of
     * it. — The *map* below still stands exactly as priced here; what closed the
     * floor is not the map but the third witness above it, which by construction
     * is not a band statistic and so does not have this ceiling. */
    /* ── the third witness, on the same decision ────────────────────────────
     * The second difference of the sample *one behind* the one in hand — which
     * is what a causal statistic can know: x[p−2] − 2x[p−1] + x[p] is D2 at
     * p−1, and p−1 is still 17 samples away from being emitted. The bar moves
     * with the dose the same way the ratio's does (the dose asks how sure the
     * detector has to be, not how much of a pop may stay): at the automatic
     * 0.71 it sits at 4.9…6.9 σ, at a healthy card's 0.08 at 6.8…8.8 σ, and at
     * full strength at 4.9…6.9 σ once the knee below has done its work. The
     * width of that band is the whole trade, and it was swept against the
     * stage's guards (probe tools/work/sp11.js; per 8 s of material, and the
     * pops are the audit's four beds): The window needs its whole 96 samples before the
     * statistic means anything, so the branch is off for the first 2 ms of a
     * file — the same listening period the detector's own warm-up spends, for
     * the same reason. It is deliberately *not* multiplied by the level gate
     * above: that gate exists to make the ratio relative to the file's own
     * activity, and this branch is already a ratio to the local activity of its
     * own band. It *is* folded in **before the knee below**, and that placement
     * is measured: a hi-hat's onset is a step in this statistic too (a 0.2 ms
     * attack of a 7–17 kHz burst, against the σ of the quiet bed before it),
     * and the knee is what keeps the stage off it — at a healthy card's dose the
     * ratio's own confidence there buys 0.038 of a repair. Bypassing the knee
     * moved the loudest of the performance fixture's 16 hits by 1.63 dB, which
     * is the one thing this stage may not do (dsp.test.js holds it to 1.0 dB);
     * through the knee it moves by less than 0.1 dB.
     *
     *   band             pops left   performance   kit snare   kit touched   clean master
     *   5+3 … 8+4              3     0.52 dB       −62.1 dB      4.40 %        2.74 %
     *   4.5+3 … 6.5+3          1     0.52 dB       −62.1 dB      4.85 %        2.74 %
     *   4+3 … 6+3              0     0.52 dB       −62.1 dB      4.94 %        2.74 %
     *   4.5+3 … 6+2            0     0.52 dB       −62.1 dB      4.94 %        2.74 %
     *
     * i.e. closing the floor completely costs half a percentage point of the kit
     * being touched and moves nothing else — the snare, the performance's hits
     * and the clean master read the same number to the digit at every band. */
    const d2 = this.prevIn2 - 2 * this.prevIn + x;
    if (this.r2count >= this.r2W && !this.plateauPrev && !this.reconPrev) {
      const sigma = Math.sqrt(this.r2sum / this.r2W);
      /* A sample that straddles the clip rail is the clip's own signature, not a
       * click: clipping *creates* a sample-level corner (that is what the repair
       * stage exists for), and the plateau test further down only ever sees the
       * sample in its own hand. This witness looks three samples wide — the two
       * before the one in hand and the one in hand — so the rail guard has to be
       * three samples wide too. Measured: without it the branch wrote 4.3 dB more
       * than it may into the *unclipped* part of the clipped fixtures (matrix,
       * `…and where it must write nothing`); with it those rows are back to their
       * pre-round values. */
      let railed = false;
      if (clipLevel > 0.02) {
        railed = (x < 0 ? -x : x) >= clipLevel
          || (this.prevIn < 0 ? -this.prevIn : this.prevIn) >= clipLevel
          || (this.prevIn2 < 0 ? -this.prevIn2 : this.prevIn2) >= clipLevel;
      }
      if (!railed && sigma > 0) {
        const kR = smoothstep(4 + 3 * (1 - amount), 6 + 3 * (1 - amount),
          (d2 < 0 ? -d2 : d2) / sigma);
        if (kR > k) k = kR;
      }
    }
    /* ── …and digital silence does not fill the window ──────────────────────
     * A look-ahead stage in front of this one emits `look` samples of *exact*
     * zeros before the first real sample (measured: with the de-clipper engaged
     * the de-clicker's input is 0.000000 for its first 272 samples and then
     * jumps to full level — a step out of digital silence, which is a genuine
     * click in this statistic and would be repaired as one). Audio at any level
     * carries a floor — dither, tape, room — so exact zeros are not signal: they
     * neither fill the window nor count towards it, and the branch simply waits
     * for its 96 real samples. The same listening rule the detector's own
     * warm-up follows, for the same reason. A pop written *into* digital silence
     * is therefore not repaired; it is also 90 dB below anything audible. */
    const silent = x === 0 && this.prevIn === 0 && this.prevIn2 === 0;
    if (!silent) {
      const sq = d2 * d2;
      this.r2sum += sq - this.r2ring[this.r2i];
      this.r2ring[this.r2i] = sq;
      this.r2i = (this.r2i + 1) % this.r2W;
      if (this.r2count < this.r2W) this.r2count++;
    }
    const th = 1 - 0.5 * amount
      - 0.25 * amount * smoothstep(0.32, 0.52, asym);
    k = smoothstep(th, th + 0.30, k);
    // ── 2 · nothing is emitted unheard: the sample waits in the delay line ──
    const L = this.ring.length;
    this.ring[this.w] = x;
    // A sample the de-clipper reconstructed is not a click, whatever it looks
    // like in the detector (see DeClipper): it is a *peak*, and replacing it
    // with a low-frequency prediction would take the peak off again.
    if (reconstructed) k = 0;
    // …and neither is the flat top this detector would otherwise happily call a
    // click. A clipped peak *is* a broadband discontinuity — it has to be, that
    // is what clipping does to a waveform — so a de-clicker left to itself
    // pulls the flat tops of a loud master down to a third of their level
    // (measured: 0.99 → 0.15 in the middle of a plateau). Whoever is doing the
    // repairing, the *signature* of clipping must not be repaired as a click:
    // if this sample sits at the file's measured clipping level and does not
    // differ from its predecessor, it is a plateau. The test is local on
    // purpose, so it holds whether or not the de-clipper itself is engaged.
    let prevIn = this.prevIn;
    this.prevIn = x;
    this.prevIn2 = prevIn;
    let plateau = false;
    if (clipLevel > 0.02) {
      const ax0 = x < 0 ? -x : x;
      const ap = prevIn < 0 ? -prevIn : prevIn;
      const diff = ax0 - ap;
      if (ax0 >= clipLevel && ap >= clipLevel && (x > 0) === (prevIn > 0)
          && diff < 0.0025 && diff > -0.0025) { k = 0; plateau = true; }
    }
    // The flag travels *with* the sample, not with the detection: a detection
    // at the edge of a clipped plateau plans a window that reaches back into
    // the plateau (that is how the look-ahead works), and the plateau has to
    // survive it. Two sources set it — the de-clipper, whose reconstructed
    // peaks are broadband by construction, and the local test just above,
    // which holds whether or not the de-clipper is engaged at all.
    this.mark[this.w] = (plateau || reconstructed) ? 1 : 0;
    this.plateauPrev = plateau;
    this.reconPrev = reconstructed;
    if (k > 0.02) {
      /* …and it asks the tail stage for the ring behind it, one event at a time:
       * a ring is over in at most 8 ms, so a second detection inside that window
       * is either the same ring or a click the first model already covers. */
      if (this.ev.length === 0 && this.rings.length === 0) this.ev.push({ pos: this.n, k: k < 1 ? k : 1 });
      // a detection plans the whole window around itself, in front of the click
      // as much as behind it (that is what the look-ahead is for)
      for (let o = -this.pre; o <= this.post; o++) {
        const g = k * this.shape(o);
        if (g <= 0.005) continue;
        const idx = (this.w + o + L) % L;
        if (g > this.plan[idx]) this.plan[idx] = g;
      }
    }
    // ── 3 · emit the sample that is `look` samples old ─────────────────────
    const r = (this.w - this.look + L) % L;
    const xd = this.ring[r];
    let m = this.plan[r];
    if (this.mark[r]) m = 0;                   // a window planned over a plateau is cancelled
    this.mark[r] = 0;
    this.plan[r] = 0;
    this.dryOut = xd;                          // what the A/B compares against
    // the prediction always runs, so its state is continuous whether or not the
    // sample in hand is being repaired (a filter switched on for one window at
    // a time would ring at both of its ends)
    /* ── what stands in the window, measured ───────────────────────────────
     * Inside a full-replacement window this filter is fed its own output, so it
     * has no input left and runs to a fixed point: measured sample by sample on
     * the acceptance fixture (#374596), `pred` freezes at −0.1785 for 60+ samples
     * and the window becomes a ≈1.35 ms DC plate. That is audible as a hole
     * (the residual is as loud as the music the window removed: median 0.8 dB of
     * the music's own 4–12 kHz, worst 8.1), and it is still the best of the four
     * fills that were measured on the same fixture — band 4–12 kHz over the clean
     * copy · leftover against the music's peaks · the drum kit:
     *
     *   as shipped (self-fed low pass)  median −10.2 · worst +4.0 · 3/72 over · fill cost med 0.7 dB · kit: snare −62.1, 4.4 %
     *   the same filter fed the dry x  median  −0.8 · worst +39.8 · 30/72      · med 4.1 · worst 46.8 · kit: snare −70.8, 2.9 %
     *   3-tap polynomial extrapolation  median  −6.5 · worst +16.0 · 13/72     · med 20.1 · worst 40.9 · kit: snare −50.4, 69.7 %
     *   4-tap polynomial extrapolation  median  +2.9 · worst +14.6 · 38/72     · med 6.3 · worst 27.9 · kit: snare −0.3, 98.8 %
     *
     * The extrapolators carry gain (3×, 4×) and therefore fire on snares (the
     * kit is 70–99 % touched and the −55 dB snare guard is gone), and letting the
     * *dry* pop into the prediction is worse on every witness. So the trade the
     * shipped fill makes — a low-frequency hole in exchange for the pop — is the
     * best measured one; the window *width* was swept too (pre/post 4/8 … 16/48)
     * and moves the leftover by under 1 dB, so the width is not the lever either. */
    const p = this.pred2.process(this.pred.process(this.inp));
    let out = m > 0.001 ? xd + (p - xd) * m : xd;
    /* ── 4 · …and the ring the click left behind, on the same detection ─────
     * Applied to the sample being emitted, never to the dry A/B reference: the
     * model is parameterised from the detection, so the removal is an
     * *extrapolation* of a tone that is already measured — the fit window itself
     * is behind the emitted sample by `pre + 1` samples of the look-ahead.
     *
     * …and it is scaled by what the de-clicker's own window has *not* already
     * taken: that window replaces the flagged samples with a 4 kHz prediction of
     * the repaired signal, so a ring inside it is gone with weight `m` — the mix
     * applied to this very sample. Subtracting the model there as well removes
     * the same tone twice and, since a prediction of a 9 kHz tone is near zero,
     * puts it back inverted: measured on a synthetic 9 kHz ring that is exactly
     * what happened — the fit was right to the hundredth (f0 9000.0 Hz, a 0.4626,
     * b 0.1791 against 0.458 / 0.19 predicted) and the output was *worse* than
     * the input, with the whole file's crackle index up from 0.512 to 0.938
     * instead of down. With the model weighted by `1 − m`, the two stages share
     * the ring exactly: the window's share follows the repair's own shape, the
     * tail's share takes over as that shape falls to zero, and nothing is
     * subtracted twice. The last millisecond of the model fades out, so the
     * removal cannot end in a step of its own. */
    const ne = this.n - this.look;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const md = this.rings[i];
      const kk = ne - md.pos;
      if (kk > md.len) { this.rings.splice(i, 1); continue; }
      if (kk < 0) continue;
      const env = (1 - m) * Math.exp(-kk / md.tauS) * Math.min(1, (md.len - kk) / md.fade);
      out -= env * (md.a * Math.cos(md.w * kk) + md.b * Math.sin(md.w * kk));
    }
    for (let i = this.ev.length - 1; i >= 0; i--) {
      const e = this.ev[i];
      if (this.n - e.pos < this.tail) continue;
      this.ev.splice(i, 1);
      const md = this.fitTail(e.pos, e.k);
      if (md) this.rings.push(md);
    }
    this.inp = out;                                    // filter sees the repair
    this.n++;
    this.w = (this.w + 1) % L;
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* glue compressor                                                             */
/* -------------------------------------------------------------------------- */

const GLUE_DECIM = 4;

class GlueComp {
  constructor(sr) {
    this.sr = sr;
    this.atk = 0.012;
    this.rel = 0.180;
    this.env = new EnvFollower(sr, this.atk, this.rel, GLUE_DECIM);
    this.gain = new Ramp(GLUE_DECIM, 1);
    this.thr = 0.079;          // ≈ −22 dBFS *at the file's own peak* (see setRef)
    this.ref = 1;              // the file's peak as a scale factor, 1 = full scale
  }
  reset() { this.env.v = 0; this.gain.reset(1); }
  /**
   * Where "−22 dBFS" sits, for this file. The compressor is a piece of taste,
   * not an absolute target: what it should do is grab the peaks that stand
   * above the *programme's* own level, and how loud the upload happens to be
   * says nothing about the programme. Measured on one fixture 20 dB down, the
   * fixed threshold let the compressor do nothing at all (effect −45.8 dB at
   * 0 dBFS, none at −20 dBFS) — the same slider, the same measurement, no
   * compression. Scaling the threshold by the file's peak keeps the nominal
   * behaviour (a file at full scale: the threshold is exactly the old 0.079)
   * and makes the glue a function of the waveform.
   */
  setRef(refLin) { this.ref = clamp(refLin, 0.002, 4); }
  /**
   * Per-song timing. A drum-driven recording needs the compressor to let the
   * hit through (a slower attack) and to be back at unity before the next one
   * (a shorter release); a sustained recording wants the opposite: grab a
   * little and let go slowly. That is one number from the measurement —
   * `glueTime` — telling the same compressor what this song is.
   */
  setTime(t) {
    const atk = 0.005 + 0.030 * t;
    const rel = 0.130 + 0.300 * t;
    if (Math.abs(atk - this.atk) < 1e-4 && Math.abs(rel - this.rel) < 1e-3) return;
    this.atk = atk;
    this.rel = rel;
    this.env.set(this.sr, atk, rel);
  }
  /** soft 2:1 glue with automatic makeup — linear domain, one sqrt */
  tick(x, amount) {
    if (amount <= 0.0001) return x;
    const ax = x < 0 ? -x : x;
    const e = this.env.tick(ax);
    const thr = this.thr * this.ref;
    const gr = e > thr ? Math.sqrt(thr / e) : 1;
    this.gain.set(1 - amount * (1 - gr));
    const g = this.gain.tick();
    const makeup = 1 + amount * (1 - gr) * 0.75;
    return x * g * makeup;
  }
}

/** PLL loop filter: natural frequency and damping of the frequency estimate. */
const HUM_PLL_FN_HZ = 0.3;     // how fast the estimate is allowed to swing — real
                                // wow/flutter lives at a few Hz at most; faster than
                                // this starts answering to the programme instead
const HUM_PLL_ZETA = 1.0;      // critically damped — settles without overshoot
                                // ringing into the notch retune that follows it
/** Lock-in range, hertz either side of fCenter, before the loop is re-seeded. */
const HUM_PLL_MIN_HZ = 45;
const HUM_PLL_MAX_HZ = 65;
/** Samples between "is the estimate worth a retune" checks (control-rate, like
 *  every other decimated coefficient update in this file — the PLL itself still
 *  updates every sample, only the expensive trig in Biquad.set* is throttled). */
const HUM_PLL_DECIM = 8;

/**
 * Software PLL that tracks the mains fundamental.
 *
 * A notch fixed at the frequency measured once, up front, chases nothing: a
 * turntable's platter speed and a tape transport's capstan both wander by
 * fractions of a hertz with motor load, belt age and mains-side wow, so a hum
 * that measured 50.1 Hz at the start of a side can sit at 49.8 Hz two minutes
 * in. A notch narrow enough to reject hum without eating the bass (see
 * HUM_BW_HZ) is narrow enough to miss that drift. The PLL is a synchronous
 * (lock-in) detector: a self-tracking bandpass isolates the fundamental's
 * neighbourhood, a local oscillator is quadrature-mixed against it, and the
 * resulting phase error steers the oscillator's own frequency through a
 * critically-damped PI loop filter — the textbook analogue/digital PLL
 * topology, here doing for a drifting 50 Hz line what the FracDelay PLL-less
 * cross-correlation in AzimuthCorrector does for channel timing.
 *
 * Derivation check (own working, since a lock-in detector is easy to get
 * backwards): with the bandpassed input locked to xb ≈ A·sin(φ) and the local
 * oscillator at θ, mixing against cos θ and sin θ and low-passing the double-
 * frequency term away leaves mixI → (A/2)·sin(φ−θ) and mixQ → (A/2)·cos(φ−θ) —
 * so atan2(mixI, mixQ) is the signed phase error φ−θ directly, zero at lock,
 * and mixI²+mixQ² ≈ (A/2)² is an amplitude estimate that is independent of
 * that error (used only for the mag>0 guard below). The first implementation
 * of this loop used atan2(mixQ, mixI) with mixQ built from xb·(−sin θ) instead
 * — innocuous-looking, but it moves the detector's zero to a *quarter-cycle*
 * phase error rather than zero, so a perfectly locked loop still reports a
 * −0.25-cycle error and integrates against it forever: on a steady, driftless
 * 50 Hz test tone the estimate did not hold 50 Hz, it walked monotonically
 * away from it (49.99 Hz at 0.5 s to 49.73 Hz at 9.5 s and still falling) —
 * the sign-convention equivalent of deliverable #2's A/B swap, caught the same
 * way, by asserting what the correct answer is supposed to be and finding the
 * code did not produce it.
 *
 * The loop filter gains are not hand-picked: HUM_PLL_FN_HZ/HUM_PLL_ZETA fix a
 * standard second-order PI loop (Kp = 2ζωn, Ki = ωn²), chosen so the estimate
 * settles in roughly a second without overshoot ringing into the notch retune.
 * A first attempt skipped this and additionally summed each sample's
 * (Kp·err + Ki-integral) *into* the running frequency rather than computing
 * the frequency fresh from a fixed centre each sample — an accidental extra
 * integrator (type-III loop) that never settles at any gain: it was still
 * drifting/oscillating around the true frequency after 10 s of simulation
 * regardless of how far the gains were turned down. Fixed by keeping fCenter
 * fixed (re-seeded only on profile/file change) and setting
 * freq = clamp(fCenter + Kp·err + integ, 45, 65) outright each sample.
 */
class HumPLL {
  constructor(sr) {
    this.sr = sr;
    this.bp = new Biquad();
    this.lpI = new Biquad();
    this.lpQ = new Biquad();
    this.lpI.setLowpass(sr, 6, 0.7071);
    this.lpQ.setLowpass(sr, 6, 0.7071);
    const wn = TWO_PI * HUM_PLL_FN_HZ;
    this.kp = 2 * HUM_PLL_ZETA * wn;
    this.ki = wn * wn;
    this.fCenter = 50;
    this.freq = 50;
    this.bpFreq = -1;              // forces the bandpass to be cut on first tick
    this.theta = 0;
    this.integ = 0;
  }
  /** Re-seed the loop at a new nominal grid frequency (profile/file change) —
   *  wherever the estimate had wandered to under the old nominal is no longer
   *  a useful starting point for a different file. */
  setCenter(f0) {
    if (f0 === this.fCenter) return;
    this.fCenter = f0;
    this.freq = f0;
    this.integ = 0;
    this.bpFreq = -1;
  }
  reset() {
    this.bp.reset(); this.lpI.reset(); this.lpQ.reset();
    this.freq = this.fCenter;
    this.theta = 0;
    this.integ = 0;
    this.bpFreq = -1;
  }
  tick(x) {
    // Self-tracking bandpass: recut only when the estimate has moved enough to
    // matter, not every sample — the loop still updates at full rate, only the
    // (comparatively expensive) coefficient recompute is throttled.
    if (Math.abs(this.freq - this.bpFreq) > 0.1) {
      this.bpFreq = this.freq;
      this.bp.setBandpass(this.sr, this.freq, 6);
    }
    const xb = this.bp.process(x);
    const c = Math.cos(this.theta), s = Math.sin(this.theta);
    const mixI = this.lpI.process(xb * c);
    const mixQ = this.lpQ.process(xb * s);
    let err = 0;
    if (mixI * mixI + mixQ * mixQ > 1e-14) err = Math.atan2(mixI, mixQ) / TWO_PI;
    // Anti-windup: without a bound the integrator can wander far past the
    // clamp while the loop is unlocked (silence, or a false hum measurement
    // on hum-free material), then take seconds to unwind once real hum
    // appears — cheaper to just cap it at what the frequency clamp allows.
    this.integ = clamp(this.integ + (err * this.ki) / this.sr, -20, 20);
    this.freq = clamp(this.fCenter + this.kp * err + this.integ, HUM_PLL_MIN_HZ, HUM_PLL_MAX_HZ);
    this.theta += (TWO_PI * this.freq) / this.sr;
    if (this.theta > Math.PI) this.theta -= TWO_PI;
    else if (this.theta < -Math.PI) this.theta += TWO_PI;
  }
}

/**
 * Mains hum: a narrow notch at 50/60 Hz plus its 2nd and 3rd harmonic.
 *
 * Hum is the one analogue defect that is *exactly* periodic, so it is the one
 * that can be removed without touching the music — provided you know the mains
 * frequency and that the recording did not drift. The notches are dosed by the
 * measurement and swept away entirely when nothing was detected.
 *
 * Q is deliberately moderate (≈8, i.e. a ~6 Hz skirt at 50 Hz): a needle-drop
 * hum is never exactly on frequency — a turntable that runs 0.5 % fast is at
 * 50.25 Hz — and a razor-thin notch would leave the shoulder behind while
 * removing a slice of the bass.
 *
 * The centre that drives all three notches now comes from a live HumPLL
 * rather than the frequency measured once at analysis time: that measurement
 * is still the PLL's starting point (and its re-seed on a profile change,
 * see set()), but between there and the end of the file the notch follows
 * whatever the mains actually did, not what it did at t=0.
 */
class HumNotch {
  constructor(sr) {
    this.sr = sr;
    this.cut = [new Biquad(), new Biquad(), new Biquad()];
    this.pll = new HumPLL(sr);
    this.gains = [0, 0, 0];
    this.notchHz = -1;             // frequency the cuts are currently built for
    this.tickCount = 0;
    this.lastHz = 0;
    this.last = [2, 2, 2];         // impossible values → the first prepare() sets up
  }
  set(f0) {
    if (f0 === this.lastHz) return;
    this.lastHz = f0;
    this.pll.setCenter(f0);
    this.notchHz = -1;             // force an immediate retune, not next decim tick
    this.last = [2, 2, 2];         // force the next prepare() to recompute
  }
  reset() {
    for (const b of this.cut) b.reset();
    this.pll.reset();
    this.notchHz = -1;
    this.tickCount = 0;
  }
  prepare(d1, d2, d3, f0) {
    if (d1 === this.last[0] && d2 === this.last[1] && d3 === this.last[2]) return;
    this.last = [d1, d2, d3];
    // One dose per harmonic, each measured against its *own* five-hertz
    // shoulders. The old law notched the second and third harmonic by a fixed
    // −34/−26 dB whenever the fundamental was notched at all — which took 20 dB
    // out of 100 and 150 Hz on a recording whose hum was a pure 50 Hz line and
    // whose bass lived exactly there. A harmonic that was not measured does not
    // get notched.
    this.gains = [-HUM_DB_PER_DOSE * d1, -HUM_DB_PER_DOSE * d2, -HUM_DB_PER_DOSE * d3];
  }
  tick(x) {
    this.pll.tick(x);
    this.tickCount++;
    // Constant *absolute* width, not constant Q. Hum drifts in hertz, not in
    // octaves — a turntable running 0.5 % fast sits at 50.25 Hz whether that is
    // its fundamental or the third harmonic, so a notch that is three hertz wide
    // still lands on it 14 dB down. Width matters because the sub octave lives in
    // the same 30–60 Hz region: a five-hertz-wide bell measured 2.5 dB out of the
    // 41 Hz bin (its skirt, not its bandwidth), which is a third of what the sub
    // synthesiser adds down there — three hertz costs half a decibel instead.
    //
    // Retuning is decimated (checked every HUM_PLL_DECIM samples) and gated on
    // the estimate having moved far enough to matter — the PLL itself still
    // tracks every sample, this just throttles the coefficient recompute.
    const due = this.notchHz < 0 || this.tickCount % HUM_PLL_DECIM === 0;
    if (due && Math.abs(this.pll.freq - this.notchHz) > 0.05) {
      this.notchHz = this.pll.freq;
      for (let i = 0; i < 3; i++) {
        const f = this.notchHz * (i + 1);
        this.cut[i].setPeak(this.sr, f, clamp(f / HUM_BW_HZ, 1.2, 60), this.gains[i]);
      }
    }
    return this.cut[2].process(this.cut[1].process(this.cut[0].process(x)));
  }
}

/* -------------------------------------------------------------------------- */
/* per-channel processing chain                                                */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* true-peak limiter — the file's last stage                                   */
/* -------------------------------------------------------------------------- */

/**
 * True-peak limiter (the export ceiling).
 *
 * The chain's soft clip keeps *samples* under full scale, and that is not the
 * same thing as keeping the *waveform* under it: a signal that turns around
 * between two samples — which is what every limit and every bright master does
 * — reaches higher between them than at them. Measured over the four fixtures
 * that ship with the app, a file whose sample peak sits at −0.02 dBFS arrives
 * at the encoder at up to +1.0 dBTP, and a codec that has to encode an
 * overdriven waveform distorts it. Every streaming target is a *true-peak*
 * target for exactly this reason (−1 dBTP, −2 dBTP when a master is louder than
 * −14 LUFS), and the app's own measurement reports the same figure as `ispDb` —
 * so this stage closes the loop between what the app measures and what it does.
 *
 * It is a look-ahead limiter, not a clipper: the peak is *estimated* between
 * the samples (a Catmull-Rom curve through the neighbouring samples, evaluated
 * at four points per interval), the gain needed to keep that estimate under the
 * ceiling is computed `look` samples ahead of the sample it applies to, and the
 * applied gain is the minimum over that window — so the reduction is already
 * ramping down when the peak arrives, which is why it does not click and does
 * not overshoot. Release is slow (80 ms) and symmetric across the channels: the
 * detector takes the maximum over all channels, so a loud left channel cannot
 * pull the right one with it and the image stays put.
 *
 * With a ceiling of 0 dB (the default) the stage is *off*: no delay, no gain,
 * the output is the input — a file that does not need a limiter must not get
 * one. `latency` reports the look-ahead only while it is engaged.
 */
/* --------------------------------------------------------------------------
 * Inter-sample peak ("true peak"): 4× oversampled, 32-tap Hann-windowed sinc.
 *
 * The limiter and the *measurement* (`ispStep` in dsp-utils.js, which reports
 * `ispDb` and drives the diagnosis) build this table from the same numbers and
 * judge the same intervals — a limiter that estimates the peak differently from
 * the meter that reports it cannot be trusted about its own ceiling. The short
 * seven-tap sinc that used to sit in both places read 0.5 dB *low* on bright
 * transient material: measured against ffmpeg's ebur128 and against an
 * independent 32-tap meter, the app reported −2.10 dBTP for an export both
 * other meters put at −1.60 — 0.4 dB above the ceiling it had just been given.
 * ----------------------------------------------------------------------- */
const ISP_TAPS = 32;
const ISP_PHASES = 4;
const ISP_TABLE = (() => {
  const N = ISP_TAPS;
  const t = [];
  for (let p = 1; p < ISP_PHASES; p++) {
    const taps = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      const x = (n - (N / 2 - 1)) - p / ISP_PHASES;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (n + 0.5) / N);
      taps[n] = sinc * w;
    }
    let sum = 0;
    for (let n = 0; n < N; n++) sum += taps[n];
    for (let n = 0; n < N; n++) taps[n] /= sum;
    t.push(taps);
  }
  return t;
})();

class TruePeakLimiter {
  constructor(sr) {
    this.sr = sr;
    this.on = false;
    this.delay = 0;                 // samples of look-ahead (the reported part)
    this.len = 1;
    this.lim = 1;
    this.rel = 1;
    this.w = 0;
    this.pos = 0;
    this.ring = [];
    this.dqG = new Float64Array(2);
    this.dqI = new Float64Array(2);
    this.head = 0;
    this.tail = 0;
    this.g = 1;
  }

  reset() {
    for (const r of this.ring) r.fill(0);
    this.w = 0; this.pos = 0; this.g = 1;
    this.head = 0; this.tail = 0;
  }

  /**
   * Configure for this render: `ceilDb` is the target in dBTP (0 = the stage is
   * off, and then nothing is delayed either).
   */
  set(sr, nCh, ceilDb) {
    const on = ceilDb < -0.01;
    // 1.5 ms of look-ahead — the window the gain is minimised over — plus the
    // sixteen samples the interpolator needs to see *past* the interval it
    // judges (ISP_TAPS/2; the kernel is symmetric, so half of it is future)
    const look = Math.max(8, Math.round(sr * 0.0015));
    const delay = on ? look + ISP_TAPS / 2 : 0;
    const len = delay + ISP_TAPS + 8;
    if (delay !== this.delay || this.ring.length !== nCh) {
      this.ring = [];
      for (let c = 0; c < nCh; c++) this.ring.push(new Float32Array(len));
      this.dqG = new Float64Array(look + 3);
      this.dqI = new Float64Array(look + 3);
      this.head = 0; this.tail = 0; this.w = 0;
    }
    if (on !== this.on) this.g = 1;
    this.on = on;
    this.delay = delay;
    this.len = len;
    this.look = look;
    // A tenth of a decibel of margin below the target: the estimate below is the
    // same one the app's own `ispDb` is built from, and the limiter's gain only
    // ever smooths the waveform — so the margin is insurance, not slack. That
    // pair of statements is only worth anything while the *estimate* is honest,
    // which is what the 32-tap kernel is for (see ISP_TABLE).
    this.lim = Math.pow(10, (Math.min(0, ceilDb) - 0.1) / 20);
    this.gate = this.lim * 0.5;      // an interval this far down cannot overshoot
    this.rel = 1 - Math.exp(-1 / (Math.max(1, sr) * 0.08));   // ~80 ms release
    /* ── what this stage costs a master that has no dynamics left ──────────
     * Measured on the acceptance "squashed master" fixture (itself built at
     * three crush levels), spread = the 20 ms envelope's p98 − p05:
     *
     *   DR 8.1 dB  in 11.38 → out 10.38   (−1.00 dB)
     *   DR 6.8 dB  in  9.92 → out  8.37   (−1.55 dB)
     *   DR 5.3 dB  in  7.91 → out  5.81   (−2.09 dB)
     *
     * and the cause is this stage and not the compressor: with `tpCeil: 0` the
     * same renders lose 0.44 dB, with the ceiling at −2 they lose 1.55. The
     * mechanism is honest — a master peaking at −1.11 dBFS needs 1.1 dB of
     * reduction to hold a −2 dBTP ceiling, and the gain is applied *inside* the
     * loud passages (80 ms release) while the quiet ones come back up, so the
     * loud/quiet ratio shrinks by more than the level does. A whole-file static
     * trim instead of limiting would keep the ratio: measured on the same
     * fixture, a trim of 0.5 / 1.0 / 1.5 / 2.0 dB (with `refDb` lowered to
     * match, so the loudness matcher does not undo it) leaves the spread at
     * −1.20 / −0.89 / −0.59 / −0.52 dB while the peak still lands on −2.10.
     * What a trim costs is loudness: 1–2 dB on a class of file that the card
     * already calls "squashed". The suite therefore *measures* the loss (the
     * acceptance row prints it, and the row's note reads "squashed" at DR < 9)
     * and does not yet assert against it: choosing between a 1.5 dB dynamic
     * loss at the input's level and a 0.5 dB loss 1–2 dB quieter is a product
     * decision about the promise "the output keeps the upload's level", and it
     * is the next thing to decide here. */
  }

  /**
   * Limit one block in place, across all channels — the detector takes the
   * maximum over the channels, so a loud left channel cannot pull the right one
   * down with it and the stereo image stays put.
   */
  processBlock(dst, nCh, frames) {
    if (!this.on) return;
    const len = this.len, D = this.delay, lim = this.lim, cap = this.dqG.length;
    const n = Math.min(nCh, this.ring.length);
    for (let i = 0; i < frames; i++) {
      const w = this.w;
      // ── 1 · the peak *between* the samples ────────────────────────────────
      // The very estimator the measurement uses (dsp-utils `ispStep`): 32 taps
      // of a Hann-windowed sinc at four phases, judging the interval sixteen
      // samples behind the newest one — so all 32 taps are history, and every
      // interval gets looked at exactly once. Using a cheaper local curve
      // instead (a Catmull-Rom through the neighbours) was measured against
      // this: it reported 0.23 dB *less* than the measurement found, i.e. the
      // limiter left the file over the ceiling while claiming otherwise.
      // The phases are only evaluated near the ceiling (the local 32-sample
      // maximum is the cheap gate): an interval whose loudest sample is 6 dB
      // below the ceiling cannot interpolate its way above it.
      let pk = 0;
      const table = ISP_TABLE;
      for (let c = 0; c < n; c++) {
        const ring = this.ring[c];
        ring[w] = dst[c][i];
        const base = (w - (ISP_TAPS - 1) + len) % len;
        let m = 0;
        for (let nn = 0; nn < ISP_TAPS; nn++) {
          const av = ring[(base + nn) % len];
          const a = av < 0 ? -av : av;
          if (a > m) m = a;
        }
        if (m > pk) pk = m;
        if (m < this.gate) continue;
        for (let d = 1; d < ISP_PHASES; d++) {
          const t = table[d - 1];
          let v = 0;
          for (let nn = 0; nn < ISP_TAPS; nn++) v += ring[(base + nn) % len] * t[nn];
          const av = v < 0 ? -v : v;
          if (av > pk) pk = av;
        }
      }
      // ── 2 · the gain this interval needs … ────────────────────────────────
      const req = pk > lim ? lim / pk : 1;
      // …tracked in a monotone deque, so the minimum over the look-ahead window
      // is O(1) — and that minimum is what makes the attack exact: the gain has
      // already come down by the time the peak it belongs to is emitted
      while (this.tail !== this.head) {
        const back = (this.tail - 1 + cap) % cap;
        if (this.dqG[back] >= req) this.tail = back; else break;
      }
      this.dqG[this.tail] = req;
      this.dqI[this.tail] = this.pos + i;
      this.tail = (this.tail + 1) % cap;
      const oldest = this.pos + i - this.look;
      while (this.head !== this.tail && this.dqI[this.head] < oldest) this.head = (this.head + 1) % cap;
      const gReq = this.dqG[this.head];
      // ── 3 · instant attack (the window looked ahead), slow release ────────
      // The *upward* law is the one that is easy to get wrong: a gain that only
      // ever multiplied by a factor below one decayed towards silence on every
      // file, whether or not it needed limiting (measured: material 6 dB under
      // the ceiling came out 22 dB down). Down is instant; up is exponential.
      if (gReq < this.g) this.g = gReq;
      else this.g += (gReq - this.g) * this.rel;
      // ── 4 · emit the sample from `D` samples ago, through that gain ───────
      const g = this.g;
      const r = (w - D + len) % len;
      for (let c = 0; c < n; c++) dst[c][i] = this.ring[c][r] * g;
      this.w = w + 1 === len ? 0 : w + 1;
    }
    this.pos += frames;
  }
}

class ChannelChain {
  constructor(sr) {
    this.sr = sr;
    // The chain is DC-blocked at both ends. Both blockers sit deliberately low
    // (2 Hz): a guard is there to remove an *offset*, and the higher the corner,
    // the more it rotates the phase of the 20–60 Hz region — which is where the
    // sub-bass repair works and where a rotation shows up as a peak lift.
    // Measured on a loud dense master: a one-pole at 16 Hz lifts the internal
    // peak by 1.4 dB, at 8 Hz by 1.2 dB, at 2 Hz by 0.05 dB.
    this.dc = new DCBlocker(sr, 2);

    // Sub-sonic guard: a turntable rumble, a desk, a building — measured per
    // song (18–35 Hz above the bass band in the quiet passages) and filtered
    // only when it was measured. A 4-section (48 dB/octave) high-pass at the
    // corner the measurement asked for, bypassed completely at 0.
    /* Four sections, not one. A single 2nd-order high-pass at the corner the law
     * picks (18–24 Hz for the excesses it sees) is −3.3 dB at 25 Hz: measured on
     * the acceptance fixture — a bed high-passed at 60 Hz with 4th-order noise
     * below 35 Hz mixed in at 9 dB of excess — one section moved the 25 Hz band
     * by 0.28 dB while the analyser reported the excess falling from 14.3 to
     * 8.2 dB. The stage was doing a tenth of what its own measurement said.
     *
     * Four sections is also, in this probe's numbers, the cheapest way to spend
     * the removal: at the top of the law's range, N=4 @ 24 Hz takes 10.4 dB out
     * of 14–30 Hz where two sections @ 30 Hz take 10.1, and it pays 0.82 dB at
     * 35–45 Hz instead of 0.90 — a steeper knee *below* the bass, which is what
     * the bass guitar's low E (41 Hz) wants. Steeper still (N=6 @ 20 Hz) is
     * worse on both counts.
     *
     * The law has a second rung now — 42 Hz for a *saturated* floor (see presets
     * 9a) — and there the depth matters more, not less. Measured by parking
     * sections 2–4 at 1 Hz so that only one runs: a 42 Hz corner leaves the
     * acceptance §4 fixture at 10.8 dB of excess, as bad as the shipped 24 Hz
     * rung, where the four sections take it to 3.7. The stack is what lets the
     * corner go to the top of the measured band without the removal spilling
     * into the bass above it. */
    this.infra = new Biquad();
    this.infra2 = new Biquad();
    this.infra3 = new Biquad();
    this.infra4 = new Biquad();
    this.infraHz = 0;
    this.infraTouched = false;

    // Mains hum and the measurement-driven resonance notches. Both are repairs:
    // they exist because something was *measured*, and both are bypassed
    // completely (branch, no filtering) when their amount is zero, so a clean
    // file pays for neither.
    this.humNotch = new HumNotch(sr);
    this.humHz = 50;
    this.humDepth = 0;
    this.humDepth2 = 0;
    this.humDepth3 = 0;
    this.box = [new Biquad(), new Biquad()];
    this.boxLast = [NaN, NaN];

    // fixed tone stage: 60 Hz shelf · 200 · 450 · 1.3 k · 3.2 k · 7 k shelf
    const eqDefs = [
      ['lowshelf', 60, 0.70], ['peak', 200, 0.80], ['peak', 450, 1.00],
      ['peak', 1300, 0.90], ['peak', 3200, 0.85], ['highshelf', 7000, 0.70],
    ];
    this.eq = eqDefs.map((d) => ({ type: d[0], f: d[1], q: d[2], last: 1e9, bq: new Biquad() }));

    // The per-song corrective EQ: twelve peaking bands on the measured
    // centres, each with its own gain from the analysis. It sits *after* the
    // profile's six bands and its curve is computed net of what those bands
    // already do (see presets.js), so the two never correct the same problem
    // twice — what is left is what this particular song is missing.
    this.ceq = CEQ_F.map((f, i) => ({ f, i, last: 1e9, bq: new Biquad() }));

    // dynamic de-resonator probing bands (room honk / boxiness / harshness)
    // overlapping bands (≈0.8 octave apart) so no room resonance sneaks
    // between two probes; the low mids get slightly tighter filters
    this.reso = [[220, 2.4], [380, 2.3], [660, 2.2], [1150, 2.1], [1900, 2.0], [3100, 1.8]]
      .map((b) => new ResoBand(sr, b[0], b[1]));

    // harmonic exciter — three bands generate the octave above their input
    this.exc = [
      new ExciterBand(sr, 1300, 0.75, 2600, 0.65),
      new ExciterBand(sr, 2100, 0.75, 4200, 0.65),
      new ExciterBand(sr, 3400, 0.80, 6800, 0.60),
    ];
    this.excMix = [0.42, 0.36, 0.22];
    this.excEven = 0.55;                 // + warmth, see prepare()

    this.air = new AirSynth(sr);
    // Default-off, additive-only Stage 7 coupling: stays a no-op until both a
    // curve has arrived over the port *and* `airNeural` is raised above 0.
    this.neuralAir = new NeuralAirCurve(sr);
    this.sub = new SubSynth(sr);
    this.hiss = new DeHiss(sr, 3200);
    this.deess = new DeEsser(sr);
    this.declip = new DeClipper(sr);
    this.click = new DeClicker(sr);
    // Two stages have a look-ahead (the de-clipper's run memory and the
    // de-clicker's half millisecond), and both delay everything that follows
    // them — so the *dry* side of the master A/B crossfade is delayed by their
    // sum. Mixing the undelayed input with a delayed output would sum a signal
    // with a copy of itself a few milliseconds late — a comb — and the crossfade
    // is the one place that delay would be audible. This ring is only the
    // reference: the output is the chain's own, at the chain's own latency.
    // …and it has to be as long as the *whole* delay the chain can report —
    // every stage that holds its output back adds to it, and the true-peak
    // limiter does too (it lives on the processor, so its look-ahead is sized
    // here from the sample rate). Getting this wrong is not a subtle bug: a
    // ring shorter than the delay makes `tick` read *before* the buffer, which
    // is `undefined`, which is NaN by the time it reaches the output — measured
    // on a loud master with de-clipper and limiter engaged, that was NaN audio
    // for the first 2.7 s of the file, until the master crossfade reached
    // exactly 1 and the dry reference stopped being mixed in.
    const maxLook = Math.round(sr * 0.0015) + 4;
    this.dryRing = new Float32Array(this.declip.look + this.click.look + maxLook + 16);
    this.dryW = 0;
    this.dry = 0;
    this.delay = 0;
    this.glue = new GlueComp(sr);

    this.lowShelf = new Biquad();
    this.highShelf = new Biquad();
    // Output DC guard: the exciter's even-harmonic term and the warmth stage can
    // add a small offset, so the chain ends with a DC blocker. This used to be a
    // 24 Hz biquad pair ("infra-sonic guard"), which measured badly on loud,
    // dense masters: cascading a 24 Hz highpass rotates the phase of the 20–60 Hz
    // region enough to lift the chain's internal peak by ~6 dB on material that
    // is already at full scale. The soft-clip guard then had to catch that peak
    // and the level matcher pulled the whole file down by up to 6 dB — an
    // audible "overdriven and quieter" result on the material that needed the
    // least. At 2 Hz the guard costs 0.05 dB of peak on that material, changes
    // nothing below 100 Hz and still removes a constant offset within a second.
    this.dcOut = new DCBlocker(sr, 2);

    // Loudness matcher (block-rate, see RemasterProcessor.process). It works on
    // the 300 Hz – 3.4 kHz band, which is where the music lives, so adding a
    // bottom and a top octave cannot fool the A/B into sounding "louder = better".
    // Two cascaded Q 0.707 sections per edge — a 4th-order (Linkwitz-Riley) band
    // — so the band is really the musical band: with a single 2nd-order section
    // per edge, restored content at 200 Hz or at 4–5 kHz leaked into the measure
    // and the matcher pulled the whole file down (or up) to compensate for an
    // addition the ear does not count as loudness.
    this.midDry = [new Biquad(), new Biquad(), new Biquad(), new Biquad()];
    this.midDry[0].setHighpass(sr, 300, 0.707); this.midDry[1].setHighpass(sr, 300, 0.707);
    this.midDry[2].setLowpass(sr, 3400, 0.707); this.midDry[3].setLowpass(sr, 3400, 0.707);
    this.midWet = [new Biquad(), new Biquad(), new Biquad(), new Biquad()];
    this.midWet[0].setHighpass(sr, 300, 0.707); this.midWet[1].setHighpass(sr, 300, 0.707);
    this.midWet[2].setLowpass(sr, 3400, 0.707); this.midWet[3].setLowpass(sr, 3400, 0.707);
    this.dryMs = 1e-6;
    this.wetMs = 1e-6;
    this.midDryMs = 1e-9;
    this.midWetMs = 1e-9;
    this.dryPk = 1e-6;
    this.wetPk = 1e-6;
    this.alGain = 1;

    // Presence follower: synthesis should follow the music, not merely exceed the
    // noise floor. `env` is a fast (~13 ms) envelope, `lvl` a slow loud-level
    // reference (~1 s release); their ratio says whether we are inside the music
    // or in a quiet passage, and `drive` gates all harmonic generation.
    this.env = 0;
    this.lvl = 0;
    this.drive = 0;
    this.p = null;
  }

  reset() {
    this.dc.reset();
    this.infra.reset(); this.infra2.reset(); this.infra3.reset(); this.infra4.reset();
    this.humNotch.reset();
    this.box[0].reset(); this.box[1].reset();
    for (const e of this.eq) { e.bq.reset(); e.last = 1e9; }
    for (const e of this.ceq) { e.bq.reset(); e.last = 1e9; }
    this.deess.reset();
    for (const r of this.reso) r.reset();
    for (const e of this.exc) e.reset();
    this.air.reset(); this.neuralAir.reset(); this.sub.reset(); this.hiss.reset();
    this.declip.reset();
    this.click.reset();
    this.dryRing.fill(0); this.dryW = 0; this.dry = 0; this.delay = 0;
    this.glue.reset();
    this.dcOut.reset();
    this.lowShelf.reset(); this.highShelf.reset();
    for (const b of this.midDry) b.reset();
    for (const b of this.midWet) b.reset();
    this.dryMs = 1e-6; this.wetMs = 1e-6; this.midDryMs = 1e-9; this.midWetMs = 1e-9;
    this.dryPk = 1e-6; this.wetPk = 1e-6; this.alGain = 1;
    this.env = 0; this.lvl = 0; this.drive = 0;
  }

  /** recompute coefficient sets / control constants — once per render block */
  prepare(p) {
    this.p = p;
    for (let i = 0; i < this.eq.length; i++) {
      const band = this.eq[i];
      const g = p.bands[i];
      if (g !== band.last) {
        band.last = g;
        const bq = band.bq;
        if (band.type === 'lowshelf') bq.setLowShelf(this.sr, band.f, band.q, g);
        else if (band.type === 'highshelf') bq.setHighShelf(this.sr, band.f, band.q, g);
        else bq.setPeak(this.sr, band.f, band.q, g);
      }
    }
    // the per-song corrective EQ
    for (let i = 0; i < this.ceq.length; i++) {
      const band = this.ceq[i];
      const g = p.ceq[i];
      if (g !== band.last) {
        band.last = g;
        // coefficients only where there is something to do: a band at 0 dB is
        // skipped entirely in tick() and costs one comparison
        if (g < -0.01 || g > 0.01) band.bq.setPeak(this.sr, band.f, CEQ_Q, g);
      }
    }
    // sub-sonic corner (0 = no filter)
    const ih = clamp(p.infraHP, 0, 80);
    if (ih > 4) {
      if (!this.infraTouched || Math.abs(ih - this.infraHz) > 0.5) {
        this.infraHz = ih;
        this.infraTouched = true;
        this.infra.setHighpass(this.sr, ih, 0.707);
        this.infra2.setHighpass(this.sr, ih, 0.707);
        this.infra3.setHighpass(this.sr, ih, 0.707);
        this.infra4.setHighpass(this.sr, ih, 0.707);
      }
    } else {
      this.infraTouched = false;
      this.infraHz = 0;
    }

    // mains hum: notch depth from the measurement, frequency from the measurement
    if (p.hum !== this.humDepth || p.hum2 !== this.humDepth2 || p.hum3 !== this.humDepth3
      || p.humHz !== this.humHz) {
      this.humDepth = p.hum;
      this.humDepth2 = p.hum2;
      this.humDepth3 = p.hum3;
      this.humHz = p.humHz;
      this.humNotch.set(p.humHz);
    }
    this.humNotch.prepare(this.humDepth, this.humDepth2, this.humDepth3, this.humHz);

    // the two strongest measured resonances, notched precisely
    const boxDefs = [[p.boxF1, p.boxQ1, p.boxG1], [p.boxF2, p.boxQ2, p.boxG2]];
    for (let i = 0; i < 2; i++) {
      const d = boxDefs[i];
      const key = d[0] * 1e6 + d[1] * 1e3 + d[2];
      if (key !== this.boxLast[i]) {
        this.boxLast[i] = key;
        this.box[i].setPeak(this.sr, d[0], d[1], d[2]);
      }
    }

    // the de-clipper's detection level: the measured plateau level of this
    // file, 0.35 dB down (see the DeClipper comment for why the level and not a
    // constant is what separates clipping from a merely loud waveform)
    this.declip.th = Math.pow(10, p.declipLevel / 20);
    // The headroom a repair *needs* is a property of the passage it is in, so
    // the figure decays slowly (≈0.5 s) instead of being reset: consecutive
    // clipped peaks in sparse material are hundreds of milliseconds apart, and
    // the guard must stay lifted between them. Nothing else in the chain sees
    // this number — the level match measures the true peak of the wet signal.
    this.declip.head = 1 + (this.declip.head - 1) * 0.9996;

    for (let i = 0; i < this.reso.length; i++) this.reso[i].depth = p.reso;
    this.excEven = 0.55 + p.warmth * 0.25;
    for (let i = 0; i < this.exc.length; i++) this.exc[i].setNoise(p.noiseLin, p.refLin);
    this.sub.setSource(p.subSrc);
    this.air.setNoise(p.noiseLin, p.refLin);
    this.air.setSource(p.airF);
    this.airRoom = p.airRoom;
    this.sub.setNoise(p.noiseLin);
    this.hiss.setNoise(p.hfNoiseLin);
    this.hiss.setTilt(p.hissTilt, p.hissMax);
    // the de-hisser splits where *this* file's noise starts
    this.hiss.setXover(p.hissF);
    this.glue.setTime(p.glueTime);
    this.glue.setRef(p.refLin);
    this.lowShelf.setLowShelf(this.sr, 700, 0.60, -p.tilt * 5.0);
    this.highShelf.setHighShelf(this.sr, 3200, 0.60, p.tilt * 5.0);
    this.warm = p.warmth;
    this.refLin = p.refLin;
  }

  /** process one sample (dry level accumulation happens in the caller) */
  tick(x) {
    const p = this.p;
    // the dry reference: the input as it was `delay` samples ago, which is what
    // the engaged look-ahead stages have held it back by
    const dr = this.dryRing;
    const dw = this.dryW;
    dr[dw] = x;
    const N = dr.length;
    const di = dw - this.delay;
    // …and the read is clamped as well: a delay longer than the ring must give
    // a *stale* dry reference (one block of it, on the first frames of a
    // render), never a non-finite one
    let di2 = di < 0 ? di + N : di;
    if (di2 < 0) di2 = 0;
    const dly = dr[di2];
    this.dryW = dw + 1 === N ? 0 : dw + 1;
    this.dry = this.delay ? dly : x;
    let y = x;
    // Detect/reconstruct the observed PCM before the linear DC blocker. Moving
    // a constant rail through that filter first biases the detection threshold
    // and teaches LPC a slowly decaying "plateau". With repair off, delay and
    // this linear filter commute, so the neutral path stays unchanged.
    // ── the de-clipper runs first: a flat top is waveform damage, and every
    // later stage (de-hiss, de-click, synthesis) would rather work on a
    // waveform that has its peaks back than have to undo one
    y = this.dc.process(this.declip.tick(y, p.declip, this.declip.th));
    if (this.infraTouched) y = this.infra4.process(this.infra3.process(this.infra2.process(this.infra.process(y))));

    // 0 ── presence follower (drives every synthesis stage)
    const ax = x < 0 ? -x : x;
    this.env += (ax - this.env) * 0.0015;
    this.lvl = ax > this.lvl ? ax : this.lvl + (ax - this.lvl) * 0.00002;
    const rel = this.env / (this.lvl + 1e-9);
    const want = rel > 0.30 ? 1 : rel < 0.06 ? 0 : (() => {
      const t = (rel - 0.06) / 0.24;
      return t * t * (3 - 2 * t);
    })();
    this.drive += (want - this.drive) * 0.004;

    // 1 ── static tone shaping
    const eq = this.eq;
    for (let i = 0; i < eq.length; i++) y = eq[i].bq.process(y);

    // 1a ── the per-song corrective EQ (measured bands, net of the profile)
    const ceq = this.ceq;
    for (let i = 0; i < ceq.length; i++) {
      const band = ceq[i];
      const g = band.last;
      if (g < -0.01 || g > 0.01) y = band.bq.process(y);
    }

    // 1b ── measured resonance notches (boxiness / honk), before the synthesizers
    if (p.boxG1 < -0.05) y = this.box[0].process(y);
    if (p.boxG2 < -0.05) y = this.box[1].process(y);

    // 2 ── dynamic de-resonating
    if (p.reso > 0.0001) {
      const rs = this.reso;
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        const g = r.tick(y);
        if (g < 1) y -= r.band * (1 - g);
      }
    }

    // 3 ── noise repair, most impulsive first. The de-clicker *has* to see the
    // pop's own shape: a pop is broadband, so any stage in front of it that
    // works on the top end eats part of it and leaves a remainder too small for
    // the detector to be sure about. Measured on the worn-record fixture, the
    // de-hisser alone pulled each pop's sample down to 18 % of its height — and
    // the 15 dB that were left over were then invisible to the de-clicker
    // (f/s ≈ 1.2, under its 1.25 threshold), which is why the same fixture came
    // out with 6 pops above the clean copy when the de-hisser was in front and
    // 2 when it was not. Hiss, unlike a pop, is stationary: the de-clicker's
    // detector is a *ratio* and its level gate is relative to the file's own HF
    // activity, so it does not care whether the crackle it is looking for sits
    // in silence or in hiss. The other order was the old compromise ("never
    // synthesise harmonics out of hiss") — but that argument is about the
    // *synthesisers* further down, and those are still behind both stages.
    y = this.click.tick(y, p.declick, this.declip.marked, this.declip.th);
    y = this.hiss.tick(y, p.dehiss);


    // 4 ── harmonic exciter (level-proportional, noise- and presence-gated)
    // The saturation drive is deliberately independent of the amount: the
    // amount belongs in the mix only. Putting it in both places made the
    // parameter quadratic, which is what made small automatic doses sound so
    // much louder than they measured.
    const drive = this.drive;
    if (p.exciter > 0.0001 && drive > 0.001) {
      const mix = this.excMix, ex = this.exc;
      const g = p.exciter * drive * EXC_MIX;
      for (let i = 0; i < ex.length; i++) {
        const b = ex[i];
        const h = b.tick(y, 2.6 * drive, this.excEven);
        y += h * mix[i] * g * b.prog;
      }
    }

    // 5 ── air synthesis 8–16 kHz
    if (p.air > 0.0001 && drive > 0.001) {
      const ds = this.air.control(y);
      const h = this.air.tick(y, 2.6 * drive, this.airRoom);
      y += h * p.air * ds * this.air.prog * drive * AIR_MIX;
    }

    // 5b ── optional neural air coupling: re-shapes what Stage 5 just built
    // (and whatever survived above it) using a dB curve a model predicted
    // offline from the dry source. No-op unless a curve was posted in AND
    // `airNeural` > 0 — see NeuralAirCurve above for why this can never
    // synthesise anything the DSP stage did not already put there.
    if (p.airNeural > 0.0001) y = this.neuralAir.tick(y, p.airNeural);

    // 6 ── sub-harmonic synthesis (30–60 Hz)
    if (p.sub > 0.0001 && drive > 0.001) y += this.sub.tick(y, p.subRatio) * p.sub * drive;

    // 7 ── sibilance control, and it has to be *here*: after every stage that
    // can put energy into 5–10 kHz. It used to sit before the exciter and the
    // air synthesiser, on the theory that a band about to be regenerated should
    // not be regenerated from sibilant noise. The theory is sound and the
    // placement was still wrong, because the synthesisers do not only replace
    // what is there — they add. Measured on a fixture with 120 ms "s" bursts
    // (acceptance matrix, sibilance row): the de-esser alone moved the band by
    // −1.6 dB, and the exciter and air synthesiser behind it handed back +2.1 dB
    // (air alone) and +0.5 dB (exciter alone), so the chain as a whole ended up
    // 0.8 dB *brighter* in the sibilance band than the untreated file. A repair
    // that a later stage can undo is not a repair; the de-esser is now the last
    // word on the band, and its detector sees everything that got there —
    // including the synthesisers' own output.
    y = this.deess.tick(y, p.deess);

    // 8 ── glue compression
    y = this.glue.tick(y, p.glue);

    // 9 ── tone tilt + analog warmth + DC guard
    y = this.highShelf.process(this.lowShelf.process(y));
    const w = this.warm;
    if (w > 0.0001) {
      // The drive is scaled to the file's own peak (see `refLin` and the refDb
      // parameter): the same saturation curve, evaluated at the same *relative*
      // level. A quadratic-ish nonlinearity adds its harmonics in proportion to
      // the level it is fed, so without this a −20 dBFS copy of a master got
      // 30 dB less analogue warmth than the master did (measured: effect
      // −39.5 dB at 0 dBFS, −67.8 dB at −20 dBFS, same dose). A file that
      // reaches full scale gets exactly what it got before.
      const r = this.refLin;
      y = y * (1 - w * 0.55) + ftanh((y / r) * (1 + w * 1.8)) * r * w * 0.62;
    }
    y = this.dcOut.process(y);

    // 9b ── mains hum, and it belongs *here*: every stage above can create or
    // amplify low-frequency energy — the exciter and the saturator make
    // harmonics of whatever they are fed, and the sub synthesizer builds its
    // output out of the signal it is given. Notching before them removed the
    // hum and then let the chain put part of it back (10 dB of notch measured as
    // 3 dB of repair). Placed last, the notch has the final word, and it is
    // still three biquads, bypassed completely when nothing was measured.
    if (p.hum > 0.0001 || p.hum2 > 0.0001 || p.hum3 > 0.0001) y = this.humNotch.tick(y);
    return y;
  }
}

/**
 * A single channel delayed by a variable, sub-sample amount `d` (0 ≤ d ≤
 * maxLag, in samples), realised as an integer ring-buffer tap followed by one
 * first-order Thiran allpass for the fractional remainder — the standard way
 * to get a delay that need not land on a sample boundary without resampling
 * the signal: at d = di + frac, the allpass coefficient η = (1 − frac) / (1 +
 * frac) makes y[n] = η·x[n−di] + x[n−di−1] − η·y[n−1], which is exact at DC
 * and accurate to a fraction of a degree of phase error through the audio
 * band for the small delays this stage ever asks for (a handful of samples).
 * `d` itself is allowed to change every sample — the caller is expected to
 * have already smoothed it — so the integer part can only move by at most one
 * tap between calls, which the allpass state tolerates without a click.
 */
class FracDelay {
  constructor(maxLag) {
    this.len = Math.max(4, Math.ceil(maxLag) + 4);
    this.buf = new Float32Array(this.len);
    this.w = 0;
    this.apXz = 0;
    this.apYz = 0;
  }
  reset() { this.buf.fill(0); this.w = 0; this.apXz = 0; this.apYz = 0; }
  process(x, d) {
    const L = this.len;
    this.buf[this.w] = x;
    const di = d < 0 ? 0 : (d | 0);
    const frac = d - di;
    const xd = this.buf[(this.w - di + L * 4) % L];
    const eta = (1 - frac) / (1 + frac);
    const y = eta * xd + this.apXz - eta * this.apYz;
    this.apXz = xd;
    this.apYz = y;
    this.w = (this.w + 1) % L;
    return y;
  }
}

/**
 * Stereo tape-azimuth correction.
 *
 * A tape head whose gap is not exactly perpendicular to the tape's direction
 * of travel reads the two tracks at slightly different points along its
 * length — a physical head-tilt defect common to worn cassette and reel
 * transports — which is a pure *timing* offset between the channels, not a
 * level or polarity fault: correlated at the bottom (a bass wavelength dwarfs
 * a few hundred microseconds of skew) and comb-filtered at the top once the
 * pair is summed to mono, which is the complaint an off-azimuth transfer
 * actually produces. Two stages make the repair:
 *
 *  · a sliding cross-correlation between the high-passed channels (azimuth
 *    skew is inaudible below a few kHz, so the search is kept there to avoid
 *    mistaking a bass pan or a wide low end for a transport defect) finds the
 *    integer lag that maximises agreement over a 12 ms window, refined to a
 *    fraction of a sample by a parabolic fit through the three scores either
 *    side of the peak, and re-estimated every 20 ms — azimuth drift is a
 *    transport property, not something that needs to be chased sample by
 *    sample;
 *  · the lagging channel is delayed by that amount through a `FracDelay`
 *    until the pair is aligned; the leading channel is untouched, so the
 *    repair is phase-only and adds no level change and no look-ahead (the
 *    cross-correlation sees the signal that already went through the ring
 *    buffer, not the future).
 *
 * The correction is its own guard against acting on programme material that
 * only *looks* like a defect (a hard-panned double-tracked guitar, a drum
 * overhead pair): `confidence` is the normalised correlation at the estimated
 * lag, so a window where the channels do not actually agree any better at
 * that lag than at zero applies nothing, and silence or near-mono material
 * (nothing to correlate, or nothing worth correcting) reads the same way.
 */
class AzimuthCorrector {
  constructor(sr) {
    this.sr = sr;
    // real tape-azimuth skew is microseconds, not milliseconds: a search that
    // reaches further starts finding the programme's own stereo timing
    // instead of a transport defect. ~0.35 ms is already a pronounced tilt.
    this.maxLag = Math.max(2, Math.round(sr * 0.00035));
    this.hpA = new Biquad(); this.hpB = new Biquad();
    this.hpA.setHighpass(sr, 3000, 0.707);
    this.hpB.setHighpass(sr, 3000, 0.707);
    this.winLen = Math.max(32, Math.round(sr * 0.012));
    this.ringLen = this.winLen + 2 * this.maxLag + 8;
    this.ra = new Float32Array(this.ringLen);
    this.rb = new Float32Array(this.ringLen);
    this.w = 0;
    this.filled = 0;
    this.period = Math.max(1, Math.round(sr * 0.02));
    this.phase = 0;
    this.lag = 0;              // smoothed estimate, samples; +ve = B lags A
    this.confidence = 0;       // 0..1
    // the delay actually fed to the allpasses, slewed sample by sample so an
    // integer-part change at re-estimation time never lands as a step
    this.dA = 0; this.dB = 0;
    this.apA = new FracDelay(this.maxLag);
    this.apB = new FracDelay(this.maxLag);
  }
  reset() {
    this.ra.fill(0); this.rb.fill(0); this.w = 0; this.filled = 0;
    this.phase = 0; this.lag = 0; this.confidence = 0; this.dA = 0; this.dB = 0;
    this.hpA.reset(); this.hpB.reset();
    this.apA.reset(); this.apB.reset();
  }
  _estimate() {
    const L = this.ringLen, N = this.winLen, M = this.maxLag;
    const base = (this.w - N + L * 8) % L;
    let bestLag = 0, bestScore = -Infinity;
    const scores = new Array(2 * M + 1);
    for (let lag = -M; lag <= M; lag++) {
      let s = 0;
      for (let i = 0; i < N; i += 2) {
        const ai = this.ra[(base + i + L * 8) % L];
        const bi = this.rb[(base + i + lag + L * 8) % L];
        s += ai * bi;
      }
      scores[lag + M] = s;
      if (s > bestScore) { bestScore = s; bestLag = lag; }
    }
    // silence (or near-silence) has nothing to correlate: freeze the lag
    // estimate rather than let float noise pick an arbitrary "best" among
    // scores that are all approximately zero, and let confidence decay so a
    // stale correction cannot resume the instant real signal returns
    if (Math.abs(bestScore) < 1e-12) { this.confidence *= 0.8; return; }
    // parabolic interpolation through the peak and its two neighbours for a
    // sub-sample refinement of the integer search above, and — from the same
    // parabola — the *interpolated peak score*, i.e. roughly what the search
    // would have found at the true (non-integer) lag had it been able to look
    // there directly. Reading the correlation at the *nearest integer* lag
    // instead systematically under-reads it for a true offset near a half
    // sample (rounding to the wrong side of it can score no better than doing
    // nothing at all), which left the stage with zero confidence at exactly
    // the small, common end of the azimuth range a worn transport produces.
    let refined = bestLag, peakScore = bestScore;
    if (bestLag > -M && bestLag < M) {
      const sL = scores[bestLag - 1 + M], s0c = scores[bestLag + M], sR = scores[bestLag + 1 + M];
      const a2 = 0.5 * (sL + sR) - s0c, b2 = 0.5 * (sR - sL);
      if (Math.abs(a2) > 1e-12) {
        const xStar = -b2 / (2 * a2);
        refined = bestLag + xStar;
        peakScore = a2 * xStar * xStar + b2 * xStar + s0c;
      }
    }
    // signal energy at zero lag, to make both scores above scale-free
    let ea = 0, eb = 0;
    for (let i = 0; i < N; i += 2) {
      const ai = this.ra[(base + i + L * 8) % L];
      const bi0 = this.rb[(base + i + L * 8) % L];
      ea += ai * ai; eb += bi0 * bi0;
    }
    const den = Math.sqrt(ea * eb) || 1e-12;
    const rhoAligned = clamp(peakScore / den, -1, 1);
    const rho0 = clamp(scores[M] / den, -1, 1);
    // confident only where the aligned correlation is both high in its own
    // right and a real improvement over doing nothing (zero lag) — a file
    // that is already aligned (rho0 ≈ rhoAligned) asks for no correction, and
    // one with nothing in common at any lag (both low) asks for none either
    const conf = clamp(rhoAligned, 0, 1) * smoothstep(0.015, 0.12, rhoAligned - rho0);
    // slow integration: a transport's azimuth error does not change file to
    // file within one recording, so the estimate should not either
    this.lag += (refined - this.lag) * 0.25;
    this.confidence += (conf - this.confidence) * 0.2;
  }
  /** One sample of the input pair. `amount` is the 0..1 repair dose. Returns [outA, outB]. */
  process(a, b, amount, out) {
    const ha = this.hpA.process(a), hb = this.hpB.process(b);
    const L = this.ringLen;
    this.ra[this.w] = ha; this.rb[this.w] = hb;
    this.w = (this.w + 1) % L;
    if (this.filled < L) this.filled++;
    if (++this.phase >= this.period) {
      this.phase = 0;
      if (this.filled >= L) this._estimate();
    }
    const eff = amount > 0 ? amount * this.confidence : 0;
    const lag = this.lag * eff;
    // `lag` > 0 means B lags A (B is the late channel) — so A, the one that
    // is ahead, is the one delayed to meet it, not B delayed further behind
    // its own lateness; `lag` < 0 is the mirror case
    const targetA = lag > 0 ? lag : 0;
    const targetB = lag < 0 ? -lag : 0;
    // sample-by-sample slew of the applied delay itself (not just the
    // estimate above), so even a re-estimation every 20 ms arrives at the
    // allpass as a ramp, never a step
    this.dA += (targetA - this.dA) * 0.01;
    this.dB += (targetB - this.dB) * 0.01;
    if (eff > 0.0001) {
      out[0] = this.apA.process(a, this.dA);
      out[1] = this.apB.process(b, this.dB);
    } else {
      // still run the (now-idle) allpasses towards zero delay so re-engaging
      // the stage does not resume from a stale offset
      this.apA.process(a, this.dA);
      this.apB.process(b, this.dB);
      out[0] = a; out[1] = b;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* the processor                                                               */
/* -------------------------------------------------------------------------- */

class RemasterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = (name, dflt, lo, hi) => ({
      name, defaultValue: dflt,
      minValue: lo === undefined ? 0 : lo,
      maxValue: hi === undefined ? 1 : hi,
      automationRate: 'k-rate',
    });
    return [
      k('power', 0),          // master intensity 0..1
      k('bypass', 0),         // 1 = pure dry (A/B switch)
      k('sub', 0),
      // where the sub-harmonic synthesiser looks for the fundamental: 95 Hz for
      // a recording whose bottom octave is there, up to 240 Hz for one whose
      // bottom is empty (see SubSynth.setSource)
      k('subSrc', 95, 60, 260),
      k('subRatio', 0.5, 0.34, 0.66),
      k('exciter', 0),
      k('air', 0),
      // trust dial for the optional neural Stage-7 coupling (see
      // NeuralAirCurve): 0 = ignore any curve posted over the port, exactly
      // as if the feature did not exist. Default 0 — opt-in only.
      k('airNeural', 0),
      k('dehiss', 0),
      k('declip', 0),
      k('declipLevel', -0.1, -60, 0),   // the measured plateau level, dBFS
      k('declick', 0),
      k('reso', 0),
      k('glue', 0),
      k('warmth', 0),
      k('tilt', 0, -1, 1),
      k('band0', 0, -15, 15),   // 60 Hz shelf
      k('band1', 0, -15, 15),   // 200 Hz mud
      k('band2', 0, -15, 15),   // 450 Hz boxiness
      k('band3', 0, -15, 15),   // 1.3 kHz honk
      k('band4', 0, -15, 15),   // 3.2 kHz presence
      k('band5', 0, -15, 15),   // 7 kHz air shelf
      k('hum', 0),                      // mains notch depth · fundamental (a repair)
      k('hum2', 0),                     // mains notch depth · second harmonic
      k('hum3', 0),                     // mains notch depth · third harmonic
      k('humHz', 50, 50, 60),           // mains frequency the notches sit on
      k('boxG1', 0, -12, 0),            // measured resonance 1 · depth in dB
      k('boxF1', 200, 80, 2000),        // measured resonance 1 · frequency
      k('boxQ1', 3, 1, 10),             // measured resonance 1 · sharpness
      k('boxG2', 0, -12, 0),            // measured resonance 2 · depth in dB
      k('boxF2', 400, 80, 2000),        // measured resonance 2 · frequency
      k('boxQ2', 3, 1, 10),             // measured resonance 2 · sharpness
      k('width', 0),                    // stereo width restoration (M/S, above 200 Hz)
      k('azimuth', 0),                  // tape-azimuth sub-sample channel alignment (a repair)
      k('airRoom', 0.5, 0.3, 1.2),      // ceiling of the synthesised band vs its source
      k('airF', 6000, 2000, 8000),      // where the missing top end is derived from
      k('noiseFloor', -70, -100, -20),  // measured broadband noise floor (dBFS)
      k('hissFloor', -80, -110, -20),   // measured high-frequency noise floor (dBFS)
      k('hissTilt', 0, -40, 40),        // measured HF − MID tilt of the programme (dB)
      k('hissMax', 0, 0, 24),           // measured tilt step = the top end that is noise
      k('autoLevel', 1),
      // ── per-song stages ──────────────────────────────────────────────────
      // Everything below is set from *this file's* measurements, not from a
      // profile: the corrective EQ is the shape this song is missing, the
      // sub-sonic corner is the rumble it actually has, the de-esser is the
      // sibilance it actually has, and the de-hisser's crossover is where its
      // noise actually starts.
      k('infraHP', 0, 0, 80),           // sub-sonic high-pass corner in Hz (0 = off)
      k('deess', 0),                    // dynamic 5–9.5 kHz sibilance control
      k('bassMono', 0),                 // mono-maker below 120 Hz (out-of-phase bass)
      k('glueTime', 0.5, 0, 1),         // 0 = fast/percussive-safe · 1 = slow/smooth
      k('hissF', 3200, 2000, 8000),     // de-hisser crossover, measured per file
      k('tpCeil', 0, -6, 0),            // true-peak ceiling in dBTP (0 = the stage is off)
      // The file's own peak, in dBFS. Stages that are neither a repair nor an
      // absolute target (the limiter) read it to place their thresholds
      // relative to this recording instead of relative to full scale; the
      // default 0 dBFS is exactly the old behaviour.
      k('refDb', 0, -60, 12),
      k('eq0', 0, -9, 9),               // per-song corrective EQ · 50 Hz
      k('eq1', 0, -9, 9),               // · 80 Hz
      k('eq2', 0, -9, 9),               // · 125 Hz
      k('eq3', 0, -9, 9),               // · 200 Hz
      k('eq4', 0, -9, 9),               // · 320 Hz
      k('eq5', 0, -9, 9),               // · 500 Hz
      k('eq6', 0, -9, 9),               // · 800 Hz
      k('eq7', 0, -9, 9),               // · 1250 Hz
      k('eq8', 0, -9, 9),               // · 2000 Hz
      k('eq9', 0, -9, 9),               // · 3200 Hz
      k('eq10', 0, -9, 9),              // · 5000 Hz
      k('eq11', 0, -9, 9),              // · 8000 Hz
    ];
  }

  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sr = sampleRate;
    this.chains = [];
    // one limiter for the whole file, not one per channel: the detector takes
    // the maximum over the channels, so a loud left channel cannot pull the
    // right one down with it and the stereo image stays where it was
    this.tp = new TruePeakLimiter(sampleRate);
    this.prm = {
      power: 0, bypass: 1, sub: 0, subRatio: 0.5, exciter: 0, air: 0, airNeural: 0, dehiss: 0,
      declip: 0, declipLevel: -0.1, declick: 0, reso: 0, glue: 0, warmth: 0, tilt: 0,
      hum: 0, hum2: 0, hum3: 0, humHz: 50, boxF1: 200, boxQ1: 3, boxG1: 0, boxF2: 400, boxQ2: 3, boxG2: 0,
      width: 0, azimuth: 0, airRoom: 0.5, airF: 6000, hissTilt: 0, hissMax: 0, refDb: 0, refLin: 1,
      bands: [0, 0, 0, 0, 0, 0], noiseLin: 1e-4, hfNoiseLin: 1e-5, autoLevel: 1,
      infraHP: 0, deess: 0, bassMono: 0, glueTime: 0.5, hissF: 3200,
      ceq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    // stereo width restoration: M/S above 200 Hz, so the bass stays exactly
    // where it was (and a mono file has nothing to widen in the first place)
    this.sideHP = new Biquad();
    this.sideHP.setHighpass(this.sr, 200, 0.707);
    // tape-azimuth sub-sample alignment runs on the raw channel pair, before
    // the mid/side split below — see AzimuthCorrector
    this.azimuth = new AzimuthCorrector(this.sr);
    this._azOut = [0, 0];
    // The mono-maker's low-pass: the side signal's bottom is what an out-of-phase
    // bass lives in, and folding it into the centre is the repair (a mono bass
    // cannot cancel itself in a mono playback). It is the *same* one-pole the
    // analysis measures the low band with — `stereoBands`, coefficient
    // 1 - exp(-2π·200/sr) — and that is the point of it. The analysis reports
    // corr(LP(L), LP(R)); with LP linear, subtracting LP(side) from the side makes
    // LP(L) and LP(R) equal, so that correlation goes to exactly 1: the stage
    // delivers on its own licence by construction.
    //
    // A 2-pole corner at 120 Hz could not. The measured band reaches well past
    // it — a one-pole at 200 Hz is still only −3.5 dB at 300 Hz — so the chain's
    // own output kept a negative low correlation (−0.10 measured on the
    // acceptance §16 fixture) and the app named `outOfPhase` again on it *and* on
    // the export, i.e. the tool reporting its own repair as unfixed. Measured
    // after: the low correlation 0.16 → 0.99 and the issue gone from the export.
    this.sideLPa = 1 - Math.exp(-2 * Math.PI * 200 / this.sr);
    this.sideLPz = 0;
    this.powerSm = 0;
    this.powerInit = false;      // the first block adopts the target (see process)
    this.forceBypass = !!opts.bypass;
    this._ensureChannels(opts.channels || 2);
    this.port.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.type === 'reset') {
        for (const c of this.chains) c.reset();
        this.sideHP.reset();
        this.sideLPz = 0;
        this.azimuth.reset();
        this.powerSm = 0;
        this.powerInit = false;
      } else if (d.type === 'neuralAirCurve') {
        // Posted by the main thread once (per render) after an optional,
        // async worker call — see neural-controller.js / engine.js. Every
        // channel gets its own copy of the bands array so per-channel curves
        // (e.g. stereo-aware super-resolution later) are already possible
        // without changing this message shape.
        const bandsHz = Array.isArray(d.bandsHz) ? d.bandsHz : [];
        const perChannel = Array.isArray(d.gainsDb) ? d.gainsDb : [];
        for (let i = 0; i < this.chains.length; i++) {
          const gainsDb = Array.isArray(perChannel[i]) ? perChannel[i] : perChannel;
          this.chains[i].neuralAir.setCurve(bandsHz, Array.isArray(gainsDb) ? gainsDb : []);
        }
      }
    };
  }

  _ensureChannels(n) { while (this.chains.length < n) this.chains.push(new ChannelChain(this.sr)); }

  _readParams(parameters) {
    const pr = this.prm;
    const g = (name, dflt) => {
      const a = parameters[name];
      return a && a.length ? a[0] : dflt;
    };
    pr.power = g('power', 0);
    pr.bypass = g('bypass', 0);
    pr.sub = g('sub', 0);
    pr.subRatio = g('subRatio', 0.5);
    /* …and the corner the synthesizer tracks at. Declared in the descriptor
     * list and read at the call site, but never *assigned* here until this
     * line: `p.subSrc` was undefined, `setSource(undefined || 95)` fell back to
     * the design corner, and the whole "a recording whose bottom octave is
     * empty tracks at its octave instead" repair never ran in the worklet. The
     * audit's parameter check found the *descriptor* and the harness found no
     * fault, because a parameter that is declared, plumbed and then read as
     * undefined is indistinguishable from one that works — until the row that
     * measures what it does moves (the acceptance "weak bass" row read −9.30 →
     * −8.77 dB on a fixture high-passed at 200 Hz, i.e. nothing happened).
     * tests/audit.test.js now checks the reverse direction as well: every
     * declared parameter must be read. */
    pr.subSrc = g('subSrc', 95);
    pr.exciter = g('exciter', 0);
    pr.air = g('air', 0);
    pr.dehiss = g('dehiss', 0);
    pr.declip = g('declip', 0);
    pr.declipLevel = g('declipLevel', -0.1);
    pr.declick = g('declick', 0);
    pr.reso = g('reso', 0);
    pr.glue = g('glue', 0);
    pr.warmth = g('warmth', 0);
    pr.tilt = g('tilt', 0);
    pr.hum = g('hum', 0);
    pr.hum2 = g('hum2', 0);
    pr.hum3 = g('hum3', 0);
    pr.humHz = g('humHz', 50);
    pr.boxG1 = g('boxG1', 0); pr.boxF1 = g('boxF1', 200); pr.boxQ1 = g('boxQ1', 3);
    pr.boxG2 = g('boxG2', 0); pr.boxF2 = g('boxF2', 400); pr.boxQ2 = g('boxQ2', 3);
    pr.width = g('width', 0);
    pr.azimuth = g('azimuth', 0);
    pr.airRoom = g('airRoom', 0.5);
    pr.airF = g('airF', 6000);
    pr.airNeural = g('airNeural', 0);
    pr.hissTilt = g('hissTilt', 0);
    pr.hissMax = g('hissMax', 0);
    pr.autoLevel = g('autoLevel', 1);
    pr.bands[0] = g('band0', 0);
    pr.bands[1] = g('band1', 0);
    pr.bands[2] = g('band2', 0);
    pr.bands[3] = g('band3', 0);
    pr.bands[4] = g('band4', 0);
    pr.bands[5] = g('band5', 0);
    pr.infraHP = g('infraHP', 0);
    pr.deess = g('deess', 0);
    pr.bassMono = g('bassMono', 0);
    pr.glueTime = g('glueTime', 0.5);
    pr.hissF = g('hissF', 3200);
    pr.tpCeil = g('tpCeil', 0);
    pr.refDb = g('refDb', 0);
    pr.refLin = clamp(Math.pow(10, pr.refDb / 20), 0.002, 4);
    for (let b = 0; b < 12; b++) pr.ceq[b] = g('eq' + b, 0);
    pr.noiseLin = Math.pow(10, g('noiseFloor', -70) / 20);
    pr.hfNoiseLin = Math.pow(10, g('hissFloor', -80) / 20);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    this._readParams(parameters);
    const pr = this.prm;
    const nCh = output.length;
    this._ensureChannels(nCh);
    for (let c = 0; c < nCh; c++) this.chains[c].prepare(pr);

    // Three stages hold their output back — the de-clipper while it is armed,
    // the de-clicker for its half millisecond and the true-peak limiter for its
    // look-ahead — so the chain delays whatever follows by that much. This is the number any caller comparing output with
    // input has to line the two up by, or it measures the delay instead of the
    // processing; `H.renderEx` in the test harness hands it to the suites.
    const bypassedNow = this.forceBypass || pr.bypass > 0.5 || pr.power < 1e-4;
    this.tp.set(this.sr, nCh, pr.tpCeil);
    const delay = bypassedNow ? 0
      : (pr.declip > 0.0001 && pr.declipLevel > -60 ? this.chains[0].declip.look : 0)
        + (pr.declick > 0.0001 ? this.chains[0].click.look : 0)
        + this.tp.delay;
    for (let c = 0; c < nCh; c++) this.chains[c].delay = delay;
    this.latency = delay;

    const inCh = input && input.length ? input.length : 0;
    const frames = output[0].length;
    const targetPower = (this.forceBypass || pr.bypass > 0.5) ? 0 : clamp(pr.power, 0, 1);

    // block-rate smoothing of the master power (≈18 ms) → click-free A/B and
    // click-free slider moves; computed once per block so stereo stays coherent.
    //
    // The *first* block adopts the target instead of ramping to it. Starting the
    // smoother at zero meant every fresh render — playback and, worse, the
    // export — began as a dry/wet crossfade and was only fully processed after
    // ~50 ms, so the head of the file kept a quarter to a third of whatever the
    // chain had just repaired. Measured on the toolkit's worn fixture, the pop at
    // sample 193 (4 ms in) came out of the de-clicker at exactly 0.000 — the
    // detector had it at k = 1.000 — and the rendered file still carried 25 % of
    // its 1.30 spike, with 35 % left of the pop at sample 852. Both are inside
    // the ramp. The smoothing exists for a *change* of the knob, and a render
    // that starts at the requested setting has not changed anything.
    const pc = Math.exp(-frames / (this.sr * 0.018));
    this.powerSm = this.powerInit ? targetPower + pc * (this.powerSm - targetPower) : targetPower;
    this.powerInit = true;
    const pw = this.powerSm;

    const autoLevel = pr.autoLevel > 0.5 && pw > 0.001;
    const bypassed = pw < 1e-4;

    // The soft-clip guard's knee for this block, headroom included: a
    // reconstructed peak sits *above* the plateau it was rebuilt from, and the
    // guard's knee starts below that plateau — so the guard has to act that much
    // higher up or it flattens the arc straight back into the flat top it came
    // from. `declip.head` is a per-file maximum measured by the de-clipper
    // itself, so a file that is not being de-clipped has `head === 1` and this
    // is the guard exactly as it was. Nothing has to be passed in: the stage
    // that does the reconstruction is the stage that knows its size, and its
    // figure is registered a whole look-ahead (271 samples, two blocks) before
    // the samples it applies to reach this point.
    let head = 1;
    for (let c = 0; c < nCh; c++) if (this.chains[c].declip.head > head) head = this.chains[c].declip.head;
    const knee = head > 1.0001 ? KNEE * head : KNEE;
    const krng = head > 1.0001 ? RANGE * head : RANGE;
    // One stereo-linked attenuation, computed from the future reconstructed
    // peak before it leaves the de-clipper's look-ahead. It is independent of
    // the loudness-match toggle: manual export must not re-clip restored crests.
    // Holding the maximum until reset prevents block-by-block normalization
    // (pumping); the actual peak is used, not a clip-rail-relative gain ratio.
    let predictedPeak = 0;
    if (pr.declip > 0.0001) for (let c = 0; c < nCh; c++) {
      const chain = this.chains[c];
      predictedPeak = Math.max(predictedPeak, chain.declip.restoredPeak * (autoLevel ? chain.alGain : 1));
    }
    const reconstructionGain = predictedPeak > KNEE ? KNEE / predictedPeak : 1;


    for (let c = 0; c < nCh; c++) {
      const chain = this.chains[c];
      const src = inCh > 0 ? input[c < inCh ? c : inCh - 1] : null;
      const dst = output[c];
      // loudness matching uses the *previous* block's gain (2.7 ms latency at
      // 48 kHz — inaudible) so the sample loop stays allocation- and sqrt-free
      const g = autoLevel ? chain.alGain : 1;
      let drySq = 0, wetSq = 0, midDrySq = 0, midWetSq = 0;
      let dryPk = 0, wetPk = 0;

      if (bypassed) {
        for (let i = 0; i < frames; i++) {
          let x = src ? src[i] : 0;
          if (!(x > -32 && x < 32)) x = x > 32 ? 1 : x < -32 ? -1 : 0;
          drySq += x * x;
          dst[i] = x;
        }
      } else {
        for (let i = 0; i < frames; i++) {
          // Guard the very entrance of the chain: a single NaN or ±Inf sample —
          // from a damaged file or a decoder quirk — would otherwise stick in the
          // filter states for ever and silence (or destroy) the whole output.
          // NaN fails both comparisons and becomes 0.
          let x = src ? src[i] : 0;
          if (!(x > -32 && x < 32)) x = x > 32 ? 1 : x < -32 ? -1 : 0;
          const wet0 = chain.tick(x);
          // peaks are tracked *before* the level match, so the matcher can be
          // told to give back any headroom it would otherwise eat (see below)
          const xr = chain.dry;                 // the aligned dry reference
          const ax = xr < 0 ? -xr : xr;
          if (ax > dryPk) dryPk = ax;
          const aw0 = wet0 < 0 ? -wet0 : wet0;
          if (aw0 > wetPk) wetPk = aw0;
          let wet = wet0 * g * reconstructionGain;
          // Soft-clip guard, last stage in the chain: a tanh knee above −0.55 dBFS
          // that saturates *below* full scale, so a 16-bit export can never pin a
          // sample at the ceiling. Transparent below the knee.
          //
          // The knee moves up by the headroom the de-clipper's reconstruction
          // needs — `chain.declip.head` is what it has actually used on this
          // file, `pr.declipHead` what the measurement promised it would need.
          // A guard at the old knee would flatten every reconstructed arc back
          // into a flat top; lifted, the arc arrives intact and the *level
          // matcher* below is what pays for it, by the only currency it has:
          // it ducks the finished file until the restored peak fits where the
          // un-repaired one used to sit. The guard's own ceiling scales with
          // the knee, so its shape (and its promise about a 16-bit export) is
          // unchanged — only the level it acts at moves.
          if (knee > KNEE) {
            if (wet > knee) wet = knee + krng * ftanh((wet - knee) / krng);
            else if (wet < -knee) wet = -knee + krng * ftanh((wet + knee) / krng);
          } else if (wet > KNEE) wet = KNEE + RANGE * ftanh((wet - KNEE) / RANGE);
          else if (wet < -KNEE) wet = -KNEE + RANGE * ftanh((wet + KNEE) / RANGE);
          drySq += xr * xr;
          // Every level the matcher compares is measured on the *input* to its
          // own gain: `wet0`, not `wet`. Measured after the gain, the wet band
          // energy carries g² while the correction the matcher derives from it
          // is only linear in g, so the loop settles at the cube root of the
          // correction it should apply (a 4 dB mismatch came out as 1.3 dB) and
          // a 1 dB residual was left on every file. Measuring before the gain
          // makes the fixed point exact: chain level × g = dry level.
          wetSq += wet0 * wet0;
          // mid-band energy for the loudness match
          let md = xr, mw = wet0;
          for (let b = 0; b < 4; b++) {
            md = chain.midDry[b].process(md);
            mw = chain.midWet[b].process(mw);
          }
          midDrySq += md * md;
          midWetSq += mw * mw;
          const mixed = xr + pw * (wet - xr);
          // The last hard limit of the chain. It is a *rail*, not a second
          // soft-clipper: it exists so that no arithmetic surprise can write an
          // out-of-range sample into the export buffer. It therefore has to sit
          // where the guard above it saturates (`knee + krng`), because a hard
          // clamp at 1.0 would do exactly what the guard was lifted to stop
          // doing — cut the top off every reconstructed peak. On a file that is
          // not being de-clipped both are 1.0 and this line is unchanged.
          const rail = knee + krng;
          dst[i] = mixed > rail ? rail : mixed < -rail ? -rail : mixed;
        }
      }

      if (autoLevel) {
        const n = Math.max(1, frames);
        // Block-rate energy followers with a fast attack and a slow release:
        // they track the *loud* parts of the music, which is where the ear
        // compares levels, and they hold their value through quiet passages so
        // the gain does not pump along with the song.
        const RISE = 0.25, FALL = 0.004;
        const follow = (prev, e) => (e > prev ? prev + (e - prev) * RISE : prev + (e - prev) * FALL);
        chain.dryMs = follow(chain.dryMs, drySq / n);
        chain.wetMs = follow(chain.wetMs, wetSq / n);
        // The mid band is a *loudness* comparison, so it integrates like one
        // (~0.3 s, symmetric). Peak-holding it (fast attack, slow release) made
        // the match depend on how much more dynamic one side happened to be and
        // biased the result by ~0.2 dB on material with a wide envelope; the
        // peak followers stay where a peak is what matters (headroom, below).
        const avg = (prev, e) => prev + (e - prev) * 0.008;
        chain.midDryMs = avg(chain.midDryMs, midDrySq / n);
        chain.midWetMs = avg(chain.midWetMs, midWetSq / n);
        // same treatment for the peaks (slower release: peaks are sparse)
        chain.dryPk = follow(chain.dryPk, dryPk);
        chain.wetPk = follow(chain.wetPk, wetPk);

        const dr = Math.sqrt(chain.dryMs), wr = Math.sqrt(chain.wetMs);
        const md = Math.sqrt(chain.midDryMs), mw = Math.sqrt(chain.midWetMs);
        if (md > 1e-7 && mw > 1e-7) {
          // Match the mid band, which is what the ear calls "as loud as".
          //
          // `md`/`mw` are RMS levels (the square root of the held mean squares),
          // so equalising them takes the ratio directly. The extra square root
          // this used to carry only ever applied *half* the correction the
          // measurement asked for — a systematic 2 dB error for a 4 dB
          // mismatch, in both directions — which is what left the automatic
          // mode either leaning loud or leaning quiet depending on the file.
          let target = md / mw;
          // safety rail: whatever the chain did to the spectrum, the broadband
          // level may not move more than −6 … +4 dB
          if (dr > 1e-7 && wr > 1e-7) {
            const r = target * (wr / dr);
            if (r > 1.5849) target = 1.5849 * (dr / wr);
            else if (r < 0.5012) target = 0.5012 * (dr / wr);
          }
          // Headroom guard. The level match may lower the restored signal, but
          // only by as much as the chain's own peak excursion needs — and only
          // when that excursion would otherwise be caught by the soft-clip guard
          // that protects the export. Ducking merely because the output peaks
          // above the input makes a restored file quieter than the original for
          // no audible reason (the auto level match is a promise: "as loud as
          // before"), so the reference is the higher of two limits:
          //   · the clip knee — material that was below the guard must never be
          //     pushed into it;
          //   · the source's own peak — a file that already sat at the rail gives
          //     back at most what the chain took.
          // Measured on the *wet* chain before this gain: the ratio is then
          // independent of the gain itself. Judging the finished output instead
          // (post-gain, post-clip) closes a feedback loop — the gain pulls the
          // output peak down, the output peak then looks fine, the gain rises
          // again — and left the guard cycling, so part of the peak escaped it.
          const safe = chain.dryPk > KNEE ? chain.dryPk : KNEE;
          if (chain.wetPk > safe) {
            target = Math.min(target, Math.max(safe / chain.wetPk, 0.5));
          }
          chain.alGain += (clamp(target, 0.25, 2.5) - chain.alGain) * 0.12;
        }
      }
    }

      // ── stereo width restoration ────────────────────────────────────────────
    // A narrow 1970s mix (or a mono master folded to two identical channels)
    // cannot be widened by any per-channel stage — it needs both channels at
    // once. The added signal is the *high-passed* side: everything below
    // 200 Hz stays bit-identical, so the bass keeps its mono centre and the
    // low end cannot develop the phase problems wide-stereo bass always has.
    // A mono file has no side signal, so it stays exactly mono instead of
    // getting a fake image.
    const widen = pr.width > 0.0001;
    const monoBass = pr.bassMono > 0.0001;
    const azimuthOn = pr.azimuth > 0.0001;
    if (nCh >= 2 && !bypassed && (widen || monoBass || azimuthOn)) {
      const L = output[0], R = output[1];
      const az = this.azimuth, azOut = this._azOut;
      for (let i = 0; i < frames; i++) {
        // ── tape-azimuth alignment, ahead of the mid/side split: a sub-sample
        // channel-timing offset is exactly the kind of defect that turns into
        // a comb filter the instant the pair below is summed to mono, so it
        // has to be corrected *before* the sum, not after — see
        // AzimuthCorrector. The side-chain always runs while this loop does
        // (so re-engaging the stage mid-file is never a cold start); only the
        // correction itself is gated by `pr.azimuth`.
        az.process(L[i], R[i], pr.azimuth, azOut);
        const l = azOut[0], r = azOut[1];
        const m = (l + r) * 0.5;
        let sd = (l - r) * 0.5;
        // ── out-of-phase bass: an inverted bass channel (a mis-wired cartridge,
        // a polarity-flipped bass mic) is *correlated* everywhere except at the
        // bottom, where it cancels — which is why the measurement looks at the
        // low band separately. Folding the low side signal into the centre is
        // the repair; nothing above 120 Hz is touched, and a recording whose
        // bass is already centred pays nothing.
        // the one-pole tracks the side whether or not the fold is engaged, so
        // switching the stage on mid-file (a new parameter set) never reads a
        // stale state
        const sdz = (this.sideLPz += (sd - this.sideLPz) * this.sideLPa);
        if (monoBass) sd -= sdz * clamp(pr.bassMono, 0, 1);
        const add = widen ? this.sideHP.process(sd) * pr.width : 0;
        let lo = m + sd + add, ro = m - sd - add;
        // the widening happens after the per-channel soft-clip guard, so the
        // same knee is applied here — a 16-bit export still cannot pin a sample
        if (lo > knee) lo = knee + krng * ftanh((lo - knee) / krng);
        if (ro > knee) ro = knee + krng * ftanh((ro - knee) / krng);
        L[i] = lo; R[i] = ro;
      }
    }
    // The true-peak limiter is the last thing that happens to the audio — after
    // the width stage, which adds side energy and would otherwise be the one
    // part of the chain no ceiling covered.
    if (!bypassed) this.tp.processBlock(output, nCh, frames);
    return true;
  }
}

registerProcessor('remaster-processor', RemasterProcessor);
