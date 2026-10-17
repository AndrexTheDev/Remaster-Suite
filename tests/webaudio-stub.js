/* =============================================================================
 * A *small* Web Audio implementation for the Node test suite.
 * -----------------------------------------------------------------------------
 * It is not a browser: it only implements the slice of the API the Remaster
 * Suite actually uses, but it runs the real AudioWorklet processor in 128-frame
 * quanta and the real OfflineAudioContext render loop, including suspend() /
 * resume() progress reporting. That makes the whole application testable —
 * decode → analyse → render → encode → zip — without a headless browser.
 * ========================================================================== */
'use strict';

const H = require('./harness.js');
const DSP = H.loadDsp();

/* --------------------------------------------------------------- AudioBuffer */

class AudioBufferStub {
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._data = [];
    for (let c = 0; c < numberOfChannels; c++) this._data.push(new Float32Array(length));
  }
  getChannelData(c) { return this._data[c]; }
  copyToChannel(src, c, offset) {
    const dst = this._data[c];
    const off = Math.max(0, Math.floor(offset || 0));
    const n = Math.min(src.length, dst.length - off);
    for (let i = 0; i < n; i++) dst[off + i] = src[i];
  }
  copyFromChannel(dst, c, offset) {
    const src = this._data[c];
    const off = Math.max(0, Math.floor(offset || 0));
    for (let i = 0; i < dst.length; i++) dst[i] = src[off + i] || 0;
  }
}

/* -------------------------------------------------------------------- params */

class ParamStub {
  constructor(desc) {
    this._v = desc.defaultValue === undefined ? 0 : desc.defaultValue;
    this.name = desc.name;
  }
  get value() { return this._v; }
  set value(v) { this._v = v; }
  setValueAtTime(v) { this._v = v; return this; }
  setTargetAtTime(v) { this._v = v; return this; }
  linearRampToValueAtTime(v) { this._v = v; return this; }
  cancelScheduledValues() { return this; }
}

/* --------------------------------------------------------------------- nodes */

class NodeStub {
  constructor(ctx) {
    this.context = ctx;
    this._outs = [];
    this._in = null;
    ctx._register(this);
  }
  connect(dst) { this._outs.push(dst); return dst; }
  disconnect() { this._outs = []; }
  _ensureIn(n, nCh) {
    if (!this._in || this._in.length !== nCh || this._in[0].length !== n) {
      this._in = [];
      for (let c = 0; c < nCh; c++) this._in.push(new Float32Array(n));
    }
    return this._in;
  }
  /** Push rendered channels into every successor. */
  _emit(chans) {
    for (const out of this._outs) {
      const n = chans[0].length;
      const want = out._wantChannels || chans.length;
      const dst = out._ensureIn(n, want);
      for (let c = 0; c < dst.length; c++) {
        const src = chans[Math.min(c, chans.length - 1)];
        const gain = chans.length > dst.length && dst.length === 1 ? 1 / chans.length : 1;
        for (let i = 0; i < n; i++) dst[c][i] += src[i] * gain;
      }
    }
  }
}

