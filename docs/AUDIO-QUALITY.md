# Prompt 5.1 — measured results and open acceptance criteria

Status: **de-clipping follow-up passes its reference gates; white-noise acceptance is still NOT met.**

## Reproduction

```sh
npm install
node tests/audio-quality.test.js       # currently exit 1: white noise still fails
node tests/encoding-batch.test.js      # real Chromium; optional @sparticuz/chromium required
```

The quality test runs the production AudioWorklet through the repository's Node
harness, not a fitted/oracle restoration. It uses a four-second, 48 kHz mono
three-tone clean reference (440, 997, 2203 Hz), deterministic seeded white noise,
hard clipping at ±0.35, and a separate 50 Hz hum case. Parameters explicitly
engage the corresponding repair. The first second of filter settling and the
processor's declared latency are excluded equally from both comparisons.
The test does not search for an optimal lag or hand the clean reference to the
restorer. The neural model is not available in this Node harness; these results
are the existing DSP route, not an assertion about neural restoration.

## Objective quality

| Corruption | Input SI-SDR | Output SI-SDR | Gain | LSD input → output | ≥ +8 dB |
|---|---:|---:|---:|---:|---|
| Clipping (AR/Hermite upgrade) | 12.45 dB | 39.61 dB | +27.17 dB | 65.58 → 47.08 dB | PASS (also ≥8.5 dB) |
| White noise | 14.18 dB | 14.17 dB | −0.01 dB | 88.13 → 88.13 dB | **FAIL** |
| Hum | 10.50 dB | 22.10 dB | +11.60 dB | 4.01 → 0.99 dB | PASS |

Six metric checks and two restoration checks pass: **8/9**. The suite still
exits nonzero because white noise misses +8 dB. Clipping is now repaired by the
AR/Hermite follow-up; its acceptance threshold was **raised** to +8.5 dB and the
original source/corruption/reference were not changed. The previous implementation
measured only +2.51 dB. See `DECLIPPING-AR.md` and `tests/declip-ar.test.js` for
43 focused checks and fifteen gain fixtures at 32–96 kHz (all above +8.5 dB).

This is not proof of general restoration quality. The high-frequency de-hisser
still does not remove broadband in-band white noise; that needs better denoising
and a broader speech/music corpus, not a weaker metric or threshold.

`siSdr(reference, estimate)` subtracts each signal's mean, computes
`alpha = dot(estimate, reference) / dot(reference, reference)`, then returns
`10 log10(energy(alpha * reference) / energy(estimate - alpha * reference))`.
An all-constant reference gives NaN, a perfect nonzero reconstruction +Infinity,
and a zero/orthogonal estimate −Infinity. Inputs must be finite and aligned.

LSD is the mean frame-wise RMS difference of log-power spectra (dB): periodic
Hann window, 1024-point FFT by default, 50% overlap, one-sided bins including DC
and Nyquist, window-energy normalization, 1e-12 absolute power floor, final frame
zero-padded. It is symmetric, but **not** gain invariant. A clean-reference LSD
measures error; processed-vs-original LSD only measures change. Sparse-tone LSD
is sensitive to the stated floor; its large noise-case values are not perceptual
scores. Known analytic 0 dB SI-SDR and 6.0206 dB LSD cases guard the formulas.

## Encoding and responsiveness

The browser test launches ten concurrent 30-second stereo, 44.1 kHz MP3 jobs at
192 kbps through the real production WASM worker pool. Every MP3 is decoded by
Web Audio and checked for duration, channel count and audible RMS. It then writes
ten 16-bit WAV files through the yielding streaming API. Input buffers must stay
usable for A/B. The test observes requestAnimationFrame intervals and UI-thread
long tasks throughout encoding, decode checks and WAV packing. PCM fixture
construction happens before measurement.

Latest isolated run: Chromium 153.0.8010.0, **two actual encoding workers**,
342 frame intervals, mean **60.00 FPS**, p95/max **16.67 ms**, **zero intervals
above 20 ms**, **zero long tasks**. Each MP3 is 720,979 bytes; total WAV output
52,920,440 bytes. The browser's hardwareConcurrency *hint* is explicitly overridden
to four via CDP to exercise the two-worker branch; this does not allocate or claim
four physical CPUs. The normal two-core sandbox hint was also tested and used one
worker, as designed. Machine-readable results: `ENCODING-BATCH-RESULT.json`.

This is a headless Chromium **encoding benchmark**, not proof that every device,
iOS Safari, or the full decode/restoration/UI workflow sustains 60 FPS. The check
fails for mean FPS below 59 or any frame gap above 20 ms; scheduler contention can
legitimately make it fail on another run. Physical-device validation remains open.

## Implementation

* Local, unmodified `wasm-media-encoders@0.7.0` LAME WASM; no CDN required.
* Pool size `max(1, min(2, hardwareConcurrency - 1))`. Exclusive file leases,
  persistent WASM heaps reused only after finalization, FIFO waiting callers.
* Normalized Float32 PCM transferred in owned 16K-frame copies. No full-file
  PCM conversion to Int16, and source buffers are never transferred away.
* Sink backpressure, worker init/chunk error and message-error handling, 30-second
  response timeouts, failed-worker disposal. No mainthread encoder fallback.
* Streaming clients must finish or abort; the chunked app aborts its lease when
  rendering/sink writes fail. Whole-file encoding releases in error paths too.
* Both app WAV paths use yielding 16K-frame streaming writes. The synchronous
  low-level `encodeWav` utility remains for compatibility/fixtures.
* jsdom/Node integration tests now use worker_threads to execute the unmodified
  worker and real WASM, rather than restoring a mainthread fallback for tests.

See `assets/vendor/NOTICE.md` for wrapper/LAME licensing and source/build links.

## Regression validation from the initial encoding change

The twelve pre-existing suites were executed individually after adapting the
export integrations to real WASM workers: **1240 checks pass** (chunked-render
53 → 57 adds sink failure, replacement, abort, and no-worker rejection).
`node scripts/validate-docs.js`: 19/19; static analysis: zero defects,
zero unreferenced declarations across 17 production files.
The old fixed 300 ms jsdom Magic Fix wait was replaced with a bounded wait for
completion, since cold WASM initialization is genuinely asynchronous.

The original `npm test` aggregate run exposed stale lamejs-specific audit and
mobile timing assumptions, which were then fixed and re-run. No successful
aggregate `npm test` is claimed: its new final quality gate remains red by design
until the remaining white-noise restoration failure is addressed. The older full beta/UI
screenshot suite was not re-run for this change. Historical true-peak-margin
measurements were made with lamejs; the tooling now uses the production WASM
codec, but that full corpus should be requalified before release.

The subsequent de-clipping change completed the full fifteen-suite `npm test`
chain: **1296 passed / 1 failed**, solely the remaining white-noise gate. See
`DECLIPPING-AR.md` for the changed AudioWorklet and focused 43-check acceptance.
