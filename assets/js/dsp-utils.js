/* =============================================================================
 * Remaster Suite — shared DSP utilities
 * -----------------------------------------------------------------------------
 * Framework-free helpers shared by the analyser, the renderer and the Node test
 * suite: FFT, spectra, loudness, noise-floor estimation, content metrics,
 * sample-rate sniffing and WAV writing.
 *
 * Classic script (no ES module syntax) so the exact same file can be loaded
 * with <script src>, via importScripts() in a worker, or through vm.runInContext
 * in Node tests.
 * ========================================================================== */
(function (global) {
  'use strict';

  const TWO_PI = Math.PI * 2;

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const db = (lin) => 20 * Math.log10(Math.max(lin, 1e-12));
  const lin = (d) => Math.pow(10, d / 20);

  /* ---------------------------------------------------------------- windows */

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / n);
    return w;
  }

  function blackman(n) {
    const w = new Float32Array(n);
    const a = TWO_PI / (n - 1);
    for (let i = 0; i < n; i++) {
      w[i] = 0.42 - 0.5 * Math.cos(a * i) + 0.08 * Math.cos(2 * a * i);
    }
    return w;
  }

  /* -------------------------------------------------------------------- FFT */

  /** In-place iterative radix-2 complex FFT (re/im are Float32Array/Array). */
  function fft(re, im) {
    const n = re.length;
    // bit reversal
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -TWO_PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
          const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr; cwr = nwr;
        }
      }
    }
  }

  /**
   * Averaged magnitude spectrum — as a sliceable step (see "sliced passes").
   * @returns {{step:object, value:function():object}}
   */
  function spectrumStep(channels, sr, opts) {
    const o = Object.assign({ fftSize: 4096, hop: 2048, maxFrames: 220, dbFloor: -120 }, opts || {});
    const n = o.fftSize, half = n / 2;
    const win = hann(n);
    let winSum = 0;
    for (let i = 0; i < n; i++) winSum += win[i];
    const len = channels[0].length;
    const nCh = channels.length;
    const totalFrames = Math.max(1, Math.floor((len - n) / o.hop) + 1);
    const step = Math.max(1, Math.floor(totalFrames / o.maxFrames));
    // the very offsets the plain loop would have visited, in the same order
    const offsets = [];
    for (let f = 0; f < totalFrames; f += step) offsets.push(f);
    const count = Math.min(offsets.length, o.maxFrames);
    const acc = new Float64Array(half + 1);
    const frameRms = [];
    const re = new Float32Array(n), im = new Float32Array(n);
    let frames = 0;
    let peak = 0;          // loudest sample actually analysed (see the floor below)
    const st = stepRange('spectrum', count, count * 610000, (from, to) => {
      for (let idx = from; idx < to && idx < count; idx++) {
        const off = offsets[idx] * o.hop;
        re.fill(0); im.fill(0);
        for (let c = 0; c < nCh; c++) {
          const s = channels[c];
          for (let i = 0; i < n; i++) {
            const x = s[off + i] || 0;
            re[i] += x * win[i];
            const a = x < 0 ? -x : x;
            if (a > peak) peak = a;
          }
        }
        // frame loudness (mono sum)
        let ms = 0;
        for (let i = 0; i < n; i++) {
          let v = 0;
          for (let c = 0; c < nCh; c++) v += (channels[c][off + i] || 0);
          v /= nCh;
          ms += v * v;
        }
        frameRms.push(Math.sqrt(ms / n));
        fft(re, im);
        for (let k = 0; k <= half; k++) {
          const m = re[k] * re[k] + im[k] * im[k];
          acc[k] += m;
        }
        frames++;
      }
    });
    return {
      step: st,
      value() {
        // 2/winSum converts a bin magnitude back to a sine-equivalent amplitude,
        // /nCh averages the channels, sqrt() undoes the power accumulation.
        const norm = 2 / (winSum * nCh);
        const out = new Float32Array(half + 1);
        const freq = new Float32Array(half + 1);
        // The floor is a depth *below this file's own peak*, not an absolute
        // −120 dBFS. An absolute floor clamps the whole spectrum of a quiet
        // file 20 dB early: bins that sat at −105 dBFS land on the floor, the
        // measured shape changes, and every number derived from the shape moves
        // with it — measured on one fixture, the codec cliff wandered 1 740 Hz
        // and shrank from 18.5 dB to 13.4 dB when the same file was measured
        // 20 dB down (scratch/analysis-scale.js). For a file that reaches full
        // scale the two floors are the same number, so nothing about a normal
        // master changes.
        const selfFloor = (peak > 1e-6 ? db(peak) : 0) + o.dbFloor;
        for (let k = 0; k <= half; k++) {
          const amp = Math.sqrt(acc[k] / Math.max(1, frames)) * norm;
          out[k] = Math.max(selfFloor, db(amp));
          freq[k] = k * sr / n;
        }
        frameRms.sort((a, b) => a - b);
        return {
          freq, db: out, n: half + 1, sr, binHz: sr / n, frameCount: frames,
          frameRms: Float32Array.from(frameRms),
        };
      },
    };
  }

  /**
   * Averaged magnitude spectrum of one or more channels.
   * @returns {{freq:Float32Array, db:Float32Array, n:number, sr:number, binHz:number,
   *            frameCount:number, frameRms:Float32Array}}
   */
  function spectrum(channels, sr, opts) {
    const sp = spectrumStep(channels, sr, opts);
    sp.step.slice(0, sp.step.units);
    return sp.value();
  }

  /** Average level (dB) of a spectrum between f1 and f2 Hz. */
  function bandLevel(spec, f1, f2) {
    let sum = 0, cnt = 0;
    for (let k = 0; k < spec.n; k++) {
      const f = spec.freq[k];
      if (f >= f1 && f <= f2) { sum += Math.pow(10, spec.db[k] / 10); cnt++; }
    }
    if (!cnt) return -120;
    return 10 * Math.log10(sum / cnt);
  }

  /**
   * Median level inside a band — robust against narrow tonal content.
   * @param {number[]} [excludeHz] frequencies to ignore (mains hum & harmonics)
   */
  const HUM_HZ = [50, 60, 100, 120, 150, 180, 200, 300];

  /**
   * The centre frequencies of the per-song corrective EQ — twelve log-spaced
   * bands from 50 Hz to 8 kHz (≈0.68 octave apart, so neighbouring bands
   * overlap and their sum is a smooth curve rather than twelve bumps).
   *
   * These are shared between the analyser (which measures the level and the
   * noise in each one) and presets.js (which decides what to do about it), and
   * between presets.js and the worklet, so a correction can never be computed
   * on different frequencies than it is applied to.
   */
  const EQ_CENTERS = [50, 80, 125, 200, 320, 500, 800, 1250, 2000, 3200, 5000, 8000];
  function bandMedian(spec, f1, f2, excludeHz) {
    const ex = excludeHz || HUM_HZ;
    const vals = [];
    for (let k = 0; k < spec.n; k++) {
      const f = spec.freq[k];
      if (f < f1 || f > f2) continue;
      let skip = false;
      for (let e = 0; e < ex.length; e++) if (Math.abs(f - ex[e]) < 6) { skip = true; break; }
      if (!skip) vals.push(spec.db[k]);
    }
    if (!vals.length) return -120;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }

  /** Smooth a spectrum with a moving average (for robust trend analysis). */
  function smoothSpec(spec, radius) {
    const r = radius || 2;
    const out = new Float32Array(spec.n);
    for (let k = 0; k < spec.n; k++) {
      let s = 0, c = 0;
      for (let j = -r; j <= r; j++) {
        const i = k + j;
        if (i >= 0 && i < spec.n) { s += spec.db[i]; c++; }
      }
      out[k] = s / c;
    }
    return out;
  }

  /* --------------------------------------------------------- spectral shapes */

  /** Frequency (Hz) where the spectrum falls below threshold below its own peak. */
  function hfCutoff(spec, thresholdDb) {
    const th = thresholdDb === undefined ? 32 : thresholdDb;
    const sm = smoothSpec(spec, 3);
    let peak = -200;
    for (let k = 0; k < spec.n; k++) {
      if (spec.freq[k] > 300 && spec.freq[k] < 18000) peak = Math.max(peak, sm[k]);
    }
    if (peak < -100) return 0;
    const lim = peak - th;
    let cut = 0;
    for (let k = spec.n - 1; k > 0; k--) {
      const f = spec.freq[k];
      if (f < 800 || f > 20000) continue;
      if (sm[k] > lim) { cut = f; break; }
    }
    return cut;
  }

  /** Energy ratio (dB) between two bands — the workhorse for tonal diagnosis. */
  function ratioDb(spec, f1a, f2a, f1b, f2b) {
    return bandLevel(spec, f1a, f2a) - bandLevel(spec, f1b, f2b);
  }

  /**
   * How far the spectrum falls in the 1.6 kHz *above* a measured ceiling.
   *
   * `hfCutoff` says *where* a file's top end ends; on its own that is a
   * location, and a location is not a defect. Measured on the app's own
   * material: the ceiling of a worn record sits at 13.8–16.8 kHz with 10–20 dB
   * of fall above it (a medium's slope into its own noise floor), a real
   * encoder wall sits at 6–16.5 kHz with **39–55 dB** of fall (the encoder
   * removes everything above it), and the app's own 320 kbit/s export — whose
   * de-hisser took down a hiss that had been carrying the top octave — lands at
   * 13.9 kHz with **24.6 dB**, i.e. between the two. That number is what
   * separates "the medium ends here" from "a bitrate removed this", and it is
   * what `codecLoss` in presets.js reads before it calls a ceiling a codec.
   *
   * @param {object} spec spectrum from `spectrum()`
   * @param {number} cutHz the measured ceiling (0 = none)
   * @returns {number} drop in dB over the next 1.6 kHz (0 when there is no ceiling)
   */
  function cutDropDb(spec, cutHz) {
    if (!(cutHz > 0)) return 0;
    const sm = smoothSpec(spec, 3);
    const df = spec.freq[1] - spec.freq[0];
    const pick = (f) => {
      let v = -200;
      for (let k = 0; k < spec.n; k++) if (Math.abs(spec.freq[k] - f) < df * 0.6) v = Math.max(v, sm[k]);
      return v;
    };
    return pick(cutHz) - pick(Math.min(cutHz * 1.6, 19900));
  }

  /**
   * Spectral slope in dB/octave measured between two reference bands.
   */
  function slopeDbPerOct(spec, lowF, highF) {
    const l = bandLevel(spec, lowF, lowF * 1.6);
    const h = bandLevel(spec, highF, highF * 1.6);
    const oct = Math.log2(highF / lowF);
    return (h - l) / oct;
  }

  /* ------------------------------------------------------- sliced passes -----
   * Every heavy pass over a file is written as a *step*: a range-addressable
   * loop whose accumulators survive between calls, plus a `value()` that turns
   * them into the answer. The same step object is then driven either
   *
   *   in one go   → `measure()` — the synchronous API the tuning law and the
   *                 test suite depend on, and
   *   in slices   → `measureAsync()` — the same work, yielding to the event loop
   *                 between slices, so a phone can paint a moving progress bar
   *                 and stay scrollable while a 10-minute file is measured.
   *
   * Both drivers call the same slice functions on the same units in the same
   * order, so they cannot disagree by one bit. That is the point of the shape:
   * a progress bar may never become a second implementation of the maths.
   *
   * `cost` is a rough relative cost per unit (nanoseconds on the reference
   * machine), used only to weight the progress bar and the time estimate.
   */

  /**
   * Declare a step: `units` addressable units, an estimated total `estCost`
   * (nanoseconds on the reference machine) and one `slice(from, to)`.
   *
   * `estCost` is fixed at build time and only ever used to weight the progress
   * bar, so the bar stays monotone even for the steps whose real unit count is
   * only known once an earlier step has run (the quiet-frame spectrum).
   */
  function stepRange(label, units, estCost, slice) {
    return { label, units, estCost: Math.max(0, estCost), slice };
  }

  /** A per-sample pass over one or more channels, in channel-major order. */
  function scanStep(label, channels, costPerSample, makeState, onSample, value) {
    const starts = [];
    let total = 0;
    for (const ch of channels) { starts.push(total); total += ch.length; }
    const st = makeState();
    const slice = (from, to) => {
      for (let c = 0; c < channels.length; c++) {
        const a = Math.max(from, starts[c]);
        const b = Math.min(to, starts[c] + channels[c].length);
        if (b <= a) continue;
        const ch = channels[c];
        const base = starts[c];
        for (let i = a; i < b; i++) onSample(st, c, ch, i - base);
      }
    };
    const out = stepRange(label, total, total * costPerSample, slice);
    out.value = value ? () => value(st) : null;
    out.state = st;
    return out;
  }

  /**
   * Yield to the event loop between slices — a macrotask, so the browser can
   * paint, scroll and accept input while a long file is being measured. A
   * `MessageChannel` would be marginally cheaper, but its port would keep a
   * Node test process alive after the last slice; a timer is exactly what the
   * spec calls a rendering opportunity anyway.
   */
  const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

  const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  /**
   * Run a list of steps to completion without yielding (the synchronous API).
   * @param {object[]} steps
   */
  function runSteps(steps) {
    for (const st of steps) {
      if (st.before) st.before();
      if (st.units > 0) st.slice(0, st.units);
    }
  }

  /** @param {{steps:object[], result:function():object}} plan */
  function runPlanSync(plan) {
    runSteps(plan.steps);
    return plan.result();
  }

  /**
   * Run a list of steps in slices, reporting progress and yielding in between.
   * @param {object[]} steps
   * @param {(p:number, label:string) => void} [onProgress] 0..1 of the whole list
   * @param {{budgetMs?:number, reportMs?:number}} [opts]
   */
  async function runStepsAsync(steps, onProgress, opts) {
    const o = opts || {};
    const budget = Math.max(4, o.budgetMs || 26);      // work per slice
    const reportMs = Math.max(16, o.reportMs || 60);   // DOM updates per second
    let total = 0;
    for (const st of steps) total += st.estCost || 0;
    let done = 0;                       // estimated work already finished
    let last = -1e9;
    if (onProgress) onProgress(0, steps.length ? steps[0].label : '');
    for (const st of steps) {
      if (st.before) st.before();
      const units = st.units | 0;
      if (units <= 0) continue;
      const share = st.estCost || 0;    // this step's slice of the bar
      let span = Math.max(1, Math.ceil(units / 10));
      let i = 0;
      while (i < units) {
        const prev = i;
        const to = Math.min(units, i + span);
        const t0 = clock();
        st.slice(prev, to);
        const dt = Math.max(0.25, clock() - t0);
        i = to;
        // keep each slice in the 8–35 ms region: long enough that the yield
        // costs nothing, short enough that a phone stays responsive
        span = Math.max(1, Math.min(Math.ceil(units / 2), Math.round(span * (budget / dt))));
        const now = clock();
        if (onProgress && (now - last >= reportMs || i >= units)) {
          last = now;
          onProgress(Math.min(1, (done + share * (i / units)) / (total > 0 ? total : 1)), st.label);
        }
        await nextTask();
      }
      done += share;
    }
    if (onProgress) onProgress(1, steps.length ? steps[steps.length - 1].label : '');
  }

  /** @param {{steps:object[], result:function():object}} plan */
  async function runPlanAsync(plan, onProgress, opts) {
    await runStepsAsync(plan.steps, onProgress, opts);
    return plan.result();
  }

  /* --- peak ---------------------------------------------------------------- */

  function peakStep(channels) {
    return scanStep('peak', channels, 1.5, () => ({ p: 0 }),
      (st, c, ch, i) => { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > st.p) st.p = a; },
      (st) => db(st.p));
  }

  function peakDb(channels) {
    const st = peakStep(channels);
    st.slice(0, st.units);
    return st.value();
  }

  /* --- filtering primitives ------------------------------------------------ */

  function biquadHP(sr, f, q) {
    const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
    const c = Math.cos(w), s = Math.sin(w), al = s / (2 * (q || 0.707));
    const a0 = 1 + al;
    return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  }

  function applyBiquad(signal, coef) {
    const [b0, b1, b2, a1, a2] = coef;
    let z1 = 0, z2 = 0;
    const out = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      const x = signal[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      out[i] = y;
    }
    return out;
  }

  /* --- loudness (ITU-R BS.1770 flavour) ------------------------------------ */

  function loudnessStep(channels, sr) {
    const nCh = channels.length;
    const len = nCh && channels[0] ? channels[0].length : 0;
    if (!nCh || !len) return { step: stepRange('loudness', 0, 0, () => {}), value: () => -70 };
    const [hb0, hb1, hb2, ha1, ha2] = biquadHP(sr, 60, 0.5);
    const sb0 = 1.53512485958697, sb1 = -2.69169618940638, sb2 = 1.19839281085285;
    const sa1 = -1.69065929318241, sa2 = 0.73248077421585; // BS.1770 high-shelf @ ~1.5 kHz
    const invCh = 1 / nCh;
    const st = { hz1: 0, hz2: 0, sz1: 0, sz2: 0, ms: 0 };
    const step = stepRange('loudness', len, len * 20, (from, to) => {
      for (let i = from; i < to; i++) {
        let x = 0;
        for (let c = 0; c < nCh; c++) x += channels[c][i];
        x *= invCh;
        const hy = Math.fround(hb0 * x + st.hz1);
        st.hz1 = hb1 * x - ha1 * hy + st.hz2;
        st.hz2 = hb2 * x - ha2 * hy;
        const sy = Math.fround(sb0 * hy + st.sz1);
        st.sz1 = sb1 * hy - sa1 * sy + st.sz2;
        st.sz2 = sb2 * hy - sa2 * sy;
        st.ms += sy * sy;
      }
    });
    return { step, value: () => -0.691 + 10 * Math.log10(st.ms / len) };
  }

  /**
   * The four per-sample measurements (peak, clipped samples, loudness and
   * dynamic range) in a *single* pass over the file.
   *
   * They used to be four separate passes reading every sample again — on a
   * three-minute stereo file that is 4 × 17 M reads of the same memory, and it
   * cost more than the arithmetic in all four put together. The numbers are the
   * same ones the individual steps produce (same filters, same windows, same
   * order of summation); only the memory traffic changed.
   */
  function coreSteps(channels, sr) {
    const nCh = channels.length;
    const len = nCh && channels[0] ? channels[0].length : 0;
    const idle = () => ({ step: stepRange('core', 0, 0, () => {}), peakDb: () => -70, clipRatio: () => 0, loudness: () => -70, dynamicRange: () => 20 });
    if (!nCh || !len) return idle();
    const [hb0, hb1, hb2, ha1, ha2] = biquadHP(sr, 60, 0.5);
    const sb0 = 1.53512485958697, sb1 = -2.69169618940638, sb2 = 1.19839281085285;
    const sa1 = -1.69065929318241, sa2 = 0.73248077421585;   // BS.1770 high-shelf @ ~1.5 kHz
    const invCh = 1 / nCh;
    const win = Math.max(256, Math.round(sr * 0.05));
    const mid = Math.floor(len / 2);
    const st = { hz1: 0, hz2: 0, sz1: 0, sz2: 0, ms: 0, peak: 0, clipped: 0, total: 0, winMs: 0,
      dcSum: new Float64Array(nCh), dcCount: 0,
      dcA: new Float64Array(nCh), dcB: new Float64Array(nCh), dcBc: new Float64Array(nCh) };
    const dr = [];
    const step = stepRange('core', len, len * 25, (from, to) => {
      for (let i = from; i < to; i++) {
        let x = 0, sq = 0;
        for (let c = 0; c < nCh; c++) {
          const v = channels[c][i];
          x += v;
          sq += v * v;
          const a = v < 0 ? -v : v;
          if (a > st.peak) st.peak = a;
          if (v > 0.994 || v < -0.994) st.clipped++;
          // DC offset. The mean of the whole file is the number that matters
          // (the chain's blockers remove it), but a mean can hide the shape of
          // the problem: a recording that is clean for a minute and then offset
          // by a bad edit averages close to zero. The mean of each half is kept
          // as well, so the diagnosis can say which of the two it is.
          st.dcSum[c] += v;
          if (i < mid) st.dcA[c] += v;
          else { st.dcB[c] += v; st.dcBc[c]++; }
          st.total++;
        }
        st.dcCount++;
        x *= invCh;
        const hy = Math.fround(hb0 * x + st.hz1);
        st.hz1 = hb1 * x - ha1 * hy + st.hz2;
        st.hz2 = hb2 * x - ha2 * hy;
        const sy = Math.fround(sb0 * hy + st.sz1);
        st.sz1 = sb1 * hy - sa1 * sy + st.sz2;
        st.sz2 = sb2 * hy - sa2 * sy;
        st.ms += sy * sy;
        st.winMs += sq;
        if ((i + 1) % win === 0) { dr.push(Math.sqrt(st.winMs / (win * nCh))); st.winMs = 0; }
      }
    });
    const idleStep = { units: 0, estCost: 0, label: 'core', slice: () => {} };
    return {
      step,
      peakDb: () => db(st.peak),
      // a recording that is not made of numbers: the loudness accumulator goes
      // non-finite the moment one sample does, and every IIR filter after this
      // point would carry that NaN to the end of the file
      nonFinite: () => !isFinite(st.ms),
      clipRatio: () => (st.total ? st.clipped / st.total : 0),
      loudness: () => -0.691 + 10 * Math.log10(st.ms / len),
      /**
       * DC offset in dBFS (how far the mean sits below full scale; −120 = none),
       * plus how much the two halves of the file differ — a large difference
       * means the offset came in with an edit rather than with the medium.
       */
      dcOffset: () => {
        if (!st.dcCount || !len) return { db: -120, driftDb: 0, static: true };
        let worst = 0, drift = 0;
        for (let c = 0; c < nCh; c++) {
          const whole = Math.abs(st.dcSum[c] / (len || 1));
          if (whole > worst) worst = whole;
          if (st.dcBc[c] > 0) {
            const a = Math.abs(st.dcA[c] / Math.max(1, mid));
            const b = Math.abs(st.dcB[c] / st.dcBc[c]);
            const d = db(b + 1e-12) - db(a + 1e-12);
            if (d > drift) drift = d;
          }
        }
        return { db: db(worst), driftDb: clamp(drift, 0, 60), static: drift < 12 };
      },
      dynamicRange: () => {
        if (dr.length < 4) return 20;
        const c = dr.slice().sort((a, b) => a - b);
        return db(c[Math.floor(c.length * 0.95)]) - db(c[Math.floor(c.length * 0.10)]);
      },
      // the four measurements are reported as their own steps so the plan (and
      // the progress bar) keeps its shape, but they cost nothing: the work is in
      // `step` above
      steps: [idleStep, idleStep, idleStep, idleStep],
    };
  }

  /** Integrated-style loudness (ITU-R BS.1770 flavour, approx ±1.5 LU). */
  function loudness(channels, sr) {
    const l = loudnessStep(channels, sr);
    l.step.slice(0, l.step.units);
    return l.value();
  }

  /* --- flat-top (clipping) detection --------------------------------------- */

  /**
   * Flat-top detection: every run of consecutive samples that are (a) at the
   * same sign, (b) within a hair of each other, and (c) near the file's *peak*
   * level is a candidate clipped waveform.
   *
   * The measurement is what lets the repair tell clipping from a merely loud
   * recording, and it is done in a single pass with no knowledge of the peak:
   * each candidate run is filed into a histogram by its magnitude, so the top
   * occupied bucket *is* the peak, and only what sits within 0.35 dB of it
   * counts as a plateau. For each such run the local period is estimated from
   * the zero crossings just before it (only when they are regular — a periodic
   * waveform is the only case where a period means anything), and the implied
   * amplitude follows from how long the plateau is: a sine of amplitude A
   * clipped at T stays at or above T while cos(ω·t) ≥ T/A, so
   * A = T / cos(ω·n/2). A 997 Hz sine clipped at 1.25 implies 2.0 dB that is
   * missing; the same sine *never* clipped implies 0.07 dB and is left alone.
   * Where the crossings are not regular the estimate falls back to the length
   * of the run alone, capped at +3 dB.
   *
   * Reference values: a healthy master has nothing near its peak that is flat;
   * a clipped master has 0.02 % (light) to 0.5 %+ (hard) of its samples in flat
   * runs at the peak level, 1–2 dB of peak missing.
   */
  /* --------------------------------------------------------------------------
   * Sibilance, measured where it actually happens.
   *
   * The existing `sibExcessDb` takes the *median* of the 5–9.2 kHz band against
   * the trend its 2.4–4 kHz region predicts. That is the right question for a
   * recording whose top end is uniformly too hot, and the wrong one for the way
   * sibilance really arrives: a singer's "s" occupies 5–15 % of the file, so a
   * median over the whole song barely moves. Measured on a fixture with 120 ms
   * "s" bursts 8 dB above the trend, `sibExcessDb` read 1.1 dB — below the 2.5 dB
   * where the de-esser starts — and the stage never engaged (see
   * scratch/acceptance.js: the sibilance row was the only defect left unrepaired).
   *
   * This walk asks the other question: in the *loudest* moments of the file, how
   * far above the file's own typical balance does the top end sit? It filters two
   * bands per 10 ms frame, takes the ratio, and reports how far the p95 of that
   * ratio stands above its median — gated to frames where the reference band has
   * real level, so a quiet frame (where both bands are noise) cannot answer.
   * ----------------------------------------------------------------------- */
  function sibStep(channels, sr) {
    const idle = () => ({ step: stepRange('sib', 0, 0, () => {}), value: () => ({ sibPeakDb: 0, sibSustained: 0, sibFrames: 0 }) });
    if (!channels.length || !channels[0].length) return idle();
    const F = Math.max(64, Math.round(sr * 0.01));        // 10 ms
    const nCh = channels.length;
    const per = channels.map((ch) => Math.floor(ch.length / F));
    let units = 0;
    for (const k of per) units += k;
    const hi = channels.map(() => { const b = new Biquad(); b.setBandpass(sr, 7000, 0.9); return b; });
    const lo = channels.map(() => { const b = new Biquad(); b.setBandpass(sr, 2600, 0.9); return b; });
    /* …and a band *above* the "s": a sibilant is band-limited to about 9 kHz —
     * that is what makes it a sibilant and not a cymbal, whose noise runs to the
     * end of the spectrum. Measured on the two files that were both named
     * `sibilance` by the earlier scan (probe `tools/work/sib6.js`): the
     * acceptance wash reads 7 kHz 12 kHz −0.47 dB in its median frame (broadband
     * noise), the audit's own sibilant +2.11 (narrow), and every burst fixture
     * +4.1 … +4.8. Below ~18 kHz a 12 kHz band is not representable
     * (`setBandpass` clamps at 0.49·sr) and the shape cannot be seen: that term
     * passes through as 1 and the scan keeps the two tests that need no 12 kHz
     * band — the crossover and the median. The limit is stated where the shape
     * is used. */
    const upOk = Math.min(12000, sr * 0.49) > 9000;
    const up = upOk ? channels.map(() => { const b = new Biquad(); b.setBandpass(sr, 12000, 0.9); return b; }) : null;
    const ratios = [], refs = [], shapes = [];
    const step = stepRange('sib', units, units * F * 3, (from, to) => {
      let base = 0;
      for (let c = 0; c < nCh; c++) {
        const end = base + per[c];
        if (from < end && to > base) {
          const ch = channels[c];
          const a = Math.max(from, base) - base;
          const b = Math.min(to, end) - base;
          for (let w = a; w < b; w++) {
            const off = w * F;
            let he = 0, le = 0, ue = 0;
            for (let i = off; i < off + F; i++) {
              const x = ch[i];
              const h = hi[c].process(x);
              const l = lo[c].process(x);
              he += h * h; le += l * l;
              if (upOk) { const u = up[c].process(x); ue += u * u; }
            }
            const hr = Math.sqrt(he / F), lr = Math.sqrt(le / F);
            if (lr > 1e-6) {
              ratios.push(20 * Math.log10(hr / lr));
              refs.push(lr);
              shapes.push(upOk ? 20 * Math.log10(hr / (Math.sqrt(ue / F) + 1e-20)) : 1);
            }
          }
        }
        base = end;
      }
    });
    return {
      step,
      value() {
        if (ratios.length < 8) return { sibPeakDb: 0, sibRawDb: 0, sibSustained: 0, sibFrames: ratios.length };
        /* the reference band has to be *doing something*: frames where the voice
         * is silent say nothing about sibilance, and in them both bands are just
         * the file's noise floor. Threshold at a quarter of the band's own p75. */
        const rs = refs.slice().sort((a, b) => a - b);
        const gate = 0.25 * rs[Math.floor(rs.length * 0.75)];
        const kept = [], keptShape = [];
        for (let i = 0; i < ratios.length; i++) if (refs[i] > gate) { kept.push(ratios[i]); keptShape.push(shapes[i]); }
        if (kept.length < 8) return { sibPeakDb: 0, sibRawDb: 0, sibSustained: 0, sibFrames: kept.length };
        kept.sort((a, b) => a - b);
        keptShape.sort((a, b) => a - b);
        const p50 = kept[Math.floor(kept.length * 0.5)];
        const p95 = kept[Math.min(kept.length - 1, Math.floor(kept.length * 0.95))];
        /* …and the scan has to be a scan of a *sibilant*, which is a narrower
         * claim than "the frame's 7 kHz/2.6 kHz balance is high": the balance
         * has to *cross over* in the burst frame. Two ways it crosses without a
         * sibilant behind it, both measured:
         *
         *  · **the 2.6 kHz band falls, not the 7 kHz band.** A phrased organ is
         *    the case that named a clean file: on the acceptance organ the ratio
         *    reads p50 −7.82 dB / p95 −2.27 dB — a *rise* of 5.55 dB, and the
         *    app read 1.00 of sibilance from it — but the 7 kHz band is the
         *    bed's noise floor the whole time (it lifts itself by 1.73 dB over
         *    the same frames). A singer's "s" does the opposite: p50 −2.19,
         *    p95 +3.43 (probe `tools/work/sib4.js`). So the peak only counts if
         *    the peak frame's balance is *positive* — 7 kHz above 2.6 kHz, the
         *    one claim a sibilant makes by definition. (The three organ voicings
         *    read −1.94 / −2.27 / −2.74, the four "s" settings +0.51 … +5.16,
         *    and the same "s" file 20 dB down reads *identically* — the test is a
         *    ratio of two bands of the same file and knows nothing of level.)
         *  · **the file is already sibilant in its median frame.** A sustained
         *    cymbal wash reads p50 +3.47 / p95 +5.99: its balance is over zero
         *    *all the time*, and the "peak" above it (2.52 dB) is a wash
         *    breathing, not a burst — the 7 kHz band never stands out of
         *    anything, so there is nothing for a de-esser to duck. The window
         *    below asks for the peak frame to be a *departure*: p50 negative.
         *    Measured on the whole battery (probes `tools/work/sib3-5.js`): the
         *    four "s" settings cross −2.2 → +0.5…+5.2; the organ, the bed, the
         *    vinyl and the cassette sims stay negative at both ends; the wash is
         *    positive at both ends. */
        const shape = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
        const shapeP50 = upOk ? keptShape[Math.floor(keptShape.length * 0.5)] : 1;
        const narrow = upOk ? shape((shapeP50 - 0.5) / 1) : 1;
        /* a file whose *median* frame has the 7 kHz band over its 2.6 kHz band is
         * continuously top-heavy; a "s" that never stops is one case, broadband
         * noise is another, and the shape tells them apart (measured: the
         * acceptance wash is not narrow, the audit sibilant is) */
        const sustained = p50 > 0.75 && p95 > 0 && narrow > 0.5 ? 1 : 0;
        /* the burst path needs the balance to *cross over* in the peak frame —
         * 7 kHz over 2.6 kHz, the one claim a sibilant makes — and it needs the
         * file not to be continuously positive (a wash that breathes has its
         * "peak" everywhere) */
        const form = sustained ? 1 : shape((p95 + 1.2) / 1.5) * shape((0.75 - p50) / 1.5);
        /* `sibRawDb` is the number this scan returned before the form existed —
         * the acceptance matrix prints it beside the gated one, the way the
         * crackle rows print "crest alone vs the app", so a row's before/after
         * is re-derivable from the measurement itself. */
        return {
          sibPeakDb: Math.max(0, (p95 - p50) * form),
          sibRawDb: Math.max(0, p95 - p50),
          sibSustained: sustained,
          sibFrames: kept.length,
        };
      },
    };
  }

  function flatTopStep(channels, sr) {
    const nCh = channels.length;
    const len = nCh && channels[0] ? channels[0].length : 0;
    const idle = () => ({ step: stepRange('clip', 0, 0, () => {}), value: () => ({
      flatRatio: 0, levelDb: -120, runCount: 0, runMedian: 0, overshootDb: 0, maxRun: 0, evidence: 0,
    }) });
    if (!nCh || !len) return idle();
    // A flat top is a run of samples that are equal *to the file's own
    // resolution*, so both the tolerance and the silence gate are relative to
    // this file's peak — 0.25 % of it (≈ −52 dBc) is the same 0.0025 that used
    // to be absolute, for a file that reaches full scale. Absolute, the
    // detector reads a quieter copy of one recording as a *more* clipped one:
    // consecutive samples differ by 20 dB less, so runs survive TOL longer and
    // the run statistics, the implied overshoot and the de-clip dose all follow
    // the upload's volume instead of the waveform (scratch/analysis-scale.js).
    let pk = 0;
    for (let c = 0; c < nCh; c++) {
      const ch = channels[c];
      for (let i = 0; i < ch.length; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > pk) pk = a; }
    }
    // 0.25 dB per bucket, 0 dBFS downwards: the top occupied bucket is the peak
    const NB = 256, BIN = 0.25, GATE = 1.4;              // 1.4 buckets = 0.35 dB
    const count = new Int32Array(NB);
    const samples = new Float64Array(NB);
    const lenSum = new Float64Array(NB);
    const lenMax = new Int32Array(NB);
    const impSum = new Float64Array(NB);
    const impN = new Int32Array(NB);
    let total = 0;
    const TOL = 0.0025 * pk;
    const SIL = 1e-5 * pk;
    for (let c = 0; c < nCh; c++) {
      const ch = channels[c];
      const st = { prev: 0, armed: false, len: 0, mag: 0, sign: 1, pos: 0,
        cross: new Int32Array(9), crossN: 0, crossW: 0 };
      const period = () => {
        if (st.crossN < 5) return 0;
        const k = (st.crossW - 1 + 9) % 9;
        let sum = 0, sum2 = 0, n = 0;
        for (let i = 1; i < st.crossN; i++) {
          const d = st.cross[(k - i + 1 + 9) % 9] - st.cross[(k - i + 9) % 9];
          sum += d; sum2 += d * d; n++;
        }
        if (!n) return 0;
        const mean = sum / n;
        const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        return (mean < 2 || sd / mean > 0.35) ? 0 : 2 * mean;
      };
      const file = (runLen, mag) => {
        const b = Math.min(NB - 1, Math.max(0, Math.floor((-20 * Math.log10(mag)) / BIN)));
        count[b]++;
        samples[b] += runLen;
        lenSum[b] += runLen;
        if (runLen > lenMax[b]) lenMax[b] = runLen;
        const p = period();
        let implied;
        if (p > 0) {
          const w = Math.min(1.4, (2 * Math.PI / p) * runLen * 0.5);
          implied = -20 * Math.log10(Math.cos(w));
        } else {
          implied = Math.min(3, 0.9 + 0.25 * runLen);
        }
        impSum[b] += implied; impN[b]++;
      };
      for (let i = 0; i < ch.length; i++) {
        const x = ch[i];
        if ((x > 0 && st.prev <= 0) || (x < 0 && st.prev >= 0)) {
          if (st.crossN) {
            const k = (st.crossW - 1 + 9) % 9;
            if (st.pos - st.cross[k] > sr / 24) st.crossN = 0;
          }
          st.cross[st.crossW] = st.pos;
          st.crossW = (st.crossW + 1) % 9;
          if (st.crossN < 9) st.crossN++;
        }
        st.prev = x;
        const ax = x < 0 ? -x : x;
        if (ax > SIL) {
          if (st.armed && x * st.sign > 0 && Math.abs(ax - st.mag) <= TOL) {
            st.len++;
            st.mag = ax;
            if (st.len > 2048) st.armed = false;        // not a peak
          } else {
            if (st.armed && st.len > 1) file(st.len, st.mag);
            st.armed = true;
            st.len = 1;
            st.mag = ax;
            st.sign = x < 0 ? -1 : 1;
          }
        } else {
          if (st.armed && st.len > 1) file(st.len, st.mag);
          st.armed = false;
        }
        st.pos++;
        total++;
      }
      if (st.armed && st.len > 1) file(st.len, st.mag);
    }
    // the walk above is the step; nothing is left to slice, so it reports done
    const step = stepRange('clip', 0, 0, () => {});
    return {
      step,
      value: () => {
        let top = -1;
        for (let b = 0; b < NB; b++) if (count[b]) { top = b; break; }
        if (top < 0) return { flatRatio: 0, levelDb: -120, runCount: 0, runMedian: 0, overshootDb: 0, maxRun: 0, evidence: 0 };
        let n = 0, sm = 0, ls = 0, mx = 0, is = 0, inn = 0;
        for (let b = top; b <= Math.min(NB - 1, top + GATE); b++) {
          n += count[b]; sm += samples[b]; ls += lenSum[b];
          if (lenMax[b] > mx) mx = lenMax[b];
          is += impSum[b]; inn += impN[b];
        }
        const levelDb = -(top + 0.5) * BIN;
        const overshootDb = inn ? is / inn : 0;
        return {
          flatRatio: total ? sm / total : 0,
          levelDb,
          runCount: n,
          runMedian: n ? ls / n : 0,
          overshootDb,
          maxRun: mx,
          /* …and two *ceilings*, because the two terms above are both floors and
           * a square wave clears both of them: measured on a 55 Hz square
           * synthesizer on its own, the flat share at the peak is **100.000 %**
           * (every sample in the file is inside a plateau) with an implied
           * missing peak of **15.35 dB**. Programme clipped by a real transfer —
           * the same bed cut at 0.9, 0.7, 0.5 and 0.3 of its own peak, and the
           * acceptance matrix's over-limited master at a 0.70 rail — reads
           * 0.005 / 0.168 / 1.819 / 11.556 / 0.690 % and 1.65 / 1.80 / 1.93 /
           * 2.04 / 1.79 dB. Saturation is not in that population: a 15 dB
           * overshoot is not a peak to reconstruct, it is a waveform that never
           * had one, and a file whose plateaus *are* the waveform has nothing
           * left to interpolate between.
           *
           * The share ceiling is the wider of the two edges, and deliberately:
           * how much of a *legitimately* clipped file sits at the rail depends
           * on the source's own crest factor, not on the defect — a 997 Hz sine
           * cut 2 dB below its peak (the matrix's own clipping fixture) sits
           * there **42 %** of the time, where programme cut 2 dB down sits there
           * 0.005–11.6 %. So the ceiling starts at 70 % and is complete at 95 %,
           * above every clipping fixture the suite has and still catching a
           * waveform that is nothing but rails (measured: 100.000 %). The
           * overshoot ceiling is the sharper edge for that family anyway — a
           * square's is 15.35 dB against 1.65–2.05 dB for every clipped fixture
           * measured, so it starts at 5 dB and is complete at 10. (The square's
           * *crackle* reading is closed by its own gate in value() below; this
           * one is the clipping detector's.) */
          evidence: Math.min(1, (sm / total) / 0.004) * clamp((overshootDb - 0.6) / 2, 0, 1)
            * (1 - clamp((sm / total - 0.70) / 0.25, 0, 1))
            * (1 - clamp((overshootDb - 5) / 5, 0, 1)),
        };
      },
    };
  }

  /* --- crackle / click detection ------------------------------------------- */

  /**
   * Crackle / click detection.
   *
   * A vinyl pop, a digital glitch or a tape dropout is a *tall, narrow* spike,
   * so it stands out in the crest factor (peak ÷ RMS) of the 8.5 kHz+ band —
   * regardless of how loud the music is. The 98th percentile of the per-window
   * crest factors is immune to a single stray event but reacts immediately to
   * real crackle, and the *global* term (a quarter of the index) is the third
   * largest window peak, not the largest: crackle is a repeated event.
   *
   * Reference values: clean music ≈ 13 dB · light crackle ≈ 20 dB · worn vinyl ≈ 24 dB+.
   *
   * Two measurements decide which windows are allowed to speak, and both were
   * wrong once (see the gate in value() and the rank in the global term):
   *
   *   · the selection is *relative* — a window counts when its HF energy is
   *     within ~26 dB of the file's own typical HF window. The absolute
   *     rms > 1e-5 it used to be *was* the statistic on tonal material: only
   *     the windows the analysis's own 8.5 kHz high-pass rings in at the start
   *     passed it, and the 98th percentile of three windows is the
   *     second-highest of them;
   *   · the index is scale-invariant, by construction (every term is a ratio
   *     inside a window) and by measurement — the same fixtures at 0, −10, −20
   *     and −30 dB read 0.004 / 0.004 / 0.004 / 0.004 (a pink bed), 0.000 …
   *     0.000 (a 1 kHz sine), 0.956 at every level (a vinyl sim) — so the
   *     selection has to be too.
   *
   * The population it separates, measured (index): a pink bed 0.004, the same
   * bed with three sustained sub-bass tones on it 0.004, a 1 kHz sine 0.000,
   * white noise 0.000, a cassette sim 0.000, a low-bitrate sim 0.008 — and a
   * garage sim 0.817, a vinyl sim 0.956, the worn-record fixture 1.000. Before
   * the two fixes the same set read 0.075 / 0.175 / 0.108 / 0.000 / 0.022 /
   * 0.026 — and the 0.175 was enough to pass the classifier's own "there is
   * crackle here" gate (0.06) and hand a *clean, tonal* master the vinyl
   * chain: a 0.45 de-click dose on material with no clicks, the sub-sonic
   * guard, and a card naming "rumble, crackle". With the statistic honest the
   * same file is a general profile, dose 0.08, and the card names only what is
   * actually there.
   */
  function crackleStep(channels, sr, winSec) {
    const [b0, b1, b2, a1, a2] = biquadHP(sr, 8500, 0.707);
    const win = Math.max(64, Math.round(sr * (winSec || 0.02)));
    const per = channels.map((ch) => (ch.length >= win ? Math.floor((ch.length - win) / win) + 1 : 0));
    let units = 0;
    for (const k of per) units += k;
    const state = channels.map(() => ({ z1: 0, z2: 0 }));
    /* Per window: its HF energy and its HF peak. The *selection* of which
     * windows carry the statistic is made in value(), against the file's own
     * HF level — see the gate there. */
    const st = { ms: [], peak: [], duty: [], flat: [], wid: [], spikeFrames: 0, crests: [], peaks: [], gPeak: 0, gSum: 0, gCount: 0, pops: 0 };
    /* one window of band-passed samples, kept for the second pass that measures
     * how much of the window sits near its own peak — see the duty gate in value() */
    const spikeBuf = new Float32Array(win);
    /* …and the transform behind the *tonal* admission (see value()): a click the
     * cartridge rings out is a damped *tone* in this band, and a tone is the one
     * thing a hi-hat, a cymbal and a sibilant are not. One FFT per window, on the
     * same band-passed samples, and only where the duty test has not already
     * decided the window (duty > 0.04). The band is 6–24 kHz: below 6 kHz the
     * transform would be describing the music, not the analysis band. */
    const nf = 1 << Math.ceil(Math.log2(Math.max(256, win)));
    const hwin = hann(win);
    const re = new Float32Array(nf), im = new Float32Array(nf);
    const bandLo = Math.ceil(6000 / (sr / nf)), bandHi = Math.min(nf / 2 - 1, Math.floor(24000 / (sr / nf)));
    const flatness = () => {
      let tot = 0, lg = 0, nb = 0;
      for (let b = bandLo; b <= bandHi; b++) { const v = re[b] * re[b] + im[b] * im[b]; tot += v; lg += Math.log(v + 1e-30); nb++; }
      return tot > 1e-30 && nb > 0 ? Math.exp(lg / nb) / (tot / nb) : 1;
    };
    const step = stepRange('crackle', units, units * win * 1.6, (from, to) => {
      let base = 0;
      for (let c = 0; c < channels.length; c++) {
        const end = base + per[c];
        if (from < end && to > base) {
          const ch = channels[c];
          const s = state[c];
          const a = Math.max(from, base) - base;
          const b = Math.min(to, end) - base;
          for (let w = a; w < b; w++) {
            const off = w * win;
            let peak = 0, ms = 0;
            for (let i = off; i < off + win; i++) {
              const raw = ch[i];
              const x = Math.fround(b0 * raw + s.z1);
              s.z1 = b1 * raw - a1 * x + s.z2;
              s.z2 = b2 * raw - a2 * x;
              const aa = x < 0 ? -x : x;
              if (aa > peak) peak = aa;
              ms += x * x;
              spikeBuf[i - off] = x;
            }
            /* how much of the window sits within 10 dB of its own peak. The
             * ratio is scale-invariant: a *noise* process fills a third of any
             * window above 0.3·peak whatever its level — the peak of 960
             * Gaussian samples is ~3.3σ, so 0.3·peak is ~1σ and a third of the
             * samples sit above 1σ — while a spike of one to three samples
             * measures 0.001–0.02. Measured, the duty of the eight
             * tallest-crest windows: crackle 0.002–0.02, the sibilance fixture
             * 0.13–0.47, a clean bed 0.24–0.45, a hiss 0.22–0.39, a squashed
             * master 0.21–0.38. */
            const nearTh = 0.3 * peak;
            let near = 0, ipk = 0, best = -1;
            for (let i = 0; i < win; i++) {
              const a = spikeBuf[i] < 0 ? -spikeBuf[i] : spikeBuf[i];
              if (a > nearTh) near++;
              if (a > best) { best = a; ipk = i; }
            }
            const duty = near / win;
            st.duty.push(duty);
            /* A window the duty test already takes needs no transform; one whose
             * duty is above the sustained-tone bound cannot be taken either, so
             * only the band between them is measured. */
            let flat = 1;
            if (duty > 0.04 && duty <= 0.25) {
              for (let i = 0; i < nf; i++) { re[i] = i < win ? spikeBuf[i] * hwin[i] : 0; im[i] = 0; }
              fft(re, im);
              flat = flatness();
            }
            st.flat.push(flat);
            /* …and how long the tallest excursion in the window takes to fall
             * 20 dB from its own peak, in samples. That is the *duration* of the
             * spike, and duration is the one thing a click and a musical hit do
             * not share: a click is over in the analysis filter's own ring
             * (~0.1 ms), a hit rings for as long as the drum does (0.4 ms and
             * up). The threshold is 20 dB rather than 6 because at −6 dB both
             * are inside the filter's ring and the two families measure 3 and 3;
             * at −20 dB they separate. It is a *witness* now, not a gate — the
             * duration gate that used it is gone, see value(). */
            let wid = win;
            if (best > 1e-20) {
              const th = 0.1 * best;
              wid = 1;
              for (let i = ipk - 1; i >= 0 && Math.abs(spikeBuf[i]) >= th; i--) wid++;
              for (let i = ipk + 1; i < win && Math.abs(spikeBuf[i]) >= th; i++) wid++;
            }
            st.wid.push(wid);
            st.gSum += ms; st.gCount += win;
            if (peak > st.gPeak) st.gPeak = peak;
            st.ms.push(ms); st.peak.push(peak);
            st.peaks.push(peak);
            const rms = Math.sqrt(ms / win);
            if (rms > 1e-12) st.crests.push(peak / rms);   // which of these count is decided in value()
          }
        }
        base = end;
      }
    });
    return {
      step,
      value() {
        /* ── which windows carry this statistic ─────────────────────────────
         * A window counts when its HF energy is within ~26 dB of the file's own
         * *typical* HF window (5 % of the median). The gate used to be an
         * absolute rms > 1e-5, and on material whose HF is nearly nothing —
         * a sustained tone, a sub-bass drone, a sine test signal — that gate is
         * the whole statistic: only the few windows the 8.5 kHz high-pass rings
         * in at the start pass it, and the 98th percentile of three windows is
         * the second-highest of them. Measured: a plain 1 kHz sine read 0.108 of
         * "crackle", and a bed of pink noise with three sustained low tones on
         * it read 0.175 against 0.075 for the same bed without them — enough to
         * pass the classifier's own "there is crackle here" gate (0.06) and put
         * a *clean, tonal* master into the vinyl profile, where the chain then
         * applied a 0.45 de-click dose and a sub-sonic guard to material with no
         * clicks and no rumble (measured end to end: 2.2 dB of level and 3.5 dB
         * of its 35 Hz note, with the card naming "rumble, crackle").
         * A relative gate is scale-invariant by construction: the statistic is
         * unchanged when the file is scaled (measured: the same fixture at 0,
         * −10, −20 and −30 dB reads 0.075 / 0.075 / 0.075 / 0.075 and a vinyl
         * sim 0.993 at every level), so the selection has to be too. */
        const sortedMs = st.ms.slice().sort((a, b) => a - b);
        const hfMed = sortedMs.length ? sortedMs[Math.floor(sortedMs.length * 0.5)] : 0;
        const gate = Math.max(hfMed * 0.05, 1e-20);
        const crests = [], peakKept = [], widKept = [], rankKept = [];
        let gSum = 0, gCount = 0, gPeak = 0, spikeCount = 0;
        for (let i = 0; i < st.ms.length; i++) {
          if (st.ms[i] <= gate) continue;
          gSum += st.ms[i]; gCount += win;
          if (st.peak[i] > gPeak) gPeak = st.peak[i];
          /* ── which windows describe a *spike* ─────────────────────────────
           * A window whose energy is spread through it is a noise process —
           * hiss, a cymbal, a sibilant — and its crest says nothing about
           * clicks: a tall narrow peak is a spike only when the rest of the
           * window is quiet underneath it. Without this gate the statistic is a
           * *level* measure of the top end on such material, and it names faults
           * that are not there: measured, the sibilance fixture (section 10 of
           * the acceptance matrix — a clean bed with twelve "s" bursts on it)
           * read 0.269 of "crackle", above both the classifier's gate and the
           * vinyl profile's, so the chain put a 0.51 de-click dose on material
           * whose only defect was sibilance: it damaged the file it was asked to
           * repair. The gate sits in the gap the distributions leave, and the
           * gap is wide: the pop windows of the crackle and worn-rip fixtures
           * measure 0.002–0.02 (a 128 kbit/s arrival included), the "s" onsets
           * of the sibilance fixture 0.045–0.12, the noise windows of every
           * fixture 0.20–0.60. At 0.04 the gate is a factor of two above the
           * highest pop measured and below every onset measured, and a sweep
           * over 0.04 / 0.08 / 0.12 / 0.15 / 0.20 / 0.30 (acceptance fixtures,
           * their chain outputs, a clean bed, a hiss, the squashed master) puts
           * the working range at 0.04–0.04 ±: at 0.30 the sibilance fixture is
           * back to 0.399 and the *card* is vinyl again, at 0.08 it is 0.181.
           * 0.04 is the one value at which every fixture reads its class.
           * A non-spike window takes the floor value 1 (0 dB, far below the
           * 13 dB knee) rather than being dropped: the 98th percentile then
           * still asks for *repeated* spikes, exactly as the rank-3 global term
           * does, so a single glitch cannot carry the index — and a file the
           * chain has repaired falls back to the floor. */
          /* ── …and the second family the duty test cannot take ────────────
           * A stylus click is not an impulse in the air: it excites the
           * cartridge's own resonance and rings there, 0.3 … 3 ms of damped
           * *tone* at 8–12 kHz. A ring that long fills its window, so its duty
           * sits in the 0.045–0.12 band a sibilant onset occupies (round 15's
           * probe: duty p50 0.063, 71 of 72 windows in that band) and the duty
           * gate above cannot take it without taking the sibilants. What
           * separates them is not level and not duration — it is *tonality*, and
           * the measurement is the spectral flatness of the window (geometric
           * over arithmetic mean of the 6–24 kHz bins, one 1024-point FFT on the
           * Hann-windowed band-passed samples):
           *
           *   the ring family    τ 0.6 / 1.0 / 1.5 / 2.5 ms   0.11 · 0.07 · 0.055 · 0.032   (p50)
           *                 …and their p90 across 66–74 windows: 0.14 · 0.11 · 0.077 · 0.061
           *   a sibilant onset  12 "s" bursts on a bed        0.269 … 0.584   (p10 … p90)
           *   a hi-hat pattern   3 ms noise bursts, 5 ms tail    0.488 … 0.587
           * a 320 kbit/s export of the sibilant fixture        0.065 … 0.196 over 30 windows
           *   a clean bed, a bell, a damped *musical* blip     0.5 and up, or the duty test's bounds
           *
           * The threshold sits in the gap the two distributions leave, and the value is
           * 0.10 — the *tightest* one the family survives: swept over 0.20 / 0.15 / 0.12 /
           * 0.10 / 0.08 (probe tools/work/wr24.js, the whole battery per step) the readings
           * of τ 0.6 / 1.0 / 1.5 / 2.5 ms come out 0.73 / 0.62 / 0.51 / 0.39 at every one
           * of them, while the number of windows admitted falls with the threshold
           * (τ 1.0 ms: 68 → 43). So the tightest one that costs the family nothing is
           * taken: it sits *below* the highest p90 the family reaches (0.14, at τ 0.6 ms,
           * whose windows the duty test already takes) and 2.7× below the lowest p10 the
           * sibilant family reaches (0.269).
           * The duty bound (0.25) is not the discriminator — it only keeps *sustained*
           * tones out, whose duty is 0.6 … 0.8: a long tone in this band is a note, not
           * a click, and a 90 ms bell or a synth pad stays where it was. What this
           * costs is stated below with the measurement: a *damped* 9 kHz tone burst
           * under 10 ms — a musical blip, not a click — is indistinguishable from a
           * stylus ring in every statistic measured here, and is repaired the way a
           * click is (which is what RX's de-click would do with it too).
           */
          const rms = Math.sqrt(st.ms[i] / win);
          const cf = st.peak[i] / rms;
          /* …and a window admitted on tonality is admitted only if it is a
           * *spike* by the same 13 dB measure the whole index is built on: the
           * tonality test alone can be fooled by a window whose HF is almost
           * nothing, where what reads flat is the analysis filter, not a click.
           * Measured, that is not hypothetical — the acceptance matrix's own
           * clean bed (8 s of pink noise through the chain's own 9 kHz low-pass,
           * no defect at all) has one such window (window 136 of 400: duty 0.226,
           * flatness 0.040, crest 4.17, HF energy 0.41× the file's median), and
           * it is the *same* window in every fixture built on that bed. With the
           * bound, that bed and the chain output of the cassette fixture (whose
           * one residual window reads 4.49) report no spike windows at all, and
           * the ring family loses only its own sub-knee windows (tau 2.5 ms: 12
           * of 71; tau 1.5 ms: 3 of 68) — the ones the index already discounts,
           * since neither its p98 term nor its rank can use a crest below 4.5. */
          const spike = st.duty[i] <= 0.04
            || (st.duty[i] <= 0.25 && st.flat[i] <= 0.10 && cf >= 4.5);
          if (spike) { spikeCount++; crests.push(cf); peakKept.push(st.peak[i]); widKept.push(st.wid[i]);
            /* ── …and which of them may carry the *repetition* rank ──────────
             * The rank term is the third tallest spike-window peak against the
             * file's own HF rms, and it is the one term a *sustained* HF event
             * can feed: a sibilant's onset windows are tall peaks whatever their
             * crest, and on the tonality admission (round 18) that is exactly
             * what a 320 kbit/s export of the clean sibilance fixture did —
             * index 0.155 with a p98 crest of 12.9 dB, i.e. *below* the 13 dB
             * knee the whole index is built on, carried entirely by the rank
             * (global crest 19.2 dB). So a window supplies the rank only if its
             * own crest reaches that knee (4.5 = 13 dB): the same rule the p98
             * term applies by construction, now applied to both. Measured, it
             * changes nothing else — the spike sets of every crackle fixture
             * stand at 19.8–25.1 dB of crest. */
            if (cf >= 4.5) rankKept.push(st.peak[i]); }
          else crests.push(1);
        }
        st.spikeFrames = spikeCount;
        st.crests = crests;
        for (const cf of crests) if (cf > 4.5) st.pops++;
        st.peaks = peakKept.length ? peakKept : st.peaks;
        st.gSum = gSum; st.gCount = gCount; st.gPeak = gPeak;
        const grms = Math.sqrt(st.gSum / Math.max(1, st.gCount));
        /* …and the global term is the *third* largest window peak, not the
         * largest. Crackle is a repeated event: one pop in a file is an edit, a
         * splice or a hiccup, and the largest peak of an ordinary recording is
         * the analysis filter's own settling transient — the 8.5 kHz high-pass
         * starts cold on sample 0, and its ring is the tallest peak in every
         * clean file (measured: the median bed's global crest is 15.5 dB and the
         * only window above its steady crest is window 0; a plain 1 kHz sine
         * reads a *3.0 dB* crest in 599 windows of 600 and 17.0 dB in the first).
         * With a rank-3 statistic the same bed reads 11.3 dB and the sine 3.0,
         * while dense crackle — where most windows are pops — is untouched:
         * measured, the worn upload reads 30.6 → 30.9 dB and the vinyl sim
         * 21.9 → 22.1. The weight is unchanged, so what this buys is precision:
         * a single glitch click in a clean master no longer contributes a
         * quarter of the crackle index on its own. */
        /* …and only spike windows may supply the rank: a file whose three
         * tallest HF windows are sustained noise — a cymbal, a sibilant, a hiss —
         * reads no repetition at all, where the rank used to be taken over every
         * window and the sibilance fixture scored 20.8 dB of "global crest" off
         * its own "s" bursts. */
        const peakRank = rankKept.length >= 3 ? rankKept.slice().sort((a, b) => b - a)[2] : 0;
        const globalCrestDb = 20 * Math.log10(peakRank / (grms + 1e-12));
        st.crests.sort((a, b) => a - b);
        const p98 = st.crests.length ? st.crests[Math.min(st.crests.length - 1, Math.floor(st.crests.length * 0.98))] : 1;
        const med = st.crests.length ? st.crests[Math.floor(st.crests.length * 0.5)] : 1;
        const crestP98Db = 20 * Math.log10(p98 + 1e-9);
        const medDb = 20 * Math.log10(med + 1e-9);
        /* ── …but a crest factor cannot tell damage from a performance ───────
         * Measured with these numbers on twelve-second fixtures built for both
         * families (spike windows of 400 · index · contrast = p98 − median
         * crest · the *duration* of the spike in samples, median/p90 over its
         * spike windows · share of spike windows wider than 0.25 ms):
         *
         *   72 pops on a bed         62/400  1.000  24.7 dB   5/6    ·   0 %
         *   72 weaker pops           54/400  1.000  23.4 dB   5/5    ·   2 %
         *   the vinyl sim            46/400  0.984  24.0 dB   6/7    ·   0 %
         *   the garage sim           17/400  0.728  19.8 dB   5/8    ·   0 %
         *   the worn rip             62/400  1.000  25.0 dB   5/6    ·   0 %
         *   the worn rip at 128k     60/400  1.000  25.1 dB   7/10   ·   0 %
         *   pops at 320 kbit/s       61/400  1.000  24.9 dB   8/9    ·   0 %
         *   pops under drum hits     60/400  1.000  24.8 dB   5/6    ·   0 %
         *   ── hits, as the burst model makes them (no body, no tail — the
         *   two subsections below are what removed the duration gate) ──
         *   hits of 0.4 ms           26/400  0.982  22.8 dB   9/18   ·  31 %
         *   hits of 0.8 ms           26/400  0.854  21.1 dB   8/19   ·  31 %
         *   hits of 2 ms              8/400  0.000   0.0 dB  15/23   ·   —
         *   a 55 Hz square wave     400/400  1.000   0.0 dB   4/4    ·   0 %
         *   the clean bed             1/400  0.000   0.0 dB   4/4    ·   0 %
         *
         * One gate, for the way this index named music, and it is on the
         * *index* only — the statistics above stay levels and stay worth
         * looking at:
         *
         *  · **contrast ≥ 6 dB.** A click *interrupts* its file; a square wave
         *    is nothing but edges, so all 400 of its windows are as spiky as one
         *    another and its own median crest equals its 98th percentile — 0.0 dB
         *    of contrast, where every crackle fixture above stands ≥ 19.8 dB
         *    above a median that is the floor. Its spikes are 4 samples wide;
         *    contrast is what sees it.
         *  · **…and no duration gate.** There used to be a second one —
         *    fewer than 15 % of the spike windows wider than 0.25 ms, measured
         *    as the −20 dB span of the tallest excursion. It is gone, and the
         *    measurement that removed it is this one: it was tuned on the
         *    harness's click model (one to three samples, 5–10 samples wide at
         *    −20 dB) and on music fixtures that were themselves click-shaped —
         *    an HP-3 kHz noise burst of 0.4–2 ms with no drum body behind it and
         *    no tail after it. Realistic percussion looks different, and it was
         *    never measured: a body plus a top end that rings for as long as the
         *    drum does. Built with the app's own filter coefficients, one
         *    fixture each (kick+snare+hi-hat groove · snare alone with a 130 ms
         *    tail · a snare roll at 8/s · a hi-hat with 45 ms · a crash with
         *    800 ms · a clave · a rimshot · a stick click with a 900 Hz body ·
         *    a 4 ms clave-like burst with a 1200 Hz body) every one of them
         *    reads **0 spike windows**, before and after this change, and the
         *    reason is the duty gate above and not the duration: a window that
         *    contains a hit *with a tail* is filled with the top end, so its
         *    samples are not 25 dB below its own peak, so it is not a spike.
         *    What the duration gate did reject was the click as the file really
         *    carries it: a stylus click is a damped oscillation at the
         *    cartridge resonance, not a one-sample impulse. Measured on a 9 kHz
         *    ring, 9 per second, amplitude 0.55, on a quiet bed, as
         *    (spike windows · share wider than 0.25 ms · index as it shipped):
         *
         *      τ 0.1 ms            56 ·  0 % · 1.00
         *      τ 0.3 ms            61 ·  8 % · 0.89
         *      τ 0.6 ms            58 · 21 % · **0.00**
         *      4 kHz, τ 0.6 ms     26 · 19 % · **0.00**
         *      12 kHz, τ 0.6 ms    57 · 98 % · **0.00**
         *      τ 0.6 on a crash     12 · 33 % · **0.00**
         *      τ 0.6 6/s on a groove 27 · 33 % · **0.00**
         *      a 130 Hz thump + ring 54 · 20 % · **0.00**
         *
         *    Six of the eight fixtures in the table were invisible to the
         *    chain — no card, no dose, the click left in the file, which is the
         *    beta report this is written for. Without the gate the same eight
         *    read 1.00 · 0.89 · 0.73 · 0.81 · 0.70 · 0.34 · 0.47 · 0.73 — and a
         *    ninth ring of the family, τ 1.5 ms, still reads 0.00: its ring fills
         *    the window, so its duty sits with the sibilant onsets and the gate
         *    above never lets it in (probe `node /tmp/duty15.js`: duty p50 0.063,
         *    71 of its 72 windows in the 0.045–0.12 band, 1 under the 0.04 gate —
         *    so 1 spike window, index 0.00, no dose, `node /tmp/gate5.js`) — and
         *    nothing else measured moved: the nine percussion fixtures above
         *    read 0.000 either way, a 55 Hz square reads 0.000 (its contrast is
         *    0.0 dB, and that is what keeps it out), a clean bed, a sibilant
         *    fixture, a cassette, a low-bitrate and a combo sim read 0.000, and
         *    the vinyl, garage and combo sims read 0.98 / 0.73 / 0.62 as before
         *    (a probe run over the whole battery: `node /tmp/gate5.js`).
         *
         *    Two costs are paid and stated. A *burst* of 0.4–2 ms with no body
         *    and no tail — the fixtures the old gate was tuned on — reads
         *    crackle again (0.98 / 0.85), because in every statistic measured
         *    here it *is* one: same duty (0.002–0.04), same crest, same one
         *    window of it. It is repaired like a click; the guard that protects
         *    a performance is the tail, and a recording that really is a train
         *    of such bursts will be de-clicked the way RX's de-click would
         *    de-click it. And a ring longer than about 1.2 ms was, until round
         *    18, out of reach: it fills a tenth of its window with samples near
         *    its own peak, which is the duty band a sibilant onset occupies
         *    (0.045–0.12), so the duty gate could not take it without taking the
         *    sibilants — a measured limit of that one statistic, not of the
         *    chain (a 1.5 ms ring is what a real stylus click does; it is the
         *    ninth member of this family and it read **0.00**). Round 18 lifted
         *    it with a *second*, independent admission — the window's tonality —
         *    documented at the gate in value(). Measured on the inputs, before →
         *    after that admission (probe tools/work/wr22.js):
         *
         *      τ 0.6 ms 9/s        0.729 → 0.729    hi-hats 3/s        0.000 → 0.000
         *      τ 1.0 ms 9/s        0.548 → 0.616    sibilance 12 "s"   0.000 → 0.000
         *      τ 1.5 ms 9/s        0.000 → 0.512    a 9.2 kHz bell     0.000 → 0.000
         *      τ 1.5 ms 3/s        0.000 → 0.499    the clean bed      0.000 → 0.000
         *      τ 1.5 ms 6/s @0.25  0.000 → 0.436    cassette sim       0.000 → 0.000
         *      τ 2.5 ms 9/s        0.000 → 0.386    low-bitrate sim    0.000 → 0.000
         *      72 pops on a bed    1.000 → 1.000    vinyl sim          0.984 → 0.984
         *      the worn 128 kbit/s 1.000 → 1.000    garage sim         0.728 → 0.728
         *                                          combo sim          0.615 → 0.643
         *
         *    and the price is stated with it: a *damped* 9 kHz tone burst under
         *    10 ms — a synth blip, a chime sample, a "laser" — is indistinguishable
         *    from a stylus ring in every statistic measured here; it reads 0.469
         *    where the shipped detector read 0.000. That is a deliberate trade,
         *    not an oversight: it is what a time-domain de-clicker does with such
         *    material (RX's included), the dose it earns is the same one a real
         *    ring earns, and what the chain then costs the blip is measured in the
         *    acceptance matrix, in the row beside the ring's own. */

        const widthMax = Math.max(2, Math.round(sr * 0.25e-3));
        let wide = 0;
        for (const w of widKept) if (w > widthMax) wide++;
        const wideShare = widKept.length ? wide / widKept.length : 0;
        widKept.sort((a, b) => a - b);
        const spikeWidth = widKept.length ? widKept[Math.floor(widKept.length * 0.5)] : 0;
        const spikeContrastDb = crestP98Db - medDb;
        const impulsive = spikeContrastDb >= 6;
        const index = impulsive
          ? clamp((crestP98Db - 13) / 10, 0, 1) * 0.75
            + clamp((globalCrestDb - 13) / 10, 0, 1) * 0.25
          : 0;
        // The index was briefly gated on how far the loud frames' peaks stood
        // above the file's *own* HF median, to stop a *repaired* file from
        // reading as still-crackly: every term above is a ratio inside a frame,
        // so it cannot see that the pops are gone — the few frames that still
        // carry energy look spiky against their own tiny rms. That gate is gone
        // again, for a better reason than it was added: the repair itself now
        // works (the de-hisser's gate was following its own key through every
        // pop, and the output guard was flattening the de-clipper's peaks), and
        // a chain that really removes the crackle makes this index read it.
        // Measured on the worn-record fixture: crest p98 25.9 dB with the pops,
        // 12.1 dB after the chain, against 11.3 dB for the *clean* copy of the
        // same record. The gate, meanwhile, was a false-negative generator on
        // dense crackle — a worn record through a 128 kbit/s encoder reads
        // 26.2 dB of p98 crest and was being scored 0.07 because the pops are so
        // dense that they *are* the file's median HF frame. Prominence is kept
        // in the returned statistics because it is a useful number to look at;
        // it no longer multiplies the index.
        st.peaks.sort((a, b) => a - b);
        const medPeak = st.peaks.length ? st.peaks[Math.floor(st.peaks.length * 0.5)] : 0;
        const p90Peak = st.peaks.length ? st.peaks[Math.min(st.peaks.length - 1, Math.floor(st.peaks.length * 0.90))] : 0;
        const prominenceDb = 20 * Math.log10((p90Peak + 1e-12) / (medPeak + 1e-12));
        return {
          index,
          crestP98Db,
          globalCrestDb,
          medianCrestDb: medDb,
          peakProminenceDb: prominenceDb,
          spikeFrames: spikeCount,
          frames: st.crests.length,
          spikes: st.pops,
          // the two gates behind `index`, in their own units, so a row can
          // witness them: the median duration of the file's spikes (samples to
          // fall 20 dB), how far their p98 crest stands above the file's own
          // median crest, and the share of spikes too wide to be clicks
          spikeWidth,
          spikeContrastDb,
          spikeWideShare: wideShare,
        };
      },
    };
  }

  function crackleDetect(channels, sr, winSec) {
    const c = crackleStep(channels, sr, winSec);
    c.step.slice(0, c.step.units);
    return c.value();
  }

  /* --- noise & surface noise ----------------------------------------------- */

  /**
   * Noise & surface-noise analysis (the heart of the auto-diagnosis).
   *
   * 1. Split the file into 50 ms frames and look at their loudness distribution.
   *    Frames that sit far below the musical average are the ones that reveal
   *    what the recording does when it is silent — that is where hiss, rumble
   *    and crackle live.
   * 2. Build the spectrum of those quiet frames only → "noise spectrum".
   *    Its SLOPE says what kind of noise it is:
   *      flat          → tape hiss / digital noise
   *      rolled off    → low-frequency rumble / hum
   * 3. Measure how much the high-frequency envelope FLUCTUATES inside the quiet
   *    parts: steady hiss is smooth, vinyl crackle bursts.
   *
   * @returns {{steps:object[], value:function():object, index:object}}
   */
  /** The band the top end is compared with for the hiss tilt: 700 Hz … 3 kHz. */
  const HISS_MID_HZ = 1450;
  const HISS_MID_Q = 0.63;

  function noiseStep(channels, sr) {
    const fftSize = 2048, hop = 1024, half = fftSize / 2;
    const win = hann(fftSize);
    let winSum = 0;
    for (let i = 0; i < fftSize; i++) winSum += win[i];
    const nCh = channels.length;
    const len = channels[0].length;
    const total = Math.max(1, Math.floor((len - fftSize) / hop) + 1);
    const norm = 2 / (winSum * nCh);

    // ---- 1. frame loudness distribution ---------------------------------
    // Alongside it, a 4–16 kHz follower built from the same frames: whether the
    // top end moves with the music or sits still is what separates a stationary
    // hiss floor from ordinary bright material (see hissDeficitDb below).
    const filters = [];
    const frames = [];                 // per channel, the window sums, filled as we filter
    const rings = [];                  // per channel, a sliding sum over the frame window
    for (let c = 0; c < nCh; c++) {
      const a = new Biquad(), b = new Biquad();
      a.setHighpass(sr, 4000, 0.707); b.setHighpass(sr, 4000, 0.707);
      // …and the band the top end is compared with: hiss is recognised by the
      // *tilt* of the top end, not by its level. The worklet uses the same two
      // bands, so what is measured here is what can be subtracted there.
      const ma = new Biquad(), mb = new Biquad();
      ma.setBandpass(sr, HISS_MID_HZ, HISS_MID_Q); mb.setBandpass(sr, HISS_MID_HZ, HISS_MID_Q);
      // …and a fourth follower for the *programme* band. "Which frames carry no
      // music" must not be asked of the full-band RMS, because a loud stationary
      // noise owns that number. Measured on a bed with sub-35 Hz rumble at 9 dB
      // of excess: the 8 % quietest frames by RMS carried 13 dB more programme
      // than the frames this band picks, and the rumble reading fell from +36 to
      // +9 dB *exactly as the rumble got louder* — the app stopped seeing the
      // defect it was looking at. A 200 Hz high-pass is enough: rumble and hum
      // live below it, hiss lifts every frame by the same amount and therefore
      // cannot reorder them.
      const pa = new Biquad(), pb = new Biquad();
      pa.setHighpass(sr, 200, 0.707); pb.setHighpass(sr, 200, 0.707);
      // ── the bands the bottom of the record is measured in ────────────────
      // Two poles each way would be enough for a band *energy* — except at the
      // one place that matters: a 2-pole low pass at 45 Hz is only 4 dB down at
      // 50 Hz, so the mains line sits inside the "20-45 Hz" band at nearly full
      // level. Measured, that is not a detail: on a garage fixture that is
      // high-passed at 150 Hz and has no bottom end at all, the 50 Hz line made
      // the band read 6.2 dB of "infra excess", and with the line notched out it
      // reads -16.4 dB. So the analysis cuts the mains out before it measures.
      //
      // It cuts it once, at the front — one comb of constant-Q notches (Q 20,
      // −60 dB at the centre, 2.5 Hz wide at 50 Hz) per channel, shared by the
      // three low-band chains. It used to notch each band separately and only
      // out to half an octave past the band edges, which is not a margin against
      // a 2-pole roll-off, and that was wrong in both directions, measured:
      //
      //   • *below* a band: half an octave under 90 Hz is 60 Hz, so the 60 Hz
      //     grid's fundamental was notched out of the 90-203 Hz reference band
      //     and the 50 Hz grid's was not — and a 2-pole high pass at 90 Hz
      //     passes 50 Hz at -10.6 dB (measured on the chain: -10.6 with the
      //     shipped notch list, -10.7 with no notches at all, -220 with one at
      //     50). Same record, layer by layer: +8.5 dB of infra excess with
      //     rumble and hiss, -12.0 dB with the hum added, the reference band up
      //     22 dB while the 20-45 Hz band did not move. A hum *hid* the rumble.
      //   • *above* a band: the harmonics between the half-octave margin and the
      //     filters' actual reach. On a clean bed, one line at -30.5 dBFS:
      //     100 Hz reads +20.0 dB of "excess", 150 Hz +13.5, 200 Hz +9.0,
      //     250 Hz +5.9, 300 Hz +2.6, and on a bed 10 dB drier 30.1 / 23.4 /
      //     18.5 — a mains harmonic of a recording that has no rumble *asked
      //     for a high-pass*, because the chain was told to trust that number.
      //
      // The reach is set by the chain's own measured gain (a pure line at f, as
      // HP → LP leaves it, dB):
      //
      //        f      50     60    100    120    150    180    200    250    300    400    600
      //   20-45    -4.1   -6.2  -14.1  -17.1  -21.0  -24.1  -25.9  -29.8  -33.0  -38.0  -45.0
      //  90-203  -10.6   -7.9   -2.4   -1.7   -1.7   -2.4   -3.1   -5.3   -7.6  -12.1  -18.9
      //
      // so the comb covers every harmonic of both grids from the fundamentals up
      // to 420 Hz — inside the reference band they arrive at 0 to -3 dB, and at
      // 100-300 Hz the 20-45 Hz band is still within 33 dB of them. Measured
      // after the comb, one line at -30.5 dBFS on a clean bed reads 0.5-2.0 dB
      // of excess at 50, 60, 100, 120, 150, 200, 250, 300, 350, 400 and 420 Hz
      // (the bed with no line reads 1.6), where before 100 Hz read 20.0 and
      // 150 Hz 13.5 — and on a bed 10 dB drier, where the same harmonic used to
      // read 30.1, it reads 1.5.
      //
      // The reach is where it stops being *reachable*: at 500 Hz the reference
      // band is 16 dB down, so a line there still reads -16.4 dB of "excess"
      // (measured — it hides a rumble rather than faking one) and a 10th
      // harmonic would have to sit within 16 dB of the fundamental, i.e. the
      // mains would have to be a square wave. Notching to 1.2 kHz would close
      // even that with ~25 more biquads per channel; it is not worth the
      // analysis time for a line no recording has.
      //
      // …and one measured property that is *not* repaired here, because it is
      // not a repair: a line that wanders — vinyl and tape wobble move it by
      // 0.2-2 %, far more than a 2.5 Hz notch can follow. Measured with a
      // 50…250 Hz hum wobbling ±1 % at 3 Hz: both bands rise by ~11 dB
      // (20-45: -66.1 → -55.8, 90-203: -67.7 → -55.5) while the *ratio* does
      // not move at all — a clean bed reads -0.1 dB of excess and a rumbly one
      // 14.5 dB, against 1.6 and 16.5 with the line steady. A steady line is
      // the case that fakes a rumble; a wandering one is self-cancelling. A
      // comb of three notches per harmonic (+0.75 %) would buy 12 dB of
      // suppression on a ±1 % wander and costs 0.3-0.5 dB of reference-band
      // energy, i.e. a recalibration; a tracking or spectral estimator would be
      // the real answer. Neither is needed for the verdict as measured.
      const mkComb = () => {
        const out = [];
        for (const mains of [50, 60]) {
          for (let h = 1; h * mains <= 420; h++) {
            const n = new Biquad();
            n.setNotch(sr, h * mains, 20);
            out.push(n);
          }
        }
        return out;
      };
      const kk = mkComb();
      const ka = new Biquad(), kb = new Biquad();     // 20-45 Hz
      ka.setHighpass(sr, 20, 0.707); kb.setLowpass(sr, 45, 0.707);
      const la = new Biquad(), lb = new Biquad();     // 45-90 Hz
      la.setHighpass(sr, 45, 0.707); lb.setLowpass(sr, 90, 0.707);
      const ra = new Biquad(), rb = new Biquad();     // 90-203 Hz
      ra.setHighpass(sr, 90, 0.707); rb.setLowpass(sr, 203, 0.707);
      filters.push({ a, b, ma, mb, pa, pb, ka, kb, la, lb, ra, rb, kk });
      frames.push({ raw: new Float64Array(total), hf: new Float64Array(total), mid: new Float64Array(total),
        prog: new Float64Array(total), low: new Float64Array(total), bass: new Float64Array(total),
        ref: new Float64Array(total) });
      rings.push({ raw: new Float32Array(fftSize), hf: new Float32Array(fftSize), mid: new Float32Array(fftSize),
        prog: new Float32Array(fftSize), low: new Float32Array(fftSize), bass: new Float32Array(fftSize),
        ref: new Float32Array(fftSize), i: 0, sr: 0, sh: 0, sm: 0, sp: 0, sl: 0, sb: 0, sf: 0 });
    }
    const frameRms = new Float32Array(total);
    const hfFrame = new Float32Array(total);
    const midFrame = new Float32Array(total);
    const progFrame = new Float32Array(total);
    const lowFrame = new Float32Array(total);      // 20-45 Hz
    const bassFrame = new Float32Array(total);     // 45-90 Hz
    const refFrame = new Float32Array(total);      // 90-203 Hz

    // The filtering pass *is* the frame measurement. It used to keep the whole
    // filtered signal in memory only to read it back three samples at a time —
    // 280 MB on a three-minute stereo file, and a second full pass over it. A
    // sliding sum over the same 2048-sample window the frames are cut with gives
    // the identical number with no storage at all.
    const stepHf = scanStep('noise-hf', channels, 22, () => ({}),
      (st, c, ch, i) => {
        const f = filters[c], r = rings[c];
        const v = ch[i];
        const hf = f.b.process(f.a.process(v));
        const md = f.mb.process(f.ma.process(v));
        const pg = f.pb.process(f.pa.process(v));
        // the three low bands read the signal with the mains combed out of it —
        // one pass over the comb, shared, instead of one bank per band
        let vc = v;
        for (let q = 0; q < f.kk.length; q++) vc = f.kk[q].process(vc);
        const vl = f.kb.process(f.ka.process(vc));
        const vb = f.lb.process(f.la.process(vc));
        const vf = f.rb.process(f.ra.process(vc));
        const qr = v * v, qh = hf * hf, qm = md * md, qp = pg * pg;
        const ql = vl * vl, qb = vb * vb, qf = vf * vf;
        r.sr += qr - r.raw[r.i]; r.raw[r.i] = qr;
        r.sh += qh - r.hf[r.i]; r.hf[r.i] = qh;
        r.sm += qm - r.mid[r.i]; r.mid[r.i] = qm;
        r.sp += qp - r.prog[r.i]; r.prog[r.i] = qp;
        r.sl += ql - r.low[r.i]; r.low[r.i] = ql;
        r.sb += qb - r.bass[r.i]; r.bass[r.i] = qb;
        r.sf += qf - r.ref[r.i]; r.ref[r.i] = qf;
        r.i++;
        if (r.i >= fftSize) r.i = 0;
        const end = i + 1 - fftSize;
        if (end >= 0 && end % hop === 0) {
          const fr = end / hop;
          if (fr < total) {
            frames[c].raw[fr] = r.sr; frames[c].hf[fr] = r.sh; frames[c].mid[fr] = r.sm;
            frames[c].prog[fr] = r.sp;
            frames[c].low[fr] = r.sl; frames[c].bass[fr] = r.sb; frames[c].ref[fr] = r.sf;
          }
        }
      });

    const stepFrames = stepRange('noise-frames', 1, 60000, () => {
      for (let fr = 0; fr < total; fr++) {
        let ms = 0, hs = 0, bs = 0, ps = 0, ls = 0, ks = 0, fs = 0;
        for (let c = 0; c < nCh; c++) {
          ms += frames[c].raw[fr]; hs += frames[c].hf[fr]; bs += frames[c].mid[fr];
          ps += frames[c].prog[fr]; ls += frames[c].low[fr]; ks += frames[c].bass[fr];
          fs += frames[c].ref[fr];
        }
        frameRms[fr] = Math.sqrt(ms / (fftSize * nCh));
        hfFrame[fr] = Math.sqrt(hs / (fftSize * nCh));
        midFrame[fr] = Math.sqrt(bs / (fftSize * nCh));
        progFrame[fr] = Math.sqrt(ps / (fftSize * nCh));
        lowFrame[fr] = Math.sqrt(ls / (fftSize * nCh));
        bassFrame[fr] = Math.sqrt(ks / (fftSize * nCh));
        refFrame[fr] = Math.sqrt(fs / (fftSize * nCh));
      }
    });

    // the distribution is read between the two loops, exactly as before
    const stats = { p02: 0, p05: 0, p20: 0, p50: 0, p70: 0, p90: 0, p98: 0, hfP02: 0, hfP98: 0,
      quietLimit: 0, progP70: 0, quietCount: 0, useAll: true, visit: null };
    const stepStats = stepRange('noise-stats', 1, 60000, () => {});
    stepStats.before = () => {
      const sorted = Float32Array.from(frameRms).sort();
      const sortedHf = Float32Array.from(hfFrame).sort();
      const sortedProg = Float32Array.from(progFrame).sort();
      const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
      const pctHf = (p) => sortedHf[Math.min(sortedHf.length - 1, Math.max(0, Math.floor(sortedHf.length * p)))];
      const pctProg = (p) => sortedProg[Math.min(sortedProg.length - 1, Math.max(0, Math.floor(sortedProg.length * p)))];
      stats.p02 = pct(0.02); stats.p05 = pct(0.05); stats.p20 = pct(0.20); stats.p50 = pct(0.50);
      stats.p90 = pct(0.90); stats.p98 = pct(0.98);
      stats.hfP02 = pctHf(0.02); stats.hfP98 = pctHf(0.98);
      stats.p70 = pct(0.70);
      // "quiet" is a statement about the programme: the 8 % of frames with the
      // least in the programme band are the frames without music in them, which
      // is the only place a noise floor can be read (see the follower above).
      stats.quietLimit = Math.max(pctProg(0.08), 1e-8);
      stats.progP70 = pctProg(0.70);
      let quietCount = 0;
      for (let fr = 0; fr < total; fr++) if (progFrame[fr] <= stats.quietLimit) quietCount++;
      stats.quietCount = quietCount;
      stats.useAll = quietCount < 4;
      // the frames the accumulation below will actually visit (≤ 400) — known
      // up front so the progress bar is weighted by real work, not by the file
      const visit = [];
      for (let fr = 0; fr < total && visit.length < 400; fr++) {
        if (!stats.useAll && progFrame[fr] > stats.quietLimit) continue;
        visit.push(fr);
      }
      stats.visit = visit;
    };

    const acc = new Float64Array(half + 1);
    const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
    let used = 0;
    const stepSpec = stepRange('noise-spectrum', 0, Math.min(400, total) * 120000, () => {});
    stepSpec.before = () => { stepSpec.units = stats.visit ? stats.visit.length : 0; };
    stepSpec.slice = (from, to) => {
      const visit = stats.visit || [];
      for (let v = from; v < to && v < visit.length; v++) {
        const fr = visit[v];
        const off = fr * hop;
        re.fill(0); im.fill(0);
        for (let c = 0; c < nCh; c++) {
          const ch = channels[c];
          for (let i = 0; i < fftSize; i++) re[i] += ch[off + i] * win[i];
        }
        fft(re, im);
        for (let k = 0; k <= half; k++) {
          const m = (re[k] * re[k] + im[k] * im[k]) * norm * norm;
          acc[k] += m;
        }
        used++;
      }
    };

    return {
      steps: [stepHf, stepFrames, stepStats, stepSpec],
      value() {
        const spec = new Float32Array(half + 1);
        const nUsed = Math.max(1, used);
        for (let k = 0; k <= half; k++) {
          spec[k] = Math.max(acc[k] / nUsed, 1e-20);
        }
        const bandSum = (f1, f2) => {
          let sum = 0;
          for (let k = 0; k <= half; k++) {
            const hz = k * sr / fftSize;
            if (hz >= f1 && hz <= f2) sum += spec[k];
          }
          return 10 * Math.log10(Math.max(sum, 1e-20));
        };
        const floorDb = bandSum(20, 20000);
        const hfFloorDb = bandSum(6000, 20000);
        const midFloorDb = bandSum(1000, 6000);
        const lowFloorDb = bandSum(30, 200);
        // Slope of the noise spectrum in dB per octave *of band power*:
        //   pink/analogue programme ≈ 0 · white (tape) hiss ≈ +3 · rumble sharply negative
        const lo = bandSum(600, 1200);
        const hi = bandSum(4800, 9600);
        const noiseSlope = hi - lo;
        const flatness = clamp(noiseSlope / 2.6, 0, 1);
        const rumble = clamp((lowFloorDb - midFloorDb + 6) / 18, 0, 1);
        const bbDynDb = db(stats.p98 + 1e-12) - db(stats.p02 + 1e-12);
        const hfDynDb = db(stats.hfP98 + 1e-12) - db(stats.hfP02 + 1e-12);
        const hissDeficitDb = clamp(bbDynDb - hfDynDb, -30, 30);
        // Does the top end *follow the programme*? A tape hiss sits still while
        // the music moves, so the 4–16 kHz follower and the frame level
        // decorrelate. This is the only hiss measure that works on material with
        // no quiet passage anywhere in it — where every window-based floor is
        // just the music itself — and it is what separates a dull, noisy
        // recording from a dull, clean one.
        let mr = 0, mh = 0;
        for (let fr = 0; fr < total; fr++) { mr += frameRms[fr]; mh += hfFrame[fr]; }
        mr /= total; mh /= total;
        let cr = 0, vr = 0, vh = 0;
        for (let fr = 0; fr < total; fr++) {
          const dr = frameRms[fr] - mr, dh = hfFrame[fr] - mh;
          cr += dr * dh; vr += dr * dr; vh += dh * dh;
        }
        const rho = (vr > 1e-20 && vh > 1e-20) ? cr / Math.sqrt(vr * vh) : 1;
        const hfFollowDb = 10 * Math.log10(Math.max(rho * rho, 1e-6));

        // ── the tilt of the top end, in the music and in the gaps ──────────
        // This is what identifies hiss. Music's top end is tied to its mids: when
        // the performance drops, the 4–16 kHz band drops with it and the tilt
        // (HF − MID) stays put. A hiss does not drop — so in the quiet frames the
        // tilt *rises* by exactly the amount of noise sitting in the HF band.
        // That difference is a calibrated number in dB: how much of the top end
        // is noise rather than programme, which is precisely what a repair may
        // take out (and all it may take out).
        // The frames are split by *how loud they are*, not by what their tilt
        // happens to be: the loud ones carry the programme (that is the tilt the
        // music has), the quiet ones are where the noise is left alone.
        const loudT = [], quietT = [];
        for (let fr = 0; fr < total; fr++) {
          if (!(midFrame[fr] > 1e-9 && hfFrame[fr] > 1e-9)) continue;
          const t = db(hfFrame[fr] / midFrame[fr]);
          if (progFrame[fr] >= stats.progP70) loudT.push(t);
          else if (progFrame[fr] <= stats.quietLimit) quietT.push(t);
        }
        const med = (arr) => {
          if (!arr.length) return 0;
          const c = arr.slice().sort((a, b) => a - b);
          return c[Math.floor(c.length / 2)];
        };
        const musicTiltDb = med(loudT);
        const hissTiltDb = med(quietT);
        // Where the HF band sits when the recording is quiet, as a *band RMS* —
        // the same quantity the worklet's sliding window produces, so the
        // threshold the repair is gated by is a number both sides agree on.
        const hfQuiet = [];
        for (let fr = 0; fr < total; fr++) if (progFrame[fr] <= stats.quietLimit) hfQuiet.push(hfFrame[fr]);
        const hfQuietRmsDb = (stats.useAll || hfQuiet.length < 4) ? db(stats.hfP02 + 1e-12) : db(med(hfQuiet));
        const hissTiltStepDb = (loudT.length >= 3 && quietT.length >= 3)
          ? clamp(hissTiltDb - musicTiltDb, 0, 24) : 0;
        /**
         * The noise floor per EQ band, from the same quiet frames the floor
         * itself is measured in. Two things need it: the diagnosis (which can
         * then say "the noise sits at 6.3 kHz and above" instead of "there is
         * hiss") and the per-song EQ (a band whose music is only 8 dB above the
         * noise floor must not be boosted — that would boost the noise).
         */
        const bandLevelArr = (v, f1, f2) => {
          let sum = 0, cnt = 0;
          for (let k = 0; k <= half; k++) {
            const hz = k * sr / fftSize;
            if (hz >= f1 && hz <= f2) { sum += v[k]; cnt++; }
          }
          return 10 * Math.log10(Math.max(cnt ? sum / cnt : 1e-20, 1e-20));
        };
        const noiseBandDb = EQ_CENTERS.map((f) => bandLevelArr(spec, f / 1.26, f * 1.26));
        /**
         * Rumble, measured where only rumble can be: in the quiet frames. Real
         * sub-bass leaves with the music; turntable rumble (and a desk fan, and
         * a building) is still there when the band stops playing.
         */
        // The comparison is between the quietest frames' 20-45 Hz energy and
        // their 90-203 Hz energy, as *band energies from filters* rather than as
        // sums of FFT bins. It is deliberately a near reference: a record's
        // spectrum is only approximately 1/f between the two bands, so every
        // octave of distance turns the recording's own low-frequency tilt into
        // "energy below 45 Hz" — measured, a clean full-band bed with an ordinary
        // +10 dB shelf below 150 Hz reads 12.1 dB of excess against a 311-700 Hz
        // reference and 4.6 against 90-203. The mains harmonics are outside both
        // bands, so hum cannot leak into this number at all.
        //
        // `infraBandsMean` keeps the same three bands as sums over the 43 ms
        // frames' spectrum — one bin wide at the bottom, right next to the mains
        // line. The tests use it to document why the measurement has a life of
        // its own: on a fixture that is high-passed at 150 Hz and has no bottom
        // end at all, that number reads 12.5 dB of "excess", and on a plain vinyl
        // sim with hum it reads -0.6.
        const bandSumArr = (v, f1, f2) => {
          let sum = 0;
          for (let k = 1; k <= half; k++) {
            const hz = k * sr / fftSize;
            if (hz >= f1 && hz <= f2) sum += v[k];
          }
          return 10 * Math.log10(Math.max(sum, 1e-20));
        };
        const infraBandsMean = [[20, 45], [45, 90], [90, 203], [203, 450]].map(([a2, b2]) => bandSumArr(spec, a2, b2));
        const quietFrames = [];
        for (let fr = 0; fr < total; fr++) {
          if (stats.useAll || progFrame[fr] <= stats.quietLimit) quietFrames.push(fr);
        }
        const medOver = (arr) => {
          if (!quietFrames.length) return 0;
          const c = quietFrames.map((fr) => arr[fr]).sort((x, y) => x - y);
          return c[Math.floor(c.length / 2)];
        };
        const infraBands = [db(Math.max(medOver(lowFrame), 1e-12)), db(Math.max(medOver(bassFrame), 1e-12)),
          db(Math.max(medOver(refFrame), 1e-12))];
        // The excess is the median of the *per-frame* ratio, not the ratio of the
        // medians: a crackle pop is a two-sample step, which is a broadband
        // event — it lifts all three bands in the frames it lands in, and those
        // frames are in the quiet set (measured on the garage fixture, 2.5 pops
        // a second moved the ratio-of-medians by +6 dB, i.e. straight into the
        // rumble decision, while the pops themselves are already handled by the
        // de-clicker). A ratio taken frame by frame sees a pop as "louder
        // everywhere" and a rumble as "louder only below 45 Hz", which is the
        // question that is actually being asked.
        const ratios = [];
        for (let fr = 0; fr < total; fr++) {
          if (!(stats.useAll || progFrame[fr] <= stats.quietLimit)) continue;
          if (!(lowFrame[fr] > 0 && refFrame[fr] > 0)) continue;
          ratios.push(db(lowFrame[fr]) - db(refFrame[fr]));
        }
        ratios.sort((x, y) => x - y);
        const infraExcessDb = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;
        // how much the *noise* floor itself moves between quiet passages: a
        // hiss that pumps is a different repair (slower release) from one that
        // sits still, and a recording whose floor moves a lot cannot be trusted
        // as much (the confidence above already carries part of that)
        const quietHf = [];
        for (let fr = 0; fr < total; fr++) if (progFrame[fr] <= stats.quietLimit) quietHf.push(hfFrame[fr]);
        const quietHfSorted = quietHf.slice().sort((p, q) => p - q);
        const qp = (p) => (quietHfSorted.length ? quietHfSorted[Math.min(quietHfSorted.length - 1, Math.floor(quietHfSorted.length * p))] : 0);
        const hfQuietSpreadDb = quietHfSorted.length >= 8 ? clamp(db(qp(0.90) + 1e-12) - db(qp(0.10) + 1e-12), 0, 40) : 0;
        // how much the recording actually breathes: a file with no quiet passages
        // gets confidence 0 — we then never claim noise that we cannot prove
        const frameRange = db(stats.p98) - db(stats.p05);
        return { spec, floorDb, hfFloorDb, midFloorDb, lowFloorDb, noiseSlope, flatness, rumble,
          bbDynDb, hfDynDb, hissDeficitDb, hfFollowDb, hfQuietRmsDb,
          musicTiltDb, hissTiltDb, hissTiltStepDb,
          noiseBandDb, infraExcessDb, infraBands, infraBandsMean, hfQuietSpreadDb,
          crackleIndex: 0, crestP98Db: 0, crestGlobalDb: 0, musicDb: db(stats.p98),
          quietLevelDb: db(stats.quietLimit), quietCount: stats.quietCount, total,
          confidence: clamp((frameRange - 5) / 12, 0, 1) * clamp(stats.quietCount / 4, 0, 1),
          dynamicRangeDb: db(stats.p98) - db(stats.p05),
          frameRms };
      },
    };
  }

  /**
   * Noise & surface-noise analysis of a whole file (synchronous form).
   * The crackle pass inside it is shared with `measure()`; this wrapper runs its
   * own so the function keeps working stand-alone.
   */
  function noiseAnalysis(channels, sr) {
    const nt = noiseStep(channels, sr);
    const crk = crackleStep(channels, sr);
    const steps = [nt.steps[0], nt.steps[1], nt.steps[2], nt.steps[3], crk.step];
    const plan = { steps, result: () => null };
    runPlanSync(plan);
    return Object.assign(nt.value(), {
      crackleIndex: crk.value().index,
      crestP98Db: crk.value().crestP98Db,
      crestGlobalDb: crk.value().globalCrestDb,
    });
  }

  /**
   * How ragged the top end is, in dB — median absolute deviation of the
   * spectrum from its own smoothed trend, measured above 2.5 kHz and below the
   * detected cliff.
   *
   * A naturally rolled-off old recording has a smooth slope; a badly encoded
   * one has holes, birdies and a comb. The number tells the synthesiser how
   * much it may trust the band it derives the missing top end from.
   */
  function hfRaggedness(spec, cut) {
    const sm = smoothSpec(spec, 2);
    const hi = clamp(cut && cut > 4000 ? cut : 8000, 3000, 16000);
    const vals = [];
    for (let k = 0; k < spec.n; k++) {
      const f = spec.freq[k];
      if (f < 2500 || f > hi) continue;
      vals.push(Math.abs(spec.db[k] - sm[k]));
    }
    if (vals.length < 12) return 0;
    vals.sort((a, b) => a - b);
    return clamp((vals[Math.floor(vals.length / 2)] - 1.5) / 6, 0, 1);
  }

  /* --- dynamic range, clipping, correlation -------------------------------- */

  /**
   * Dynamic range proxy: loud frame RMS minus quiet frame RMS.
   *
   * The frames are cut at fixed multiples of the window from the start of the
   * file and the RMS is accumulated per sample — the same numbers as summing
   * each window on its own, without reading the file a second time (the fused
   * `coreSteps` does the walk; this is the same measurement on its own).
   */
  function dynamicRangeStep(channels, sr) {
    const win = Math.max(256, Math.round(sr * 0.05));
    const nCh = channels.length, len = nCh && channels[0] ? channels[0].length : 0;
    if (!nCh || !len) return { step: stepRange('dynamic-range', 0, 0, () => {}), value: () => 20 };
    const count = len >= win ? Math.floor(len / win) + 1 : 0;
    const vals = [];
    let ms = 0;
    const step = stepRange('dynamic-range', len, len * 0.6, (from, to) => {
      for (let i = from; i < to; i++) {
        let sq = 0;
        for (let c = 0; c < nCh; c++) { const v = channels[c][i]; sq += v * v; }
        ms += sq;
        if ((i + 1) % win === 0) { vals.push(Math.sqrt(ms / (win * nCh))); ms = 0; }
      }
    });
    return {
      step,
      value() {
        if (vals.length < 4) return 20;
        vals.sort((a, b) => a - b);
        const lo = vals[Math.floor(vals.length * 0.10)];
        const hi = vals[Math.floor(vals.length * 0.95)];
        return db(hi) - db(lo);
      },
    };
  }

  function dynamicRange(channels, sr) {
    const d = dynamicRangeStep(channels, sr);
    d.step.slice(0, d.step.units);
    return d.value();
  }

  /** Fraction of samples sitting at digital full scale (clipping / limiting). */
  function clipStep(channels) {
    const nCh = channels.length;
    const len = nCh && channels[0] ? channels[0].length : 0;
    if (!nCh || !len) return { step: stepRange('clip', 0, 0, () => {}), value: () => 0 };
    const st = { clipped: 0, total: 0 };
    const step = stepRange('clip', len, len * 1.6, (from, to) => {
      for (let i = from; i < to; i++) {
        for (let c = 0; c < nCh; c++) {
          const v = channels[c][i];
          if (v > 0.994 || v < -0.994) st.clipped++;
          st.total++;
        }
      }
    });
    return { step, value: () => (st.total ? st.clipped / st.total : 0) };
  }

  function clipRatio(channels) {
    const st = clipStep(channels);
    st.slice(0, st.units);
    return st.value();
  }

  /* --- mains hum, measured exactly --------------------------------------- */

  /** The mains grid, and the control frequencies the floor is read from. */
  const HUM_SET = {
    50: { mains: [50, 100, 150, 200], floor: [43, 54, 66, 78, 92, 112, 138, 168] },
    60: { mains: [60, 120, 180, 240], floor: [52, 65, 74, 88, 104, 132, 156, 196] },
  };

  /**
   * Mains hum, measured where it actually is.
   *
   * The detector this replaces read the spectrum through `bandMedian`, which
   * *excludes* ±6 Hz around 50/60/100/120/150/180/200/300 — it was asking a band
   * with the hum filtered out of it and could only ever answer "no hum". Reading
   * raw FFT bins instead is luck of the bin grid: at 48 kHz an 8192-point
   * transform has 5.86 Hz bins, so 50 and 60 Hz both fall between bins and which
   * one "wins" depends on leakage from the music.
   *
   * This measures the exact frequencies with a sliding Goertzel over up to 48
   * segments spread across the file, and compares them with control frequencies
   * just off the mains grid. Two properties matter for a repair with −40 dB of
   * authority, and both come from that:
   *   · the level is exact, not grid-dependent;
   *   · hum is *stationary* — a bass note is not. `steady` is the share of
   *     segments where the tone is within 6 dB of its own median, which is what
   *     keeps a sustained musical note out of the notch.
   *
   * Hum is common-mode, so two channels are summed before the measurement.
   */
  function humStep(channels, sr) {
    const a = channels[0];
    const b = channels.length > 1 ? channels[1] : null;
    const n = a.length;
    // A one-second window: wide enough that a 5 Hz shoulder sits five bins away
    // (a Hann window leaks less than −50 dB there), so the *tonality* of a mains
    // line can be measured over 40+ dB instead of the 12 dB a short window
    // affords.
    const segLen = Math.max(64, Math.round(sr * 1.0));
    const segCount = clamp(Math.floor(n / segLen), 1, 48);
    const stride = Math.max(segLen, Math.floor(n / segCount));
    const dec = Math.max(1, Math.round(sr / 6000));       // every measurement bin is < 200 Hz
    const decRate = sr / dec;                             // the rate the DFT actually runs at
    // Every line that matters (mains frequency, its harmonics) plus, for each,
    // the two shoulders five hertz to either side. The shoulders are what "no
    // hum" means at that exact frequency: a mains line is *narrow*, so a tone
    // standing well above its own five-hertz neighbourhood is a line, whatever
    // the music around it happens to be doing.
    const lines = [];
    for (const mains of [50, 60]) {
      const set = HUM_SET[mains];
      for (const f of set.mains) {
        if (!lines.some((u) => Math.abs(u.f - f) < 0.5)) {
          lines.push({ f, mains, kind: 'tone', side: false });
          lines.push({ f: f - 5, mains, kind: 'shoulder', side: true });
          lines.push({ f: f + 5, mains, kind: 'shoulder', side: true });
        }
      }
    }
    const K = lines.length;
    // Phasors in flat typed arrays and the window precomputed: this loop runs
    // K × samples-per-segment × segments times (seven million on a three-minute
    // file) and the property loads of an array of objects were costing ten times
    // what the arithmetic did.
    const phRe = new Float64Array(K), phIm = new Float64Array(K);
    const phSr = new Float64Array(K), phSi = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      phRe[k] = 1; phIm[k] = 0;
      phSr[k] = Math.cos(TWO_PI * lines[k].f / decRate);
      phSi[k] = -Math.sin(TWO_PI * lines[k].f / decRate);
    }
    const st = { mag: lines.map(() => []), abs: lines.map(() => []), rms: [] };
    const f1 = new Biquad(), f2 = new Biquad();
    let win = null;                       // the Hann window, built once per segment length
    const idx = lines.map((L) => L);
    const toneIdx = {};
    for (const mains of [50, 60]) toneIdx[mains] = idx.findIndex((L) => L.kind === 'tone' && L.mains === mains && L.f === mains);
    const harmIdx = {};
    for (const mains of [50, 60]) harmIdx[mains] = HUM_SET[mains].mains.map((f) => idx.findIndex((L) => L.kind === 'tone' && L.f === f));

    const slice = (from, to) => {
      for (let sg = from; sg < to; sg++) {
        const start = sg * stride;
        if (start + segLen > n) continue;
        f1.setLowpass(sr, 300, 0.541); f2.setLowpass(sr, 300, 1.306);
        let sum = 0;
        for (let i = start; i < start + segLen; i++) {
          const x = b ? (a[i] + b[i]) * 0.5 : a[i];
          sum += x * x;
        }
        const re = new Float64Array(K), im = new Float64Array(K);
        const pRe = Float64Array.from(phRe), pIm = Float64Array.from(phIm);
        const used = Math.floor(segLen / dec);
        if (!win || win.length !== used) {
          win = new Float64Array(used);
          for (let m = 0; m < used; m++) win[m] = 0.5 - 0.5 * Math.cos(TWO_PI * m / used);
        }
        for (let m = 0, i = start; m < used; m++, i += dec) {
          const s = b ? (a[i] + b[i]) * 0.5 : a[i];
          const x = f2.process(f1.process(s)) * win[m];
          for (let k = 0; k < K; k++) {
            re[k] += x * pRe[k]; im[k] += x * pIm[k];
            const nr = pRe[k] * phSr[k] - pIm[k] * phSi[k];
            pIm[k] = pRe[k] * phSi[k] + pIm[k] * phSr[k];
            pRe[k] = nr;
          }
        }
        const rms = Math.sqrt(sum / segLen);
        for (let k = 0; k < K; k++) {
          const amp = 4 * Math.sqrt(re[k] * re[k] + im[k] * im[k]) / Math.max(used, 1);
          st.mag[k].push(amp / Math.max(rms, 1e-9));            // relative to the segment
          st.abs[k].push(amp);                                  // and in absolute terms
        }
        st.rms.push(rms);
      }
    };

    const out = stepRange('hum', segCount, segCount * (segLen * 2 + (segLen / dec) * (1.5 + K * 3)), slice);
    out.value = () => {
      const dbo = (v) => 20 * Math.log10(Math.max(v, 1e-9));
      /* ── the one question the segment test cannot answer ──────────────────
       * "Does the line follow the music?" is asked two ways here. The segment
       * test above can only answer it when the file *has* quiet passages: it
       * needs a 1 s segment that is 6 dB below the file's median, i.e. a real
       * silence, and it falls back to `persist = 1` (assume hum) when it finds
       * none. On music that never stops that fallback is what decides, and it
       * decides wrong: measured, an organ piece whose pedal note is played at
       * exactly 50 Hz in phrases — the notes *are* the loudest thing in the
       * file — reads a 25.6 dB line, steady 0.88, persist 1.00 (no quiet
       * segment found) and is named `hum` at 0.70, where the right answer is
       * "that is the piece".
       *
       * So the line is also measured the way a musician would: frame by frame,
       * 100 ms at a 20 ms hop, against the same frame's own loudness. A mains
       * line is a *constant* and its correlation with the programme is zero; a
       * note is played and its level rises and falls with everything around it.
       * Measured (correlation of the 50 Hz frame level with the frame's own
       * RMS): the sustained-tone fixture 0.02, hum under the acceptance bed
       * 0.03, the phrased organ **0.83** — the same number on the file whose
       * pedal is 5 Hz off the grid, so it is the phrasing being read and not
       * the frequency. From 0.30 up the line is following and the score is
       * tapered to zero by 0.60.
       *
       * It costs one Goertzel per hop at the branch's fundamental (decimated
       * 8:1 like the segment pass), and it replaces nothing: a line that sits
       * still through the silences *and* does not follow the music is still
       * hum, and a file with no silence at all is now judged by the music
       * instead of by an assumption. */
      const followSeries = (f0) => {
        const fw = Math.max(64, Math.round(sr * 0.10));
        const hop = Math.max(1, Math.round(sr * 0.02));
        const d2 = Math.max(1, Math.round(sr / 6000));
        const used = Math.floor(fw / d2), rate2 = sr / d2;
        const w = new Float64Array(used);
        for (let m = 0; m < used; m++) w[m] = 0.5 - 0.5 * Math.cos(TWO_PI * m / used);
        /* the line and the two shoulders it is read against, all three at the
         * same window so the window's own gain cancels in the difference — the
         * segment pass's trick, moved down to a 100 ms frame. Without it the
         * frame measures the *bin* and not the line: on the matrix's hum fixture
         * the bed's own energy across 45–55 Hz is the same order as the tone, so
         * a bare 50 Hz frame level follows the bed (slope 0.57 dB/dB against a
         * tone that does not move at all) and the fallback would taper a real
         * hum away. */
        const freqs = [f0, f0 - 30, f0 + 30];
        const pr = freqs.map((fq) => Math.cos(TWO_PI * fq / rate2));
        const pi = freqs.map((fq) => -Math.sin(TWO_PI * fq / rate2));
        const lev = [], prog = [];
        for (let start = 0; start + fw <= n; start += hop) {
          let prk = [1, 1, 1], pik = [0, 0, 0], sum = 0;
          const re = [0, 0, 0], im = [0, 0, 0];
          for (let m = 0, i = start; m < used; m++, i += d2) {
            const x = b ? (a[i] + b[i]) * 0.5 : a[i];
            const y = x * w[m];
            for (let k = 0; k < 3; k++) {
              re[k] += y * prk[k]; im[k] += y * pik[k];
              const nr = prk[k] * pr[k] - pik[k] * pi[k];
              pik[k] = prk[k] * pi[k] + pik[k] * pr[k];
              prk[k] = nr;
            }
            sum += x * x;
          }
          const mag = (k) => 4 * Math.sqrt(re[k] * re[k] + im[k] * im[k]) / Math.max(used, 1);
          const shoulder = 0.5 * (mag(1) + mag(2));
          lev.push(dbo(mag(0)) - dbo(shoulder));      // the line over its own neighbourhood, in dB
          prog.push(Math.sqrt(sum / fw));
        }
        return { lev, prog };
      };
      /** The line's *slope* against the programme, in dB per dB — not a
       *  correlation. A correlation is ill-conditioned on the very file that
       *  needs the test most: a line that is perfectly constant has no variance
       *  to correlate, and a little leakage from a moving bass is then enough to
       *  produce a correlation near 0.6 out of nothing (measured on the
       *  sustained-tone fixture: r = 0.62 where the line itself moves 0.02 dB
       *  per dB of programme). The slope asks the question the ear asks — when
       *  the music drops 10 dB, how far does the line drop? — and a constant
       *  answers 0 whatever else is in the bin. */
      const followSlope = (f0) => {
        const s2 = followSeries(f0);
        const nn = s2.lev.length;
        if (nn < 8) return 0;
        /* the file's own quietest and loudest quarter of frames, compared by
         * *median* rather than by a least-squares fit: the medians of the two
         * ends are what the ear hears as the drop, and leakage that rides on the
         * programme cannot move a median the line itself dominates */
        const order = s2.prog.map((v, i) => i).sort((x, y) => s2.prog[x] - s2.prog[y]);
        const q = Math.max(2, Math.floor(nn / 4));
        const med = (arr) => { const c = arr.slice().sort((a, b) => a - b); return c[Math.floor(c.length / 2)]; };
        const quietIdx = order.slice(0, q), loudIdx = order.slice(nn - q);
        const progDrop = dbo(med(quietIdx.map((i) => s2.prog[i]))) - dbo(med(loudIdx.map((i) => s2.prog[i])));
        const lineDrop = med(quietIdx.map((i) => s2.lev[i])) - med(loudIdx.map((i) => s2.lev[i]));
        if (progDrop > -0.5) return 0;                 // no dynamic range to read a slope from
        return clamp(lineDrop / progDrop, -1, 2);
      };
      const median = (arr) => {
        if (!arr.length) return 0;
        const c = arr.slice().sort((x, y) => x - y);
        return c[Math.floor(c.length / 2)];
      };
      const branch = (mains) => {
        const toneDb = (k) => dbo(median(st.mag[k]));
        const fundIdx = harmIdx[mains][0];
        const fundDb = toneDb(fundIdx);
        // the *highest* shoulder: the worst case, so a tone is only called tonal
        // when it beats both sides
        let shoulderDb = -140;
        for (let k = 0; k < K; k++) {
          const L = idx[k];
          if (L.kind === 'shoulder' && L.mains === mains && Math.abs(L.f - lines[fundIdx].f) === 5) shoulderDb = Math.max(shoulderDb, toneDb(k));
        }
        const harm = HUM_SET[mains].mains.slice(1).map((f, i) => {
          const k = harmIdx[mains][i + 1];
          let sh = -140;
          for (let j = 0; j < K; j++) {
            const L = idx[j];
            if (L.kind === 'shoulder' && L.mains === mains && Math.abs(L.f - f) === 5) sh = Math.max(sh, toneDb(j));
          }
          return { hz: f, excess: toneDb(k) - sh };
        });
        const series = st.mag[fundIdx];
        const med = median(series);
        const steady = series.length ? series.filter((v) => dbo(v) > dbo(med) - 6).length / series.length : 0;
        // Does the tone *follow the music*? A mains line sits at a constant
        // absolute level through the quiet passages too; a note at the same
        // frequency drops with everything else around it. This is the one test
        // that separates a hum from music — and it is why a tune that happens to
        // be written at 50 or 60 Hz does not have to be damaged to repair hum.
        const abs = st.abs[fundIdx];
        const rmsMed = median(st.rms);
        const quiet = [];
        for (let i = 0; i < st.rms.length; i++) if (st.rms[i] < rmsMed * 0.5) quiet.push(i);
        const followDb = quiet.length >= 3 ? dbo(median(quiet.map((i) => abs[i]))) - dbo(median(abs)) : 0;
        const persist = quiet.length >= 3 ? clamp((followDb + 7) / 5, 0, 1) : 1;
        return { mains, excess: fundDb - shoulderDb, fundDb, shoulderDb, steady, followDb, persist, quietN: quiet.length, harm };
      };
      const b50 = branch(50), b60 = branch(60);
      const best = b50.excess >= b60.excess ? b50 : b60;
      const evidence = clamp((best.excess - 3) / 6, 0, 1);
      const credibility = clamp((best.steady - 0.7) / 0.25, 0, 1);
      /* …and where the segment test had *nothing to look at* the frame-level
       * slope answers instead of the old assumption. This is the exact place the
       * bug was: `persist` is the right test whenever the file has quiet
       * passages (the line sits still while the music stops) and it *only* has
       * an answer then — `quiet.length >= 3` — so on music that never stops it
       * fell back to 1 and the score rested on `steady` alone. Measured, that is
       * where a phrased organ pedal at 50 Hz was named `hum` (line 25.6 dB,
       * steady 0.88, fallback 1.00 → score 0.70). A file *with* quiet passages
       * keeps the segment test and is untouched by the slope: a hum under a
       * phrase is still a hum, which is what `persist` is for. */
      const followSlopeDb = followSlope(best.mains);
      const followTaper = best.quietN >= 3 ? 1 : 1 - clamp((followSlopeDb - 0.35) / 0.35, 0, 1);
      return {
        score: clamp(evidence * credibility * best.persist * followTaper, 0, 1),
        peakDb: clamp(best.excess, -20, 60),
        steady: best.steady,
        followDb: best.followDb,
        persist: best.persist,
        followSlope: followSlopeDb,
        followTaper,
        shoulderDb: best.shoulderDb,
        mainsHz: best.mains,
        hum50Db: b50.excess,
        hum60Db: b60.excess,
        hum2Db: clamp(best.harm[0] ? best.harm[0].excess : 0, -20, 60),
        hum3Db: clamp(best.harm[1] ? best.harm[1].excess : 0, -20, 60),
      };
    };
    return out;
  }

  /** Highest bin level inside ±tol Hz of `f`. */
  function spectrumPeak(spec, f, tol) {
    let v = -140;
    for (let k = 0; k < spec.n; k++) {
      if (spec.db[k] > v && Math.abs(spec.freq[k] - f) <= tol) v = spec.db[k];
    }
    return v;
  }

  /**
   * The strongest narrow resonances in the low mids — a boxy room, a honky
   * cabinet, a resonant pressing. Broad rises are what the fixed EQ bank is for;
   * this finds the *narrow* offenders so they can be notched precisely instead of
   * pulling a whole octave down with them.
   *
   * @returns {{hz:number, excessDb:number, q:number}[]} strongest first, max 2
   */
  function resonanceScan(spec) {
    const binHz = spec.n > 1 ? spec.freq[1] - spec.freq[0] : 1;
    const trend = smoothSpec(spec, 4);
    const found = [];
    for (let k = 3; k < spec.n - 3; k++) {
      const f = spec.freq[k];
      if (f < 150 || f > 1800) continue;
      if (spec.db[k] < spec.db[k - 1] || spec.db[k] < spec.db[k + 1]) continue;   // local maximum
      // compare against a local trend about a third of an octave wide
      const r = clamp(Math.round(f / binHz / 3), 5, 60);
      let sum = 0, cnt = 0;
      for (let j = k - r; j <= k + r; j++) {
        if (j < 0 || j >= spec.n || j === k) continue;
        sum += trend[j]; cnt++;
      }
      if (!cnt) continue;
      const ex = spec.db[k] - sum / cnt;
      if (ex < 3) continue;
      // …and it has to be a *colouration*, not a note. A room ring sits a few dB
      // above its own trend — the card calls anything over 3 dB boxy and
      // saturates at 9 — while a sustained partial has nothing around it at all:
      // measured, a 997 Hz sine reads 96 dB of "excess" against its trend and a
      // 220 Hz sine 53 dB, and the notch that fits a resonance would take 8 dB
      // out of the note (at 997 Hz the clamped Q 6 makes that notch 166 Hz
      // wide). A mains harmonic is the same kind of peak and has its own,
      // precise notch. 24 dB is three times the point where "boxy" saturates,
      // so a genuinely awful room still passes.
      if (ex > 24) continue;
      // …and it has to be *narrow*: a broad rise is not a resonance
      const off = Math.max(2, Math.round(f * 0.30 / binHz));
      const drop = spec.db[k] - Math.max(spec.db[Math.min(spec.n - 1, k + off)], spec.db[Math.max(0, k - off)]);
      if (drop < ex * 0.45) continue;
      found.push({ hz: f, excessDb: ex, q: clamp(f / Math.max(20, drop), 1.5, 6) });
    }
    found.sort((a, b) => b.excessDb - a.excessDb);
    const picked = [];
    for (const c of found) {
      if (picked.some((p) => Math.abs(Math.log2(p.hz / c.hz)) < 0.45)) continue;
      picked.push(c);
      if (picked.length === 2) break;
    }
    return picked;
  }

  /** Pearson correlation between the first two channels (mono-compat check). */
  function correlationStep(channels) {
    if (channels.length < 2) return { step: stepRange('correlation', 0, 0, () => {}), value: () => 1 };
    const a = channels[0], b = channels[1];
    const n = Math.min(a.length, b.length);
    const stride = Math.max(1, Math.floor(n / 200000));
    const count = n > 0 ? Math.ceil(n / stride) : 0;
    const st = { sa: 0, sb: 0, saa: 0, sbb: 0, sab: 0, cnt: 0 };
    const step = stepRange('correlation', count, count * 250, (from, to) => {
      for (let k = from; k < to; k++) {
        const i = k * stride;
        if (i >= n) break;
        const x = a[i], y = b[i];
        st.sa += x; st.sb += y; st.saa += x * x; st.sbb += y * y; st.sab += x * y; st.cnt++;
      }
    });
    return {
      step,
      value() {
        const cnt = st.cnt;
        if (!cnt) return 1;
        const cov = st.sab / cnt - (st.sa / cnt) * (st.sb / cnt);
        const va = st.saa / cnt - (st.sa / cnt) ** 2;
        const vb = st.sbb / cnt - (st.sb / cnt) ** 2;
        if (va <= 1e-12 || vb <= 1e-12) return 1;
        return clamp(cov / Math.sqrt(va * vb), -1, 1);
      },
    };
  }

  function stereoCorrelation(channels) {
    const c = correlationStep(channels);
    c.step.slice(0, c.step.units);
    return c.value();
  }

  /* --- stereo detail, band by band ----------------------------------------- */

  /**
   * Where a stereo image is narrow, and where it is broken.
   *
   * One broadband correlation number cannot tell the two failure modes apart: a
   * 1960s mix folded almost to mono is correlated *everywhere*, while a
   * recording with an out-of-phase bottom (a polarity-inverted bass mic, a
   * mis-wired cartridge) is correlated in the middle and inverted down below.
   * Both want a different repair, so the correlation is measured in three bands
   * — below 200 Hz, 200 Hz–2 kHz, above 2 kHz — alongside the channel balance.
   *
   * Band splits are one-pole crossovers run at full rate (a low band cannot be
   * measured from decimated samples), while the moment products are accumulated
   * every fourth sample: the bands live far enough below Nyquist that the
   * subset is the same measurement, and it keeps the pass cheap.
   */
  function stereoBandsStep(channels, sr) {
    const flat = () => ({ step: stepRange('stereo-bands', 0, 0, () => {}), value: () => ({ low: 1, mid: 1, high: 1, balanceDb: 0 }) });
    if (channels.length < 2) return flat();
    const a = channels[0], b = channels[1];
    const n = Math.min(a.length, b.length);
    if (!n) return flat();
    const cLow = 1 - Math.exp(-TWO_PI * 200 / sr);
    const cMid = 1 - Math.exp(-TWO_PI * 2000 / sr);
    const st = {
      la: 0, ha: 0, lb: 0, hb: 0,                // one-pole states (low 200, low 2k)
      low: [0, 0, 0], mid: [0, 0, 0], high: [0, 0, 0],   // [saa, sbb, sab]
      ea: 0, eb: 0, cnt: 0,
    };
    const step = stepRange('stereo-bands', n, n * 7, (from, to) => {
      for (let i = from; i < to; i++) {
        const x = a[i], y = b[i];
        st.la += (x - st.la) * cLow;
        st.lb += (y - st.lb) * cLow;
        st.ha += (x - st.ha) * cMid;
        st.hb += (y - st.hb) * cMid;
        if ((i & 3) !== 0) continue;
        const xl = st.la, yl = st.lb;
        const xm = st.ha - st.la, ym = st.hb - st.lb;
        const xh = x - st.ha, yh = y - st.hb;
        st.low[0] += xl * xl; st.low[1] += yl * yl; st.low[2] += xl * yl;
        st.mid[0] += xm * xm; st.mid[1] += ym * ym; st.mid[2] += xm * ym;
        st.high[0] += xh * xh; st.high[1] += yh * yh; st.high[2] += xh * yh;
        st.ea += x * x; st.eb += y * y; st.cnt++;
      }
    });
    const rho = (v) => {
      const den = Math.sqrt(v[0] * v[1]);
      if (den <= 1e-18) return 1;
      return clamp(v[2] / den, -1, 1);
    };
    return {
      step,
      value: () => ({
        low: rho(st.low), mid: rho(st.mid), high: rho(st.high),
        balanceDb: st.cnt && st.ea > 1e-12 && st.eb > 1e-12 ? 10 * Math.log10(st.ea / st.eb) : 0,
      }),
    };
  }

  /* --- transient character -------------------------------------------------- */

  /**
   * How percussive a recording is.
   *
   * The chain has to know this about the *song*, not about music in general:
   * de-clicking must not mistake a snare for a click (its detector is gated by
   * how much the fast envelope stands above the slow one, and on percussion
   * that ratio is high everywhere), and a glue compressor that is meant to
   * *smooth* a sustained recording pumps on a drum-driven one.
   *
   * Measured on the mono sum with two envelope followers (≈1 ms attack / 30 ms
   * release and 120 ms): an attack is a moment where the fast envelope stands
   * 4 dB or more above the slow one and the level is above the noise; the
   * count per second is the density, the median excess is the punch.
   */
  /* --- inter-sample peak estimate ------------------------------------------ */

  /**
   * True-peak (inter-sample peak) estimate, in dBFS.
   *
   * A master can sit at −0.1 dBFS on every sample and still produce a
   * reconstructed waveform 1–2 dB above full scale, which is what a lossy
   * encoder or a 16-bit export will then clip. The estimate interpolates the
   * band-limited waveform between the samples that are already close to the
   * peak — a 7-tap windowed-sinc evaluated at three offsets — and reports the
   * highest value found. It is an estimate (that is what it is called in the
   * UI), accurate to a few tenths of a dB, not a conformance-grade meter.
   */
  /* --------------------------------------------------------------------------
   * Inter-sample peak ("true peak"): 4× oversampled, 32-tap Hann-windowed sinc.
   *
   * The kernel is the *shared* definition of "what the waveform does between the
   * samples": the limiter in the worklet builds the same table from the same
   * numbers and judges the same intervals, because a limiter that measures the
   * peak differently from the meter that reports it is a limiter that lies about
   * its own ceiling.
   *
   * The short seven-tap sinc that used to sit here (and in the limiter) is not
   * good enough on bright, transient-heavy material: measured against two
   * independent interpolators (ffmpeg's ebur128 and a 32-tap meter in the test
   * toolkit) it read 0.5 dB *low* on a percussion master — the app reported
   * −2.10 dBTP for an export that both other meters put at −1.60, above the
   * ceiling it had just been told to hold. 32 taps with a Hann window agree with
   * ffmpeg to within 0.06 dB on tonal material and 0.09 dB on transients.
   * ----------------------------------------------------------------------- */
  const ISP_TAPS = 32;
  const ISP_PHASES = 4;
  let ISP_TABLE = null;
  /** @returns {Float64Array[]} one 32-tap kernel per quarter-sample phase */
  function ispTable() {
    if (ISP_TABLE) return ISP_TABLE;
    const N = ISP_TAPS;
    const t = [];
    for (let p = 1; p < ISP_PHASES; p++) {
      const taps = new Float64Array(N);
      for (let n = 0; n < N; n++) {
        // distance from the interpolation point (which sits p/4 samples across
        // the interval, so the newest tap has a quarter-sample of future in it)
        const x = (n - (N / 2 - 1)) - p / ISP_PHASES;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (n + 0.5) / N);
        taps[n] = sinc * w;
      }
      let sum = 0;
      for (let n = 0; n < N; n++) sum += taps[n];
      for (let n = 0; n < N; n++) taps[n] /= sum;      // unity gain per phase
      t.push(taps);
    }
    ISP_TABLE = t;
    return t;
  }

  function ispStep(channels) {
    const flat = { step: stepRange('isp', 0, 0, () => {}), value: () => -70 };
    if (!channels.length || !channels[0].length) return flat;
    const st = { isp: 0 };
    const starts = [];
    let total = 0;
    for (const ch of channels) { starts.push(total); total += ch.length; }
    // The oversampling walk only has to visit samples near the peak — an
    // inter-sample maximum can add a fraction of a dB over the sample it sits
    // between, never 20 — but "near the peak" has to mean *this file's* peak.
    // The absolute 0.5 that used to sit here is a full-scale-only gate: on the
    // same file 20 dB down the inter-sample peak came back as "nothing" (−240
    // dB) and the analyser reported the sample peak as the true peak. A
    // statistic that cannot see a change is not a measurement.
    let pk = 0;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      for (let i = 0; i < ch.length; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > pk) pk = a; }
    }
    const gate = pk * 0.5;
    const table = ispTable();
    const half = ISP_TAPS / 2;                       // 16 samples of reach each way
    const step = stepRange('isp', total, total * 2, (from, to) => {
      for (let c = 0; c < channels.length; c++) {
        const ch = channels[c];
        const len = ch.length;
        const a = Math.max(half, Math.max(from, starts[c]) - starts[c]);
        const b = Math.min(len - half, Math.min(to, starts[c] + len) - starts[c]);
        for (let i = a; i < b; i++) {
          // The gate is on the *neighbourhood*, not on the sample: the kernel
          // reaches sixteen samples ahead, so an interval whose own sample is
          // below the gate can still be the one that overshoots.
          let m = 0;
          for (let k = -half; k < half; k++) { const av = ch[i + k] < 0 ? -ch[i + k] : ch[i + k]; if (av > m) m = av; }
          if (m < gate) continue;
          for (let d = 1; d < ISP_PHASES; d++) {
            const taps = table[d - 1];
            let v = 0;
            for (let n = 0; n < ISP_TAPS; n++) v += ch[i - half + 1 + n] * taps[n];
            const av = v < 0 ? -v : v;
            if (av > st.isp) st.isp = av;
          }
          const ab = ch[i + 1] < 0 ? -ch[i + 1] : ch[i + 1];
          if (ab > st.isp) st.isp = ab;
        }
      }
    });
    return { step, value: () => db(st.isp) };
  }

  /* --- the full measurement ------------------------------------------------- */

  /**
   * The whole measurement as a plan: a list of steps (each range-addressable)
   * plus a `result()` that turns the accumulated numbers into the metrics.
   * `measure()` runs it in one go, `measureAsync()` runs it in slices.
   */
  function measurePlan(channels, sr) {
    const sp = spectrumStep(channels, sr, { fftSize: 8192, maxFrames: 140 });
    const core = coreSteps(channels, sr);       // peak + clip + loudness + dynamics, one walk
    const cor = correlationStep(channels);
    const crk = crackleStep(channels, sr);
    const flatTop = flatTopStep(channels, sr);
    const nt = noiseStep(channels, sr);
    const humExact = humStep(channels, sr);
    // Per-song detail: how the stereo image is built band by band, how
    // percussive the recording is, and how far the reconstructed waveform is
    // likely to leave full scale between the samples.
    const sb = stereoBandsStep(channels, sr);
    const sib = sibStep(channels, sr);
    const isp = ispStep(channels);
    // the crest reference is a strided walk over the same file: it rides in the
    // final step instead of costing a pass of its own
    let crestMs = 0, crestN = 0;
    const fin = stepRange('finalise', 8, 60000, (from, to) => {
      for (let k = from; k < to; k++) {
        for (const ch of channels) {
          for (let i = k; i < ch.length; i += 8) { crestMs += ch[i] * ch[i]; crestN++; }
        }
      }
    });
    const steps = [
      core.step, sp.step, cor.step, crk.step, flatTop.step, sb.step, sib.step,
      core.steps[0], core.steps[1], core.steps[2], core.steps[3],
      nt.steps[0], nt.steps[1], nt.steps[2], nt.steps[3], humExact, isp.step, fin,
    ];

    function result() {
      const spec = sp.value();
      const na = nt.value();
      const crackle = crk.value();
      const clipInfo = flatTop.value();
      const nf = na.floorDb;
      const hfNf = na.hfFloorDb;
      const cut = hfCutoff(spec, 32);
      const hum = humExact.value();
      const resonances = resonanceScan(spec);
      // how ragged the spectrum is above the codec cliff: a 64 kbps file has
      // holes and birdies, a naturally dull recording has a smooth slope
      const raggedHi = hfRaggedness(spec, cut);
      const m = {
        sr,
        channels: channels.length,
        duration: channels[0].length / sr,
        peakDb: core.peakDb(),
        nonFinite: core.nonFinite(),
        crestDb: core.peakDb() - db(Math.sqrt(crestN ? crestMs / crestN : 0)),
        loudness: core.loudness(),
        noiseFloorDb: nf,
        hfNoiseFloorDb: hfNf,
        noiseSlope: na.noiseSlope,
        noiseFlatness: na.flatness,
        noiseRumble: na.rumble,
        noiseConfidence: na.confidence,
        hfFollowDb: na.hfFollowDb,
        musicTiltDb: na.musicTiltDb,
        hissTiltDb: na.hissTiltDb,
        hissTiltStepDb: na.hissTiltStepDb,
        crackleIndex: crackle.index,
        // flat tops: the signature of a clipped master (see clipStep)
        clipFlatRatio: clipInfo.flatRatio,
        clipLevelDb: clipInfo.levelDb,
        clipRunCount: clipInfo.runCount,
        clipRunMedian: clipInfo.runMedian,
        clipOvershootDb: clipInfo.overshootDb,
        clipMaxRun: clipInfo.maxRun,
        clipEvidence: clipInfo.evidence,
        noiseInfo: Object.assign({}, na, { crackleIndex: crackle.index, crestP98Db: crackle.crestP98Db, crestGlobalDb: crackle.globalCrestDb, spikeFrames: crackle.spikeFrames }),
        hfNoiseDeltaDb: hfNf - nf,
        dynamicRangeDb: core.dynamicRange(),
        clipRatio: core.clipRatio(),
        musicLevelDb: na.musicDb,
        hissRefDb: na.hfQuietRmsDb,        // the de-hisser's level reference (band RMS)
        humScore: hum.score,
        humPeakDb: hum.peakDb,
        humSteady: hum.steady,
        humFollowDb: hum.followDb,
        mainsHz: hum.mainsHz,
        humPersist: hum.persist,
        humFollowSlope: hum.followSlope,
        humShoulderDb: hum.shoulderDb,
        humMainsHz: hum.mainsHz,
        hum2Db: hum.hum2Db,
        hum3Db: hum.hum3Db,
        hum50: hum.hum50Db,
        hum60: hum.hum60Db,
        resonances: resonances,
        resoHz: resonances.length ? resonances[0].hz : 0,
        resoExcessDb: resonances.length ? resonances[0].excessDb : 0,
        hfRagged: raggedHi,
        hfCutoff: cut,
        cutDropDb: cutDropDb(spec, cut),          // how steeply the top end falls at that ceiling
        correlation: cor.value(),
        // ── per-song detail (everything below is measured on *this* file) ──
        ispDb: isp.value(),                       // estimated true peak
        stereo: sb.value(),                       // correlation per band + balance
        dc: core.dcOffset(),                      // offset and whether it drifts
        noiseBandDb: na.noiseBandDb || [],        // noise floor per EQ band
        infraExcessDb: na.infraExcessDb || 0,     // quiet-frame 20–45 Hz vs 90–203 Hz
        infraBands: na.infraBands || null,
        infraBandsMean: na.infraBandsMean || null,
        noiseSpreadDb: na.hfQuietSpreadDb || 0,   // does the hiss floor pump?
        eqCenters: EQ_CENTERS.slice(),
        // tonal descriptors (dB relative ratios)
        bassRoll: 0, mudScore: 0, harshness: 0, airiness: 0, tilt: 0,
        spec,
      };

      // Band centres: 42 · 113 · 354 · 1130 · 2830 · 8500 · 13900 Hz.
      // The reference slope is −3 dB/octave (typical musical programme), so every
      // figure below is "dB away from a normally balanced recording".
      const sub = bandMedian(spec, 34, 58);
      const bass = bandMedian(spec, 80, 150);
      const lowMid = bandMedian(spec, 250, 480);
      const mid = bandMedian(spec, 800, 1600);
      const upperMid = bandMedian(spec, 2000, 4000);
      const high = bandMedian(spec, 6000, 12000);
      const veryHigh = bandMedian(spec, 12500, 16000);

      m.bassRoll = clamp((-3 * Math.log2(121 / 45) + bass - sub) / 16, 0, 1);
      // How much of the bottom the *recording itself* has, against the band just
      // above it: −25 dB is an empty octave (a file high-passed at 200 Hz reads
      // −25.6), +5 dB is a normal programme's own downward slope (a flat pink
      // bed reads +5.2, a vinyl sim +4.1) and a hummed or rumbling transfer sits
      // around −3. It is what decides whether a sub-octave can be derived at all
      // — the synthesiser can only double content that exists — and whether the
      // low mids may be balanced against a trend that the hole has dragged down.
      m.subHoleDb = bandMedian(spec, 34, 58) - bandMedian(spec, 80, 150);
      m.subDeficit = m.bassRoll;
      m.mudScore = clamp((-3 * Math.log2(1130 / 347) + lowMid - mid) / 12, 0, 1);
      m.harshness = clamp((-3 * Math.log2(2830 / 1130) + upperMid - mid - 2) / 10, 0, 1);
      m.airiness = clamp((-3 * Math.log2(8500 / 113) + high - bass) / 24, 0, 1);
      m.tilt = high - bass + 3 * Math.log2(8500 / 113);
      m.hfEnergyLoss = clamp((bandLevel(spec, 3000, 6000) - veryHigh) / 40, 0, 1);
      m.deriveDb = bandMedian(spec, 4600, 7500);
      m.deriveGapDb = clamp(mid - m.deriveDb, 0, 30);
      m.topLoss = clamp((-3 * Math.log2(8500 / 1130) + mid - high) / 22, 0, 1);

      // confidence that the top end was band-limited (e.g. MP3 / telephone)
      const sm = smoothSpec(spec, 3);
      let ref = -200;
      for (let k = 0; k < spec.n; k++) if (spec.freq[k] > 400 && spec.freq[k] < 6000) ref = Math.max(ref, sm[k]);
      let endF = 20000;
      for (let k = spec.n - 1; k > 0; k--) {
        if (spec.freq[k] < 4000) break;
        if (sm[k] > ref - 45) { endF = spec.freq[k]; break; }
      }
      m.specEndHz = endF;
      m.bandLimited = endF < 15000 ? clamp((15000 - endF) / 8000, 0, 1) : 0;

      m.snrDb = m.musicLevelDb - nf;           // music peaks above the noise floor
      m.hfSnrDb = m.musicLevelDb - hfNf;
      m.hissDeficitDb = na.hissDeficitDb === undefined ? 0 : na.hissDeficitDb;
      const hissLevel = clamp((55 - m.hfSnrDb) / 26 + 0.35, 0.35, 1);
      // Two independent ways of seeing the same thing: the top end does not fall
      // with the music (the tilt step — calibrated in dB), or it does not move at
      // all while the whole signal does (the dynamic-range deficit). Whichever is
      // stronger wins; both are gated by the measured HF level and by whether the
      // file actually has quiet passages to prove anything with.
      const tiltEvidence = clamp(((m.hissTiltStepDb || 0) - 0.8) / 5.0, 0, 1);
      const deficitEvidence = clamp((m.hissDeficitDb - 1.0) / 4.0, 0, 1);
      m.hissAmount = clamp(Math.max(tiltEvidence, deficitEvidence) * hissLevel * clamp(m.noiseConfidence * 1.5, 0, 1), 0, 1);
      m.hfDropDb = bandMedian(spec, 6000, 8000) - bandMedian(spec, 12000, 16000);
      const smS = smoothSpec(spec, 6);
      let maxCliff = 0, cliffAt = 0;
      for (let k = 0; k < spec.n; k++) {
        const f = spec.freq[k];
        // The search starts at 4 kHz, not 8: a codec's lowpass is a *sudden*
        // drop of 9 dB or more inside 1.6 kHz, and a cheap encoder puts one
        // anywhere from 4 to 20 kHz. With the window starting at 8 kHz a
        // 96–128 kbit/s wall at 7.5 kHz was invisible — the analyser reported
        // "no cliff" for a file that is nothing but cliff — and the profile
        // that exists for exactly that file could not be reached. A gentle
        // roll-off (any real recording) clears the 9 dB threshold of
        // `brickwall` by construction: −12 dB/octave loses 6 dB over 1.6 kHz.
        if (f < 4000 || f > 19500) continue;
        let j = k, span = 0;
        while (j < spec.n && span < 1600) { span = spec.freq[j] - f; j++; }
        const kj = Math.min(spec.n - 1, j - 1);
        const drop = smS[k] - smS[kj];
        // …and a cliff has to *end*. A codec's wall is the last thing in the
        // file: above it there is nothing left to lose, so the next 1.6 kHz
        // costs almost nothing more (above/drop measured 0.00 at 128 kbit/s,
        // −0.62 at 96 kbit/s, 0.32 at the audible edge of a simulated one). A
        // filter's slope never ends — it keeps taking 1.6 kHz per 1.6 kHz, so
        // above/drop stays at 0.85–1.00 inside a roll-off (measured on this
        // app's own 320 kbit/s export and on a vinyl simulation) and such a
        // window is not a wall. Without the test the reported cliff for a
        // mellow record sat several kHz below where its top end actually dies,
        // which is also the number the air repair is built from. A roll-off
        // whose tail has already reached the floor does pass this test — that
        // one is separated by *where* it sits, see `codecLoss` in presets.js.
        let l = kj, span2 = 0;
        while (l < spec.n && span2 < 1600) { span2 = spec.freq[l] - spec.freq[kj]; l++; }
        const above = smS[kj] - smS[Math.min(spec.n - 1, l - 1)];
        if (drop > maxCliff && above <= 0.45 * drop) { maxCliff = drop; cliffAt = f; }
      }
      m.cliffDb = maxCliff;
      m.cliffHz = cliffAt;
      m.brickwall = clamp((maxCliff - 9) / 12, 0, 1);
      m.dullIndex = clamp(Math.max(
        (15000 - (m.hfCutoff || 0)) / 8000,
        m.hfCutoff && m.hfCutoff < 17000 ? (m.topLoss || 0) * 1.1 : (m.topLoss || 0) * 0.85
      ), 0, 1);
      m.cleanliness = clamp((m.snrDb - 42) / 28, 0, 1);
      m.bandExcess = [60, 200, 450, 1300, 3200, 7000].map((f) => {
        const narrow = bandMedian(spec, f / 1.22, f * 1.22);
        const wide = bandMedian(spec, f / 2.2, f * 2.2);
        return narrow - wide;
      });

      /* ── the twelve-band picture the per-song EQ is built from ──────────
       * The six-band bank above is a profile's tone control: one shelf and five
       * peaks, dosed by six "how bad is it" numbers. This is the opposite kind
       * of measurement — the actual shape of *this* recording, band by band,
       * with the song's own 1 kHz region as the pivot. Everything the per-song
       * correction does is derived from it, and it is also what the diagnosis
       * shows the user: "at 200 Hz this file is 4.1 dB above its own trend". */
      const bandDb = EQ_CENTERS.map((f) => bandMedian(spec, f / 1.26, f * 1.26));
      m.bandDb = bandDb;
      m.bandSnrDb = bandDb.map((v, i) => v - (na.noiseBandDb && isFinite(na.noiseBandDb[i]) ? na.noiseBandDb[i] : -120));
      /**
       * Sibilance: the 5–9 kHz band against the trend its own 2.4–4 kHz region
       * predicts (−3 dB/oct). A recording whose "s" and cymbals sit 6 dB above
       * that trend has a de-esser problem; one whose top end is merely bright
       * does not (that is a tilt, and the tilt term handles it).
       */
      m.sibExcessDb = bandMedian(spec, 5000, 9200) - (bandMedian(spec, 2400, 4000) - 3 * Math.log2(7100 / 3200));
      /* …and the same question asked per frame, which is the only way the answer
       * is about a singer's "s" and not about the song's average (see sibStep) */
      m.sibPeakDb = sib.value().sibPeakDb;
      m.sibRawDb = sib.value().sibRawDb;
      m.sibSustained = sib.value().sibSustained;
      /**
       * Where the hiss begins: the lowest band in which the *music* is less
       * than 14 dB above the measured noise floor. The de-hisser's crossover
       * follows it, so a cassette whose hiss starts at 2.5 kHz is split at
       * 2.5 kHz and a bright digital file with a 7 kHz floor is not split at
       * 3.2 kHz by default and then asked to subtract a problem it cannot see.
       */
      let hissFrom = 0;
      for (let i = 0; i < EQ_CENTERS.length; i++) {
        if (EQ_CENTERS[i] < 1800) continue;
        if (isFinite(m.bandSnrDb[i]) && m.bandSnrDb[i] < 14) { hissFrom = EQ_CENTERS[i]; break; }
      }
      m.hissStartHz = clamp(hissFrom || 3200, 2200, 8000);
      m.noiseSpreadDb = m.noiseSpreadDb || 0;
      m.dcOffsetDb = m.dc && isFinite(m.dc.db) ? m.dc.db : -120;

      // vinyl-style surface noise: crackle bursts + hum + analogue noise floor
      m.vinylAmount = clamp(0.55 * m.crackleIndex + 0.25 * clamp(m.humScore, 0, 1)
        + 0.20 * clamp((m.snrDb < 45 ? (45 - m.snrDb) / 35 : 0), 0, 1), 0, 1);
      m.tapeAmount = clamp(0.75 * m.hissAmount + 0.25 * clamp((16000 - (m.hfCutoff || 0)) / 9000, 0, 1), 0, 1);
      m.score = qualityScore(m);
      return m;
    }

    return { steps, result };
  }

  /**
   * Full measurement pass over decoded audio.
   * @param {Float32Array[]} channels
   * @param {number} sr
   */
  function measure(channels, sr) {
    return runPlanSync(measurePlan(channels, sr));
  }

  /**
   * The same measurement, sliced: yields to the event loop between slices and
   * reports how far it is, so the UI stays alive (and honest) on a long file.
   * @param {Float32Array[]} channels
   * @param {number} sr
   * @param {(p:number, label:string) => void} [onProgress]
   * @param {{budgetMs?:number, reportMs?:number}} [opts]
   */
  function measureAsync(channels, sr, onProgress, opts) {
    return runPlanAsync(measurePlan(channels, sr), onProgress, opts);
  }

  /**
   * 0–100 "how good does this recording sound" score.
   * Used for the Before/After read-out so users can see the improvement.
   */
  function qualityScore(m) {
    // every term is guarded: a measurement that came out non-finite (a corrupt
    // file, an empty buffer) must still produce a number, never a `NaN %` on
    // screen or a `NaN` parameter downstream
    const n = (x, d) => (isFinite(x) ? x : (d === undefined ? 0 : d));
    const cut = n(m.hfCutoff, 0);
    const topLoss = clamp(cut < 17000 ? (17000 - cut) / 9000 : 0, 0, 1);
    const snr = clamp(n(m.snrDb) / 60, 0, 1);
    const hiss = clamp(n(m.hissAmount), 0, 1);
    const crackle = clamp(n(m.crackleIndex), 0, 1);
    const s =
      100
      - 24 * clamp(n(m.bassRoll), 0, 1)
      - 16 * clamp(n(m.mudScore), 0, 1)
      - 14 * clamp(n(m.harshness), 0, 1)
      - 22 * clamp(topLoss * 0.6 + n(m.bandLimited) * 0.4, 0, 1)
      - 16 * (1 - snr)
      - 12 * hiss
      - 12 * crackle
      - 6 * clamp(n(m.humScore), 0, 1)
      - 6 * clamp(n(m.clipRatio) * 300, 0, 1);
    return clamp(Math.round(s), 0, 100);
  }

  /* ------------------------------------------------------ sample-rate sniff */

  /** Read the source sample rate straight from the container header. */
  function detectSampleRate(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    const tag = (o, s) => {
      if (o + s.length > u8.length) return false;
      for (let i = 0; i < s.length; i++) if (u8[o + i] !== s.charCodeAt(i)) return false;
      return true;
    };

    // ---- RIFF / WAVE ------------------------------------------------------
    if (tag(0, 'RIFF') && tag(8, 'WAVE')) {
      let o = 12;
      while (o + 8 <= u8.length) {
        const size = dv.getUint32(o + 4, true);
        if (tag(o, 'fmt ')) return dv.getUint32(o + 12, true);
        o += 8 + size + (size & 1);
        if (size === 0) break;
      }
    }
    // ---- FLAC -------------------------------------------------------------
    if (tag(0, 'fLaC')) {
      let o = 4;
      while (o + 4 <= u8.length) {
        const type = u8[o] & 0x7f;
        const size = (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3];
        if (type === 0 && o + 4 + 18 <= u8.length) {
          const b = u8.subarray(o + 4, o + 4 + 18);
          return (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
        }
        o += 4 + size;
      }
    }
    // ---- OGG (Vorbis / Opus) ---------------------------------------------
    if (tag(0, 'OggS')) {
      for (let o = 0; o + 30 < u8.length && o < 200000; o++) {
        if (tag(o, 'vorbis') && o + 16 < u8.length) {
          return new DataView(buf, o + 12, 4).getUint32(0, true);
        }
        if (tag(o, 'OpusHead')) return 48000; // Opus always decodes at 48 kHz
      }
    }
    // ---- MP4 / M4A (mdhd timescale) --------------------------------------
    if (tag(4, 'ftyp')) {
      for (let o = 0; o + 32 < u8.length; o++) {
        if (tag(o, 'mdhd')) {
          const version = u8[o + 4];
          const tsOff = version === 1 ? o + 8 + 16 : o + 8 + 8;
          if (tsOff + 4 <= u8.length) {
            const ts = dv.getUint32(tsOff, false);
            if (ts > 4000 && ts < 384000) return ts;
          }
        }
      }
      return 44100;
    }
    // ---- MPEG audio (MP3) -------------------------------------------------
    // scan for a valid frame header, read the sampling-rate index
    const rates = {
      3: [44100, 48000, 32000], // MPEG1
      2: [22050, 24000, 16000], // MPEG2
      0: [11025, 12000, 8000],  // MPEG2.5
    };
    for (let o = 0; o < Math.min(u8.length - 4, 200000); o++) {
      if (u8[o] === 0xff && (u8[o + 1] & 0xe0) === 0xe0) {
        const verBits = (u8[o + 1] >> 3) & 0x03;
        const srIdx = (u8[o + 2] >> 2) & 0x03;
        const layer = (u8[o + 1] >> 1) & 0x03;
        if (verBits === 1 || srIdx === 3 || layer === 0) continue;
        const table = rates[verBits];
        if (table && table[srIdx]) {
          // validate against the next frame (offset by frame length)
          const bitrateIdx = (u8[o + 2] >> 4) & 0x0f;
          const pad = (u8[o + 2] >> 1) & 0x01;
          const brTable = verBits === 3
            ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
            : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
          const bitrate = brTable[bitrateIdx] * 1000;
          const sr = table[srIdx];
          let flen = 0;
          if (bitrate > 0) {
            if (verBits === 3) flen = Math.floor((layer === 3 ? 12 : 144) * bitrate / sr) + pad;
            else flen = Math.floor((layer === 3 ? 72 : 144) * bitrate / sr) + pad;
          }
          if (flen > 4 && o + flen + 2 < u8.length) {
            const n = o + flen;
            if (u8[n] === 0xff && (u8[n + 1] & 0xe0) === 0xe0) return sr;
          } else if (o > 10) {
            return sr; // header found mid-stream, frame math unreliable — accept
          }
        }
      }
    }
    return 0;
  }

  /* ---------------------------------------------------------------- WAV I/O */

  /**
   * Encode interleaved PCM WAV.
   * @param {Float32Array[]} channels
   * @param {number} sr
   * @param {16|24|32} bitDepth  (32 = 32-bit float WAV, 16/24 = integer PCM)
   */
  function encodeWav(channels, sr, bitDepth) {
    const nCh = Math.min(2, channels.length);
    const len = channels[0].length;
    const isFloat = bitDepth === 32;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = nCh * bytesPerSample;
    const dataSize = len * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, isFloat ? 3 : 1, true);
    view.setUint16(22, nCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let off = 44;
    if (isFloat) {
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < nCh; c++) {
          view.setFloat32(off, clamp(channels[c][i], -1, 1), true);
          off += 4;
        }
      }
    } else if (bitDepth === 16) {
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < nCh; c++) {
          const v = clamp(channels[c][i], -1, 1);
          view.setInt16(off, Math.round(v * 0x7fff), true);
          off += 2;
        }
      }
    } else { // 24 bit
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < nCh; c++) {
          const v = clamp(channels[c][i], -1, 1);
          const s = Math.round(v < 0 ? v * 0x800000 : v * 0x7fffff);
          view.setUint8(off, s & 0xff);
          view.setUint8(off + 1, (s >> 8) & 0xff);
          view.setUint8(off + 2, (s >> 16) & 0xff);
          off += 3;
        }
      }
    }
    return buffer;
  }

  /** Decode a RIFF/WAVE buffer into channel arrays (used by the CLI tester). */
  function decodeWav(buffer) {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) if (u8[o + i] !== s.charCodeAt(i)) return false; return true; };
    if (!str(0, 'RIFF') || !str(8, 'WAVE')) throw new Error('not a WAV');
    let o = 12, fmt = null, dataOff = 0, dataLen = 0;
    while (o + 8 <= u8.length) {
      const size = view.getUint32(o + 4, true);
      if (str(o, 'fmt ')) {
        fmt = {
          format: view.getUint16(o + 8, true),
          channels: view.getUint16(o + 10, true),
          sr: view.getUint32(o + 12, true),
          bits: view.getUint16(o + 22, true),
        };
      } else if (str(o, 'data')) {
        dataOff = o + 8; dataLen = size; break;
      }
      o += 8 + size + (size & 1);
    }
    if (!fmt) throw new Error('WAV: no fmt chunk');
    const bytes = fmt.bits / 8;
    if (!bytes || fmt.channels < 1) throw new Error('WAV: invalid format');
    const avail = Math.max(0, Math.min(dataLen, u8.length - dataOff));
    const frames = Math.floor(avail / (bytes * fmt.channels));
    const chans = [];
    for (let c = 0; c < fmt.channels; c++) chans.push(new Float32Array(frames));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < fmt.channels; c++) {
        const p = dataOff + (i * fmt.channels + c) * bytes;
        let v = 0;
        if (fmt.format === 3) v = view.getFloat32(p, true);
        else if (fmt.bits === 16) v = clamp(view.getInt16(p, true) / 32767, -1, 1);
        else if (fmt.bits === 24) {
          let s = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
          if (s & 0x800000) s -= 0x1000000;            // sign-extend 24 → 32 bit
          v = s / 8388608;
        } else if (fmt.bits === 32) v = view.getInt32(p, true) / 2147483648;
        else if (fmt.bits === 8) v = (view.getUint8(p) - 128) / 128;
        chans[c][i] = v;
      }
    }
    return { channels: chans, sr: fmt.sr, bitDepth: fmt.bits, format: fmt.format };
  }

  /* ------------------------------------------------------------- downsampler */

  /** Peak envelope (min/max pairs) for waveform drawing. */
  function peaks(signal, buckets) {
    const n = signal.length;
    const out = new Float32Array(buckets * 2);
    const per = n / buckets;
    for (let b = 0; b < buckets; b++) {
      const s = Math.floor(b * per);
      const e = Math.min(n, Math.max(s + 1, Math.floor((b + 1) * per)));
      let mn = 1e9, mx = -1e9, sum = 0;
      for (let i = s; i < e; i++) {
        const v = signal[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v * v;
      }
      out[b] = mn;
      out[b + buckets] = mx;
    }
    return out;
  }

  /** RMS envelope for waveform drawing (nicer than peak for music). */
  function rmsEnvelope(signal, buckets) {
    const n = signal.length;
    const out = new Float32Array(buckets);
    const per = n / buckets;
    for (let b = 0; b < buckets; b++) {
      const s = Math.floor(b * per);
      const e = Math.min(n, Math.max(s + 1, Math.floor((b + 1) * per)));
      let sum = 0;
      for (let i = s; i < e; i++) sum += signal[i] * signal[i];
      out[b] = Math.sqrt(sum / (e - s));
    }
    return out;
  }

  /* ------------------------------------------------------- tiny biquad class */

  class Biquad {
    constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
    setLowpass(sr, f, q) {
      const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
      const c = Math.cos(w), s = Math.sin(w), al = s / (2 * (q || 0.707)), a0 = 1 + al;
      this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = (1 - c) / 2 / a0;
      this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
      return this;
    }
    setHighpass(sr, f, q) {
      const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
      const c = Math.cos(w), s = Math.sin(w), al = s / (2 * (q || 0.707)), a0 = 1 + al;
      this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = (1 + c) / 2 / a0;
      this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
      return this;
    }
    /** Constant-peak-gain band pass, as the worklet's Biquad builds it. */
    setBandpass(sr, f, q) {
      const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
      const c = Math.cos(w), s = Math.sin(w), al = s / (2 * (q || 0.707)), a0 = 1 + al;
      this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0;
      this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
      return this;
    }
    /** RBJ notch: a bell of `−60 dB` at its centre is what the band paths use. */
    setNotch(sr, f, q) {
      const w = TWO_PI * clamp(f, 5, sr * 0.49) / sr;
      const c = Math.cos(w), s = Math.sin(w), al = s / (2 * (q || 0.707)), a0 = 1 + al;
      this.b0 = 1 / a0; this.b1 = -2 * c / a0; this.b2 = 1 / a0;
      this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
      return this;
    }
    process(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      return y;
    }
  }

  /* ----------------------------------------------------------------- exports */

  const API = {
    flatTopStep,
    TWO_PI, clamp, db, lin,
    hann, blackman, fft, spectrum, bandLevel, bandMedian, smoothSpec,
    hfCutoff, ratioDb, slopeDbPerOct, peakDb, loudness,
    stepRange, scanStep, runSteps, runStepsAsync,
    dynamicRange, clipRatio, humStep, resonanceScan, hfRaggedness, stereoCorrelation, measure, measureAsync,
    noiseAnalysis, crackleDetect,
    stereoBandsStep, ispStep, EQ_CENTERS,
    detectSampleRate, encodeWav, decodeWav, peaks, rmsEnvelope, Biquad,
    applyBiquad, biquadHP, qualityScore,
  };

  global.RSDSP = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
