/* =============================================================================
 * Remaster Suite — application glue
 * -----------------------------------------------------------------------------
 * Drop → listen → compare → save. This file owns the state, the sequential
 * (memory-friendly) processing queue and every piece of wiring between the
 * engine, the analyser and the DOM.
 * ========================================================================== */
(function (global) {
  'use strict';

  const UI = global.RSUI;
  const Codecs = global.RSCodecs;
  const Presets = global.RSPresets;
  const Analyzer = global.RSAnalyzer;
  const Engine = global.RSEngine;
  const OPFS = global.RSOPFS;

  const $ = UI.$;
  const $$ = UI.$$;
  const t = (k, v) => global.RSi18n.t(k, v);

  /* ------------------------------------------------------------------- config */

  /** Touch-first device? Decides the copy, the wake lock and the memory budget. */
  function isTouchDevice() {
    try {
      if (global.matchMedia && global.matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
    } catch (e) { /* no matchMedia: fall through */ }
    return !!(global.navigator && global.navigator.maxTouchPoints > 0);
  }

  /**
   * Read the pointer again — a phone that gets a keyboard, a tablet that is
   * rotated, a desktop window that is resized onto a touch screen. The wording
   * and the memory budget follow; nothing is decided once and forever.
   */
  function applyPointer() {
    const touch = isTouchDevice();
    State.touch = touch;
    CONFIG.softMemoryMB = touch ? 420 : 900;
    return touch;
  }

  const CONFIG = {
    previewSeconds: 40,        // live A/B window; the full file is rendered on save
    previewMin: 12,
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    // a phone browser has far less room for a ZIP full of WAVs than a desktop
    softMemoryMB: isTouchDevice() ? 420 : 900,
    maxLiveTools: 120,
  };

  /* -------------------------------------------------------------------- state */

  const State = {
    cards: [],
    seq: 1,
    power: 0.70,
    preset: 'auto',
    ab: 'restored',
    format: 'wav',
    mp3Rate: 320,
    wavDepth: 16,
    busy: false,
    powerTouched: false,
    touch: false,
    job: null,
    // set once `RSOPFS.isSupported()` resolves (see `initStreaming()`); while
    // it is still pending, batch rendering uses the safe in-memory path
    opfsReady: false,
  };

  /* ------------------------------------------------------- OPFS scratch I/O */

  /**
   * Detect the Origin Private File System once at boot and sweep any scratch
   * files a previous, crashed tab might have left behind — OPFS persists
   * across reloads, unlike a plain JS heap, so it needs this one bit of
   * housekeeping that in-memory buffers never did.
   */
  async function initStreaming() {
    if (!OPFS) return;
    try {
      State.opfsReady = await OPFS.isSupported();
    } catch (e) {
      State.opfsReady = false;
    }
    if (State.opfsReady) OPFS.resetScratch();
  }

  /** A fresh, collision-free OPFS scratch key for this card's next render. */
  function renderKeyFor(card) {
    card._renderSeq = (card._renderSeq || 0) + 1;
    return 'render-' + card.id + '-' + card._renderSeq;
  }

  /** Drop a card's previous rendered file from OPFS before replacing it. */
  async function forgetRender(card) {
    if (!OPFS || !card.result || !card.result.opfsKey) return;
    await OPFS.remove(card.result.opfsKey);
  }

  /* ------------------------------------------------------------- formatting */

  const P = {
    resolvedPreset(card) {
      const wanted = card.preset || State.preset;
      if (wanted !== 'auto') return wanted;
      if (card.analysis && card.analysis.preset) return card.analysis.preset;
      return 'auto';
    },
    power(card) {
      return card.power === null || card.power === undefined ? State.power : card.power;
    },
    params(card) {
      const resolved = P.resolvedPreset(card);
      const metrics = (card.analysis && card.analysis.metrics) || null;
      const power = P.power(card);
      if (!metrics) return null;
      const params = Presets.buildParams(resolved, metrics, power);
      params.bypass = 0;                       // A/B is handled separately
      params.autoLevel = 1;
      /* A lossy export pays the encoder's own overshoot out of the ceiling: the
       * promise is about the file the user keeps, not about the render (measured
       * through this path — the 128 kbit/s export of a dense master came back
       * 2.0 dB over its ceiling and was named `truePeak` on its own re-upload,
       * tools/work/tp2.js). The monitor builds its parameters here too, so what
       * you hear is still what you save, at every format and bitrate; a ceiling
       * that was switched off (0) stays off. */
      if (params.tpCeil < 0) params.tpCeil -= Presets.codecMargin(State.format, State.mp3Rate);
      return params;
    },
    signature(card) {
      const fmt = State.format;
      return [P.resolvedPreset(card), P.power(card).toFixed(3), fmt,
        fmt === 'mp3' ? State.mp3Rate : State.wavDepth].join('|');
    },
    exportRate(card) {
      const sr = (card.analysis && card.analysis.sampleRate) || 44100;
      if (State.format === 'mp3') return Codecs.mp3RateFor(sr);
      return Math.max(8000, Math.min(96000, Math.round(sr)));
    },
  };

  /* ------------------------------------------------------------------ helpers */

  function isAudioFile(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf('audio') === 0) return true;
    return /\.(mp3|wav|wave|flac|ogg|oga|opus|m4a|mp4|aac|aif|aiff|webm|weba|wma|alac)$/i.test(file.name || '');
  }

  function setStatus(card, status, note) {
    card.status = status;
    const pill = card.el.pill;
    if (pill) {
      const key = 'status.' + status;
      const label = t(key);
      if (label !== key && status !== 'rendering') { pill.textContent = label; pill.hidden = false; }
      else if (status === 'rendering') { pill.textContent = t('status.processing'); pill.hidden = false; }
      pill.className = 'pill' + (status === 'done' || status === 'ready' ? ' is-ok'
        : status === 'error' ? ' is-bad' : ' is-busy');
    }
    if (note !== undefined) setNote(card, note);
    if (card.el.card) card.el.card.classList.toggle('is-ready', status === 'ready' || status === 'done');
  }

  function setNote(card, text, isError) {
    const n = card.el.note;
    if (!n) return;
    if (!text) { n.hidden = true; n.textContent = ''; return; }
    n.hidden = false;
    n.textContent = text;
    n.classList.toggle('is-error', !!isError);
  }

  /* ---------------------------------------------------------------- progress */

  const nowMs = () => (global.performance && global.performance.now ? global.performance.now() : Date.now());

  /** The stage words. Referenced literally so the translation audit sees them. */
  const STAGE_TEXT = {
    wait: () => t('work.wait'),
    decode: () => t('work.decode'),
    // `measure` is the analyzer's word for the measurement slice, `analyze` the
    // card's word for "the analysis has started" — the user sees one stage.
    measure: () => t('work.analyze'),
    analyze: () => t('work.analyze'),
    diagnose: () => t('work.diagnose'),
    window: () => t('work.window'),
    envelope: () => t('work.envelope'),
    preview: () => t('work.preview'),
    render: () => t('work.render'),
    encode: () => t('work.encode'),
    zip: () => t('work.zip'),
  };
  const stageText = (stage) => (STAGE_TEXT[stage] ? STAGE_TEXT[stage]() : t('work.wait'));

  /** "noch ~12 s" / "noch ~3 min" — deliberately coarse, never fake-precise. */
  function timeLeftText(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 90) return t('work.eta', { s: Math.max(1, Math.round(seconds)) });
    return t('work.etaMin', { m: Math.max(2, Math.round(seconds / 60)) });
  }

  /** Seconds left at the current rate — 0 when that cannot be estimated yet. */
  function estimateLeft(card, p) {
    const t0 = card && card._workT0;
    if (!t0 || !p || p >= 1) return 0;
    const elapsed = (nowMs() - t0) / 1000;
    const left = (elapsed * (1 - p)) / p;
    return left > 1 && left < 3 * 3600 ? left : 0;
  }

  /** Give the browser one frame to paint — before a long, blocking step starts. */
  const nextPaint = () => new Promise((resolve) => {
    const raf = global.requestAnimationFrame || ((fn) => global.setTimeout(fn, 16));
    raf(() => resolve());
  });

  /**
   * Paint one card's progress. `p === null` means "running, but not measurable"
   * (decoding a file happens inside the browser's decodeAudioData) — the bar
   * then animates instead of inventing a percentage.
   */
  function setCardWork(card, stage, p, etaSeconds) {
    const el = card.el;
    const busy = !!stage;
    const known = p !== null && p !== undefined;
    card.progress = known ? Math.max(0, Math.min(1, p)) : 0;
    if (!busy) card._workT0 = 0;
    else if (!card._workT0) card._workT0 = nowMs();
    if (el.work) {
      el.work.hidden = !busy;
      el.work.classList.toggle('is-indeterminate', busy && !known);
      if (busy) {
        const pct = known ? Math.round(card.progress * 100) : null;
        el.stage.textContent = stageText(stage);
        el.pct.textContent = pct === null ? '' : t('ui.percent', { v: pct });
        el.bar.style.width = (pct === null ? 0 : pct) + '%';
        el.bar.classList.toggle('is-error', card.status === 'error');
        if (el.track) el.track.setAttribute('aria-valuenow', String(pct === null ? 0 : pct));
        el.eta.textContent = etaSeconds ? timeLeftText(etaSeconds) : '';
      }
    }
    // the status pill keeps the short state word — with the percentage while a
    // file is being written, because that is the number people watch
    if (busy && card.status === 'processing' && known && card.el.pill) {
      card.el.pill.textContent = t('status.rendering', { p: Math.round(card.progress * 100) });
      card.el.pill.hidden = false;
    }
    // …and the job bar follows the card that is currently in the queue
    if (State.job && State.job.card === card) {
      if (busy && !known) Job.unknown(stage);
      else Job.at(card.progress, stage);
    }
  }

  const clearCardWork = (card) => setCardWork(card, null, 0, 0);

  /**
   * Keep the screen awake while a long job runs: a phone that dims the display
   * can suspend the tab and stall the queue mid-file. Best effort — the API is
   * optional and the work still finishes if it is missing.
   */
  const Wake = {
    lock: null,
    async request() {
      if (this.lock) return;
      const wl = global.navigator && global.navigator.wakeLock;
      if (!wl || !wl.request) return;
      try { this.lock = await wl.request('screen'); } catch (e) { this.lock = null; }
    },
    async release() {
      const lock = this.lock;
      this.lock = null;
      if (!lock) return;
      try { await lock.release(); } catch (e) { /* already gone */ }
    },
  };

  /**
   * The job bar: one honest line for "what is running, how far, how long".
   * A queue of files reports per file; a ZIP reports as a whole.
   */
  const Job = {
    start(total, card) {
      State.job = {
        total: Math.max(1, total), index: 0, name: (card && card.name) || '',
        card: card || null, stage: 'wait', p: 0, t0: nowMs(), indeterminate: false,
      };
      Wake.request();
      paintJob();
    },
    file(index, name, card) {
      if (!State.job) return;
      State.job.index = Math.max(0, index);
      State.job.name = name || '';
      if (card !== undefined) State.job.card = card;
      State.job.p = 0;
      State.job.indeterminate = false;
      paintJob();
    },
    at(p, stage) {
      if (!State.job) return;
      State.job.indeterminate = false;
      State.job.p = Math.max(0, Math.min(1, p || 0));
      if (stage) State.job.stage = stage;
      paintJob();
    },
    /**
     * The step that is running cannot be counted (the browser's own decode, a
     * ZIP write) — the bar sweeps instead of sitting frozen at the last number.
     * The percentage keeps showing the last thing we could actually measure.
     */
    unknown(stage) {
      if (!State.job) return;
      State.job.indeterminate = true;
      if (stage) State.job.stage = stage;
      paintJob();
    },
    end() {
      State.job = null;
      const wrap = $('#globalProgress');
      if (wrap) wrap.hidden = true;
      Wake.release();
    },
  };

  function paintJob() {
    const job = State.job;
    const wrap = $('#globalProgress');
    if (!wrap || !job) return;
    wrap.hidden = false;
    const overall = Math.max(0, Math.min(1, (job.index + job.p) / job.total));
    const pct = Math.round(overall * 100);
    const fill = $('#globalProgressFill');
    const label = $('#globalProgressText');
    const pctOut = $('#globalProgressPct');
    const track = $('#globalProgressTrack');
    wrap.classList.toggle('is-indeterminate', !!job.indeterminate);
    // an animated fill has no width of its own — the stylesheet sweeps it
    if (fill) fill.style.width = job.indeterminate ? '' : pct + '%';
    if (pctOut) pctOut.textContent = t('ui.percent', { v: pct });
    if (track) track.setAttribute('aria-valuenow', String(pct));
    // one line that answers "which file" first, then "what is it doing": a queue
    // names the file it is on, a single save names that file, and the batch-wide
    // steps (packing the ZIP) only have the stage to show.
    let text;
    if (job.total > 1) {
      text = t('job.file', { i: Math.min(job.index + 1, job.total), n: job.total, name: job.name || '…' })
        + ' · ' + stageText(job.stage);
    } else if (job.name) {
      text = job.name + ' · ' + stageText(job.stage);
    } else {
      text = stageText(job.stage);
    }
    const left = estimateJobLeft(job, overall);
    if (left) text += ' · ' + timeLeftText(left);
    if (label) { label.textContent = text; label.title = text; }
  }

  function estimateJobLeft(job, overall) {
    if (!overall || overall <= 0.02) return 0;
    const elapsed = (nowMs() - job.t0) / 1000;
    const left = (elapsed * (1 - overall)) / overall;
    return left > 1.5 && left < 3 * 3600 ? left : 0;
  }

  if (global.document) {
    global.document.addEventListener('visibilitychange', () => {
      // coming back to a running job: re-acquire what the browser dropped
      if (!global.document.hidden && (State.job || State.busy)) Wake.request();
    });
  }

  function totalBytesOf(list) {
    let bytes = 0;
    for (const c of list) {
      if (!c.result) continue;
      bytes += c.result.bytes ? c.result.bytes.length : (c.result.size || 0);
    }
    return bytes;
  }

  /* ------------------------------------------------------------ card building */

  function createCard(file) {
    const tpl = $('#cardTpl');
    const node = tpl.content.firstElementChild.cloneNode(true);
    const card = {
      id: State.seq++,
      file,
      name: file.name || 'audio',
      size: file.size || 0,
      status: 'queued',
      power: null,
      preset: null,
      loop: false,
      analysis: null,
      after: null,
      previewBuffer: null,
      result: null,
      progress: 0,
      error: null,
      el: {
        card: node,
        name: $('[data-slot="name"]', node),
        meta: $('[data-slot="meta"]', node),
        pill: $('[data-slot="status"]', node),
        diagnosis: $('[data-slot="diagnosis"]', node),
        chips: $('[data-slot="chips"]', node),
        analysis: $('[data-slot="analysis"]', node),
        analysisCount: $('[data-slot="analysisCount"]', node),
        analysisLead: $('[data-slot="analysisLead"]', node),
        findings: $('[data-slot="findings"]', node),
        canvas: $('[data-slot="wave"]', node),
        waveEmpty: $('[data-slot="waveEmpty"]', node),
        window: $('[data-slot="window"]', node),
        seek: $('[data-slot="seek"]', node),
        time: $('[data-slot="time"]', node),
        preset: $('[data-slot="preset"]', node),
        power: $('[data-act="power"]', node),
        powerOut: $('[data-slot="power"]', node),
        work: $('[data-slot="work"]', node),
        stage: $('[data-slot="stage"]', node),
        eta: $('[data-slot="eta"]', node),
        pct: $('[data-slot="pct"]', node),
        track: $('[data-slot="track"]', node),
        bar: $('[data-slot="bar"]', node),
        note: $('[data-slot="note"]', node),
      },
    };

    card.el.name.textContent = card.name;
    card.el.name.title = card.name;
    card.el.meta.textContent = Codecs.formatBytes(card.size, global.RSi18n.lang);

    // preset choices inside the card (short labels)
    const short = { auto: 'preset.auto.short', garage: 'preset.garage', vinyl: 'preset.vinyl', cassette: 'preset.cassette', lowbitrate: 'preset.lowbitrate', general: 'preset.general' };
    for (const id of Presets.PRESET_ORDER) {
      card.el.preset.appendChild(UI.el('option', { value: id, text: t(short[id] || 'preset.general') }));
    }
    card.el.preset.value = 'auto';
    card.el.power.value = Math.round(State.power * 100);
    UI.paintRange(card.el.power);
    card.el.powerOut.textContent = t('ui.percent', { v: Math.round(State.power * 100) });

    card.wave = new UI.Waveform(card.el.canvas, {
      onSeek: async (sec) => {
        await ensurePlaying(card);
        Engine.seek(sec);
      },
    });

    const playBtn = $('[data-act="play"]', node);
    if (playBtn) playBtn.setAttribute('aria-label', t('card.play'));
    wireCard(card);
    setStatus(card, 'queued');
    clearCardWork(card);
    refreshCardText(card);
    return card;
  }

  function refreshCardText(card) {
    const a = card.analysis;
    if (!a) { setNote(card, t('note.decode')); return; }
    card.el.meta.textContent = t('meta.line', {
      dur: Codecs.formatDuration(a.duration),
      ch: a.channels > 1 ? 'Stereo' : 'Mono',
      sr: Codecs.formatRate(a.sampleRate, global.RSi18n.lang),
      size: Codecs.formatBytes(card.size, global.RSi18n.lang),
    });
    card.el.diagnosis.innerHTML = UI.diagnosisText(a.diag);
    const chips = UI.chipsFrom(card.analysis.chips, card.after ? card.after.chips : null);
    card.el.chips.textContent = '';
    for (const c of chips) card.el.chips.appendChild(c);
    refreshAnalysis(card);
    if (card.analysis.window) {
      card.el.window.textContent = t('card.window', {
        a: Math.round(card.analysis.window.start),
        b: Math.round(card.analysis.window.end),
      });
    }
    const fmtLabel = State.format === 'mp3' ? 'MP3' : 'WAV';
    if (card.status === 'ready') setNote(card, t('note.realtime'));
    if (card.status === 'done') setNote(card, t('note.done', { fmt: fmtLabel }));
    // the restored half of the waveform, when we have it
    const data = {
      before: card.analysis.windowEnvelope,
      after: card.after ? card.after.envelope : null,
      duration: card.analysis.window ? card.analysis.window.seconds : card.analysis.duration,
    };
    card.wave.setData(data);
  }

  /**
   * The detailed analysis panel: every finding, the number it was measured at,
   * and the dose the file will really get — recomputed whenever the parameters
   * change, because the doses are what it shows.
   */
  function refreshAnalysis(card) {
    const box = card.el && card.el.analysis;
    if (!box) return;
    const a = card.analysis;
    if (!a || !a.metrics) { box.hidden = true; return; }
    const params = P.params(card);
    const r = Presets.recipe(a.metrics, params, P.power(card));
    card.recipe = r;
    box.hidden = false;
    card.el.analysisCount.textContent = r.headline.count === 1
      ? t('card.findOne')
      : t('card.findMany', { n: r.headline.count });
    card.el.analysisLead.textContent = t('card.analysisLead', {
      char: t('char.' + r.character),
      severe: r.headline.severe,
    });
    card.el.findings.textContent = '';
    card.el.findings.appendChild(UI.findingsList(r, global.RSi18n.lang));
  }

  /* -------------------------------------------------------------- card wiring */

  function wireCard(card) {
    const node = card.el.card;

    $('[data-act="remove"]', node).addEventListener('click', () => removeCard(card));

    $('[data-act="play"]', node).addEventListener('click', () => {
      if (State.current === card && Engine.playing) Engine.pause();
      else ensurePlaying(card);
    });

    $('[data-act="loop"]', node).addEventListener('click', (ev) => {
      card.loop = !card.loop;
      ev.currentTarget.classList.toggle('is-active', card.loop);
      if (State.current === card) Engine.setLoop(card.loop);
    });

    $('[data-act="preset"]', node).addEventListener('change', (ev) => {
      card.preset = ev.target.value;
      onCardParamsChanged(card);
    });

    const power = card.el.power;
    power.addEventListener('input', () => {
      card.power = Number(power.value) / 100;
      card.el.powerOut.textContent = t('ui.percent', { v: power.value });
      UI.paintRange(power);
      onCardParamsChanged(card, true);
    });
    power.addEventListener('change', () => onCardParamsChanged(card, false, true));

    $$('[data-act="ab"] button', node).forEach((btn) => {
      btn.addEventListener('click', () => {
        setAB(btn.getAttribute('data-ab'));
        if (State.current !== card) ensurePlaying(card);
      });
    });

    $('[data-act="download"]', node).addEventListener('click', () => saveCard(card));
    $('[data-act="retry"]', node).addEventListener('click', () => prepareCard(card, true));

    const seek = $('[data-act="seek"]', node);
    const scrub = async (ev) => {
      if (!card.analysis) return;
      const r = seek.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      await ensurePlaying(card);
      Engine.seek(f * card.analysis.window.seconds);
    };
    seek.addEventListener('pointerdown', (ev) => { seek.setPointerCapture(ev.pointerId); scrub(ev); });
    seek.addEventListener('pointermove', (ev) => { if (ev.buttons) scrub(ev); });
    seek.addEventListener('keydown', async (ev) => {
      if (!card.analysis) return;
      const step = 2;
      if (ev.key === 'ArrowRight') { ev.preventDefault(); await ensurePlaying(card); Engine.seek(Engine.position + step); }
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); await ensurePlaying(card); Engine.seek(Math.max(0, Engine.position - step)); }
    });
  }

  /** Called whenever the per-file preset or power changes. */
  function onCardParamsChanged(card, live, final) {
    if (!card.analysis) return;
    if (State.current === card) applyLiveParams(card);
    if (live) {
      clearTimeout(card._previewTimer);
      card._previewTimer = setTimeout(() => refreshPreview(card), 420);
    } else if (final !== false) {
      refreshPreview(card);
    }
    if (card.result && card.result.signature !== P.signature(card)) {
      card.result.stale = true;
      if (card.status === 'done') setStatus(card, 'ready');
    }
  }

  /** Re-render only the preview window so the waveform matches the sliders. */
  async function refreshPreview(card) {
    if (!card.analysis || !card.analysisWindowChannels) return;
    const params = P.params(card);
    if (!params) return;
    try {
      // even a 40 s window takes a moment on a phone: say what is happening
      const slow = card.analysis.duration > 180;
      if (slow) { card._workT0 = nowMs(); setCardWork(card, 'preview', 0); }
      const res = await Engine.render(card.analysisWindowChannels, card.analysis.sampleRate, params, {
        progressSteps: slow ? 12 : 0,
        onProgress: slow ? (p) => setCardWork(card, 'preview', p, estimateLeft(card, p)) : undefined,
      });
      if (slow) clearCardWork(card);
      const env = Analyzer.envelope(res.channels, card.analysis.windowEnvelope.max.length);
      card.after = { envelope: env, chips: Analyzer.analyzeChannels(res.channels, res.sampleRate).chips };
      refreshCardText(card);
    } catch (err) { /* preview refresh is best effort */ }
  }

  /* ------------------------------------------------------------ live playback */

  function applyLiveParams(card) {
    const params = P.params(card);
    if (!params) return;
    Engine.applyParams(params);
    Engine.setBypass(State.ab === 'original');
    Engine.setCompare(State.ab === 'compare');
  }

  async function ensurePlaying(card) {
    if (!card.previewBuffer) { UI.toast(t('toast.needDecode'), 'bad'); return; }
    try {
      await Engine.init();
    } catch (err) {
      UI.toast(err && err.message === 'worklet-load-failed' ? t('toast.workletFail') : t('toast.engineFail'), 'bad', 7000);
      return;
    }
    if (State.current !== card) {
      State.current = card;
      Engine.setBuffer(card.previewBuffer, { start: 0, end: card.previewBuffer.duration });
      Engine.setLoop(card.loop);
      applyLiveParams(card);
      markPlaying(null);
    }
    Engine.play();
    markPlaying(card);
  }

  function markPlaying(card) {
    for (const c of State.cards) {
      const on = c === card && Engine.playing;
      c.el.card.classList.toggle('is-playing', on);
      // a screen reader (and a phone's accessibility tree) should hear what the
      // button will do now, not what it did when the card was built
      const btn = $('[data-act="play"]', c.el.card);
      if (btn) btn.setAttribute('aria-label', t(on ? 'card.pause' : 'card.play'));
    }
  }

  function setAB(mode) {
    State.ab = mode === 'compare' ? 'compare' : mode === 'original' ? 'original' : 'restored';
    Engine.setCompare(State.ab === 'compare');
    Engine.setBypass(State.ab === 'original');
    $$('#abSwitch button').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-ab') === State.ab));
    for (const c of State.cards) {
      $$('[data-act="ab"] button', c.el.card).forEach((b) => {
        const on = State.ab !== 'compare' && b.getAttribute('data-ab') === State.ab;
        b.classList.toggle('is-active', on);
      });
    }
  }

  Engine.onTick((pos) => {
    const card = State.current;
    if (!card || !card.analysis) return;
    const dur = card.analysis.window.seconds;
    const f = dur ? Math.max(0, Math.min(1, pos / dur)) : 0;
    card.el.seek.style.width = (f * 100).toFixed(2) + '%';
    const seekEl = $('[data-act="seek"]', card.el.card);
    if (seekEl) seekEl.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    card.el.time.textContent = Codecs.formatDuration(pos) + ' / ' + Codecs.formatDuration(dur);
    card.wave.setPosition(pos);
  });

  Engine.onState((s) => {
    markPlaying(s.playing ? State.current : null);
  });

  /* ---------------------------------------------------------- the file queue */

  async function addFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []).filter(isAudioFile);
    if (!files.length) { UI.toast(t('toast.noFiles'), 'bad'); return; }
    let skipped = 0;
    const fresh = [];
    for (const f of files) {
      if (f.size > CONFIG.maxFileBytes) {
        UI.toast(t('toast.tooBig', { name: f.name, mb: Math.round(CONFIG.maxFileBytes / 1048576) }), 'bad', 6000);
        skipped++;
        continue;
      }
      const card = createCard(f);
      fresh.push(card);
      State.cards.push(card);
      $('#fileList').appendChild(card.el.card);
      $('#controls').hidden = false;
    }
    if (!fresh.length) return;
    const n = fresh.length;
    refreshLibraryLabels();
    // the file is on the list *now*, with its name — on a phone the new card is
    // often below the fold, so it is brought into view instead of being silent
    revealCard(fresh[0]);
    UI.toast(n === 1 ? t('toast.addedOne', { name: fresh[0].name }) : t('toast.added', { n: n }), 'ok');
    Job.start(n, fresh[0]);
    let done = 0;
    for (const card of fresh) {
      Job.file(done, card.name, card);
      // sequential on purpose: one file in memory at a time keeps RAM flat
      await prepareCard(card);
      done++;
    }
    Job.end();
    if (skipped) UI.toast(t('toast.skipped', { n: skipped }), 'bad');
  }

  /** Scroll a fresh card into view (guarded: headless DOMs have no scrolling). */
  function revealCard(card) {
    const node = card && card.el && card.el.card;
    if (!node || typeof node.scrollIntoView !== 'function') return;
    try {
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (e) {
      try { node.scrollIntoView(); } catch (e2) { /* nothing to do */ }
    }
  }

  /**
   * Decode + measure a file, then render the short preview so the A/B waveform
   * and the before/after numbers are real, never estimated.
   *
   * Every stage reports what it is doing and how far along it is: decoding and
   * the browser's own work are indeterminate, the measurement and the render
   * are measured (the measurement is sliced, see RSDSP), so the bar never lies
   * about a file that takes a minute on a phone.
   */
  async function prepareCard(card, again) {
    if (card.status === 'analyzing' || card.status === 'rendering') return;
    setStatus(card, 'analyzing', t('note.decode'));
    card._workT0 = nowMs();
    setCardWork(card, 'decode', null);
    await nextPaint();                       // let the bar paint before the work starts
    try {
      const dec = await Codecs.decodeFile(card.file);
      const buffer = dec.buffer;
      card.sourceSampleRate = dec.sampleRate;
      card.buffer = buffer;

      setNote(card, t('note.analyze'));
      card._workT0 = nowMs();
      setCardWork(card, 'analyze', 0);
      // sliced measurement: the page keeps painting while a long file is measured
      const analysis = await Analyzer.analyzeAsync(
        buffer,
        { previewSeconds: previewSecondsFor(buffer.duration), buckets: 1400 },
        (p, stage) => setCardWork(card, stage, p, estimateLeft(card, p))
      );
      card.analysis = analysis;
      // first file, untouched slider: adopt the strength the profile recommends
      if (!State.powerTouched && analysis.recommendedPower) adoptRecommendedPower(analysis.recommendedPower);
      card.el.waveEmpty.hidden = true;
      if (again) card.result = null;
      setCardWork(card, 'window', null);

      // the live monitor only ever holds the preview window, not the whole file
      const from = Math.floor(analysis.window.start * analysis.sampleRate);
      const to = Math.floor(analysis.window.end * analysis.sampleRate);
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        chans.push(buffer.getChannelData(c).subarray(from, to));
      }
      card.analysisWindowChannels = chans;
      card.previewBuffer = Codecs.makeBuffer(chans, analysis.sampleRate);
      card.buffer = null;                    // let the full decode go

      // the restored side of the comparison (short window → fast, always real)
      const params = P.params(card);
      if (params) {
        card._workT0 = nowMs();
        setCardWork(card, 'preview', 0);
        const res = await Engine.render(chans, analysis.sampleRate, params, {
          progressSteps: 12,
          onProgress: (p) => setCardWork(card, 'preview', p, estimateLeft(card, p)),
        });
        const env = Analyzer.envelope(res.channels, 1400);
        const after = Analyzer.analyzeChannels(res.channels, res.sampleRate);
        card.after = { envelope: env, chips: after.chips };
        card.afterScore = after.score;
      }
      $('[data-act="retry"]', card.el.card).hidden = true;
      clearCardWork(card);
      setStatus(card, 'ready');
      refreshCardText(card);
    } catch (err) {
      card.error = err;
      setStatus(card, 'error');
      if (card.el.bar) card.el.bar.classList.add('is-error');
      clearCardWork(card);
      const msg = err && err.message;
      setNote(card, msg === 'worklet-load-failed' ? t('toast.workletFail')
        : msg === 'broken-audio' ? t('err.broken')
          : t('err.decode') + ' ' + (msg ? '(' + msg + ')' : ''), true);
      $('[data-act="retry"]', card.el.card).hidden = false;
    }
  }

  /** Move the master slider to the value a profile recommends (one time). */
  function adoptRecommendedPower(value) {
    const p = Math.max(0, Math.min(1, value));
    State.power = p;
    const power = $('#power');
    if (!power) return;
    const pct = Math.round(p * 100);
    power.value = pct;
    UI.paintRange(power);
    const out = $('#powerVal');
    if (out) out.textContent = t('ui.percent', { v: pct });
    for (const c of State.cards) {
      if (c.power === null || c.power === undefined) {
        c.el.power.value = pct;
        c.el.powerOut.textContent = t('ui.percent', { v: pct });
        UI.paintRange(c.el.power);
      }
    }
  }

  function previewSecondsFor(duration) {
    return Math.max(CONFIG.previewMin, Math.min(CONFIG.previewSeconds, duration));
  }

  /* -------------------------------------------------------- full rendering */

  /**
   * Render the whole file with the current settings and keep the encoded blob.
   * @returns {Promise<{blob:Blob,name:string,format:string}>}
   */
  async function renderCard(card, opts) {
    const o = opts || {};
    const params = P.params(card);
    if (!params) throw new Error('not analysed');
    const signature = P.signature(card);
    if (card.result && card.result.signature === signature && (card.result.bytes || card.result.file) && !o.force) {
      return card.result;
    }

    setStatus(card, 'processing', t('note.decode'));
    card._workT0 = nowMs();
    setCardWork(card, 'decode', null);
    await nextPaint();
    const dec = await Codecs.decodeFile(card.file);
    const rate = P.exportRate(card);

    card._workT0 = nowMs();
    setCardWork(card, 'render', 0);
    setNote(card, t('status.processing'));
    const res = await Engine.render(dec.buffer, rate, params, {
      progressSteps: 24,
      onProgress: (p) => setCardWork(card, 'render', p, estimateLeft(card, p)),
    });

    setNote(card, State.format === 'mp3' ? t('toast.mp3Slow') : t('status.export'));
    const name = Codecs.outputName(card.name, State.format === 'mp3' ? 'mp3' : 'wav');
    const onEncodeProgress = (p) => setCardWork(card, 'encode', p, estimateLeft(card, p));

    let result;
    if (State.opfsReady && OPFS) {
      // stream straight to disk-backed scratch storage: at no point does this
      // card's whole output exist as one ArrayBuffer on the main thread, so a
      // batch of large files never multiplies into the soft-memory ceiling
      await forgetRender(card);
      const key = renderKeyFor(card);
      const sink = await OPFS.createWriter(key);
      try {
        card._workT0 = nowMs();
        setCardWork(card, 'encode', 0);
        if (State.format === 'mp3') {
          await Codecs.encodeMp3(res.channels, res.sampleRate, State.mp3Rate, onEncodeProgress, sink);
        } else {
          await Codecs.encodeWavStream(res.channels, res.sampleRate, State.wavDepth, sink, onEncodeProgress);
        }
        const closed = await sink.close();
        const file = await OPFS.getFile(key);
        result = { file, size: closed.size, name, format: State.format, rate: res.sampleRate, signature, stale: false, opfsKey: key };
      } catch (err) {
        await sink.abort();
        throw err;
      }
    } else {
      card._workT0 = nowMs();
      setCardWork(card, 'encode', 0);
      let bytes;
      if (State.format === 'mp3') {
        const out = await Codecs.encodeMp3(res.channels, res.sampleRate, State.mp3Rate, onEncodeProgress);
        bytes = out.bytes;
      } else {
        setCardWork(card, 'encode', null); // a WAV write is fast, but not instant
        bytes = Codecs.encodeWav(res.channels, res.sampleRate, State.wavDepth);
      }
      result = { bytes, name, format: State.format, rate: res.sampleRate, signature, stale: false };
    }

    clearCardWork(card);
    card.result = result;
    setStatus(card, 'done');
    setNote(card, t('note.done', { fmt: State.format.toUpperCase() }));
    refreshCardText(card);
    return card.result;
  }

  async function saveCard(card) {
    if (State.busy) return;
    if (!card.analysis) { UI.toast(t('toast.needDecode'), 'bad'); return; }
    State.busy = true;
    Job.start(1, card);
    try {
      const res = await renderCard(card);
      Codecs.download(res.file || res.bytes, res.name);
      UI.toast(t('toast.saved', { name: res.name }), 'ok');
    } catch (err) {
      setStatus(card, 'error');
      const msg = err && err.message;
      // the encoder refusing its own output is a real, nameable failure — it
      // must never be saved as a file that "worked"
      setNote(card, /^mp3-/.test(msg || '') ? t('err.mp3') : t('err.render') + ' ' + (msg || ''), true);
      UI.toast(/^mp3-/.test(msg || '') ? t('err.mp3') : t('toast.renderFail', { msg: msg || '?' }), 'bad', 6000);
    }
    Job.end();
    State.busy = false;
  }

  async function processAll() {
    if (State.busy) return;
    const todo = State.cards.filter((c) => c.analysis);
    if (!todo.length) { UI.toast(t('toast.zipEmpty'), 'bad'); return; }
    State.busy = true;
    disableControls(true);
    try {
      const projected = todo.reduce((sum, c) => {
        const secs = c.analysis.duration;
        const rate = P.exportRate(c);
        return sum + (State.format === 'mp3'
          ? secs * State.mp3Rate * 125
          : secs * rate * (c.analysis.channels > 1 ? 2 : 1) * (State.wavDepth / 8));
      }, 0);
      if (projected > CONFIG.softMemoryMB * 1e6 && !State.opfsReady) {
        UI.toast(t('toast.bigBatchMemory'), 'warn', 6000);
      }
      Job.start(todo.length, todo[0]);
      for (let i = 0; i < todo.length; i++) {
        const card = todo[i];
        Job.file(i, card.name, card);
        try {
          await renderCard(card);
        } catch (err) {
          setStatus(card, 'error');
          setNote(card, (err && err.message) || t('err.render'), true);
        }
      }
      UI.toast(t('batch.done', { n: todo.length }), 'ok');
    } catch (err) {
      UI.toast(t('toast.renderFail', { msg: (err && err.message) || '?' }), 'bad', 6000);
    }
    Job.end();
    disableControls(false);
    State.busy = false;
  }

  async function downloadZip() {
    if (State.busy) return;
    const ready = State.cards.filter((c) => c.analysis);
    if (!ready.length) { UI.toast(t('toast.zipEmpty'), 'bad'); return; }
    State.busy = true;
    disableControls(true);
    let zipKey = null;
    try {
      UI.toast(t('toast.zipStart'), null, 2200);
      const projected = totalBytesOf(ready);
      if (projected > CONFIG.softMemoryMB * 1e6 && State.format === 'wav' && !State.opfsReady) {
        UI.toast(t('toast.bigBatchMemory'), 'warn', 6000);
      }
      const entries = [];
      Job.start(ready.length, ready[0]);
      for (let i = 0; i < ready.length; i++) {
        const card = ready[i];
        Job.file(i, card.name, card);
        const res = await renderCard(card);
        entries.push(res.opfsKey
          ? { name: res.name, key: res.opfsKey, size: res.size }
          : { name: res.name, bytes: res.bytes });
      }
      const readmeText = buildReadme(ready);
      const readmeBytes = utf8Encode(readmeText);
      Job.file(Math.max(0, entries.length - 1), entries.length ? entries[entries.length - 1].name : '', null);
      Job.at(0.9, 'zip');
      const name = 'remaster-suite-' + new Date().toISOString().slice(0, 10) + '.zip';

      let file;
      if (State.opfsReady && OPFS && entries.every((e) => e.key)) {
        // OPFS file → OPFS file, all the way through: the assembled archive
        // never exists in the main thread's heap, only its final `{size}`
        zipKey = 'zip-' + Date.now();
        entries.push({ name: 'README.txt', bytes: readmeBytes });
        await OPFS.packZip(entries, zipKey, (info) => {
          const share = entries.length ? info.index / entries.length : 1;
          Job.at(0.9 + share * 0.1, 'zip');
        });
        file = await OPFS.getFile(zipKey);
      } else {
        entries.readme = readmeText;
        file = await Codecs.zip(entries, (p) => Job.at(0.9 + p * 0.1, 'zip'));
      }
      Codecs.download(file, name);
      UI.toast(t('toast.zipDone', { n: ready.length }), 'ok');
    } catch (err) {
      UI.toast(t('toast.zipFail') + ' ' + (err && err.message ? err.message : ''), 'bad', 6000);
    }
    if (zipKey) global.setTimeout(() => OPFS.remove(zipKey), 5000);
    Job.end();
    disableControls(false);
    State.busy = false;
  }

  /** UTF-8 bytes of a string — used for the small README.txt entry that goes
   * straight into an OPFS-assembled ZIP (never needs a real file on disk). */
  function utf8Encode(str) {
    if (typeof global.TextEncoder !== 'undefined') return new global.TextEncoder().encode(str);
    const esc = unescape(encodeURIComponent(str));
    const out = new Uint8Array(esc.length);
    for (let i = 0; i < esc.length; i++) out[i] = esc.charCodeAt(i);
    return out;
  }

  /** A short note inside the ZIP: what was done and by whom. */
  function buildReadme(cards) {
    const lines = [];
    lines.push('Harmonic Restoration — Remaster Suite');
    lines.push('Developed by AndrexTheDev · hippie.highho@gmail.com');
    lines.push('100 % client-side audio restoration · ' + new Date().toISOString().slice(0, 10));
    lines.push('');
    lines.push('Files in this archive');
    lines.push('--------------------');
    for (const c of cards) {
      const a = c.analysis;
      const presets = P.resolvedPreset(c);
      lines.push('* ' + c.name);
      lines.push('  out      : ' + ((c.result && c.result.name) || '—'));
      lines.push('  profile  : ' + presets + '  (power ' + Math.round(P.power(c) * 100) + ' %)');
      lines.push('  format   : ' + (c.result ? c.result.format.toUpperCase() + ' · ' + c.result.rate + ' Hz' : '—'));
      lines.push('  detected : ' + (a ? (a.diag.chain && a.diag.chain.length ? a.diag.chain.join('+') : a.diag.id) : '?')
        + (a ? ' [' + a.diag.issues.join(', ') + ']' : ''));
      lines.push('  quality  : ' + (a ? a.score : '?') + ' / 100 before');
      lines.push('');
    }
    lines.push('If this saved you time, a voluntary tip is welcome:');
    lines.push('  SOL 79KsqtJJdhKFJ9woxnYgtf3nq7HxQveafWBCtC3mxWi8');
    lines.push('  BTC bc1qeqzrlfg3edrydk4s0hecakc82gp26n5p7hkc7f');
    lines.push('  ETH 0xBC3fab34f69bc9f6661608C3FB36dDdC313C42F7');
    lines.push('');
    lines.push('Tips are voluntary and not a purchase.');
    return lines.join('\n');
  }

  function removeCard(card) {
    if (State.current === card) { Engine.stop(); State.current = null; }
    clearTimeout(card._previewTimer);
    if (card.wave && card.wave.destroy) card.wave.destroy();
    forgetRender(card);
    const i = State.cards.indexOf(card);
    if (i >= 0) State.cards.splice(i, 1);
    card.el.card.remove();
    refreshLibraryLabels();
    if (!State.cards.length) {
      $('#controls').hidden = true;
      $('#fileList').textContent = '';
    }
  }

  function clearAll() {
    Engine.stop();
    State.current = null;
    Job.end();
    clearTimeout(previewTimer);
    for (const c of State.cards) {
      clearTimeout(c._previewTimer);
      if (c.wave && c.wave.destroy) c.wave.destroy();
      forgetRender(c);
      c.el.card.remove();
    }
    State.cards = [];
    refreshLibraryLabels();
    $('#controls').hidden = true;
    UI.toast(t('toast.cleared'));
  }

  function disableControls(off) {
    ['#btnProcessAll', '#btnZip', '#btnClear'].forEach((sel) => {
      const b = $(sel);
      if (b) b.disabled = off;
    });
  }

  function refreshLibraryLabels() {
    const n = State.cards.length;
    const zip = $('#btnZip');
    if (zip) zip.textContent = n > 1 ? t('ctl.zip') + ' (' + n + ')' : t('ctl.zip');
  }

  /* ------------------------------------------------------------- global wiring */

  /** The dropzone copy differs for a finger: nothing can be dragged on a phone. */
  /**
   * The drop zone is the one place where desktop and phone wording differ:
   * dragging a file is not something a phone can do. The key is written back to
   * `data-i18n` so a later language repaint keeps the variant this device needs.
   */
  function paintDropzone() {
    const touch = State.touch;
    const pairs = [
      [$('#dzTitle'), touch ? 'drop.titleTouch' : 'drop.title'],
      [$('#dzHint'), touch ? 'drop.hintTouch' : 'drop.hint'],
    ];
    for (const [el, key] of pairs) {
      if (!el) continue;
      el.setAttribute('data-i18n', key);
      el.textContent = t(key);
    }
  }

  function bindDropzone() {
    const dz = $('#dropzone');
    const input = $('#fileInput');
    const openPicker = () => input.click();
    dz.addEventListener('click', openPicker);
    dz.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPicker(); }
    });
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach((type) => {
      dz.addEventListener(type, (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        dz.classList.add('is-over');
      });
    });
    ['dragleave', 'dragend'].forEach((type) => dz.addEventListener(type, () => dz.classList.remove('is-over')));
    dz.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dz.classList.remove('is-over');
      if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });
    // dropping anywhere on the page must never navigate away
    ['dragover', 'drop'].forEach((type) => {
      global.addEventListener(type, (ev) => {
        if (ev.target === dz || dz.contains(ev.target)) return;
        ev.preventDefault();
      });
    });
  }

  function bindControls() {
    const power = $('#power');
    power.value = Math.round(State.power * 100);
    UI.paintRange(power);
    $('#powerVal').textContent = t('ui.percent', { v: power.value });
    power.addEventListener('input', () => {
      State.powerTouched = true;
      State.power = Number(power.value) / 100;
      $('#powerVal').textContent = t('ui.percent', { v: power.value });
      UI.paintRange(power);
      for (const c of State.cards) {
        if (c.power === null) {
          c.el.power.value = power.value;
          c.el.powerOut.textContent = t('ui.percent', { v: power.value });
          UI.paintRange(c.el.power);
        }
      }
      const card = State.current;
      if (card) applyLiveParams(card);
      debouncePreviewAll();
    });

    const presetSel = $('#presetSelect');
    presetSel.value = State.preset;
    presetSel.addEventListener('change', () => {
      State.preset = presetSel.value;
      for (const c of State.cards) {
        if (c.preset === null || c.preset === undefined) c.el.preset.value = State.preset;
      }
      const card = State.current;
      if (card) applyLiveParams(card);
      debouncePreviewAll();
    });

    $$('#abSwitch button').forEach((b) => {
      b.addEventListener('click', () => {
        setAB(b.getAttribute('data-ab'));
        if (!Engine.playing && State.cards.length) {
          const target = State.current || State.cards.find((c) => c.previewBuffer);
          if (target) ensurePlaying(target);
        }
      });
    });

    $('#btnProcessAll').addEventListener('click', processAll);
    $('#btnZip').addEventListener('click', downloadZip);
    $('#btnClear').addEventListener('click', clearAll);

    $$('.controls .seg[role="group"] button[data-format]').forEach((b) => {
      b.addEventListener('click', () => {
        State.format = b.getAttribute('data-format');
        $$('.controls .seg button[data-format]').forEach((x) => x.classList.toggle('is-active', x === b));
        $('#mp3Rate').hidden = State.format !== 'mp3';
        $('#wavDepth').hidden = State.format !== 'wav';
        markAllStale();
      });
    });

    const mp3 = $('#mp3Rate');
    mp3.addEventListener('change', () => {
      State.mp3Rate = Number(mp3.value);
      markAllStale();
    });
    const depth = $('#wavDepth');
    if (depth) {
      depth.addEventListener('change', () => {
        State.wavDepth = Number(depth.value);
        markAllStale();
      });
    }
  }

  /** Any change of export settings invalidates already rendered results. */
  function markAllStale() {
    for (const c of State.cards) {
      if (c.result) c.result.stale = true;
      if (c.status === 'done') setStatus(c, 'ready');
    }
    refreshAllCards();
  }

  function refreshAllCards() {
    for (const c of State.cards) if (c.analysis) refreshCardText(c);
  }

  let previewTimer = 0;
  function debouncePreviewAll() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      for (const c of State.cards) if (c.analysis) refreshPreview(c);
    }, 500);
  }

  function bindHeader() {
    const sw = $('#langSwitch');
    $$('button', sw).forEach((b) => {
      b.addEventListener('click', () => {
        const lang = b.getAttribute('data-lang');
        global.RSi18n.setLang(lang);
        $$('#langSwitch button').forEach((x) => {
          const on = x === b;
          x.classList.toggle('is-active', on);
          x.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        refreshAllText();
      });
    });
    const help = $('#btnHelp');
    help.addEventListener('click', () => UI.openDialog('#dlgHelp'));
    const libBtn = $('#btnLibMode');
    if (libBtn) {
      const paint = () => {
        const cdn = global.RSLibs.mode === 'cdn';
        libBtn.textContent = t(cdn ? 'about.libCdn' : 'about.libLocal');
        libBtn.title = t('about.libToggle');
      };
      paint();
      libBtn.addEventListener('click', () => {
        global.RSLibs.toggle();
        paint();
        UI.toast(t(global.RSLibs.mode === 'cdn' ? 'toast.libCdn' : 'toast.libLocal'), 'ok', 5200);
      });
      global.RSLibs._paint = paint;
    }
  }

  /** Re-render every text node that was built in JavaScript. */
  function refreshAllText() {
    const langs = [['#langSwitch button[data-lang="de"]', 'de'], ['#langSwitch button[data-lang="en"]', 'en']];
    for (const [sel, lang] of langs) {
      const b = $(sel);
      if (b) { const on = global.RSi18n.lang === lang; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    }
    // short preset labels inside the cards
    for (const c of State.cards) {
      const short = { auto: 'preset.auto.short', garage: 'preset.garage', vinyl: 'preset.vinyl', cassette: 'preset.cassette', lowbitrate: 'preset.lowbitrate', general: 'preset.general' };
      Array.prototype.forEach.call(c.el.preset.options, (o) => { o.textContent = t(short[o.value] || 'preset.general'); });
      c.el.powerOut.textContent = t('ui.percent', { v: c.el.power.value });
      const play = $('[data-act="play"]', c.el.card);
      if (play) play.setAttribute('aria-label', t(c === State.current && Engine.playing ? 'card.pause' : 'card.play'));
      c.wave.o.onSeek && c.wave.schedule();
      if (c.analysis) refreshCardText(c);
    }
    const power = $('#power');
    if (power) $('#powerVal').textContent = t('ui.percent', { v: power.value });
    if (global.RSLibs && global.RSLibs._paint) global.RSLibs._paint();
    paintDropzone();
    if (State.job) paintJob();
    refreshLibraryLabels();
    for (const c of State.cards) c.wave.draw();
  }

  function bindFooter() {
    $$('.coin').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const addr = btn.getAttribute('data-copy');
        const label = btn.getAttribute('data-copy-label') || '';
        const ok = await UI.copyText(addr);
        UI.toast(ok ? t('toast.copyOk', { label: label }) : t('toast.copyFail'), ok ? 'ok' : 'bad');
        if (ok) {
          btn.classList.add('is-copied');
          global.setTimeout(() => btn.classList.remove('is-copied'), 1200);
        }
      });
    });
  }

  /* ------------------------------------------------------------------ start up */

  function boot() {
    if (!global.document || !$('#dropzone')) return;
    applyPointer();
    // …and keep listening: the same tab can be a phone and then a desktop again
    try {
      const mq = global.matchMedia && global.matchMedia('(hover: none) and (pointer: coarse)');
      if (mq && mq.addEventListener) {
        mq.addEventListener('change', () => {
          applyPointer();
          paintDropzone();
        });
      }
    } catch (e) { /* very old browsers: the boot value stands */ }
    global.RSi18n.setLang(global.RSi18n.detect(), { apply: false });
    global.RSi18n.apply();
    paintDropzone();
    UI.bindDialogs();
    bindHeader();
    bindDropzone();
    bindControls();
    bindFooter();
    setAB('restored');           // a first listen should be the restored version
    refreshAllText();
    initStreaming();
    initCOI();
  }

  /**
   * Hook into `coi-serviceworker.js`'s registration result (see root-level
   * file): if a one-time reload is still needed to actually pick up the
   * cross-origin isolation headers, say so for a moment before it happens —
   * a page that silently reloads itself looks broken, not helpful.
   */
  function initCOI() {
    const coi = global.RSCOI;
    if (!coi || !coi.ready || typeof coi.ready.then !== 'function') return;
    coi.ready.then((info) => {
      if (!info || !info.needsReload || typeof info.confirmReload !== 'function') return;
      UI.toast(t('coi.reloading'), null, 1400);
      global.setTimeout(() => info.confirmReload(), 650);
    }).catch(() => { /* isolation is an optional speed-up, never required */ });
  }

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  const API = {
    State, CONFIG, Job, boot, addFiles, prepareCard, renderCard, processAll, downloadZip,
    adoptRecommendedPower, setCardWork, revealCard, isTouchDevice, refreshAllText,
    setAB, ensurePlaying, clearAll, removeCard, refreshPreview, P,
    initStreaming, initCOI,
  };
  global.RSApp = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
