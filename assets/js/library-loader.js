/* =============================================================================
 * Remaster Suite — third-party library loader
 * -----------------------------------------------------------------------------
 * The suite ships with its own copies of the only two libraries it needs
 * (JSZip for the batch ZIP, lamejs for the MP3 encoder) so that the default
 * mode makes *zero* external requests — the privacy claim on the tin is real.
 *
 * Because the project brief also asks for these libraries to be loadable from
 * free CDNs (unpkg / cdnjs / jsDelivr), `setMode('cdn')` switches to fetching
 * them from those hosts, and every fetch falls back to the bundled copy when a
 * CDN is blocked, offline or slow. FFmpeg.wasm is available as an *optional*
 * emergency decoder only, loaded lazily from a CDN the first time a browser
 * refuses to decode a file on its own.
 * ========================================================================== */
/**
 * @fileoverview Third-party library loader — exposed as the global `RSLibs`.
 *
 * Owns the single decision of *where* each dependency comes from: the bundled
 * copy under `assets/vendor/` (the default, zero network) or one of three free
 * CDNs. Every fetch is a classic `<script>` injection with a timeout, a
 * per-URL promise cache and a fallback chain, so a blocked or offline CDN
 * degrades to the bundled file instead of throwing at the call site. The CDN
 * URLs for *libraries* live in this file and nowhere else; the audit suite
 * pins that. The quantised neural weights are the one deliberate exception —
 * they are not a library but a model, and their channel belongs to the model
 * manager (`neural-controller.js`, overridable with `setModelSource()` or a
 * `rs-model-cdn` meta tag).
 *
 * `ffmpegFactory()` and `ortUrls()` are the two exceptions to "always bundled":
 * both are CDN-only, lazily loaded emergency paths, never fetched unless the
 * feature they belong to is actually invoked.
 *
 * @module RSLibs
 */
