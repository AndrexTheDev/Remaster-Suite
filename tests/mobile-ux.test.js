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
  ok(/function vibrate\(pattern, anchor\)/.test(appJs), 'a dedicated vibrate() helper exists, and takes the control it belongs to');
  ok(/UI\.haptic\(anchor \|\| null, pattern\)/.test(appJs),
    'it goes through the UI layer, which owns the visual fallback for a platform without the Vibration API');
  const calls = (appJs.match(/\bvibrate\(/g) || []).length;
  ok(calls >= 6, 'vibrate() is actually called from several interactions, not just declared', calls + ' call sites');

  section('static · the phone inspector drawer');
  ok(/<section class="sheet" id="cardSheet" role="dialog" aria-modal="true"/.test(html),
    'a real modal dialog lives in the markup, not a styled div');
  ok(/aria-labelledby="cardSheetTitle"/.test(html) && /aria-describedby="cardSheetHint"/.test(html),
    'the dialog is named and described for a screen reader');
  ok(/<div class="sheet-body" id="cardSheetBody"><\/div>/.test(html), 'it has its own body slot for the adopted controls');
  ok(/id="cardSheetGrab"/.test(html), 'a grabber is there, which is the only drag handle');
  ok(/data-act="inspect"/.test(html) && /data-i18n-aria="card.inspect"/.test(html),
    'each card carries its own labelled "settings" button, reachable by keyboard');
  ok(/\.card-inspect\s*\{\s*display:\s*none/.test(css), 'that button is hidden where the card already shows its controls');

  const m768 = css.slice(css.indexOf('@media (max-width: 768px)'));
  ok(/\.card-inspect\s*\{\s*display:\s*grid/.test(m768), '…and appears exactly at the phone breakpoint');
  ok(/\.card-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;?\s*\}/.test(m768),
    'the per-file controls are one column on a phone — no sideways strip inside a card');
  ok(!/\.card[^{]*(?:card-grid|field)[^{]*\{[^}]*overflow-x/.test(m768),
    'no control inside a card is a horizontal scroller any more');
  ok(/\.sheet-body\s*\{[^}]*touch-action:\s*pan-y/.test(css), 'the drawer body allows vertical panning only');
  ok(/\.sheet-body\s*\{[^}]*overscroll-behavior:\s*contain/.test(css),
    'a scroll inside the drawer never chains to the page behind it');
  ok(/\.ctl-rack\s*\{[^}]*overscroll-behavior-x:\s*contain/s.test(css),
    'the main rack keeps its horizontal swipe, and it stays inside the rack');
  ok(/@keyframes hapticKnock/.test(css) && /\.is-haptic\s*\{[^}]*animation:\s*hapticKnock/.test(css),
    'the haptic fallback is a real micro-animation, not just a class name');

  // The drawer has to win the stacking contest against the toast layer: a
  // leftover toast once sat exactly on its save row (docs/beta/26-…png).
  const zOf = (sel) => {
    const m = new RegExp('\\' + sel + '\\s*\\{[^}]*z-index:\\s*(\\d+)').exec(css);
    return m ? Number(m[1]) : NaN;
  };
  const toastZ = zOf('.toasts');
  ok(Number.isFinite(toastZ) && zOf('.sheet') > toastZ && zOf('.sheet-scrim') > toastZ,
    'the drawer and its scrim stack above the toast layer (' + zOf('.sheet') + '/' + zOf('.sheet-scrim')
      + ' vs ' + toastZ + ')');
  ok(/html\.sheet-open \.toasts\s*\{[^}]*opacity:\s*0/.test(css),
    'a toast that predates the drawer is hidden while it is open, not left on top of it');
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

  // seek(): the waveform click, the seek strip and the arrow keys all land
  // here, and the position must be clamped to the file rather than trusted
  engine.seek(1.25);
  ok(Math.abs(engine.position - 1.25) < 0.02, 'seek() moves the transport', engine.position.toFixed(3) + ' s');
  engine.seek(bufA.duration + 30);
  ok(engine.position === bufA.duration, 'a seek past the end lands on the last sample, not beyond it', engine.position.toFixed(3) + ' s');
  engine.seek(-4);
  ok(engine.position === 0, 'a seek before the start lands on zero', engine.position);
  const fresh = new EngineCtor();
  let threw = null;
  try { fresh.seek(5); } catch (e) { threw = e; }
  ok(threw === null, 'seek() before a buffer exists is a no-op, never a crash', threw && threw.message);
  ok(fresh.position === 0, 'and the position stays at zero', fresh.position);
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
  win.Worker = require('./encoding-worker-adapter.js');
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
    const card = App.State.cards[0];
    // The production WASM encoder boots in a real worker now. Await completion,
    // not the old 300 ms mainthread-lamejs timing assumption.
    const deadline = Date.now() + 15000;
    while (card.status !== 'done' && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
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

/* ---------------------------------------------------------------- inspector */

async function inspectorChecks() {
  section('app · the bottom-sheet inspector on a phone');
  {
    const win = boot(true);
    Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true });
    Object.defineProperty(win, 'innerHeight', { value: 844, configurable: true });
    const App = win.RSApp;
    await new Promise((r) => setTimeout(r, 30));
    await App.addFiles([wavFile(win, [tone(220, 3, SR), tone(220, 3, SR)], SR, 'inspector.wav')]);
    const card = App.State.cards[0];
    ok(!!card && !!card.el.grid, 'a card owns a grid element for its controls');

    const order = Array.from(card.el.grid.children).map((n) => n.className);
    const idx = (frag) => order.findIndex((c) => c.indexOf(frag) !== -1);
    ok(idx('field') === 0 && order.length === 4,
      'the grid holds exactly the four per-file blocks: profile, power, compare, save', order.join(' · '));
    ok(idx('field') === 0, 'they are already in the reading order the drawer needs');

    const homeIndex = Array.prototype.indexOf.call(card.el.card.children, card.el.grid);
    const opened = App.openInspector(card);
    ok(opened === true && App.sheet.isOpen() === true, 'opening the inspector presents the sheet');
    ok(win.document.getElementById('cardSheet').hidden === false
      && win.document.getElementById('cardSheetScrim').hidden === false,
      'both the panel and its scrim are on screen');
    ok(card.el.grid.parentNode === win.document.getElementById('cardSheetBody'),
      'the card\'s own grid moved into the drawer — not a copy of it');
    ok(!!card.el.grid.querySelector('[data-act="preset"]')
      && !!card.el.grid.querySelector('[data-act="power"]')
      && !!card.el.grid.querySelector('[data-act="ab"]')
      && !!card.el.grid.querySelector('[data-act="download"]'),
      'profile, power, the A/B pair and save are all inside the drawer');
    ok(card.el.card.classList.contains('is-inspected'), 'the card is marked as the one being inspected');

    const lock = {
      body: win.document.body.style.position,
      html: win.document.documentElement.classList.contains('sheet-open'),
      inert: win.document.querySelector('main').hasAttribute('inert'),
    };
    ok(lock.body === 'fixed' && lock.html === true,
      'the page behind is pinned, which is what actually stops iOS Safari scrolling it', lock.body);
    ok(lock.inert === true, 'everything outside the drawer is inert — out of the tab order and the a11y tree');
    ok(win.document.activeElement && win.document.activeElement.id === 'cardSheetClose',
      'focus moved into the sheet, onto its own close button');

    App.sheet.close();
    ok(App.sheet.isOpen() === false, 'closing dismisses it');
    ok(card.el.grid.parentNode === card.el.card
      && Array.prototype.indexOf.call(card.el.card.children, card.el.grid) === homeIndex,
      'the grid is back in exactly the slot it left', 'index ' + homeIndex);
    ok(win.document.body.style.position === ''
      && win.document.documentElement.classList.contains('sheet-open') === false,
      'the page is unlocked again');
    ok(win.document.querySelector('main').hasAttribute('inert') === false, 'and nothing is left inert');
    ok(!card.el.card.classList.contains('is-inspected'), 'the card is no longer marked');

    /* Every affordance closes it: the Done button, the scrim, and Escape. */
    App.openInspector(card);
    win.document.getElementById('cardSheetDone').click();
    ok(App.sheet.isOpen() === false, 'the Done button closes the drawer');

    App.openInspector(card);
    win.document.getElementById('cardSheetScrim').click();
    ok(App.sheet.isOpen() === false, 'a tap on the scrim closes it');

    App.openInspector(card);
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(App.sheet.isOpen() === false, 'Escape closes it');

    /* A tap on the card body is the convenience path; a tap on a control is not. */
    card.el.diagnosis.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    ok(App.sheet.isOpen() === true, 'tapping the card body opens the drawer');
    App.sheet.close();
    App.openInspector(card);
    App.sheet.close();
    card.el.preset.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    ok(App.sheet.isOpen() === false, 'tapping one of its controls does not — the gesture never steals a control');
    card.el.inspect.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    ok(App.sheet.isOpen() === true, 'the card\'s own settings button opens it too');
    App.sheet.close();

    /* A viewport that grows past the breakpoint must not leave a fixed panel
       hovering over a desktop layout. */
    App.openInspector(card);
    Object.defineProperty(win, 'innerWidth', { value: 1280, configurable: true });
    win.dispatchEvent(new win.Event('resize'));
    ok(App.sheet.isOpen() === false && App.sheet.isSmallViewport() === false,
      'resizing to a desktop width closes the drawer and returns the grid');

    /* Removing the card while its grid is in the sheet must not strand it. */
    Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true });
    App.openInspector(card);
    App.removeCard(card);
    ok(App.sheet.isOpen() === false && win.document.getElementById('cardSheetBody').children.length === 0,
      'removing the inspected card closes the drawer and empties its body');

    /* On a desktop the drawer is not offered at all. */
    const desk = boot(false);
    Object.defineProperty(desk, 'innerWidth', { value: 1440, configurable: true });
    await new Promise((r) => setTimeout(r, 30));
    await desk.RSApp.addFiles([wavFile(desk, [tone(220, 3, SR)], SR, 'desk.wav')]);
    const dCard = desk.RSApp.State.cards[0];
    ok(desk.RSApp.openInspector(dCard) === false && desk.RSApp.sheet.isOpen() === false,
      'a desktop never gets the phone drawer — its card already shows every control');
    ok(dCard.el.grid.parentNode === dCard.el.card, 'and the grid never moved');
  }

  section('app · haptic feedback on a platform without the Vibration API (iOS Safari)');
  {
    const win = boot(true);
    const App = win.RSApp;
    const UI = win.RSUI;
    const el = win.document.getElementById('btnMagicFix');
    ok(UI.hapticSupported() === false, 'jsdom has no navigator.vibrate — the same situation as iOS Safari');

    const mode = App.vibrate(16, el);
    ok(mode === 'visual' && el.classList.contains('is-haptic'),
      'the call falls back to a visible knock on the control', mode);
    ok(UI.pulse(el) === true && el.classList.contains('is-haptic'),
      'the animation can also be asked for on its own (UI.pulse)');
    await new Promise((r) => setTimeout(r, 520));
    ok(!el.classList.contains('is-haptic'), 'the class cleans itself up — no stuck animation');

    let seen = null;
    Object.defineProperty(win.navigator, 'vibrate', { value: (p) => { seen = p; return true; }, configurable: true });
    const buzz = App.vibrate([10, 20], el);
    ok(buzz === 'vibrate' && Array.isArray(seen) && seen[0] === 10,
      'where the API exists, it is the one used — no double feedback');
    ok(!el.classList.contains('is-haptic'), 'and the visual fallback stays off');

    Object.defineProperty(win.navigator, 'vibrate', { value: () => false, configurable: true });
    const refused = App.vibrate(10, el);
    ok(refused === 'visual' && el.classList.contains('is-haptic'),
      'a policy that refuses the vibration still gets the visual answer');
    Object.defineProperty(win.navigator, 'vibrate', { value: () => { throw new Error('blocked'); }, configurable: true });
    ok(App.vibrate(10, el) === 'visual', 'a throwing implementation is handled the same way');
    await new Promise((r) => setTimeout(r, 520));
  }
}

async function main() {
  staticChecks();
  await engineChecks();
  await appChecks();
  await inspectorChecks();

  console.log('\n' + '-'.repeat(60));
  console.log(failed ? failed + ' FAILED / ' + passed + ' passed' : 'ALL TESTS PASSED (' + passed + ')');
  if (failures.length) console.log('failed: ' + failures.join(', '));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nmobile-ux suite crashed:\n', err);
  process.exit(1);
});
