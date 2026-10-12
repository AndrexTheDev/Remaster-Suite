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
  function envelope(channels, buckets, from, to) {
    const nCh = channels.length;
    const len = channels[0].length;
    const a = Math.max(0, Math.floor(from === undefined ? 0 : from));
    const b = Math.min(len, Math.ceil(to === undefined ? len : to));
    const span = Math.max(1, b - a);
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    const rms = new Float32Array(buckets);
    for (let k = 0; k < buckets; k++) {
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
    return { min, max, rms };
  }

  /** Cheap 1-per-second loudness profile, used to pick a representative window. */
  function loudnessProfile(channels) {
    const sr = 48000;                     // nominal only: this is a shape, not a level
    const per = Math.round(sr);           // ≈ 1 s
    const len = channels[0].length;
    const out = [];
    for (let s = 0; s < len; s += per) {
      const e = Math.min(len, s + per);
      let sum = 0;
      for (let c = 0; c < channels.length; c++) {
        const ch = channels[c];
        for (let i = s; i < e; i += 3) sum += ch[i] * ch[i];
      }
      out.push(Math.sqrt(sum / Math.max(1, ((e - s) / 3) * channels.length)));
    }
    return out;
  }

  /**
   * Pick the preview window: the loudest stretch of roughly `seconds` length,
   * because that is where the difference between original and restored is heard
   * most clearly.
   */
  function pickPreviewWindow(channels, sampleRate, seconds) {
    const len = channels[0].length;
    const dur = len / sampleRate;
    const want = Math.min(seconds, dur);
    if (dur <= want + 2) return { start: 0, end: dur, seconds: dur };
    const prof = loudnessProfile(channels);
    const win = Math.max(2, Math.round(want));         // profile is per second
    let bestSum = -1, bestAt = 0;
    let sum = 0;
    for (let i = 0; i < prof.length; i++) {
      sum += prof[i];
      if (i >= win) sum -= prof[i - win];
      if (i >= win - 1 && sum > bestSum) { bestSum = sum; bestAt = i - win + 1; }
    }
    const start = clamp(bestAt, 0, Math.max(0, dur - want));
    return { start, end: start + want, seconds: want };
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

  const API = { analyze, analyzeChannels, envelope, pickPreviewWindow, chipsFrom, mixdown, loudnessProfile };
  global.RSAnalyzer = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
