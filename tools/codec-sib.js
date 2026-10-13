'use strict';
/* The user's own loop, measured link by link.
 *
 *   bad file in → export MP3 320 → upload the export → read the problem list
 *
 * The open complaint was that the export came back diagnosed as `sibilance`.
 * The chain's own output was the culprit: a 7 kHz air shelf (the law lifted it
 * because the top end was missing) sits in the middle of the "s" band, while
 * the hole a 64 kbit/s encoder leaves is *above* 15 kHz. This probe prints the
 * sibilance statistics on every link plus the control that says what a 320
 * encode of the untouched file reads — without that control, "the export has
 * sibilance" could just as well be "a 320 encode of a hot master has it".
 */
const U = require('./util.js');
const { H, RSDSP, SR } = U;
const RP = require('../assets/js/presets.js');
const Processor = H.loadProcessor(SR);
const SEC = 8;

function bed(lp, norm) {
  let s = H.filter(RSDSP, H.pink(SR, SEC, 0.40, 31), SR, 'lp', lp, 0.60);
  const e = H.songEnvelope(SR, SEC, 0.35);
  for (let i = 0; i < s.length; i++) s[i] *= e[i];
  return H.normalize(s, norm);
}
function bq(type, f, q) {
  const w = 2 * Math.PI * Math.min(f, SR * 0.49) / SR;
  const c = Math.cos(w), s = Math.sin(w), al = s / (2 * (q || 0.707));
  const a0 = 1 + al;
  if (type === 'HP') return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  return [al / a0, 0, -al / a0, -2 * c / a0, (1 - al) / a0];
}
const filt = (sig, list) => list.reduce((acc, c) => RSDSP.applyBiquad(acc, c), sig);
const rms = (a) => { let e = 0; for (let i = 0; i < a.length; i++) e += a[i] * a[i]; return Math.sqrt(e / a.length); };
const lv = (sig, f, q) => 20 * Math.log10(rms(filt(sig, [bq('BP', f, q || 0.8)])) + 1e-20);

const orig = bed(20000, 0.72);
const mp3 = U.enc([orig], 64, U.WORK + '/probe64.mp3')[0];
const m = RSDSP.measure([mp3], SR);
const P = RP.buildParams('auto', m, 0.7);
const outCh = H.renderEx(Processor, [mp3], P).out;
const out = outCh[0];

const re320 = U.enc(outCh, 320, U.WORK + '/probe320.mp3')[0];
const ctrl320 = U.enc([orig], 320, U.WORK + '/probe320c.mp3')[0];

const line = (tag, chans) => {
  const mm = RSDSP.measure(chans, SR);
  const d = RP.diagnose(mm);
  console.log('  %s  sibExcess %s  sibPeak %s  brickwall %s  → %s  (profile %s)',
    tag.padEnd(28),
    (mm.sibExcessDb === undefined ? '—' : mm.sibExcessDb.toFixed(2)).padStart(5),
    (mm.sibPeakDb === undefined ? '—' : mm.sibPeakDb.toFixed(2)).padStart(5),
    (mm.brickwall === undefined ? '—' : mm.brickwall.toFixed(2)).padStart(4),
    d.issues.join(',') || 'healthy', RP.classify(mm).id);
};

console.log('the chain the user sees:');
line('original (no codec)', [orig]);
line('64k input', [mp3]);
line('64k → chain output', outCh);
line('chain output → 320', [re320]);
console.log('controls (nothing to do with the chain):');
line('original → 320', [ctrl320]);
line('original → 64k', U.enc([orig], 64, U.WORK + '/probe64c.mp3'));

console.log('\nband levels (independent biquads), 64k input vs the chain output:');
for (const [tag, f] of [['mid 1.3k', 1300], ['source 4.6–7.5k', 5850], ['sib 7k', 7000], ['air 12k', 12000], ['top 16k', 16000]]) {
  console.log('  %s  in %s  out %s   Δ %s dB', tag.padEnd(16),
    lv(mp3, f).toFixed(2).padStart(7), lv(out, f).toFixed(2).padStart(7),
    (lv(out, f) - lv(mp3, f)).toFixed(2).padStart(6));
}
console.log('  %s      in %s  out %s   (pre-encode original: %s)',
  'tilt 7k/2.6k'.padEnd(16),
  (lv(mp3, 7000) - lv(mp3, 2600)).toFixed(2).padStart(6), (lv(out, 7000) - lv(out, 2600)).toFixed(2).padStart(6),
  (lv(orig, 7000) - lv(orig, 2600)).toFixed(2));
console.log('\nwhat the law asked for, and what it held back:');
console.log('  air %s  airRoom %s  airF %s Hz   band5 (7 kHz shelf) %s dB   declip %s  deess %s  dehiss %s',
  P.air.toFixed(3), P.airRoom.toFixed(2), P.airF.toFixed(0), P.band5.toFixed(2), P.declip.toFixed(2), P.deess.toFixed(2), P.dehiss.toFixed(2));
console.log('  measured on the input: brickwall %s  cliff %s Hz  topLoss %s  dullIndex %s  sibExcess %s  sibPeak %s',
  m.brickwall.toFixed(2), m.cliffHz.toFixed(0), (m.topLoss || 0).toFixed(3), (m.dullIndex || 0).toFixed(3),
  (m.sibExcessDb || 0).toFixed(2), (m.sibPeakDb || 0).toFixed(2));
