'use strict';
/* Two acceptance fixtures whose *statistic* has to be right before the row can
 * mean anything: the hiss has to sit where the de-hisser works, and the "s"
 * bursts have to be noise, not a tone (a 7.8 kHz tone burst reads as a codec
 * cliff in the analyser, which then shows up in the row's notes as `codec`).
 */
const U = require('./util.js');
const { H, RSDSP, SR } = U;
const RP = require('../assets/js/presets.js');
const Processor = H.loadProcessor(SR);
const SEC = 8;

const bed = (lp, norm) => {
  let s = H.filter(RSDSP, H.pink(SR, SEC, 0.40, 31), SR, 'lp', lp, 0.60);
  const e = H.songEnvelope(SR, SEC, 0.35);
  for (let i = 0; i < s.length; i++) s[i] *= e[i];
  return H.normalize(s, norm);
};
function bq(type, f, q) {
  const w = 2 * Math.PI * Math.min(f, SR * 0.49) / SR;
  const c = Math.cos(w), s = Math.sin(w), al = s / (2 * (q || 0.707));
  const a0 = 1 + al;
  if (type === 'HP') return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  return [al / a0, 0, -al / a0, -2 * c / a0, (1 - al) / a0];
}
const filt = (sig, list) => list.reduce((acc, c) => RSDSP.applyBiquad(acc, c), sig);
const rms = (a, from, to) => { let e = 0, n = 0; for (let i = from === undefined ? 0 : from; i < (to === undefined ? a.length : to); i++) { e += a[i] * a[i]; n++; } return Math.sqrt(e / Math.max(1, n)); };
function quietMask(cleanSym, frac) {
  const F = Math.round(SR * 0.02), frames = Math.floor(cleanSym.length / F), lvl = [];
  for (let k = 0; k < frames; k++) lvl.push(rms(cleanSym, k * F, (k + 1) * F));
  const med = lvl.slice().sort((a, b) => a - b)[Math.floor(frames / 2)];
  const mask = [];
  for (let k = 0; k < frames; k++) mask.push(lvl[k] < med * (frac || 0.5));
  return mask;
}
function maskedBandDb(sig, mask, list, lat) {
  const b = filt(sig, list), F = Math.round(SR * 0.02);
  let e = 0, n = 0;
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    for (let i = k * F; i < (k + 1) * F; i++) { const j = i + (lat || 0); if (j < b.length) { e += b[j] * b[j]; n++; } }
  }
  return n ? 10 * Math.log10(e / n) : -120;
}
function run(chans) {
  const m = RSDSP.measure(chans, SR);
  const P = RP.buildParams('auto', m, 0.7);
  const r = H.renderEx(Processor, chans, P);
  return { m, P, out: r.out, lat: r.latency, dry: RP.diagnose(m), wet: RP.diagnose(RSDSP.measure(r.out, SR)) };
}

console.log('── hiss fixtures (the repair band is 2.2–4 kHz; the meter band ≥4 kHz) ──');
const clean = bed(9000, 0.7);
const mask = quietMask(clean, 0.5);
const HP4 = bq('HP', 4000, 0.707);
for (const [tag, noiseSig, amp] of [
  ['white 0.010', H.noise(SR, SEC, 1, 21), 0.010],
  ['white 0.020', H.noise(SR, SEC, 1, 21), 0.020],
  ['hp3k 0.020', H.filter(RSDSP, H.noise(SR, SEC, 1, 21), SR, 'hp', 3000, 0.707), 0.020],
  ['hp3k 0.030', H.filter(RSDSP, H.noise(SR, SEC, 1, 21), SR, 'hp', 3000, 0.707), 0.030],
  ['hp2k 0.040', H.filter(RSDSP, H.noise(SR, SEC, 1, 21), SR, 'hp', 2000, 0.5), 0.040],
]) {
  const dirty = H.normalize(H.mix([clean, H.mul(noiseSig, amp)]), 0.7);
  const r = run([dirty]);
  console.log('  %s  quiet ≥4k %s → %s dB   hiss %s dose %s   issues %s',
    tag.padEnd(12),
    maskedBandDb(dirty, mask, [HP4]).toFixed(2).padStart(7),
    maskedBandDb(r.out[0], mask, [HP4], r.lat).toFixed(2).padStart(7),
    (r.m.hissAmount === undefined ? '—' : r.m.hissAmount.toFixed(2)), r.P.dehiss.toFixed(2), r.dry.issues.join(','));
}

console.log('\n── sibilance fixtures (burst = a real "s" is band-limited noise) ──');
function bursts(kind, gain) {
  const dirty = Float32Array.from(clean);
  const F = Math.round(SR * 0.12);
  const nz = H.noise(SR * 0.12, 1, 1, 77);
  const shaped = filt(nz, [bq('HP', 5200, 0.707)]);
  for (let b = 0; b < 12; b++) {
    const at = Math.round(SR * (0.35 + b * 0.6));
    for (let i = 0; i < F; i++) {
      const j = at + i;
      if (j >= dirty.length) break;
      const env = Math.exp(-i / (F * 0.5)) * (1 + 0.4 * Math.sin(i * 0.7));
      dirty[j] += gain * env * (kind === 'noise' ? shaped[i] : Math.sin(2 * Math.PI * 7800 * i / SR));
    }
  }
  return H.normalize(dirty, 0.72);
}
for (const [kind, gain] of [['noise', 0.55], ['noise', 0.8], ['tone', 0.30]]) {
  const dirty = bursts(kind, gain);
  const r = run([dirty]);
  console.log('  bursts %s gain %s   sibExcess %s  sibPeak %s  deess %s  issues %s',
    kind.padEnd(5), String(gain).padEnd(4),
    (r.m.sibExcessDb === undefined ? '—' : r.m.sibExcessDb.toFixed(2)),
    (r.m.sibPeakDb === undefined ? '—' : r.m.sibPeakDb.toFixed(2)),
    r.P.deess.toFixed(2), r.dry.issues.join(','));
}
