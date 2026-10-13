# Changelog

All notable changes to the Remaster Suite. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the ones shown in
*About & credits*.

## [Unreleased]

**The level release.** The suite promised that a quieter upload gets the same repair — and the
repairs did, but the rest of the app did not. Four absolute constants sat in the analysis (an
inter-sample-peak gate, a flat-top tolerance, a spectrum floor, a synthesizer reference cap) and two
thresholds sat in the tone stages (the glue's and the warmth's), all of them written for a file at
full scale. The same recording measured and processed 20 dB down now comes out 20 dB down: nothing
else may move.

### Fixed

* **The inter-sample peak was invisible below full scale.** The oversampling walk visited samples
  above an absolute 0.5, so a file 20 dB down reported −240 dB — "no inter-sample peak" — and the
  analyser handed the sample peak on as the true peak. The gate is now relative to the file's own
  peak; at full scale it is the same 0.5 it always was.
* **The flat-top detector read a quieter copy as a *more* clipped one.** The tolerance for "these
  samples are equal" was an absolute 0.0025, so a file 20 dB down had 20 dB more room for runs to
  survive it: run lengths, the median run, the implied overshoot and the de-clip dose all followed
  the upload's volume. Tolerance and silence gate are now relative to the file's peak.
* **The spectrum floor was an absolute −120 dBFS.** On a quiet file that clamps the top octave 20 dB
  early — measured on one fixture, the codec cliff moved from 17 402 Hz to 15 662 Hz and shrank from
  18.5 dB to 13.4 dB. The floor is now that much below the file's own peak, which is the same number
  for a master that reaches full scale.
* **The exciter's and the air synthesiser's noise reference cap (0.02) bit only on loud files.**
  Measured on the vinyl fixture, the reference came out 0.0214 at full scale and 0.002 14 at
  −20 dBFS, so the programme gate sat at a different level *relative to the music* and the same dose
  generated 44 dB less harmonic content. The cap scales with the file's peak.

### Added

* **`refDb` — the file's own peak, as a parameter.** The glue's threshold (−22 dBFS *at that peak*)
  and the warmth's drive read it; at full scale both are exactly the numbers they were. Measured
  before: with the fixed threshold the compressor did nothing at all on a file 20 dB down (effect
  −45.8 dB at 0 dBFS, none at −20 dBFS) and the warmth produced 30 dB fewer harmonics.
* **A permanent invariance test** (`tests/dsp.test.js`, *the analysis and the synthesis do not depend
  on the level*): two fixtures measured at 0 and −20 dBFS have to produce identical metrics with the
  levels exactly 20 dB apart, and every synthesis stage has to render the same file in both
  directions — with the true-peak limiter asserted as the documented exception.

## [1.6.0] — 2026-10-12

**The combination release.** The suite always dosed every stage from a measurement, but it still
picked *one* of the six profiles by a vote and threw the other readings away. Most real files are
not one thing: the classic record in a private archive is a 1970s album, ripped from vinyl, then
compressed to 128 kbit/s by whoever put it online — crackle, surface noise, transfer hiss and a
codec cliff in one file, so whichever profile won the vote, the treatments the other problems needed
were capped by it. Automatic mode now works on a chain instead of a label.

### Added

* **A diagnosis that names every problem, not the loudest one.** `classify` returns a chain of the
  profiles that carry evidence (from 30 % score upwards), the card's sentence becomes *"Sounds like
  several problems at once: vinyl rip + heavily compressed file"*, and the ZIP report carries the
  whole chain (`detected : lowbitrate+vinyl+cassette`). A band-limited source keeps its own name
  (*band-limited recording*) instead of being called a low-bitrate file, while still borrowing that
  profile's top-end rebuild.
* **A tone curve that is the mix of the detected problems.** The six band ceilings are the
  evidence-weighted mean of the detected profiles' curves (70 % vinyl / 30 % codec gets 70/30 of the
  two curves) — not the winner's curve. Measured on a vinyl+128 kbit/s fixture: the 7 kHz ceiling
  lands at **2.38 dB** between the vinyl 1.80 and the codec 2.60 instead of taking either.
