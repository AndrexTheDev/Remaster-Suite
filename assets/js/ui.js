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
        global.addEventListener('resize', () => this.schedule());
      }
      const onVis = () => { if (!doc.hidden) this.schedule(); };
      doc.addEventListener('visibilitychange', onVis);
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
      const half = mid - 4;

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
      const px = w / n;
      const progressX = this.duration ? (this.position / this.duration) * w : 0;

      const drawSide = (env, dir, style, styleBright) => {
        g.fillStyle = style;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          const mag = Math.min(1, Math.max(Math.abs(env.max[i]), Math.abs(env.min[i])));
          const x = i * px;
          const bw = Math.max(1, px * 0.92);
          const y = mid + dir * mag * half;
          g.rect(x, Math.min(mid, y), bw, Math.max(1, Math.abs(mid - y)));
        }
        g.fill();
        g.fillStyle = styleBright;
        g.save();
        g.beginPath();
        g.rect(0, dir > 0 ? mid : 0, progressX, dir > 0 ? h - mid : mid);
        g.clip();
        g.beginPath();
        for (let i = 0; i < n; i++) {
          const mag = Math.min(1, Math.max(Math.abs(env.max[i]), Math.abs(env.min[i])));
          const x = i * px;
          const bw = Math.max(1, px * 0.92);
          const y = mid + dir * mag * half;
          g.rect(x, Math.min(mid, y), bw, Math.max(1, Math.abs(mid - y)));
        }
        g.fill();
        g.restore();
      };

      // original: above the line, muted grey until played, off-white after
      drawSide(this.before, -1, 'rgba(124,132,146,.55)', 'rgba(240,242,245,.9)');
      if (this.after) {
        // restored: below the line, green dim / gradient bright once played
        drawSide(this.after, 1, 'rgba(0,180,110,.35)', 'rgba(0,230,118,.95)');
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
    let s = t('diag.lead', { kind: kind });
    if (issues) s += t('diag.issues', { issues: issues });
    else s += t('diag.clean');
    if (diag.confidence) s += t('diag.confident', { p: Math.round(Math.min(1, diag.confidence) * 100) });
    return s;
  }

  const API = {
    $, $$, el, paintRange, scoreColor, copyText, toast, openDialog, closeDialog, bindDialogs,
    Waveform, formatTime, chipsFrom, diagnosisText,
  };
  global.RSUI = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
