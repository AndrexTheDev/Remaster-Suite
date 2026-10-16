<p align="center">
  <img src="assets/img/logo.svg" alt="Harmonic Restoration — a record whose groove becomes a waveform" width="140">
</p>

# Harmonic Restoration · Remaster Suite

**Audio restoration that runs entirely in your browser.** Drop in an old, muffled, hissy or
crackly recording — the suite listens to it, says in one plain sentence what is wrong with it,
and repairs it with a single slider. No upload, no account, no server, no cost.

```
drop a file  →  it gets measured  →  original ⇄ restored, click to compare  →  save
```

* **100 % client-side.** Your audio never leaves the device. There is no backend to talk to.
* **Real DSP, not a filter preset.** A `AudioWorklet` signals chain rebuilds harmonics up to
  16 kHz, synthesises the missing sub-bass octave, removes hiss and clicks, tames room
  resonances and level-matches the result for an honest A/B.
* **Static site.** Plain HTML + CSS + ES6 JavaScript, no build step, no framework, ready for
  GitHub Pages as it is.
* **Bilingual.** German and English — every label, tooltip, diagnosis and legal text.

---

## Quick start

### Just use it

Serve the folder over HTTP — any static server will do (GitHub Pages, a NAS, a Raspberry Pi):

```bash
python3 -m http.server 8080     # then open http://localhost:8080
```

> A `file://` open will *not* work: browsers refuse to load an `AudioWorklet` module from the
> local file system. Any http(s) origin is fine.

### Put it on GitHub Pages

1. Push this repository to GitHub.
2. *Settings → Pages → Source*: `Deploy from a branch`, branch `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/<repo>/`. Done — no build, no CI, no secrets.

Everything is referenced relatively, so it also works from a sub-folder, a CDN or `file://`-style
offline mirrors of a site.

---

## What it does

### Hear it first, read it second

The moment a file lands, the analyser measures it (8192-point FFT, noise-floor statistics,
crest/clipping analysis) and produces:

* a **plain-language diagnosis** — *"Sounds like a 1960s/70s garage or one-microphone recording.
  Standing out: little deep bass, boxy mids, dull highs, tape hiss."*
* a **sound-quality score** out of 100, before **and** after
* a **waveform comparison**: the original mirrored above the centre line, the restored version
  below it, in the same timeline
