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

### Measured — where the de-clicker's detector stops, and what moving it costs

* **The pops a de-clicker cannot see are the ones the statistic under-reads, and that is now a
  number instead of an open item.** At the automatic dose (0.71) the fast/slow ratio map plus the
  knee only let a spike through once the ratio reads ≈ 2.2. The acceptance fixture's *three
  quietest* pops (|a| 0.41–0.48 of a 0.34–1.70 spread) read **1.86–2.02** with `asym` 0.30–0.33 —
  below the 0.32–0.52 band that would discount the threshold for that shape, so the shape term is
  worth 0.007 there, not the 0.18 it could be. Measured in **four beds** (low-passed at 5, 7, 9 and
  12 kHz): 51–52 of 54 pops repaired, and **the same two or three left in every bed** — the floor
  belongs to the statistic, not to a fixture.
* **Moving the gate down is measured, and it is not worth it**: the ratio map lowered to ≈ 2.0 costs
  the drum kit's snare 24 dB of its 55 dB guard (−62.1 → −37.7 dB) and rewrites 30.3 % of a clean
  wide-band master (4.4 % at the shipped map); lowered to ≈ 1.9 it takes the snare to −13.6 dB and
  81.7 % of the master. The shape term cannot reach them at all (its whole budget is `0.25 ×
  amount` = 0.18 of confidence). So the floor is documented in the worklet itself and **pinned by
  an audit row** (`audit · the de-clicker's own floor`), which fails if any of those three numbers
  moves by more than a couple of dB.
* **The fill was suspected and cleared.** Inside a full-replacement window the prediction filter is
  fed its own output, so it has no input left and runs to a fixed point: measured sample by sample
  (#374596), `pred` freezes at −0.1785 for 60+ samples and the window becomes a ≈1.35 ms DC plate.
  It is a real trade — the residual is as loud as the music the window removed (median 0.8 dB of the
  music's own 4–12 kHz, worst 8.1) — and it is **the best of four fills measured** on the same
  fixture: the same filter fed the dry sample is worse on every witness (band median −0.8, leftover
  worst 46.8 dB), 3-tap extrapolation touches 69.7 % of the drum kit (snare −50.4 dB), 4-tap takes
  the snare to −0.3 dB and 98.8 % touched. The window *width* (pre/post 4/8 … 16/48) moves the
  leftover by under 1 dB, so width is not the lever either.
* **One measurement lesson from the same round**: the acceptance row's "3 of 72 pops above the clean
  copy" is a comparison that includes the limiter's local gain (with the de-clicker bypassed the
  same windows read 1.65/2.14 dB, with it engaged 4.01/3.69). On the residual — the chain on the
  dirty file minus the chain on the clean copy — the two untouched pops read 5.9 and 8.1 dB in their
  4–12 kHz band, and the *repaired* ones read ≈ 0.8 dB median, which is the fill's cost and not a
  leftover click. A survivor count is only meaningful with its meter named.

### Measured — what the true-peak limiter costs a squashed master

* **The card names "squashed" correctly and the chain then takes 1–2 dB more of the little
  dynamics the file has left.** Measured on the acceptance fixture at three crush levels, spread =
  the 20 ms envelope's p98 − p05: DR 8.1 dB in 11.38 → **10.38** (−1.00); DR 6.8 in 9.92 → **8.37**
  (−1.55); DR 5.3 in 7.91 → **5.81** (−2.09). The cause is the true-peak limiter, not the glue:
  with the ceiling off the same renders lose 0.44 dB, at −2 dBTP they lose 1.55. The mechanism is
  honest — a master peaking at −1.11 dBFS needs 1.1 dB of reduction to hold a −2 dBTP ceiling — but
  the gain is applied *inside* the loud passages (80 ms release) while the quiet ones come back up,
  so the loud/quiet ratio shrinks by more than the level does. A whole-file static trim would keep
  the ratio: measured, a trim of 0.5/1.0/1.5/2.0 dB (with `refDb` lowered to match) leaves the
  spread at −1.20/−0.89/−0.59/−0.52 dB with the peak still on −2.10. What a trim costs is loudness,
  and choosing between a 1.5 dB dynamic loss at the upload's level and a 0.5 dB loss 1–2 dB quieter
  is a decision about the promise "the output keeps the upload's level" — so it is measured,
  written into the limiter's own code with the numbers, and left as the named decision rather than
  silently changed.

### Fixed — a declared parameter the worklet never read (and the silent stage behind it)

* **`subSrc` was declared, written by the law, plumbed through the harness, read at its call site —
  and never assigned.** The sub-harmonic synthesiser's "look for the fundamental at 95 Hz, unless the
  bottom octave is *empty*, in which case move the corner up to where the bass band is" repair (added
  two rounds ago, with a measured justification in the code) therefore never ran in the worklet:
  `p.subSrc` was `undefined`, `setSource(undefined || 95)` fell back to the design corner, and the
  stage was silent on exactly the files it exists for. Measured with the worklet instrumented at the
  sub's own call site, on a recording high-passed at 200 Hz with the 240 Hz corner *asked for*: the
  stage ticked 384 000 times with `srcHz 95`, its gate shut (median 0.0000, p90 0.0000) because a
  95 Hz low-pass on that file has nothing above its own noise gate, and its output was zero. The
  only place the fault was visible was the row that measures what the stage does — the acceptance
  weak-bass row read −9.30 → −8.77 dB, i.e. nothing happened. With the read in place: `srcHz 240`,
  the gate open (median 1.0000), the tracked note ~150 Hz, the derived octave at 75 Hz, and the
  **34–58 Hz band rises from −96.7 to −85.6 dBFS — 11 dB out of digital silence** (the source has
  *nothing* there), while the band the row measures, 60–200 Hz, moves 0.7 dB because a sub sits
  under the band it was derived from (SUB_CAP 0.70 × dose × drive ≈ −14 dB relative to it). The
  repair is honest about its own size and the code says so.
