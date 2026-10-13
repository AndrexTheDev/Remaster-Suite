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
const goertzel = (sig, f) => {
  const w = 2 * Math.PI * f / SR;
  let re = 0, im = 0;
  for (let i = 0; i < sig.length; i++) { re += sig[i] * Math.cos(w * i); im += sig[i] * Math.sin(w * i); }
  return 2 * Math.sqrt(re * re + im * im) / sig.length;
};

/* ── the material ───────────────────────────────────────────────────────── */
// the bed the record was cut from (ground truth: what the faults are measured against)
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

// …uploaded as a 128 kbit/s MP3
const upload = U.enc([vinyl], 128, U.WORK + '/workflow-upload.mp3')[0];

/* ── the app ────────────────────────────────────────────────────────────── */
const m = RSDSP.measure([upload], SR);
const cls = RP.classify(m);
const P = RP.buildParams(cls.id, m, 0.7);
const t0 = Date.now();
const out = H.renderEx(Processor, [upload], P);
const secs = (Date.now() - t0) / 1000;

// …and the export, which is what the user gets back: MP3 320
const exportCh = U.enc(out.out, 320, U.WORK + '/workflow-export320.mp3');
const re = exportCh[0];
const mOut = RSDSP.measure([re], SR);
const dIn = RP.diagnose(m), dOut = RP.diagnose(mOut);

/* ── the report ─────────────────────────────────────────────────────────── */
const F = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : String(v));
console.log('material: a worn record digitised and saved as a 128 kbit/s MP3 (%d s, %.1f× realtime to process)', SEC, secs);

console.log('\nwhat the app says');
console.log('  upload     %s   (profile %s, recommended power %s)',
  (dIn.issues.join(', ') || 'healthy').padEnd(40), cls.id, RP.PRESETS[cls.id] ? RP.PRESETS[cls.id].recommended : '—');
console.log('  re-upload  %s   (profile %s, via the %s kbit/s export)',
  (dOut.issues.join(', ') || 'healthy').padEnd(40), RP.classify(mOut).id, 320);

console.log('\nthe defects, each against the bed the record was cut from');
const HP4 = bq('HP', 4000, 0.707);
const row = (name, before, after, unit) => console.log('  %s %s → %s %s', name.padEnd(30), F(before).padStart(8), F(after).padStart(8), unit || '');
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
const popStat = (sig, lat) => {
  const all = popEnergy(sig, lat);
  return { med: med(pops.map((i) => all[i])), over: pops.filter((i) => all[i] > 0).length, n: pops.length };
};
{
  const before = popStat(upload, 0), after = popStat(re, out.latency);
  row('crackle: pop / bed energy', before.med, after.med, 'dB');
  row('crackle: pops left above bed', before.over + '/' + before.n, after.over + '/' + after.n, '');
}
row('crackle: analyser index', m.crackleIndex, mOut.crackleIndex, '');
// hum: the mains lines against their neighbours
const humDb = (sig, lat) => {
  const x = sig.subarray(lat || 0);
  return 20 * Math.log10((goertzel(x, 50) + goertzel(x, 150)) / (goertzel(x, 113) + 1e-20));
};
row('hum: 50 + 150 Hz vs 113 Hz', humDb(upload), humDb(re, out.latency), 'dB');
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
row('hiss: ≥4 kHz in the quiet', quietHf(upload), quietHf(re, out.latency), 'dBFS');
// rumble: below 35 Hz against the bass band
const rumbleDb = (sig, lat) => {
  const x = sig.subarray(lat || 0);
  return 10 * Math.log10((goertzel(x, 18) ** 2 + goertzel(x, 25) ** 2 + goertzel(x, 32) ** 2) / (goertzel(x, 100) ** 2 + 1e-20));
};
row('rumble: 18–32 Hz vs 100 Hz', rumbleDb(upload), rumbleDb(re, out.latency), 'dB');
/* The codec's own loss: the decode against the signal that went *into* the
 * encoder (not against the bed — in this band the fixture is mostly hiss, and a
 * row measured against the bed would be reading the de-hisser, not the codec). */
const HF = [bq('HP', 8000, 0.707), bq('LP', 16000, 0.707)];
const hfDb = (sig, lat) => 10 * Math.log10(rms(filt(sig.subarray(lat || 0), HF)) ** 2 / rms(filt(vinyl, HF)) ** 2);
row('codec: 8–16 kHz vs pre-encode', hfDb(upload), hfDb(re, out.latency), 'dB');
// …and the chain's own footprint on the music band, level-matched: a big number
// here would mean the chain changed the music rather than the defects
const MB = [bq('HP', 800, 0.707), bq('LP', 4000, 0.707)];
const mbDb = (sig, lat) => 10 * Math.log10(rms(filt(sig.subarray(lat || 0), MB)) ** 2 / rms(filt(bed, MB)) ** 2);
row('music band 0.8–4 kHz vs bed', mbDb(upload), mbDb(re, out.latency), 'dB');
console.log('\nwhat the chain was asked for: declick %s · dehiss %s · declip %s · deess %s · air %s · hum %s · infraHP %s Hz',
  F(P.declick, 2), F(P.dehiss, 2), F(P.declip, 2), F(P.deess, 2), F(P.air, 2), F(P.hum, 2), F(P.infraHP, 0));
console.log('%d samples deviate from the bed; %d of them are pops (4 dB+), and the export still has %d of those above the bed',
  pos.length, pops.length, popStat(re, out.latency).over);
