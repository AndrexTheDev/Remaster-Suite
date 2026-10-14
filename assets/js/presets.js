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
    declip: 0.85,      // flat-top (clipping) reconstruction — a repair
    declick: 0.85,     // impulse repair
    glue: 0.35,        // glue compression
    warmth: 0.45,      // saturation
    tilt: 0.35,        // tone tilt
    // The three below are repairs, so they are allowed to work hard — but only
    // where something was measured: hum is notched by the measured mains level,
    // boxiness by the measured resonance, width by the measured image.
    hum: 0.85,         // mains notches (−36 dB at the fundamental at 0.85)
    // dB taken out of the strongest measured resonance. This was 3.5 — a third
    // of an octave of safety against a mis-placed notch — and it turned out to
    // be the binding constraint rather than the measurement: on a +12 dB Q-4
    // ring over a bed, the scan reports 5.5 dB of excess, and 3.5 dB of cut left
    // the ring half audible above the same bed (independent meter, every depth
    // from 0 to 9 dB). What a shallow cut was buying is now bought by the
    // *measurement*: the peak has to sit ≥ 3 dB above its own local trend, at
    // Q ≥ 3, inside 150–1800 Hz, and it is read from the quiet-frame spectrum —
    // sound that is there when the music is not.
    // …and the ceiling was 8 until a stronger ring showed what an open-loop
    // cap does at the top of its range. Measured on +18 and +21 dB Q-4 rings
    // over the same bed (the scan reports 8.5 and 10.0 dB, above anything the
    // card's own "boxy" scale saturates at): at 8 dB of cut the *export is still
    // diagnosed boxy* — the app's own scan reads 3.5 and 4.9 dB of excess at
    // 223 Hz on the file it just wrote — while 10 and 12 dB close both (scan
    // 0.0, no resonance listed). A wider notch is not the lever (Q 4 instead of
    // 6 moves the residue 0.87 → 0.60 dB and the scan *up* to 3.9), and the cost
    // of the deeper cut stays where the design wants it: over those rings the
    // notch's own third of an octave loses 5.2–6.2 dB and the two neighbouring
    // third-octaves move 1.0–1.4 dB. Rings the scan reports at ≤ 5.5 dB — which
    // is everything the acceptance fixture and the audit's own room fixture
    // write, and where 1.45 × the report is still ≤ 8 — are untouched by this.
    box: 12,
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
  const MANUAL = Object.assign({}, CEILING, {
    reso: 0.80, sub: 0.80, exciter: 0.70, air: 0.80,
    dehiss: 0.95, declip: 0.95, declick: 0.95, glue: 0.55, warmth: 0.65, tilt: 0.50,
    eq: 9,             // a profile the user picked may correct more of the shape
    // The repair ceilings are *inherited* rather than repeated: the mains
    // notches, the measured resonance, the stereo width and the air ceiling are
    // dosed by their measurement in both modes, and a manual profile spends more
    // of the colour and the synthesis, not of a repair. They have to be present
    // in this table at all, which they were not — `clamp(x, 0, undefined)`
    // returns x, and `undefined * n` is NaN, so the picked profiles silently ran
    // the resonance notch at 0 dB (on a fixture with a measured 5.5 dB ring) and
    // the width stage at NaN, i.e. off, while the hum ceiling was not applied
    // either. Measured with `RP.buildParams('vinyl', m, 0.7)` before the fix:
    // boxG1 = 0 at a frequency the scan had just reported.
  });

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
  /**
   * The score at which a profile is *named* in the diagnosis. Below it the
   * evidence is real but faint (every vinyl rip is a little boxy, every
   * cassette a little dull) and naming it would turn the sentence into a
   * shopping list. It still counts towards the tone — see TONE_MIN.
   */
  const CHAIN_MIN = 0.30;

  /**
   * The score at which a profile starts to colour the *tone* and the taste
   * amounts. Lower than CHAIN_MIN on purpose: a hint of garage in a vinyl rip is
   * still a hint, and below this line the number is noise.
   */
  const TONE_MIN = 0.12;

  /** The evidence each profile carries, in score order. */
  function evidence(diag) {
    const scores = (diag && diag.scores) || {};
    const list = [];
    for (const k of Object.keys(scores)) {
      // a band-limited source (telephone, dictaphone, a 32 kHz master) has no
      // profile of its own: what it needs is the top end rebuilt, which is the
      // low-bitrate profile's job — the same equation the label uses.
      const id = k === 'narrowband' ? 'lowbitrate' : k;
      const p = PRESETS[id];
      if (!p || !p.anchors) continue;
      const found = list.find((e) => e.id === id);
      if (found) found.w = Math.max(found.w, scores[k]);
      else list.push({ id, w: scores[k] });
    }
    return list.sort((a, b) => b.w - a.w);
  }

  /**
   * What this file is, in problems rather than in one label.
   *
   * Real files are rarely one thing: the most common record in a private
   * archive is a 1970s album, ripped from vinyl, then compressed to 128 kbit/s
   * by whoever put it online — crackle, a dull top end, surface noise and a
   * codec cliff, all at once. Picking the one profile with the highest score
   * and throwing the rest away is what makes such a file come out half
   * restored. The chain is the list of profiles that carry evidence, weighted
   * by how much evidence each one carries; a file with a single problem gets a
   * chain of one and behaves exactly as it always did.
   */
  function chainOf(scores, winner, confidence) {
    const list = [];
    for (const k of Object.keys(scores || {})) {
      // `narrowband` has no profile of its own — it is the *reason* a
      // band-limited file wants the low-bitrate profile's top-end rebuild — but
      // it is what the file is, so the chain (and the sentence) keeps the name.
      const id = k;
      if (scores[k] < CHAIN_MIN) continue;
      const found = list.find((c) => c.id === id);
      if (found) found.w = Math.max(found.w, scores[k]);
      else list.push({ id, w: scores[k] });
    }
    if (!list.some((c) => c.id === winner || (winner === 'lowbitrate' && c.id === 'narrowband'))) {
      list.push({ id: winner, w: Math.max(confidence, CHAIN_MIN) });
    }
    const sum = list.reduce((n, c) => n + c.w, 0) || 1;
    for (const c of list) c.w = c.w / sum;
    list.sort((a, b) => b.w - a.w);
    return list;
  }

  /** Stage budgets a profile is allowed to *unlock*: permission, not dose. */
  const CHAIN_PERMISSION = ['reso', 'sub', 'exciter', 'air', 'dehiss', 'declick'];
  /** Stages that are taste rather than repair: those are mixed, not unioned. */
  const CHAIN_TASTE = ['glue', 'warmth', 'tilt'];

  /**
   * The profile a file actually gets: one profile's anchors when it has one
   * problem, a *synthesis* of the profiles it has evidence for when it has
   * several.
   *
   * The rule is the one sentence that makes this safe: **a profile is a set of
   * permissions and one tone curve.** So
   *   · the tone bands are the weighted mix of the detected profiles' curves
   *     (a file that is 70 % vinyl and 30 % codec gets 70/30 of the two
   *     curves, not one of them);
   *   · a stage's *permission* is the union — the most any detected profile
   *     allows — because the amount that stage actually applies is still dosed
   *     from the measurement (`demand`), so a wider permission can only ever
   *     be used by evidence that is already there. This is what stops a codec
   *     cliff from being capped by the vinyl ceiling, or a hissy cassette from
   *     being capped by the vinyl one;
   *   · taste amounts (glue, warmth, tilt) are mixed like the tone, because
   *     nobody needs the *sum* of two personalities.
   */
  function mixAnchors(id, diag) {
    const base = PRESETS[id] || PRESETS.auto;
    if (!base.anchors) return base.anchors;
    const parts = evidence(diag)
      .filter((e) => e.w >= TONE_MIN)
      .map((e) => ({ id: e.id, w: e.w, a: (PRESETS[e.id] || base).anchors }));
    if (parts.length < 2) return base.anchors;
    const sum = parts.reduce((n, p) => n + p.w, 0) || 1;
    const out = {};
    // the tone is the mix of the curves, weighted by the evidence
    out.bands = [];
    for (let i = 0; i < 6; i++) out.bands[i] = parts.reduce((n, p) => n + p.w * (p.a.bands[i] || 0), 0) / sum;
    // a *permission* is not a dose: the profile that was detected keeps its own
    // (it is the diagnosis), and every other profile adds its permission in
    // proportion to how much evidence it carries — no cliff at a threshold, and
    // no faint reading unlocking a stage the file has not earned.
    for (const k of CHAIN_PERMISSION) {
      let v = base.anchors[k] || 0;
      for (const p of parts) {
        if (p.id === id) continue;
        v = Math.max(v, (p.a[k] || 0) * smoothstep(TONE_MIN, 0.40, p.w));
      }
      out[k] = v;
    }
    for (const k of CHAIN_TASTE) out[k] = parts.reduce((n, p) => n + p.w * (p.a[k] || 0), 0) / sum;
    out.subRatio = parts.reduce((n, p) => n + p.w * (p.a.subRatio || 0.5), 0) / sum;
    return out;
  }

  /**
   * Did a codec actually take something away?
   *
   * A hard spectral cliff is the signature of lossy encoding, and the
   * measurement finds it — but *where* the cliff sits decides whether there is
   * anything to repair. A 320 kbit/s MP3 cuts at about 20 kHz, i.e. above what
   * a listener hears: the label "low bitrate" there is not a finding, it is the
   * edge of the analysis band. Measured on one programme encoded at 96, 128,
   * 192, 256 and 320 kbit/s, every one of them reported a cliff between 19.2
   * and 19.5 kHz, and the app called all five "low bitrate" — including, most
   * visibly, the 320 kbit/s file the *export* had just written, which made
   * re-uploading an export look like a defect that had been there all along.
   *
   * Below this point the loss is real and the chain that rebuilds the top
   * octave is the right answer; above it there is nothing missing to rebuild.
   */
  function codecLoss(m) {
    // Two ways a lossy stage can have removed something audible, and the
    // difference between them is *where* the wall is:
    //
    //  · a measured cliff inside the top octave (4–17 kHz) is a codec's
    //    signature, whatever the programme around it sounds like. A 128 kbit/s
    //    MP3 cuts at ~14.5 kHz and this fires on it;
    //  · a bandwidth ceiling below 17 kHz *can* be the same thing, but it can
    //    just as well be a dull programme — an old transfer that stops at 8 kHz
    //    because that is all the medium had. That one is named by its own card
    //    ("dull top end") and its treatment is the same air synthesis, so the
    //    codec name is only used when the file's own dullness does *not*
    //    explain the ceiling. `min(hfCutoff, cliffHz)` alone got this wrong in
    //    both directions: it called every dull record that had ever been
    //    encoded a low-bitrate file — including this app's own 320 kbit/s
    //    export, which was the complaint that started the round — while a wall
    //    at 7.5 kHz (below the old cliff search's floor) was invisible.
    // …and both branches ask for the *size* of what they found, not just its
    // location. Measured, that distinction is the whole difference between the
    // app naming its own export and staying quiet about it:
    //
    //   · branch 1 — the cliff the search reports must be a cliff. The search
    //     returns the window with the largest drop anywhere in 4–19.5 kHz, and a
    //     smooth −12 dB/octave programme still has a largest window (measured: a
    //     bright pink bed 6.1 kHz @ 2.4 dB, a cassette sim 5.1 kHz @ 2.6, a
    //     vinyl sim 15.1 kHz @ 4.6). `brickwall` is that drop measured on the
    //     same definition a codec wall is measured with (9 dB); requiring it
    //     keeps every measured codec (its cliffDb is 42–74 dB) and drops the
    //     slope-only cases;
    //   · branch 2 — a bandwidth ceiling is a codec's only when the spectrum
    //     *falls off a cliff at it*: measured, the fall over the 1.6 kHz above
    //     the ceiling is 39–55 dB for a real encoder wall (96 kbit/s: 52.2,
    //     128: 39.4) against 10–20 dB for a medium's slope and 24.6 dB for the
    //     app's own 320 export after its de-hisser took the hiss out of the top
    //     octave. The threshold sits at 32 dB, inside that gap.
    //   One boundary of this rule, measured and left as it is: the fall is
    //   measured into the file's *own* floor, so a file with a digital-silence
    //   floor (a synthetic bed, a file whose noise was already removed) and a
    //   low-pass reads as a wall — the acceptance suite's own harsh fixture, a
    //   pink bed low-passed at 9 kHz with no noise at all, keeps its "codec"
    //   line for exactly that reason, and it did before this rule too. On real
    //   material the floor is what makes the two populations separable, and a
    //   file with nothing above 14 kHz and nothing below it either *was*
    //   band-limited by something.
    const brickwall = clamp(m.brickwall || 0, 0, 1);
    const cliff = m.cliffHz || 0;
    if (cliff > 0 && cliff < 17000 && brickwall > 0) return true;
    const cut = m.hfCutoff || 0;
    const dull = clamp(Math.max(m.dullIndex || 0, m.topLoss || 0), 0, 1);
    return cut > 0 && cut < 17000 && dull < 0.6 && (m.cutDropDb || 0) >= 32;
  }

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
    // …and the brickwall only counts where it is a *codec* wall (see
    // codecLoss): the score itself is honest — there is a wall, and it drops
    // 12 dB over 1.6 kHz — but a wall at 19 kHz took away nothing anybody
    // hears, and a wall is where streaming services, codecs and this app's own
    // export put one. Gating the *interpretation* is what keeps a 320 kbit/s
    // re-upload out of the low-bitrate profile.
    const brick = codecLoss(m) ? clamp(m.brickwall, 0, 1) : 0;
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
    // low bitrate / MP3: a hard spectral cliff. The cliff itself is *measured*,
    // so it counts in full; the two circumstantial terms (clean material, a
    // dull top end) are what the hiss/crackle discounts are for — a noisy file
    // can look dull for other reasons, but it cannot fake a brick wall. Without
    // this split, the most common record in a private archive — an old vinyl
    // rip that was later pushed through a 128 kbit/s encoder — lost its codec
    // treatment exactly because it was also hissy and crackly.
    // …and the cliff has to be *inside* the audible top octave to count (see
    // `codecLoss`): a cliff at 20 kHz is the analysis band edge, not a bitrate.
    s.lowbitrate = clamp((0.62 * brick
      + (0.30 * clean * (1 - hiss) + 0.16 * dull * (1 - flat)) * (1 - 0.5 * hiss) * (1 - 0.5 * crackle))
      * (codecLoss(m) ? 1 : 0), 0, 1);
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
    const id = top < 0.40 ? 'general' : best;
    return {
      id,
      chain: chainOf(s, id === 'general' ? 'general' : id, top),
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
    /* …and the *cliff* is only a loss when it is inside the audible top. The
     * file's own test for that already exists — `codecLoss` is what decides
     * whether a cliff is evidence of a bitrate at all, and it asks whether the
     * content ends below 17 kHz. The deficit has to ask the same question,
     * because a wall is not a bitrate: 96–320 kbit/s all put the encoder's
     * anti-alias filter at 19.1–19.4 kHz and remove *nothing* (measured: every
     * band 4–16 kHz within 0.4 dB). Pricing that wall at the full 12 dB is how
     * a healthy modern master — 320 kbit/s, topLoss 0.00, dullIndex 0.00 —
     * came out of the chain +1.4 dB bright in 8–16 kHz, and how the harness's
     * own low-bitrate sims (synthetic walls at 17.7/18.8 kHz, topLoss 0.25 and
     * 0.09) got 10–12 dB of demand out of the wall alone. What is *genuinely*
     * missing is measured either way, by `topLoss` and `dullIndex`, and those
     * carry the demand for such a file on their own; the wall adds nothing to
     * it. Below 17 kHz — a cliff that cut the band an "s" lives in — the wall
     * is priced in full, exactly as before.
     */
    const cliffPrices = codecLoss(m) ? 1 : 0;
    const codecDeficitDb = clamp((m.brickwall || 0) * 12 * cliffPrices, 0, 12);
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
    /**
     * …and where the *hole* is, which decides which tool may fill it.
     *
     * A wall at 15.5 kHz removed 15.5–20 kHz; the 7 kHz shelf boosts 7–15 kHz.
     * On this app's own codec fixture the law asked for +2.4 dB there — a band
     * the encoder had *not* touched, and the band a sibilant "s" lives in — so
     * the app's export came back diagnosed as `sibilance` (5–9 kHz measured
     * +2.5 dB over its own trend, against +0.2 on the input). The restoration
     * at 15 kHz and up is real and must stay; it just belongs to the
     * synthesiser, which works above 8.2 kHz from whatever survived just below
     * the cliff, not to a shelf that reaches down through the "s".
     */
    /**
     * …and *which instrument* may fill the hole, which is decided by where the
     * hole is. Measured with the toolkit's encoder on the acceptance bed (the
     * decode against the pre-encode original, per band):
     *
     *   32 kbit/s · cliff  7254 Hz   6 kHz −1.4   8 kHz −3.1  12 kHz −6.7
     *   48 kbit/s · cliff 10254 Hz   8 kHz −0.3  10 kHz −1.2  12 kHz −2.5
     *   64 kbit/s · cliff 15533 Hz   8 kHz +0.2  12 kHz +0.2  14 kHz −0.1  16 kHz −0.8
     *
     * A wall at 7–10 kHz cut the band a 7 kHz shelf lifts: the shelf is the
     * right instrument and stays. A wall at 15.5 kHz cut *nothing* below 14 kHz,
     * so a shelf there is not restoring anything — it is a 2.4 dB lift across
     * 7–15 kHz, the band an "s" lives in, and this app's own export then came
     * back from a re-upload diagnosed `sibilance` (5–9 kHz measured +2.5 dB over
     * the file's own trend against +0.2 on the input). Above 9.5–12 kHz the
     * shelf stands down and the synthesiser — whose output starts at 8.2 kHz and
     * is derived from the band that survived just below the cliff — does the
     * restoration on its own.
     */
    const wallAboveSib = clamp(m.brickwall || 0, 0, 1) * smoothstep(9500, 12000, m.cliffHz || 0);
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
    /* …and whether there is anything *down there* to work from. The
     * sub-harmonic synthesiser tracks the fundamental through a low pass — it
     * has to, or it would double a record's second harmonic instead of its
     * fundamental — so on a file whose bottom octave is empty it has no source
     * at all. Measured on a file high-passed at 200 Hz (`subHoleDb` −25.6): the
     * synthesiser stayed silent (34–58 Hz −96.7 → −95.9 dBFS) while the tone
     * curve's 60 Hz shelf wrote 3.5 dB into the same empty band and the
     * corrective EQ cut the low mids by 2.5–3.4 dB — the region that carries
     * that recording's bass came out 2.4 dB *further* below 300–900 than the
     * untouched file. A hole (below −12 dB) is not a balance: nothing is dosed
     * into the empty band, the synthesiser looks where the content actually
     * starts, and the low-mid cuts stand down. */
    const subHole = m.subHoleDb === undefined ? 1 : smoothstep(-26, -12, m.subHoleDb);

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

    /* ── clipping (flat tops) ──────────────────────────────────────────────
     * Two independent numbers have to agree before a file is called clipped
     * (see the analyser's flat-top pass): how much of it sits in flat runs at
     * its *own peak level*, and how much peak those runs imply was cut off.
     * Either one alone is wrong — a loud sine that was never clipped has a lot
     * of the first and 0.07 dB of the second (measured), and a single stray
     * pair of equal samples has the second and none of the first. The dose is
     * a repair, so it is gated, never scaled to taste: below 0.002 % of flat
     * samples at the peak level there is nothing to reconstruct. */
    const clipShare = clamp(m.clipFlatRatio || 0, 0, 1);
    const clipImplied = clamp(m.clipOvershootDb || 0, 0, 6);
    const clipNeed = smoothstep(0.00002, 0.0008, clipShare) * smoothstep(0.7, 1.6, clipImplied);

    /* ── the six per-song decisions ────────────────────────────────────────
     * Everything above is a *problem* the profile then treats. Everything below
     * is a property of this one file — a rumble it has, a sibilance it has, an
     * out-of-phase bottom, an amount of percussive movement, and where its
     * noise actually starts — that no profile could know about. */
    const conf = clamp((m.noiseConfidence || 0) * 1.5, 0, 1);

    // Sibilance: the 5–9 kHz band above the trend the file's own mids predict.
    // 2.5 dB is the dead zone (that is an "s" being present), 8 dB is a
    // problem; a de-esser is a *repair*, so it needs evidence, not a hunch.
    // Sibilance arrives in bursts: a singer's "s" occupies a few percent of the
    // file, so a statistic averaged over the whole song barely moves for the
    // defect it is supposed to find. Two measurements answer it now: the old
    // median-based `sibExcessDb` (the right question for a top end that is
    // *uniformly* too hot) and `sibPeakDb`, the per-frame scan of how far the
    // loudest 5–9 kHz moments sit above the file's own typical balance — which
    // is the right question for intermittent sibilance. Measured: clean
    // recordings read 0.7–1.0 dB on the scan, a vocal with 120 ms "s" bursts
    // 8 dB above its trend reads 2.2–4.9. Without it the de-esser never
    // engaged on such a file (dose 0.00) and the only defect in the acceptance
    // matrix that went unrepaired was this one.
    /* …and only the *scan* may arm the stage, because the stage is a burst
     * detector too: 10 ms windows, 140 ms hold, ducking the 7 kHz band while a
     * burst lasts. The median statistic cannot arm it — a steady tilt raises the
     * 5–9 kHz band and the trend above it by the same amount, and the de-esser
     * has nothing to duck because nothing is a burst. This app's own top-end
     * shelf is exactly such a steady tilt: a 64 kbit/s file came back from its
     * own 320 kbit/s export with `sibExcessDb` 0.23 → 1.66 and `sibPeakDb`
     * 0.95 → 1.06 (the bursts are untouched, as they should be), and under a
     * manual profile — which lifts the same shelf harder — the export was then
     * diagnosed `sibilance` and the chain ducked the band it had just lifted:
     * the de-esser armed by its own tone stage. A *clearly measured* tilt
     * (≥ 2 dB) may still add to the dose, up to the size of the correction
     * itself, so a file that is both bursty and uniformly bright is treated
     * harder; it can never *become* the evidence. */
    /* …and the bonus may only scale a *proven burst*. The paragraph above says
     * the median statistic can never become the evidence, and it could: a
     * sustained cymbal wash (an acceptance fixture — a bright wash over a quiet
     * bed) reads `sibExcessDb` +5.07 with a scan of 0.00, and at 2 × 0.58 that
     * was 1.16 dB of `sibDb` — enough, on a slightly brighter file, to name
     * `sibilance` and duck the top end of material whose only property is that
     * it is made of cymbals. The bonus now needs the scan to be past its own
     * dead zone: below 2.5 dB the file is not a burst file, and the median term
     * has nothing to amplify (measured: the wash 0.00, the +6 dB codec tilt in
     * the audit suite 0.86, both below the window; the acceptance "s" fixture
     * 5.63, above it). */
    const bursty = smoothstep(2.5, 5, m.sibPeakDb || 0);
    /* …and a file the scan calls *sustained* (its median frame is already narrow
     * and 7 kHz-heavy — a singer whose "s" never stops) may use the median
     * statistic as evidence without the burst gate, because the case the gate
     * protects against is exactly the one the scan's shape test now rejects: a
     * wash. Measured, scan + excess → `sibDb` (probe `tools/work/sib6.js`):
     * the audit's continuous sibilant 1.98 + 1.33 = 3.31 (de-esser 0.51, and
     * 0.07 without the flag), the acceptance wash 0.00 + 0.00, the +6 dB codec
     * tilt 0.86 + 0.00. */
    const sibDb = clamp((m.sibPeakDb || 0)
      + 2 * smoothstep(2, 8, m.sibExcessDb || 0) * (m.sibSustained ? 1 : bursty), 0, 16);
    // Threshold and slope are its own: the per-frame scan reads 0.7–1.0 dB on a
    // clean recording and 2.2–4.9 dB on one with real "s" bursts, so the window
    // starts above the noise and reaches full correction inside the range the
    // defect actually occupies.
    const sibNeed = smoothstep(1.4, 4.2, sibDb);

    // Sub-sonic rumble, measured where only rumble can be: in the quiet
    // passages. Two guards, because this is the one measurement a *clean*
    // recording can trip by accident:
    //   · the noise confidence — on material with no quiet passage at all, the
    //     "quiet" frames are really the music, and there is nothing to measure;
    //   · the mains score — a 50/60 Hz line leaks into the band *below* it at
    //     any sane FFT resolution, and a hum is a notch, not a reason to take
    //     the bottom off the record.
    // The knee sits where the panel in `infraExcessDb` says the two populations
    // separate. Clean material — a flat bed, the same bed with +6 and +10 dB
    // shelves below 150 Hz, a plain vinyl sim, the garage sim whose bed is
    // high-passed at 150 Hz — reads 1.0, 2.2, 3.2, −11.8 and −24.2 dB. Material
    // with real below-45 Hz energy reads 6.4 (the acceptance rumble fixture),
    // 15.2 (the worn fixture with a rumble under it) and 16.0 (rumble alone).
    // The knee therefore opens just above the loudest clean reading.
    const infraDb = clamp(m.infraExcessDb || 0, 0, 26);
    const infraNeed = smoothstep(4.5, 11, infraDb) * smoothstep(0.12, 0.45, conf)
      * (1 - 0.5 * clamp(m.humScore || 0, 0, 1));
    /* What this cannot do, measured, because the guard is a cascade of four
     * 2-pole high passes at its corner and it *costs* something: a sustained
     * music note in the bottom end. On one bed with a rumble ladder and a
     * club-style 35 Hz note (all measured through the chain, bands from the
     * app's own statistic unless said otherwise):
     *
     *   rumble at 0 dB rel.   8-20 Hz 54.9 → 26.1 · 20-35 54.8 → 45.8 · music 30-45 -3.2 dB
     *   the same bed with a sustained 35 Hz note (the club control, re-measured
     *   for the two-rung law): the statistic reads 14.7 dB of "excess" — above
     *   the knee — and the 18-24 Hz rung costs the note 3.4 dB where the
     *   saturated 42 Hz rung costs it 19.1 dB. The note never reaches the rung
     *   unforced: the confidence gate gives that fixture 0 Hz, because a
     *   passage with the note in it is not a quiet passage.
     *
     * Three candidate witnesses that would tell the two apart were measured and
     * each fails, so do not re-derive them:
     *   · level — the quiet passage's 20-45 Hz against the level the music
     *     reaches (loud 90-203): monotone in rumble level, and the 35 Hz note
     *     reads -10.2 where a full-scale rumble reads -21.6. The note is
     *     *louder* than the rumble;
     *   · stationarity — loud frames against quiet frames: note 6.8 vs 10.8,
     *     rumble 10.1 vs 16.3. Both negative, 3 dB apart;
     *   · tonality — the peakiness of the quiet frames' 20-45 Hz band over six
     *     narrow probes: a full-scale rumble 5.3 dB, the note 7.1 dB. 1.8 dB.
     * A sustained sub-bass note and a turntable floor are the same thing to
     * every measurement the app owns; what keeps the note out of the repair is
     * the *confidence* gate, not its shape. Where the gate does open, the cost
     * is the price of the repair on a file whose quiet floor is the defect —
     * measured this round: the club note 3.4 dB at the low rung, 19.1 dB at the
     * saturated one. The arm threshold stays where the clean population says it
     * separates (measured: the club note reads 14.7 dB of "excess" where the
     * acceptance §4 bed alone reads -6.4 and a musical bass fixture — a kick
     * plus a 41-82 Hz line — 3.8), rather than being raised until no music can
     * ever trip it. The corner's second rung is documented at 9a below. */

    // An out-of-phase bottom: the channels agree in the mids but the bottom of
    // one channel is *inverted*, so it cancels below 200 Hz. Only stereo
    // material can have it, and only when there is real side energy down there
    // to cancel in the first place. The frontier is between a *cancelling* and a
    // merely *decorrelated* bottom, and it is drawn on the negative side because
    // zero is not the defect: measured, the audit's inverted-bass fixture reads
    // −0.82 in the low band and the acceptance §16 fixture (one channel's bottom
    // inverted by 1.9×) −0.49, while two independent pink noises — a legitimately
    // *wide* stereo image, i.e. the thing that must not be repaired — read +0.06
    // and were treated as full need by the old curve, which put the truth at
    // +0.55 and the defect's *absence* at +0.05. The mono-maker was therefore
    // folding the bottom of well-made wide mixes: on the engine's own
    // stereo-integrity fixture the old curve moved the file's correlation
    // 0.03 → 0.32, past the ±0.25 the suite allows — and the suite is right to
    // allow no more. Need now reaches full only where a cancellation does
    // (≤ −0.35) and is zero at +0.05: the same wide fixture reads 0.03 → 0.03
    // (Δ 0.00) and is not named, a mild cancellation (0.35×) reads +0.97 and is
    // left alone, and both inverted fixtures above still ask for the stage in
    // full (bassMono 1.00).
    const st = m.stereo || {};
    const lowRho = (m.channels > 1 && isFinite(st.low)) ? st.low : 1;
    const widenGuard = m.channels > 1 && isFinite(st.mid) ? 1 : 0;
    const phaseNeed = widenGuard * smoothstep(0.05, -0.35, lowRho);

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

    /* Scale freedom: the doses below are *not* gain-free, and must not be — they
     * are the compensation for the absolute thresholds inside the worklet. Every
     * parameter that carries the level in dBFS (refDb, hissFloor, noiseFloor,
     * declipLevel) moves by exactly the gain of the input, so a compressor
     * threshold or a hiss floor lands on the same point of the signal whether the
     * transfer arrived at −3 or at −40 dBFS, and the two halves cancel: the card,
     * the issue list, the chain's action per band and the delivered defect
     * statistic are the same at every input level. A new parameter that reads a
     * level has to carry it the same way, or the chain stops being scale-free —
     * the audit row `scale freedom` and the probes tools/work/dc10.js … dc18.js
     * are what say so, and the row re-measures the lot at 0 and −12 dB. */

    return {
      topDeficitDb, codecDeficitDb, airDeficitDb, subDeficitDb, subPresentDb, subHole, wallAboveSib,
      mudExcessDb, harshExcessDb, boxExcessDb,
      hissNeed, crackleNeed, clipNeed, clipShare, clipImplied, humNeed, headroom, dense,
      // normalised needs (0..1) used by the doses
      needTop: clamp(topDeficitDb / 18, 0, 1),
      needAir: clamp(Math.max(airDeficitDb / 20, (m.brickwall || 0) * 0.9 * cliffPrices), 0, 1),
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
    // …and with the bottom octave *empty* (see subHoleDb) the trend these bands
    // are measured against has been dragged down by the hole itself: the
    // 200–500 Hz region that then measures as a hump is where this recording's
    // bass actually lives. Measured on a file high-passed at 200 Hz, taking that
    // "hump" down by 2.5 dB at 200 Hz and 3.4 dB at 450 Hz put the 60–200 Hz
    // region 2.4 dB further below the 300–900 Hz band than the untouched file.
    const subHole = m.subHoleDb === undefined ? 1 : smoothstep(-26, -12, m.subHoleDb);

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
        if (m.brickwall > 0.25 && codecLoss(m) && f > m.cliffHz * 1.0) g = Math.min(g, 0.8);
      } else if (g < 0 && f <= 320 && subHole < 0.5) {
        g = 0;                                         // a hole is not a balance
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
      D.needAir * (1 - D.wallAboveSib),                // 7 kHz shelf  (lift)
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
      // The top band's *lift* stands down where the wall is above the "s" band
      // (see wallAboveSib — a shelf cannot fill a hole an octave above itself);
      // its *cut* stays: that is the repair.
      let adj = clamp(beyond * 0.4, -2.5, 2.5);
      if (i === 5 && adj < 0) adj *= (1 - D.wallAboveSib);
      a.bands[i] -= adj;
    }

    // extra shaping where the measurement was emphatic
    a.bands[0] += 1.6 * D.needSub * D.subHole;
    a.bands[3] -= 0.7 * D.needHarsh;
    a.bands[4] -= 1.2 * D.needHarsh;
    a.bands[5] += 1.0 * D.needAir * (1 - D.wallAboveSib);

    for (let i = 0; i < 6; i++) a.bands[i] = clamp(a.bands[i], -bandCap, bandCap);

    /* ── 3 · dynamic de-resonating ────────────────────────────────────────
     * Room ring and boxiness: dosed by how boxy/harsh the material measured. */
    a.reso = a.reso * smoothstep(0.05, 0.55, D.needReso);

    /* ── 4 · sub-bass synthesis ───────────────────────────────────────────
     * Only what is missing: a recording whose bottom octave is intact gets
     * nothing at all (the old law added it because the profile said so, which
     * is exactly what made cassette and vinyl rips sound pumped up). */
    a.sub = a.sub * smoothstep(0.15, 0.60, D.needSub);
    /* …and it looks where the content actually starts. Its analysis band is a
     * 95 Hz low pass by design — a record's fundamental is what lives down
     * there, and looking higher would double the second harmonic instead — but
     * on a file whose bottom octave is *empty* there is nothing to track at
     * 95 Hz: measured on a file high-passed at 200 Hz, the synthesiser stayed
     * silent (34–58 Hz −96.7 → −95.9 dBFS) while the tone curve wrote into the
     * same empty band. With a hole measured, the corner moves up to where the
     * bass band is, so the octave it derives is one the recording can actually
     * carry. Measured on the acceptance weak-bass fixture with the corner at
     * 240 Hz: the tracker locks onto ~150 Hz (the strongest periodicity left in
     * that band), so the derived octave lands at 75 Hz — the 34–58 Hz band
     * reads −96.7 → **−85.6 dBFS**, i.e. 11 dB out of digital silence, and the
     * 60–200 Hz band moves 0.7 dB. The stage is dosed as a *sub*: it sits under
     * the band it was derived from (SUB_CAP 0.70 × dose × drive ≈ −14 dB
     * relative to it), which is why the band the row measures moves less than
     * the band the repair works in. */
    a.subSrc = 95 + 145 * (1 - D.subHole);
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
    // …and only when the analyser found top-end noise to subtract at all. The
    // tilt step is that evidence: without it the worklet has no cap for the
    // tilt key and falls back to the level key, which on a *stationary* top end
    // cannot tell hiss from programme. Measured on a clean dull pink bed (a
    // synthesizer-pad-like file, tilt step 0.04 dB) the profile's half dose took
    // 4.3 dB off the 9–13 kHz band — a false positive, and the reason the
    // intensity slider stopped being monotone: the repair fought the air
    // synthesis that comes two stages later. A profile scales a measured
    // repair; it does not invent one.
    const hissEvidence = (m.hissTiltStepDb || 0) > 1.0;
    a.dehiss = hissEvidence
      ? clamp(a.dehiss * (0.5 + 0.5 * hissDose) + 0.25 * floorExtra * D.hissNeed, 0, cap.dehiss)
      : 0;
    // …and here the evidence has to be able to *overrule* the profile, because
    // the profile is about the material and the measurement is about the defect.
    // Measured: a drum recording with 9 pops/s was named `crackle` by the card
    // (index 1.00) and then dosed 0.17 by the `garage` anchor — every pop stayed
    // exactly where it was (index 1.00 → 1.00), a repair the app promised and
    // did not make. A clean recording reads 0.02–0.13 on the same statistic, a
    // worn one 0.99; from 0.55 up the anchor's modesty is overridden as far as
    // the profile's own repair budget, and below 0.40 the dose stays the
    // anchor's (scaled, as before, by how sure the reading is).
    const crk = smoothstep(0.10, 0.55, D.crackleNeed);
    a.declick = clamp(Math.max(a.declick * (0.5 + 0.5 * smoothstep(0.03, 0.40, D.crackleNeed)), cap.declick * 0.55 * crk), 0, cap.declick);
    // The de-clipper is the same kind of stage — it only touches the samples
    // its own detector flags as flat tops at the file's peak level — so the
    // dose is the evidence, mapped onto the profile's repair budget.
    // …and like every repair here, it runs on *evidence*. The floor is not
    // cosmetic: the chain's own soft-clip guard leaves a few flat samples at the
    // rail in its output, so a processed file measured again reports a flat-share
    // of about 2e-5 — two flat tops per hundred thousand samples, which is the
    // guard's residue and not damage. With the dose scaled from zero that reading
    // was enough to switch the stage on at half strength on a *re-upload*, i.e.
    // the app was de-clipping its own output. Below the floor the stage stays off.
    a.declip = D.clipNeed > 0.15 ? clamp(cap.declip * (0.5 + 0.5 * D.clipNeed), 0, cap.declip) : 0;
    // …and the level the detector keys on is this file's measured plateau
    a.declipLevel = num(m.clipLevelDb, -0.1);

    /* ── 6b · the export ceiling ───────────────────────────────────────────────
     * Every streaming target is a *true-peak* target, and the numbers are not
     * negotiable: −1 dBTP, or −2 dBTP when the master is louder than −14 LUFS
     * (a hot master is the one that gets transcoded hard, so it is the one that
     * needs more room). The app measures the file's own true peak — `ispDb` —
     * so this is a decision the measurement can make on its own: what the file
     * arrives with decides which ceiling the limiter is set to. A file that is
     * already under it pays nothing for the stage (it is bit-transparent below
     * the ceiling); a file that is over it finally stops arriving at the
     * encoder overdriven. */
    const loud = (m.loudness === undefined ? -70 : m.loudness) > -14;
    a.tpCeil = loud ? -2 : -1;

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
      // The scan reports a *narrow peak* against its local trend — that is how
      // it finds a resonance at all — while the ring it names is wider than that
      // peak, and the Q it reports under-reads the width too (a +12 dB Q-4 ring
      // comes back as Q 6). Measured against an independent meter on that
      // fixture, the ring only reaches the bed's own level at ≈ 1.5× the
      // reported excess, and the sibling bands 110 and 440 Hz move by 0.3 dB
      // across the whole 0…9 dB range: the notch stays a third of an octave, so
      // the depth, not the width, is what has to match the measurement.
      const depth = Math.min(cap.box, 1.45 * r.excessDb) * dose;
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

    // 9a · sub-sonic rumble → a high-pass at the measured corner, on two rungs.
    // What this cannot do is a rumble *above* the corner: a turntable's bottom
    // end reaches into the 30–80 Hz where the bass lives, and a high-pass that
    // takes it out takes the music's bottom with it — measured, a 30 Hz corner
    // costs a sustained 35 Hz note 7.6 dB and a 24 Hz corner 3.4 dB (the audit's
    // "what the sub-sonic guard cannot do" holds those numbers). The rumble
    // statistic is a radio below 45 Hz, so it only ever arms this stage where the
    // music has nothing anyway; a rumble on top of the bass is left in place and
    // named on the card rather than half-removed by a filter that cannot tell it
    // from the bass.
    //
    // The corner *is* the amount: 18 Hz at the arm threshold, +6 Hz per unit of
    // need — and a second rung above need 0.55 that reaches 42 Hz, the top of the
    // 20–45 Hz band the statistic calls rumble. The rung exists because the low
    // rung cannot deliver the repair on the floors that are *saturated*, measured
    // on the acceptance §4 fixture (excess 15.5 dB, need 1.0): 18–24 Hz took it
    // to 10.6 dB and left its quiet 20–45 Hz band 22.4 dB above the mids, i.e.
    // exactly where it was; 42 Hz takes the statistic under the knee at 3.7 dB
    // and that band to 7.2 dB. It is the 4-section depth and not the corner that
    // spends the removal — 2 sections at the same 42 Hz leave 10.8 dB. The rung
    // is not free, and its price is bounded by measurement: 42 Hz costs a
    // sustained 35 Hz note 19.1 dB where the low rung costs it 3.4, and a 41.2 Hz
    // line about 12 dB (between the sweep's 38 Hz / −9.3 dB and 45 Hz / −14.8 dB
    // points). It is paid only where the *quiet passages* carry that band 8 dB or
    // more above the file's own mids — energy no music is playing there — and the
    // fixtures that stay out of it are pinned by the suites: the audit's rumbly
    // bed sits exactly on the rung's onset (8.0 dB → 21.3 Hz, unchanged), §17's
    // worn record reads need 0.27 (19.6 Hz, unchanged), a bed with a sustained
    // 35 Hz note never reaches the rung at all (the confidence gate: the unforced
    // law measures 0 Hz on it), and a musical bass fixture reads 3.8 dB of
    // "excess" and gets no guard.
    a.infraHP = D.infraNeed > 0.02
      ? clamp(18 + 6 * D.infraNeed + 18 * smoothstep(0.55, 1, D.infraNeed), 0, 42)
      : 0;

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
    humHz: 50, boxF1: 120, boxF2: 240, boxQ1: 3, boxQ2: 3, refDb: 0,
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
    // A hand-picked profile is a decision, not a diagnosis: it is used as it
    // is. The automatic mode synthesises the profile from every problem the
    // file was found to have (see mixAnchors).
    const a = adapt(manual ? base.anchors : mixAnchors(id, diag), metrics, diag, { manual });
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
    /* The de-hisser's amount is a *measurement*, not a taste: the law already
     * hands it the tilt step it found (capped by the card) and zero when the
     * evidence is not there, so the intensity curve was scaling a number that
     * has nothing to do with intensity — 0.830 of it at the default p = 0.7.
     * It follows the `fix` policy the hum notch and the measured resonance
     * notches already follow (see the assembly below), measured on the acceptance
     * hiss fixture: in the frames the noise owns the band came down 7.69 →
     * **8.79 dB** and the tilt step the card prints 10.18 → **8.39 dB**, against
     * 0.13 → 0.20 dB on the frames the music owns; both clean-bed fixtures still
     * measure a tilt step under 0.25 dB and a dose of exactly 0. The de-clicker
     * and the de-clipper are *not* moved here, and that round is closed by
     * measurement rather than by taste:
     *   · the de-clicker's amount is a repair *depth*, and the curve is its
     *     transient protection — applied as measured (0.861 instead of 0.715 at
     *     the default) it buys **one** pop of a 72-pop fixture (3 → 2 above the
     *     clean copy, pop energy −10.32 → −10.29 dB) and costs the kit
     *     **6 dB of snare** (−62.1 → −55.8 dB, 13 dB on the acceptance
     *     reproduction), 2.3× the touched samples (4.37 → 9.99 %) and 2.7× the
     *     clean master (2.74 → 7.46 %); the audit suite pins that row;
     *   · the de-clipper's amount is only the *detector's threshold*
     *     (`implied > 1.2 − 0.7·amount` — the waveform decides the depth), and
     *     it is already saturated where it matters: identical plateau error from
     *     dose 0.05 to 1.0 on the tonal contract fixture and within 0.02 dB on a
     *     hard-clipped noise fixture, so "as measured" would be a no-op that
     *     only lowers the evidence bar the dsp suite just pinned.
     *
     * The de-esser belongs in the first group for the same reason and was the
     * last one still in the second: its amount is `0.85 · sibNeed · headroom`,
     * and `sibNeed` is the law's own reading of the file — the departure of the
     * loudest frames from the file's balance, which is zero when no such
     * departure was measured. The curve was taking **0.830** of it, and the
     * stage under-delivered the rest, so the app's own output came back to it
     * still sibilant: on §10's burst fixture the 7 kHz band of the loudest 20 %
     * of frames came down **2.61 dB**, the scan the dose is computed from
     * 5.46 → 3.26 dB, and the 320 kbit/s export was diagnosed `sibilance` again
     * with **0.614** of dose asked for it (probe `tools/work/sib11.js`). As
     * measured (0.850 at the default) the same rows read **3.06 dB**,
     * **5.46 → 2.61 dB**, and the export reads **healthy** at 0.226 — under the
     * law's 0.30 naming threshold, which the curved dose missed by a factor of
     * two. The same file's own demand on the input is unchanged (the dose is the
     * measurement); what changes is that the stage now spends it.
     *
     * The stage's *reference* is the second half of that deficit and is measured
     * but **not** shipped: `slowDb` is a ~2 s mean that the bursts themselves
     * raise, so the per-frame target reads 0.45 where the file's own departure
     * says 0.79. Holding the reference while a burst window is open (probe
     * `sib11.js`, variant `freeze`) takes the export's dose 0.260 → **0.055** and
     * the scan → 2.41 — at the price of nearly doubling the de-esser's move on
     * a *continuous* "s" (the loudest 20 % of frames −5.25 → **−6.43 dB** on the
     * audit's own sibilant, a file whose every frame is a burst, so the
     * reference never learns a body). That trade is not yet bounded by
     * measurement here and is left where it is on purpose.
     */
    const repairMeasured = (x) => x * smoothstep(0, 0.20, p);
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
      subSrc: num(clamp(a.subSrc === undefined ? 95 : a.subSrc, 60, 260), 95),
      subRatio: a.subRatio,
      exciter: a.exciter * amt,
      air: a.air * amt,
      dehiss: repairMeasured(a.dehiss),
      // the de-clipper's own detector runs on the *measured* plateau level, so
      // it stays dormant (amount 0) on anything that was not measured as
      // clipped, whatever the slider says
      declip: a.declip > 0 ? repair(a.declip) : 0,
      declipLevel: num(clamp(a.declipLevel, -60, 0), -0.1),
      declick: repair(a.declick),
      tpCeil: num(a.tpCeil, 0),
      // …and the file's own peak, so the stages that are neither a repair nor
      // an absolute target (the glue, the analogue warmth) place their
      // thresholds relative to *this recording* instead of full scale. See the
      // `refDb` parameter in remaster-processor.js.
      refDb: num(clamp(metrics.peakDb, -60, 12), 0),
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
      airF: num(clamp((metrics.brickwall || 0) > 0.3 && codecLoss(metrics) ? metrics.cliffHz * 0.72 : 6000, 2200, 6000), 6000),
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
      // …and the de-esser's is a measurement too: `sibNeed` is zero unless the
      // scan measured a departure, so the intensity curve was scaling the
      // file's own reading (see the paragraph above `repairMeasured`).
      deess: num(repairMeasured(a.deess), 0),
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
    if ((m.brickwall || 0) > 0.25 && codecLoss(m)) {
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
    // Clipping has two sides, and the app now does something about one of them.
    // A rail (the old `clipRatio`) is the loud half; the signature that matters
    // more is a *plateau* just under full scale, which is what a limited master
    // has and what a listener hears as a buzz. Both feed one finding; when the
    // de-clipper runs, the finding carries the repair instead of a warning.
    const clipEv = m.clipEvidence === undefined ? 0 : m.clipEvidence;
    const clipSev = Math.max(clipEv, (m.clipRatio || 0) > 0.002 ? 0.6 : 0);
    if (clipSev > 0.05) {
      const overshoot = m.clipOvershootDb === undefined ? null : dbv(m.clipOvershootDb);
      if ((p.declip || 0) > 0) add('clipping', clamp(clipSev, 0, 1), overshoot, act('declip', m.clipOvershootDb || 0, 'db'));
      else add('clipping', clamp(clipSev, 0, 1), overshoot, act('headroom', null));
    }
    if (m.peakDb > -1) add('hotPeak', clamp((m.peakDb + 3) / 3, 0, 1), dbv(m.peakDb), act('ceiling', null));
    if (m.ispDb !== undefined && m.ispDb > -1.05) {
      // the *measured* true peak against the ceiling the chain will hold it to
      const ceil = (p.tpCeil === undefined || p.tpCeil === 0) ? 0 : p.tpCeil;
      add('truePeak', clamp((m.ispDb + 1) / 1.5, 0, 1), { n: m.ispDb, unit: 'dbtp' },
        ceil < 0 ? act('truePeak', ceil, 'dbtp') : act('ceiling', null));
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
    if ((m.clipEvidence || 0) > 0.05) push('clipping', clamp(m.clipEvidence, 0, 1));
    else if (m.clipRatio > 0.002) push('clipping', 0.6);
    if (m.dynamicRangeDb < 9) push('squashed', 0.5);
    // the per-song findings are part of the sentence as well: they are the ones
    // a profile cannot know about
    const D = demand(m, d);
    if (D.sibNeed > 0.3) push('sibilance', D.sibNeed);
    if (D.infraNeed > 0.3) push('rumble', D.infraNeed);
    if (D.phaseNeed > 0.3) push('outOfPhase', D.phaseNeed);
    /* A narrow stereo image, on the licence of its own repair: this used to be
     * `m.correlation < 0.2`, which is the *opposite* of a narrow image — a
     * narrow one is a *correlated* one (ρ → 1; the law at `widenNeed` says so and
     * the card's own row is keyed on it). Measured before the fix, the engine's
     * wide-stereo pair — two independent pink noises, ρ = 0.030, the widener asked
     * for nothing (dose 0.000) and the image came out untouched at 0.031 — was
     * named `narrow` in the sentence, i.e. the app telling the user "almost mono"
     * about the widest file it can be handed, while a genuinely narrow pair
     * (ρ = 0.982, dose 0.457) was named nothing. The threshold is the one the
     * card's own row uses (0.15), so the sentence and the card cannot disagree. */
    if (D.widenNeed > 0.15) push('narrow', clamp(D.widenNeed, 0, 1));
    if (m.dcOffsetDb !== undefined && m.dcOffsetDb > -46) push('dc', 0.5);
    if (!issues.length) push('healthy', 1);
    issues.sort((a, b) => b.weight - a.weight);
    return {
      id: d.id,
      chain: (d.chain || [{ id: d.id, w: 1 }]).map((c) => c.id),
      // The card names what was found, in order of weight. Three was the old
      // cap, and the toolkit's end-to-end loop is what caught it: a worn record
      // that was also saved as a 128 kbit/s MP3 comes back with crackle, hiss,
      // hum, rumble *and* a codec wall — five real findings — and the card named
      // three of them, so the hum never appeared even though the chain was
      // notching it. (The demand-based findings below are ordered with it, so
      // this is a display cap only.)
      issues: issues.slice(0, 5).map((i) => i.key),
      confidence: d.confidence, scores: d.scores,
    };
  }

  /** Resolve "auto" to the profile that was actually detected. */
  function resolve(presetId, metrics) {
    if (presetId && presetId !== 'auto' && PRESETS[presetId]) return presetId;
    return classify(metrics).id;
  }

  const API = { PRESETS, PRESET_ORDER, CEILING, MANUAL, PROFILE_EQ, CHAIN_MIN, TONE_MIN, classify, chainOf, evidence, mixAnchors, demand, adapt, resolve, buildParams, diagnose, recipe, eqCurve, curveDb, biquadDb, profileDb };
  global.RSPresets = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
