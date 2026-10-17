# Batch streaming and worker safety (5.1B / 5.2)

## Architecture

`processAll()` uses independent asynchronous lanes, bounded by the number of
cards, `navigator.hardwareConcurrency`, and a conservative three-times-largest-
decoded-PCM estimate against the existing device memory budget. The encoder pool
has separate backpressure: one logical core is reserved for UI/rendering and at
most two simultaneous WASM heaps are retained. Thus “up to hardwareConcurrency”
is an upper bound, not a promise of that many simultaneous LAME instances.
Analysis during upload still runs sequentially. Native Web Audio decoding still
materializes each source; this change does not implement a streaming decoder.

Every batch render opts into `renderChunked()` regardless of file duration.
Finalized PCM spans go directly to the incremental MP3/WAV encoder and then the
OPFS writer. Without OPFS the same writer interface holds **encoded byte
chunks** and closes into an immutable Blob, not a whole restored Float32Array.
The in-memory writer takes ownership by copying writes, rejects writes after
close/abort and releases its chunk list on close/abort. ZIP can read these memory
scratch keys when disk-backed OPFS is unavailable. Encoded output/ZIP memory is
still proportional to output size on that fallback; it is not disk streaming.
Individual saves retain the older short-file fast path and long-file threshold.

Per-card progress paints are coalesced through requestAnimationFrame; lifecycle
completion clears any stale queued paint. Offline spans register progress
suspensions, so the bar advances within a chunk rather than every ten seconds.
The append stage is visibly labelled encoding, and successful terminal progress
remains one. A failure in one lane does not cancel unrelated cards.

## Codec leases

Both APIs accept an optional final `{ signal }` argument:

```js
const controller = new AbortController();
const encoder = await RSCodecs.createMp3StreamEncoder(
  48000, 192, 2, sink, { signal: controller.signal }
);
// or: encodeMp3(channels, rate, kbps, progress, sink, { signal })
```

* Pre-aborted signals allocate no worker.
* Queued abort removes the waiter, its listener and deadline immediately.
* A waiter has a **15-second queue deadline** (`TimeoutError`). This does not
  impose a fifteen-second whole-file duration limit.
* An acquired worker's individual response watchdog remains 30 seconds.
* Active signal cancellation disposes that file's worker; release is idempotent.
* Returned, unleased workers terminate after **30 seconds idle**. Reacquisition
  clears the idle timer; an old timer cannot kill an active reused lease.
* Failed workers are removed from the count and the next surviving waiter is
  serviced. Per-request completion is guarded against abort/error races.

Worker absence, missing WebAssembly, Worker-constructor/CSP failure and failed
WASM initialization have the distinct `EncodingUnavailableError` classification.
The app catches that class only for requested MP3 and retries as a correctly
named/formatted WAV, with a bilingual warning toast. WAV packing runs on the
main thread in yielding chunks; it deliberately does not freeze the UI with a
single giant synchronous conversion. Queue timeout, explicit cancellation, DSP
failure, sink/quota failure are **not** disguised as successful fallback audio.

## Responsiveness and true peak

UI-side full analysis, after-measurement and envelopes optionally run in one
serialized `analysis-worker.js` using the exact production DSP/analyzer modules.
Owned input copies are transferred, never the source buffers used for A/B.
Requests have a 30-second watchdog; unsupported Worker/EventTarget, CSP failure
or worker failure disables offload and returns to the exact yielding path.
The measurement worker is terminated after 30 seconds idle. The live monitor
also suspends its AudioContext after pause/stop/natural end, rather than spending
CPU on an attached worklet processing silence. Resume waits for a pending
suspension and reuses the same context; Stop resets old DSP history. Three
additional transport checks exercise these transitions. Six focused tests
verify full/after/envelope parity, order, failure recovery and CSP fallback.
UI-side after-measurement/envelope calculations use yielding equivalents of
the synchronous reference APIs when offload is unavailable. The shared analysis scheduler targets six-ms
slices and calibrates conservatively from one unit, rather than starting with a
large uncalibrated slice. Synchronous reference APIs remain available for tools.

Real styled-page profiling also identified software repaint costs, separate from
JavaScript long tasks. While an audio job runs, `body.is-working` replaces the
large background gradients and sticky backdrop blurs with opaque chrome, pauses
the decorative button pulse and removes width tweens from rAF-driven progress.
Progress tracks contain their layout/paint. The original card entry animation and final compositing state are retained. Job end
restores the normal idle chrome; two DOM checks cover this lifecycle. The six
existing idle/ready screenshot baselines are not re-recorded to accept changes.
Performance evidence must use correctly served `text/css` styles, not a bare or
MIME-rejected stylesheet.

MP3 export parameters clamp the true-peak ceiling to **at most −1.5 dBTP** and
retain the existing more conservative bitrate-specific margins. A −1.5 dBTP
pre-encode ceiling by itself is **not** a proof about arbitrary decoded MP3s.
The encoding test includes twelve actual engine→WASM encode→browser decode
measurements (44.1/48 kHz, 128/192 kbps, tone/music/noise, mono/stereo), requiring
each measured decoded true peak ≤0 dBTP. The matrix is separate from the timed
isolated encoder interval. Bypassed processing and arbitrary future recordings
are not certified by those fixtures.

