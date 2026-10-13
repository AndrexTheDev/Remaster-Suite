'use strict';
/* The user's loop, end to end — the complaint that started this round:
 *
 *   bad file in → the app processes it → export MP3 320 → upload the export
 *   → read the problem list, and listen
 *
 * The file here is what the complaint describes: a worn record, digitised and
 * then saved as a 128 kbit/s MP3 (so it arrives with crackle, hiss, hum, rumble
 * *and* a codec wall). Every link is measured with the app's own analyser and
 * with an independent meter against the pre-degradation bed, because the two
 * can disagree and the row that matters is the one where they do.
 *
 *   node tools/workflow-check.js
 */
const U = require('./util.js');
const { H, RSDSP, SR } = U;
const RP = require('../assets/js/presets.js');
const Processor = H.loadProcessor(SR);
const SEC = 12;

function bq(type, f, q) {
  const w = 2 * Math.PI * Math.min(f, SR * 0.49) / SR;
  const c = Math.cos(w), sn = Math.sin(w), al = sn / (2 * (q || 0.707));
  const a0 = 1 + al;
  if (type === 'HP') return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  if (type === 'LP') return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  return [al / a0, 0, -al / a0, -2 * c / a0, (1 - al) / a0];
}
const filt = (x, l) => l.reduce((a, c) => RSDSP.applyBiquad(a, c), x);
const rms = (a, from, to) => {
  let e = 0, n = 0;
  for (let i = from === undefined ? 0 : from; i < (to === undefined ? a.length : to); i++) { e += a[i] * a[i]; n++; }
  return Math.sqrt(e / Math.max(1, n));
};
/* A band, through a window, per frame — the shape every row here uses.  A
 * *single* DFT bin is the one estimate that cannot be used for a noise-like
 * signal: the bin is one realisation of a noise process, so its variance is
 * ~100 % and two measurements of the same file differ by decibels. */
const hann = (N) => { const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); return w; };
const bandE = (seg, w, f1, f2) => {
  let e = 0;
  for (let f = f1; f <= f2; f += 1) {
    let re = 0, im = 0;
    for (let i = 0; i < seg.length; i++) {
      const v = seg[i] * w[i];
      re += v * Math.cos(2 * Math.PI * f * i / SR); im += v * Math.sin(2 * Math.PI * f * i / SR);
    }
    e += re * re + im * im;
  }
  return e;
};

/* ── the material ───────────────────────────────────────────────────────── *
 * Two records, because the complaint has two shapes: an old vinyl rip that was
 * saved as a lossy MP3, and a newer song that arrives as a 320 kbit/s MP3 and
 * should *not* be treated as damaged. `bed` is ground truth in both: for the
 * worn record it is the signal before it was worn, for the newer song it is the
 * file that went into the encoder. Every row is measured against it, so a row
 * that does not move is a stage that did not touch the music.
 */
function wornRecord() {
  // the bed the record was cut from
  let bed = H.filter(RSDSP, H.pink(SR, SEC, 0.40, 31), SR, 'lp', 9000, 0.55);
  const env = H.songEnvelope(SR, SEC, 0.30);
  for (let i = 0; i < bed.length; i++) bed[i] *= env[i];
  bed = H.normalize(bed, 0.62);

  // …and the record itself: crackle, rumble, hiss, a little hum, a worn top end
  let vinyl = Float32Array.from(bed);
  vinyl = H.addCrackle(vinyl, 9, 0.9, 8);
  vinyl = H.mix([vinyl, H.filter(RSDSP, H.filter(RSDSP, H.mul(H.noise(SR, SEC, 1, 12), 0.12), SR, 'lp', 35, 0.707), SR, 'lp', 35, 0.707)]);
  vinyl = H.mix([vinyl, H.mul(H.filter(RSDSP, H.noise(SR, SEC, 1, 21), SR, 'hp', 3000, 0.6), 0.014)]);
  // the mains lines have to sit *above* the turntable's own 20–40 Hz noise, or the
  // card is right to call it rumble and this row measures the wrong defect
  vinyl = H.mix([vinyl, H.tone(50, SR, SEC, 0.030), H.tone(150, SR, SEC, 0.010)]);
  vinyl = H.normalize(H.filter(RSDSP, vinyl, SR, 'lp', 14000, 0.7), 0.70);
  return { label: 'a worn record, digitised and saved as a 128 kbit/s MP3',
    bed, source: vinyl, upload: U.enc([vinyl], 128, U.WORK + '/workflow-upload.mp3')[0],
    exportName: U.WORK + '/workflow-export320.mp3' };
}

