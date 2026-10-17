/* =============================================================================
 * Minimal Chrome DevTools Protocol client over the platform WebSocket.
 * Everything the beta suite needs: one page, one browser endpoint, screenshots,
 * console capture, downloads. No npm dependency beyond Node ≥ 22.
 * ========================================================================== */
'use strict';

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message + (m.error.data ? ' · ' + String(m.error.data).slice(0, 200) : '')));
        else p.res(m.result);
      } else if (m.method) {
        for (const h of this.handlers.get(m.method) || []) h(m.params);
      }
    });
  }
  send(method, params) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  close() { try { this.ws.close(); } catch { /* done */ } }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('cannot open ' + url));
  });
  return new CDP(ws);
}

/** wait until the DevTools HTTP endpoint answers */
async function waitDevtools(port, ms) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (r.ok) return r.json();
    } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error('DevTools endpoint never came up');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** find the page target created by the caller and connect to it */
async function pageForTarget(port, targetId, ms) {
  const t0 = Date.now();
  for (;;) {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const t = list.find((e) => e.id === targetId && e.webSocketDebuggerUrl);
    if (t) return connect(t.webSocketDebuggerUrl);
    if (Date.now() - t0 > ms) throw new Error('target ' + targetId + ' has no debugger url');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Race an operation against diagnostics, cancelling the deadline on BOTH
 * success and rejection. Promise.race alone leaves thousands of stale timers
 * issuing DevTools requests a minute after successful polling has finished. */
async function withDeadline(operation, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => {
        Promise.resolve().then(onTimeout).then(
          () => reject(new Error('Operation timed out')), reject);
      }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

module.exports = { CDP, connect, waitDevtools, pageForTarget, withDeadline };
