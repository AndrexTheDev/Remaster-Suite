/* Synchronous tooling bridge: the child uses the actual async production codec
 * and dedicated worker, rather than a stale duplicate of its encoding law.
 * Input: 32-bit float WAV on stdin. Arguments: output path, kbps, sample rate.
 */
'use strict';
const fs = require('fs');
global.RSDSP = require('../assets/js/dsp-utils.js');
global.Worker = require('../tests/encoding-worker-adapter.js');
const Codecs = require('../assets/js/codecs.js');
(async () => {
  const bytes = fs.readFileSync(0);
  const input = global.RSDSP.decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const result = await Codecs.encodeMp3(input.channels, Number(process.argv[4]), Number(process.argv[3]));
  fs.writeFileSync(process.argv[2], result.bytes);
})().catch(err => { console.error(err); process.exitCode = 1; });
