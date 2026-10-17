/* AR/Hermite de-clipping acceptance. Real worklet, no clean-reference oracle. */
'use strict';
const assert = require('assert/strict');
const H = require('./harness.js');
const DSP = H.loadDsp();
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.error('  ✗ ' + name + ': ' + err.message); }
}
function material(sr, frequencies, amplitudes, seconds = 3) {
  return Float32Array.from({ length: sr * seconds }, (_, i) => frequencies.reduce(
    (sum, f, j) => sum + amplitudes[j] * Math.sin(2 * Math.PI * f * i / sr), 0));
}
function clipped(source, rail) { return Float32Array.from(source, x => Math.max(-rail, Math.min(rail, x))); }
function finitePeak(samples) {
  let peak = 0;
  for (const x of samples) { assert(Number.isFinite(x)); peak = Math.max(peak, Math.abs(x)); }
  return peak;
}
const results = [];
for (const sr of [32000, 44100, 48000, 96000]) for (const frequencies of [[440, 997, 2203], [330, 880, 1760], [220, 660, 1540]]) {
  const clean = material(sr, frequencies, [.45, .2, .1]);
  const damaged = clipped(clean, .35);
  const rendered = H.renderEx(H.loadProcessor(sr), [damaged], { declip: 1, declipLevel: 20 * Math.log10(.35) });
  const end = clean.length - rendered.latency;
  const reference = clean.subarray(sr, end), before = damaged.subarray(sr, end);
  const after = rendered.out[0].subarray(sr + rendered.latency, end + rendered.latency);
  const gain = DSP.siSdr(reference, after) - DSP.siSdr(reference, before);
  results.push({ fixture: frequencies.join('/'), sr, gain });
  check(sr + ' Hz ' + frequencies.join('/') + ': gains >8.5 dB', () => assert(gain > 8.5, gain.toFixed(3) + ' dB'));
  check(sr + ' Hz: no non-finite values or secondary sample clipping', () => assert(finitePeak(rendered.out[0]) < 1));
}
{
  const sr = 48000, rail = .25, clean = material(sr, [440, 997, 2203], [.45, .2, .1]), damaged = clipped(clean, rail);
  const rendered = H.renderEx(H.loadProcessor(sr), [damaged], { declip: 1, declipLevel: 20 * Math.log10(rail) });
  const end = clean.length - rendered.latency, reference = clean.subarray(sr, end);
  const gain = DSP.siSdr(reference, rendered.out[0].subarray(sr + rendered.latency, end + rendered.latency))
    - DSP.siSdr(reference, damaged.subarray(sr, end));
  results.push({ fixture: 'deep clipping at +/-0.25', sr, gain });
  check('deeper clipping at +/-0.25: gains >8.5 dB', () => assert(gain > 8.5, gain.toFixed(3) + ' dB'));
  check('deeper clipping: bounded, finite output', () => assert(finitePeak(rendered.out[0]) < 1));
}
for (const autoLevel of [0, 1]) {
  const sr = 48000, clean = material(sr, [997], [1.25]), damaged = clipped(clean, .99);
  const rendered = H.renderEx(H.loadProcessor(sr), [damaged], { declip: 1, declipLevel: 20 * Math.log10(.99), autoLevel });
  const end = clean.length - rendered.latency, reference = clean.subarray(sr, end);
  const gain = DSP.siSdr(reference, rendered.out[0].subarray(sr + rendered.latency, end + rendered.latency))
    - DSP.siSdr(reference, damaged.subarray(sr, end));
  results.push({ fixture: 'hot sine; autoLevel=' + autoLevel, sr, gain });
  check('headroom with autoLevel=' + autoLevel + ': >8.5 dB shape gain', () => assert(gain > 8.5, gain.toFixed(3) + ' dB'));
  check('headroom with autoLevel=' + autoLevel + ': attenuates without re-clipping', () => assert(finitePeak(rendered.out[0]) < 1));
}
const sr = 48000, Processor = H.loadProcessor(sr);
const stage = new Processor({ processorOptions: { channels: 1 } }).chains[0].declip;
check('Hermite bridge exactly meets both observed endpoint values', () => {
  assert.equal(stage.hermiteBridge(0, .2, .3, .01, -.02, 20), .2);
  assert(Math.abs(stage.hermiteBridge(1, .2, .3, .01, -.02, 20) - .3) < 1e-15);
});
check('Hermite bridge matches both boundary derivatives (finite-difference verification)', () => {
  const f = t => stage.hermiteBridge(t, .2, .3, .01, -.02, 20), eps = 1e-6;
  assert(Math.abs((f(eps) - f(0)) / (eps * 20) - .01) < 1e-7);
  assert(Math.abs((f(1) - f(1 - eps)) / (eps * 20) + .02) < 1e-7);
});
check('AR residual blend also preserves endpoint values and first derivatives', () => {
  const f = t => stage.shortBridge(t, .2, .3, .01, -.02, 20, .7 + Math.sin(t));
  const eps = 1e-5;
  assert.equal(f(0), .2); assert(Math.abs(f(1) - .3) < 1e-15);
  assert(Math.abs((-3 * f(0) + 4 * f(eps) - f(2 * eps)) / (2 * eps * 20) - .01) < 1e-6);
  assert(Math.abs((3 * f(1) - 4 * f(1 - eps) + f(1 - 2 * eps)) / (2 * eps * 20) + .02) < 1e-6);
});
// Inspect only the real stage's accepted writes. No reference signal is supplied
// to reconstruction; the clean reference is used exclusively by the evaluator.
let accepted = 0, strict = true;
const originalRepair = stage.repairShortAR.bind(stage);
stage.repairShortAR = () => {
  const ok = originalRepair();
  if (ok) {
    accepted++;
    for (let k = 0; k < stage.cbarLen; k++) {
      const index = (stage.cbarStart + k) % stage.ring.length;
      if (Math.abs(stage.source[index]) >= stage.cbarPeak * (1 - 1e-5))
        strict = strict && Math.abs(stage.ring[index]) > stage.cbarPeak;
    }
  }
  return ok;
};
const clean = material(sr, [440, 997, 2203], [.45, .2, .1], 2), damaged = clipped(clean, .35);
const restored = new Float32Array(damaged.length);
for (let i = 0; i < damaged.length + stage.look; i++) {
  const value = stage.tick(i < damaged.length ? damaged[i] : 0, 1, .35);
  if (i >= stage.look) restored[i - stage.look] = value;
}
check('short plateaus actually use LPC/AR rather than only the old fallback', () => assert(accepted > 500, accepted + ' accepted repairs'));
check('accepted reconstructed samples are strictly above the signed clip rail', () => assert(strict));
check('unclipped observations remain unchanged by the reconstruction stage', () => {
  for (let i = 0; i < damaged.length; i++) if (Math.abs(damaged[i]) < .35 - 1e-6)
    assert(Math.abs(restored[i] - damaged[i]) < 1e-7, 'modified clean observation ' + i);
});
check('the raw stage itself restores peak energy (not an evaluator gain trick)', () => {
  assert(finitePeak(restored) > .6);
  const reference = clean.subarray(sr), before = damaged.subarray(sr), after = restored.subarray(sr);
  assert(DSP.siSdr(reference, after) - DSP.siSdr(reference, before) > 8.5);
});
check('masked LPC never learns saturated observations or earlier reconstruction writes', () => {
  stage.shortContextN = 512; stage.postN = 128; stage.shortFitThreshold = .35;
  for (let i = 0; i < 512; i++) stage.shortContext[i] = .2 * Math.sin(i * .13) + .05 * Math.sin(i * .3);
  for (let i = 0; i < 128; i++) stage.post[i] = .2 * Math.sin((i + 530) * .13) + .05 * Math.sin((i + 530) * .3);
  stage.shortContext.fill(.35, 200, 206); stage.post.fill(-.35, 50, 55);
  assert(stage.fitShortAR(.35));
  const coef = Array.from(stage.shortCoef);
  stage.ring.fill(32); stage.shortContext.fill(4, 200, 206); stage.post.fill(-4, 50, 55);
  assert(stage.fitShortAR(.35));
  assert.deepEqual(Array.from(stage.shortCoef), coef);
});
check('LPC refuses insufficient or fully saturated training contexts', () => {
  stage.shortContextN = 512; stage.shortContext.fill(.35); stage.postN = 128; stage.post.fill(-.35);
  stage.shortFitThreshold = .35;
  assert.equal(stage.fitShortAR(.35), false);
  stage.shortContextN = 4; stage.postN = 4;
  assert.equal(stage.fitShortAR(.35), false);
});
check('LPC refuses unpredictable broadband noise instead of inventing a crest', () => {
  let seed = 123;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 4294967296 - .5) * .4; };
  stage.shortContextN = 512; stage.postN = 128;
  for (let i = 0; i < 512; i++) stage.shortContext[i] = next();
  for (let i = 0; i < 128; i++) stage.post[i] = next();
  assert.equal(stage.fitShortAR(.35), false);
});
check('reset clears source observations, pending reconstruction and held headroom', () => {
  stage.reset();
  assert.equal(stage.cbarPending, false); assert.equal(stage.cbarShort, false);
  assert.equal(stage.shortContextN, 0); assert.equal(stage.restoredPeak, 0);
  assert(stage.source.every(x => x === 0)); assert(stage.shortContext.every(x => x === 0));
});
check('disabled stage is sample-exact and has no delayed state advance', () => {
  for (const x of damaged.subarray(0, 128)) assert.equal(stage.tick(x, 0, .35), x);
  assert.equal(stage.pos, 0);
});
check('stereo-linked headroom preserves exact opposite-polarity channels', () => {
  const hot = clipped(material(sr, [997], [1.25], 2), .99);
  const result = H.renderEx(Processor, [hot, Float32Array.from(hot, x => -x)],
    { declip: 1, declipLevel: 20 * Math.log10(.99), autoLevel: 0 });
  for (let i = 0; i < hot.length; i++) assert(Math.abs(result.out[0][i] + result.out[1][i]) < 1e-6);
  assert(finitePeak(result.out[0]) < 1); assert(finitePeak(result.out[1]) < 1);
});
console.log('\nSI-SDR gains (known-clean reference; first second and declared latency excluded):');
for (const row of results) console.log(`  ${row.sr} Hz · ${row.fixture}: +${row.gain.toFixed(2)} dB`);
console.log(failed ? `${failed} FAILED / ${passed} passed` : `ALL TESTS PASSED (${passed})`);
process.exitCode = failed ? 1 : 0;
