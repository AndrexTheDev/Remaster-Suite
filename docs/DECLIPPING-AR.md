# De-clipping follow-up — masked AR/Hermite reconstruction

This addresses item **1.1, de-clipping**, from the Prompt 5.1 follow-up. It does
not implement the separate white-noise repair.

## Measured acceptance

The original four-second, 48 kHz quality fixture is unchanged: clean components
at 440/997/2203 Hz with amplitudes 0.45/0.2/0.1, hard-clipped at +/-0.35. The clean
reference is never passed to the processor. Evaluation excludes the first second
and compensates only the processor's declared latency, not an optimized lag.

| Implementation | Input SI-SDR | Restored SI-SDR | Gain |
|---|---:|---:|---:|
| Before this upgrade | 12.45 dB | 14.95 dB | +2.51 dB |
| Masked AR/Hermite | 12.45 dB | **39.61 dB** | **+27.17 dB** |

`node tests/audio-quality.test.js` now passes clipping with a **raised +8.5 dB
gate**. It remains **8/9 overall, exit 1**, because white noise still measures
-0.01 dB gain. Hum is unchanged at +11.60 dB. Clean-reference clipping LSD improves
from 65.58 to 47.08 dB; these sparse-tone/floored-spectrum values are not perceptual
quality grades.

`node tests/declip-ar.test.js` passes **43 checks**. Its independent three-second
fixtures (same latency/warmup policy) give:

| Sample rate | 440/997/2203 Hz | 330/880/1760 Hz | 220/660/1540 Hz |
|---|---:|---:|---:|
| 32000 Hz | +25.51 dB | +26.29 dB | +15.96 dB |
| 44100 Hz | +24.40 dB | +26.46 dB | +15.03 dB |
| 48000 Hz | +27.17 dB | +26.47 dB | +14.39 dB |
| 96000 Hz | +26.75 dB | +25.31 dB | +11.81 dB |

Additional 48 kHz cases: deeper +/-0.25 clipping of the first mixture **+21.49 dB**;
a 1.25-amplitude 997 Hz sine clipped at +/-0.99 **+26.96 dB**, with autoLevel
both on and off. Every one of the fifteen gain fixtures exceeds +8.5 dB and
checks finite output with sample peak below full scale.

This is a measured synthetic-fixture contract, **not** a universal +8.5 dB
promise for arbitrary speech, music, noise, or arbitrarily severe clipping.

## Algorithm

### 1. Observe the clipping rail before filtering it

The input DC blocker now follows raw-PCM reconstruction. A DC filter before
reconstruction changes a perfectly constant rail into a decaying one and shifts
the very threshold the detector was given. Without reconstruction, the linear
filter and the fixed delay commute; the neutral path is preserved.

Detection accounts for Float32 rounding: for example, stored 0.35 is actually
about 0.349999994, slightly below a double-precision dB-to-linear threshold.
The comparison has a one-part-per-million tolerance. Runs must remain same-sign,
above the threshold, and within the existing peak-relative continuation floor.
Samples below the threshold are not swallowed into the exit of a repair.

### 2. Fit only original, uncorrupted observations

A separate raw ring is never overwritten by reconstruction. The short-run fit
uses up to 512 immediately preceding original samples and up to 128 exit samples;
collection stops at the next clipped run. It excludes every regression window
that touches saturation. It does **not** concatenate clean fragments across gaps.

The covariance fit minimizes forward **and time-reversed** one-step squared
prediction error using a single local AR model. Its order is the largest supported
by both adjacent clean seed spans, between four and eight. A lower-order model
can therefore reconstruct a gap with fewer than eight clean seeds without
initializing the predictor from damaged samples.

The small normal system is solved with partial pivoting and a relative 1e-14
numerical diagonal load (absolute minimum 1e-14). At least eight regression rows
per coefficient are required. A relative fit residual above 1%, non-finite or
unreasonable coefficients, or unsupported clean seed spans reject the model.
Covariance LPC is **not** claimed to be pole-stable merely by construction:
explicit bounded extrapolation and rejection are still necessary.

### 3. Predict from both sides and preserve boundary tangents

The model predicts forward from the preceding clean samples and backward from
the following clean samples. A raised-cosine crossfade joins these predictions.
Predictions above four times the observed rail, non-finite values, or excessive
forward/backward disagreement are rejected before any accepted AR write.

