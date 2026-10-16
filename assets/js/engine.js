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
 * identical: what you hear is what you save. Three stages delay the output, and
 * their look-ahead adds up to the chain's total latency of 424 samples at 48 kHz
 * (the figure the suites measure): the de-clipper 271 + the de-clicker 65 (its
 * spike window plus the millisecond the ring behind it is fitted over) + the
 * true-peak limiter 88. The same in both paths, and the A/B crossfade delays its
 * dry side with it, so nothing about the comparison changes.
 * ========================================================================== */
(function (global) {
  'use strict';

  const WORKLET = 'assets/worklets/remaster-processor.js';
  const BRIDGE = 'assets/worklets/neural-bridge.js';
  const RING_MODULE = 'assets/js/ring-buffer.js';
  const NEURAL_HOP = 512;                    // the bridge's fixed delay, frames
  const NEURAL_WORKER = 'assets/js/neural-worker.js';
  const SMOOTH = 0.02;                       // AudioParam glide, seconds
  const MAX_LATENCY_S = 2;                   // the dry delay line's capacity

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.node = null;
      this.gain = null;
      this.src = null;
      this.buffer = null;
      this._loaded = new WeakSet();       // worklet module loaded per context
      this._neural = null;                 // offscreen ML worker + its ring buffers
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
      /* Latency, in samples. `latency` is what the monitor's dry path is delayed
       * by, and it is the sum of what is actually in the path: the worklet
       * reports its own look-ahead (declip, declick, true-peak limiter) through
       * its port, and an in-path neural stage reports its own via
       * setNeuralLatency(). Nothing else is added — a stage that is not in the
       * path contributes nothing. */
      this.latency = 0;
      this._workletLatency = 0;
      this._stageLatency = Object.create(null);   // neural stage → samples, in the path only
      this.dryDelay = null;
      this.wetGain = null;
      this.dryGain = null;
      this._bridge = null;                 // neural-bridge node, when the ML side is in the path
      this._bridgeLoaded = new WeakSet();
      this._neuralMode = 'auto';
    }

    /* ------------------------------------------------------------ plumbing */

    /**
     * Create the live context and load the processor. Needs a user gesture.
     * @param {{neural?: 'auto'|'passthrough'|'off', hopSize?: number}} [opts]
     *   'auto' (default): the ML side joins the monitor only when a stage has
     *   local weights; 'passthrough': the side joins without weights, so the
     *   ring path is exercised end to end (tests, sandboxes); 'off': DSP only.
     */
    async init(opts) {
      if (opts && opts.neural) this._neuralMode = opts.neural;
      if (this.ctx && this._loaded.has(this.ctx)) return this.ctx;
      const Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio unavailable');
      if (!this.ctx) {
        this.ctx = new Ctor({ latencyHint: 'playback' });
        // the decoder reuses this context for files (see codecs.js decodeTracked),
        // so the page holds one live context, not one per file
        if (global.RSCodecs && typeof global.RSCodecs.useLiveContext === 'function') {
          global.RSCodecs.useLiveContext(this.ctx);
        }
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
        // Wet path: the processor, then the output gain. Dry path: the source,
        // delayed by the total latency, then its own gain. The A/B switch crossfades
        // the two gains (see setBypass), so the two are always sample-aligned.
        this.wetGain = this.ctx.createGain();
        this.dryGain = this.ctx.createGain();
        this.dryDelay = this.ctx.createDelay(MAX_LATENCY_S);
        this.node.connect(this.wetGain);
        this.wetGain.connect(this.gain);
        this.dryDelay.connect(this.dryGain);
        this.dryGain.connect(this.gain);
        this.node.port.onmessage = (ev) => {
          const d = ev.data || {};
          if (d.type === 'latency') { this._workletLatency = d.samples | 0; this._updateLatency(); }
        };
        this._applyAB(this.bypass, 0);
      }
      // resume first: the play click must not wait for the ML side to come up
      if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) { /* gesture needed */ } }
      if (!this._neuralStarted) {
        this._neuralStarted = true;
        await this.startNeural({ mode: this._neuralMode });
      }
      return this.ctx;
    }

    /**
     * Put the ML side into the monitor: the probe decides which stages have
     * weights, the rings and the worker are opened (initNeural), and the
     * neural-bridge joins the wet path between the processor and the wet gain.
     * The bridge's delay (its fixed fill) and the model's own delay are then
     * part of `this.latency`, so the dry path follows them. Resolves to the
     * neural handle, or null when the side is not needed or cannot run here
     * (no SharedArrayBuffer, no Worker, no weights and not in 'passthrough').
     * @param {{mode?: string}} [o]
     */
    async startNeural(o) {
      const mode = (o && o.mode) || this._neuralMode;
      if (mode === 'off' || !this.ctx || !this.node || !this.wetGain) return null;
      let denoise = false, superRes = false;
      try {
        const probe = await this.probeModels();
        denoise = probe.stages.denoise.use === 'dfn3';
        superRes = probe.stages.superRes.use !== 'dsp';
      } catch (e) { denoise = superRes = false; }
      if (mode !== 'passthrough' && !denoise && !superRes) return null;
      const neural = await this.initNeural({
        hopSize: NEURAL_HOP,
        channels: 2,
        sampleRate: this.ctx.sampleRate,
        denoise: denoise,
        passThrough: true,
        onMessage: (d) => this._onNeuralMessage(d),
      });
      if (!neural) return null;
      try {
        await this._loadBridgeModules(this.ctx);
        const bridge = new global.AudioWorkletNode(this.ctx, 'neural-bridge', {
          numberOfInputs: 1, numberOfOutputs: 1,
          outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
        });
        this.node.disconnect(this.wetGain);
        this.node.connect(bridge);
        bridge.connect(this.wetGain);
        bridge.port.postMessage({
          type: 'rings', inputSab: neural.input.sab, outputSab: neural.output.sab, fill: neural.hop,
        });
        this._bridge = bridge;
        this._stageLatency.bridge = neural.hop;   // fixed: the bridge holds `hop` frames
        this._updateLatency();
        neural.worker.postMessage({ type: 'start' });
        return neural;
      } catch (err) {
        this.disposeNeural();
        return null;
      }
    }

    /**
     * The model probe (library-loader's probeModels), started once and kept: it
     * looks at local files only and is started when the engine loads, so by the
     * time the monitor is first played its answer is already known.
     */
    probeModels() {
      if (!this._probe) {
        const libs = global.RSLibs;
        this._probe = libs && typeof libs.probeModels === 'function'
          ? libs.probeModels()
          : Promise.reject(new Error('no model probe'));
      }
      return this._probe;
    }

    async _loadBridgeModules(ctx) {
      if (this._bridgeLoaded.has(ctx)) return;
      // the ring module first: the bridge uses RSRing in the worklet scope
      await ctx.audioWorklet.addModule(this._moduleUrl(RING_MODULE));
      await ctx.audioWorklet.addModule(this._moduleUrl(BRIDGE));
      this._bridgeLoaded.add(ctx);
    }

    _moduleUrl(path) {
      return global.location ? new URL(path, global.location.href).href : path;
    }

    /** A worker error takes the ML side out of the path, back to the plain DSP wet path. */
    _onNeuralMessage(d) {
      if (d && d.type === 'error') this._leaveBridge();
      // 'unavailable' is not a failure: the stage cannot run here (no runtime,
      // no weights). The bridge stays in passthrough, nothing is added to the
      // latency, and the audio is the plain DSP chain — silently.
      if (d && d.type === 'unavailable') this._neuralUnavailable = d.name || true;
    }

    _leaveBridge() {
      if (!this._bridge) return;
      try { this.node.disconnect(this._bridge); } catch (e) { /* already */ }
      try { this._bridge.disconnect(); } catch (e) { /* already */ }
      this.node.connect(this.wetGain);
      this._bridge = null;
      delete this._stageLatency.bridge;
      this._updateLatency();
    }

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

    get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

    /* --------------------------------------------------------------- params */

    /** Apply a full parameter set (flat name → value map). */
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

    /** A/B: true = play untouched original, false = play the restoration. */
    setBypass(on, glide) {
      this.bypass = !!on;
      this._applyAB(this.bypass, glide === undefined ? 0.01 : glide);
      this._notifyState();
    }

    /** The crossfade between the delayed dry path and the processed wet path. */
    _applyAB(bypassOn, glide) {
      if (!this.wetGain || !this.dryGain || !this.ctx) return;
      const t = this.ctx.currentTime;
      this.wetGain.gain.setTargetAtTime(bypassOn ? 0 : 1, t, glide);
      this.dryGain.gain.setTargetAtTime(bypassOn ? 1 : 0, t, glide);
    }

    /**
     * Latency of one neural stage that is in the monitor path, as the stage
     * reports it (the DFN3 denoiser's delay from the worker's `loaded` message;
     * a super-resolution stage's window when one is in the path). A stage that
     * is not in the path is 0 — call with 0, or disposeNeural(), to take it out.
     * The dry delay follows at once.
     * @param {string} stage  'denoise' | 'superRes' | any name a caller uses
     * @param {number} samples
     */
    setNeuralLatency(stage, samples) {
      const v = Math.max(0, samples | 0);
      if (v) this._stageLatency[stage] = v; else delete this._stageLatency[stage];
      this._updateLatency();
    }

    /**
     * The total look-ahead of everything in the monitor path, in samples:
     * the worklet's own (de-clicker, de-clipper, true-peak limiter — reported
     * through its port) plus each neural stage's. `this.latency` is this sum,
     * and the dry monitor path is delayed by exactly it.
     */
    _updateLatency() {
      let neural = 0;
      for (const k of Object.keys(this._stageLatency)) neural += this._stageLatency[k];
      const total = this._workletLatency + neural;
      this.latency = total;
      if (this.dryDelay && this.ctx) {
        const sec = Math.min(MAX_LATENCY_S, total / this.ctx.sampleRate);
        // an exact sample count: the delay is a whole number of frames at the
        // context rate, so the dry and wet signals line up sample for sample
        this.dryDelay.delayTime.setValueAtTime(sec, this.ctx.currentTime);
      }
    }

    /** Auto A/B: flip every `seconds` so the ear stays honest. */
    setCompare(on, seconds) {
      if (this.compareTimer) { global.clearInterval(this.compareTimer); this.compareTimer = null; }
      if (!on) return;
      const period = Math.max(1, seconds || 4) * 1000;
      this.compareTimer = global.setInterval(() => this.setBypass(!this.bypass, 0.012), period);
    }

    /* ---------------------------------------------------------- monitoring */

    /** Hand the engine a decoded buffer for live A/B monitoring. */
    setBuffer(buffer, window) {
      this.stop();
      this.buffer = buffer;
      this.offset = window ? window.start : 0;
      this.bounds = window || { start: 0, end: buffer ? buffer.duration : 0 };
    }

    async play() {
      if (!this.buffer) return;
      await this.init();
      if (this.playing) return;
      // The clock is the context's: a suspended context does not advance, so the
      // playhead would stand still while `playing` says otherwise. init() returns
      // early once the context is loaded, so the resume has to happen here too
      // (the browser suspends a context on its own: policy, device change).
      if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) { /* gesture needed */ } }
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      if (this.loop && this.bounds) {
        src.loop = true;
        src.loopStart = this.bounds.start;
        src.loopEnd = this.bounds.end;
      }
      src.connect(this.node);
      src.connect(this.dryDelay);
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

    pause() {
      if (!this.playing) return;
      this.offset = this.position;
      this._stopSource();
      this.playing = false;
      this._notifyState();
    }

    stop() {
      this._stopSource();
      this.playing = false;
      this._notifyState();
    }

    _stopSource() {
      if (this.src) {
        try { this.src.onended = null; this.src.stop(); } catch (e) { /* already stopped */ }
        try { this.src.disconnect(); } catch (e) { /* ignore */ }
        this.src = null;
      }
      if (this._raf) { global.cancelAnimationFrame(this._raf); this._raf = 0; }
    }

    seek(seconds) {
      const dur = this.buffer ? this.buffer.duration : 0;
      const t = Math.max(0, Math.min(dur, seconds));
      this.offset = t;
      if (this.playing) {
        this._stopSource();
        this.playing = false;
        this.play();
      } else {
        this._notifyState();
      }
    }

    setLoop(on) { this.loop = !!on; if (this.src) { this.src.loop = !!on && !!this.bounds; } }

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

    onTick(fn) { this._tickHandlers.add(fn); return () => this._tickHandlers.delete(fn); }
    onState(fn) { this._stateHandlers.add(fn); return () => this._stateHandlers.delete(fn); }

    _notifyState() { for (const fn of this._stateHandlers) fn({ playing: this.playing, position: this.position, bypass: this.bypass }); }

    _startTick() {
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

    /* ------------------------------------------------------- offscreen ML */

    /**
     * Set up the hybrid-inference side chain: two lock-free ring buffers over
     * SharedArrayBuffer plus the offscreen worker that reads them
     * (assets/js/neural-worker.js). The audio thread never waits on a model —
     * 128-frame quanta go into the input ring, 512…2048-frame hops come back
     * through the return ring, and `output.latencyFrames()` is what a mixer
     * must delay its dry path by to stay aligned.
     *
     * Requires SharedArrayBuffer (cross-origin isolation) and Worker; resolves
     * to null where either is missing, so callers degrade to plain DSP instead
     * of failing. Nothing here is started before this call.
     * @param {{hopSize?:number, channels?:number, sampleRate?:number,
     *          ringFrames?:number, passThrough?:boolean, onMessage?:Function}} [o]
     * @returns {Promise<{worker:Worker, input:object, output:object, hop:number}|null>}
     */
    async initNeural(o) {
      const RSRing = global.RSRing;
      if (!RSRing || !RSRing.isSupported() || !global.Worker) return null;
      this.disposeNeural();
      const opts = o || {};
      const hop = Math.min(2048, Math.max(512, (opts.hopSize | 0) || 1024));
      const channels = Math.max(1, (opts.channels | 0) || 2);
      const sampleRate = (opts.sampleRate | 0) || 48000;
      const frames = opts.ringFrames || 8192;
      const input = RSRing.create({ capacity: frames, channels, sampleRate });
      const output = RSRing.create({
        capacity: frames, channels, sampleRate,
        targetFill: hop,
        latencyCompensation: hop,
      });
      // the load window (3–5 s, default 4 s): the page cuts a worker whose
      // acquisition has been silent for this long; the worker gets the same value
      // The page's loader decides the limits (default 5 s, floor 3 s, ceiling adjustable)
      const lim = (global.RSLibs && global.RSLibs.budgetLimits) ? global.RSLibs.budgetLimits() : { min: 3000, max: 5000 };
      const want = Number(opts.budgetMs) || (global.RSLibs ? global.RSLibs.budget : 5000);
      const windowMs = Math.min(lim.max, Math.max(lim.min, want));
      const worker = new global.Worker(NEURAL_WORKER);
      const neural = { worker, input, output, hop, windowMs, watch: null, onMessage: opts.onMessage || null };
      this._neural = neural;
      worker.onmessage = (ev) => {
        const d = ev.data || {};
        // the watchdog follows the acquisition: progress re-arms it, the end of
        // the network phase (or any answer) disarms it. Session creation is not watched.
        if (d.type === 'acquiring' || d.type === 'progress') this._watchNeural(neural, d.name || 'dfn3', true);
        else if (d.type === 'acquired' || d.type === 'loaded' || d.type === 'unavailable' || d.type === 'error') this._watchNeural(neural, d.name || 'dfn3', false);
        // a stage that loads reports its delay; the monitor's dry path follows it
        if (d.type === 'loaded' && d.name === 'dfn3') this.setNeuralLatency('denoise', d.latency);
        if (opts.onMessage) opts.onMessage(d);
      };
      worker.onerror = () => { if (opts.onMessage) opts.onMessage({ type: 'error', message: 'neural worker failed' }); };
      worker.postMessage({
        type: 'init',
        base: global.location ? global.location.href : undefined,
        inputSab: input.sab,
        outputSab: output.sab,
        hopSize: hop,
        passThrough: opts.passThrough !== false,
        budgetMs: windowMs,
        // a worker has no storage: it is handed the page's opt-in and ceiling
        online: !!(global.RSLibs && global.RSLibs.online),
        budgetMax: lim.max,
      });
      // DeepFilterNet3 needs 48 kHz rings; the worker replies with the delay it adds
      // (`loaded.latency`), which the mixer must add to its compensation.
      if (opts.denoise) worker.postMessage({ type: 'loadDfn3', id: 'dfn3', options: opts.denoiseOptions || {} });
      return neural;
    }

    /**
     * The acquisition watchdog. Armed (or re-armed) by each progress message; it
     * fires only when the acquisition has been silent for `windowMs`. A worker
     * blocked inside importScripts cannot cut itself off, so the page terminates
     * it and reports the stage unavailable — the same answer as a missing runtime.
     */
    _watchNeural(neural, name, arm) {
      if (neural.watch) { global.clearTimeout(neural.watch); neural.watch = null; }
      if (!arm) return;
      neural.watch = global.setTimeout(() => {
        neural.watch = null;
        if (this._neural !== neural) return;
        const msg = { type: 'unavailable', name: name, reason: 'stalled while acquiring (no progress for ' + neural.windowMs + ' ms)' };
        this.disposeNeural();
        this._onNeuralMessage(msg);
        if (neural.onMessage) neural.onMessage(msg);
      }, neural.windowMs);
    }

    /** Terminate the ML worker and drop its rings. Safe to call twice. */
    disposeNeural() {
      // the stages are gone with the worker: the monitor's latency drops with
      // them, whether or not a worker was ever started
      this._leaveBridge();
      this._stageLatency = Object.create(null);
      this._updateLatency();
      const n = this._neural;
      if (!n) return;
      this._neural = null;
      if (n.watch) { global.clearTimeout(n.watch); n.watch = null; }
      try { n.worker.postMessage({ type: 'dispose' }); } catch (e) { /* already gone */ }
      try { n.worker.terminate(); } catch (e) { /* already gone */ }
    }

    /* ------------------------------------------------------ offline render */

    /**
     * Render through the real processor into plain Float32Array channels.
     * @param {Float32Array[]} channels source audio
     * @param {number} sampleRate source/target sample rate
     * @param {object} params parameter map (see presets.buildParams)
     * @param {{onProgress?:(p:number)=>void, progressSteps?:number}} [opts]
     * @returns {Promise<{channels:Float32Array[], sampleRate:number}>}
     */
    async render(source, sampleRate, params, opts) {
      const o = opts || {};
      // accept either an AudioBuffer or an array of Float32Array channels
      const isBuffer = !!(source && source.getChannelData && source.sampleRate);
      const srcChans = isBuffer
        ? (() => { const a = []; for (let c = 0; c < source.numberOfChannels; c++) a.push(source.getChannelData(c)); return a; })()
        : source;
      const inRate = isBuffer ? source.sampleRate : Math.max(8000, Math.min(192000, Math.round(sampleRate || 48000)));
      const nCh = Math.min(2, Math.max(1, srcChans.length));
      const srcLen = srcChans[0].length;
      const sr = Math.max(8000, Math.min(192000, Math.round(sampleRate || inRate)));
      // output length follows the target rate: playing a buffer whose rate differs
      // from the context resamples it, which is exactly what we want here
      const len = Math.max(1, Math.round((srcLen * sr) / inRate));
      const Ctor = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      if (!Ctor) throw new Error('OfflineAudioContext unavailable');

      const ctx = new Ctor({ numberOfChannels: nCh, length: len, sampleRate: sr });
      await this._loadWorklet(ctx);
      const node = new global.AudioWorkletNode(ctx, 'remaster-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [nCh],
        channelCount: nCh,
        channelCountMode: 'explicit',
      });
      // the processor reports its look-ahead on its first block (see the live path)
      let workletLatency = -1;
      node.port.onmessage = (ev) => {
        const d = ev.data || {};
        if (d.type === 'latency') workletLatency = d.samples | 0;
      };

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

      // OfflineAudioContext.suspend(t) pauses the render when it reaches time t and
      // resolves at that point; resume() carries it on. All the suspend points are
      // scheduled *before* startRendering(): a point scheduled from inside a
      // callback arrives after the render has gone past it, and is silently lost.
      // Each point is a whole number of render quanta (128 frames), so two points
      // never collide on the same quantum.
      const quantum = 128;
      const seen = new Set();
      const pending = [];
      for (let k = 1; k <= steps; k++) {
        const raw = Math.round(((len * k) / (steps + 1)) / quantum) * quantum;
        if (raw <= 0 || raw >= len || seen.has(raw)) continue;
        seen.add(raw);
        const when = raw / sr;
        try {
          pending.push(ctx.suspend(when).then(() => {
            if (o.onProgress) o.onProgress(when / duration);
            return ctx.resume();
          }));
        } catch (e) { /* suspend unsupported: this point is simply not reported */ }
      }

      const rendered = await ctx.startRendering();
      await Promise.all(pending);
      // the report arrives on the main thread a moment after the render ends
      // The processor's report is posted on its first block, during the render, so
      // it is queued before the render resolves: no wait is needed. `latencyReported`
      // says whether it came; without it nothing is trimmed and the caller is told.
      node.port.onmessage = null;
      node.disconnect();

      /* Align the output with the source. The processor's look-ahead (declicker,
       * de-clipper, true-peak limiter) delays what it returns by exactly the
       * number of samples the live monitor's dry path is delayed by, so the
       * export drops that many leading samples and pads the tail with silence:
       * the file lines up with the original, as the A/B comparison does. */
      const L = Math.max(0, workletLatency);
      const shift = (src) => {
        const dst = new Float32Array(src.length);
        dst.set(src.subarray(Math.min(L, src.length)));
        return dst;
      };
      const out = [];
      for (let c = 0; c < rendered.numberOfChannels; c++) out.push(shift(rendered.getChannelData(c)));
      if (o.onProgress) o.onProgress(1);
      return { channels: out, sampleRate: rendered.sampleRate, buffer: null, latency: L, latencyReported: workletLatency >= 0 };
    }
  }

  global.RSAudioEngine = AudioEngine;
  global.RSEngine = new AudioEngine();
  // the probe runs now, in the background: local files only, see library-loader.js
  global.RSEngine.probeModels().catch(() => { /* no probe: the DSP chain runs */ });
  if (typeof module !== 'undefined' && module.exports) module.exports = AudioEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
