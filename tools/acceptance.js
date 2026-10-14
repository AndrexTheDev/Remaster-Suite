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

/* ── the chain ──────────────────────────────────────────────────────────── */
function run(chans, over) {
  const m = RSDSP.measure(chans, SR);
  const cls = RP.classify(m);
  const P = Object.assign({}, RP.buildParams('auto', m, 0.7), over || {});
  const r = H.renderEx(Processor, chans, P);
  const mo = RSDSP.measure(r.out, SR);
  return { m, mo, P, cls, out: r.out, lat: r.latency, dry: RP.diagnose(m), wet: RP.diagnose(mo) };
}
const ROWS = [];
const row = (defect, stat, dry, wet, note) => ROWS.push([defect, stat, dry, wet, note || '']);
const N = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d === undefined ? 2 : d) : String(v));

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
}
mark('section 2');
/* 2 ── hiss ──────────────────────────────────────────────────────────────── */
{
  const clean = bed(9000, 0.7);
  /* The hiss has to sit where the de-hisser works (its repair band is 2.2–4 kHz,
   * keyed on ≥4 kHz): white noise at this level is mostly *below* the band the
   * row measures and the repair moved it by 1 dB. Shaped 2 kHz and up, the row
   * reads a 4 dB repair — and the analyser's own reading ("hiss") is unchanged. */
  const dirty = H.normalize(H.mix([clean, H.mul(H.filter(RSDSP, H.noise(SR, SEC, 1, 21), SR, 'hp', 2000, 0.5), 0.040)]), 0.7);
  const r = run([dirty]);
  const HP4 = bq('HP', 4000, 0.707);
  const mask = quietMask(clean, 0.5);
  row('hiss', '≥4 kHz RMS in quiet passages (dBFS)', maskedBandDb(dirty, mask, [HP4]), maskedBandDb(r.out[0], mask, [HP4], r.lat),
    'in the loud passages: ' + N(maskedBandDb(dirty, mask.map((v) => !v), [HP4]), 1) + ' → ' + N(maskedBandDb(r.out[0], mask.map((v) => !v), [HP4], r.lat), 1));
  row('hiss', 'analyser hissAmount', r.m.hissAmount, r.mo.hissAmount, r.dry.issues.join(',') + ' · dose ' + N(r.P.dehiss));
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
   * floor — and the chain brings the band from −38.1 to −67.5 dBFS, i.e. to
   * within 1.4 dB of what the bed itself does down there. (The row's note used to
   * print the rumble's own level under the words "the bed alone", which made the
   * row look 36 dB better than it was; both numbers are named now.) */
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
}
mark('section 5');
/* 5 ── clipping ──────────────────────────────────────────────────────────── */
function plateausOf(sig, rail) {
  const set = new Uint8Array(sig.length);
  const lim = rail * 0.999;
  for (let i = 0; i < sig.length; i++) if (Math.abs(sig[i]) >= lim) set[i] = 1;
  return set;
}
/** best-fit scale over the plateau samples, error against the original */
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
  row('clipping (' + tag + ')', 'error at the plateaus vs the original (dB)', dryDry, plateauError(orig, r.out[0], mask, r.lat),
    'declip ' + N(r.P.declip) + ' at plateau ' + N(db(rail), 1) + ' dBFS · best-fit scale, as in the engine test');
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
  row('sibilance', 'level inside the “s” bursts (dBFS)', burstBand(norm), burstBand(r.out[0], r.lat), 'a third of every burst, 33–100 ms in');
  row('sibilance', '7 kHz p95/p30 across the file (dB)', p95p30(norm), p95p30(r.out[0], r.lat),
    'sibExcess ' + N(r.m.sibExcessDb, 1) + ' → ' + N(r.mo.sibExcessDb, 1) + ' · deess ' + N(r.P.deess) + ' · ' + r.dry.issues.join(','));
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
/* 13 ── dull top end ────────────────────────────────────────────────────── */
{
  const clean = bed(20000, 0.7);
  let dull = H.normalize(filt(clean, [bq('LP', 5200, 0.707), bq('LP', 5200, 0.707)]), 0.7);
  const r = run([dull]);
  const topDb = (sig, lat) => bandSumDb(sig, 9000, 15000, lat) - bandSumDb(sig, 2000, 4000, lat);
  row('dull top end', '9–15 kHz vs 2–4 kHz (dB)', topDb(dull), topDb(r.out[0], r.lat),
    'hfCutoff ' + N(r.m.hfCutoff, 0) + ' Hz · dullIndex ' + N(r.m.dullIndex) + ' · topLoss ' + N(r.m.topLoss) + ' · air ' + N(r.P.air) + ' · airF ' + N(r.P.airF, 0) + ' · ' + r.dry.issues.join(','));
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
}

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
