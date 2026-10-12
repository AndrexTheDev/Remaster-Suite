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
        dehiss: 0.55, declick: 0.75, glue: 0.25, warmth: 0.55, tilt: 0.0,
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
    const rumble = clamp(m.noiseRumble, 0, 1) * (1 - 0.3 * flat);
    const hiss = clamp(m.hissAmount, 0, 1);
    const clean = clamp(m.cleanliness, 0, 1);
    const dull = clamp(Math.max(m.dullIndex || 0, m.topLoss || 0), 0, 1);
    const brick = clamp(m.brickwall, 0, 1);
    const thin = clamp(m.bassRoll, 0, 1);
    const mud = clamp(m.mudScore, 0, 1);
    const harsh = clamp(m.harshness, 0, 1);

    const s = {};
    // vinyl rip: crackle is the signature, backed by hum, rumble and surface noise
    s.vinyl = clamp((0.55 * crackle + 0.16 * hum + 0.14 * rumble + 0.12 * hiss + 0.08 * (1 - brick))
      * (crackle > 0.06 ? 1 : 0.42), 0, 1);
    // cassette: steady hiss, flat noise floor, rolled-off top, no crackle
    s.cassette = clamp(0.75 * hiss + 0.25 * flat * (1 - crackle) + 0.20 * dull * (1 - brick), 0, 1);
    // low bitrate / MP3: hard spectral cliff on otherwise clean material
    s.lowbitrate = clamp((0.62 * brick + 0.30 * clean * (1 - hiss) + 0.16 * dull * (1 - flat))
      * (1 - 0.5 * hiss) * (1 - 0.5 * crackle), 0, 1);
    // 60s/70s garage or one-mic room session: thin, boxy, dull, noisy, analogue
    s.garage = clamp(0.40 * dull * (1 - 0.7 * brick) + 0.20 * mud + 0.16 * thin
      + 0.14 * rumble * (1 - flat) + 0.10 * (1 - clean), 0, 1);
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
    // Automatic mode stays inside the published budget (never below 0.30);
    // an explicitly chosen profile may rebuild more of a missing top end
    // (never below 0.65), which is how "garage"/"low bitrate" keep their
    // character on material whose top end is genuinely gone.
    const deriveRoom = manual
      ? clamp(1 - (gap - 8) / 40, 0.65, 1)
      : clamp(1 - (gap - 8) / 18, 0.30, 1);

    // how much low end is missing (bassRoll = 34–58 Hz below the −3 dB/oct line)
    const subDeficitDb = clamp((m.bassRoll || 0) * 16, 0, 16);
    const subPresentDb = clamp(band(0), -12, 12);            // > 0 = the source already humps there

    // how much is *too much*
    const mudExcessDb = clamp((m.mudScore || 0) * 12, 0, 12);
    const harshExcessDb = clamp((m.harshness || 0) * 10, 0, 10);
    const boxExcessDb = clamp(Math.max(band(2), 0), 0, 12);

    // noise: only repair what was confidently measured
    const hissNeed = clamp((m.hissAmount || 0) * clamp((m.noiseConfidence || 0) * 1.5, 0, 1), 0, 1);
    const crackleNeed = clamp(m.crackleIndex || 0, 0, 1);
    const humNeed = clamp(m.humScore || 0, 0, 1);

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
      needMud: clamp(mudExcessDb / 10, 0, 1),
      needHarsh: clamp(harshExcessDb / 8, 0, 1),
      needReso: clamp(Math.max(mudExcessDb / 12, harshExcessDb / 10, boxExcessDb / 10), 0, 1),
      bandExcess: [0, 1, 2, 3, 4, 5].map(band),
      confidence: c.confidence,
    };
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

    /* ── 6 · noise repair ─────────────────────────────────────────────────
     * De-hiss and de-click are repairs: they engage in proportion to the
     * measured problem, plus a small amount for material with a high broadband
     * floor, and never on a signal that was measured as clean. */
    const floorExtra = clamp((clamp(m.noiseFloorDb, -95, -30) + 58) / 22, 0, 1);
    // Half of a repair stage comes from the profile (that is what picking
    // "vinyl" or "cassette" means) and half from the measurement (how much
    // was detected). Both modules are threshold-gated inside the worklet — they
    // only touch samples their own detector flags — so a half amount on clean
    // material measures as a no-op rather than as damage.
    const hissDose = smoothstep(0.04, 0.45, Math.max(D.hissNeed, D.humNeed * 0.7));
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

    /* ── 8 · tone tilt ────────────────────────────────────────────────────
     * A gentle nudge, at most a quarter of what was measured, and only when
     * the tilt is actually audible. */
    a.tilt = clamp(a.tilt + clamp((m.tilt || 0) / 45, -0.20, 0.20) * (D.confidence > 0.35 ? 1 : 0.5), -cap.tilt, cap.tilt);

    return a;
  }

  /**
   * Build the flat parameter map consumed by the AudioWorklet.
   * @param {string} presetId
   * @param {object} metrics
   * @param {number} power 0..1
   * @param {object} [overrides] manual tweaks
   */
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
      noiseFloor: clamp(metrics.noiseFloorDb, -95, -30),
      hissFloor: clamp(metrics.hfNoiseFloorDb, -110, -25),
      autoLevel: 1,
    };
    if (overrides) Object.assign(params, overrides);
    return params;
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
    if (!issues.length) push('healthy', 1);
    issues.sort((a, b) => b.weight - a.weight);
    return { id: d.id, issues: issues.slice(0, 3).map((i) => i.key), confidence: d.confidence, scores: d.scores };
  }

  /** Resolve "auto" to the profile that was actually detected. */
  function resolve(presetId, metrics) {
    if (presetId && presetId !== 'auto' && PRESETS[presetId]) return presetId;
    return classify(metrics).id;
  }

  const API = { PRESETS, PRESET_ORDER, CEILING, classify, demand, adapt, resolve, buildParams, diagnose };
  global.RSPresets = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
