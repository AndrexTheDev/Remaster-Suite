# Third-party components

The Remaster Suite bundles its export libraries, so that the
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
* Legacy copy retained for compatibility tests and the library-loader API; production MP3 export now uses the WASM build below.
* Source of the bundled copy: `https://unpkg.com/lamejs@1.2.1/lame.min.js`
* Unmodified. The library is used as-is; any modification of LAME/lamejs sources must be
  released back under the LGPL. Full source of the port: https://github.com/zhuker/lamejs

## ONNX Runtime Web — `onnxruntime-web/`

* Version: 1.20.1, unmodified files from npm `onnxruntime-web@1.20.1`.
* Licence: MIT (see `onnxruntime-web/LICENSE`).
* Bundled lazy runtime: `ort.webgpu.min.js` plus the SIMD/threaded JSEP `.mjs` and `.wasm` sidecars.
* Used for: local DeepFilterNet3 WebGPU inference with WASM-SIMD fallback.
* SHA-256 values are pinned by `tests/neural.test.js`; CDN URLs remain rescue mirrors only.
* Source: https://github.com/microsoft/onnxruntime/tree/v1.20.1/js/web

## FFmpeg.wasm — optional, never bundled

* `@ffmpeg/ffmpeg` 0.11.6 + `@ffmpeg/core` 0.11.0 (single-threaded core, no cross-origin
  isolation required), licence LGPL-2.1+/GPL depending on build flags.
* Used **only** as an emergency decoder when the browser itself cannot read a file, loaded
  lazily from `https://unpkg.com/` — never shipped with this repository.
* Project: https://github.com/ffmpegwasm/ffmpeg.wasm

## Fonts, icons, styles

None. The interface uses system fonts and inline SVG only — no webfont, no icon font, no
CSS framework, no analytics, no cookie.

## LAME WebAssembly — `mp3.wasm`, `WasmMediaEncoder.min.js`

* Unmodified files from npm `wasm-media-encoders@0.7.0`.
* npm tarball SHA-1: `107502a817ba1c42c64d94d4220b0c53792427ed`.
* Wrapper: MIT (`wasm-media-encoders.LICENSE`). LAME: LGPL-2.0-or-later
  (`lame-wasm.COPYING`); this is not covered solely by the wrapper's MIT licence.
* Source and reproducible build scripts:
  https://github.com/arseneyr/wasm-media-encoders/tree/4a45333baadbab312d1cc0911151dfad23157c51
  (initialize submodules, including `src/wasm/lame/lame-src`, then `make prod`
  with Emscripten and Yarn as specified upstream).
* LAME source: https://github.com/arseneyr/lame . The upstream tagged tree's
  submodule records the exact LAME revision. No LAME changes made here.
* The separately shipped WASM and JS are loaded locally only inside the encoding
  worker. They can be replaced/rebuilt with compatible modified versions.
