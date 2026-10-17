/* Node test adapter: runs the UNMODIFIED production worker in worker_threads.
 * No encoder stub or main-thread fallback. unref permits pooled idle workers.
 */
'use strict';
const { Worker } = require('worker_threads');
const path = require('path');
module.exports = class EncodingWorker {
  constructor() {
    this.worker = new Worker(`
      const { parentPort } = require('worker_threads');
      const fs = require('fs'), path = require('path'), vm = require('vm');
      const root = ${JSON.stringify(path.resolve(__dirname, '../assets/js'))};
      const box = vm.createContext({ WebAssembly, Response, Uint8Array, Float32Array, Int32Array, ArrayBuffer,
        fetch: async file => new Response(fs.readFileSync(path.resolve(root, file)), {headers: {'Content-Type': 'application/wasm'}}),
        postMessage: (data, transfers) => parentPort.postMessage(data, transfers) });
      box.self = box;
      box.importScripts = file => vm.runInContext(fs.readFileSync(path.resolve(root, file), 'utf8'), box);
      vm.runInContext(fs.readFileSync(path.join(root, 'encoding-worker.js'), 'utf8'), box);
      parentPort.on('message', data => box.onmessage({data}));
    `, { eval: true });
    this.worker.on('message', data => { if (this.onmessage) this.onmessage({ data }); this.worker.unref(); });
    this.worker.on('error', err => { if (this.onerror) this.onerror(err); });
    this.worker.unref();
  }
  postMessage(data, transfers) {
    if (this.onPCM && data.channels) this.onPCM(data.channels);
    this.worker.ref(); this.worker.postMessage(data, transfers);
  }
  terminate() { this.worker.terminate(); }
};
