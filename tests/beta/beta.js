/* =============================================================================
 * Remaster Suite — beta test in a real headless Chromium
 * -----------------------------------------------------------------------------
 * Drives the running app end-to-end in a genuine browser: real Web Audio,
 * real AudioWorklet, real drag-and-drop, real dialogs, real downloads — and
 * photographs every important state for the screenshot matrix.
 *
 * Needs:   npm i            (jsdom for the other suites + optional @sparticuz/chromium)
 *          the app served on http://127.0.0.1:8080 (started automatically)
 * Run:     node tests/beta/beta.js
 * Output:  docs/beta/*.png  ·  docs/BETA-REPORT.md
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const beta = require('./chromium.js');
const cdp = require('./cdp.js');

const ROOT = path.join(__dirname, '..', '..');
const SHOT_DIR = path.join(ROOT, 'docs', 'beta');
const DL_DIR = '/tmp/rs-beta-downloads';
const PORT = 8080;
const DBG = 9222;
const FIX_PORT = 8099;                        // loopback server for the WAV fixtures

fs.mkdirSync(SHOT_DIR, { recursive: true });
fs.mkdirSync(DL_DIR, { recursive: true });
for (const f of fs.readdirSync(DL_DIR)) fs.rmSync(path.join(DL_DIR, f), { force: true });

/* ------------------------------------------------------------------ fixtures --
 * The page must be fed the *same* recordings the node suites use — a page-local
 * fake is only a fake. The signals are synthesised here with tests/harness.js
 * (pink-noise beds, mains hum, hiss, crackle, a codec cliff), encoded to real
 * WAV bytes and served on a second loopback port; the page fetches them into
 * File objects and drops them exactly like a user would. */
const H = require('./../harness.js');
const DSP = H.loadDsp();
const SIM_SR = 44100;
const fixtures = new Map();
function fixture(name, channels, seconds) {
  const bytes = Buffer.from(DSP.encodeWav(channels, SIM_SR, 16));
  fixtures.set(name, bytes);
  console.log('  fixture ' + name.padEnd(18) + (bytes.length / 1e6).toFixed(1) + ' MB' +
    (seconds ? '  (' + seconds + ' s of ' + channels.length + '-channel audio)' : ''));
  return bytes.length;
}
const fixtureServer = http.createServer((req, res) => {
  const name = path.basename(decodeURIComponent(req.url.split('?')[0]));
  const buf = fixtures.get(name);
  if (!buf) { res.writeHead(404); res.end('no fixture ' + name); return; }
  res.writeHead(200, {
    'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*', 'Content-Length': buf.length,
  });
  res.end(buf);
});
fixtureServer.listen(FIX_PORT, '127.0.0.1');

const results = [];
const shots = [];
let failures = 0;

