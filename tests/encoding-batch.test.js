/* Real Chromium MP3/WAV batch and rAF pacing. No mocked encoder. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const beta = require('./beta/chromium.js');
const cdp = require('./beta/cdp.js');
const ROOT = path.resolve(__dirname, '..');
(async () => {
  const server = http.createServer((req, res) => {
    const file = path.resolve(ROOT, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { child, version } = beta.launch(9333);
  let browser, page;
  try {
    const info = await cdp.waitDevtools(9333, 15000);
    browser = await cdp.connect(info.webSocketDebuggerUrl);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    page = await cdp.pageForTarget(9333, targetId, 10000);
    await page.send('Runtime.enable');
    // Exercise the two-worker branch with a declared four-core scheduling hint.
    await page.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 4 });
    // Load only production DSP and codecs, avoiding unrelated model/network work.
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.send('Page.navigate', { url: origin + '/index.html' });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const result = await page.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const sr = 44100;
      const source = Float32Array.from({length: sr * 30}, (_, i) => 0.4 * Math.sin(2 * Math.PI * 440 * i / sr));
      let workersCreated = 0;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url, opts) {
          super(url, opts);
          if (String(url).includes('encoding-worker.js')) workersCreated++;
        }
      };
      const gaps = [], longTasks = [];
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
      observer.observe({ type: 'longtask', buffered: false });
      let running = true, previous;
      function frame(t) { if (previous !== undefined) gaps.push(t - previous); previous = t; if (running) requestAnimationFrame(frame); }
      requestAnimationFrame(frame);
      // Each file is 30 seconds stereo; jobs contend for the bounded pool.
      const original = source[100];
      const jobs = Array.from({length: 10}, async (_, i) => {
        const out = await RSCodecs.encodeMp3([source, source], sr, 192);
        if (!RSCodecs.looksLikeMp3(out.bytes) || out.bytes.length < 10000) throw Error('Invalid MP3 ' + i);
        const ctx = new OfflineAudioContext(2, 1, sr);
        const decoded = await ctx.decodeAudioData(out.bytes.slice().buffer);
        if (decoded.duration < 29.9 || decoded.numberOfChannels !== 2) throw Error('MP3 duration/channels ' + i);
        const pcm = decoded.getChannelData(0);
        let energy = 0;
        for (let j = sr; j < sr * 2; j++) energy += pcm[j] * pcm[j];
        if (Math.sqrt(energy / sr) < 0.2) throw Error('Silent MP3 ' + i);
        return out.bytes.length;
      });
      const sizes = await Promise.all(jobs);
      let wavBytes = 0;
      for (let i = 0; i < 10; i++) {
        await RSCodecs.encodeWavStream([source, source], sr, 16, {async write(bytes) { wavBytes += bytes.length; }});
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      running = false; observer.disconnect();
      if (source[100] !== original || !source.byteLength) throw Error('Source detached/mutated');
      const sorted = gaps.slice().sort((a,b) => a-b);
      return { sizes, wavBytes, workersCreated, hardwareConcurrencyHint: navigator.hardwareConcurrency, frames: gaps.length,
        meanFps: 1000 / (gaps.reduce((a,b) => a+b, 0) / gaps.length),
        p95FrameMs: sorted[Math.floor(sorted.length * .95)], maxFrameMs: Math.max(...gaps),
        over20ms: gaps.filter(x => x > 20).length, longTasks };
    })()` });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    const metrics = { browser: version, ...result.result.value };
    // Separate codec requalification, deliberately outside the isolated rAF
    // interval above. Run the actual engine/limiter, WASM encoder and browser
    // decoder; never infer decoded true peak merely from the input ceiling.
    const matrixResult = await page.send('Runtime.evaluate', { awaitPromise:true, returnByValue:true, expression:`(async()=>{
      const rows=[];
      for(const rate of [44100,48000]) for(const kbps of [128,192]) for(const kind of ['tone','music','noise']) {
        const x=new Float32Array(rate*2); let seed=31415;
        for(let i=0;i<x.length;i++) {
          const t=i/rate; seed=(Math.imul(seed,1664525)+1013904223)>>>0;
          x[i]=kind==='tone'?.98*Math.sin(2*Math.PI*997*t):kind==='music'?
            .6*Math.sin(2*Math.PI*440*t)+.3*Math.sin(2*Math.PI*997*t)+.15*Math.sin(2*Math.PI*2203*t):
            .95*(seed/2147483648-1);
        }
        const channels=kind==='tone'?[x]:[x,Float32Array.from(x,v=>-.9*v)];
        const ceiling=Math.min(-1.5,-1-RSPresets.codecMargin('mp3',kbps));
        const rendered=await RSEngine.render(channels,rate,{power:1,autoLevel:0,tpCeil:ceiling});
        const encoded=await RSCodecs.encodeMp3(rendered.channels,rate,kbps);
        const ctx=new OfflineAudioContext(channels.length,1,rate);
        const decoded=await ctx.decodeAudioData(encoded.bytes.slice().buffer);
        const pcm=Array.from({length:decoded.numberOfChannels},(_,c)=>decoded.getChannelData(c));
        const isp=RSDSP.ispStep(pcm); await RSDSP.runStepsAsync([isp.step]);
        rows.push({rate,kbps,kind,channels:channels.length,ceiling,decodedDbTP:isp.value()});
      }
      return rows;
    })()` });
    if(matrixResult.exceptionDetails) throw new Error(JSON.stringify(matrixResult.exceptionDetails));
    metrics.codecMatrix=matrixResult.result.value;
    console.log(JSON.stringify(metrics, null, 2));
    fs.writeFileSync(path.join(ROOT, 'docs/ENCODING-BATCH-RESULT.json'), JSON.stringify(metrics, null, 2) + '\n');
    const checks = [
      [metrics.sizes.length === 10 && metrics.sizes.every(n => n > 10000) && metrics.workersCreated === 2, 'ten audible MP3 files encode/decode using at most two workers'],
      [metrics.wavBytes === 10 * (44 + 44100 * 30 * 4), 'ten streamed WAV files have exact PCM sizes'],
      [metrics.frames > 60, 'animation callbacks continue during encoding; source stays intact'],
      [metrics.meanFps >= 59 && metrics.maxFrameMs <= 20, 'continuous ~60 FPS (no gap >20ms)'],
      [metrics.longTasks.length === 0, 'no encoding long tasks on UI thread'],
      [metrics.codecMatrix.length === 12 && metrics.codecMatrix.every(r=>Number.isFinite(r.decodedDbTP) && r.decodedDbTP<=0), 'decoded WASM MP3 true peak ≤0 dBTP at 128/192 kbps, 44.1/48k, mono/stereo'],
    ];
    for (const [ok, label] of checks) console.log((ok ? '  ✓ ' : '  ✗ ') + label);
    const failed = checks.filter(([ok]) => !ok).length;
    console.log(failed ? 'FAILED (' + failed + ' of 6)' : 'ALL TESTS PASSED (6)');
    if (failed) process.exitCode = 1;
  } finally {
    if (page) page.close(); if (browser) browser.close();
    child.kill('SIGKILL'); server.close(); beta.cleanProfile();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
