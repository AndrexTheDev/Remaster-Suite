/* =============================================================================
 * Remaster Suite — problem presets & adaptive auto-tuning
 * -----------------------------------------------------------------------------
 * A preset is a set of *anchor* values (the amount reached at 100 % restoration
 * power). The engine scales every anchor by the master "Restoration Power"
 * slider and refines it with the measurements taken from the actual file, so a
 * single slider produces a musically sensible result on any source material.
 * ========================================================================== */
(function (global) {
  'use strict';

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  /* Global calibration of the two synthesis engines.
   * Tuned against a naturally bright reference recording so that restored
   * material lands *near* a normal spectral balance instead of sounding
   * artificially bright: a half-repaired top end is worth more than a fake one.
   * (Measured: top-to-mid balance relative to a reference master.) */
  const SYNTH_CAL = 0.55;
  /** 0 below lo, 1 above hi, smooth in between (Hermite). */
  const smoothstep = (lo, hi, x) => {
    const t = clamp((x - lo) / (hi - lo || 1e-9), 0, 1);
    return t * t * (3 - 2 * t);
  };

  /* -------------------------------------------------------------------------
   * Anchors (100 % power)
   *   band0  low shelf    60 Hz
   *   band1  mud          200 Hz
   *   band2  boxiness     450 Hz
   *   band3  honk        1.3 kHz
   *   band4  presence    3.2 kHz
   *   band5  air shelf    7.0 kHz
   *   reso   dynamic de-resonating depth (0..1)
   *   sub    sub-harmonic synthesis amount (0..1)
   *   subRatio  sub frequency ratio (0.34 .. 0.66)
   *   exciter / air  harmonic regeneration amounts (0..1)
   *   dehiss / declick  restoration amounts (0..1)
   *   glue / warmth / tilt  finishing (0..1 / -1..1)
   * ---------------------------------------------------------------------- */
  const PRESETS = {
    auto: {
      id: 'auto',
      recommended: 0.72,
      anchors: {
        bands: [2.5, -3.0, -2.0, 0.5, 2.5, 2.8],
        reso: 0.45, sub: 0.40, subRatio: 0.5, exciter: 0.45, air: 0.45,
        dehiss: 0.45, declick: 0.20, glue: 0.30, warmth: 0.28, tilt: 0.0,
      },
    },
    garage: {
      id: 'garage',
      recommended: 0.85,
      anchors: {
        bands: [4.0, -5.0, -3.5, 1.0, 3.5, 4.0],
        reso: 0.65, sub: 0.70, subRatio: 0.5, exciter: 0.60, air: 0.50,
        dehiss: 0.50, declick: 0.20, glue: 0.35, warmth: 0.40, tilt: 0.05,
      },
    },
    vinyl: {
      id: 'vinyl',
      recommended: 0.70,
      anchors: {
        bands: [2.0, -3.5, -2.5, 0.5, 2.0, 2.5],
        reso: 0.40, sub: 0.45, subRatio: 0.5, exciter: 0.35, air: 0.35,
        dehiss: 0.55, declick: 0.75, glue: 0.25, warmth: 0.55, tilt: 0.0,
      },
    },
    cassette: {
      id: 'cassette',
      recommended: 0.68,
      anchors: {
        bands: [1.5, -2.5, -1.5, 0.0, 2.5, 3.0],
        reso: 0.35, sub: 0.40, subRatio: 0.5, exciter: 0.50, air: 0.55,
        dehiss: 0.90, declick: 0.20, glue: 0.30, warmth: 0.45, tilt: 0.0,
      },
    },
    lowbitrate: {
      id: 'lowbitrate',
      recommended: 0.75,
      anchors: {
        bands: [1.5, -2.0, -1.5, 0.5, 3.5, 3.5],
        reso: 0.30, sub: 0.45, subRatio: 0.5, exciter: 0.70, air: 0.75,
        dehiss: 0.30, declick: 0.10, glue: 0.30, warmth: 0.25, tilt: 0.05,
      },
    },
    general: {
      id: 'general',
      recommended: 0.65,
      anchors: {
        bands: [2.0, -2.5, -2.0, 0.0, 2.0, 2.2],
        reso: 0.40, sub: 0.40, subRatio: 0.5, exciter: 0.40, air: 0.40,
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
   * Refine a preset with measurements from the actual file.
   * @returns {object} a new anchors object
   */
  function adapt(anchors, m, diag) {
    const a = JSON.parse(JSON.stringify(anchors));
    const d = diag || classify(m);
    const nf = m.noiseFloorDb;

    // ── automatic corrective EQ: flatten narrow humps and fill shallow holes
    //    (max ±3.5 dB, and only half of what is measured — subtle by design)
    if (m.bandExcess && m.bandExcess.length === 6) {
      for (let i = 0; i < 6; i++) {
        const ex = clamp(m.bandExcess[i], -10, 10);
        a.bands[i] -= clamp(ex * 0.45, -3.5, 3.5);
      }
    }

    // ── low end: put back what is missing, never more than needed ───────────
    if (d.thin > 0.25) {
      a.bands[0] += 3.4 * d.thin;
      a.sub += 0.30 * d.thin;
    }
    if (m.correlation < 0.25) a.sub *= 0.7;              // keep wide material mono-safe
    a.sub = clamp(a.sub, 0, 0.95);

    // ── low mids / room mud ────────────────────────────────────────────────
    if (d.mud > 0.3) {
      a.bands[1] -= 2.8 * d.mud;
      a.bands[2] -= 2.2 * d.mud;
      a.reso += 0.18 * d.mud;
    }

    // ── top end: synthesis follows demand ──────────────────────────────────
    // Harmonic generation is only worth anything where something is missing, so
    // how much was measured as absent (dull top, codec cliff) scales the
    // exciter, the air synth and the 7 kHz shelf. Material that already has a
    // proper top end gets a fraction of the default — it needs no repair.
    const demand = clamp(Math.max(d.dull, d.brick, 0), 0, 1);
    const scaleTop = 0.34 + 0.72 * demand;
    a.air *= scaleTop;
    a.exciter *= 0.40 + 0.70 * demand;
    a.bands[5] *= 0.45 + 0.60 * demand;
    if (d.dull > 0.2) {
      a.air += 0.30 * d.dull * demand;
      a.exciter += 0.16 * d.dull;
      a.bands[5] += 2.0 * d.dull;
    }
    if (m.airiness > 0.7) {
      const extra = 1 - 0.5 * clamp((m.airiness - 0.7) / 0.3, 0, 1);
      a.air *= extra * extra;                 // already bright: back off harder
      a.exciter *= extra;
      a.bands[5] *= extra;
    }
    a.air = clamp(a.air * SYNTH_CAL, 0, 0.95);
    a.exciter = clamp(a.exciter * SYNTH_CAL, 0, 0.95);

    // ── harshness / ringing ────────────────────────────────────────────────
    if (d.harsh > 0.3) {
      a.reso += 0.22 * d.harsh;
      a.bands[4] -= 1.8 * d.harsh;
      a.bands[3] -= 0.9 * d.harsh;
    }
    a.reso = clamp(a.reso, 0, 0.95);

    // ── noise ──────────────────────────────────────────────────────────────
    if (d.analogNoise > 0.25) a.dehiss = Math.max(a.dehiss, 0.35 + 0.6 * d.analogNoise);
    if (nf > -58) a.dehiss = clamp(a.dehiss + 0.15 * clamp((nf + 58) / 22, 0, 1), 0, 1);
    if (d.hum > 0.4) a.dehiss = clamp(a.dehiss + 0.08, 0, 1);
    a.dehiss = clamp(a.dehiss, 0, 1);

    // ── crackle ────────────────────────────────────────────────────────────
    if (d.crackle > 0.1) a.declick = clamp(0.25 + 0.7 * d.crackle, 0, 0.95);

    // ── dynamics ───────────────────────────────────────────────────────────
    if (m.dynamicRangeDb < 12) a.glue *= 0.5;
    else if (m.dynamicRangeDb > 20) a.glue = clamp(a.glue + 0.1, 0, 0.55);
    a.glue = clamp(a.glue, 0, 0.6);

    // ── warmth: for material that still has room ───────────────────────────
    // Saturation adds density, so it belongs on sparse, dynamic recordings.
    // A modern, heavily limited master must not be squashed any further.
    if (m.crestDb > 18) a.warmth *= 0.7;                       // very sparse
    if (m.crestDb < 8 || m.clipRatio > 0.002) a.warmth *= 0.5; // dense or clipped
    if (m.dynamicRangeDb < 12) a.warmth = Math.min(a.warmth, 0.20);
    a.warmth = clamp(a.warmth, 0, 0.65);

    // ── tone balance tilt (brightness relative to a neutral recording) ─────
    a.tilt = clamp(a.tilt + clamp(m.tilt / 30, -0.25, 0.25), -0.4, 0.4);

    for (let i = 0; i < 6; i++) a.bands[i] = clamp(a.bands[i], -9, 9);
    return a;
  }

  /**
   * Build the flat parameter map consumed by the AudioWorklet.
   * @param {string} presetId
   * @param {object} metrics
   * @param {number} power 0..1
   * @param {object} [overrides] manual tweaks (from the "advanced" panel)
   */
  function buildParams(presetId, metrics, power, overrides) {
    const diag = classify(metrics);
    // "auto" is not a sound of its own: it resolves to whatever was detected
    const id = (presetId === 'auto' || !PRESETS[presetId]) ? diag.id : presetId;
    const base = PRESETS[id] || PRESETS.auto;
    const a = adapt(base.anchors, metrics, diag);
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

    const bands = a.bands.map((g) => g * p);
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

  const API = { PRESETS, PRESET_ORDER, classify, adapt, resolve, buildParams, diagnose };
  global.RSPresets = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
