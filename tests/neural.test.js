/* =============================================================================
 * Remaster Suite — neural path: fallbacks, bridge and latency (no network)
 * -----------------------------------------------------------------------------
 * Node suite for the hybrid path that the browser runs:
 *   · the model probe decides from local files only, never leaves the origin,
 *     and falls back to the DSP chain when nothing is present;
 *   · the model manifest is consistent (candidates, files, fallbacks);
 *   · the neural-bridge worklet, loaded from its real file with a stub of the
 *     AudioWorklet scope, moves audio through the rings to a worker and back
 *     with a delay of exactly its fill level, and the worker's pump keeps
 *     that delay when it runs in lock-step with the audio.
 * Run: node tests/neural.test.js
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, info) {
  if (cond) { passed++; console.log('  ✓ ' + label + (info ? '  → ' + info : '')); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label + (info ? '  → ' + info : '')); }
}
function section(name) { console.log('\n▸ ' + name); }

/* ---------------------------------------------------------------- probe -- */
section('models · without weights every stage falls back to the DSP chain');
{
  const requested = [];
  const realFetch = global.fetch;
  // every request is recorded and refused: the sandbox has no network
  global.fetch = (url, init) => {
    requested.push({ url: String(url), method: (init && init.method) || 'GET' });
    return Promise.reject(new Error('blocked in test'));
  };
  const Libs = require(path.join(ROOT, 'assets', 'js', 'library-loader.js'));
  Libs.setMode && Libs.setMode('local');
  Libs.probeModels({ timeoutMs: 200 }).then((p) => {
    ok(p.manifest === false, 'with no page origin the manifest cannot be read, and the probe says so', 'node has no origin');
    ok(p.stages.denoise.use === 'dsp' && p.stages.superRes.use === 'dsp',
      'the stages fall back to the DSP chain', p.stages.denoise.use + ' / ' + p.stages.superRes.use);
    ok(requested.every((r) => r.url.startsWith('assets/')),
      'every request stays on the origin (relative URLs only)', requested.map((r) => r.url).join(', ') || 'none');
    ok(['compact', 'full'].includes(p.tier.tier), 'the memory tier is decided', p.tier.tier + ' (' + p.tier.reason + ')');
    global.fetch = realFetch;
    return withManifest(Libs);
  });
}

/* the same probe with a manifest and one compact weight file present on disk */
function withManifest(Libs) {
  section('models · the probe picks the candidate whose files are present');
  const realFetch = global.fetch;
  const manifestText = fs.readFileSync(path.join(ROOT, 'assets', 'vendor', 'models', 'manifest.json'));
  const present = new Set(['assets/vendor/models/novasr-compact.onnx']);
  const requested = [];
  global.fetch = (url, init) => {
    const u = String(url);
    requested.push({ url: u, method: (init && init.method) || 'GET' });
    if (u.endsWith('manifest.json')) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(manifestText.buffer.slice(manifestText.byteOffset, manifestText.byteOffset + manifestText.byteLength)) });
    }
    const hit = present.has(u.replace(/^\//, ''));
    return Promise.resolve({ ok: hit, status: hit ? 200 : 404 });
  };
  return Libs.probeModels({ timeoutMs: 500 }).then((p) => {
    ok(p.manifest === true, 'the manifest is read from the page origin');
    ok(p.stages.denoise.use === 'dsp', 'no DeepFilterNet3 files → the denoiser falls back to DSP');
    ok(p.stages.superRes.use === 'novasr-compact', 'the compact super-resolution weights are picked when the full ones are absent',
      p.stages.superRes.use);
    ok(p.models['novasr-full.onnx'] === 'missing' && p.models['novasr-compact.onnx'] === 'local',
      'each file is reported as local or missing');
    ok(requested.every((r) => r.url.startsWith('assets/')), 'still nothing leaves the origin');
    global.fetch = realFetch;
    return runManifestAndBridge();
  });
}

/* ------------------------------------------------------------- manifest -- */
function runManifestAndBridge() {
  section('models · the manifest is consistent');
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'vendor', 'models', 'manifest.json'), 'utf8'));
  const stages = Object.keys(man.stages);
  ok(stages.includes('denoise') && stages.includes('superRes'), 'both neural stages are declared', stages.join(', '));
  const ids = [];
  let filesOk = true;
  for (const s of stages) {
    ok(man.stages[s].fallback === 'dsp', 'stage ' + s + ' falls back to the DSP chain');
    for (const c of man.stages[s].candidates) {
      ids.push(c.id);
      for (const f of c.files) if (!/^[a-z0-9-]+\.onnx$/.test(f)) filesOk = false;
    }
  }
  ok(new Set(ids).size === ids.length, 'candidate ids are unique', ids.join(', '));
  ok(filesOk, 'every weight file is a plain *.onnx name in the models folder');
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  ok(/!assets\/vendor\/models\/manifest\.json/.test(gi), 'the manifest is tracked; weights stay git-ignored');

  return runBridge();
}

