/* =============================================================================
 * Remaster Suite — interface layer
 * -----------------------------------------------------------------------------
 * Small helpers, toasts, dialogs, and the interactive A/B waveform canvas.
 * No framework: plain DOM, one rAF per redraw, device-pixel-ratio aware.
 * ========================================================================== */
(function (global) {
  'use strict';

  const doc = global.document;
  const t = (k, v) => (global.RSi18n ? global.RSi18n.t(k, v) : k);

  /* ------------------------------------------------------------------ helpers */

  const $ = (sel, root) => (root || doc).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || doc).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const n = doc.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === false || v === null || v === undefined) continue;
        if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'class') n.className = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v);
      }
    }
    (children || []).forEach((c) => { if (c) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return n;
  }

  /** Range inputs paint their own filled track through one CSS variable. */
  /* Texture for the two correction highlights: a hatch (removed clicks) and a dot
   * grid (lifted top end). Built once per kind from a small offscreen canvas. A
   * context that cannot make a pattern returns null, and the tint alone is drawn. */
  const MARK_PAT = {};
  /* Path2D where the browser has it; otherwise the rectangles are kept as a plain list and
   * replayed, so the drawing is the same either way. */
  const HAS_PATH2D = typeof global.Path2D === 'function';
  function rectPath() { return HAS_PATH2D ? new global.Path2D() : []; }
  function addRect(p, x, y, w, h) { if (HAS_PATH2D) p.rect(x, y, w, h); else p.push([x, y, w, h]); }
  function fillPath(g, p) {
    if (HAS_PATH2D) { g.fill(p); return; }
    g.beginPath();
    for (const r of p) g.rect(r[0], r[1], r[2], r[3]);
    g.fill();
  }
  function markPattern(g, kind) {
    if (kind in MARK_PAT) return MARK_PAT[kind];
    MARK_PAT[kind] = null;
    try {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const x = c.getContext('2d');
      if (!x || !g.createPattern) return null;
      if (kind === 'hatch') {
        x.strokeStyle = 'rgba(255,200,40,.9)'; x.lineWidth = 1.6;
        x.beginPath(); x.moveTo(-2, 8); x.lineTo(8, -2); x.moveTo(-2, 2); x.lineTo(2, -2); x.moveTo(6, 10); x.lineTo(10, 6); x.stroke();
      } else {
        x.fillStyle = 'rgba(64,200,255,.95)';
        x.beginPath(); x.arc(4, 4, 1.3, 0, Math.PI * 2); x.fill();
      }
      MARK_PAT[kind] = g.createPattern(c, 'repeat');
    } catch (e) { MARK_PAT[kind] = null; }
    return MARK_PAT[kind];
  }
  function paintRange(input) {
    const min = Number(input.min || 0), max = Number(input.max || 100);
    const v = Number(input.value);
    const pct = max === min ? 0 : ((v - min) / (max - min)) * 100;
    input.style.setProperty('--fill', String(pct));
  }

  function scoreColor(score) {
    if (score >= 80) return 'var(--green)';
    if (score >= 60) return 'var(--gold)';
    return 'var(--red)';
  }

  /* --------------------------------------------------------------- clipboard */

  async function copyText(text) {
    try {
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        await global.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to the legacy path */ }
    try {
      const ta = el('textarea', { style: 'position:fixed;top:-1000px;opacity:0' });
      ta.value = text;
      doc.body.appendChild(ta);
      ta.select();
      const ok = doc.execCommand && doc.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ toasts */

  let toastHost = null;
  function toast(message, kind, ms) {
    if (!doc) return null;
    if (!toastHost) toastHost = $('#toasts');
    if (!toastHost) return null;
    const node = el('div', { class: 'toast' + (kind ? ' is-' + kind : ''), text: message, role: 'status' });
    toastHost.appendChild(node);
    const kill = () => {
      node.classList.add('hide');
      global.setTimeout(() => node.remove(), 260);
    };
    node.addEventListener('click', kill);
    global.setTimeout(kill, ms || 3800);
    while (toastHost.children.length > 4) toastHost.firstChild.remove();
    return node;
  }

  /* ----------------------------------------------------------------- dialogs */

  function openDialog(id) {
    const d = typeof id === 'string' ? $(id) : id;
    if (!d) return;
    if (typeof d.showModal === 'function') {
      if (!d.open) { try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } }
    } else {
      d.setAttribute('open', '');
    }
    d.scrollTop = 0;
  }

  function closeDialog(d) {
    if (!d) return;
    if (typeof d.close === 'function' && d.open) { try { d.close(); } catch (e) { d.removeAttribute('open'); } }
    else d.removeAttribute('open');
  }

  function bindDialogs(root) {
    const scope = root || doc;
    $$('[data-dialog]', scope).forEach((btn) => {
      btn.addEventListener('click', () => openDialog('#' + btn.getAttribute('data-dialog')));
    });
    $$('dialog.dialog', scope).forEach((d) => {
      d.addEventListener('click', (ev) => { if (ev.target === d) closeDialog(d); });
    });
  }

  /* ------------------------------------------------- detailed analysis list */

  /**
   * A measured number, written the way a person reads it: locale decimal
   * separator, a sensible number of digits for the unit, and the sign that
   * belongs to a level in dB.
   */
  function formatValue(value, lang) {
    if (!value || !isFinite(value.n)) return '—';
    const de = lang === 'de';
    const num = (x, digits) => {
      const v = Math.abs(x) < 0.005 && x !== 0 ? 0 : x;
      const t2 = v.toFixed(digits === undefined ? 1 : digits);
      return de ? t2.replace('.', ',') : t2;
    };
    switch (value.unit) {
      case 'db': return (value.n > 0 ? '+' : '−') + num(Math.abs(value.n), 1) + ' dB';
      case 'hz':
        return value.n >= 1000
          ? num(value.n / 1000, value.n >= 10000 ? 1 : 1) + ' kHz'
          : num(value.n, 0) + ' Hz';
      case 'pct': return num(value.n * 100, value.n * 100 < 10 ? 1 : 0) + (de ? ' %' : ' %');
      case 'ms': return num(value.n, 0) + ' ms';
      case 's': return num(value.n, value.n < 10 ? 1 : 0) + ' s';
      case 'ratio': return num(value.n, 2);
      case 'dbtp': return (value.n > 0 ? '+' : '−') + num(Math.abs(value.n), 1) + ' dBTP';
      default: return num(value.n, 2);
    }
  }

  /**
   * The findings list of one file card. Built as DOM nodes — never as HTML
   * strings — so a measurement can never become markup, whatever a decoder
   * hands us.
   */
  function findingsList(recipe, lang) {
    const frag = doc.createDocumentFragment();
    for (const f of recipe.findings) {
      const cls = f.sev >= 0.5 ? 'is-severe' : f.sev >= 0.2 ? 'is-mild' : 'is-clear';
      const li = el('li', { class: 'finding ' + cls });
      li.appendChild(el('span', { class: 'finding-dot', 'aria-hidden': 'true' }));
      li.appendChild(el('span', { class: 'finding-label', text: t('find.' + f.key) }));
      if (f.value) li.appendChild(el('span', { class: 'finding-value', text: formatValue(f.value, lang) }));
      if (f.act) {
        const text = f.act.value
          ? t('find.act.' + f.act.key, { v: formatValue(f.act.value, lang) })
          : t('find.act.' + f.act.key);
        li.appendChild(el('span', { class: 'finding-act', text }));
      }
      frag.appendChild(li);
    }
    return frag;
  }

  /* ---------------------------------------------------------------- waveform */

  /**
   * Interactive A/B waveform. The untouched original is drawn mirrored above the
   * centre line, the restored version mirrored below it, so both are comparable
   * at a glance without hiding each other.
   */
  class Waveform {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.o = opts || {};
      this.before = null;
      this.after = null;
      this.duration = 0;
      this.position = 0;
      this.hover = -1;
      this._raf = 0;
      this._bind();
    }

    _bind() {
      const c = this.canvas;
      c.addEventListener('click', (ev) => this._seek(ev));
      c.addEventListener('pointerdown', (ev) => {
        c.setPointerCapture(ev.pointerId);
        this._seek(ev);
      });
      c.addEventListener('pointermove', (ev) => {
        const r = c.getBoundingClientRect();
        this.hover = (ev.clientX - r.left) / r.width;
        this.schedule();
      });
      c.addEventListener('pointerleave', () => { this.hover = -1; this.schedule(); });
      if (global.ResizeObserver) {
        this._ro = new global.ResizeObserver(() => this.schedule());
        this._ro.observe(c);
      } else {
        this._onResize = () => this.schedule();
        global.addEventListener('resize', this._onResize);
      }
      this._onVis = () => { if (!doc.hidden) this.schedule(); };
      doc.addEventListener('visibilitychange', this._onVis);
    }

    destroy() {
      if (this._raf) { global.cancelAnimationFrame(this._raf); this._raf = 0; }
      if (this._ro) { try { this._ro.disconnect(); } catch (e) { /* ignore */ } this._ro = null; }
      if (this._onResize) { global.removeEventListener('resize', this._onResize); this._onResize = null; }
      if (this._onVis && doc) { doc.removeEventListener('visibilitychange', this._onVis); this._onVis = null; }
    }

    _seek(ev) {
      if (!this.o.onSeek || !this.duration) return;
      const r = this.canvas.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      this.o.onSeek(f * this.duration);
    }

    setData(data) {
      this.before = data.before || this.before;
      this.after = data.after || this.after;
      // the highlights belong to one restoration: none without its render
      this.corrections = data.corrections || null;
      this.duration = data.duration || 0;
      this.schedule();
    }

    setPosition(seconds) {
      this.position = seconds;
      this.schedule();
    }

    schedule() {
      if (this._raf) return;
      this._raf = global.requestAnimationFrame(() => { this._raf = 0; this.draw(); });
    }

    /** Bars and correction columns for one size and one data set. Rebuilt only when the
     *  canvas size, the bar count, the envelopes or the correction map change. */
    geometry(w, h, n) {
      const G = this._geo;
      if (G && G.w === w && G.h === h && G.n === n && G.src === this.before
        && G.after === this.after && G.corr === this.corrections) return G;
      const mid = h / 2, half = mid - 4, px = w / n;
      const bw = Math.max(1, px * 0.92), cw = Math.max(1, px);
      const bars = (env, dir) => {
        const p = rectPath();
        for (let i = 0; i < n; i++) {
          const mag = Math.min(1, Math.max(Math.abs(env.max[i]), Math.abs(env.min[i])));
          const y = mid + dir * mag * half;
          addRect(p, i * px, Math.min(mid, y), bw, Math.max(1, Math.abs(mid - y)));
        }
        return p;
      };
      const columns = (flags) => {
        const p = rectPath();
        if (flags) for (let i = 0; i < n && i < flags.length; i++) if (flags[i]) addRect(p, i * px, 0, cw, h);
        return p;
      };
      const corr = this.corrections;
      this._geo = {
        w, h, n, src: this.before, after: this.after, corr,
        before: bars(this.before, -1),
        after: this.after ? bars(this.after, 1) : null,
        bright: columns(corr && corr.bright),
        clicks: columns(corr && corr.clicks),
      };
      return this._geo;
    }

    draw() {
      const c = this.canvas;
      if (!c || !c.classList) return;
      const dpr = global.devicePixelRatio || 1;
      const w = Math.max(80, c.clientWidth || 600);
      const h = Math.max(60, c.clientHeight || 132);
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const g = c.getContext && c.getContext('2d');
      if (!g) return;                       // headless / canvas-less environments
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const mid = h / 2;

      // baseline + frame
      g.strokeStyle = 'rgba(255,255,255,.07)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, mid + 0.5);
      g.lineTo(w, mid + 0.5);
      g.stroke();

      const hasData = this.before && this.before.max && this.before.max.length;
      if (!hasData) return;

      const n = this.before.max.length;
      const progressX = this.duration ? (this.position / this.duration) * w : 0;
      // the bars and the correction columns are geometry: built once per data set and
      // size (see geometry()), so a playhead move only fills them again
      const geo = this.geometry(w, h, n);

      const drawSide = (path, style, styleBright, dir) => {
        g.fillStyle = style;
        fillPath(g, path);
        g.fillStyle = styleBright;
        g.save();
        g.beginPath();
        g.rect(0, dir > 0 ? mid : 0, progressX, dir > 0 ? h - mid : mid);
        g.clip();
        fillPath(g, path);
        g.restore();
      };

      // corrections: the columns the restoration changed, lifted behind both
      // halves so the eye finds them before it reads the waves. Gold is a click
      // taken out; cyan is top end that was lifted where there is content.
      if (this.corrections) {
        // the tint carries the colour; the pattern carries the meaning for a
        // reader who cannot tell gold from cyan (hatch = click, dots = top end)
        const lift = (path, colour, kind) => {
          g.fillStyle = colour;
          fillPath(g, path);
          const pat = markPattern(g, kind);
          if (!pat) return;
          g.fillStyle = pat;
          fillPath(g, path);
        };
        lift(geo.bright, 'rgba(64,200,255,.16)', 'dots');
        lift(geo.clicks, 'rgba(255,200,40,.26)', 'hatch');
      }

      // original: above the line, muted grey until played, off-white after
      drawSide(geo.before, 'rgba(124,132,146,.55)', 'rgba(240,242,245,.9)', -1);
      if (this.after) {
        // restored: below the line, green dim / gradient bright once played
        drawSide(geo.after, 'rgba(0,180,110,.35)', 'rgba(0,230,118,.95)', 1);
      }

      // hover marker
      if (this.hover >= 0) {
        g.strokeStyle = 'rgba(255,255,255,.18)';
        g.beginPath();
        g.moveTo(this.hover * w, 0);
        g.lineTo(this.hover * w, h);
        g.stroke();
      }

      // playhead
      if (this.duration) {
        const x = Math.max(0, Math.min(w, progressX));
        g.strokeStyle = '#ffd700';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
      }
    }
  }

  /* ------------------------------------------------------------- formatters */

  function formatTime(seconds) {
    return global.RSCodecs ? global.RSCodecs.formatDuration(seconds) : Math.round(seconds) + 's';
  }

  /**
   * The small metrics strip: quality score plus the numbers that matter, each
   * with a before → after arrow once the file has been processed.
   */
  function chipsFrom(before, after) {
    const C = global.RSCodecs;
    const out = [];
    if (!before) return out;
    const fmtDb = (v) => (isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(1) + ' dB' : '—');
    const fmtRate = (v) => (v ? C.formatRate(v, global.RSi18n.lang) : '—');

    const item = (label, a, b, cls) => {
      const node = el('li', { class: 'chip' + (cls ? ' ' + cls : '') });
      node.appendChild(el('span', { text: label + ': ' }));
      node.appendChild(el('b', { text: a }));
      if (b !== undefined && b !== null && b !== a) {
        node.appendChild(el('span', { text: ' → ' }));
        node.appendChild(el('b', { text: b }));
      }
      return node;
    };

    const a = before;
    const b = after || null;
    const scoreTxt = b ? String(b.score) : String(a.score);
    const scoreNode = el('li', { class: 'chip chip-score' });
    scoreNode.appendChild(el('span', { text: t('chip.score') + ': ' }));
    scoreNode.appendChild(el('b', { text: a.score + (b ? ' → ' + scoreTxt : '') }));
    scoreNode.appendChild(el('span', { text: ' / 100' }));
    out.push(scoreNode);

    out.push(item(t('chip.peak'), fmtDb(a.peakDb), b ? fmtDb(b.peakDb) : null));
    out.push(item(t('chip.hf'), fmtRate(a.hfCutoff), b ? fmtRate(b.hfCutoff) : null));
    out.push(item(t('chip.noise'), fmtDb(a.noiseFloorDb), b ? fmtDb(b.noiseFloorDb) : null));
    out.push(item(t('chip.dynamics'),
      (isFinite(a.dynamicRangeDb) ? a.dynamicRangeDb.toFixed(1) : '—') + ' dB',
      b && isFinite(b.dynamicRangeDb) ? b.dynamicRangeDb.toFixed(1) + ' dB' : null));
    if (a.channels > 1) {
      const fmtC = (v) => (isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(2) : '—');
      out.push(item(t('chip.width'), fmtC(a.correlation), b ? fmtC(b.correlation) : null));
    }
    if (a.clipRatio > 0.0002) {
      const fmtP = (v) => (v * 100).toFixed(3) + ' %';
      out.push(item(t('chip.clip'), fmtP(a.clipRatio), b ? fmtP(b.clipRatio) : null));
    }
    return out;
  }

  /**
   * One sentence in plain language: what was heard and what will be done.
   * No jargon, no numbers — those live in the chips.
   */
  function diagnosisText(diag) {
    if (!diag) return '';
    const kind = t('kind.' + (diag.id === 'general' && diag.issues[0] === 'healthy' ? 'healthy' : diag.id));
    const issues = (diag.issues || [])
      .filter((k) => k !== 'healthy')
      .map((k) => t('issue.' + k))
      .join(', ');
    // Several problems at once is the normal case, not the exception — a 1970s
    // record that was ripped from vinyl and then compressed to 128 kbit/s is
    // three problems, and the sentence says so instead of naming whichever one
    // won the vote.
    const chain = (diag.chain || []).filter((k) => k !== 'general');
    let s = chain.length > 1
      ? t('diag.leadMix', { kinds: chain.slice(0, 2).map((k) => t('kind.short.' + k)).join(' + ') })
      : t('diag.lead', { kind: kind });
    if (issues) s += t('diag.issues', { issues: issues });
    else s += t('diag.clean');
    if (diag.confidence) s += t('diag.confident', { p: Math.round(Math.min(1, diag.confidence) * 100) });
    return s;
  }

  const API = {
    formatValue, findingsList,
    $, $$, el, paintRange, scoreColor, copyText, toast, openDialog, closeDialog, bindDialogs,
    Waveform, formatTime, chipsFrom, diagnosisText,
  };
  global.RSUI = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