* measurement chips (peak, loudness, top-end cut-off, noise floor, dynamics, stereo width, clipping)
* **an honest progress bar while it works** — the stage (*"Measuring the sound …"*, *"Restoring the
  recording …"*, *"Writing the file …"*), a percentage and a coarse time left, on the file card and
  on a second bar above the list that names the file the queue is on. Steps that cannot be counted
  (the browser's own decode) sweep instead of inventing a number.

### On a phone

The suite is built to be used in a phone browser:

* **The card is on the list the moment you pick the file, with its name** — the analysis runs
  behind it, and a long name wraps instead of being cut off.
* **The job bar docks to the bottom edge** so it stays visible while you scroll the list.
* **Thumb-first controls:** every button and segmented control is at least 44 px tall, fields use
  16 px text (so iOS Safari does not zoom into them), and nothing depends on hovering.
* **No desktop wording:** with a coarse pointer the drop zone says *tap to choose* instead of
  *drop files here*, and it switches live if the pointer changes.
* **Safe-area aware:** the notch and the home indicator are respected — the bar and the footer
  keep clear of the gesture area.
* **Smaller memory budget** (420 MB instead of 900 MB estimated output) so a ZIP full of WAVs
  cannot blow up a mobile browser, and a **screen wake lock** keeps the tab alive during a long
  render. When the browser offers the [Origin Private File System](#streaming-batch-exports-opfs),
  that budget stops being a hard ceiling at all — see below.
* Verified in a real browser at 320, 360, 390, 414 and 768 px wide — no horizontal scrolling
  anywhere, in `tests/beta/beta.js` and the screenshot matrix in [`docs/beta/`](docs/beta).

### The one slider

**Restoration power** (0–100 %) scales every single parameter together. 0 % is bit-transparent
(you hear the untouched original), 100 % is the full intervention of the chosen profile.
60–80 % is where music usually sounds best — which is why the slider *adopts the strength the
detected profile recommends* the moment the first file is analysed. Touch the slider once and
your value wins from then on.

The profile is a **ceiling**, never a curve to apply. Every amount in the chain is dosed from the
measurement: a stage that *repairs* something (de-hiss, de-click, de-resonator, corrective EQ) only
moves when that problem was actually detected, and a stage that *synthesises* something (sub-bass,
exciter, air) only adds what was measured as missing, capped by the profile's budget. Three of the
repairs take the measurement literally, because a partial one is worse than none: the **mains notch**
is exactly as deep as the line it removes (a shallower one leaves the hum, a deeper one cuts the
bass), the **resonance notches** are exactly as deep as the peaks they remove, and the **de-hisser**
subtracts exactly the number of decibels of top end the analyser found to be noise. On material
that needs nothing, the automatic result measures as unchanged — `tests/tuning.test.js` renders
nine problem recordings and holds every octave band that carries content to ±3 dB, the music band's
loudness to ±0.8 dB, and the soft-clip guard transparent.

Seven of the chain's parameters are not amounts at all but *measurements of the file* — the mains
frequency, the frequency and sharpness of its two worst resonances, where its noise starts, which
split its de-hisser should use, how percussive it is — and four stages exist only when a file asks
for them: the **sub-sonic guard**, the **per-song corrective EQ**, the **de-esser** and the **bass
mono-maker** — the last of which fires on a *cancelling* bottom (a negative low-band correlation) and
never on a merely wide one: measured, an inverted-bass fixture reads −0.82 and is repaired in full,
while two independent channels read +0.06 and are left exactly as they were. They are computed from
that file's own spectrum, and on a recording that measures
clean they do nothing (on a 93/100 file: sub-sonic guard and de-esser exactly 0, mono-maker 0, no
corrective band above **0.2 dB**). Each one is visible in the analysis, in one plain sentence — and
when a file has several problems at once, automatic mode treats all of them (see
[More than one problem](#more-than-one-problem)).

Nothing in the chain is a fixed curve. The six profile bands above are anchors — ceilings — and
the **corrective EQ** is the part that is different for every song: twelve bands, log-spaced from
50 Hz to 8 kHz, correcting *this recording's* own departures from its own spectral trend, and
subtracting what the profile's bands are already doing so the two never add up. Its guard rails are
deliberate: a ±1.5 dB dead zone (so a linear recording is left linear), a cap of ±6 dB, no boost
where the band is within 18 dB of the measured noise, and no correction at all in a band the file
does not fill — an empty band is a boundary, not a tone.

Two bounds tell the difference between "a repair" and "overdriven", because a dull 1960s recording
has *nothing* above 9 kHz — a strict band-by-band limit would either forbid the repair or allow a
fake top end:

* a band the recording actually fills may not move by more than a few dB — measured, the automatic
  mode keeps every such octave within ±2.5 dB and the music band within ±0.3 dB of the original;
* everything the chain changes **above 6 kHz — synthesis, EQ, saturation — stays at least 18 dB
  below the music band** (12 dB even for a manually chosen profile pushed to 100 %). Filling a dead
  top octave is a repair; a top end that arrives at music level is a fake modern sound.

### Six sound profiles

| Profile | For |
| --- | --- |
| **Automatic** | reads the file and combines whatever it finds (see below) |
| **Garage / one-mic (60s/70s)** | thin bottom, boxy mids, rolled-off top, room noise |
| **Vinyl rip** | crackle, surface roar, rumble (hum is repaired whenever it is measured, whichever profile runs) |
| **Cassette de-hiss** | steady tape hiss, soft high-frequency loss |
| **Low bitrate brightener** | hard codec edge around 11–16 kHz (the biggest job for the exciter) |
| **General polish** | nothing dramatic, just better |

### More than one problem

Most real files are not one thing. The classic record in a private archive is a 1970s album, ripped
from vinyl, then compressed to 128 kbit/s by whoever put it online: crackle, surface noise, a dull
top end, a codec cliff — four problems, one file. A profile vote that keeps the winner and throws
the rest away is what leaves such a file half restored.

Automatic mode therefore works on a **chain**, not on a label:

* **The diagnosis names every problem it found**, not just the loudest one — *"Sounds like several
  problems at once: vinyl rip + heavily compressed file. Standing out: crackle, dull highs, …"* —
  and the ZIP report carries the whole chain (`detected : lowbitrate+vinyl+cassette`).
* **The tone is the mix** of the detected profiles' curves, weighted by how much evidence each one
  carries — 70/30 vinyl/codec gets 70/30 of the two curves.
* **A repair's permission is the union, the dose is the measurement.** Each profile allows so much
  de-hissing, de-clicking, sub-bass, air; a file that is both hissy and crackly gets the wider of
  the two budgets for each stage, and then the *measured* requirement decides how much of it is
  used. This is what stops a codec cliff from being capped by the vinyl ceiling, or a dirty cassette
  from being capped by the cassette's (deliberately cautious) de-click budget.
* **A wall is only a codec when it is where a codec cuts.** The analyser looks for the steepest
  1.6 kHz drop that *ends* — above it there is nothing left to lose. A cliff inside the top octave
  (4–17 kHz) is a codec's signature whatever else is in the file; a ceiling below 17 kHz only counts
  when the file's own dullness does not already explain it (that file gets the dull-top card, and the
  same air repair). Without the split the app called its own 320 kbit/s export "low bitrate" on every
  re-upload, because lame's antialias filter leaves a 15 dB wall at 18 955 Hz — a wall that removes
  nothing anybody hears.
* **Every threshold is relative to the file, never to full scale.** What a recording sounds like
  does not change when you turn the fader down, so neither may the answer: the same recording
  uploaded 20 dB quieter has to get the same repair, and the analyser has to *read* it the same.
  Every statistic is a ratio, a slope or a level relative to the file's own level, and the stages
  whose thresholds are a matter of taste (the glue, the analogue warmth, the harmonic synthesisers)
  read the file's own peak (`refDb`). Verified by measurement, not by intent: the analyser is run on
  the same six fixtures at 0 and −20 dBFS and every metric has to be identical (the levels exactly
  20 dB apart), and every synthesis stage has to render the same file *K* times down — the two
  outputs may not differ by more than −50 dB. Four absolute constants were found and removed this
  way: an inter-sample-peak walk that only looked at samples above 0.5 (a quiet file reported "no
  inter-sample peak"), a flat-top tolerance of 0.0025 (a quieter copy of one recording read as a
  *more* clipped one), a spectrum floor of −120 dBFS (the codec cliff of one fixture wandered
  1 740 Hz between two levels of the same file), and the exciter's reference cap of 0.02, which only
  bites on a loud file. The one documented exception is the true-peak limiter: it holds an *absolute*
  ceiling (−1/−2 dBTP), and a limiter that followed the fader would be broken.
* **A permission is not a dose, and a hint is not a problem.** A faint reading joins the tone mix as
  far as it is worth, but only real evidence unlocks a budget — and a file with one problem is still
  a file with one problem (measured drift on a solo cassette: 0.03 dB of tone and 0.00 of budget).

Measured on the case that started this: cassette tape with a little dirt on it, diagnosed as
cassette (its hiss is the bigger defect) with clicks on top. Applied in full, the cassette profile's
own budget still leaves **6 of the file's 10 spike windows** (windows whose high-frequency energy is
a spike rather than a burst — the statistic the detector counts, see the changelog); the chain's own
dose **0.60** instead of 0.20 leaves **none**. And on a real 128 kbit/s re-encode of a vinyl rip the
codec joins the chain at 0.46, which lifts the 7 kHz band correction from 0.0 to 1.5 dB.

### Batch

Drop as many files as you like. They are processed **one after another** (memory stays flat,
the browser stays responsive), every file gets its own card, and *Download ZIP* bundles all
finished results — with a `README.txt` describing what was done.

#### Streaming batch exports (OPFS)

A dozen 24-bit WAV masters held as plain `ArrayBuffer`s would blow past a tab's soft memory
budget (420 MB on a phone, 900 MB on a desktop — see [On a phone](#on-a-phone)) long before the
ZIP is even built. When the browser supports the **Origin Private File System**, the suite avoids
that entirely instead of just warning about it:

* `assets/js/opfs-manager.js` (`RSOPFS`) opens a `FileSystemSyncAccessHandle` **inside a
  dedicated Worker** — the one place the spec allows it — and every rendered WAV/MP3 is written
  there in ~4 MB chunks as it is encoded, never assembled as one in-memory buffer first.
* *Download ZIP* then assembles the archive **OPFS file → OPFS file**, entirely inside that same
  worker: a hand-written, streamed ZIP writer (STORE method, CRC-32 computed on the fly, sizes
  recorded in a trailing data descriptor) copies each source file a chunk at a time straight into
  the output file. The main thread only ever sees the final `{size}` — never the archive's bytes.
* The finished file is handed to the browser as a native `File`/`Blob`, so even the download step
  never duplicates it into the JS heap.
* Browsers without OPFS (or without `FileSystemSyncAccessHandle` — Safari < 16.4, Firefox < 111,
  very old Chromium) fall back to the original in-memory path automatically; the UI only shows the
  soft-memory warning when that fallback is the one actually in use.

`tests/opfs.test.js` runs the *exact worker source* `opfs-manager.js` ships to the browser inside
a Node `vm` context against a small OPFS simulator, including a multi-megabyte streamed ZIP that
is cross-checked with both the bundled JSZip and the system `unzip`.

#### Chunked rendering for long files and mobile memory limits

Streaming the *output* only helps once the file has already been decoded and rendered — a 96 kHz
FLAC or a multi-hour DJ mix still has to exist as one whole-length `AudioBuffer`, one whole-length
rendered signal and one whole-length encoded file in between, and on a phone that middle step is
the one that actually runs out of room. Three pieces close that gap:

* **Upload streaming.** A large freshly-picked file is copied into OPFS scratch storage the moment
  it is added (`RSOPFS.streamFileIntoScratch()` in `assets/js/opfs-manager.js`), read in bounded
  `file.slice().arrayBuffer()` chunks rather than one `file.arrayBuffer()` call — `app.js` then
  rebinds the card to that disk-backed copy. Small files skip the round-trip entirely.
* **Chunked offline rendering.** `assets/js/engine.js` adds `Engine.renderChunked()` alongside the
  existing whole-file `Engine.render()` (which is unchanged and still used for the live preview,
  the A/B window and every file below the chunking threshold). It renders independent, short
  `OfflineAudioContext` spans — 10 seconds by default, with up to a second of preroll so stateful
  filters (the mains-hum PLL, the de-click/de-clip detectors) can resettle, and a 50 ms lookahead
  tail — and blends consecutive chunks with a linear, level-preserving crossfade (not an equal-power
  one, which would add up to +3 dB at the midpoint of two near-identical, correlated renders of the
  same underlying audio) instead of a hard seam. Each
  finished chunk is hashed straight into an incremental encoder
  (`Codecs.createWavStreamEncoder()` / `createMp3StreamEncoder()` in `assets/js/codecs.js`) and
  written to the OPFS output file, then dropped — the full restored or encoded signal never exists
  as one array. `app.js`'s `renderCard()` only takes this path once a file is both long enough and
  OPFS is available; every shorter file still renders in a single pass exactly as before.
* **Mobile memory budget guard.** `assets/js/memory-guard.js` (`RSMemoryGuard`) reads Chromium's
  `performance.memory` heap snapshot where it exists (desktop and Android Chrome/WebView) and
  shrinks the next chunk size as the heap fills past 70%, down to a 2-second floor past 90%.
  `Engine.renderChunked()` consults it automatically between chunks. The signal is honestly
  Chromium-only — iOS Safari exposes nothing like it — so the real, cross-platform guarantee is the
  chunked architecture itself always working in small, bounded pieces; the watchdog is a
  best-effort second layer where the browser actually lets it look.

### Honest A/B

The **Original / Restored / A/B** switch cross-fades between dry and wet *inside* the processor
with an 18 ms ramp, so switching never clicks. The restored path is level-matched to the original
on the music band (300 Hz – 3.4 kHz, measured within ±0.3 dB), so "restored" never wins just by
being louder — and a rebuilt bottom or top octave cannot fool the comparison either. A/B mode flips
every four seconds by itself.

---

## The signal chain

Everything lives in [`assets/worklets/remaster-processor.js`](assets/worklets/remaster-processor.js)
and runs per sample, control-rate decimated for speed:

| # | Stage | What it does |
| --- | --- | --- |
| 0 | **Presence follower** | a 13 ms envelope against a one-second average; it gates every synthesis stage, so nothing is generated in a gap — the air and the sub octave arrive with the music, not with the noise floor |
| 1 | **Input DC guard** | 2 Hz one-pole: removes a damaged file's offset without rotating the phase of the 20–60 Hz region, where the sub-bass repair works |
| 1a | **De-clip (CBAR)** | a *plateau* in the waveform — one sample to over a thousand sitting flat at the file's own peak level, which is what a limited master (or, on an extended run, a historical transfer's motor overload) did to its peaks — is reconstructed by one of three models, in order of how much evidence the run itself carries. A **short** run (≤ 269 samples, 5.6 ms) is solved exactly as before: the run's implied overshoot comes from the local period of the zero crossings where one is trustworthy, from a Hermite cubic through the two real neighbouring samples and their slopes where it is not, and whichever model predicts more is the one taken. A **longer but still periodic** run — a slow, heavily overloaded bass note whose flat top outlasts the old 269-sample ceiling — uses the *same* length-solves-for-the-peak formula (a sine of amplitude A clipped at T stays at or above T for T/A ≤ cos(ω·len/2), which does not get weaker as the run gets longer: it is exact up to half the signal's own period, which is also the hard ceiling on how long a same-sign run can ever be) but draws it as a symmetric raised-cosine arc over the *whole* run instead of a single bounded cubic, because a long span has more independent length-evidence to lean on than two sampled boundary slopes do. A run with **no reliable period** (broadband overload, clipped noise) falls back to CBAR proper — Constrained Blind Amplitude Reconstruction: an order-16 autoregressive model (Levinson–Durbin) is fit separately to the 128 samples of real audio immediately before the run and the 128 immediately after, each run forward as a zero-input filter across the gap, the two extrapolations cross-faded with a raised-cosine weight, and the result constrained to never cross back below the measured clip rail — so a run nothing can be inferred about settles honestly at the flat top it started at, rather than at a guess. The detector keys on the measured plateau level of *this* file, not on a constant, which is what separates clipping from a merely loud waveform: a loud but unclipped recording measures 0.0007 % flat samples and 0.07 dB of implied overshoot, a clipped one 0.39 % and 1.7 dB. Measured on a 25 Hz tone at twice the clip level (70 % of each half-cycle flat, 679 samples long — far beyond anything the old 269-sample ceiling could touch at all) the shape error against the known original goes from −13.9 dB unrepaired to −33.7 dB repaired by the periodic model; a milder 30 Hz/456-sample case goes from −18.0 to −43.7 dB; a clipped noise burst (no period to find) still produces zero non-finite samples and never reads worse than the flat top it replaced. It runs first among the repairs, before anything else looks at the waveform — and the output guard's knee moves up with whatever the stage reconstructed (a per-file maximum), because that guard sits *below* the plateau of a clipped master and would otherwise flatten the restored arc straight back into the flat top it came from: on a 997 Hz tone clipped at 0.99, −16.2 dB of error left in the plateau with a fixed knee against −29.1 dB with the knee lifted |
| 1b | **Sub-sonic guard** | a 4-section (48 dB/octave) high-pass at the corner the measurement asks for: 18–24 Hz where a turntable's rumble sits *below* the music, escalating to 42 Hz — the top of the band the statistic calls rumble — only when the quiet passages are **saturated** with it (8 dB or more of the app's own excess). A turntable's rumble lives down there and no instrument does, which is why the corner stays low unless the floor itself is the defect |
| 2 | **Static EQ bank** | 6 biquads: 60 Hz shelf, 200 Hz mud, 450 Hz box, 1.3 kHz honk, 3.2 kHz presence, 7 kHz air — the profile's anchors, dosed from the measurement |
| 2b | **Per-song corrective EQ** | 12 bands, 50 Hz … 8 kHz at Q 1.4, correcting the file's own departures from its own spectral trend — net of what the six profile bands do. ±1.5 dB dead zone, ±6 dB cap, no boost near the noise floor, no correction in a band the file does not fill |
| 2c | **Measured resonance notches** | the two strongest narrow peaks the analyser finds (150 Hz – 1.8 kHz, ≥ 3.2 dB above the local trend), each notched at its own frequency, depth and sharpness. A boxy room is a *constant* colouration, which the dynamic de-resonator below cannot see |
| 3 | **Dynamic de-resonator** | 6 narrow bands (220 Hz … 3.1 kHz) watch their own envelope against a long-term average; anything ringing way above it gets pulled down. Steady tones pass, room ring does not. |
| 4 | **De-click** | low-pass prediction (4 kHz, 4th order) plus a fast/slow envelope ratio, and 1.35 ms of look-ahead: a detected impulse plans a repair window that reaches half a millisecond *in front of* the spike (a codec puts most of a pop's energy there) and 1 ms behind it, and the window is replaced by the prediction with tapered ends. It runs *before* the de-hisser, because a pop is broadband: anything in front of it that works on the top end eats part of it and leaves a remainder the detector cannot be sure about — measured on a worn record (music + hiss + crackle) the de-hisser in front pulled each pop's sample down to 18 % of its height and still left 6 pops above a clean copy, behind it 0. Every decision it makes is relative to the file (the fast/slow *ratio* of the high band, then a level gate against the file's own one-second HF activity), so a quiet transfer is repaired exactly like a hot one: with an absolute level gate the same fixture kept 63 pops at −24 dBFS against 6 at 0 dBFS, while the ratio statistic is literally unchanged (p50 1.08, p99 2.3, max 6.7 at both levels). The look-ahead is the stage's own latency — see below. Its amount is a repair *depth*, so the intensity curve is its transient margin and not a taste: measured, applying the de-clicker as measured (20 % more at the default) buys one pop of a 72-pop fixture and costs the kit 6 dB of snare — the audit suite pins that comparison. The *shape* discount is not a lever either: doubling its weight and moving its band down to 0.28…0.36 costs five times the kit price and seven times the clean-master price for the same pops, and the survivors read ratio 2.03 / 1.86 / 1.80 against a knee that wants ≈ 2.22 at the default dose and ≈ 2.04 at full strength — so the *map* is unchanged, and what closed that floor is a **third witness**, on a different quantity altogether: not how big the residual is next to its own average (that is a band statistic, and a pop quieter than the bed's own top end has no size there), but what the *waveform* may do between two samples. Content below 9 kHz has a hard ceiling on its second difference — |D2| ≤ (2·sin(π·f/fs))²·A, 0.35·A there — while a one-sample delta produces |D2| = 2a at its own sample whatever the bed does, so the *ratio* of the two is scale-free and bandwidth-free by construction. Measured in σ of the local D2 over the 2 ms before the sample in hand (probes tools/work/sp1.js … sp11.js): the three survivors read **8.3…11.4 σ** in four different beds, the pops the ratio already catches ≈12 σ at the quietest and ≈31 σ at the median, while a drum machine reads 0.008 % of its samples above 5 σ, the audit's wide clean master 0.000 % above 4, the clipped hot master 0.000 % above 5, a loud tape-hiss bed 0.001 % above 5, and the matrix's own percussion performance **0 of 8 s above 8 σ**. The branch is folded in *before* the dose-dependent knee, and both halves of that are measured: a hi-hat's onset is a step in this statistic too (52 σ, because it rises out of the quiet bar before it), and the knee is what keeps the stage off it — bypassing the knee moved the worst of the performance fixture's 16 hits by **1.63 dB**, through it by 0.1 dB. The band was then swept against everything the stage is guarded by, per 8 s of material: 5+3…8+4 σ leaves three pops of the four-bed floor probe, 4.5+3…6.5+3 leaves one, **4+3…6+3 leaves none** — and at every one of those bands the worst performance hit reads 0.52 dB, the snare −62.1 dB and the clean master 2.74 %, to the digit: closing the floor costs half a percentage point of the kit being touched (4.40 → 4.94 %) and nothing else. The matrix's section 1 row now reads **72/72 → 0/72** pops above the clean copy where it read 3/72, the four-bed probe reads 54/54 in every bed, and the audit's floor section carries both states side by side — the same renders with the witness switched off are the control that keeps the old numbers honest. The *diagnosis* that orders that repair is gated once, because a crest factor cannot tell a performance from damage: the file's spikes must stand ≥ 6 dB above the file's own median crest (*contrast* — a square wave has none). A second, *duration* gate (fewer than 15 % of the spike windows wider than 0.25 ms) lived here too and is gone, because of what it threw away: it was tuned on the harness's click model — one to three samples — and a click as a file really carries it is a **damped oscillation at the cartridge resonance**. Measured on a 9 kHz ring at 9 per second, τ 0.1 / 0.3 / 0.6 ms reads index 1.00 / 0.89 / **0.00**: 21 % of the 0.6 ms ring's spike windows are wider than that bound, so the file read healthy, got no dose from the chain and kept every click — the beta report. What guards a performance is not duration but the *duty* gate in front of the crest statistic: a hit has a body and a top end that outlives its attack, so a window that carries one is filled with the top end and never becomes a spike. Measured, a kick+snare+hi-hat groove, a snare with a 130 ms top end, a roll at 8/s, a hi-hat with 45 ms, a crash with 800 ms, a clave, a rimshot, a stick click with a 900 Hz body and a 4 ms burst with a 1200 Hz body read **zero** spike windows, and the same chain's de-clicker moves a drum performance's hits by 0.31 dB of peak worst in the regression guard (median −0.27 dB; §20's own fixture reads −0.06 / 0.31 dB of 16 hits at the profile's floor dose of 0.072, both columns at each render's own latency) — while the burst the old gate was tuned on (24 × 0.4 ms of HP-3 kHz noise, no body, no tail) is a click train by every statistic here and is repaired as one. A *dropout* — a hole rather than an impulse — is the class it does **not** see, and that is measured too: a mute of 1–12 samples costs the 0.3–4 kHz band nothing at all (the band-limited signal heals it), 25/60/120 samples cost −6.8/−9.8/−12.8 dB, and the stage fires on none of them at any length (the witness watches the high band, where the prediction smears a gap's edges, so the ratio reads 1.24–1.94 against the 2.2 knee; and both replacement witnesses — a body-band envelope dip, and the ratio *falling* — read as deep on plain music as at the holes), while a fill would need a longer delay line than its 1.35 ms of look-ahead or the un-filled head would land as a step. The acceptance matrix carries the class (`dropouts`) and the audit pins the bound. §20 of the acceptance matrix carries both directions, measured by the app's index and by an independent 4–12 kHz time-domain meter. Round 18 closed the ninth member of the family, and it is the length a real stylus click rings at: a **1.5 ms ring fills its window**, so its duty (p50 0.063) sits in the band a sibilant onset occupies (0.045–0.12) and the file read index **0.00** off a *single* spike window — no card, no dose, the clicks left in it. The admission that takes it is the window's **tonality** (the spectral flatness of its 6–24 kHz content: 0.055 at τ 1.5 ms, 0.269…0.584 for a sibilant onset, 0.488…0.587 for a hi-hat), with three guards worth their own numbers: a duty bound (0.25) that only ever excludes a *sustained* tone; the index's own 13 dB knee, which a window must reach to be admitted on tonality at all — without it the matrix's own **clean** bed admits one window of 400 whose HF is almost nothing (duty 0.226, flatness 0.040, crest 4.17, energy 0.41× the file's median) and the same window appears in *every* fixture built on that bed; and the same knee on the repetition rank — without that, a 320 kbit/s export of the **clean** sibilance fixture read **0.155** off its own noise and the app named `crackle` on its own export. The family then reads 0.73 / 0.62 / 0.51 / 0.39 at τ 0.6 / 1.0 / 1.5 / 2.5 ms where the shipped detector read 0.73 / 0.55 / 0.00 / 0.00, every music fixture stays at 0.00 (hi-hats, sibilants, a 9.2 kHz bell, a note in the band, a drum performance, a clean bed, the sims), and the matrix carries both halves of the repair: the 1.5 ms ring's per-click 4–12 kHz peak comes down **13.7 → 1.9 dB** — its onset to **−2.1 dB** over the clean copy from +17.7, and the ring-out behind it, which a second-difference witness reads as music, from +11.7 to +3.6 (the row below measures that window for its own sake and reads 9.9 → 2.7 dB: it takes the window's own peak). **Round 19 repaired that ring-out**, the largest lever the round-18 report left on the table, and the way it is done is what makes it safe: when the detector fires, the *same* detection asks for the tone behind it to be **fitted** — 48 samples of the delay line (1 ms), matched against one damped sinusoid on a grid of τ (0.4…4 ms) and frequency (6…13 kHz, 250 Hz steps), the fit licensed by **R²**, the share of the window that single tone explains: 0.23…0.50 over the ring family against 0.008…0.097 over hi-hats, a kick/snare/hat groove, twelve "s" bursts and clean beds, so the gate (0.2) sits in the measured gap. What the model explains is subtracted from the *emitted* sample for up to 3τ with a 1 ms fade, weighted by the de-clicker's own repair mix (1 − m) — the repair window has already removed the ring with weight m, and subtracting at full weight re-injects it inverted (measured: the file read 0.94 where it had read 0.51). The stage runs inside the same delay line the repair uses, so it costs no second look-ahead: the look-ahead is **65 samples** instead of 17, i.e. 1.35 ms. Measured through the whole chain, the family's own index reads **0.73 / 0.62 / 0.51 / 0.39 → 0.00** at τ 0.6 / 1.0 / 1.5 / 2.5 ms (the ninth member of the family: 0.512 → **0.000**, `crackle` → `healthy`), the per-click 4–12 kHz peak **13.1 → 0.8** dB on the 0.6 ms ring and **13.7 → 1.9** on the 1.5 ms one, the blip train's own index 0.47 → 0.00 (the matrix's crackle section reads 72/72 → **0/72** under its own chain — while the worn record's own row still counts **2 of 72**, which is the 128 kbit/s arrival's top end and not the click: the ring is what this stage repairs, the encoder's own floor is the boundary below), and every music fixture still reads 0.00 with **zero fits** where the family gets 55–65 of its 72. The price is stated the same way: a *damped* 9 kHz burst under 10 ms — a synth blip — is indistinguishable from a ring in every statistic measured, so it earns the tail's fit as well as the spike window's repair: it reads 0.47 where it read 0.00, and its band peak loses **12.0 dB** where the round-18 price was 8.75. |
| 5 | **De-hiss** | Linkwitz-Riley split, keyed on the *tilt* of the top end (4 kHz+ against the 1.45 kHz band — the same two bands, cascaded the same way, in the same 2048-sample window the analyser measures), so it attenuates where the top end stops following the programme and leaves everything else alone: on a cassette-class file the same repair is worth 3.2 dB between the notes and 0.2 dB over music. Getting the mid band's cascade right was worth 4.4 dB of ask on the frames a hiss owns: with one filter instead of two, the key's reference reads the noise's own body and the quiet frames' tilt comes out 4.38 dB low. The split itself is measured too (2.2–4 kHz, where this file's noise starts). The gate closes over 60 ms and opens in 8 ms — the closing lag is worth 1.9 dB of the repair on the hiss fixtures for ≤0.2 dB of the music's own top end, and the pops are untouched at every close time because the de-clicker runs in front of it — and its last 0.1 % of range is a continuous crossfade rather than a branch. Its level reference is a band RMS measured exactly like the key (same band, same 2048-sample window), so it needs no absolute ceiling — and with one at 0.01 it went quiet on anything louder than −49 dBFS: measured on one recording rendered at 0 and at −20 dBFS, the finished files were 12.6 dB apart with the ceiling and 33.5 dB apart without it. Its own shape was the next limit, and it was structural: `low + high` is the Linkwitz-Riley allpass, so `low + high·g` sums back a unit-magnitude copy of the whole signal at the gate's gain — measured as a static transfer with the gate held closed (probes hiss12/hiss13), the split delivers **26 / 47 / 63 %** of its request at 4 / 6 / 8 kHz (a steeper split is worth 1.0–1.4 dB, a lower crossover 0–1 dB: neither is the lever). Where the two floor witnesses agree — the key band at the measured HF floor *and* the tilt anomaly at its measured maximum — the missing part now comes from a high-shelf on the same corner, at 0.75 of the measured step; the fraction comes from a four-fixture sweep in which the pause floor stops falling after it and the pauses' own tilt crosses the music's there (hiss19). On the acceptance hiss fixture's pause frames (probe hiss24, dB over the clean copy at 1–12 kHz) the chain went 11/16/17/17/17/18/21 → **9/12/12/11/8/8/10**, the tilt step the card prints 18.35 → **0.00 dB**, its amount gate 1.00 → **0.39**, and the user's own re-upload workflow (`tools/workflow-check.js`, worn record → MP3 320) reads `hiss` → **healthy** while the loud and soft musical frames stay within 0.06 dB per band (a forced dose on loud music is bit-identical). The automatic dose only asks for the repair when the measurement found a tilt step, because on a *stationary* top end — a dull pad, a synthesizer bed — the quiet-frame floor and the programme are the same number and the gate cannot tell hiss from music (a clean dull bed measured 0.04 dB of tilt step and lost 4.3 dB of its 9–13 kHz band to the profile's half dose). Round 15 measured what the *tilt* term cannot see: a **broadband** floor — an arrival's own top end in a quiet passage, e.g. a 128 kbit/s MP3 — lifts the 4 kHz+ band and the 1.45 kHz reference together, so the tilt difference stays at 0.0 dB while the level key allows 19–20 dB of cut, and the floor survives (on the acceptance fixture's quiet-passage pop the arrival's own top end stands **22.2 dB** over the clean copy's and the stage takes 1.3 dB of it). Where a frame's tilt *does* sit above the reference, the same burst comes out **15.2 dB** down. Reading the broadband case would mean a *local* instead of a *file-wide* reference — a depth policy, and one the suites pin on purpose (`dsp.test.js`, "the floor regime delivers what was measured"). Round 16 built that lever anyway and priced it: letting the *level* key decide where the tilt term reads nothing buys **~9 dB** on the worn record's arrival floor, but the app then names a new defect on its own exports (`dullTop` on the hiss, cassette, vinyl and worn rows, which read `hiss`/`healthy` before) — the level key cannot tell a quiet top end from a floor one, so the answer would have to be a *content* witness in the analyser, not a retune. It is not in the tree; the numbers are in the changelog. Round 17 also measured the *content* witness that would gate this arbitration — the shape inside the key band (11 kHz against 5.5 kHz): it separates analog hiss from programme with room to spare (**+1.8…+2.1 dB** on the noise-owned frames against **−3.2…−4.9** on the music-owned ones), but it is **redundant with the tilt term** wherever it opens (88 of 88 frames already ask the full measured step — a flat top end *is* the tilt anomaly), and at the codec residue it reads *programme*, correctly: the encoder's error is shaped like the music it encoded. Round 20 then measured the statistic a *band-level* repair would have to key on — the HF excess over the local programme — and it is the music that closes it: the pops' neighbourhoods come out of the chain at the level of the clicks-free copy (p50 2.3 dB against the control's 2.0, from 11.9 on arrival), while **hi-hats read 20.4 dB** and twelve "s" bursts 9.8 of the same statistic, i.e. a gate on it would cut cymbals harder than it cuts the defect. So that residue is the arrival's, and it stays a documented row rather than another repair |
| 5b | **De-esser** | a dynamic dip over 5.2–9.5 kHz, keyed on the fast/slow ratio of that band: a quiet "s" and a loud one are the same problem, and a recording without sibilance measures zero. The *diagnosis* that arms it is a per-frame scan of the 7 kHz/2.6 kHz balance, and it has been cheated twice by material that is not a sibilant — a phrased organ (the 2.6 kHz band falls between the phrases, so the balance "rises" 4.3 dB: the old scan read 4.29 and the card named `sibilance` on a clean organ) and a sustained cymbal wash (the balance is over zero *all the time* — a wash breathes everywhere — and the median tilt of +4.73 dB, real enough, was amplified by 2 into a 0.61 dose). The scan now asks two things of the peak frame: the balance must *cross over* (7 kHz above 2.6 kHz, the one claim a sibilant makes by definition) and the file's own median balance must not already be over zero — and a file whose median frame *is* top-heavy is asked for a band-limited top end (7 kHz over 12 kHz: −0.5 dB on the wash, +2.1 on a continuous "s", +4.1…+4.8 on every burst fixture) before its median tilt may count as evidence. Measured: the organ 4.29 → 0.00 and the wash 2.52 → 0.00 of scan, both `deess 0.000`, both never ducked by the chain (+1.00 and +0.35 dB of 7 kHz, the tone stage's own lift); a singer whose "s" never stops still reads `sibilance` with a 0.558 dose and the chain takes its own 7 kHz band down 5.0 dB. Its amount is a *measurement*, like the de-hisser's: the law hands it zero unless a departure was measured, so the intensity curve was scaling the file's own reading — it took 0.830 of it, and the app's own export of §10's burst fixture came back diagnosed `sibilance` because of it. Measured with the curve removed (probes `sib11/sib12.js`, and the acceptance matrix's own §10 rows): the 7 kHz band of the loudest frames down 3.06 instead of 2.61 dB, the scan the card names the defect with 5.46 → 2.43, and the export **healthy** at a 0.226 dose against the 0.255 naming line. Every clean fixture still measures a dose of exactly 0. It sits before the synthesisers, so the exciter and the air cannot rebuild what it just removed |
| 6 | **Harmonic exciter** | 3 bands, each: band-pass → asymmetric saturation (even *and* odd harmonics) → band-pass → envelope gate. Synthesise the overtones that were never recorded. |
| 7 | **Air synthesis 8–16 kHz** | takes the surviving 4.5–7.5 kHz band and generates 2nd/3rd order content above it, gated by the presence follower and limited to a fraction of the band it came from |
| 7b | **Neural air coupling (optional, off by default)** | six fixed peaking filters (8–22 kHz, clamped to ±12 dB) re-shape what stage 7 just built, driven by a dB correction curve an optional neural model predicts *offline*, once, from the dry source — see [Optional neural enhancement](#optional-neural-enhancement). It never synthesises a waveform of its own; stage 7 stays the only thing that puts energy above the cliff, this stage can only re-shape it, and it is bit-identical to not existing unless both a curve was posted and the control is turned on |
| 8 | **Sub-bass 30–60 Hz** | 6th-order low pass → hysteresis zero-crossing detector → divide-by-two pitch tracking → oscillator with a gated envelope. A 60–120 Hz bass line gains its missing bottom octave. |
| 9 | **Glue compressor** | soft 2:1 with automatic make-up; attack and release follow the file's measured percussive character. When `dynamicRangeDb < 12`, the dose is halved and warmth is capped: a squashed master is not compressed again. Measured on the acceptance fixture, the app reads **8.70 → 8.27 dB** and the independent 20 ms envelope reads **12.82 → 11.45 dB** — the class stays `squashed`; no transient shaper is shipped because the peaks are no longer present to reconstruct |
| 10 | **Warmth + tilt** | gentle saturation and a low/high shelf pair for the final tone balance |
| 11 | **Stereo (M/S) & tape-azimuth correction** | before the mid/side split: a sliding cross-correlation between the high-passed (above 3 kHz) channels finds the sub-sample lag that maximises their agreement over a 12 ms window — refined to a fraction of a sample by a parabolic fit through the search's peak and its two neighbours, re-estimated every 20 ms — and the lagging channel is delayed to meet the other through a first-order (Thiran) fractional-allpass filter, phase-only and with no look-ahead of its own. This is the repair for a tape head tilted a few microradians off true vertical (a worn cassette or reel transport's classic defect): the two tracks are read a few hundred microseconds apart, which is inaudible as a polarity fault (a bass wavelength dwarfs the skew, so the bottom stays correlated) and turns into a comb filter the instant the pair is summed to mono, which is the complaint an off-azimuth transfer actually produces. The correction is its own guard: `confidence` is the normalised correlation improvement the estimated lag actually delivers over doing nothing, so a hard-panned mix or a double-tracked part that only *looks* like a timing defect is left alone, and silence or an already-aligned pair reads the same way. Measured against a known ground truth (a broadband signal and a copy of it delayed by a known sub-sample amount): the mono-sum high-band energy loss from the comb filter goes from −1.0…−3.8 dB at 1.2–2.7 samples of simulated skew to −0.05…−0.09 dB once corrected, independent L/R material keeps a confidence of 0.1 or below (no audible correction applied), and an already-aligned pair is not pulled apart. After alignment: a bass that measured out of phase in one channel is folded to mono below 200 Hz; the side signal of an image that measured narrow but not mono is lifted back towards the programme's own bandwidth, and a mono master is never widened |
| 12 | **Mains hum notch, adaptive PLL-tracked** | three biquads, three hertz wide, at the mains fundamental and its harmonics — dosed from the level the line stands above its own neighbourhood, and placed *after* every stage that can put low-frequency energy back. Bypassed completely when nothing was measured. The frequency driving all three notches is no longer the value measured once at t = 0: a per-channel software PLL (lock-in/synchronous detector) tracks it continuously across the whole file, inside the 45–65 Hz capture range the task specifies. A self-tracking bandpass (Q ≈ 6, recut only when the estimate has moved enough to matter) isolates the fundamental's neighbourhood; a local oscillator is quadrature-mixed against it and each arm low-passed at 6 Hz, which leaves the two mix outputs converging on (A/2)·sin(φ−θ) and (A/2)·cos(φ−θ) — so `atan2(mixI, mixQ)` is the signed phase error, zero at lock, independent of the hum's own amplitude; a critically damped PI loop filter (natural frequency 0.3 Hz, chosen so the estimate settles in about a second without overshoot) steers the local oscillator's frequency, which is what the notches are retuned from. A motor that holds dead steady needed nothing extra: the measured mains notch above already covers it. What it does not cover is the motor that does not hold steady — a worn belt or a tired capstan loses a hertz or more of platter/transport speed over a side, which is wider than the notch's own three-hertz skirt — and that is what this closes: on a synthetic 50 → 48 Hz linear drift over 20 s (realistic worst-case belt wear, deliberately built wider than the notch skirt so a lucky-width pass cannot be the reason), the line that survives a frequency-frozen notch at −19.3 dB comes down to −22.9 dB once the PLL tracks it, 3.6 dB of extra attenuation measured against the drift's own known instantaneous frequency, not a fixed bin (`tests/dsp.test.js`). A first implementation of the phase detector used the mathematically adjacent but wrong convention (`atan2(mixQ, mixI)` with the quadrature arm built from `xb·(−sin θ)`), which puts the detector's zero at a quarter-cycle phase error rather than true lock: on a steady, driftless 50 Hz tone the estimate did not hold 50 Hz, it walked monotonically away from it (49.99 Hz at 0.5 s to 49.73 Hz at 9.5 s and still falling), the same class of sign inversion row 11's azimuth corrector shipped with and was caught by its own regression test — fixed the same way here, before it ever reached the worklet |
| 13 | **Output** | 2 Hz DC guard (keeps the offset the saturation stages can add out of the export), auto level match, then a tanh soft-clip guard that saturates at −0.02 dBFS so a 16-bit export can never hit the rail. Its knee — and the hard rail behind it — moves up by whatever the de-clipper reconstructed, so the guard that protects the export cannot undo the repair; on a file that was not de-clipped both are exactly what they always were |
| 14 | **True-peak limiter** | the export ceiling. Samples under full scale do not mean the *waveform* is under it, and a codec that has to encode an overdriven waveform distorts it — so the last stage holds the file to the true-peak target every streaming service asks for: −1 dBTP, or −2 dBTP when the master is louder than −14 LUFS. The peak is estimated between the samples with the same 32-tap windowed sinc the *measurement* (`ispDb`) uses — one shared definition of what the waveform does between the samples, so the stage that enforces the ceiling and the meter that reports it cannot disagree. It was a seven-tap sinc once, and on a bright percussive master that read 0.5 dB low: the export measured −1.60 dBTP by two independent meters while the app claimed −2.10, i.e. over the ceiling it had just been given. With 32 taps agreeing with ffmpeg's `ebur128` to 0.00–0.03 dB on tonal, squashed and percussive material, the ceiling holds where it says it does (−2.10 dBTP measured on all three). The gain is computed 1.5 ms ahead of the sample it applies to and minimised over that window, and the detector is shared between the channels so the image cannot move. A file already under the ceiling is bit-transparent (`gain = 1.000000`, no level change); a file over it comes down by the overshoot it had — and the *file the user keeps* is the MP3, not the render: a lossy encoder re-shapes the waveform between the samples, so its own overshoot comes out of that promise. Measured through the app's own export path (lamejs, the app's 16-bit dither and its 72000-sample chunking; ffmpeg's `ebur128` as an independent 4× oversampled meter), a dense master rendered *at* its ceiling comes back **+2.00 / +0.60 / +0.40 / +0.40 dB** over it at 128 / 192 / 256 / 320 kbit/s — and at 128 kbit/s the app's own findings list then named `truePeak` on the re-upload of its own export, the same shape of dishonesty as the sinc that read 0.5 dB low. So a lossy export lowers the render's ceiling by the worst overshoot measured at that bitrate (`Presets.codecMargin`: 2.1 / 0.8 / 0.5 / 0.5 dB) before the encoder ever runs, and the monitor is built from the same parameters, so what you hear is still what you save. A file that stays under the ceiling is bit-transparent to the margin (measured: 0.00 dB), so the room is only paid for by a master whose limiter is already working. The bitrates the UI offers (192/256/320) each carry their own margin, and the audit re-derives that arithmetic from the export markup itself |

The dry/wet cross-fade happens at the very end: `out = dry + power · (wet − dry)`. The chain is
minimum-phase IIR throughout, so it adds no delay of its own — with three exceptions, all of them
repairs that cannot be done without seeing a little of the future:

* the **de-clicker** needs half a millisecond of look-ahead to repair the part of a codec-smeared
  pop that sits *before* the spike the detector fired on (17 samples at 48 kHz, 0.35 ms), and the
  millisecond *behind* it that the click's ring-out is fitted over (48 samples, 1.00 ms — one number, 65 samples);
* the **de-clipper** waits for the end of a flat run before it can reconstruct it, plus — now that
  an extended, non-periodic run falls back to CBAR's forward/backward AR model — the 128 samples of
  real audio collected *after* the run for the backward half of that fit (1330 samples at 48 kHz,
  27.7 ms: 1200 the longest run it will ever track open-ended, plus 128 of trailing context, plus a
  few samples of margin). A short or periodic run resolves in a fraction of that and never needs the
  worst case, but the stage's reported latency is one fixed number regardless, so the chain stays
  sample-aligned whichever model a given run actually took;
* the **true-peak limiter** computes the gain 1.5 ms ahead of the sample it applies to, plus the
  sixteen samples the interpolator reaches past that interval (88 samples at 48 kHz), because a
  ceiling that is only enforced after the peak has passed is a clipper.

The sums are reported per render (`latency`, 0 when the stages are off), and the cross-fade delays
its dry side by the same amount, so the A/B switch and the strength slider stay phase-coherent and
sample-aligned: you hear the change and not the delay. With the repair stages off — or at strength
0 — the latency is exactly 0. The offline render (the file you save) is bit-identical to what you
heard live either way.

**The whole chain is scale-free, and that is measured end to end.** A transfer that arrives 12 dB
quieter is the same record: over 0 … −40 dB of input the *decisions* (card and issue list), the chain's
*action* per band (identical to ≤ 0.1 dB), the *delivered* defect statistic (≤ 0.11 dB, on the 4 kHz+
level of the quiet frames against the same frame's body band) and the app's own index (`hissAmount`,
`crackleIndex`, `sibExcessDb`, to 0.01) all come out the same on every fixture — and the meter itself is
*exactly* linear (a −40 dB input reads back at −40.0000). What makes it work is not that the doses ignore
the level, because they do not: on the quiet copies the taste doses read up to 2.2× higher (exciter 0.0211
→ 0.0527, glue 0.0927 → 0.2317, warmth 0.1523 → 0.3323 on a crackly bed, plateau from −12 dB) and the
de-hisser's dose settles 0.02 lower and stays there. It is that every parameter which carries a level in
dBFS — `refDb`, `hissFloor`, `noiseFloor`, `declipLevel` — moves by *exactly* the gain, so a compressor
threshold and a hiss floor land on the same point of the signal whether the transfer arrived at −3 or at
−40 dBFS: at *fixed* parameters the same de-hisser is not scale-free at all (a −6 dB copy differs by
1.2 dB of waveform), while the delivered files match at −41.5 dB. The audit row `scale freedom`
re-measures both halves at 0 and −12 dB on a hiss and a crackle fixture, so a new stage that reads a
level without carrying it fails there instead of on somebody's record. The one thing that does *not*
scale is the delivery itself: the chain does not lift a quiet file — a −20 dB transfer leaves at
−20 dB, exactly — which is the level stage's job and not this property.

### Offline render

Saving runs the same processor in an `OfflineAudioContext` — with `suspend()`/`resume()` progress
reporting instead of blocking the tab — at the **source sample rate** (the container header is
parsed to find it), then encodes:

* **WAV** 16, 24 or 32-bit float, written by hand, no dependency
* **MP3** up to 320 kbps through lamejs, inside a Web Worker so the UI never freezes. The mixer
  hands the encoder 16-bit PCM (lamejs copies what it is given straight into 16-bit buffers, so a
  −1…1 float mix would be written out as a silent file), and the stream is checked for a frame
  header and a plausible length before the download starts

A ZIP containing hundreds of megabytes of WAVs would blow up browser memory if it were built from
plain in-memory buffers — so, where the browser allows it, it isn't: see
[Streaming batch exports (OPFS)](#streaming-batch-exports-opfs). Where it can't (no OPFS support),
the app falls back to the original in-memory path and keeps an eye on the projected size, warning
before you pack.

---

## Optional neural enhancement

**Off by default, and invisible unless both a model is installed and the toggle is turned on.** Next to
the export format row is "AI high-frequency reconstruction" (`#neuralToggle`); it stays disabled, with a
status line explaining why, until `neural-controller.js`'s probe finds at least one model and a working
execution provider. Nothing about the pure-DSP chain changes when it is off — this is additive-only, not
a different mode.

* **Execution.** [`assets/js/neural-worker.js`](assets/js/neural-worker.js) runs `onnxruntime-web` in a
  dedicated Worker. On a phone or tablet (`/Mobi|Android|iPhone/i` against `navigator.userAgent`) with
  WebNN available, it tries WebNN first — the only web API that can reach an on-device NPU, probed
  NPU → GPU → CPU device type — then WebGPU (with fp16 weights once the adapter confirms `shader-f16`),
  then WASM-SIMD; everywhere else WebGPU still goes first. Every provider is its own try/catch, so an
  unsupported op or a refused context falls straight through to the next one, never to a failed call. The
  library itself is fetched from a CDN only once a model is actually used (see [Privacy](#privacy)) — it
  is never bundled (the npm package unpacks to ≈145 MB) and never loaded just because the toggle exists on
  the page.
* **Models.** Two restoration models — [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet)
  (noise suppression) and [BS-RoFormer](https://github.com/ZFTurbo/Music-Source-Separation-Training)
  (stem separation: vocals / drums / bass / other) — and the Stage-7 air coupling below are all wired to
  real, published ONNX export contracts, but **no weights ship with this repository.** Drop a model's
  `.onnx` file (and its auxiliary weights, where the export needs one) into OPFS or a same-origin
  `models/<name>/` folder to activate it; with nothing there, every call cleanly reports
  `{applied: false, reason: 'weights-not-found'}` and the DSP chain runs exactly as it always has. On
  mobile, the smallest quantised variant a model publishes (int4, then int8) is preferred over fp16/fp32,
  to keep resident weights under ≈80 MB of VRAM — the same clean "nothing installed" fallback applies
  either way.
* **Stage 7 coupling, not AudioSR.** A real AudioSR is a 258 M-parameter latent-diffusion model (UNet +
  VAE + HiFi-GAN, 50 sampling steps, over a gigabyte of weights) — nothing a browser tab can run at a
  usable speed. What ships instead keeps this project's existing, phase-correct `AirSynth` harmonic
  regenerator (row 7 of [the signal chain](#the-signal-chain)) as the only thing that ever synthesises a
  waveform above the codec cliff, and asks a (not yet installed) model only for a small per-band dB
  correction curve — six fixed peaking filters apply it, blended in by the `airNeural` amount, clamped to
  ±12 dB so a bad prediction can never do more than a gentle shelf could.
* **When it runs.** Only on the final export render, never on the live preview or the A/B comparison
  window — both re-render on every slider nudge, and inference is not instant.
* **Thermal/memory throttle fallback.** Every inference call is raced against a 20 s watchdog; if it times
  out, or the error matches an out-of-memory/device-lost pattern, the model's cached session is dropped (so
  the next call re-probes instead of reusing a dead GPU/NPU context) and the call resolves
  `{applied: false, reason: 'oom'|'device-lost'|'timeout'}` — the render falls back to the pure DSP path
  exactly as it does for `weights-not-found`, and a single quiet toast lets you know why, without
  repeating itself for every call in a batch export that hits the same limit.

## Privacy

* **No server.** Nothing to send your audio to, and nothing that would.
* **No cookies, no localStorage, no analytics, no fonts or icons from the network.** The whole UI
  is local — system fonts, inline SVG, bundled CSS.
* **No external request by default:** JSZip (ZIP export) and lamejs (MP3 encoder) ship with the
  project in [`assets/vendor/`](assets/vendor).
* **Optional CDN mode:** *About & credits → Libraries* switches those two libraries to a free CDN
  (unpkg / cdnjs / jsDelivr, with fallback to the bundled copy). Only then does your IP reach a
  third party — exactly one request, as with any ordinary web page.
* **Optional FFmpeg.wasm rescue decoder:** if a browser refuses to decode a file itself, the suite
  can pull FFmpeg.wasm (single-threaded core, so it works on plain static hosting) from unpkg and
  convert the file to WAV locally. It is never loaded unless a file needs it.
* **Optional neural enhancement, same rule:** turning the "AI high-frequency reconstruction" toggle
  on (see [below](#optional-neural-enhancement)) is the only thing that fetches `onnxruntime-web`
  from the jsDelivr/unpkg CDN (≈145 MB unpacked — far too large to vendor); the *audio* never leaves
  the machine either way, inference runs entirely in a local Worker against weights that live in
  OPFS or a local folder, never uploaded or referenced from the network.

Full text: *Privacy* in the footer of the app.

---

## Repository layout

```
index.html                       the whole interface (markup, templates, dialogs)
coi-serviceworker.js             cross-origin isolation bootstrap: registers itself as a
                                 Service Worker that adds COOP/COEP response headers on
                                 plain static hosting (see Cross-origin isolation, below)
assets/
  css/app.css                    dark Jamaican-flag theme, responsive, no webfonts
  js/
    dsp-utils.js                 FFT, spectrum, noise/crackle/clipping measurement,
                                 WAV writer + reader, sample-rate sniffing  (RSDSP)
    presets.js                   the six profiles, auto-classification, adaptive tuning (RSPresets)
    i18n.js                      every German and English string, including the legal texts (RSi18n)
    library-loader.js            bundled copies ⇄ free CDNs, optional FFmpeg.wasm (RSLibs)
    opfs-manager.js            Origin Private File System scratch storage: streaming
                                 WAV/MP3 writers and a streamed ZIP packer, both backed by
                                 FileSystemSyncAccessHandle in a Worker (RSOPFS)
    codecs.js                    decode, WAV/MP3 encode (in memory or streamed), ZIP, download (RSCodecs)
    analyzer.js                  file → measurements, diagnosis, waveform envelopes (RSAnalyzer)
    neural-controller.js         main-thread handle onto neural-worker.js — one Promise-returning
                                 call per model, never rejects (RSNeural)
    neural-worker.js             optional, best-effort WebNN/WebGPU/WASM inference: DeepFilterNet3,
                                 BS-RoFormer, and the Stage-7 air super-resolution curve, with
                                 mobile-first EP ordering, quantised-weight selection, and an
                                 OOM/timeout throttle fallback (worker-only, loaded with
                                 `new Worker(...)`, not a <script> tag)
    memory-guard.js               best-effort mobile heap watchdog: reads performance.memory where
                                 Chromium exposes it and shrinks the next render chunk under
                                 pressure, null-safe everywhere else (RSMemoryGuard)
    engine.js                    AudioContext + AudioWorklet, live monitor, whole-file offline
                                 render, and the chunked/streamed offline render for long files
                                 on constrained devices (RSEngine)
    ui.js                        DOM helpers, toasts, dialogs, interactive waveform (RSUI)
    app.js                       state, per-card logic, batch queue (RSApp)
  worklets/
    remaster-processor.js        the complete DSP chain (the heart of the suite)
  vendor/                        jszip.min.js (MIT), lame.min.js (LGPL-3.0) + licence note
  img/
    logo.svg                     the brand mark (vector, scales to any size)
    logo.png                     512×512 raster version
    apple-touch-icon.png         180×180 home-screen icon
    og-image.jpg                 512×512 social preview
    favicon.svg                  the waveform alone — the record ring is unreadable at 16 px
tests/
  harness.js                     Node harness + signal simulators (garage session,
                                 cassette, vinyl rip, low bitrate, clean, and the
                                 combination fixture: a vinyl transfer that went
                                 through a 128 kbit/s encoder)
  dsp.test.js                    DSP/engine suite: transparency, sub, air, exciter, de-hiss,
                                 de-click, measured hum/hiss repair, and the contract that a
                                 broken file never becomes NaN parameters (160 checks)
  tuning.test.js                 the tuning contract: what the automatic mode may do to a file (17 checks)
  web.test.js                    static, DOM and app suite (137 checks)
  audit.test.js                  repository hygiene, markup, contrast, i18n, parameter,
                                 codec and robustness audit — including the mains-notch law,
                                 a rich-hum fixture, the effect budgets, the
                                 several-problems-at-once chain, and the chain-level
                                 scale-freedom row, the export's ceiling through the
                                 codec, and the de-clicker's floor with its control (335
                                 checks)
  e2e.test.js                    realistic journeys: five problem recordings, slider sweep,
                                 profile overrides, 10-file batch → ZIP, mono/32 k/96 k,
                                 hostile input (108 checks)
  opfs.test.js                   runs the actual shipped OPFS worker source in a Node vm
                                 against a simulated Origin Private File System: streaming
                                 writes, a multi-megabyte streamed ZIP cross-checked with
                                 JSZip and unzip(1), and the in-memory fallback (28 checks)
  coi.test.js                    runs the shipped coi-serviceworker.js in a Node vm as both
                                 a Service Worker (COOP/COEP header rewrite) and a page
                                 script (registration, the one-reload rule, no reload loop;
                                 19 checks)
  webaudio-stub.js               miniature Web Audio implementation for Node
  beta/
    beta.js                      the real-browser suite: every control on the page,
                                 the whole journey from file to export, the scale
                                 rows, the progress bars, the phone layouts (94 checks)
    cdp.js                       minimal Chrome DevTools Protocol client over the
                                 platform WebSocket — no dependency beyond Node ≥ 22
    chromium.js                  launcher for the packaged headless Chromium
```

No bundler, no transpiler, no dependencies at runtime. The only `node_modules` in the project
belong to the test suite.

---

## Tests

```bash
npm install          # only for the test suite (jsdom)
npm test             # runs all seven dependency-free suites
node tests/dsp.test.js     # engine: transparency, sub, air, exciter, de-hiss, de-click,
                           # de-resonator, level match, power scaling, WAV/MP3/ZIP, classification
node tests/web.test.js     # static integrity, bilingual coverage, boot, drop → analyse → render
                           # → save → ZIP, error handling, resampling
node tests/audit.test.js   # repository hygiene, markup, stylesheet, contrast, bilingual
                           # coverage, parameter ranges, the several-problems-at-once
                           # chain, DSP edge cases, codec round-trips, budgets
node tests/e2e.test.js     # realistic journeys: five problem recordings, slider sweep, profile
                           # overrides, 10-file batch → ZIP, mono/32 k/96 k, hostile input
node tests/tuning.test.js  # the tuning contract: octave bands, loudness, the level match, the
                           # soft-clip guard, level-normalised synthesis, honest extremes
node tests/opfs.test.js    # the shipped OPFS worker source against a simulated file system:
                           # streaming writes, a streamed ZIP cross-checked with JSZip and
                           # unzip(1), the oversized-batch guard, the in-memory fallback
node tests/coi.test.js     # the shipped coi-serviceworker.js as both a Service Worker
                           # (COOP/COEP header rewrite) and a page script (the one-reload
                           # rule, never a reload loop)
node tests/mobile-ux.test.js  # the carousel effect rack, the gold "AI Magic Fix" button,
                           # and the live A/B/C compare FAB: markup/CSS, navigator.vibrate
                           # safety, engine.js's switchBuffer() position preservation,
                           # the desktop-arms vs phone-auto-processes split, tap/hold
node tests/beta/beta.js    # big beta: drives a real headless Chromium over the DevTools
                           # protocol — real clicks, real drops, real AudioWorklet, real
                           # dialogs and downloads, phone emulation at 390 and 320 px with
                           # live progress sampling — and photographs the screenshot matrix.
                           # The recordings are the same synthesised fixtures the node suites
                           # use, served to the page, and the upload path is timed phase by
                           # phase. The two scale rows calibrate themselves: a 30-second take
                           # goes through the identical instrumented path seconds earlier on
                           # the same machine, and what the row holds the app to is the
                           # machine's own rate, not an absolute budget. 94 checks
```

The beta writes `docs/BETA-REPORT.md` and the screenshot matrix to `docs/beta/`.
It needs the optional dev dependency `@sparticuz/chromium` (a packaged headless
Chromium, used because CI machines rarely ship a browser); `npm test` runs the
five dependency-free suites and stays green everywhere.

Signals are simulated (garage session, cassette, vinyl rip, low-bitrate, clean — plus a vinyl
transfer that was later pushed through a 128 kbit/s encoder, the file that needs more than one
treatment at once) and the whole application is exercised in a DOM with a miniature Web Audio
implementation that runs the real processor in 128-frame quanta — so the tests measure the actual
engine, not a mock.

---

## Browser support

| Browser | Minimum | Notes |
| --- | --- | --- |
| Chrome / Edge | 66+ | `AudioWorklet` (recommended) |
| Firefox | 76+ | `AudioWorklet` |
| Safari | 14.1+ | `AudioWorklet`; MP3 export works, encoding is a little slower |
| Mobile | current iOS/Android | works, but batch processing many long files deserves a desktop |

Decoding uses the browser's own codecs — MP3, WAV, FLAC, OGG/Vorbis and M4A/AAC all work
wherever the browser supports them. Anything the browser refuses is handed to FFmpeg.wasm.

### Cross-origin isolation

`SharedArrayBuffer` — which a future multi-threaded FFmpeg.wasm rescue decoder could use — only
exists on a page that is `crossOriginIsolated`, which in turn needs two response headers
(`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) that
plain static hosting such as GitHub Pages cannot send. [`coi-serviceworker.js`](coi-serviceworker.js)
works around that: loaded as a normal `<script>`, it registers *itself* as a Service Worker (one
file plays both roles, switching on whether `window` exists), which then rewrites every same-origin
response to carry those two headers.

A Service Worker only controls pages that load *after* it is active, so turning on isolation for
an already-open tab needs exactly one reload. The suite only performs that reload after it has
registered the worker and confirmed one is actually needed (an already-isolated page, a page
served without TLS, or a browser with no Service Worker support never reloads at all), and shows a
short, translated toast — *"Hochleistungsmodus wird aktiviert …" / "Turning on the high-performance
mode …"* — in the moment before it does. `tests/coi.test.js` runs the exact shipped file inside a
Node `vm`, standing in for both a `ServiceWorkerGlobalScope` and a page `window`, to check the
header rewrite and every branch of that one-reload logic (including that it never loops).

---

## Branding

The mark is a record whose groove turns into a waveform — gold where the original
was, green where the restoration begins. Vector version (`assets/img/logo.svg`)
for anything that scales, raster (`logo.png`) for stores and social cards,
`favicon.svg` for the browser tab: the waveform alone, because record rings turn
to mush at 16 px.

## Credits, licences and tips

* **Developed by AndrexTheDev** — [hippie.highho@gmail.com](mailto:hippie.highho@gmail.com)
* Application source: **MIT** (see [`LICENSE`](LICENSE)).
* Bundled third-party code keeps its own licence (see [`assets/vendor/NOTICE.md`](assets/vendor/NOTICE.md)):
  **JSZip** (MIT), **lamejs** / LAME (LGPL-3.0), optional **FFmpeg.wasm** (LGPL/GPL).

If the suite saves you work, a voluntary crypto tip is welcome — every address in the footer has a
one-click copy button:

| | |
| --- | --- |
| **SOL** | `79KsqtJJdhKFJ9woxnYgtf3nq7HxQveafWBCtC3mxWi8` |
| **BTC** | `bc1qeqzrlfg3edrydk4s0hecakc82gp26n5p7hkc7f` |
| **ETH** | `0xBC3fab34f69bc9f6661608C3FB36dDdC313C42F7` |

Tips are voluntary and not a purchase — the suite stays free, with no commitment.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| *"The DSP processor was blocked"* | The page was opened as a local file (`file://`). Serve it over http(s). |
| Nothing plays | Browsers need one click before audio may start — press play. |
| MP3 export feels slow | Encoding MP3 in JavaScript takes a moment; WAV is instant and lossless. |
| A file will not open | The browser cannot decode that container. Try WAV/FLAC/OGG, or enable the FFmpeg rescue path. |
| The result sounds too strong | Lower the restoration power — the chain is deliberately a little bold at 100 %. |
| Very large batches | Use MP3 for the ZIP; several hundred megabytes of WAV will exhaust browser memory. |
