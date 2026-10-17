'use strict';
const assert = require('assert/strict'), fs = require('fs'), vm = require('vm'), path = require('path');
const H = require('./harness'), ROOT = H.ROOT, DSP = H.loadDsp();
global.RSDSP = DSP; global.RSPresets = require('../assets/js/presets');
const Analyzer = require('../assets/js/analyzer');
const input = [H.noise(16000, .2, .1, 41)];
const audio = { sampleRate:16000, numberOfChannels:1, length:input[0].length,
  duration:.2, getChannelData:c=>input[c] };
let passed=0,failed=0;
async function check(name,fn) { try {await fn();passed++;console.log('  ✓ '+name);} catch(e){failed++;console.error('  ✗ '+name+': '+e.message);} }
function sandbox(extra={}) {
  const pending=new Map(), order=[];
  const box=vm.createContext({setTimeout,clearTimeout,performance,URL,Float32Array,Float64Array,Uint8Array,ArrayBuffer,...extra});
  box.self=box;
  box.postMessage=data=>{if(data.progress!==undefined)return;order.push(data.id);const finish=pending.get(data.id);pending.delete(data.id);finish(data);};
  box.importScripts=(...files)=>{for(const file of files) vm.runInContext(fs.readFileSync(path.join(ROOT,'assets/js',file),'utf8'),box,{filename:file});};
  box.importScripts('analysis-worker.js');
  let sequence=0;
  return {box,order,request:mode=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);
    box.onmessage({data:{id,mode,channels:input,sr:16000,options:{buckets:32,previewSeconds:1}}});})};
}
(async()=>{
  const worker=sandbox();
  await check('off-thread after-measurement exactly matches the synchronous reference',async()=>{
    const actual=await worker.request('after');assert.equal(JSON.stringify(actual.result),JSON.stringify(Analyzer.analyzeChannels(input,16000)));
  });
  await check('off-thread envelope preserves every bucket',async()=>{
    const actual=await worker.request('envelope');assert.equal(JSON.stringify(actual.result),JSON.stringify(Analyzer.envelope(input,32)));
  });
  await check('off-thread full analysis exactly matches the yielding reference',async()=>{
    const actual=await worker.request('analyze');const expected=await Analyzer.analyzeAsync(audio,{buckets:32,previewSeconds:1});
    assert.equal(JSON.stringify(actual.result),JSON.stringify(expected));
  });
  await check('bad commands report an error without poisoning subsequent work',async()=>{
    assert((await worker.request('invalid')).error);assert((await worker.request('after')).result);
  });
  await check('simultaneous submitted requests complete in queue order',async()=>{
    const before=worker.order.length;const jobs=[worker.request('analyze'),worker.request('after'),worker.request('envelope')];
    const results=await Promise.all(jobs);assert.deepEqual(worker.order.slice(before),results.map(r=>r.id));
  });
  await check('CSP-blocked measurement workers fall back exactly and are not retried forever',async()=>{
    let constructions=0;
    class BlockedWorker { constructor(){constructions++;throw new Error('CSP');} addEventListener(){} }
    const box=vm.createContext({setTimeout,clearTimeout,performance,URL,Float32Array,Float64Array,Uint8Array,ArrayBuffer,
      document:{currentScript:{src:'https://example.invalid/assets/js/analyzer.js'}},Worker:BlockedWorker});
    for(const file of ['dsp-utils.js','presets.js','analyzer.js']) vm.runInContext(fs.readFileSync(path.join(ROOT,'assets/js',file),'utf8'),box);
    for(let i=0;i<2;i++) assert.equal(JSON.stringify(await box.RSAnalyzer.analyzeChannelsAsync(input,16000)),JSON.stringify(Analyzer.analyzeChannels(input,16000)));
    assert.equal(constructions,1);
  });
  console.log(failed?`FAILED (${failed})`:`ALL TESTS PASSED (${passed})`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
