/* =============================================================================
 * Remaster Suite — neural bridge (AudioWorklet)
 * -----------------------------------------------------------------------------
 * Sits in the monitor's wet path, after the DSP processor:
 *
 *   remaster-processor → neural-bridge → wet gain
 *
 * It moves the audio through the ring buffers to the ML worker and back:
 * every 128-frame quantum is written into the input ring (the worker drains
 * it in hops), and what the worker has returned is pulled from the output ring
 * into a FIFO that is read out with a fixed fill level `fill`.
 *
 * The delay is `fill` frames by construction: the output pops a block only once
 * the FIFO holds `fill` frames, and it discards frames above that level. A worker
 * that runs early or late therefore changes how often the bridge underruns or
 * overruns (both are counted), never the latency — the dry path can be delayed
 * by exactly `fill` plus the model's own delay, for good.
 *
 * Messages (main → worklet):
 *   { type: 'rings', inputSab, outputSab, fill }   attach the rings, start
 *   { type: 'bypass', on }                          true: pass the input through
 *   { type: 'stop' }                                back to pass-through, drop state
 * Messages (worklet → main):
 *   { type: 'stats', underruns, overruns, primed }   on request ({ type: 'stats' })
 *
 * The ring module (assets/js/ring-buffer.js) must be added to the same context
 * first: it evaluates into the shared scope as `RSRing`.
 * ========================================================================== */
class NeuralBridge extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRing = null;
    this.outRing = null;
    this.active = false;     // rings attached and not stopped
    this.bypass = false;
    this.fill = 512;         // frames the bridge keeps in its FIFO = its delay
    this.cap = 16384;        // per-channel FIFO capacity, frames (power of two)
    this.mask = this.cap - 1;
    this.fifo = [];
    this.head = 0;           // read index
    this.count = 0;          // frames in the FIFO
    this.primed = false;
    this.underruns = 0;
    this.overruns = 0;
    this.tmp = null;
    this.port.onmessage = (ev) => this.onMessage(ev.data || {});
  }

  onMessage(d) {
    if (d.type === 'rings') {
      this.inRing = globalThis.RSRing.attach(d.inputSab);
      this.outRing = globalThis.RSRing.attach(d.outputSab);
      this.channels = this.inRing.channels;
      this.fill = Math.max(1, d.fill | 0);
      this.fifo = [];
      for (let c = 0; c < this.channels; c++) this.fifo.push(new Float32Array(this.cap));
      this.tmp = [];
      for (let c = 0; c < this.channels; c++) this.tmp.push(new Float32Array(128));
      this.head = 0;
      this.count = 0;
      this.primed = false;
      this.active = true;
    } else if (d.type === 'bypass') {
      this.bypass = !!d.on;
    } else if (d.type === 'stop') {
      this.active = false;
      this.inRing = null;
      this.outRing = null;
    } else if (d.type === 'stats') {
      this.port.postMessage({
        type: 'stats', underruns: this.underruns, overruns: this.overruns,
        primed: this.primed, fifo: this.count,
      });
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    const inp = inputs[0];
    if (!this.active || this.bypass || !inp || !inp.length) {
      for (let c = 0; c < out.length; c++) {
        const d = out[c];
        if (inp && inp[c]) d.set(inp[c].subarray(0, n)); else d.fill(0);
      }
      return true;
    }

    // to the worker: a mono input feeds both ring channels
    const src = [];
    for (let c = 0; c < this.channels; c++) src.push(inp[Math.min(c, inp.length - 1)]);
    this.inRing.write(src, n, 0);

    // from the worker: take every whole block that is waiting, bounded by the FIFO
    while (this.outRing.available() >= n && this.count + n <= this.cap) {
      const got = this.outRing.read(this.tmp, n, 0);
      if (got < n) break;
      for (let c = 0; c < this.channels; c++) {
        const f = this.fifo[c];
        for (let i = 0; i < n; i++) f[(this.head + this.count + i) & this.mask] = this.tmp[c][i];
      }
      this.count += n;
    }

    // hold the delay at `fill`: frames above it are dropped and counted
    if (this.count > this.fill + 4 * n) {
      const drop = this.count - this.fill;
      this.head = (this.head + drop) & this.mask;
      this.count -= drop;
      this.overruns++;
    }

    if (!this.primed) {
      if (this.count >= this.fill) this.primed = true;
      else { for (let c = 0; c < out.length; c++) out[c].fill(0); return true; }
    }

    // read out n frames; a short FIFO plays what it has and counts the gap
    const k = Math.min(n, this.count);
    for (let c = 0; c < out.length; c++) {
      const f = this.fifo[Math.min(c, this.channels - 1)];
      const d = out[c];
      for (let i = 0; i < k; i++) d[i] = f[(this.head + i) & this.mask];
      for (let i = k; i < n; i++) d[i] = 0;
    }
    this.head = (this.head + k) & this.mask;
    this.count -= k;
    if (k < n) this.underruns++;
    return true;
  }
}

registerProcessor('neural-bridge', NeuralBridge);
