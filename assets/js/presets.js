/* =============================================================================
 * Remaster Suite — problem presets & adaptive auto-tuning
 * -----------------------------------------------------------------------------
 * A preset is a set of *ceilings*, not a set of amounts. Note the difference:
 *
 *   ceiling  — the most a profile will ever do at 100 % restoration power.
 *   amount   — what the chain actually gets, after the measurements have been
 *              read.
 *
 * The engine never applies a ceiling simply because a profile was chosen. Every
 * value is *dosed* from what was measured on the actual file:
 *
 *   • a stage that repairs something (de-hiss, de-click, de-resonator, the
 *     corrective EQ) is dosed by how strongly the problem was *detected* —
 *     nothing detected, nothing done;
 *   • a stage that synthesises something (sub-bass, exciter, air, warmth) is
 *     dosed by how much was measured as *missing*, in dB — nothing missing,
 *     nothing added.
 *
 * That is what stops the automatic mode from sounding over-controlled: on
 * material that needs no repair the chain stays transparent, and on material
 * that does need repair it never adds more than the missing amount, capped by a
 * published budget (see `doze`/`CAPS` below).
 * ========================================================================== */
(function (global) {
  'use strict';

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  /** 0 below lo, 1 above hi, smooth in between (Hermite). */
  const smoothstep = (lo, hi, x) => {
    const t = clamp((x - lo) / (hi - lo || 1e-9), 0, 1);
    return t * t * (3 - 2 * t);
  };

  /* -------------------------------------------------------------------------
   * Hard ceilings for the automatic tuning (100 % power, worst case material).
   *
   * These are the numbers the acceptance test in tests/tuning.test.js measures
   * the *rendered* audio against. They are deliberately lower than what the DSP
   * can do (the worklet still accepts 0…1), because the automatic mode has to
   * sound believable on any recording — a half-repaired top end is worth more
   * than a fake one. A listener who wants more can raise the power slider; the
   * plain-language contract is that the automatic result never sounds
   * "processed".
   * ---------------------------------------------------------------------- */
  const CEILING = {
    reso: 0.55,        // dynamic de-resonating depth
    sub: 0.45,         // sub-harmonic synthesis
    exciter: 0.26,     // harmonic exciter
    air: 0.30,         // 8–16 kHz air synthesis (dosed by need × deriveRoom)
    dehiss: 0.92,      // downward expander (a repair — allowed to work hard)
    declick: 0.85,     // impulse repair
    glue: 0.35,        // glue compression
    warmth: 0.45,      // saturation
    tilt: 0.35,        // tone tilt
    // The three below are repairs, so they are allowed to work hard — but only
    // where something was measured: hum is notched by the measured mains level,
    // boxiness by the measured resonance, width by the measured image.
    hum: 0.85,         // mains notches (−36 dB at the fundamental at 0.85)
    box: 3.5,          // dB taken out of the strongest measured resonance
    width: 0.55,       // stereo width restoration (≈ +3.4 dB of side signal)
    airRoom: 0.95,     // how much top end the synthesiser may rebuild
    eq: 6,             // dB the per-song corrective EQ may move a band in auto
  };

  /* The same for a profile the *user* picked by hand.
   *
   * Automatic mode is the one that has to be safe on any file, so it works on
   * the conservative budget above. A profile that was chosen explicitly is a
   * promise — "vinyl", "cassette", "128 kbit/s" — and it may spend more of
   * the chain to keep that promise (the de-clicker still only moves samples its
   * detector flags, the air synthesiser is still level-normalised, and the
   * worklet's own caps still hold). This is where the profiles stay audibly
   * different from each other instead of all converging on the same gentle
   * result. */
  const MANUAL = {
    reso: 0.80, sub: 0.80, exciter: 0.70, air: 0.80,
    dehiss: 0.95, declick: 0.95, glue: 0.55, warmth: 0.65, tilt: 0.50,
    eq: 9,             // a profile the user picked may correct more of the shape
  };

  /* -------------------------------------------------------------------------
   * Ceilings (100 % power) per profile
   *   band0  low shelf    60 Hz         band3  honk       1.3 kHz
   *   band1  mud          200 Hz        band4  presence   3.2 kHz
   *   band2  boxiness     450 Hz        band5  air shelf  7.0 kHz
   *   reso   dynamic de-resonating depth (0..1)
   *   sub    sub-harmonic synthesis (0..1)      subRatio  sub ratio (0.34..0.66)
   *   exciter / air   harmonic regeneration (0..1)
   *   dehiss / declick  restoration amounts (0..1)
   *   glue / warmth / tilt  finishing (0..1 / -1..1)
   * ---------------------------------------------------------------------- */
  const PRESETS = {
    auto: {
      id: 'auto',
      recommended: 0.72,
      anchors: {
        bands: [2.5, -3.0, -2.0, 0.5, 2.0, 2.2],
        reso: 0.40, sub: 0.40, subRatio: 0.5, exciter: 0.45, air: 0.45,
        dehiss: 0.45, declick: 0.20, glue: 0.30, warmth: 0.28, tilt: 0.0,
      },
    },
    garage: {
      id: 'garage',
      recommended: 0.75,
      anchors: {
        bands: [12.0, -4.0, -3.0, 1.0, 1.5, 3.5],
        reso: 0.60, sub: 0.70, subRatio: 0.5, exciter: 0.60, air: 0.50,
        dehiss: 0.50, declick: 0.20, glue: 0.35, warmth: 0.40, tilt: 0.05,
      },
    },
    vinyl: {
      id: 'vinyl',
      recommended: 0.70,
      anchors: {
        bands: [1.5, -3.0, -2.0, 0.5, 1.5, 1.8],
        reso: 0.40, sub: 0.45, subRatio: 0.5, exciter: 0.35, air: 0.35,
        dehiss: 0.55, declick: 0.85, glue: 0.25, warmth: 0.55, tilt: 0.0,
      },
    },
    cassette: {
      id: 'cassette',
      recommended: 0.68,
      anchors: {
        bands: [1.2, -2.5, -1.5, 0.0, 2.0, 2.4],
        reso: 0.35, sub: 0.40, subRatio: 0.5, exciter: 0.45, air: 0.50,
        dehiss: 0.90, declick: 0.20, glue: 0.30, warmth: 0.45, tilt: 0.0,
      },
    },
    lowbitrate: {
      id: 'lowbitrate',
      recommended: 0.72,
      anchors: {
        bands: [1.2, -1.8, -1.2, 0.4, 2.6, 2.6],
        reso: 0.30, sub: 0.45, subRatio: 0.5, exciter: 0.60, air: 0.80,
        dehiss: 0.30, declick: 0.10, glue: 0.30, warmth: 0.25, tilt: 0.05,
      },
    },
    general: {
      id: 'general',
      recommended: 0.62,
      anchors: {
        bands: [1.8, -2.2, -1.6, 0.0, 1.6, 1.8],
        reso: 0.35, sub: 0.40, subRatio: 0.5, exciter: 0.40, air: 0.40,
        dehiss: 0.40, declick: 0.20, glue: 0.30, warmth: 0.28, tilt: 0.0,
      },
    },
  };

  /** Order used by the preset <select> / chips in the UI. */
  const PRESET_ORDER = ['auto', 'garage', 'vinyl', 'cassette', 'lowbitrate', 'general'];

  /* ---------------------------------------------------------------- analysis */

  /**
   * Automatic problem detection.
   * @param {object} m metrics from RSDSP.measure()
   * @returns {{id:string, scores:object}} best matching preset + raw scores
   */
  function classify(m) {
    const cut = m.hfCutoff || 0;
    const crackle = clamp(m.crackleIndex, 0, 1);
    const hum = clamp(m.humScore, 0, 1);
    const flat = clamp(m.noiseFlatness, 0, 1);
    // Low-frequency energy only counts as *rumble* when it is neither part of a
    // flat noise bed (that is hiss, which already has its own term) nor sitting
    // where a measured mains line is (that is hum). Without both discounts a
    // hissy, hummy, bottom-less old recording scores as a turntable, because its
    // only low-frequency content is noise.
    const rumble = clamp(m.noiseRumble, 0, 1) * (1 - 0.3 * flat) * (1 - 0.5 * flat) * (1 - 0.5 * hum);
    const hiss = clamp(m.hissAmount, 0, 1);
    const clean = clamp(m.cleanliness, 0, 1);
    const dull = clamp(Math.max(m.dullIndex || 0, m.topLoss || 0), 0, 1);
    const brick = clamp(m.brickwall, 0, 1);
    const thin = clamp(m.bassRoll, 0, 1);
    const mud = clamp(m.mudScore, 0, 1);
    const harsh = clamp(m.harshness, 0, 1);

    const s = {};
    // vinyl rip: crackle is the signature, backed by rumble and surface noise.
    //
    // Mains hum is deliberately *not* one of them any more. Hum is interference,
    // not a medium: it turns up on tape, on a live desk and in a one-microphone
    // garage recording just as often as on a turntable, and with the hum
    // measurement fixed it was single-handedly pushing every hummy old recording
    // into the vinyl profile. A record instead has a *bottom end* (a mechanically
    // coupled one), which is what `1 − thin` says here.
    s.vinyl = clamp((0.58 * crackle + 0.16 * rumble + 0.09 * hiss + 0.08 * (1 - brick) + 0.06 * (1 - thin))
      * (crackle > 0.06 ? 1 : 0.42), 0, 1);
    // cassette: steady hiss, flat noise floor, rolled-off top, no crackle
    s.cassette = clamp(0.75 * hiss + 0.25 * flat * (1 - crackle) + 0.20 * dull * (1 - brick), 0, 1);
    // low bitrate / MP3: hard spectral cliff on otherwise clean material
    s.lowbitrate = clamp((0.62 * brick + 0.30 * clean * (1 - hiss) + 0.16 * dull * (1 - flat))
      * (1 - 0.5 * hiss) * (1 - 0.5 * crackle), 0, 1);
    // 60s/70s garage or one-mic room session: thin, boxy, dull, noisy, analogue —
    // and, because it was cut in a room with whatever wiring was there, often
    // hummy as well
    s.garage = clamp(0.42 * dull * (1 - 0.7 * brick) + 0.20 * mud + 0.22 * thin
      + 0.14 * rumble * (1 - flat) + 0.10 * (1 - clean) + 0.06 * hum + 0.10 * hiss, 0, 1);
    // telephone / dictaphone / badly band-limited source
    s.narrowband = clamp((9000 - cut) / 5000, 0, 1);

    let best = 'general', top = 0;
    for (const k of Object.keys(s)) if (s[k] > top) { top = s[k]; best = k; }
    if (best === 'narrowband') best = 'lowbitrate';
    return {
      id: top < 0.40 ? 'general' : best,
      scores: s, confidence: top,
      crackle, hum, rumble, hiss, clean, dull, brick, thin, mud, harsh,
      analogNoise: hiss, flat,
    };
  }

  /**
   * What does the material actually need? Everything in dB, so the doses below
   * can be read and reasoned about directly.
   *
   * `need` values are the *problems* (0 = nothing wrong, 1 = as bad as measured
   * can get); `*Db` are the same numbers expressed in decibels.
   *
   * @param {object} m metrics from RSDSP.measure()
   * @param {object} [d] classification (recomputed when omitted)
   */
  function demand(m, d, opts) {
    const c = d || classify(m);
    const manual = !!(opts && opts.manual);
    const band = (i) => (m.bandExcess && m.bandExcess.length === 6 ? clamp(m.bandExcess[i], -12, 12) : 0);

    // how much of the top end is missing, in dB — two independent measures:
    //  · topLoss  ✔ 6–12 kHz sits below the −3 dB/oct reference line
    //  · brickwall ✔ a codec cliff cut the top off, which is a known loss
    const topDeficitDb = clamp((m.topLoss || 0) * 22, 0, 22);
    const codecDeficitDb = clamp((m.brickwall || 0) * 12, 0, 12);
    // the top octave is masked by everything below it, so a given dB deficit up
    // there is worth less than the same deficit in the 6–12 kHz region
    const airDeficitDb = clamp(Math.max(topDeficitDb * 1.15, codecDeficitDb, (m.dullIndex || 0) * 10 * 0.9), 0, 24);
    // …and how much of it can be rebuilt at all. The synthesiser derives the
    // 8–16 kHz band from what is still present at 4.6–7.5 kHz: on a source that
    // is merely rolled off there is plenty to work from, while on one whose top
    // end is simply gone, every extra dB of "air" is invention. Measured gap
    // (4.6–7.5 kHz below the 0.8–1.6 kHz midrange): healthy ≈ 6 dB, rolled off
    // ≈ 9 dB, gone ≈ 18 dB.
    const gap = m.deriveGapDb === undefined ? 8 : clamp(m.deriveGapDb, 0, 30);
    // The same distinction separates a codec from a genuinely dull recording:
    // when the top end ends in a *cliff* (a bitrate low-pass), the content above
    // it was there before the encoder removed it, so rebuilding it from the band
    // just below the cliff is restoration — not invention. `brickwall` is the
    // measured steepness of that cliff.
    const brick = clamp(m.brickwall || 0, 0, 1);
    const codecRoom = clamp(0.30 + 0.55 * brick, 0, 0.85);
    // …and how far the synthesised band may reach above the one it was derived
    // from. This is *not* a second reward for having a cliff — the cliff already
    // raised `deriveRoom` above. It rises on one condition only: that the
    // derivation band itself had to move down. A cliff at 11 kHz leaves the
    // 6 kHz source untouched and nothing changes here; a cliff at 5 kHz forces
    // the source down to ≈3.6 kHz, where the same synthesis produces a thinner
    // result and has to be allowed to work harder.
    const ragged = clamp(m.hfRagged || 0, 0, 1);
    const srcShift = clamp((7000 - (m.cliffHz || 20000)) / 4500, 0, 1);
    const airRoom = clamp(0.5 + 0.40 * srcShift * (1 - ragged), 0.5, 0.90);

    // Automatic mode stays inside the published budget (never below 0.30);
    // an explicitly chosen profile may rebuild more of a missing top end
    // (never below 0.65), which is how "garage"/"low bitrate" keep their
    // character on material whose top end is genuinely gone.
    const deriveRoom = manual
      ? clamp(1 - (gap - 8) / 40, 0.65, 1)
      : Math.max(clamp(1 - (gap - 8) / 18, 0.30, 1), codecRoom);

    // how much low end is missing (bassRoll = 34–58 Hz below the −3 dB/oct line)
    const subDeficitDb = clamp((m.bassRoll || 0) * 16, 0, 16);
    const subPresentDb = clamp(band(0), -12, 12);            // > 0 = the source already humps there

    // how much is *too much*
    const mudExcessDb = clamp((m.mudScore || 0) * 12, 0, 12);
    const harshExcessDb = clamp((m.harshness || 0) * 10, 0, 10);
    const boxExcessDb = clamp(Math.max(band(2), 0), 0, 12);

    // ── mains hum ─────────────────────────────────────────────────────────
    // `humScore` comes from the exact-frequency measurement with its
    // stationarity check, so a sustained bass note measured as "not always
    // there" scores low even though it is strong.
    const humNeed = clamp(m.humScore || 0, 0, 1);
    // the strongest measured narrow resonance (boxy room, honky cabinet)
    const resoList = m.resonances || [];
    const resoExcess = resoList.length ? clamp(resoList[0].excessDb || 0, 0, 12) : 0;

    // ── stereo width ──────────────────────────────────────────────────────
    // A narrow image is a *correlated* one. Mono is the limit case (ρ = 1) and
    // is left alone: there is no side signal to widen, and inventing one would
    // be a fake image. `widenNeed` only rises where the channels are correlated
    // but not identical.
    const rho = m.correlation === undefined ? 1 : clamp(m.correlation, -1, 1);
    const widenNeed = (m.channels > 1 ? smoothstep(0.55, 0.93, rho) : 0) * (1 - smoothstep(0.995, 1, rho));

    // noise: only repair what was confidently measured
    const hissNeed = clamp((m.hissAmount || 0) * clamp((m.noiseConfidence || 0) * 1.5, 0, 1), 0, 1);
    const crackleNeed = clamp(m.crackleIndex || 0, 0, 1);

    /* ── the six per-song decisions ────────────────────────────────────────
     * Everything above is a *problem* the profile then treats. Everything below
     * is a property of this one file — a rumble it has, a sibilance it has, an
     * out-of-phase bottom, an amount of percussive movement, and where its
     * noise actually starts — that no profile could know about. */
    const conf = clamp((m.noiseConfidence || 0) * 1.5, 0, 1);

    // Sibilance: the 5–9 kHz band above the trend the file's own mids predict.
    // 2.5 dB is the dead zone (that is an "s" being present), 8 dB is a
    // problem; a de-esser is a *repair*, so it needs evidence, not a hunch.
    const sibDb = clamp(m.sibExcessDb || 0, 0, 16);
    const sibNeed = smoothstep(2.5, 8, sibDb);

    // Sub-sonic rumble, measured where only rumble can be: in the quiet
    // passages. Two guards, because this is the one measurement a *clean*
    // recording can trip by accident:
    //   · the noise confidence — on material with no quiet passage at all, the
    //     "quiet" frames are really the music, and there is nothing to measure;
    //   · the mains score — a 50/60 Hz line leaks into the band *below* it at
    //     any sane FFT resolution, and a hum is a notch, not a reason to take
    //     the bottom off the record.
    const infraDb = clamp(m.infraExcessDb || 0, 0, 26);
    const infraNeed = smoothstep(9, 20, infraDb) * smoothstep(0.12, 0.45, conf)
      * (1 - 0.5 * clamp(m.humScore || 0, 0, 1));

    // An out-of-phase bottom: the channels are correlated in the mids but
    // *cancel* below 200 Hz. Only stereo material can have it, and only when
    // there is real side energy down there to cancel in the first place.
    const st = m.stereo || {};
    const lowRho = (m.channels > 1 && isFinite(st.low)) ? st.low : 1;
    const widenGuard = m.channels > 1 && isFinite(st.mid) ? 1 : 0;
    const phaseNeed = widenGuard * smoothstep(0.55, 0.05, lowRho);

    // How percussive the material is (crest factor: a bed of sound sits at
    // 12–15 dB, hits and notes at 18–22 dB). It decides how the glue
    // compressor is timed — a compressor that grabs a drum recording the way
    // it grabs a pad pumps it.
    const percussive = clamp(((m.crestDb === undefined ? 14 : m.crestDb) - 13) / 8, 0, 1);

    // Where this file's noise actually starts (measured per band from the
    // quiet-frame spectrum against the music in the same band). The *repair*
    // branch of the de-hisser may reach down from the band the analyser keys
    // on (4 kHz), never above it — see DeHiss.setXover — so the usable range of
    // the split is 2.2–4 kHz: enough to follow a cassette's 2.5 kHz hiss edge,
    // and never a number measured somewhere the gate cannot see.
    const hissStartHz = clamp(m.hissStartHz || 3200, 2200, 4000);

    // is there headroom to add anything at all? (a master that already peaks at
    // −0.2 dBFS must not receive another 3 dB of bass)
    const peakDb = clamp(m.peakDb === undefined ? -6 : m.peakDb, -30, 0);
    const headroom = peakDb <= -1 ? 1 : clamp(1 - 0.6 * (peakDb + 1), 0.4, 1);
    const dense = (m.dynamicRangeDb !== undefined && m.dynamicRangeDb < 12) ? 1 : 0;

    return {
      topDeficitDb, codecDeficitDb, airDeficitDb, subDeficitDb, subPresentDb,
      mudExcessDb, harshExcessDb, boxExcessDb,
      hissNeed, crackleNeed, humNeed, headroom, dense,
      // normalised needs (0..1) used by the doses
      needTop: clamp(topDeficitDb / 18, 0, 1),
      needAir: clamp(Math.max(airDeficitDb / 20, (m.brickwall || 0) * 0.9), 0, 1),
      deriveRoom,
      needSub: clamp(subDeficitDb / 12, 0, 1),
      humNeed, resoNeed: clamp((resoExcess - 2) / 8, 0, 1), resoExcess,
      resoList, widenNeed, airRoom, codecRoom,
      // the per-song six
      sibDb, sibNeed, infraDb, infraNeed, lowRho, phaseNeed, percussive, hissStartHz, conf,
      needMud: clamp(mudExcessDb / 10, 0, 1),
      needHarsh: clamp(harshExcessDb / 8, 0, 1),
      needReso: clamp(Math.max(mudExcessDb / 12, harshExcessDb / 10, boxExcessDb / 10,
        (resoExcess - 2) / 8), 0, 1),
      bandExcess: [0, 1, 2, 3, 4, 5].map(band),
      confidence: c.confidence,
    };
  }

  /* ------------------------------------------------------- the per-song curve */

  /**
   * The six fixed bands of the profile's tone stage. Mirrored from the worklet
   * (chain 1) so the per-song correction can be computed *net* of what the
   * profile already does — the one thing that keeps two stages from correcting
   * the same problem twice.
   */
  const PROFILE_EQ = [
    ['lowshelf', 60, 0.70], ['peak', 200, 0.80], ['peak', 450, 1.00],
    ['peak', 1300, 0.90], ['peak', 3200, 0.85], ['highshelf', 7000, 0.70],
  ];

  /**
   * Magnitude of one RBJ biquad at frequency `f`, in dB — built from exactly
   * the coefficients the worklet's Biquad computes, so "the profile already
   * does +3 dB here" is a measurement and not an estimate.
   */
  function biquadDb(type, sr, f0, q, gainDb, f) {
    const w0 = 2 * Math.PI * clamp(f0, 5, sr * 0.49) / sr;
    const c = Math.cos(w0), sn = Math.sin(w0);
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lowshelf' || type === 'highshelf') {
      const al = sn / 2 * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
      const sq = 2 * Math.sqrt(A) * al;
      if (type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c);
        b2 = A * ((A + 1) - (A - 1) * c - sq);
        a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c);
        a2 = (A + 1) + (A - 1) * c - sq;
      } else {
        b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c);
        b2 = A * ((A + 1) + (A - 1) * c - sq);
        a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c);
        a2 = (A + 1) - (A - 1) * c - sq;
      }
    } else {
      const al = sn / (2 * q);
      b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A;
      a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A;
    }
    const w = 2 * Math.PI * clamp(f, 1, sr * 0.5) / sr;
    const cw = Math.cos(w), sw = Math.sin(w);
    const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * cw + b2 * c2, ni = -(b1 * sw + b2 * s2);
    const dr = a0 + a1 * cw + a2 * c2, di = -(a1 * sw + a2 * s2);
    const num = Math.sqrt(nr * nr + ni * ni), den = Math.sqrt(dr * dr + di * di);
    return 20 * Math.log10(Math.max(num, 1e-9) / Math.max(den, 1e-9));
  }

  /** What the profile's six bands already do at `f`, in dB. */
  function profileDb(bands, sr, f) {
    let sum = 0;
    for (let i = 0; i < PROFILE_EQ.length; i++) {
      const d = PROFILE_EQ[i];
      const g = bands && isFinite(bands[i]) ? bands[i] : 0;
      if (Math.abs(g) < 0.01) continue;
      sum += biquadDb(d[0], sr, d[1], d[2], g, f);
    }
    return sum;
  }

  /** 3-point smoothing that keeps the ends in place. */
  function smoothCurve(v) {
    const out = v.slice();
    for (let i = 1; i < v.length - 1; i++) out[i] = (v[i - 1] + 2 * v[i] + v[i + 1]) / 4;
    return out;
  }

  /**
   * Wide (5-point) trend with mirrored ends: what the curve would look like if
   * the band under test were removed and the surrounding bands were asked what
   * belongs between them.
   */
  function wideTrend(v) {
    const n = v.length, out = new Array(n);
    const at = (i) => v[Math.max(0, Math.min(n - 1, i))];
    for (let i = 0; i < n; i++) {
      out[i] = (at(i - 2) + at(i - 1) + at(i) + at(i + 1) + at(i + 2)) / 5;
    }
    const t2 = new Array(n);
    for (let i = 0; i < n; i++) {
      t2[i] = (out[Math.max(0, i - 1)] + out[i] + out[Math.min(n - 1, i + 1)]) / 3;
    }
    return t2;
  }

  /**
   * The per-song corrective EQ — the *shape* of this recording, twelve bands.
   *
   * The profile's six bands are broad: they move the tone, the tilt, the
   * character. What they cannot do is a *local* imbalance — a hollow 800 Hz, a
   * peaky 1.6 kHz, a scooped 3 kHz, all of them one or two bands wide and
   * different in every file. That is what this curve is: the file's own twelve
   * measured bands compared with the trend its *neighbouring* bands predict, so
   * a band that sticks out is pulled back and one that sits in a hole is lifted,
   * while the recording's overall tone is left alone (that belongs to the
   * profile and the power slider, and every file is meant to keep its own).
   *
   * The rules that keep it honest:
   *   · a ±1.5 dB dead zone — natural ripple is not a defect, and chasing it is
   *     how an automatic mode starts to sound like its own reflection;
   *   · the *local* part of what the profile already does is subtracted, so a
   *     bump the profile has already fixed is not fixed twice (its smooth part
   *     is character and stays untouched);
   *   · boosts are refused where they would only lift noise (a band less than
   *     ~12 dB above the measured floor there) and where the file is empty — and
   *     halved when there was no quiet passage to measure a floor in, because
   *     then the noise margin is simply unknown;
   *   · a codec's cliff is never boosted (that top end was removed; rebuilding
   *     it is the air synthesiser's job, a shelf would only lift the noise under
   *     the edge);
   *   · no bass cut without measured excess in the bottom octave — the one
   *     correction that can make a record sound small.
   *
   * @returns {number[]} twelve gains in dB, in EQ_CENTERS order
   */
  function eqCurve(m, bands, manual) {
    const centers = (m.eqCenters && m.eqCenters.length === 12) ? m.eqCenters : [50, 80, 125, 200, 320, 500, 800, 1250, 2000, 3200, 5000, 8000];
    const lvl = (m.bandDb && m.bandDb.length === 12) ? m.bandDb : null;
    if (!lvl) return centers.map(() => 0);
    const sr = m.sr || 48000;
    const cap = manual ? 9 : 6;

    // the file's local departure from its own trend
    const trend = wideTrend(lvl);
    let local = lvl.map((v, i) => (isFinite(v) ? v - trend[i] : 0));
    // …minus the local part of the profile's response: what the profile has
    // already shaped locally must not be shaped again
    const prof = centers.map((f) => profileDb(bands, sr, f));
    const profTrend = wideTrend(prof);
    local = local.map((v, i) => v + (prof[i] - profTrend[i]));

    let curve = local.map((v) => {
      const g = -v;                                    // flatten the local shape
      return Math.sign(g) * Math.max(0, Math.abs(g) - 1.5);
    });
    curve = smoothCurve(curve);

    // is the noise floor in this band known well enough to allow a boost?
    const conf = clamp((m.noiseConfidence || 0) * 1.5, 0, 1);
    const med = lvl.slice().sort((a, b) => a - b)[lvl.length >> 1];
    for (let i = 0; i < curve.length; i++) {
      const f = centers[i];
      let g = clamp(curve[i], -cap, cap);
      if (!isFinite(lvl[i]) || (med - lvl[i]) > 22) {
        // the band holds no music: nothing to balance, and a boost would only
        // raise whatever is left
        g = 0;
      } else if (g > 0) {
        const snr = (m.bandSnrDb && isFinite(m.bandSnrDb[i])) ? m.bandSnrDb[i] : 40;
        if (conf > 0.25) {
          // a band that is mostly noise: a boost there is a boost of the noise
          if (snr < 12) g *= 0.2;
          else if (snr < 18) g *= 0.55;
        } else {
          g *= 0.55;                                   // floor unknown → be careful
        }
        // above a codec cliff the content was *removed*
        if (m.brickwall > 0.25 && m.cliffHz && f > m.cliffHz * 1.0) g = Math.min(g, 0.8);
      } else if (g < 0 && f <= 80) {
        // Taking the bottom away is the one correction that can remove what the
        // recording actually has, so it needs more evidence than the dead zone:
        // an excess this file measured *against its own trend*, not just a dip
        // in the trend fit. (There is no separate "bass excess" number in the
        // measurement — the band's own departure is the measurement.)
        const excess = clamp(-local[i], 0, 12);
        if (excess < 3) g = 0;
        else g = Math.max(g, -0.5 * excess);
      }
      curve[i] = clamp(g, -cap, cap);
    }
    return curve;
  }

  /** What the per-song curve does at one frequency, in dB (real biquads). */
  function curveDb(curve, centers, q, sr, f) {
    let sum = 0;
    for (let i = 0; i < centers.length; i++) {
      if (Math.abs(curve[i]) < 0.01) continue;
      sum += biquadDb('peak', sr, centers[i], q, curve[i], f);
    }
    return sum;
  }

  /**
   * Dose every stage of the chain from the measurements.
   *
   * @param {object} anchors the profile's ceilings (100 % power)
   * @param {object} m       metrics from RSDSP.measure()
   * @param {object} [diag]  classification
   * @returns {object} the amounts this file actually gets (before the power slider)
   */
  function adapt(anchors, m, diag, opts) {
    const d = diag || classify(m);
    const D = demand(m, d, opts);
    const a = JSON.parse(JSON.stringify(anchors));
    // `manual` = the user named this profile; automatic mode works to a tighter
    // budget (see CEILING / MANUAL above)
    const manual = !!(opts && opts.manual);
    const cap = manual ? MANUAL : CEILING;
    const bandCap = manual ? 9 : 6;

    /* ── 1 · tone shaping ──────────────────────────────────────────────────
     * The profile's curve is a *ceiling*, not a curve to apply. Every band is
     * dosed by how much that particular problem was measured: no mud measured,
     * no mud cut; a bottom octave that is intact gets no bass lift. Without
     * this the automatic mode put a mild smiley-face curve on every file —
     * which is exactly the "it always does something" feel we are fixing. */
    const dose = [
      D.needSub,                                       // 60 Hz shelf  (fill)
      D.needMud,                                       // 200 Hz       (cut)
      D.needMud,                                       // 450 Hz       (cut)
      Math.max(D.needHarsh, D.needReso * 0.6),         // 1.3 kHz      (cut)
      D.needTop,                                       // 3.2 kHz      (lift)
      D.needAir,                                       // 7 kHz shelf  (lift)
    ];
    for (let i = 0; i < 6; i++) a.bands[i] *= dose[i];

    /* ── 2 · corrective EQ ─────────────────────────────────────────────────
     * On top of that, follow the measured deviation from the local trend — but
     * only partially and only outside a dead zone: every real recording has
     * ±1.5 dB of natural ripple, and "correcting" that is how an automatic mode
     * ends up chasing its own tail. Half of a narrow hump is a correction, all
     * of it is a new sound. */
    for (let i = 0; i < 6; i++) {
      const ex = D.bandExcess[i];
      const beyond = Math.sign(ex) * Math.max(0, Math.abs(ex) - 1.5);
      a.bands[i] -= clamp(beyond * 0.4, -2.5, 2.5);
    }

    // extra shaping where the measurement was emphatic
    a.bands[0] += 1.6 * D.needSub;
    a.bands[3] -= 0.7 * D.needHarsh;
    a.bands[4] -= 1.2 * D.needHarsh;
    a.bands[5] += 1.0 * D.needAir;

    for (let i = 0; i < 6; i++) a.bands[i] = clamp(a.bands[i], -bandCap, bandCap);

    /* ── 3 · dynamic de-resonating ────────────────────────────────────────
     * Room ring and boxiness: dosed by how boxy/harsh the material measured. */
    a.reso = a.reso * smoothstep(0.05, 0.55, D.needReso);

    /* ── 4 · sub-bass synthesis ───────────────────────────────────────────
     * Only what is missing: a recording whose bottom octave is intact gets
     * nothing at all (the old law added it because the profile said so, which
     * is exactly what made cassette and vinyl rips sound pumped up). */
    a.sub = a.sub * smoothstep(0.15, 0.60, D.needSub);
    if (D.subPresentDb > 2.5) a.sub *= 0.4;             // already humps there
    if (m.correlation !== undefined && m.correlation < 0.25) a.sub *= 0.7;
    a.sub = clamp(a.sub * D.headroom, 0, cap.sub);

    /* ── 5 · top end: exciter and air ─────────────────────────────────────
     * Both are dosed from the deficit and nothing else, and both are held back
     * on a hot master. The air amount is then capped: the worklet limits what
     * the synthesiser may add relative to the band it derives from, so this
     * number is a *request*, not a guarantee. */
    const topDose = smoothstep(0.10, 0.45, D.needTop);
    const airDose = smoothstep(0.10, 0.45, D.needAir);
    a.exciter = clamp(a.exciter * topDose * D.headroom, 0, cap.exciter);
    // `deriveRoom` is what keeps the automatic result believable: it is the only
    // factor that separates "rolled off, worth rebuilding" from "gone, leave it
    // alone", and it is deliberately applied to the amount, after the dose curve
    a.air = clamp(a.air * airDose * D.headroom * D.deriveRoom, 0, cap.air);
    // The *ceiling* is a separate axis from the amount. `deriveRoom` says how
    // much of the missing top end is worth asking for; `airRoom` says how far
    // above the band it was derived from the synthesised band may reach. On a
    // codec-damaged file the surviving band sits just below the cliff and the
    // rebuilt band has to be able to stand on its own; on a healthy file the
    // ceiling never leaves the shipped 0.5. It needs no power term of its own:
    // the worklet multiplies the synthesised band by the (power-dosed) air
    // amount *after* the ceiling, so a lower slider position stays quieter than
    // a higher one whatever the ceiling is.
    a.airRoom = clamp(D.airRoom, 0.5, cap.airRoom);

    /* ── 6 · noise repair ─────────────────────────────────────────────────
     * De-hiss and de-click are repairs: they engage in proportion to the
     * measured problem, plus a small amount for material with a high broadband
     * floor, and never on a signal that was measured as clean. */
    const floorExtra = clamp((clamp(num(m.noiseFloorDb, -70), -95, -30) + 58) / 22, 0, 1);
    // Half of a repair stage comes from the profile (that is what picking
    // "vinyl" or "cassette" means) and half from the measurement (how much
    // was detected). Both modules are threshold-gated inside the worklet — they
    // only touch samples their own detector flags — so a half amount on clean
    // material measures as a no-op rather than as damage.
    // The de-hisser now subtracts the *measured* amount of top-end noise (the
    // analyser reports how many dB of the 4–16 kHz band the programme cannot
    // account for), so its amount is a fraction of a real repair rather than a
    // strength on a gate: anything the measurement is sure about is applied in
    // full, and a marginal reading stays marginal.
    const hissDose = smoothstep(0.04, 0.40, D.hissNeed);
    a.dehiss = clamp(a.dehiss * (0.5 + 0.5 * hissDose) + 0.25 * floorExtra * D.hissNeed, 0, cap.dehiss);
    a.declick = clamp(a.declick * (0.5 + 0.5 * smoothstep(0.03, 0.40, D.crackleNeed)), 0, cap.declick);

    /* ── 7 · dynamics and warmth ──────────────────────────────────────────
     * Saturation adds density, so it belongs on sparse, dynamic recordings.
     * A modern, heavily limited master must not be squashed any further. */
    const drDb = m.dynamicRangeDb === undefined ? 18 : m.dynamicRangeDb;
    a.glue = a.glue * (drDb < 12 ? 0.5 : 1) * (drDb > 20 ? 1.15 : 1) * D.headroom;
    a.glue = clamp(a.glue, 0, cap.glue);
    a.warmth = a.warmth * (D.dense ? 0.45 : 1) * D.headroom;
    if (drDb < 12) a.warmth = Math.min(a.warmth, 0.20);
    a.warmth = clamp(a.warmth, 0, cap.warmth);

    /* ── 7b · mains hum ───────────────────────────────────────────────────
     * A repair with a lot of authority (−36 dB at the fundamental), so it is
     * dosed from the measurement alone: the exact-frequency detector reports how
     * far the 50/60 Hz tone sits above the surrounding spectrum *and* whether it
     * was there in every segment of the file. A sustained musical note is loud
     * but not stationary, and a level that never moves is what hum is. */
    const humGate = smoothstep(0.05, 0.25, D.humNeed);
    // The depth is the *measured* excess, not "as deep as the cap allows":
    // removing `G` dB from a tone that stood `E` dB proud of its neighbours
    // leaves `E − G` there, so `G ≈ E` is the one dose that lands the mains line
    // on top of the music instead of either leaving hum or cutting a bass hole.
    // (The worklet's law is −42 dB at the fundamental for `hum = 1`.)
    // …plus three decibels of margin, because the chain hands the notch a signal
    // with more low end than the source had: sub synthesis and saturation both
    // put energy back at the mains frequency. Measured on the garage fixture, a
    // notch sized to the source excess left the 50 Hz line 2.5 dB proud of its
    // shoulders at the output; three decibels of margin lands it on the
    // detector's own floor, and the notch stays five hertz wide either way.
    const humWantDb = clamp((m.humPeakDb || 0) + 3, 0, 32);
    a.hum = clamp((humWantDb / 42) * humGate, 0, cap.hum);
    // …and the same, measured, for the two harmonics that carry mains buzz. A
    // pure 50 Hz line (the usual case) leaves them at zero, so the bass that
    // lives at 100 and 150 Hz is not touched; a recording with real harmonic
    // content on the mains gets each one notched by exactly its own excess.
    a.hum2 = clamp((clamp((m.hum2Db || 0) + 2, 0, 32) / 42) * humGate, 0, cap.hum);
    a.hum3 = clamp((clamp((m.hum3Db || 0) + 2, 0, 32) / 42) * humGate, 0, cap.hum);
    a.humHz = m.mainsHz === 60 ? 60 : 50;

    /* ── 7c · boxiness: the measured resonances ───────────────────────────
     * The dynamic de-resonator (below, `reso`) only pulls down what rings above
     * its own running average — which a *constant* colouration never does, it is
     * the average. Those need a static notch, and the measurement now finds them
     * precisely (narrow peak, ≥ 3 dB above the local trend, 150–1800 Hz). The
     * cut is deliberately shallow (≤ 3.5 dB): a mis-placed notch costs a third
     * of an octave, while an untouched honk colours the whole record. */
    const boxes = (D.resoList || []).slice(0, 2);
    a.box = [0, 0];
    a.boxF = [200, 400];
    a.boxQ = [3, 3];
    for (let i = 0; i < boxes.length; i++) {
      const r = boxes[i];
      const dose = smoothstep(3.2, 5.2, r.excessDb) * D.headroom;
      const depth = Math.min(cap.box, 0.55 * r.excessDb) * dose;
      // each notch carries its own allowance: two narrow notches half an octave
      // apart do not add up, so a shared budget only ever starved the second one
      const take = Math.min(depth, cap.box);
      a.box[i] = -take;
      a.boxF[i] = clamp(r.hz, 100, 1800);
      a.boxQ[i] = clamp(r.q || 3, 1.4, 6);
    }

    /* ── 7d · stereo width ────────────────────────────────────────────────
     * Only for an image that is narrow (channels strongly correlated) and not
     * mono: the worklet adds the high-passed side signal, so the bass stays in
     * the centre and a mono master stays mono. */
    a.width = clamp(cap.width * smoothstep(0.08, 0.55, D.widenNeed), 0, cap.width);

    /* ── 8 · tone tilt ────────────────────────────────────────────────────
     * A gentle nudge, at most a quarter of what was measured, and only when
     * the tilt is actually audible. */
    a.tilt = clamp(a.tilt + clamp((m.tilt || 0) / 45, -0.20, 0.20) * (D.confidence > 0.35 ? 1 : 0.5), -cap.tilt, cap.tilt);

    /* ── 9 · the per-song stages ──────────────────────────────────────────
     * Six decisions that no profile can make, because they are about this one
     * file. Each is a repair: it is dosed by the measurement of the defect and
     * it does nothing at all when nothing was measured. */

    // 9a · sub-sonic rumble → a high-pass at the measured corner. The corner
    // *is* the amount, and it stays low on purpose: 18–30 Hz is where rumble
    // lives and where no instrument does, so a 12 dB/octave filter there takes
    // out what a turntable (or a desk, or a passing lorry) put in without
    // touching the bass above it. A "repair" that reaches into 40 Hz would be
    // taking the record's bottom away, which is the opposite of remastering.
    a.infraHP = D.infraNeed > 0.02 ? clamp(18 + 12 * D.infraNeed, 0, 30) : 0;

    // 9b · sibilance → the dynamic de-esser amount (up to the cap at full need)
    a.deess = clamp(0.85 * D.sibNeed * D.headroom, 0, 0.85);

    // 9c · stereo: an out-of-phase bottom is folded to the centre, and the
    // widening is only asked for where the image is narrow *and* centred —
    // widening a recording with a phase problem makes the phase problem
    // audible, which is exactly what the bass-mono stage above prevents.
    a.bassMono = clamp(D.phaseNeed * 1.0, 0, 1);

    // 9d · how a *hit* behaves → the glue compressor's timing. Percussive
    // material gets a slower attack and a shorter release (let the hit
    // through, be back at unity for the next one); sustained material gets the
    // slow, smooth setting that is what "glue" means on a pad or a string bed.
    a.glueTime = clamp(1 - D.percussive * 0.85, 0.15, 1);

    // 9e · where the hiss starts → the de-hisser's crossover. A rate, not an
    // amount: it is the measurement, and the worklet multiplies by the amount.
    a.hissF = D.hissStartHz;

    // 9f · the per-song corrective EQ, computed net of the profile's own bands.
    // Its amount follows the master amount like every other amount (at 0 % the
    // curve is not applied at all), but the *shape* is this file's.
    a.ceq = eqCurve(m, a.bands, manual).map((g) => clamp(g, -cap.eq, cap.eq));

    // 9g · the de-clicker on percussive material. Its detector separates a
    // click from a snare by how far the fast envelope stands above the slow
    // one — and a drum hit does that too, which is why a recording with a lot
    // of them gets a little less of it.
    // The exception is the recording that is *made* of clicks: crackle raises
    // the crest factor just like a drum kit does, so the "percussive" estimate
    // is confounded by the very defect this stage repairs. Where the crackle
    // detector has actually heard crackle, the reduction stands down — a
    // crackly record is the one case where full de-clicking is what the file
    // needs, whatever its crest factor says.
    a.declick = clamp(a.declick * (1 - 0.3 * D.percussive * (1 - D.crackleNeed)), 0, cap.declick);

    return a;
  }

  /**
   * Build the flat parameter map consumed by the AudioWorklet.
   * @param {string} presetId
   * @param {object} metrics
   * @param {number} power 0..1
   * @param {object} [overrides] manual tweaks
   */
  /** Last line of defence against a parameter that was never measured. */
  /** What a parameter means when the measurement could not provide a value. */
  const NEUTRAL = {
    autoLevel: 1, noiseFloor: -70, hissFloor: -80, airRoom: 0.5, airF: 6000, subRatio: 0.5,
    humHz: 50, boxF1: 120, boxF2: 240, boxQ1: 3, boxQ2: 3,
    hissF: 3200, glueTime: 0.5, infraHP: 0,
  };

  function num(v, dflt) {
    const x = Number(v);
    return isFinite(x) ? x : dflt;
  }

  function buildParams(presetId, metrics, power, overrides) {
    const diag = classify(metrics);
    // "auto" is not a sound of its own: it resolves to whatever was detected
    const id = (presetId === 'auto' || !PRESETS[presetId]) ? diag.id : presetId;
    const base = PRESETS[id] || PRESETS.auto;
    const manual = !!(presetId && presetId !== 'auto' && PRESETS[presetId]);
    const a = adapt(base.anchors, metrics, diag, { manual });
    const p = clamp(power, 0, 1);
    // Amounts follow a slightly concave curve, so the low range of the slider is
    // useful. `on` is the "switched on at all" factor: it is *exactly* 0 at 0 %,
    // which is what makes 0 % a bit-transparent copy of the original, and it is
    // exactly 1 from 10 % upwards, so nothing else about the curve changes.
    const on = smoothstep(0, 0.10, p);
    const amt = Math.pow(p, 0.85) * on;
    // the dry/wet crossfade only exists in the first few percent; above that the
    // signal is fully wet and the amounts alone carry the intensity
    const wet = smoothstep(0, 0.06, p);
    // repair stages (de-hiss, de-click) engage a little earlier than the
    // creative ones — but never before the slider has left zero
    const repair = (x) => x * (0.35 + 0.65 * amt) * on;
    // Measured defects are not a matter of taste: once the slider has left zero,
    // hum, boxiness and a collapsed image are fixed by the *measurement* — a
    // mains notch shallower than the hum leaves the hum, and one deeper than it
    // cuts the bass. These are gated, never scaled down.
    const fix = (x) => x * smoothstep(0, 0.20, p);

    // bands are an amount like every other: they follow the same curve as the
    // rest of the chain (`p` alone made them 3 dB weaker at half power, which is
    // not what the slider says)
    const bands = a.bands.map((g) => g * amt);
    const params = {
      power: wet,                    // dry/wet crossfade (0 % = untouched original)
      bypass: 0,
      band0: bands[0], band1: bands[1], band2: bands[2],
      band3: bands[3], band4: bands[4], band5: bands[5],
      reso: a.reso * amt,
      sub: a.sub * amt,
      subRatio: a.subRatio,
      exciter: a.exciter * amt,
      air: a.air * amt,
      dehiss: repair(a.dehiss),
      declick: repair(a.declick),
      glue: a.glue * amt,
      warmth: a.warmth * amt,
      tilt: a.tilt * p,
      // Repairs that live outside the power curve: hum and the measured
      // resonance notches are either measured or they are not, and a slider at
      // 100 % must not invent them. They are gated by `p` (0 % stays
      // bit-transparent) but otherwise applied as measured.
      hum: fix(a.hum),
      hum2: fix(a.hum2 || 0),
      hum3: fix(a.hum3 || 0),
      humHz: a.humHz,
      boxG1: num(fix(a.box[0]), 0), boxF1: a.boxF[0], boxQ1: a.boxQ[0],
      boxG2: num(fix(a.box[1]), 0), boxF2: a.boxF[1], boxQ2: a.boxQ[1],
      // width is taste, not a defect: it follows the repair curve with the rest
      width: num(repair(a.width), 0),
      // how much top end the synthesiser may rebuild, and where it derives it
      // from: a low-bitrate file needs the source band below its cliff, not the
      // fixed 6 kHz band that sits partly above it. (`num` keeps a parameter
      // that was never measured out of the worklet — a NaN there would silently
      // switch the air band off.)
      airRoom: num(a.airRoom, 0.5),
      airF: num(clamp((metrics.brickwall || 0) > 0.3 && metrics.cliffHz ? metrics.cliffHz * 0.72 : 6000, 2200, 6000), 6000),
      noiseFloor: clamp(num(metrics.noiseFloorDb, -70), -95, -30),
      // The de-hisser's level reference is the HF band's RMS in the quiet
      // passages (`hissRefDb`), not the spectrum's band sum: the worklet gates on
      // an RMS of that band, so the two numbers have to be the same quantity.
      hissFloor: clamp(num(metrics.hissRefDb, num(metrics.hfNoiseFloorDb, -80)), -110, -25),
      // the programme's own HF − MID tilt, and how much of the top end the
      // measurement found to be noise rather than programme (dB)
      hissTilt: num(metrics.musicTiltDb, 0),
      hissMax: num(clamp((metrics.hissTiltStepDb || 0) - 1.0, 0, 18), 0),
      // ── the per-song stages ─────────────────────────────────────────────
      // Amounts follow the same curves as everything else: the rumble filter's
      // corner follows the *gate* (a repair is either on or off, but it must
      // not switch on at 2 %), the de-esser and the bass-mono stage are
      // amounts, and the corrective EQ follows `amt` like every other band.
      infraHP: num(fix(a.infraHP), 0),
      deess: num(repair(a.deess), 0),
      bassMono: num(fix(a.bassMono), 0),
      glueTime: num(a.glueTime, 0.5),
      hissF: num(clamp(a.hissF, 2000, 8000), 3200),
      autoLevel: 1,
    };
    // the corrective EQ: twelve bands, same amount curve as the profile's
    for (let i = 0; i < 12; i++) {
      params['eq' + i] = num(clamp((a.ceq && a.ceq[i]) || 0, -9, 9) * amt, 0);
    }
    if (overrides) Object.assign(params, overrides);
    // Belt and braces: whatever the measurement was, the worklet never receives a
    // non-finite number. A `NaN` parameter does not fail loudly — it either
    // switches a stage off or poisons the whole signal, and the file comes out
    // silent. `NEUTRAL` is "that stage does nothing" for the few parameters where
    // zero is not neutral; everything else falls back to zero.
    for (const k of Object.keys(params)) {
      const v = params[k];
      if (typeof v === 'number' && !isFinite(v)) params[k] = NEUTRAL[k] === undefined ? 0 : NEUTRAL[k];
    }
    return params;
  }

  /**
   * The whole per-song analysis, item by item.
   *
   * This is the answer to "what does this file actually need": every finding
   * carries the number it was measured at and the treatment it produced — and
   * the treatments are the *parameters that will actually be used*, not a
   * description of the profile. A file with nothing wrong produces a short,
   * honest list instead of a shopping list.
   *
   * @param {object} m metrics from RSDSP.measure()
   * @param {object} [params] the built parameter map (for the doses)
   * @param {number} [power] 0..1
   * @returns {{findings:Array, headline:{count:number,severe:number}, character:string}}
   */
  function recipe(m, params, power) {
    const p = params || {};
    const D = demand(m);
    const st = m.stereo || {};
    const out = [];
    const add = (key, sev, value, act) => {
      out.push({ key, sev: clamp(sev, 0, 1), value: value || null, act: act || null });
    };
    const dbv = (n) => ({ n, unit: 'db' });
    const pct = (n) => ({ n, unit: 'pct' });
    // an action carries the parameter it ends up setting, in its own unit, so
    // the UI can print the dose the file will really get
    const act = (key, n, unit) => ({ key, value: n === null || n === undefined ? null : { n, unit: unit || 'pct' } });

    /* ── noise and surface defects ─────────────────────────────────────── */
    if (D.infraNeed > 0.02) {
      add('rumble', D.infraNeed, dbv(D.infraDb), act('infra', p.infraHP || 0, 'hz'));
    }
    if ((m.humScore || 0) > 0.2) {
      add('hum', clamp(m.humScore, 0, 1), dbv(m.humPeakDb || 0), act('hum', 42 * (p.hum || 0), 'db'));
      if ((m.hum2Db || 0) > 2 || (m.hum3Db || 0) > 2) {
        add('humHarm', clamp(Math.max(m.hum2Db || 0, m.hum3Db || 0) / 20, 0, 1),
          dbv(Math.max(m.hum2Db || 0, m.hum3Db || 0)), act('humHarm', null));
      }
    }
    if ((m.hissAmount || 0) > 0.12) {
      add('hiss', clamp(m.hissAmount, 0, 1), dbv(m.hissTiltStepDb || 0),
        act('dehiss', p.dehiss || 0));
      add('hissBand', clamp(m.hissAmount, 0, 1), { n: p.hissF || m.hissStartHz || 3200, unit: 'hz' },
        act('hissSplit', p.hissF || 0, 'hz'));
    }
    if ((m.crackleIndex || 0) > 0.08) {
      add('crackle', clamp(m.crackleIndex, 0, 1), dbv((m.noiseInfo && m.noiseInfo.crestP98Db) || 0),
        act('declick', p.declick || 0));
    }
    if (m.noiseSpreadDb > 6) {
      add('noisePump', clamp(m.noiseSpreadDb / 18, 0, 1), dbv(m.noiseSpreadDb), act('expander', null));
    }

    /* ── tonal shape: the measured bands and the per-song curve ────────── */
    const reso = (D.resoList || [])[0];
    if (reso && reso.excessDb > 3) {
      add('boxy', clamp((reso.excessDb - 3) / 6, 0, 1), { n: reso.hz, unit: 'hz' },
        act('box', Math.abs(p.boxG1 || 0), 'db'));
    }
    const reso2 = (D.resoList || [])[1];
    if (reso2 && reso2.excessDb > 3 && Math.abs(p.boxG2 || 0) > 0.05) {
      add('boxy2', clamp((reso2.excessDb - 3) / 6, 0, 1), { n: reso2.hz, unit: 'hz' },
        act('box', Math.abs(p.boxG2), 'db'));
    }
    if (D.needMud > 0.12) {
      add('mud', D.needMud, dbv(D.mudExcessDb), act('eqCut', Math.min(0, p.band1 || 0) + Math.min(0, p.band2 || 0), 'db'));
    }
    if (D.needHarsh > 0.1) {
      add('harsh', D.needHarsh, dbv(D.harshExcessDb), act('eqCut', Math.min(0, p.band4 || 0), 'db'));
    }
    if (D.sibNeed > 0.05) {
      add('sibilance', D.sibNeed, dbv(D.sibDb), act('deess', p.deess || 0));
    }
    if (D.needTop > 0.15 || D.needAir > 0.2) {
      add('dullTop', clamp(Math.max(D.needTop, D.needAir), 0, 1), dbv(D.topDeficitDb),
        act('exciter', p.exciter || 0));
      add('airLost', clamp(D.needAir, 0, 1), dbv(D.airDeficitDb), act('air', p.air || 0));
    }
    if ((m.brickwall || 0) > 0.25 && m.cliffHz) {
      add('codec', clamp(m.brickwall, 0, 1), { n: m.cliffHz, unit: 'hz' },
        act('rebuild', p.airF || 0, 'hz'));
    }
    if (D.needSub > 0.15) {
      add('weakBass', D.needSub, dbv(D.subDeficitDb), act('sub', p.sub || 0));
    }
    // the per-song EQ itself: the largest correction it makes, and where
    if (p.eq0 !== undefined) {
      let worst = 0, worstF = 0, count = 0;
      for (let i = 0; i < 12; i++) {
        const g = p['eq' + i] || 0;
        if (Math.abs(g) > 0.6) count++;
        if (Math.abs(g) > Math.abs(worst)) { worst = g; worstF = (m.eqCenters && m.eqCenters[i]) || 0; }
      }
      if (Math.abs(worst) > 0.6) {
        add('shape', clamp(Math.abs(worst) / (MANUAL.eq), 0, 1), { n: worstF, unit: 'hz' },
          act('songEq', worst, 'db'));
      }
    }

    /* ── stereo image ──────────────────────────────────────────────────── */
    if (m.channels > 1 && D.phaseNeed > 0.05) {
      add('outOfPhase', D.phaseNeed, { n: st.low, unit: 'ratio' }, act('bassMono', p.bassMono || 0));
    }
    if (m.channels > 1 && D.widenNeed > 0.15) {
      add('narrow', clamp(D.widenNeed, 0, 1), { n: m.correlation, unit: 'ratio' }, act('width', p.width || 0));
    }
    if (m.channels === 1) add('mono', 0.2, null, act('mono', null));
    if (m.channels > 1 && Math.abs(st.balanceDb || 0) > 1.5) {
      add('balance', clamp(Math.abs(st.balanceDb) / 6, 0, 1), dbv(st.balanceDb), act('balance', null));
    }

    /* ── level, dynamics, medium ───────────────────────────────────────── */
    const dr = m.dynamicRangeDb === undefined ? 18 : m.dynamicRangeDb;
    if (dr < 12) add('dense', clamp((12 - dr) / 8, 0, 1), dbv(dr), act('noSquash', null));
    if ((m.clipRatio || 0) > 0.002) {
      add('clipping', clamp(m.clipRatio * 40, 0, 1), pct(m.clipRatio * 100), act('headroom', null));
    }
    if (m.peakDb > -1) add('hotPeak', clamp((m.peakDb + 3) / 3, 0, 1), dbv(m.peakDb), act('ceiling', null));
    if (m.ispDb !== undefined && m.ispDb > m.peakDb + 0.1 && m.ispDb > -1) {
      add('truePeak', clamp((m.ispDb + 1) / 1.5, 0, 1), dbv(m.ispDb), act('truePeak', null));
    }
    const dcDb = m.dcOffsetDb === undefined ? -120 : m.dcOffsetDb;
    if (dcDb > -46) add('dcOffset', clamp((dcDb + 60) / 14, 0, 1), dbv(dcDb), act('dcGuard', null));
    if (m.dc && m.dc.driftDb > 12) {
      add('dcDrift', clamp(m.dc.driftDb / 30, 0, 1), dbv(m.dc.driftDb), act('dcGuard', null));
    }
    if (m.snrDb !== undefined && m.snrDb < 45) {
      add('noiseFloor', clamp((45 - m.snrDb) / 35, 0, 1), dbv(m.snrDb), act('expander', null));
    }
    if (D.percussive > 0.25 && p.glue !== undefined) {
      add('punch', D.percussive, dbv(m.crestDb || 0), act('glueTime', p.glueTime || 0));
    }

    out.sort((a, b) => b.sev - a.sev);
    const severe = out.filter((f) => f.sev >= 0.5).length;
    if (!out.length || out[0].sev < 0.2) {
      out.unshift({ key: 'clean', sev: 0, value: null, act: null });
    }
    return {
      findings: out,
      headline: { count: out.length, severe },
      // the material's character, in one word for the UI ("sustained" /
      // "percussive" / "dense"), from the same measurement the glue timing uses
      character: D.percussive > 0.55 ? 'percussive' : (dr < 12 ? 'dense' : 'sustained'),
    };
  }

  /**
   * Build the plain-language diagnosis shown on each file card.
   * @returns {{id:string, issues:string[], confidence:number}}
   */
  function diagnose(m) {
    const d = classify(m);
    const issues = [];
    const push = (key, weight) => issues.push({ key, weight });
    if (d.thin > 0.3) push('weakBass', d.thin);
    if (d.mud > 0.35) push('boxyMids', d.mud);
    if (d.dull > 0.3) push('dullTop', d.dull);
    if (d.analogNoise > 0.3) push('hiss', d.analogNoise);
    if (d.crackle > 0.15) push('crackle', d.crackle + 0.2);
    if (d.hum > 0.35) push('hum', d.hum);
    if (d.brick > 0.4) push('codec', d.brick);
    if (d.harsh > 0.35) push('harsh', d.harsh);
    if (m.clipRatio > 0.002) push('clipping', 0.6);
    if (m.dynamicRangeDb < 9) push('squashed', 0.5);
    if (m.correlation < 0.2 && m.channels > 1) push('narrow', 0.5);
    // the per-song findings are part of the sentence as well: they are the ones
    // a profile cannot know about
    const D = demand(m, d);
    if (D.sibNeed > 0.3) push('sibilance', D.sibNeed);
    if (D.infraNeed > 0.3) push('rumble', D.infraNeed);
    if (D.phaseNeed > 0.3) push('outOfPhase', D.phaseNeed);
    if (m.dcOffsetDb !== undefined && m.dcOffsetDb > -46) push('dc', 0.5);
    if (!issues.length) push('healthy', 1);
    issues.sort((a, b) => b.weight - a.weight);
    return { id: d.id, issues: issues.slice(0, 3).map((i) => i.key), confidence: d.confidence, scores: d.scores };
  }

  /** Resolve "auto" to the profile that was actually detected. */
  function resolve(presetId, metrics) {
    if (presetId && presetId !== 'auto' && PRESETS[presetId]) return presetId;
    return classify(metrics).id;
  }

  const API = { PRESETS, PRESET_ORDER, CEILING, MANUAL, PROFILE_EQ, classify, demand, adapt, resolve, buildParams, diagnose, recipe, eqCurve, curveDb, biquadDb, profileDb };
  global.RSPresets = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