function newerSong() {
  // a modern, wide-band master: nothing wrong with it but the bitrate it arrived
  // in. It must come out of the chain *unchanged* — same level, same top end,
  // same music — and the card must not invent a defect.
  let bed = H.filter(RSDSP, H.pink(SR, SEC, 0.42, 61), SR, 'hp', 30, 0.707);
  for (let f of [180, 3200, 6400, 11000]) {
    const t = H.tone(f, SR, SEC, 0.05);
    for (let i = 0; i < bed.length; i++) bed[i] += t[i] * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.5 * i / SR));
  }
  const env2 = H.songEnvelope(SR, SEC, 0.55);
  for (let i = 0; i < bed.length; i++) bed[i] *= env2[i];
  bed = H.normalize(H.filter(RSDSP, bed, SR, 'lp', 19000, 0.7), 0.80);
  return { label: 'a newer song, delivered as a 320 kbit/s MP3',
    bed, source: bed, upload: U.enc([bed], 320, U.WORK + '/workflow-new320.mp3')[0],
    exportName: U.WORK + '/workflow-new-exp320.mp3' };
}

const SCENARIOS = { worn: wornRecord, new: newerSong };
  /* ── the app ────────────────────────────────────────────────────────────── */
function run(sc) {
  const { label, bed, source, upload } = sc;
  const m = RSDSP.measure([upload], SR);
  const cls = RP.classify(m);
  const P = RP.buildParams(cls.id, m, 0.7);
  const t0 = Date.now();
  const out = H.renderEx(Processor, [upload], P);
  const secs = (Date.now() - t0) / 1000;

  // …and the export, which is what the user gets back: MP3 320
  const exportCh = U.enc(out.out, 320, sc.exportName);
  const re = exportCh[0];
  const mOut = RSDSP.measure([re], SR);
  const dIn = RP.diagnose(m), dOut = RP.diagnose(mOut);

  /* ── the report ─────────────────────────────────────────────────────────── */
  const F = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : String(v));
  console.log('\n══ %s (%d s, %s× realtime to process) ══', label, SEC, secs.toFixed(1));

  console.log('\nwhat the app says');
  console.log('  upload     %s   (profile %s, recommended power %s)',
    (dIn.issues.join(', ') || 'healthy').padEnd(40), cls.id, RP.PRESETS[cls.id] ? RP.PRESETS[cls.id].recommended : '—');
  console.log('  re-upload  %s   (profile %s, via the %s kbit/s export)',
    (dOut.issues.join(', ') || 'healthy').padEnd(40), RP.classify(mOut).id, 320);

  console.log('\nthe defects, each against the bed the record was cut from');
  const HP4 = bq('HP', 4000, 0.707);
  // …and every row carries a control: the *source* encoded straight to 320 kbit/s
  // with no chain at all. Whatever the export and the control share is the
  // encoder's own doing, not the app's — without it a 0.5 dB drift in the quiet
  // reads like a stage when it is the MP3 that was just written.
  const ctrl = U.enc([source], 320, sc.exportName.replace('.mp3', '-control.mp3'))[0];
  const cm = RSDSP.measure([ctrl], SR);
  const row = (name, before, after, unit, control, note) => console.log('  %s %s → %s %s%s%s', name.padEnd(30),
    F(before).padStart(8), F(after).padStart(8), (unit || '').padEnd(6),
    control === undefined || control === null ? '' : ' (control ' + F(control) + ')',
    note ? ' · ' + note : '');
  // crackle: pop energy over the bed at the crackle positions
  const pos = [];
  for (let i = 2; i < upload.length - 2; i++) {
    if (i >= bed.length) break;
    const d = Math.abs(upload[i] - bed[i]);
    if (d > 0.25 && d > Math.abs(upload[i - 1] - bed[i - 1]) && d >= Math.abs(upload[i + 1] - bed[i + 1])) pos.push(i);
  }
  /* Only the positions that carry a *pop* go into the statistic. `pos` is every
   * sample where the upload deviates from the bed, and most of those are the
   * encoder's own work, not crackle: over all of them the median barely moves
   * even when every pop has been repaired (measured: 91 % of the pops repaired,
   * median −7.6 → −7.6 dB). The pops are the positions that are *loud in the pop
   * band* over the bed, and the row follows them and only them. */
  const popEnergy = (sig, lat) => {
    const b = filt(sig, [HP4, bq('LP', 12000, 0.707)]);
    const ref = filt(bed, [HP4, bq('LP', 12000, 0.707)]);
    return pos.map((p) => {
      let e = 0, ec = 0;
      for (let k = -16; k <= 48; k++) {
        const j = p + (lat || 0) + k;
        if (j >= 0 && j < b.length) e += b[j] * b[j];
        const q = p + k;
        if (q >= 0 && q < ref.length) ec += ref[q] * ref[q];
      }
      return 10 * Math.log10(e / Math.max(ec, 1e-20));
    });
  };
  const upIn = popEnergy(upload, 0);
  const pops = upIn.map((v, i) => [v, i]).filter(([v]) => v > 4).map(([, i]) => i);   // 4 dB over the bed = a pop
  const med = (a) => { const s2 = a.slice().sort((x, y) => x - y); return s2[Math.floor(s2.length / 2)]; };
  let leftRel = 0, leftAud = 0;                                    // for the closing line
  const popStat = (sig, lat) => {
    const all = popEnergy(sig, lat);
    return { med: med(pops.map((i) => all[i])), over: pops.filter((i) => all[i] > 0).length, n: pops.length };
  };
  {
    const before = popStat(upload, 0), after = popStat(re, out.latency);
    if (before.n) {
      row('crackle: pop / bed energy', before.med, after.med, 'dB');
      /* "Left above the bed" is not the same as "left audible", and on this
       * fixture the difference is the whole story: five pops still read above the
       * bed after the chain, and the loudest of them is at −64.9 dBFS in 7 kHz
       * while the music in that same second peaks at 0.005 (−46 dBFS) — a tick
       * 20 dB below anything the music does there, i.e. nothing a listener can
       * hear. So the row counts the ones that are *both* still over the bed and
       * above an audible floor, and names the loudest one's level either way. */
      const left = pops.filter((i) => popStat(re, out.latency).over > 0);
      const loud = [];
      const band7k = [bq('BP', 7000, 0.9)];
      const lvl = (sig, at, lat) => {
        const b = filt(sig.subarray(lat || 0), band7k);
        let e = 0, n = 0;
        for (let k = -16; k <= 48; k++) { const j = at + k; if (j >= 0 && j < b.length) { e += b[j] * b[j]; n++; } }
        return 20 * Math.log10(Math.sqrt(e / Math.max(n, 1)) + 1e-12);
      };
      leftRel = after.over;
      const allAfter = popEnergy(re, out.latency);
      let worst = { db: -99, at: -1, fs: -120 };
      for (const i of pops) {
        const fs = lvl(re, pos[i], out.latency);
        if (allAfter[i] > 0 && fs > -50) loud.push(i);
        if (allAfter[i] > worst.db) worst = { db: allAfter[i], at: pos[i], fs, music: lvl(bed, pos[i], 0) };
      }
      leftAud = loud.length;
      row('crackle: pops left audible', before.over + '/' + before.n, loud.length + '/' + before.n, '',
        null, 'loudest survivor ' + F(worst.db) + ' dB over the bed at ' + F(worst.fs)
        + ' dBFS in 7 kHz, where the bed itself reads ' + F(worst.music) + ' dBFS');
    } else {
      row('crackle: pops found', 0, 0, '(none — nothing to repair)');
    }
  }
  row('crackle: analyser index', m.crackleIndex, mOut.crackleIndex, '', cm.crackleIndex);
  // hum: the mains lines against their neighbours
  /* The line has to be compared with its *own* neighbourhood, not with a wide
   * band: a turntable's rumble at 30 Hz and the music's own bass sit 15 dB below
   * the mains line at 50 Hz, and measuring the line against a median over
   * 26–186 Hz (or against a single 113 Hz bin) reads 35 dB of "hum" on a file
   * whose line is 14 dB above the floor it actually has to beat. A mains line is
   * narrow: ±5 Hz is what the app compares it with, and this meter does the same
   * with its own Hann-windowed 1 s DFT, so the two can be checked against each
   * other without sharing any code. */
  const humExcess = (sig, lat) => {
    const N = Math.round(SR), x = sig.subarray(lat || 0);
    const segs = Math.floor(x.length / N);
    if (segs < 3) return { e: 0, fs: -120 };
    const perSeg = (f) => {
      const rel = [], rms = [], abs = [];
      for (let s = 0; s < segs; s++) {
        const st = s * N;
        let sum = 0, re = 0, im = 0;
        for (let i = 0; i < N; i++) {
          const v = x[st + i]; sum += v * v;
          const w = v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
          re += w * Math.cos(2 * Math.PI * f * i / SR); im += w * Math.sin(2 * Math.PI * f * i / SR);
        }
        const r = Math.sqrt(sum / N);
        const a = 4 * Math.sqrt(re * re + im * im) / N;
        rms.push(r); abs.push(a);
        rel.push(a / Math.max(r, 1e-9));
      }
      const pick = (a) => { const c = a.slice().sort((u, v) => u - v); return c[Math.floor(c.length / 2)]; };
      return { rel: 20 * Math.log10(Math.max(pick(rel), 1e-9)), fs: 20 * Math.log10(Math.max(pick(abs), 1e-12)) };
    };
    const b = {};
    for (const f of [45, 50, 55, 145, 150, 155]) b[f] = perSeg(f);
    // per line, and the *median* of the per-segment ratio — not the mean over
    // segments: this fixture's music swings 20 dB with its own envelope, so a
    // mean reports whichever passage happened to be quiet in it. Measured, the
    // same signal read 9.1 dB with a mean and 2.4 dB with the median, and only
    // the second agrees with the app's own reading of that export. An independent
    // meter is only independent if it is also not wrong.
    const e50 = b[50].rel - Math.max(b[45].rel, b[55].rel);
    const e150 = b[150].rel - Math.max(b[145].rel, b[155].rel);
    // …and the *absolute* level of the line travels with it: an excess is only a
    // hum if there is something there to hear. A modern master's own bass note at
    // 50 Hz reads a couple of dB of "excess" and is a bass note, not a line — the
    // level says which, and the source's own value says whether anything was
    // added.
    return { e: Math.max(e50, e150), fs: Math.max(b[50].fs, b[150].fs) };
  };
  {
    const hIn = humExcess(upload), hOut = humExcess(re, out.latency), hCtl = humExcess(ctrl);
    row('hum: 50/150 Hz vs ±5 Hz', hIn.e, hOut.e, 'dB',
      F(hCtl.e) + ' re-encoded · the line itself sits at ' + F(hIn.fs) + ' dBFS, source '
      + F(humExcess(source).fs) + ' dBFS');
  }
  // hiss: ≥4 kHz in the quietest third of the bed
  const F2 = Math.round(SR * 0.02), frames = Math.floor(bed.length / F2), lv = [];
  for (let k = 0; k < frames; k++) lv.push(rms(bed, k * F2, (k + 1) * F2));
  const lvMed = lv.slice().sort((a, b2) => a - b2)[Math.floor(frames / 2)];
  const mask = lv.map((v) => v < lvMed * 0.5);
  const quietHf = (sig, lat) => {
    const b = filt(sig, [HP4]);
    let e = 0, n = 0;
    for (let k = 0; k < mask.length; k++) {
      if (!mask[k]) continue;
      for (let i = k * F2; i < (k + 1) * F2; i++) { const j = i + (lat || 0); if (j < b.length) { e += b[j] * b[j]; n++; } }
    }
    return 10 * Math.log10(e / Math.max(1, n));
  };
  row('hiss: ≥4 kHz in the quiet', quietHf(upload), quietHf(re, out.latency), 'dBFS', quietHf(ctrl));
  /* rumble: 18-32 Hz against the bass band, as the *median of the per-frame
   * ratios* of two windowed bands. It used to be three unwindowed single-bin
   * DFTs (18, 25, 32 Hz) against one at 100 Hz over the whole file, and that
   * meter cannot carry the row: on this fixture the same signal's 3 s chunks of
   * that number span 11.3 dB and its half-second frames run from +6.2 to +15.2,
   * so a 3 dB move between two files is inside the meter's own noise. Measured
   * both ways on the same pair of files: single bins +3.0 dB, windowed band
   * medians +1.2 dB, and an independent 2-pole-band RMS ratio (15-45 Hz against
   * 100 Hz) +0.1 dB — the row was reading its own variance, and part of the
   * "+3 dB" was the hum repair the card had just done (the 50 Hz line sits in
   * the 40-60 Hz neighbourhood of the reference). The number is referenced to
   * the *control* as every other row is, and the frames are printed so the
   * reading can be judged. */
  const rumbleDb = (sig, lat) => {
    const x = sig.subarray(lat || 0), N = Math.round(SR * 0.5), segs = Math.floor(x.length / N);
    if (segs < 3) return 0;
    const w = hann(N), rel = [];
    for (let s = 0; s < segs; s++) {
      const seg = x.subarray(s * N, (s + 1) * N);
      const lo = bandE(seg, w, 17, 33), mid = bandE(seg, w, 95, 105);
      if (lo > 0 && mid > 0) rel.push(10 * Math.log10(lo / mid));
    }
    rel.sort((a, b) => a - b);
    return rel.length ? rel[Math.floor(rel.length / 2)] : 0;
  };
  row('rumble: 18–32 Hz vs 100 Hz', rumbleDb(upload), rumbleDb(re, out.latency), 'dB', rumbleDb(ctrl),
    'medians of ' + Math.floor(upload.length / Math.round(SR * 0.5)) + ' half-second windowed frames');
  /* The codec's own loss: the decode against the signal that went *into* the
   * encoder (not against the bed — in this band the fixture is mostly hiss, and a
   * row measured against the bed would be reading the de-hisser, not the codec). */
  const HF = [bq('HP', 8000, 0.707), bq('LP', 16000, 0.707)];
  const hfDb = (sig, lat) => 10 * Math.log10(rms(filt(sig.subarray(lat || 0), HF)) ** 2 / rms(filt(source, HF)) ** 2);
  row('codec: 8–16 kHz vs pre-encode', hfDb(upload), hfDb(re, out.latency), 'dB', hfDb(ctrl));
  // …and the chain's own footprint on the music band, level-matched: a big number
  // here would mean the chain changed the music rather than the defects
  const MB = [bq('HP', 800, 0.707), bq('LP', 4000, 0.707)];
  const mbDb = (sig, lat) => 10 * Math.log10(rms(filt(sig.subarray(lat || 0), MB)) ** 2 / rms(filt(bed, MB)) ** 2);
  row('music band 0.8–4 kHz vs bed', mbDb(upload), mbDb(re, out.latency), 'dB', mbDb(ctrl));
  console.log('\nwhat the chain was asked for: declick %s · dehiss %s · declip %s · deess %s · air %s · hum %s · infraHP %s Hz',
    F(P.declick, 2), F(P.dehiss, 2), F(P.declip, 2), F(P.deess, 2), F(P.air, 2), F(P.hum, 2), F(P.infraHP, 0));
  /* The closing line counts the same thing the row above does. It used to end
   * with "the export still has N above the bed", which reads as a defect and is
   * not one: on this fixture the survivors sit at −65 dBFS in a passage whose
   * own bed is −69, i.e. below anything the music does in that band. Both
   * numbers are printed, the absolute one first-class. */
  console.log('%d samples deviate from the bed; %d of them are pops (4 dB+). The export reads %d of those above the bed, and %d of them above it *audibly* (over the bed and over −50 dBFS in 7 kHz) — a tick at −65 dBFS against a bed at −69 is the bed, not a defect.',
    pos.length, pops.length, leftRel, leftAud);
}

for (const key of (process.argv[2] ? [process.argv[2]] : Object.keys(SCENARIOS))) {
  if (!SCENARIOS[key]) { console.log('unknown scenario %s (have: %s)', key, Object.keys(SCENARIOS).join(', ')); process.exit(1); }
  run(SCENARIOS[key]());
}