## Acceptance evidence

Focused worker lifecycle tests: `node tests/worker-safety.test.js` (**9 codec checks**, plus **3 harness deadline checks**;
virtual clocks accelerate the 15/30-second lifecycle tests). Chunked/app tests:
`node tests/chunked-render.test.js` (**59 checks**), including real decodable WAV
fallback and an explicit warning on blocked MP3 Worker construction.

`tests/beta/beta.js` now includes a full real-picker ten-file UI batch at
44.1/48 kHz, mono/stereo, 5–60 seconds. Fixtures include deterministic music,
noise and **recorded human spoken digits** from pinned CC BY-SA FSDD fixtures
(see `tests/fixtures/speech/README.md`), resampled/repeated with pauses. This is
not a natural-conversation intelligibility corpus. Trusted Process All and ZIP clicks use the production app path.
The performance case uses the same page after the preceding UI/mobile/screenshot
cases; unrelated CPU profiling is stopped before measurement. CDP evaluation
deadlines are cancelled on success/rejection: previously stale timeout callbacks
flooded DevTools with diagnostic requests sixty seconds after successful polls.
Three harness regressions cover success, failure and genuine timeout diagnostics.
No reload/reset or artificial idle interval is inserted inside the workflow.
rAF intervals and PerformanceObserver long tasks span upload/decode/analysis,
restoration, encoding and ZIP creation. Measurement stops at ZIP export, not
a later artificial idle period. It requires mean ≥59 FPS and no task >50 ms.
Machine-readable output: `UI-WORKFLOW-RESULT.json`; full browser/screenshot
results: `BETA-REPORT.md`. These requirements must be judged from the completed
run, not inferred from the isolated encoder benchmark.

### Completed acceptance — 2026-10-17

The uninterrupted command chain completed with exit code **0**:

```sh
node scripts/validate-docs.js && node tests/audio-quality.test.js && npm test && node tests/beta/beta.js
```

* Documentation: **19/19** checks; static source audit: **18 files, 0 defects,
  0 unreferenced modules**.
* `npm test`: **18 suites / 1,344 checks**, including the unchanged **9/9 DSP
  quality gates**, 25 Wiener/transport checks, 11 worker/harness lifecycle checks
  and six analysis-worker checks.
* Isolated encoding: **60.002 FPS**, maximum frame interval **16.67 ms**, **zero
  long tasks**. All twelve actual MP3 encode/decode peak cases pass; highest
  decoded fixture peak **−0.893 dBTP**. See `ENCODING-BATCH-RESULT.json`.
* Full styled Chromium beta: **201/201** checks, **26 screenshots**, **6/6
  existing visual baselines pixel-identical**. No baseline files were changed.
* Whole UI workflow, after the preceding browser scenarios on the same page:
  ten real input files → decode/analyse → trusted Process All → ten actual MP3
  results → trusted ZIP export. **59.787 FPS**, **4,994 measured intervals**,
  maximum frame interval **50.00 ms**, **zero long tasks**, **83.557 seconds**.
  Neither FPS nor long-task thresholds were relaxed; no artificial idle tail
  was added. See `UI-WORKFLOW-RESULT.json` and `BETA-REPORT.md`.

The prior scratch-server results with a MIME-rejected stylesheet are excluded
from this evidence. The full beta uses the normal styled page. The original
card-entry animation is retained: transient changes to its compositing caused
small baseline differences during development and were reverted, not accepted
as new baselines.

### Final review: cancelled replacement lease

An additional regression reproduces cancellation between dequeueing a waiter
and asynchronously delivering a replacement for a broken encoder. The pool now
returns this unclaimed lease for reuse/idle disposal instead of leaking it.
The regression failed before the fix and passes after it. This adds one check:
the current suite inventory is **18 suites / 1,345 checks** (12 worker/harness
lifecycle checks). The 1,344-check acceptance above records the earlier full run;
its Chromium/screenshot artifacts are unchanged by this queue-only correction.

### Completed pre-commit requalification

After the replacement-lease correction and UI-harness synchronization fixes,
the uninterrupted chain `validate-docs → audio-quality → beta → npm test`
completed with exit code **0**. Current totals: **18 suites / 1,345 checks**,
**201/201 Chromium checks**, **26 screenshots**, **6/6 unchanged baselines**.
The styled ten-file MP3/ZIP workflow measured **59.917 FPS**,
**4,205 intervals**, maximum interval **33.335 ms**, **0 long tasks**,
**70.190 seconds**. The JSON artifacts contain this latest run.

The click helper now checks native hit-testing before trusted mouse events,
scrolling targets clear of a tall sticky rack instead of clicking an occluder.
The separate progress-pixel scenario uses the existing real 30-second fixture
to capture both early and late progress on fast machines; it still requires
at least four samples, three distinct pictures and matching reported widths.
The real ten-file performance scenario and its thresholds are unchanged.
