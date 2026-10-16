# Third-party components

The Remaster Suite bundles the two libraries it cannot write itself, so that the
default mode makes **no external network request at all**. `assets/js/library-loader.js`
can also fetch them from free CDNs (unpkg / cdnjs / jsDelivr) on request.

## JSZip — `jszip.min.js`

* Version: 3.10.1
* Licence: MIT — https://github.com/Stuk/jszip/blob/main/LICENSE.markdown
* Used for: building the batch ZIP archive in the browser.
* Source of the bundled copy: `https://unpkg.com/jszip@3.10.1/dist/jszip.min.js`
* Unmodified.

## lamejs — `lame.min.js`

* Version: 1.2.1 — a JavaScript port of **LAME** (https://lame.sourceforge.net/)
* Licence: LGPL-3.0 (see `lamejs.LICENSE` in this folder)
* Used for: MP3 encoding of the rendered audio (MPEG-1/2 Layer III, up to 320 kbps).
* Source of the bundled copy: `https://unpkg.com/lamejs@1.2.1/lame.min.js`
* Unmodified. The library is used as-is; any modification of LAME/lamejs sources must be
  released back under the LGPL. Full source of the port: https://github.com/zhuker/lamejs

## FFmpeg.wasm — optional, never bundled

* `@ffmpeg/ffmpeg` 0.11.6 + `@ffmpeg/core` 0.11.0 (single-threaded core, no cross-origin
  isolation required), licence LGPL-2.1+/GPL depending on build flags.
* Used **only** as an emergency decoder when the browser itself cannot read a file, loaded
  lazily from `https://unpkg.com/` — never shipped with this repository.
* Project: https://github.com/ffmpegwasm/ffmpeg.wasm

## onnxruntime-web — optional, never bundled

* Version: 1.20.1 (the `ort.all` build, which carries the WebGPU execution provider).
* Licence: MIT — https://github.com/microsoft/onnxruntime/blob/main/LICENSE
* Used for: hybrid ML inference in the offscreen worker (`assets/js/neural-worker.js`) —
  WebGPU first, automatic fallback to the multi-threaded SIMD WASM build. Loaded lazily
  by `RSLibs.onnxRuntime()` from `assets/vendor/onnxweb/` when a copy is vendored there,
  otherwise from the free CDNs (unpkg / jsDelivr / cdnjs) — never fetched until the ML
  path is asked for. ONNX models live in `assets/vendor/models/` and follow the same
  local-first, CDN-fallback rule.
* Project: https://github.com/microsoft/onnxruntime

## DeepFilterNet3 ONNX graphs — `assets/vendor/models/dfn3-*.onnx`, optional, never bundled

* Model: DeepFilterNet3 (encoder, ERB decoder, deep-filter decoder), ONNX export.
* Licence of the project: dual **Apache-2.0 or MIT**, at the user's option —
  https://github.com/Rikorose/DeepFilterNet/blob/main/LICENSE
* Used for: non-stationary noise reduction in the hybrid ML side chain (48 kHz).
* Not shipped with the repository. The files are placed in `assets/vendor/models/`
  by the user; the application and tests skip the DeepFilterNet3 path when they are absent.

## NovaSR and LavaSR — 48 kHz super-resolution, not included

* Planned for the super-resolution stage. No weight files are bundled or referenced
  by this repository; the stage is not active.

## Fonts, icons, styles

None. The interface uses system fonts and inline SVG only — no webfont, no icon font, no
CSS framework, no analytics, no cookie.