* **The reverse-direction check is now a test**: every parameter in the worklet's descriptor list
  must appear in a `g('name'` read (the twelve EQ bands are read in a loop, which the check knows).
  This is the class of fault that no other check could see — a declared, wired, never-read parameter
  looks exactly like a working one until the row that measures its effect moves. It found `subSrc`
  to be the only one of the 58.

### Fixed — the app called its own export a codec problem

* **`codecLoss` asked only *where* a file's top end ends, never how steeply.** The card's
  "chopped-off highs (codec)" is driven by a measured ceiling below 17 kHz plus a dullness guard, and
  the app's own 320 kbit/s export satisfied both — because the *de-hisser had just done its job*: on
  a worn record the top octave is largely hiss, and taking the hiss down lowers the measured ceiling
  (`hfCutoff` 15 381 → 13 898 Hz) without touching the encoder's wall at 18.9 kHz. Measured across
  the population, the fall over the 1.6 kHz *above* the ceiling separates the two kinds of ceiling
  cleanly — a real bitrate wall loses **39–55 dB** there (96 kbit/s: 52.2, 128: 39.4, 64: 53.9, 32:
  53.0, 24: 55.1) against **10–20 dB** for a medium's own slope (the worn record 15.3, its 128 kbit/s
  upload 16.9, a vinyl sim 11.2, a cassette sim 10.4) and 24.6 dB for the de-hissed export. Both of
  `codecLoss`'s branches now ask for the size as well as the location: the cliff branch requires the
  cliff to *be* a cliff (`brickwall` > 0 on the same 9 dB definition a codec wall is measured with),
  and the ceiling branch requires the fall at the ceiling to be ≥ 32 dB. Result, end to end: the
  app's own 320 export is diagnosed **"hiss"** instead of "hiss, codec"; the worn upload reads
  crackle, hiss, hum (the wall at 19 kHz removed nothing audible — the medium ends first); the
  acceptance suite's own codec fixtures converge — the 64 kbit/s round trip now re-uploads to
  **healthy** (was "codec") and the 32 kbit/s one to **"dullTop"** (was "dullTop, codec"), so the app
  no longer tells the user to fix the wall it just fixed; and every real wall (24–64 kbit/s, the
  low-bitrate sims) keeps its name. The new audit section 'a ceiling is not a bitrate' builds both
  ceilings within a kilohertz of each other so the rows measure steepness and nothing else.

