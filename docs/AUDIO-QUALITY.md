# Prompt 5.1 — measured results and open acceptance criteria

Status: **5.1A reference quality passes (9/9); 5.1B and 5.2 full-workflow acceptance remain open.**

## Reproduction

```sh
npm install
node tests/audio-quality.test.js       # exit 0: 9/9, unchanged reference/thresholds
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
| White noise (STFT Wiener) | 14.18 dB | 28.82 dB | +14.64 dB | 88.07 → 70.89 dB | PASS |
| Hum | 10.50 dB | 22.10 dB | +11.60 dB | 4.01 → 0.99 dB | PASS |

Six metric checks and all three restoration checks pass: **9/9**, exit 0.
The source, corruptions, reference and thresholds are unchanged. Acceptance uses
only the processor's declared delay, never a best-lag search. AR/Hermite clipping
retains +27.17 dB; see `DECLIPPING-AR.md` for its 43 focused checks.

## Adaptive broadband DSP (5.1A)

`RSDSP.SpectralWiener` is shared by the worklet and the offline
`denoiseWiener(channels, sr, options)` utility. The engine loads `dsp-utils.js`
into each AudioWorklet scope before loading the processor. FFT 1024, hop 256,
periodic Hann analysis/synthesis, inverse FFT and normalized overlap-add add
exactly **1024 samples** of engaged latency. Disabled operation is undelayed.

Eight rotating 16-hop minimum-statistics buckets track the smoothed noisy power
spectrum. A nine-bin robust spectral median excludes narrow stationary tones;
minimum-statistics bias compensation and an optional independent measured RMS
prior constrain the estimate. Partial startup windows cannot depress minimum
statistics. Decision-directed a-priori SNR uses alpha .98, the previous clean
power estimate and current posterior SNR. Wiener gain is xi/(1+xi), with a
configurable default **−18 dB** floor and wet amount. Storage is preallocated;
no frame-sized allocations happen in `tick`/`processFrame`.

This is a **hybrid integration**, not removal of all existing HF repair: a
positive independently measured HF excess (`hissMax > .05 dB`) retains the
calibrated coloured-hiss expander/shelf. Without that excess, dehiss selects
whole-spectrum Wiener processing. Thus the broadband reference gate passes
without regressing the existing measured coloured-hiss/music protections.
Switching modes resets estimator/OLA state. The delayed dry ring includes the
STFT stage; the reported processor latency includes it only when engaged.
Whole-file and chunked-span exports flush and trim the **additional STFT delay**;
older de-clip/de-click/limiter export lookahead conventions are unchanged.

`alignSignals` and `siSdrAligned` provide **explicit diagnostic** bounded,
normalized FFT cross-correlation: default ±16 samples, hard bound ±2048, central
analysis window at most 32768 samples. They return signed lag, overlap and
correlation; `siSdrAligned` also returns raw and aligned scores. Finite inputs
are required; silent/constant windows return lag zero and NaN correlation.
A constant lag cannot undo frequency-dependent filter phase. `siSdr` stays
strictly aligned by contract, and the acceptance fixture does not call these
best-lag diagnostics. No hidden metric optimization was introduced.

`tests/wiener.test.js` adds **22 checks**: unity-mask WOLA/tails at four rates,
streaming/offline sample parity, bypass, reset, stereo isolation, nonfinite
safety, positive/negative lag and whole-file/chunked-span export alignment.
This is not a broad speech/music corpus or a real-time mobile CPU certification.

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
337 frame intervals, mean **60.00 FPS**, p95/max **16.67 ms**, **zero intervals
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
mobile timing assumptions, which were then fixed and re-run. At that historical stage no successful aggregate `npm test` was claimed; the
white-noise failure has now been addressed by 5.1A. The older full beta/UI
screenshot suite was not re-run for this change. Historical true-peak-margin
measurements were made with lamejs; the tooling now uses the production WASM
codec, but that full corpus should be requalified before release.

The subsequent de-clipping change completed the full fifteen-suite `npm test`
chain: **1296 passed / 1 failed**, solely the then-remaining white-noise gate. See
`DECLIPPING-AR.md` for the changed AudioWorklet and focused 43-check acceptance.


## 5.1A final regression (2026-10-17)

The complete sixteen-suite `npm test` chain exited **0**: **1319 passed, zero
failed** (1240 earlier checks + 5 encoding + 43 de-clipping + 9 quality + 22
Wiener/alignment). The Web/DOM suite was additionally re-run against the final
export-padding changes: **137/137**. Documentation validation: **19/19**;
production static analysis: **17 files, zero defects/unreferenced declarations**.
Only the existing all-stages latency assertion was updated to include the new
1024 samples; no quality reference, corruption or threshold was weakened.

A separate real Chromium 153 smoke run loaded the production page, then called
`RSEngine.render` on four seconds of noisy three-tone audio. Actual worklet
module loading succeeded; original/export lengths were both **192000** samples.
SI-SDR input **14.1841**, output **28.7719**, gain **+14.5877 dB**, using the
engine's fixed-delay trim, not searched alignment. This was an additional
single-file smoke, not the heterogeneous UI workflow acceptance.

The isolated ten-file encoder benchmark in that npm run passed **5/5**:
**337** rAF intervals, **60.0024 FPS**, maximum gap **16.67 ms**, **zero long
tasks**, two WASM workers. It still measures encoding/decode/WAV packing only.

**Still open (5.1B/5.2):** hardware-aware parallel UI process-all scheduling,
queued cancellation/15-second queue deadline/30-second idle disposal, controlled
WAV fallback/toast on encoding feature failure, decoded MP3 true-peak corpus,
and the full heterogeneous decode→restore→encode→ZIP browser performance run
with refreshed desktop/mobile screenshot baselines. The current encoder remains
bounded to two workers and has no main-thread encoder fallback. These are not
implicitly satisfied by the green DSP/encoding regression.
