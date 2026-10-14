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
  render.
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
mono-maker**. They are computed from that file's own spectrum, and on a recording that measures
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
cassette (its hiss is the bigger defect) with clicks on top. The single-profile answer took 0.6 dB
off the spike crest; the chain takes **3.6 dB** off it, because the file earned a de-click budget of
0.60 instead of the cassette profile's 0.20 — and on a real 128 kbit/s re-encode of a vinyl rip the
codec joins the chain at 0.46, which lifts the 7 kHz band correction from 0.0 to 1.5 dB.

### Batch

Drop as many files as you like. They are processed **one after another** (memory stays flat,
the browser stays responsive), every file gets its own card, and *Download ZIP* bundles all
finished results — with a `README.txt` describing what was done.

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
| 1a | **De-clip** | a *plateau* in the waveform — one to hundreds of samples sitting flat at the file's own peak level, which is what a limited master did to its peaks — is reconstructed: the run's implied overshoot is estimated from the local period of the zero crossings, and a cosine arc is written back into it. The detector keys on the measured plateau level of *this* file, not on a constant, which is what separates clipping from a merely loud waveform: a loud but unclipped recording measures 0.0007 % flat samples and 0.07 dB of implied overshoot, a clipped one 0.39 % and 1.7 dB. It runs first among the repairs, before anything else looks at the waveform — and the output guard's knee moves up with whatever the stage reconstructed (a per-file maximum), because that guard sits *below* the plateau of a clipped master and would otherwise flatten the restored arc straight back into the flat top it came from: on a 997 Hz tone clipped at 0.99, −16.2 dB of error left in the plateau with a fixed knee against −29.1 dB with the knee lifted |
| 1b | **Sub-sonic guard** | a 12 dB/octave high-pass at 18–30 Hz, switched on *only* when the quiet passages measured rumble below the music and no mains line that could explain it. A turntable's rumble lives there; no instrument does, which is why the corner stays under 30 Hz |
| 2 | **Static EQ bank** | 6 biquads: 60 Hz shelf, 200 Hz mud, 450 Hz box, 1.3 kHz honk, 3.2 kHz presence, 7 kHz air — the profile's anchors, dosed from the measurement |
| 2b | **Per-song corrective EQ** | 12 bands, 50 Hz … 8 kHz at Q 1.4, correcting the file's own departures from its own spectral trend — net of what the six profile bands do. ±1.5 dB dead zone, ±6 dB cap, no boost near the noise floor, no correction in a band the file does not fill |
| 2c | **Measured resonance notches** | the two strongest narrow peaks the analyser finds (150 Hz – 1.8 kHz, ≥ 3.2 dB above the local trend), each notched at its own frequency, depth and sharpness. A boxy room is a *constant* colouration, which the dynamic de-resonator below cannot see |
| 3 | **Dynamic de-resonator** | 6 narrow bands (220 Hz … 3.1 kHz) watch their own envelope against a long-term average; anything ringing way above it gets pulled down. Steady tones pass, room ring does not. |
| 4 | **De-click** | low-pass prediction (4 kHz, 4th order) plus a fast/slow envelope ratio, and 0.35 ms of look-ahead: a detected impulse plans a repair window that reaches half a millisecond *in front of* the spike (a codec puts most of a pop's energy there) and 1 ms behind it, and the window is replaced by the prediction with tapered ends. It runs *before* the de-hisser, because a pop is broadband: anything in front of it that works on the top end eats part of it and leaves a remainder the detector cannot be sure about — measured on a worn record (music + hiss + crackle) the de-hisser in front pulled each pop's sample down to 18 % of its height and still left 6 pops above a clean copy, behind it 0. Every decision it makes is relative to the file (the fast/slow *ratio* of the high band, then a level gate against the file's own one-second HF activity), so a quiet transfer is repaired exactly like a hot one: with an absolute level gate the same fixture kept 63 pops at −24 dBFS against 6 at 0 dBFS, while the ratio statistic is literally unchanged (p50 1.08, p99 2.3, max 6.7 at both levels). The look-ahead is the stage's only latency — see below Its amount is a repair *depth*, so the intensity curve is its transient margin and not a taste: measured, applying the de-clicker as measured (20 % more at the default) buys one pop of a 72-pop fixture and costs the kit 6 dB of snare — the audit suite pins that comparison. |
| 5 | **De-hiss** | Linkwitz-Riley split, keyed on the *tilt* of the top end (4 kHz+ against the 1.45 kHz band — the same two bands, cascaded the same way, in the same 2048-sample window the analyser measures), so it attenuates where the top end stops following the programme and leaves everything else alone: on a cassette-class file the same repair is worth 3.2 dB between the notes and 0.2 dB over music. Getting the mid band's cascade right was worth 4.4 dB of ask on the frames a hiss owns: with one filter instead of two, the key's reference reads the noise's own body and the quiet frames' tilt comes out 4.38 dB low. The split itself is measured too (2.2–4 kHz, where this file's noise starts). The gate closes over 60 ms and opens in 8 ms — the closing lag is worth 1.9 dB of the repair on the hiss fixtures for ≤0.2 dB of the music's own top end, and the pops are untouched at every close time because the de-clicker runs in front of it — and its last 0.1 % of range is a continuous crossfade rather than a branch. Its level reference is a band RMS measured exactly like the key (same band, same 2048-sample window), so it needs no absolute ceiling — and with one at 0.01 it went quiet on anything louder than −49 dBFS: measured on one recording rendered at 0 and at −20 dBFS, the finished files were 12.6 dB apart with the ceiling and 33.5 dB apart without it. The automatic dose only asks for the repair when the measurement found a tilt step, because on a *stationary* top end — a dull pad, a synthesizer bed — the quiet-frame floor and the programme are the same number and the gate cannot tell hiss from music (a clean dull bed measured 0.04 dB of tilt step and lost 4.3 dB of its 9–13 kHz band to the profile's half dose) |
| 5b | **De-esser** | a dynamic dip over 5.2–9.5 kHz, keyed on the fast/slow ratio of that band: a quiet "s" and a loud one are the same problem, and a recording without sibilance measures zero. It sits before the synthesisers, so the exciter and the air cannot rebuild what it just removed |
| 6 | **Harmonic exciter** | 3 bands, each: band-pass → asymmetric saturation (even *and* odd harmonics) → band-pass → envelope gate. Synthesise the overtones that were never recorded. |
| 7 | **Air synthesis 8–16 kHz** | takes the surviving 4.5–7.5 kHz band and generates 2nd/3rd order content above it, gated by the presence follower and limited to a fraction of the band it came from |
| 8 | **Sub-bass 30–60 Hz** | 6th-order low pass → hysteresis zero-crossing detector → divide-by-two pitch tracking → oscillator with a gated envelope. A 60–120 Hz bass line gains its missing bottom octave. |
| 9 | **Glue compressor** | soft 2:1 with automatic make-up; attack and release follow the file's measured percussive character |
| 10 | **Warmth + tilt** | gentle saturation and a low/high shelf pair for the final tone balance |
| 11 | **Stereo (M/S)** | a bass that measured out of phase in one channel is folded to mono below 200 Hz; the side signal of an image that measured narrow but not mono is lifted back towards the programme's own bandwidth, and a mono master is never widened |
| 12 | **Mains hum notch** | three biquads, three hertz wide, at the measured mains frequency and its harmonics — dosed from the level the line stands above its own neighbourhood, and placed *after* every stage that can put low-frequency energy back. Bypassed completely when nothing was measured |
| 13 | **Output** | 2 Hz DC guard (keeps the offset the saturation stages can add out of the export), auto level match, then a tanh soft-clip guard that saturates at −0.02 dBFS so a 16-bit export can never hit the rail. Its knee — and the hard rail behind it — moves up by whatever the de-clipper reconstructed, so the guard that protects the export cannot undo the repair; on a file that was not de-clipped both are exactly what they always were |
| 14 | **True-peak limiter** | the export ceiling. Samples under full scale do not mean the *waveform* is under it, and a codec that has to encode an overdriven waveform distorts it — so the last stage holds the file to the true-peak target every streaming service asks for: −1 dBTP, or −2 dBTP when the master is louder than −14 LUFS. The peak is estimated between the samples with the same 32-tap windowed sinc the *measurement* (`ispDb`) uses — one shared definition of what the waveform does between the samples, so the stage that enforces the ceiling and the meter that reports it cannot disagree. It was a seven-tap sinc once, and on a bright percussive master that read 0.5 dB low: the export measured −1.60 dBTP by two independent meters while the app claimed −2.10, i.e. over the ceiling it had just been given. With 32 taps agreeing with ffmpeg's `ebur128` to 0.00–0.03 dB on tonal, squashed and percussive material, the ceiling holds where it says it does (−2.10 dBTP measured on all three). The gain is computed 1.5 ms ahead of the sample it applies to and minimised over that window, and the detector is shared between the channels so the image cannot move. A file already under the ceiling is bit-transparent (`gain = 1.000000`, no level change); a file over it comes down by the overshoot it had |

The dry/wet cross-fade happens at the very end: `out = dry + power · (wet − dry)`. The chain is
minimum-phase IIR throughout, so it adds no delay of its own — with three exceptions, all of them
repairs that cannot be done without seeing a little of the future:

* the **de-clicker** needs half a millisecond of look-ahead to repair the part of a codec-smeared
  pop that sits *before* the spike the detector fired on (17 samples at 48 kHz, 0.35 ms);
* the **de-clipper** waits for the end of a flat run before it can reconstruct it (271 samples at
  48 kHz, 5.6 ms — the longest run it will repair);
* the **true-peak limiter** computes the gain 1.5 ms ahead of the sample it applies to, plus the
  sixteen samples the interpolator reaches past that interval (88 samples at 48 kHz), because a
  ceiling that is only enforced after the peak has passed is a clipper.

The sums are reported per render (`latency`, 0 when the stages are off), and the cross-fade delays
its dry side by the same amount, so the A/B switch and the strength slider stay phase-coherent and
sample-aligned: you hear the change and not the delay. With the repair stages off — or at strength
0 — the latency is exactly 0. The offline render (the file you save) is bit-identical to what you
heard live either way.

### Offline render

Saving runs the same processor in an `OfflineAudioContext` — with `suspend()`/`resume()` progress
reporting instead of blocking the tab — at the **source sample rate** (the container header is
parsed to find it), then encodes:

* **WAV** 16, 24 or 32-bit float, written by hand, no dependency
* **MP3** up to 320 kbps through lamejs, inside a Web Worker so the UI never freezes. The mixer
  hands the encoder 16-bit PCM (lamejs copies what it is given straight into 16-bit buffers, so a
  −1…1 float mix would be written out as a silent file), and the stream is checked for a frame
  header and a plausible length before the download starts

A ZIP containing hundreds of megabytes of WAVs would blow up browser memory, so the app keeps an
eye on the projected size and warns before you pack.

---

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

Full text: *Privacy* in the footer of the app.

---

## Repository layout

```
index.html                       the whole interface (markup, templates, dialogs)
assets/
  css/app.css                    dark Jamaican-flag theme, responsive, no webfonts
  js/
    dsp-utils.js                 FFT, spectrum, noise/crackle/clipping measurement,
                                 WAV writer + reader, sample-rate sniffing  (RSDSP)
    presets.js                   the six profiles, auto-classification, adaptive tuning (RSPresets)
    i18n.js                      every German and English string, including the legal texts (RSi18n)
    library-loader.js            bundled copies ⇄ free CDNs, optional FFmpeg.wasm (RSLibs)
    codecs.js                    decode, WAV/MP3 encode, ZIP, download (RSCodecs)
    analyzer.js                  file → measurements, diagnosis, waveform envelopes (RSAnalyzer)
    engine.js                    AudioContext + AudioWorklet, live monitor and offline render (RSEngine)
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
                                 broken file never becomes NaN parameters (73 checks)
  tuning.test.js                 the tuning contract: what the automatic mode may do to a file (17 checks)
  web.test.js                    static, DOM and app suite (137 checks)
  audit.test.js                  repository hygiene, markup, contrast, i18n, parameter,
                                 codec and robustness audit — including the mains-notch law,
                                 a rich-hum fixture, the effect budgets, and the
                                 several-problems-at-once chain (257 checks)
  e2e.test.js                    realistic journeys: five problem recordings, slider sweep,
                                 profile overrides, 10-file batch → ZIP, mono/32 k/96 k,
                                 hostile input (108 checks)
  webaudio-stub.js               miniature Web Audio implementation for Node
```

No bundler, no transpiler, no dependencies at runtime. The only `node_modules` in the project
belong to the test suite.

---

## Tests

```bash
npm install          # only for the test suite (jsdom)
npm test             # runs all five suites
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
node tests/beta/beta.js    # big beta: drives a real headless Chromium over the DevTools
                           # protocol — real drops, real AudioWorklet, real dialogs and
                           # downloads, phone emulation at 390 and 320 px with live progress
                           # sampling — and photographs the screenshot matrix. The recordings
                           # are the same synthesised fixtures the node suites use, served to
                           # the page, and the upload path is timed phase by phase
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
