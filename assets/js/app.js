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

  const $ = UI.$;
  const $$ = UI.$$;
  const t = (k, v) => global.RSi18n.t(k, v);

  /* ------------------------------------------------------------------- config */

  const CONFIG = {
    previewSeconds: 40,        // live A/B window; the full file is rendered on save
    previewMin: 12,
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    softMemoryMB: 900,         // warn above this before packing a ZIP
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
  };

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

  function setProgress(card, p) {
    card.progress = p;
    const bar = card.el.bar;
    if (bar) {
      bar.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
      bar.classList.toggle('is-error', card.status === 'error');
    }
    if (card === State.current && State.busy) {
      const text = t('status.rendering', { p: Math.round(Math.max(0, Math.min(1, p)) * 100) });
      if (card.el.pill) { card.el.pill.textContent = text; card.el.pill.hidden = false; }
    }
  }

  function globalProgress(show, ratio, text) {
    const wrap = $('#globalProgress');
    if (!wrap) return;
    wrap.hidden = !show;
    if (!show) return;
    const fill = $('#globalProgressFill');
    const label = $('#globalProgressText');
    if (fill) fill.style.width = Math.round(Math.max(0, Math.min(1, ratio || 0)) * 100) + '%';
    if (label) label.textContent = text || '';
  }

  function totalBytesOf(list) {
    let bytes = 0;
    for (const c of list) if (c.result && c.result.bytes) bytes += c.result.bytes.length;
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
        canvas: $('[data-slot="wave"]', node),
        waveEmpty: $('[data-slot="waveEmpty"]', node),
        window: $('[data-slot="window"]', node),
        seek: $('[data-slot="seek"]', node),
        time: $('[data-slot="time"]', node),
        preset: $('[data-slot="preset"]', node),
        power: $('[data-act="power"]', node),
        powerOut: $('[data-slot="power"]', node),
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
      onSeek: (sec) => {
        ensurePlaying(card);
        Engine.seek(sec);
      },
    });

    wireCard(card);
    setStatus(card, 'queued');
    setProgress(card, 0);
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
    const scrub = (ev) => {
      if (!card.analysis) return;
      const r = seek.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      ensurePlaying(card);
      Engine.seek(f * card.analysis.window.seconds);
    };
    seek.addEventListener('pointerdown', (ev) => { seek.setPointerCapture(ev.pointerId); scrub(ev); });
    seek.addEventListener('pointermove', (ev) => { if (ev.buttons) scrub(ev); });
    seek.addEventListener('keydown', (ev) => {
      if (!card.analysis) return;
      const step = 2;
      if (ev.key === 'ArrowRight') { Engine.seek(Engine.position + step); ev.preventDefault(); }
      if (ev.key === 'ArrowLeft') { Engine.seek(Math.max(0, Engine.position - step)); ev.preventDefault(); }
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
      const res = await Engine.render(card.analysisWindowChannels, card.analysis.sampleRate, params, {
        progressSteps: 0,
      });
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
    for (const c of State.cards) c.el.card.classList.toggle('is-playing', c === card && Engine.playing);
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
    let done = 0;
    for (const card of fresh) {
      const i = ++done;
      globalProgress(true, (i - 1) / n, t('batch.progress', { i: i, n: n, name: card.name }));
      // sequential on purpose: one file in memory at a time keeps RAM flat
      await prepareCard(card);
      globalProgress(true, i / n, t('batch.progress', { i: i, n: n, name: card.name }));
    }
    globalProgress(false, 1, '');
    if (skipped) UI.toast(t('toast.skipped', { n: skipped }), 'bad');
    UI.toast(t('toast.added', { n: n }), 'ok');
  }

  /**
   * Decode + measure a file, then render the short preview so the A/B waveform
   * and the before/after numbers are real, never estimated.
   */
  async function prepareCard(card, again) {
    if (card.status === 'analyzing' || card.status === 'rendering') return;
    setStatus(card, 'analyzing', t('note.decode'));
    setProgress(card, 0.05);
    try {
      const dec = await Codecs.decodeFile(card.file);
      const buffer = dec.buffer;
      card.sourceSampleRate = dec.sampleRate;
      card.buffer = buffer;

      setNote(card, t('note.analyze'));
      setProgress(card, 0.35);
      const analysis = Analyzer.analyze(buffer, { previewSeconds: previewSecondsFor(buffer.duration), buckets: 1400 });
      card.analysis = analysis;
      // first file, untouched slider: adopt the strength the profile recommends
      if (!State.powerTouched && analysis.recommendedPower) adoptRecommendedPower(analysis.recommendedPower);
      card.el.waveEmpty.hidden = true;
      if (again) card.result = null;
      setProgress(card, 0.6);

      // the live monitor only ever holds the preview window, not the whole file
      const from = Math.floor(analysis.window.start * analysis.sampleRate);
      const to = Math.floor(analysis.window.end * analysis.sampleRate);
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        chans.push(buffer.getChannelData(c).subarray(from, to));
      }
      card.analysisWindowChannels = chans;
      card.analysis.windowEnvelope = Analyzer.envelope(chans, 1400);
      card.previewBuffer = Codecs.makeBuffer(chans, analysis.sampleRate);
      card.buffer = null;                    // let the full decode go
      setProgress(card, 0.7);

      // the restored side of the comparison (short window → fast, always real)
      const params = P.params(card);
      if (params) {
        const res = await Engine.render(chans, analysis.sampleRate, params, { progressSteps: 0 });
        const env = Analyzer.envelope(res.channels, 1400);
        const after = Analyzer.analyzeChannels(res.channels, res.sampleRate);
        card.after = { envelope: env, chips: after.chips };
        card.afterScore = after.score;
      }
      setProgress(card, 1);
      setStatus(card, 'ready');
      refreshCardText(card);
      setNote(card, t('note.realtime'));
      card.wave.setData({
        before: card.analysis.windowEnvelope,
        after: card.after ? card.after.envelope : null,
        duration: card.analysis.window.seconds,
      });
    } catch (err) {
      card.error = err;
      setStatus(card, 'error');
      setProgress(card, 1);
      setNote(card, (err && err.message) === 'worklet-load-failed' ? t('toast.workletFail') : t('err.decode') + ' ' + (err && err.message ? '(' + err.message + ')' : ''), true);
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
    if (card.result && card.result.signature === signature && card.result.bytes && !o.force) {
      return card.result;
    }

    setStatus(card, 'processing', t('note.decode'));
    setProgress(card, 0.02);
    const dec = await Codecs.decodeFile(card.file);
    const rate = P.exportRate(card);
    setProgress(card, 0.05);

    const res = await Engine.render(dec.buffer, rate, params, {
      progressSteps: 24,
      onProgress: (p) => {
        setProgress(card, 0.05 + p * 0.8);
        setNote(card, t('status.rendering', { p: Math.round(p * 100) }));
      },
    });

    setNote(card, State.format === 'mp3' ? t('toast.mp3Slow') : t('status.export'));
    setProgress(card, 0.86);
    let bytes;
    let name;
    if (State.format === 'mp3') {
      const out = await Codecs.encodeMp3(res.channels, res.sampleRate, State.mp3Rate, (p) => setProgress(card, 0.86 + p * 0.13));
      bytes = out.bytes;
      name = Codecs.outputName(card.name, 'mp3');
    } else {
      bytes = Codecs.encodeWav(res.channels, res.sampleRate, State.wavDepth);
      name = Codecs.outputName(card.name, 'wav');
    }
    setProgress(card, 1);
    card.result = { bytes, name, format: State.format, rate: res.sampleRate, signature, stale: false };
    setStatus(card, 'done');
    setNote(card, t('note.done', { fmt: State.format.toUpperCase() }));
    refreshCardText(card);
    return card.result;
  }

  async function saveCard(card) {
    if (State.busy) return;
    if (!card.analysis) { UI.toast(t('toast.needDecode'), 'bad'); return; }
    State.busy = true;
    try {
      const res = await renderCard(card);
      Codecs.download(res.bytes, res.name);
      UI.toast(t('toast.saved', { name: res.name }), 'ok');
    } catch (err) {
      setStatus(card, 'error');
      setNote(card, t('err.render') + ' ' + (err && err.message ? err.message : ''), true);
      UI.toast(t('toast.renderFail', { msg: (err && err.message) || '?' }), 'bad', 6000);
    }
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
      if (projected > CONFIG.softMemoryMB * 1e6) {
        UI.toast(t('toast.mp3Slow'), 'warn', 6000);
      }
      for (let i = 0; i < todo.length; i++) {
        const card = todo[i];
        globalProgress(true, i / todo.length, t('batch.processing', { i: i + 1, n: todo.length }));
        try {
          await renderCard(card);
        } catch (err) {
          setStatus(card, 'error');
          setNote(card, (err && err.message) || t('err.render'), true);
        }
        globalProgress(true, (i + 1) / todo.length, t('batch.processing', { i: i + 1, n: todo.length }));
      }
      UI.toast(t('batch.done', { n: todo.length }), 'ok');
    } catch (err) {
      UI.toast(t('toast.renderFail', { msg: (err && err.message) || '?' }), 'bad', 6000);
    }
    globalProgress(false, 1, '');
    disableControls(false);
    State.busy = false;
  }

  async function downloadZip() {
    if (State.busy) return;
    const ready = State.cards.filter((c) => c.analysis);
    if (!ready.length) { UI.toast(t('toast.zipEmpty'), 'bad'); return; }
    State.busy = true;
    disableControls(true);
    try {
      UI.toast(t('toast.zipStart'), null, 2200);
      const projected = totalBytesOf(ready);
      if (projected > CONFIG.softMemoryMB * 1e6 && State.format === 'wav') {
        UI.toast(t('toast.mp3Slow'), 'warn', 6000);
      }
      const entries = [];
      for (let i = 0; i < ready.length; i++) {
        const card = ready[i];
        globalProgress(true, (i / ready.length) * 0.9, t('batch.processing', { i: i + 1, n: ready.length }));
        const res = await renderCard(card);
        entries.push({ name: res.name, bytes: res.bytes });
      }
      entries.readme = buildReadme(ready);
      globalProgress(true, 0.94, t('batch.zipPrep', { n: entries.length }));
      const blob = await Codecs.zip(entries, (p) => globalProgress(true, 0.94 + p * 0.05, t('batch.zipPrep', { n: entries.length })));
      const name = 'remaster-suite-' + new Date().toISOString().slice(0, 10) + '.zip';
      Codecs.download(blob, name);
      UI.toast(t('toast.zipDone', { n: entries.length }), 'ok');
    } catch (err) {
      UI.toast(t('toast.zipFail') + ' ' + (err && err.message ? err.message : ''), 'bad', 6000);
    }
    globalProgress(false, 1, '');
    disableControls(false);
    State.busy = false;
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
      lines.push('  detected : ' + (a ? a.diag.id : '?') + (a ? ' [' + a.diag.issues.join(', ') + ']' : ''));
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
    const i = State.cards.indexOf(card);
    if (i >= 0) State.cards.splice(i, 1);
    card.el.card.remove();
    if (!State.cards.length) {
      $('#controls').hidden = true;
      $('#fileList').textContent = '';
    }
  }

  function clearAll() {
    Engine.stop();
    State.current = null;
    for (const c of State.cards) c.el.card.remove();
    State.cards = [];
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
      c.wave.o.onSeek && c.wave.schedule();
      if (c.analysis) refreshCardText(c);
    }
    const power = $('#power');
    if (power) $('#powerVal').textContent = t('ui.percent', { v: power.value });
    if (global.RSLibs && global.RSLibs._paint) global.RSLibs._paint();
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
    global.RSi18n.setLang(global.RSi18n.detect(), { apply: false });
    global.RSi18n.apply();
    UI.bindDialogs();
    bindHeader();
    bindDropzone();
    bindControls();
    bindFooter();
    setAB('restored');           // a first listen should be the restored version
    refreshAllText();
  }

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  const API = {
    State, CONFIG, boot, addFiles, prepareCard, renderCard, processAll, downloadZip,
    adoptRecommendedPower,
    setAB, ensurePlaying, clearAll, removeCard, refreshPreview, P,
  };
  global.RSApp = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
