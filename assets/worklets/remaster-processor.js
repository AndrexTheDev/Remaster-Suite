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
  setNoise(noiseLin) {
    // harmonic generation follows the music. The reference is the measured
    // noise floor but capped, so a noisy estimate can never mute the effect.
    this.gLo = clamp(noiseLin * 1.5, 1e-6, 0.02);
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
  setNoise(noiseLin) {
    this.gLo = clamp(noiseLin * 1.5, 1e-6, 0.02);
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
    this.hp1 = new Biquad(); this.hp1.setHighpass(sr, 5200, 0.707);
    this.hp2 = new Biquad(); this.hp2.setHighpass(sr, 5200, 0.707);
    this.lp1 = new Biquad(); this.lp1.setLowpass(sr, 9500, 0.707);
    this.lp2 = new Biquad(); this.lp2.setLowpass(sr, 9500, 0.707);
    this.fast = new EnvFollower(sr, 0.002, 0.030, DEESS_DECIM);
    this.slow = new EnvFollower(sr, 0.060, 0.250, DEESS_DECIM);
    this.ramp = new Ramp(DEESS_DECIM, 1);
    this.sense = 1.35;              // how far above its own average a burst counts
  }
  reset() {
    this.hp1.reset(); this.hp2.reset(); this.lp1.reset(); this.lp2.reset();
    this.fast.v = 0; this.slow.v = 0;
    this.ramp.reset(1);
  }
  tick(x, amount) {
    if (amount <= 0.0001) {
      if (this.ramp.t !== 1) this.ramp.reset(1);
      return x;
    }
    const hf = this.lp2.process(this.lp1.process(this.hp2.process(this.hp1.process(x))));
    const a = hf < 0 ? -hf : hf;
    const e = this.fast.tick(a);
    const s = this.slow.tick(a);
    let g = 1;
    if (s > 1e-7 && e > s * this.sense) {
      // up to 12 dB of excess maps to the full correction; the amount decides
      // how much of it is actually taken
      const over = e / (s * this.sense);
      const cut = clamp(Math.log(over) / Math.log(4), 0, 1);
      g = 1 - amount * cut * 0.62;
    }
    this.ramp.set(g);
    const gg = this.ramp.tick();
    return x - hf * (1 - gg);
  }
}

/* -------------------------------------------------------------------------- */
/* HF de-hiss: linkwitz-riley 4th order split + downward expander              */
/* -------------------------------------------------------------------------- */

const HISS_DECIM = 8;
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
    this.cutDb = 0;            // the cut the key currently asks for
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
    this.t1 = clamp(hfNoiseLin * 2.8, 1e-7, 0.01);
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
      const cutTilt = this.maxCut > 0.01 ? clamp(tiltNow - this.tiltRef, 0, this.maxCut) : 60;
      const lvl = smoothstep(this.t1, this.t1 + 1 / this.inv, e);
      const cutLevel = lvl > 1e-6 ? -20 * Math.log10(lvl) : 60;
      this.cutDb = Math.min(cutTilt, Math.max(cutLevel - 6, 0));
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
    // Nothing to attenuate: hand the sample through untouched. This is what
    // keeps the stage *transparent* rather than "almost transparent" — without
    // it, every sample ran through the LR4 reconstruction, whose phase rotation
    // lifted the internal peak of a dense loud master by +4.7 dB and made the
    // soft-clip guard (and the level matcher behind it) pull the file down. The
    // de-hisser is a repair: it may only touch samples that need repairing.
    if (gEff >= 0.9999) return x;
    return low + high * gEff;
  }
}

/* -------------------------------------------------------------------------- */
/* de-clicker (vinyl crackle / digital impulse repair)                         */
/* -------------------------------------------------------------------------- */

