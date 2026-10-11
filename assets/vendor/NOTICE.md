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

## Fonts, icons, styles

None. The interface uses system fonts and inline SVG only — no webfont, no icon font, no
CSS framework, no analytics, no cookie.
