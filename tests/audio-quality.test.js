/* Objective, reference-based regression: real worklet, no oracle restoration. */
'use strict';
const assert = require('assert/strict');
const H = require('./harness.js');
const DSP = H.loadDsp();
const SR = 48000, Processor = H.loadProcessor(SR);
let checks = 0, failures = 0;
function check(name, fn) {
  try { fn(); checks++; console.log('  ✓ ' + name); }
  catch (e) { failures++; console.error('  ✗ ' + name + ': ' + e.message); }
}
const a = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.13));
check('SI-SDR is invariant to gain and polarity', () => {
  assert(DSP.siSdr(a, Float32Array.from(a, x => -2 * x)) > 120);
});
check('orthogonal estimate has no target energy', () => {
  assert.equal(DSP.siSdr(new Float32Array([1, -1, 1, -1]), new Float32Array([1, 1, -1, -1])), -Infinity);
  // estimate = reference + equally energetic orthogonal noise: exactly 0 dB.
  assert(Math.abs(DSP.siSdr(new Float32Array([1, -1, 1, -1]), new Float32Array([2, 0, 0, -2]))) < 1e-12);
});
check('silent reference is undefined', () => assert(Number.isNaN(DSP.siSdr(new Float32Array(4), new Float32Array(4)))));
check('invalid/alignment inputs rejected', () => {
  assert.throws(() => DSP.siSdr(a, new Float32Array(1)), RangeError);
  assert.throws(() => DSP.logSpectralDistance(a, a, 100), RangeError);
  assert.throws(() => DSP.siSdr(new Float32Array([NaN]), new Float32Array([0])), RangeError);
});
check('LSD identity and symmetry', () => {
  const b = Float32Array.from(a, x => x * 0.5);
  assert.equal(DSP.logSpectralDistance(a, a), 0);
  assert(Math.abs(DSP.logSpectralDistance(a, b) - DSP.logSpectralDistance(b, a)) < 1e-10);
});
check('LSD measures a 6.02 dB amplitude change', () => {
  const impulse = new Float32Array(1024); impulse[512] = 1;
  assert(Math.abs(DSP.logSpectralDistance(impulse, Float32Array.from(impulse, x => x / 2)) - 6.020599913) < 1e-6);
});
// Multi-tone clean source, fixed seed, independently corrupted cases. No clean
// samples enter the processor. Latency and initial filter settling are excluded
// equally from input and output comparisons; no best-lag/gain fitting of output.
const clean = Float32Array.from({ length: SR * 4 }, (_, i) =>
  0.45 * Math.sin(2 * Math.PI * 440 * i / SR) +
  0.2 * Math.sin(2 * Math.PI * 997 * i / SR) +
  0.1 * Math.sin(2 * Math.PI * 2203 * i / SR));
let seed = 0x51a;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; }
const cases = [
  { name: 'Clipping', minGain: 8.5, input: Float32Array.from(clean, x => Math.max(-0.35, Math.min(0.35, x))), params: { declip: 1, declipLevel: 20 * Math.log10(0.35) } },
  { name: 'White Noise', input: Float32Array.from(clean, x => x + 0.12 * random()), params: { dehiss: 1, noiseFloor: -23, hissF: 3200 } },
  { name: 'Hum', input: Float32Array.from(clean, (x, i) => x + 0.15 * Math.sin(2 * Math.PI * 50 * i / SR)), params: { hum: 1, humHz: 50 } },
];
for (const c of cases) {
  const rendered = H.renderEx(Processor, [c.input], c.params);
  const start = SR, end = clean.length - rendered.latency;
  const reference = clean.subarray(start, end);
  const input = c.input.subarray(start, end);
  const output = rendered.out[0].subarray(start + rendered.latency, end + rendered.latency);
  const before = DSP.siSdr(reference, input), after = DSP.siSdr(reference, output);
  const lsdBefore = DSP.logSpectralDistance(reference, input), lsdAfter = DSP.logSpectralDistance(reference, output);
  console.log(`${c.name}: SI-SDR ${before.toFixed(2)} → ${after.toFixed(2)} dB; gain ${(after - before).toFixed(2)} dB; LSD ${lsdBefore.toFixed(2)} → ${lsdAfter.toFixed(2)} dB`);
  const target = c.minGain || 8;
  check(c.name + ' SI-SDR gain ≥ +' + target + ' dB', () => assert(after - before >= target, `measured ${(after - before).toFixed(2)} dB`));
}
console.log(`${failures ? 'FAILED' : 'ALL TESTS PASSED'} (${checks} passed, ${failures} failed)`);
process.exitCode = failures ? 1 : 0;
