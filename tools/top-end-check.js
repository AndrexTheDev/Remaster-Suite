'use strict';
/* Which instrument fills which hole?
 *
 * The top end is repaired by two things with very different reach: a 7 kHz
 * shelf (broad, reaches down through the "s" band) and the synthesiser (whose
 * output starts at 8.2 kHz and is derived from the band that survived just
 * below a cliff). The law decides between them from where the hole is — this
 * probe prints, per material, what was measured, what the law asked for and
 * what each band actually got.
 *
 *   node tools/top-end-check.js
 */
const U = require('./util.js');
const { H, RSDSP, SR } = U;
const RP = require('../assets/js/presets.js');
const Processor = H.loadProcessor(SR);
const SEC = 8;
function bq(type, f, q) {
  const w = 2 * Math.PI * Math.min(f, SR * 0.49) / SR;
  const c = Math.cos(w), sn = Math.sin(w), al = sn / (2 * (q || 0.707));
  const a0 = 1 + al;
  if (type === 'HP') return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  if (type === 'LP') return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  return [al / a0, 0, -al / a0, -2 * c / a0, (1 - al) / a0];
}
const filt = (x, l) => l.reduce((a, c) => RSDSP.applyBiquad(a, c), x);
const rms = (a, lat) => { let e = 0, n = 0; for (let i = lat || 0; i < a.length; i++) { e += a[i] * a[i]; n++; } return Math.sqrt(e / n); };
const band = (sig, f, lat) => 20 * Math.log10(rms(filt(sig.subarray(lat || 0), [bq('BP', f, 1.0)])) + 1e-20);
const bed = (lp) => {
  let s = H.filter(RSDSP, H.pink(SR, SEC, 0.40, 31), SR, 'lp', lp, 0.60);
  const e = H.songEnvelope(SR, SEC, 0.35);
  for (let i = 0; i < s.length; i++) s[i] *= e[i];
  return H.normalize(s, 0.7);
};
console.log('material                  cliff   asked        what 7 k / 12 k / 16 k got (dB)');
const cases = [
  ['dull LP 4 kHz', bed(4000)],
  ['medium LP 9 kHz', bed(9000)],
  ['bright (20 kHz)', bed(20000)],
  ['codec 64k (wall 15.5 k)', U.enc([bed(20000)], 64, U.WORK + '/top64.mp3')[0]],
  ['codec 32k (wall 7.3 k)', U.enc([bed(20000)], 32, U.WORK + '/top32.mp3')[0]],
];
for (const [name, sig] of cases) {
  const m = RSDSP.measure([sig], SR);
  const P = RP.buildParams(RP.classify(m).id, m, 0.7);
  const r = H.renderEx(Processor, [sig], P);
  const o = r.out[0], lat = r.latency;
  console.log('%s  cliff %s  air %s  band5 %s  | %s %s %s',
    name.padEnd(24),
    (m.cliffHz || 0).toFixed(0).padStart(5),
    P.air.toFixed(2).padStart(4), P.band5.toFixed(2).padStart(5),
    (band(o, 7000, lat) - band(sig, 7000)).toFixed(2).padStart(6),
    (band(o, 12000, lat) - band(sig, 12000)).toFixed(2).padStart(6),
    (band(o, 16000, lat) - band(sig, 16000)).toFixed(2).padStart(6));
}
console.log('\n(the 64 k wall sits above the "s" band, so the shelf is not spent there at all —' +
  '\nthe synthesiser does what little is left to do; the 32 k wall sits at 7.3 kHz and keeps it.)');
