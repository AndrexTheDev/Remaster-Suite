'use strict';
/* =============================================================================
 * Acceptance matrix — one fixture per defect class, the whole automatic chain on
 * it, and for each defect the one statistic that describes it.
 * -----------------------------------------------------------------------------
 * The app's own analyser value and an independent time-domain meter (own RBJ
 * biquads + Goertzel, no app code in the measurement path) are printed side by
 * side: a defect counts as repaired only when *both* move, and a row where the
 * indicator moves while the sound does not (or the reverse) is a bug report.
 *
 * This file is committed on purpose: it is the evidence for the restoration
 * claims, and evidence in a gitignored directory does not survive a fresh
 * checkout. (Rebuilt after the sandbox was reset; the fixtures are the ones the
 * rows name, the statistics are described in each row's note.)
 *
 *   node tools/acceptance.js
 * ========================================================================== */
const U = require('./util.js');
const { H, RSDSP, SR, db } = U;
const RP = require('../assets/js/presets.js');
const Processor = H.loadProcessor(SR);
const SEC = 8;
const T0 = Date.now();
const mark = (t) => { if (process.env.VERBOSE) console.error('  [' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + t); };

/* ── independent meters ─────────────────────────────────────────────────── */
function bq(type, f, q) {
  const w = 2 * Math.PI * Math.min(f, SR * 0.49) / SR;
  const c = Math.cos(w), s = Math.sin(w), al = s / (2 * (q || 0.707));
  const a0 = 1 + al;
  if (type === 'HP') return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  if (type === 'LP') return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  return [al / a0, 0, -al / a0, -2 * c / a0, (1 - al) / a0];
}
const filt = (sig, list) => list.reduce((acc, c) => RSDSP.applyBiquad(acc, c), sig);
const rms = (a, from, to) => {
  let e = 0, n = 0;
  for (let i = from === undefined ? 0 : from; i < (to === undefined ? a.length : to); i++) { e += a[i] * a[i]; n++; }
  return Math.sqrt(e / Math.max(1, n));
};
function goertzel(sig, f) {
  const w = 2 * Math.PI * f / SR;
  let re = 0, im = 0;
  for (let i = 0; i < sig.length; i++) { re += sig[i] * Math.cos(w * i); im += sig[i] * Math.sin(w * i); }
  return 2 * Math.sqrt(re * re + im * im) / sig.length;
}
/** frames (20 ms) of a signal that the *clean copy* says are quiet */
function quietMask(cleanSym, frac) {
  const F = Math.round(SR * 0.02), frames = Math.floor(cleanSym.length / F);
  const lvl = [];
  for (let k = 0; k < frames; k++) lvl.push(rms(cleanSym, k * F, (k + 1) * F));
  const med = lvl.slice().sort((a, b) => a - b)[Math.floor(frames / 2)];
  const mask = [];
  for (let k = 0; k < frames; k++) mask.push(lvl[k] < med * (frac || 0.5));
  return mask;
}
function maskedBandDb(sig, mask, list, lat) {
  const b = filt(sig, list);
  const F = Math.round(SR * 0.02);
  let e = 0, n = 0;
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    for (let i = k * F; i < (k + 1) * F; i++) { const j = i + (lat || 0); if (j < b.length) { e += b[j] * b[j]; n++; } }
  }
  return n ? 10 * Math.log10(e / n) : -120;
}
/** band level summed over a range, the way the app's own infra measure does */
function bandSumDb(sig, f1, f2, lat) {
  const out = [];
  const n = f2 > f1 * 1.01 ? 8 : 1;      // a one-bin band is a bin, not a loop
  for (let k = 0; k < n; k++) {
    const f = n === 1 ? f1 : f1 * Math.pow(f2 / f1, k / (n - 1));
    out.push(goertzel(lat ? sig.subarray(lat) : sig, f));
  }
  let e = 0;
  for (const v of out) e += v * v;
  return 10 * Math.log10(e / out.length + 1e-20);
}
const sideRatio = (ch) => {
  if (ch.length < 2) return -120;
  let sm = 0, mm = 0;
  for (let i = 0; i < ch[0].length; i++) { const s = ch[0][i] - ch[1][i], m = ch[0][i] + ch[1][i]; sm += s * s; mm += m * m; }
  return 10 * Math.log10(sm / Math.max(mm, 1e-20));
};
/** Runs of same-sign samples that are equal to their neighbour to within 1e-4
 * of the file's peak and sit within 0.2 % of it: a *flat top*, counted by this
 * tool's own walk. Two rules, both of them the physics and not a convenience:
 * the samples have to keep the sign (a plateau does not cross zero — without
 * this the counter merges the two opposite clipped crests either side of a zero
 * crossing, and on the noise fixture it read 7.8 % where the truth is 4.2 %),
 * and the tolerance is 25× tighter than the app's own detector uses, so the
 * smooth top of a restored arc — whose samples differ by ~2e-3 of the peak at
 * 997 Hz — cannot land in a run here, while a clipped plateau (identical to the
 * last bit) always does. Reported as per-mille of the file plus the longest run,
 * so both the population and the worst case are on the row. */
function flatSpans(sig, tol) {
  let pk = 0;
  for (let i = 0; i < sig.length; i++) { const a = Math.abs(sig[i]); if (a > pk) pk = a; }
  const lim = pk * 0.998, T = (tol === undefined ? 1e-4 : tol) * pk;
  let inRun = 0, runs = 0, samples = 0, longest = 0;
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i], a = Math.abs(x);
    const flat = a >= lim && (inRun === 0 || (x * sig[i - 1] > 0 && Math.abs(a - Math.abs(sig[i - 1])) <= T));
    if (flat) inRun++;
    else { if (inRun >= 2) { runs++; samples += inRun; if (inRun > longest) longest = inRun; } inRun = 0; }
  }
  if (inRun >= 2) { runs++; samples += inRun; if (inRun > longest) longest = inRun; }
  return { runs, samples, longest, permille: 1000 * samples / Math.max(1, sig.length), peak: pk };
}

/* ── the chain ──────────────────────────────────────────────────────────── */
const EXPORTS = [];
function run(chans, over) {
  const m = RSDSP.measure(chans, SR);
  const cls = RP.classify(m);
  const P = Object.assign({}, RP.buildParams('auto', m, 0.7), over || {});
  const r = H.renderEx(Processor, chans, P);
  const mo = RSDSP.measure(r.out, SR);
  const dry = RP.diagnose(m), wet = RP.diagnose(mo);
  /* Every class is re-uploaded once from its own export (§19): the app must not
   * name a defect on the export that the chain has just repaired. It is recorded
   * here rather than per section so that *every* class is covered by
   * construction — a class that forgets its own export row still shows up. */
  const exp = RP.diagnose(RSDSP.measure(U.enc(r.out, 320, U.WORK + '/accept-export' + EXPORTS.length + '.mp3'), SR));
  EXPORTS.push({ cls: cls.id, dry: dry.issues, wet: wet.issues, exp: exp.issues });
  return { m, mo, P, cls, out: r.out, lat: r.latency, latency: r.latency, dry, wet };
}
const ROWS = [];
const row = (defect, stat, dry, wet, note) => ROWS.push([defect, stat, dry, wet, note || '']);
const N = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d === undefined ? 2 : d) : String(v));
/** a 0–1 clamp for the rows that re-derive a statistic from the exposed fields */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* H.renderEx reports its look-ahead as `latency`; `run()` re-labels it `lat`.
 * Reading the wrong one yields `undefined`, and every reader here writes
 * `(lat || 0)` — so the row reads the render *before* the limiter's 88 samples
 * instead of after them. That is exactly what happened to the two rows of the
 * click section below: the drum row has reported 1.79 dB of "damage" that the
 * stage does not do since the round that added it, and the burst row's
 * de-click-off column was read 1.8 ms early. A raw render's latency is read
 * here, and a result that does not carry one is an error, not a 0. */
const rawLat = (x) => {
  if (!x || typeof x.latency !== 'number') throw new Error('rawLat: expected an H.renderEx result');
  return x.latency;
};

const bed = (lp, norm, depth) => {
  let s = H.filter(RSDSP, H.pink(SR, SEC, 0.40, 31), SR, 'lp', lp, 0.60);
  const e = H.songEnvelope(SR, SEC, depth === undefined ? 0.35 : depth);
  for (let i = 0; i < s.length; i++) s[i] *= e[i];
  return H.normalize(s, norm);
};

