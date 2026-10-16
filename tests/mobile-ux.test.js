/* =============================================================================
 * Remaster Suite — mobile touch optimisation & "Magic Auto-Restore" suite
 * -----------------------------------------------------------------------------
 * Covers the three pieces of the mobile UX round:
 *
 *   · the effect rack becomes a swipeable, snap-scrolling carousel below
 *     768 px, with bigger touch targets and haptic feedback hooks
 *   · the gold "AI Magic Fix" button: arms auto profile + a confident power
 *     + (where available) a light neural pass, and on a phone runs the whole
 *     batch without the user ever touching a slider
 *   · the live A/B/C compare FAB: mirrors the top A/B switch, adds an
 *     AI-assisted third position when one is actually available, and a
 *     press-and-hold that jumps to the original for exactly as long as it is
 *     held — including engine.js's own switchBuffer(), which is what makes a
 *     mid-playback buffer swap not restart the transport from zero
 *
 * Run:  node tests/mobile-ux.test.js
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

/* ------------------------------------------------------------------- static */

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'assets/css/app.css'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');

function staticChecks() {
  section('static · the effect rack can become a carousel');
  ok(/<div class="ctl-rack" id="ctlRack">/.test(html), 'the control groups are wrapped in a dedicated rack element');
  ok(/<div class="ctl-dots" id="ctlDots"/.test(html), 'a dot-trail container exists for the carousel');
  const mobile768 = css.slice(css.indexOf('@media (max-width: 768px)'));
  ok(mobile768.indexOf('@media (max-width: 768px)') === 0, 'a dedicated 768 px breakpoint exists');
  ok(/\.ctl-rack\s*\{[^}]*overflow-x:\s*auto/.test(mobile768) && /scroll-snap-type:\s*x mandatory/.test(mobile768),
    'the rack becomes a horizontally snap-scrolling carousel on a phone');
  ok(/\.ctl-rack \.ctl-group\s*\{[^}]*scroll-snap-align/.test(mobile768), 'each control group is its own snap-aligned page');
  ok(/\.ctl-dots\s*\{\s*display:\s*flex/.test(mobile768), 'the dot trail is shown once the rack becomes a carousel');
  ok(/input\[type="range"\]::-webkit-slider-thumb\s*\{[^}]*width:\s*28px/.test(mobile768),
    'the slider thumb grows for a touch screen');
  // the pre-existing 720/480 "mobile" assertions must still see their exact
  // rules — the new 768 px block must not have been spliced in between them
  const between = css.slice(css.indexOf('@media (max-width: 720px)'), css.indexOf('@media (max-width: 480px)'));
  ok(!/@media \(max-width: 768px\)/.test(between), 'the new breakpoint does not sit inside the existing 720→480 slice');

  section('static · the gold Magic Fix button');
  ok(/<button type="button" class="btn-magic" id="btnMagicFix"/.test(html), 'the button is on the main surface (the hero), not buried in a menu');
  ok(/data-i18n="magic\.cta"/.test(html) && /data-i18n="magic\.sub"/.test(html), 'its copy is translated, not hard-coded');
  ok(/\.btn-magic\s*\{[^}]*background:\s*linear-gradient\(180deg, var\(--gold\)/.test(css), 'the button is actually gold, not just named that');

  section('static · the live A/B/C compare FAB');
  ok(/<div class="fab-ab" id="fabAB" hidden>/.test(html), 'the FAB starts hidden — it only appears while something plays');
  ok(/<button type="button" class="fab-ab-btn" id="fabABBtn"/.test(html), 'the FAB button exists');
  ok(/\.fab-ab\s*\{[^}]*position:\s*fixed/.test(css) && /env\(safe-area-inset-bottom\)/.test(css.slice(css.indexOf('.fab-ab {'))),
    'the FAB is fixed and clears the home-indicator safe area');

  section('static · haptic feedback is wired through a safe helper');
  ok(/function vibrate\(pattern\)/.test(appJs), 'a dedicated vibrate() helper exists');
  const calls = (appJs.match(/\bvibrate\(/g) || []).length;
  ok(calls >= 6, 'vibrate() is actually called from several interactions, not just declared', calls + ' call sites');
}

/* ------------------------------------------------------------------- engine */

async function engineChecks() {
  section('engine · switchBuffer() keeps the transport position, setBuffer() does not');
  stub.install(global);                                   // OfflineAudioContext et al. straight on `global`
  // the live tick loop needs a rAF — bare Node has none; a timer stand-in is
  // plenty since nothing here asserts on frame timing, only on position math
  if (!global.requestAnimationFrame) {
    global.requestAnimationFrame = (fn) => setTimeout(fn, 16);
    global.cancelAnimationFrame = (id) => clearTimeout(id);
  }
  const EngineCtor = require(path.join(ROOT, 'assets/js/engine.js'));
  const engine = new EngineCtor();
  await engine.init();
  const sr = engine.sampleRate;
  const len = sr * 2;
  const bufA = engine.ctx.createBuffer(2, len, sr);
  const bufB = engine.ctx.createBuffer(2, len, sr);
  const chA = new Float32Array(len).fill(0.1);
  const chB = new Float32Array(len).fill(0.9);
  bufA.copyToChannel(chA, 0, 0); bufA.copyToChannel(chA, 1, 0);
  bufB.copyToChannel(chB, 0, 0); bufB.copyToChannel(chB, 1, 0);

  engine.setBuffer(bufA, { start: 0, end: bufA.duration });
  await engine.play();
  engine.ctx._t += 0.75;                         // 0.75 s into playback
  const posBefore = engine.position;
  ok(Math.abs(posBefore - 0.75) < 0.02, 'position tracks elapsed time before any swap', posBefore.toFixed(3) + ' s');

  engine.switchBuffer(bufB, { start: 0, end: bufB.duration });
  // switchBuffer() re-engages play() the same fire-and-forget way the rest of
  // the engine's API already does (see ensurePlaying()) — the context is
  // already live here, so this only needs a microtask to settle
  await new Promise((r) => setTimeout(r, 0));
  ok(engine.playing === true, 'switchBuffer() does not stop playback');
  ok(engine.buffer === bufB, 'switchBuffer() actually swaps the buffer');
  const posAfter = engine.position;
  ok(Math.abs(posAfter - posBefore) < 0.05, 'switchBuffer() preserves the playback position', posAfter.toFixed(3) + ' s vs ' + posBefore.toFixed(3) + ' s before');

  // a plain setBuffer(), by contrast, is the "load a new file" contract: it
  // always restarts at the window's start
  engine.setBuffer(bufA, { start: 0, end: bufA.duration });
  ok(engine.playing === false, 'setBuffer() stops playback — a different render of a different file is not "the same spot"');
  ok(engine.position === 0, 'setBuffer() resets the position to the window start', engine.position);
}

/* --------------------------------------------------------------------- app */

const SR = 48000;

function boot(touch) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => {
    const msg = String(err && err.message);
    if (/Not implemented: navigation|Could not parse CSS|getContext \(without installing the canvas/.test(msg)) return;
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
  Object.defineProperty(win.navigator, 'maxTouchPoints', { value: touch ? 5 : 0, configurable: true });
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

function wavFile(win, channels, sr, name, bits) {
  const ab = DSP.encodeWav(channels, sr, bits || 16);
  return new win.File([new Uint8Array(ab)], name, { type: 'audio/wav' });
}

function tone(freq, seconds, sr) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

async function appChecks() {
  /* --------------------------------------------------------------------- */
  section('app · haptic feedback never throws, with or without the API');
  {
    const win = boot(false);
    const App = win.RSApp;
    try { App.vibrate(10); ok(true, 'vibrate() is silent when navigator.vibrate does not exist'); }
    catch (e) { ok(false, 'vibrate() is silent when navigator.vibrate does not exist', String(e)); }

    let calledWith = null;
    Object.defineProperty(win.navigator, 'vibrate', { value: (p) => { calledWith = p; return true; }, configurable: true });
    App.vibrate([10, 20]);
    ok(Array.isArray(calledWith) && calledWith[0] === 10, 'vibrate() calls through to a real implementation when one exists');

    Object.defineProperty(win.navigator, 'vibrate', { value: () => { throw new Error('blocked by permissions policy'); }, configurable: true });
    try { App.vibrate(5); ok(true, 'a permissions-policy rejection is swallowed, not thrown'); }
    catch (e) { ok(false, 'a permissions-policy rejection is swallowed, not thrown', String(e)); }
  }

  /* --------------------------------------------------------------------- */
  section('app · Magic Fix on a desktop: arms the settings, previews, waits for a click');
  {
    const win = boot(false);
    const App = win.RSApp;
    await new Promise((r) => setTimeout(r, 30));
    await App.addFiles([wavFile(win, [tone(220, 6, SR), tone(220, 6, SR)], SR, 'song.wav')]);

    const before = App.State.power;
    ok(before !== App.CONFIG.magicPower, 'the default power is not already the Magic Fix value (test is meaningful)');

    win.document.querySelector('#btnMagicFix').click();
    await new Promise((r) => setTimeout(r, 30));

    ok(App.State.preset === 'auto', 'Magic Fix selects automatic profile detection');
    ok(Math.abs(App.State.power - App.CONFIG.magicPower) < 1e-9, 'Magic Fix sets a confidently strong restoration power', App.State.power);
    ok(App.State.powerTouched === true, 'the power is marked as deliberately set, so it is never silently overridden later');
    const card = App.State.cards[0];
    ok(card.preset === null && card.power === null, 'existing cards follow the new global settings rather than being frozen at their old ones');
    ok(card.status !== 'done', 'on a desktop, Magic Fix previews the result but does not commit to a render on its own');
  }

  /* --------------------------------------------------------------------- */
  section('app · Magic Fix on a phone: runs the whole batch by itself');
  {
    const win = boot(true);
    const App = win.RSApp;
    await new Promise((r) => setTimeout(r, 30));
    ok(App.isTouchDevice() === true, 'the phone is recognised as a touch device for this scenario');
    await App.addFiles([wavFile(win, [tone(330, 5, SR), tone(330, 5, SR)], SR, 'take.wav')]);

    win.document.querySelector('#btnMagicFix').click();
    await new Promise((r) => setTimeout(r, 300));

    const card = App.State.cards[0];
    ok(card.status === 'done', '"auf Mobilgeräten soll dieser Button sofort … anwenden" — the file is fully processed, no extra tap needed', card.status);
    ok(!!card.result && (card.result.bytes || card.result.file), 'a real, saved-ready result came out of it');
  }

  /* --------------------------------------------------------------------- */
  section('app · Magic Fix with an empty list: arms itself and opens the picker');
  {
    const win = boot(true);
    const App = win.RSApp;
    await new Promise((r) => setTimeout(r, 30));
    let pickerOpened = false;
    win.document.querySelector('#fileInput').addEventListener('click', () => { pickerOpened = true; });

    win.document.querySelector('#btnMagicFix').click();
    ok(App.State.preset === 'auto' && Math.abs(App.State.power - App.CONFIG.magicPower) < 1e-9,
      'the settings are already armed before a single file exists');
    ok(pickerOpened, 'the file picker is opened so the next step is just "choose a file"');
    ok(App.State._magicFixAutoProcess === true, 'on a phone, the very next batch of files is flagged to auto-process');
  }

  /* --------------------------------------------------------------------- */
  section('app · the compare FAB mirrors the top A/B switch and adds nothing it cannot back up');
  {
    const win = boot(false);
    const App = win.RSApp;
    await new Promise((r) => setTimeout(r, 30));
    await App.addFiles([wavFile(win, [tone(440, 8, SR), tone(440, 8, SR)], SR, 'clip.wav')]);
    const card = App.State.cards[0];

    ok(win.document.querySelector('#fabAB').hidden === true, 'the FAB is hidden before anything plays');
    await App.ensurePlaying(card);
    ok(win.document.querySelector('#fabAB').hidden === false, 'the FAB appears once playback starts');
    ok(App.FAB.availableModes().length === 2, 'without a neural preview buffer, only Original/DSP are offered — no fabricated third option', App.FAB.availableModes().join(','));
    ok(App.FAB.mode === 'restored', 'the FAB starts on the restored (DSP) side, matching the default A/B state');

    App.FAB.tap();
    ok(App.FAB.mode === 'original' && App.State.ab === 'original', 'tapping cycles to Original and keeps the top switch in lockstep');
    ok(win.RSEngine.bypass === true, 'Original really is bypass engaged on the live engine');

    App.FAB.tap();
    ok(App.FAB.mode === 'restored' && App.State.ab === 'restored', 'tapping again returns to the restoration');
    ok(win.RSEngine.bypass === false, 'bypass is released again');

    App.FAB.holdStart();
    ok(App.FAB.engaged() === 'original' && win.RSEngine.bypass === true, 'holding jumps straight to Original while held');
    ok(App.State.ab === 'restored', 'a hold never touches the persistent top-switch state — it is purely momentary');
    App.FAB.holdEnd();
    ok(App.FAB.engaged() === 'restored' && win.RSEngine.bypass === false, 'releasing restores exactly the mode that was resting before the hold');
  }
}

async function main() {
  staticChecks();
  await engineChecks();
  await appChecks();

  console.log('\n' + '-'.repeat(60));
  console.log(failed ? failed + ' FAILED / ' + passed + ' passed' : 'ALL TESTS PASSED (' + passed + ')');
  if (failures.length) console.log('failed: ' + failures.join(', '));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nmobile-ux suite crashed:\n', err);
  process.exit(1);
});
