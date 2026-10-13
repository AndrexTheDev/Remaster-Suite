/* =============================================================================
 * Remaster Suite — Harmonic Restoration Engine
 * =============================================================================
 * AudioWorkletProcessor implementing the full restoration chain:
 *
 *   input ─┬───────────────────────────────────────────────┐ (dry)
 *          │                                               │
 *          ├─ DC guard ─ Static EQ bank (6 bands)           │
 *          ├─ Dynamic de-resonator (7 probing bands)       │
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

function db2lin(db) { return Math.pow(10, db / 20); }

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

const DEESS_DECIM = 4;
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
 * at the decimated update rate. Closing — the gate deciding "this top end is
 * noise" — is deliberately slow: the key is a 2048-sample (43 ms) sliding RMS of
 * 4–16 kHz, and a vinyl pop is a broadband burst whose energy *dominates that
 * window* out of all proportion to its length (twenty samples at full scale
 * against 2048 of music at −34 dB: +14 dB of apparent tilt for 43 ms). A gate
 * that follows its key sample-by-sample therefore slams shut at every pop and
 * opens again when the pop leaves the window: measured on a worn record with 108
 * injected pops, the chain left 38 HF frames above 15 dB of crest against 3 with
 * the de-hisser off, because every pop came out as a 43 ms *hole* with broadband
 * edges instead of a repaired click. Slow closing costs nothing on the thing the
 * gate is for — hiss is stationary, and the 43 ms a real noise floor takes to be
 * recognised is inaudible — while opening has to stay fast, because opening is
 * what keeps a musical transient from being dulled.
 */