The observed boundary samples `a`, `b` and their one-sided slopes `da`, `db`
define a cubic Hermite bridge `H(t)` across the span. The AR residual enters as

```
F(t) = H(t) + g(t) * (AR(t) - H(t))
```

where `g` is a smoothstep edge gate that is zero with zero first derivative at
both boundaries, reaching one two samples into the span. The bridge and the
blend therefore preserve the two observed values and boundary tangents before
the sample constraints. The tests check endpoint values and both derivatives,
including the AR-residual blend, by finite differences.

This matches the **observed one-sided slopes**, not the mathematically unknown
derivatives of an inaccessible unclipped original. Nor is this a claim that
later DC filtering, gain adjustment or sample-wise projection preserves every
continuous-time derivative of that original.

### 4. Project damaged samples onto the clipping constraint

For each damaged sample in sign-normalized space:

```
x_hat = max(rail + epsilon, min(4 * rail, F))
epsilon = max(1e-7, rail * 1e-6)
```

This is Euclidean projection onto a convex **sample-amplitude interval**. The
finite epsilon survives Float32 storage, so an accepted repair is strictly above
the rail, not equal to it. This is not a globally optimal convex audio inpainting
solver and does not impose a threshold constraint on all between-sample times.

The old Hermite/period repair remains the fallback when there is insufficient
predictive evidence. An accepted AR repair first restores the original candidate
observations, then writes only its saturated core. A raw-stage test verifies
that uncorrupted observations stay unchanged, and that the AR path actually runs
and restores energy rather than merely benefiting from evaluator gain fitting.

### 5. Pay for peak recovery with headroom, not new clipping

The reconstructed **absolute** peak is held until reset. The processor combines
it with the actual loudness-match gain to derive one stereo-linked attenuation
before the output guard. Its target is the existing soft-guard knee, leaving
margin for downstream filter transients. This also operates with autoLevel off.

Holding a maximum avoids independent per-block peak normalization, which would
pump. Both channels share the attenuation. The test checks exact opposite-polarity
stereo preservation and verifies below-full-scale finite samples in both manual
and automatic headroom modes. The separate true-peak limiter and full MP3
true-peak corpus are not replaced by these sample-peak checks.

## Preserved behaviour and cost

* Short-run ceiling remains 5.6 ms; longer runs retain the periodic/CBAR paths.
* Declared latency remains **1330 samples at 48 kHz** (27.7 ms); no new delay.
* No clean reference, oscillator frequencies or expected amplitudes enter repair.
* All added model/context/prediction scratch is preallocated. No per-run arrays
  are created by the new fitting/reconstruction methods.
* Fit, missing-context, seed and extrapolation failures retain the earlier fallback.
* Reset clears raw observations, pending repairs, model context and held headroom.
* Disabled raw stage returns samples exactly, without advancing delayed state.

The fit is heavier than a single cubic and runs on the AudioWorklet thread.
Physical-device worklet deadline/dropout validation remains open; an offline
Node test or encoding FPS test cannot establish that real-time CPU guarantee.

## Regression assertion corrected against physical ground truth

One old DSP assertion required a repaired 997 Hz sine to have fewer than 0.84%
near-flat samples. The clean sine itself has **2.43%** two-sample near-flat crests
under that detector. The assertion rewarded an unnaturally pointed old arc.
It now requires a large reduction from the damaged plateau **and** occupancy
within one percentage point of the known clean reference, while retaining the
strict implied-missing-peak and clipping-evidence limits. No SI-SDR threshold was
weakened; the clipping quality gate was increased from +8 to +8.5 dB.

## Validation status

The final **complete `npm test` chain** ran all fifteen suites:

* Twelve existing regression suites: **1240/1240** checks pass.
* Encoding batch: **5/5** checks pass (60.00 FPS, max frame gap 16.67 ms,
  no long tasks in its isolated encoding interval; not full-workflow FPS).
* New de-clipping suite: **43/43** checks pass.
* Audio quality: **8/9**, only white noise fails.
* Overall: **1296 passed / 1 failed**, exit **1**, exactly the outstanding
  white-noise quality gate. This is not presented as an all-green aggregate.
* Static documentation validation: **19/19**. Static analysis: zero defects /
  zero unreferenced declarations across 17 production files. `git diff --check`
  is clean.

Older full beta screenshots, physical mobile devices, real-time worklet deadlines,
the full MP3 true-peak corpus and production-model quality remain outside this
follow-up's completed validation.
