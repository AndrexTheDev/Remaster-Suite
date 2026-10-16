/* =============================================================================
 * Remaster Suite — extended end-to-end scenarios
 * -----------------------------------------------------------------------------
 * Realistic user journeys, driven through the actual application in a DOM with a
 * miniature Web Audio implementation:
 *
 *   · five problem recordings through auto-diagnosis and the full pipeline
 *   · the single slider from 0 % to 100 % on real material
 *   · hand-picked profiles overriding the automatic choice
 *   · a ten-file batch, processed sequentially, packed into one ZIP
 *   · mono, stereo, 32 kHz, 96 kHz
 *   · hostile input: silence, clipping, DC offset, 1-sample file, noise only
 *
 * Run:  node tests/e2e.test.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const H = require('./harness.js');
const stub = require('./webaudio-stub.js');

const ROOT = H.ROOT;
const DSP = H.loadDsp();
const Presets = require(path.join(ROOT, 'assets', 'js', 'presets.js'));

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label + (detail ? '  → ' + detail : '')); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label + '  → ' + (detail === undefined ? 'failed' : detail)); }
}
function section(name) { console.log('\n▸ ' + name); }
const num = (v, d) => (isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : '—');

/* ------------------------------------------------------------------- helpers */

const SR = 48000;

function boot() {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => {
    const msg = String(err && err.message);
    if (/Not implemented: navigation|Could not parse CSS|getContext \(without installing the canvas/.test(msg)) return;
    throw err;
  });
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    url: 'https://remaster.local/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const win = dom.window;
  Object.defineProperty(win.navigator, 'language', { value: 'de', configurable: true });
  stub.install(win);
  win.URL.createObjectURL = () => 'blob:mock';
  win.URL.revokeObjectURL = () => {};
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  win.eval(fs.readFileSync(path.join(ROOT, 'assets/vendor/lame.min.js'), 'utf8'));
  for (const f of ['dsp-utils.js', 'presets.js', 'i18n.js', 'library-loader.js', 'opfs-manager.js', 'codecs.js', 'analyzer.js', 'memory-guard.js', 'engine.js', 'ui.js', 'app.js']) {
    win.eval(fs.readFileSync(path.join(ROOT, 'assets/js', f), 'utf8'));
  }
  return win;
}

/** A WAV file object the app can decode, built from channel arrays. */
function wavFile(win, channels, sr, name, bits) {
  const ab = DSP.encodeWav(channels, sr, bits || 16);
  return new win.File([new Uint8Array(ab)], name, { type: 'audio/wav' });
}

function bandOf(channels, f1, f2, sr) {
  const spec = DSP.spectrum(channels, sr || SR, { fftSize: 8192, maxFrames: 120 });
  return DSP.bandMedian(spec, f1, f2);
}

function peakOf(channels) {
  let p = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; }
  return p;
}

function finite(channels) {
  for (const c of channels) for (let i = 0; i < c.length; i++) if (!isFinite(c[i])) return false;
  return true;
}

/** Read back what a card produced (byte arrays travel betweeen realms). */
async function bytesOf(win, result) {
  return result && result.bytes ? result.bytes : null;
}

/* ══════════════════════════════════════════════════════════════════ the suite ══ */

