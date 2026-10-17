/**
 * @fileoverview Dedicated LAME WASM encoder. One file per worker lease.
 * @module RSEncodingWorker
 * @typedef {Object} EncodingCommand
 * @property {string} cmd - init or chunk.
 * @property {Float32Array[]} [channels] - transferred, normalized PCM.
 * @property {boolean} [last] - flush this file.
 */
'use strict';
importScripts('../vendor/WasmMediaEncoder.min.js');
let encoder;
self.onmessage = async ({ data: d }) => {
  try {
    let bytes = new Uint8Array(0);
    if (d.cmd === 'init') {
      if (!encoder) encoder = await self.WasmMediaEncoder.createEncoder('audio/mpeg', '../vendor/mp3.wasm');
      encoder.configure({ channels: d.nCh, sampleRate: d.sr, outputSampleRate: d.sr, bitrate: d.kbps });
    } else if (d.cmd === 'chunk') {
      const parts = [];
      if (d.channels[0].length) parts.push(encoder.encode(d.channels).slice());
      if (d.last) parts.push(encoder.finalize().slice());
      bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) { bytes.set(p, off); off += p.length; }
    } else throw new Error('Unknown encoding command');
    self.postMessage({ ok: true, data: bytes.buffer }, [bytes.buffer]);
  } catch (e) { self.postMessage({ ok: false, err: e.message }); }
};
