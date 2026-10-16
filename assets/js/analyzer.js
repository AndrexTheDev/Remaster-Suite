/* =============================================================================
 * Remaster Suite — listening before speaking
 * -----------------------------------------------------------------------------
 * Turns an AudioBuffer into (a) hard numbers, (b) a plain-language diagnosis
 * and (c) waveform envelopes for the A/B display. Everything here is pure
 * measurement — it never touches the audio.
 * ========================================================================== */
(function (global) {
  'use strict';

  const DSP = global.RSDSP;
  const Presets = global.RSPresets;

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  /* -------------------------------------------------------------- envelopes */

  /**
   * Peak + RMS envelope of a channel set, for drawing.
   * @param {Float32Array[]} channels
   * @param {number} buckets number of horizontal pixels
   * @param {number} [from] first sample (default 0)
   * @param {number} [to] last sample (default end)
   * @returns {{min:Float32Array, max:Float32Array, rms:Float32Array}}
   */
  function envelopeStep(channels, buckets, from, to, label) {
    const nCh = channels.length;
    const len = channels[0].length;
    const a = Math.max(0, Math.floor(from === undefined ? 0 : from));
    const b = Math.min(len, Math.ceil(to === undefined ? len : to));
    const span = Math.max(1, b - a);
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    const rms = new Float32Array(buckets);
    // one bucket = one unit: buckets are independent, so slicing the k loop is
    // observable-equivalent to running it in one go
    const step = DSP.stepRange(label || 'envelope', buckets, buckets * 9000, (kFrom, kTo) => {
    for (let k = kFrom; k < kTo; k++) {
      const s = a + Math.floor((k * span) / buckets);
      const e = Math.max(s + 1, a + Math.floor(((k + 1) * span) / buckets));
      let mn = 1e9, mx = -1e9, sum = 0, cnt = 0;
      for (let i = s; i < e; i++) {
        let v = 0;
        for (let c = 0; c < nCh; c++) v += channels[c][i];
        v /= nCh;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v * v;
        cnt++;
      }
      min[k] = mn === 1e9 ? 0 : mn;
      max[k] = mx === -1e9 ? 0 : mx;
      rms[k] = Math.sqrt(sum / Math.max(1, cnt));
    }
    });
    return { step, value: () => ({ min, max, rms }) };
  }

  /**
   * Peak + RMS envelope of a channel set, for drawing (synchronous form).
   * @param {Float32Array[]} channels
   * @param {number} buckets number of horizontal pixels
   * @param {number} [from] first sample (default 0)
   * @param {number} [to] last sample (default end)
   * @returns {{min:Float32Array, max:Float32Array, rms:Float32Array}}
   */
  function envelope(channels, buckets, from, to) {
    const st = envelopeStep(channels, buckets, from, to);
    st.step.slice(0, st.step.units);
    return st.value();
  }

  /** Cheap 1-per-second loudness profile, used to pick a representative window. */
  function loudnessProfileStep(channels) {
    const sr = 48000;                     // nominal only: this is a shape, not a level
    const per = Math.round(sr);           // ≈ 1 s
    const len = channels[0].length;
    const seconds = Math.max(1, Math.ceil(len / per));
    const out = [];
    // one second = one unit (the profile is per-second by construction)
    const step = DSP.stepRange('loudness-profile', seconds, seconds * 20000, (from, to) => {
      for (let b = from; b < to; b++) {
        const s = b * per;
        const e = Math.min(len, s + per);
        let sum = 0;
        for (let c = 0; c < channels.length; c++) {
          const ch = channels[c];
          for (let i = s; i < e; i += 3) sum += ch[i] * ch[i];
        }
        out.push(Math.sqrt(sum / Math.max(1, ((e - s) / 3) * channels.length)));
      }
    });
    return { step, value: () => out };
  }

  function loudnessProfile(channels) {
    const st = loudnessProfileStep(channels);
    st.step.slice(0, st.step.units);
    return st.value();
  }

  /**
   * Pick the preview window: the loudest stretch of roughly `seconds` length,
   * because that is where the difference between original and restored is heard
   * most clearly.
   */
  /** Pick the preview window — as a plan step, so it can be sliced too. */
  function previewWindowSteps(channels, sampleRate, seconds) {
    const len = channels[0].length;
    const dur = len / sampleRate;
    const want = Math.min(seconds, dur);
    const direct = dur <= want + 2 ? { start: 0, end: dur, seconds: dur } : null;
    const prof = direct ? null : loudnessProfileStep(channels);
    const steps = direct ? [DSP.stepRange('window', 0, 0, () => {})] : [prof.step];
    const value = () => {
      if (direct) return direct;
      const p = prof.value();
      const win = Math.max(2, Math.round(want));       // profile is per second
      let bestSum = -1, bestAt = 0;
      let sum = 0;
      for (let i = 0; i < p.length; i++) {
        sum += p[i];
        if (i >= win) sum -= p[i - win];
        if (i >= win - 1 && sum > bestSum) { bestSum = sum; bestAt = i - win + 1; }
      }
      const start = clamp(bestAt, 0, Math.max(0, dur - want));
      return { start, end: start + want, seconds: want };
    };
    return { steps, value };
  }

  function pickPreviewWindow(channels, sampleRate, seconds) {
    const w = previewWindowSteps(channels, sampleRate, seconds);
    DSP.runSteps(w.steps);
    return w.value();
  }

  /* --------------------------------------------------------------- analysis */

  /**
   * Full analysis of a decoded buffer.
   * @param {AudioBuffer} audioBuffer
   * @param {{previewSeconds?:number, buckets?:number}} [opts]
   */
  function analyze(audioBuffer, opts) {
    const o = opts || {};
    const sr = audioBuffer.sampleRate;
    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
    const metrics = DSP.measure(channels, sr);
    const diag = Presets.diagnose(metrics);
    const window = pickPreviewWindow(channels, sr, o.previewSeconds || 40);
    const buckets = o.buckets || 1400;
    const env = envelope(channels, buckets, 0, channels[0].length);
    const winEnv = envelope(channels, buckets, window.start * sr, window.end * sr);
    return {
      sampleRate: sr,
      duration: channels[0].length / sr,
      channels: channels.length,
      metrics,
      diag,
      score: metrics.score,
      preset: diag.id,
      recommendedPower: (Presets.PRESETS[diag.id] || Presets.PRESETS.auto).recommended,
      window,
      envelope: env,
      windowEnvelope: winEnv,
      chips: chipsFrom(metrics),
    };
  }

  /**
   * The very same analysis, sliced and with progress — what the UI runs, so the
   * page keeps painting a real progress bar instead of freezing on a long file.
   *
   * The synchronous `analyze()` above stays the reference: both forms call the
   * same stepping routines on the same units, so they cannot disagree by one
   * bit — `tests/dsp.test.js` compares every metric of both forms.
   *
   * @param {AudioBuffer} audioBuffer
   * @param {{previewSeconds?:number, buckets?:number}} [opts]
   * @param {(p:number, stage:string) => void} [onProgress] stage: measure | diagnose | window | envelope
   */
  async function analyzeAsync(audioBuffer, opts, onProgress) {
    const o = opts || {};
    const sr = audioBuffer.sampleRate;
    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
    const buckets = o.buckets || 1400;
    const report = (p, stage) => { if (onProgress) onProgress(clamp(p, 0, 1), stage); };

    report(0, 'measure');
    // the measurement is about three quarters of the work
    const metrics = await DSP.measureAsync(channels, sr, (p) => report(p * 0.74, 'measure'));
    // A file that is not made of numbers cannot be repaired: every filter in the
    // chain would carry the NaN to the end of the output. Refuse it here, with a
    // message, instead of handing the render parameters built from nonsense.
    if (metrics.nonFinite) throw new Error('broken-audio');
    report(0.76, 'diagnose');
    const diag = Presets.diagnose(metrics);

    const w = previewWindowSteps(channels, sr, o.previewSeconds || 40);
    await DSP.runStepsAsync(w.steps, (p) => report(0.76 + p * 0.06, 'window'));
    const picked = w.value();

    const envStep = envelopeStep(channels, buckets, 0, channels[0].length, 'envelope');
    await DSP.runStepsAsync([envStep.step], (p) => report(0.82 + p * 0.12, 'envelope'));
    const env = envStep.value();

    const winStep = envelopeStep(channels, buckets, picked.start * sr, picked.end * sr, 'envelope');
    await DSP.runStepsAsync([winStep.step], (p) => report(0.94 + p * 0.05, 'envelope'));
    const winEnv = winStep.value();

    report(1, 'diagnose');
    return {
      sampleRate: sr,
      duration: channels[0].length / sr,
      channels: channels.length,
      metrics,
      diag,
      score: metrics.score,
      preset: diag.id,
      recommendedPower: (Presets.PRESETS[diag.id] || Presets.PRESETS.auto).recommended,
      window: picked,
      envelope: env,
      windowEnvelope: winEnv,
      chips: chipsFrom(metrics),
    };
  }

  /**
   * Where the restoration changed the audio, per horizontal bucket of a preview
   * window — the highlights the waveform draws over the two halves.
   *
   *   clicks  a spike was taken out: the bucket's crest factor (peak over RMS)
   *           fell by more than 4 dB, and the spike was well above the music
   *           (crest > 14 dB before). A click is a crest, not a level change.
   *   bright  the top end (above 8 kHz) took a larger share of the bucket's
   *           energy: its energy ratio (band above 8 kHz over the full band)
   *           rose by more than 3 dB, and the band has real content (its level
   *           is above −60 dBFS). A ratio, not a level: a louder bucket with the
   *           same tilt is not "bright", and a rise in the band the source
   *           already had is the sheen a codec-cut master gets back (or a fake
   *           one, which is what the bandwidth-extension rows in
   *           tools/acceptance.js check against). The previous metric was the
   *           RMS of the first difference, which is not band-limited and moved
   *           with any level change.
   *
   * Column resolution: a bucket is ~28 ms on a 40 s window, so the 2–9 ms the
   * chain's look-ahead adds does not move a highlight off its bucket.
   *
   * @param {Float32Array[]} before the original's window channels
   * @param {Float32Array[]} after  the rendered window channels
   * @param {number} buckets
   * @param {number} [sr=48000]     sample rate, for the 8 kHz split
   * @returns {{clicks:Uint8Array, bright:Uint8Array}}
   */
  /* Click thresholds, calibrated on synthetic platter clicks (2 ms damped 2.5 kHz
   * bursts over a pink bed) at the app's real resolution (40 s in 1400 buckets,
   * ~28 ms each), against a limiter that trims sharp 80 Hz kick transients by up
   * to 3 dB. Crest gate 14 → 10 dB: ×6-bed clicks 30 → 48 of 120, ×8 95 → 104 of
   * 120, limiter false positives 0 at either setting. Below 6 dB nothing changes.
   * ×4-bed clicks stay mostly undetected (8 of 120): at that level the click
   * barely clears the bed's own crest, so this metric cannot separate them. The
   * drop gate stays at 4 dB (3 dB gave false positives on the limiter). Real
   * platter recordings were not available to calibrate against. */
  const CLICK_MIN_CREST_DB = 10, CLICK_MIN_DROP_DB = 4;
  function correctionMap(before, after, buckets, sr) {
    const n = Math.min(before[0].length, after[0].length);
    const clicks = new Uint8Array(buckets), bright = new Uint8Array(buckets);
    const hpB = topBandPerChannel(before, sr || 48000, n);
    const hpA = topBandPerChannel(after, sr || 48000, n);
    const stat = (chs, hp, s, e) => {
      let peak = 0, sq = 0, eAll = 0, eHf = 0, cnt = 0;
      for (let c = 0; c < Math.min(chs.length, hp.length); c++) {
        const x = chs[c], h = hp[c];
        for (let i = s; i < e; i++) {
          const v = x[i], a = v < 0 ? -v : v;
          if (a > peak) peak = a;
          sq += v * v;
          eAll += v * v;
          eHf += h[i] * h[i];
          cnt++;
        }
      }
      const rms = Math.sqrt(sq / Math.max(1, cnt));
      return {
        crest: peak > 1e-9 && rms > 1e-9 ? 20 * Math.log10(peak / rms) : 0,
        peak,
        share: eAll > 1e-18 ? eHf / eAll : 0,
        hfDb: 10 * Math.log10(eHf / Math.max(1, cnt) + 1e-18),   // 20·log10 of the band's RMS
      };
    };
    for (let k = 0; k < buckets; k++) {
      const s = Math.floor((k * n) / buckets), e = Math.floor(((k + 1) * n) / buckets);
      if (e <= s) continue;
      const b = stat(before, hpB, s, e), a = stat(after, hpA, s, e);
      if (b.crest - a.crest > CLICK_MIN_DROP_DB && b.crest > CLICK_MIN_CREST_DB && b.peak > 0.02) clicks[k] = 1;
      const ratioDb = 10 * Math.log10((a.share + 1e-12) / (b.share + 1e-12));
      if (ratioDb > 3 && a.hfDb > -60) bright[k] = 1;
    }
    return { clicks, bright };
  }

  /**
   * The energy above 8 kHz of each channel: a 2nd-order Butterworth high-pass
   * (RBJ, Q 0.707) run once over the window. Returns one Float32Array per channel.
   */
  function topBandPerChannel(chs, sr, n) {
    const w0 = 2 * Math.PI * 8000 / sr, cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, b2 = b0;
    const a1 = -2 * cw / a0, a2 = (1 - alpha) / a0;
    return chs.map((x) => {
      const y = new Float32Array(n);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < n; i++) {
        const v = x[i];
        const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        y[i] = o; x2 = x1; x1 = v; y2 = y1; y1 = o;
      }
      return y;
    });
  }

  /** Re-measure a processed channel set (used for the Before/After read-out). */
  function analyzeChannels(channels, sr) {
    const metrics = DSP.measure(channels, sr);
    return {
      metrics,
      score: metrics.score,
      chips: chipsFrom(metrics),
      diag: Presets.diagnose(metrics),
    };
  }

  /** The numbers shown as small chips on every card. */
  function chipsFrom(m) {
    return {
      score: m.score,
      peakDb: m.peakDb,
      loudness: m.loudness,
      hfCutoff: m.hfCutoff,
      noiseFloorDb: m.noiseFloorDb,
      dynamicRangeDb: m.dynamicRangeDb,
      correlation: m.correlation,
      clipRatio: m.clipRatio,
      crestDb: m.crestDb,
      crackleIndex: m.crackleIndex,
      channels: m.channels,
    };
  }

  /** Mixed-down mono copy — handy for the preview render and for encoding. */
  function mixdown(channels) {
    if (channels.length === 1) return channels[0];
    const n = channels[0].length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < channels.length; c++) v += channels[c][i];
      out[i] = v / channels.length;
    }
    return out;
  }

  const API = {
    analyze, analyzeAsync, analyzeChannels, envelope, envelopeStep, pickPreviewWindow, chipsFrom, correctionMap,
    mixdown, loudnessProfile,
  };
  global.RSAnalyzer = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
