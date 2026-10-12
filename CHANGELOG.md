# Changelog

All notable changes to the Remaster Suite. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the ones shown in
*About & credits*.

## [1.4.0] — 2026-10-12

**The measurement release.** Three repairs that were dosed from a number nobody had ever checked
now measure the defect itself and subtract exactly that: mains hum is notched by the level its own
line stands above the music, hiss is recognised by the tilt of the top end in the gaps rather than
by a level that sane recordings never have, and the two strongest room resonances are found and
notched by hand-picked frequency and depth. A narrow stereo image gets its sides back — but a mono
master stays mono. Nothing about the interface changed.

### Added

* **Mains hum is measured, then removed — and only that.** The exact frequencies are examined
  directly (50 and 60 Hz and their harmonics, each against its own shoulders five hertz away) in a
  one-second Hann window, on a decimated copy of the signal, and the line has to be there for the
  whole file *and* refuse to drop when the music drops: that is what tells mains hum apart from a
  bass note that happens to be written at 50 Hz, and it is why a perfectly steady tune no longer
  has to be damaged to repair a hum that was never there. Measured: a garage recording with
  **13.4 dB** of hum above its own neighbourhood comes out at **2.5 dB** — below the detector's own
  3 dB line for calling something hum — at the recommended strength, and **1.8 dB** at full
  strength. The build before it left the line exactly where it was (its demand law never fired on
  that material) and even added half a decibel; the 100/150 Hz bands are untouched because the hum
  has no energy there, where the old harmonic notch fired whenever the fundamental did and took
  20 dB out of them.
* **The notch is three hertz wide, not five, and it sits last in the chain.** Hum drifts in hertz,
  not in octaves, so the width is absolute and the frequency is the measured one. Placed last,
  after the exciter, the sub synthesiser and the saturator — all of which put energy back at the
  mains frequency — it has the final word; the narrower bell costs the octave below half a
  decibel instead of 2.5 dB.
* **A hiss measurement that works on loud material.** A tape hiss at −49 dBFS is 20 dB *below* the
  quiet parts of a normal recording, so every floor-based detector misses exactly the case a
  listener hears. The analyser now measures the **tilt** of the top end (4 kHz+ against the
  1.45 kHz band) separately in the loud frames and in the quiet ones: programme keeps its tilt
  when it gets quiet, a hiss does not. The difference is a calibrated number of decibels — how
  much of the top end is not programme — and it is what the repair subtracts. Measured: 7.7 dB on
  the 1970s garage fixture, 3.9 dB on the cassette, 0.0–0.1 dB on clean, codec-damaged and vinyl
  material (so nothing happens there).
* **The de-hisser is keyed on the same bands and the same window as the analyser** — a 2048-sample
  sliding RMS of the 4 kHz+ band and of the 1.45 kHz band, where it used to be a peak-ish envelope
  follower, i.e. a different number with an arbitrary constant between it and the measurement. The
  dose is applied **in decibels**: half of the repair is −6 dB of the noise, where a linear
  crossfade of the gate gains is far less than that at the bottom of the range. Measured on the
  garage fixture: the top-end floor between the notes comes down **6.2 dB** and the programme's own
  top end moves by less than 0.3 dB; a steady hiss between the notes of a very quiet bed comes down
  32 dB; a loud, continuous master stays within 0.1 dB.
* **A file that is not made of numbers is refused, not "restored".** One `NaN` sample in a 32-bit
  float WAV poisons every recursive filter behind it — the output is silence, but a silence that
  cost a full render and looks like a successful one. The measurement now reports whether the file
  is numeric, the analyser refuses such a file with a message instead of rendering it, and
  `buildParams` cannot emit a non-finite parameter at all: whatever the measurement was, a stage
  that has no measured value does nothing rather than something undefined.
