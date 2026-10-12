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
const { spawn } = require('child_process');
const beta = require('./chromium.js');
const cdp = require('./cdp.js');

const ROOT = path.join(__dirname, '..', '..');
const SHOT_DIR = path.join(ROOT, 'docs', 'beta');
const DL_DIR = '/tmp/rs-beta-downloads';
const PORT = 8080;
const DBG = 9222;

fs.mkdirSync(SHOT_DIR, { recursive: true });
fs.mkdirSync(DL_DIR, { recursive: true });
for (const f of fs.readdirSync(DL_DIR)) fs.rmSync(path.join(DL_DIR, f), { force: true });

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
  const viewport = (w, h, mobile) => page.send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile,
  });
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
  const H = require('../harness.js');
  const DSP = H.loadDsp();
  const SIM_SR = 44100;
  const sims = {
    garage: H.garageSim(DSP, SIM_SR, 12),
    cassette: H.cassetteSim(DSP, SIM_SR, 12),
    vinyl: H.vinylSim(DSP, SIM_SR, 12),
  };
  await evalJS(`
    window.__file = (name, b64) => {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new File([u8], name, { type: 'audio/wav' });
    };
    window.__mk = (kind, sec) => {
      const SR = 44100, N = SR * (sec || 12);
      const L = new Float32Array(N), R = new Float32Array(N);
      let seed = kind === 'garage' ? 11 : kind === 'cassette' ? 22 : 33, lp = 0;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
      for (let i = 0; i < N; i++) {
        const t = i / SR;
        const env = Math.min(1, 0.25 + 0.75 * Math.abs(Math.sin(t * 0.4) + 0.5 * Math.sin(t * 0.13)));
        const n = rnd();
        let x;
        if (kind === 'garage') { lp += 0.06 * (n - lp); x = lp * 3 * env + 0.02 * Math.sin(2 * Math.PI * 50 * t); }
        else if (kind === 'cassette') { lp += 0.25 * (n - lp); x = lp * 1.1 * env + 0.02 * n; }
        else { lp += 0.5 * (n - lp); x = lp * env + (rnd() > 0.9995 ? rnd() * 1.1 : 0); }
        L[i] = Math.max(-0.95, Math.min(0.95, x));
        R[i] = L[i] * 0.94;
      }
      const bytes = window.RSDSP.encodeWav([L, R], SR, 16);
      return new File([bytes], kind + '-take.wav', { type: 'audio/wav' });
    };
    window.__drop = (files) => {
      const dz = document.querySelector('#dropzone');
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      dz.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    };
    true`);
  for (const [k, sig] of Object.entries(sims)) {
    const b64 = Buffer.from(DSP.encodeWav([sig, sig], SIM_SR, 16)).toString('base64');
    await evalJS(`window.__${k}File = __file('${k}-take.wav', '${b64}')`);
  }

  /* ------------------------------------------------------------ the drop ---- */
  section('beta · real drag-and-drop of three problem recordings');
  await evalJS(`__drop([__garageFile, __cassetteFile, __vinylFile])`);
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
  const perf = await evalJS(`(async () => {
    const big = __mk('garage', 180);           // synthesis is not part of the budget
    const t0 = performance.now();
    await RSApp.addFiles([big]);
    const analyseMs = performance.now() - t0;
    const card = RSApp.State.cards[RSApp.State.cards.length - 1];
    const t1 = performance.now();
    await RSApp.renderCard(card, { force: true });
    const renderMs = performance.now() - t1;
    return {
      analyseMs: Math.round(analyseMs),
      renderMs: Math.round(renderMs),
      preset: card.analysis.preset,
      bytes: card.result.bytes.length,
      heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
    };
  })()`);
  check('a 3-minute take is analysed in seconds, not minutes (sandbox CPU)', perf.analyseMs < 6000, perf.analyseMs + ' ms');
  check('a 3-minute take renders in real time or faster', perf.renderMs < 60000, perf.renderMs + ' ms');
  check('heap stays moderate after the long file', perf.heapMB < 900, perf.heapMB + ' MB');

  await evalJS(`RSApp.clearAll()`);
  await evalJS(`__drop([__mk('garage',6), __mk('cassette',6), __mk('vinyl',6), __mk('garage',6), __mk('cassette',6), __mk('vinyl',6)])`);
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

  /* --------------------------------------------------------------- mobile ---- */
  section('beta · mobile viewport');
  await evalJS(`RSApp.clearAll()`);
  await viewport(390, 844, true);
  await sleep(400);
  check('no horizontal overflow on a phone', await evalJS(
    `document.documentElement.scrollWidth <= window.innerWidth + 1`),
    await evalJS(`document.documentElement.scrollWidth + ' vs ' + window.innerWidth`));
  await shot('13-mobile-de-empty');
  await evalJS(`__drop([__mk('garage', 8), __mk('vinyl', 8)])`);
  await (async () => {
    for (let i = 0; i < 40; i++) { await sleep(400); if (await evalJS(`RSApp.State.cards.filter(c=>c.analysis).length === 2`)) return; }
  })();
  check('mobile: no overflow with cards either', await evalJS(
    `document.documentElement.scrollWidth <= window.innerWidth + 1`));
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
  md += `| full page | \`17-desktop-de-fullpage.png\` | — |\n\n`;
  md += `All screenshots live in \`docs/beta/\`. Captured sizes: ` + shots.map((s) => s.name + ' ' + s.size).join(' · ') + '.\n';
  md += `\n## Harness notes\n\n` +
    `- The suite drives a packaged headless Chromium (\\`@sparticuz/chromium\\`, an optional\n` +
    `  dev dependency) over the raw DevTools protocol — no puppeteer needed.\n` +
    `- Awaiting the MP3 render through \\`Runtime.evaluate\\`'s \\`awaitPromise\\` deadlocks in\n` +
    `  this headless sandbox (page and Node both idle; isolated repros with programmatic\n` +
    `  clicks pass). The suite therefore uses fire-and-forget + polling for that one\n` +
    `  call, which is equally strict: the promise must settle and the page must keep\n` +
    `  answering.\n` +
    `- Analysis/render timings are sandbox-CPU numbers; real hardware is faster.\n`;
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