mark('section 1');
/* 1 ── crackle ───────────────────────────────────────────────────────────── */
{
  const clean = bed(9000, 0.7), dirty = H.addCrackle(clean, 9, 0.85, 8);
  const r = run([dirty]);
  const HP4 = bq('HP', 4000, 0.707), LP12 = bq('LP', 12000, 0.707);
  const ref = filt(clean, [HP4, LP12]);
  const pos = [];
  for (let i = 2; i < dirty.length - 2; i++) {
    const d = Math.abs(dirty[i] - clean[i]);
    if (d > 0.25 && d > Math.abs(dirty[i - 1] - clean[i - 1]) && d >= Math.abs(dirty[i + 1] - clean[i + 1])) pos.push(i);
  }
  const at = (sig, lat) => {
    const b = filt(sig, [HP4, LP12]);
    const rel = pos.map((p) => {
      let e = 0, ec = 0;
      for (let k = -16; k <= 48; k++) {
        const j = p + lat + k; if (j >= 0 && j < b.length) e += b[j] * b[j];
        ec += ref[p + k] * ref[p + k];
      }
      return e / ec;
    }).sort((a, b2) => b2 - a);
    return { med: 10 * Math.log10(rel[Math.floor(rel.length / 2)]), over: rel.filter((x) => x > 1).length, n: rel.length };
  };
  const d = at(dirty, 0), w = at(r.out[0], r.lat);
  row('crackle', 'pop energy over the clean copy (median dB)', d.med, w.med, 'pops above it: ' + d.over + '/' + d.n + ' → ' + w.over + '/' + w.n);
  row('crackle', 'analyser crackleIndex', r.m.crackleIndex, r.mo.crackleIndex,
    r.cls.id + ' · dose ' + N(r.P.declick));
  /* The user's own loop, on the app's own export: encode the finished file at
   * 320 kbit/s, feed it back and ask the same two questions. This is the claim
   * that started the round — "the export still crackles and the app still calls
   * it crackle" — so it is measured here and not argued: the pop energy stays
   * where the repair left it (median **−10.26 → −10.23 dB** over the clean copy,
   * the same 3 of 72 pops above it), and the app's verdict on its own export is
   * **healthy** (crackleIndex 1.00 dry → 0.06 after the chain → 0.04 after the
   * re-upload while the statistic was a bare percentile; **0.00 → 0.00** since
   * the duty gate, because the spike population is gone and the index then sits
   * on its floor — see section 10). The encoder returns sample-aligned output, so the alignment is
   * the render's own latency; it is found by correlation anyway (lag 0 samples on
   * this fixture) rather than assumed, because the pop meter is a window meter
   * and a wrong offset measures the bed. */
  const re = U.enc(r.out, 320, U.WORK + '/accept-crackle-320.mp3')[0];
  const lag = (() => {
    let best = 0, bv = -Infinity;
    for (let d2 = -256; d2 <= 256; d2++) {
      let s = 0;
      for (let i = 4800; i < r.out[0].length - 4800; i += 11) s += r.out[0][i] * re[i + d2];
      if (s > bv) { bv = s; best = d2; }
    }
    return best;
  })();
  const rm = RSDSP.measure([re], SR);
  const w320 = at(re, r.lat + lag);
  row('crackle', 're-upload at 320 kbit/s → pop energy (median dB)', w.med, w320.med,
    'pops above it: ' + w.over + '/' + w.n + ' → ' + w320.over + '/' + w320.n + ' · aligned by correlation, lag ' + lag + ' samples');
  row('crackle', 're-upload at 320 kbit/s → diagnosis', r.dry.issues.join(','), RP.diagnose(rm).issues.join(',') || 'healthy',
    'crackleIndex ' + N(rm.crackleIndex) + ' · what the user re-uploads is this file, and it must not be named a crackle the chain has repaired');
}
mark('section 2');
/* 2 ── hiss ────────────────────────────────────────────────────────────────
 * The de-hisser's dose is not a strength: it is the fraction of a *measured*
 * repair (see the stage), so both halves of the measurement belong on the row.
 * `hissTiltStepDb` is how many dB of the 4–16 kHz top end the programme cannot
 * account for — the *size*, and the number the card prints. `hissAmount` is a
 * 0–1 gate built from the same step (its evidence term is (step − 0.8)/5, so it
 * clamps on anything clearly hissy) plus a dynamic-deficit term and the level
 * term; the rows print the pair and the raw deficit beside them, because the
 * amount alone cannot say *which* witness is holding the verdict up. Measured
 * this round: the step falls **18.35 → 0.00 dB** and the amount **1.00 → 0.39**,
 * and what is left of the amount is the level term — not the tilt (probe
 * hiss24: band table below).
 *
 * Two more things are measured here rather than assumed, because the audit of
 * this class needs them — all on this fixture (step 18.35 dB, card cassette,
 * dose 0.764, and the hiss shaped 2 kHz up so that it sits where the stage
 * works; white noise at this level is mostly below the band the row measures and
 * the repair moves it by 1 dB):
 *   · *where* the repair acts. The quiet mask is 53 of 400 frames, and in 48 of
 *     them the top end is the noise's own — measured, not asserted: the clean
 *     copy's ≥4 kHz sits below the hiss's. There the band comes down **12.1 dB**
 *     (10.3 before this round; the shelf's own share is measured against the same
 *     render with the term removed — probe hiss25: 10.12 vs 8.93 dB over the wider
 *     music-owned population); in the 5 quiet frames the music owns, and in the
 *     loud passages, it moves 1.12 and 0.1 dB, and of the first number the shelf
 *     is 0.04 dB (0.48 vs 0.45 dB on the wider population) — those are the numbers
 *     that have to stay near zero;
 *   · *how much of the key's ask is applied*. In the noise-owned frames the tilt
 *     key reads **15.9 dB** — the same number the analyser's quiet median reports
 *     (15.82), which is the point of the key — the ask is capped to the card's
 *     17.35 (the frame would ask 18.4), the smoothed cut holds **17.33** of it
 *     (98 %, so the 60 ms ride is not the limit) and the amount that leaves the
 *     split is 15.9 dB per sample — because within a 20 ms frame the energy sits
 *     where the level term has the gate more open, **10.3 dB energy-weighted**
 *     (8.93 dB measured over the wider population).
 *     This round added a second stage to that path (see HISS_FLOOR_RATIO): where
 *     the two witnesses agree the frame is floor only, a shelf on the repair
 *     corner delivers what the split's phase-coupled reconstruction cannot — its
 *     gain is **12.87 dB at the median gate update** in these frames (probe
 *     hiss23: floorW p50 1.00, shelf 12.87 of the 0.75 × 17.33 it may take). It
 *     is *not* worth 12.87 dB to the band, and that is the point of the gating:
 *     the energy-weighted gain is +1.2 dB (10.3 → 12.1, the row above), because
 *     the samples that carry a frame's energy are exactly the ones where the key
 *     sees music and the witnesses back off. The *pause* is where the whole
 *     amount lands: median level per band over the noise-owned frames, against
 *     the clean copy (probe hiss24, dB over the clean copy at 1/2/3/4/6/8/12 kHz)
 *     11/16/17/17/17/18/21 → **9/12/12/11/8/8/10**, i.e. the repair doubles where
 *     the defect lives and leaves the bottom of the range to the music.
 *     Three earlier fixes brought the split here, each measured: (a) the mid band of the key was
 *     **one** biquad where the analyser cascades **two** — the single filter's
 *     upper skirt reaches into the 4 kHz+ band the hiss lives in and read the
 *     quiet frames' tilt 4.38 dB low (−1.85 dB over the whole file), so the key
 *     under-asked by the very noise it was looking for; (b) the closing time is
 *     60 ms and used to be 250 — the *lag*, not the ask, was holding the repair
 *     back (6.06 → 7.94 dB of band on the close time alone); (c) a measured repair
 *     is now applied as measured instead of being scaled by the intensity curve
 *     (0.35 + 0.65·p^0.85 = 0.830 at the default p = 0.7, which turned the law's
 *     0.920 into 0.764). Together, on this fixture: the frames the noise owns went
 *     **5.8 → 10.3 dB** of band and the step this card printed **5.82 dB** — the shelf below then
 *     takes the same two numbers to **12.1 dB** and **0.00 dB** — and
 *     the frames the music owns moved 0.02 → 1.12 dB (they are quiet frames where
 *     the noise still contributes a dB or so — the calibrated answer, not a
 *     mistake). Both clean-bed fixtures still measure a dose of exactly 0.
 *     What is *not* claimed here is that this is enough. The tilt step now reads
 *     **0.00 dB on the output** (was 5.82) and `hissAmount` **0.39** (was 1.00) —
 *     the indicator moves with the sound now, which is what the 5th-order
 *     requirement asks for — but the pauses' absolute floor is still 8–12 dB above
 *     the clean copy at 6–12 kHz (probe hiss24), the export is still named a hiss
 *     (through the level term, not the tilt), and the row says so instead of
 *     implying nothing is left.
 *
 * The class's *ceiling* is measured here too, so the next round does not re-derive it. In
 * the frames the noise owns, the noise is **32.4 dB** above the clean copy's own top end
 * (this fixture has a ground truth: the bed is known) — so the 12.1 dB the chain takes is
 * **37 % of what is there** (32 % before this round), and the step the card prints says so.
 * The cap that bounds the ask is no longer the limit either: lifting `hissMax` by 3 dB is
 * worth **+0.04 dB** of band now (probe hiss26: 10.12 → 10.16 dB energy-weighted in the
 * noise-owned frames, where the same lift used to be worth +0.27 dB), because the shelf
 * scales with the same cap and the witnesses — not the cap — decide what is applied.
 * Two ways to ask the frame's own 32 dB were measured and rejected:
 *   · *a level key alone* (ask = how far the top end sits above the measured floor) asks
 *     **2.9–7.6 dB inside the loud and music-owned frames** where the tilt key correctly asks
 *     0 — on this fixture the level cannot separate the classes at all (the frame's top end
 *     over the floor: noise **1.30**, music **1.10**), so it would dull music;
 *   · *inverting the two bands* (`P_MID = (HF² − N²)/10^(tiltRef/10)`, the one formulation
 *     that is algebraically identifiable) is degenerate here — **3.9 dB** in the noise-owned
 *     frames against **7.6 dB** in the loud ones, i.e. the wrong way round, because the
 *     programme's tilt is not constant across frames and the two meters disagreed by ~1.6 dB
 *     (that disagreement was the one-filter mid band, fixed above).
 * What is left is **not** a policy the app could just dial up: the frames that still carry
 * music where they are loud are what the difference between the per-sample cut (15.9 dB, plus
 * up to 12.9 of shelf where the witnesses agree) and the energy-weighted 12.1 dB is.
 * ------------------------------------------------------------------------- */
{
  const clean = bed(9000, 0.7);
  const hiss = H.mul(H.filter(RSDSP, H.noise(SR, SEC, 1, 21), SR, 'hp', 2000, 0.5), 0.040);
  const dirty = H.normalize(H.mix([clean, hiss]), 0.7);
  const r = run([dirty]);
  const HP4 = bq('HP', 4000, 0.707);
  const mask = quietMask(clean, 0.5);
  /* the population the repair exists for, measured against the clean copy: a
   * frame is the noise's when the clean copy's top end sits below the hiss's */
  const noiseOwns = (() => {
    const F = Math.round(SR * 0.02), frames = Math.floor(clean.length / F);
    const fc = filt(clean, [HP4]), fh = filt(hiss, [HP4]);
    const out = new Array(frames).fill(false);
    for (let k = 0; k < frames; k++) {
      let a = 0, b = 0;
      for (let i = k * F; i < (k + 1) * F; i++) { a += fc[i] * fc[i]; b += fh[i] * fh[i]; }
      out[k] = a < b;
    }
    return out;
  })();
  const inQuietNoise = mask.map((q, k) => q && noiseOwns[k]);
  const inQuietMusic = mask.map((q, k) => q && !noiseOwns[k]);
  const red = (mk) => maskedBandDb(dirty, mk, [HP4]) - maskedBandDb(r.out[0], mk, [HP4], r.lat);
  row('hiss', '≥4 kHz RMS in quiet passages (dBFS)', maskedBandDb(dirty, mask, [HP4]), maskedBandDb(r.out[0], mask, [HP4], r.lat),
    'where the noise owns the top end (' + inQuietNoise.filter(Boolean).length + ' of the ' + mask.filter(Boolean).length
    + ' quiet frames): ' + N(red(inQuietNoise), 1) + ' dB · the quiet frames the music owns: ' + N(red(inQuietMusic), 2)
    + ' dB · loud passages: ' + N(maskedBandDb(dirty, mask.map((v) => !v), [HP4]), 1) + ' → '
    + N(maskedBandDb(r.out[0], mask.map((v) => !v), [HP4], r.lat), 1));
  row('hiss', 'the size it measures, hissTiltStepDb (dB)', r.m.hissTiltStepDb, r.mo.hissTiltStepDb,
    'the card prints this number · the music now stands ' + N(r.mo.hfSnrDb, 1) + ' dB above the top-end floor (was '
    + N(r.m.hfSnrDb, 1) + ') · dose ' + N(r.P.dehiss, 3));
  const witnesses = (m2) => 'tilt ' + N(clamp01(((m2.hissTiltStepDb || 0) - 0.8) / 5.0))
    + ' · deficit ' + N(clamp01(((m2.hissDeficitDb || 0) - 1.0) / 4.0)) + ' (raw ' + N(m2.hissDeficitDb) + ' dB)';
  row('hiss', 'analyser hissAmount — the 0–1 gate behind the card', r.m.hissAmount, r.mo.hissAmount,
    'built from the step above and two more witnesses, so the row prints them: ' + witnesses(r.m) + ' → ' + witnesses(r.mo));
  const re = U.enc(r.out, 320, U.WORK + '/accept-hiss-320.mp3')[0];
  const rm = RSDSP.measure([re], SR);
  row('hiss', 're-upload at 320 kbit/s → diagnosis', r.dry.issues.join(','), RP.diagnose(rm).issues.join(',') || 'healthy',
    'step ' + N(rm.hissTiltStepDb, 2) + ' dB · amount ' + N(rm.hissAmount) + ' · card ' + RP.classify(rm).id
    + ' — the tilt is *not* what names the export any more (0.00): ' + witnesses(rm)
    + '. What is left is the deficit: the export\'s top end still stands ' + N(rm.hissDeficitDb, 2)
    + ' dB above where the music predicts it, which matches the 4–6 dB of floor the deepest pauses still carry over the clean copy (probe hiss24) — an honest bound, not a missed repair');
}
mark('section 3');
/* 3 ── mains hum ─────────────────────────────────────────────────────────── */
{
  const clean = bed(9000, 0.7);
  const hum = (f, a) => H.tone(f, SR, SEC, a);
  const dirty = H.normalize(H.mix([clean, hum(50, 0.030), hum(150, 0.012)]), 0.7);
  const r = run([dirty]);
  const humDb = (sig, lat) => 20 * Math.log10((goertzel(lat ? sig.subarray(lat) : sig, 50) + goertzel(lat ? sig.subarray(lat) : sig, 150)) / (goertzel(lat ? sig.subarray(lat) : sig, 113) + 1e-20));
  row('mains hum', '50 + 150 Hz vs a non-hum bin (dB)', humDb(dirty), humDb(r.out[0], r.lat),
    'humScore ' + N(r.m.humScore) + ' → ' + N(r.mo.humScore) + ' · ' + r.dry.issues.join(','));
  row('mains hum', 'analyser humPeakDb', r.m.humPeakDb, r.mo.humPeakDb, '');
  /* the export the user gets back, re-uploaded — the honesty check from the
   * request: a fault the chain has repaired may not still be named on it */
  const re = U.enc(r.out, 320, U.WORK + '/accept-hum-320.mp3')[0];
  const rm = RSDSP.measure([re], SR);
  row('mains hum', 're-upload at 320 kbit/s → diagnosis', r.dry.issues.join(','), RP.diagnose(rm).issues.join(',') || 'healthy',
    'card ' + r.cls.id + ' → ' + RP.classify(rm).id + ' · the 320 kbit/s encoder puts its own noise floor under the file, which is what the analyser reads on it');
}
mark('section 4');
/* 4 ── rumble ────────────────────────────────────────────────────────────── */
{
  let clean = bed(6000, 0.7);
  clean = H.normalize(H.filter(RSDSP, clean, SR, 'hp', 60, 0.707), 0.7);
  /* The rumble has to *dominate* the band that is supposed to see it, or the row
   * measures the bed's own leakage through its 60 Hz high-pass instead of the
   * defect. Measured on this fixture as it stands: the bed alone reaches 8–20 Hz
   * at **−68.9 dBFS**, the rumble mixed into it at **−32.4** — 36 dB above that
   * floor — and the chain brings the band from −38.1 to **−93.3 dBFS**, i.e.
   * *past* what the bed itself does down there, because the saturated rung's
   * corner (42 Hz) sits above the band. (The row's note used to print the
   * rumble's own level under the words "the bed alone", which made the row look
   * 36 dB better than it was; both numbers are named now. The 18–24 Hz rung this
   * row had before the second rung stopped at −67.5 dBFS, within 1.4 dB of the
   * bed's own floor — which is why the second rung exists.) */
  const low = H.normalize(H.filter(RSDSP, H.filter(RSDSP, H.noise(SR, SEC, 0.30, 12), SR, 'lp', 35, 0.707), SR, 'lp', 35, 0.707), 0.9);
  const dirty = H.normalize(H.mix([clean, low]), 0.7);
  const r = run([dirty]);
  /* The floor this row has to beat is the *bed's* own leakage into 8–20 Hz
   * through its 60 Hz high-pass — measured here, not guessed: it read −17.0 dBFS
   * at the 0.30 rumble level that made this row useless. The note used to print
   * the rumble source's own level under the words "the bed alone", which flattered
   * the row by ~5 dB; both numbers are printed now, each named. */
  const bedFloor = bandSumDb(clean, 8, 20);
  const srcLevel = bandSumDb(low, 8, 20);
  row('rumble', 'under-35 Hz vs 100 Hz (dB)', bandSumDb(dirty, 14, 30) - bandSumDb(dirty, 90, 110), bandSumDb(r.out[0], 14, 30, r.lat) - bandSumDb(r.out[0], 90, 110, r.lat),
    'infraExcess ' + N(r.m.infraExcessDb, 1) + ' → ' + N(r.mo.infraExcessDb, 1) + ' · guard ' + N(r.P.infraHP, 1) + ' Hz · ' + r.dry.issues.join(','));
  row('rumble', 'absolute level of the 25 Hz band (dBFS)', bandSumDb(dirty, 24, 26), bandSumDb(r.out[0], 24, 26, r.lat), '');
  row('rumble', 'the 8–20 Hz band, where the bed is not (dBFS)', bandSumDb(dirty, 8, 20), bandSumDb(r.out[0], 8, 20, r.lat),
    'the bed alone reaches this band at ' + N(bedFloor, 1) + ' dBFS (the rumble mixed into it reads ' + N(srcLevel, 1) + ')');
  row('rumble', 'below 20 Hz vs 100 Hz (dB)', bandSumDb(dirty, 10, 19) - bandSumDb(dirty, 90, 110), bandSumDb(r.out[0], 10, 19, r.lat) - bandSumDb(r.out[0], 90, 110, r.lat), '');
  const re = U.enc(r.out, 320, U.WORK + '/accept-rumble-320.mp3')[0];
  const rm = RSDSP.measure([re], SR);
  row('rumble', 're-upload at 320 kbit/s → diagnosis', r.dry.issues.join(','), RP.diagnose(rm).issues.join(',') || 'healthy',
    'card ' + r.cls.id + ' → ' + RP.classify(rm).id + ' · infraExcess on the export ' + N(rm.infraExcessDb, 1) + ' dB');
}
mark('section 5');
/* 5 ── clipping ────────────────────────────────────────────────────────────
 * Two meters, and a row that used to compare two things that cannot be.
 *
 * The defect's own statistic is a *pair*: the share of samples sitting in flat
 * runs at the file's top, and the peak the run length implies is missing — the
 * two numbers the diagnosis acts on (`clipFlatRatio` + `clipOvershootDb`, whose
 * product is the evidence). Neither alone is a verdict, measured on this very
 * fixture: the smooth top of a *restored* arc is flat enough to read as 2–3
 * sample runs (with the tonal stages off, 7.17 % of the file and an implied
 * peak of 0.07 dB — and evidence 0.00), while a real plateau reads 42.01 % in
 * 11-sample runs and 2.05 dB (evidence 0.73). The rows print both numbers.
 *
 * The plateau error, which the engine test uses, is a *phase ruler* and cannot
 * compare two different chains: rotating the original by half a sample reads
 * −31.9 dB on the tone fixture and by three samples −16.0, i.e. the whole range
 * these rows cover — and every EQ stage rotates phase, while the exciter adds
 * harmonics by design. Measured on the tone with the shipped parameters: the
 * clipped file −23.46, the chain without the de-clipper −13.40, with it −15.24;
 * the same file through a repair-only chain −23.46 → −31.87. So a dry-vs-
 * finished comparison here reports the chain's colouring, not the repair, and
 * the verdict has to be a one-parameter control inside the chain that actually
 * runs — which is what the first row now is. And where it still reads *up*
 * (noise, kick + bass) that is the metric, not the stage: the true depth of a
 * noise crest cannot be recovered from its run length, the detector's own
 * fallback is capped at +3 dB, and no reconstruction can be closer than that
 * guess — the flat-top pair and the counter are the verdict for those two.
 * ------------------------------------------------------------------------- */