class SourceNodeStub extends NodeStub {
  constructor(ctx) {
    super(ctx);
    this.buffer = null;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.playbackRate = new ParamStub({ name: 'playbackRate', defaultValue: 1 });
    this._playing = false;
    this._offset = 0;
    this._pos = 0;
    this.onended = null;
    this._scratch = null;
  }
  start(when, offset) {
    this._playing = true;
    this._offset = offset || 0;
    this._pos = (offset || 0) * (this.buffer ? this.buffer.sampleRate : this.context.sampleRate);
  }
  stop() { this._playing = false; }
  _render(n) {
    if (!this._playing || !this.buffer) return;
    const ctxRate = this.context.sampleRate;
    const buf = this.buffer;
    const rate = this.playbackRate.value * (buf.sampleRate / ctxRate);
    const nCh = this.buffer.numberOfChannels;
    if (!this._scratch || this._scratch.length !== nCh || this._scratch[0].length < n) {
      this._scratch = [];
      for (let c = 0; c < nCh; c++) this._scratch.push(new Float32Array(Math.max(128, n)));
    }
    const out = [];
    for (let c = 0; c < nCh; c++) {
      const s = this._scratch[c].length === n ? this._scratch[c] : this._scratch[c].subarray(0, n);
      s.fill(0);
      out.push(s);
    }
    let pos = this._pos;
    const end = buf.length;
    const loopFrom = (this.loop ? this.loopStart : this._offset) * buf.sampleRate;
    const loopTo = this.loop ? this.loopEnd * buf.sampleRate : end;
    if (rate === 1 && !this.loop && Math.floor(pos) === pos && pos + n <= end) {
      const p0 = pos | 0;
      for (let c = 0; c < nCh; c++) out[c].set(buf._data[c].subarray(p0, p0 + n));
      pos += n;
    } else {
      for (let i = 0; i < n; i++) {
        if (this.loop && pos >= loopTo) pos = loopFrom + ((pos - loopFrom) % Math.max(1, loopTo - loopFrom));
        if (pos >= end) { this._playing = false; break; }
        const i0 = Math.floor(pos);
        const i1 = Math.min(end - 1, i0 + 1);
        const f = pos - i0;
        for (let c = 0; c < nCh; c++) {
          const d = buf._data[c];
          out[c][i] = d[i0] * (1 - f) + d[i1] * f;
        }
        pos += rate;
      }
    }
    this._pos = pos;
    this._emit(out);
  }
}

class GainNodeStub extends NodeStub {
  constructor(ctx) {
    super(ctx);
    this.gain = new ParamStub({ name: 'gain', defaultValue: 1 });
    this._wantChannels = 2;
  }
  _render(n) {
    const inCh = this._in || [];
    const out = inCh.map((c) => Float32Array.from(c));
    const g = this.gain.value;
    for (const ch of out) for (let i = 0; i < n; i++) ch[i] *= g;
    this._emit(out);
  }
}

class DestinationStub extends NodeStub {
  constructor(ctx) {
    super(ctx);
    this._target = null;
    this._offset = 0;
  }
  _ensureIn(n, nCh) {
    if (!this._in || this._in.length !== nCh || this._in[0].length !== n) {
      this._in = [];
      for (let c = 0; c < nCh; c++) {
        this._in.push(this._target[c].subarray(this._offset, this._offset + n));
      }
    }
    return this._in;
  }
}

class WorkletNodeStub extends NodeStub {
  constructor(ctx, name, opts) {
    super(ctx);
    this.name = name;
    this.options = opts || {};
    this._wantChannels = Math.max(1, Math.min(2, (opts && opts.channelCount) || 2));
    const Cls = ctx._workletClass;
    if (!Cls) throw new Error('worklet not loaded');
    this.processor = new Cls({ processorOptions: { channels: this._wantChannels } });
    this.parameters = new Map();
    this._paramArrays = {};
    for (const d of (Cls.parameterDescriptors || [])) {
      const p = new ParamStub(d);
      this.parameters.set(d.name, p);
      this._paramArrays[d.name] = new Float32Array([p.value]);
    }
    this.port = this.processor.port;
    this._zero = new Float32Array(128);
    this._outScratch = [];
    for (let c = 0; c < this._wantChannels; c++) this._outScratch.push(new Float32Array(128));
  }
  _render(n) {
    const nCh = this._wantChannels;
    if (this._zero.length < n) {
      this._zero = new Float32Array(n);
      this._outScratch = [];
      for (let c = 0; c < nCh; c++) this._outScratch.push(new Float32Array(n));
    }
    const zero = this._zero.length === n ? this._zero : this._zero.subarray(0, n);
    const inCh = [];
    const outCh = [];
    for (let c = 0; c < nCh; c++) {
      inCh.push(this._in && this._in[c] ? this._in[c] : zero);
      outCh.push(this._outScratch[c].length === n ? this._outScratch[c] : this._outScratch[c].subarray(0, n));
    }
    for (const [k, p] of this.parameters) this._paramArrays[k][0] = p.value;
    this.processor.process([inCh], [outCh], this._paramArrays);
    this._emit(outCh);
  }
}

/* ---------------------------------------------------------------- base context */