const HISS_CLOSE_MS = 250;
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
    // 700 Hz–3 kHz band rides with the programme, the 4–16 kHz band rides with it
    // too as long as it holds music — and stops riding when what is up there is
    // noise. Measuring the same two bands here as the analyser does is what makes
    // the measured number (dB of top end that is not programme) something this
    // stage can actually subtract.
    this.mid = new Biquad(); this.mid.setBandpass(sr, HISS_MID_HZ, HISS_MID_Q);
    this.rmsHf = new SlidingRms(2048);       // same window as the analyser's frames
    this.rmsMid = new SlidingRms(2048);
    this.tickCount = 0;
    this.gate = new Ramp(HISS_DECIM, 1);
    this.t1 = 1e-6;
    this.inv = 1;
    this.tiltRef = 0;          // the programme's own HF − MID tilt (measured)
    this.maxCut = 0;           // how much of the top end may be taken (measured)
    this.cutDb = 0;            // the cut the gate has actually taken (smoothed, see tick)
  }
  reset() {
    this.lp1.reset(); this.lp2.reset(); this.hp1.reset(); this.hp2.reset();
    this.k1.reset(); this.k2.reset();
    this.mid.reset();
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
    const em2 = this.rmsMid.tick(this.mid.process(x));
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
      const cutTilt = this.maxCut > 0.01 ? clamp(tiltNow - this.tiltRef, 0, this.maxCut) : 60;
      const lvl = smoothstep(this.t1, this.t1 + 1 / this.inv, e);
      const cutLevel = lvl > 1e-6 ? -20 * Math.log10(lvl) : 60;
      // The correction the key asks for…
      const cutTarget = Math.min(cutTilt, Math.max(cutLevel - 6, 0));
      // …and the correction the gate is *allowed* to have taken so far: closing
      // slowly (a pop must not punch a hole — see HISS_CLOSE_MS), opening
      // quickly (a transient must not be dulled). The steady state is the same
      // number the key asked for, so a measured tilt still means what it says.
      const rate = cutTarget > this.cutDb
        ? 1 - Math.exp(-HISS_DECIM / (this.sr * HISS_CLOSE_MS * 0.001))
        : 1 - Math.exp(-HISS_DECIM / (this.sr * HISS_OPEN_MS * 0.001));
      this.cutDb += (cutTarget - this.cutDb) * rate;
      this.gate.set(Math.pow(10, -this.cutDb / 20));
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
    return x + (low + high * gEff - x) * s;
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
 * Where the local period is not trustworthy (broadband material: music, noise,
 * cymbals) the period is taken from the length of the plateau alone and capped
 * at +3 dB — a bound, not a claim. The repair itself is an arc from the plateau
 * up to the implied peak and back down, which is what the missing waveform
 * looks like in both cases: for a sinusoid it *is* the right shape
 * (−32 dB of residual error against −16 dB for the flat top, measured against
 * the ground truth), and for a transient it is the least opinionated smooth
 * curve through the same endpoints.
 *
 * Because a run is only reconstructed once it has ended, the stage delays its
 * output by the longest run it will handle (`look`, 5.4 ms) — while it is
 * engaged. Order matters as much as detection: this is the *first* repair in the
 * chain, before the de-hisser and the de-clicker, because those two work on the
 * waveform as it is and reconstructing a peak afterwards would have to undo
 * them. Every restoration handbook says the same thing for the same reason.
 */
class DeClipper {
  constructor(sr) {
    this.sr = sr;
    // The longest flat top we will reconstruct. At 48 kHz this is 5.6 ms: long
    // enough for the clipped bass note of a loud master (a 60 Hz peak at +4 dB
    // spends ~5 ms above full scale), short enough that the delay stays small.
    this.maxRun = Math.max(8, Math.round(sr * 0.0056));
    this.look = this.maxRun + 2;
    const L = this.look + 8;
    this.ring = new Float32Array(L);          // incoming samples, waiting
    // Which of the waiting samples this stage has reconstructed. The de-clicker
    // downstream reads it: a *reconstructed* peak is broadband and spiky, and a
    // de-clicker looking for clicks would happily eat it again — measured on a
    // clipped master, the de-clicker alone pulled the flat tops down to a third
    // of their level, which is worse than leaving them. The flag travels with
    // the sample (the marking is retroactive, so even the samples in front of a
    // run are covered by the time they are emitted).
    this.mark = new Uint8Array(L);
    this.arc = new Float64Array(this.maxRun + 8);   // the Hermite arc, reused
    this.w = 0;
    this.marked = false;                      // was the sample just emitted ours?
    this.after = 0;                           // the sample that ended the current run
    this.th = 0.9;                            // set by prepare(): the clip level
    // How far above the plateau this stage has reconstructed, as a linear
    // factor. It is the *floor* under the guard's lift: a caller that does not
    // know the measured headroom still gets a reconstruction that survives the
    // guard, and a passage with no clipping lets the figure decay again.
    this.head = 1;
    this.tol = 0.0025;                        // "flat": how equal neighbours must be
    /* How far below its own starting magnitude a run may drift and still be one
     * run: 1.5 %, which is fifteen times the tilt a DC blocker puts on a plateau
     * and a tenth of the step a real crest takes when it leaves the rail. */
    this.runFloor = 0;
    this.lastSign = 0;
    // run tracking
    this.armed = false;                       // inside a candidate plateau
    this.runStart = 0;
    this.runLen = 0;
    this.prev = 0;
    this.pos = 0;                             // absolute sample counter
    // the last few zero crossings, for the local period (half a period apart)
    this.cross = new Int32Array(9);
    this.crossN = 0;
    this.crossW = 0;
  }
  reset() {
    this.ring.fill(0); this.mark.fill(0);
    this.w = 0; this.marked = false; this.armed = false; this.runStart = 0; this.runLen = 0;
    this.head = 1;
    this.prev = 0; this.pos = 0; this.crossN = 0; this.crossW = 0;
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
  /** Reconstruct the plateau [start, start+len-1] in the ring. */
  repair(start, len, amount) {
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
  tick(x, amount, level) {
    if (amount <= 0.0001 || level <= 0.02) {
      this.th = 1;                                       // dormant: a run can never match
      this.armed = false;
      return x;
    }
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

    /* ── 2 · runs of flat samples at (or just under) the clip level ─────────
     *
     * A run *starts* at the detection level and then lives on its own, slightly
     * lower floor (0.15 dB below its own first magnitude). The distinction is not
     * cosmetic: the chain high-passes the signal before this stage (the input DC
     * blocker), and on a signal that already sat at the rail that filter tilts the
     * plateau by a fraction of a percent — measured on a 997 Hz tone clipped at
     * 0.75, the flat samples arrive as 0.7515, 0.7513, … 0.7499, crossing the
     * absolute threshold part way through and *ending the run there*. Every
     * plateau in the file was then reconstructed from its first half: `len` came
     * out at 8 where the plateau was 15, the Hermite took its trailing tangent
     * from a sample still inside the plateau (m1 = −0.0016 instead of −0.119) and
     * the arc was lopsided — the reconstructed peak landed two samples after the
     * run began and decayed back to the rail across the rest of it. The ground
     * truth error on the documented fixture was −26.9 dB where the model's own
     * numbers say −32 dB, and the truncated-run artefacts were louder than the
     * clipping they replaced.
     *
     * A real crest does not behave like that: its samples leave the rail at once
     * (the first one after a clipped peak is 10–20 % down, not 0.2 %), so a 1.5 %
     * floor cannot swallow one. */
    const ax = x < 0 ? -x : x;
    if (this.armed && x * this.lastSign > 0 && ax >= this.runFloor
        && Math.abs(ax - this.lastMag) <= this.tol) {
      this.runLen++;
      this.lastMag = ax;
      if (this.runLen > this.maxRun) this.armed = false;     // too long to be a peak
    } else if (ax >= level) {
      this.armed = true;
      this.runStart = this.pos;
      this.runLen = 1;
      this.lastMag = ax;
      this.lastSign = x < 0 ? -1 : 1;
      this.runFloor = ax * DECLIP_RUN_FLOOR;
    } else if (this.armed) {
      this.armed = false;
      /* The sample that *ended* the run is the current one, and it is not in the
       * ring yet — the ring is written after this branch. Handing it to the
       * repair directly is the difference between a Hermite through the run's two
       * real neighbours and one through the sample's slot from 274 samples ago:
       * measured, the latter put a tangent of −0.99 into the cubic on a 997 Hz
       * tone and turned a correct +2 dB arc into a 3 dB one, dropping the
       * ground-truth error from −29.0 to −15.7 dB. */
      this.after = x;
      this.repair(this.runStart, this.runLen, amount);
    }
    this.ring[this.w] = x;
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
 * De-clicker (vinyl crackle, digital dropouts, impulse repair).
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
 */
class DeClicker {
  constructor(sr) {
    this.sr = sr;
    // The window, in samples. `pre` is what the look-ahead has to be able to
    // reach back to; `rise`/`fall` are the crossfades that keep the window from
    // ending in a step of its own.
    this.pre = Math.max(2, Math.round(sr * 0.00033));
    this.post = Math.max(4, Math.round(sr * 0.00100));
    this.look = this.pre + 1;
    this.rise = Math.max(2, Math.round(sr * 0.00017));
    this.fall = Math.max(2, Math.round(sr * 0.00033));
    const L = this.look + this.post + 4;
    this.ring = new Float32Array(L);          // the incoming samples, waiting
    this.plan = new Float32Array(L);          // …and how far each of them is repaired
    this.mark = new Uint8Array(L);            // …and which came from the de-clipper
    this.prevIn = 0;                          // for the flat-top test below
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
    this.ring.fill(0); this.plan.fill(0); this.mark.fill(0);
    this.w = 0; this.inp = 0; this.dryOut = 0; this.prevIn = 0;
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
  tick(x, amount, reconstructed, clipLevel) {
    if (amount <= 0.0001) { this.inp = x; this.dryOut = x; this.prevIn = x; return x; }
    // ── 1 · the detector, on the sample that just arrived ──────────────────
    const pd = this.dp2.process(this.dp1.process(x));
    const d = x - pd;
    const ad = d < 0 ? -d : d;
    const f = this.fast.tick(ad);
    const s = this.slow.tick(ad);
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
    const th = 1 - 0.5 * amount;
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
    if (k > 0.02) {
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
    const p = this.pred2.process(this.pred.process(this.inp));
    const out = m > 0.001 ? xd + (p - xd) * m : xd;
    this.inp = out;                                    // filter sees the repair
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
 */
class HumNotch {
  constructor(sr) {
    this.sr = sr;
    this.cut = [new Biquad(), new Biquad(), new Biquad()];
    this.lastHz = 0;
    this.last = [2, 2, 2];         // impossible values → the first prepare() sets up
  }
  set(f0) {
    if (f0 === this.lastHz) return;
    this.lastHz = f0;
    this.last = [2, 2, 2];         // force the next prepare() to recompute
  }
  reset() { for (const b of this.cut) b.reset(); }
  prepare(d1, d2, d3, f0) {
    if (d1 === this.last[0] && d2 === this.last[1] && d3 === this.last[2]) return;
    this.last = [d1, d2, d3];
    // One dose per harmonic, each measured against its *own* five-hertz
    // shoulders. The old law notched the second and third harmonic by a fixed
    // −34/−26 dB whenever the fundamental was notched at all — which took 20 dB
    // out of 100 and 150 Hz on a recording whose hum was a pure 50 Hz line and
    // whose bass lived exactly there. A harmonic that was not measured does not
    // get notched.
    const gains = [-HUM_DB_PER_DOSE * d1, -HUM_DB_PER_DOSE * d2, -HUM_DB_PER_DOSE * d3];
    // Constant *absolute* width, not constant Q. Hum drifts in hertz, not in
    // octaves — a turntable running 0.5 % fast sits at 50.25 Hz whether that is
    // its fundamental or the third harmonic, so a notch that is three hertz wide
    // still lands on it 14 dB down. Width matters because the sub octave lives in
    // the same 30–60 Hz region: a five-hertz-wide bell measured 2.5 dB out of the
    // 41 Hz bin (its skirt, not its bandwidth), which is a third of what the sub
    // synthesiser adds down there — three hertz costs half a decibel instead.
    for (let i = 0; i < 3; i++) {
      const f = f0 * (i + 1);
      this.cut[i].setPeak(this.sr, f, clamp(f / HUM_BW_HZ, 1.2, 60), gains[i]);
    }
  }
  tick(x) {
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
    // only when it was measured. 12 dB/octave at the corner the measurement
    // asked for, bypassed completely at 0.
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
     * worse on both counts. */
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
    this.air.reset(); this.sub.reset(); this.hiss.reset();
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
    let y = this.dc.process(x);
    // ── the de-clipper runs first: a flat top is waveform damage, and every
    // later stage (de-hiss, de-click, synthesis) would rather work on a
    // waveform that has its peaks back than have to undo one
    y = this.declip.tick(y, p.declip, this.declip.th);
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
      k('subRatio', 0.5, 0.34, 0.66),
      k('exciter', 0),
      k('air', 0),
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
      power: 0, bypass: 1, sub: 0, subRatio: 0.5, exciter: 0, air: 0, dehiss: 0,
      declip: 0, declipLevel: -0.1, declick: 0, reso: 0, glue: 0, warmth: 0, tilt: 0,
      hum: 0, hum2: 0, hum3: 0, humHz: 50, boxF1: 200, boxQ1: 3, boxG1: 0, boxF2: 400, boxQ2: 3, boxG2: 0,
      width: 0, airRoom: 0.5, airF: 6000, hissTilt: 0, hissMax: 0, refDb: 0, refLin: 1,
      bands: [0, 0, 0, 0, 0, 0], noiseLin: 1e-4, hfNoiseLin: 1e-5, autoLevel: 1,
      infraHP: 0, deess: 0, bassMono: 0, glueTime: 0.5, hissF: 3200,
      ceq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    // stereo width restoration: M/S above 200 Hz, so the bass stays exactly
    // where it was (and a mono file has nothing to widen in the first place)
    this.sideHP = new Biquad();
    this.sideHP.setHighpass(this.sr, 200, 0.707);
    // the mono-maker's low-pass: the side signal below 120 Hz is what an
    // out-of-phase bottom lives in, and folding it into the centre is the
    // repair (a mono bass cannot cancel itself in a mono playback)
    this.sideLP = new Biquad();
    this.sideLP.setLowpass(this.sr, 120, 0.707);
    this.powerSm = 0;
    this.powerInit = false;      // the first block adopts the target (see process)
    this.forceBypass = !!opts.bypass;
    this._ensureChannels(opts.channels || 2);
    this.port.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.type === 'reset') {
        for (const c of this.chains) c.reset();
        this.sideHP.reset();
        this.sideLP.reset();
        this.powerSm = 0;
        this.powerInit = false;
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
    pr.airRoom = g('airRoom', 0.5);
    pr.airF = g('airF', 6000);
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
          let wet = wet0 * g;
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
    if (nCh >= 2 && !bypassed && (widen || monoBass)) {
      const L = output[0], R = output[1];
      for (let i = 0; i < frames; i++) {
        const l = L[i], r = R[i];
        const m = (l + r) * 0.5;
        let sd = (l - r) * 0.5;
        // ── out-of-phase bass: an inverted bass channel (a mis-wired cartridge,
        // a polarity-flipped bass mic) is *correlated* everywhere except at the
        // bottom, where it cancels — which is why the measurement looks at the
        // low band separately. Folding the low side signal into the centre is
        // the repair; nothing above 120 Hz is touched, and a recording whose
        // bass is already centred pays nothing.
        if (monoBass) sd -= this.sideLP.process(sd) * clamp(pr.bassMono, 0, 1);
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