function plateausOf(sig, rail) {
  const set = new Uint8Array(sig.length);
  const lim = rail * 0.999;
  for (let i = 0; i < sig.length; i++) if (Math.abs(sig[i]) >= lim) set[i] = 1;
  return set;
}
/** best-fit scale over the plateau samples, error against the original.
 * Read the number with its alignment: it is a *phase ruler* on tonal material
 * (a half-sample rotation of the original alone reads −31.9 dB at 997 Hz, three
 * samples −16.0), so it may only ever compare two renders that differ in one
 * parameter — never the dry file with a chain that applies EQ. */
function plateauError(orig, sig, mask, lat) {
  let ss = 0, so = 0, oo = 0, n = 0;
  for (let i = 0; i < orig.length; i++) {
    if (!mask[i]) continue;
    const j = i + (lat || 0);
    if (j < 0 || j >= sig.length) continue;
    ss += sig[j] * sig[j]; so += sig[j] * orig[i]; oo += orig[i] * orig[i]; n++;
  }
  if (!n || oo <= 0) return -Infinity;
  const g = so / Math.max(ss, 1e-20);
  return 10 * Math.log10(Math.max(ss * g * g - 2 * g * so + oo, 1e-20) / oo);
}
/** how much a render writes, relative to the original, over a mask */
function writeDb(orig, a, b, mask, lat, latB) {
  let e = 0, oo = 0;
  for (let i = 0; i < orig.length; i++) {
    if (!mask[i]) continue;
    const j = i + (lat || 0), k = i + (latB || 0);
    if (j < 0 || j >= a.length || k < 0 || k >= b.length) continue;
    const d = a[j] - b[k];
    e += d * d; oo += orig[i] * orig[i];
  }
  return 10 * Math.log10(Math.max(e, 1e-20) / Math.max(oo, 1e-20));
}
function clipCase(tag, orig, rail, note) {
  const clipped = new Float32Array(orig.length);
  for (let i = 0; i < orig.length; i++) clipped[i] = Math.max(-rail, Math.min(rail, orig[i]));
  const r = run([clipped]);
  const mask = plateausOf(clipped, rail);
  const dryDry = plateauError(orig, clipped, mask);
  /* the verdict, one parameter apart, inside the chain that actually shipped */
  const noDeclip = H.renderEx(Processor, [clipped], Object.assign({}, r.P, { declip: 0 }));
  row('clipping (' + tag + ')', 'error at the plateaus vs the original, full chain, de-clipper off / on (dB)',
    plateauError(orig, noDeclip.out[0], mask, noDeclip.latency), plateauError(orig, r.out[0], mask, r.lat),
    'one parameter apart · declip ' + N(r.P.declip) + ' at plateau ' + N(db(rail), 1) + ' dBFS · the clipped file alone reads '
    + N(dryDry, 2) + ' dB, which is *not* the comparison — and on the two non-periodic fixtures the repair legitimately moves '
    + 'this number *up*: how deep a noise peak went is not knowable from its run length (the detector’s own fallback, capped at '
    + '+3 dB), so only the pair and the counter below are the verdict there');
  row('clipping (' + tag + ')', 'flat samples at the top, the share the diagnosis reads (%)',
    100 * r.m.clipFlatRatio, 100 * r.mo.clipFlatRatio,
    'implied missing peak ' + N(r.m.clipOvershootDb, 2) + ' → ' + N(r.mo.clipOvershootDb, 2) + ' dB · evidence '
    + N(r.m.clipEvidence, 2) + ' → ' + N(r.mo.clipEvidence, 2) + ' · longest run ' + r.m.clipMaxRun + ' → ' + r.mo.clipMaxRun
    + ' samples (what is left is an arc’s top, not a rail) · the pair is the verdict, not the share');
  const spIn = flatSpans(clipped), spOut = flatSpans(r.out[0]);
  row('clipping (' + tag + ')', 'flat samples, own counter (per mille of the file)',
    spIn.permille, spOut.permille,
    spIn.runs + ' → ' + spOut.runs + ' runs of same-sign samples equal to 1e-4 of the peak, longest '
    + spIn.longest + ' → ' + spOut.longest + ' · 25× tighter than the detector’s own tolerance, so a restored arc cannot land in one');
  // the repair chain alone, one parameter apart — the de-clipper's own verdict
  const REP = { power: 1, autoLevel: 0, tpCeil: 6, declip: 0, declipLevel: r.P.declipLevel || -0.1,
    declick: r.P.declick, dehiss: r.P.dehiss, deess: r.P.deess, hum: r.P.hum || 0, hum2: r.P.hum2 || 0, hum3: r.P.hum3 || 0 };
  const off = H.renderEx(Processor, [clipped], REP);
  const on = H.renderEx(Processor, [clipped], Object.assign({}, REP, { declip: r.P.declip }));
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  row('clipping (' + tag + ')', 'plateau error, repair chain only, de-clipper off / on (dB)',
    plateauError(orig, off.out[0], mask, off.latency), plateauError(orig, on.out[0], mask, on.latency),
    'the control differs in one parameter');
  row('clipping (' + tag + ')', '…and the untouched part of the same file (dB)',
    plateauError(orig, clipped, inv), plateauError(orig, r.out[0], inv, r.lat),
    'the chain’s own tonal work, which is allowed to move this');
  row('clipping (' + tag + ')', 'de-clipper vs the same chain without it, at the plateaus (dB)', -60,
    writeDb(orig, on.out[0], off.out[0], mask, on.latency, off.latency),
    'how much the reconstruction writes there — this is the repair');
  row('clipping (' + tag + ')', '…and where it must write nothing (dB)', -60,
    writeDb(orig, on.out[0], off.out[0], inv, on.latency, off.latency),
    'a repair that writes here is damage, whatever else it does');
  if (note) row('clipping (' + tag + ')', note, '', '', '');
}
{
  const noise = H.normalize(H.noise(SR, SEC, 0.7, 5), 0.95);
  clipCase('noise', noise, 0.75);
  const tone = H.tone(997, SR, SEC, 1.25);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.max(-0.99, Math.min(0.99, tone[i]));
  clipCase('997 Hz tone', H.tone(997, SR, SEC, 1.25), 0.99);
  let kick = H.normalize(H.mix([H.noise(SR, SEC, 0.5, 9), H.tone(60, SR, SEC, 0.6)]), 0.98);
  clipCase('kick + bass', kick, 0.75);
}
mark('section 6');
/* 6 ── codec wall ──────────────────────────────────────────────────────────
 * Two walls, because they are two different situations and the app has to get
 * both right (measured on this fixture with the toolkit's encoder):
 *
 *   32 kbit/s · cliff  7254 Hz   6 kHz −1.4   8 kHz −3.1   12 kHz −6.7  → repair
 *   64 kbit/s · cliff 15533 Hz   6 kHz +0.1   8 kHz +0.2   12 kHz +0.2  → nothing was cut
 *                                14 kHz −0.1  16 kHz −0.8  18 kHz −2.0
 *
 * The row used to treat every wall as "12 dB of top end is missing", which asked
 * for +2.4 dB at 7 kHz on the 64 kbit/s file — a band the encoder had left
 * untouched — and the chain's own export then came back from a re-upload
 * diagnosed `sibilance`. A wall's deficit now follows where the wall sits.
 */