* **Repair permissions are the union, doses stay measured.** Each profile's budget for de-hissing,
  de-clicking, sub-bass, air and the rest is a *permission*; a file with two problems gets the wider
  permission per stage, scaled by how much evidence it carries, and the measurement still decides
  the dose. Measured: **cassette tape with a little dirt on it** is diagnosed as cassette (0.60) +
  vinyl (0.40) and takes its spikes down **3.6 dB** at the recommended strength — where the
  single-profile answer managed 0.6 dB, because the cassette ceiling (0.20) was the limit, not the
  detector.
* **A measured codec cliff counts in full.** The low-bitrate score used to be discounted by hiss and
  crackle all the way through, which meant the most common combined file — an old vinyl rip at
  128 kbit/s — lost the codec treatment *because* it was noisy. The cliff is a direct measurement,
  so it now stands on its own (measured brickwall 1.00 → codec score 0.62 on the combined fixture,
  0.28 before), while the circumstantial terms (clean material, a dull top) keep their discounts.

### Notes

* A file with a single problem is still a file with a single problem: on a solo cassette the new
  mixing moves the tone by **0.03 dB** and the repair budgets by **0.00**, and the clean reference
  file is bit-for-bit the same decision as before (no parameter moves at all).
* A hand-picked profile is a decision, not a diagnosis: it is still used exactly as chosen, with no
  blending.
* Nothing about the single slider changed: the amounts still follow the same power curve, and 0 %
  is still a bit-transparent copy of the original.

## [1.5.0] — 2026-10-12

**The per-song release.** Until now the suite chose one of six profiles from the measurements and
the profile's *ceilings* decided how far each stage could go. That is still true — a profile is
never a curve to apply — but seven parameters are no longer amounts at all: they are measurements
of the file itself (where its noise starts, which split its de-hisser should use, where its mains
line sits, how percussive it is, how its bass arrives in the two channels), and four stages are new
and exist only when a file asks for them. Two files of the same kind no longer get the same
treatment: they get the treatment each of them measured.

### Added

* **A sub-sonic guard, dosed from measured rumble.** The quiet passages are compared below the
  music (20–45 Hz against 120–270 Hz, equal relative width, summed) and the guard is a 12 dB/octave
  high-pass at **18–30 Hz** — under the bass, where a turntable's rumble lives and no instrument
  does — and only when the confidence in that measurement is there *and* no mains line could be its
  cause (a 50/60 Hz line leaks into the band below it at any sane FFT resolution, and a hum is a
  notch, not a reason to take the bottom off the record). Measured: a rumbly fixture gets 22 Hz, a
  clean pink programme 0 Hz, the garage fixture 0 Hz.
* **A per-song corrective EQ — twelve bands, 50 Hz … 8 kHz, Q 1.4.** This is the part that is
  different for every song: the file's own departures from its own spectral trend, minus what the
  profile's six bands already shape, with a ±1.5 dB dead zone, a ±6 dB cap, boosts held back within
  18 dB of the measured noise floor, and no correction at all in a band the file does not fill
  (more than 22 dB under its own median). Measured on a dull 6 kHz-limited recording: the curve
  comes out `0 0 0 0 0 0 0 0 −0.1 −0.2 +0.35 +1.64 dB`, and pushing the slider from 0 % to 100 %
  moves the 9–13 kHz band by 6.1 dB.
* **A de-esser that fires on sibilance and only on sibilance.** A dynamic dip over 5.2–9.5 kHz,
  keyed on the fast/slow ratio of that band — a quiet "s" and a loud one are the same problem — and
  dosed from the measured excess of the band over the trend the rest of the spectrum predicts. It
  sits before the synthesisers, so the exciter and the air stage cannot rebuild what it just took
  out. Measured: a sibilant probe asks for 0.46, a recording without sibilance measures 0.00.
