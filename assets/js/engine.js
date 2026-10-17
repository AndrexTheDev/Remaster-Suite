/* =============================================================================
 * Remaster Suite — the audio engine
 * -----------------------------------------------------------------------------
 * Two ways to run the exact same DSP:
 *
 *   live    — an AudioContext + AudioWorkletNode, used for the A/B monitor.
 *   offline — an OfflineAudioContext, used for the real, full-length render
 *             that ends up in the WAV/MP3 file.
 *
 * The chain is minimum-phase throughout, so the two are sample-for-sample
 * identical: what you hear is what you save. The one stage that delays is the
 * de-clicker, whose look-ahead shifts the output by 65 samples (its spike window
 * plus the millisecond the ring behind it is fitted over)
 * at 48 kHz while it is engaged — the same in both paths, and the A/B crossfade
 * delays its dry side with it, so nothing about the comparison changes.
 * ========================================================================== */
/**
 * @fileoverview The audio engine — exported as the constructor
 * `global.RSAudioEngine` *and* as the ready-made singleton
 * `global.RSEngine`, which is what the app actually uses.
 *
 * Runs the one DSP chain in the one worklet, two ways: live (`AudioContext` +
 * `AudioWorkletNode`, for the A/B monitor) and offline (`OfflineAudioContext`,
 * for the file the user saves). The chain is minimum-phase throughout, so both
 * paths are sample-for-sample identical — what is heard is what is saved. The
 * single stage that delays is the de-clicker, whose look-ahead shifts the
 * output by 65 samples at 48 kHz while it is engaged; that is the same in both
 * paths, and the A/B crossfade delays its dry side with it, so nothing about
 * the comparison changes.
 *
 * `render()` is the whole-file offline path. `renderChunked()` is its
 * bounded-memory sibling for long files and phones: independent spans, joined
 * with a level-preserving crossfade, streaming each finished chunk out through
 * `onChunk` instead of holding the whole file in memory.
 *
 * @module RSEngine
 */