function codecCase(tag, kb, bandLo, bandHi) {
  const orig = bed(20000, 0.72);
  const mp3 = U.enc([orig], kb, U.WORK + '/accept' + kb + '.mp3')[0];
  const r = run([mp3]);
  const HP = bq('HP', bandLo, 0.707), LP = bq('LP', bandHi, 0.707);
  const lvl = (sig, lat) => 10 * Math.log10(Math.pow(rms(filt(sig.subarray(lat || 0), [HP, LP])), 2));
  row('codec wall (' + kb + 'k)', bandLo / 1000 + '–' + bandHi / 1000 + ' kHz vs the pre-encode original (dB)',
    lvl(mp3) - lvl(orig), lvl(r.out[0], r.lat) - lvl(orig),
    'cliff ' + N(r.m.cliffHz, 0) + ' Hz @ ' + N(r.m.cliffDb, 1) + ' dB · ' + r.dry.issues.join(',') + ' · profile ' + r.cls.id);
  row('codec wall (' + kb + 'k)', 'analyser brickwall', r.m.brickwall, r.mo.brickwall,
    'air ' + N(r.P.air, 3) + ' (' + N(r.m.topLoss, 2) + ' topLoss, ' + N(r.m.dullIndex, 2) + ' dullIndex)');
  const re = U.enc(r.out, 320, U.WORK + '/accept320-' + kb + '.mp3')[0];
  const rm = RSDSP.measure([re], SR);
  row('codec wall (' + kb + 'k)', 're-upload at 320 kbit/s → diagnosis', r.dry.issues.join(','), RP.diagnose(rm).issues.join(',') || 'healthy',
    'profile ' + r.cls.id + ' → ' + RP.classify(rm).id);
}
codecCase('32k', 32, 8000, 16000);
codecCase('64k', 64, 15000, 20000);
/* 7 ── boxy resonance ───────────────────────────────────────────────────── */
{
  const clean = bed(6000, 0.7);
  let out = Float32Array.from(clean);
  const ring = filt(clean, [bq('BP', 220, 4)]);
  for (let i = 0; i < out.length; i++) out[i] += 1.5 * ring[i];
  out = H.normalize(out, 0.7);
  const r = run([out]);
  const excess = (sig, lat) => {
    const a = rms(filt(sig.subarray(lat || 0), [bq('BP', 220, 4)]));
    const b = rms(filt(sig.subarray(lat || 0), [bq('BP', 110, 2)])) + rms(filt(sig.subarray(lat || 0), [bq('BP', 440, 2)]));
    return 10 * Math.log10(a / (0.5 * b + 1e-20));
  };
  row('boxy resonance', '220 Hz ring vs its neighbours (dB)', excess(out), excess(r.out[0], r.lat),
    'resoExcess ' + N(r.m.resoExcessDb, 1) + ' → ' + N(r.mo.resoExcessDb, 1) + ' · notch ' + N(r.P.boxG1, 2) + ' dB @ ' + N(r.P.boxF1, 0) + ' Hz');
}
mark('section 8');
/* 8 ── narrow stereo ────────────────────────────────────────────────────── */
{
  const mid = bed(9000, 0.7);
  const side = H.normalize(filt(bed(9000, 0.7), [bq('HP', 300, 0.707)]), 0.06);
  const L = Float32Array.from(mid, (x, i) => x + side[i]);
  const R = Float32Array.from(mid, (x, i) => x - side[i]);
  const m = RSDSP.measure([L, R], SR);
  const P = RP.buildParams('auto', m, 0.7);
  const out = H.renderEx(Processor, [L, R], P).out;
  row('narrow image', 'side/mid energy (dB)', sideRatio([L, R]), sideRatio(out),
    'correlation ' + N(m.correlation, 3) + ' · width ' + N(P.width, 2) + ' · ' + RP.classify(m).id);
}
mark('section 9');
/* 9 ── DC offset ────────────────────────────────────────────────────────── */
{
  const clean = bed(9000, 0.7);
  const dirty = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i++) dirty[i] = clean[i] + 0.02;
  const r = run([dirty]);
  const mean = (sig, lat) => {
    let s = 0, n = 0;
    for (let i = lat || 0; i < sig.length; i++) { s += sig[i]; n++; }
    return s / Math.max(1, n);
  };
  row('dc offset', 'mean sample value', mean(dirty), mean(r.out[0], r.lat),
    'dcOffsetDb ' + N(r.m.dcOffsetDb, 1) + ' → ' + N(r.mo.dcOffsetDb, 1));
}
mark('section 10');
/* 10 ── sibilance ───────────────────────────────────────────────────────── */
{
  const clean = bed(9000, 0.7);
  const dirty = Float32Array.from(clean);
  const F = Math.round(SR * 0.12);
  /* A real "s" is band-limited *noise*, and it starts smoothly: a 7.8 kHz tone
   * burst reads as a codec cliff in the analyser (the row's note said "codec"
   * on a file with no codec in it), and an abrupt noise onset reads as crackle.
   * Both were the fixture talking, not the app. 25 ms raised-cosine attack. */
  const shaped = filt(H.noise(SR * 0.12, 1, 1, 77), [bq('HP', 5200, 0.707)]);
  for (let burst = 0; burst < 12; burst++) {
    const at = Math.round(SR * (0.35 + burst * 0.6));
    for (let i = 0; i < F; i++) {
      const j = at + i;
      if (j >= dirty.length) break;
      const A = Math.round(SR * 0.025);
      const att = i < A ? 0.5 - 0.5 * Math.cos(Math.PI * i / A) : 1;
      dirty[j] += 0.55 * att * Math.exp(-i / (F * 0.5)) * shaped[i] * (1 + 0.4 * Math.sin(i * 0.7));
    }
  }
  const norm = H.normalize(dirty, 0.72);
  const r = run([norm]);
  const burstBand = (sig, lat) => {
    const b = filt(sig.subarray(lat || 0), [bq('BP', 7800, 1.2)]);
    let e = 0, n = 0;
    for (let burst = 0; burst < 12; burst++) {
      const at = Math.round(SR * (0.35 + burst * 0.6)) + Math.round(SR * 0.03);
      for (let i = 0; i < SR * 0.06; i++) { const j = at + i; if (j < b.length) { e += b[j] * b[j]; n++; } }
    }
    return n ? 10 * Math.log10(e / n) : -120;
  };
  const p95p30 = (sig, lat) => {
    const F2 = Math.round(SR * 0.01), b = filt(sig.subarray(lat || 0), [bq('BP', 7000, 1.0)]);
    const lv = [];
    for (let k = 0; k + F2 < b.length; k += F2) {
      let e = 0;
      for (let i = 0; i < F2; i++) e += b[k + i] * b[k + i];
      lv.push(10 * Math.log10(e / F2 + 1e-20));
    }
    lv.sort((a, b2) => a - b2);
    return lv[Math.floor(lv.length * 0.95)] - lv[Math.floor(lv.length * 0.30)];
  };
  /* ── the other half of "recognise every defect precisely" ─────────────────
   * A defect class must not be *invented*, and this fixture is where that failed:
   * its twelve "s" bursts are sustained high-frequency *noise*, and the crackle
   * statistic — a crest factor per 20 ms window — is a level measure on them:
   * acceptance **v2aj** (the run before the duty gate landed) named `crackle` on
   * this very fixture — its own card read `sibilance,crackle` — and the probe
   * that went looking for the cause measured **0.269** of index and a **0.512**
   * de-click dose on the same construction. The chain damaged the file it was
   * asked to repair, and it did it on the strength of a statistic that has no
   * way to tell a burst from a click.
   * The statistic now asks whether the window's HF energy is a *spike* or a
   * noise process (duty: the share of the window within 10 dB of its own peak —
   * 0.002–0.02 for clicks, 0.045–0.12 for these onsets, 0.20–0.60 for noise),
   * and the two rows below are the witness: the index stays below every gate and
   * the de-click dose stays at the floor the profile uses for material with no
   * clicks. The row is kept in this section on purpose — it is the section that
   * pays for the mistake. */
  row('sibilance', 'analyser crackleIndex — sibilance is not clicks', r.m.crackleIndex, r.mo.crackleIndex,
    'before the duty gate acceptance v2aj named "crackle" on this fixture and the chain spent 0.512 of de-click dose on it · dose now ' + N(r.P.declick) + ', the floor the profile uses for material with no clicks (0.078)');
  /* ── the dose the stage was handed, and the dose it spent ─────────────────
   * The stage's amount is `0.85 · sibNeed · headroom` — the law's own reading of
   * the file, zero unless a departure was measured — and it was the last one
   * still going through the intensity curve, which took **0.830** of it at the
   * default. The row that showed a repair was unfinished was this section's own
   * re-upload: the app's export came back diagnosed `sibilance` with **0.614**
   * of dose asked for it against 0.706 on the input, i.e. the demand had fallen
   * by a sixth for a repair that had moved the bursts 2.6 dB. Measured with the
   * curve removed (probe `tools/work/sib11.js`), the same chain takes the 7 kHz
   * band of the loudest frames down **3.06 dB** instead of 2.61, the scan the
   * dose is computed from falls 5.46 → **2.61 dB** instead of 3.26, and the
   * export reads `healthy` at **0.226** — under the 0.255 where the card starts
   * naming it. The same argument the de-hisser's amount got, applied to the
   * stage that was still missing it.
   *
   * What is *not* claimed: the chain's own output still asks **0.260** on this
   * fixture — 2 % over the naming line, at a scan of 2.43 dB against the
   * 0.7–1.0 dB a clean recording reads — and a file whose bursts are closer
   * together than the stage's 140 ms hold is not repaired in its own terms at
   * all: at 4/s the scan reads 6.39 → **6.17** at the full 0.850 dose, because a
   * duck that covers the whole file moves the file's median balance as much as
   * its peak balance, and the scan is the *difference* (probe `sib14.js`; a
   * shorter hold does not help — 30 ms reads 6.25, and the delivered band move
   * shrinks with it, probe `sib15.js`). That is the next round's problem, stated
   * where it was measured. */
  row('sibilance', 'level inside the “s” bursts (dBFS)', burstBand(norm), burstBand(r.out[0], r.lat), 'a third of every burst, 33–100 ms in');
  row('sibilance', '7 kHz p95/p30 across the file (dB)', p95p30(norm), p95p30(r.out[0], r.lat),
    'sibExcess ' + N(r.m.sibExcessDb, 1) + ' → ' + N(r.mo.sibExcessDb, 1) + ' · deess ' + N(r.P.deess) + ' · ' + r.dry.issues.join(','));
  const re = U.enc(r.out, 320, U.WORK + '/accept-sibilance-320.mp3')[0];
  const rm = RSDSP.measure([re], SR);
  row('sibilance', 're-upload at 320 kbit/s → diagnosis', r.dry.issues.join(','), RP.diagnose(rm).issues.join(',') || 'healthy',
    'card ' + r.cls.id + ' → ' + RP.classify(rm).id + ' · the scan the dose is computed from ' + N(r.m.sibPeakDb)
    + ' → ' + N(r.mo.sibPeakDb) + ' dB on the chain\'s own output, which asks ' + N(RP.buildParams('auto', r.mo, 0.7).deess, 3)
    + ' (the card names `sibilance` from 0.255 up) — the export asks ' + N(RP.buildParams('auto', rm, 0.7).deess, 3) + ' and reads healthy');
  /* ── the other kind of sibilant, and why the guard above cannot just be a
   * stronger burst test ───────────────────────────────────────────────────────
   * The fixture above is *bursts*: a singer's "s" comes and goes, which is what
   * makes the peak-over-median scan the right question. This fixture is the
   * audit suite's own sibilant — a lowpassed music bed with a 5.2–9 kHz noise
   * that never leaves — and its band is already over trend in the *median*
   * frame, so the burst above that is small (measured: scan 1.98 dB where the
   * burst fixture reads 4.6–5.6). It is a sibilant nonetheless (a "s" that does
   * not stop), and the app has to keep naming it: its evidence is the sustained
   * path, unlocked by the shape test — the top end is band-limited (7 kHz above
   * 12 kHz) like a vocal, where §20's wash and organ are broadband or fall away
   * between phrases. The two rows are the counter-case to §20's two "not
   * sibilance" rows, and the second is measured by an independent meter: the
   * file's own 7 kHz band in the frames where the *input* is loudest — one frame
   * set, both columns read on it. */
  const unending = (() => {
    const base = H.normalize(H.filter(RSDSP, H.pink(SR, SEC, 0.3, 71), SR, 'lp', 4000, 0.707), 0.4);
    let z = H.filter(RSDSP, H.filter(RSDSP, H.noise(SR, SEC, 1, 75), SR, 'hp', 5200, 0.707), SR, 'lp', 9000, 0.707);
    z = H.normalize(z, 0.4);
    const env = H.songEnvelope(SR, SEC, 0.25);
    const out = Float32Array.from(base);
    for (let i = 0; i < out.length; i++) out[i] += z[i] * env[i];
    return H.normalize(out, 0.8);
  })();
  const ru = run([unending]);
  /* …and the *frames* are chosen on the input, not separately on each file:
   * sorting a de-essed file's own frames picks a different population out of it
   * (the duck flattens the distribution, so its "loudest 20 %" reaches down into
   * frames the input never had there) and the row then under-reads the very move
   * it exists to show — 2.8 → 2.9 dB where the paired meter reads 4.4 → 5.1 dB
   * on the same two renders (probe tools/work/sib11.js). */
  const loud20 = (sig, ref) => {
    const b = filt(sig, [bq('BP', 7000, 0.9)]);
    const r = filt(ref, [bq('BP', 7000, 0.9)]);
    const F = Math.round(SR * 0.01), lv = [], rv = [];
    const n = Math.min(b.length, r.length);
    for (let k = 0; k + F < n; k += F) {
      let e = 0, re = 0;
      for (let i = 0; i < F; i++) { e += b[k + i] * b[k + i]; re += r[k + i] * r[k + i]; }
      lv.push(e / F); rv.push(re / F);
    }
    const sorted = rv.slice().sort((x, y) => y - x);
    const cut = sorted[Math.max(0, Math.floor(sorted.length * 0.2) - 1)];
    let sum = 0, take = 0;
    for (let i = 0; i < lv.length; i++) if (rv[i] >= cut) { sum += lv[i]; take++; }
    return 10 * Math.log10(sum / Math.max(1, take) + 1e-20);
  };
  row('sibilance', 'a continuous “s”: scan ungated vs with the shape test (dB)', N(ru.m.sibRawDb, 2), N(ru.m.sibPeakDb, 2),
    'its median 7 kHz/2.6 kHz balance is already +2.34 dB (a singer who never stops) and the audit suite pins this file twice (deess ' + N(ru.P.deess, 3)
    + ' > 0.4, sibSustained === 1) · the two files §20 reports as *not* sibilance are the ones this path must not take: their top end is not band-limited (the wash) or their headroom moves with the phrases (the organ)');
  row('sibilance', 'a continuous “s” through the chain: 7 kHz of the loudest 20 % of frames (dBFS)',
    N(loud20(unending, unending), 1), N(loud20(ru.out[0].subarray(ru.lat), unending), 1),
    'the de-esser at dose ' + N(ru.P.deess, 3) + ' on the file that needs it — and the same chain never ducks the band on §20\'s wash and organ (tests/dsp.test.js measures both directions through the engine)');
}

