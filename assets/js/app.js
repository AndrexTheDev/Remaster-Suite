/* =============================================================================
 * Remaster Suite — application glue
 * -----------------------------------------------------------------------------
 * Drop → listen → compare → save. This file owns the state, the sequential
 * (memory-friendly) processing queue and every piece of wiring between the
 * engine, the analyser and the DOM.
 * ========================================================================== */
/**
 * @fileoverview Application glue — drop, listen, compare, save. Loaded last,
 * as the only module that *uses* the others: it owns the card list, the
 * sequential (memory-friendly) processing queue and every piece of wiring
 * between the engine, the analyser, the codecs and the DOM.
 *
 * Everything the rest of the app needs from this file hangs off three
 * structures: `State` (the session's own state, shared by every card), the
 * per-file `Card` objects it creates from `#cardTpl`, and `CONFIG` (the
 * tunables, including the mobile memory budget and the thresholds at which a
 * render switches to the chunked/streamed path). Nothing here is exported —
 * the app is the last script on the page and there is no caller below it.
 *
 * @module RSApp
 */
(function (global) {
  'use strict';

  const UI = global.RSUI;
  const Codecs = global.RSCodecs;
  const Presets = global.RSPresets;
  const Analyzer = global.RSAnalyzer;
  const Engine = global.RSEngine;
  const OPFS = global.RSOPFS;
  const Neural = global.RSNeural;

  const $ = UI.$;
  const $$ = UI.$$;
  /**
   * Translate one message key through the active dictionary, with optional
   * substitutions. A thin local alias so every label in this file reads the
   * same way, and so a missing dictionary at load time cannot turn a label
   * into a crash.
   * @param {string} k - dictionary key (for example `note.decode`).
   * @param {Object} [v] - substitution values for `{name}` placeholders.
   * @returns {string} the translated text, or the key itself when it is
   *   unknown.
   */
  const t = (k, v) => global.RSi18n.t(k, v);

  /* ------------------------------------------------------------------- config */

  /**
   * Whether the primary input is a coarse pointer — a phone or tablet. Decides
   * the copy ("tap to choose" instead of "drop files here"), whether a long
   * render takes a screen wake lock, and the memory budget. Deliberately reads
   * the *pointer*, not the user agent: a desktop with a touchscreen is a
   * desktop.
   * @returns {boolean} `true` for a touch-first device.
   */
  function isTouchDevice() {
    try {
      if (global.matchMedia && global.matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
    } catch (e) { /* no matchMedia: fall through */ }
    return !!(global.navigator && global.navigator.maxTouchPoints > 0);
  }

  /**
   * Read the pointer again — a phone that gets a keyboard, a tablet that is
   * rotated, a desktop window that is resized onto a touch screen. The wording
   * and the memory budget follow; nothing is decided once and forever.
   * @returns {boolean} the touch state after re-reading the pointer.
   */
  function applyPointer() {
    const touch = isTouchDevice();
    State.touch = touch;
    CONFIG.softMemoryMB = touch ? 420 : 900;
    return touch;
  }

  /**
   * Haptic feedback for a touch interaction — a slider crossing a notch, a
   * preset landing, the Magic Fix button firing, the compare FAB being held.
   *
   * `navigator.vibrate` is Android-Chrome-only: iOS Safari has never shipped
   * it, and an embedded frame can have it blocked by a permissions policy. So
   * the call goes through `RSUI.haptic()`, which vibrates where it can and
   * otherwise knocks the control the touch belongs to (a short scale-and-ring
   * micro-animation). Exactly one of the two happens, and a caller never has
   * to feature-detect either.
   * @param {(number|number[])} pattern - milliseconds, or an on/off pattern,
   *   exactly as the Web Vibration API takes them.
   * @param {?Element} [anchor] - the control that was touched; the visual
   *   fallback animates this, so a caller on a phone should always pass it.
   * @returns {('vibrate'|'visual'|'none')} which feedback channel really ran.
   */
  function vibrate(pattern, anchor) {
    if (UI && UI.haptic && typeof UI.haptic === 'function') {
      return UI.haptic(anchor || null, pattern);
    }
    try {
      const v = global.navigator && global.navigator.vibrate;
      if (typeof v === 'function') { v.call(global.navigator, pattern); return 'vibrate'; }
    } catch (e) { /* unsupported or blocked — the UI works fine without it */ }
    return 'none';
  }

  /**
   * The application's tunables. The memory-related ones matter most: a phone
   * browser has far less room for a ZIP full of WAVs than a desktop, which is
   * why the soft budget, the OPFS upload threshold and the chunked-render
   * threshold all exist (and are all measured by the suites rather than
   * guessed at).
   * @typedef {Object} AppConfig
   * @property {number} previewSeconds - 40: length of the live A/B window; the
   *   full file is rendered on save.
   * @property {number} previewMin - 12: shortest preview window, even for a
   *   very short file.
   * @property {number} maxFileBytes - 2 GiB, the point at which a file is
   *   refused before anything tries to decode it.
   * @property {number} softMemoryMB - 420 on a phone, 900 on a desktop:
   *   estimated output ceiling that decides whether batch work streams through
   *   OPFS or stays in memory.
   * @property {number} maxLiveTools - 120: cap on live monitoring nodes, so a
   *   batch cannot leave one audio graph per card running.
   * @property {number} opfsUploadThresholdBytes - 24 MiB: a bigger upload is
   *   streamed straight into OPFS scratch instead of being read whole into the
   *   heap; smaller files skip the round trip.
   * @property {number} chunkedRenderThresholdSeconds - 90: a longer file
   *   renders through `RSEngine.renderChunked()` and streams into its OPFS
   *   output file; every automated fixture stays below this, so its
   *   exact-size assertions exercise the unchanged whole-file path.
   * @property {number} chunkSeconds - 10: nominal chunk length for that render.
   * @property {number} chunkCrossfadeMs - 50: crossfade joining two chunks.
   * @property {number} magicPower - 0.85: the power the one-tap "AI Magic
   *   Fix" sets — high enough that the measurement-gated stages really engage,
   *   short of 100 % so it never feels like a blunt instrument.
   * @property {number} magicNeuralAmount - 0.65: a deliberately light trust
   *   amount for the optional neural coupling, applied only by Magic Fix.
   */

  /** @type {AppConfig} */
  const CONFIG = {
    previewSeconds: 40,        // live A/B window; the full file is rendered on save
    previewMin: 12,
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    // a phone browser has far less room for a ZIP full of WAVs than a desktop
    softMemoryMB: isTouchDevice() ? 420 : 900,
    maxLiveTools: 120,
    // a freshly-picked file larger than this is streamed straight into OPFS
    // scratch storage on upload (see streamUploadToOPFS()) instead of ever
    // being read whole into the heap by a naive `file.arrayBuffer()`; small
    // files skip the round-trip entirely — there is nothing to protect
    opfsUploadThresholdBytes: 24 * 1024 * 1024,
    // a file this long (post-decode) renders through Engine.renderChunked()
    // and streams straight into the OPFS output file instead of one
    // whole-file Engine.render() pass — see renderCard(). Well above every
    // fixture the automated test suites use, so their exact-size/exact-peak
    // assertions exercise the unchanged render() path, never this one.
    chunkedRenderThresholdSeconds: 90,
    chunkSeconds: 10,
    chunkCrossfadeMs: 50,
    // the one-tap "AI Magic Fix": a confident, pre-judged restoration power —
    // strong enough that the measurement-gated de-clipper and air-synthesis
    // stages really engage, but short of 100 % so it never feels like a
    // blunt instrument — paired with auto profile detection and, where the
    // hardware/weights allow it, a deliberately *light* application of the
    // optional neural coupling (see State.neuralAmount below).
    magicPower: 0.85,
    magicNeuralAmount: 0.65,
  };

  /* -------------------------------------------------------------------- state */

  /**
   * The session state, shared by every card: the sliders' values, the current
   * A/B mode, the export format, what the batch queue is doing right now and
   * the three facts that are only ever learned asynchronously (whether OPFS is
   * usable, whether a neural model is installed, and whether one already fell
   * back to the pure-DSP path this session).
   *
   * Keys prefixed with an underscore are private to this module's own long
   * running operations; everything else is read by the card renderers.
   * @typedef {Object} AppState
   * @property {RSApp.Card[]} cards - the file cards, in display order.
   * @property {number} seq - monotonic id source; ids are never reused.
   * @property {number} power - 0…1 restoration power (the global slider).
   * @property {string} preset - selected profile id, `'auto'` by default.
   * @property {('original'|'restored'|'compare')} ab - what the monitor plays.
   * @property {('wav'|'mp3')} format - export format.
   * @property {number} mp3Rate - MP3 bitrate in kbps.
   * @property {number} wavDepth - WAV word length (16/24/32).
   * @property {boolean} busy - a batch operation is running; the controls are
   *   disabled while it is.
   * @property {boolean} powerTouched - the user moved the slider, so it no
   *   longer adopts a profile's recommendation.
   * @property {boolean} touch - coarse pointer detected (see `applyPointer()`).
   * @property {?RSApp.JobState} job - the running job, or `null`.
   * @property {boolean} opfsReady - `RSOPFS.isSupported()` resolved true.
   * @property {boolean} neuralEnabled - the user switched the neural coupling
   *   on; only ever effective together with `neuralAvailable`.
   * @property {boolean} neuralAvailable - a model really has weights installed
   *   *and* a session could be built — never true just because the feature
   *   exists in this build.
   * @property {boolean} neuralDenoise - DeepFilterNet3 specifically is
   *   available, i.e. the pre-DSP denoiser (Stage 0) can really run.
   * @property {boolean} aiDenoise - the pre-DSP neural denoiser is switched on
   *   for renders. Set by Magic Fix (and only when `neuralDenoise` is true);
   *   it is what the FAB's C position plays.
   * @property {Object} neuralModels - the probe's per-model report, kept so
   *   the UI can name the model a switch would use instead of guessing.
   * @property {boolean} _aiDenoiseWanted - Magic Fix asked for the pre-DSP
   *   denoiser before the capability probe had answered, so the answer arms it
   *   instead of the request being lost.
   * @property {?RSApp.Card} _inspectorCard - the card whose controls the phone
   *   sheet is holding, or `null`. Exactly one can be open, because there is
   *   exactly one sheet.
   * @property {boolean} _neuralFallbackToastShown - one hardware-fallback toast
   *   per session, not one per failed call in a batch.
   * @property {boolean} _magicFixAutoProcess - Magic Fix set this before opening
   *   the picker on an empty list, so `addFiles()` starts the batch by itself.
   * @property {?number} neuralAmount - a lighter-than-default trust amount for
   *   the neural coupling, `undefined` everywhere except right after a Magic
   *   Fix (so the ordinary checkbox keeps its full-strength behaviour).
   */

  const State = {
    cards: [],
    seq: 1,
    power: 0.70,
    preset: 'auto',
    ab: 'restored',
    format: 'wav',
    mp3Rate: 320,
    wavDepth: 16,
    busy: false,
    powerTouched: false,
    touch: false,
    job: null,
    // set once `RSOPFS.isSupported()` resolves (see `initStreaming()`); while
    // it is still pending, batch rendering uses the safe in-memory path
    opfsReady: false,
    // the user's own choice, off by default (see `initNeural()`): whether the
    // optional neural Stage-7 coupling should run on the *final* export
    // render. It only ever has an effect when `neuralAvailable` is also true.
    neuralEnabled: false,
    // set once `RSNeural.probe()` resolves: true only when at least one of
    // DeepFilterNet3 / BS-RoFormer / the air super-resolution model actually
    // has weights installed *and* a WebGPU or WASM session could be built —
    // never true just because the feature exists in this build.
    neuralAvailable: false,
    // DeepFilterNet3 specifically — the model Stage 0 runs. Separate from
    // `neuralAvailable`, which is true when *any* model loaded.
    neuralDenoise: false,
    // the pre-DSP denoiser, switched on by Magic Fix when a model is there
    aiDenoise: false,
    // the probe's per-model report (see initNeural())
    neuralModels: null,
    // Magic Fix pressed before the probe resolved: arm Stage 0 when it does
    _aiDenoiseWanted: false,
    // the card whose per-file controls are in the phone's bottom sheet
    _inspectorCard: null,
    // set in initNeural(): nothing is installed but the model manager could
    // fetch the quantised weights, so the toggle offers to do exactly that
    // instead of sitting disabled.
    neuralDownloadable: false,
    // true while a model download is running — the toggle refuses a second one
    _neuralLoading: false,
    // the progress subscription is page-lifetime, not per-initNeural() call
    _neuralProgressBound: false,
    // flips true the first time a render's neural call fails with a
    // hardware-limit reason (OOM/device-lost/timeout — see initNeural()'s
    // Neural.onHardwareFallback subscription); keeps the toast it triggers
    // to exactly one per session instead of one per failed call in a batch.
    _neuralFallbackToastShown: false,
    // set by applyMagicFix() right before it opens the file picker when the
    // list is still empty — addFiles() checks this once its own sequential
    // analyse loop is done and, only on a touch device, goes straight into
    // processAll() so a single tap on "AI Magic Fix" really is the whole
    // journey from empty page to a finished, downloadable file.
    _magicFixAutoProcess: false,
    // a lighter-than-default wet amount for the optional neural coupling
    // (see CONFIG.magicNeuralAmount); undefined everywhere except right
    // after a Magic Fix, so the pre-existing "KI-Höhenrekonstruktion"
    // checkbox keeps its original, full-strength `{}` neural options object
    // and every test that exercises it is unaffected.
    neuralAmount: undefined,
  };

  /**
   * The in-memory representation of one file in the list — the source of truth
   * for its UI node, its analysis, its render and the scratch keys behind them.
   * @typedef {Object} Card
   * @property {number} id - monotonic id, also the basis of its scratch keys.
   * @property {File} file - the picked file; rebound to the OPFS copy once a
   *   large upload was streamed there.
   * @property {string} name - display name (and the basis of the export name).
   * @property {number} size - byte count as picked.
   * @property {string} status - `'queued'`, `'analyzing'`, `'processing'`,
   *   `'done'`, `'error'` — drives the card's pill and buttons.
   * @property {?number} power - per-card power override, `null` = follow the
   *   global slider.
   * @property {?string} preset - per-card profile override, `null` = follow.
   * @property {boolean} loop - whether the preview repeats.
   * @property {?RSAnalyzer.AnalysisResult} analysis - the measurement; `null`
   *   until the file has been analysed.
   * @property {?Object} after - the re-measurement of the rendered file.
   * @property {?AudioBuffer} previewBuffer - the live monitor's buffer (B:
   *   original through the DSP chain).
   * @property {?AudioBuffer} previewBufferNeural - the C position's buffer:
   *   the same chain, but fed by the Stage-0 neural pre-process. Only ever
   *   set when that stage really ran (see computeComparePreview()).
   * @property {?Object} previewStage0 - what Stage 0 reported for that render
   *   (chunks, underflows, timing), or `null`.
   * @property {boolean} [isInspected] - this card's controls are currently in
   *   the phone's bottom sheet; only ever one card at a time.
   * @property {?Object} result - the finished render (channels or an OPFS key,
   *   plus its rate and length).
   * @property {number} progress - 0…1 of the current step, for the bar.
   * @property {?string} error - a failed step's message, or `null`.
   * @property {Object<string, Element>} el - the card's DOM handles (see
   *   `createCard()`), so a repaint never queries the document again. `grid`
   *   is the `.card-grid` holding the per-file controls: it is the node the
   *   bottom sheet adopts on a phone, and closing the sheet puts it back.
   * @property {RSUI.Waveform} wave - the A/B canvas controller.
   * @property {number} [_workT0] - when the current step started, for the ETA.
   * @property {string} [_uploadOpfsKey] - scratch key of a streamed upload.
   * @property {number} [_renderSeq] - counter behind collision-free render keys.
   */

  /**
   * The job bar's state: what is running, how far along it is and how long it
   * has been going.
   * @typedef {Object} JobState
   * @property {number} total - files in the batch (1 for a single file).
   * @property {number} index - 0-based index of the file being worked on.
   * @property {string} name - that file's name, for the bar's label.
   * @property {?RSApp.Card} card - its card, when the job knows one.
   * @property {string} stage - the stage key the bar names.
   * @property {number} p - 0…1 progress of the batch as a whole.
   * @property {number} t0 - `performance.now()` when the job started, for the
   *   time-left estimate.
   * @property {boolean} indeterminate - the current step cannot be counted
   *   (the browser's own decode, a ZIP write), so the bar sweeps instead of
   *   inventing a number.
   */

  /* ------------------------------------------------------- OPFS scratch I/O */

  /**
   * Detect the Origin Private File System once at boot and sweep any scratch
   * files a previous, crashed tab might have left behind — OPFS persists
   * across reloads, unlike a plain JS heap, so it needs this one bit of
   * housekeeping that in-memory buffers never did.
   * @returns {Promise<void>} resolves once the capability is known; a failure
   *   simply leaves `State.opfsReady` false and the in-memory path in charge.
   */
  async function initStreaming() {
    if (!OPFS) return;
    try {
      State.opfsReady = await OPFS.isSupported();
    } catch (e) {
      State.opfsReady = false;
    }
    if (State.opfsReady) OPFS.resetScratch();
  }

  /* ---------------------------------------------------------------- neural */

  /**
   * The neural row's status line as it was last decided, so a language switch
   * can re-translate it without probing the hardware again — a second probe
   * would also clear the user's switch, which is not what changing the page
   * language should do.
   * @type {?{key: ?string, models: ?string[], provider: ?string}}
   */
  let neuralStatus = null;
  /** Last cache report, retained so language changes repaint model metadata. */
  let neuralModelStatus = null;

  /** Paint the neural status line in the current language.
   * @returns {void} */
  function paintNeuralStatus() {
    const status = $('#neuralStatus');
    if (!status || !neuralStatus) return;
    status.textContent = neuralStatus.models
      ? neuralStatus.models.join(', ') + ' · ' + t(neuralStatus.provider)
      : t(neuralStatus.key);
  }

  /**
   * Remember and paint one status for the neural row.
   * @param {?string} key - the i18n key to show, or null for the model list.
   * @param {{models: string[], provider: string}} [extra] - for the "available"
   *   case: the installed models and the provider's own i18n key.
   * @returns {void}
   */
  function setNeuralStatus(key, extra) {
    neuralStatus = {
      key: key || null,
      models: (extra && extra.models) || null,
      provider: (extra && extra.provider) || null,
    };
    paintNeuralStatus();
  }

  /** Paint installed model provenance and management controls. @param {?Object} status cache report. @returns {void} */
  function paintNeuralModelInfo(status) {
    neuralModelStatus = status;
    const box = $('#neuralModelInfo'), text = $('#neuralModelMeta'), remove = $('#neuralModelRemove');
    if (!box || !text || !remove) return;
    const variants = status && status.variants;
    const name = variants && Object.keys(variants).find((key) => variants[key] && variants[key].cached);
    if (!name) { box.hidden = true; text.textContent = ''; return; }
    const item = variants[name], meta = item.metadata || {};
    text.textContent = t('ctl.neuralMeta', {
      variant: name.toUpperCase(), size: ((item.size || 0) / 1e6).toFixed(1),
      version: meta.version || '—', license: meta.license || '—',
    }) + (item.updateAvailable ? ' · ' + t('ctl.neuralUpdate') : '');
    remove.disabled = State._neuralLoading;
    box.hidden = false;
  }

  /**
   * Probe the optional neural pipeline once at boot: does WebGPU (or at
   * least WASM-SIMD) work here, and is any model's weights file actually
   * installed (OPFS or a local `models/<name>/` folder)? The checkbox stays
   * disabled with an explanatory status line until this resolves true — the
   * feature is opt-in *and* only ever offered when it can really do
   * something, never a control that silently does nothing when toggled.
   *
   * @returns {Promise<void>} resolves once the probe finished — whether or
   * not a model turned out to be installed.
   */
  async function initNeural() {
    const toggle = $('#neuralToggle');
    if (!toggle) return;
    if (!Neural || typeof Neural.probe !== 'function') { toggle.disabled = true; setNeuralStatus('ctl.neuralUnavailable'); return; }
    // A configured URL is not evidence that a usable model exists. Resolve the
    // signed-by-hash channel description first; only a compatible manifest may
    // turn the empty state into a download offer.
    if (typeof Neural.loadModelManifest === 'function') {
      try { await Neural.loadModelManifest(); } catch (e) { /* clean unavailable state below */ }
    }
    let probe;
    try { probe = await Neural.probe(); } catch (e) { toggle.disabled = true; setNeuralStatus('ctl.neuralUnavailable'); return; }
    const models = (probe && probe.models) || {};
    const anyModel = Object.keys(models).some((k) => models[k] && models[k].available);
    State.neuralModels = models;
    State.neuralAvailable = !!anyModel;
    // Stage 0 is DeepFilterNet3's job specifically — a loaded BS-RoFormer or
    // air model must not make the denoise switch look usable
    State.neuralDenoise = !!(models.deepfilternet3 && models.deepfilternet3.available);
    if (!State.neuralDenoise) State.aiDenoise = false;
    // a Magic Fix that landed while this probe was still in flight gets its
    // answer now — the one-tap journey must not depend on the tap's timing
    if (State.neuralDenoise && State._aiDenoiseWanted) {
      State._aiDenoiseWanted = false;
      if (!State.aiDenoise) {
        State.aiDenoise = true;
        if (State.cards.length) markAllStale();   // the export has changed shape
      }
    }
    // Nothing installed is no longer a dead end: the model manager can fetch
    // the quantised weights once and keep them in OPFS. `canLoadModels()`
    // answers whether that is even possible here (a source configured, a model
    // store present), and the toggle only stays enabled when it is.
    State.neuralDownloadable = !anyModel && !!(Neural.canLoadModels && Neural.canLoadModels());
    let cached = null;
    try { cached = Neural.modelStatus ? await Neural.modelStatus('deepfilternet3') : null; } catch (e) { cached = null; }
    paintNeuralModelInfo(cached);
    toggle.disabled = !(State.neuralAvailable || State.neuralDownloadable);
    toggle.checked = false;
    if (State.neuralAvailable) {
      // WebNN > WebGPU > WASM only as a *status label* here — which EP a
      // given model session actually landed on (mobile-first WebNN order
      // included) is `neural-worker.js`'s own call per model; this is just
      // the best single-line summary of what this device can reach at all.
      setNeuralStatus(null, {
        models: Object.keys(models).filter((k) => models[k] && models[k].available),
        provider: (probe.webnn && probe.webnn.available) ? 'ctl.neuralWebnn'
          : (probe.webgpu && probe.webgpu.available) ? 'ctl.neuralWebgpu' : 'ctl.neuralWasm',
      });
    } else if (cached && cached.cached) {
      // the weights are on disk but the runtime could not be loaded (an
      // offline first run, a blocked CDN): say exactly that instead of
      // claiming no model exists
      setNeuralStatus('ctl.neuralInstalledNoRuntime');
    } else if (State.neuralDownloadable) {
      setNeuralStatus('ctl.neuralDownloadable');
    } else {
      setNeuralStatus('ctl.neuralUnavailable');
    }
    // one progress subscription for the page's lifetime: every download this
    // module starts, including one a probe-triggered load started, paints the
    // same bar
    if (Neural.onModelProgress && !State._neuralProgressBound) {
      State._neuralProgressBound = true;
      Neural.onModelProgress((p) => {
        if (!p || p.phase !== 'download') return;
        UI.modelLoader.update({ ratio: p.ratio, text: t('ctl.neuralDownloading') });
      });
    }
    // One quiet, one-time-per-session toast when a render actually attempted
    // neural inference and the hardware gave out mid-call (OOM/device-lost/
    // timeout — see neural-worker.js's resolveInferenceFailure and
    // neural-controller.js's HARDWARE_LIMIT_REASONS). The pure-DSP fallback
    // itself needs no new code here: engine.js already treats any
    // `{applied:false}` result as "proceed without the curve" — this is
    // purely informational, so it never fires more than once even across a
    // whole batch export full of repeated throttled calls.
    if (Neural && typeof Neural.onHardwareFallback === 'function' && !State._neuralFallbackToastShown) {
      Neural.onHardwareFallback(() => {
        if (State._neuralFallbackToastShown) return;
        State._neuralFallbackToastShown = true;
        UI.toast(t('toast.neuralFallback'), 'warn', 6000);
      });
    }
  }

  /**
   * Fetch the quantised model the neural stage needs, once, showing the
   * download in the same progress row a render uses — the "first start"
   * story in one function: nothing installed, one switch, weights in OPFS
   * from then on.
   *
   * Runs from the toggle's own change handler, so the user's gesture is what
   * starts the network access. Every outcome is a toast and a status line;
   * the toggle never ends up on with a model that is not really there.
   * @returns {Promise<void>} resolves when the attempt is over, successfully
   *   or not.
   */
  async function loadNeuralModel() {
    const toggle = $('#neuralToggle');
    if (!Neural || typeof Neural.ensureModel !== 'function' || State._neuralLoading) return;
    State._neuralLoading = true;
    if (toggle) { toggle.disabled = true; toggle.checked = false; }
    setNeuralStatus('ctl.neuralDownloading');
    const label = t('ctl.neuralDownloading');
    UI.modelLoader.update({ ratio: 0, text: label });
    let res;
    try {
      res = await Neural.ensureModel('deepfilternet3', {});
    } catch (err) {
      res = { ready: false, reason: String((err && err.message) || err) };
    }
    State._neuralLoading = false;
    if (!res || !res.ready) {
      UI.modelLoader.fail(t('ctl.neuralUnavailable'));
      UI.toast(t('toast.neuralDownloadFailed'), 'warn', 6000);
      if (toggle) toggle.disabled = !State.neuralDownloadable;
      setNeuralStatus('ctl.neuralUnavailable');
      return;
    }
    UI.modelLoader.done(t('ctl.neuralDownloaded'));
    UI.toast(t('toast.neuralDownloaded', { size: ((res.bytes || 0) / 1e6).toFixed(1) }), 'ok', 5000);
    await initNeural();                       // re-probe: the weights are now there
    const again = $('#neuralToggle');
    if (again && !again.disabled) {
      again.checked = true;
      State.neuralEnabled = true;
      markAllStale();
    }
  }

  /**
   * A fresh, collision-free OPFS scratch key for this card's next render. The
   * counter is kept on the card so a re-render never collides with the file the
   * previous render left behind (which is still being downloaded, or is still
   * the previous result).
   * @param {RSApp.Card} card - the card to mint a key for.
   * @returns {string} e.g. `'render-7-2'`.
   */
  function renderKeyFor(card) {
    card._renderSeq = (card._renderSeq || 0) + 1;
    return 'render-' + card.id + '-' + card._renderSeq;
  }

  /**
   * Drop a card's previous rendered file from OPFS before replacing it, so a
   * batch of re-renders cannot fill the scratch directory with superseded
   * takes. Best effort: a failed delete never fails the render.
   * @param {RSApp.Card} card - the card whose result to release.
   * @returns {Promise<void>}
   */
  async function forgetRender(card) {
    if (!OPFS || !card.result || !card.result.opfsKey) return;
    await OPFS.remove(card.result.opfsKey);
  }

  /**
   * The moment a card is big enough to matter, copy its raw upload into OPFS
   * scratch storage (bounded-chunk reads — see `RSOPFS.streamFileIntoScratch`)
   * and rebind `card.file` to the disk-backed copy, so every later
   * `Codecs.decodeFile(card.file)` call (there are two: the preview decode in
   * `prepareCard()` and the export decode in `renderCard()`) reads from a
   * `File` OPFS itself is holding, not an in-memory `Blob` the picker handed
   * over. `decodeAudioData` itself still needs one whole `ArrayBuffer` at the
   * moment it actually decodes — this does not change that, it only removes
   * the *second*, redundant whole-file copy the original upload Blob would
   * otherwise keep pinned in the heap for as long as the card exists.
   * @param {RSApp.Card} card - the card whose upload to copy.
   * @returns {Promise<void>} resolves even on failure — the card then simply
   *   keeps its original, in-memory `File`.
   */
  async function streamUploadToOPFS(card) {
    if (!OPFS || !State.opfsReady) return;
    if (!card.file || (card.file.size || 0) < CONFIG.opfsUploadThresholdBytes) return;
    try {
      const key = 'upload-' + card.id;
      const res = await OPFS.streamFileIntoScratch(card.file, key, {});
      if (res.streamed) {
        card.file = res.file;
        card._uploadOpfsKey = key;
      }
    } catch (e) {
      // best effort — the card simply keeps its original, in-memory File
    }
  }

  /**
   * Drop a card's streamed-to-OPFS upload copy, if it has one — called when
   * the card is removed or the list is cleared, so scratch storage does not
   * outlive the files it was holding.
   * @param {RSApp.Card} card - the card whose upload to release.
   * @returns {Promise<void>}
   */
  async function forgetUpload(card) {
    if (!OPFS || !card._uploadOpfsKey) return;
    await OPFS.remove(card._uploadOpfsKey);
    card._uploadOpfsKey = null;
  }

  /* ------------------------------------------------------------- formatting */

  /**
   * The per-card parameter accessors: every question about "which profile,
   * which power, which parameters, which signature" is answered here and
   * nowhere else, so the monitor, the render and the export cache cannot
   * disagree about what a card is currently set to.
   * @typedef {Object} ParamAccessors
   * @property {function(RSApp.Card): string} resolvedPreset - the profile id
   *   actually in effect: the card's override, else the global one, else (for
   *   `'auto'`) what the analysis detected.
   * @property {function(RSApp.Card): number} power - 0…1: the card's override
   *   or the global slider.
   * @property {function(RSApp.Card): ?RSPresets.ParamMap} params - the built
   *   parameter map, or `null` before the file was measured. A lossy export
   *   pays the encoder's own overshoot out of the true-peak ceiling here, so
   *   the promise is about the file the user keeps; the monitor builds its
   *   parameters here too, which is what keeps "what you hear" and "what you
   *   save" the same file.
   * @property {function(RSApp.Card): string} signature - the settings as one
   *   string (`profile|power|format|depth-or-bitrate`), used to decide whether
   *   a cached render is still valid.
   * @property {function(RSApp.Card): number} exportRate - the sample rate the
   *   export will really use: the MP3 encoder's nearest legal rate for MP3, the
   *   file's own rate (clamped to 8…96 kHz) for WAV.
   */

  /** @type {ParamAccessors} */
  const P = {
    resolvedPreset(card) {
      const wanted = card.preset || State.preset;
      if (wanted !== 'auto') return wanted;
      if (card.analysis && card.analysis.preset) return card.analysis.preset;
      return 'auto';
    },
    power(card) {
      return card.power === null || card.power === undefined ? State.power : card.power;
    },
    params(card) {
      const resolved = P.resolvedPreset(card);
      const metrics = (card.analysis && card.analysis.metrics) || null;
      const power = P.power(card);
      if (!metrics) return null;
      const params = Presets.buildParams(resolved, metrics, power);
      params.bypass = 0;                       // A/B is handled separately
      params.autoLevel = 1;
      /* A lossy export pays the encoder's own overshoot out of the ceiling: the
       * promise is about the file the user keeps, not about the render (measured
       * through this path — the 128 kbit/s export of a dense master came back
       * 2.0 dB over its ceiling and was named `truePeak` on its own re-upload,
       * tools/work/tp2.js). The monitor builds its parameters here too, so what
       * you hear is still what you save, at every format and bitrate; a ceiling
       * that was switched off (0) stays off. */
      if (params.tpCeil < 0) params.tpCeil -= Presets.codecMargin(State.format, State.mp3Rate);
      if (State.format === 'mp3') params.tpCeil = Math.min(-1.5, params.tpCeil);
      /* Stage 0 re-measures its actual output inside engine.js and scales the
       * DSP de-hisser from the measured SNR improvement. Keep the full dose
       * here so a missing/failed neural stage retains the complete DSP repair. */
      return params;
    },
    signature(card) {
      const fmt = State.format;
      // the neural routing is part of "the same settings": a cached render made
      // with Stage 0 on is not the file the user would get with it off, and
      // Magic Fix turning it on has to invalidate the old result
      const neural = (State.aiDenoise ? 'ai' : '-') + (State.neuralEnabled ? ':' : '') + (State.neuralEnabled ? 'air' : '');
      return [P.resolvedPreset(card), P.power(card).toFixed(3), fmt,
        fmt === 'mp3' ? State.mp3Rate : State.wavDepth, neural].join('|');
    },
    exportRate(card) {
      const sr = (card.analysis && card.analysis.sampleRate) || 44100;
      if (State.format === 'mp3') return Codecs.mp3RateFor(sr);
      return Math.max(8000, Math.min(96000, Math.round(sr)));
    },
  };

  /* ------------------------------------------------------------------ helpers */

  /**
   * Whether a dropped file is worth trying: either the browser already knows
   * it is audio, or its extension is one of the containers this project has
   * seen decode (including the ones a browser usually refuses, which is what
   * the FFmpeg rescue path is for).
   * @param {File} file - the dropped file.
   * @returns {boolean} `true` when it should be added to the list.
   */
  function isAudioFile(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf('audio') === 0) return true;
    return /\.(mp3|wav|wave|flac|ogg|oga|opus|m4a|mp4|aac|aif|aiff|webm|weba|wma|alac)$/i.test(file.name || '');
  }

  /**
   * Move a card to a status and repaint its pill, icon and action buttons.
   * The status is the card's own state machine (`idle`, `analyzing`,
   * `ready`, `rendering`, `done`, `error`); everything the user sees about
   * where the file is comes from here and nowhere else.
   * @param {RSApp.Card} card - the card to update.
   * @param {string} status - the new status id.
   * @param {?string} [note] - an optional note shown under the card.
   * @returns {void}
   */
  function setStatus(card, status, note) {
    card.status = status;
    const pill = card.el.pill;
    if (pill) {
      const key = 'status.' + status;
      const label = t(key);
      if (label !== key && status !== 'rendering') { pill.textContent = label; pill.hidden = false; }
      else if (status === 'rendering') { pill.textContent = t('status.processing'); pill.hidden = false; }
      pill.className = 'pill' + (status === 'done' || status === 'ready' ? ' is-ok'
        : status === 'error' ? ' is-bad' : ' is-busy');
    }
    if (note !== undefined) setNote(card, note);
    if (card.el.card) card.el.card.classList.toggle('is-ready', status === 'ready' || status === 'done');
  }

  /**
   * Show or clear a card's note line, painting errors differently from
   * ordinary progress notes.
   * @param {RSApp.Card} card - the card whose note to set.
   * @param {string} text - the message; an empty value hides the line.
   * @param {boolean} [isError] - `true` for the error styling.
   * @returns {void}
   */
  function setNote(card, text, isError) {
    const n = card.el.note;
    if (!n) return;
    if (!text) { n.hidden = true; n.textContent = ''; return; }
    n.hidden = false;
    n.textContent = text;
    n.classList.toggle('is-error', !!isError);
  }

  /* ---------------------------------------------------------------- progress */

  /**
   * A monotonic millisecond clock: `performance.now()` where it exists, the
   * epoch clock otherwise. Used only for the time-left estimates, so the
   * fallback's coarser resolution is harmless.
   * @returns {number} milliseconds.
   */
  const nowMs = () => (global.performance && global.performance.now ? global.performance.now() : Date.now());

  /**
   * The stage words the two progress bars may show, one function per stage key
   * so each string is looked up when it is needed rather than at load. Every
   * entry is referenced literally on purpose: the translation audit reads these
   * keys out of the source and checks that both languages define them, which is
   * why they are written out rather than assembled from a prefix.
   * @type {Object<string, function(): string>}
   */
  const STAGE_TEXT = {
    wait: () => t('work.wait'),
    decode: () => t('work.decode'),
    // `measure` is the analyzer's word for the measurement slice, `analyze` the
    // card's word for "the analysis has started" — the user sees one stage.
    measure: () => t('work.analyze'),
    analyze: () => t('work.analyze'),
    diagnose: () => t('work.diagnose'),
    window: () => t('work.window'),
    envelope: () => t('work.envelope'),
    preview: () => t('work.preview'),
    render: () => t('work.render'),
    encode: () => t('work.encode'),
    zip: () => t('work.zip'),
  };
  /**
   * The translated word for a stage key — an unknown key (an older render's
   * report, a stage added elsewhere) falls back to the neutral "working"
   * wording instead of showing a raw key.
   * @param {string} stage - a key of the stage table above.
   * @returns {string} the translated stage name.
   */
  const stageText = (stage) => (STAGE_TEXT[stage] ? STAGE_TEXT[stage]() : t('work.wait'));

  /**
   * A deliberately coarse "about this much is left" phrase — seconds under
   * 90, whole minutes above, and nothing at all rather than a fake-precise
   * number when no estimate exists.
   * @param {number} seconds - estimated seconds remaining.
   * @returns {string} the translated phrase, or `''`.
   */
  function timeLeftText(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 90) return t('work.eta', { s: Math.max(1, Math.round(seconds)) });
    return t('work.etaMin', { m: Math.max(2, Math.round(seconds / 60)) });
  }

  /**
   * Seconds left for one card at its own rate, from the progress it has made
   * since the step started. Linear on purpose: a curve fitted to earlier steps
   * would be inventing precision the measurement does not have.
   * @param {RSApp.Card} card - the card being worked on.
   * @param {number} p - its progress, 0…1.
   * @returns {number} seconds remaining, or `0` when it cannot be estimated
   *   yet (no start time, no progress, or already finished).
   */
  function estimateLeft(card, p) {
    const t0 = card && card._workT0;
    if (!t0 || !p || p >= 1) return 0;
    const elapsed = (nowMs() - t0) / 1000;
    const left = (elapsed * (1 - p)) / p;
    return left > 1 && left < 3 * 3600 ? left : 0;
  }

  /** Give the browser one frame to paint — before a long, blocking step starts. */
  const nextPaint = () => new Promise((resolve) => {
    const raf = global.requestAnimationFrame || ((fn) => global.setTimeout(fn, 16));
    raf(() => resolve());
  });

  /**
   *
   * Paint one card's progress. `p === null` means "running, but not measurable"
   * (decoding a file happens inside the browser's decodeAudioData) — the bar
   * then animates instead of inventing a percentage.
   *
   * @param {RSApp.Card} card - the card to repaint.
   * @param {?string} stage - the stage id, or `null` to take the card
   * out of its busy state.
   * @param {?number} p - progress 0…1, or `null` when the step cannot be
   * measured.
   * @param {number} [etaSeconds] - seconds left, shown when it is honest.
   * @returns {void}
   */
  function setCardWork(card, stage, p, etaSeconds) {
    card.progress = p == null ? 0 : Math.max(0, Math.min(1, p));
    card._pendingWork = [stage, p, etaSeconds];
    if (!stage) { card._pendingWork = null; paintCardWork(card, stage, p, etaSeconds); return; }
    if (card._workPaintPending) return;
    card._workPaintPending = true;
    const raf = global.requestAnimationFrame || (fn => global.setTimeout(fn, 16));
    raf(() => {
      card._workPaintPending = false;
      const pending = card._pendingWork; card._pendingWork = null;
      if (pending) paintCardWork(card, ...pending);
    });
  }

  /** Paint the latest coalesced per-card progress at a frame boundary.
   * @param {RSApp.Card} card - card being painted.
   * @param {?string} stage - active stage or null.
   * @param {?number} p - progress or unknown.
   * @param {number} etaSeconds - estimated remaining time.
   * @returns {void}
   */
  function paintCardWork(card, stage, p, etaSeconds) {
    const el = card.el;
    const busy = !!stage;
    const known = p !== null && p !== undefined;
    card.progress = known ? Math.max(0, Math.min(1, p)) : 0;
    if (!busy) card._workT0 = 0;
    else if (!card._workT0) card._workT0 = nowMs();
    if (el.work) {
      el.work.hidden = !busy;
      el.work.classList.toggle('is-indeterminate', busy && !known);
      if (busy) {
        const pct = known ? Math.round(card.progress * 100) : null;
        el.stage.textContent = stageText(stage);
        el.pct.textContent = pct === null ? '' : t('ui.percent', { v: pct });
        el.bar.style.width = (pct === null ? 0 : pct) + '%';
        el.bar.classList.toggle('is-error', card.status === 'error');
        if (el.track) el.track.setAttribute('aria-valuenow', String(pct === null ? 0 : pct));
        el.eta.textContent = etaSeconds ? timeLeftText(etaSeconds) : '';
      }
    }
    // the status pill keeps the short state word — with the percentage while a
    // file is being written, because that is the number people watch
    if (busy && card.status === 'processing' && known && card.el.pill) {
      card.el.pill.textContent = t('status.rendering', { p: Math.round(card.progress * 100) });
      card.el.pill.hidden = false;
    }
    // …and the job bar follows the card that is currently in the queue
    if (State.job && State.job.card === card) {
      if (busy && !known) Job.unknown(stage);
      else Job.at(card.progress, stage);
    }
  }

  /**
   * Take a card out of its busy state — the shorthand for "this card is
   * not working on anything any more".
   * @param {RSApp.Card} card - the card to clear.
   * @returns {void}
   */
  const clearCardWork = (card) => setCardWork(card, null, card.status === 'processing' ? 1 : 0, 0);

  /**
   * Keep the screen awake while a long job runs: a phone that dims the display
   * can suspend the tab and stall the queue mid-file. Best effort — the API is
   * optional and the work still finishes if it is missing.
   */
  const Wake = {
    lock: null,
    async request() {
      if (this.lock) return;
      const wl = global.navigator && global.navigator.wakeLock;
      if (!wl || !wl.request) return;
      try { this.lock = await wl.request('screen'); } catch (e) { this.lock = null; }
    },
    async release() {
      const lock = this.lock;
      this.lock = null;
      if (!lock) return;
      try { await lock.release(); } catch (e) { /* already gone */ }
    },
  };

  /**
   * The job bar: one honest line for "what is running, how far, how long".
   * A queue of files reports per file; a ZIP reports as a whole.
   * @typedef {Object} JobController
   * @property {function(number, RSApp.Card=): void} start - begin a job of
   *   `total` files; takes the wake lock and paints the bar.
   * @property {function(number, string, RSApp.Card=): void} file - move to a
   *   file, resetting the progress to zero.
   * @property {function(number, string=): void} at - report real progress and
   *   (optionally) the stage it belongs to.
   * @property {function(string=): void} unknown - the current step cannot be
   *   counted; the bar sweeps instead of sitting frozen.
   * @property {function(): void} end - clear the job and release the wake lock.
   */

  /** @type {JobController} */
  const Job = {
    start(total, card) {
      document.body.classList.add('is-working');
      State.job = {
        total: Math.max(1, total), index: 0, name: (card && card.name) || '',
        card: card || null, stage: 'wait', p: 0, t0: nowMs(), indeterminate: false,
      };
      Wake.request();
      paintJob();
    },
    file(index, name, card) {
      if (!State.job) return;
      State.job.index = Math.max(0, index);
      State.job.name = name || '';
      if (card !== undefined) State.job.card = card;
      State.job.p = 0;
      State.job.indeterminate = false;
      paintJob();
    },
    at(p, stage) {
      if (!State.job) return;
      State.job.indeterminate = false;
      State.job.p = Math.max(0, Math.min(1, p || 0));
      if (stage) State.job.stage = stage;
      paintJob();
    },
    /**
     *
     * The step that is running cannot be counted (the browser's own decode, a
     * ZIP write) — the bar sweeps instead of sitting frozen at the last number.
     * The percentage keeps showing the last thing we could actually measure.
     *
     * @param {string} [stage] - the stage to show while the bar sweeps.
     * @returns {void}
     */
    unknown(stage) {
      if (!State.job) return;
      State.job.indeterminate = true;
      if (stage) State.job.stage = stage;
      paintJob();
    },
    end() {
      document.body.classList.remove('is-working');
      State.job = null;
      const wrap = $('#globalProgress');
      if (wrap) wrap.hidden = true;
      Wake.release();
    },
  };

  /**
   * Repaint the job bar from `State.job`: the file it is on, the stage word,
   * the percentage and the coarse time left. A finished or absent job hides the
   * bar entirely — an empty progress bar that never goes away is worse than no
   * bar at all.
   * @returns {void}
   */
  function paintJob() {
    const job = State.job;
    const wrap = $('#globalProgress');
    if (!wrap || !job) return;
    wrap.hidden = false;
    const overall = Math.max(0, Math.min(1, (job.index + job.p) / job.total));
    const pct = Math.round(overall * 100);
    const fill = $('#globalProgressFill');
    const label = $('#globalProgressText');
    const pctOut = $('#globalProgressPct');
    const track = $('#globalProgressTrack');
    wrap.classList.toggle('is-indeterminate', !!job.indeterminate);
    // an animated fill has no width of its own — the stylesheet sweeps it
    if (fill) fill.style.width = job.indeterminate ? '' : pct + '%';
    if (pctOut) pctOut.textContent = t('ui.percent', { v: pct });
    if (track) track.setAttribute('aria-valuenow', String(pct));
    // one line that answers "which file" first, then "what is it doing": a queue
    // names the file it is on, a single save names that file, and the batch-wide
    // steps (packing the ZIP) only have the stage to show.
    let text;
    if (job.total > 1) {
      text = t('job.file', { i: Math.min(job.index + 1, job.total), n: job.total, name: job.name || '…' })
        + ' · ' + stageText(job.stage);
    } else if (job.name) {
      text = job.name + ' · ' + stageText(job.stage);
    } else {
      text = stageText(job.stage);
    }
    const left = estimateJobLeft(job, overall);
    if (left) text += ' · ' + timeLeftText(left);
    if (label) { label.textContent = text; label.title = text; }
  }

  /**
   * Estimate the seconds left of a whole batch from the time it has taken
   * so far and the fraction it has finished. Deliberately conservative: an
   * estimate that is not between 1.5 s and an hour is suppressed rather than
   * shown, because a wrong countdown is worse than none.
   * @param {RSApp.JobState} job - the running job (its `t0` is the start).
   * @param {number} overall - fraction of the batch finished, 0…1.
   * @returns {number} seconds remaining, or `0` when no honest estimate is
   *   possible.
   */
  function estimateJobLeft(job, overall) {
    if (!overall || overall <= 0.02) return 0;
    const elapsed = (nowMs() - job.t0) / 1000;
    const left = (elapsed * (1 - overall)) / overall;
    return left > 1.5 && left < 3 * 3600 ? left : 0;
  }

  if (global.document) {
    global.document.addEventListener('visibilitychange', () => {
      // coming back to a running job: re-acquire what the browser dropped
      if (!global.document.hidden && (State.job || State.busy)) Wake.request();
    });
  }

  /**
   * Sum the size of every finished render in a list — what the ZIP button
   * shows before the archive is built, and what the memory guard's caller
   * consults before starting a streamed pack.
   * @param {RSApp.Card[]} list - the cards to total up.
   * @returns {number} bytes across the list; cards without a result count
   *   as zero.
   */
  function totalBytesOf(list) {
    let bytes = 0;
    for (const c of list) {
      if (!c.result) continue;
      bytes += c.result.bytes ? c.result.bytes.length : (c.result.size || 0);
    }
    return bytes;
  }

  /* ------------------------------------------------------------ card building */

  /**
   * Build a card for a freshly picked file: clone the template, wire every
   * control inside it, fill the preset options and set the initial status. The
   * returned object is the card's in-memory state (see the `Card` typedef) and
   * is what every later step takes as its first argument.
   * @param {File} file - the file the card stands for.
   * @returns {RSApp.Card} the new card, already inserted-independent (the
   *   caller appends its `el.card` to the list).
   */
  function createCard(file) {
    const tpl = $('#cardTpl');
    const node = tpl.content.firstElementChild.cloneNode(true);
    const card = {
      id: State.seq++,
      file,
      name: file.name || 'audio',
      size: file.size || 0,
      status: 'queued',
      power: null,
      preset: null,
      loop: false,
      analysis: null,
      after: null,
      previewBuffer: null,
      previewBufferNeural: null,
      previewStage0: null,
      result: null,
      progress: 0,
      error: null,
      el: {
        card: node,
        name: $('[data-slot="name"]', node),
        meta: $('[data-slot="meta"]', node),
        pill: $('[data-slot="status"]', node),
        diagnosis: $('[data-slot="diagnosis"]', node),
        chips: $('[data-slot="chips"]', node),
        analysis: $('[data-slot="analysis"]', node),
        analysisCount: $('[data-slot="analysisCount"]', node),
        analysisLead: $('[data-slot="analysisLead"]', node),
        findings: $('[data-slot="findings"]', node),
        canvas: $('[data-slot="wave"]', node),
        waveEmpty: $('[data-slot="waveEmpty"]', node),
        window: $('[data-slot="window"]', node),
        seek: $('[data-slot="seek"]', node),
        time: $('[data-slot="time"]', node),
        grid: $('.card-grid', node),
        inspect: $('[data-act="inspect"]', node),
        preset: $('[data-slot="preset"]', node),
        power: $('[data-act="power"]', node),
        powerOut: $('[data-slot="power"]', node),
        work: $('[data-slot="work"]', node),
        stage: $('[data-slot="stage"]', node),
        eta: $('[data-slot="eta"]', node),
        pct: $('[data-slot="pct"]', node),
        track: $('[data-slot="track"]', node),
        bar: $('[data-slot="bar"]', node),
        note: $('[data-slot="note"]', node),
      },
    };

    card.el.name.textContent = card.name;
    card.el.name.title = card.name;
    card.el.meta.textContent = Codecs.formatBytes(card.size, global.RSi18n.lang);

    // preset choices inside the card (short labels)
    const short = { auto: 'preset.auto.short', garage: 'preset.garage', vinyl: 'preset.vinyl', cassette: 'preset.cassette', lowbitrate: 'preset.lowbitrate', general: 'preset.general' };
    for (const id of Presets.PRESET_ORDER) {
      card.el.preset.appendChild(UI.el('option', { value: id, text: t(short[id] || 'preset.general') }));
    }
    card.el.preset.value = 'auto';
    card.el.power.value = Math.round(State.power * 100);
    UI.paintRange(card.el.power);
    card.el.powerOut.textContent = t('ui.percent', { v: Math.round(State.power * 100) });

    card.wave = new UI.Waveform(card.el.canvas, {
      /**
       * A click or drag on the waveform: make sure this card is the one being
       * monitored, then jump the transport there.
       * @param {number} sec - the position in seconds inside the preview window.
       * @returns {Promise<void>}
       */
      onSeek: async (sec) => {
        await ensurePlaying(card);
        Engine.seek(sec);
      },
    });

    const playBtn = $('[data-act="play"]', node);
    if (playBtn) playBtn.setAttribute('aria-label', t('card.play'));
    wireCard(card);
    setStatus(card, 'queued');
    clearCardWork(card);
    refreshCardText(card);
    return card;
  }

  /**
   * Re-translate every word on one card — after a language switch, and after a
   * change that alters what the card says about itself (a new status, a new
   * export format).
   * @param {RSApp.Card} card - the card to repaint.
   * @returns {void}
   */
  function refreshCardText(card) {
    const a = card.analysis;
    if (!a) { setNote(card, t('note.decode')); return; }
    if (State._inspectorCard === card) {
      const sub = $('#cardSheetSub');
      if (sub) sub.textContent = t('meta.line', {
        dur: Codecs.formatDuration(a.duration),
        ch: a.channels > 1 ? 'Stereo' : 'Mono',
        sr: Codecs.formatRate(a.sampleRate, global.RSi18n.lang),
        size: Codecs.formatBytes(card.size, global.RSi18n.lang),
      });
    }
    card.el.meta.textContent = t('meta.line', {
      dur: Codecs.formatDuration(a.duration),
      ch: a.channels > 1 ? 'Stereo' : 'Mono',
      sr: Codecs.formatRate(a.sampleRate, global.RSi18n.lang),
      size: Codecs.formatBytes(card.size, global.RSi18n.lang),
    });
    card.el.diagnosis.innerHTML = UI.diagnosisText(a.diag);
    const chips = UI.chipsFrom(card.analysis.chips, card.after ? card.after.chips : null);
    card.el.chips.textContent = '';
    for (const c of chips) card.el.chips.appendChild(c);
    refreshAnalysis(card);
    if (card.analysis.window) {
      card.el.window.textContent = t('card.window', {
        a: Math.round(card.analysis.window.start),
        b: Math.round(card.analysis.window.end),
      });
    }
    const fmtLabel = State.format === 'mp3' ? 'MP3' : 'WAV';
    if (card.status === 'ready') setNote(card, t('note.realtime'));
    if (card.status === 'done') setNote(card, t('note.done', { fmt: fmtLabel }));
    // the restored half of the waveform, when we have it
    const data = {
      before: card.analysis.windowEnvelope,
      after: card.after ? card.after.envelope : null,
      duration: card.analysis.window ? card.analysis.window.seconds : card.analysis.duration,
    };
    card.wave.setData(data);
  }

  /**
   * The detailed analysis panel: every finding, the number it was measured at,
   * and the dose the file will really get — recomputed whenever the parameters
   * change, because the doses are what it shows.
   */
  /**
   * Render the analysis half of a card: score, diagnosis sentence, chips,
   * findings list, the A/B canvas and the preview window's own numbers. Called
   * as soon as an analysis exists and again whenever the re-measured "after"
   * side arrives.
   * @param {RSApp.Card} card - the card to paint.
   * @returns {void}
   */
  function refreshAnalysis(card) {
    const box = card.el && card.el.analysis;
    if (!box) return;
    const a = card.analysis;
    if (!a || !a.metrics) { box.hidden = true; return; }
    const params = P.params(card);
    const r = Presets.recipe(a.metrics, params, P.power(card));
    card.recipe = r;
    box.hidden = false;
    card.el.analysisCount.textContent = r.headline.count === 1
      ? t('card.findOne')
      : t('card.findMany', { n: r.headline.count });
    card.el.analysisLead.textContent = t('card.analysisLead', {
      char: t('char.' + r.character),
      severe: r.headline.severe,
    });
    card.el.findings.textContent = '';
    card.el.findings.appendChild(UI.findingsList(r, global.RSi18n.lang));
  }

  /* ---------------------------------------------------------- card inspector */

  /**
   * Open the phone's bottom sheet with this card's per-file controls in it.
   *
   * On a phone the card itself stops carrying the grid: `.card-grid` is moved
   * into the sheet, where CSS lays it out as one vertical column — profile,
   * power, the A/B pair and the save buttons, in that order, full width. The
   * node is *moved*, not copied, so the slider keeps its listener and the A/B
   * buttons keep their `is-active` state, and `closeInspector()` puts it back
   * at the exact position it came from.
   *
   * On a desktop this is a deliberate no-op: the card already shows every
   * control, and a drawer over a 1440 px layout would be a regression dressed
   * up as a feature.
   * @param {RSApp.Card} card - the card to inspect.
   * @returns {boolean} `true` when the sheet really opened.
   */
  function openInspector(card) {
    if (!card || !card.el || !card.el.grid) return false;
    if (!UI.sheet || typeof UI.sheet.open !== 'function') return false;
    if (!UI.sheet.isSmallViewport()) return false;
    // a second card's inspector replaces the first one's, never stacks
    if (State._inspectorCard && State._inspectorCard !== card) closeInspector();
    const opened = UI.sheet.open({
      title: card.name,
      subtitle: card.el.meta ? card.el.meta.textContent : '',
      body: card.el.grid,
      onClose: () => {
        card.el.card.classList.remove('is-inspected');
        card.isInspected = false;
        if (State._inspectorCard === card) State._inspectorCard = null;
      },
    });
    if (!opened) return false;
    State._inspectorCard = card;
    card.isInspected = true;
    card.el.card.classList.add('is-inspected');
    vibrate(8, card.el.inspect || card.el.card);
    return true;
  }

  /**
   * Close whichever card's controls the sheet is holding, if any. Safe to call
   * when nothing is open — the card queue calls it on every removal.
   * @returns {void}
   */
  function closeInspector() {
    if (UI.sheet && typeof UI.sheet.close === 'function') UI.sheet.close();
    State._inspectorCard = null;
  }

  /* -------------------------------------------------------------- card wiring */

  /**
   * Bind every interaction inside one card: remove, play, loop, the per-card
   * profile selector, the A/B buttons, download and retry, plus the local
   * power slider. Handlers are attached to the card's own subtree, which is why
   * a card created later needs no global listener table.
   * @param {RSApp.Card} card - the card to wire (its DOM handles must exist).
   * @returns {void}
   */
  function wireCard(card) {
    const node = card.el.card;

    $('[data-act="remove"]', node).addEventListener('click', () => removeCard(card));

    // The card's own drawer affordance. It is a real button, so it is reachable
    // by keyboard and announced by a screen reader — the whole-card tap below
    // is a convenience on top of it, never the only way in.
    if (card.el.inspect) {
      card.el.inspect.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openInspector(card);
      });
    }

    // A tap anywhere on the card that is not itself a control opens the
    // inspector. Restricting it to the card's own chrome is what keeps the
    // gesture from stealing a slider drag, a seek, a play button or a link.
    node.addEventListener('click', (ev) => {
      if (!UI.sheet || !UI.sheet.isSmallViewport()) return;
      if (UI.sheet.isOpen()) return;
      const t = ev.target;
      if (t && t.closest && t.closest('button, a, input, select, textarea, label, canvas, summary, details, .seek, .player, .chip')) return;
      openInspector(card);
    });

    $('[data-act="play"]', node).addEventListener('click', () => {
      if (State.current === card && Engine.playing) Engine.pause();
      else ensurePlaying(card);
    });

    $('[data-act="loop"]', node).addEventListener('click', (ev) => {
      card.loop = !card.loop;
      ev.currentTarget.classList.toggle('is-active', card.loop);
      if (State.current === card) Engine.setLoop(card.loop);
    });

    $('[data-act="preset"]', node).addEventListener('change', (ev) => {
      card.preset = ev.target.value;
      onCardParamsChanged(card);
    });

    const power = card.el.power;
    power.addEventListener('input', () => {
      card.power = Number(power.value) / 100;
      card.el.powerOut.textContent = t('ui.percent', { v: power.value });
      UI.paintRange(power);
      onCardParamsChanged(card, true);
    });
    power.addEventListener('change', () => onCardParamsChanged(card, false, true));

    $$('[data-act="ab"] button', node).forEach((btn) => {
      btn.addEventListener('click', () => {
        setAB(btn.getAttribute('data-ab'));
        if (State.current !== card) ensurePlaying(card);
      });
    });

    $('[data-act="download"]', node).addEventListener('click', () => saveCard(card));
    $('[data-act="retry"]', node).addEventListener('click', () => prepareCard(card, true));

    const seek = $('[data-act="seek"]', node);
    /**
     * The seek strip's drag handler: turn a pointer position into a fraction
     * of the bar and move the transport there, staying inside the preview
     * window.
     * @param {PointerEvent} ev - the pointer event to locate.
     * @returns {Promise<void>}
     */
    const scrub = async (ev) => {
      if (!card.analysis) return;
      const r = seek.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      await ensurePlaying(card);
      Engine.seek(f * card.analysis.window.seconds);
    };
    seek.addEventListener('pointerdown', (ev) => { seek.setPointerCapture(ev.pointerId); scrub(ev); });
    seek.addEventListener('pointermove', (ev) => { if (ev.buttons) scrub(ev); });
    seek.addEventListener('keydown', async (ev) => {
      if (!card.analysis) return;
      const step = 2;
      if (ev.key === 'ArrowRight') { ev.preventDefault(); await ensurePlaying(card); Engine.seek(Engine.position + step); }
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); await ensurePlaying(card); Engine.seek(Math.max(0, Engine.position - step)); }
    });
  }

  /**
   * Called whenever the per-file preset or power changes: the cached render
   * is marked stale, the card is repainted and — unless the slider is still
   * being dragged — the preview is re-rendered through the debounce.
   * @param {RSApp.Card} card - the card whose settings changed.
   * @param {boolean} live - `true` while a slider is still moving.
   * @param {boolean} final - `true` for the last value of a gesture.
   * @returns {void}
   */
  function onCardParamsChanged(card, live, final) {
    if (!card.analysis) return;
    if (State.current === card) applyLiveParams(card);
    if (live) {
      clearTimeout(card._previewTimer);
      card._previewTimer = setTimeout(() => refreshPreview(card), 420);
    } else if (final !== false) {
      refreshPreview(card);
    }
    if (card.result && card.result.signature !== P.signature(card)) {
      card.result.stale = true;
      if (card.status === 'done') setStatus(card, 'ready');
    }
  }

  /**
   * Re-render only the preview window so the waveform and the A/B monitor
   * match the sliders — the full-length render is untouched, and the
   * compare position is preserved across the new buffer.
   * @param {RSApp.Card} card - the card to preview.
   * @returns {Promise<void>} resolves once the card's preview is current.
   */
  async function refreshPreview(card) {
    if (!card.analysis || !card.analysisWindowChannels) return;
    const params = P.params(card);
    if (!params) return;
    try {
      // even a 40 s window takes a moment on a phone: say what is happening
      const slow = card.analysis.duration > 180;
      if (slow) { card._workT0 = nowMs(); setCardWork(card, 'preview', 0); }
      const res = await Engine.render(card.analysisWindowChannels, card.analysis.sampleRate, params, {
        progressSteps: slow ? 12 : 0,
        onProgress: slow ? (p) => setCardWork(card, 'preview', p, estimateLeft(card, p)) : undefined,
      });
      if (slow) clearCardWork(card);
      const env = await Analyzer.envelopeAsync(res.channels, card.analysis.windowEnvelope.max.length);
      card.after = { envelope: env, chips: (await Analyzer.analyzeChannelsAsync(res.channels, res.sampleRate)).chips };
      refreshCardText(card);
      await computeComparePreview(card, card.analysisWindowChannels, card.analysis.sampleRate, params);
    } catch (err) { /* preview refresh is best effort */ }
  }

  /**
   *
   * The compare FAB's third position — **C: the neural pre-process plus the
   * DSP chain** — needs an actual second render to play, not a knob flipped
   * live (both neural stages are far too slow for that). This renders it once
   * per analysis/preset/power change, through the same `stage0` option the
   * export uses, so C really is the file the user would save with the AI
   * denoiser armed — not an approximation of it.
   *
   * If Stage 0 is not armed (`State.aiDenoise` — Magic Fix throws that switch,
   * and only when DeepFilterNet3 is actually available) there is nothing for C
   * to be: it is left null and the FAB honestly offers Original/DSP only. The
   * same is true when the stage reports a fallback — a missing model is an
   * ordinary state, not a failure, and the position must not pretend
   * otherwise.
   *
   * @param {RSApp.Card} card - the card the preview belongs to.
   * @param {Float32Array[]} chans - the preview window's source channels.
   * @param {number} sampleRate - their sample rate in Hz.
   * @param {?RSPresets.ParamMap} params - the parameters to render with.
   * @returns {Promise<void>} resolves when `previewBufferNeural` is
   * either set or deliberately left `null` — never rejects.
   */
  async function computeComparePreview(card, chans, sampleRate, params) {
    const stage0 = stage0For();
    if (!(stage0 && Stage0Available() && params && chans)) { card.previewBufferNeural = null; return; }
    try {
      const res = await Engine.render(chans, sampleRate, params, {
        neural: neuralOptFor() || undefined,
        stage0,
      });
      card.previewBufferNeural = res.stage0 && res.stage0.applied
        ? Codecs.makeBuffer(res.channels, res.sampleRate)
        : null;
      card.previewStage0 = res.stage0 || null;
    } catch (e) { card.previewBufferNeural = null; }
    if (FAB && FAB.onPreviewChanged) FAB.onPreviewChanged(card);
  }

  /**
   * Whether the pre-DSP stage could run at all right now: a model with
   * weights, a runtime session, and a worker to talk to. Kept as one named
   * question so the Magic Fix, the export and the C position cannot answer
   * it differently.
   * @returns {boolean} `true` when Stage 0 is usable.
   */
  function Stage0Available() {
    return !!(State.neuralDenoise && State.neuralAvailable && global.RSNeural
      && typeof global.RSNeural.denoiseChannels === 'function');
  }

  /* ------------------------------------------------------------ live playback */

  /**
   * Push a card's current parameters into the running monitor. Only the card
   * being listened to is touched — a list full of cards must not retune the
   * graph the user is actually hearing.
   * @param {RSApp.Card} card - the card to apply.
   * @returns {void}
   */
  function applyLiveParams(card) {
    const params = P.params(card);
    if (!params) return;
    Engine.applyParams(params);
    Engine.setBypass(State.ab === 'original');
    Engine.setCompare(State.ab === 'compare');
  }

  /**
   * Make this card the one being monitored: hand its preview buffer to the
   * engine, apply its parameters, stop whatever else was playing and start this
   * one. Called from the play button, from a canvas seek and from the A/B
   * switch, which is why it has to be idempotent.
   * @param {RSApp.Card} card - the card to play.
   * @returns {Promise<void>} resolves once playback started, or immediately
   *   when the card has nothing to play yet.
   */
  async function ensurePlaying(card) {
    if (!card.previewBuffer) { UI.toast(t('toast.needDecode'), 'bad'); return; }
    try {
      await Engine.init();
      if (State.current !== card) {
        State.current = card;
        Engine.setBuffer(card.previewBuffer, { start: 0, end: card.previewBuffer.duration });
        Engine.setLoop(card.loop);
        applyLiveParams(card);
        markPlaying(null);
        FAB.syncFromAB();           // a new card starts on whatever the top A/B switch says
      }
      // Stop/setBuffer may still be suspending the previous monitor context.
      // Do not report readiness until play has serialized suspension/resume.
      await Engine.play();
      markPlaying(card);
    } catch (err) {
      UI.toast(err && err.message === 'worklet-load-failed' ? t('toast.workletFail') : t('toast.engineFail'), 'bad', 7000);
    }
  }

  /**
   * Mark exactly one card (or none) as the one playing, so the list always
   * shows which file the transport belongs to.
   * @param {?RSApp.Card} card - the card that is playing, `null` for none.
   * @returns {void}
   */
  function markPlaying(card) {
    for (const c of State.cards) {
      const on = c === card && Engine.playing;
      c.el.card.classList.toggle('is-playing', on);
      // a screen reader (and a phone's accessibility tree) should hear what the
      // button will do now, not what it did when the card was built
      const btn = $('[data-act="play"]', c.el.card);
      if (btn) btn.setAttribute('aria-label', t(on ? 'card.pause' : 'card.play'));
    }
  }

  /**
   * Switch the monitor between the original, the restoration and the automatic
   * A/B. `'compare'` is the honest mode: it flips the bypass every few seconds
   * so the ear cannot settle on either version. The choice is global (it applies
   * to whichever card is playing) and the segmented control repaints from it,
   * never the other way round.
   * @param {('original'|'restored'|'compare')} mode - the mode to set; anything
   *   unknown means `'restored'`, the version the user came for.
   * @returns {void}
   */
  function setAB(mode) {
    State.ab = mode === 'compare' ? 'compare' : mode === 'original' ? 'original' : 'restored';
    // undo whatever buffer the compare FAB might have swapped in for its 'ai'
    // position — the top switch only ever knows about the plain DSP render
    const card = State.current;
    if (card && card.previewBuffer && Engine.buffer !== card.previewBuffer) {
      Engine.switchBuffer(card.previewBuffer, Engine.bounds);
    }
    Engine.setCompare(State.ab === 'compare');
    Engine.setBypass(State.ab === 'original');
    $$('#abSwitch button').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-ab') === State.ab));
    for (const c of State.cards) {
      // the grid is the stable home of the per-file A/B buttons: on a phone it
      // may currently be living inside the inspector sheet, and a selector run
      // against the card would then find nothing to repaint
      $$('[data-act="ab"] button', c.el.grid || c.el.card).forEach((b) => {
        const on = State.ab !== 'compare' && b.getAttribute('data-ab') === State.ab;
        b.classList.toggle('is-active', on);
      });
    }
    FAB.syncFromAB();
  }

  /**
   * The live A/B/C compare FAB — a thumb-reach floating control that mirrors
   * the top A/B switch (so the two never disagree) and adds one thing the
   * top switch cannot: a third, AI-assisted position, plus a press-and-hold
   * gesture that jumps to the original for exactly as long as it is held and
   * returns to whatever was playing the instant it is released. It only ever
   * appears while something is actually playing; the auto-alternating "A/B"
   * self-compare mode hides it, since that already flips bypass on its own
   * timer and the two would otherwise fight over the same engine state.
   *
   * `mode` is always the *resting* position — a hold never changes it, it
   * only ever engages Original for as long as the thumb (or Enter/Space key)
   * stays down; `engaged()` is what is actually reaching the speakers right
   * now, which is what every repaint and every engine call go by.
   */
  const FAB = {
    mode: 'restored',          // 'original' | 'restored' | 'ai'
    holding: false,
    _holdT0: 0,
    _wasHold: false,
    el: null, btn: null, label: null,

    init() {
      this.el = $('#fabAB');
      this.btn = $('#fabABBtn');
      this.label = $('#fabABLabel');
      if (!this.el || !this.btn) return;
      this.btn.addEventListener('pointerdown', () => this.holdStart());
      this.btn.addEventListener('pointerup', () => this.holdEnd());
      this.btn.addEventListener('pointercancel', () => this.holdEnd());
      this.btn.addEventListener('pointerleave', () => { if (this.holding) this.holdEnd(); });
      this.btn.addEventListener('click', () => this.tap());
      this.btn.addEventListener('keydown', (ev) => {
        if ((ev.key === 'Enter' || ev.key === ' ') && !ev.repeat) { ev.preventDefault(); this.holdStart(); }
      });
      this.btn.addEventListener('keyup', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.holdEnd(); }
      });
      this.paint();
    },

    /**
     * Which resting positions this card can actually offer right now.
     * @returns {string[]} the resting positions, in the order a tap cycles
     *   through them.
     */
    availableModes() {
      const card = State.current;
      return (card && card.previewBufferNeural) ? ['restored', 'ai', 'original'] : ['restored', 'original'];
    },

    /** What is actually supposed to be reaching the speakers right now. */
    engaged() { return this.holding ? 'original' : this.mode; },

    tap() {
      if (this._wasHold) { this._wasHold = false; return; }     // a hold's release already fired the click
      const modes = this.availableModes();
      const i = modes.indexOf(this.mode);
      const next = modes[(i + 1) % modes.length];
      vibrate(8, this.btn);
      // 'original'/'restored' also exist on the top A/B switch — go through
      // setAB() so the two controls can never show something different
      if (next === 'ai') { this.mode = next; this.engage(); } else { setAB(next); }
    },

    holdStart() {
      if (this.holding || !State.current) return;
      this.holding = true;
      this._holdT0 = nowMs();
      vibrate(12, this.btn);
      this.engage();
    },

    holdEnd() {
      if (!this.holding) return;
      this.holding = false;
      // a quick tap-and-release should read as a tap, not a flash-to-original
      this._wasHold = (nowMs() - this._holdT0) > 220;
      this.engage();
    },

    /**
     * Push whatever `engaged()` currently resolves to into the live engine.
     * @returns {void}
     */
    engage() {
      const mode = this.engaged();
      const card = State.current;
      if (card && card.previewBuffer) {
        if (mode === 'ai' && card.previewBufferNeural) {
          Engine.switchBuffer(card.previewBufferNeural, Engine.bounds);
          Engine.setBypass(false);
        } else {
          Engine.switchBuffer(card.previewBuffer, Engine.bounds);
          Engine.setBypass(mode === 'original');
        }
      }
      this.paint();
    },

    /**
     * Called by setAB() so the FAB never disagrees with the top A/B switch
     * — it only ever adds the 'ai' position on top of what that sets.
     * @returns {void}
     */
    syncFromAB() {
      if (!this.holding) this.mode = State.ab === 'original' ? 'original' : 'restored';
      this.paint();
      this.updateVisibility();
    },

    /**
     * A neural preview finished (or failed) rendering for `card` — if it is
     * the one currently playing and the FAB is resting on 'ai', keep it honest.
     * @param {RSApp.Card} card - the card whose preview changed.
     * @returns {void}
     */
    onPreviewChanged(card) {
      if (card !== State.current) return;
      if (this.mode === 'ai' && !card.previewBufferNeural) { this.mode = 'restored'; this.engage(); }
      this.paint();
    },

    updateVisibility() { this.show(Engine.playing && State.ab !== 'compare'); },
    show(on) { if (this.el) this.el.hidden = !on; },

    paint() {
      if (!this.btn || !this.label) return;
      const shown = this.engaged();
      const letter = shown === 'original' ? 'A' : shown === 'ai' ? 'C' : 'B';
      this.label.textContent = letter;
      this.btn.classList.toggle('is-holding', this.holding);
      this.btn.classList.toggle('is-ai', shown === 'ai');
      this.btn.setAttribute('aria-label', t('fab.mode.' + shown));
    },
  };

  Engine.onTick((pos) => {
    const card = State.current;
    if (!card || !card.analysis) return;
    const dur = card.analysis.window.seconds;
    const f = dur ? Math.max(0, Math.min(1, pos / dur)) : 0;
    card.el.seek.style.width = (f * 100).toFixed(2) + '%';
    const seekEl = $('[data-act="seek"]', card.el.card);
    if (seekEl) seekEl.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    card.el.time.textContent = Codecs.formatDuration(pos) + ' / ' + Codecs.formatDuration(dur);
    card.wave.setPosition(pos);
  });

  Engine.onState((s) => {
    markPlaying(s.playing ? State.current : null);
    FAB.updateVisibility();
  });

  /* ---------------------------------------------------------- the file queue */

  /**
   * Add dropped or picked files to the list: filter to audio, build a card for
   * each, then analyse them one after another — never in parallel, because the
   * point of the queue is that a phone's memory sees one decode at a time. On a
   * touch device a Magic Fix that started from an empty list continues straight
   * into the batch render, which is what makes the one-tap journey real.
   * @param {(FileList|File[])} fileList - the files to add.
   * @returns {Promise<void>} resolves when every added file has been analysed.
   */
  async function addFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []).filter(isAudioFile);
    if (!files.length) { UI.toast(t('toast.noFiles'), 'bad'); return; }
    let skipped = 0;
    const fresh = [];
    for (const f of files) {
      if (f.size > CONFIG.maxFileBytes) {
        UI.toast(t('toast.tooBig', { name: f.name, mb: Math.round(CONFIG.maxFileBytes / 1048576) }), 'bad', 6000);
        skipped++;
        continue;
      }
      const card = createCard(f);
      fresh.push(card);
      State.cards.push(card);
      $('#fileList').appendChild(card.el.card);
      $('#controls').hidden = false;
    }
    if (!fresh.length) return;
    const n = fresh.length;
    refreshLibraryLabels();
    // the file is on the list *now*, with its name — on a phone the new card is
    // often below the fold, so it is brought into view instead of being silent
    revealCard(fresh[0]);
    UI.toast(n === 1 ? t('toast.addedOne', { name: fresh[0].name }) : t('toast.added', { n: n }), 'ok');
    Job.start(n, fresh[0]);
    let done = 0;
    for (const card of fresh) {
      Job.file(done, card.name, card);
      // sequential on purpose: one file in memory at a time keeps RAM flat
      await prepareCard(card);
      done++;
    }
    Job.end();
    if (skipped) UI.toast(t('toast.skipped', { n: skipped }), 'bad');
    // the Magic Fix button armed itself before the file picker opened and the
    // list was empty at the time — on a phone that means "go", full stop
    if (State._magicFixAutoProcess) {
      State._magicFixAutoProcess = false;
      UI.toast(t('toast.magicFix'), 'ok');
      await processAll();
    }
  }

  /**
   * Scroll a fresh card into view (guarded: headless DOMs have no scrolling).
   * @param {RSApp.Card} card - the card to scroll to.
   * @returns {void}
   */
  function revealCard(card) {
    const node = card && card.el && card.el.card;
    if (!node || typeof node.scrollIntoView !== 'function') return;
    try {
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (e) {
      try { node.scrollIntoView(); } catch (e2) { /* nothing to do */ }
    }
  }

  /**
   *
   * Decode + measure a file, then render the short preview so the A/B waveform
   * and the before/after numbers are real, never estimated.
   *
   * Every stage reports what it is doing and how far along it is: decoding and
   * the browser's own work are indeterminate, the measurement and the render
   * are measured (the measurement is sliced, see RSDSP), so the bar never lies
   * about a file that takes a minute on a phone.
   *
   * @param {RSApp.Card} card - the card to decode, measure and preview.
   * @param {boolean} [again] - `true` on a retry: the previous error is
   * cleared and the card starts over.
   * @returns {Promise<void>} resolves when the card is ready to render,
   * or has been marked as failed.
   */
  async function prepareCard(card, again) {
    if (card.status === 'analyzing' || card.status === 'rendering') return;
    setStatus(card, 'analyzing', t('note.decode'));
    card._workT0 = nowMs();
    setCardWork(card, 'decode', null);
    await nextPaint();                       // let the bar paint before the work starts
    if (!card._uploadStreamAttempted) {
      card._uploadStreamAttempted = true;
      await streamUploadToOPFS(card);
    }
    try {
      const dec = await Codecs.decodeFile(card.file);
      const buffer = dec.buffer;
      card.sourceSampleRate = dec.sampleRate;
      card.buffer = buffer;

      setNote(card, t('note.analyze'));
      card._workT0 = nowMs();
      setCardWork(card, 'analyze', 0);
      // sliced measurement: the page keeps painting while a long file is measured
      const analysis = await Analyzer.analyzeAsync(
        buffer,
        { previewSeconds: previewSecondsFor(buffer.duration), buckets: 1400 },
        (p, stage) => setCardWork(card, stage, p, estimateLeft(card, p))
      );
      card.analysis = analysis;
      // first file, untouched slider: adopt the strength the profile recommends
      if (!State.powerTouched && analysis.recommendedPower) adoptRecommendedPower(analysis.recommendedPower);
      card.el.waveEmpty.hidden = true;
      if (again) card.result = null;
      setCardWork(card, 'window', null);

      // the live monitor only ever holds the preview window, not the whole file
      const from = Math.floor(analysis.window.start * analysis.sampleRate);
      const to = Math.floor(analysis.window.end * analysis.sampleRate);
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        chans.push(buffer.getChannelData(c).subarray(from, to));
      }
      card.analysisWindowChannels = chans;
      card.previewBuffer = Codecs.makeBuffer(chans, analysis.sampleRate);
      card.buffer = null;                    // let the full decode go

      // the restored side of the comparison (short window → fast, always real)
      const params = P.params(card);
      if (params) {
        card._workT0 = nowMs();
        setCardWork(card, 'preview', 0);
        const res = await Engine.render(chans, analysis.sampleRate, params, {
          progressSteps: 12,
          /**
           * Feed the preview render's progress into the card's own bar.
           * @param {number} p - progress 0…1.
           * @returns {void}
           */
          onProgress: (p) => setCardWork(card, 'preview', p, estimateLeft(card, p)),
        });
        const env = await Analyzer.envelopeAsync(res.channels, 1400);
        const after = await Analyzer.analyzeChannelsAsync(res.channels, res.sampleRate);
        card.after = { envelope: env, chips: after.chips };
        card.afterScore = after.score;
        await computeComparePreview(card, chans, analysis.sampleRate, params);
      }
      $('[data-act="retry"]', card.el.card).hidden = true;
      clearCardWork(card);
      setStatus(card, 'ready');
      refreshCardText(card);
    } catch (err) {
      card.error = err;
      setStatus(card, 'error');
      if (card.el.bar) card.el.bar.classList.add('is-error');
      clearCardWork(card);
      const msg = err && err.message;
      setNote(card, msg === 'worklet-load-failed' ? t('toast.workletFail')
        : msg === 'broken-audio' ? t('err.broken')
          : t('err.decode') + ' ' + (msg ? '(' + msg + ')' : ''), true);
      $('[data-act="retry"]', card.el.card).hidden = false;
    }
  }

  /**
   * Move the master slider to the value a profile recommends (one time).
   * @param {number} value - the recommended power, 0…1 (clamped).
   * @returns {void}
   */
  function adoptRecommendedPower(value) {
    const p = Math.max(0, Math.min(1, value));
    State.power = p;
    const power = $('#power');
    if (!power) return;
    const pct = Math.round(p * 100);
    power.value = pct;
    UI.paintRange(power);
    const out = $('#powerVal');
    if (out) out.textContent = t('ui.percent', { v: pct });
    for (const c of State.cards) {
      if (c.power === null || c.power === undefined) {
        c.el.power.value = pct;
        c.el.powerOut.textContent = t('ui.percent', { v: pct });
        UI.paintRange(c.el.power);
      }
    }
  }

  /**
   * How long the A/B window should be for a file of this length: the configured
   * 40 s for anything long enough to have one, the whole file for a short one,
   * and never below the configured minimum.
   * @param {number} duration - the file's length in seconds.
   * @returns {number} the preview length in seconds.
   */
  function previewSecondsFor(duration) {
    return Math.max(CONFIG.previewMin, Math.min(CONFIG.previewSeconds, duration));
  }

  /* -------------------------------------------------------- full rendering */

  /**
   * One finished render, as the rest of the app handles it: either the channels
   * themselves (a short file, kept in memory) or the key of the OPFS file they
   * were streamed into (a long one).
   * @typedef {Object} RenderResult
   * @property {?Float32Array[]} channels - the rendered audio when it stayed in
   *   memory, `null` when it went to OPFS.
   * @property {?string} opfsKey - scratch key of the streamed render.
   * @property {number} sampleRate - the rate it was rendered at, in Hz.
   * @property {number} samples - its length in samples.
   * @property {string} format - the format it is meant to be saved as.
   * @property {string} signature - the settings it was rendered with, so a
   *   later request can tell whether it is still current.
   */

  /**
   *
   * Whether a file is long enough that `renderCard()` should use the
   * bounded-memory `Engine.renderChunked()` + incremental-encoder path
   * instead of one whole-file `Engine.render()` pass. Pulled out as its own
   * pure function so the threshold decision is trivially unit-testable
   * without needing a real OPFS or a real render.
   *
   * Requires OPFS (the chunked path has nowhere to stream to otherwise) and
   * a duration comfortably above anything the automated test fixtures use,
   * so every existing exact-size/exact-peak assertion keeps exercising the
   * unchanged `Engine.render()` path.
   *
   * @param {number} durationSeconds - the file's length in seconds.
   * @returns {boolean} `true` when the chunked, streamed path should be
   * used instead of one whole-file pass.
   */
  function shouldChunkRender(durationSeconds) {
    return State.opfsReady && !!OPFS && durationSeconds >= CONFIG.chunkedRenderThresholdSeconds;
  }

  /**
   *
   * The memory-bounded twin of the plain `Engine.render()` + encode block in
   * `renderCard()`: used only once `shouldChunkRender()` says the file is
   * worth it. Each `Engine.renderChunked()` chunk is hashed straight into the
   * matching incremental codec encoder (`Codecs.createWavStreamEncoder` /
   * `createMp3StreamEncoder`) and then dropped — at no point does this
   * card's full-length restored *or* encoded audio exist anywhere but on the
   * OPFS-backed scratch file being streamed to. `RSMemoryGuard`, if the
   * script is loaded, is picked up automatically by `Engine.renderChunked()`
   * itself (see its own default there) and needs no wiring here.
   *
   * @param {RSApp.Card} card - the card being rendered.
   * @param {RSCodecs.DecodedFile} dec - the decoded source.
   * @param {number} rate - the rate to render at, in Hz.
   * @param {RSPresets.ParamMap} params - the parameters to render with.
   * @param {?Object} neuralOpt - Stage-7 neural options, or `null`.
   * @param {?Object} stage0Opt - the pre-DSP neural stage, or `null`.
   * @param {string} name - the output name the render key is built from.
   * @param {string} signature - the settings signature for that key.
   * @param {string} [format] - actual output format, including fallback.
   * @param {AbortSignal} [signal] - encoding cancellation.
   * @returns {Promise<RSApp.RenderResult>} the streamed render's handle.
   */
  async function renderCardChunked(card, dec, rate, params, neuralOpt, stage0Opt, name, signature, format = State.format, signal) {
    await forgetRender(card);
    const key = renderKeyFor(card);
    const sink = await OPFS.createWriter(key);
    const nCh = Math.min(2, dec.buffer.numberOfChannels);
    const totalSamples = Math.max(1, Math.round((dec.buffer.length * rate) / dec.buffer.sampleRate));
    let mp3Enc = null;
    try {
      card._workT0 = nowMs();
      setCardWork(card, 'render', 0);
      const isMp3 = format === 'mp3';
      mp3Enc = isMp3 ? await Codecs.createMp3StreamEncoder(rate, State.mp3Rate, nCh, sink, { signal }) : null;
      const wavEnc = isMp3 ? null : Codecs.createWavStreamEncoder(totalSamples, rate, State.wavDepth, sink);
      const chunked = await Engine.renderChunked(dec.buffer, rate, params, {
        chunkSeconds: CONFIG.chunkSeconds,
        crossfadeMs: CONFIG.chunkCrossfadeMs,
        neural: neuralOpt,
        stage0: stage0Opt,
        /**
         * Feed the chunked render's progress into the card's bar.
         * @param {number} p - progress 0…1.
         * @returns {void}
         */
        onProgress: (p) => setCardWork(card, 'render', p, estimateLeft(card, p)),
        /**
         * Hand one finished chunk to the streaming encoder before it is dropped
         * — MP3 chunks are flushed on the last one, WAV has no flush step.
         * @param {Float32Array[]} channels - the chunk's channels.
         * @param {{index:number,total:number,isLast:boolean}} info - chunk info.
         * @returns {Promise<void>}
         */
        onChunk: async (channels, info) => {
          setCardWork(card, 'encode', info.endSample / info.totalSamples, estimateLeft(card, info.endSample / info.totalSamples));
          await nextPaint();
          if (mp3Enc) await mp3Enc.appendChannels(channels, info.isLast);
          else await wavEnc.appendChannels(channels);
        },
      });
      const stage0Stats = chunked.stage0;
      const stats = mp3Enc ? await mp3Enc.finish() : await wavEnc.finish();
      const closed = await sink.close();
      const file = await OPFS.getFile(key);
      return { file, size: closed.size, name, format, rate: stats.sampleRate || rate,
        signature, stale: false, opfsKey: key, stage0: stage0Stats };
    } catch (err) {
      if (mp3Enc) mp3Enc.abort();
      await sink.abort();
      throw err;
    }
  }

  /**
   * Render the whole file with the current settings and keep the encoded blob.
   * @returns {Promise<{blob:Blob,name:string,format:string}>}
   */
  /**
   * The neural render option for the final export, honouring the toggle,
   * capability probe, and — only when a Magic Fix armed it — a lighter wet
   * amount via the already-wired `neural.amount` lever (see engine.js).
   * @returns {?Object} options for `Engine.render()`/`renderChunked()`,
   * or `null` when the feature is off or no model is installed.
   */
  function neuralOptFor() {
    if (!(State.neuralEnabled && State.neuralAvailable)) return null;
    return isFinite(State.neuralAmount) ? { amount: State.neuralAmount } : {};
  }

  /**
   * The pre-DSP neural stage for a render, or `null` for the pure DSP route.
   *
   * This is the switch Magic Fix throws: Stage 0 is the denoiser *in front of*
   * the chain (see `Engine.render`'s `stage0` option), so the DSP stages below
   * it see a cleaner signal, and the C position of the compare FAB is exactly
   * "this plus the chain".
   * @returns {?Object} `{mode:'denoise'}` when the model is there and the
   *   stage is armed, `null` otherwise.
   */
  function stage0For() {
    if (!(State.aiDenoise && State.neuralDenoise)) return null;
    return { mode: 'denoise', adaptive: true };
  }

  /**
   * Render one card into its result — the full-length pass, in either of its
   * two shapes (chunked and streamed for a long file, whole-file otherwise).
   * Sets the card's progress, status and note, re-measures the result for the
   * before/after read-out, and keeps the previous result until the new one is
   * complete, so a failed re-render never loses the file the user had.
   * @param {RSApp.Card} card - the card to render.
   * @param {Object} [opts] - render options (`force` bypasses the cache check).
   * @returns {Promise<RSApp.RenderResult>} the render, or the card's existing
   *   result when nothing about its settings has changed.
   */
  /** Render with explicit WAV fallback if worker/WASM initialization is blocked.
   * Does not disguise abort, queue timeout, quota or DSP failures as success.
   * @param {RSApp.Card} card - card to render.
   * @param {Object} [opts] - render options, signal and optional format.
   * @returns {Promise<RSApp.RenderResult>} correctly named/typed output.
   */
  async function renderCard(card, opts) {
    try { return await renderCardAttempt(card, opts); }
    catch (error) {
      if ((opts && opts.format || State.format) !== 'mp3' || error.name !== 'EncodingUnavailableError') throw error;
      UI.toast(t('toast.wavFallback'), 'warn', 6000);
      return renderCardAttempt(card, Object.assign({}, opts, { force: true, format: 'wav' }));
    }
  }

  /** Execute one render in the requested actual format.
   * @param {RSApp.Card} card - card to render.
   * @param {Object} [opts] - streaming, signal, force and format.
   * @returns {Promise<RSApp.RenderResult>} actual output.
   */
  async function renderCardAttempt(card, opts) {
    const o = opts || {};
    const format = o.format || State.format;
    const params = P.params(card);
    if (!params) throw new Error('not analysed');
    const signature = P.signature(card);
    if (card.result && card.result.signature === signature && (card.result.bytes || card.result.file) && !o.force) {
      return card.result;
    }

    setStatus(card, 'processing', t('note.decode'));
    card._workT0 = nowMs();
    setCardWork(card, 'decode', null);
    await nextPaint();
    const dec = await Codecs.decodeFile(card.file);
    const rate = P.exportRate(card);

    card._workT0 = nowMs();
    setCardWork(card, 'render', 0);
    setNote(card, t('status.processing'));
    // The neural Stage-7 coupling driven by the "KI-Höhenrekonstruktion"
    // checkbox (or by a Magic Fix) only ever runs on this, the final export
    // render — never on the live preview or the A/B comparison window, both
    // of which re-render on every slider nudge and would otherwise pay an
    // inference cost the user never gets to hear the benefit of before the
    // next nudge discards it. (The one exception is the compare FAB's own
    // "C" position — see computeComparePreviews() — which renders its own,
    // separate, always-full-strength neural preview once per analysis, not
    // on every nudge, specifically so there is something real to A/B/C
    // against.) It is also always optional: `Engine.render` falls back to
    // the identical pure-DSP render whenever it is omitted, unavailable, or
    // fails for any reason (see the comment there).
    const neuralOpt = neuralOptFor();
    const stage0Base = stage0For();
    const stage0Opt = stage0Base ? Object.assign({}, stage0Base, { signal: o.signal }) : null;
    const name = Codecs.outputName(card.name, format === 'mp3' ? 'mp3' : 'wav');

    let result;
    if (OPFS && (o.streaming || shouldChunkRender(dec.buffer.duration))) {
      // Long file, OPFS available: render *and* encode in small, overlapping
      // chunks streamed straight to the scratch file — see
      // renderCardChunked() — instead of materialising the whole restored
      // signal (Engine.render()'s own return value) and then the whole
      // encoded file as two more full-length allocations on top of it.
      setNote(card, format === 'mp3' ? t('toast.mp3Slow') : t('status.export'));
      result = await renderCardChunked(card, dec, rate, params, neuralOpt, stage0Opt, name, signature, format, o.signal);
    } else {
      const res = await Engine.render(dec.buffer, rate, params, {
        progressSteps: 24,
        /**
         * Feed the whole-file render's progress into the card's bar.
         * @param {number} p - progress 0…1.
         * @returns {void}
         */
        onProgress: (p) => setCardWork(card, 'render', p, estimateLeft(card, p)),
        neural: neuralOpt,
        stage0: stage0Opt,
      });

      setNote(card, format === 'mp3' ? t('toast.mp3Slow') : t('status.export'));
      /**
       * Feed the encoder's progress into the card's bar — this is the stage the
       * MP3 note warns about, so it is the one that most needs a moving bar.
       * @param {number} p - progress 0…1.
       * @returns {void}
       */
      const onEncodeProgress = (p) => setCardWork(card, 'encode', p, estimateLeft(card, p));

      if (State.opfsReady && OPFS) {
        // stream straight to disk-backed scratch storage: at no point does this
        // card's whole output exist as one ArrayBuffer on the main thread, so a
        // batch of large files never multiplies into the soft-memory ceiling
        await forgetRender(card);
        const key = renderKeyFor(card);
        const sink = await OPFS.createWriter(key);
        try {
          card._workT0 = nowMs();
          setCardWork(card, 'encode', 0);
          if (format === 'mp3') {
            await Codecs.encodeMp3(res.channels, res.sampleRate, State.mp3Rate, onEncodeProgress, sink, { signal: o.signal });
          } else {
            await Codecs.encodeWavStream(res.channels, res.sampleRate, State.wavDepth, sink, onEncodeProgress);
          }
          const closed = await sink.close();
          const file = await OPFS.getFile(key);
          result = { file, size: closed.size, name, format: format, rate: res.sampleRate,
            signature, stale: false, opfsKey: key, stage0: res.stage0 };
        } catch (err) {
          await sink.abort();
          throw err;
        }
      } else {
        card._workT0 = nowMs();
        setCardWork(card, 'encode', 0);
        let bytes;
        if (format === 'mp3') {
          const out = await Codecs.encodeMp3(res.channels, res.sampleRate, State.mp3Rate, onEncodeProgress, undefined, { signal: o.signal });
          bytes = out.bytes;
        } else {
          const pieces = [];
          const stats = await Codecs.encodeWavStream(res.channels, res.sampleRate, State.wavDepth,
            { async write(chunk) { pieces.push(chunk); } }, onEncodeProgress);
          bytes = new Uint8Array(stats.bytesWritten);
          let offset = 0;
          for (const chunk of pieces) { bytes.set(chunk, offset); offset += chunk.length; }
        }
        result = { bytes, name, format: format, rate: res.sampleRate, signature, stale: false, stage0: res.stage0 };
      }
    }

    clearCardWork(card);
    card.result = result;
    setStatus(card, 'done');
    setNote(card, t('note.done', { fmt: format.toUpperCase() }));
    refreshCardText(card);
    return card.result;
  }

  /**
   * Save one card's file to the user's device: reuse the existing render when
   * the settings have not changed, otherwise render first — then encode (WAV or
   * MP3) and hand the bytes to the browser as a download. A streamed OPFS render
   * is passed on as a `File`, so its bytes are never read back into the heap
   * just to be saved.
   * @param {RSApp.Card} card - the card to save.
   * @returns {Promise<void>} resolves once the download was triggered, or once
   *   the failure has been reported on the card.
   */
  async function saveCard(card) {
    if (State.busy) return;
    if (!card.analysis) { UI.toast(t('toast.needDecode'), 'bad'); return; }
    State.busy = true;
    Job.start(1, card);
    try {
      const res = await renderCard(card);
      Codecs.download(res.file || res.bytes, res.name);
      UI.toast(t('toast.saved', { name: res.name }), 'ok');
    } catch (err) {
      setStatus(card, 'error');
      const msg = err && err.message;
      // the encoder refusing its own output is a real, nameable failure — it
      // must never be saved as a file that "worked"
      setNote(card, /^mp3-/.test(msg || '') ? t('err.mp3') : t('err.render') + ' ' + (msg || ''), true);
      UI.toast(/^mp3-/.test(msg || '') ? t('err.mp3') : t('toast.renderFail', { msg: msg || '?' }), 'bad', 6000);
    }
    Job.end();
    State.busy = false;
  }

  /**
   * Render cards concurrently under CPU and decoded-memory limits. Per-card
   * progress is coalesced at frame boundaries; encoding has independent pool
   * backpressure. A second batch call while running is ignored.
   * @returns {Promise<void>} resolves when the queue is empty.
   */
  async function processAll() {
    if (State.busy) return;
    const todo = State.cards.filter((c) => c.analysis);
    if (!todo.length) { UI.toast(t('toast.zipEmpty'), 'bad'); return; }
    State.busy = true;
    disableControls(true);
    try {
      const projected = todo.reduce((sum, c) => {
        const secs = c.analysis.duration;
        const rate = P.exportRate(c);
        return sum + (State.format === 'mp3'
          ? secs * State.mp3Rate * 125
          : secs * rate * (c.analysis.channels > 1 ? 2 : 1) * (State.wavDepth / 8));
      }, 0);
      if (projected > CONFIG.softMemoryMB * 1e6 && !State.opfsReady) {
        UI.toast(t('toast.bigBatchMemory'), 'warn', 6000);
      }
      Job.start(todo.length, todo[0]);
      // Bound concurrency by both logical CPUs and the decoded PCM budget.
      // The encoder pool independently bounds WASM heaps and applies backpressure.
      const cores = Math.max(1, Math.floor(global.navigator && global.navigator.hardwareConcurrency || 2));
      const largest = Math.max(1, ...todo.map(c => c.analysis.duration * P.exportRate(c) * (c.analysis.channels > 1 ? 2 : 1) * 4));
      const lanes = Math.min(todo.length, cores, Math.max(1, Math.floor(CONFIG.softMemoryMB * 1e6 / (largest * 3))));
      let cursor = 0;
      /** Process independent cards without letting one failed file cancel siblings.
       * @returns {Promise<void>} lane completion.
       */
      async function lane() {
        while (cursor < todo.length) {
          const i = cursor++, card = todo[i];
          Job.file(i, card.name, card);
          try { await renderCard(card, { streaming: true }); }
          catch (err) { setStatus(card, 'error'); setNote(card, (err && err.message) || t('err.render'), true); }
          await nextPaint();
        }
      }
      await Promise.all(Array.from({ length: lanes }, () => lane()));
      UI.toast(t('batch.done', { n: todo.length }), 'ok');
    } catch (err) {
      UI.toast(t('toast.renderFail', { msg: (err && err.message) || '?' }), 'bad', 6000);
    }
    Job.end();
    disableControls(false);
    State.busy = false;
  }

  /**
   * Bundle every finished card into one ZIP and download it. Two
   * implementations, one promise: with OPFS the archive is assembled
   * streamed-file to streamed-file inside the worker (the heap never holds the
   * archive), without it JSZip builds it in memory. Cards that are not rendered
   * yet are rendered first, so the button always does what it says.
   * @returns {Promise<void>} resolves once the download was triggered.
   */
  async function downloadZip() {
    if (State.busy) return;
    const ready = State.cards.filter((c) => c.analysis);
    if (!ready.length) { UI.toast(t('toast.zipEmpty'), 'bad'); return; }
    State.busy = true;
    disableControls(true);
    let zipKey = null;
    try {
      UI.toast(t('toast.zipStart'), null, 2200);
      const projected = totalBytesOf(ready);
      if (projected > CONFIG.softMemoryMB * 1e6 && State.format === 'wav' && !State.opfsReady) {
        UI.toast(t('toast.bigBatchMemory'), 'warn', 6000);
      }
      const entries = [];
      Job.start(ready.length, ready[0]);
      for (let i = 0; i < ready.length; i++) {
        const card = ready[i];
        Job.file(i, card.name, card);
        const res = await renderCard(card);
        entries.push(res.opfsKey
          ? { name: res.name, key: res.opfsKey, size: res.size }
          : { name: res.name, bytes: res.bytes });
      }
      const readmeText = buildReadme(ready);
      const readmeBytes = utf8Encode(readmeText);
      Job.file(Math.max(0, entries.length - 1), entries.length ? entries[entries.length - 1].name : '', null);
      Job.at(0.9, 'zip');
      const name = 'remaster-suite-' + new Date().toISOString().slice(0, 10) + '.zip';

      let file;
      if (State.opfsReady && OPFS && entries.every((e) => e.key)) {
        // OPFS file → OPFS file, all the way through: the assembled archive
        // never exists in the main thread's heap, only its final `{size}`
        zipKey = 'zip-' + Date.now();
        entries.push({ name: 'README.txt', bytes: readmeBytes });
        await OPFS.packZip(entries, zipKey, (info) => {
          const share = entries.length ? info.index / entries.length : 1;
          Job.at(0.9 + share * 0.1, 'zip');
        });
        file = await OPFS.getFile(zipKey);
      } else {
        for (const entry of entries) if (entry.key) {
          const stored = await OPFS.getFile(entry.key);
          entry.bytes = new Uint8Array(await Codecs.readBlob(stored));
        }
        entries.readme = readmeText;
        file = await Codecs.zip(entries, (p) => Job.at(0.9 + p * 0.1, 'zip'));
      }
      Codecs.download(file, name);
      UI.toast(t('toast.zipDone', { n: ready.length }), 'ok');
    } catch (err) {
      UI.toast(t('toast.zipFail') + ' ' + (err && err.message ? err.message : ''), 'bad', 6000);
    }
    if (zipKey) global.setTimeout(() => OPFS.remove(zipKey), 5000);
    Job.end();
    disableControls(false);
    State.busy = false;
  }

  /**
   * UTF-8 bytes of a string — used for the small README.txt entry that goes
   * straight into an OPFS-assembled ZIP (never needs a real file on disk).
   * @param {string} str - the text to encode.
   * @returns {Uint8Array} its UTF-8 bytes.
   */
  function utf8Encode(str) {
    if (typeof global.TextEncoder !== 'undefined') return new global.TextEncoder().encode(str);
    const esc = unescape(encodeURIComponent(str));
    const out = new Uint8Array(esc.length);
    for (let i = 0; i < esc.length; i++) out[i] = esc.charCodeAt(i);
    return out;
  }

  /**
   * A short note inside the ZIP: what was done and by whom.
   * @param {RSApp.Card[]} cards - the cards included in the archive.
   * @returns {string} the README's text.
   */
  function buildReadme(cards) {
    const lines = [];
    lines.push('Harmonic Restoration — Remaster Suite');
    lines.push('Developed by AndrexTheDev · hippie.highho@gmail.com');
    lines.push('100 % client-side audio restoration · ' + new Date().toISOString().slice(0, 10));
    lines.push('');
    lines.push('Files in this archive');
    lines.push('--------------------');
    for (const c of cards) {
      const a = c.analysis;
      const presets = P.resolvedPreset(c);
      lines.push('* ' + c.name);
      lines.push('  out      : ' + ((c.result && c.result.name) || '—'));
      lines.push('  profile  : ' + presets + '  (power ' + Math.round(P.power(c) * 100) + ' %)');
      lines.push('  format   : ' + (c.result ? c.result.format.toUpperCase() + ' · ' + c.result.rate + ' Hz' : '—'));
      const neural = c.result && c.result.stage0;
      lines.push('  neural   : ' + (neural && neural.applied
        ? [neural.pipeline || 'neural', neural.variant || 'unknown variant', neural.provider || 'unknown provider'].join(' · ')
        : 'not applied' + (neural && neural.reason ? ' (' + neural.reason + ')' : '')));
      lines.push('  detected : ' + (a ? (a.diag.chain && a.diag.chain.length ? a.diag.chain.join('+') : a.diag.id) : '?')
        + (a ? ' [' + a.diag.issues.join(', ') + ']' : ''));
      lines.push('  quality  : ' + (a ? a.score : '?') + ' / 100 before');
      lines.push('');
    }
    lines.push('If this saved you time, a voluntary tip is welcome:');
    lines.push('  SOL 79KsqtJJdhKFJ9woxnYgtf3nq7HxQveafWBCtC3mxWi8');
    lines.push('  BTC bc1qeqzrlfg3edrydk4s0hecakc82gp26n5p7hkc7f');
    lines.push('  ETH 0xBC3fab34f69bc9f6661608C3FB36dDdC313C42F7');
    lines.push('');
    lines.push('Tips are voluntary and not a purchase.');
    return lines.join('\n');
  }

  /**
   * Remove one card: stop anything it was doing, release its scratch files and
   * its object URLs, and drop its DOM node. Every release is best-effort — a
   * card that is going away must not fail the user's next action.
   * @param {RSApp.Card} card - the card to remove.
   * @returns {void}
   */
  function removeCard(card) {
    if (State._inspectorCard === card) closeInspector();
    if (State.current === card) { Engine.stop(); State.current = null; }
    clearTimeout(card._previewTimer);
    if (card.wave && card.wave.destroy) card.wave.destroy();
    forgetRender(card);
    forgetUpload(card);
    const i = State.cards.indexOf(card);
    if (i >= 0) State.cards.splice(i, 1);
    card.el.card.remove();
    refreshLibraryLabels();
    if (!State.cards.length) {
      $('#controls').hidden = true;
      $('#fileList').textContent = '';
    }
  }

  /**
   * Empty the list: stop playback, drop every card (and its scratch files),
   * cancel the pending preview debounce and put the page back to its empty
   * state. A running batch is stopped first.
   * @returns {void}
   */
  function clearAll() {
    closeInspector();
    Engine.stop();
    State.current = null;
    Job.end();
    clearTimeout(previewTimer);
    for (const c of State.cards) {
      clearTimeout(c._previewTimer);
      if (c.wave && c.wave.destroy) c.wave.destroy();
      forgetRender(c);
      forgetUpload(c);
      c.el.card.remove();
    }
    State.cards = [];
    refreshLibraryLabels();
    $('#controls').hidden = true;
    UI.toast(t('toast.cleared'));
  }

  /**
   * Disable or re-enable the global controls while a batch runs, so the user
   * cannot start a second one on top of it.
   * @param {boolean} off - `true` to disable.
   * @returns {void}
   */
  function disableControls(off) {
    ['#btnProcessAll', '#btnZip', '#btnClear'].forEach((sel) => {
      const b = $(sel);
      if (b) b.disabled = off;
    });
  }

  /**
   * Repaint the two facts about the session that are learned asynchronously:
   * where the libraries come from (bundled copies or a free CDN) and whether a
   * neural model is actually usable. Both are shown in the header and in the
   * neural row.
   * @returns {void}
   */
  function refreshLibraryLabels() {
    const n = State.cards.length;
    const zip = $('#btnZip');
    if (zip) zip.textContent = n > 1 ? t('ctl.zip') + ' (' + n + ')' : t('ctl.zip');
  }

  /* ------------------------------------------------------------- global wiring */

  /** The dropzone copy differs for a finger: nothing can be dragged on a phone. */
  /**
   * The drop zone is the one place where desktop and phone wording differ:
   * dragging a file is not something a phone can do. The key is written back to
   * `data-i18n` so a later language repaint keeps the variant this device needs.
   */
  function paintDropzone() {
    const touch = State.touch;
    const pairs = [
      [$('#dzTitle'), touch ? 'drop.titleTouch' : 'drop.title'],
      [$('#dzHint'), touch ? 'drop.hintTouch' : 'drop.hint'],
    ];
    for (const [el, key] of pairs) {
      if (!el) continue;
      el.setAttribute('data-i18n', key);
      el.textContent = t(key);
    }
  }

  /**
   * Wire the drop zone: click to pick, drag-and-drop with its overlay, paste,
   * and the file input's own change event. A change fires exactly once per
   * selection — the input is reset afterwards, so picking the same file twice
   * still works.
   * @returns {void}
   */
  function bindDropzone() {
    const dz = $('#dropzone');
    const input = $('#fileInput');
    /**
     * Open the file picker — the drop zone's click, keyboard and button
     * handlers all route through this one function.
     * @returns {void}
     */
    const openPicker = () => input.click();
    dz.addEventListener('click', openPicker);
    dz.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPicker(); }
    });
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach((type) => {
      dz.addEventListener(type, (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        dz.classList.add('is-over');
      });
    });
    ['dragleave', 'dragend'].forEach((type) => dz.addEventListener(type, () => dz.classList.remove('is-over')));
    dz.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dz.classList.remove('is-over');
      if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });
    // dropping anywhere on the page must never navigate away
    ['dragover', 'drop'].forEach((type) => {
      global.addEventListener(type, (ev) => {
        if (ev.target === dz || dz.contains(ev.target)) return;
        ev.preventDefault();
      });
    });
  }

  /**
   * Wire every global control: the power slider and its label, the profile
   * selector, the A/B segmented control, the format and bitrate selects, the
   * batch buttons, the neural switch and the two one-tap helpers. This is the
   * only place the global controls are bound, on purpose — a second binding
   * site is how a control ends up doing something twice.
   * @returns {void}
   */
  function bindControls() {
    const power = $('#power');
    power.value = Math.round(State.power * 100);
    UI.paintRange(power);
    $('#powerVal').textContent = t('ui.percent', { v: power.value });
    let lastPowerDecile = Math.round(State.power * 10);
    power.addEventListener('input', () => {
      State.powerTouched = true;
      State.power = Number(power.value) / 100;
      $('#powerVal').textContent = t('ui.percent', { v: power.value });
      UI.paintRange(power);
      // a tiny pulse every 10 % — tactile ticks on a slider that otherwise
      // gives a touch screen no physical detents to feel
      const decile = Math.round(State.power * 10);
      if (decile !== lastPowerDecile) { lastPowerDecile = decile; vibrate(6, $('#powerVal')); }
      for (const c of State.cards) {
        if (c.power === null) {
          c.el.power.value = power.value;
          c.el.powerOut.textContent = t('ui.percent', { v: power.value });
          UI.paintRange(c.el.power);
        }
      }
      const card = State.current;
      if (card) applyLiveParams(card);
      debouncePreviewAll();
    });
    power.addEventListener('change', () => vibrate(14, power));

    const presetSel = $('#presetSelect');
    presetSel.value = State.preset;
    presetSel.addEventListener('change', () => {
      State.preset = presetSel.value;
      vibrate(10, presetSel);
      for (const c of State.cards) {
        if (c.preset === null || c.preset === undefined) c.el.preset.value = State.preset;
      }
      const card = State.current;
      if (card) applyLiveParams(card);
      debouncePreviewAll();
    });

    $$('#abSwitch button').forEach((b) => {
      b.addEventListener('click', () => {
        vibrate(10, b);
        setAB(b.getAttribute('data-ab'));
        if (!Engine.playing && State.cards.length) {
          const target = State.current || State.cards.find((c) => c.previewBuffer);
          if (target) ensurePlaying(target);
        }
      });
    });

    $('#btnProcessAll').addEventListener('click', processAll);
    $('#btnZip').addEventListener('click', downloadZip);
    $('#btnClear').addEventListener('click', clearAll);

    $$('.controls .seg[role="group"] button[data-format]').forEach((b) => {
      b.addEventListener('click', () => {
        State.format = b.getAttribute('data-format');
        $$('.controls .seg button[data-format]').forEach((x) => x.classList.toggle('is-active', x === b));
        $('#mp3Rate').hidden = State.format !== 'mp3';
        $('#wavDepth').hidden = State.format !== 'wav';
        markAllStale();
      });
    });

    const mp3 = $('#mp3Rate');
    mp3.addEventListener('change', () => {
      State.mp3Rate = Number(mp3.value);
      markAllStale();
    });
    const depth = $('#wavDepth');
    if (depth) {
      depth.addEventListener('change', () => {
        State.wavDepth = Number(depth.value);
        markAllStale();
      });
    }

    const neural = $('#neuralToggle');
    if (neural) {
      neural.addEventListener('change', () => {
        if (neural.checked && !State.neuralAvailable) { loadNeuralModel(); return; }
        State.neuralEnabled = neural.checked && State.neuralAvailable;
        // Switching the neural feature *off* stops the pre-DSP denoiser too:
        // it is the one control a user has for "no neural work", and leaving
        // Stage 0 armed would keep the slowest part of the pipeline running
        // behind a switch that says it is not. Switching it on does not arm
        // Stage 0 by itself — the checkbox is the air reconstruction, and
        // Magic Fix is what decides a denoiser should run in front of the chain.
        if (!State.neuralEnabled) { State.aiDenoise = false; State._aiDenoiseWanted = false; }
        markAllStale();   // the final export differs, so any cached render is now stale
      });
    }

    const neuralRemove = $('#neuralModelRemove');
    if (neuralRemove) {
      neuralRemove.addEventListener('click', async () => {
        if (State.busy || State._neuralLoading || !Neural || typeof Neural.removeModel !== 'function') return;
        if (global.confirm && !global.confirm(t('ctl.neuralRemoveConfirm'))) return;
        neuralRemove.disabled = true;
        const status = Neural.modelStatus ? await Neural.modelStatus('deepfilternet3') : null;
        const variants = status && status.variants;
        const variant = variants && Object.keys(variants).find((key) => variants[key] && variants[key].cached);
        if (variant) await Neural.removeModel('deepfilternet3', variant);
        State.neuralEnabled = false; State.neuralAvailable = false; State.neuralDenoise = false;
        State.aiDenoise = false; State._aiDenoiseWanted = false;
        markAllStale();
        UI.toast(t('ctl.neuralRemoved'), 'ok');
        await initNeural();
      });
    }

    FAB.init();
    bindMagicFix();
    bindCarousel();
  }

  /* ----------------------------------------------------------- magic fix */

  /**
   *
   * One tap: auto profile, a confidently strong restoration power, and —
   * wherever this device/build actually has the weights for it — a light
   * application of the optional neural coupling. On a phone this also runs
   * the batch straight through, exactly as the brief asks ("auf Mobilgeräten
   * soll dieser Button sofort … anwenden"); on a desktop it arms the same
   * settings and refreshes every preview so the result can be previewed
   * before committing to "Alle verarbeiten".
   *
   * What it does when a denoiser is actually installed: it arms **Stage 0** —
   * DeepFilterNet3 in front of the chain, see `Engine.render`'s `stage0`
   * option — then re-measures the result and leaves only the DSP de-hiss dose
   * justified by the remaining noise floor. Without weights it does exactly what it
   * always did: the measurement-gated DSP stages at `magicPower`, plus the
   * optional neural air coupling at `magicNeuralAmount`. Both states are real
   *; neither is simulated when the model is missing.
   *
   * @returns {void}
   */
  function bindMagicFix() {
    const btn = $('#btnMagicFix');
    if (!btn) return;
    btn.addEventListener('click', () => applyMagicFix());
  }

  /**
   * Apply the pre-judged Magic Fix settings and, on an empty list, open the
   * picker and mark the session so the batch starts by itself afterwards.
   * Does nothing at all while a batch is running.
   * @returns {Promise<void>} resolves once the picker was opened or the
   *   settings were applied.
   */
  async function applyMagicFix() {
    const btn = $('#btnMagicFix');
    if (btn && btn.classList.contains('is-firing')) return;   // ignore a double-tap mid-run
    vibrate(16, btn);
    armMagicSettings();
    if (!State.cards.length) {
      State._magicFixAutoProcess = State.touch;
      UI.toast(t('toast.magicArmed'), 'ok', 5000);
      const input = $('#fileInput');
      if (input) input.click();
      return;
    }
    UI.toast(t('toast.magicFix'), 'ok');
    debouncePreviewAll();
    if (State.touch) {
      if (btn) btn.classList.add('is-firing');
      try { await processAll(); } finally { if (btn) btn.classList.remove('is-firing'); }
    }
  }

  /** Arm the global + every existing card's settings for the Magic Fix,
   * without necessarily processing anything yet (see applyMagicFix()). */
  function armMagicSettings() {
    State.preset = 'auto';
    State.powerTouched = true;
    State.power = CONFIG.magicPower;
    if (State.neuralAvailable) {
      State.neuralEnabled = true;
      State.neuralAmount = CONFIG.magicNeuralAmount;
    }
    // The one-tap fix uses the denoiser *in front of* the chain when the
    // model is really there. This is the switch the C position of the compare
    // FAB plays, and the reason Magic Fix can promise a cleaner result than
    // the DSP stages alone. Without weights it stays off — the arming code
    // never claims a stage it cannot run.
    State._aiDenoiseWanted = true;
    State.aiDenoise = !!(State.neuralDenoise && Stage0Available());

    const presetSel = $('#presetSelect');
    if (presetSel) presetSel.value = 'auto';
    const power = $('#power');
    if (power) {
      power.value = Math.round(CONFIG.magicPower * 100);
      UI.paintRange(power);
      $('#powerVal').textContent = t('ui.percent', { v: power.value });
    }
    const neuralToggle = $('#neuralToggle');
    if (neuralToggle && State.neuralAvailable) neuralToggle.checked = true;

    for (const c of State.cards) {
      c.preset = null;              // follow the global "auto"
      c.power = null;               // follow the global power
      c.el.preset.value = 'auto';
      c.el.power.value = Math.round(CONFIG.magicPower * 100);
      c.el.powerOut.textContent = t('ui.percent', { v: c.el.power.value });
      UI.paintRange(c.el.power);
    }
    markAllStale();
    const card = State.current;
    if (card) applyLiveParams(card);
  }

  /* -------------------------------------------------------- effect carousel */

  /**
   * The phone-only swipeable effect rack: a dot per page, kept in sync with
   * whichever page is currently centred in the scroll container. Purely a
   * progressive enhancement — the rack scrolls natively via CSS scroll-snap
   * with or without this; the dots just make the "there is more" visible.
   * @returns {void}
   */
  function bindCarousel() {
    const rack = $('#ctlRack');
    const dots = $('#ctlDots');
    if (!rack || !dots) return;
    const groups = $$('.ctl-group', rack);
    if (!groups.length) return;
    while (dots.firstChild) dots.removeChild(dots.firstChild);
    const dotEls = groups.map((g, i) => {
      const i_ = UI.el('i', { role: 'presentation' });
      i_.className = i === 0 ? 'is-active' : '';
      dots.appendChild(i_);
      return i_;
    });

    let raf = 0;
    /**
     * Repaint the dot trail from the rack's current scroll position, and
     * mark the group whose centre is closest to the viewport's centre.
     * @returns {void}
     */
    const paint = () => {
      raf = 0;
      const center = rack.scrollLeft + rack.clientWidth / 2;
      let closest = 0;
      let best = Infinity;
      groups.forEach((g, i) => {
        const mid = g.offsetLeft + g.offsetWidth / 2;
        const d = Math.abs(mid - center);
        if (d < best) { best = d; closest = i; }
      });
      dotEls.forEach((d, i) => d.classList.toggle('is-active', i === closest));
    };
    rack.addEventListener('scroll', () => {
      if (!raf) raf = requestAnimationFrame(paint);
    }, { passive: true });
    paint();
  }

  /** Any change of export settings invalidates already rendered results. */
  function markAllStale() {
    for (const c of State.cards) {
      if (c.result) c.result.stale = true;
      if (c.status === 'done') setStatus(c, 'ready');
    }
    refreshAllCards();
  }

  /**
   * Repaint every card's own text and read-out without re-measuring anything —
   * used after a global change and after a language switch.
   * @returns {void}
   */
  function refreshAllCards() {
    for (const c of State.cards) if (c.analysis) refreshCardText(c);
  }

  /**
   * Pending debounce handle for {@link RSApp.debouncePreviewAll}; `0` when no
   * refresh is scheduled.
   * @type {number}
   */
  let previewTimer = 0;
  /**
   * Refresh every card's preview, at most once per debounce window (the wait
   * is {@link RSApp.CONFIG}'s `previewDebounceMs`). Dragging the global slider
   * fires a change per frame; without this, each one would start a render of
   * its own.
   * @returns {void}
   */
  function debouncePreviewAll() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      for (const c of State.cards) if (c.analysis) refreshPreview(c);
    }, 500);
  }

  /**
   * Wire the header: the language switch (which re-translates the whole page),
   * the library-mode toggle and the help dialog. The language switch re-applies
   * both dictionaries and then repaints everything derived from them, so no
   * label keeps its old language.
   * @returns {void}
   */
  function bindHeader() {
    const sw = $('#langSwitch');
    $$('button', sw).forEach((b) => {
      b.addEventListener('click', () => {
        const lang = b.getAttribute('data-lang');
        global.RSi18n.setLang(lang);
        $$('#langSwitch button').forEach((x) => {
          const on = x === b;
          x.classList.toggle('is-active', on);
          x.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        refreshAllText();
      });
    });
    const help = $('#btnHelp');
    help.addEventListener('click', () => UI.openDialog('#dlgHelp'));
    const libBtn = $('#btnLibMode');
    if (libBtn) {
      /**
       * Repaint the library-mode button for the current mode and language.
       * @returns {void}
       */
      const paint = () => {
        const cdn = global.RSLibs.mode === 'cdn';
        libBtn.textContent = t(cdn ? 'about.libCdn' : 'about.libLocal');
        libBtn.title = t('about.libToggle');
      };
      paint();
      libBtn.addEventListener('click', () => {
        global.RSLibs.toggle();
        paint();
        UI.toast(t(global.RSLibs.mode === 'cdn' ? 'toast.libCdn' : 'toast.libLocal'), 'ok', 5200);
      });
      global.RSLibs._paint = paint;
    }
  }

  /** Re-render every text node that was built in JavaScript. */
  function refreshAllText() {
    const langs = [['#langSwitch button[data-lang="de"]', 'de'], ['#langSwitch button[data-lang="en"]', 'en']];
    for (const [sel, lang] of langs) {
      const b = $(sel);
      if (b) { const on = global.RSi18n.lang === lang; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    }
    // short preset labels inside the cards
    for (const c of State.cards) {
      const short = { auto: 'preset.auto.short', garage: 'preset.garage', vinyl: 'preset.vinyl', cassette: 'preset.cassette', lowbitrate: 'preset.lowbitrate', general: 'preset.general' };
      Array.prototype.forEach.call(c.el.preset.options, (o) => { o.textContent = t(short[o.value] || 'preset.general'); });
      c.el.powerOut.textContent = t('ui.percent', { v: c.el.power.value });
      const play = $('[data-act="play"]', c.el.card);
      if (play) play.setAttribute('aria-label', t(c === State.current && Engine.playing ? 'card.pause' : 'card.play'));
      c.wave.o.onSeek && c.wave.schedule();
      if (c.analysis) refreshCardText(c);
    }
    const power = $('#power');
    if (power) $('#powerVal').textContent = t('ui.percent', { v: power.value });
    if (global.RSLibs && global.RSLibs._paint) global.RSLibs._paint();
    paintNeuralStatus();
    paintNeuralModelInfo(neuralModelStatus);
    paintDropzone();
    if (State.job) paintJob();
    refreshLibraryLabels();
    for (const c of State.cards) c.wave.draw();
  }

  /**
   * Wire the footer's tip addresses: clicking one copies it to the clipboard
   * and confirms with a toast — the whole interaction, in a page that has no
   * backend to send anything to.
   * @returns {void}
   */
  function bindFooter() {
    $$('.coin').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const addr = btn.getAttribute('data-copy');
        const label = btn.getAttribute('data-copy-label') || '';
        const ok = await UI.copyText(addr);
        UI.toast(ok ? t('toast.copyOk', { label: label }) : t('toast.copyFail'), ok ? 'ok' : 'bad');
        if (ok) {
          btn.classList.add('is-copied');
          global.setTimeout(() => btn.classList.remove('is-copied'), 1200);
        }
      });
    });
  }

  /* ------------------------------------------------------------------ start up */

  /**
   * Start the application: detect the pointer, wire everything, paint the
   * initial state and kick off the three things that can only be learned
   * asynchronously (whether OPFS is usable, whether a neural model is
   * installed, and whether cross-origin isolation already exists). Every one of
   * those three failing is an ordinary outcome, never a blocked page.
   * @returns {void}
   */
  function boot() {
    if (!global.document || !$('#dropzone')) return;
    applyPointer();
    // …and keep listening: the same tab can be a phone and then a desktop again
    try {
      const mq = global.matchMedia && global.matchMedia('(hover: none) and (pointer: coarse)');
      if (mq && mq.addEventListener) {
        mq.addEventListener('change', () => {
          applyPointer();
          paintDropzone();
        });
      }
    } catch (e) { /* very old browsers: the boot value stands */ }
    global.RSi18n.setLang(global.RSi18n.detect(), { apply: false });
    global.RSi18n.apply();
    paintDropzone();
    UI.bindDialogs();
    bindHeader();
    bindDropzone();
    bindControls();
    bindFooter();
    setAB('restored');           // a first listen should be the restored version
    refreshAllText();
    initStreaming();
    initNeural();
    initCOI();
  }

  /**
   *
   * Hook into `coi-serviceworker.js`'s registration result (see root-level
   * file): if a one-time reload is still needed to actually pick up the
   * cross-origin isolation headers, say so for a moment before it happens —
   * a page that silently reloads itself looks broken, not helpful.
   *
   * @returns {void}
   */
  function initCOI() {
    const coi = global.RSCOI;
    if (!coi || !coi.ready || typeof coi.ready.then !== 'function') return;
    coi.ready.then((info) => {
      if (!info || !info.needsReload || typeof info.confirmReload !== 'function') return;
      UI.toast(t('coi.reloading'), null, 1400);
      global.setTimeout(() => info.confirmReload(), 650);
    }).catch(() => { /* isolation is an optional speed-up, never required */ });
  }

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  /**
   * Everything the application exposes for tests and for other pages: the
   * two state objects, the job bar, the lifecycle entry points, the file
   * queue, the per-card parameter accessors, the one-tap helpers and the
   * phone-only A/B button.
   * @typedef {Object} RSAppApi
   * @property {RSApp.AppState} State - the live session state.
   * @property {RSApp.AppConfig} CONFIG - the tunables.
   * @property {RSApp.JobController} Job - the batch progress bar.
   * @property {function(): void} boot - wire the page (idempotent).
   * @property {function((FileList|File[])): Promise<void>} addFiles - queue files.
   * @property {function(RSApp.Card, boolean=): Promise<void>} prepareCard - decode and analyse one card.
   * @property {function(RSApp.Card, Object=): Promise<RSApp.RenderResult>} renderCard - render one card.
   * @property {function(): Promise<void>} processAll - render every stale card.
   * @property {function(): Promise<void>} downloadZip - render, pack and save.
   * @property {function(number): void} adoptRecommendedPower - take a profile's power once.
   * @property {function(RSApp.Card, ?string, ?number, ?number): void} setCardWork - per-card progress.
   * @property {function(RSApp.Card): void} revealCard - scroll a card into view.
   * @property {function(): boolean} isTouchDevice - coarse pointer in use.
   * @property {function(): void} refreshAllText - re-translate the page.
   * @property {function(string): void} setAB - original / restored / compare.
   * @property {function(RSApp.Card): Promise<void>} ensurePlaying - monitor a card.
   * @property {function(): void} clearAll - empty the list.
   * @property {function(RSApp.Card): void} removeCard - drop one card.
   * @property {function(RSApp.Card): Promise<void>} refreshPreview - re-render a preview.
   * @property {RSApp.ParamAccessors} P - the parameter accessors.
   * @property {function(): Promise<void>} initStreaming - probe OPFS and the codecs.
   * @property {function(): void} initCOI - the cross-origin-isolation probe.
   * @property {function(): Promise<void>} initNeural - probe the neural worker.
   * @property {function((number|number[]), (Element|null)=): string} vibrate
   *   - haptic feedback: a vibration where the platform has one, a
   *   micro-animation where it does not.
   * @property {function(RSApp.Card): boolean} openInspector - the phone's
   *   bottom sheet with this card's controls.
   * @property {function(): void} closeInspector - dismiss it.
   * @property {RSUI.BottomSheetApi} sheet - the drawer module itself.
   * @property {function(): Promise<void>} applyMagicFix - the one-tap restoration.
   * @property {function(): void} armMagicSettings - set the Magic Fix state.
   * @property {RSApp.FabController} FAB - the floating A/B button.
   *
   * @type {RSAppApi}
   */
  const API = {
    State, CONFIG, Job, boot, addFiles, prepareCard, renderCard, processAll, downloadZip,
    adoptRecommendedPower, setCardWork, revealCard, isTouchDevice, refreshAllText,
    setAB, ensurePlaying, clearAll, removeCard, refreshPreview, P,
    initStreaming, initCOI, initNeural,
    vibrate, applyMagicFix, armMagicSettings, FAB,
    openInspector, closeInspector, sheet: UI.sheet,
  };
  global.RSApp = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
