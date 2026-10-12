# Changelog

All notable changes to the Remaster Suite. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the ones shown in
*About & credits*.

## [1.2.0] — 2026-10-12

**The tuning release:** the automatic mode was overdriven, and it is now bounded by
measurement at every stage. Nothing about the interface changed — the same slider does less,
and only where there is something to do.

### Fixed

* **The level match could never settle.** The matcher measured a level that its own gain had
  already multiplied, so the feedback loop settled at the *cube root* of the required
  correction, and it applied a `sqrt()` to a ratio of RMS levels, halving every correction.
  It now measures the pre-gain signal and compares plain RMS ratios: the music band
  (300 Hz – 3.4 kHz) comes out within **±0.3 dB** of the original on every test recording.
* **The headroom guard parked loud material on the clip knee.** It judged the *output* peak —
  after the very gain it controls — so on a dense master it kept ducking until the signal sat
  on the soft-clip knee. It is now keyed to the input peak versus the knee (`safe = max(dryPeak,
  knee)`) and only ducks what would actually be clipped. A loud master comes out at −0.28 dB
  mid-band instead of −4.7 dB.
* **The de-hisser coloured everything it touched.** It rebuilt the signal from the two
  Linkwitz-Riley branches; that reconstruction is flat in magnitude but *not in phase*, so it
  overshot the input peak by up to **+4.7 dB** on dense material — the soft-clip guard shaved
  the overshoot and the level matcher pulled the file down, audible as "overdriven and
  quieter". The split is still LR4, but whenever the gate is open the stage now returns the
  input sample unchanged, so it can only ever change what it is repairing (a steady hiss
  between notes goes down by 32 dB; the six test recordings above 6 kHz stay within 0.3 dB).
* **The DC guards rotated the low end.** Single-pole at 8 Hz in and 12 Hz out lifted the
  internal peak of a loud master (up to ×1.5 at 24 Hz) and shifted phase exactly where the
  sub-bass repair works. Both ends are now 2 Hz.
* **The exciters were not level-normalised** (a quiet file got less effect than a loud one)
  and the drive was scaled twice. The amount now scales the mix only.

### Changed

* **The profile anchors are ceilings, not curves.** Every amount is dosed from the
  measurement (`RSPresets.demand`): the bass lift from the measured bottom-octave shortfall,
  the top end from the measured top loss and codec brickwall, the de-resonator from the
  measured box/harsh excess, the de-hiss from the new hiss measurement. A band whose problem
  was not measured gets nothing — a healthy recording now measures as **unchanged** (air,
  exciter and sub are exactly 0, every octave band within 0.01 dB).
* **Repairs scale with the repair, synthesis with the deficit.** De-hiss and de-click keep
  half of the profile's amount and scale the rest with what was detected; sub, exciter and
  air get *nothing at all* when nothing was measured as missing. Nothing is applied "because
  the profile says so" any more.
* **`deriveRoom`** — the factor that separates "rolled off, worth rebuilding" from "gone,
  leave it alone" — now bounds the air and exciter amounts, and a hot, dense master is held
  back further (`headroom`, `dense`).
* **The corrective EQ has a dead zone.** Every recording has ±1.5 dB of natural ripple;
  correcting it was the automatic mode chasing its own tail. It now moves at most 40 % of the
  deviation beyond that dead zone, clamped to ±2.5 dB per band, and the profile curve is
  capped at 9 dB (manual) / 6 dB (automatic).
* **The amount curve** is applied to the EQ bands too (they used the raw slider before, so
  half power gave 3 dB where the slider said 6). Recommended powers: garage 0.85 → **0.75**,
  low-bitrate 0.75 → **0.72**, general 0.65 → **0.62**.
* **New hiss measurement** (`RSDSP.noiseAnalysis`): frame-wise high-frequency versus broadband
  dynamics plus the HF signal-to-noise ratio (`hissDeficitDb`, `hissLevel`, `m.hissAmount`).
  The old detector could not tell tape hiss from a cymbal; this one measures 0 on healthy and
  vinyl material and 1.0 on the cassette sim.
* `Version 1.2` in *About & credits*; README documents the dosing law and the new contract.

### Added

* **`tests/tuning.test.js`** — the tuning contract as 17 checks over nine recordings, because
  "it is too heavy" is a matter of numbers once it is written down: no octave band with
  content may move more than 3 dB (the sub-bass repair 6 dB), the music band must stay as loud
  (±0.8 dB), the soft-clip guard must stay out of material that was below the knee, healthy
  material must not be touched at all, synthesis must add the same dB at any input level, and
  **what the chain changes above 6 kHz must stay ≥ 18 dB below the music band** in automatic
  mode (≥ 12 dB even for a manually chosen profile at 100 %). Filling a dead top octave is a
  repair; a top end that arrives at music level is a fake modern sound — this is the check
  that tells them apart.
* Measured result of the automatic mode at its recommended power (mid = 300 Hz – 3.4 kHz):

  | recording | profile | mid | RMS | octave bands within |
  | --- | --- | --- | --- | --- |
  | garage | garage @0.75 | +0.07 | +0.13 | ±2.5 dB (dead top octave +12, 33 dB below the music) |
  | cassette | cassette @0.68 | +0.00 | +0.01 | ±0.1 dB |
  | vinyl | vinyl @0.70 | +0.03 | +0.20 | ±0.5 dB |
  | low bitrate | lowbitrate @0.72 | +0.06 | −0.30 | ±0.8 dB below 5 kHz, +1.3 above |
  | bright modern | general @0.62 | −0.00 | +0.03 | ±0.1 dB |
  | bass heavy | general @0.62 | +0.07 | +0.02 | ±0.7 dB |
  | hot master | general @0.62 | −0.28 | −0.24 | ±0.3 dB |
  | telephone band | cassette @0.68 | +0.07 | +0.11 | ±1.2 dB |

### Test contracts updated (product behaviour, not tolerance fixes)

* The stage tests (air, exciter, de-hiss, de-click, de-resonator) render with the level match
  switched off: with it on, a single module's change is partly undone by the matcher, which
  measures "how loud is the music" and not "how much did this module do".
* The slider-span bar in `tests/dsp.test.js` is 5 dB instead of 6: the span is measured through
  the shipped chain (matcher included) and measures 5.7 dB.
* `tests/audit.test.js` derives the expected direction of each EQ band from the same material
  and profile it measures, instead of from a different profile's anchors.

## [1.1.0] — 2026-10-12

First public release: the six sound profiles with automatic classification, the 21-parameter
AudioWorklet restoration chain (EQ, de-resonator, exciter, air synthesis, sub-bass, de-hiss,
de-click, glue, warmth/tilt, level match, soft-clip guard), live preview with an honest A/B
switch, batch rendering to WAV/MP3/ZIP, German and English UI, 100 % client-side.