* **Two measured resonance notches.** The dynamic de-resonator can only pull down what rings above
  its own running average — a *constant* colouration is the average, so a boxy room or a honky
  cabinet survives it. The measurement now finds the two strongest narrow peaks (150–1800 Hz, at
  least 3.2 dB above the local trend) and notches each at its own frequency, depth (up to 3.5 dB)
  and sharpness.
* **Stereo width restoration.** An image whose channels are strongly correlated but not identical
  (a 1970s two-track master, a mono-summed CD) gets up to ~3.4 dB of high-passed side signal above
  200 Hz. A genuinely mono master is left alone: there is no side signal to widen, and inventing
  one would be a fake image.
* **The air synthesiser can now rebuild a top end that was never there.** Its source band used to
  be fixed at 6 kHz; on a codec-damaged file that band sits *above* the cliff, so it was
  synthesising out of rubble. It is now derived from the measured cliff (`0.72 × cliff`, 2.2–6 kHz)
  and the ceiling the synthesised band may reach above it (`airRoom`) is dosed from how much
  programme survived below the cliff.

### Changed

* **Mains hum is interference, not a medium.** The classifier no longer lets a measured hum vote
  for "vinyl rip" — a 1970s home recording on a cheap deck is hummy for the same reason a turntable
  is, and with the hum detector fixed it was single-handedly turning every hummy old recording into
  a vinyl rip. What marks vinyl out is what a needle does: crackle, rumble and surface noise — and
  low-frequency energy only counts as rumble when it is neither part of a flat noise bed (that is
  hiss) nor sitting on a measured mains line.
* **The garage profile gets a hiss term.** Tape hiss is as much a one-mic 1960s recording's problem
  as a cassette's, and the fixture that used to be diagnosed as a dull, thin, noisy recording is
  now measured as just that instead of as a turntable.
* **The analysis got several times cheaper.** The hum measurement used to be 21 resonators running
  over every sample of every frame and was the single most expensive thing in the measurement pass;
  it is now one decimated, windowed DFT of 27 exact frequencies. The four per-sample statistics
  (peak, clipped samples, loudness and dynamic range) used to be four separate walks over the whole
  file; they are now one, and the hiss band measurement fills its frames as it filters instead of
  keeping a copy of the filtered signal to read back — 280 MB of buffers on a three-minute stereo
  file that no longer exist. A three-minute stereo file measures in **1.3 s** in the suite's Node
  run (2.4 s before) and in **1.7–1.9 s** inside the test browser — measured cold, while the test
  process was still building the fixture — which is what keeps a phone inside its progress budget. (The largest remaining cost of an upload
  is not the measurement at all but the 40-second preview render through the worklet: 3.2 s in the
  test browser, measured.)

### Verified

* Five dependency-free suites: **552 checks** (dsp 73 · audit 224 · web 130 · e2e 108 · tuning 17),
  all green.
* The beta suite drives a real headless Chromium (drag-and-drop, Web Audio worklet, downloads,
  phone viewports) and now feeds it the **same synthesised recordings the node suites use**,
  served to the page and dropped like a user file, instead of signals generated inside the page.
  It measures the phases of an upload as well as its total, so a regression can be attributed:
  for a three-minute stereo take, decode 205 ms · measurement 1.3 s · preview render 3.2 s ·
  preview measurement 0.4 s.
* The mains notch has its own law section in the audit: a fixture with a *rich* hum (fundamental
  plus two harmonics) proves each harmonic is dosed from its own measurement, a pure 50 Hz line
  must not notch 100 or 150 Hz, the octave below the mains has to stay within 2 dB, and at 0 % dose
  the notch must be out of the signal path entirely.
* The de-hiss repair is a test, not a claim: the top-end floor between the notes has to come down
  by more than 3 dB while the programme's own top end stays within 0.5 dB.
* The two test bands that straddled the mains line (30–60 Hz and 32–58 Hz) now measure *below* it;
  they were subtracting a repair from a restoration and calling the difference "sub bass".
