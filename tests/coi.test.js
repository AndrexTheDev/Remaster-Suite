/* =============================================================================
 * Remaster Suite — cross-origin isolation bootstrap test suite
 * -----------------------------------------------------------------------------
 * `coi-serviceworker.js` plays two roles in one file, picked by whether
 * `window` exists. Both are exercised here with a Node `vm` context standing
 * in for, respectively, a ServiceWorkerGlobalScope and a page `window` —
 * the exact file shipped to the browser, not a paraphrase of it.
 *
 * Run:  node tests/coi.test.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./harness.js');

const ROOT = H.ROOT;
const SRC = fs.readFileSync(path.join(ROOT, 'coi-serviceworker.js'), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label + (detail ? '  → ' + detail : '')); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label + '  → ' + (detail === undefined ? 'failed' : detail)); }
}
function section(name) { console.log('\n▸ ' + name); }

async function run() {
  section('static · the file exists and stays dependency-free');
  {
    ok(SRC.length > 500, 'the file has real content', SRC.length + ' bytes');
    ok(!/https?:\/\//.test(SRC), 'no remote host is ever contacted');
    ok(/Cross-Origin-Opener-Policy/.test(SRC) && /same-origin/.test(SRC), 'sets COOP: same-origin');
    ok(/Cross-Origin-Embedder-Policy/.test(SRC) && /require-corp/.test(SRC), 'sets COEP: require-corp');
    ok(!/console\.(log|debug)|debugger|TODO|FIXME/.test(SRC), 'no debug leftovers');
  }

  /* ------------------------------------------------------- Service Worker ---- */
  section('as a Service Worker · rewrites same-origin responses');
  {
    const events = {};
    const fakeSelf = {
      addEventListener(type, fn) { events[type] = fn; },
    };
    const sandbox = {
      self: fakeSelf,
      Headers, Response, Promise, console,
      fetch: async () => new Response('hello', { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' } }),
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'coi-serviceworker.js (worker)' });

    ok(typeof events.install === 'function' && typeof events.activate === 'function' && typeof events.fetch === 'function',
      'install/activate/fetch listeners are registered');

    let responded = null;
    const fakeEvent = {
      request: { cache: 'default', mode: 'navigate' },
      respondWith(p) { responded = p; },
    };
    events.fetch(fakeEvent);
    const response = await responded;
    ok(response.headers.get('Cross-Origin-Opener-Policy') === 'same-origin', 'COOP header is set on the rewritten response');
    ok(response.headers.get('Cross-Origin-Embedder-Policy') === 'require-corp', 'COEP header is set on the rewritten response');
    ok(response.status === 200, 'the original status survives the rewrite');
    ok(await response.text() === 'hello', 'the original body survives the rewrite');
  }

  section('as a Service Worker · leaves cross-origin only-if-cached requests alone');
  {
    const events = {};
    const sandbox = {
      self: { addEventListener(type, fn) { events[type] = fn; } },
      Headers, Response, Promise, console,
      fetch: async () => { throw new Error('must not be called'); },
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'coi-serviceworker.js (worker-2)' });
    let touched = false;
    events.fetch({ request: { cache: 'only-if-cached', mode: 'no-cors' }, respondWith() { touched = true; } });
    ok(!touched, 'the cache-only cross-origin edge case is left untouched (would throw in a real browser)');
  }

  /* ------------------------------------------------------------ page script */
  section('as a page script · already isolated → no registration, no reload');
  {
    const store = {};
    const sandbox = {
      window: null,
      console,
      Promise,
    };
    sandbox.window = {
      crossOriginIsolated: true,
      navigator: { serviceWorker: {} },
      isSecureContext: true,
      sessionStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
      },
      document: { currentScript: null },
      location: { reload() { throw new Error('must not reload when already isolated'); } },
    };
    sandbox.self = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'coi-serviceworker.js (page-isolated)' });
    const info = await sandbox.window.RSCOI.ready;
    ok(info.isolated === true && info.needsReload === false, 'reports isolated with no reload needed');
  }

  section('as a page script · no Service Worker support → reports unsupported, never reloads');
  {
    const sandbox = { console, Promise };
    sandbox.window = {
      crossOriginIsolated: false,
      navigator: {},
      isSecureContext: true,
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: { currentScript: null },
      location: { reload() { throw new Error('must not reload'); } },
    };
    sandbox.self = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'coi-serviceworker.js (page-unsupported)' });
    const info = await sandbox.window.RSCOI.ready;
    ok(info.needsReload === false && info.reason === 'unsupported', 'no Service Worker API → unsupported, no reload attempted');
  }

  section('as a page script · fresh registration asks for exactly one reload');
  {
    const store = {};
    let registeredUrl = null;
    const sandbox = { console, Promise };
    sandbox.window = {
      crossOriginIsolated: false,
      navigator: {
        serviceWorker: {
          controller: null,
          register: async (url) => { registeredUrl = url; return { active: null }; },
        },
      },
      isSecureContext: true,
      sessionStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
      },
      document: { currentScript: { src: 'https://remaster.local/coi-serviceworker.js' } },
      location: { reload() { this.reloaded = true; } },
    };
    sandbox.self = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'coi-serviceworker.js (page-fresh)' });
    const info = await sandbox.window.RSCOI.ready;
    ok(info.needsReload === true, 'a fresh, uncontrolled registration asks for a reload');
    ok(registeredUrl === 'https://remaster.local/coi-serviceworker.js', 'registers the script at its own URL (root scope)');
    ok(!sandbox.window.location.reloaded, 'the reload does not happen on its own — the app must confirm it');
    info.confirmReload();
    ok(sandbox.window.location.reloaded === true, 'confirmReload() performs exactly the one reload');
    ok(store['rs-coi-reloaded'] === '1', 'the reload is flagged so a second attempt this session is skipped');
  }

  section('as a page script · will not loop-reload within the same tab session');
  {
    const store = { 'rs-coi-reloaded': '1' };
    const sandbox = { console, Promise };
    sandbox.window = {
      crossOriginIsolated: false,
      navigator: { serviceWorker: { controller: null, register: async () => ({ active: null }) } },
      isSecureContext: true,
      sessionStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
      },
      document: { currentScript: null },
      location: { reload() { throw new Error('must not reload a second time'); } },
    };
    sandbox.self = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'coi-serviceworker.js (page-already-tried)' });
    const info = await sandbox.window.RSCOI.ready;
    ok(info.needsReload === false && info.reason === 'already-tried', 'a second attempt this session is reported, not acted on');
  }

  console.log('\n' + '-'.repeat(60));
  if (failed) {
    console.log('FAILED ' + failed + ' / ' + (passed + failed) + ':\n  - ' + failures.join('\n  - '));
    process.exitCode = 1;
  } else {
    console.log('ALL TESTS PASSED (' + passed + ')');
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
