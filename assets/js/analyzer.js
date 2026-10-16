/* =============================================================================
 * Remaster Suite — listening before speaking
 * -----------------------------------------------------------------------------
 * Turns an AudioBuffer into (a) hard numbers, (b) a plain-language diagnosis
 * and (c) waveform envelopes for the A/B display. Everything here is pure
 * measurement — it never touches the audio.
 * ========================================================================== */
/**
 * @fileoverview File measurement and diagnosis — exposed as the global
 * `RSAnalyzer` (`globalThis.RSAnalyzer`).
 *
 * Turns a decoded `AudioBuffer` into (a) the hard numbers (`RSDSP.measure`),
 * (b) a plain-language diagnosis (`RSPresets.diagnose`), (c) the loudest
 * preview window, and (d) peak/RMS envelopes for the A/B canvas. Everything
 * here is pure measurement: no stage of this module writes to the audio it is
 * handed.
 *
 * Two spellings of the same analysis exist on purpose. `analyze()` runs
 * synchronously and is the reference; `analyzeAsync()` is the one the page
 * uses, because it slices the work through `RSDSP.runStepsAsync` and reports
 * progress instead of freezing the tab on a long file. Both walk the same
 * stepping routines on the same units, and `tests/dsp.test.js` compares every
 * metric of both forms — so the async form cannot drift from the reference.
 *
 * @module RSAnalyzer
 */