* **A bass mono-maker for a bass that arrives out of phase.** If one channel's low end is inverted,
  the two channels cancel below 200 Hz when the file is folded to mono — a mis-wired cartridge or a
  polarity-flipped bass microphone does exactly this. Measured: an inverted bass asks for 1.00, a
  centred bass for 0.00.
* **Measured rates instead of guessed ones.** The glue compressor's attack/release now follow the
  file's **percussive character** (crest factor), and the de-hisser's split point is the measured
  **start of the noise** (2.2–4 kHz), so a tape whose hiss begins at 2.5 kHz is repaired from
  2.5 kHz up instead of from a fixed 3.2 kHz.
* **Every one of them is named in the analysis**, in the same plain sentence as the rest, and the
  worklet's parameter set grew from 36 to **53** (all of them exercised by `tests/audit.test.js`,
  which now also proves that a sibilant, an inverted bass and a rumbly recording each move exactly
  one stage).

### Fixed

* **MP3 export wrote silence.** lamejs copies whatever it is handed straight into 16-bit buffers,
  so the −1…1 float mix from the renderer was written out as samples rounding to zero: a file with
  valid frames, a plausible size, and no sound. Independently decoded (mpg123): the file the old
  path produced measures **−∞ dBFS** — digital silence, 120 960 bytes of it — while the same signal
  through the fixed path measures **−17.8 dBFS RMS, −3.4 dBFS peak**. Both encoder paths (the worker and the main-thread
  fallback) now scale to 16-bit PCM with clipping and dither, and the stream is checked for a frame
  header and a sensible length before the download is offered — an encoder failure is reported as an
  error instead of being saved as a file that "worked". `tests/web.test.js` now listens at the
  encoder's input and fails if the samples stop being 16-bit PCM (the check was verified against the
  old behaviour: peak 2 instead of ≈23 000), and `tests/audit.test.js` checks the conversion itself
  and that *both* paths perform it.
* The de-clicker's amount no longer takes a 30 % cut on material whose crest factor is high
  *because* of its crackle — a crackly record is the one case where full de-clicking is what the
  file needs, and the vinyl profile's ceiling for it rises from 0.75 to 0.85. Measured: the vinyl
  fixture's spike crest comes down 1.9 dB at the recommended strength.
* **Crackle survived the de-clicker on anything that had been through a codec** — a vinyl rip
  downloaded as a 128 kbit/s MP3, the round trip the beta report is full of. Two mistakes in one
  stage. First, the amount scaled the *depth* of every repair, so at the automatic dose (0.715 on a
  crackly record) each detected pop kept 29 % of its amplitude: the knob now moves the detector's
  confidence threshold instead, and a pop that is detected is repaired. Second, and worse, the
  repair was causal: an encoder spreads a three-sample pop over the 26 ms window it codes in, and
  96 % of the pop's energy ends up within ±40 samples of the spike — two thirds of it *before* the
  spike, where no causal repairer can reach. Replacing the waveform with the *ground truth* from the
  peak onwards still measures a crackle index of 0.63–0.68 however long the window is; a causal
  window that fades in leaves the smear behind *and* steps on the residual, which measured 1.00 —
  the repair becoming the click. The stage now takes half a millisecond of look-ahead (0.35 ms:
  17 samples at 48 kHz) and plans the repair window around the detection, 0.33 ms in front and 1 ms
  behind. On a 24 s vinyl fixture with 216 injected pops through 128 kbit/s at the automatic dose,
  the measured crackle index **1.000 → 0.232** (297 → 22 spike frames; the same music encoded
  without the pops reads 0.062) where the old stage reached 0.665, and on a 96 BPM drum kit the
  change in the 2 ms around a snare is **−84 dB** against −31 dB before — the wider window is also
  the *gentler* one, because a repair that covers the whole pop no longer has to fade in on top of
  it. The price is the delay: the master cross-fade delays its dry side with the stage, and the
  processor reports the figure as `this.latency` (`H.renderEx` in the test harness hands it to the
  suites).

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