### Measured — what the de-clicker does when nothing is wrong

* **"The stage touches N % of the file" is a meaningless sentence without its threshold and its
  dose beside it**, and one that read badly — a healthy card's dose touching 60 % of a clean
  bed — turned out to be a `2e-5` threshold at a dose of 0.6, i.e. the wrong pair of numbers
  quoted together. Measured properly, on a clean wide-band master against the same render with the
  stage off, aligned to each side's own latency: at **dose 0.08** (what a healthy card asks) **0.06 %
  of samples move more than 0.002**, the RMS deviation is **−51 dB** and the 6 kHz+ band is unchanged
  to 0.00 dB; at **0.30** it is 0.09 % and −32 dB; at the **0.60 ceiling** 1.65 % and −23 dB with
  0.04 dB of HF. So the stage is a no-op until it is asked for a dose only a worn record asks for,
  and even at the ceiling it does not dull the file. Both halves are now rows in the audit
  ('and on clean material the automatic dose is a no-op', '…and even dosed to its ceiling it does
  not dull the file'), and the meaning of the kit's own touched threshold is written beside it in
  `tests/dsp.test.js`.

### Measured — what the sub-sonic guard cannot do

* **A sustained music note in the bottom end and a turntable floor are the same thing to every
  measurement the app owns**, and that is now measured rather than assumed. The guard is four 2-pole
  high passes at its corner; on one bed with a rumble ladder and a club-style 35 Hz note it takes a
  full-scale rumble's 8–20 Hz band down 28.8 dB and its 20–35 Hz band 9.0 dB for 3.2 dB of the
  music's 30–45 Hz — and it costs a *sustained 35 Hz note* 3.7 dB, because the note reads 10.8 dB of
  "excess" (above the knee that a pink bed clears at 1.6). Three candidate witnesses that would tell
  a drone from a rumble were measured and each fails: **level** (the note reads −10.2 dB against the
  level the music reaches, a full-scale rumble −21.6 — the note is *louder*), **stationarity** (loud
  minus quiet: note −4.0 dB, rumble −6.2) and **tonality** (peakiness over six narrow probes: a
  full-scale rumble 5.3 dB, the note 7.1 — 1.8 dB apart). The arm threshold therefore stays where the
  clean population says it separates, and the cost stays recorded in the code rather than tuned away.

### Fixed — a clean master was read as a *cracked* one

* **The crackle statistic's window selection was absolute, and on tonal material
  that selection *was* the statistic.** `crackleStep` cuts the 8.5 kHz+ band into 20 ms windows and reads
  their crest factors — but it only counted windows above an absolute `rms > 1e-5`, and it took the
  global term from the single largest peak in the whole file. On a sustained tone the 8.5 kHz band is
  nearly empty: the only windows that passed were the ones the analysis's *own* high-pass rings in at
  sample 0, and the 98th percentile of three windows is the second-highest of them. Measured: a pink
  bed read **0.075**, the same bed with three sustained sub-bass tones on it **0.175**, a plain 1 kHz
  sine **0.108** (against 0.000 for white noise). The 0.175 cleared the classifier's own "there is
  crackle here" gate (0.06), and together with the bottom end (read as rumble) it put a **clean,
  tonal master into the vinyl profile**: measured end to end on that file, a **0.45** de-click dose
  on material with no clicks, a 24 Hz sub-sonic guard, a card naming "rumble, crackle", and 2.2 dB of
  level lost. Two fixes, both measured: the window selection is now *relative* to the file's own
  typical HF window (within ~26 dB of the median — scale-invariant by construction, and the statistic
  is scale-invariant by measurement: 0.004 at 0, −10, −20 and −30 dB), and the global term is the
  **third** largest window peak, not the largest, because crackle is a repeated event. The same set
  now reads 0.004 / 0.004 / 0.000 / 0.000, while real crackle is untouched: a garage sim 0.817, a
  vinyl sim 0.956, the worn-record fixture 1.000. Every threshold that reads this number (0.06 in the
  classifier, 0.08 on the card, the dose knee at 0.03…0.40) sits in the gap that opened between
  0.008 and 0.817 — nothing was re-tuned, the measurement was fixed. The clean tonal master is now a
  general profile with a 0.08 dose and a card that names only the bottom end it has.

### Fixed — the loop's own rumble meter read the hum repair

* **The rumble measurement notched the mains out to half an octave past each band, and a 2-pole
  filter does not stop at half an octave.** The harmonics in between leaked: measured on a clean bed
  with one line at −30.5 dBFS, 100 Hz read **+20.0 dB** of infra excess, 150 Hz +13.5, 200 Hz +9.0,
  250 Hz +5.9, 300 Hz +2.6 — and on a bed 10 dB drier, 30.1 / 23.4 / 18.5. So a mains harmonic of a
  recording **with no rumble** was read as rumble and the chain was asked for a 24 Hz high-pass: a
  repair the file did not need, which is the failure this round is about, in the other direction.
  The analysis now cuts the mains once, at the front, with one comb of constant-Q notches shared by
  the three low-band chains, and the reach is the measured gain of the chains themselves (a pure
  line at *f*, as HP → LP leaves it: −14.1 dB at 100 Hz and −21.0 at 150 in the 20–45 Hz band;
  −2.4 / −1.7 / −1.7 / −2.4 / −3.1 / −5.3 / −7.6 at 100/120/150/180/200/250/300 in the 90–203 Hz
  reference band). It covers every harmonic of both grids from the fundamentals to 420 Hz, and it is
  *fewer* biquads than the three banks it replaces. Measured after it: a line at 50, 60, 100, 120,
  150, 200, 250, 300, 350, 400 or 420 Hz reads 0.5–2.0 dB, against 1.6 dB for the bed with no line
  at all — and a realistic hum (50…250 Hz, −8 dB per harmonic, −30 dBFS) on a record that *has* a
  rumble leaves the verdict where it was (16.5 → 16.3 dB, guard 22.4 Hz; before the comb the same
  hum read 14.7). Two rows in the audit hold it: 'a mains line does not hide the rumble underneath
  it' and 'and a mains harmonic cannot fake one' (six frequencies, worst 1.1 dB).
* **What is left is measured and stated**: at 500 Hz the reference band is only 16 dB down, so a
  line there still reads −16.4 dB of excess — a harmonic stops mattering past 420 Hz only because it
  would have to sit within 16 dB of the fundamental. And a line that *wanders* (vinyl and tape
  wobble move it 0.2–2 %, far more than a 2.5 Hz notch follows) raises both bands by ~11 dB while
  the ratio does not move: a clean bed reads −0.1 dB and a rumbly one 14.5. A steady line is the
  case that fakes a rumble; a wandering one is self-cancelling. Both numbers are in the code.

### Fixed — the loop's own rumble meter read the hum repair

* **The row measuring the bottom end used 95–105 Hz as its reference — the second harmonic of a
  50 Hz mains line.** The chain's hum repair takes that line out, so the row read its own reference
  moving: measured, the export read 12.5 dB against a control of 10.8 while the app's own statistic
  said the bottom end had not moved at all (guard 0). The reference is now **82–94 Hz**, beside the
  line rather than on it, and the meter skips the ±5 Hz neighbourhood of every mains harmonic in
  both bands — the same exclusion the app's comb does, for the same reason. The same fixture now
  reads **9.0 → 8.4 dB against a control of 8.9**: honest about a rumble the chain left alone *and*
  about why (below).
* **A fixture whose rumble is a whisper reads like a coin flip, and it is.** The worn record's
  turntable noise is 33.5 dB under its own bed, i.e. right at the foot of the guard's decision
  (measured: 4.12 dB of excess for the upload, 5.2 for the source it was encoded from, against a
  knee that starts at 4.5 — the 128 kbit/s codec discards about a decibel of a noise floor that far
  below the music). Two measured facts decide what to do about it, and neither is a threshold to
  move: the guard would not have helped *anyway* (a 24 Hz two-pole high-pass takes 4 dB off a rumble
  that sits at 20–35 Hz: measured 12.25 → 7.67 on the same fixture with its rumble 12 dB louder),
  and the same fixture with the guard armed converges — the export re-reads 2.26 dB, i.e. the loop
  does not re-report a rumble it removed. The row is left showing the truth, and the gap it exposes
  (a rumble *above* the corner of the guard is not repairable with a high-pass at all) is the next
  item rather than a number to tune.

### Fixed — a line that hid the bottom of the record

* **A 50 Hz mains line walked straight into the reference band of the rumble measurement, and a
  60 Hz one did not.** The statistic compares a quiet passage's 20–45 Hz energy with its 90–203 Hz
  energy, and it notches every mains harmonic out of both bands — but the margin below a band was
  half an octave, and half an octave below 90 Hz is 60 Hz. So on a 60 Hz grid the fundamental was
  notched; on a 50 Hz grid it was not, and it needed to be: the band's own two-pole high pass at
  90 Hz passes 50 Hz at **−10.6 dB** (measured on the band's own chain: −10.6 dB as shipped, −10.7
  with no notch at all, −220 dB with one), which is 25 dB above the floor of a quiet passage.
  Measured on the same record, layer by layer: **+8.5 dB** of infra excess with rumble and hiss,
  **−12.0 dB** with the hum added, the reference band up 22 dB while the 20–45 Hz band did not move.
  The consequence was not cosmetic — the wound fixture's crackle-and-rumble record measured −12.8 dB,
  so the card said "no rumble", the chain was asked for `infraHP 0`, and the turntable's bottom end
  came out of the chain untouched while the card named hum. The margin below a band never goes under
  the mains fundamental now: the same fixture reads **+7.0 dB** and asks **19.5 Hz**, the 128 kbit/s
  upload that carries it reads −12.8 → **+5.8 dB** (18.5 Hz), and the two cases that must not move
  do not: a plain bed still reads +1.5 dB → `infraHP 0`, and the newer-song scenario stays
  healthy → healthy. On the loop's own rumble row the chain now takes the record's bottom end
  **down 3.6 dB** against its control instead of the 3 dB it appeared to add. Two rows in the audit
  hold both halves of it: the same record with 50 + 150 Hz reads 16.3 dB against 16.5 without it
  (guard 22.4 Hz), and a flat bed with the same hum reads 5.0 dB → 0 Hz.

### Fixed — a pop the ratio could not see

* **The de-clicker under-repaired exactly the pops that arrive where the music is loud in the same
  band.** Its detector asks one question — how far above its own recent average is this sample — and
  a one-sample spike is diluted by that average: the same pop reads a ratio of 7 on a quiet bar and
  2.3 on a bright one, while the knee that decides the repair depth sits at 2.2–2.7. Measured on the
  new audit fixture (8 s of pink low-passed at 9 kHz, 9 pops per second, 150 of them 4 dB or more
  over the bed): the median pop fell 22 dB and one pop sat **4.6 dB above the bed** — the loudest
  thing left in the file, and the row that was failing. The detector now reads a second witness, the
  *shape* of the deviation: over the last 2 ms the two polarities of the residual `x − LP4k(x)` are
  occupied equally by the music's own HF (asymmetry ≈ 0) and very unequally by an impulse (≈ 1).
  Measured: **0.85** median at the pops, **0.18** at a snare attack (a hit raises the *signal's*
  envelope too, so its HF is part of it and not a spike on top of it), and 0.8 % of a plain bed of
  the same material crossing 0.4. Two milliseconds is the window that separates the three — at 1 ms
  the music crosses 0.4 five times as often, at 4 ms the pops' own reading falls back into the
  noise's. A shape that is an impulse now asks for less of the ratio's confidence — a quarter of the
  scale at full strength, half that at the automatic dose — and that is what closed the row: the
  surviving pop falls to **−4.9 dB** over the bed, the loudest survivor in the block reads
  **−33.0 dBFS** against its −50 dBFS line, and the median pop still falls 22 dB. The price,
  measured on the same runs: the drum kit's touched fraction 3.2 % → **4.4 %** (the guard is 8 %)
  and its worst snare window −66 → **−62 dB** (the guard is −55). A bare impulse used to come out
  5.5 % intact; it now comes out **0.6 %** — which is the point of the stage, and it is why the
  latency probe in `tests/audit.test.js` was moved: it used to rely on the de-clicker *failing* to
  repair an impulse. The probe now times the delay with the stage engaged but turned down (where it
  repairs nothing, measured for every dose from 0.02 to 0.10), asserts the delay to the sample, and
  the full-dose case asserts the impulse is gone instead.

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

* **Every render began with a quarter of the unprocessed signal in it.** The master-power
  smoother started at zero and ramped to its target over ~18 ms, so the first ~50 ms of every
  render — and of every *export* — was a dry/wet crossfade, and it carried a quarter to a third
  of whatever the chain had just repaired. Measured on the worn-record fixture, the de-clicker
  took the pop at sample 193 (4 ms in) out completely (detector at k = 1.000, output 0.000) and
  the rendered file still had 25 % of its 1.30 spike in it, which is why the app's own 320 kbit/s
  export was still diagnosed `crackle` on a re-upload. The smoother exists for a *change* of the
  knob: the first block now adopts the target, and the re-upload card of that recording reads
  `hiss, codec` instead of `crackle, hiss, codec`.
* **The de-clicker swallowed the first five milliseconds of every file.** Both envelopes of its
  detector start at zero, so at the first sample `fast / (slow + 1e-9)` is 1e9 — the detector
  called it a click, and the repair replaced the head of the file with the low-pass prediction
  of a signal that had not arrived yet, which is silence. The two feed each other (`inp` comes
  from the *repaired* output), so on a plain pink bed the chain's output was exactly 0.000 for
  its first 256 samples. Seeding the envelopes from the first residual is not enough — the fast
  envelope's 0.6 ms attack against the slow one's 4 ms holds the ratio at 3–8 for another ten
  milliseconds — so the stage now spends its first 1.3 ms listening, seeds its statistic from
  the largest residual in that window, and then has a valid ratio from sample 64 on. An event
  inside the first 1.3 ms is not repaired; that is the stated cost.
### Fixed — the true-peak claim

* **The inter-sample peak was under-read by 0.5 dB on transient material, and the limiter shared the
  error.** The estimator was a seven-tap windowed sinc in both the measurement (`ispDb`) and the
  limiter (`ISP_TABLE`). Measured on a bright percussive master against two independent meters — a
  32-tap interpolator in the test toolkit and ffmpeg's `ebur128` — the app reported −2.10 dBTP for an
  export that both put at −1.60: 0.4 dB *above* the ceiling it had just been asked to hold, with the
  limiter's gain derived from the same wrong number. Both places now build one 32-tap Hann-windowed
  sinc at four phases; the three meters agree to 0.00–0.03 dB, and the ceiling lands at −2.10 dBTP on
  tonal, squashed and percussive material alike. The limiter's look-ahead grew by the kernel's extra
  reach (76 → 88 samples, 1.83 ms).
* **A permanent check that does not use the app's own meter** (`tests/dsp.test.js`, *the true-peak
  claim, measured by somebody else*): a 48-tap Blackman-windowed sinc at eight phases — more taps, a
  different window, twice the phase resolution — has to agree with `ispDb` within 0.15 dB, and a
  limited export has to be under the ceiling by *both* meters.