mark('section 11');
/* 11 ── thin bass ────────────────────────────────────────────────────────── */
{
  let clean = bed(9000, 0.7);
  clean = H.normalize(filt(clean, [bq('HP', 200, 0.707), bq('HP', 200, 0.707)]), 0.7);
  const r = run([clean]);
  /* the row names the band the *repair* can reach: the sub synthesiser derives
   * its octave from what is there, so a file whose bottom stops at 200 Hz gets
   * energy around 100 Hz, not at 40. Measured over 40–90 the row said +1.9 dB
   * and over 60–200 it says the number below — the same repair, the band it
   * actually works in. */
  const tilt = (sig, lat) => bandSumDb(sig, 60, 200, lat) - bandSumDb(sig, 300, 900, lat);
  const low = (sig, lat) => bandSumDb(sig, 34, 58, lat);
  const only = (over) => {
    const q = Object.assign({}, r.P, { reso: 0, dehiss: 0, declick: 0, exciter: 0, air: 0, glue: 0, warmth: 0, tilt: 0, width: 0, declip: 0, hum: 0, deess: 0, band0: 0, band1: 0, band2: 0, band3: 0, band4: 0, band5: 0, sub: 0 }, over);
    const x = H.renderEx(Processor, [clean], q);
    return [x.out[0], x.latency];
  };
  const subOnly = only({ sub: r.P.sub });
  row('weak bass', '60–200 Hz vs 300–900 Hz (dB)', tilt(clean), tilt(r.out[0], r.lat),
    'bassRoll ' + N(r.m.bassRoll) + ' · sub ' + N(r.P.sub) + ' · band0 ' + N(r.P.band0) + ' · ' + r.dry.issues.join(','));
  const shelfOnly = only({ band0: r.P.band0 });
  const none = only({});
  const bands = (sig, lat) => N(bandSumDb(sig, 60, 200, lat)) + ' / ' + N(bandSumDb(sig, 300, 900, lat));
  row('weak bass', 'the same chain with every stage switched off (dB)', tilt(clean), tilt(none[0], none[1]),
    '60–200 / 300–900: ' + bands(clean) + ' → ' + bands(none[0], none[1]) + ' dBFS — this is what the always-on path does');
  row('weak bass', 'same, with only the sub synthesiser on (dB)', tilt(clean), tilt(subOnly[0], subOnly[1]),
    'sub ' + N(r.P.sub) + ' · 60–200 / 300–900: ' + bands(clean) + ' → ' + bands(subOnly[0], subOnly[1]) + ' · 34–58 Hz ' + N(low(clean)) + ' → ' + N(low(subOnly[0], subOnly[1])) + ' dBFS');
  row('weak bass', 'same, with only the 60 Hz shelf on (dB)', tilt(clean), tilt(shelfOnly[0], shelfOnly[1]),
    'band0 ' + N(r.P.band0) + ' dB · 60–200 / 300–900: ' + bands(clean) + ' → ' + bands(shelfOnly[0], shelfOnly[1]) + ' · 34–58 Hz ' + N(low(clean)) + ' → ' + N(low(shelfOnly[0], shelfOnly[1])) + ' dBFS');
  row('weak bass', 'the octave the synthesiser derives, 34–58 Hz (dBFS)', low(clean), low(r.out[0], r.lat), 'the source has nothing there');
  /* which stage is supposed to fill the bottom, measured one at a time: the
   * synthesiser generates an octave below what is there (the fixture stops at
   * 200 Hz, so its octave is 100 Hz) and the tone curve's 60 Hz shelf fills in
   * below that. If the row above moves *down*, one of them is writing where the
   * file has nothing while the other does not write at all. */

}
mark('section 12');
/* 12 ── boxy low mids ───────────────────────────────────────────────────── */
{
  const clean = bed(9000, 0.7);
  const hump = filt(clean, [bq('BP', 240, 0.55)]);
  let dirty = new Float32Array(clean.length);
  for (let i = 0; i < dirty.length; i++) dirty[i] = clean[i] + 2.4 * hump[i];
  dirty = H.normalize(dirty, 0.7);
  const r = run([dirty]);
  const humpDb = (sig, lat) => bandSumDb(sig, 180, 320, lat) - bandSumDb(sig, 600, 1200, lat);
  row('boxy mids', '180–320 Hz vs 600–1200 Hz (dB)', humpDb(dirty), humpDb(r.out[0], r.lat),
    'mudScore ' + N(r.m.mudScore) + ' · band1 ' + N(r.P.band1) + ' · band2 ' + N(r.P.band2) + ' · ' + r.dry.issues.join(','));
}
mark('section 13');
/* 13 ── dull top end ──────────────────────────────────────────────────────
 * Where the class's line sits, measured by sweeping the low-pass corner of the
 * same bed (a single pole, so the corner is the slope) and asking the app:
 *
 *   corner   19k    16k    13k    11k     9k     7k     5k
 *   dullIdx 0.00   0.02   0.05   0.12   0.22   0.37   0.62
 *   card    healthy ……………………… healthy   dullTop  dullTop
 *
 * — i.e. the flag turns on between 0.22 and 0.37, and the same sweep says what
 * the chain does with it: the 8–16 kHz band comes up 0.4 (13 kHz) … 2.7 dB
 * (5 kHz), the air dose falls with the dullness the other way (0.324 at 5 kHz,
 * 0.012 at 11 kHz, 0 at 13 kHz). A file the *card* calls dull (7 kHz corner,
 * dullIdx 0.37 → 0.22) comes out `healthy`, and a 5 kHz corner — the double-pole
 * fixture below reads the top of the scale, dullIdx 1.00 — does **not**: it comes
 * out at 0.46 with the card still saying `dullTop`. That is the synthesiser's
 * own ceiling, not a missing repair: it derives what it adds from the band below
 * the cliff and is not allowed to overtake it (`airRoom`), so a recording this
 * dull is not turned into a bright modern one — and the row prints the pair of
 * verdicts rather than only the dry one, so the reader can see which of the two
 * happened.
 * ------------------------------------------------------------------------- */
{
  const clean = bed(20000, 0.7);
  let dull = H.normalize(filt(clean, [bq('LP', 5200, 0.707), bq('LP', 5200, 0.707)]), 0.7);
  const r = run([dull]);
  const topDb = (sig, lat) => bandSumDb(sig, 9000, 15000, lat) - bandSumDb(sig, 2000, 4000, lat);
  row('dull top end', '9–15 kHz vs 2–4 kHz (dB)', topDb(dull), topDb(r.out[0], r.lat),
    'hfCutoff ' + N(r.m.hfCutoff, 0) + ' Hz · dullIndex ' + N(r.m.dullIndex) + ' → ' + N(r.mo.dullIndex)
    + ' · topLoss ' + N(r.m.topLoss) + ' → ' + N(r.mo.topLoss) + ' · air ' + N(r.P.air) + ' · airF ' + N(r.P.airF, 0)
    + ' · ' + r.dry.issues.join(',') + ' → ' + (r.wet.issues.join(',') || 'healthy')
    + ' (the synthesiser may not overtake the band it derives from — a 7 kHz corner is closed, a 5 kHz one is not)');
}
mark('section 14');
/* 14 ── harsh presence ──────────────────────────────────────────────────── */
{
  let clean = bed(9000, 0.7);
  /* a honk at 3 kHz needs +9.5 dB *relative to the programme's own slope* before
   * the analyser calls it harsh (it compares the 2–4 kHz median with the
   * 0.8–1.6 kHz one against a −3 dB/octave reference), so the fixture is a filter
   * applied twice. The top-end shelf keeps it from also reading as dull, which
   * is what a narrow 3 kHz honk does on its own. */
  for (let i = 0; i < 2; i++) clean = filt(clean, [bq('PEQ', 3000, 0.8)]);
  clean = filt(clean, [bq('PEQ', 9000, 0.5)]);
  const dirty = H.normalize(clean, 0.7);
  const r = run([dirty]);
  const harshDb = (sig, lat) => bandSumDb(sig, 2000, 4000, lat) - bandSumDb(sig, 800, 1600, lat);
  row('harsh presence', '2–4 kHz vs 0.8–1.6 kHz (dB)', harshDb(dirty), harshDb(r.out[0], r.lat),
    'harshness ' + N(r.m.harshness) + ' → ' + N(r.mo.harshness) + ' · band4 ' + N(r.P.band4) + ' · ' + r.dry.issues.join(','));
}
mark('section 15');
/* 15 ── a squashed master ───────────────────────────────────────────────── */
{
  let clean = bed(9000, 0.7);
  /* squashed the way an over-limited master is: the peaks are pulled flat, so
   * the file's own 98th percentile sits almost on its 5th — and squashed hard
   * enough that the *app* says so. A row named after a defect class has to be a
   * file the app actually scores as one, and this fixture did not: measured on
   * the fixture as it shipped (the envelope re-applied at power 0.12, then
   * tanh ×1.6), the app reads dynamicRangeDb **12.2** and the card comes back
   * "hiss". Driving the *saturation* instead is the wrong knob — 3.2 → 10.9 dB
   * "healthy", 5.0 → 9.3 dB "clipping", 7.0 → 7.7 dB "squashed,clipping" — the
   * dynamic range of an over-limited master comes from its *envelope*, not from
   * a limiter's knee, and a hard knee also writes flat tops the de-clipper's
   * plateau detector rightly names. Flattening the envelope (power 0.02) and
   * keeping the saturation mild (×2.0) is what the class is: measured, the app
   * reads **8.7 dB** and the card names `squashed` — and nothing else. */
  /* the envelope is taken out and the rest saturated, which is what an
   * over-limited master is: every 20 ms window at nearly the same level. The
   * fixture is built on its own pink bed rather than on `bed()` so that the
   * level stays flat — `bed()` carries the song envelope this class is about */
  const sq = new Float32Array(clean.length);
  const env = H.songEnvelope(SR, SEC, 0.35);
  for (let i = 0; i < sq.length; i++) sq[i] = clean[i] / Math.max(env[i], 0.02) * Math.pow(Math.max(env[i], 0.02), 0.02);
  let mean = 0;
  for (let i = 0; i < sq.length; i++) mean += sq[i];
  mean /= sq.length;
  for (let i = 0; i < sq.length; i++) sq[i] = Math.tanh((sq[i] - mean) * 2.0) / 2.0;
  const flat = H.normalize(sq, 0.88);
  const r = run([flat]);
  const crest = (sig, lat) => {
    const lv = [];
    const F = Math.round(SR * 0.02);
    for (let k = 0; k + F < sig.length; k += F) {
      let e = 0;
      for (let i = 0; i < F; i++) { const j = k + i + (lat || 0); if (j < sig.length) e += sig[j] * sig[j]; }
      lv.push(Math.sqrt(e / F));
    }
    lv.sort((a, b) => a - b);
    return 20 * Math.log10((lv[Math.floor(lv.length * 0.98)] + 1e-12) / (lv[Math.floor(lv.length * 0.05)] + 1e-12));
  };
  row('squashed master', '20 ms envelope p98 − p05 (dB)', crest(flat), crest(r.out[0], r.lat),
    'the app reads ' + N(r.m.dynamicRangeDb, 1) + ' dB (its own "squashed" line is 9) · card '
    + r.dry.issues.join(',') + ' · glue dose ' + N(r.P.glue, 2) + ' · warmth dose ' + N(r.P.warmth, 2));
}
mark('section 16');
/* 16 ── an out-of-phase bottom ──────────────────────────────────────────── */
{
  const a = bed(9000, 0.7, 0.30);
  const bIn = bed(9000, 0.7, 0.30);
  const lowB = filt(bIn, [bq('LP', 200, 0.707)]);
  const b = new Float32Array(bIn.length);
  for (let i = 0; i < b.length; i++) b[i] = bIn[i] - 1.9 * lowB[i];      // the bottom of one channel inverted
  const L = H.normalize(a, 0.62), R = H.normalize(b, 0.62);
  const r = run([L, R]);
  const lowRho = (x, y, lat) => {
    const xl = filt(lat ? x.subarray(lat) : x, [bq('LP', 200, 0.707)]);
    const yl = filt(lat ? y.subarray(lat) : y, [bq('LP', 200, 0.707)]);
    const n = Math.min(xl.length, yl.length);
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < n; i++) { sa += xl[i]; sb += yl[i]; saa += xl[i] * xl[i]; sbb += yl[i] * yl[i]; sab += xl[i] * yl[i]; }
    const cov = sab / n - (sa / n) * (sb / n);
    const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return cov / Math.sqrt(Math.max(va * vb, 1e-30));
  };
  const hpRho = (x, y, lat, f) => {
    const xl = filt(lat ? x.subarray(lat) : x, [bq('HP', f, 0.707)]);
    const yl = filt(lat ? y.subarray(lat) : y, [bq('HP', f, 0.707)]);
    const n = Math.min(xl.length, yl.length);
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < n; i++) { sa += xl[i]; sb += yl[i]; saa += xl[i] * xl[i]; sbb += yl[i] * yl[i]; sab += xl[i] * yl[i]; }
    const cov = sab / n - (sa / n) * (sb / n);
    const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return cov / Math.sqrt(Math.max(va * vb, 1e-30));
  };
  row('out-of-phase bottom', 'below-200 Hz correlation (ratio)', lowRho(L, R), lowRho(r.out[0], r.out[1], r.lat),
    'correlation ' + N(r.m.correlation) + ' → ' + N(r.mo.correlation) + ' · bassMono ' + N(r.P.bassMono) + ' · ' + r.dry.issues.join(','));
  /* the broadband number *has* to move — an inverted bottom is most of the
   * side signal — so what is checked for "the repair stayed where it belongs"
   * is the correlation above 2 kHz, where the mono-maker must not write */
  row('out-of-phase bottom', 'above-2 kHz correlation, must stay put (ratio)', hpRho(L, R, 0, 2000), hpRho(r.out[0], r.out[1], r.lat, 2000),
    'the repair may only touch the bottom');
  /* The repair has to deliver on *its own* statistic — the one the diagnosis
   * acts on — or the app goes on naming its own output for a defect it has just
   * repaired. The analysis reports the low band's correlation through a one-pole
   * at 200 Hz, the fold uses that same one-pole, and the naming line is 0.05
   * from below: the number that armed the stage has to reach the far side of it.
   * (This row is the one that found the mismatch: the fold used to be a 2-pole
   * corner at 120 Hz, which left the chain's output at −0.10 and the app naming
   * `outOfPhase` on its own export.) */
  row('out-of-phase bottom', "the app's own low-band correlation (ratio)", r.m.stereo.low, r.mo.stereo.low,
    'this number arms the stage (`phaseNeed`), ' + (r.wet.issues.join(',') || 'healthy') + ' after it');
  /* …and the case that must *not* be repaired: two channels that are simply
   * different are a wide image, not a phase fault, and its bottom reads near
   * zero — exactly the value the old need curve treated as full need, which is
   * how the mono-maker came to fold well-made wide mixes (the engine's own
   * stereo-integrity test: correlation 0.03 → 0.32). The pair is a control: the
   * app must ask for nothing here and the chain must leave the image alone. */
  const widePair = (() => {
    const env = H.songEnvelope(SR, SEC, 0.30);
    const mk = (seed, lp, norm) => {
      const s = H.filter(RSDSP, H.pink(SR, SEC, 0.40, seed), SR, 'lp', lp, 0.60);
      for (let i = 0; i < s.length; i++) s[i] *= env[i];
      return H.normalize(s, norm);
    };
    return [mk(81, 9000, 0.9), mk(82, 12000, 0.85)];
  })();
  const rw = run(widePair);
  row('out-of-phase bottom', 'a merely wide bottom — control (ratio)', RSDSP.stereoCorrelation(widePair), RSDSP.stereoCorrelation(rw.out),
    "the app's own low-band correlation " + N(rw.m.stereo.low, 3) + ' · bassMono ' + N(rw.P.bassMono, 2)
    + ' · issues ' + (rw.dry.issues.join(',') || 'healthy') + ' · the two independent meters must agree that nothing was folded');
}

