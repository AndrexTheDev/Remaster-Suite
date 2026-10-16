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
     * @param {Float32Array[]|AudioBuffer} source
     * @param {number} sampleRate
     * @param {object} params
     * @param {{
     *   chunkSeconds?: number, crossfadeMs?: number, prerollSeconds?: number,
     *   minChunkSeconds?: number, memoryGuard?: {suggestChunkSeconds:Function},
     *   onChunk?: (channels: Float32Array[], info: {startSample:number, endSample:number, totalSamples:number, isLast:boolean}) => (void|Promise<void>),
     *   onProgress?: (p:number) => void, neural?: object,
     * }} [opts]
     * @returns {Promise<{channels?: Float32Array[], sampleRate:number, samples:number, chunks:number}>}
     *   `channels` is only populated when the caller did not pass `onChunk`
     *   (kept so the method is still usable as a drop-in, memory-saving
     *   alternative without a sink — tests rely on this). The entire point
     *   of `onChunk`/a streaming sink is to never need that full array.
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

        const spanOut = await this._renderSpan(spanSrcChans, inRate, sr, nCh, effectiveParams, spanOutLen, neuralCurve);

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

      const result = { sampleRate: sr, samples: len, chunks: chunkIndex };
      if (accumulate) result.channels = outAccum;
      return result;
    }

    /**
     * One short, independent render span — the unit `renderChunked()`
     * composes the whole file out of. Mirrors `render()`'s own node
     * setup/param-apply/startRendering sequence exactly, just scoped to a
     * slice of the source instead of all of it.
     * @private
     */
    async _renderSpan(spanSrcChans, inRate, sr, nCh, params, spanOutLen, neuralCurve) {
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

      const spanLen = Math.max(1, spanSrcChans[0].length);
      const buf = ctx.createBuffer(nCh, spanLen, inRate);
      for (let c = 0; c < nCh; c++) buf.copyToChannel(spanSrcChans[c], c, 0);
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
      return out;
    }
  }

  global.RSAudioEngine = AudioEngine;
  global.RSEngine = new AudioEngine();
  if (typeof module !== 'undefined' && module.exports) module.exports = AudioEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