class BaseContextStub {
  constructor(opts) {
    const o = opts || {};
    this.sampleRate = o.sampleRate || 48000;
    this.numberOfChannels = o.numberOfChannels || 2;
    this._length = o.length || 0;
    this._nodes = [];
    this._suspends = [];
    this._destination = new DestinationStub(this);
    this._workletClass = null;
    this.audioWorklet = {
      addModule: async (url) => {
        if (/dsp-utils\.js$/.test(String(url))) { H.loadDsp(); return; }
        if (!/remaster-processor\.js$/.test(String(url))) throw new Error('unexpected module: ' + url);
        this._workletClass = H.loadProcessor(this.sampleRate);
        return undefined;
      },
    };
    this.state = 'suspended';
  }
  _register(node) { this._nodes.push(node); }
  get destination() { return this._destination; }
  createBuffer(nCh, len, sr) { return new AudioBufferStub(nCh, len, sr || this.sampleRate); }
  createBufferSource() { return new SourceNodeStub(this); }
  createGain() { return new GainNodeStub(this); }
  async resume() { this.state = 'running'; return undefined; }
  async close() { this.state = 'closed'; return undefined; }
  async decodeAudioData(arrayBuffer) {
    // Web Audio handles MP3/AAC/OGG; this stub only needs WAV for the tests
    const wav = DSP.decodeWav(arrayBuffer);
    const buf = new AudioBufferStub(wav.channels.length, wav.channels[0].length, wav.sr);
    for (let c = 0; c < wav.channels.length; c++) buf._data[c].set(wav.channels[c]);
    return buf;
  }
}

/* --------------------------------------------------------------- offline context */

class OfflineAudioContextStub extends BaseContextStub {
  constructor(opts) {
    super(opts);
    this.length = this._length;
  }
  createAudioWorkletNode(name, opts) { return new WorkletNodeStub(this, name, opts); }
  async suspend(when) {
    return new Promise((resolve) => { this._suspends.push({ when: when, resolve: resolve }); });
  }
  resume() {
    if (this._pausedResolve) { const r = this._pausedResolve; this._pausedResolve = null; r(); }
    return Promise.resolve();
  }
  _order() {
    const seen = new Set();
    const list = [];
    const visit = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      list.push(node);
      for (const o of node._outs) visit(o);
    };
    for (const n of this._nodes) if (n instanceof SourceNodeStub) visit(n);
    for (const n of this._nodes) visit(n);
    return list;
  }
  async startRendering() {
    if (!this._workletClass) throw new Error("no processor loaded");
    const out = new AudioBufferStub(this.numberOfChannels, this._length, this.sampleRate);
    this._destination._target = out._data;
    const order = this._order();
    const nCh = this.numberOfChannels;
    const BLK = 128;
    for (let off = 0; off < this._length; off += BLK) {
      const n = Math.min(BLK, this._length - off);
      for (const node of this._nodes) node._in = null;
      this._destination._offset = off;
      this._destination._ensureIn(n, nCh);
      for (const node of order) {
        if (node === this._destination) continue;
        if (typeof node._render === 'function') node._render(n);
      }
      // suspension points (progress reporting)
      if (this._suspends.length) {
        const t = (off + n) / this.sampleRate;
        const due = this._suspends.filter((s) => s.when <= t);
        if (due.length) {
          this._suspends = this._suspends.filter((s) => s.when > t);
          await new Promise((res) => { this._pausedResolve = res; due.forEach((s) => s.resolve()); });
        }
      }
    }
    this.state = 'closed';
    return out;
  }
}

/* ------------------------------------------------------------------ live context */

class AudioContextStub extends BaseContextStub {
  constructor(opts) {
    super(opts);
    this.sampleRate = 48000;
    this._t = 0;
    this.state = 'running';
  }
  get currentTime() { return this._t; }
  createAudioWorkletNode(name, opts) { return new WorkletNodeStub(this, name, opts); }
}

function install(win) {
  win.AudioContext = AudioContextStub;
  win.OfflineAudioContext = OfflineAudioContextStub;
  win.AudioWorkletNode = function (ctx, name, opts) {
    if (!ctx || typeof ctx.createAudioWorkletNode !== 'function') throw new Error('bad context');
    return ctx.createAudioWorkletNode(name, opts);
  };
  win.AudioBuffer = AudioBufferStub;
  return { AudioContextStub, OfflineAudioContextStub, AudioBufferStub };
}

module.exports = { install, AudioBufferStub, OfflineAudioContextStub, AudioContextStub, AudioWorkletNode: WorkletNodeStub };