class DeClicker {
  constructor(sr) {
    // prediction = 24 dB/oct low pass, fed with the *repaired* signal so that a
    // replaced sample can never leak back into the filter state
    this.pred = new Biquad(); this.pred.setLowpass(sr, 4000, 0.707);
    this.pred2 = new Biquad(); this.pred2.setLowpass(sr, 4000, 0.707);
    this.fast = new EnvFollower(sr, 1 / sr, 0.0006, 1);   // instant attack: 1-sample spikes
    this.slow = new EnvFollower(sr, 0.004, 0.025, 1);
    this.hang = 0;                    // keeps the repair alive for the neighbours
    this.inp = 0;
  }
  reset() {
    this.pred.reset(); this.pred2.reset(); this.fast.v = 0; this.slow.v = 0;
    this.hang = 0; this.inp = 0;
  }
  tick(x, amount) {
    if (amount <= 0.0001) { this.inp = x; return x; }
    const p = this.pred2.process(this.pred.process(this.inp));
    const d = x - p;
    const ad = d < 0 ? -d : d;
    const f = this.fast.tick(ad);
    const s = this.slow.tick(ad);
    // a click is a *short* broadband burst: the fast envelope spikes far above
    // the slow one, while musical transients raise both together
    const ratio = f / (s + 1e-9);
    let k = clamp((ratio - 1.25) / 1.5, 0, 1);
    k *= clamp((f - 0.008) / 0.05, 0, 1);
    k *= k * (3 - 2 * k);                              // smoothstep
    k *= amount;
    // a real pop spans 2–3 samples: hold the repair briefly, decaying, so the
    // trailing half of the spike is repaired as well
    if (k > this.hang) this.hang = k; else this.hang *= 0.72;
    const m = k > this.hang ? k : this.hang;
    const out = x + (p - x) * m;
    this.inp = out;                                    // filter sees the repair
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
    this.thr = 0.079;          // ≈ −22 dBFS
  }
  reset() { this.env.v = 0; this.gain.reset(1); }
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
    const gr = e > this.thr ? Math.sqrt(this.thr / e) : 1;
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
    this.infra = new Biquad();
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
    this.click = new DeClicker(sr);
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
    this.infra.reset();
    this.humNotch.reset();
    this.box[0].reset(); this.box[1].reset();
    for (const e of this.eq) { e.bq.reset(); e.last = 1e9; }
    for (const e of this.ceq) { e.bq.reset(); e.last = 1e9; }
    this.deess.reset();
    for (const r of this.reso) r.reset();
    for (const e of this.exc) e.reset();
    this.air.reset(); this.sub.reset(); this.hiss.reset();
    this.click.reset(); this.glue.reset();
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