mark('section 17');
/* 17 ── everything a vinyl rip brings, at once ─────────────────────────────
 * The user's own case, and the one no single-class section covers: a worn
 * record that carries *every* defect of its world at the same time — rumble,
 * mains hum, a worn top end (hiss), crackle, and a 128 kbit/s MP3 as the way
 * it arrived. The claim this section has to prove is the one from the request:
 * the chain works the defects off one after another, and *no repair undoes
 * another*. Every class therefore gets its own row and its own meter — the
 * same meters its own section uses — and the bed the record was cut from is
 * known, so each of them has ground truth.
 *
 * Measured (card `vinyl` on the input, issues `crackle,hiss,hum` — the rumble
 * is below the card's reporting line even though it is there, and 9.7 dB deep):
 *   crackle   8.51 → **−9.96 dB** over the clean bed (72/72 → 4/72 pops), the
 *             app's index 1.00 → **0.00** — under the full chain this is §1's own
 *             result** (8.40 → −10.26, 72 → 3), i.e. the de-hisser, the hum
 *             notches, the subsonic guard and the codec cost the de-clicker
 *             nothing, which is exactly the "no stage undoes another" claim;
 *   hiss      −37.76 → **−42.02 dBFS** (≥4 kHz over the 56 quiet frames), the
 *             tilt step 16.34 → **0.85 dB** — before this round the step stopped
 *             at 6.86 dB, i.e. the pauses were still left above the music's own
 *             tilt;
 *   hum       30.77 → **18.47 dB** against a non-hum bin — the 128 kbit/s
 *             arrival has already smeared the line (§3's clean case reaches
 *             1.7 dB; a lossy codec has nowhere else to put that energy);
 *   rumble    9.73 → **0.97 dB** (14–30 vs 90–110 Hz), guard 19.6 Hz;
 *   codec     the 8–16 kHz band sits 0.82 dB below the pre-encode record and
 *             comes out 1.61 dB down — the chain's own top-end work, the same
 *             direction as the loop's fixture;
 *   music     0.62 → **2.18 dB** versus the bed — the chain's tonal work is
 *             allowed to move this, and here it is by far the largest move.
 * The export is then re-encoded at 320 kbit/s and re-measured: the app now says
 * `healthy` (card general), tilt step 0.85 dB — before this round the same file
 * came back `hiss` (card cassette, step 6.86), which is the request's own
 * complaint ("I re-upload the export and the same problem is still named") and
 * the row that closes it. What the 128 kbit/s arrival leaves on the record is
 * still a floor — it is just no longer above the music's own top-end tilt.
 * ------------------------------------------------------------------------- */
{
  const clean = bed(9000, 0.62, 0.30);
  let rec = Float32Array.from(clean);
  rec = H.mix([rec, H.filter(RSDSP, H.filter(RSDSP, H.mul(H.noise(SR, SEC, 1, 12), 0.12), SR, 'lp', 35, 0.707), SR, 'lp', 35, 0.707)]);
  rec = H.mix([rec, H.tone(50, SR, SEC, 0.030), H.tone(150, SR, SEC, 0.010)]);
  rec = H.mix([rec, H.mul(H.filter(RSDSP, H.noise(SR, SEC, 1, 21), SR, 'hp', 3000, 0.6), 0.014)]);
  rec = H.normalize(H.filter(RSDSP, rec, SR, 'lp', 14000, 0.7), 0.70);
  const pops = H.addCrackle(rec, 9, 0.9, 8);
  const upload = U.enc([pops], 128, U.WORK + '/accept-worn.mp3')[0];
  const r = run([upload]);
  /* the positions the fixture wrote — against the bed, which is the ground truth */
  const at = [];
  for (let i = 2; i < pops.length - 2; i++) {
    const d = Math.abs(pops[i] - clean[i]);
    if (d > 0.25 && d > Math.abs(pops[i - 1] - clean[i - 1]) && d >= Math.abs(pops[i + 1] - clean[i + 1])) at.push(i);
  }
  const HP4 = bq('HP', 4000, 0.707), LP12 = bq('LP', 12000, 0.707);
  const ref = filt(clean, [HP4, LP12]);
  const popE = (sig, lat) => {
    const b = filt(sig, [HP4, LP12]);
    const rel = at.map((p) => { let e = 0, ec = 0;
      for (let k = -16; k <= 48; k++) { const j = p + (lat || 0) + k; if (j >= 0 && j < b.length) e += b[j] * b[j]; ec += ref[p + k] * ref[p + k]; }
      return e / Math.max(ec, 1e-20); }).sort((a, x) => x - a);
    return { med: 10 * Math.log10(rel[Math.floor(rel.length / 2)]), over: rel.filter((x) => x > 1).length };
  };
  const pe = popE(upload, 0), pw = popE(r.out[0], r.lat);
  row('worn record (all at once)', 'crackle: pop energy over the clean copy (median dB)', pe.med, pw.med,
    'pops above it: ' + pe.over + '/' + at.length + ' → ' + pw.over + '/' + at.length + ' · crackleIndex '
    + N(r.m.crackleIndex) + ' → ' + N(r.mo.crackleIndex) + ' · section 1 reads 72/72 → 3/72 under its own chain, so the rest of the chain costs the de-clicker nothing');
  const mask = quietMask(clean, 0.5);
  row('worn record (all at once)', 'hiss: ≥4 kHz RMS in the quiet (dBFS)', maskedBandDb(upload, mask, [HP4]), maskedBandDb(r.out[0], mask, [HP4], r.lat),
    'tilt step ' + N(r.m.hissTiltStepDb) + ' → ' + N(r.mo.hissTiltStepDb) + ' dB over ' + mask.filter(Boolean).length + ' quiet frames');
  const humDb = (sig, lat) => 20 * Math.log10((goertzel(lat ? sig.subarray(lat) : sig, 50) + goertzel(lat ? sig.subarray(lat) : sig, 150)) / (goertzel(lat ? sig.subarray(lat) : sig, 113) + 1e-20));
  row('worn record (all at once)', 'hum: 50 + 150 Hz vs a non-hum bin (dB)', humDb(upload, 0), humDb(r.out[0], r.lat),
    'the 128 kbit/s arrival has smeared the line (section 3\'s clean case reaches 1.7 dB)');
  row('worn record (all at once)', 'rumble: 14–30 vs 90–110 Hz (dB)',
    bandSumDb(upload, 14, 30) - bandSumDb(upload, 90, 110), bandSumDb(r.out[0], 14, 30, r.lat) - bandSumDb(r.out[0], 90, 110, r.lat),
    'guard ' + N(r.P.infraHP, 1) + ' Hz');
  row('worn record (all at once)', 'codec: 8–16 kHz vs the pre-encode record (dB)',
    bandSumDb(upload, 8000, 16000) - bandSumDb(pops, 8000, 16000), bandSumDb(r.out[0], 8000, 16000, r.lat) - bandSumDb(pops, 8000, 16000),
    'the chain\'s own top-end work, the same direction as the loop\'s fixture');
  row('worn record (all at once)', 'music: 0.8–4 kHz vs the bed (dB)',
    bandSumDb(upload, 800, 4000) - bandSumDb(clean, 800, 4000), bandSumDb(r.out[0], 800, 4000, r.lat) - bandSumDb(clean, 800, 4000),
    'the chain\'s tonal work is allowed to move this — the largest single move here');
  const re = U.enc(r.out, 320, U.WORK + '/accept-worn-320.mp3')[0];
  const rm = RSDSP.measure([re], SR);
  row('worn record (all at once)', 're-upload at 320 kbit/s → diagnosis', r.dry.issues.join(','), RP.diagnose(rm).issues.join(',') || 'healthy',
    'card ' + r.cls.id + ' → ' + RP.classify(rm).id + ' · tilt step on the export ' + N(rm.hissTiltStepDb) + ' dB — the defect the 128 kbit/s arrival left loudest does not come back: the pauses no longer sit above the music\'s own tilt (before this round: card cassette, step 6.86)');
}
mark('section 18');
/* 18 ── the modern master, hot ─────────────────────────────────────────────
 * The other world of the request: a newer song. Nothing worn about it — no
 * crackle, no rumble, no mains line — but it is *hot*: the envelope is
 * flattened (what an over-limited master is, see section 15), saturated
 * mildly, then clipped 2.0 dB below its own peak by the transfer, and it
 * arrives as a 192 kbit/s MP3. Card `general`, and the app names
 * `squashed,clipping` — both, which is the point: on this fixture the two
 * classes coexist and each has its own witness to move.
 *
 * Measured:
 *   squashed   20 ms envelope p98 − p05 12.75 → 11.63 dB, the app's own
 *              dynamicRangeDb 8.7 → 8.7. The chain does not invent dynamics
 *              back, and it does not squash further: the 1.1 dB the statistic
 *              loses is the output stage, measured — with only the ceiling
 *              removed it reads 11.86 dB, with the whole level stage off
 *              12.75 (= the input), so it is the −2 dBTP ceiling + level ride,
 *              not a compressor;
 *   clipping   flat share of the top 0.20 % → **0.02 %**, implied missing peak
 *              1.44 → 1.44 dB, evidence 0.21 → 0.02, de-clipper dose 0.68; and
 *              the tool's own counter (same-sign samples equal to 1e-4 of the
 *              peak) 6.28 → **0.00 per mille**, 618 → **0 runs**, longest
 *              36 → 0 — the plateau population is gone, measured twice. (The
 *              app's *own* longest-run reading moves little, 5 → 4 samples: it
 *              counts inside its flat-pair window, and the share and the
 *              counter are the statistics this fixture's evidence acts on.)
 *   codec      the 8–16 kHz band sits 0.35 dB below the pre-encode master and
 *              comes out 0.07 dB below it — the air synthesiser (dose 0.10,
 *              6.0 kHz) rebuilding most of what the bitrate took, inside its
 *              own ceiling;
 *   music      −0.26 → 0.37 dB versus the pre-encode master.
 * The export reads `squashed` — the clipping is gone from it, and what is left
 * is the master's own dynamics, honestly reported.
 * ------------------------------------------------------------------------- */
{
  const clean = bed(9000, 0.7, 0.35);
  const sqEnv = H.songEnvelope(SR, SEC, 0.35);
  const sq = new Float32Array(clean.length);
  for (let i = 0; i < sq.length; i++) sq[i] = clean[i] / Math.max(sqEnv[i], 0.02) * Math.pow(Math.max(sqEnv[i], 0.02), 0.02);
  let mean = 0;
  for (let i = 0; i < sq.length; i++) mean += sq[i];
  mean /= sq.length;
  for (let i = 0; i < sq.length; i++) sq[i] = Math.tanh((sq[i] - mean) * 2.0) / 2.0;
  const master = H.normalize(sq, 0.88);
  /* the transfer clips 2.0 dB below the master's own peak */
  const rail = 0.70;
  const clipped = new Float32Array(master.length);
  for (let i = 0; i < clipped.length; i++) clipped[i] = Math.max(-rail, Math.min(rail, master[i]));
  const upload = U.enc([clipped], 192, U.WORK + '/accept-modern.mp3')[0];
  const r = run([upload]);
  const crest = (sig, lat) => {
    const lv = [], F = Math.round(SR * 0.02);
    for (let k = 0; k + F < sig.length; k += F) { let e = 0;
      for (let i = 0; i < F; i++) { const j = k + i + (lat || 0); if (j < sig.length) e += sig[j] * sig[j]; }
      lv.push(Math.sqrt(e / F)); }
    lv.sort((a, b) => a - b);
    return 20 * Math.log10((lv[Math.floor(lv.length * 0.98)] + 1e-12) / (lv[Math.floor(lv.length * 0.05)] + 1e-12));
  };
  row('hot modern master', '20 ms envelope p98 − p05 (dB)', crest(upload), crest(r.out[0], r.lat),
    'the app reads ' + N(r.m.dynamicRangeDb, 1) + ' → ' + N(r.mo.dynamicRangeDb, 1) + ' dB (its own "squashed" line is 9) · card '
    + r.dry.issues.join(',') + ' → ' + (r.wet.issues.join(',') || 'healthy') + ' · it does not invent dynamics, and does not squash further');
  row('hot modern master', 'flat samples at the top, the share the diagnosis reads (%)',
    100 * r.m.clipFlatRatio, 100 * r.mo.clipFlatRatio,
    'implied missing peak ' + N(r.m.clipOvershootDb) + ' → ' + N(r.mo.clipOvershootDb) + ' dB · evidence ' + N(r.m.clipEvidence)
    + ' → ' + N(r.mo.clipEvidence) + ' · longest run ' + r.m.clipMaxRun + ' → ' + r.mo.clipMaxRun + ' samples · de-clipper dose ' + N(r.P.declip));
  const spIn = flatSpans(clipped), spOut = flatSpans(r.out[0]);
  row('hot modern master', 'flat samples, own counter (per mille of the file)', spIn.permille, spOut.permille,
    spIn.runs + ' → ' + spOut.runs + ' runs of same-sign samples equal to 1e-4 of the peak, longest ' + spIn.longest + ' → ' + spOut.longest
    + ' · the plateau population is gone, measured twice');
  row('hot modern master', 'codec: 8–16 kHz vs the pre-encode master (dB)',
    bandSumDb(upload, 8000, 16000) - bandSumDb(master, 8000, 16000), bandSumDb(r.out[0], 8000, 16000, r.lat) - bandSumDb(master, 8000, 16000),
    'the air synthesiser rebuilding what the bitrate took, inside its own ceiling (air ' + N(r.P.air) + ', airF ' + N(r.P.airF, 0) + ')');
  row('hot modern master', 'music: 0.8–4 kHz vs the pre-encode master (dB)',
    bandSumDb(upload, 800, 4000) - bandSumDb(master, 800, 4000), bandSumDb(r.out[0], 800, 4000, r.lat) - bandSumDb(master, 800, 4000), '');
  const re = U.enc(r.out, 320, U.WORK + '/accept-modern-320.mp3')[0];
  const rm = RSDSP.measure([re], SR);
  row('hot modern master', 're-upload at 320 kbit/s → diagnosis', r.dry.issues.join(','), RP.diagnose(rm).issues.join(',') || 'healthy',
    'card ' + r.cls.id + ' → ' + RP.classify(rm).id + ' — the clipping is gone from the export, and what is left is the master\'s own dynamics, honestly reported');
}

mark('section 19');
/* 19 ── the app's honesty about its own export, for every class at once ────
 * The user's own check, applied to the whole matrix instead of to the three
 * classes that had an export row: process the class's fixture, write the
 * 320 kbit/s MP3 the app would hand back, re-upload it, and compare the two
 * diagnosis lists. What this section looks for is the failure the request names
 * — a defect the chain has repaired that is *named again* on the export, i.e.
 * `the input has it, the chain's own output does not, the export does`. Codec
 * noise the encoder adds is a different thing and is reported as such (a
 * 320 kbit/s encode puts its own floor under the file; on material that arrived
 * as a 128 kbit/s MP3 the re-upload is a second generation of lossy coding).
 *
 * It covers every class *by construction*: the entry is recorded in `run()`, so
 * a class that forgets its own export row still shows up here. */
