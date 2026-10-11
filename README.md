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

### The one slider

**Restoration power** (0–100 %) scales every single parameter together. 0 % is bit-transparent
(you hear the untouched original), 100 % is the full intervention of the chosen profile.
60–80 % is where music usually sounds best — which is why the slider *adopts the strength the
detected profile recommends* the moment the first file is analysed. Touch the slider once and
your value wins from then on.

### Six sound profiles

| Profile | For |
| --- | --- |
| **Automatic** | picks the right profile from the measurements |
| **Garage / one-mic (60s/70s)** | thin bottom, boxy mids, rolled-off top, room noise |
| **Vinyl rip** | crackle, surface roar, rumble, hum |
| **Cassette de-hiss** | steady tape hiss, soft high-frequency loss |
| **Low bitrate brightener** | hard codec edge around 11–16 kHz (the biggest job for the exciter) |
| **General polish** | nothing dramatic, just better |

### Batch

Drop as many files as you like. They are processed **one after another** (memory stays flat,
the browser stays responsive), every file gets its own card, and *Download ZIP* bundles all
finished results — with a `README.txt` describing what was done.

### Honest A/B

The **Original / Restored / A/B** switch cross-fades between dry and wet *inside* the processor
with an 18 ms ramp, so switching never clicks. The restored path is level-matched to the original
(running RMS, ±5 dB), so "restored" never wins just by being louder. A/B mode flips every four
seconds by itself.

---

## The signal chain

Everything lives in [`assets/worklets/remaster-processor.js`](assets/worklets/remaster-processor.js)
and runs per sample, control-rate decimated for speed:

| # | Stage | What it does |
| --- | --- | --- |
| 1 | **DC guard** | 14 Hz one-pole, keeps DC out of the envelopes |
| 2 | **Static EQ bank** | 6 biquads: 60 Hz shelf, 200 Hz mud, 450 Hz box, 1.3 kHz honk, 3.2 kHz presence, 7 kHz air — dosed automatically from the measurement |
| 3 | **Dynamic de-resonator** | 6 narrow bands (220 Hz … 3.1 kHz) watch their own envelope against a long-term average; anything ringing way above it gets pulled down. Steady tones pass, room ring does not. |
| 4 | **Harmonic exciter** | 3 bands, each: band-pass → asymmetric saturation (even *and* odd harmonics) → band-pass → envelope gate. Synthesise the overtones that were never recorded. |
| 5 | **Air synthesis 8–16 kHz** | takes the surviving 4.5–7.5 kHz band and generates 2nd/3rd order content above it, with a de-esser so it never turns into fizz |
| 6 | **Sub-bass 30–60 Hz** | 6th-order low pass → hysteresis zero-crossing detector → divide-by-two pitch tracking → oscillator with a gated envelope. A 60–120 Hz bass line gains its missing bottom octave. |
| 7 | **De-hiss** | Linkwitz-Riley split at 3.2 kHz; the top band is a downward expander keyed from the music, so hiss only opens between notes |
| 8 | **De-click** | low-pass prediction (4 kHz, 4th order) plus a fast/slow envelope ratio; impulses are replaced by the prediction, with a short decaying hold for the neighbours of the click |
| 9 | **Glue compressor** | soft 2:1 with automatic make-up, transient-preserving |
| 10 | **Warmth + tilt** | gentle saturation and a low/high shelf pair for the final tone balance |
| 11 | **Output** | 25 Hz infrasonic high-pass, auto level match, then a tanh soft-clip guard that saturates at −0.02 dBFS so a 16-bit export can never hit the rail |

The dry/wet cross-fade happens at the very end: `out = dry + power · (wet − dry)`. Because the whole
chain is minimum-phase IIR, it has **zero latency** — the A/B switch is sample-accurate, and the
offline render (the file you save) is bit-identical to what you heard live.

### Offline render

Saving runs the same processor in an `OfflineAudioContext` — with `suspend()`/`resume()` progress
reporting instead of blocking the tab — at the **source sample rate** (the container header is
parsed to find it), then encodes:

* **WAV** 16 or 24-bit, written by hand, no dependency
* **MP3** up to 320 kbps through lamejs, inside a Web Worker so the UI never freezes

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
  img/favicon.svg
tests/
  harness.js                     Node harness + signal simulators
  dsp.test.js                    DSP/engine suite (56 checks)
  web.test.js                    static, DOM and end-to-end suite (85 checks)
  webaudio-stub.js               miniature Web Audio implementation for Node
```

No bundler, no transpiler, no dependencies at runtime. The only `node_modules` in the project
belong to the test suite.

---

## Tests

```bash
npm install          # only for the test suite (jsdom)
npm test             # runs both suites
node tests/dsp.test.js   # engine: transparency, sub, air, exciter, de-hiss, de-click,
                         # de-resonator, level match, power scaling, WAV/MP3/ZIP, classification
node tests/web.test.js   # static integrity, bilingual coverage, boot, drop → analyse → render →
                         # save → ZIP, error handling, resampling  (85 checks)
```

Signals are simulated (garage session, cassette, vinyl rip, low-bitrate, clean) and the whole
application is exercised in a DOM with a miniature Web Audio implementation that runs the real
processor in 128-frame quanta — so the tests measure the actual engine, not a mock.

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
