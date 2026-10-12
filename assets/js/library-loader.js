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
(function (global) {
  'use strict';

  const doc = global.document;

  /** Free CDNs, in the order they are tried. */
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
  };

  /** Bundled copies — always present in this project. */
  const LOCAL = {
    jszip: 'assets/vendor/jszip.min.js',
    lame: 'assets/vendor/lame.min.js',
  };

  const FFMPEG_CORE = {
    corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
    wasmPath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.wasm',
  };

  let mode = 'local';                       // 'local' (default) | 'cdn'
  const loaded = Object.create(null);       // url → promise
  const notes = [];                         // human readable log for the About box

  /* --------------------------------------------------------------- utilities */

  /** Load a classic script once; resolves with the global it defines. */
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

  /** Try a list of URLs in order, then the bundled copy. */
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

  const API = {
    CDN,
    LOCAL,

    get mode() { return mode; },
    /** Switch between bundled copies ('local') and free CDNs ('cdn'). */
    setMode(next) {
      mode = next === 'cdn' ? 'cdn' : 'local';
      notes.push(mode === 'cdn' ? 'mode: cdn' : 'mode: local');
      return mode;
    },
    toggle() { return API.setMode(mode === 'cdn' ? 'local' : 'cdn'); },

    /** Resolve JSZip (bundled or from a CDN). Never two scripts at once. */
    async jszip() {
      if (global.JSZip) return global.JSZip;
      const urls = mode === 'cdn' ? CDN.jszip : [];
      const used = await fetchFirst(urls, () => !!global.JSZip, LOCAL.jszip);
      notes.push('jszip ← ' + used);
      await settle();
      if (!global.JSZip) throw new Error('JSZip unavailable');
      return global.JSZip;
    },

    /** Resolve lamejs (MP3 encoder). */
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

    ffmpegCore: FFMPEG_CORE,

    /** Absolute URL of a bundled file (workers need an absolute path). */
    localUrl(file) {
      if (!global.location) return file;
      try { return new URL(file, global.location.href).href; } catch (e) { return file; }
    },

    /** Absolute URL used to fetch lamejs *inside* a worker (local or CDN). */
    async lameUrl() {
      if (global.lamejs) return API.localUrl(LOCAL.lame);
      const urls = mode === 'cdn' ? CDN.lame.slice() : [];
      urls.push(API.localUrl(LOCAL.lame));
      return urls[0];
    },

    notes,
  };

  /** Wait a microtask batch so a just-appended script can define its global. */
  function settle() {
    return new Promise((r) => global.setTimeout(r, 0));
  }

  global.RSLibs = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