/* -------------------------------------------------------------- bridge -- */
function runBridge() {
  section('bridge · audio through the rings returns exactly `fill` frames later');
  // the AudioWorklet scope, as the browser provides it
  let Registered = null;
  global.AudioWorkletProcessor = class {
    constructor() { this.port = { postMessage: (m) => { this.last = m; }, onmessage: null }; }
  };
  global.registerProcessor = (name, cls) => { Registered = cls; };
  global.RSRing = require(path.join(ROOT, 'assets', 'js', 'ring-buffer.js'));
  require(path.join(ROOT, 'assets', 'worklets', 'neural-bridge.js'));
  ok(typeof Registered === 'function', 'the bridge processor registers under its name');

  const Ring = global.RSRing;
  const FILL = 512, HOP = 512, Q = 128, FRAMES = 128 * 400;
  const inRing = Ring.create({ capacity: 8192, channels: 2, sampleRate: 48000 });
  const outRing = Ring.create({ capacity: 8192, channels: 2, sampleRate: 48000 });
  const bridge = new Registered();
  bridge.onMessage({ type: 'rings', inputSab: inRing.sab, outputSab: outRing.sab, fill: FILL });

  // the input: a unique value per frame, so any shift is visible
  const input = [new Float32Array(FRAMES), new Float32Array(FRAMES)];
  for (let i = 0; i < FRAMES; i++) { input[0][i] = Math.sin(i * 0.013) + 1e-4 * (i % 97); input[1][i] = input[0][i] * 0.5; }
  const output = [new Float32Array(FRAMES), new Float32Array(FRAMES)];

  // the ML worker, in its passthrough form: drain a hop, return it unchanged
  const workerTmp = [new Float32Array(HOP), new Float32Array(HOP)];
  const worker = (every) => {
    if (inRing.available() >= HOP && outRing.free() >= HOP) {
      inRing.read(workerTmp, HOP);
      outRing.write(workerTmp, HOP);
    }
  };

  const blocks = FRAMES / Q;
  for (let b = 0; b < blocks; b++) {
    const inp = [input[0].subarray(b * Q, (b + 1) * Q), input[1].subarray(b * Q, (b + 1) * Q)];
    const out = [output[0].subarray(b * Q, (b + 1) * Q), output[1].subarray(b * Q, (b + 1) * Q)];
    bridge.process([inp], [out], {});
    worker(1);
  }
  bridge.onMessage({ type: 'stats' });
  const stats = bridge.last;

  // find the delay in the steady part: output[t] === input[t - d]
  let delay = -1;
  for (let d = 0; d <= 2 * FILL && delay < 0; d++) {
    let match = true;
    for (let t = 4096; t < FRAMES && match; t += 37) {
      if (Math.abs(output[0][t] - input[0][t - d]) > 1e-6) match = false;
    }
    if (match) delay = d;
  }
  ok(delay === FILL, 'the wet path is the input delayed by exactly the fill level', 'delay ' + delay + ' frames (fill ' + FILL + ')');
  ok(stats.underruns === 0 && stats.overruns === 0, 'a worker in step with the audio never underruns or overruns',
    'underruns ' + stats.underruns + ' · overruns ' + stats.overruns);
  ok(stats.primed === true, 'the bridge primes and then plays');

  // a worker that runs late: the delay still does not move, the gap is counted
  section('bridge · a worker that lags is counted, not hidden as a latency change');
  const inRing2 = Ring.create({ capacity: 8192, channels: 2, sampleRate: 48000 });
  const outRing2 = Ring.create({ capacity: 8192, channels: 2, sampleRate: 48000 });
  const bridge2 = new Registered();
  bridge2.onMessage({ type: 'rings', inputSab: inRing2.sab, outputSab: outRing2.sab, fill: FILL });
  let tick = 0;
  for (let b = 0; b < blocks; b++) {
    const inp = [input[0].subarray(b * Q, (b + 1) * Q), input[1].subarray(b * Q, (b + 1) * Q)];
    const out = [output[0].subarray(b * Q, (b + 1) * Q), output[1].subarray(b * Q, (b + 1) * Q)];
    bridge2.process([inp], [out], {});
    tick++;
    if (tick % 7 !== 0 && inRing2.available() >= HOP && outRing2.free() >= HOP) {
      inRing2.read(workerTmp, HOP);
      outRing2.write(workerTmp, HOP);
    }
  }
  bridge2.onMessage({ type: 'stats' });
  ok(bridge2.last.underruns > 0, 'a lagging worker shows up as underruns', 'underruns ' + bridge2.last.underruns);

  // bypass and stop: the input goes straight through
  const bp = new Float32Array(Q).fill(0.25);
  const bo = new Float32Array(Q);
  bridge.onMessage({ type: 'stop' });
  bridge.process([[bp, bp]], [[bo, bo]], {});
  ok(bo[0] === 0.25, 'after stop the bridge passes its input through untouched');

  const pendingFallbacks = (async () => {
  /* ------------------------------------------------- runtime fallbacks -- */
  // A stage that cannot run (no onnxruntime, no weights) is a silent fall-back
  // to the DSP chain: nothing throws, the answer is "unavailable" with code
  // UNAVAILABLE, and the decoder is the browser's own AudioContext first.
  section('fallbacks · no runtime, no weights: silent DSP, never a throw');
  {
    const Libs = require(path.join(ROOT, 'assets', 'js', 'library-loader.js'));
    const Module = require('module');
    const realLoad = Module._load;
    const hideOrt = (on) => {
      Module._load = function (req, ...rest) {
        if (on && /onnxruntime-node/.test(req)) throw new Error("Cannot find module '" + req + "'");
        return realLoad.call(this, req, ...rest);
      };
    };
    // 1 · the runtime present (the dev install): it is bound, not fetched
    Libs.setMode('local');
    const rt = await Libs.onnxRuntime();
    ok(!!rt && !!rt.InferenceSession,
      'with onnxruntime-node installed, the runtime is bound without a network request');
    // 2 · the runtime missing: null, not an exception
    hideOrt(true);
    let threw = false, rt2 = 'unset';
    try { rt2 = await Libs.onnxRuntime(); } catch (e) { threw = true; }
    hideOrt(false);
    ok(!threw && rt2 === null, 'with onnxruntime-node missing, onnxRuntime() resolves to null (no throw)');
    // 3 · the weights missing: UNAVAILABLE, which the worker reports silently
    let code = null;
    try { await Libs.onnxModel('no-such-model'); } catch (e) { code = e.code; }
    ok(code === 'UNAVAILABLE' && Libs.isUnavailable({ code: 'UNAVAILABLE' }),
      'missing ONNX weights reject with code UNAVAILABLE (the silent fall-back)', String(code));
    ok(!Libs.isUnavailable(new Error('boom')), 'an unrelated error is not mistaken for "unavailable"');
    // the worker's source uses the same contract, not message text
    const wsrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'neural-worker.js'), 'utf8');
    ok(/Libs\.isUnavailable\(err\)[\s\S]{0,80}unavailable\(m\.id/.test(wsrc) && /type: 'unavailable'/.test(wsrc),
      'the worker answers "unavailable" (not "error") for a stage that cannot run');
  }

  section('decode · the primary live context is reused; a temporary one is closed');
  {
    const codecsPath = path.join(ROOT, 'assets', 'js', 'codecs.js');
    // codecs.js keeps the primary context and the offline cache for the page's
    // life: a fresh module per case, so each case starts from an empty page
    const freshCodecs = () => { delete require.cache[require.resolve(codecsPath)]; return require(codecsPath); };
    const savedA = global.AudioContext, savedO = global.OfflineAudioContext, savedW = global.webkitAudioContext;
    // a context fake that logs its life: created, decoded, closed
    const log = { created: [], decoded: [], closed: [] };
    const mk = (name, refuse) => class {
      constructor() { log.created.push(name); this.state = 'running'; this.sampleRate = 48000; }
      decodeAudioData(buf, onOk, onErr) {
        log.decoded.push(name);
        if (refuse) {
          const e = new Error('EncodingError: unable to decode');
          e.name = 'EncodingError';
          if (onErr) onErr(e);
          return Promise.reject(e);
        }
        const out = { sampleRate: 48000, length: 4, name: name };
        if (onOk) onOk(out);
        return Promise.resolve(out);
      }
      close() { log.closed.push(name); this.state = 'closed'; return Promise.resolve(); }
    };
    const reset = () => { log.created.length = 0; log.decoded.length = 0; log.closed.length = 0; };
    const ab = () => new ArrayBuffer(16);

    // 1 · a primary live context is registered (the engine's): it is reused,
    //     no second live context is created, and the path says so
    reset();
    global.AudioContext = mk('live'); global.OfflineAudioContext = mk('offline');
    let C = freshCodecs();
    C.useLiveContext(new (mk('primary'))());
    log.created.length = 0;
    const r1 = await C.decodeTracked(ab(), 48000).catch((e) => e);
    ok(r1 && r1.path === 'native-live' && r1.contextClosed === false, 'with a primary live context, the decode reuses it (native-live)',
      r1 && r1.path);
    ok(log.created.length === 0 && log.decoded.join() === 'primary' && log.closed.length === 0,
      'the primary is reused: no new AudioContext is created and the primary is not closed',
      'created ' + log.created.length + ' · decoded ' + log.decoded.join());

    // 2 · no primary: the OfflineAudioContext decodes — no live context at all,
    //     so no autoplay warning can be raised by the decode
    reset();
    C = freshCodecs();
    const r2 = await C.decodeTracked(ab(), 48000).catch((e) => e);
    ok(r2 && r2.path === 'native-offline' && r2.contextClosed === false,
      'with no primary, the offline context decodes (native-offline), no gesture needed', r2 && r2.path);
    ok(log.created.indexOf('live') < 0, 'no live AudioContext is created by a decode without a primary (no autoplay warning)',
      'created: ' + log.created.join(',') || 'none');

    // 3 · the decoder reuses its offline context for the same rate (no instance pile-up)
    reset();
    await C.decodeTracked(ab(), 48000).catch(() => {});
    ok(log.created.length === 0, 'a second decode at the same rate reuses the offline context', 'created ' + log.created.length);

    // 4 · the browser refuses the bytes: the error propagates, no second native decoder is tried
    reset();
    global.OfflineAudioContext = mk('offline', true);
    C = freshCodecs();
    C.useLiveContext(new (mk('primary', true))());
    let refused = null;
    try { await C.decodeTracked(ab(), 48000); } catch (e) { refused = e; }
    ok(refused && /EncodingError/.test(refused.message) && log.decoded.join() === 'primary',
      'bytes the browser refuses are not retried on another native decoder', log.decoded.join());

    // 5 · no primary, no offline decoder: a temporary live context decodes and is
    //     closed again with ctx.close(), so it never counts against the page limit
    reset();
    global.OfflineAudioContext = undefined; global.webkitOfflineAudioContext = undefined;
    global.AudioContext = mk('live');
    C = freshCodecs();
    const r5 = await C.decodeTracked(ab(), 48000).catch((e) => e);
    ok(r5 && r5.path === 'native-live' && r5.contextClosed === true, 'a temporary live context is used only as the last resort, and reported as closed',
      r5 && (r5.path + ' closed=' + r5.contextClosed));
    ok(log.created.length === 1 && log.closed.join() === 'live', 'the temporary context is created once and closed explicitly',
      'created ' + log.created.length + ' · closed ' + log.closed.join());

    // 6 · a primary that was closed by the page is not used: the decoder falls through
    reset();
    global.AudioContext = mk('live');
    global.OfflineAudioContext = mk('offline');
    C = freshCodecs();
    const dead = new (mk('primary'))(); dead.state = 'closed';
    C.useLiveContext(dead);
    const r6 = await C.decodeTracked(ab(), 48000).catch((e) => e);
    ok(r6 && r6.path === 'native-offline', 'a closed primary is skipped; the offline decoder takes the file', r6 && r6.path);

    // 7 · nothing to decode with: a clear "no context" error, not a hang
    reset();
    global.AudioContext = undefined; global.webkitAudioContext = undefined;
    global.OfflineAudioContext = undefined; global.webkitOfflineAudioContext = undefined;
    C = freshCodecs();
    let none = null;
    try { await C.decodeTracked(ab(), 48000); } catch (e) { none = e; }
    ok(none && none.noContext === true, 'with no native decoder at all, the decode rejects with noContext (FFmpeg rescue then applies)',
      none && none.message);

    // 8 · the decode result is marked with the path that produced it (decodeFile)
    global.AudioContext = mk('live'); global.OfflineAudioContext = mk('offline');
    global.webkitOfflineAudioContext = undefined;
    C = freshCodecs();
    const blob = { size: 16, name: 'x.wav', arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)), slice: () => ({}) };
    const d8 = await C.decodeFile(blob, { allowFFmpeg: false }).catch((e) => e);
    ok(d8 && d8.path === 'native-offline' && d8.rescued === false && d8.contextClosed === false,
      'decodeFile marks its result with the decoder path (native-offline)', d8 && (d8.path + ' rescued=' + d8.rescued));

    global.AudioContext = savedA; global.OfflineAudioContext = savedO; global.webkitAudioContext = savedW;
  }

  /* ------------------------------------------------ time budget (B1) ----- */
  section('budget · a load with no reachable source gives up within the budget');
  {
    const Libs = require(path.join(ROOT, 'assets', 'js', 'library-loader.js'));
    const realFetch = global.fetch;
    const realNav = Object.getOwnPropertyDescriptor(global, 'navigator');
    // every request hangs: the worst case for a dead network
    global.fetch = () => new Promise(() => {});
    Libs.setMode('local');
    ok(Libs.budget === 5000, 'the default load budget is 5 s', String(Libs.budget));
    Libs.setBudget(3000);
    ok(Libs.budget === 3000, 'the network budget is 3 s (the low end of the 3–5 s range)', String(Libs.budget));
    ok(Libs.setBudget(60000) === 5000 && Libs.setBudget(100) === 3000, 'the budget is clamped to 3–5 s');
    Libs.setBudget(3000);
    Libs.registerModel('budget-hang', { remote: 'https://cdn.example.test/budget-hang.onnx' });
    Libs.setOnline(true);                       // the CDN is only ever tried with the opt-in
    Libs.setMode('cdn');
    const t0 = Date.now();
    let code = null;
    try { await Libs.onnxModel('budget-hang'); } catch (e) { code = e.code; }
    const took = Date.now() - t0;
    ok(code === 'UNAVAILABLE' && took >= 2800 && took <= 3600,
      'a hung source gives up at the budget and reports UNAVAILABLE (the DSP path runs)', took + ' ms · ' + code);
    Libs.setMode('local');
    global.fetch = realFetch;

    // offline: the CDN is not tried at all, and the load is refused at once
    const requested = [];
    global.fetch = (url) => { requested.push(String(url)); return Promise.reject(new Error('offline')); };
    Object.defineProperty(global, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
    Libs.registerModel('budget-offline', { remote: 'https://cdn.example.test/budget-offline.onnx' });
    Libs.setOnline(true);                       // opted in, but the browser is offline: still no CDN
    Libs.setMode('cdn');
    const t1 = Date.now();
    let code2 = null;
    try { await Libs.onnxModel('budget-offline'); } catch (e) { code2 = e.code; }
    const took2 = Date.now() - t1;
    ok(code2 === 'UNAVAILABLE' && requested.length === 1 && requested.every((u) => !/^https?:/.test(u) && /budget-offline\.onnx$/.test(u)),
      'offline, no CDN is contacted: only the bundled copy is tried', requested.join(', ') || 'none');
    ok(took2 < 500, 'offline, the load is refused at once, not after a timeout', took2 + ' ms');
    Libs.setOnline(false);
    Libs.setMode('local');
    if (realNav) Object.defineProperty(global, 'navigator', realNav); else delete global.navigator;
    global.fetch = realFetch;
  }

  section('budget · a body that keeps arriving is loaded; one that stops is cut at the stall window');
  {
    const Libs = require(path.join(ROOT, 'assets', 'js', 'library-loader.js'));
    const realFetch = global.fetch;
    Libs.setMode('local');
    Libs.setBudget(3000);
    // a large model on a slow device: 8 chunks, 600 ms apart — 4.8 s in all, past
    // the 3 s budget, but never silent for longer than the window
    const chunk = new Uint8Array(4096);
    global.fetch = async () => new Response(new ReadableStream({
      async start(c) {
        for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 600)); c.enqueue(chunk); }
        c.close();
      },
    }), { status: 200 });
    Libs.registerModel('budget-trickle', { remote: 'https://cdn.example.test/budget-trickle.onnx' });
    const t0 = Date.now();
    let bytes = null;
    try { bytes = await Libs.onnxModel('budget-trickle'); } catch (e) { bytes = e; }
    const took0 = Date.now() - t0;
    ok(bytes && bytes.byteLength === 8 * 4096 && took0 > 3000,
      'a model that keeps arriving past the 3 s budget is loaded in full', took0 + ' ms · ' + (bytes && bytes.byteLength));

    // headers, then silence: the body is cut one stall window after its last byte
    global.fetch = async () => new Response(new ReadableStream({ start() {} }), { status: 200 });
    Libs.registerModel('budget-stall', { remote: 'https://cdn.example.test/budget-stall.onnx' });
    const t1 = Date.now();
    let code = null;
    try { await Libs.onnxModel('budget-stall'); } catch (e) { code = e.code; }
    const took1 = Date.now() - t1;
    ok(code === 'UNAVAILABLE' && took1 >= 2800 && took1 <= 3800,
      'a body that stops is cut one window after the last byte and reports UNAVAILABLE', took1 + ' ms · ' + code);
    global.fetch = realFetch;
    Libs.setBudget(4000);
  }

  section('budget · the page watchdog cuts a worker that stalls while acquiring, not one that is moving');
  {
    const Engine = require(path.join(ROOT, 'assets', 'js', 'engine.js'));
    global.RSRing = require(path.join(ROOT, 'assets', 'js', 'ring-buffer.js'));
    // a stub worker with a scripted reply to loadDfn3; records what it was sent
    const made = [];
    let steps = [];
    const runSteps = (w) => {
      for (const st of steps) setTimeout(() => { if (!w.terminated && w.onmessage) w.onmessage({ data: st.msg }); }, st.after);
    };
    const realWorker = global.Worker;
    global.Worker = class StubWorker {
      constructor() { this.terminated = false; this.onmessage = null; this.inits = []; made.push(this); }
      postMessage(m) {
        if (m.type === 'init') this.inits.push(m);
        if (m.type === 'loadDfn3') runSteps(this);
      }
      terminate() { this.terminated = true; }
    };

    // (a) the window is configurable and clamped to 3–5 s, and the worker is told it
    const eCfg = new Engine();
    const nA = await eCfg.initNeural({ hopSize: 512, channels: 2, sampleRate: 48000, denoise: false, budgetMs: 60000 });
    ok(nA.windowMs === 5000 && made[made.length - 1].inits[0].budgetMs === 5000,
      'the load window is clamped to the 5 s ceiling and handed to the worker', String(nA.windowMs));
    eCfg.disposeNeural();
    const eDef = new Engine();
    require(path.join(ROOT, 'assets', 'js', 'library-loader.js')).setBudget(5000);   // the loader's default, set explicitly
    const nD = await eDef.initNeural({ hopSize: 512, channels: 2, sampleRate: 48000, denoise: false });
    ok(nD.windowMs === 5000, 'the default load window is the loader default, 5 s', String(nD.windowMs));
    eDef.disposeNeural();

    // (b) silence after 'acquiring' is cut at the window: terminated, reported unavailable
    steps = [{ after: 0, msg: { type: 'acquiring', id: 'dfn3', name: 'dfn3', budgetMs: 3000 } }];
    const eStall = new Engine();
    const seenStall = [];
    const t0 = Date.now();
    let cutAt = 0;
    await eStall.initNeural({ hopSize: 512, channels: 2, sampleRate: 48000, denoise: true, budgetMs: 3000,
      onMessage: (d) => { seenStall.push(d); if (d.type === 'unavailable' && !cutAt) cutAt = Date.now() - t0; } });
    const w1 = made[made.length - 1];
    await new Promise((r) => setTimeout(r, 3800));
    const cut = seenStall.find((d) => d.type === 'unavailable');
    const tookStall = cutAt;
    ok(tookStall >= 2800 && tookStall <= 3600, 'the cut comes one window after the last progress (≈ 3 s)', tookStall + ' ms');
    ok(w1.terminated && cut && cut.name === 'dfn3' && eStall._neuralUnavailable === 'dfn3' && eStall._neural === null,
      'a worker silent in its acquisition is terminated and the stage reported unavailable',
      (cut ? cut.reason : 'no report') + ' · ' + tookStall + ' ms');

    // (c) progress keeps it alive past the window; the end of acquisition disarms it.
    // Session creation after 'acquired' is CPU work and is not cut, however long it takes.
    steps = [{ after: 0, msg: { type: 'acquiring', id: 'dfn3', name: 'dfn3', budgetMs: 3000 } }];
    for (let t = 500; t <= 3500; t += 500) steps.push({ after: t, msg: { type: 'progress', id: 'dfn3', name: 'dfn3', stage: 'bytes' } });
    steps.push({ after: 3600, msg: { type: 'acquired', id: 'dfn3', name: 'dfn3' } });
    const eMove = new Engine();
    const seenMove = [];
    // the script runs when loadDfn3 is posted, inside initNeural
    await eMove.initNeural({ hopSize: 512, channels: 2, sampleRate: 48000, denoise: true, budgetMs: 3000,
      onMessage: (d) => seenMove.push(d) });
    const w2 = made[made.length - 1];
    await new Promise((r) => setTimeout(r, 6800));
    ok(!w2.terminated && !seenMove.some((d) => d.type === 'unavailable') && eMove._neural !== null,
      'a load that keeps reporting progress past the window is not cut, and silence after acquired is not timed',
      'terminated ' + w2.terminated + ' · reports ' + seenMove.map((d) => d.type).join(','));
    eMove.disposeNeural();
    global.Worker = realWorker;
  }

  section('privacy · strict local mode: no third-party request without the opt-in');
  {
    const Libs = require(path.join(ROOT, 'assets', 'js', 'library-loader.js'));
    const keepRSLibs = global.RSLibs;
    const realFetch = global.fetch;
    const isRemote = (u) => /^https?:\/\//.test(u);
    const seen = [];
    // every local file is missing (404): the only thing a loader could still do is ask a CDN
    global.fetch = (url) => { seen.push(String(url)); return Promise.resolve({ ok: false, status: 404 }); };
    Libs.setOnline(false);
    Libs.setMode('cdn');                        // even the 'cdn' mode must not reach a CDN now
    Libs.registerModel('priv-model', { remote: 'https://cdn.example.test/priv-model.onnx' });
    const t0 = Date.now();
    let code = null;
    try { await Libs.onnxModel('priv-model'); } catch (e) { code = e.code; }
    const took = Date.now() - t0;
    ok(code === 'UNAVAILABLE' && seen.length === 1 && !seen.some(isRemote) && took < 500,
      'a missing local model is refused at once; no third-party host is contacted', took + ' ms · ' + seen.join(', '));

    const before = seen.length;
    const ff = await Libs.ffmpegFactory();
    ok(ff === null && !seen.slice(before).some(isRemote),
      'the FFmpeg rescue decoder is not fetched from a CDN without the opt-in', seen.slice(before).join(', ') || 'no request');
    ok(!isRemote(Libs.lameUrl ? String(await Libs.lameUrl()) : ''),
      'the MP3 encoder inside a worker resolves to the bundled copy without the opt-in');

    // with the opt-in, the same missing model does try the CDN (after the local copy)
    Libs.setOnline(true);
    seen.length = 0;
    Libs.registerModel('priv-model2', { remote: 'https://cdn.example.test/priv-model2.onnx' });
    let code2 = null;
    try { await Libs.onnxModel('priv-model2'); } catch (e) { code2 = e.code; }
    ok(code2 === 'UNAVAILABLE' && seen.some((u) => u === 'https://cdn.example.test/priv-model2.onnx'),
      'with the opt-in, the CDN source is tried after the local copy', seen.join(', '));
    Libs.setOnline(false);

    // the choice and the budget ceiling are stored, and a new page session reads them back
    const store = {};
    global.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    };
    Libs.setOnline(true);
    ok(store['rs.online'] === '1', 'the opt-in is stored under rs.online');
    Libs.setBudgetMax(999999);
    ok(Libs.budgetLimits().max === 60000 && store['rs.inferenceBudgetMaxMs'] === '60000',
      'the budget ceiling is clamped to 60 s and stored (for a high-end device)');
    Libs.setBudgetMax(20000);
    ok(Libs.setBudget(30000) === 20000, 'a budget above the ceiling is clamped to it', String(Libs.budget));
    Libs.setBudget(5000);
    delete require.cache[require.resolve(path.join(ROOT, 'assets', 'js', 'library-loader.js'))];
    const Fresh = require(path.join(ROOT, 'assets', 'js', 'library-loader.js'));
    ok(Fresh.online === true && Fresh.budgetLimits().max === 20000,
      'a new page session reads the stored opt-in and the stored ceiling', Fresh.online + ' · ' + Fresh.budgetLimits().max);
    Fresh.setOnline(false);
    Fresh.setBudgetMax(5000);
    ok(store['rs.inferenceBudgetMaxMs'] === undefined && store['rs.online'] === undefined,
      'turning the opt-in off and the ceiling back to 5 s removes the stored values');

    delete global.localStorage;
    global.fetch = realFetch;
    global.RSLibs = keepRSLibs;
    Libs.setOnline(false);
    Libs.setBudgetMax(5000);
    Libs.setBudget(5000);
  }

  /* -------- end to end: worker → engine → bridge, no ONNX runtime loaded -- */
  section('end to end · the real worker, engine and bridge fall back to DSP without the ONNX runtime');
  {
    const { Worker: ThreadWorker } = require('worker_threads');
    const realFetch = global.fetch;
    const savedWorker = global.Worker, savedLoc = global.location;
    // the network is refused everywhere (the sandbox has none); the ONNX runtime
    // is not installed in the worker, so a stage can only ever be "unavailable"
    global.fetch = (url) => Promise.reject(new Error('offline in test: ' + url));
    global.location = { href: 'http://localhost:8080/index.html' };
    global.RSRing = require(path.join(ROOT, 'assets', 'js', 'ring-buffer.js'));
    const Libs0 = require(path.join(ROOT, "assets", "js", "library-loader.js"));
    Libs0.setMode('local');
    Libs0.setBudget(4000);

    // the worker thread: the page's importScripts, served from assets/js only
    const bootstrap = `
      const { parentPort, workerData } = require('worker_threads');
      const fs = require('fs'), path = require('path'), vm = require('vm');
      globalThis.self = globalThis;
      globalThis.location = { href: workerData.base };
      globalThis.fetch = (url) => Promise.reject(new Error('offline in test: ' + url));
      globalThis.postMessage = (m) => parentPort.postMessage(m);
      globalThis.importScripts = (...urls) => {
        for (const u of urls) {
          const name = String(u).split('/').pop();
          const file = path.join(workerData.root, 'assets', 'js', name);
          if (!/^[a-z0-9.-]+\\.js$/.test(name) || !fs.existsSync(file)) throw new Error('offline in test: ' + u);
          vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
        }
      };
      parentPort.on('message', (d) => { if (typeof self.onmessage === 'function') self.onmessage({ data: d }); });
    `;
    // the browser's Worker, as a thread running the real neural-worker.js
    class PageWorker {
      constructor(url) {
        const src = fs.readFileSync(path.join(ROOT, url), 'utf8');
        this.t = new ThreadWorker(bootstrap + '\n' + src, { eval: true, workerData: { root: ROOT, base: global.location.href } });
        this.t.on('message', (m) => { if (this.onmessage) this.onmessage({ data: m }); });
        this.t.on('error', (e) => { if (this.onerror) this.onerror(e); });
      }
      postMessage(m) { this.t.postMessage(m); }
      terminate() { return this.t.terminate(); }
    }
    global.Worker = PageWorker;

    const Engine = require(path.join(ROOT, 'assets', 'js', 'engine.js'));
    const e = new Engine();
    const seen = [];
    const t0 = Date.now();
    const neural = await e.initNeural({
      hopSize: 512, channels: 2, sampleRate: 48000, denoise: true, passThrough: true,
      onMessage: (d) => { seen.push(d); e._onNeuralMessage(d); },
    });
    ok(!!neural, 'the engine opens the worker and the rings (no runtime needed to open them)');
    // wait for the worker's answer (or the budget + margin, whichever is first)
    const answer = await new Promise((resolve) => {
      const limit = Date.now() + 6000;
      const iv = setInterval(() => {
        if (seen.some((d) => d.type === 'unavailable' || d.type === 'error') || Date.now() > limit) {
          clearInterval(iv); resolve(seen.find((d) => d.type === 'unavailable' || d.type === 'error') || null);
        }
      }, 20);
    });
    const took = Date.now() - t0;
    ok(answer && answer.type === 'unavailable', 'the worker answers "unavailable" for the denoiser (not "error")',
      answer ? answer.type + ' · ' + answer.name : 'no answer');
    ok(took <= 5000, 'the answer comes within the 3–5 s budget (no minutes of waiting)', took + ' ms');
    ok(seen.every((d) => d.type !== 'error'), 'no worker error is raised by the fallback');
    ok(e._neuralUnavailable === 'dfn3', 'the engine records the stage as unavailable', String(e._neuralUnavailable));
    ok(!e._bridge, 'the neural bridge is not in the audio path (the wet path stays DSP)');
    ok(e._stageLatency.denoise === undefined, 'no latency is added for a stage that did not load', String(e._stageLatency.denoise));
    e.disposeNeural();
    ok(e._neural === null, 'disposing the side chain terminates the worker and drops its rings');

    global.Worker = savedWorker; global.location = savedLoc; global.fetch = realFetch;
  }

  })();
  pendingFallbacks.then(() => {
  console.log('\n' + '-'.repeat(60));
  console.log(failed ? failed + ' FAILED / ' + passed + ' passed' : 'ALL TESTS PASSED (' + passed + ')');
  if (failures.length) console.log('failed: ' + failures.join(', '));
  process.exit(failed ? 1 : 0);
  }, (err) => {
    // a rejected check must not end the run quietly with exit code 0
    console.error('fallback checks crashed: ' + (err && err.stack || err));
    process.exit(1);
  });
}