for (const e of EXPORTS) {
  /* `healthy` is a *token in the list*, not an absence of one (`diagnose`
   * pushes it when nothing else fired), so it has to be filtered out of both
   * comparisons — without this the first fixture whose export comes back
   * perfectly healthy reads "the encode itself adds healthy", and a repaired
   * defect could be "back" as `healthy`. */
  const names = (a) => a.filter((x) => x !== 'healthy');
  const back = names(e.dry).filter((x) => names(e.exp).includes(x) && !names(e.wet).includes(x));
  const codec = names(e.exp).filter((x) => !names(e.dry).includes(x) && !names(e.wet).includes(x));
  row('export honesty', e.cls + ': input → re-upload at 320 kbit/s',
    e.dry.join(',') || 'healthy', e.exp.join(',') || 'healthy',
    (back.length ? '**a repaired defect is back on the export: ' + back.join(',') + '**' : 'no repaired defect returns')
    + ' · the chain\'s own output reads ' + (e.wet.join(',') || 'healthy')
    + (codec.length ? ' · the encode itself adds ' + codec.join(',') : ''));
}

mark('section 20');
/* 20 ── a clean file is not named ────────────────────────────────────────────
 * Seventeen sections prove a repair. This one proves the *diagnosis* keeps quiet
 * about material that carries no defect of the class being measured — because
 * the chain acts on the diagnosis, a false positive is not a wrong label, it is
 * an instruction. Measured end to end, the worst of them: the crackle index read
 * **0.982** on a pattern of 24 bursts of 0.4 ms, and the 0.702 de-click dose
 * that came with it cost those bursts **13.97 dB mean / 53.32 dB worst** of
 * their peak level through the chain (the same chain with the de-clicker off:
 * 0.49 / 1.25).
 *
 * That measurement is why this section is built around what a *performance* is.
 * The fixture was written as a percussion guard — an HP-3 kHz noise burst of
 * 0.4 ms, twenty-four of them 0.33 s apart — and what it lacks is the two things
 * every real hit has: a body, and a top end that outlives the attack. Measured
 * on nine fixtures that have them (a kick+snare+hi-hat groove · a snare with a
 * 130 ms top end · a snare roll at 8/s · a hi-hat with 45 ms · a crash with
 * 800 ms · a clave · a rimshot · a stick click with a 900 Hz body · a 4 ms
 * burst with a 1200 Hz body; probe /tmp/gate5.js): **0 spike windows each**,
 * with and without a duration gate, because a window that carries a hit *with a
 * tail* is filled with the top end and fails the duty gate (0.04) before the
 * index ever looks at it. The rows below are that measurement in this tool's own
 * fixtures.
 *
 * What the burst fixture always was, and what a duration gate cost: a burst of
 * 0.4 ms with no body and no tail is a click in *every* statistic here — duty
 * 0.02–0.04, the band a pop occupies; contrast 22.8 dB; one window wide; the
 * nine fixtures above the same. Naming and repairing it is what a de-clicker is
 * for, and the guard that keeps the stage off a performance is the tail,
 * measured above. The gate that used to keep the burst out (fewer than 15 % of
 * the spike windows wider than 0.25 ms) was tuned on the harness's click model
 * — one to three samples, 5–10 samples wide at −20 dB — and it threw away the
 * click as a *file* carries it, a damped oscillation at the cartridge
 * resonance: on a 9 kHz ring, 9 per second, on the same bed, τ 0.1 / 0.3 / 0.6
 * ms reads index 1.00 / 0.89 / **0.00**, 21 % of the 0.6 ms ring's spike windows
 * being wider than the 0.25 ms bound (a ninth ring of the family, τ 1.5 ms, reads
 * 0.00 still — its ring fills the 20 ms window, so its duty sits in the band a
 * sibilant onset occupies: duty p50 0.063, 71 of its 72 windows inside 0.045–0.12
 * and 1 under the 0.04 gate, so 1 spike window and no dose — probes
 * /tmp/duty15.js and /tmp/gate5.js). That is the beta report this section now
 * carries: with
 * the gate the file read index 0.00, healthy, dose 0 — and the clicks stayed in
 * it.
 *
 * Both directions are rows below, measured twice: by the app's own index and by
 * this tool's independent time-domain meter — every click's peak in the 4–12 kHz
 * band against the same file *without* the clicks.
 * ------------------------------------------------------------------------- */
{
  const P0 = Processor;
  /* a train of 0.4 ms top-end bursts with no body and no tail: a click train by
   * every statistic this file has (see the header) — and the app now says so */
  const ticks = (() => {
    const out = Float32Array.from(bed(9000, 0.7));
    const hf = filt(H.noise(SR, SEC, 0.6, 91), [bq('HP', 3000, 0.707)]);
    for (let k = 0; k * 0.33 < SEC; k++) {
      const at = Math.round(k * 0.33 * SR);
      for (let i = 0; i < SR * 0.02 && at + i < out.length; i++) out[at + i] += 0.5 * Math.exp(-i / (SR * 0.0004)) * hf[at + i] * 3;
    }
    return H.normalize(out, 0.7);
  })();
  const r = run([ticks]);
  const cd = RSDSP.crackleDetect([ticks], SR);
  /* what the statistic said before the gate: the two terms of the old index */
  const crestAlone = 0.75 * clamp01((cd.crestP98Db - 13) / 10) + 0.25 * clamp01((cd.globalCrestDb - 13) / 10);
  row('a train of 0.4 ms bursts (no body, no tail)', 'crackle index: crest alone vs the app (0–1)', N(crestAlone, 3), N(r.m.crackleIndex, 3),
    'spikes ' + N(cd.spikeFrames, 0) + '/400 · contrast ' + N(cd.spikeContrastDb, 1) + ' dB · duration ' + N(cd.spikeWidth, 0)
    + ' samples · ' + N(100 * cd.spikeWideShare, 0) + ' % of them wider than 0.25 ms → ' + (r.dry.issues.join(',') || 'healthy')
    + ' · duty 0.02–0.04, the band a pop occupies — this is 24 clicks and the app repairs them as clicks; the three rows below are the same chain on material that is a performance');
  /* …and what the stage does to it. On a click train that repair *is* the job;
   * the guard is the tail, and the performance rows below carry it. */
  const off = H.renderEx(P0, [ticks], Object.assign({}, r.P, { declick: 0 }));
  const hitLoss = (out, lat) => {
    let sum = 0, n = 0, worst = 0;
    for (let k = 0; k * 0.33 < SEC; k++) {
      const at = Math.round(k * 0.33 * SR), j = at + (lat || 0);
      let pk = 0, pkD = 0;
      for (let i = 0; i < SR * 0.003 && j + i < out.length; i++) { const a = Math.abs(out[j + i]); if (a > pk) pk = a; }
      for (let i = 0; i < SR * 0.003 && at + i < ticks.length; i++) { const a = Math.abs(ticks[at + i]); if (a > pkD) pkD = a; }
      if (pkD > 1e-6) { const d = 20 * Math.log10(pk / pkD); sum += d; n++; if (Math.abs(d) > Math.abs(worst)) worst = d; }
    }
    return { mean: sum / Math.max(n, 1), worst };
  };
  const a = hitLoss(off.out[0], rawLat(off)), b = hitLoss(r.out[0], r.lat);
  row('a train of 0.4 ms bursts (no body, no tail)', 'burst peak level through the chain: de-click off vs on (dB)',
    N(a.mean, 2) + ' / ' + N(a.worst, 2), N(b.mean, 2) + ' / ' + N(b.worst, 2),
    'mean / worst · de-click dose ' + N(r.P.declick, 3) + ' — 24 clicks, and the stage spends its dose on them (before this round the same reading was the worst false positive in the matrix: 13.97 / 53.32 dB on a fixture the duration gate then silenced at index 0.000)');

  /* ── a performance: a body plus a top end that outlives the attack ─────── */
  const noiseBuf = (seed, hp, lp) => filt(H.noise(SR, 2 * SEC, 0.5, seed), [bq('HP', hp, 0.707), bq('LP', lp, 0.707)]);
  const hitAt = (out, at, len, atkMs, tauMs, gen) => {
    const atk = Math.max(1, SR * atkMs * 1e-3), tau = SR * tauMs * 1e-3;
    for (let i = 0; i < Math.min(len, out.length - at); i++) out[at + i] += (1 - Math.exp(-i / atk)) * Math.exp(-i / tau) * gen(i);
  };
  const bn = noiseBuf(101, 1200, 16000), bb = noiseBuf(102, 150, 400), hn = noiseBuf(103, 7000, 17000);
  const cn = noiseBuf(104, 4000, 17000);
  const kickAt = (o, at) => {
    hitAt(o, at, Math.round(SR * 0.3), 0.5, 60, (i) => Math.sin(2 * Math.PI * 55 * i / SR) * Math.exp(-i / (SR * 0.09)));
    hitAt(o, at, Math.round(SR * 0.01), 0.1, 3, (i) => 0.25 * Math.sin(2 * Math.PI * 2400 * i / SR));
  };
  const snareAt = (o, at) => {
    hitAt(o, at, Math.round(SR * 0.25), 0.3, 130, (i) => 0.55 * bn[at + i] * 3);
    hitAt(o, at, Math.round(SR * 0.2), 0.5, 70, (i) => 0.40 * bb[at + i] * 3);
  };
  const hatAt = (o, at) => hitAt(o, at, Math.round(SR * 0.2), 0.2, 45, (i) => 0.42 * hn[at + i] * 3);
  const claveAt = (o, at) => {
    hitAt(o, at, Math.round(SR * 0.15), 0.2, 32, (i) => 0.45 * Math.sin(2 * Math.PI * 2400 * i / SR));
    hitAt(o, at, Math.round(SR * 0.05), 0.1, 6, (i) => 0.20 * Math.sin(2 * Math.PI * 5200 * i / SR));
  };
  const crashAt = (o, at) => hitAt(o, at, Math.round(SR * 1.6), 3, 800, (i) => 0.30 * cn[at + i] * 3);
  const performance = (() => {
    const out = Float32Array.from(bed(9000, 0.7));
    const pos = [];
    for (let k = 0; k * 0.5 < SEC; k++) {
      const at = Math.round(k * 0.5 * SR);
      pos.push(at);
      if (k % 2 === 0) kickAt(out, at); else snareAt(out, at);
      hatAt(out, Math.round((k * 0.5 + 0.25) * SR));
      claveAt(out, Math.round((k * 0.5 + 0.125) * SR));
      if (k % 4 === 0) crashAt(out, at + 1);
    }
    return { sig: H.normalize(out, 0.8), pos };
  })();
  const rp = run([performance.sig]);
  const cp = RSDSP.crackleDetect([performance.sig], SR);
  row('a drum performance (body + 30–800 ms top end)', 'crackle index: crest alone vs the app (0–1)',
    0.75 * clamp01((cp.crestP98Db - 13) / 10) + 0.25 * clamp01((cp.globalCrestDb - 13) / 10), rp.m.crackleIndex,
    'spike windows ' + N(cp.spikeFrames, 0) + ' · contrast ' + N(cp.spikeContrastDb, 1) + ' dB · card ' + rp.cls.id
    + ' · a kick, a snare with a 130 ms top end, a hi-hat with 45 ms, a clave and a crash — a window that carries a hit with a tail is filled with the top end and never reaches the spike set, which is why the duration gate was never what protected this');
  /* Per hit, in the fixture's own order: sorting here (as this row used to)
   * pairs the k-th *smallest* peak of one render with the k-th smallest of the
   * other, which is not a comparison of hits — and reading a raw render's
   * latency as `.lat` read the off column 88 samples early. Both made this row
   * report damage the stage does not do. */
  const perfPeaks = (o, lat) => performance.pos.map((h) => {
    let pk = 0;
    const c = h + (lat || 0);
    for (let i = -Math.round(SR * 0.001); i < SR * 0.004; i++) {
      const j = c + i;
      if (j >= 0 && j < o.length) { const x = Math.abs(o[j]); if (x > pk) pk = x; }
    }
    return pk;
  });
  const medOf = (v) => { const s = v.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const offp = H.renderEx(P0, [performance.sig], Object.assign({}, rp.P, { declick: 0 }));
  const ppOn = perfPeaks(rp.out[0], rp.lat), ppOff = perfPeaks(offp.out[0], rawLat(offp));
  const pMed = 20 * Math.log10((medOf(ppOn) + 1e-12) / (medOf(ppOff) + 1e-12));
  const pWorst = Math.max.apply(null, ppOn.map((v, k) =>
    Math.abs(20 * Math.log10((v + 1e-12) / (ppOff[k] + 1e-12)))));
  row('a drum performance (body + 30–800 ms top end)', 'hit peak level through the chain: de-click off vs on (dB)',
    '0.00 / 0.00', N(pMed, 2) + ' / ' + N(pWorst, 2),
    'median / worst of ' + performance.pos.length + ' hits · de-click dose ' + N(rp.P.declick, 3)
    + ' — the same chain and the same stage as the two rows above, on material that is a performance instead of a train of clicks,'
    + ' both columns at the render\'s own latency (a raw renderEx result reports it as `latency`; this row read `lat` and measured the off render 88 samples early until this round)');

  /* ── the click as a *file* carries it: a damped ring at the cartridge resonance ── */
  const clickTrain = (() => {
    const bedSym = bed(9000, 0.7);
    const raw = Float32Array.from(bedSym);
    const rand = H.rng(7);
    const pos = [];
    const tau = SR * 0.6e-3;
    for (let k = 0; k < Math.round(9 * SEC); k++) {
      const p = Math.floor(rand() * (raw.length - 6 * tau - 4));
      pos.push(p);
      const amp = 0.55 * (0.5 + rand()) * (rand() < 0.5 ? -1 : 1);
      for (let i = 0; i < 6 * tau && p + i < raw.length; i++) raw[p + i] += amp * Math.exp(-i / tau) * Math.sin(2 * Math.PI * 9000 * i / SR);
    }
    /* the reference is the *same* file without the clicks — the bed scaled by the
     * same gain, not normalised on its own (the clicks raise the peak) */
    const g = 0.8 / H.peak(raw);
    return { sig: Float32Array.from(raw, (x) => x * g), pos, clean: Float32Array.from(bedSym, (x) => x * g) };
  })();
  const rc = run([clickTrain.sig]);
  const cc = RSDSP.crackleDetect([clickTrain.sig], SR);
  const ca = RSDSP.crackleDetect([rc.out[0]], SR);
  row('a click as a file carries it (0.6 ms ring, 9 kHz)', 'crackle index: before vs after the chain (0–1)',
    N(cc.index, 2), N(ca.index, 2),
    'spikes ' + N(cc.spikeFrames, 0) + '/400 · ' + N(cc.spikeWidth, 0) + ' samples wide · '
    + N(100 * cc.spikeWideShare, 0) + ' % of them wider than 0.25 ms · dose ' + N(rc.P.declick, 3)
    + ' · ' + (rc.dry.issues.join(',') || 'healthy') + ' → ' + (rc.wet.issues.join(',') || 'healthy')
    + ' — the duration gate this replaces read 0.00 here, named nothing and budgeted no dose');
  /* the independent meter: per click, 4–12 kHz, against the same file without clicks */
  const bandPeaks = (sig, pos, lat) => {
    const bnd = filt(sig, [bq('HP', 4000, 0.707), bq('LP', 12000, 0.707)]);
    const v = pos.map((p) => {
      let pk = 0;
      const o2 = Math.max(0, p + (lat || 0) - Math.round(SR * 0.002));
      for (let i = 0; i < SR * 0.006 && o2 + i < bnd.length; i++) { const x = Math.abs(bnd[o2 + i]); if (x > pk) pk = x; }
      return pk;
    });
    v.sort((x, y) => x - y);
    return v[v.length >> 1];
  };
  const mClean = bandPeaks(clickTrain.clean, clickTrain.pos, 0);
  const mDry = bandPeaks(clickTrain.sig, clickTrain.pos, 0);
  const mOut = bandPeaks(rc.out[0], clickTrain.pos, rc.lat);
  row('a click as a file carries it (0.6 ms ring, 9 kHz)', 'per click in 4–12 kHz vs the same file without clicks (dB)',
    N(20 * Math.log10((mDry + 1e-12) / (mClean + 1e-12)), 1), N(20 * Math.log10((mOut + 1e-12) / (mClean + 1e-12)), 1),
    'median of ' + clickTrain.pos.length + ' clicks · independent time-domain meter (this tool\'s own biquads), not the app\'s statistic — the repair need not be perfect at the loudest of them, but the population has to come back to the clean file\'s level');
  /* a hi-hat pattern: the family the duty gate already excluded */
  const hats = (() => {
    const out = Float32Array.from(bed(9000, 0.7));
    const hf = filt(H.noise(SR, SEC, 0.6, 91), [bq('HP', 3000, 0.707)]);
    for (let k = 0; k * 0.33 < SEC; k++) {
      const at = Math.round(k * 0.33 * SR);
      for (let i = 0; i < SR * 0.02 && at + i < out.length; i++) out[at + i] += 0.5 * Math.exp(-i / (SR * 0.005)) * hf[at + i] * 3;
    }
    return H.normalize(out, 0.7);
  })();
  const rh = run([hats]);
  const ch = RSDSP.crackleDetect([hats], SR);
  row('a hi-hat pattern, not crackle', 'crackle index: crest alone vs gated (0–1)',
    0.75 * clamp01((ch.crestP98Db - 13) / 10) + 0.25 * clamp01((ch.globalCrestDb - 13) / 10), rh.m.crackleIndex,
    'the burst rings 5 ms, so a window that carries it is filled with the top end — duty 0.05–0.12 against the 0.04 gate — '
    + 'and the crest factor never sees it · ' + (rh.dry.issues.join(',') || 'healthy'));
  /* a synthesizer square: real flat tops at the file's peak, and a crackle
   * reading built from 400 spike windows that stand 0 dB above the file's own
   * median crest — every window in the file is an edge */
  const square = H.normalize((() => {
    const sq = new Float32Array(SR * SEC);
    for (let i = 0; i < sq.length; i++) sq[i] = 0.5 * Math.sign(Math.sin(2 * Math.PI * 55 * i / SR));
    return sq;
  })(), 0.7);
  const squareMix = H.normalize(H.mix([bed(4000, 0.5), H.normalize((() => {
    const sq = new Float32Array(SR * SEC);
    for (let i = 0; i < sq.length; i++) sq[i] = 0.5 * Math.sign(Math.sin(2 * Math.PI * 55 * i / SR));
    return sq;
  })(), 0.5) ]), 0.7);
  const cq = RSDSP.crackleDetect([square], SR);
  const mq = RSDSP.measure([square], SR);
  const dq = RP.diagnose(mq);
  const dqm = RP.diagnose(RSDSP.measure([squareMix], SR));
  row('a square-wave bass, not crackle', 'crackle index: crest alone vs gated (0–1)',
    0.75 * clamp01((cq.crestP98Db - 13) / 10) + 0.25 * clamp01((cq.globalCrestDb - 13) / 10), mq.crackleIndex,
    'contrast ' + N(cq.spikeContrastDb, 1) + ' dB against the 6 dB gate — 400 of 400 windows are spikes, p98 ' + N(cq.crestP98Db, 1)
    + ' dB on a median of ' + N(cq.medianCrestDb, 1) + ' · ' + (dq.issues.join(',') || 'healthy'));
  row('a square-wave bass, not clipping', 'clipping evidence: floors only vs with the ceilings (0–1)',
    N(Math.min(1, (mq.clipFlatRatio || 0) / 0.004) * clamp01(((mq.clipOvershootDb || 0) - 0.6) / 2), 2), N(mq.clipEvidence || 0, 2),
    'the file is ' + N(100 * mq.clipFlatRatio, 3) + ' % flat at its own peak with an implied missing peak of ' + N(mq.clipOvershootDb, 2)
    + ' dB — a transfer that clips 0.9/0.7/0.5/0.3 of the peak measures 0.005–11.6 % and 1.65–2.04 dB (a 997 Hz tone cut 2 dB down reads 42 %, and is left alone), so the ceilings sit at 70 % and 5 dB · with the bed under it '
    + (dqm.issues.join(',') || 'healthy'));
  /* an organ: a real line at exactly the mains frequency, *played* */
  const organ = (() => {
    let s = new Float32Array(SR * SEC);
    const chords = [[220, 261.6, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 233.1, 293.7]];
    const bar = 1.5, on = 1.15;
    for (let k = 0; k * bar < SEC; k++) {
      const at = Math.round(k * bar * SR), len = Math.round(on * SR);
      for (const f of chords[k % 4]) for (let i = 0; i < len && at + i < s.length; i++) {
        const e = Math.min(1, i / (SR * 0.08)) * Math.min(1, (len - i) / (SR * 0.12));
        s[at + i] += 0.16 * e * (Math.sin(2 * Math.PI * f * i / SR) + 0.3 * Math.sin(2 * Math.PI * f * 2 * i / SR));
      }
      for (let i = 0; i < len && at + i < s.length; i++) {
        const e = Math.min(1, i / (SR * 0.06)) * Math.min(1, (len - i) / (SR * 0.15));
        for (const [k2, a2] of [[1, 1], [2, 0.4], [3, 0.25], [4, 0.15], [6, 0.08]])
          s[at + i] += 0.30 * a2 * e * Math.sin(2 * Math.PI * 50 * k2 * i / SR);
      }
    }
    const env = H.songEnvelope(SR, SEC, 0.35);
    for (let i = 0; i < s.length; i++) s[i] *= env[i];
    return H.normalize(H.mix([s, H.mul(bed(9000, 0.25), 0.5)]), 0.72);
  })();
  const ro = run([organ]);
  const lineOnly = clamp01((ro.m.humPeakDb - 3) / 6) * clamp01((ro.m.humSteady - 0.7) / 0.25) * (ro.m.humPersist === undefined ? 1 : ro.m.humPersist);
  row('an organ pedal at 50 Hz, not hum', 'hum score: line and steadiness alone vs with the slope (0–1)', N(lineOnly, 3), N(ro.m.humScore, 3),
    'the line is ' + N(ro.m.humPeakDb, 1) + ' dB above its own shoulders and steady ' + N(ro.m.humSteady, 2)
    + ' — a real mains line in every respect but one: it drops ' + N(ro.m.humFollowSlope, 2)
    + ' dB per dB with the music, and a line that follows is a note · the control stays named: the §3 fixture below reads slope '
    + '-1.00 (a constant line grows *relatively* louder as the music falls) and the sustained tone reads 0.00 · '
    + (ro.dry.issues.join(',') || 'healthy'));
  /* …and the same organ is the sibilance false positive: its 7 kHz/2.6 kHz
   * balance *crosses over* in its peak frame because the 2.6 kHz band falls
   * between the phrases, not because the 7 kHz band stands out of anything. The
   * scan now asks the peak frame's balance to be positive (the two rows are the
   * ungated number beside the gated one, so the row re-derives its own
   * before/after the way the crackle rows print "crest alone vs the app"), and
   * a file whose *median* frame is top-heavy is asked for a band-limited top end
   * before its median tilt may count as evidence — the paragraph in §10 and the
   * audit's own guards (tests/audit.test.js: "a phrased organ is not sibilance")
   * are the other half of this measurement. */
  const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const oldSibLaw = (raw, excess) => Math.max(0, raw + 2 * sstep(2, 8, excess || 0));
  const orgLaw = oldSibLaw(ro.m.sibRawDb, ro.m.sibExcessDb);
  row('a phrased organ, not sibilance', '7 kHz scan: ungated vs with the crossover test (dB)', N(ro.m.sibRawDb, 2), N(ro.m.sibPeakDb, 2),
    'the old scan alone read ' + N(orgLaw, 2) + ' dB of `sibDb` — '
    + (orgLaw > 4.2 ? 'past' : 'below') + ' the 4.2 dB full-correction point'
    + (orgLaw > 4.2 ? ', so the card named `sibilance` and the de-esser took a dose on a clean organ' : ' on this voicing (the probe fixture with full drawbar harmonics reads 5.55 — probe tools/work/sib4.js)')
    + ' · now: need ' + N(RP.demand(ro.m).sibNeed, 2)
    + ', deess ' + N(ro.P.deess, 3) + ' · card ' + (ro.dry.issues.join(',') || 'healthy'));
  const wash = (() => {
    const n = filt(H.noise(SR * SEC, 1, 1, 55), [bq('HP', 4000, 0.707)]);
    const out = Float32Array.from(bed(9000, 0.7), (x) => x * 0.6);
    for (let i = 0; i < out.length; i++) {
      const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.25 * i / SR + 1.1) * Math.sin(2 * Math.PI * 1.7 * i / SR);
      out[i] += 0.30 * env * n[i] * (1 + 0.3 * Math.sin(2 * Math.PI * 0.07 * i / SR));
    }
    return H.normalize(out, 0.8);
  })();
  const rw = run([wash]);
  row('a sustained cymbal wash, not sibilance', '7 kHz scan: ungated vs with the shape test (dB)', N(rw.m.sibRawDb, 2), N(rw.m.sibPeakDb, 2),
    'the wash is over zero *all the time* (its median frame already has 7 kHz above 2.6 kHz) and reaches 12 kHz as far as it reaches 7 — a cymbal is not band-limited, a "s" is '
    + '(probe tools/work/sib6.js: median 7 kHz/12 kHz −0.47 dB here, +2.11 on the audit\'s sibilant, +4.1…+4.8 on every burst fixture) · the old law read '
    + N(oldSibLaw(rw.m.sibRawDb, rw.m.sibExcessDb), 2) + ' dB (`sibExcessDb` ' + N(rw.m.sibExcessDb, 2) + ' of a *real* tilt) and took deess 0.61 on the material whose only property is that it is made of cymbals (probe tools/work/sib3.js, the same construction) · '
    + 'now deess ' + N(rw.P.deess, 3) + ' · card ' + (rw.dry.issues.join(',') || 'healthy'));
  /* …and the user's own loop: their export of a *clean* master may not come back
   * with a defect the encoder put in it */
  const master = bed(20000, 0.8);
  const expo = U.enc([master], 320, U.WORK + '/accept-clean-320.mp3')[0];
  const dm = RP.diagnose(RSDSP.measure([master], SR)), de = RP.diagnose(RSDSP.measure([expo], SR));
  row('a clean master, not codec', '8–16 kHz vs the pre-encode master (dB): master vs its 320 kbit/s export',
    N(bandSumDb(master, 8000, 16000) - bandSumDb(master, 8000, 16000), 2), N(bandSumDb(expo, 8000, 16000) - bandSumDb(master, 8000, 16000), 2),
    'card ' + dm.id + ' → ' + de.id + ' · issues ' + (dm.issues.join(',') || 'healthy') + ' → ' + (de.issues.join(',') || 'healthy')
    + ' — the brick wall and the noise floor the encoder adds are not defects the card names');
}

/* ── print ──────────────────────────────────────────────────────────────── */
/* ── print ──────────────────────────────────────────────────────────────── */
const W = [20, 62, 14, 14];
console.log('%s %s %s %s %s',
  'defect'.padEnd(W[0]), 'statistic'.padEnd(W[1]), 'before'.padStart(W[2]), 'after'.padStart(W[3]), 'notes');
console.log('─'.repeat(W[0] + W[1] + W[2] + W[3] + 8));
for (const [d, s, a, b, note] of ROWS) {
  const fmt = (v) => {
    if (typeof v !== 'number') return String(v);
    if (!isFinite(v)) return '-Infinity';
    if (v < -120) return 'nothing written';   // the dry file is bit-identical there
    return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
  };
  console.log('%s %s %s %s   %s', d.padEnd(W[0]), s.padEnd(W[1]), fmt(a).padStart(W[2]), fmt(b).padStart(W[3]), note);
}
console.log('\n%d rows · %d defect classes', ROWS.length, new Set(ROWS.map((r) => r[0].replace(/ \(.*/, ''))).size);