### Added — six defect classes that had no acceptance row

The matrix had ten classes and the diagnosis names fifteen. The six that were missing — weak bass,
boxy mids, dull top end, harsh presence, a squashed master, an out-of-phase bottom — now each have a
row with a before/after and an independent meter, and building them found four defects in the chain
(the ones below). What they measure today:

* **dull top end** — the air synthesiser rebuilds 8.3 dB of the missing top (9–15 kHz vs 2–4 kHz,
  −32.4 → −24.1 dB on the independent meter), and the analyser's `dullIndex` follows.
* **harsh presence** — the fixture is a 3 kHz honk two filters deep (the analyser compares the 2–4 kHz
  median with the 0.8–1.6 kHz one against a −3 dB/octave reference, so a honk needs +9.5 dB over its
  own slope before it is called harsh): `harshness` 0.93 → 0.54 and the meter 13.7 → 10.6 dB.
* **squashed master** — the chain backs *off*: glue 0.26 → 0.11, warmth 0.31 → 0.09, and the dynamic
  range does not fall further (16.2 → 15.0 dB on the envelope meter; the file is already flat).
* **out-of-phase bottom** — `bassMono` brings the below-200 Hz correlation from −0.55 towards zero
  while the above-2 kHz correlation stays at 1.00, i.e. the repair writes only where it belongs.