(function (global) {
  'use strict';

  const DSP = global.RSDSP;
  const Presets = global.RSPresets;

  /**
   * Clamp a number into an inclusive range.
   * @param {number} x - value to clamp.
   * @param {number} lo - lower bound.
   * @param {number} hi - upper bound.
   * @returns {number} `x` limited to `lo…hi`; `NaN` passes through unchanged
   *   (callers that care check it themselves).
   */
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  /**
   * Per-bucket peak/RMS envelope of a signal, in the pixel geometry the A/B
   * canvas draws with.
   * @typedef {Object} Envelope
   * @property {Float32Array} min - lowest (most negative) sample per bucket.
   * @property {Float32Array} max - highest sample per bucket.
   * @property {Float32Array} rms - root-mean-square per bucket.
   */

  /**
   * The preview window: the loudest stretch of roughly the requested length,
   * picked because that is where the difference between original and restored
   * is heard most clearly. All three fields are in seconds.
   * @typedef {Object} PreviewWindow
   * @property {number} start - window start in seconds from the file's start.
   * @property {number} end - window end in seconds (file end at the latest).
   * @property {number} seconds - `end - start`, i.e. the window's own length.
   */

  /**
   * The small numbers under every card, all taken from the measurement.
   * @typedef {Object} Chips
   * @property {number} score - sound-quality score, 0…100.
   * @property {number} peakDb - sample peak in dBFS (0 = full scale).
   * @property {number} loudness - programme loudness in LUFS.
   * @property {number} hfCutoff - highest frequency carrying programme, in Hz.
   * @property {number} noiseFloorDb - estimated noise floor in dBFS.
   * @property {number} dynamicRangeDb - measured dynamic range in dB.
   * @property {number} correlation - stereo correlation, −1…1.
   * @property {number} clipRatio - share of samples at/near full scale, 0…1.
   * @property {number} crestDb - crest factor (peak minus RMS) in dB.
   * @property {number} crackleIndex - click/crackle index, 0…1.
   * @property {number} channels - channel count of the analysed file.
   */

  /**
   * The progress stages this module reports. `app.js` maps each of them to a
   * translated label; `tests/audit.test.js` pins that every stage here has
   * wording in both languages.
   * @typedef {'measure'|'diagnose'|'window'|'envelope'} AnalyzerStage
   */

  /**
   * What both `analyze()` and `analyzeAsync()` resolve to.
   * @typedef {Object} AnalysisResult
   * @property {number} sampleRate - sample rate of the analysed buffer, in Hz.
   * @property {number} duration - length in seconds.
   * @property {number} channels - channel count (1 = mono, 2 = stereo).
   * @property {RSDSP.Metrics} metrics - the raw measurement behind everything
   *   else on this object.
   * @property {RSPresets.Diagnosis} diag - profile id, wording and reasons.
   * @property {number} score - `metrics.score`, copied for convenience.
   * @property {string} preset - detected profile id (`diag.id`).
   * @property {number} recommendedPower - 0…1 restoration power the detected
   *   profile recommends; what the slider adopts after the first file.
   * @property {PreviewWindow} window - the preview window.
   * @property {Envelope} envelope - envelope of the whole file.
   * @property {Envelope} windowEnvelope - envelope of the preview window.
   * @property {Chips} chips - the card read-out.
   */

  /* -------------------------------------------------------------- envelopes */

  /**
   * Peak + RMS envelope of a channel set, for drawing.
   * Sliced form: the returned {@link Step} can be suspended between buckets,
   * which is what lets `analyzeAsync()` keep the page painting. One bucket is
   * one unit of work.
   * @param {Float32Array[]} channels - channel list; every channel must be the
   *   same length. Samples are averaged across channels first, so a stereo file
   *   yields one mono envelope.
   * @param {number} buckets - number of horizontal pixels (buckets).
   * @param {number} [from=0] - first sample to read.
   * @param {number} [to=channels[0].length] - one past the last sample to read.
   * @param {string} [label='envelope'] - stage label handed to
   *   `RSDSP.stepRange` for progress reporting.
   * @returns {{step: Step, value: function(): Envelope}} `value()` returns the
   *   three full-length arrays; `step` is already run to completion by the
   *   caller here (see `envelope()`), or sliced further by the async path.
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
   * @param {number} [to=channels[0].length] - one past the last sample to read.
   * @returns {Envelope} the completed envelope.
   */
  function envelope(channels, buckets, from, to) {
    const st = envelopeStep(channels, buckets, from, to);
    st.step.slice(0, st.step.units);
    return st.value();
  }

  /**
   * Cheap one-value-per-second loudness profile (RMS, every third sample),
   * used only to *shape* the file and find its loudest stretch — hence the
   * nominal 48 kHz and the decimation: this is a shape, not a level, and must
   * stay cheaper than the real measurement. One second is one unit of work.
   * @param {Float32Array[]} channels - channel list, equal lengths.
   * @returns {{step: Step, value: function(): number[]}} `value()` returns one
   *   RMS value per second of material, in file order.
   */
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

  /**
   * Synchronous form of {@link loudnessProfileStep}: run every unit at once.
   * @param {Float32Array[]} channels - channel list, equal lengths.
   * @returns {number[]} one RMS value per second of material.
   */
  function loudnessProfile(channels) {
    const st = loudnessProfileStep(channels);
    st.step.slice(0, st.step.units);
    return st.value();
  }

  /**
   * Pick the preview window — as a plan step, so it can be sliced too: the
   * loudest stretch of roughly `seconds` length, found by sliding a window over
   * the per-second loudness profile. Files shorter than the request are their
   * own window, and that case costs no work at all (its step has zero units).
   * @param {Float32Array[]} channels - channel list, equal lengths.
   * @param {number} sampleRate - sample rate in Hz, to convert samples to the
   *   seconds the window is expressed in.
   * @param {number} seconds - desired window length; shortened automatically
   *   for a file that is shorter than this.
   * @returns {{steps: Step[], value: function(): PreviewWindow}} the plan the
   *   caller runs (sliced or whole) and the function that reads the result.
   */
  function previewWindowSteps(channels, sampleRate, seconds) {
    const len = channels[0].length;
    const dur = len / sampleRate;
    const want = Math.min(seconds, dur);
    const direct = dur <= want + 2 ? { start: 0, end: dur, seconds: dur } : null;
    const prof = direct ? null : loudnessProfileStep(channels);
    const steps = direct ? [DSP.stepRange('window', 0, 0, () => {})] : [prof.step];
    /**
     * Turn the loudness profile into the window start: the loudest
     * `seconds`-long stretch of the file, or the whole file when it is too
     * short for the search to mean anything.
     * @returns {{start:number, end:number, seconds:number}} window in seconds
     */
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

  /**
   * Synchronous form of {@link previewWindowSteps}: run the plan, read it.
   * @param {Float32Array[]} channels - channel list, equal lengths.
   * @param {number} sampleRate - sample rate in Hz.
   * @param {number} seconds - desired window length in seconds.
   * @returns {PreviewWindow} the chosen window.
   */
  function pickPreviewWindow(channels, sampleRate, seconds) {
    const w = previewWindowSteps(channels, sampleRate, seconds);
    DSP.runSteps(w.steps);
    return w.value();
  }

  /* --------------------------------------------------------------- analysis */

  /**
   * Full analysis of a decoded buffer — synchronous, blocking, and the
   * reference the async form is compared against.
   * @param {AudioBuffer} audioBuffer - decoded file; its channel data is read,
   *   never modified.
   * @param {Object} [opts] - analysis options.
   * @param {number} [opts.previewSeconds=40] - desired preview window length.
   * @param {number} [opts.buckets=1400] - envelope resolution in buckets.
   * @returns {AnalysisResult} metrics, diagnosis, window, envelopes and chips.
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
   * @param {AudioBuffer} audioBuffer - decoded file; read-only here too.
   * @param {Object} [opts] - same options as `analyze()`.
   * @param {number} [opts.previewSeconds=40] - desired preview window length.
   * @param {number} [opts.buckets=1400] - envelope resolution in buckets.
   * @param {(p: number, stage: AnalyzerStage) => void} [onProgress] - called
   *   with a monotonic 0…1 share and the {@link AnalyzerStage} it belongs to;
   *   deliberately coarse, so every report is a real step and never an
   *   invented number.
   * @returns {Promise<AnalysisResult>} the same object shape `analyze()` returns.
   * @throws {Error} `'broken-audio'` when the file is not made of numbers
   *   (`metrics.nonFinite`): every filter in the chain would carry the `NaN` to
   *   the end of the output, so the file is refused here, with a message,
   *   instead of handing the renderer parameters built from nonsense.
   */
  async function analyzeAsync(audioBuffer, opts, onProgress) {
    const o = opts || {};
    const sr = audioBuffer.sampleRate;
    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
    const buckets = o.buckets || 1400;
    /**
     * Report progress as a clamped 0…1 fraction plus the stage name, and do
     * nothing at all when the caller passed no callback.
     * @param {number} p - fraction of the whole analysis, clamped to 0…1.
     * @param {string} stage - stage id the UI translates to a label.
     * @returns {void}
     */
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
   * Re-measure an already-rendered channel set, for the After column of the
   * before/after read-out. No diagnosis of the *file* is made from it beyond
   * the fresh one this returns.
   * @param {Float32Array[]} channels - rendered channels, equal lengths.
   * @param {number} sr - their sample rate in Hz.
   * @returns {{metrics: RSDSP.Metrics, score: number, chips: Chips,
   *   diag: RSPresets.Diagnosis}} the new numbers, the score, the card chips
   *   and a diagnosis of the result.
   */
  function analyzeChannels(channels, sr) {
    const metrics = DSP.measure(channels, sr);
    return {
      metrics,
      score: metrics.score,
      chips: chipsFrom(metrics),
      diag: Presets.diagnose(metrics),
    };
  }

  /**
   * Pick the handful of headline numbers out of a full measurement — the ones
   * small enough to sit as chips on a card, and the only part of the metrics a
   * card ever shows.
   * @param {RSDSP.Metrics} m - a complete measurement.
   * @returns {Chips} the card read-out (a copy: the metrics themselves stay
   *   untouched).
   */
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

  /**
   * Average a channel set down to mono. Used by the preview render and by the
   * encoders, and deliberately the plain arithmetic mean: anything cleverer
   * (weighting, phase alignment) would change the file the user hears versus
   * the file they get.
   * @param {Float32Array[]} channels - channel list, equal lengths; a single
   *   channel is returned as-is, not copied.
   * @returns {Float32Array} the mono mixdown.
   */
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

  /**
   * The public surface, assigned to `global.RSAnalyzer` below.
   * @typedef {Object} RSAnalyzerApi
   * @property {function(AudioBuffer, Object=): AnalysisResult} analyze
   * @property {function(AudioBuffer, Object=, function(number, AnalyzerStage)=): Promise<AnalysisResult>} analyzeAsync
   * @property {function(Float32Array[], number): Object} analyzeChannels
   * @property {function(Float32Array[], number, number=, number=): Envelope} envelope
   * @property {function(Float32Array[], number, number=, number=, string=): {step: Step, value: function(): Envelope}} envelopeStep
   * @property {function(Float32Array[], number, number): PreviewWindow} pickPreviewWindow
   * @property {function(RSDSP.Metrics): Chips} chipsFrom
   * @property {function(Float32Array[]): Float32Array} mixdown
   * @property {function(Float32Array[]): number[]} loudnessProfile
   */

  /** @type {RSAnalyzerApi} */
  const API = {
    analyze, analyzeAsync, analyzeChannels, envelope, envelopeStep, pickPreviewWindow, chipsFrom,
    mixdown, loudnessProfile,
  };
  /** @type {RSAnalyzerApi} */
  global.RSAnalyzer = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
