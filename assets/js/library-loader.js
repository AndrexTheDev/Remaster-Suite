/* =============================================================================
 * Remaster Suite — third-party library loader
 * -----------------------------------------------------------------------------
 * PRIVACY CONTRACT (strict local mode). By default this loader makes no request
 * to any host other than the page's own origin. Third-party CDNs (unpkg,
 * cdnjs, jsDelivr) are contacted only after the user has switched on the
 * online option (`setOnline(true)`, persisted as localStorage 'rs.online').
 * With the option off, a missing local asset is refused at once with
 * UNAVAILABLE and the caller runs the DSP path — no CDN is tried, not even as a
 * fallback, and `setMode('cdn')` alone does not change that. Offline browsers
 * are never asked for anything remote either way.
 *
 * With the option on, the libraries are fetched from the CDN list in order, and
 * each fetch falls back to the bundled copy. FFmpeg.wasm is an optional rescue
 * decoder, loaded only when a browser refuses a file and only with the option on.
 * The ML runtime and models follow the same rule: the local copy in
 * assets/vendor/ first, a pinned CDN only with the option on.
 *
 * The loader also runs inside a dedicated worker (importScripts instead of
 * script tags) — see `setBase`, which points worker-side URL resolution back
 * at the page so assets/vendor/… still resolves.
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
    /* onnxruntime-web with the WebGPU execution provider (ort.all build).
     * Pinned: a model that runs today must run in five years. */
    onnx: [
      'https://unpkg.com/onnxruntime-web@1.20.1/dist/ort.all.min.js',
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.all.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.20.1/ort.all.min.js',
    ],
  };

  /** Bundled copies — always present in this project. */
  const LOCAL = {
    jszip: 'assets/vendor/jszip.min.js',
    lame: 'assets/vendor/lame.min.js',
    /* optional local onnxruntime-web drop-in (large — normally CDN-loaded) */
    onnx: 'assets/vendor/onnxweb/ort.all.min.js',
    /* ONNX models live here, named <model>.onnx */
    models: 'assets/vendor/models/',
  };

  const FFMPEG_CORE = {
    corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
    wasmPath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.wasm',
  };

  /* ----------------------------------------------------------- configuration */
  /* One switch for every third-party request, and the budget ceiling. Both are
   * read from localStorage at start-up (the page only; a worker has none and is
   * handed the values by the page). A missing or invalid value keeps the default. */
  const STORE = { online: 'rs.online', budgetMax: 'rs.inferenceBudgetMaxMs' };
  function storeGet(key) {
    try { return global.localStorage ? global.localStorage.getItem(key) : null; } catch (e) { return null; }
  }
  function storeSet(key, value) {
    try {
      if (!global.localStorage) return;
      if (value === null) global.localStorage.removeItem(key); else global.localStorage.setItem(key, String(value));
    } catch (e) { /* private mode or no storage: the choice lasts for this page only */ }
  }
  let online = storeGet(STORE.online) === '1';   // default: no third-party request at all

  /** The only gate for a third-party host: the user's opt-in, and a browser that is online. */
  function remoteAllowed() {
    return online && !offlineNow();
  }
  /** The remote list when allowed, an empty list (no request) otherwise. */
  function remoteOnly(urls) {
    return remoteAllowed() ? urls.slice() : [];
  }

  /** ONNX model registry — where a model lives besides assets/vendor/models/. */
  const MODELS = Object.create(null);       // name → { file, remote: [urls] }
  const modelCache = Object.create(null);   // name → promise of ArrayBuffer

  /**
   * An error for "this stage cannot run here" (no runtime, no weights). Callers
   * treat it as a silent fall-back to the DSP chain — it is never a failure of
   * the page. `code` is the contract, the message is for the log only.
   */
  function unavailable(msg) {
    const e = new Error(msg);
    e.code = 'UNAVAILABLE';
    return e;
  }

  /* ------------------------------------------------------ time budget (B1)
   * One ceiling for every network attempt of one load — the CDN list, the
   * bundled copy, the model sources and the runtime. A load that cannot reach
   * a source gives up when the budget runs out (3–5 s, default 4 s) and the
   * caller runs the DSP path; it never waits minutes on a dead network. */
  /* Default 5 s. The floor is 3 s. The ceiling is 5 s unless the user raises it
   * for a high-end device (localStorage 'rs.inferenceBudgetMaxMs', 5–60 s). */
  const BUDGET = { min: 3000, max: 5000, ms: 5000 };
  const BUDGET_MAX_LIMIT = 60000;
  (function applyStoredCeiling() {
    const v = Number(storeGet(STORE.budgetMax));
    if (isFinite(v) && v > 0) BUDGET.max = Math.min(BUDGET_MAX_LIMIT, Math.max(5000, v));
  })();
  function nowMs() {
    return global.performance && typeof global.performance.now === 'function' ? global.performance.now() : Date.now();
  }
  function deadline(ms) { return { at: nowMs() + (ms || BUDGET.ms) }; }
  /* Progress hook: a host (the worker) watches the acquisition moving. A silent
   * stall is what the host cuts; progress keeps it alive. The hook never breaks a load. */
  let onProgress = null;
  function progress(stage, url) {
    if (!onProgress) return;
    try { onProgress({ stage: stage, url: url, at: nowMs() }); } catch (e) { /* hook is advisory */ }
  }
  function remaining(dl) { return Math.max(0, dl.at - nowMs()); }
  /** A browser that reports itself offline has nothing to wait for: no CDN is tried. */
  function offlineNow() {
    const nav = global.navigator;
    return !!(nav && nav.onLine === false);
  }
  /**
   * Probe one URL with a HEAD request, bounded by `ms`. Used where a script
   * cannot be interrupted (importScripts inside a worker): an unreachable or
   * stalled host is rejected here, before the blocking import is started.
   */
  function probeReachable(url, ms) {
    return new Promise((resolve) => {
      if (typeof global.fetch !== 'function') { resolve(false); return; }
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const timer = global.setTimeout(() => finish(false), Math.max(1, ms));
      global.fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' }).then(
        (res) => { global.clearTimeout(timer); finish(!!res && (res.ok || res.type === 'opaque')); },
        () => { global.clearTimeout(timer); finish(false); });
    });
  }

  /** onnxruntime-node, when this is Node and the package is installed (tests, tools). */
  function nodeOnnxRuntime() {
    if (doc || typeof global.importScripts === 'function') return null;
    try {
      return typeof require === 'function' ? require('onnxruntime-node') : null;
    } catch (e) {
      return null;                       // not installed: the caller falls back to DSP
    }
  }

  /** Page base for resolving assets/… inside a worker (see setBase). */
  let base = null;

  let mode = 'local';                       // 'local' (default) | 'cdn'
  const loaded = Object.create(null);       // url → promise
  const notes = [];                         // human readable log for the About box

  /* --------------------------------------------------------------- utilities */

  /** Load a classic script once; resolves with the global it defines. */
  function loadScript(url, timeoutMs) {
    if (loaded[url]) return loaded[url];
    const limit = Math.max(1, timeoutMs || 9000);
    const p = new Promise((resolve, reject) => {
      // inside a dedicated worker there is no document — importScripts instead.
      // importScripts cannot be interrupted, so the host is probed first within
      // the same budget: a stalled CDN is refused here, not inside the import.
      if (!doc && typeof global.importScripts === 'function') {
        progress('probe', url);
        probeReachable(url, limit).then((ok) => {
          if (!ok) { reject(new Error('unreachable: ' + url)); return; }
          progress('import', url);
          try {
            global.importScripts(url);
            progress('imported', url);
            resolve(true);
          } catch (err) {
            reject(new Error('failed: ' + url));
          }
        });
        return;
      }
      if (!doc) { reject(new Error('no document')); return; }
      const el = doc.createElement('script');
      let done = false;
      const timer = global.setTimeout(() => {
        if (done) return;
        done = true;
        el.remove();
        reject(new Error('timeout: ' + url));
      }, limit);
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
  async function fetchFirst(urls, check, localUrl, dl) {
    const budget = dl || deadline();
    // no opt-in, or offline: the remote list is not tried at all (no request);
    // the bundled copy still is
    const list = remoteOnly(urls);
    if (localUrl) list.push(localUrl);
    let lastErr = null;
    for (const url of list) {
      const left = remaining(budget);
      if (left <= 0) { lastErr = new Error('budget exhausted'); break; }
      try {
        await loadScript(url, left);
        if (!check || check()) return url;
      } catch (err) { lastErr = err; }
    }
    throw unavailable((lastErr && lastErr.message) || 'no source available');
  }

  /**
   * Fetch binary bytes (ONNX models). Two limits, neither of them a total:
   *  · the connection (up to the response headers) has `timeoutMs`, the caller's
   *    share of the shared budget;
   *  · the body has a *stall window* of one budget. It is cut only when no bytes
   *    arrive for that long, so a large local model on a slow device is loaded
   *    in full while it keeps arriving, and a body that stops is refused.
   */
  function fetchBytes(url, timeoutMs) {
    const connect = Math.max(1, timeoutMs || BUDGET.ms);
    return new Promise((resolve, reject) => {
      if (typeof global.fetch !== 'function') { reject(new Error('no fetch')); return; }
      let done = false, timer = null, reader = null;
      const fail = (err) => {
        if (done) return;
        done = true;
        global.clearTimeout(timer);
        if (reader) { try { reader.cancel(); } catch (e) { /* already closed */ } }
        reject(err);
      };
      const arm = (ms, what) => {
        global.clearTimeout(timer);
        timer = global.setTimeout(() => fail(new Error(what + url)), Math.max(1, ms));
      };
      arm(connect, 'timeout: ');
      progress('connect', url);
      global.fetch(url).then(async (res) => {
        if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 'no response') + ': ' + url);
        if (!res.body || typeof res.body.getReader !== 'function') return res.arrayBuffer();
        reader = res.body.getReader();
        const parts = [];
        let size = 0, lastNote = 0;
        for (;;) {
          arm(BUDGET.ms, 'stalled: ');       // silence since the last byte, not the total
          const next = await reader.read();
          if (next.done) break;
          parts.push(next.value);
          size += next.value.byteLength;
          const now = nowMs();
          if (now - lastNote >= 250) { lastNote = now; progress('bytes', url); }
        }
        const out = new Uint8Array(size);
        let at = 0;
        for (const p of parts) { out.set(p, at); at += p.byteLength; }
        return out.buffer;
      }).then((buf) => {
        if (done) return;
        done = true;
        global.clearTimeout(timer);
        resolve(buf);
      }, fail);
    });
  }

  /* ------------------------------------------------------------- public API */

  const API = {
    CDN,
    LOCAL,

    get mode() { return mode; },
    /** Whether third-party hosts may be contacted (the user's opt-in). */
    get online() { return online; },
    /** Switch the third-party opt-in on or off; the choice is stored for the next visit. */
    setOnline(on) {
      online = !!on;
      storeSet(STORE.online, online ? '1' : null);
      notes.push(online ? 'online sources: allowed (opt-in)' : 'online sources: off (strict local)');
      return online;
    },
    /** The network budget of one load, in ms (default 5 s, clamped to 3 s … the ceiling). */
    get budget() { return BUDGET.ms; },
    /** The floor and the ceiling of the budget, for a host that clamps its own (the page for its worker). */
    budgetLimits() { return { min: BUDGET.min, max: BUDGET.max }; },
    /** Raise or lower the ceiling (5–60 s). Stored for the next visit. Returns the ceiling. */
    setBudgetMax(ms) {
      const v = Number(ms);
      if (!isFinite(v)) return BUDGET.max;
      BUDGET.max = Math.min(BUDGET_MAX_LIMIT, Math.max(5000, v));
      storeSet(STORE.budgetMax, BUDGET.max === 5000 ? null : BUDGET.max);
      if (BUDGET.ms > BUDGET.max) BUDGET.ms = BUDGET.max;
      return BUDGET.max;
    },
    /** Progress hook for a host that watches a load (null to remove it). */
    setProgress(fn) { onProgress = typeof fn === 'function' ? fn : null; },
    /** A fresh budget (`{at}`) to share across several loads of one feature. */
    newBudget(ms) { return deadline(ms); },
    setBudget(ms) {
      const v = Number(ms);
      BUDGET.ms = isFinite(v) ? Math.min(BUDGET.max, Math.max(BUDGET.min, v)) : BUDGET.ms;
      return BUDGET.ms;
    },
    /** Switch between bundled copies ('local') and free CDNs ('cdn'). */
    setMode(next) {
      mode = next === 'cdn' ? 'cdn' : 'local';
      notes.push(mode === 'cdn' ? 'mode: cdn' : 'mode: local');
      return mode;
    },
    /** Flip the third-party opt-in (kept for callers that used the old toggle). */
    toggle() { return API.setOnline(!online); },

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
      const root = base || (global.location && global.location.href);
      if (!root) return file;
      try { return new URL(file, root).href; } catch (e) { return file; }
    },

    /**
     * Point URL resolution at the page. A dedicated worker's `location` is its
     * own script, so without this every assets/vendor/… fetch inside the ML
     * worker would resolve one directory too deep.
     */
    setBase(href) { base = href || null; return base; },

    /** Register where an ONNX model lives besides assets/vendor/models/. */
    registerModel(name, spec) {
      const s = spec || {};
      MODELS[name] = {
        file: s.file || (name + '.onnx'),
        remote: Array.isArray(s.remote) ? s.remote.slice() : (s.remote ? [s.remote] : []),
      };
      delete modelCache[name];
      return MODELS[name];
    },

    /**
     * Lazily fetch an ONNX model as raw bytes: the local filesystem first
     * (assets/vendor/models/<file>), then the registered CDN fallbacks — in
     * 'cdn' mode the order is reversed. Nothing is downloaded before this
     * call; a second call resolves from the in-memory cache.
     * @param {string} name  model name (or pass { file } in the options)
     * @returns {Promise<ArrayBuffer>} the bytes an inference session wants
     */
    async onnxModel(name, opts) {
      if (modelCache[name]) return modelCache[name];
      const p = (async () => {
        const spec = MODELS[name] || {};
        const o = opts || {};
        const file = o.file || spec.file || (name + '.onnx');
        const remote = (o.remote || spec.remote || []).slice();
        const local = API.localUrl(LOCAL.models + file);
        // the remote sources are requested only with the opt-in; without it the
        // only candidate is the bundled file, and a missing one is refused at once
        const order = remoteAllowed()
          ? (mode === 'cdn' ? remote.concat([local]) : [local].concat(remote))
          : [local];
        // a caller that loads several files (DeepFilterNet3: three graphs) passes
        // one shared budget, so the total is bounded, not each file's share
        const budget = o.budget || deadline();
        for (const url of order) {
          const left = remaining(budget);
          if (left <= 0) break;
          try {
            const bytes = await fetchBytes(url, left);
            notes.push('onnx model ' + name + ' ← ' + url);
            return bytes;
          } catch (err) { /* next source, while the budget lasts */ }
        }
        // no local file and no reachable source: the stage is unavailable, which
        // is an ordinary outcome offline — not an error (see unavailable())
        throw unavailable('model unavailable: ' + name);
      })();
      modelCache[name] = p;
      // a failed load must not poison the cache forever
      p.catch(() => { delete modelCache[name]; });
      return p;
    },

    /**
     * Lazily bind onnxruntime-web (the WebGPU-capable build): a local drop-in
     * in assets/vendor/onnxweb/ first, the free CDNs after — the reverse of the
     * bundled libraries, because the runtime is megabytes heavy and no copy
     * ships with the suite by default. In Node the installed onnxruntime-node
     * is used instead, when it is there.
     *
     * Never throws: a runtime that cannot be bound (offline, blocked, not
     * installed) resolves to null, and the caller runs the DSP chain.
     * @returns {Promise<object|null>} the `ort` namespace, or null
     */
    async onnxRuntime() {
      if (global.ort) return global.ort;
      const node = nodeOnnxRuntime();
      if (node) { notes.push('onnxruntime ← onnxruntime-node'); return node; }
      if (!doc && typeof global.importScripts !== 'function') {
        notes.push('onnxruntime unavailable here → dsp');
        return null;
      }
      const urls = mode === 'cdn' ? CDN.onnx : [];
      let used = null;
      const budget = deadline();                // one budget for the whole runtime load
      try {
        used = await fetchFirst(urls, () => !!global.ort, LOCAL.onnx, budget);
      } catch (err) {
        // nothing vendored locally: the CDN list is the fallback
        try {
          used = await fetchFirst(CDN.onnx, () => !!global.ort, null, budget);
        } catch (err2) {
          notes.push('onnxruntime unavailable (' + err2.message + ') → dsp');
          return null;
        }
      }
      notes.push('onnxruntime ← ' + used);
      await settle();
      if (!global.ort) { notes.push('onnxruntime did not define ort → dsp'); return null; }
      // the runtime fetches its own .wasm modules from beside its script
      if (global.ort.env && global.ort.env.wasm) {
        global.ort.env.wasm.simd = true;
        const cut = used.lastIndexOf('/');
        if (cut > 0 && !global.ort.env.wasm.wasmPaths) {
          global.ort.env.wasm.wasmPaths = used.slice(0, cut + 1);
        }
      }
      return global.ort;
    },

    /** Absolute URL used to fetch lamejs *inside* a worker (local or CDN). */
    async lameUrl() {
      if (global.lamejs) return API.localUrl(LOCAL.lame);
      // the CDN address only with the opt-in; the bundled copy otherwise
      const urls = remoteOnly(CDN.lame);
      urls.push(API.localUrl(LOCAL.lame));
      return urls[0];
    },

    /**
     * Which stages of the hybrid chain can run here, decided before anything is
     * loaded. Only files next to the page are looked at (a HEAD request to
     * assets/vendor/models/), so a blocked network changes nothing: a stage
     * whose weights are not present is 'dsp' and the chain runs unchanged.
     * Remote candidates are reported as 'remote' only in 'cdn' mode and only
     * when registerModel() gave them a source — they are not contacted here.
     * @returns {Promise<{tier:string, stages:object, models:object, manifest:boolean}>}
     */
    async probeModels(opts) {
      const o = opts || {};
      const manifest = await loadManifest(o.timeoutMs || 1500);
      const env = environment();
      const tier = pickTier(env);
      const models = Object.create(null);
      const stages = Object.create(null);
      if (!manifest) {
        for (const k of ['denoise', 'superRes']) stages[k] = { use: 'dsp', candidate: null, reason: 'no manifest' };
        return { tier: tier, stages: stages, models: models, manifest: false };
      }
      const cache = Object.create(null);
      const avail = async (file) => {
        if (!(file in cache)) cache[file] = await localFileExists(LOCAL.models + file, o.timeoutMs || 1500);
        return cache[file];
      };
      for (const stageName of Object.keys(manifest.stages || {})) {
        const st = manifest.stages[stageName];
        let chosen = null;
        for (const c of st.candidates || []) {
          // a full-size model is not loaded on a compact-tier device at all
          if (c.tier === 'full' && tier.tier === 'compact') continue;
          const files = c.files || [];
          let all = files.length > 0;
          for (const f of files) {
            const ok = await avail(f);
            models[f] = ok ? 'local' : 'missing';
            if (!ok) all = false;
          }
          if (all) { chosen = c; break; }
        }
        stages[stageName] = chosen
          ? { use: chosen.id, candidate: chosen.id, reason: 'local' }
          : { use: st.fallback || 'dsp', candidate: null, reason: 'no local weights' };
      }
      return { tier: tier, stages: stages, models: models, manifest: true };
    },

    /** True for the "stage cannot run here" outcome (see unavailable()). */
    isUnavailable(err) { return !!(err && err.code === 'UNAVAILABLE'); },

    notes,
  };

  /* ---------------------------------------------------- model probing ---- */

  let manifestPromise = null;
  /** The model chain (assets/vendor/models/manifest.json), fetched once from this origin. */
  function loadManifest(timeoutMs) {
    if (manifestPromise) return manifestPromise;
    const p = fetchBytes(API.localUrl(LOCAL.models + 'manifest.json'), timeoutMs || 1500)
      .then((buf) => JSON.parse(new TextDecoder('utf-8').decode(buf)))
      .catch(() => null);
    // a failed read is not kept: the next probe tries again
    p.then((m) => { if (!m) manifestPromise = null; });
    manifestPromise = p;
    return p;
  }

  /** HEAD on a same-origin path: true when the file is there. Never leaves the origin. */
  function localFileExists(path, timeoutMs) {
    return new Promise((resolve) => {
      if (typeof global.fetch !== 'function') { resolve(false); return; }
      const url = API.localUrl(path);
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const timer = global.setTimeout(() => finish(false), timeoutMs);
      global.fetch(url, { method: 'HEAD', cache: 'no-store' }).then(
        (res) => { global.clearTimeout(timer); finish(!!(res && res.ok)); },
        () => { global.clearTimeout(timer); finish(false); });
    });
  }

  /** The memory tier, by the same rule the worker uses (neural-dsp.js). */
  function environment() {
    const nav = global.navigator || {};
    const ua = String(nav.userAgent || '');
    const mem = global.performance && global.performance.memory;
    return {
      mobile: !!(nav.userAgentData && nav.userAgentData.mobile) || /Mobi|Android|iPhone|iPad/i.test(ua),
      heapLimitMB: mem ? mem.jsHeapSizeLimit / 1048576 : NaN,
      usedHeapMB: mem ? mem.usedJSHeapSize / 1048576 : NaN,
    };
  }
  function pickTier(env) {
    if (global.RSNeural && typeof global.RSNeural.chooseModelTier === 'function') {
      return global.RSNeural.chooseModelTier(env);
    }
    const e = env || {};
    const free = Number(e.heapLimitMB) - Number(e.usedHeapMB);
    if (e.mobile) return { tier: 'compact', reason: 'mobile' };
    if (isFinite(free) && free < 420) return { tier: 'compact', reason: 'heap' };
    return { tier: 'full', reason: 'default' };
  }

  /** Wait a microtask batch so a just-appended script can define its global. */
  function settle() {
    return new Promise((r) => global.setTimeout(r, 0));
  }

  global.RSLibs = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