async function run() {
  const win = boot();
  await new Promise((r) => setTimeout(r, 40));
  const App = win.RSApp;

  /* ------------------------------------------------------------------------ */
  section('scenario · five problem recordings, one automatic diagnosis each');
  const sims = {
    garage: H.garageSim(DSP, SR, 12),
    cassette: H.cassetteSim(DSP, SR, 12),
    vinyl: H.vinylSim(DSP, SR, 12),
    lowbitrate: H.lowBitrateSim(DSP, SR, 12),
    clean: (() => {
      const env = H.songEnvelope(SR, 12, 0.04);
      let s = H.mul(H.pink(SR, 12, 0.35, 77), 1);
      for (let i = 0; i < s.length; i++) s[i] *= env[i];
      s = H.filter(DSP, s, SR, 'lp', 17000, 0.707);
      s = H.mix([s, H.noise(SR, 12, 0.0006, 78)]);
      return H.normalize(s, 0.8);
    })(),
  };
  const expectations = { garage: 'garage', cassette: 'cassette', vinyl: 'vinyl', lowbitrate: 'lowbitrate', clean: 'general' };

  for (const [key, sim] of Object.entries(sims)) {
    const file = wavFile(win, [sim, sim], SR, key + '.wav');
    await App.addFiles([file]);
    const card = App.State.cards[App.State.cards.length - 1];
    const detected = card.analysis ? card.analysis.preset : '?';
    ok(!!card.analysis && detected === expectations[key], 'auto-diagnosis: ' + key, detected + ' (' + num(card.analysis.score, 0) + '/100)');
    const sentence = card.el.diagnosis.textContent;
    ok(sentence.length > 30 && sentence.indexOf('{') === -1, '  …with a readable sentence', sentence.slice(0, 52) + '…');
    ok(card.after && card.after.chips && card.afterScore >= card.analysis.score - 5,
      '  …and a preview that does not make it worse', num(card.analysis.score, 0) + ' → ' + num(card.afterScore, 0));
    const res = await App.renderCard(card, { force: true });
    const decoded = DSP.decodeWav((await bytesOf(win, res)).buffer);
    ok(finite(decoded.channels) && peakOf(decoded.channels) <= 1, '  …and a full render inside full scale',
      'peak ' + num(peakOf(decoded.channels), 4));
    ok(decoded.channels[0].length === sim.length, '  …at exactly the same length',
      decoded.channels[0].length + ' samples');
  }

  section('scenario · what the restoration actually does to each problem');
  {
    const card = (name) => App.State.cards.find((c) => c.name === name + '.wav');

    const g = card('garage');
    let res = await App.renderCard(g, { force: true });
    let out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    const hf = [bandOf([sims.garage], 9000, 15000), bandOf(out, 9000, 15000)];
    ok(hf[1] > hf[0] + 4, 'garage: the missing top end comes back', num(hf[0]) + ' → ' + num(hf[1]) + ' dB');
    // Below the mains hum: the sub octave is built in the same 30–60 Hz region
    // the 50 Hz hum lives in, so the band is read *under* it and the hum itself is
    // checked separately, with the same detector the app uses to decide whether to
    // notch at all. (Measuring 32–58 Hz would add the two opposite repairs
    // together — a restored sub octave and a removed hum — and call it bass.)
    const lf = [bandOf([sims.garage], 25, 40), bandOf(out, 25, 40)];
    ok(lf[1] > lf[0] + 2, 'garage: deep bass is synthesised', num(lf[0]) + ' → ' + num(lf[1]) + ' dB');
    const humBefore = DSP.measure([sims.garage], SR).hum50;
    const humAfter = DSP.measure(out, SR).hum50;
    ok(humAfter < humBefore - 3, 'garage: the 50 Hz mains hum is removed',
      num(humBefore) + ' → ' + num(humAfter) + ' dB above its own neighbourhood');
    const box = [bandOf([sims.garage], 300, 360), bandOf(out, 300, 360)];
    ok(box[1] < box[0] + 1, 'garage: the boxy 320 Hz resonance is not amplified', num(box[0]) + ' → ' + num(box[1]) + ' dB');

    const v = card('vinyl');
    res = await App.renderCard(v, { force: true });
    out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    const na = DSP.noiseAnalysis([sims.vinyl], SR);
    const nb = DSP.noiseAnalysis(out, SR);
    const snrBefore = na.musicDb - na.floorDb, snrAfter = nb.musicDb - nb.floorDb;
    ok(snrAfter > snrBefore - 1, 'vinyl: the music-to-noise distance is not made worse',
      num(snrBefore) + ' → ' + num(snrAfter) + ' dB');
    const crest = [DSP.crackleDetect([sims.vinyl], SR).crestP98Db, DSP.crackleDetect(out, SR).crestP98Db];
    ok(crest[1] < crest[0] - 1, 'vinyl: crackle spikes are measurably tamed',
      num(crest[0]) + ' → ' + num(crest[1]) + ' dB crest');

    const c = card('cassette');
    res = await App.renderCard(c, { force: true });
    out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    const hiss = [bandOf([sims.cassette], 12000, 16000) - bandOf([sims.cassette], 1000, 3000),
      bandOf(out, 12000, 16000) - bandOf(out, 1000, 3000)];
    ok(hiss[1] > hiss[0] - 1, 'cassette: the top end is not opened up into pure hiss',
      num(hiss[0]) + ' → ' + num(hiss[1]) + ' dB relative');

    const l = card('lowbitrate');
    res = await App.renderCard(l, { force: true });
    out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    const air = [bandOf([sims.lowbitrate], 14000, 17000), bandOf(out, 14000, 17000)];
    ok(air[1] > air[0] + 6, 'low bitrate: content above the codec cliff is rebuilt',
      num(air[0]) + ' → ' + num(air[1]) + ' dB');

    const clean = card('clean');
    res = await App.renderCard(clean, { force: true });
    out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    let inSq = 0, outSq = 0, diffSq = 0;
    for (let i = 0; i < out[0].length; i++) {
      inSq += sims.clean[i] ** 2;
      outSq += out[0][i] ** 2;
      diffSq += (out[0][i] - sims.clean[i]) ** 2;
    }
    const levelDb = 10 * Math.log10(outSq / inSq);
    const changeDb = 10 * Math.log10(diffSq / inSq);
    ok(Math.abs(levelDb) < 4, 'clean file: the level is preserved', num(levelDb) + ' dB');
    const body = [bandOf([sims.clean], 300, 3000), bandOf(out, 300, 3000)];
    ok(Math.abs(body[1] - body[0]) < 3, 'clean file: the body of the music is left alone',
      num(body[0]) + ' → ' + num(body[1]) + ' dB');
    ok(changeDb < 6, 'clean file: the processing stays in proportion',
      num(changeDb) + ' dB difference energy');
    const hfClean = [bandOf([sims.clean], 9000, 15000), bandOf(out, 9000, 15000)];
    ok(hfClean[1] < hfClean[0] + 6, 'clean file: the top end is not overstated',
      num(hfClean[0]) + ' → ' + num(hfClean[1]) + ' dB');
  }

  section('scenario · an over-compressed modern master is called out');
  {
    const env = H.songEnvelope(SR, 12, 0.02);
    let loud = H.mul(H.pink(SR, 12, 0.35, 88), 1);
    for (let i = 0; i < loud.length; i++) loud[i] *= 0.75 + 0.25 * env[i];   // narrow envelope
    loud = H.filter(DSP, loud, SR, 'hp', 35, 0.707);
    loud = H.filter(DSP, loud, SR, 'lp', 15000, 0.707);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.tanh(loud[i] * 6) * 0.9;    // hard limiting
    loud = H.normalize(loud, 0.9);
    const file = wavFile(win, [loud, loud], SR, 'loud-master.wav');
    await App.addFiles([file]);
    const card = App.State.cards[App.State.cards.length - 1];
    const issues = card.analysis.diag.issues;
    ok(card.analysis.metrics.dynamicRangeDb < 14, 'the squashed master measures as low in dynamics',
      num(card.analysis.metrics.dynamicRangeDb) + ' dB');
    ok(issues.indexOf('squashed') !== -1 || issues.indexOf('clipping') !== -1,
      '…and the diagnosis says so', issues.join(', '));
    const res = await App.renderCard(card, { force: true });
    const out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    ok(finite(out) && peakOf(out) <= 1, '…and it is still rendered cleanly', 'peak ' + num(peakOf(out), 4));
    ok(DSP.measure([out], SR).dynamicRangeDb >= card.analysis.metrics.dynamicRangeDb - 2,
      '…without squashing the dynamics further',
      num(card.analysis.metrics.dynamicRangeDb) + ' → ' + num(DSP.measure([out], SR).dynamicRangeDb) + ' dB');
    ok(App.P.params(card).warmth < 0.25, '…and without adding saturation to a limited master',
      'warmth ' + num(App.P.params(card).warmth, 3));
  }

  section('scenario · the single slider, from 0 % to 100 %');
  {
    const card = App.State.cards.find((c) => c.name === 'garage.wav');
    card.preset = 'garage';
    card.power = 0;
    let res = await App.renderCard(card, { force: true });
    let out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
    let maxDiff = 0;
    for (let i = 0; i < out[0].length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[0][i] - sims.garage[i]));
    ok(maxDiff < 1e-4, '0 % is the original, sample for sample', 'largest difference ' + maxDiff.toExponential(1));

    const series = [];
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      card.power = p;
      res = await App.renderCard(card, { force: true });
      const dec = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
      // the sub octave is read below the mains line the notch has to take out
      series.push({ p, hf: bandOf(dec, 9000, 15000), sub: bandOf(dec, 32, 45), peak: peakOf(dec), finite: finite(dec) });
    }
    const rising = series.every((s, i) => i === 0 || s.hf >= series[i - 1].hf - 0.5);
    ok(rising, 'the top-end synthesis grows with the slider',
      series.map((s) => Math.round(s.hf)).join(' / ') + ' dB');
    ok(series[4].hf > series[3].hf && series[3].hf > series[2].hf, 'and it keeps growing at the top half');
    const subRising = series.every((s, i) => i === 0 || s.sub >= series[i - 1].sub - 0.5);
    ok(subRising, 'the sub-bass follows the slider too', series.map((s) => Math.round(s.sub)).join(' / ') + ' dB');
    ok(series.every((s) => s.finite && s.peak <= 1.0), 'every power setting stays inside full scale',
      'peaks ' + series.map((s) => s.peak.toFixed(3)).join(' / '));
  }

  section('scenario · manual profiles override the automatic choice');
  {
    const dull = App.State.cards.find((c) => c.name === 'garage.wav');
    const hissy = App.State.cards.find((c) => c.name === 'cassette.wav');
    dull.power = 0.7;
    hissy.power = 0.7;

    // on dull material, the profile decides how much top end is rebuilt
    const hf = {};
    for (const id of ['lowbitrate', 'general', 'vinyl']) {
      dull.preset = id;
      const res = await App.renderCard(dull, { force: true });
      const out = DSP.decodeWav((await bytesOf(win, res)).buffer).channels;
      hf[id] = bandOf(out, 9000, 15000);
    }
    ok(hf.lowbitrate > hf.general + 6, 'the bitrate profile rebuilds far more top end than the general one',
      num(hf.lowbitrate) + ' dB vs ' + num(hf.general) + ' dB');
    ok(hf.lowbitrate > hf.vinyl + 6, 'the vinyl profile stays deliberately conservative',
      num(hf.vinyl) + ' dB vs ' + num(hf.lowbitrate) + ' dB');
    dull.preset = null;

    // repair amounts come from the profile — unless the measurement overrules them
    hissy.preset = 'vinyl';
    const byVinyl = App.P.params(hissy);
    hissy.preset = 'cassette';
    const byCassette = App.P.params(hissy);
    hissy.preset = 'general';
    const byGeneral = App.P.params(hissy);
    hissy.preset = null;
    ok(byVinyl.declick > byGeneral.declick + 0.2, 'the vinyl profile de-clicks far harder',
      num(byVinyl.declick, 2) + ' vs ' + num(byGeneral.declick, 2));
    ok(byCassette.dehiss > byGeneral.dehiss + 0.1, 'the cassette profile de-hisses far harder',
      num(byCassette.dehiss, 2) + ' vs ' + num(byGeneral.dehiss, 2));

    // every file names the problems that were actually built into it
    const expected = {
      'garage.wav': ['dullTop', 'crackle'],
      'cassette.wav': ['hiss'],
      'vinyl.wav': ['crackle'],
      'lowbitrate.wav': ['codec'],
      'clean.wav': ['healthy'],
    };
    const wrong = [];
    for (const [name, issues] of Object.entries(expected)) {
      const card2 = App.State.cards.find((c) => c.name === name);
      const found = card2.analysis.diag.issues;
      const hit = issues.every((i) => found.indexOf(i) !== -1);
      if (!hit) wrong.push(name + ' → ' + found.join(','));
    }
    ok(wrong.length === 0, 'every file names the problems that were built into it', wrong.join(' | ') || 'all five match');
  }

  section('scenario · mono, 32 kHz and 96 kHz sources');
  {
    const cases = [
      ['mono-32k.wav', [H.cassetteSim(DSP, 32000, 6)], 32000],
      ['stereo-96k.wav', [H.garageSim(DSP, 96000, 6), H.garageSim(DSP, 96000, 6)], 96000],
    ];
    for (const [name, channels, sr] of cases) {
      const file = wavFile(win, channels, sr, name);
      await App.addFiles([file]);
      const card = App.State.cards[App.State.cards.length - 1];
      ok(!!card.analysis && card.analysis.sampleRate === sr, name + ': analysed at its own rate',
        card.analysis ? card.analysis.sampleRate + ' Hz' : 'failed');
      const res = await App.renderCard(card, { force: true });
      const decoded = DSP.decodeWav((await bytesOf(win, res)).buffer);
      ok(decoded.sr === sr && decoded.channels.length === channels.length,
        name + ': exported at its own rate and channel count',
        decoded.sr + ' Hz, ' + decoded.channels.length + ' ch');
      ok(finite(decoded.channels) && peakOf(decoded.channels) <= 1, name + ': output is sane',
        'peak ' + num(peakOf(decoded.channels), 4));
      ok(Math.abs(decoded.channels[0].length - channels[0].length) <= 1, name + ': length preserved');
    }
  }

  section('scenario · hostile input, no crash, no noise bomb');
  {
    const silent = new Float32Array(SR * 2);
    const clipped = new Float32Array(SR * 2);
    for (let i = 0; i < clipped.length; i++) clipped[i] = Math.max(-1, Math.min(1, Math.sin(i * 0.02) * 3));
    const dc = new Float32Array(SR * 2).fill(0.4);
    const noiseOnly = H.noise(SR, 3, 0.2, 99);
    const oneSample = new Float32Array([0.5]);
    const cases = [
      ['silence.wav', [silent]],
      ['clipped.wav', [clipped]],
      ['dc-offset.wav', [dc, dc]],
      ['noise-only.wav', [noiseOnly, noiseOnly]],
      ['one-sample.wav', [oneSample]],
    ];
    for (const [name, channels] of cases) {
      const file = wavFile(win, channels, SR, name);
      await App.addFiles([file]);
      const card = App.State.cards[App.State.cards.length - 1];
      const analysed = !!card.analysis;
      ok(analysed, 'hostile input: ' + name + ' is analysed', card.status);
      if (!analysed) continue;
      let res = null;
      try { res = await App.renderCard(card, { force: true }); } catch (err) { res = null; }
      ok(!!res, '  …renders without throwing');
      if (!res) continue;
      const decoded = DSP.decodeWav((await bytesOf(win, res)).buffer);
      const peak = peakOf(decoded.channels);
      ok(finite(decoded.channels), '  …produces finite samples');
      ok(peak <= 1.0, '  …stays inside full scale', 'peak ' + num(peak, 4));
      if (name === 'silence.wav') ok(peak < 1e-6, '  …and silence stays silent', 'peak ' + peak.toExponential(1));
      if (name === 'one-sample.wav') ok(decoded.channels[0].length === 1, '  …one sample in, one sample out');
      if (name === 'dc-offset.wav') ok(peak < 0.9, '  …DC offset is not amplified into a loud thump',
        'peak ' + num(peak, 3));
    }
  }

  section('scenario · a ten-file batch, processed one after another');
  {
    App.clearAll();
    const files = [];
    for (let i = 0; i < 10; i++) {
      const sim = [H.garageSim, H.cassetteSim, H.vinylSim, H.lowBitRateSim || H.lowBitrateSim][i % 4](DSP, SR, 4);
      files.push(wavFile(win, [sim, sim], SR, 'batch-' + (i + 1) + '.wav'));
    }
    const t0 = Date.now();
    await App.addFiles(files);
    ok(App.State.cards.length === 10, 'ten cards created', App.State.cards.length + ' cards');
    ok(App.State.cards.every((c) => !!c.analysis), 'all ten analysed',
      ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    ok(App.State.cards.every((c) => c.buffer === null), 'no card keeps the full decode in memory');
    ok(App.State.cards.every((c) => c.previewBuffer && c.previewBuffer.duration <= 41), 'each card holds only a preview buffer');

    const memory = App.State.cards.reduce((n, c) => n + c.previewBuffer.length * 2 * 4, 0);
    ok(memory < 40e6, 'the whole batch lives in well under 40 MB of audio memory', (memory / 1e6).toFixed(1) + ' MB');

    // Process All
    App.State.power = 0.7;
    await App.processAll();
    ok(App.State.cards.every((c) => c.status === 'done' && c.result && c.result.bytes.length > 1000),
      'every file was rendered and encoded', App.State.cards[0].result.bytes.length + ' bytes each');
    ok(App.State.cards.every((c) => c.result.name.indexOf('.wav') !== -1), 'names carry the right extension');

    // ZIP
    const NodeJSZip = require(path.join(ROOT, 'assets/vendor/jszip.min.js'));
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
    await App.downloadZip();
    win.RSCodecs.download = realDownload;
    ok(!!captured && /\.zip$/.test(captured.name), 'a ZIP was produced', captured && captured.name);
    const zip = await NodeJSZip.loadAsync(captured.bytes);
    const audioEntry = Object.keys(zip.files).filter((n) => /\.wav$/.test(n));
    ok(audioEntry.length === 10, 'the ZIP holds all ten files', String(audioEntry.length));
    const readme = await zip.file('README.txt').async('string');
    ok((readme.match(/^  profile  :/gm) || []).length === 10, 'the readme documents all ten');
    ok(/79KsqtJJdhKFJ9woxnYgtf3nq7HxQveafWBCtC3mxWi8/.test(readme), 'the readme carries the tip addresses');

    const total = audioEntry.reduce((n, n2) => n + zip.files[n2]._data.uncompressedSize, 0);
    ok(total > 1e6, 'the archive really contains audio', (total / 1e6).toFixed(1) + ' MB');
  }

  section('scenario · MP3 batch export');
  {
    App.State.format = 'mp3';
    App.State.mp3Rate = 256;
    const card = App.State.cards[0];
    const res = await App.renderCard(card, { force: true });
    const mp3 = res.bytes;
    ok(/\.mp3$/.test(res.name) && mp3.length > 4000, 'MP3 produced', (mp3.length / 1024).toFixed(0) + ' KB');
    ok(mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0, 'the stream starts on a frame boundary',
      '0x' + mp3[0].toString(16) + mp3[1].toString(16));
    // walk the stream frame by frame, the way a decoder does
    const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const RATES = [44100, 48000, 32000];
    let off = 0, frames = 0, broken = 0, sizes = new Set();
    while (off + 4 < mp3.length) {
      if (mp3[off] !== 0xff || (mp3[off + 1] & 0xe0) !== 0xe0) { broken++; break; }
      const b2 = mp3[off + 2];
      const kbps = BITRATES[(b2 >> 4) & 0xf];
      const rateIdx = (b2 >> 2) & 0x3;
      if (!kbps || rateIdx === 3) { broken++; break; }
      const frameSize = Math.floor((144 * kbps * 1000) / RATES[rateIdx]) + ((b2 >> 1) & 1);
      sizes.add(frameSize);
      frames++;
      off += frameSize;
    }
    ok(frames > 20 && broken === 0, 'every frame starts where the previous one ended', frames + ' frames, ' + broken + ' breaks');
    ok(sizes.size <= 2, 'frame size is constant apart from padding', [...sizes].join(', ') + ' bytes');
    ok(mp3.length - off < 2100, 'the stream ends on a frame boundary', (mp3.length - off) + ' bytes left over');
    App.State.format = 'wav';
  }

  section('scenario · the interface keeps up');
  {
    const card = App.State.cards[0];
    card.el.power.value = '100';
    card.el.power.dispatchEvent(new win.Event('input'));
    ok(card.power === 1, 'per-file slider updates the card state');
    card.el.power.value = '30';
    card.el.power.dispatchEvent(new win.Event('input'));
    ok(Math.abs(card.power - 0.3) < 1e-9, '…and back down');

    card.el.preset.value = 'vinyl';
    card.el.preset.dispatchEvent(new win.Event('change'));
    ok(App.P.params(card).declick > 0.3, 'per-file profile change reaches the parameter map',
      'declick ' + num(App.P.params(card).declick, 2));

    win.document.querySelector('#abSwitch button[data-ab="original"]').click();
    ok(App.State.ab === 'original', 'A/B switch moves to the original');
    win.document.querySelector('#abSwitch button[data-ab="compare"]').click();
    ok(App.State.ab === 'compare', 'A/B switch can self-compare');
    win.document.querySelector('#abSwitch button[data-ab="restored"]').click();
    ok(App.State.ab === 'restored', 'A/B switch returns to the restoration');

    win.RSApp.removeCard(card);
    ok(App.State.cards.length === 9 && win.document.querySelectorAll('#fileList .card').length === 9,
      'a card can be removed from the list');
    win.document.querySelector('#btnClear').click();
    ok(App.State.cards.length === 0 && win.document.querySelectorAll('#fileList .card').length === 0,
      'the list can be cleared completely');
  }

  console.log('\n' + '-'.repeat(60));
  console.log(failed ? failed + ' FAILED / ' + passed + ' passed' : 'ALL TESTS PASSED (' + passed + ')');
  if (failures.length) console.log('failed: ' + failures.join(', '));
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error('\ne2e suite crashed:\n', err);
  process.exit(1);
});
