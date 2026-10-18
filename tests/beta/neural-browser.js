/* Real Chromium E2E: manifest -> OPFS -> worker -> bundled ORT/WASM -> PCM. */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const beta = require('./chromium.js');
const cdp = require('./cdp.js');
const ROOT = path.join(__dirname, '..', '..');
const PORT = 8187, DBG = 9237;
const CANDIDATE = process.env.DFN3_CANDIDATE_DIR && path.resolve(process.env.DFN3_CANDIDATE_DIR);
let candidateManifest = null;
if (CANDIDATE) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'models/manifest.json')));
  manifest.models.deepfilternet3.variants.official.artifacts = ['enc.onnx', 'erb_dec.onnx', 'df_dec.onnx'].map((file) => {
    const bytes = fs.readFileSync(path.join(CANDIDATE, file));
    return { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  candidateManifest = Buffer.from(JSON.stringify(manifest));
}
let passed = 0, failed = 0;
function ok(v, name, detail) { if (v) { passed++; console.log('  ✓ ' + name + (detail ? '  → ' + detail : '')); } else { failed++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); } }
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css' };
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  if (candidateManifest && rel === 'models/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': candidateManifest.length,
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' });
    res.end(candidateManifest); return;
  }
  const candidateMatch = CANDIDATE && /^models\/deepfilternet3\/([^/]+\.onnx)$/.exec(rel);
  const file = candidateMatch ? path.join(CANDIDATE, candidateMatch[1]) : path.resolve(ROOT, rel);
  const allowed = candidateMatch ? file.startsWith(CANDIDATE + path.sep) : file.startsWith(ROOT + path.sep);
  if (!allowed || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size,
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
(async () => {
  let child, browser, page;
  try {
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    ({ child } = beta.launch(DBG));
    const info = await cdp.waitDevtools(DBG, 15000);
    browser = await cdp.connect(info.webSocketDebuggerUrl);
    const target = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/index.html` });
    page = await cdp.pageForTarget(DBG, target.targetId, 10000);
    await page.send('Runtime.enable');
    await new Promise((r) => setTimeout(r, 1000));
    const expression = `(async()=>{
      RSNeural.setModelSource(['models']);
      const manifest = await RSNeural.loadModelManifest();
      const installed = await RSNeural.ensureModel('deepfilternet3', { variant:'official' });
      const status = await RSNeural.modelStatus('deepfilternet3');
      const storage = await RSNeural.modelStorageStatus();
      const probe = await RSNeural.probe();
      const root=await navigator.storage.getDirectory(); const md=await root.getDirectoryHandle('models'); const dd=await md.getDirectoryHandle('deepfilternet3'); const files=[]; for await(const [name] of dd.entries()) files.push(name);
      const x = new Float32Array(12000);
      for(let i=0;i<x.length;i++) x[i]=.15*Math.sin(2*Math.PI*440*i/48000)+.01*Math.sin(2*Math.PI*7000*i/48000);
      const result = await RSNeural.denoise(x);
      let peak=0, finite=true; if(result.output) for(const v of result.output){ if(!Number.isFinite(v)) finite=false; peak=Math.max(peak,Math.abs(v)); }
      return {isolated:crossOriginIsolated, manifest, installed:{ready:installed.ready,variant:installed.variant,verified:installed.verified,artifacts:installed.artifacts&&installed.artifacts.length}, cached:status.cached,storage,probe,files,result:{applied:result.applied,reason:result.reason,pipeline:result.pipeline,provider:result.provider,length:result.output&&result.output.length,finite,peak}};
    })()`;
    const reply = await cdp.withDeadline(page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), 120000);
    const v = reply.result && reply.result.value;
    ok(v && v.isolated, 'browser is cross-origin isolated for threaded local WASM');
    ok(v && v.manifest.ready && v.installed.ready && v.installed.variant === 'official' && v.installed.verified && v.installed.artifacts === 3 && v.files.length === 3 && v.cached,
      'browser installs and reopens the verified three-graph group through OPFS', v && JSON.stringify({manifest:v.manifest,installed:v.installed,cached:v.cached,storage:v.storage,probe:v.probe,files:v.files}));
    ok(v && v.result.applied && v.result.pipeline === 'official' && v.result.length === 12000 && v.result.finite && v.result.peak <= 1.5,
      'real browser worker returns safe exact-length PCM', v && JSON.stringify({result:v.result, modelRequests:requests.filter(x=>x.includes('.onnx')||x.includes('neural-worker'))}));

    const songReply = await cdp.withDeadline(page.send('Runtime.evaluate', {
      expression: `(async()=>{const ab=await(await fetch(${JSON.stringify("01 I'm Gonna Put It On - The Wailing Wailers - Bob Marley & The Wailers.mp3")})).arrayBuffer();const ac=new AudioContext({sampleRate:48000});const b=await ac.decodeAudioData(ab);const start=0;const x=new Float32Array(144000);for(let i=0;i<x.length;i++){let s=0;for(let c=0;c<b.numberOfChannels;c++)s+=b.getChannelData(c)[start+i]/b.numberOfChannels;x[i]=s;}const stage=await RSNeural.denoiseChannels([x],{sampleRate:48000});const out=stage.channels&&stage.channels[0];let peak=0,delta=0,finite=true;if(out)for(let i=0;i<out.length;i++){const y=out[i];finite=finite&&Number.isFinite(y);peak=Math.max(peak,Math.abs(y));delta+=Math.abs(y-x[i]);}await ac.close();return {sampleRate:b.sampleRate,channels:b.numberOfChannels,duration:b.duration,applied:stage.applied,reason:stage.reason,length:out&&out.length,finite,peak,delta,chunks:stage.stats&&stage.stats.chunks}})()`,
      awaitPromise: true, returnByValue: true,
    }), 120000);
    const song = songReply.result && songReply.result.value;
    ok(song && song.sampleRate === 48000 && song.channels === 2 && song.duration > 180,
      'Chromium decodes the hash-pinned Wailing Wailers MP3 at its frozen contract', song && JSON.stringify(song));
    ok(song && song.applied && song.length === 144000 && song.finite && song.peak <= 1.5 && song.delta > 0.01,
      'the real song segment passes official neural inference and the output safety gate', song && JSON.stringify(song));

    const mobileProfiles = [
      { name: 'Android', width: 412, height: 915, scale: 2.625,
        ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/153.0 Mobile Safari/537.36' },
      { name: 'iPhone', width: 393, height: 852, scale: 3,
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' },
    ];
    await page.send('Network.enable');
    for (const profile of mobileProfiles) {
      await page.send('Network.setUserAgentOverride', { userAgent: profile.ua });
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: profile.width, height: profile.height, deviceScaleFactor: profile.scale, mobile: true,
      });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?mobile=${profile.name}` });
      await new Promise((r) => setTimeout(r, 1000));
      const mobileReply = await cdp.withDeadline(page.send('Runtime.evaluate', {
        expression: `(async()=>{const p=await RSNeural.probe();const x=new Float32Array(12000);for(let i=0;i<x.length;i++)x[i]=.1*Math.sin(2*Math.PI*330*i/48000);const r=await RSNeural.denoise(x);return {mobile:p.mobile,provider:p.models.deepfilternet3&&p.models.deepfilternet3.provider,applied:r.applied,reason:r.reason,length:r.output&&r.output.length,finite:!r.output||Array.from(r.output).every(Number.isFinite)}})()`,
        awaitPromise: true, returnByValue: true,
      }), 120000);
      const m = mobileReply.result && mobileReply.result.value;
      ok(m && m.mobile && m.applied && m.length === 12000 && m.finite,
        profile.name + ' mobile profile runs the complete official worker pipeline', m && JSON.stringify(m));
    }
  } catch (err) { failed++; console.error('  ✗ browser neural E2E → ' + (err.stack || err)); }
  finally { if (page) page.close(); if (browser) browser.close(); if (child) child.kill('SIGKILL'); server.close(); beta.cleanProfile(); }
  console.log(`\n${failed ? 'FAILED' : 'ALL TESTS PASSED'} (${passed} passed, ${failed} failed)`);
  if (failed) process.exitCode = 1;
})();
