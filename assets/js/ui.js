/* =============================================================================
 * Remaster Suite — interface layer
 * -----------------------------------------------------------------------------
 * Small helpers, toasts, dialogs, and the interactive A/B waveform canvas.
 * No framework: plain DOM, one rAF per redraw, device-pixel-ratio aware.
 * ========================================================================== */
/**
 * @fileoverview Interface layer — exposed as the global `RSUI`
 * (`globalThis.RSUI`).
 *
 * Small DOM helpers, toasts, `<dialog>` plumbing, the findings list, the metric
 * chips and the interactive A/B waveform canvas. No framework, one
 * `requestAnimationFrame` per redraw, device-pixel-ratio aware.
 *
 * Two rules hold everywhere in this file and are enforced by the audit suite:
 * markup is built out of DOM nodes, never out of HTML strings (the one
 * exception is the caller-supplied `html` attribute of {@link RSUI.el}, which
 * only ever receives our own translated strings), and every user-visible word
 * comes from `RSi18n` rather than from a literal.
 *
 * @module RSUI
 */
(function (global) {
  'use strict';

  const doc = global.document;
  /**
   * Translate, with a fallback for the module-isolation case: in the Node
   * suites `RSi18n` may not be loaded, and showing the key beats throwing.
   * @param {string} k - dictionary key, e.g. a `chip.*` or `find.*` entry.
   * @param {Object<string, (string|number)>} [v] - template values for `{x}`
   *   placeholders in the string.
   * @returns {string} the translated text, or `k` itself when RSi18n is absent.
   */
  const t = (k, v) => (global.RSi18n ? global.RSi18n.t(k, v) : k);

  /* ------------------------------------------------------------------ helpers */

  /**
   * `querySelector` with a scope, short enough to sit in a guard clause.
   * @param {string} sel - CSS selector.
   * @param {(Document|Element)} [root=document] - scope to search in.
   * @returns {Element|null} the first match, or `null`.
   */
  const $ = (sel, root) => (root || doc).querySelector(sel);
  /**
   * `querySelectorAll` as a real array, so callers can `map`/`filter` on it
   * without a `NodeList` conversion each time.
   * @param {string} sel - CSS selector.
   * @param {(Document|Element)} [root=document] - scope to search in.
   * @returns {Element[]} every match, in document order.
   */
  const $$ = (sel, root) => Array.prototype.slice.call((root || doc).querySelectorAll(sel));

  /**
   * Create one element. Attributes are applied in this order of precedence:
   * `text` sets `textContent`, `html` sets the markup (only ever called with
   * our own translated strings), `class` sets `className`, any key starting
   * with `on` becomes an event listener for the rest of the key
   * (`onClick` → `click`), and everything else goes through `setAttribute`.
   * `false`, `null` and `undefined` values are skipped, so a caller can write
   * `{'aria-pressed': on && 'true'}`.
   * @param {string} tag - element name, e.g. `'li'`, `'span'`, `'textarea'`.
   * @param {Object<string, (string|number|boolean|Function)>} [attrs] - the
   *   attribute map described above.
   * @param {Array<(Node|string|null)>} [children] - appended in order; strings
   *   become text nodes and falsy entries are skipped.
   * @returns {Element} the new element, not yet attached to the document.
   */
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

  /**
   * Repaint a range input's filled track. The fill is one CSS custom property
   * (`--fill`, in percent) rather than a background image per browser, so the
   * slider keeps its native behaviour and stays keyboard-accessible.
   * @param {HTMLInputElement} input - the range input; `min`/`max` are read
   *   with the HTML defaults (`0`/`100`) when absent.
   * @returns {void}
   */
  function paintRange(input) {
    const min = Number(input.min || 0), max = Number(input.max || 100);
    const v = Number(input.value);
    const pct = max === min ? 0 : ((v - min) / (max - min)) * 100;
    input.style.setProperty('--fill', String(pct));
  }

  /**
   * Traffic-light colour for a sound-quality score, as a CSS variable rather
   * than a literal colour, so the palette stays in one place.
   * @param {number} score - sound-quality score, 0…100.
   * @returns {string} `'var(--green)'` for 80+, `'var(--gold)'` for 60+, and
   *   `'var(--red)'` below that.
   */
  function scoreColor(score) {
    if (score >= 80) return 'var(--green)';
    if (score >= 60) return 'var(--gold)';
    return 'var(--red)';
  }

  /* --------------------------------------------------------------- clipboard */

  /**
   * Copy text to the clipboard, modern API first and a hidden textarea with
   * `execCommand('copy')` as the fallback for older browsers.
   * @param {string} text - what to copy (a tip address, a diagnosis line).
   * @returns {Promise<boolean>} `true` when a clipboard write really happened;
   *   `false` when both paths are unavailable or refused (which is what the
   *   caller turns into a toast) — never rejects.
   */
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

  /**
   * The toast container (`#toasts`), looked up once and remembered.
   * @type {Element|null}
   */
  let toastHost = null;
  /**
   * Show a short toast. Clicking it dismisses it immediately; it also removes
   * itself after `ms`. At most four toasts are kept on screen — a batch render
   * that fails ten times in a row must not paper the page.
   * @param {string} message - already-translated text.
   * @param {string} [kind] - `'ok'`, `'warn'`, `'error'`, … becomes the
   *   `is-<kind>` class that colours the toast.
   * @param {number} [ms=3800] - how long it stays before fading out.
   * @returns {Element|null} the toast node (callers size animations against
   *   it), or `null` when there is no document or no toast host.
   */
  function toast(message, kind, ms) {
    if (!doc) return null;
    if (!toastHost) toastHost = $('#toasts');
    if (!toastHost) return null;
    const node = el('div', { class: 'toast' + (kind ? ' is-' + kind : ''), text: message, role: 'status' });
    toastHost.appendChild(node);
    /** Cancel the pending repaint, if one is scheduled. */
    const kill = () => {
      node.classList.add('hide');
      global.setTimeout(() => node.remove(), 260);
    };
    node.addEventListener('click', kill);
    global.setTimeout(kill, ms || 3800);
    while (toastHost.children.length > 4) toastHost.firstChild.remove();
    return node;
  }

  /* ------------------------------------------------------- model download */

  /**
   * The progress row a model download draws itself in: `#modelProgress` and
   * its fill. Kept here rather than in `app.js` because it is pure DOM — the
   * caller decides *what* is happening, this decides what the bar shows.
   *
   * It is deliberately the same `.work-track`/`.work-fill` pair the per-card
   * render bars use: a second progress-bar look would be a second thing to
   * keep consistent, and the whole point of the row is that a download looks
   * like every other piece of work the app does.
   * @typedef {Object} ModelLoader
   * @property {function({ratio: number, text: (string|undefined)}): (Element|null)} update
   * @property {function(string=): (Element|null)} done
   * @property {function(string=): (Element|null)} fail
   * @property {function(): void} reset
   * @property {function(): (Element|null)} node
   */

  /**
   * Clamp a ratio into 0…1 and turn it into a width. A NaN (a download with
   * no known total that has not received anything yet) is 0, not "NaN %".
   * @param {number} ratio - the raw share.
   * @returns {string} a CSS width, e.g. `'42.0%'`.
   */
  function ratioWidth(ratio) {
    const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
    return (r * 100).toFixed(1) + '%';
  }

  /** @type {ModelLoader} */
  const modelLoader = {
    /**
     * Show the row and paint one step. Creates nothing: the markup is in
     * `index.html`, so a page without it (the Node suites) simply gets `null`.
     * @param {{ratio: number, text: (string|undefined)}} p - the step.
     * @returns {Element|null} the row, or `null` when there is no document or
     *   no markup for it.
     */
    update(p) {
      if (!doc) return null;
      const box = $('#modelProgress');
      if (!box) return null;
      const step = p || { ratio: 0 };
      box.hidden = false;
      box.classList.remove('is-done', 'is-failed');
      const bar = $('#modelProgressBar');
      const pct = $('#modelProgressPct');
      const text = $('#modelProgressText');
      const track = $('#modelProgressTrack');
      if (bar) bar.style.width = ratioWidth(step.ratio);
      if (pct) pct.textContent = Math.round((Number.isFinite(step.ratio) ? Math.max(0, Math.min(1, step.ratio)) : 0) * 100) + ' %';
      if (text && step.text) text.textContent = step.text;
      if (track) track.setAttribute('aria-valuenow', String(Math.round((Number.isFinite(step.ratio) ? Math.max(0, Math.min(1, step.ratio)) : 0) * 100)));
      return box;
    },

    /**
     * Paint the finished state and fade the row out. The 100 % frame is shown
     * first on purpose — a bar that vanishes at 97 % looks like a failure.
     * @param {string} [text] - the final label.
     * @returns {Element|null} the row.
     */
    done(text) {
      const box = this.update({ ratio: 1, text });
      if (!box) return null;
      box.classList.add('is-done');
      global.setTimeout(() => { if (box.isConnected) box.hidden = true; }, 1200);
      return box;
    },

    /**
     * Park the bar at whatever it reached, mark it failed and hide it: a
     * failed download must not leave a half-full bar on the page implying
     * that it is still working.
     * @param {string} [text] - the failure label.
     * @returns {Element|null} the row.
     */
    fail(text) {
      if (!doc) return null;
      const box = $('#modelProgress');
      if (!box) return null;
      if (text) {
        const label = $('#modelProgressText');
        if (label) label.textContent = text;
      }
      box.classList.add('is-failed');
      global.setTimeout(() => { if (box.isConnected) { box.hidden = true; box.classList.remove('is-failed', 'is-done'); } }, 1600);
      return box;
    },

    /**
     * Hide the row and forget the last state, so the next download starts at
     * zero rather than at whatever the previous one finished on.
     * @returns {void}
     */
    reset() {
      if (!doc) return;
      const box = $('#modelProgress');
      if (!box) return;
      box.hidden = true;
      box.classList.remove('is-done', 'is-failed');
      const bar = $('#modelProgressBar');
      if (bar) bar.style.width = '0%';
      const pct = $('#modelProgressPct');
      if (pct) pct.textContent = '0 %';
    },

    /**
     * The row element itself, for callers that want to measure it.
     * @returns {Element|null} `#modelProgress`.
     */
    node() { return doc ? $('#modelProgress') : null; },
  };

  /* ----------------------------------------------------------------- dialogs */

  /**
   * Open a `<dialog>` by node or by selector, scrolling it back to the top.
   * `showModal()` is preferred because it traps focus; a browser without it
   * falls back to the `open` attribute, which is exactly what the audit's
   * no-`showModal` probe expects.
   * @param {(string|Element)} id - selector such as `'#dlgHelp'`, or the
   *   dialog node itself.
   * @returns {void}
   */
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

  /**
   * Close a dialog: `close()` when the browser has it, otherwise drop the
   * `open` attribute. Safe to call on `null` and on an already-closed dialog.
   * @param {Element|null} d - the dialog node.
   * @returns {void}
   */
  function closeDialog(d) {
    if (!d) return;
    if (typeof d.close === 'function' && d.open) { try { d.close(); } catch (e) { d.removeAttribute('open'); } }
    else d.removeAttribute('open');
  }

  /**
   * Wire every dialog trigger and backdrop click inside `root`: any element
   * carrying `data-dialog="<id>"` opens that dialog, and a click on a dialog's
   * own backdrop (the event target *is* the dialog) closes it.
   * @param {(Document|Element)} [root=document] - scope to bind within; a card
   *   inserted later can be bound on its own subtree only.
   * @returns {void}
   */
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
   * A number paired with the unit it is measured in — the shape every value in
   * a diagnosis recipe travels in.
   * @typedef {Object} MeasuredValue
   * @property {number} n - the numeric value, already in the unit below.
   * @property {('db'|'hz'|'pct'|'ms'|'s'|'ratio'|'dbtp')} unit - how to render it;
   *   `pct` is a 0…1 fraction, everything else is already scaled.
   */

  /**
   * A measured number, written the way a person reads it: locale decimal
   * separator (`3,5` in German, `3.5` in English), a sensible number of digits
   * for the unit, the typographic minus in dB signs, and an em dash for a value
   * that is missing or not finite.
   * @param {MeasuredValue} value - the number and its unit.
   * @param {string} lang - `'de'` or `'en'`; only the decimal separator and
   *   the percent spacing differ.
   * @returns {string} the formatted value, e.g. `'−3,2 dB'` or `'8,5 kHz'`.
   */
  function formatValue(value, lang) {
    if (!value || !isFinite(value.n)) return '—';
    const de = lang === 'de';
    /**
     * Format a number for a human: fixed digits, and the locale's decimal
     * separator. Values that round to zero are shown as zero (never `-0,0`).
     * @param {number} x - the value.
     * @param {number} [digits] - decimal places, default 1.
     * @returns {string} the formatted number without its unit.
     */
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
   * One line of a diagnosis recipe, before it is translated.
   * @typedef {Object} Finding
   * @property {string} key - `find.*` dictionary key naming the finding.
   * @property {number} sev - severity, 0…1; ≥ 0.5 paints as severe, ≥ 0.2 as
   *   mild, below that as clear (all classes come from the stylesheet).
   * @property {MeasuredValue} [value] - the measured number, when it adds
   *   something to the sentence.
   * @property {{key: string, value: MeasuredValue=}} [act] - what the chain
   *   will do about it, as a `find.act.*` key plus optional value.
   */

  /**
   * The findings list of one file card. Built as DOM nodes — never as HTML
   * strings — so a measurement can never become markup, whatever a decoder
   * hands us.
   * @param {{findings: Finding[]}} recipe - the diagnosis recipe.
   * @param {string} lang - `'de'` or `'en'`, passed through to
   *   {@link RSUI.formatValue}.
   * @returns {DocumentFragment} one `<li class="finding …">` per finding,
   *   ready to append to the card's list.
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
   * Callbacks and behaviour of a {@link RSUI.Waveform} canvas.
   * @typedef {Object} WaveformOptions
   * @property {function(number): void} [onSeek] - called with the target
   *   position in seconds when the user clicks or drags on the canvas; absent
   *   means the canvas is a pure display.
   */

  /**
   * The envelope pair drawn on one card's canvas, plus the timeline it lives on.
   * @typedef {Object} WaveformData
   * @property {RSAnalyzer.Envelope} [before] - envelope of the original.
   * @property {RSAnalyzer.Envelope} [after] - envelope of the restored file;
   *   absent until the render finished, which is why the lower half stays
   *   empty before that.
   * @property {number} [duration] - timeline length in seconds; playhead and
   *   seek positions are scaled by it.
   */

  /**
   * Interactive A/B waveform. The untouched original is drawn mirrored above the
   * centre line, the restored version mirrored below it, so both are comparable
   * at a glance without hiding each other: the played part of each half is
   * drawn bright, the unplayed part muted, and a gold playhead marks the
   * position. Redraws are coalesced into one animation frame per change, and
   * the backing store is sized in device pixels (`devicePixelRatio`), so the
   * canvas stays sharp on a phone and cheap on a 4K desktop.
   *
   * Instances are owned by one card; {@link RSUI.Waveform#destroy} releases
   * every listener and observer it installed, which is what the card list does
   * when a file is removed.
   */
  class Waveform {
    /**
     * @param {HTMLCanvasElement} canvas - the card's canvas; it is resized to
     *   its CSS box times the device pixel ratio on every draw.
     * @param {WaveformOptions} [opts] - see {@link WaveformOptions}.
     */
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

    /**
     * Install the interaction, resize and visibility listeners. A
     * `ResizeObserver` is used where available; otherwise a window `resize`
     * listener does the same job, and `destroy()` knows which one to remove.
     * @private
     * @returns {void}
     */
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

    /**
     * Release everything this instance installed: the pending animation frame,
     * the resize observer or listener, and the visibility listener. After this
     * the instance is inert; calling it twice is safe.
     * @returns {void}
     */
    destroy() {
      if (this._raf) { global.cancelAnimationFrame(this._raf); this._raf = 0; }
      if (this._ro) { try { this._ro.disconnect(); } catch (e) { /* ignore */ } this._ro = null; }
      if (this._onResize) { global.removeEventListener('resize', this._onResize); this._onResize = null; }
      if (this._onVis && doc) { doc.removeEventListener('visibilitychange', this._onVis); this._onVis = null; }
    }

    /**
     * Turn a pointer event into a timeline position and hand it to `onSeek`.
     * Ignored while there is no data or no callback, and clamped to the ends,
     * so a click on the padding cannot seek past the file.
     * @private
     * @param {MouseEvent} ev - a click or pointerdown/pointermove event.
     * @returns {void}
     */
    _seek(ev) {
      if (!this.o.onSeek || !this.duration) return;
      const r = this.canvas.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      this.o.onSeek(f * this.duration);
    }

    /**
     * Hand the canvas its envelopes and timeline length. Fields that are
     * missing or falsy keep their previous value, so the restored envelope can
     * be added later without resending the original.
     * @param {WaveformData} data - the envelopes and duration.
     * @returns {void}
     */
    setData(data) {
      this.before = data.before || this.before;
      this.after = data.after || this.after;
      this.duration = data.duration || 0;
      this.schedule();
    }

    /**
     * Move the playhead. Called from the audio elements' `timeupdate` as well
     * as on every seek; the redraw is coalesced, so a burst of calls costs one
     * frame.
     * @param {number} seconds - current playback position in seconds.
     * @returns {void}
     */
    setPosition(seconds) {
      this.position = seconds;
      this.schedule();
    }

    /**
     * Ask for a redraw, at most one per animation frame: the first call
     * schedules it, every call until then is merged into it.
     * @returns {void}
     */
    schedule() {
      if (this._raf) return;
      this._raf = global.requestAnimationFrame(() => { this._raf = 0; this.draw(); });
    }

    /**
     * Paint the canvas: baseline, both envelope halves (played part bright,
     * unplayed part muted), the hover marker and the gold playhead. Silent and
     * harmless when there is no canvas, no 2D context or no data yet — a
     * headless DOM must be able to call this without a guard.
     * @returns {void}
     */
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

      /**
       * Draw one half of the mirrored envelope — upwards or downwards — in the
       * given colour, using the brighter colour for the part that is playing.
       * @param {RSUI.Envelope} env - the envelope to draw.
       * @param {number} dir - `-1` upwards, `1` downwards.
       * @param {string} style - CSS colour for the unplayed part.
       * @param {string} styleBright - CSS colour for the played part.
       * @returns {void}
       */
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

  /**
   * Format a duration the way the rest of the app does — through the codecs'
   * own formatter when it is loaded, so a time is never written two ways in
   * one screenshot.
   * @param {number} seconds - duration in seconds.
   * @returns {string} `'3:12'`-style text, or `'42s'` when `RSCodecs` is not
   *   loaded (the Node suites).
   */
  function formatTime(seconds) {
    return global.RSCodecs ? global.RSCodecs.formatDuration(seconds) : Math.round(seconds) + 's';
  }

  /**
   * The small metrics strip: quality score plus the numbers that matter, each
   * with a before → after arrow once the file has been processed. Rows whose
   * value does not apply (no clipping, a mono file with no stereo width) are
   * left out entirely rather than shown as zero.
   * @param {RSAnalyzer.Chips} before - the measurement of the original file.
   * @param {RSAnalyzer.Chips|null} [after] - the measurement of the rendered
   *   file; `null` before the render, which is what turns the arrows on.
   * @returns {Element[]} `<li>` nodes for the chips row, in display order.
   */
  function chipsFrom(before, after) {
    const C = global.RSCodecs;
    const out = [];
    if (!before) return out;
    /**
     * A signed dB value for a chip, with an em dash when it is missing.
     * @param {number} v - the value in dB.
     * @returns {string} the text.
     */
    const fmtDb = (v) => (isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(1) + ' dB' : '—');
    /**
     * A sample rate for a chip, in the active language.
     * @param {number} v - the rate in Hz; `0` means "no ceiling measured".
     * @returns {string} the text.
     */
    const fmtRate = (v) => (v ? C.formatRate(v, global.RSi18n.lang) : '—');

    /**
     * One chip: a label, the file's own value, and — when the render changed
     * it — an arrow and the value after the repair.
     * @param {string} label - the chip's label, already translated.
     * @param {string} a - the value before the repair.
     * @param {?string} [b] - the value after it, or `null`/equal for none.
     * @param {string} [cls] - extra class for the chip.
     * @returns {Element} the `<li>` node.
     */
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
      /**
       * A signed correlation value for the width chip.
       * @param {number} v - the correlation, −1…1.
       * @returns {string} the text.
       */
      const fmtC = (v) => (isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(2) : '—');
      out.push(item(t('chip.width'), fmtC(a.correlation), b ? fmtC(b.correlation) : null));
    }
    if (a.clipRatio > 0.0002) {
      /**
       * A clipped fraction as a percentage — three decimals, because clipping
       * is interesting well below one percent.
       * @param {number} v - the fraction, 0…1.
       * @returns {string} the text.
       */
      const fmtP = (v) => (v * 100).toFixed(3) + ' %';
      out.push(item(t('chip.clip'), fmtP(a.clipRatio), b ? fmtP(b.clipRatio) : null));
    }
    return out;
  }

  /**
   * One sentence in plain language: what was heard and what will be done.
   * No jargon, no numbers — those live in the chips. Several problems at once
   * is the normal case, not the exception, so the lead sentence names up to two
   * of them instead of pretending there is only one.
   * @param {RSPresets.Diagnosis} diag - the diagnosis to phrase; a missing one
   *   yields an empty string rather than a crash mid-render.
   * @returns {string} the translated sentence.
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

  /**
   * The public surface, assigned to `global.RSUI` below.
   * @typedef {Object} RSUIApi
   * @property {function(MeasuredValue, string): string} formatValue
   * @property {function(Object, string): DocumentFragment} findingsList
   * @property {function(string, (Document|Element)=): (Element|null)} $
   * @property {function(string, (Document|Element)=): Element[]} $$
   * @property {function(string, Object=, Array=): Element} el
   * @property {function(HTMLInputElement): void} paintRange
   * @property {function(number): string} scoreColor
   * @property {function(string): Promise<boolean>} copyText
   * @property {function(string, string=, number=): (Element|null)} toast
   * @property {function((string|Element)): void} openDialog
   * @property {function(Element|null): void} closeDialog
   * @property {function((Document|Element)=): void} bindDialogs
   * @property {function(new: Waveform, HTMLCanvasElement, WaveformOptions=)} Waveform
   * @property {function(number): string} formatTime
   * @property {function(RSAnalyzer.Chips, ?RSAnalyzer.Chips=): Element[]} chipsFrom
   * @property {function(RSPresets.Diagnosis): string} diagnosisText
   * @property {ModelLoader} modelLoader - the model-download progress row.
   */

  /** @type {RSUIApi} */
  const API = {
    formatValue, findingsList,
    $, $$, el, paintRange, scoreColor, copyText, toast, openDialog, closeDialog, bindDialogs,
    Waveform, formatTime, chipsFrom, diagnosisText, modelLoader,
  };
  /** @type {RSUIApi} */
  global.RSUI = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
