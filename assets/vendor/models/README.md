# ONNX models

Drop `.onnx` model files here and they are picked up lazily by
`RSLibs.onnxModel(name)` in `assets/js/library-loader.js` — nothing is fetched
until the hybrid ML path actually asks for a model.

Lookup order (mode `local`, the default):

1. `assets/vendor/models/<name>.onnx` — this directory
2. the CDN fallback URLs registered with `RSLibs.registerModel(name, { remote })`

In `cdn` mode the order is reversed. A model that fails to load everywhere is
reported to the caller and the suite falls back to the pure-DSP chain — it never
breaks the audio path.

## Which stage runs, and the fallback

`manifest.json` in this folder lists each neural stage (`denoise`, `superRes`) with
its candidate models in order of preference. `RSLibs.probeModels()` (in
`assets/js/library-loader.js`) reads it and checks only the files next to the page
with a HEAD request. It never contacts another host unless the page is in `cdn`
mode and a model was registered with a remote source.

- A stage whose files are all present uses its first complete candidate.
- A super-resolution candidate marked `full` is skipped on a compact-tier device
  (mobile, or less than 420 MB of free heap).
- Otherwise the stage falls back to the pure-DSP chain (`"fallback": "dsp"`).

This is how the suite runs with no weights at all, in a sandbox or on a network
that blocks Hugging Face: every stage reports `dsp`, nothing is downloaded, and
the audio path is the one without the neural side.

No placeholder or dummy weight files are shipped. A fake graph would look like a
denoiser and would not be one.

## Expected files

| File | Graph | Used by |
|------|-------|---------|
| `dfn3-enc.onnx` | DeepFilterNet3 encoder | `neural-worker.js` (`dfn3`) |
| `dfn3-erb-dec.onnx` | DeepFilterNet3 ERB mask decoder | `neural-worker.js` (`dfn3`) |
| `dfn3-df-dec.onnx` | DeepFilterNet3 deep-filter decoder | `neural-worker.js` (`dfn3`) |

The three graphs are the ONNX export of DeepFilterNet3 from the DeepFilterNet
project (`models/DeepFilterNet3_onnx/`, Apache-2.0 or MIT, see `assets/vendor/NOTICE.md`).
Their I/O is verified in the test suite (`tests/e2e.test.js`, section *DeepFilterNet3*):
`feat_erb [1,1,S,32]`, `feat_spec [1,2,S,96]`, and the 10-tap deep-filter coefficients.

The 48 kHz super-resolution stage (NovaSR, LavaSR) is **not** present: no weight
files are shipped or referenced. The worker's memory guard reserves the compact
tier for it (see `chooseModelTier` in `assets/js/neural-dsp.js`).

Models are large binaries: do not commit them to git unless the project ships
them deliberately; register a CDN source instead. The `*.onnx` files and the
`dfn3-config.ini` in this folder are git-ignored.

Without these files the ML tests skip with a message, and the app runs its
pure-DSP chain unchanged.