(function (global) {
  'use strict';

  const doc = global.document;

  /**
   * Free CDN mirrors per dependency, in try order (unpkg first, then cdnjs
   * where the package exists there, jsDelivr last).
   * @typedef {Object} CdnLists
   * @property {string[]} jszip - three URLs for jszip 3.10.1 (MIT).
   * @property {string[]} lame - three URLs for lamejs 1.2.1 (LGPL-3.0).
   * @property {string[]} ffmpeg - two URLs for the `@ffmpeg/ffmpeg` 0.11.6 UMD
   *   bundle — the wrapper only; the core is loaded from `FFMPEG_CORE`.
   * @property {string[]} ort - two URLs for the `onnxruntime-web` 1.20.1
   *   `.webgpu` build, the one UMD bundle carrying both the WebGPU and the
   *   WASM/SIMD execution providers. CDN-only by design: the unpacked package
   *   is ~140 MB, two orders of magnitude above every other dependency here.
   */

  /**
   * The bundled copies: paths relative to the site root, always present in
   * this repository (the audit suite fails if one is missing).
   * @typedef {Object} LocalCopies
   * @property {string} jszip - `assets/vendor/jszip.min.js`
   * @property {string} lame - `assets/vendor/lame.min.js`
   */

  /** Free CDNs, in the order they are tried. */
  /** @type {CdnLists} */
  const CDN = {
    jszip: [
      'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
      'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    ],
    lame: [
      'https://unpkg.com/lamejs@1.2.1/lame.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js',
      'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
    ],
    ffmpeg: [
      'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js',
      'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js',
    ],
    // onnxruntime-web (the neural inference runtime, see neural-worker.js):
    // the `.webgpu` build is the one UMD bundle that carries *both* the
    // WebGPU and the WASM/SIMD execution providers, so one load covers the
    // "prefer WebGPU, fall back to WASM" requirement without a second
    // network round trip when the fallback fires. There is no bundled local
    // copy — the unpacked package is ~140 MB, two orders of magnitude over
    // every other dependency this project ships, so it is CDN-only and
    // loaded lazily, exactly like ffmpeg: never fetched unless a neural
    // feature is actually invoked, so the zero-network default is unchanged.
    ort: [
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js',
      'https://unpkg.com/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js',
    ],
  };

  /** Bundled copies — always present in this project. */
  /** @type {LocalCopies} */
  const LOCAL = {
    jszip: 'assets/vendor/jszip.min.js',
    lame: 'assets/vendor/lame.min.js',
  };

  /**
   * Where the single-threaded FFmpeg.wasm core (its JS glue and its `.wasm`
   * payload) is fetched from when the rescue decoder is actually used.
   * Single-threaded on purpose: it needs no `SharedArrayBuffer`, hence no
   * cross-origin isolation, so it works on plain static hosting.
   * @type {{corePath: string, wasmPath: string}}
   */
  const FFMPEG_CORE = {
    corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
    wasmPath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.wasm',
  };

  /**
   * Current source preference.
   * @type {'local'|'cdn'}
   */
  let mode = 'local';
  /**
   * Promise cache keyed by URL, so two callers asking for the same library
   * inject exactly one `<script>`. A rejected promise deletes its own entry
   * (see the `catch` in {@link RSLibs.loadScript}) so a failure is not cached.
   * @type {Object<string, Promise<boolean>>}
   */
  const loaded = Object.create(null);
  /**
   * Human-readable trace of every resolution decision (`'jszip ← …'`,
   * `'mode: cdn'`, `'ffmpeg unavailable: …'`), surfaced in the About/diagnostics
   * UI. Append-only; never read by control flow.
   * @type {string[]}
   */
  const notes = [];

  /* --------------------------------------------------------------- utilities */

  /**
   * Inject one classic `<script>` and settle when it has defined its global.
   * The promise is cached per URL for the lifetime of the page (success only),
   * and the element is removed again on both failure and timeout — a `<script>`
   * tag left behind would be re-evaluated after a late answer.
   * @param {string} url - absolute URL to load (CDN or a path this loader
   *   resolved itself).
   * @param {number} [timeoutMs=9000] - how long to wait before rejecting.
   * @returns {Promise<boolean>} resolves `true` once the script is loaded; the
   *   value is not the library, so callers check their own global afterwards.
   * @throws {Error} `'no document'` in a worker-like host, `'timeout: <url>'`
   *   after `timeoutMs`, `'failed: <url>'` when the load errors (blocked,
   *   offline, 404).
   */
  function loadScript(url, timeoutMs) {
    if (loaded[url]) return loaded[url];
    const p = new Promise((resolve, reject) => {
      if (!doc) { reject(new Error('no document')); return; }
      const el = doc.createElement('script');
      let done = false;
      const timer = global.setTimeout(() => {
        if (done) return;
        done = true;
        el.remove();
        reject(new Error('timeout: ' + url));
      }, timeoutMs || 9000);
      el.src = url;
      el.async = true;
      el.onload = () => {
        if (done) return;
        done = true;
        global.clearTimeout(timer);
        resolve(true);
      };
      el.onerror = () => {
        if (done) return;
        done = true;
        global.clearTimeout(timer);
        el.remove();
        reject(new Error('failed: ' + url));
      };
      (doc.head || doc.documentElement).appendChild(el);
    });
    loaded[url] = p;
    // a failed load must not poison the cache forever
    p.catch(() => { delete loaded[url]; });
    return p;
  }

  /**
   * Walk a candidate list in order, appending the bundled copy as the last
   * resort, and stop at the first URL whose global actually appeared.
   * @param {string[]} urls - CDN candidates (empty array for "bundled only").
   * @param {function(): boolean} [check] - predicate that inspects the global
   *   the script was supposed to define; a load that succeeds without the
   *   global still counts as failed and the next URL is tried.
   * @param {string} [localUrl] - bundled fallback, appended last.
   * @returns {Promise<string>} the URL that worked.
   * @throws {Error} the last error seen, or `'no source available'` when the
   *   list was empty and no fallback was given.
   */
  async function fetchFirst(urls, check, localUrl) {
    const list = urls.slice();
    if (localUrl) list.push(localUrl);
    let lastErr = null;
    for (const url of list) {
      try {
        await loadScript(url);
        if (!check || check()) return url;
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('no source available');
  }

  /* ------------------------------------------------------------- public API */

  /**
   * The public surface, assigned to `global.RSLibs` below.
   * @typedef {Object} RSLibsApi
   * @property {CdnLists} CDN - the mirror lists themselves (read-only by
   *   convention; `ortUrls()` hands out a copy).
   * @property {LocalCopies} LOCAL - the bundled paths.
   * @property {'local'|'cdn'} mode - current preference (getter).
   * @property {function('local'|'cdn'): ('local'|'cdn')} setMode - switch the
   *   preference, log it in `notes`, return the mode actually set.
   * @property {function(): ('local'|'cdn')} toggle - flip `local` ⇄ `cdn`.
   * @property {function(): Promise<object>} jszip - resolve `window.JSZip`.
   * @property {function(): Promise<object>} lame - resolve `window.lamejs`.
   * @property {function(): Promise<?function>} ffmpegFactory - optional rescue
   *   decoder factory, or `null` when unavailable.
   * @property {{corePath: string, wasmPath: string}} ffmpegCore - core URLs.
   * @property {function(): string[]} ortUrls - onnxruntime-web candidates.
   * @property {function(string): string} localUrl - absolutise a bundled path.
   * @property {function(): Promise<string>} lameUrl - URL to load lamejs from
   *   inside a worker.
   * @property {string[]} notes - the resolution log.
   */

  /** @type {RSLibsApi} */
  const API = {
    CDN,
    LOCAL,

    get mode() { return mode; },
    /**
     * Switch between bundled copies (`'local'`) and free CDNs (`'cdn'`).
     * Anything else, including a missing argument, means `'local'` — the
     * privacy-preserving default is the one an unknown input lands on.
     * @param {'local'|'cdn'} next - the requested source preference.
     * @returns {'local'|'cdn'} the mode actually set.
     */
    setMode(next) {
      mode = next === 'cdn' ? 'cdn' : 'local';
      notes.push(mode === 'cdn' ? 'mode: cdn' : 'mode: local');
      return mode;
    },
    /**
     * Flip the source preference and return the new one.
     * @returns {'local'|'cdn'} the mode after the toggle.
     */
    toggle() { return API.setMode(mode === 'cdn' ? 'local' : 'cdn'); },

    /**
     * Resolve JSZip — already-loaded global first, then (in CDN mode) the three
     * mirrors in order, then the bundled copy. Concurrent callers share the one
     * cached `<script>` promise.
     * @returns {Promise<object>} the `JSZip` constructor.
     * @throws {Error} `'JSZip unavailable'` when even the bundled copy failed.
     */
    async jszip() {
      if (global.JSZip) return global.JSZip;
      const urls = mode === 'cdn' ? CDN.jszip : [];
      const used = await fetchFirst(urls, () => !!global.JSZip, LOCAL.jszip);
      notes.push('jszip ← ' + used);
      await settle();
      if (!global.JSZip) throw new Error('JSZip unavailable');
      return global.JSZip;
    },

    /**
     * Resolve lamejs (the MP3 encoder), same chain and same caching as
     * `jszip()`: existing global → CDN mirrors → bundled copy.
     * @returns {Promise<object>} the `lamejs` namespace.
     * @throws {Error} `'lamejs unavailable'` when even the bundled copy failed.
     */
    async lame() {
      if (global.lamejs) return global.lamejs;
      const urls = mode === 'cdn' ? CDN.lame : [];
      const used = await fetchFirst(urls, () => !!global.lamejs, LOCAL.lame);
      notes.push('lamejs ← ' + used);
      await settle();
      if (!global.lamejs) throw new Error('lamejs unavailable');
      return global.lamejs;
    },

    /**
     * Optional FFmpeg.wasm, used only when the browser cannot decode a file by
     * itself. Single-threaded core: works without cross-origin isolation, so it
     * is usable on plain static hosting such as GitHub Pages.
     * @returns {Promise<object|null>} a `createFFmpeg` factory or null
     */
    async ffmpegFactory() {
      if (global.FFmpeg && global.FFmpeg.createFFmpeg) return global.FFmpeg.createFFmpeg;
      try {
        await fetchFirst(CDN.ffmpeg, () => !!(global.FFmpeg && global.FFmpeg.createFFmpeg), null);
        return global.FFmpeg ? global.FFmpeg.createFFmpeg : null;
      } catch (err) {
        notes.push('ffmpeg unavailable: ' + err.message);
        return null;
      }
    },

    /** @type {{corePath: string, wasmPath: string}} */
    ffmpegCore: FFMPEG_CORE,

    /**
     * Candidate onnxruntime-web URLs, in try order, for `neural-worker.js` to
     * `importScripts()` itself (a worker has no `document` to inject a
     * `<script>` into, so this hands back the *list*, not a loaded global,
     * and the worker runs its own `importScripts` try/fallback loop — see
     * `loadOrt()` there). CDN-only, by design (see the `ort` entry above).
     * A copy is returned on purpose: the worker must be able to shift and
     * splice its candidate list without mutating this module's constant.
     * @returns {string[]} the candidate URLs, in try order.
     */
    ortUrls() { return CDN.ort.slice(); },

    /**
     * Absolutise a bundled path against the current document URL, because a
     * worker's `importScripts()` and a blob context resolve relative paths
     * against themselves, not against the page.
     * @param {string} file - repository-relative path such as
     *   `assets/vendor/lame.min.js`.
     * @returns {string} an absolute URL, or `file` unchanged when there is no
     *   `location` to resolve against (Node, a bare worker host).
     */
    localUrl(file) {
      if (!global.location) return file;
      try { return new URL(file, global.location.href).href; } catch (e) { return file; }
    },

    /**
     * The URL a rendering worker should import lamejs from: the first CDN
     * mirror in CDN mode, otherwise the bundled copy — both absolutised, since
     * the caller is a worker and not this page.
     * @returns {Promise<string>} the URL to `importScripts()`.
     */
    async lameUrl() {
      if (global.lamejs) return API.localUrl(LOCAL.lame);
      const urls = mode === 'cdn' ? CDN.lame.slice() : [];
      urls.push(API.localUrl(LOCAL.lame));
      return urls[0];
    },

    notes,
  };

  /**
   * Give an appended `<script>` a macrotask to execute before the caller looks
   * at the global it defines (`jszip()`/`lame()` call this after `loadScript`
   * settled, because `onload` can fire in the same task the global lands in).
   * @returns {Promise<void>} resolves on the next `setTimeout(0)` turn.
   */
  function settle() {
    return new Promise((r) => global.setTimeout(r, 0));
  }

  /** @type {RSLibsApi} */
  global.RSLibs = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
