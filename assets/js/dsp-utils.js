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
    const st = stepRange('spectrum', count, count * 610000, (from, to) => {
      for (let idx = from; idx < to && idx < count; idx++) {
        const off = offsets[idx] * o.hop;
        re.fill(0); im.fill(0);
        for (let c = 0; c < nCh; c++) {
          const s = channels[c];
          for (let i = 0; i < n; i++) re[i] += (s[off + i] || 0) * win[i];
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
        for (let k = 0; k <= half; k++) {
          const amp = Math.sqrt(acc[k] / Math.max(1, frames)) * norm;
          out[k] = Math.max(o.dbFloor, db(amp));
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

  /** Integrated-style loudness (ITU-R BS.1770 flavour, approx ±1.5 LU). */
  function loudness(channels, sr) {
    const l = loudnessStep(channels, sr);
    l.step.slice(0, l.step.units);
    return l.value();
  }

  /* --- crackle / click detection ------------------------------------------- */

  /**
   * Crackle / click detection.
   *
   * A vinyl pop, a digital glitch or a tape dropout is a *tall, narrow* spike,
   * so it stands out in the crest factor (peak ÷ RMS) of the 8.5 kHz+ band —
   * regardless of how loud the music is. We take the 98th percentile of the
   * per-window crest factors, which is immune to a single stray event but reacts
   * immediately to real crackle.
   *
   * Reference values: clean music ≈ 13 dB · light crackle ≈ 20 dB · worn vinyl ≈ 24 dB+.
   */
  function crackleStep(channels, sr, winSec) {
    const [b0, b1, b2, a1, a2] = biquadHP(sr, 8500, 0.707);
    const win = Math.max(64, Math.round(sr * (winSec || 0.02)));
    const per = channels.map((ch) => (ch.length >= win ? Math.floor((ch.length - win) / win) + 1 : 0));
    let units = 0;
    for (const k of per) units += k;
    const state = channels.map(() => ({ z1: 0, z2: 0 }));
    const st = { crests: [], gPeak: 0, gSum: 0, gCount: 0, pops: 0 };
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
            }
            st.gSum += ms; st.gCount += win;
            if (peak > st.gPeak) st.gPeak = peak;
            const rms = Math.sqrt(ms / win);
            if (rms > 1e-5) {
              const cf = peak / rms;
              st.crests.push(cf);
              if (cf > 4.5) st.pops++;
            }
          }
        }
        base = end;
      }
    });
    return {
      step,
      value() {
        const grms = Math.sqrt(st.gSum / Math.max(1, st.gCount));
        const globalCrestDb = 20 * Math.log10(st.gPeak / (grms + 1e-12));
        st.crests.sort((a, b) => a - b);
        const p98 = st.crests.length ? st.crests[Math.min(st.crests.length - 1, Math.floor(st.crests.length * 0.98))] : 1;
        const med = st.crests.length ? st.crests[Math.floor(st.crests.length * 0.5)] : 1;
        const crestP98Db = 20 * Math.log10(p98 + 1e-9);
        const index = clamp((crestP98Db - 13) / 10, 0, 1) * 0.75
          + clamp((globalCrestDb - 13) / 10, 0, 1) * 0.25;
        return {
          index: clamp(index, 0, 1),
          crestP98Db,
          globalCrestDb,
          medianCrestDb: 20 * Math.log10(med + 1e-9),
          frames: st.crests.length,
          spikes: st.pops,
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
    const hfCh = [];
    const filters = [];
    for (let c = 0; c < nCh; c++) {
      const a = new Biquad(), b = new Biquad();
      a.setHighpass(sr, 4000, 0.707); b.setHighpass(sr, 4000, 0.707);
      filters.push({ a, b });
      hfCh.push(new Float32Array(len));
    }
    const frameRms = new Float32Array(total);
    const hfFrame = new Float32Array(total);

    const stepHf = scanStep('noise-hf', channels, 14, () => ({}),
      (st, c, ch, i) => { const f = filters[c]; hfCh[c][i] = f.b.process(f.a.process(ch[i])); });

    const stepFrames = stepRange('noise-frames', total, total * 30, (from, to) => {
      for (let fr = from; fr < to; fr++) {
        const off = fr * hop;
        let ms = 0, hs = 0;
        for (let c = 0; c < nCh; c++) {
          const ch = channels[c], hch = hfCh[c];
          for (let i = 0; i < fftSize; i++) {
            const v = ch[off + i];
            ms += v * v;
            const w = hch[off + i];
            hs += w * w;
          }
        }
        frameRms[fr] = Math.sqrt(ms / (fftSize * nCh));
        hfFrame[fr] = Math.sqrt(hs / (fftSize * nCh));
      }
    });

    // the distribution is read between the two loops, exactly as before
    const stats = { p02: 0, p05: 0, p20: 0, p50: 0, p90: 0, p98: 0, hfP02: 0, hfP98: 0,
      quietLimit: 0, quietCount: 0, useAll: true, visit: null };
    const stepStats = stepRange('noise-stats', 1, 60000, () => {});
    stepStats.before = () => {
      const sorted = Float32Array.from(frameRms).sort();
      const sortedHf = Float32Array.from(hfFrame).sort();
      const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
      const pctHf = (p) => sortedHf[Math.min(sortedHf.length - 1, Math.max(0, Math.floor(sortedHf.length * p)))];
      stats.p02 = pct(0.02); stats.p05 = pct(0.05); stats.p20 = pct(0.20); stats.p50 = pct(0.50);
      stats.p90 = pct(0.90); stats.p98 = pct(0.98);
      stats.hfP02 = pctHf(0.02); stats.hfP98 = pctHf(0.98);
      stats.quietLimit = Math.max(pct(0.08), 1e-8);
      let quietCount = 0;
      for (let fr = 0; fr < total; fr++) if (frameRms[fr] <= stats.quietLimit) quietCount++;
      stats.quietCount = quietCount;
      stats.useAll = quietCount < 4;
      // the frames the accumulation below will actually visit (≤ 400) — known
      // up front so the progress bar is weighted by real work, not by the file
      const visit = [];
      for (let fr = 0; fr < total && visit.length < 400; fr++) {
        if (!stats.useAll && frameRms[fr] > stats.quietLimit) continue;
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
        for (let k = 0; k <= half; k++) spec[k] = Math.max(acc[k] / nUsed, 1e-20);
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
        // how much the recording actually breathes: a file with no quiet passages
        // gets confidence 0 — we then never claim noise that we cannot prove
        const frameRange = db(stats.p98) - db(stats.p05);
        return { spec, floorDb, hfFloorDb, midFloorDb, lowFloorDb, noiseSlope, flatness, rumble,
          bbDynDb, hfDynDb, hissDeficitDb,
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

  /* --- dynamic range, clipping, correlation -------------------------------- */

  /** Dynamic range proxy: loud frame RMS minus quiet frame RMS. */
  function dynamicRangeStep(channels, sr) {
    const win = Math.max(256, Math.round(sr * 0.05));
    const nCh = channels.length, len = channels[0].length;
    const count = len >= win ? Math.floor((len - win) / win) + 1 : 0;
    const vals = [];
    const step = stepRange('dynamic-range', count, count * win * 1.1, (from, to) => {
      for (let w = from; w < to; w++) {
        const off = w * win;
        let ms = 0;
        for (let c = 0; c < nCh; c++) {
          const s = channels[c];
          for (let i = 0; i < win; i++) { const v = s[off + i]; ms += v * v; }
        }
        vals.push(Math.sqrt(ms / (win * nCh)));
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
    return scanStep('clip', channels, 2.6, () => ({ clipped: 0, total: 0 }),
      (st, c, ch, i) => { const v = ch[i]; if (v > 0.994 || v < -0.994) st.clipped++; st.total++; },
      (st) => (st.total ? st.clipped / st.total : 0));
  }

  function clipRatio(channels) {
    const st = clipStep(channels);
    st.slice(0, st.units);
    return st.value();
  }

  /** Mains hum: 50/100 or 60/120 Hz peakiness vs. the surrounding spectrum. */
  function humScore(spec) {
    const g = (f, bw) => bandMedian(spec, f - bw, f + bw);
    const ref = (g(45, 6) + g(55, 6) + g(100, 8) + g(120, 8)) / 4;
    const f50 = g(50, 2.5) - ref;
    const f60 = g(60, 2.5) - ref;
    return { score: Math.max(0, Math.max(f50, f60)) / 12, f50: f50, f60: f60 };
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

  /* --- the full measurement ------------------------------------------------- */

  /**
   * The whole measurement as a plan: a list of steps (each range-addressable)
   * plus a `result()` that turns the accumulated numbers into the metrics.
   * `measure()` runs it in one go, `measureAsync()` runs it in slices.
   */
  function measurePlan(channels, sr) {
    const sp = spectrumStep(channels, sr, { fftSize: 8192, maxFrames: 140 });
    const pk = peakStep(channels);
    const cl = clipStep(channels);
    const cor = correlationStep(channels);
    const crk = crackleStep(channels, sr);
    const ldn = loudnessStep(channels, sr);
    const dyn = dynamicRangeStep(channels, sr);
    const nt = noiseStep(channels, sr);
    const steps = [
      sp.step, pk, cl, cor, crk.step, ldn.step, dyn.step,
      nt.steps[0], nt.steps[1], nt.steps[2], nt.steps[3],
      stepRange('finalise', 1, 40000, () => {}),
    ];

    function result() {
      const spec = sp.value();
      const na = nt.value();
      const crackle = crk.value();
      const nf = na.floorDb;
      const hfNf = na.hfFloorDb;
      const cut = hfCutoff(spec, 32);
      const hum = humScore(spec);
      const m = {
        sr,
        channels: channels.length,
        duration: channels[0].length / sr,
        peakDb: pk.value(),
        crestDb: pk.value() - db(Math.sqrt(
          (() => { let s = 0, c = 0; for (const ch of channels) { for (let i = 0; i < ch.length; i += 7) { s += ch[i] * ch[i]; c++; } } return s / c; })()
        )),
        loudness: ldn.value(),
        noiseFloorDb: nf,
        hfNoiseFloorDb: hfNf,
        noiseSlope: na.noiseSlope,
        noiseFlatness: na.flatness,
        noiseRumble: na.rumble,
        noiseConfidence: na.confidence,
        crackleIndex: crackle.index,
        noiseInfo: Object.assign({}, na, { crackleIndex: crackle.index, crestP98Db: crackle.crestP98Db, crestGlobalDb: crackle.globalCrestDb }),
        hfNoiseDeltaDb: hfNf - nf,
        dynamicRangeDb: dyn.value(),
        clipRatio: cl.value(),
        musicLevelDb: na.musicDb,
        humScore: hum.score,
        hum50: hum.f50,
        hum60: hum.f60,
        hfCutoff: cut,
        correlation: cor.value(),
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
      m.hissAmount = clamp((m.hissDeficitDb - 1.0) / 4.0, 0, 1) * hissLevel * clamp(m.noiseConfidence * 1.5, 0, 1);
      m.hfDropDb = bandMedian(spec, 6000, 8000) - bandMedian(spec, 12000, 16000);
      const smS = smoothSpec(spec, 6);
      let maxCliff = 0, cliffAt = 0;
      for (let k = 0; k < spec.n; k++) {
        const f = spec.freq[k];
        if (f < 8000 || f > 19500) continue;
        let j = k, span = 0;
        while (j < spec.n && span < 1600) { span = spec.freq[j] - f; j++; }
        const drop = smS[k] - smS[Math.min(spec.n - 1, j - 1)];
        if (drop > maxCliff) { maxCliff = drop; cliffAt = f; }
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
    const topLoss = clamp(((m.hfCutoff || 0) < 17000 ? (17000 - (m.hfCutoff || 0)) / 9000 : 0), 0, 1);
    const snr = clamp(m.snrDb / 60, 0, 1);
    const hiss = clamp(m.hissAmount, 0, 1);
    const crackle = clamp(m.crackleIndex, 0, 1);
    const s =
      100
      - 24 * clamp(m.bassRoll, 0, 1)
      - 16 * clamp(m.mudScore, 0, 1)
      - 14 * clamp(m.harshness, 0, 1)
      - 22 * clamp(topLoss * 0.6 + m.bandLimited * 0.4, 0, 1)
      - 16 * (1 - snr)
      - 12 * hiss
      - 12 * crackle
      - 6 * clamp(m.humScore, 0, 1)
      - 6 * clamp((m.clipRatio || 0) * 300, 0, 1);
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
    process(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      return y;
    }
  }

  /* ----------------------------------------------------------------- exports */

  const API = {
    TWO_PI, clamp, db, lin,
    hann, blackman, fft, spectrum, bandLevel, bandMedian, smoothSpec,
    hfCutoff, ratioDb, slopeDbPerOct, peakDb, loudness,
    stepRange, scanStep, runSteps, runStepsAsync,
    dynamicRange, clipRatio, humScore, stereoCorrelation, measure, measureAsync,
    noiseAnalysis, crackleDetect,
    detectSampleRate, encodeWav, decodeWav, peaks, rmsEnvelope, Biquad,
    applyBiquad, biquadHP, qualityScore,
  };

  global.RSDSP = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