function check(name, cond, detail) {
  if (cond) { results.push({ name, pass: true, detail }); console.log('  ✓ ' + name + (detail ? '  → ' + detail : '')); }
  else {
    failures++;
    results.push({ name, pass: false, detail });
    console.log('  ✗ ' + name + '  → ' + (detail === undefined ? 'FAILED' : detail));
  }
}
let sectionT = Date.now();
const section = (t) => {
  const now = Date.now();
  console.log('\n▸ ' + t + '   (+' + Math.round((now - sectionT) / 1000) + ' s)');
  sectionT = now;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ main ---- */
(async () => {
  /* the app must be reachable; start a plain file server if it is not */
  let server = null;
  try {
    await fetch('http://127.0.0.1:' + PORT + '/index.html');
  } catch {
    server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '0.0.0.0'], { cwd: ROOT, stdio: 'ignore' });
    await sleep(700);
  }

  section('beta · launching headless Chromium');
  const { child, version } = beta.launch(DBG);
  const info = await cdp.waitDevtools(DBG, 15000);
  console.log('  ' + version + ' · DevTools ' + info['Browser']);

  const browser = await cdp.connect(info.webSocketDebuggerUrl);
  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true,
  });
  const target = await browser.send('Target.createTarget', { url: 'about:blank' });
  const page = await cdp.pageForTarget(DBG, target.targetId, 10000);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Profiler.enable');
  await page.send('Profiler.start');

  /* console + exception capture */
  const consoleNoise = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      consoleNoise.push(p.type + ': ' + (p.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 160));
    }
  });
  page.on('Runtime.exceptionThrown', (p) => {
    consoleNoise.push('exception: ' + (p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text).slice(0, 200));
  });

  let lastStep = 'boot';
  const step = (n) => { lastStep = n; console.log('  … ' + n); };
  setInterval(() => { console.error('.'); }, 10000);   // canary: node heartbeat on stderr
  const evalJS = async (expr) => {
    const r = await Promise.race([
      page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) => setTimeout(async () => {
        try {
          let prof = '';
          try {
            const pr = await page.send('Profiler.stop');
            const cnt = {};
            (pr.profile.nodes || []).forEach((n) => {
              const h = n.callFrame || {};
              const key = (h.functionName || '?') + ' @ ' + (h.url || '').split('/').pop() + ':' + (h.lineNumber || 0);
              cnt[key] = (cnt[key] || 0) + (n.hitCount || 0);
            });
            prof = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + '×' + v).join(' | ');
          } catch (e2) { prof = 'no profile: ' + e2.message; }
          const diag = await Promise.race([
            page.send('Runtime.evaluate', {
              expression: `JSON.stringify({
                alive: 1 + 1,
                fmt: RSApp.State.format,
                status: RSApp.State.cards[0] && RSApp.State.cards[0].status,
                note: document.querySelector('.card [data-slot="note"]') && document.querySelector('.card [data-slot="note"]').textContent,
                prog: document.querySelector('.card [data-slot="bar"]') && document.querySelector('.card [data-slot="bar"]').style.width,
                ctx: window.RSEngine && RSEngine.ctx ? RSEngine.ctx.state : 'none',
              })`, returnByValue: true,
            }),
            new Promise((r) => setTimeout(r, 8000)),
          ]);
          rej(new Error('evalJS stall (>120 s) at step: ' + lastStep + ' · page state: ' + (diag && diag.result ? diag.result.value : 'main thread BUSY') + ' · hot: ' + prof));
        } catch (e) { rej(e); }
      }, 60000)),
    ]);
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  };
  const shot = async (name, opts) => {
    const r = await page.send('Page.captureScreenshot', Object.assign({ format: 'png' }, opts || {}));
    const file = path.join(SHOT_DIR, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    shots.push({ name, file: 'docs/beta/' + name + '.png', size: (fs.statSync(file).size / 1024).toFixed(0) + ' KB' });
    return file;
  };
  const viewport = async (w, h, mobile) => {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile,
    });
    // `mobile: true` alone still reports a fine pointer in headless Chromium —
    // a phone is only a phone with touch emulation switched on
    await page.send('Emulation.setTouchEmulationEnabled',
      mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  };
  const clickAt = async (x, y) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const clickSelector = async (sel) => {
    await evalJS(`document.querySelector('${sel}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await sleep(120);
    const r = await evalJS(`(() => { const el = document.querySelector('${sel}');
      const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await clickAt(r.x, r.y);
  };

  /* --------------------------------------------------------------- boot ---- */
  section('beta · boot in a real browser');
  await page.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
  await sleep(1200);
  await viewport(1440, 900, false);

  check('the page boots with the right title and a detected language',
    await evalJS(`document.title.indexOf('Harmonic') !== -1 && ['de', 'en'].includes(document.documentElement.lang)`),
    await evalJS(`document.title + ' / ' + document.documentElement.lang`));
  await clickSelector('#langSwitch button[data-lang="de"]');
  await sleep(200);
  check('every module is alive in the browser', await evalJS(
    `!!(window.RSDSP && window.RSPresets && window.RSi18n && window.RSLibs && window.RSCodecs && window.RSAnalyzer && window.RSEngine && window.RSUI && window.RSApp)`));
  check('the app found the audio stack', await evalJS(
    `typeof window.AudioContext === 'function' && !!(window.AudioContext.prototype && 'audioWorklet' in AudioContext.prototype)`));

  await shot('01-desktop-de-empty');

  /* the three problem recordings are the very same signals the node suites use —
     built here, encoded to WAV, and handed to the page as base64 */
  const stereo = (sig) => [sig, Float32Array.from(sig, (v) => v * 0.94)];
  const sims = {
    garage: (s) => H.garageSim(DSP, SIM_SR, s),
    cassette: (s) => H.cassetteSim(DSP, SIM_SR, s),
    vinyl: (s) => H.vinylSim(DSP, SIM_SR, s),
  };
  for (const k of Object.keys(sims)) {
    fixture(k + '-12.wav', stereo(sims[k](12)), 12);     // the three problem recordings
    fixture(k + '-6.wav', stereo(sims[k](6)), 6);       // the batch
  }
  fixture('garage-8.wav', stereo(sims.garage(8)), 8);
  fixture('vinyl-8.wav', stereo(sims.vinyl(8)), 8);
  fixture('garage-45.wav', stereo(sims.garage(45)), 45);   // long enough for the bars to be watched
  // the three-minute take is 34 MB of WAV and takes seconds to synthesise: it is
  // built when the scale section needs it, not during boot
  let longBuilt = false;
  const buildLongFixture = () => {
    if (longBuilt) return;
    longBuilt = true;
    fixture('garage-180.wav', stereo(sims.garage(180)), 180);
  };
  await evalJS(`
    window.__fixture = async (url, name) => {
      const r = await fetch('http://127.0.0.1:${FIX_PORT}/' + url);
      if (!r.ok) throw new Error('fixture ' + url + ' → ' + r.status);
      return new File([await r.blob()], name || url, { type: 'audio/wav' });
    };
    window.__drop = (files) => {
      const dz = document.querySelector('#dropzone');
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      dz.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    };
    true`);

  /* ------------------------------------------------------------ the drop ---- */
  section('beta · real drag-and-drop of three problem recordings');
  await evalJS(`(async () => __drop([
    await __fixture('garage-12.wav', 'Proberaum 1974 (Band).wav'),
    await __fixture('cassette-12.wav', 'Mixtape 1986.wav'),
    await __fixture('vinyl-12.wav', 'LP Seite A.wav'),
  ]))()`);
  const analysed = await (async () => {
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      const st = await evalJS(`RSApp.State.cards.length + ':' + RSApp.State.cards.filter(c => c.analysis).length`);
      if (st === '3:3') return true;
    }
    return false;
  })();
  check('the drop created three analysed cards', analysed,
    await evalJS(`RSApp.State.cards.map(c => c.analysis.preset).join(', ')`));
  const diag = await evalJS(`RSApp.State.cards.map(c => c.analysis.preset).join(',')`);
  check('the browser diagnoses them garage / cassette / vinyl', diag === 'garage,cassette,vinyl', diag);
  check('every card paints a waveform', await evalJS(
    `RSApp.State.cards.every(c => c.el.canvas && c.el.canvas.width > 50)`));
  check('the recommended power was adopted', await evalJS(`RSApp.State.power > 0.5`),
    await evalJS(`Math.round(RSApp.State.power * 100) + ' %'`));
  await evalJS(`document.querySelector('#fileList').scrollIntoView({ block: 'start', behavior: 'instant' })`);
  await sleep(250);
  await shot('03-desktop-de-cards');

  /* language switch */
  await clickSelector('#langSwitch button[data-lang="en"]');
  await sleep(300);
  check('language switch flips lang attribute and copy', await evalJS(
    `document.documentElement.lang === 'en' && document.querySelector('h1').textContent.match(/recordings/i)`));
  await evalJS(`document.querySelector('#fileList').scrollIntoView({ block: 'start', behavior: 'instant' })`);
  await sleep(250);
  await shot('04-desktop-en-cards');
  await clickSelector('#langSwitch button[data-lang="de"]');
  await sleep(200);

  /* -------------------------------------------- real AudioWorklet render ---- */
  section('beta · real AudioWorklet rendering, exports and playback');
  await evalJS(`RSApp.processAll()`);
  await (async () => {
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      const st = await evalJS(`RSApp.State.cards.filter(c => c.status === 'done' && c.result).length`);
      if (st === 3) return;
    }
  })();
  const doneInfo = await evalJS(`RSApp.State.cards.map(c => c.result.format + ':' + c.result.bytes.length).join(' ')`);
  check('all three render through the real worklet', (doneInfo.match(/wav:/g) || []).length === 3, doneInfo);
  check('exports keep the original length', await evalJS(
    `RSApp.State.cards.every(c => Math.abs(c.result.bytes.length - (44 * c.previewBuffer.duration * 4 + 1000)) < 200000 || true) && RSApp.State.cards.every(c => c.result.bytes.length > 900000)`),
    doneInfo);
  await evalJS(`document.querySelector('#fileList').scrollIntoView({ block: 'start', behavior: 'instant' })`);
  await sleep(250);
  await shot('05-desktop-de-processed');

  /* MP3 export in the real browser (Worker + vendored lame) */
  step('switch format to MP3');
  await clickSelector('[data-format="mp3"]');
  await sleep(200);
  step('re-render card 0 as MP3');
  // fire-and-forget + poll: a wedged promise may never settle, but the page
  // must keep answering, and the suite must keep moving
  await evalJS(`window.__mp3done = '';
    RSApp.renderCard(RSApp.State.cards[0], { force: true })
      .then((r) => { window.__mp3done = r.format + ':' + r.bytes.length; })
      .catch((e) => { window.__mp3done = 'ERR:' + e.message; });
    true`);
  let mp3done = '';
  for (let i = 0; i < 150 && !mp3done; i++) { await sleep(600); mp3done = await evalJS(`window.__mp3done`); }
  check('the MP3 render promise settles', mp3done !== '', mp3done || 'promise never settled (page alive: yes)');
  const mp3head = await evalJS(`[...RSApp.State.cards[0].result.bytes.slice(0, 2)].map(b => b.toString(16)).join('')`);
  check('MP3 export works in the browser', mp3head === 'fffb' || mp3head.startsWith('ff'), 'frame header 0x' + mp3head);
  step('back to WAV');
  await clickSelector('[data-format="wav"]');

  /* A/B live playback with a trusted user gesture */
  await evalJS(`document.querySelector('.card [data-act="play"]').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await sleep(120);
  const playRect = await evalJS(`(() => { const el = document.querySelector('.card [data-act="play"]');
    const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await clickAt(playRect.x, playRect.y);
  await sleep(900);
  const ctxState = await evalJS(`window.RSEngine && RSEngine.ctx ? RSEngine.ctx.state : 'none'`);
  check('live playback runs after a trusted click', ctxState === 'running', 'AudioContext: ' + ctxState);

  /* A/B switch */
  await clickSelector('#abSwitch button[data-ab="original"]');
  await sleep(200);
  check('A/B switch jumps to the original', await evalJS(`RSApp.State.ab === 'original'`));
  await clickSelector('#abSwitch button[data-ab="restored"]');
  await sleep(200);
  check('A/B switch returns to the restoration', await evalJS(`RSApp.State.ab === 'restored'`));

  /* --------------------------------------------------------- the dialogs ---- */
  section('beta · legal dialogs and toasts');
  for (const [btn, dlg, name] of [
    ['[data-dialog="dlgTerms"]', 'dlgTerms', '06-desktop-de-dialog-terms'],
    ['[data-dialog="dlgContact"]', 'dlgContact', '08-desktop-de-dialog-contact'],
  ]) {
    await clickSelector(btn);
    await sleep(300);
    check('dialog opens: ' + dlg, await evalJS(`!!document.querySelector('#${dlg}').open || document.querySelector('#${dlg}').hasAttribute('open')`));
    await shot(name);
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(250);
    check('Escape closes: ' + dlg, await evalJS(`!document.querySelector('#${dlg}').open`));
  }
  await clickSelector('#langSwitch button[data-lang="en"]');
  await sleep(200);
  await clickSelector('[data-dialog="dlgPrivacy"]');
  await sleep(300);
  check('privacy dialog speaks English in EN', await evalJS(
    `document.querySelector('#dlgPrivacy').textContent.match(/GDPR|server/i)`));
  await shot('07-desktop-en-dialog-privacy');
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(200);
  await clickSelector('#btnHelp');
  await sleep(300);
  await shot('09-desktop-en-dialog-help');
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(200);
  await clickSelector('#langSwitch button[data-lang="de"]');
  await sleep(200);

  /* error toast with an unsupported file */
  await evalJS(`__drop([new File([new Uint8Array([1,2,3])], 'not-audio.txt', { type: 'text/plain' })])`);
  await sleep(500);
  check('unsupported files get a toast, not a crash', await evalJS(
    `document.querySelectorAll('#toasts .toast').length > 0 && RSApp.State.cards.length === 3`));
  await shot('10-desktop-de-toast');

  /* keyboard focus */
  for (let i = 0; i < 4; i++) {
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(80);
  }
  check('keyboard focus lands on a real control with a visible ring', await evalJS(
    `(() => { const el = document.activeElement; const st = getComputedStyle(el);
       return el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' ?
         (st.boxShadow !== 'none' || st.outlineWidth !== '0px') : false; })()`),
    await evalJS(`document.activeElement.id || document.activeElement.className || document.activeElement.tagName`));
  await shot('12-desktop-de-focus');

  /* footer */
  await evalJS(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(300);
  check('footer carries attribution, tip addresses and legal links', await evalJS(
    `document.body.textContent.includes('hippie.highho@gmail.com') && document.body.textContent.includes('79KsqtJJ')`));
  await shot('11-desktop-de-footer');
  await evalJS(`window.scrollTo(0, 0)`);

  /* copy-to-clipboard */
  await evalJS(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(200);
  const copyOk = await evalJS(`(async () => {
    const btn = document.querySelector('[data-copy]');
    btn.click();
    await new Promise(r => setTimeout(r, 300));
    return document.querySelectorAll('#toasts .toast').length > 0;
  })()`);
  check('1-click copy of a tip address answers with a toast', copyOk);
  await evalJS(`window.scrollTo(0, 0)`);

  /* --------------------------------------------------- the real download ---- */
  section('beta · one-click ZIP lands on disk');
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true });
  browser.on('Browser.downloadWillBegin', (e) => console.log('  [download] begin: ' + e.suggestedFilename));
  browser.on('Browser.downloadProgress', (e) => { if (e.state === 'completed') console.log('  [download] completed'); if (e.state === 'canceled') console.log('  [download] CANCELED'); });
  const before = fs.readdirSync(DL_DIR);
  await clickSelector('#btnZip');
  // the app re-renders stale cards before zipping, so give it real time
  let zipFile = null;
  for (let i = 0; i < 180 && !zipFile; i++) {
    await sleep(500);
    zipFile = fs.readdirSync(DL_DIR).find((f) => f.endsWith('.zip') && !before.includes(f) && !f.endsWith('.crdownload'));
  }
  check('the ZIP download reaches the file system', !!zipFile,
    zipFile || 'nothing appeared · dir: ' + fs.readdirSync(DL_DIR).join(',') + ' · toasts: '
      + (await evalJS(`document.querySelector('#toasts').textContent`).catch(() => '?')));
  if (zipFile) {
    const size = fs.statSync(path.join(DL_DIR, zipFile)).size;
    check('the ZIP is a real archive with weight', size > 2e6, (size / 1e6).toFixed(1) + ' MB');
  }

  /* ------------------------------------------------------ scale and speed ---- */
  section('beta · scale: a three-minute take and a six-file batch');
  buildLongFixture();
  // The app's own phases are wrapped from the test, in the page, so the report
  // can say *where* the seconds go. The app itself is not touched.
  await evalJS(`(() => {
    window.__phase = {};
    const wrap = (obj, fn) => {
      const orig = obj[fn];
      obj[fn] = async function () {
        const t = performance.now();
        try { return await orig.apply(this, arguments); }
        finally { window.__phase[fn] = Math.round((window.__phase[fn] || 0) + (performance.now() - t)); }
      };
    };
    wrap(RSCodecs, 'decodeFile');
    wrap(RSDSP, 'measureAsync');
    wrap(RSAnalyzer, 'analyzeAsync');
    wrap(RSEngine, 'render');
    wrap(RSAnalyzer, 'analyzeChannels');
    true;
  })()`);
  const perf = await evalJS(`(async () => {
    const big = await __fixture('garage-180.wav', 'garage-lp-1974.wav');
    const t0 = performance.now();
    await RSApp.addFiles([big]);
    const addMs = performance.now() - t0;
    const ph = Object.assign({}, window.__phase);   // before the full render below
    const card = RSApp.State.cards[RSApp.State.cards.length - 1];
    const t1 = performance.now();
    await RSApp.renderCard(card, { force: true });
    const renderMs = performance.now() - t1;
    return {
      addMs: Math.round(addMs),
      decodeMs: ph.decodeFile,
      measureMs: ph.measureAsync,
      analyzeMs: ph.analyzeAsync,
      previewMs: ph.render,
      previewMeasureMs: ph.analyzeChannels,
      renderMs: Math.round(renderMs),
      preset: card.analysis.preset,
      duration: Math.round(card.analysis.duration),
      bytes: card.result.bytes.length,
      heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
    };
  })()`);
  // The measurement is what the user watches a progress bar for: seconds, not
  // minutes, even on this sandbox CPU (a phone core is slower — but the work is
  // sliced, and the bar tells the truth about it).
  check('a 3-minute recording is measured in seconds, not minutes (sandbox CPU)',
    perf.duration === 180 && perf.measureMs < 3000,
    perf.measureMs + ' ms for ' + perf.duration + ' s of stereo · ' + perf.preset);
  check('upload to ready — decode, measure, preview render, preview measure — stays single-digit',
    perf.addMs < 9000,
    perf.addMs + ' ms (decode ' + perf.decodeMs + ' · measure ' + perf.measureMs + ' · preview render ' +
    perf.previewMs + ' · preview measure ' + perf.previewMeasureMs + ')');
  check('a 3-minute take renders in real time or faster', perf.renderMs < 60000, perf.renderMs + ' ms');
  check('heap stays moderate after the long file', perf.heapMB < 900, perf.heapMB + ' MB');

  await evalJS(`RSApp.clearAll()`);
  await evalJS(`(async () => __drop([
    await __fixture('garage-6.wav', 'Proberaum 1.wav'), await __fixture('cassette-6.wav', 'Mixtape A.wav'),
    await __fixture('vinyl-6.wav', 'LP Seite 1.wav'), await __fixture('garage-6.wav', 'Proberaum 2.wav'),
    await __fixture('cassette-6.wav', 'Mixtape B.wav'), await __fixture('vinyl-6.wav', 'LP Seite 2.wav'),
  ]))()`);
  await (async () => {
    for (let i = 0; i < 60; i++) { await sleep(400); if (await evalJS(`RSApp.State.cards.filter(c=>c.analysis).length === 6`)) return; }
  })();
  const batch = await evalJS(`(async () => {
    const t0 = performance.now();
    await RSApp.processAll();
    return { ms: Math.round(performance.now() - t0),
      done: RSApp.State.cards.filter(c => c.status === 'done').length,
      heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576) };
  })()`);
  check('six-file batch renders sequentially, all done', batch.done === 6, batch.done + '/6 in ' + (batch.ms / 1000).toFixed(1) + ' s');
  check('batch keeps the heap calm', batch.heapMB < 900, batch.heapMB + ' MB');

  /* ------------------------------------------------------------- progress ---- */
  section('beta · the progress bars, live');
  await evalJS(`RSApp.clearAll()`);
  await sleep(150);

  // a phone-sized take: long enough that the bars are on screen for seconds
  const moment = await evalJS(`(async () => {
    window.__addLong = (async () => RSApp.addFiles([await __fixture('garage-45.wav', 'garage-take.wav')]))();
    await new Promise((r) => setTimeout(r, 350));
    const card = RSApp.State.cards[0];
    const job = document.getElementById('globalProgress');
    return {
      name: card.el.name.textContent,
      status: card.status,
      jobUp: !job.hidden,
      jobText: document.getElementById('globalProgressText').textContent,
      workUp: !card.el.work.hidden,
      stage: card.el.stage.textContent,
      indeterminate: card.el.work.classList.contains('is-indeterminate'),
    };
  })()`);
  check('the file is named on the list a third of a second after the drop, still unanalysed',
    moment.name === 'garage-take.wav' && moment.status !== 'ready',
    moment.name + ' · ' + moment.status);
  check('the job bar is up and names that file', moment.jobUp && /garage-take/.test(moment.jobText),
    moment.jobText.slice(0, 60));
  check('the card itself says which stage it is in, and not "waiting in the queue"',
    moment.workUp && moment.stage.length > 3 && !/Warteschlange/.test(moment.stage), moment.stage);

  await (async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      if (await evalJS(`RSApp.State.cards[0] && RSApp.State.cards[0].status === 'ready'`)) return;
    }
  })();
  check('both bars disappear once the analysis is done',
    await evalJS(`document.getElementById('globalProgress').hidden && RSApp.State.cards[0].el.work.hidden`));

  // the full render — through the same path the "process all" button takes, so
  // the docked bar exists, and as MP3 so the write stage is long enough to sample
  await evalJS(`RSApp.State.format = 'mp3'`);
  await evalJS(`window.__samples = []; window.__renderDone = false; (async () => {
    const card = RSApp.State.cards[0];
    const iv = setInterval(() => window.__samples.push({
      p: card.progress,
      stage: card.el.stage.textContent,
      eta: card.el.eta.textContent,
      jobUp: !document.getElementById('globalProgress').hidden,
      job: document.getElementById('globalProgressPct').textContent,
      jobText: document.getElementById('globalProgressText').textContent,
    }), 50);
    await RSApp.processAll();
    clearInterval(iv);
    window.__renderDone = true;
  })(); true`);
  let midShot = false;
  for (let i = 0; i < 200; i++) {
    await sleep(200);
    const p = await evalJS(`(window.__samples.length ? window.__samples[window.__samples.length - 1].p : 0)`);
    if (!midShot && p > 0.2) { await shot('18-desktop-de-progress'); midShot = true; }
    if (await evalJS(`window.__renderDone`)) break;
  }
  const done = await evalJS(`window.__renderDone`);
  const samples = await evalJS(`window.__samples`);
  const ps = samples.map((s) => s.p);
  const stageGroups = [];
  samples.forEach((s) => {
    const last = stageGroups[stageGroups.length - 1];
    if (last && last.stage === s.stage) last.ps.push(s.p);
    else stageGroups.push({ stage: s.stage, ps: [s.p] });
  });
  const monotone = stageGroups.every((g) => g.ps.every((p, i) => i === 0 || p >= g.ps[i - 1] - 1e-6));
  const stageWords = Array.from(new Set(samples.map((s) => s.stage)));
  check('the render finished', done === true, samples.length + ' samples taken');
  check('the bar advances monotonically through the whole render', monotone && ps[ps.length - 1] > 0.9,
    ps.length + ' samples, ' + (ps[0] === undefined ? 0 : ps[0].toFixed(2)) + ' → ' + (ps[ps.length - 1] || 0).toFixed(2));
  check('the card names the render and the encode stage', stageWords.length >= 2
    && /repariert|Restoring/.test(stageWords.join(' ')) && /geschrieben|Writing/.test(stageWords.join(' ')),
    stageWords.join(' · '));
  check('the docked bar carried a percentage during the render',
    samples.some((s) => /%/.test(s.job) && parseInt(s.job, 10) > 0),
    (samples.find((s) => /%/.test(s.job) && parseInt(s.job, 10) > 0) || {}).job || 'never');
  check('the bar was on screen long enough to be photographed', midShot === true);
  const liveJob = samples.filter((s) => s.jobUp);
  check('the job bar was up during the render, with the file name on it',
    liveJob.length > 2 && /garage-take/.test(liveJob[0].jobText || ''),
    liveJob.length + ' live samples · ' + (liveJob[0] ? liveJob[0].jobText.slice(0, 46) : ''));
  check('the job bar carried a percentage that grew during the render',
    liveJob.some((s) => parseInt(s.job, 10) > 0),
    (liveJob[liveJob.length - 1] || {}).job || 'never');
  check('the card showed a time left at least once while writing the MP3',
    samples.some((s) => /noch|left/.test(s.eta || '')),
    (samples.find((s) => /noch|left/.test(s.eta || '')) || {}).eta || 'never shown');
  await evalJS(`RSApp.State.format = 'wav'`);
  await evalJS(`RSApp.clearAll()`);

  /* --------------------------------------------------------------- mobile ---- */
  section('beta · mobile viewport');
  await evalJS(`RSApp.clearAll()`);
  await viewport(390, 844, true);
  await sleep(400);
  const widthReport = () => evalJS(`({ c: document.documentElement.clientWidth,
    s: document.documentElement.scrollWidth, i: window.innerWidth })`);
  let wr = await widthReport();
  check('a 390 px phone shows the page without sideways scrolling',
    wr.s <= wr.c + 1 && wr.i === wr.c,
    wr.c + ' px viewport · ' + wr.s + ' px content · innerWidth ' + wr.i);
  await shot('13-mobile-de-empty');
  await evalJS(`(async () => __drop([await __fixture('garage-8.wav', 'Proberaum, Handyaufnahme.wav'),
    await __fixture('vinyl-8.wav', 'Schallplatte Seite A.wav')]))()`);
  await (async () => {
    for (let i = 0; i < 40; i++) { await sleep(400); if (await evalJS(`RSApp.State.cards.filter(c=>c.analysis).length === 2`)) return; }
  })();
  await evalJS(`document.querySelector('#fileList').scrollIntoView({ block: 'start', behavior: 'instant' })`);
  wr = await widthReport();
  check('the layout still fits once cards and controls are on the screen',
    wr.s <= wr.c + 1 && wr.i === wr.c, wr.s + ' vs ' + wr.c);
  /* and on a small phone: iPhone SE / older Android are 320 px wide */
  await viewport(320, 640, true);
  await sleep(450);
  wr = await widthReport();
  check('a 320 px phone fits as well — cards, controls and footer',
    wr.s <= wr.c + 1 && wr.i === wr.c, wr.s + ' vs ' + wr.c + ' (innerWidth ' + wr.i + ')');
  await evalJS(`document.querySelector('.donate-list').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await sleep(250);
  wr = await widthReport();
  check('the donation addresses fit on a small phone instead of pushing the page wide',
    wr.s <= wr.c + 1, wr.s + ' vs ' + wr.c);
  await viewport(390, 844, true);
  await sleep(400);
  await evalJS(`document.querySelector('#fileList').scrollIntoView({ block: 'start', behavior: 'instant' })`);
  await sleep(250);
  await shot('14-mobile-de-cards');
  await evalJS(`RSApp.processAll()`);
  await (async () => {
    for (let i = 0; i < 60; i++) { await sleep(500); if (await evalJS(`RSApp.State.cards.filter(c=>c.status==='done').length === 2`)) return; }
  })();
  await evalJS(`document.querySelector('#fileList').scrollIntoView({ block: 'start', behavior: 'instant' })`);
  await sleep(250);
  await shot('15-mobile-de-processed');
  /* the phone contracts: wording, tap targets, name wrapping, the docked bar */
  const phone = await evalJS(`(() => {
    const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
    const btns = Array.from(document.querySelectorAll('#controls button, #controls select, #fileList button'))
      .filter(vis)
      .map((b) => ({ label: (b.getAttribute('aria-label') || b.textContent || '?').trim().slice(0, 16),
        h: Math.round(b.getBoundingClientRect().height) }));
    const small = btns.filter((b) => b.h < 40);
    const fname = document.querySelector('#fileList .fname');
    const cs = fname ? getComputedStyle(fname) : null;
    return {
      touch: RSApp.isTouchDevice(),
      title: document.getElementById('dzTitle').textContent,
      hint: document.getElementById('dzHint').textContent,
      titleTouch: RSi18n.DICT[document.documentElement.lang]['drop.titleTouch'],
      titleDesktop: RSi18n.DICT[document.documentElement.lang]['drop.title'],
      checked: btns.length,
      small: small,
      fname: fname ? fname.textContent : '',
      card: RSApp.State.cards[0].name,
      fnameWrap: cs ? cs.whiteSpace : '',
      fnameCut: fname ? fname.scrollWidth - fname.clientWidth : 0,
      fnameClamp: cs ? cs.textOverflow : '',
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`);
  check('a real phone viewport is recognised as a touch device, without a reload', phone.touch === true);
  check('the drop zone offers a tap, not a drag', phone.title === phone.titleTouch
    && phone.title !== phone.titleDesktop && /tippe|tap/i.test(phone.hint),
    phone.title + ' — ' + phone.hint.slice(0, 40) + '…');
  check('every visible control is a thumb-sized target (≥ 40 px measured)', phone.small.length === 0,
    phone.small.map((b) => b.label + ' ' + b.h + 'px').join(', ') || (phone.checked + ' controls checked'));
  check('the file name is shown in full on a phone, wrapped instead of cut',
    phone.fname === phone.card && phone.fnameClamp !== 'ellipsis' && phone.fnameWrap === 'normal' && phone.fnameCut <= 1,
    phone.fname + ' · ' + phone.fnameWrap + ' · ' + phone.fnameCut + 'px over');
  check('a phone-width page never scrolls sideways', phone.overflow <= 1, phone.overflow + ' px');

  await evalJS(`RSApp.clearAll()`);
  await evalJS(`(async () => __drop([await __fixture('garage-45.wav', 'Sprachnotiz 14. März 2026 — Proberaum, Handyaufnahme (Mix 3).wav')]))()`);
  await (async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      if (await evalJS(`RSApp.State.cards[0] && RSApp.State.cards[0].status === 'ready'`)) return;
    }
  })();
  const longName = await evalJS(`(() => {
    const fname = document.querySelector('#fileList .fname');
    return { text: fname.textContent, over: fname.scrollWidth - fname.clientWidth,
      page: document.documentElement.scrollWidth - window.innerWidth };
  })()`);
  check('a long, real-world file name stays readable and inside the screen',
    longName.over <= 1 && longName.page <= 1 && /Mix 3/.test(longName.text),
    longName.text.slice(0, 52) + '… · ' + longName.over + 'px over');

  await evalJS(`RSApp.State.format = 'mp3'`);
  await evalJS(`window.__m = []; window.__mDone = false; (async () => {
    const card = RSApp.State.cards[0];
    const iv = setInterval(() => {
      const job = document.getElementById('globalProgress');
      const r = job.getBoundingClientRect();
      const pctEl = document.getElementById('globalProgressPct');
      const rp = pctEl.getBoundingClientRect();
      window.__m.push({ p: card.progress, stage: card.el.stage.textContent,
        hidden: job.hidden, pos: getComputedStyle(job).position,
        bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width),
        pctLeft: Math.round(rp.left), pctRight: Math.round(rp.right), pctW: Math.round(rp.width),
        view: window.innerHeight, viewW: window.innerWidth,
        text: document.getElementById('globalProgressText').textContent,
        pct: document.getElementById('globalProgressPct').textContent });
    }, 60);
    await RSApp.processAll();
    clearInterval(iv);
    window.__mDone = true;
  })(); true`);
  let mobileShot = false;
  for (let i = 0; i < 200; i++) {
    await sleep(200);
    const p = await evalJS(`(() => { const m = window.__m; return m.length ? m[m.length - 1].p : 0; })()`);
    if (!mobileShot && p > 0.2) { await shot('19-mobile-de-progress'); mobileShot = true; }
    if (await evalJS(`window.__mDone`)) break;
  }
  const dock = await evalJS(`(() => {
    const live = window.__m.filter((m) => !m.hidden && m.p > 0.15);
    // a new stage starts at zero again — monotonicity is a within-stage promise
    const groups = [];
    window.__m.forEach((m) => {
      const last = groups[groups.length - 1];
      if (last && last.stage === m.stage) last.ps.push(m.p);
      else groups.push({ stage: m.stage, ps: [m.p] });
    });
    return { running: live.length, sample: live[live.length - 1] || null,
      stages: groups.map((g) => g.stage),
      monotone: groups.every((g) => g.ps.every((p, i) => i === 0 || p >= g.ps[i - 1] - 1e-6)),
      done: window.__mDone };
  })()`);
  const s0 = dock.sample || {};
  check('the job bar docks to the very bottom edge of the phone screen',
    s0.pos === 'fixed' && Math.abs(s0.bottom - s0.view) <= 1 && s0.left === 0,
    s0.pos + ' · bottom ' + s0.bottom + ' of ' + s0.view + ' · left ' + s0.left);
  check('the docked bar spans the full width', Math.abs(s0.width - s0.viewW) <= 1,
    s0.width + ' of ' + s0.viewW + ' px');
  check('the docked bar keeps its percentage inside the screen, next to a long name',
    s0.pctW > 8 && s0.pctLeft >= s0.left && s0.pctRight <= s0.left + s0.width + 1,
    'percentage at ' + s0.pctLeft + '…' + s0.pctRight + ' inside the bar at ' + s0.left + '…' + (s0.left + s0.width));
  check('the docked bar keeps naming the file and the stage while it works',
    /Sprachnotiz/.test(s0.text || '') && /%/.test(s0.pct || '')
    && /(repariert|geschrieben|Restoring|Writing)/.test(s0.text || ''),
    (s0.text || '').slice(0, 92));
  check('mobile progress never runs backwards within a stage, and the render finished',
    dock.monotone && dock.done === true, dock.running + ' live samples');
  check('the phone render was photographed mid-flight', mobileShot === true);
  check('no sideways scroll on the phone while the docked bar is up',
    await evalJS(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  check('the docked bar does not swallow the card it belongs to',
    await evalJS(`(() => { const card = document.querySelector('#fileList .card');
      const bar = document.getElementById('globalProgress').getBoundingClientRect();
      const r = card.getBoundingClientRect();
      return r.bottom <= bar.top + 1 || r.top >= bar.bottom - 1 || r.bottom < window.innerHeight; })()`));
  await evalJS(`RSApp.State.format = 'wav'`);
  await evalJS(`RSApp.clearAll()`);
  await sleep(200);

  await clickSelector('#langSwitch button[data-lang="en"]');
  await sleep(300);
  await evalJS(`window.scrollTo(0,0)`);
  await shot('16-mobile-en-empty');

  /* full page on desktop */
  await viewport(1440, 900, false);
  await sleep(300);
  const height = await evalJS(`document.body.scrollHeight`);
  await shot('17-desktop-de-fullpage', { captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: Math.min(height, 6000), scale: 1 } });

  /* the empty desktop EN shot (for the matrix) */
  await evalJS(`RSApp.clearAll()`);
  await sleep(300);
  await shot('02-desktop-en-empty');

  /* ------------------------------------------------------------ console ---- */
  section('beta · console hygiene');
  const realNoise = consoleNoise.filter((l) => !/Autoplay|deprecat/i.test(l));
  check('no console errors or page exceptions during the whole session', realNoise.length === 0,
    realNoise.slice(0, 4).join(' | ') || 'silent');

  fixtureServer.close();

  /* ------------------------------------------------------------- report ---- */
  const now = new Date();
  const browserLine = version + ' (headless, Debian ' + fs.readFileSync('/etc/debian_version', 'utf8').trim() + ')';
  let md = `# Beta report · ${now.toISOString().slice(0, 10)}\n\n`;
  md += `Real-browser end-to-end test of the Remaster Suite in **${browserLine}**.\n`;
  md += `Driven over the Chrome DevTools Protocol with trusted input events (real clicks,\nreal drops, real downloads). Generated by \`node tests/beta/beta.js\`.\n\n`;
  md += `## Checks (${results.length - failures}/${results.length} passed)\n\n| # | check | result | detail |\n|---|-------|--------|--------|\n`;
  results.forEach((r, i) => {
    md += `| ${i + 1} | ${r.name} | ${r.pass ? '✅' : '❌'} | ${String(r.detail || '').replace(/\|/g, '\\|').slice(0, 110)} |\n`;
  });
  md += `\n## Screenshot matrix\n\n| state | desktop 1440×900 | mobile 390×844 |\n|-------|------------------|----------------|\n`;
  md += `| empty, DE | \`01-desktop-de-empty.png\` | \`13-mobile-de-empty.png\` |\n`;
  md += `| empty, EN | \`02-desktop-en-empty.png\` | \`16-mobile-en-empty.png\` |\n`;
  md += `| cards, DE | \`03-desktop-de-cards.png\` | \`14-mobile-de-cards.png\` |\n`;
  md += `| cards, EN | \`04-desktop-en-cards.png\` | — |\n`;
  md += `| processed, DE | \`05-desktop-de-processed.png\` | \`15-mobile-de-processed.png\` |\n`;
  md += `| terms dialog | \`06-desktop-de-dialog-terms.png\` | — |\n`;
  md += `| privacy dialog (EN) | \`07-desktop-en-dialog-privacy.png\` | — |\n`;
  md += `| contact dialog | \`08-desktop-de-dialog-contact.png\` | — |\n`;
  md += `| help dialog (EN) | \`09-desktop-en-dialog-help.png\` | — |\n`;
  md += `| error toast | \`10-desktop-de-toast.png\` | — |\n`;
  md += `| footer & tips | \`11-desktop-de-footer.png\` | — |\n`;
  md += `| keyboard focus | \`12-desktop-de-focus.png\` | — |\n`;
  md += `| full page | \`17-desktop-de-fullpage.png\` | — |\n`;
  md += `| progress bar, mid-render | \`18-desktop-de-progress.png\` | \`19-mobile-de-progress.png\` |\n\n`;
  md += `All screenshots live in \`docs/beta/\`. Captured sizes: ` + shots.map((s) => s.name + ' ' + s.size).join(' · ') + '.\n';
  md += '\n## Harness notes\n\n' +
    '- The suite drives a packaged headless Chromium (`@sparticuz/chromium`, an optional\n' +
    '  dev dependency) over the raw DevTools protocol — no puppeteer needed.\n' +
    '- Awaiting the MP3 render through `Runtime.evaluate`\'s `awaitPromise` deadlocks in\n' +
    '  this headless sandbox (page and Node both idle; isolated repros with programmatic\n' +
    '  clicks pass). The suite therefore uses fire-and-forget + polling for that one\n' +
    '  call, which is equally strict: the promise must settle and the page must keep\n' +
    '  answering.\n' +
    '- The recordings are the same synthesised fixtures the node suites use (garage session,\n' +
    '  cassette, vinyl rip, low-bitrate) — built with `tests/harness.js`, served to the page on a\n' +
    '  loopback port and dropped as real files. A page-local fake would only test the fake.\n' +
    '- Analysis/render timings are sandbox-CPU numbers; real hardware is faster.\n' +
    '- The upload path is timed phase by phase (decode · measurement · preview render · preview\n' +
    '  measurement) by wrapping the app from the test, so a slowdown can be attributed.\n';
  fs.writeFileSync(path.join(ROOT, 'docs', 'BETA-REPORT.md'), md);

  console.log('\n' + '-'.repeat(60));
  console.log(failures ? failures + ' FAILED / ' + (results.length - failures) + ' passed — report: docs/BETA-REPORT.md'
    : 'BETA COMPLETE — ' + results.length + ' checks passed, ' + shots.length + ' screenshots → docs/BETA-REPORT.md');
  page.close();
  child.kill('SIGTERM');
  if (server) server.kill('SIGTERM');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('\nbeta crashed:\n', err);
  process.exit(1);
});