* The brightness and loudness contracts of 1.2.0 are unchanged and still enforced.

## [1.3.0] — 2026-10-12

**The progress-and-phone release.** A long file now says what it is doing, how far along it is
and how much longer it will take — and the whole interface is built for a phone browser
first, because that is where the suite gets used.

### Added

* **An honest progress bar, in two places.** The card shows the stage it is in
  ("Measuring the sound …", "Restoring the recording …", "Writing the file …"), a percentage
  and a coarse time left ("~12 s", "~3 min" — never fake-precise). A second bar above the file
  list reports the *job*: which file of how many, its name, and the same stage and percentage.
  On a phone that bar docks to the bottom edge, so it stays visible while the list scrolls.
* **Steps that cannot be counted sweep instead of lying.** Reading a file happens inside the
  browser's own decoder; there is no percentage to report, so the bar animates and the number
  stays empty until a real measurement starts.
* **The measurement itself became interruptible.** The analyser used to run 501 numbers over
  the whole file in one blocking pass. It is now sliced into ~26 ms steps that yield to the
  event loop, so the bar paints and the tab stays responsive on a phone — with the results
  proven bit-identical to the synchronous reference (`tests/dsp.test.js`).
* **The screen wake lock** is requested while a job runs and dropped when it ends: a phone that
  dims the display can suspend the tab and stall a queue mid-file.
* **A phone layout, systematically:** 44 px tap targets for every button and both sizes of
  segmented control, 16 px fields (so iOS does not zoom into them), safe-area insets for the
  notch and the home indicator, the footer's long donation addresses allowed to shrink, and a
  halved memory budget (420 MB) so a ZIP of WAVs cannot blow up a mobile browser.
* **Phone wording:** the drop zone says "tap to choose" instead of "drop files here" when the
  device has no hovering pointer, and switches live when the pointer changes (a phone with a
  keyboard attached, a tablet that gets a mouse).

### Fixed

* A single-file job was labelled "1 Dateien" — the batch wording is now only used for batches,
  and a one-file job leads with that file's name.
* The measurement phase (0–74 % of the analysis) was labelled "waiting in the queue", because
  the analyser's stage name was not in the UI's vocabulary. Every stage the analyser can report
  now has a word, checked by the audit.
* The percentage of the docked bar could be pushed off the right edge by a long file name — a
  grid track sized `auto` grows to max-content; both progress blocks now clamp it with
  `minmax(0, 1fr)`.
* **A real phone bug found in the browser:** the footer's donation addresses are long and
  unbreakable, and every `1fr` in the chain honoured their intrinsic width, so a 390 px phone
  laid the page out 449 px wide — the copy buttons for the tip addresses sat 36 px outside the
  screen. Fixed at each step (`minmax(0, …)` tracks, `min-width: 0` on the flex and grid items).
  The page now fits 320 / 360 / 390 / 414 / 768 px exactly, verified in the beta suite.
* Two buttons (the A/B and format segmented controls) measured 39 px on a phone — just under the
  44 px thumb target; they now carry the same minimum as everything else.
* The play/pause button never told a screen reader what it would do; it now carries a translated
  `aria-label` that follows the language switch.
* The audit's "no dead translation keys" check included the dictionary file in the code it
  scanned, so it could never fail. It now scans the application only, discovers the dynamic key
  families (`kind.`, `issue.`, `status.`), and the 17 keys it immediately found were removed.

### Verified

* Five dependency-free suites: **531 checks** (dsp 66 · audit 215 · web 126 · e2e 107 · tuning 17),
  all green.
* The beta suite drives a real headless Chromium: **61 checks, 19 screenshots**, including a
  390 px and a 320 px phone, thumb-target measurements, the docked bar's geometry, and progress
  rates sampled every 50–60 ms to prove the bars only ever move forward within a stage.
* The brightness and loudness contracts of 1.2.0 are unchanged and still enforced.

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
