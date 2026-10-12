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
 * de-clicker, whose half-millisecond look-ahead shifts the output by 17 samples
 * at 48 kHz while it is engaged — the same in both paths, and the A/B crossfade
 * delays its dry side with it, so nothing about the comparison changes.
 * ========================================================================== */
(function (global) {
  'use strict';

  const WORKLET = 'assets/worklets/remaster-processor.js';
  const SMOOTH = 0.02;                       // AudioParam glide, seconds

  class AudioEngine {
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

    /** Create the live context and load the processor. Needs a user gesture. */
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
      const p = this.node && this.node.parameters.get('bypass');
      if (p) p.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, glide === undefined ? 0.01 : glide);
      this._notifyState();
    }

    /** Auto A/B: flip every `seconds` so the ear stays honest. */
    setCompare(on, seconds) {
      if (this.compareTimer) { global.clearInterval(this.compareTimer); this.compareTimer = null; }
      if (!on) return;
      const period = Math.max(1, seconds || 4) * 1000;
      this.compareTimer = global.setInterval(() => this.setBypass(!this.bypass, 0.012), period);
    }

    setVolume(v) {
      if (this.gain) this.gain.gain.setTargetAtTime(Math.max(0, Math.min(2, v)), this.ctx.currentTime, 0.02);
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
      const schedule = () => {
        if (!steps || next > steps) return;
        const when = (duration * next) / (steps + 1);
        next++;
        if (when <= 0 || when >= duration) return;
        Promise.resolve()
          .then(() => ctx.suspend(when))
          .then(() => {
            if (o.onProgress) o.onProgress(when / duration);
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
      return { channels: out, sampleRate: rendered.sampleRate, buffer: rendered };
    }
  }

  global.RSAudioEngine = AudioEngine;
  global.RSEngine = new AudioEngine();
  if (typeof module !== 'undefined' && module.exports) module.exports = AudioEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