* **boxy mids** — a broad 240 Hz hump is cut by 1.3 dB (the per-song EQ takes 2.2 dB at 200 Hz and
  2.0 dB at 450 Hz); it is the shallowest row in the matrix and the next candidate for a dose review.
* **weak bass** — see below: the row is what found the defect.

### Fixed — the bottom octave that was not there

* **A missing bottom octave was being filled where nothing could be filled, and then taken away
  again.** The "weak bass" action is a 60 Hz shelf on the tone curve plus the sub-harmonic
  synthesiser, and both assume the recording has *something* down there: the synthesiser tracks the
  fundamental through a 95 Hz low pass — by design, since looking higher would double a normal bass
  line's second harmonic — and there is nothing to track on a file whose bottom octave is empty.
  Measured on a file high-passed at 200 Hz, with each stage switched on alone: the synthesiser stayed
  silent (34–58 Hz −96.7 → −95.9 dBFS) while the 60 Hz shelf wrote 3.5 dB into the same empty band,
  and the per-song corrective EQ — whose trend reference has been dragged *down* by the hole, so the
  200–500 Hz region measures as a hump — took 2.5 dB at 200 Hz and 3.4 dB at 450 Hz out of the region
  that carries that recording's bass. The chain made the file 2.4 dB *thinner* than it found it. There
  is now a measurement for the hole (`subHoleDb`, the 34–58 Hz median against the 80–150 Hz one:
  −25.6 dB for that file, +5.2 for a flat bed, +4.1 for a vinyl sim, −3.2 for a hummed transfer), and
  three consequences: no fill is dosed into a band that measures empty, the per-song EQ stands down
  (a hole is not a balance), and the synthesiser's analysis corner moves from 95 Hz to where the bass
  band actually is, so the octave it derives is one the recording can carry (200 Hz → 100 Hz). The
  acceptance row for the class: the 60–200 Hz region against 300–900 Hz goes from −9.30 dB on the
  input to −8.77 dB after the chain, where the same file used to come out at −11.69 dB.
