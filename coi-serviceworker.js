/* =============================================================================
 * Remaster Suite — cross-origin isolation bootstrap
 * -----------------------------------------------------------------------------
 * Plain static hosting (GitHub Pages, `python -m http.server`, any file
 * server with no header config) cannot send the two response headers that
 * `crossOriginIsolated` — and therefore `SharedArrayBuffer` — require:
 *
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * This one file plays both roles needed to get them anyway, chosen by
 * whether it is executing as a normal page `<script>` or as the Service
 * Worker that script registers:
 *
 *   • page script → registers itself as a Service Worker (scope: the whole
 *     origin, because the file lives at the site root), then exposes
 *     `window.RSCOI` so the app can show a short notice before the one
 *     reload that is unavoidable: a Service Worker only controls pages
 *     *after* it is activated, so the current, uncontrolled page cannot
 *     become isolated without a fresh navigation.
 *   • Service Worker → rewrites every same-origin response to carry the two
 *     headers above before handing it back to the page.
 *
 * Approach popularised by gzuidhof/coi-serviceworker (MIT) — reimplemented
 * from scratch here to match this project's no-build, fully-audited module
 * style and to integrate with its own toast/i18n system instead of an alert.
 * Harmless to run twice; a no-op once the browser is already isolated.
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------- Service Worker ---
   * This branch runs with no `window` — it IS the worker, loaded via
   * navigator.serviceWorker.register() below. */
  if (typeof window === 'undefined') {
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener('message', (event) => {
      if (event.data === 'rs-coi-deregister') {
        event.waitUntil(
          self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => {
            clients.forEach((c) => c.navigate(c.url));
          })
        );
      }
    });

    self.addEventListener('fetch', (event) => {
      const req = event.request;
      // touching a cross-origin "only-if-cached" request throws — let it pass
      if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

      event.respondWith(
        fetch(req).then((response) => {
          // opaque (no-cors cross-origin) and error responses cannot be
          // reconstructed with new headers — pass them through untouched
          if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') {
            return response;
          }
          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }).catch((err) => new Response(
          'Remaster Suite isolation worker: fetch failed (' + ((err && err.message) || err) + ')',
          { status: 503, statusText: 'rs-coi fetch failed' }
        ))
      );
    });
    return;
  }

  /* ------------------------------------------------------------ page script */
  const w = window;
  const nav = w.navigator;
  const RELOAD_FLAG = 'rs-coi-reloaded';

  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  w.RSCOI = {
    /** Resolves once registration has been attempted, with whether a single
     * reload is still needed to actually pick up the new headers. */
    ready,
    isIsolated() { return !!w.crossOriginIsolated; },
    hasSharedArrayBuffer() { return typeof w.SharedArrayBuffer === 'function'; },
    /** Perform the one guarded reload — called by the app only after it has
     * had a chance to show a short notice. */
    reloadNow() { w.location.reload(); },
  };

  if (w.crossOriginIsolated) {
    // already isolated (real server headers, or a controlling SW from a
    // previous visit) — the reload flag from a past attempt is now stale
    try { w.sessionStorage.removeItem(RELOAD_FLAG); } catch (e) { /* ignore */ }
    resolveReady({ isolated: true, needsReload: false });
    return;
  }

  if (!nav || !('serviceWorker' in nav) || !w.isSecureContext) {
    // no Service Worker support, or served over plain http(s) without TLS —
    // SharedArrayBuffer simply will not be available here; the app already
    // treats that as an optional speed-up, never a hard requirement
    resolveReady({ isolated: false, needsReload: false, reason: 'unsupported' });
    return;
  }

  const scriptEl = w.document.currentScript;
  const swUrl = (scriptEl && scriptEl.src) || 'coi-serviceworker.js';

  nav.serviceWorker.register(swUrl, { scope: './' }).then((reg) => {
    if (nav.serviceWorker.controller) {
      // a worker is already controlling us but we are still not isolated —
      // headers changed or a previous registration failed; nothing more a
      // reload can fix on its own, so just report the state honestly
      resolveReady({ isolated: false, needsReload: false, reason: 'controller-without-isolation' });
      return;
    }
    let reloaded = false;
    try { reloaded = w.sessionStorage.getItem(RELOAD_FLAG) === '1'; } catch (e) { /* ignore */ }
    if (reloaded) {
      // already tried once this tab session — avoid a reload loop if the
      // browser never ends up isolated (e.g. the SW failed to activate)
      resolveReady({ isolated: false, needsReload: false, reason: 'already-tried' });
      return;
    }
    resolveReady({
      isolated: false,
      needsReload: true,
      registration: reg,
      confirmReload: () => {
        try { w.sessionStorage.setItem(RELOAD_FLAG, '1'); } catch (e) { /* ignore */ }
        w.RSCOI.reloadNow();
      },
    });
  }).catch((err) => {
    resolveReady({ isolated: false, needsReload: false, reason: 'register-failed', error: err });
  });
})();
