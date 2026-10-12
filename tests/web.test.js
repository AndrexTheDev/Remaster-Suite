/* =============================================================================
 * Remaster Suite — web layer test suite
 * -----------------------------------------------------------------------------
 * Runs in Node with a DOM (jsdom) and a miniature Web Audio implementation, so
 * the real application code is exercised end to end:
 *
 *   index.html → scripts → drop a file → decode → analyse → preview render →
 *   waveform → full render → WAV/MP3 … → ZIP
 *
 * Run:  node tests/web.test.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const H = require('./harness.js');
const stub = require('./webaudio-stub.js');

const ROOT = H.ROOT;
const DSP = H.loadDsp();

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label + (detail ? '  → ' + detail : '')); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label + '  → ' + (detail === undefined ? 'failed' : detail)); }
}
function section(name) { console.log('\n▸ ' + name); }

/* --------------------------------------------------------------- static checks */

function readIndexHtml() { return fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'); }

function staticChecks(doc) {
  section('static · every referenced asset exists');
  const refs = [];
  doc.querySelectorAll('script[src]').forEach((s) => refs.push(s.getAttribute('src')));
  doc.querySelectorAll('link[href]').forEach((l) => refs.push(l.getAttribute('href')));
  let missing = [];
  for (const r of refs) {
    if (/^https?:/.test(r)) continue;
    if (!fs.existsSync(path.join(ROOT, r))) missing.push(r);
  }
  ok(missing.length === 0, 'all local script/link targets exist', missing.join(', '));

  const vendor = ['assets/vendor/jszip.min.js', 'assets/vendor/lame.min.js'];
  for (const v of vendor) {
    const p = path.join(ROOT, v);
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    ok(size > 20000, 'vendored library present: ' + v, (size / 1024).toFixed(0) + ' KB');
  }
  ok(fs.existsSync(path.join(ROOT, 'assets/img/favicon.svg')), 'favicon exists');
  ok(fs.existsSync(path.join(ROOT, 'assets/vendor/lamejs.LICENSE')), 'third-party licence text shipped');

  section('static · bilingual coverage');
  const i18n = require(path.join(ROOT, 'assets/js/i18n.js'));   // CJS export for tests
  const de = i18n.keys('de');
  const en = i18n.keys('en');
  const onlyDe = de.filter((k) => en.indexOf(k) === -1);
  const onlyEn = en.filter((k) => de.indexOf(k) === -1);
  ok(onlyDe.length === 0 && onlyEn.length === 0, 'de/en dictionaries carry the same keys',
    onlyDe.concat(onlyEn).join(', '));
  ok(de.length > 120, 'dictionary is substantial', de.length + ' keys');

  const used = new Set();
  const attrs = ['data-i18n', 'data-i18n-html', 'data-i18n-title', 'data-i18n-aria'];
  for (const a of attrs) {
    doc.querySelectorAll('[' + a + ']').forEach((el) => used.add(el.getAttribute(a)));
  }
  const missingDe = [...used].filter((k) => !i18n.DICT.de[k]);
  const missingEn = [...used].filter((k) => !i18n.DICT.en[k]);
  ok(missingDe.length === 0, 'every markup key exists in German', missingDe.join(', '));
  ok(missingEn.length === 0, 'every markup key exists in English', missingEn.join(', '));

  const code = jsSources(ROOT).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const keysInCode = new Set();
  const re = /\bt\(\s*'([a-z0-9]+\.[A-Za-z0-9.]+)'/g;
  let m;
  while ((m = re.exec(code))) keysInCode.add(m[1]);
  const missingCode = [...keysInCode].filter((k) => !i18n.DICT.de[k] || !i18n.DICT.en[k]);
  ok(missingCode.length === 0, 'every key used in JavaScript exists in both languages', missingCode.join(', '));

  section('static · privacy promises');
  const allCode = code + readIndexHtml();
  ok(!/<script[^>]+src=["']https?:/.test(allCode), 'no remote script is loaded by default');
  ok(!/<link[^>]+href=["']https?:/.test(allCode), 'no remote stylesheet or font is loaded');
  ok(/localStorage/.test(allCode) === false, 'no localStorage is used');
  ok(/document\.cookie/.test(allCode) === false, 'no cookie is written');
}

function jsSources(root) {
  const dir = path.join(root, 'assets', 'js');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
}

/* --------------------------------------------------------------- jsdom bootstrap */

function bootApp() {
  const html = readIndexHtml();
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => {
    if (/Not implemented: navigation/.test(String(err && err.message))) return;
    if (/Could not parse CSS/.test(String(err && err.message))) return;
    if (/getContext \(without installing the canvas/.test(String(err && err.message))) return;
    throw err;
  });
  const dom = new JSDOM(html, {
    url: 'https://remaster.local/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const win = dom.window;
  Object.defineProperty(win.navigator, 'language', { value: 'de', configurable: true });
  Object.defineProperty(win.navigator, 'languages', { value: ['de'], configurable: true });
  stub.install(win);

  // blob URLs and clipboard: not implemented by jsdom
  const urls = [];
  win.URL.createObjectURL = (blob) => { const u = 'blob:mock-' + urls.length; urls.push(blob); return u; };
  win.URL.revokeObjectURL = () => {};
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });

  // the vendored libraries, as if their <script> tag / CDN fetch had completed
  win.eval(fs.readFileSync(path.join(ROOT, 'assets/vendor/jszip.min.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(ROOT, 'assets/vendor/lame.min.js'), 'utf8'));

  const order = ['dsp-utils.js', 'presets.js', 'i18n.js', 'library-loader.js', 'codecs.js',
    'analyzer.js', 'engine.js', 'ui.js', 'app.js'];
  for (const file of order) {
    const code = fs.readFileSync(path.join(ROOT, 'assets', 'js', file), 'utf8');
    win.eval(code);
  }
  return { dom, win, urls };
}

/* ------------------------------------------------------------------- the suite */

async function run() {
  const doc = new JSDOM(readIndexHtml()).window.document;
  staticChecks(doc);

  section('boot · the app comes alive');
  const { win } = bootApp();
  await new Promise((r) => setTimeout(r, 30));      // let DOMContentLoaded run
  ok(!!win.RSDSP && !!win.RSPresets && !!win.RSi18n && !!win.RSCodecs, 'all modules are on the page');
  ok(!!win.JSZip && !!win.lamejs, 'both helper libraries are available');
  ok(!!win.RSApp && !!win.RSAnalyzer && !!win.RSEngine && !!win.RSUI, 'app, analyser, engine and UI are exported');
  const hero = win.document.querySelector('.hero h1');
  ok(hero.textContent.length > 5, 'translations were applied on boot', hero.textContent.slice(0, 28) + '…');
  ok(win.document.getElementById('controls').hidden, 'control bar is hidden until a file arrives');
  ok(win.document.querySelector('#presetSelect').options.length === 6, 'six sound profiles in the menu');
  ok(win.document.querySelectorAll('.coin').length === 3, 'three donation addresses in the footer');
  const coin = win.document.querySelector('.coin').getAttribute('data-copy');
  ok(coin === '79KsqtJJdhKFJ9woxnYgtf3nq7HxQveafWBCtC3mxWi8', 'SOL address is exact', coin.slice(0, 8) + '…');
  ok(/hippie\.highho@gmail\.com/.test(win.document.querySelector('.credit').textContent), 'author contact is in the footer');

  section('boot · language switching');
  const deText = win.document.querySelector('.hero h1').textContent;
  win.document.querySelector('#langSwitch button[data-lang="en"]').click();
  const enText = win.document.querySelector('.hero h1').textContent;
  ok(win.RSi18n.lang === 'en', 'language switched to English');
  ok(enText !== deText, 'visible text really changed', '"' + enText.slice(0, 34) + '…"');
  ok(win.document.documentElement.lang === 'en', 'html lang attribute follows');
  ok(/Terms|Privacy/.test(win.document.querySelector('#dlgTerms').innerHTML), 'legal overlay follows the language too');
  win.document.querySelector('#langSwitch button[data-lang="de"]').click();
  ok(win.RSi18n.lang === 'de', 'back to German');

  section('flow · drop a 1960s garage recording');
  const SR = 48000;
  const sim = H.garageSim(DSP, SR, 10);
  const source = [sim, H.mul(sim, 0.8)];
  const wavAb = DSP.encodeWav(source, SR, 16);
  const file = new win.File([new Uint8Array(wavAb)], 'garage-take-3.wav', { type: 'audio/wav' });
  const t0 = Date.now();
  await win.RSApp.addFiles([file]);
  const card = win.RSApp.State.cards[0];
  ok(!!card && card.analysis, 'card exists and was analysed in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  ok(card.status === 'ready', 'card reached the ready state', card.status);
  ok(!win.document.getElementById('controls').hidden, 'control bar appeared');
  ok(card.analysis.preset === 'garage', 'auto-diagnosis picked the garage profile', card.analysis.preset);
  ok(Math.abs(win.RSApp.State.power - card.analysis.recommendedPower) < 1e-6,
    'the slider adopts the recommended strength of the detected profile',
    Math.round(win.RSApp.State.power * 100) + ' %');
  ok(win.document.querySelector('#powerVal').textContent.indexOf(Math.round(win.RSApp.State.power * 100)) === 0,
    'the badge follows the recommended strength', win.document.querySelector('#powerVal').textContent);
  ok(card.analysis.score > 20 && card.analysis.score < 95, 'quality score is plausible', String(card.analysis.score));
  const diagText = card.el.diagnosis.textContent;
  ok(diagText.length > 30 && !/[A-Z]{2,}[_ ]/.test(diagText), 'diagnosis is a readable sentence', diagText.slice(0, 60) + '…');
  ok(card.after && card.after.chips, 'a restored preview was rendered');
  ok(card.afterScore >= card.analysis.score - 4, 'restored preview scores no worse', card.analysis.score + ' → ' + card.afterScore);
  ok(!!card.previewBuffer && card.previewBuffer.length > 0, 'live monitor buffer exists',
    (card.previewBuffer.length / SR).toFixed(1) + ' s');
  ok(card.buffer === null, 'the full decode was released (low memory)');
  ok(card.wave.before && card.wave.before.max.length === 1400, 'waveform got 1400 buckets');
  ok(card.wave.after && card.wave.after.max.length === 1400, 'restored waveform half exists');
  const chips = card.el.chips.textContent;
  ok(/\/ 100/.test(chips), 'quality chip with before → after', chips.slice(0, 46).replace(/\s+/g, ' '));
  ok(card.el.canvas.getAttribute('aria-label').length > 3, 'canvas is described for screen readers');

  section('flow · per-file controls');
  win.RSApp.State.power = 1;
  win.RSApp.State.preset = 'vinyl';
  ok(win.RSApp.P.resolvedPreset(card) === 'vinyl', 'per-file profile follows the global choice');
  win.RSApp.State.preset = 'auto';
  card.preset = 'cassette';
  ok(win.RSApp.P.resolvedPreset(card) === 'cassette', 'per-file profile can differ from the global one');
  card.preset = null;
  const p0 = win.RSApp.P.params(card);
  ok(p0 && p0.power === 1 && p0.bypass === 0, 'parameter map is complete',
    Object.keys(p0).length + ' parameters');
  ok(p0.hissFloor !== undefined && p0.noiseFloor < 0, 'measured noise floors reach the processor');
  win.RSApp.State.power = 0.5;
  const p1 = win.RSApp.P.params(card);
  const scaled = ['air', 'exciter', 'dehiss', 'reso'].some((k) => Math.abs(p1[k] - p0[k]) > 1e-6);
  ok(scaled, 'the single power slider scales the whole chain');
  ok(p1.band5 < p0.band5 + 0.001 && p1.band5 !== p0.band5, 'equaliser bands scale with power too');

  section('flow · full render and save');
  win.RSApp.State.format = 'wav';
  win.RSApp.State.wavDepth = 16;
  win.RSApp.State.power = 0.8;
  const res = await win.RSApp.renderCard(card, { force: true });
  ok(res && res.bytes && res.bytes.length > 1000, 'WAV bytes produced', (res.bytes.length / 1024).toFixed(0) + ' KB');
  ok(/garage-take-3 \(restored\)\.wav$/.test(res.name), 'file name is derived from the source', res.name);
  const bytes = res.bytes;
  const decoded = DSP.decodeWav(bytes.buffer);
  ok(decoded.sr === SR, 'export keeps the source sample rate', decoded.sr + ' Hz');
  ok(Math.abs(decoded.channels[0].length - sim.length) < 4, 'export keeps the length',
    decoded.channels[0].length + ' vs ' + sim.length);
  const band = (chans, f1, f2) => {
    const spec = DSP.spectrum(chans, SR, { fftSize: 8192, maxFrames: 120 });
    return DSP.bandMedian(spec, f1, f2);
  };
  const hfBefore = band(source, 9000, 15000);
  const hfAfter = band(decoded.channels, 9000, 15000);
  ok(hfAfter > hfBefore + 3, 'restored file has substantially more top end', hfBefore.toFixed(1) + ' → ' + hfAfter.toFixed(1) + ' dB');
  const lowBefore = band(source, 30, 60);
  const lowAfter = band(decoded.channels, 30, 60);
  ok(lowAfter > lowBefore + 2, 'restored file has more sub bass', lowBefore.toFixed(1) + ' → ' + lowAfter.toFixed(1) + ' dB');
  let peak = 0, atCeiling = 0;
  for (const c of decoded.channels) {
    for (const v of c) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 0.9999) atCeiling++;
    }
  }
  ok(peak <= 1.0, 'export never exceeds full scale', peak.toFixed(6));
  ok(atCeiling === 0, 'export is not pinned at the ceiling (soft clip, no hard clip)', atCeiling + ' samples');
  ok(card.status === 'done', 'card is marked as done');
  ok(card.result.signature === win.RSApp.P.signature(card), 'result remembers its settings');

  section('flow · export settings behave');
  const again = await win.RSApp.renderCard(card);
  ok(again.bytes === res.bytes, 'an unchanged render is reused, not recomputed');
  win.document.querySelector('.controls button[data-format="mp3"]').click();
  ok(win.RSApp.State.format === 'mp3', 'export format switched to MP3');
  ok(!win.document.getElementById('mp3Rate').hidden && win.document.getElementById('wavDepth').hidden,
    'the matching quality control appears');
  ok(card.result.stale === true, 'the previous render is flagged as stale after a settings change');
  win.document.querySelector('#mp3Rate').value = '192';
  win.document.querySelector('#mp3Rate').dispatchEvent(new win.Event('change'));
  ok(win.RSApp.State.mp3Rate === 192, 'MP3 bitrate is taken from the menu');
  win.document.querySelector('.controls button[data-format="wav"]').click();
  ok(win.RSApp.State.format === 'wav' && !win.document.getElementById('wavDepth').hidden, 'back to WAV');
  win.RSApp.State.wavDepth = 24;
  const res24 = await win.RSApp.renderCard(card, { force: true });
  const d24 = DSP.decodeWav(res24.bytes.buffer);
  ok(d24.bitDepth === 24, '24-bit WAV export', d24.bitDepth + ' bit');
  win.document.querySelector('#wavDepth').value = '32';
  win.document.querySelector('#wavDepth').dispatchEvent(new win.Event('change'));
  ok(win.RSApp.State.wavDepth === 32, '32-bit float WAV option is selectable in the UI');
  const res32 = await win.RSApp.renderCard(card, { force: true });
  const d32 = DSP.decodeWav(res32.bytes.buffer);
  ok(d32.bitDepth === 32 && d32.format === 3, '32-bit float WAV export', d32.bitDepth + ' bit float');
  win.RSApp.State.wavDepth = 16;

  section('flow · MP3 export through lamejs');
  win.RSApp.State.format = 'mp3';
  const resMp3 = await win.RSApp.renderCard(card, { force: true });
  ok(/\.mp3$/.test(resMp3.name), 'MP3 file name', resMp3.name);
  const mb = resMp3.bytes;
  ok(mb.length > 2000, 'MP3 stream has real bytes', (mb.length / 1024).toFixed(0) + ' KB');
  ok((mb[0] === 0xff && (mb[1] & 0xe0) === 0xe0) || (mb[0] === 0x49 && mb[1] === 0x44), 'MP3 starts with a frame header',
    '0x' + mb[0].toString(16) + ' 0x' + mb[1].toString(16));
  const mp3Rate = DSP.detectSampleRate(mb.buffer);
  ok(!mp3Rate || mp3Rate === 48000 || mp3Rate === 44100, 'MP3 reports a sane sample rate', String(mp3Rate));

  section('flow · batch ZIP');
  win.RSApp.State.format = 'wav';
  // jsdom cannot run JSZip's asynchronous pipeline (it hangs on its internal
  // setImmediate/Blob plumbing), so the archive assertions use the very same
  // vendored JSZip file, loaded in Node instead of in the window.
  const NodeJSZip = require(path.join(ROOT, 'assets', 'vendor', 'jszip.min.js'));
  // the data crosses two V8 realms here, so the shim re-wraps byte arrays
  win.RSLibs.jszip = async () => {
    function ZipShim() { this.real = new NodeJSZip(); }
    ZipShim.prototype.file = function (name, data, opts) {
      const bytes = data && typeof data.length === 'number' && data.buffer ? new Uint8Array(data) : data;
      return this.real.file(name, bytes, opts);
    };
    ZipShim.prototype.generateAsync = function (opts, cb) { return this.real.generateAsync(opts, cb); };
    return ZipShim;
  };
  let captured = null;
  const realDownload = win.RSCodecs.download;
  win.RSCodecs.download = (data, name) => { captured = { bytes: data, name }; return name; };
  await win.RSApp.downloadZip();
  win.RSCodecs.download = realDownload;
  ok(!!captured && /\.zip$/.test(captured.name), 'ZIP was handed to the downloader', captured && captured.name);
  const zip = await NodeJSZip.loadAsync(captured.bytes);
  const names = Object.keys(zip.files);
  ok(names.length === 2, 'ZIP holds the audio file and a readme', names.join(', '));
  ok(/\.wav$/.test(names.find((n) => /\.wav$/.test(n))), 'audio entry is a WAV');
  const readme = await zip.file('README.txt').async('string');
  ok(/AndrexTheDev/.test(readme) && /79Ksqt/.test(readme), 'readme names the author and the tip addresses');
  ok(/\* garage-take-3\.wav/.test(readme), 'readme lists the processed file');

  section('flow · opening and clearing the list');
  ok(win.document.querySelectorAll('#fileList .card').length === 1, 'one card in the list');
  win.document.querySelector('#btnClear').click();
  ok(win.document.querySelectorAll('#fileList .card').length === 0, 'cards removed');
  ok(win.RSApp.State.cards.length === 0, 'state cleared');
  ok(win.document.getElementById('controls').hidden, 'control bar hidden again');

  section('engine · resampling an odd sample rate');
  const odd = DSP.encodeWav([H.tone(1000, 32000, 2, 0.5)], 32000, 16);
  const oddFile = new win.File([new Uint8Array(odd)], 'voice-note-32k.wav', { type: 'audio/wav' });
  await win.RSApp.addFiles([oddFile]);
  const card2 = win.RSApp.State.cards[0];
  ok(!!card2 && card2.analysis && card2.analysis.sampleRate === 32000, '32 kHz source analysed at its own rate',
    card2 && card2.analysis ? card2.analysis.sampleRate + ' Hz' : 'n/a');
  win.RSApp.State.format = 'mp3';
  const res2 = await win.RSApp.renderCard(card2, { force: true });
  const d2 = res2.bytes;
  ok(d2.length > 1000 && res2.rate === 32000, 'MP3 rendered at a lame-supported rate', res2.rate + ' Hz');
  win.RSApp.State.format = 'wav';

  section('errors · unreadable file is reported, not swallowed');
  const badFile = new win.File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'broken.wav', { type: 'audio/wav' });
  await win.RSApp.addFiles([badFile]);
  const card3 = win.RSApp.State.cards[win.RSApp.State.cards.length - 1];
  ok(card3 && card3.status === 'error', 'broken file ends up in the error state', card3 && card3.status);
  ok(!card3.el.note.hidden && card3.el.note.textContent.length > 3, 'card explains itself', card3.el.note.textContent.slice(0, 40));
  ok(/\(2\)/.test(win.document.querySelector('#btnZip').textContent), 'ZIP button shows count for multiple cards');
  win.RSApp.removeCard(card3);
  ok(win.RSApp.State.cards.length === 1, 'broken card can be removed');
  ok(!/\(2\)/.test(win.document.querySelector('#btnZip').textContent), 'ZIP button count updates when a card is removed');

  /* summary */
  console.log('\n' + '-'.repeat(60));
  console.log(failed ? failed + ' FAILED / ' + passed + ' passed' : 'ALL TESTS PASSED (' + passed + ')');
  if (failures.length) console.log('failed: ' + failures.join(', '));
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error('\nweb test suite crashed:\n', err);
  process.exit(1);
});