* **…and the same measurement now has to run in both modes.** `subSrc` is a parameter, so a profile
  the user picked by hand carries the hole measurement too instead of the fixed 95 Hz corner.

### Fixed — the bottom of the record, and a honk that was not a note

* **The rumble statistic was one FFT bin wide — and the bin next to it is the mains line.** The
  comparison below 45 Hz against a reference band above it took both numbers from the spectrum of
  the 43 ms analysis frames. Those frames are 23 Hz wide, so the whole "20–45 Hz band" was a single
  bin, and on a recording whose bed is high-passed at 150 Hz — nothing below the music at all — that
  one bin read 12.5 dB of *excess* (the 50 Hz line leaking into it), while a plain vinyl sim with
  hum and crackle read +3.7 dB. Both are above the threshold that arms the sub-sonic guard, so the
  guard was taking the bottom off recordings it should have left alone. The measurement is now made
  with filters per sample — three 2-pole pairs (20–45, 45–90, 90–203 Hz), each carrying its own
  notches on the mains line and its harmonics, because a 2-pole high pass at 90 Hz still passes
  50 Hz 10 dB down — and the ratio is taken frame by frame and reduced with a median, since one
  crackle pop lifts all three bands inside a single frame. The reported figure now separates what it
  has to separate: a flat bed 1.4 dB, the same bed with +6 and +10 dB shelves below 150 Hz 2.7 and
  3.7, a bottom-less garage recording −26.0, a plain vinyl sim −14.0 — against 7.4 for the
  acceptance rumble fixture, 15.4 for the worn record with a rumble under it and 16.6 for rumble
  alone. The knee moved with the scale (4.5–11 dB) and the 43 ms-frame version stays in the
  analysis as the documented artifact.
