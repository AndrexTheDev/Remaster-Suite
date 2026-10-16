/* ============================================================================= * Remaster Suite — neural DSP helpers (pure, no DOM, no ORT)
 * -----------------------------------------------------------------------------
 * Everything the ML worker needs that is plain signal processing, so it can be
 * tested in Node and reasoned about without a browser:
 *
 *   · a mixed-radix complex FFT (any length whose factors are small — 960 here)
 *   · the DeepFilterNet3 frame pipeline, a port of libDF's tract.rs: STFT with
 *     the vorbis window, ERB features, complex unit-norm features for the DF
 *     bins, stage gating by the local SNR, ERB gain mask, deep-filter (DF)
 *     coefficients with look-ahead, overlap-add synthesis
 *   · a linear-phase FIR lowpass H_LP(f) at the measured MP3 cutoff f_c — applied
 *     before super-resolution so the new band cannot intermodulate with the
 *     cutoff edge
 *   · the memory tier: the compact model is chosen on mobile or when the free
 *     JS heap is below 420 MB
 *
 * The model runner is injected (`run(kind, feeds) → outputs`), so the worker
 * binds onnxruntime-web and the tests bind onnxruntime-node to the same code.
 *
 * Dual export: CommonJS for the tests, RSNeural global in the browser / worker.
 * ========================================================================== */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------- FFT */

  const fftPlans = new Map();

  function smallestFactor(n) {
    for (let p = 2; p * p <= n; p++) if (n % p === 0) return p;
    return n;
  }

  function plan(n) {
    let p = fftPlans.get(n);
    if (!p) {
      const tc = new Float64Array(n), ts = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        tc[k] = Math.cos((2 * Math.PI * k) / n);
        ts[k] = Math.sin((2 * Math.PI * k) / n);
      }
      p = { n, tc, ts };
      fftPlans.set(n, p);
    }
    return p;
  }

  /** Recursive decimation-in-time mixed-radix FFT, forward sign (e^-i). */
  function cfft(pl, xr, xi) {
    const n = xr.length;
    if (n === 1) return { re: Float64Array.of(xr[0]), im: Float64Array.of(xi[0]) };
    const p = smallestFactor(n);
    const m = n / p;
    const subs = [];
    for (let s = 0; s < p; s++) {
      const sr = new Float64Array(m), si = new Float64Array(m);
      for (let j = 0; j < m; j++) { sr[j] = xr[j * p + s]; si[j] = xi[j * p + s]; }
      subs.push(cfft(pl, sr, si));
    }
    const outR = new Float64Array(n), outI = new Float64Array(n);
    const step = pl.n / n;
    for (let k = 0; k < n; k++) {
      let accR = 0, accI = 0;
      for (let s = 0; s < p; s++) {
        const e = (s * k) % n;
        const ti = (e * step) % pl.n;
        const c = pl.tc[ti], sn = -pl.ts[ti]; // W = e^{-2πi e/n}
        const sub = subs[s];
        const vr = sub.re[k % m], vi = sub.im[k % m];
        accR += vr * c - vi * sn;
        accI += vr * sn + vi * c;
      }
      outR[k] = accR;
      outI[k] = accI;
    }
    return { re: outR, im: outI };
  }

  /** Forward complex FFT of length n (any n whose prime factors are small). */
  function fft(re, im) {
    return cfft(plan(re.length), re, im);
  }

  /* ----------------------------------------------- DeepFilterNet3 constants */

  const DFN3 = {
    sr: 48000, fftSize: 960, hop: 480, nbErb: 32, nbDf: 96, dfOrder: 5,
    dfLookahead: 2, convLookahead: 2, normTau: 1, minNbErbFreqs: 2,
    // RuntimeParams defaults of libDF (tract.rs default_with_ch)
    minDbThresh: -10, maxDbErbThresh: 30, maxDbDfThresh: 20,
    skipRms: 1e-7, skipLimit: 5,
  };
  // Frames per model chunk. The window adds `context` frames of history.
  DFN3.chunk = 50;
  DFN3.context = 150;
  // Latency in samples. The model output for frame f is only valid once frame
  // f + 2 has arrived (conv look-ahead, measured: the encoder's lsnr at index j
  // tracks the energy of frame j − 2). Output block f − 3 is released at arrival
  // f (look-ahead 2 plus the STFT hop), and a chunk of N frames is released as a
  // whole, so the total is (N + 2 + 3) hops. Verified by the cross-correlation
  // test in tests/e2e.test.js.
  DFN3.latency = (DFN3.chunk + DFN3.convLookahead + 3) * DFN3.hop;

  function freq2erb(f) { return 9.265 * Math.log1p(f / (24.7 * 9.265)); }
  function erb2freq(e) { return 24.7 * 9.265 * (Math.exp(e / 9.265) - 1); }

  /** Band widths in FFT bins per ERB band (libDF erb_fb). */
  function erbFilterBank(sr, fftSize, nbBands, minNbFreqs) {
    const nyq = sr / 2;
    const freqWidth = sr / fftSize;
    const erbLow = freq2erb(0), erbHigh = freq2erb(nyq);
    const erb = new Array(nbBands).fill(0);
    const step = (erbHigh - erbLow) / nbBands;
    let prevFreq = 0, freqOver = 0;
    for (let i = 1; i <= nbBands; i++) {
      const f = erb2freq(erbLow + i * step);
      const fb = Math.round(f / freqWidth);
      let nb = fb - prevFreq - freqOver;
      if (nb < minNbFreqs) {
        freqOver = minNbFreqs - nb;
        nb = minNbFreqs;
      } else {
        freqOver = 0;
      }
      erb[i - 1] = nb;
      prevFreq = fb;
    }
    erb[nbBands - 1] += 1;
    const tooLarge = erb.reduce((a, b) => a + b, 0) - (fftSize / 2 + 1);
    if (tooLarge > 0) erb[nbBands - 1] -= tooLarge;
    return erb;
  }

  /** libDF calc_norm_alpha: exp(-dt/tau), rounded to three decimals below 1. */
  function normAlpha(sr, hop, tau) {
    const dt = hop / sr;
    const alpha = Math.exp(-dt / tau);
    let a = 1, precision = 3;
    while (a >= 1) {
      const scale = Math.pow(10, precision);
      a = Math.round(alpha * scale) / scale;
      precision++;
    }
    return a;
  }

  /** Vorbis power-complementary window, length fftSize (libDF DFState::new). */
  function vorbisWindow(fftSize) {
    const half = fftSize / 2;
    const w = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      const s = Math.sin((0.5 * Math.PI * (i + 0.5)) / half);
      w[i] = Math.sin(0.5 * Math.PI * s * s);
    }
    return w;
  }

  /* ------------------------------------------------------ DF frame pipeline */

  /** Stage gating from the local SNR (libDF Tract::apply_stages). */
  function applyStages(lsnr, cfg) {
    if (lsnr < cfg.minDbThresh) return { gains: false, zeros: true, df: false };
    if (lsnr > cfg.maxDbErbThresh) return { gains: false, zeros: false, df: false };
    if (lsnr > cfg.maxDbDfThresh) return { gains: true, zeros: false, df: false };
    return { gains: true, zeros: false, df: true };
  }

  function linspace(a, b, n) {
    const out = new Float64Array(n);
    const step = (b - a) / (n - 1);
    for (let i = 0; i < n; i++) out[i] = a + i * step;
    return out;
  }

  /**
   * One audio channel through DeepFilterNet3, in chunks.
   *
   * The exported encoder, ERB decoder and DF decoder are sequence models (the
   * time axis S is symbolic; libDF pulses them, keeping convolution and GRU
   * state between frames). A single frame per call therefore loses all temporal
   * context, so the channel runs the models over a window: `context` frames of
   * history followed by `chunk` new frames, and keeps only the new outputs.
   *
   * `run(kind, feeds)` takes and returns { data: Float32Array, dims: number[] }
   * values and returns a Promise of an object keyed by output name:
   *   'enc'     feeds {feat_erb [1,1,S,32], feat_spec [1,2,S,96]}
   *             → {e0,e1,e2,e3,emb,c0,lsnr}
   *   'erbDec'  feeds {emb,e3,e2,e1,e0}  → {m [1,1,S,32]}
   *   'dfDec'   feeds {emb,c0}           → {coefs [1,S,96,10]}
   */
  class Dfn3Channel {
    constructor(run, opts) {
      const o = opts || {};
      this.run = run;
      this.cfg = Object.assign({}, DFN3, o);
      const c = this.cfg;
      c.latency = (c.chunk + c.convLookahead + 3) * c.hop;
      this.n = c.fftSize;
      this.hop = c.hop;
      this.nFreq = c.fftSize / 2 + 1;
      this.win = vorbisWindow(c.fftSize);
      this.wnorm = 1 / ((c.fftSize * c.fftSize) / (2 * c.hop));
      this.erb = erbFilterBank(c.sr, c.fftSize, c.nbErb, c.minNbErbFreqs);
      this.alpha = normAlpha(c.sr, c.hop, c.normTau);
      this.meanState = linspace(-60, -90, c.nbErb);
      this.unitState = linspace(0.001, 0.0001, c.nbDf);
      this.anaMem = new Float64Array(c.hop);
      this.synMem = new Float64Array(c.hop);
      this.rollX = [];
      this.rollY = [];
      for (let i = 0; i < Math.max(c.dfOrder, c.dfLookahead); i++) this.rollX.push(this.zeroSpec());
      for (let i = 0; i < c.dfOrder + c.convLookahead; i++) this.rollY.push(this.zeroSpec());
      this.skip = 0;
      this.pending = [];   // analysed hops waiting for the next model chunk
      this.ctx = [];       // feature history for the model window
      this.frames = 0;
      this.lastLsnr = NaN;
    }

    zeroSpec() { return { re: new Float64Array(this.nFreq), im: new Float64Array(this.nFreq) }; }

    cloneSpec(s) { return { re: Float64Array.from(s.re), im: Float64Array.from(s.im) }; }

    /** Windowed STFT of one hop (libDF frame_analysis). */
    analyse(input) {
      const h = this.hop, n = this.n;
      const buf = new Float64Array(n);
      for (let i = 0; i < h; i++) buf[i] = this.anaMem[i] * this.win[i];
      for (let i = 0; i < h; i++) buf[h + i] = input[i] * this.win[h + i];
      for (let i = 0; i < h; i++) this.anaMem[i] = input[i];
      const f = fft(buf, new Float64Array(n));
      const out = this.zeroSpec();
      for (let k = 0; k < this.nFreq; k++) {
        out.re[k] = f.re[k] * this.wnorm;
        out.im[k] = f.im[k] * this.wnorm;
      }
      return out;
    }

    /** Inverse STFT of one hop with overlap-add (libDF frame_synthesis). */
    synthesise(spec) {
      const n = this.n, h = this.hop;
      // Hermitian extension; the real part of the forward FFT of conj(X) equals
      // the real part of the unnormalised inverse that realfft produces.
      const xr = new Float64Array(n), xi = new Float64Array(n);
      for (let k = 0; k < this.nFreq; k++) { xr[k] = spec.re[k]; xi[k] = -spec.im[k]; }
      for (let k = 1; k < this.nFreq - 1; k++) { xr[n - k] = spec.re[k]; xi[n - k] = spec.im[k]; }
      const x = fft(xr, xi).re;
      for (let i = 0; i < n; i++) x[i] *= this.win[i];
      const out = new Float32Array(h);
      for (let i = 0; i < h; i++) out[i] = x[i] + this.synMem[i];
      for (let i = 0; i < h; i++) this.synMem[i] = x[h + i];
      return out;
    }

    /** ERB log-power features with exponential mean normalisation. */
    featErb(spec) {
      const c = this.cfg, a = this.alpha;
      const out = new Float64Array(c.nbErb);
      let bin = 0;
      for (let b = 0; b < c.nbErb; b++) {
        const w = this.erb[b];
        let acc = 0;
        for (let j = 0; j < w; j++, bin++) acc += spec.re[bin] * spec.re[bin] + spec.im[bin] * spec.im[bin];
        out[b] = 10 * Math.log10(acc / w + 1e-10);
      }
      const feat = new Float32Array(c.nbErb);
      for (let b = 0; b < c.nbErb; b++) {
        this.meanState[b] = out[b] * (1 - a) + this.meanState[b] * a;
        feat[b] = (out[b] - this.meanState[b]) / 40;
      }
      return feat;
    }

    /** Complex unit-normalised features of the first nbDf bins, as [re…, im…]. */
    featSpec(spec) {
      const c = this.cfg, a = this.alpha;
      const feat = new Float32Array(2 * c.nbDf);
      for (let f = 0; f < c.nbDf; f++) {
        const mag = Math.hypot(spec.re[f], spec.im[f]);
        this.unitState[f] = mag * (1 - a) + this.unitState[f] * a;
        const d = Math.sqrt(this.unitState[f]);
        feat[f] = spec.re[f] / d;
        feat[c.nbDf + f] = spec.im[f] / d;
      }
      return feat;
    }

    /** Stage 1, synchronous: analyse one hop and queue it for the next chunk. */
    pushHop(input) {
      let sq = 0;
      for (let i = 0; i < this.hop; i++) sq += input[i] * input[i];
      const spec = this.analyse(input);
      this.pending.push({
        spec, silent: sq / this.hop < this.cfg.skipRms,
        erb: this.featErb(spec), feat: this.featSpec(spec),
      });
    }

    /** Stage 2, asynchronous: run the models over the window and synthesise `n` hops. */
    async runChunk(n) {
      const c = this.cfg, h = this.hop, look = c.convLookahead;
      if (this.pending.length < n + look) throw new Error('runChunk: needs ' + (n + look) + ' hops');
      const frames = this.pending.slice(0, n + look);
      this.pending.splice(0, n);
      const k = this.ctx.length;
      const S = k + n + look;
      const erbIn = new Float32Array(S * c.nbErb);
      const specIn = new Float32Array(2 * S * c.nbDf);
      const put = (t, fr) => {
        erbIn.set(fr.erb, t * c.nbErb);
        // layout [1, 2, S, nbDf]: plane (re, im), then time, then frequency
        for (let f = 0; f < c.nbDf; f++) {
          specIn[t * c.nbDf + f] = fr.feat[f];
          specIn[S * c.nbDf + t * c.nbDf + f] = fr.feat[c.nbDf + f];
        }
      };
      for (let t = 0; t < k; t++) put(t, this.ctx[t]);
      for (let i = 0; i < n + look; i++) put(k + i, frames[i]);

      const enc = await this.run('enc', {
        feat_erb: { data: erbIn, dims: [1, 1, S, c.nbErb] },
        feat_spec: { data: specIn, dims: [1, 2, S, c.nbDf] },
      });
      const lsnrAll = enc.lsnr.data;
      const dec = await this.run('erbDec', { emb: enc.emb, e3: enc.e3, e2: enc.e2, e1: enc.e1, e0: enc.e0 });
      const dfo = await this.run('dfDec', { emb: enc.emb, c0: enc.c0 });
      const mAll = dec.m.data, coefAll = dfo.coefs.data;

      // the chunk's frames (not the look-ahead ones) become context history
      for (let i = 0; i < n; i++) this.ctx.push({ erb: frames[i].erb, feat: frames[i].feat });
      while (this.ctx.length > c.context) this.ctx.shift();

      const out = new Float32Array(n * h);
      for (let i = 0; i < n; i++) {
        const t = k + i;
        const block = this.finishFrame(
          frames[i], lsnrAll[t],
          mAll.subarray(t * c.nbErb, (t + 1) * c.nbErb),
          coefAll.subarray(t * c.nbDf * c.dfOrder * 2, (t + 1) * c.nbDf * c.dfOrder * 2),
        );
        out.set(block, i * h);
      }
      return out;
    }

    /** Stage 3, synchronous: gains, deep filter and synthesis for one frame. */
    finishFrame(fr, lsnr, mask, coefs) {
      const c = this.cfg;
      this.skip = fr.silent ? this.skip + 1 : 0;
      if (this.skip > c.skipLimit) return new Float32Array(c.hop); // digital silence stays silent

      this.rollY.shift();
      this.rollX.shift();
      this.rollY.push(this.cloneSpec(fr.spec));
      this.rollX.push(fr.spec);

      this.lastLsnr = lsnr;
      const st = applyStages(lsnr, c);
      let gains = null;
      if (st.gains) gains = mask;
      else if (st.zeros) gains = new Float32Array(c.nbErb);

      const y = this.rollY[c.dfOrder - 1];
      if (gains) {
        let bin = 0;
        for (let b = 0; b < c.nbErb; b++) {
          const g = gains[b];
          for (let j = 0; j < this.erb[b]; j++, bin++) { y.re[bin] *= g; y.im[bin] *= g; }
        }
        this.skip = 0;
      } else {
        this.skip++;
      }

      const enh = this.cloneSpec(y);
      if (st.df) {
        // deep filter: sum_k X_k · C_k over the df_order noisy frames, oldest first
        for (let f = 0; f < c.nbDf; f++) {
          let ar = 0, ai = 0;
          for (let k = 0; k < c.dfOrder; k++) {
            const s = this.rollX[k];
            const o = (f * c.dfOrder + k) * 2;
            const cr = coefs[o], ci = coefs[o + 1];
            ar += s.re[f] * cr - s.im[f] * ci;
            ai += s.re[f] * ci + s.im[f] * cr;
          }
          enh.re[f] = ar;
          enh.im[f] = ai;
        }
      }
      this.frames++;
      return this.synthesise(enh);
    }
  }

  /**
   * Sample-stream wrapper: arbitrary block sizes in, the same number of samples
   * out. The output of input sample i appears at output index i + latency
   * (DFN3.latency). Frames are processed in chunks of `chunk` hops; the FIFO is
   * primed with one chunk of silence, which keeps it non-negative at every block
   * boundary (see the arithmetic in DFN3.latency).
   */
  class Dfn3Stream {
    constructor(run, opts) {
      this.chan = new Dfn3Channel(run, opts);
      this.hop = this.chan.hop;
      this.chunk = this.chan.cfg.chunk;
      this.look = this.chan.cfg.convLookahead;
      this.latency = this.chan.cfg.latency;
      this.inFifo = new Float32Array(0);
      this.outFifo = new Float32Array((this.chunk + this.look) * this.hop);
    }

    async process(block) {
      const merged = new Float32Array(this.inFifo.length + block.length);
      merged.set(this.inFifo, 0);
      merged.set(block, this.inFifo.length);
      let pos = 0;
      const produced = [];
      while (merged.length - pos >= this.hop) {
        this.chan.pushHop(merged.subarray(pos, pos + this.hop));
        pos += this.hop;
        if (this.chan.pending.length >= this.chunk + this.look) {
          produced.push(await this.chan.runChunk(this.chunk));
        }
      }
      this.inFifo = merged.slice(pos);
      if (produced.length) {
        const add = new Float32Array(produced.reduce((a, b) => a + b.length, 0));
        let at = 0;
        for (const p of produced) { add.set(p, at); at += p.length; }
        const next = new Float32Array(this.outFifo.length + add.length);
        next.set(this.outFifo, 0);
        next.set(add, this.outFifo.length);
        this.outFifo = next;
      }
      const out = this.outFifo.slice(0, block.length);
      this.outFifo = this.outFifo.slice(block.length);
      return out;
    }

    /**
     * Whole-signal convenience: returns `samples` processed and time-aligned,
     * i.e. output[i] is the enhanced version of samples[i]. Feeds the tail of
     * silence needed to flush the look-ahead.
     */
    async processSignal(samples, blockSize) {
      const bs = blockSize || 512;
      const L = samples.length;
      const padded = new Float32Array(L + this.latency);
      padded.set(samples, 0);
      const out = new Float32Array(padded.length);
      let at = 0;
      for (let i = 0; i < padded.length; i += bs) {
        const b = await this.process(padded.subarray(i, Math.min(padded.length, i + bs)));
        out.set(b, at);
        at += b.length;
      }
      return out.slice(this.latency, this.latency + L);
    }
  }

  /* ----------------------------------------------------- FIR lowpass H_LP */

  /**
   * Linear-phase windowed-sinc lowpass at fcHz. The taps are symmetric, so the
   * group delay is exactly (taps−1)/2 for every frequency. Blackman window:
   * better than 70 dB stop-band attenuation. DC gain is normalised to 1.
   */
  function linearPhaseLowpass(fcHz, sr, taps) {
    const N = taps | 0;
    if (!(N >= 3) || N % 2 === 0) throw new Error('linearPhaseLowpass: taps must be an odd number ≥ 3');
    if (!(fcHz > 0 && fcHz < sr / 2)) throw new Error('linearPhaseLowpass: fc must lie in (0, sr/2)');
    const M = (N - 1) / 2;
    const wc = (2 * fcHz) / sr;
    const h = new Float64Array(N);
    let sum = 0;
    for (let n = 0; n < N; n++) {
      const t = n - M;
      const sinc = t === 0 ? wc : Math.sin(Math.PI * wc * t) / (Math.PI * t);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (N - 1));
      h[n] = sinc * w;
      sum += h[n];
    }
    for (let n = 0; n < N; n++) h[n] /= sum;
    return h;
  }

  /** Apply taps to x, delay-compensated: output aligned with input, same length. */
  function applyFir(x, h) {
    const N = h.length, M = (N - 1) / 2, L = x.length;
    const y = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      // y[i] = Σ_k h[k] · x[i + M − k]
      const j0 = i + M;
      let acc = 0;
      const kLo = Math.max(0, j0 - (L - 1));
      const kHi = Math.min(N - 1, j0);
      for (let k = kLo; k <= kHi; k++) acc += h[k] * x[j0 - k];
      y[i] = acc;
    }
    return y;
  }

  /* ----------------------------------------------------------- memory tier */

  const COMPACT_HEAP_MB = 420;

  /**
   * Memory guard for the super-resolution stage. Mobile devices, or a free JS
   * heap below 420 MB, get the compact NovaSR model (about 52 KB); everything
   * else gets the full model. Pure: the caller supplies the readings.
   */
  function chooseModelTier(env) {
    const e = env || {};
    const limit = Number(e.heapLimitMB);
    const used = Number(e.usedHeapMB);
    const availableHeapMB = isFinite(limit) && isFinite(used) ? Math.max(0, limit - used) : NaN;
    if (e.mobile) return { tier: 'compact', reason: 'mobile', availableHeapMB };
    if (isFinite(availableHeapMB) && availableHeapMB < COMPACT_HEAP_MB) {
      return { tier: 'compact', reason: 'heap', availableHeapMB };
    }
    return { tier: 'full', reason: 'default', availableHeapMB };
  }

  /** Reads the environment hints chooseModelTier needs, from any scope. */
  function readEnvironment(scope) {
    const g = scope || root;
    const nav = g.navigator || {};
    const ua = String(nav.userAgent || '');
    const uaMobile = !!(nav.userAgentData && nav.userAgentData.mobile) || /Mobi|Android|iPhone|iPad/i.test(ua);
    const mem = g.performance && g.performance.memory;
    return {
      mobile: uaMobile,
      heapLimitMB: mem ? mem.jsHeapSizeLimit / 1048576 : NaN,
      usedHeapMB: mem ? mem.usedJSHeapSize / 1048576 : NaN,
    };
  }

  const api = {
    DFN3, fft, erbFilterBank, normAlpha, vorbisWindow, applyStages,
    Dfn3Channel, Dfn3Stream, linearPhaseLowpass, applyFir,
    chooseModelTier, readEnvironment, COMPACT_HEAP_MB,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RSNeural = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