(function (global) {
  'use strict';

  /**
   * Repository-relative path of the AudioWorklet module both paths load.
   * @type {string}
   */
  const WORKLET = 'assets/worklets/remaster-processor.js';
  /**
   * AudioParam glide for live parameter changes, in seconds. Short enough to
   * feel immediate, long enough not to click when a slider moves.
   * @type {number}
   */
  const SMOOTH = 0.02;

  /**
   * A flat parameter map, as the worklet's `parameterDescriptors` expects it:
   * name → value, one entry per AudioParam. Names and ranges are the
   * worklet's own (`assets/worklets/remaster-processor.js`), and the map is
   * built by `RSPresets` — see its `ParamMap` typedef for the full list, the
   * units and the ceilings each profile may set.
   * @typedef {Object<string, number>} EngineParams
   */

  /**
   * One state notification from the monitor, emitted on every transport change
   * (play, pause, seek, bypass flip).
   * @typedef {Object} EngineState
   * @property {boolean} playing - whether audio is currently running.
   * @property {number} position - playback position in seconds.
   * @property {boolean} bypass - `true` while the untouched original is heard.
   */

  /**
   * Where a render puts its result. `onProgress` is called with a monotonic
   * 0…1 share; the *rate* of those calls is what `progressSteps` controls.
   * @typedef {Object} RenderOptions
   * @property {function(number): void} [onProgress] - progress callback, 0…1.
   * @property {number} [progressSteps] - how many progress reports a render of
   *   this length may send; defaults to one per eight seconds, clamped to
   *   2…30. Only affects reporting, never the audio.
   * @property {Object} [neural] - optional Stage-7 coupling: when present and
   *   `RSNeural` is loaded, the network predicts a per-band dB gain curve
   *   *before* the graph starts. `bandsHz` selects the bands (default: the six
   *   from 8 kHz up) and `amount` scales the curve (default 1). Any failure
   *   leaves the curve out and the render identical to the pure-DSP path.
   * @property {Object} [stage0] - optional **pre-DSP** neural stage: when
   *   present and `RSNeural.denoiseChannels()` is loaded, the source is run
   *   through the worker (denoise, or stem separation) *before* a single DSP
   *   stage sees it — see {@link RSEngine.render}. `mode` picks the model
   *   (`'denoise'` by default), `stems` narrows a separation. Any failure
   *   leaves the render identical to the pure-DSP path.
   */

  /**
   * The whole-file render result.
   * @typedef {Object} RenderResult
   * @property {Float32Array[]} channels - one channel per array, full length.
   * @property {number} sampleRate - the rate the graph rendered at.
   * @property {AudioBuffer} buffer - the same audio as an `AudioBuffer`, which
   *   the live monitor can be handed without a copy.
   */

  /**
   * The progress report a chunked render makes once per chunk.
   * @typedef {Object} ChunkInfo
   * @property {number} startSample - first sample of this chunk, in the
   *   *output* domain (0 = start of the file).
   * @property {number} endSample - one past this chunk's last output sample;
   *   the next chunk starts here, so `end - start` is exactly this chunk's
   *   length and the chunks tile the file without overlap.
   * @property {number} totalSamples - the whole file's output length, so a
   *   sink can size a header before the last chunk arrives.
   * @property {boolean} isLast - `true` for the final chunk; a streaming writer
   *   uses it to finalise the container.
   */

  /**
   * Options for `renderChunked()`. Everything here is optional; the defaults
   * are tuned for a phone rendering a long file.
   * @typedef {Object} ChunkedRenderOptions
   * @property {number} [chunkSeconds=10] - nominal chunk length in seconds.
   * @property {number} [crossfadeMs=50] - length of the crossfade that joins
   *   two independently rendered chunks. Linear (gain-preserving) weights, not
   *   equal-power: the two sides are two renders of the *same* input, so
   *   equal-power would add up to +3 dB at the seam.
   * @property {number} [prerollSeconds=1] - extra audio rendered *before* each
   *   chunk and thrown away, so the chain's stateful stages (hum PLL, detectors,
   *   resampler) settle before the kept audio starts.
   * @property {number} [minChunkSeconds=2] - floor for the chunk length when
   *   the memory guard asks for something smaller.
   * @property {{suggestChunkSeconds: Function}} [memoryGuard] - override for
   *   `RSMemoryGuard` (tests pass a fake); defaults to the global when loaded.
   * @property {function(Float32Array[], ChunkInfo): (void|Promise<void>)} [onChunk]
   *   - streaming sink, called once per finished chunk. Passing it is what
   *   keeps `channels` out of the result — that is the whole point of the
   *   streaming path. A promise returned here is awaited before the next chunk
   *   renders, so a disk write throttles the render.
   * @property {function(number): void} [onProgress] - progress callback, 0…1,
   *   called once per chunk.
   * @property {Object} [neural] - same Stage-7 coupling as {@link RenderOptions},
   *   computed once for the whole file, never per chunk.
   */

  /**
   * The chunked render result. `channels` is only populated when the caller
   * did *not* pass `onChunk` — kept so the method doubles as a drop-in,
   * memory-saving alternative without a sink (the test suites rely on it).
   * @typedef {Object} ChunkedRenderResult
   * @property {Float32Array[]} [channels] - the assembled file, only without
   *   an `onChunk` sink.
   * @property {number} sampleRate - the rate the spans rendered at.
   * @property {number} samples - total output length, in samples.
   * @property {number} chunks - how many chunks the file was rendered in; the
   *   number the scale rows report.
   */

  /**
   * How much of a render's progress bar the pre-DSP neural stage owns when it
   * runs. Stage 0 is one inference per chunk per channel and is the slowest
   * thing in the whole pipeline, so it gets the first third rather than a
   * rounding error at the start of the bar.
   * @type {number}
   */
  const STAGE0_SHARE = 0.35;

  /**
   * Run the optional pre-DSP stage over a set of channels.
   *
   * This is the seam `render()` and `renderChunked()` share: the stage either
   * comes back with audio at its own rate (48 kHz — the models' native one),
   * or with a reason and no audio. In the second case the caller renders the
   * source untouched; an unavailable model must never make a render fail or
   * sound like a half-processed splice.
   * @param {Float32Array[]} channels - source channels.
   * @param {number} rate - their sample rate in Hz.
   * @param {?Object} stage0 - the caller's `opts.stage0`.
   * @param {function(number): void} [onProgress] - share of *this* stage.
   * @returns {Promise<{applied: boolean, channels: Float32Array[], rate: number,
   *   info: Object}>} `applied:false` carries the untouched source.
   */
  async function runStage0(channels, rate, stage0, onProgress) {
    const untouched = { applied: false, channels, rate, info: { applied: false, reason: 'not-requested' } };
    if (!stage0) return untouched;
    const N = global.RSNeural;
    if (!N || typeof N.denoiseChannels !== 'function') return Object.assign({}, untouched, { info: { applied: false, reason: 'unavailable' } });
    let res;
    try {
      res = await N.denoiseChannels(channels, Object.assign({}, stage0, {
        sampleRate: rate,
        onProgress: typeof onProgress === 'function' ? onProgress : undefined,
      }));
    } catch (err) {
      return Object.assign({}, untouched, { info: { applied: false, reason: 'stage-error: ' + ((err && err.message) || err) } });
    }
    if (!res || !res.applied || !res.channels || !res.channels.length) {
      return Object.assign({}, untouched, { info: { applied: false, reason: (res && res.reason) || 'stage-fallback', stats: res && res.stats } });
    }
    return {
      applied: true,
      channels: res.channels,
      rate: res.rate || rate,
      info: Object.assign({ applied: true, rate: res.rate || rate }, res.stats || {}),
    };
  }

  /**
   * The engine: one live monitor and, per offline call, its own render graph.
   *
   * Lifetime rule that matters: the worklet module is registered *per context*
   * (`_loaded` is a `WeakSet`), so a new `OfflineAudioContext` per chunk and a
   * long-lived live context can coexist without a double `addModule`.
   */
  class AudioEngine {
    /**
     * Create the engine with nothing connected: no context, no node, no
     * buffer, no handlers. `init()` is what opens the audio context, so an
     * engine can be constructed (and its API used) on a page that never gets
     * one — the Node suites rely on exactly that.
     */
    constructor() {
      this.ctx = null;
      this.node = null;
      this.gain = null;
      this.src = null;
      this.buffer = null;
      this._loaded = new WeakSet();       // worklet module loaded per context
      this.playing = false;
      this.startedAt = 0;
      this.offset = 0;
      this.loop = false;
      this.bounds = null;                    // {start, end} preview window, seconds
      this.params = null;
      this.bypass = false;
      this.compareTimer = null;
      this._tickHandlers = new Set();
      this._stateHandlers = new Set();
      this._raf = 0;
    }

    /* ------------------------------------------------------------ plumbing */

    /**
     * Create (or reuse) the live context and install the processor in it. Must
     * be called from a user gesture on iOS/Safari, which is why the UI calls it
     * from the play button and never on page load. Idempotent: a second call
     * returns the same context.
     * @returns {Promise<AudioContext>} the running context.
     * @throws {Error} `'Web Audio unavailable'` when the browser has no
     *   `AudioContext` constructor at all.
     */
    async init() {
      if (this.ctx && this._loaded.has(this.ctx)) return this.ctx;
      const Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio unavailable');
      if (!this.ctx) {
        this.ctx = new Ctor({ latencyHint: 'playback' });
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
      }
      await this._loadWorklet(this.ctx);
      if (!this.node) {
        this.node = new global.AudioWorkletNode(this.ctx, 'remaster-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
        });
        this.node.connect(this.gain);
      }
      if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) { /* gesture needed */ } }
      return this.ctx;
    }

    /**
     * Register the processor module with one context, at most once per context.
     * @private
     * @param {BaseAudioContext} ctx - the context to load into (live or offline).
     * @returns {Promise<void>} resolves once `addModule` settled or the context
     *   was already marked as loaded.
     * @throws {Error} `'AudioWorklet unavailable'` when the browser lacks
     *   `audioWorklet` (old Safari), or `'worklet-load-failed'` when `addModule`
     *   rejects — with the original error attached as `.cause`.
     */
    async _loadWorklet(ctx) {
      if (this._loaded.has(ctx)) return;
      if (!ctx.audioWorklet) throw new Error('AudioWorklet unavailable');
      try {
        const url = global.location ? new URL(WORKLET, global.location.href).href : WORKLET;
        await ctx.audioWorklet.addModule(url);
        this._loaded.add(ctx);            // per context, not per engine
      } catch (err) {
        const e = new Error('worklet-load-failed');
        e.cause = err;
        throw e;
      }
    }

    /**
     * Sample rate of the live context, or the 48000 Hz default before `init()`
     * ran — callers use it to convert between seconds and samples without
     * waiting for a context to exist.
     * @type {number}
     */
    get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

    /* --------------------------------------------------------------- params */

    /**
     * Apply a parameter set to the live node. The map is merged into the last
     * one applied, so a caller can send a single changed value without
     * resending everything. Unknown names are skipped (the worklet owns the
     * list), non-finite values are skipped (a broken file must never reach a
     * k-rate parameter), and each value glides rather than jumping.
     * @param {EngineParams} params - the values to apply.
     * @param {number} [glide=0.02] - time constant for the glide, in seconds.
     * @returns {void}
     */
    applyParams(params, glide) {
      this.params = Object.assign({}, this.params || {}, params || {});
      if (!this.node) return;
      const t = this.ctx.currentTime;
      const tau = glide === undefined ? SMOOTH : glide;
      for (const name of Object.keys(this.params)) {
        const p = this.node.parameters.get(name);
        if (!p) continue;
        const v = Number(this.params[name]);
        if (!isFinite(v)) continue;
        try { p.setTargetAtTime(v, t, tau); } catch (e) { p.value = v; }
      }
    }

    /**
     * A/B switch: `true` plays the untouched original, `false` the
     * restoration. Implemented inside the worklet (`bypass` parameter), so the
     * flip happens in the audio thread at a known place in the chain and never
     * clicks.
     * @param {boolean} on - `true` for the original.
     * @param {number} [glide=0.01] - glide time constant in seconds.
     * @returns {void}
     */
    setBypass(on, glide) {
      this.bypass = !!on;
      const p = this.node && this.node.parameters.get('bypass');
      if (p) p.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, glide === undefined ? 0.01 : glide);
      this._notifyState();
    }

    /**
     * Auto A/B: flip the comparison every `seconds` so the ear keeps its
     * bearings and a long listening session cannot be fooled by its own
     * adaptation. Calling it again restarts the timer; `on === false` stops it.
     * @param {boolean} on - whether to keep flipping.
     * @param {number} [seconds=4] - flip period, floored at one second.
     * @returns {void}
     */
    setCompare(on, seconds) {
      if (this.compareTimer) { global.clearInterval(this.compareTimer); this.compareTimer = null; }
      if (!on) return;
      const period = Math.max(1, seconds || 4) * 1000;
      this.compareTimer = global.setInterval(() => this.setBypass(!this.bypass, 0.012), period);
    }

    /**
     * Set the monitor's output gain — a listening level, not part of the
     * rendered file (the render graph never sees this node).
     * @param {number} v - linear gain, clamped to `0…2`.
     * @returns {void}
     */
    setVolume(v) {
      if (this.gain) this.gain.gain.setTargetAtTime(Math.max(0, Math.min(2, v)), this.ctx.currentTime, 0.02);
    }

    /* ---------------------------------------------------------- monitoring */

    /**
     * Hand the engine a freshly decoded buffer for live monitoring. Stops any
     * playback first and parks at the start of the preview window — correct for
     * "a new file was dropped", and the reason `switchBuffer()` exists for the
     * other case.
     * @param {AudioBuffer} buffer - the decoded audio.
     * @param {RSAnalyzer.PreviewWindow} [window] - the window to monitor;
     *   defaults to the whole file.
     * @returns {void}
     */
    setBuffer(buffer, window) {
      this.stop();
      this.buffer = buffer;
      this.offset = window ? window.start : 0;
      this.bounds = window || { start: 0, end: buffer ? buffer.duration : 0 };
    }

    /**
     * Swap the buffer being monitored for a different render of the *same*
     * material — e.g. the mobile A/B/C compare control jumping between the
     * original, the DSP render and the neural-assisted render — without
     * losing the listener's place or interrupting playback. A plain
     * `setBuffer()` always restarts at the window's start, which is correct
     * for "load a new file" but wrong for "keep listening, just change which
     * render this is"; this is the one call that keeps going from exactly
     * where the ear already was.
     * @param {AudioBuffer} buffer - the other render of the same material.
     * @param {RSAnalyzer.PreviewWindow} [window] - bounds to keep; defaults to
     *   the current ones, or the whole new buffer.
     * @returns {void}
     */
    switchBuffer(buffer, window) {
      if (!buffer) return;
      const wasPlaying = this.playing;
      const pos = this.position;
      const bounds = window || this.bounds || { start: 0, end: buffer.duration };
      this.buffer = buffer;
      this.bounds = bounds;
      this.offset = Math.max(bounds.start, Math.min(bounds.end, pos));
      if (wasPlaying) {
        this._stopSource();
        this.playing = false;
        this.play();
      } else {
        this._notifyState();
      }
    }

    /**
     * Start (or resume) monitoring. Initialises the context if needed, loops
     * within the preview window when `setLoop(true)` asked for it, and starts
     * the position tick. A no-op when no buffer was handed over, and while
     * something is already playing.
     * @returns {Promise<void>} resolves once playback has started.
     */
    async play() {
      if (!this.buffer) return;
      await this.init();
      if (this.playing) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      if (this.loop && this.bounds) {
        src.loop = true;
        src.loopStart = this.bounds.start;
        src.loopEnd = this.bounds.end;
      }
      src.connect(this.node);
      src.onended = () => {
        if (this.src === src && !this.loop) {
          this.offset = this.bounds ? this.bounds.start : 0;
          this._stopSource();
          this.playing = false;
          this._notifyState();
        }
      };
      const from = Math.min(this.offset, Math.max(0, this.buffer.duration - 0.02));
      src.start(0, from);
      this.src = src;
      this.playing = true;
      this.startedAt = this.ctx.currentTime - from;
      this._notifyState();
      this._startTick();
    }

    /**
     * Pause and remember the position, so `play()` continues from there rather
     * than from the window start. A no-op when nothing is playing.
     * @returns {void}
     */
    pause() {
      if (!this.playing) return;
      this.offset = this.position;
      this._stopSource();
      this.playing = false;
      this._notifyState();
    }

    /**
     * Stop playback and rewind to the start of the preview window. Used before
     * loading a new buffer and when the card is closed.
     * @returns {void}
     */
    stop() {
      this._stopSource();
      this.playing = false;
      this._notifyState();
    }

    /**
     * Release the running source node and the position tick, ignoring errors
     * from an already-stopped node — `stop()` on a finished source throws in
     * some browsers, and that must never reach the UI.
     * @private
     * @returns {void}
     */
    _stopSource() {
      if (this.src) {
        try { this.src.onended = null; this.src.stop(); } catch (e) { /* already stopped */ }
        try { this.src.disconnect(); } catch (e) { /* ignore */ }
        this.src = null;
      }
      if (this._raf) { global.cancelAnimationFrame(this._raf); this._raf = 0; }
    }

    /**
     * Jump to a position, resuming playback there when something was playing
     * (the source node cannot be repositioned, so it is replaced).
     *
     * The target is clamped to the loaded file, and a call before any buffer
     * exists is a no-op — the waveform, the seek strip and the arrow keys all
     * land here, including while a card is still being decoded.
     * @param {number} seconds - target position in seconds, clamped to
     *   `0…buffer.duration`.
     * @returns {void}
     */
    seek(seconds) {
      const total = this.buffer ? this.buffer.duration : 0;
      const t = Math.max(0, Math.min(total, seconds));
      this.offset = t;
      if (this.playing) {
        this._stopSource();
        this.playing = false;
        this.play();
      } else {
        this._notifyState();
      }
    }

    /**
     * Loop within the preview window (`true`) or run through it once and park
     * (`false`). Applied to a running source immediately.
     * @param {boolean} on - whether to loop.
     * @returns {void}
     */
    setLoop(on) { this.loop = !!on; if (this.src) { this.src.loop = !!on && !!this.bounds; } }

    /**
     * Current playback position in seconds, derived from the audio clock
     * rather than from a timer (drift-free, and correct after a seek). Wraps
     * inside the bounds while looping, and is clamped to the file either way.
     * Reads `0` before a buffer exists.
     * @type {number}
     */
    get position() {
      if (!this.buffer) return 0;
      if (!this.playing || !this.ctx) return this.offset;
      let t = this.ctx.currentTime - this.startedAt;
      const dur = this.buffer.duration;
      if (this.loop && this.bounds) {
        const span = Math.max(0.05, this.bounds.end - this.bounds.start);
        if (t > this.bounds.end) t = this.bounds.start + ((t - this.bounds.start) % span);
      }
      return Math.max(0, Math.min(dur, t));
    }

    /**
     * Subscribe to per-frame position updates while something is playing — one
     * call per animation frame, which is what the playhead is drawn from.
     * @param {function(number, number): void} fn - `(position, duration)` in
     *   seconds.
     * @returns {function(): void} `unsubscribe()`.
     */
    onTick(fn) { this._tickHandlers.add(fn); return () => this._tickHandlers.delete(fn); }
    /**
     * Subscribe to transport changes (play, pause, seek, bypass, end of
     * window) — the events a button's label is derived from, rather than
     * polled.
     * @param {function(EngineState): void} fn - called with the new state.
     * @returns {function(): void} `unsubscribe()`.
     */
    onState(fn) { this._stateHandlers.add(fn); return () => this._stateHandlers.delete(fn); }

    /**
     * Emit the current transport state to every subscriber. Never throws out:
     * a subscriber with a bug must not stop the transport.
     * @private
     * @returns {void}
     */
    _notifyState() { for (const fn of this._stateHandlers) fn({ playing: this.playing, position: this.position, bypass: this.bypass }); }

    /**
     * Start the animation-frame loop that reports positions, and end playback
     * cleanly when a non-looping window has been played out.
     * @private
     * @returns {void}
     */
    _startTick() {
      /**
       * One animation frame: report the current position to every tick
       * listener, and — when a non-looping window has just run out — park the
       * transport back at the window's start, stop the source and announce it.
       * Re-armed from inside itself for as long as playback lasts.
       * @returns {void}
       */
      const step = () => {
        if (!this.playing) return;
        const pos = this.position;
        for (const fn of this._tickHandlers) fn(pos, this.buffer ? this.buffer.duration : 0);
        if (!this.loop && this.bounds && pos >= this.bounds.end - 0.02) {
          // free run is over: park at the start of the preview
          this.offset = this.bounds.start;
          this._stopSource();
          this.playing = false;
          this._notifyState();
          return;
        }
        this._raf = global.requestAnimationFrame(step);
      };
      this._raf = global.requestAnimationFrame(step);
    }

    /* ------------------------------------------------------ offline render */

    /**
     * Render through the real processor into plain Float32Array channels.
     * @param {(Float32Array[]|AudioBuffer)} source - audio to render;
     *   channels[0] must be the longest of the channels, and every channel the
     *   same length.
     * @param {number} sampleRate - target sample rate in Hz, clamped to
     *   8000…192000; a source `AudioBuffer` contributes its own rate as the
     *   input side.
     * @param {EngineParams} params - the parameter map (`RSPresets`).
     * @param {RenderOptions} [opts] - progress and the optional neural curve.
     * @returns {Promise<RenderResult>} channels, their rate, and the same audio
     *   as an `AudioBuffer`.
     * @throws {Error} `'OfflineAudioContext unavailable'` when the browser has
     *   no offline context, and the worklet-load errors of `init()` otherwise.
     */
    async render(source, sampleRate, params, opts) {
      const o = opts || {};
      // accept either an AudioBuffer or an array of Float32Array channels
      const isBuffer = !!(source && source.getChannelData && source.sampleRate);
      let srcChans = isBuffer
        ? (() => { const a = []; for (let c = 0; c < source.numberOfChannels; c++) a.push(source.getChannelData(c)); return a; })()
        : source;
      let inRate = isBuffer ? source.sampleRate : Math.max(8000, Math.min(192000, Math.round(sampleRate || 48000)));
      const nCh = Math.min(2, Math.max(1, srcChans.length));
      const sr = Math.max(8000, Math.min(192000, Math.round(sampleRate || inRate)));
      const Ctor = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      if (!Ctor) throw new Error('OfflineAudioContext unavailable');

      // Stage 0 — the pre-DSP neural pass. It runs *before* the graph exists,
      // on the dry source, and hands back audio at the model's own rate; the
      // graph below resamples that to `sr` exactly as it would resample any
      // source buffer whose rate differs. `onProgress` is split between the
      // two halves so the card's bar keeps moving during the slow half.
      const stage0 = await runStage0(srcChans, inRate, o.stage0, o.onProgress
        ? (p) => { try { o.onProgress(Math.max(0, Math.min(1, p)) * STAGE0_SHARE); } catch (e) { /* report only */ } }
        : undefined);
      srcChans = stage0.channels;
      inRate = stage0.rate;
      const srcLen = srcChans[0].length;
      // output length follows the target rate: playing a buffer whose rate differs
      // from the context resamples it, which is exactly what we want here
      const len = Math.max(1, Math.round((srcLen * sr) / inRate));
      /** Map the graph's own 0…1 onto the bar's remaining share. @param {number} p - graph progress. @returns {number} bar progress. */
      const graphProgress = (p) => (stage0.applied ? STAGE0_SHARE + p * (1 - STAGE0_SHARE) : p);

      // Optional neural Stage-7 coupling (see NeuralAirCurve in the worklet,
      // and neural-worker.js's superresCurve): runs once, up front, on a mono
      // downmix of the dry source — it only ever predicts a dB curve, never a
      // waveform, so it has to finish before the worklet graph starts, not
      // during it. Anything short of a clean, non-empty result (the model
      // unavailable, no weights installed, a thrown error, RSNeural missing
      // entirely because the script was not loaded) leaves `neuralCurve` null
      // and the render proceeds exactly as if `opts.neural` had not been
      // passed — this call can never make a render fail or sound different
      // from the pure-DSP path by surprise.
      let neuralCurve = null;
      if (o.neural && global.RSNeural && typeof global.RSNeural.superres === 'function') {
        try {
          const bandsHz = (o.neural.bandsHz && o.neural.bandsHz.length) ? o.neural.bandsHz : [8000, 10000, 12500, 16000, 19000, 22000];
          const mono = nCh > 1
            ? (() => {
              const m = new Float32Array(srcLen);
              for (let c = 0; c < nCh; c++) { const ch = srcChans[c]; for (let i = 0; i < srcLen; i++) m[i] += ch[i] / nCh; }
              return m;
            })()
            : srcChans[0];
          const r = await global.RSNeural.superres(mono, bandsHz);
          if (r && r.applied && Array.isArray(r.gainsDb) && r.gainsDb.length) neuralCurve = { bandsHz, gainsDb: r.gainsDb };
        } catch (e) { /* fall back to the pure DSP path, silently and completely */ }
      }

      const ctx = new Ctor({ numberOfChannels: nCh, length: len, sampleRate: sr });
      await this._loadWorklet(ctx);
      const node = new global.AudioWorkletNode(ctx, 'remaster-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [nCh],
        channelCount: nCh,
        channelCountMode: 'explicit',
      });
      if (neuralCurve) {
        node.port.postMessage({ type: 'neuralAirCurve', bandsHz: neuralCurve.bandsHz, gainsDb: neuralCurve.gainsDb });
        // the caller's own params object is never mutated — only the copy the
        // worklet actually receives below picks up a non-zero trust amount,
        // and only when the caller did not already ask for a specific one
        const amount = (o.neural && isFinite(o.neural.amount)) ? o.neural.amount : 1;
        params = Object.assign({}, params);
        if (!(params.airNeural > 0)) params.airNeural = amount;
      }

      // source buffer built by hand, at its *own* rate: the graph resamples only
      // when the export rate really differs from the source rate
      const buf = ctx.createBuffer(nCh, srcLen, inRate);
      for (let c = 0; c < nCh; c++) buf.copyToChannel(srcChans[c], c, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(node);
      node.connect(ctx.destination);
      src.start(0);                    // without this the graph renders silence

      // set everything up front — k-rate params, no automation curve needed
      for (const name of Object.keys(params || {})) {
        const p = node.parameters.get(name);
        if (!p) continue;
        const v = Number(params[name]);
        if (!isFinite(v)) continue;
        try { p.setValueAtTime(v, 0); } catch (e) { p.value = v; }
      }

      const duration = len / sr;
      const steps = o.onProgress ? Math.max(2, Math.min(30, o.progressSteps || Math.ceil(duration / 8))) : 0;
      let next = 1;

      // OfflineAudioContext.suspend() is the only way to report progress during a
      // render — it must be scheduled *before* rendering starts.
      /**
       * Queue the next progress suspension, and the one after it:
       * `OfflineAudioContext.suspend()` only works when it is called *before*
       * the render starts, so the whole ladder is arranged up front and each
       * slot reports its position as it is reached.
       * @returns {void}
       */
      const schedule = () => {
        if (!steps || next > steps) return;
        const when = (duration * next) / (steps + 1);
        next++;
        if (when <= 0 || when >= duration) return;
        Promise.resolve()
          .then(() => ctx.suspend(when))
          .then(() => {
            if (o.onProgress) o.onProgress(graphProgress(when / duration));
            schedule();
            ctx.resume();
          })
          .catch(() => { /* suspend unsupported: render without progress */ });
      };
      schedule();

      const rendered = await ctx.startRendering();
      const out = [];
      for (let c = 0; c < rendered.numberOfChannels; c++) out.push(rendered.getChannelData(c));
      if (o.onProgress) o.onProgress(1);
      return { channels: out, sampleRate: rendered.sampleRate, buffer: rendered, stage0: stage0.info };
    }

    /**
     * Render through the real processor the same way `render()` does, but in
     * independent, bounded-memory chunks instead of one whole-file pass. A
     * 96 kHz FLAC or a multi-hour DJ mix rendered in one `OfflineAudioContext`
     * call needs its *entire* output resident in memory at once — Web Audio
     * has no API to read a partial result mid-render — which is exactly the
     * kind of allocation a phone cannot absorb. This method never allocates
     * more than a few chunks' worth of audio at a time.
     *
     * Each chunk gets its own short `OfflineAudioContext` and a fresh worklet
     * instance, rendered over a span a little wider than its nominal output:
     * `prerollSeconds` of extra audio *before* it (clamped to whatever came
     * before, 0 for the first chunk) gives the DSP chain's own stateful
     * stages — the mains-hum PLL, the declick/declip detectors, the resampler
     * — a little time to settle before the kept audio begins, and up to one
     * crossfade length of extra audio *after* it (0 for the last chunk) is
     * kept as a lookahead so two independently-rendered chunks can be
     * blended with a linear (level-preserving) crossfade instead of simply butted
     * together at a hard, audible seam.
     *
     * This is a real, honest trade-off, not a free lunch: stage state is
     * *not* carried continuously across a chunk boundary the way one
     * `render()` pass does it, only approximated by letting it resettle
     * during the preroll — a stage with a multi-second time constant (the
     * long-term auto-level loudness match, the hum PLL's lock time) will not
     * sound bit-for-bit identical, chunked vs. whole, on material that
     * stresses it hard right at a boundary. True continuous state hand-off
     * would need the worklet itself to serialise and resume its internal
     * state across contexts, which is out of scope here — overlap with a
     * crossfade is the mechanism this method is built around. `render()`
     * itself is completely untouched by this method: it is a new, separate,
     * opt-in code path, not a replacement.
     *
     * @param {(Float32Array[]|AudioBuffer)} source - audio to render; the
     *   first channel must be the longest, and every channel the same length.
     * @param {number} sampleRate - target rate in Hz, clamped to 8000…192000.
     * @param {EngineParams} params - the parameter map (`RSPresets`).
     * @param {ChunkedRenderOptions} [opts] - chunk size, crossfade, preroll,
     *   the memory guard, the streaming sink and the progress callback.
     * @returns {Promise<{channels?: Float32Array[], sampleRate:number, samples:number, chunks:number}>}
     *   `channels` is only populated when the caller did not pass `onChunk`
     *   (kept so the method is still usable as a drop-in, memory-saving
     *   alternative without a sink — tests rely on this). The entire point
     *   of `onChunk`/a streaming sink is to never need that full array.
     * @throws {Error} `'OfflineAudioContext unavailable'` on a browser without
     *   one; otherwise the chunk size, the crossfade and the preroll all have
     *   safe defaults and cannot throw.
     */
    async renderChunked(source, sampleRate, params, opts) {
      const o = opts || {};
      const isBuffer = !!(source && source.getChannelData && source.sampleRate);
      const srcChans = isBuffer
        ? (() => { const a = []; for (let c = 0; c < source.numberOfChannels; c++) a.push(source.getChannelData(c)); return a; })()
        : source;
      const inRate = isBuffer ? source.sampleRate : Math.max(8000, Math.min(192000, Math.round(sampleRate || 48000)));
      const nCh = Math.min(2, Math.max(1, srcChans.length));
      const srcLen = srcChans[0].length;
      const sr = Math.max(8000, Math.min(192000, Math.round(sampleRate || inRate)));
      const len = Math.max(1, Math.round((srcLen * sr) / inRate));
      const Ctor = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      if (!Ctor) throw new Error('OfflineAudioContext unavailable');

      // Same Stage-7 neural coupling as render() (see the long comment
      // there) — computed exactly once, up front, for the whole file, not
      // once per chunk: it predicts one dB curve from a mono downmix of the
      // *entire* dry source, not something that varies chunk to chunk.
      let neuralCurve = null;
      if (o.neural && global.RSNeural && typeof global.RSNeural.superres === 'function') {
        try {
          const bandsHz = (o.neural.bandsHz && o.neural.bandsHz.length) ? o.neural.bandsHz : [8000, 10000, 12500, 16000, 19000, 22000];
          const mono = nCh > 1
            ? (() => {
              const m = new Float32Array(srcLen);
              for (let c = 0; c < nCh; c++) { const ch = srcChans[c]; for (let i = 0; i < srcLen; i++) m[i] += ch[i] / nCh; }
              return m;
            })()
            : srcChans[0];
          const r = await global.RSNeural.superres(mono, bandsHz);
          if (r && r.applied && Array.isArray(r.gainsDb) && r.gainsDb.length) neuralCurve = { bandsHz, gainsDb: r.gainsDb };
        } catch (e) { /* fall back to the pure DSP path, silently and completely */ }
      }
      let effectiveParams = params;
      if (neuralCurve) {
        const amount = (o.neural && isFinite(o.neural.amount)) ? o.neural.amount : 1;
        effectiveParams = Object.assign({}, params);
        if (!(effectiveParams.airNeural > 0)) effectiveParams.airNeural = amount;
      }

      const guard = o.memoryGuard || global.RSMemoryGuard || null;
      const baseChunkSeconds = Math.max(1, o.chunkSeconds || 10);
      const minChunkSeconds = Math.max(0.5, Math.min(baseChunkSeconds, o.minChunkSeconds || 2));
      const crossfadeLen = Math.max(0, Math.round(((o.crossfadeMs == null ? 50 : o.crossfadeMs) / 1000) * sr));
      const prerollLen = Math.max(0, Math.round(Math.min(baseChunkSeconds, Math.max(0.5, o.prerollSeconds || 1)) * sr));

      const accumulate = !o.onChunk;
      const outAccum = accumulate
        ? (() => { const a = []; for (let c = 0; c < nCh; c++) a.push(new Float32Array(len)); return a; })()
        : null;

      let pos = 0;
      let pendingTail = null; // Float32Array[nCh] | null — the previous chunk's rendered lookahead
      let chunkIndex = 0;
      const INPUT_MARGIN = 256; // input-domain samples of slack so rounding never starves the resampler
      // Stage 0 runs per span (its own chunk plan inside the span), so a long
      // file never has to hold a second full-length copy of itself. The spans
      // are independent as far as memory goes but not as far as the file is
      // concerned: once any span fails, the stage is off for the rest, so the
      // result is either denoised all the way through or consistently dry.
      let stage0On = !!o.stage0;
      const stage0Info = { applied: false, spans: 0, failed: 0, chunks: 0, underflows: 0, overflows: 0, ms: 0 };

      while (pos < len) {
        const nominalStart = pos;
        const requestedSeconds = (guard && typeof guard.suggestChunkSeconds === 'function')
          ? guard.suggestChunkSeconds(baseChunkSeconds, { min: minChunkSeconds, max: baseChunkSeconds })
          : baseChunkSeconds;
        const thisChunkLen = Math.max(1, Math.round(requestedSeconds * sr));
        const nominalEnd = Math.min(len, nominalStart + thisChunkLen);
        const isLast = nominalEnd >= len;
        const thisPreroll = nominalStart > 0 ? Math.min(nominalStart, prerollLen) : 0;
        const renderStart = nominalStart - thisPreroll;
        const tailLen = isLast ? 0 : Math.min(crossfadeLen, len - nominalEnd);
        const renderEnd = nominalEnd + tailLen;
        const spanOutLen = Math.max(1, renderEnd - renderStart);

        const inStart = Math.max(0, Math.min(srcLen, Math.round((renderStart * inRate) / sr)));
        const inEnd = Math.max(inStart + 1, Math.min(srcLen, Math.round((renderEnd * inRate) / sr) + INPUT_MARGIN));
        const spanSrcChans = [];
        for (let c = 0; c < nCh; c++) spanSrcChans.push(srcChans[c].subarray(inStart, inEnd));

        const span = await this._renderSpan(spanSrcChans, inRate, sr, nCh, effectiveParams, spanOutLen, neuralCurve, stage0On ? o.stage0 : null);
        const spanOut = span.channels;
        if (stage0On && span.stage0) {
          stage0Info.spans++;
          if (span.stage0.applied) {
            stage0Info.applied = true;
            stage0Info.chunks += span.stage0.chunks || 0;
            stage0Info.underflows += span.stage0.underflows || 0;
            stage0Info.overflows += span.stage0.overflows || 0;
            stage0Info.ms += span.stage0.ms || 0;
          } else {
            stage0Info.failed++;
            // One failed span disables the stage for the rest of the file: a
            // render that is denoised at the start and dry from the middle on
            // changes character where the failure happened, which is a worse
            // artefact than a consistently dry file with an honest report.
            stage0On = false;
          }
        }

        const keepStart = nominalStart - renderStart;
        const keepEnd = keepStart + (nominalEnd - nominalStart);
        const bodyLen = nominalEnd - nominalStart;
        const finalized = [];
        for (let c = 0; c < nCh; c++) {
          const f = new Float32Array(bodyLen);
          f.set(spanOut[c].subarray(keepStart, keepEnd));
          if (pendingTail && pendingTail[c] && pendingTail[c].length) {
            const n = Math.min(pendingTail[c].length, bodyLen);
            for (let i = 0; i < n; i++) {
              // Linear (equal-*gain*, weights sum to 1), not equal-power: the
              // two sides being blended are two independent renders of the
              // *same, correlated* underlying audio (this chunk's start and
              // the previous chunk's lookahead tail cover the same input
              // samples), not two decorrelated sources being mixed the way a
              // DJ transition is. An equal-power law (sin/cos weights) adds
              // constructively on correlated content — up to +3 dB at the
              // crossfade's midpoint for two literally identical signals,
              // easily provable by setting both sides equal and noting
              // sin(θ)+cos(θ) peaks at √2, not 1 — which is exactly backwards
              // for a seam that should stay inaudible. Linear weights sum to
              // 1 everywhere, so two identical (or near-identical, once the
              // chunk's own stateful stages have resettled) renders blend
              // with no level change at all, and two renders that still
              // differ interpolate smoothly between them.
              const t = (i + 0.5) / n;
              f[i] = f[i] * t + pendingTail[c][i] * (1 - t);
            }
          }
          finalized.push(f);
        }

        if (o.onChunk) {
          await o.onChunk(finalized, { startSample: nominalStart, endSample: nominalEnd, totalSamples: len, isLast });
        } else {
          for (let c = 0; c < nCh; c++) outAccum[c].set(finalized[c], nominalStart);
        }

        pendingTail = tailLen > 0
          ? (() => { const a = []; for (let c = 0; c < nCh; c++) a.push(spanOut[c].slice(keepEnd, keepEnd + tailLen)); return a; })()
          : null;

        if (o.onProgress) o.onProgress(nominalEnd / len);
        pos = nominalEnd;
        chunkIndex++;
        // yield between chunks so the event loop (and the GC) can catch up —
        // the same courtesy codecs.js's own streaming encoders already pay
        await new Promise((resolve) => global.setTimeout(resolve, 0));
      }

      const result = { sampleRate: sr, samples: len, chunks: chunkIndex, stage0: stage0Info };
      if (accumulate) result.channels = outAccum;
      return result;
    }

    /**
     * One short, independent render span — the unit `renderChunked()`
     * composes the whole file out of. Mirrors `render()`'s own node
     * setup/param-apply/startRendering sequence exactly, just scoped to a
     * slice of the source instead of all of it.
     * @private
     * @param {Float32Array[]} spanSrcChans - input slice, at `inRate`.
     * @param {number} inRate - sample rate of the input slice in Hz (the graph
     *   resamples when it differs from `sr`).
     * @param {number} sr - rate the span is rendered at, in Hz.
     * @param {number} nCh - channel count, 1 or 2.
     * @param {EngineParams} params - parameters for this span.
     * @param {number} spanOutLen - length of the span to render, in samples at
     *   `sr`.
     * @param {{bandsHz: number[], gainsDb: (number[]|Float64Array)}|null} neuralCurve
     *   - the optional pre-computed Stage-7 curve, posted to the worklet before
     *   the graph starts.
     * @param {?Object} [stage0] - the pre-DSP neural stage for this span, or
     *   `null` for the pure DSP route.
     * @returns {Promise<{channels: Float32Array[], stage0: ?Object}>} the
     *   rendered span, one array per channel, and what Stage 0 did to it.
     */
    async _renderSpan(spanSrcChans, inRate, sr, nCh, params, spanOutLen, neuralCurve, stage0) {
      // Stage 0 before the graph, on this span only — the span already carries
      // a preroll and a crossfade tail, so the neural stage and the DSP stage
      // see the same seams and the same context around them.
      let srcChans = spanSrcChans;
      let srcRate = inRate;
      let stageInfo = null;
      if (stage0) {
        const pre = await runStage0(srcChans, srcRate, stage0);
        srcChans = pre.channels;
        srcRate = pre.rate;
        stageInfo = pre.info;
      }
      const Ctor = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      const ctx = new Ctor({ numberOfChannels: nCh, length: spanOutLen, sampleRate: sr });
      await this._loadWorklet(ctx);
      const node = new global.AudioWorkletNode(ctx, 'remaster-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [nCh],
        channelCount: nCh,
        channelCountMode: 'explicit',
      });
      if (neuralCurve) node.port.postMessage({ type: 'neuralAirCurve', bandsHz: neuralCurve.bandsHz, gainsDb: neuralCurve.gainsDb });

      const spanLen = Math.max(1, srcChans[0].length);
      const buf = ctx.createBuffer(nCh, spanLen, srcRate);
      for (let c = 0; c < nCh; c++) buf.copyToChannel(srcChans[c], c, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(node);
      node.connect(ctx.destination);
      src.start(0);

      for (const name of Object.keys(params || {})) {
        const p = node.parameters.get(name);
        if (!p) continue;
        const v = Number(params[name]);
        if (!isFinite(v)) continue;
        try { p.setValueAtTime(v, 0); } catch (e) { p.value = v; }
      }

      const rendered = await ctx.startRendering();
      const out = [];
      for (let c = 0; c < rendered.numberOfChannels; c++) out.push(rendered.getChannelData(c));
      return { channels: out, stage0: stageInfo };
    }
  }

  /**
   * The constructor is exported too, so the tests can build an engine with a
   * stubbed Web Audio layer per case; the app itself only ever uses the
   * singleton below.
   */
  global.RSAudioEngine = AudioEngine;
  /**
   * The application's one live engine instance. Rendering does not use it —
   * `render()`/`renderChunked()` are stateless per call — so a long render can
   * run while this instance keeps monitoring.
   * @type {AudioEngine}
   */
  global.RSEngine = new AudioEngine();
  if (typeof module !== 'undefined' && module.exports) module.exports = AudioEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