    for (let i = 0; i < this.reso.length; i++) this.reso[i].depth = p.reso;
    this.excEven = 0.55 + p.warmth * 0.25;
    for (let i = 0; i < this.exc.length; i++) this.exc[i].setNoise(p.noiseLin);
    this.air.setNoise(p.noiseLin);
    this.air.setSource(p.airF);
    this.airRoom = p.airRoom;
    this.sub.setNoise(p.noiseLin);
    this.hiss.setNoise(p.hfNoiseLin);
    this.hiss.setTilt(p.hissTilt, p.hissMax);
    // the de-hisser splits where *this* file's noise starts
    this.hiss.setXover(p.hissF);
    this.glue.setTime(p.glueTime);
    this.lowShelf.setLowShelf(this.sr, 700, 0.60, -p.tilt * 5.0);
    this.highShelf.setHighShelf(this.sr, 3200, 0.60, p.tilt * 5.0);
    this.warm = p.warmth;
  }

  /** process one sample (dry level accumulation happens in the caller) */
  tick(x) {
    const p = this.p;
    let y = this.dc.process(x);
    if (this.infraTouched) y = this.infra.process(y);

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

    // 3 ── noise repair comes FIRST: never synthesize harmonics out of hiss
    y = this.hiss.tick(y, p.dehiss);
    y = this.click.tick(y, p.declick);

    // 3b ── sibilance control. It sits after the noise repair and before the
    // synthesisers for the same reason the de-hisser does: the exciter and the
    // air synthesiser build their output *out of* this band, so a band that is
    // about to be regenerated must not be re-synthesised from sibilant noise.
    y = this.deess.tick(y, p.deess);

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

    // 8 ── glue compression
    y = this.glue.tick(y, p.glue);

    // 9 ── tone tilt + analog warmth + DC guard
    y = this.highShelf.process(this.lowShelf.process(y));
    const w = this.warm;
    if (w > 0.0001) y = y * (1 - w * 0.55) + ftanh(y * (1 + w * 1.8)) * w * 0.62;
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
    this.prm = {
      power: 0, bypass: 1, sub: 0, subRatio: 0.5, exciter: 0, air: 0, dehiss: 0,
      declick: 0, reso: 0, glue: 0, warmth: 0, tilt: 0,
      hum: 0, hum2: 0, hum3: 0, humHz: 50, boxF1: 200, boxQ1: 3, boxG1: 0, boxF2: 400, boxQ2: 3, boxG2: 0,
      width: 0, airRoom: 0.5, airF: 6000, hissTilt: 0, hissMax: 0,
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
    this.forceBypass = !!opts.bypass;
    this._ensureChannels(opts.channels || 2);
    this.port.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.type === 'reset') {
        for (const c of this.chains) c.reset();
        this.sideHP.reset();
        this.sideLP.reset();
        this.powerSm = 0;
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

    const inCh = input && input.length ? input.length : 0;
    const frames = output[0].length;
    const targetPower = (this.forceBypass || pr.bypass > 0.5) ? 0 : clamp(pr.power, 0, 1);

    // block-rate smoothing of the master power (≈18 ms) → click-free A/B and
    // click-free slider moves; computed once per block so stereo stays coherent
    const pc = Math.exp(-frames / (this.sr * 0.018));
    this.powerSm = targetPower + pc * (this.powerSm - targetPower);
    const pw = this.powerSm;

    const autoLevel = pr.autoLevel > 0.5 && pw > 0.001;
    const bypassed = pw < 1e-4;

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
          const ax = x < 0 ? -x : x;
          if (ax > dryPk) dryPk = ax;
          const aw0 = wet0 < 0 ? -wet0 : wet0;
          if (aw0 > wetPk) wetPk = aw0;
          let wet = wet0 * g;
          // Soft-clip guard, last stage in the chain: a tanh knee above −0.55 dBFS
          // that saturates *below* full scale, so a 16-bit export can never pin a
          // sample at the ceiling. Transparent below the knee.
          if (wet > KNEE) wet = KNEE + RANGE * ftanh((wet - KNEE) / RANGE);
          else if (wet < -KNEE) wet = -KNEE + RANGE * ftanh((wet + KNEE) / RANGE);
          drySq += x * x;
          // Every level the matcher compares is measured on the *input* to its
          // own gain: `wet0`, not `wet`. Measured after the gain, the wet band
          // energy carries g² while the correction the matcher derives from it
          // is only linear in g, so the loop settles at the cube root of the
          // correction it should apply (a 4 dB mismatch came out as 1.3 dB) and
          // a 1 dB residual was left on every file. Measuring before the gain
          // makes the fixed point exact: chain level × g = dry level.
          wetSq += wet0 * wet0;
          // mid-band energy for the loudness match
          let md = x, mw = wet0;
          for (let b = 0; b < 4; b++) {
            md = chain.midDry[b].process(md);
            mw = chain.midWet[b].process(mw);
          }
          midDrySq += md * md;
          midWetSq += mw * mw;
          const mixed = x + pw * (wet - x);
          dst[i] = mixed > 1 ? 1 : mixed < -1 ? -1 : mixed;
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
        if (lo > KNEE) lo = KNEE + RANGE * ftanh((lo - KNEE) / RANGE);
        if (ro > KNEE) ro = KNEE + RANGE * ftanh((ro - KNEE) / RANGE);
        L[i] = lo; R[i] = ro;
      }
    }
    return true;
  }
}

registerProcessor('remaster-processor', RemasterProcessor);
