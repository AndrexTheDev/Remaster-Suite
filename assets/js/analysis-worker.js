/**
 * @fileoverview Optional off-thread UI measurement. Uses the exact production
 * DSP/analyzer modules; no alternate metric implementation or clean oracle.
 * @module RSAnalysisWorker
 * @typedef {Object} MeasurementCommand
 * @property {number} id - request identifier.
 * @property {string} mode - analyze, after or envelope.
 * @property {Float32Array[]} channels - owned observations.
 * @property {number} sr - sample rate.
 * @property {Object} options - analysis/envelope configuration.
 */
'use strict';
importScripts('dsp-utils.js', 'presets.js', 'analyzer.js');
let requests = Promise.resolve();
/** Process one owned observation set; jobs are serialized to bound working PCM.
 * @param {Object} data - id, mode, channels, sr and options.
 * @returns {Promise<void>} completion response.
 */
async function measureRequest(data) {
  const { id, channels, sr, options, mode } = data;
  try {
    let result;
    if (mode === 'analyze') {
      const audio = { sampleRate: sr, numberOfChannels: channels.length,
        length: channels[0].length, duration: channels[0].length / sr, getChannelData: c => channels[c] };
      result = await self.RSAnalyzer.analyzeAsync(audio, options,
        (progress, stage) => self.postMessage({ id, progress, stage }));
    } else if (mode === 'after') result = await self.RSAnalyzer.analyzeChannelsAsync(channels, sr);
    else if (mode === 'envelope') result = await self.RSAnalyzer.envelopeAsync(channels, options.buckets);
    else throw new Error('Unknown measurement mode');
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message || String(error) }); }
}
self.onmessage = ({ data }) => { requests = requests.then(() => measureRequest(data)); };