* **A sustained note was reported as a room resonance and notched.** The scan asks whether a bin
  stands ≥ 3 dB above its own smoothed neighbourhood — and a note stands 50–100 dB above it:
  measured with the app's own scan, a 997 Hz sine reports 96.4 dB of "excess", a 220 Hz sine
  52.9 dB, and both pass the narrowness test with Q 6. The depth that fits a colouration was then
  cut out of the note (at 997 Hz, Q 6 is a 166 Hz-wide notch). A resonance is a few dB above its
  trend — the card calls anything over 3 dB boxy and saturates at 9 — so the scan now also requires
  the peak to be a colouration rather than a partial (≤ 24 dB, three times saturation), which also
  stops it from double-notching a mains harmonic that has its own, precise notch.
* **The measured resonance was cut by a third of what was measured.** The dose was 0.55 × the
  reported excess, capped at 3.5 dB, and the cap was what bound: on a +12 dB Q-4 ring over a bed
  the scan reports 5.5 dB and the chain cut 3.0, which left the ring at +1.0 dB above the bed with
  an independent meter (the bed's own reading is −1.2 dB). The scan reports a *narrow peak* while
  the ring it names is wider, and the Q it reports (6, clamped) is narrower than the ring as well,
  so the cut has to match the ring rather than the peak: 1.45 × the measured excess, ceiling 8 dB.
  Measured: the ring now comes out at −1.28 dB against the clean bed's −1.24 — removed, not
  halved — while the sibling third-octaves at 110 and 440 Hz move by 0.3 dB over the whole 0…9 dB
  range. The automatic statistic agrees: `resoExcess` 3.8 → 0.0 dB (was 3.3).
* **A profile the user picked by hand did not notch a measured resonance at all.** The manual
  ceiling table listed only the colour and synthesis parameters; `box`, `width`, `airRoom` and `hum`
  were absent, and a missing ceiling is not a no-op — `clamp(x, 0, undefined)` returns `x` and
  `undefined * n` is NaN, which `num()` turns into 0. Measured before: with a fixture whose
  resonance the scan had just reported as 5.5 dB at 217 Hz, `buildParams('vinyl', …)` asked for
  `boxG1 = 0` — the picked profiles ran the resonance notch, the stereo width and the hum ceiling
  entirely off. The repair ceilings are now inherited from the automatic table.

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
