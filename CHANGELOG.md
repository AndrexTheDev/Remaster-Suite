# Changelog

All notable changes to the Remaster Suite. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the ones shown in
*About & credits*.

## [Unreleased]

### Fixed — the de-esser was handed a measurement and spent 0.830 of it

**The amount is the law's reading of the file, and the intensity curve was taking a sixth of it — the
last repair stage still doing that.** The de-esser's dose is `0.85 · sibNeed · headroom`; `sibNeed` is
the measured departure of the file's loudest frames from the file's own balance, and it is zero when no
departure was measured, so the curve was scaling a number that has nothing to do with taste. (The
de-hisser's amount stopped being scaled for exactly this reason one round ago; the de-clicker's and the
de-clipper's are repair *depths* and stay on the curve, measured — see *Measured — the two repair stages
that stay on the taste curve* below.) What the wrong scaling left behind was visible in the app's *own*
export: on acceptance §10's burst fixture the chain was spending 0.706 where the law had handed out
0.850, and the 320 kbit/s export came back diagnosed `sibilance`, asking **0.614** of dose for itself
against 0.706 on the input — the demand had fallen by a sixth for a repair that had moved the bursts
2.6 dB.

Measured with the curve removed (probe `tools/work/sib11.js`, reproduced on the shipped source by
`tools/work/sib12.js`):

* the bursts lose the band: the acceptance row that owns this fixture (7.8 kHz over the twelve burst
  windows) moves **5.9 → 6.9 dB**, and the probe's paired 7 kHz frame meter over the file's loudest
  frames **2.61 → 3.06 dB**;
* the scan the dose is computed from — the same quantity the card names the defect with — falls
  5.46 → **2.43 dB**, more than half of the departure inside one pass (the curved dose left 3.26);
* the app's own 320 kbit/s export reads **healthy** and asks **0.226** of dose where the card starts
  naming `sibilance` at 0.255; the chain's own output asks **0.260**, and the row prints that too;
* the file that needs it more gets it too: the audit's continuous "s" (excess 5.79 dB) reads **0.558**
  of dose (0.463 curved) and the acceptance row that carries it — 7 kHz in the frames where the input
  is loudest — moves **5.0 dB** where the paired meter read 4.4 at the curved dose;
* nothing new is named and nothing clean is ducked: `sibNeed` is zero without a departure, and every
  null fixture — clean beds, the phrased organ, the cymbal wash, hi-hats at 3/s — still measures a dose
  of **exactly 0** (audit 316 green, dsp 146 → **150** with this round's four pins).

Two meters in the matrix were reading their own subject wrong, and this round fixed both because the
rows above run through them: the counter-case row sorted *each* file's own frames and took its loudest
20 % — a different population inside the de-essed file, so it read **2.8 → 2.9 dB** for a move the
paired meter puts at **4.4 → 5.0 dB** — and the export-honesty comparison treated the literal token
`healthy` as a defect, so the first fixture whose export came back clean read *the encode itself adds
healthy* (and a *repaired defect* could be reported as "back" as `healthy`). The frames are chosen on
the input and both columns are read on them; the token is filtered out of both comparisons.

What is *not* claimed: the chain's own output still asks **0.260** on this fixture — 2 % over the naming
line, at a scan of 2.43 dB against the 0.7–1.0 dB a clean recording reads — and a file whose bursts are
closer together than the stage's 140 ms hold is not repaired in its own terms at all: at 4/s the scan
reads 6.39 → **6.17** at the full 0.850 dose, because a duck that covers the whole file moves the median
balance as much as the peak balance and the scan is the *difference* (probe `tools/work/sib14.js`). Two
levers were measured and **not** shipped, both recorded where they were measured: a shorter hold does
not help (30 ms reads 6.25 and the delivered band move shrinks with it, `sib15.js`), and holding the
stage's own reference while a burst window is open — so it learns the body instead of the burst, which
is what its ~2 s mean is currently lifted by — takes the exported dose 0.260 → **0.055** and the scan to
2.41, at the price of nearly doubling the de-esser's move on a continuous "s" (loudest 20 % of frames
−5.25 → **−6.43 dB**, a file whose every frame is a burst).

### Fixed — the de-hisser asked for a cut it could not deliver

**The repair was 26 % of its own request where the defect lives.** The stage splits the signal at the
measured hiss start and scales the high branch — but `low + high` is the Linkwitz-Riley allpass, so
`low + high·g` also sums back a *unit-magnitude copy* of the whole signal at the gate's gain while the
low branch's remainder subtracts from it. Measured as a static transfer with the gate held closed
(probes hiss12/hiss13: white noise at the floor, request −22 dB) the split delivers **−5.8 dB at 4 kHz,
−10.3 at 6 kHz, −13.8 at 8 kHz — 26 / 47 / 63 % of the request** — where the same gain applied flat
delivers all −22.1. A steeper split (LR8) buys 1.0–1.4 dB at 6–8 kHz, a lower crossover (2.5 kHz)
0–1 dB on the worn record: the phase-coupled allpass term is the limit, not the filter order
(hiss10/hiss13), so neither was shipped.

**Those frames now get a shelf on the same corner, gated by two witnesses that were already there.**
Where the key band sits at the measured HF floor (`1 − lvl`) *and* the tilt anomaly is at its measured
maximum (`cutTilt / maxCut`), the missing part comes from a second-order high-shelf at the repair
corner (`HISS_FLOOR_RATIO = 0.75`) — its magnitude below the corner is exactly 1, and 0 dB of it is
exactly the identity. The fraction is a measurement, not a taste: over four fixtures × four doses
(hiss19) the pause floor keeps falling up to 0.75 and stops after it, while the *pauses' own tilt* —
the number the diagnosis acts on — crosses the music's own tilt at 0.75 (+0.34 dB off on the synthetic
bed+hiss, +0.71 on the worn record) and over-corrects beyond it (−2.2 / −1.2 dB, i.e. pauses duller
than the music).

Measured, every claim paired against the same render with the term removed (so each one is false
without the change):

* the acceptance hiss fixture's own pause frames, median per-band level against the clean copy (probe
  hiss24, dB over the clean copy at 1/2/3/4/6/8/12 kHz): arrival 14/20/23/25/28/31/36, chain before
  **11/16/17/17/17/18/21**, after **9/12/12/11/8/8/10** — the repair doubles where the defect lives —
  and the ≥4 kHz quiet-RMS row moves −39.78 → **−40.32 dBFS** (12.1 from 10.3 dB of band in the frames
  the noise owns);
* the app's own statistics on the output move *with* the sound, which is what the round was about: the
  tilt step the card prints 18.35 → **0.00 dB** and `hissAmount` 1.00 → **0.39** (the amount used to sit
  at 1.00 by construction — its evidence term clamps at a step of 5.3 dB — so a 12 dB repair moved it by
  nothing);
* the user's own workflow (`tools/workflow-check.js`, worn record): upload `crackle, hiss, hum` →
  re-upload at 320 kbit/s `hiss` → **healthy**; the acceptance §17 and §19 export rows agree (tilt step
  on the export 6.86 → 0.84 dB);
* the music does not move: loud and soft *musical* frames stay within 0.06 dB per band of the same
  render without the shelf (hiss17/hiss25 — 0.48 vs 0.45 dB over the wider music-owned population,
  0.01 dB in the loud frames), a *forced* dose on loud continuous music is **bit-identical**
  (tests/dsp.test.js), and every clean fixture still measures a dose of exactly 0.

What is *not* claimed: the pauses' absolute floor is still 8–12 dB above the clean copy at 6–12 kHz, and
the dedicated hiss fixture's export is still named a hiss — through the *level* term (amount 0.31), not
the tilt, which reads 0.00. The cap no longer binds either: lifting `hissMax` by 3 dB is worth +0.04 dB
of band where it used to be worth +0.27 dB (hiss26).

**The level release.** The suite promised that a quieter upload gets the same repair — and the
repairs did, but the rest of the app did not. Four absolute constants sat in the analysis (an
inter-sample-peak gate, a flat-top tolerance, a spectrum floor, a synthesizer reference cap) and two
thresholds sat in the tone stages (the glue's and the warmth's), all of them written for a file at
full scale. The same recording measured and processed 20 dB down now comes out 20 dB down: nothing
else may move.

### Fixed — the de-esser named a phrased organ and a wash of cymbals

**A sibilant's own statistics, measured on the two things that are not sibilants.** The de-esser's dose
comes from a per-frame scan of the 7 kHz/2.6 kHz balance (p95 − p50 over the frames where the low band is
alive) — and that balance rises for two reasons that have nothing to do with an "s":

* **the 2.6 kHz band falls, not the 7 kHz band.** On a phrased organ the notes stop between phrases, the
  reference band drops with them, and the *ratio* climbs: measured, the acceptance organ's scan reads
  **4.29 dB**, past the law's 4.2 dB full-correction point, so the card named `sibilance` on a clean file
  and the de-esser took a dose. The 7 kHz band never stands out of anything — it is the bed's floor,
  lifting itself by 1.7 dB across the same frames;
* **a wash is over zero all the time.** Broadband cymbal noise has 7 kHz above 2.6 kHz in its *median*
  frame already (a wash breathes everywhere, so the p95 above that p50 is 2.52 dB), and its top end is a
  genuinely hot tilt — `sibExcessDb` +4.73, real — which the law doubled into a **0.61** de-esser dose on
  material whose only property is that it is made of cymbals.

The scan now asks two things of the peak frame: the balance must **cross over** (7 kHz above 2.6 kHz, the
one claim a sibilant makes by definition — measured: the three organ voicings −1.94 / −2.27 / −2.74, four
"s" settings +0.51 … +5.16, and *identical* when the same "s" file is written 20 dB down, because it is a
ratio of two bands of one file and knows nothing of level), and the file's own **median** balance must not
already be over zero (−0.75 dB of hysteresis, smoothstepped). A file whose median frame *is* top-heavy is
asked for one more thing before its median tilt may count as evidence: a **band-limited top end** — 7 kHz
above 12 kHz, which is what makes an "s" an "s" and not a cymbal. Measured: the wash −0.47 dB, a
continuous "s" +2.11, every burst fixture +4.1 … +4.8, a +6 dB codec shelf −1.2.

Measured after: the organ **4.29 → 0.00**, the wash **2.52 → 0.00**, both `deess` **0.000**, and the chain
never ducks their 7 kHz band (+1.00 dB on the organ — its own `dullTop` air shelf — and +0.35 on the wash,
against −2.82 dB on the file that needs it). The counter-case is pinned by construction: a singer whose
"s" never stops reads scan 1.71 with a **0.463** dose (`sibSustained`), the audit suite guards deess > 0.4
on its own fixture, and the burst fixture of §10 is unchanged — still `sibilance`, still 0.71 of dose.

**The law keeps the median statistic out of the evidence seat.** `sibDb = scan + 2 · smoothstep(2, 8,
sibExcessDb)` could be armed by the tilt alone: the wash reads `sibExcessDb` 4.73 with a scan of 0.00,
and 2 × 0.58 was 1.16 dB of `sibDb` — enough, on a slightly brighter file, to name `sibilance` and duck
the top end it had just lifted (the argument the code already made for the codec shelf). The bonus now
needs the scan past its own dead zone (`smoothstep(2.5, 5, scan)`), **except** on a file the scan itself
calls *sustained* — where the median statistic is allowed to be evidence, because the case that gate
protects against is exactly the one the shape test now rejects. Measured: the audit's continuous sibilant
1.98 + 1.33 = 3.31 → de-esser 0.535 (0.07 without the flag), the wash 0.00 + 0.00, the +6 dB tilt
0.86 + 0.00.

* `tests/dsp.test.js` — a section of its own, 140 checks (was 134): a phrased organ, a sustained cymbal
  wash and an unending "s" each measured through the *engine* — dose and the 7 kHz band of the loudest
  20 % of frames (organ −31.0 → −30.0 dB, wash −20.3 → −19.9, "s" −18.2 → −21.0, its own biquads);
* `tests/audit.test.js` — 316 (was 313): the organ and the wash as named fixtures, plus the same-fixture
  guard that the audit's own sibilant still reads one (scan 1.98, `sibSustained` 1, deess 0.535);
* `tools/acceptance.js` — §10 gains the continuous "s" (scan + the chain's own 7 kHz meter) and §20 gains
  the two "not sibilance" rows (organ, wash) printing the ungated number beside the gated one, so each row
  re-derives its own before/after; 113 rows · 29 defect classes, exit 0 (`tools/work/acceptance-v2bb.txt`).

Measured: `npm test` **ALL PASSED (140 / 137 / 316 / 108 / 17)**, exit 0 (`tools/work/suite-round18.txt`).

### Fixed — the click as a file carries it: the duration gate on the crackle diagnosis is gone

**The gate that was added to stop the app naming music was rejecting the damage it was built to find.** It asked
for *fewer than 15 % of the spike windows wider than 0.25 ms* — the −20 dB duration of the tallest excursion in
the 8.5 kHz band — and it was tuned on the harness's click model, one to three samples wide. A click as a file
really carries it is not that: it is a **damped oscillation at the cartridge resonance**. Measured on a 9 kHz ring,
9 per second, on the fixture's own bed (spike windows · share wider than 0.25 ms · index as it shipped):

| ring | spikes | > 0.25 ms | index |
| --- | --- | --- | --- |
| τ 0.1 ms | 56 | 0 % | 1.00 |
| τ 0.3 ms | 61 | 8 % | 0.89 |
| τ 0.6 ms | 58 | **21 %** | **0.00** |
| 4 kHz, τ 0.6 ms | 26 | 19 % | **0.00** |
| 12 kHz, τ 0.6 ms | 57 | 98 % | **0.00** |
| τ 0.6 on a crash bed | 12 | 33 % | **0.00** |
| τ 0.6 6/s over a groove | 27 | 33 % | **0.00** |
| a 130 Hz thump + ring | 54 | 20 % | **0.00** |

Six of the eight rings in the table were invisible to the chain — no card, no dose, every click left in the file.
Without the gate they read 1.00 · 0.89 · 0.73 · 0.81 · 0.70 · 0.34 · 0.47 · 0.73, and the chain repairs them: measured by the app's index 0.73 → **0.00** and by an independent time-domain meter (per click, 4–12 kHz,
against the same file without the clicks) **+13.6 dB → +0.2 dB** — that meter the regression guard's, built on the
app's own high-pass and a 4–12 kHz band; §20 measures the same thing with the acceptance tool's own biquads and
its own fixture, 13.1 → 0.8 dB. A ninth ring of the family, τ 1.5 ms, is still
not named, and it is the boundary this fix does not move: a ring that long *fills* the 20 ms window, so its duty
sits in the band a sibilant onset occupies (0.045–0.12) and the duty gate never lets it into the spike set
(probe `/tmp/duty15.js` and `/tmp/gate5.js`: duty p50 0.063 — 71 of its 72 windows inside the sibilant band
0.045–0.12 — and **1** under the 0.04 gate, so 1 spike window, index 0.00 and no dose).

**What guards a performance is the duty gate, not duration.** A window that carries a hit *with a tail* is filled
with the top end and fails the duty gate long before the index looks at it: nine realistic percussion fixtures —
a kick+snare+hi-hat groove, a snare with a 130 ms top end, a snare roll at 8/s, a hi-hat with 45 ms, a crash with
800 ms, a clave, a rimshot, a stick click with a 900 Hz body, a 4 ms burst with a 1200 Hz body — read **0 spike
windows each**, with and without the gate, and the same chain's de-clicker moves their hits by **0.30 dB** of peak worst
in the regression guard — **1.84 dB mean / 2.36 dB worst** of the 16 hits of §20's own performance fixture, at the
profile's floor dose (0.072), which is the per-sample trade every de-clicker has. The
fixture the old gate was tuned on (24 × 0.4 ms of HP-3 kHz noise, no body, no tail) is a click train by every
statistic here — duty 0.02–0.04, the band a pop occupies — and is named and repaired as one.

* a regression guard, because that is the part the suite did not have: `tests/dsp.test.js` now carries both
  families — a 0.6 ms ring (index 0.73, dose 0.67, repaired to 0.00 / +0.2 dB measured twice) and a drum
  performance (0 spike windows, dose 0.07, hits move 0.30 dB worst in the regression guard) — 134 checks, was 128;
* §20 of the acceptance matrix is rebuilt around them: the burst train's two rows are re-labelled as what the
  fixture is, and four rows are new — the drum performance (index · hit level through the chain, dose 0.072) and
  the click as a file carries it (index before/after 0.73 → 0.00 · the independent 4–12 kHz meter +13.1 →
  +0.8 dB). The *dense* case, measured through the app's own `crackleDetect` (probe `/tmp/dense-levels.js`): a
  groove with claves and a bell over it reads **0 spike windows and index 0.000** on a 6 kHz and on a 12 kHz bed
  and at −20 and at −60 dBFS — the duty gate is what carries it, exactly as it carries the nine fixtures above;
* the harness's impulse model of a click was the reason this was missed for a release: `addCrackle` builds one to
  three samples, and every fixture the gate was tuned on was built with it.

Measured: `npm test` **ALL PASSED (134 / 137 / 313 / 108 / 17)**, exit 0 (`tools/work/suite-round17.txt`; the
audit suite's own summary line is overwritten by the NUL bytes it writes while testing the progress bar — the
clean capture is `tools/work/audit-round17.txt`), and the acceptance matrix **108 rows · 27 defect classes**,
exit 0 (`tools/work/acceptance-v2ba.txt`), its rows byte-identical to `tools/work/acceptance-v2az.txt` before this
documentation pass.

### Fixed — three detectors named music: a clave is not crackle, an organ is not hum, a square is not clipping

**The crackle index could not tell a performance from damage.** It is a crest factor of the 8.5 kHz band,
and a clave's attack has one too. Measured, a pattern of 24 percussion hits of 0.4 ms — the attack of a clave
or a rimshot, nothing else wrong with the file — read **0.982**, so the vinyl card took it and the chain
spent a **0.702** de-click dose on it: the hits' peak level through the chain fell **13.97 dB** on average and
**53.32 dB** worst, against 0.49 / 1.25 dB for the identical chain with the de-clicker off. Two gates on the
index now, each for one measured family, and each on the *index* only — the crest statistics stay levels and
stay worth looking at:

  * **contrast ≥ 6 dB** (p98 crest minus the file's own median crest). A click *interrupts* its file; a
    55 Hz square wave is nothing but edges, so all 400 of its windows are spikes and its p98 equals its own
    median — 0.0 dB of contrast, where every crackle fixture stands ≥ 19.8 dB above a median that is the floor;
  * **fewer than 15 % of the spike windows wider than 0.25 ms** (the excursion's own −20 dB duration). A pop
    is the analysis filter's ring at any bitrate measured (5–10 samples); a drum rings as long as the drum
    does. The clave fixture is 32 % wide and reads **0.000** now, dose 0.063, and the same chain costs those
    hits **0.61 dB mean / 1.33 dB worst**. Every crackle fixture still reads crackle: §1 dry and at
    320 kbit/s, §17's worn rip at 128, the vinyl and garage sims, drums with pops on them.

The boundary is written down in the code and in the new §20, because a gate that is not written down is a
gate nobody can trust: percussion *inside a dense cymbal mix* still reads crackle, 0.693 on the §20 fixture
(cost 1.65 / 8.70 dB on the claves), because a crash's own onset is a narrow 8.5 kHz transient too. The two
populations genuinely overlap — those claves measure 2–18 samples of duration against 5–10 for a pop smeared
by a 320 kbit/s encode — so no duration bound separates them.

**And the hum detector's one real test could not run on music that never stops.** It asks whether the line
sits still while the music stops, which needs a 1 s segment 6 dB below the file's median — a real silence.
On a file with none, it fell back to `persist = 1` (assume hum) and the verdict rested on `steady` alone:
measured, an organ piece whose pedal note is played at exactly 50 Hz in phrases reads a **25.6 dB** line,
steady 0.88, fallback 1.00 → named `hum` at **0.70**. The fallback is now a measurement: a 100 ms frame, a
20 ms hop, the line read *against its own ±30 Hz shoulders* in the same frame and compared to the frame's own
loudness — the **slope**, in dB per dB. A mains line is a constant (the §3 fixture **−1.00**, the sustained
tone **0.00**); a played note follows (the organ **0.88–0.91**) and the score is tapered to zero from 0.35
to 0.70. It replaces nothing: a file *with* quiet passages keeps the segment test exactly as it was — a hum
under a phrase is still a hum — and every hum row in the matrix, including §3's and §17's, is byte-identical.

**And the clipping detector named a synthesizer's flat tops a defect.** Both of its terms are floors: a
square wave satisfies them completely — measured, a 55 Hz square alone is **100.000 %** flat at its own peak
with an implied missing peak of **15.35 dB**, against 0.005–11.6 % and 1.65–2.04 dB for programme a real
transfer cut at 0.9 / 0.7 / 0.5 / 0.3 of its peak. Two ceilings, on the detector's `evidence` so both the
card and the dose inherit them: the plateau share at 70→95 % and the implied overshoot at 5→10 dB. The share
ceiling is deliberately the wider edge — how much of a legitimately clipped file sits at the rail depends on
the source's crest factor, not on the defect (a 997 Hz tone cut 2 dB down, the matrix's own clipping fixture,
sits there 42 % of the time) — so the overshoot is the sharp one. The square is not named clipping or crackle
any more; every clipped fixture the suite has (the audit's, e2e's, the matrix's tone and its over-limited
master) is untouched.

**Section 20 is new: a clean file is not named.** Every other section proves a repair; this one proves the
diagnosis keeps quiet about material that carries no defect of the class being measured — percussion (0.4 ms
and 5 ms), a square-wave bass, a phrased organ pedal at 50 Hz, a clean master and its own 320 kbit/s export
(so the user's loop is covered for a file with nothing wrong with it), with the gates' own numbers and the
boundary above on the rows.

Measured: `tools/work/suite-round16c.txt` — ALL TESTS PASSED (128 / 137 / 313 / 108 / 17), exit 0;
`tools/work/acceptance-v2ay.txt` — **104 rows · 25 defect classes**, exit 0, and its first 97 rows are
byte-identical to `acceptance-v2au.txt`.

### Fixed — the mono-maker measured a band it never folded, and folded bottoms that were merely wide

**The mono-maker measured a band it never folded.** The analysis reports the low band's correlation
through a one-pole at **200 Hz** (`stereoBands`) while the stage folded the side with a 2-pole corner
at **120 Hz**: bands that do not match, so the stage could never deliver on its own licence. Measured
on the acceptance §16 fixture: the chain's *own output* still read `outOfPhase` — and so did the
320 kbit/s export — i.e. the app reporting its own repair as unfixed. The fold now uses the same
one-pole the analysis measures with, and because the analysis reports corr(LP(L), LP(R)) with LP
linear, subtracting LP(side) makes that correlation 1 by construction. Measured: the low correlation
**−0.55 → 0.76** (the row's own second meter 0.16 → 0.92, from −0.10/0.61), and the issue is gone from
the chain's output *and* from the re-upload.

**And it folded bottoms that were merely wide.** The need curve keyed on *low* correlation
(`smoothstep(0.55, 0.05, rho)`), and zero is not the defect: measured, the audit's inverted-bass
fixture reads **−0.82**, the §16 fixture **−0.49**, and two independent pink noises — a legitimately
*wide* image, the one thing that must not be repaired — **+0.06**, which the old curve read as *full*
need. The engine's stereo-integrity test caught the consequence: the file's correlation moved
0.03 → **0.32**, past the ±0.25 that test allows. Need now reaches full only where a cancellation
does (≤ −0.35) and is zero at +0.05; the wide pair reads 0.03 → **0.03** (Δ 0.00) and is not named, a
mild cancellation (+0.97) is left alone, and both inverted fixtures still ask for the stage in full
(`bassMono 1.00`). The frontier is pinned in the audit suite (313 assertions now) rather than argued.

**And the same defect in the sentence.** The diagnosis list pushed `narrow` when
`m.correlation < 0.2` — the *opposite* of a narrow image, which is a *correlated* one (ρ → 1); the
card's own row is keyed on `widenNeed` and says so. Measured before the fix, on the engine's
wide-stereo pair (two independent pink noises, ρ = **0.030**, widener dose **0.000**, image out
untouched at 0.031): the app called it `narrow` — "almost mono" about the widest file it can be
handed — while a genuinely narrow pair (ρ = **0.982**, dose 0.457) was called nothing. The issue is
now pushed on the same licence the card's row uses (0.15), and the i18n label was aligned with what
the defect is (`enge Stereo-Bühne` / `narrow stereo image`, not "almost mono"). The assignment matrix
shows both sides: the wide control's issues `narrow → healthy`, the §16 fixture's dry list
`outOfPhase,narrow → outOfPhase`, and the narrow pair's own row now carries `narrow`.

### Added — the acceptance matrix re-uploads *every* class's export, not only the three that had a row

The user's own check — process, export 320 kbit/s, feed the export back — applied to the whole
matrix. The entry is recorded inside the matrix's own `run()`, so a class cannot forget it, and the
new section (§19) compares the input's issues, the chain's own output and the re-upload, marking the
one failure that matters: *the input has the defect, the chain's output does not, the export does*.

Measured (`acceptance-v2as.txt`): **97 rows · 19 classes · exit 0**, and **no class names a repaired
defect on its export** — including the classes that arrived as a 128 kbit/s MP3, where the re-upload
is a second generation of lossy coding, and the two classes that had no export row before (`dc` and
`outOfPhase`, both `healthy` on the export now). Where the encoder itself adds a reading, the row
says so instead of counting it as a return.

### Fixed — the sub-sonic guard's ceiling left a saturated rumble floor in place

The guard's corner was `clamp(18 + 6·need, 0, 24)`: whatever the floor measured, the stage never
went above 24 Hz. On the acceptance §4 fixture — a bed high-passed at 60 Hz with a 4th-order noise
floor below 35 Hz mixed into it, 15.5 dB of the app's own `infraExcess` — the ceiling was the whole
story. The chain came out at **10.6 dB** with its quiet 20–45 Hz band still **22.4 dB above the
mids** (the rumble exactly where it was), and the 320 kbit/s re-upload was still diagnosed `rumble`:
the app naming its own un-repaired defect, on its own export.

The corner is a measurement, so it now has a second rung:
`clamp(18 + 6·need + 18·smoothstep(0.55, 1, need), 0, 42)`. The low rung is unchanged, and a
*saturated* floor — 8 dB or more of measured excess, i.e. quiet passages whose 20–45 Hz band sits
that far above the file's own mids — reaches **42 Hz, the top of the band the statistic calls
rumble**.

* Measured on the same fixture: `infraExcess` 10.6 → **3.7 dB**, the quiet 20–45 Hz band 22.4 →
  **7.2 dB** above the mids, the 8–20 Hz band −38.1 → **−93.3 dBFS** (past the bed's own −68.9),
  and the re-upload is diagnosed **`dullTop`** — the rumble is no longer on it.
* The depth is what spends the removal: with sections 2–4 parked at 1 Hz so only one runs, the same
  42 Hz corner leaves 10.8 dB — as bad as the old ceiling — where the four sections take it to 3.7.
* The rung is not free, and its price is measured: 42 Hz costs a sustained 35 Hz note **19.1 dB**
  against **3.4 dB** at the low rung, a 41.2 Hz line about 12 dB (the sweep's 38 Hz / −9.3 dB and
  45 Hz / −14.8 dB points bracket it). It is paid only where the quiet floor is the defect, and the
  fixtures that stay out of it are pinned by the suites: the audit's rumbly bed sits exactly on the
  rung's onset (8.0 dB → 21.3 Hz, unchanged), §17's worn record reads 19.6 Hz (unchanged), a bed
  with a sustained 35 Hz note never reaches the rung at all (the confidence gate: the unforced law
  measures 0 Hz on it), and a musical bass fixture — a kick plus a 41–82 Hz line — reads 3.8 dB of
  "excess" and gets no guard.
* The acceptance matrix: **74 rows, 18 classes, exit 0** (`acceptance-v2ao.txt`); the five suites
  **128/137/310/108/17** (`suite-round12.txt`); the matrix's other 69 rows are byte-identical to
  `acceptance-v2an.txt`, §17's rumble witness included.

### Fixed — the crackle statistic read sibilance as clicks, and the chain then "repaired" it

The de-clip / de-click detector asked one question per 20 ms window: how tall is the peak of the
8.5 kHz+ band against that window's own RMS. On clicks the question is right. On **sustained**
high-frequency noise it is a *level* measure — and the corpus is full of sustained high-frequency
noise. Measured, the acceptance matrix's sibilance fixture (a clean bed with twelve "s" bursts on it,
25 ms raised-cosine attack, no clicks anywhere) was named `crackle` by acceptance **v2aj** — its card
read `sibilance,crackle` — and the probe that went looking for the cause measured **0.269** of index
and a **0.512** de-click dose on the same construction: the chain damaged the file it was asked to
repair, and a clean pop-free master with sibilant vocals would have been next.

* A window now has to be a *spike* to speak: the detector measures the share of the window within
  10 dB of its own peak (scale-invariant by construction — 960 samples of any noise process put
  about a third of themselves above 0.3·peak, a one-to-three-sample spike puts 0.001–0.02 there) and
  admits only windows at or below **0.04**. Measured, the duty of the tallest-crest windows: the pop
  windows of the crackle and worn-rip fixtures **0.002–0.02** (a 128 kbit/s arrival included), the
  "s" onsets of the sibilance fixture **0.045–0.12**, the noise windows of every fixture
  **0.20–0.60** — the gate sits a factor of two above the highest pop and below every onset.
* The rank-3 global term takes its three peaks from the same spike population, so a file whose
  tallest high-frequency windows are bursts reads no repetition at all: before, that term alone was
  worth 0.195 of the sibilance fixture's index (20.8 dB of "global crest" off its own "s" bursts).
* A non-spike window is given the floor value instead of being dropped, so the 98th percentile still
  asks for *repeated* spikes and one glitch in an hour cannot carry the index. The consequence is
  deliberate and documented: on a file the chain has repaired the index sits on that floor
  (acceptance §1: **0.06 → 0.00** after the chain, **0.04 → 0.00** on the re-uploaded export; §17's
  worn record **0.11 → 0.00**) — where a comparison still needs to separate two nearly-repaired
  files, the **spike-window count** is the statistic that has not saturated.
* Witnesses: acceptance §10 carries the fixture's own row (`crackleIndex` 0.00 on both sides, de-click
  dose **0.07** against the 0.512 it spent before), the sibilance card is `sibilance` again with no
  phantom de-clicking in its output, and the audit's "a permission is not a dose" case now pins the
  spike count it was really measuring: 10 windows with the de-clicker off, 6 with the cassette
  ceiling applied in full, **0** with the dose the file earned. All five suites green
  (128/137/310/108/17) with the gate at 0.04.

### Added — the acceptance matrix's "everything at once" and its mirror

* **§17 · a worn record carrying every defect of its world at once** — rumble, mains hum, a worn top
  end, crackle, and a 128 kbit/s MP3 as the way it arrived — one row per class, each with its own
  meter and ground truth. Measured: crackle 8.51 → **−9.96 dB** over the clean bed (72/72 → 4/72
  pops, the app's index 1.00 → 0.00), and that is **§1's own result** (8.40 → −10.26, 72 → 3) — the
  de-hisser, the hum notches, the subsonic guard and the codec cost the de-clicker nothing, which is
  the "no repair undoes another" claim; hiss −37.76 → −41.93 dBFS; hum 30.77 → 18.47 dB (the codec has
  smeared the line); rumble 9.73 → 0.97 dB; music 0.62 → 2.18 dB. The export reads `hiss` (cassette),
  truthfully.
* **§18 · the hot modern master** — flattened envelope, mild saturation, clipped 2.0 dB below its own
  peak, arriving at 192 kbit/s: flat share **0.20 % → 0.02 %**, evidence 0.21 → 0.02, and the matrix's
  own 1e-4 counter **6.28 → 0.00 per mille**, 618 → **0 runs**. The app reads 8.7 → 8.7 dB of dynamics
  (it does not invent dynamics, and does not squash further: the 1.1 dB the crest statistic loses is
  its −2 dBTP ceiling + level ride, measured with the ceiling alone removed (11.86 dB) and with the
  whole output stage off (12.75 = the input)).
* **Export re-uploads for the three classes that had none**: mains hum (`hum → healthy`), rumble
  (`rumble,squashed,dullTop → **dullTop**`, `infraExcess` 3.7 dB) and sibilance
  (`sibilance → sibilance`, deess on the export 0.51). The rumble row was a **bug report against the
  chain** — the sub-sonic guard's 24 Hz ceiling could not touch a rumble that sits at 25–45 Hz, so the
  app's own per-frame excess still named its own export — and it is the row that found the guard's
  missing second rung (the entry above). The sibilance row stays a truthful reading rather than a
  failure: the fixture carries twelve bursts at a third of the file's peak, the chain takes the level
  inside them −24.97 → −30.90 dBFS and the excess statistic −0.5 → −2.6 dB, and what is left is still
  sibilance the export may name.

### Measured — the two repair stages that stay on the taste curve, and why

* **The de-clicker's amount is a repair depth, and the curve is its transient protection.** Applying
  it as *measured* (0.861 instead of 0.715 at the default intensity — 20 % more) buys **one** pop of a
  72-pop fixture: pops above the clean copy 3 → 2, pop energy −10.32 → −10.29 dB, crackleIndex
  0.061 → 0.016. It costs the fixture's kit **6 dB of snare** (−62.1 → −55.8 dB — 13 dB on the
  acceptance-shaped reproduction of the same fixtures), 2.3× the touched samples (4.37 → 9.99 %) and
  2.7× the clean master (2.74 → 7.46 %). At full dose the snare reads −51 dB and
  the kit 18.6 %. That cost is what the audit suite's own `snare < −55` guard is written around, so the
  dose stays on the curve — and the audit now **pins the comparison itself** (dose on the curve vs
  as measured: snare +8 dB, kit ×1.6, master ×2 at minimum), so the next round re-measures rather
  than re-decides.
* **The de-clipper's amount is only the detector's threshold** — `implied > 1.2 − 0.7·amount`; the
  waveform decides how deep the arc goes (the stage's own comment). Measured: the parameter is *live*
  (bypass −23.49 dB against −33.30 with it on the tonal contract fixture; on a hard-clipped noise
  fixture 0 → 0.05 moves the plateau error −23.23 → −20.96 dB) and *saturated* — identical to four
  decimals at every dose from 0.05 to 1.0 on the tone fixture, and within 0.02 dB on the noise one.
  "As measured" would therefore be a no-op that lowers the evidence bar for weak runs, so it stays on
  the curve too, and the dsp suite now pins the invariance (0.05 / 0.72 / 0.90 / 1.0 within 0.05 dB).
* Both verdicts are written into `presets.js` where `repairMeasured` is defined — the de-hisser is the
  one repair whose amount is a depth *and* a measurement, and it is the only one moved. (It was for one
  round: the **de-esser**'s amount is `0.85 · sibNeed · headroom` — a measurement too — and it moved in
  the round that follows; see the top of this block.) dsp 127 → 128,
  audit 309 → 310.

### Fixed — the key measured a *different* band than the analysis it follows

* **One bandpass where the analysis cascades two.** The de-hisser's key compares the 4 kHz+ band
  against a 1.45 kHz reference, and the source says so explicitly: "the analyser measures the hiss
  tilt as 4–16 kHz against a 1.45 kHz band reference, and the key here has to see exactly those two
  bands". The analyser cascades **two** bandpasses for that reference (`ma`/`mb`, two poles per side);
  the stage used **one** — whose flatter skirts reach up into the 4 kHz+ band the hiss lives in.
  Reproduced outside both, on the acceptance fixture: with the cascade the quiet frames' median tilt
  is **15.82 dB** and the loud median **−2.53 dB** — exactly the numbers the analyser exports — and
  with one filter **11.44 dB**, i.e. the single filter reads the noise's own body into the reference
  and *under-asks by the very noise it is looking for* (mid-band power: +1.85 dB over the whole file,
  +4.38 dB in the frames the noise owns).
* **Fixed by cascading it** (`mid1`/`mid2`), which is what the source always claimed. On the
  acceptance fixture: the noise-owned frames' band comes down **8.8 → 10.3 dB** (5.8 dB before this
  week's round of hiss fixes), the tilt step the card prints **8.39 → 5.82 dB**, the quiet passages
  ≥4 kHz **−38.66 → −39.78 dBFS**, and the re-uploaded export reads **5.23 dB** where the upload read
  18.35. The internal chain now closes exactly: the key reads **15.87** (the analyser says 15.82), the
  ask is capped to the card's 17.35 (the frame would ask 18.4), the gate holds **17.33** of it — 98 %,
  so the 60 ms ride is not the limit — and 15.94 dB per sample leaves the stage, **10.33 dB
  energy-weighted**, against the independent meter's 10.3 dB.
* **What it costs**: the quiet frames the music owns move 0.20 → **1.12 dB** of top end. Those are
  frames where the noise still contributes a dB or so of the top end, so this is the calibrated answer
  rather than damage — and the loud passages move 0.1 dB.
* **The cap now binds — by 1 dB, and it is still not the lever**: lifting it 3 dB buys **+0.27 dB**
  (10.56 → 10.83). The remaining 17.3 − 10.3 dB is the signal: the frames this fixture calls the
  noise's own still carry music where they are loud, and the level term opens the gate there.
* The previous entry's claim that this 4.5 dB was "an aggregation and frame-set difference, not in
  meters" was **wrong** — the measurement above shows it was the meter, and it is now zero.

### Measured — the hiss class's ceiling, and the three key fixes that are not one

* After this round's two fixes the class reads **18.35 → 8.39 dB** of tilt step (54 % of the hiss
  removed) and the export reads 7.66 dB. What is left is bounded, and it is measured:
  in the frames the noise owns, the noise is **32.4 dB** above the clean copy's own top end (the
  acceptance fixture has a ground truth — the bed is known), the analyser's file-level step says
  **18.35 dB** (its own calibration: 17.5 dB on the loop's fixture), the card grants a cap of
  **17.35**, the frame's tilt key asks **13.9** and the ride delivers **8.8**.
* **Why the key asks 13.9 and not 18.35**: its 1.45 kHz reference band is inflated by the noise's
  own body — measured against the known bed, the reference in those frames is **+16.1 dB**, the key
  reads HF/MID 11.6 dB where the noise's own tilt is 27.7. In the frames the music owns the
  correction term is **−0.00 dB**, so the contamination is exactly where the repair is.
* **Two formulations to repair the key were tried and rejected on measurement**:
  (1) a *level key* alone asks 2.9–7.6 dB inside the loud and music-owned frames where the tilt key
  correctly asks 0 — and on this fixture the level cannot separate the classes at all (the frame's
  top end over the floor: noise **1.30**, music **1.10**), i.e. it would dull music;
  (2) *inverting the two bands* (`P_MID = (HF² − N²)/10^(tiltRef/10)` — the one algebraically
  identifiable formulation) is degenerate: **3.9 dB** in the noise-owned frames against **7.6 dB**
  in the loud ones, the wrong way round, because the programme's tilt is not constant across frames
  and the two meters disagree by ~1.6 dB. **That disagreement was the bug**: the stage's reference
  band was a single bandpass where the analysis cascades two — see the fix above, which closed it.
* **The cap did not bind then** (lifting the law 0.95 → 1.0 was worth **+0.29 dB**), and after the
  mid-band fix above it binds by 1 dB and is worth **+0.27 dB** — the remaining gap to the frame's
  own 32 dB is the signal, not a knob: those frames still carry music where they are loud. The
  acceptance header carries the numbers so the next round does not re-derive them.

### Measured — where the dull-top class's line sits, and what the chain does with it

* Sweeping the low-pass corner of the same bed (19 kHz → 5 kHz) and asking the app: `dullIndex` goes
  0.00 → 0.62 and the `dullTop` flag turns on between **0.22** (9 kHz corner) and **0.37** (7 kHz); the
  chain lifts the 8–16 kHz band by 0.4 dB (13 kHz corner) … **2.7 dB** (5 kHz), with the air dose
  falling the other way — 0.324 at 5 kHz, 0.012 at 11 kHz, 0 at 13 kHz and above.
* A file the card calls dull (7 kHz corner: 0.37 → 0.22) comes out **healthy**. The double-pole fixture
  the row uses reads the top of the scale (dullIndex **1.00 → 0.86**, topLoss 1.00 → 0.78) and comes out
  with the card still saying **`dullTop`** — that is the synthesiser's own ceiling, not a missing
  repair: it derives what it adds from the band below the cliff and is not allowed to overtake it
  (`airRoom`), so a recording this dull is not turned into a bright modern one, and the card says so.
* The row now prints the verdict **pair** — before → after the chain — instead of only the dry one,
  which left the reader to guess which of the two had happened. acceptance 57 rows (unchanged count),
  exit 0 → `tools/work/acceptance-v2ab.txt`.

### Fixed — a measured repair was still being scaled by the intensity curve

* **The de-hisser's dose is its measurement, and the taste curve was scaling it.** `repair()` multiplies
  every repair by `0.35 + 0.65·p^0.85` — **0.830** at the default `p = 0.7` — so the law's own value of
  **0.920** reached the stage as **0.764**. The policy for a measured repair already existed next door:
  the hum notch and the measured resonance notches run on `fix()` — "either measured or they are not, and
  a slider at 100 % must not invent them". The de-hisser now follows it (`repairMeasured`), the slider
  still gating it to zero below 20 %, and the card's cap still deciding how much the evidence earns.
* **Measured on the acceptance fixture**: in the frames the noise owns the band comes down **8.79 dB**
  (was 7.69) and the tilt step the card prints goes 10.18 → **8.39 dB**; the frames the music owns pay
  **0.20 dB** (was 0.13); both clean-bed fixtures — a dull one low-passed at 7 kHz, a bright one at
  19 kHz — still measure a tilt step under 0.25 dB and a dose of exactly **0**.
* **The section's own rows move with it**: quiet-passage ≥4 kHz −33.39 → **−38.66 dBFS**, inside the
  frames the noise owns **8.8 dB** (5.8 at the start of the round), the music now stands 28.9 dB above
  the top-end floor (17.3 on the input), and the re-uploaded export reads a tilt step of **7.66 dB**
  where the upload read 18.35 — the app still names `hiss`, truthfully, with half the defect left.
* The de-clicker and the de-clipper are **not** moved: their amounts carry the same argument but their
  risk is the music's transients, and their rows are green as they stand. That is its own round.

### Fixed — the de-hisser's gate was slower than the pops it was protecting against

* **The 250 ms closing time was justified by a measurement of a chain that no longer exists.** The
  constant's own comment said a fast key lets a pop slam the gate — "measured on a worn record with 108
  injected pops, the chain left 38 HF frames above 15 dB of crest against 3 with the de-hisser off".
  That was taken with the de-hisser *in front* of the de-clicker. The order has since been turned
  around ("noise repair, most impulsive first"), a pop no longer reaches this key as a bare spike: the
  level term vetoes the tilt term's spike anyway (a burst drives `e` above t1, so `lvl` → 1 and
  `cutLevel` → 0, and the *smaller* of the two wins), and the de-clicker repairs what is left behind it.
  Re-measured on the same fixture the old claim used — a vinyl simulation with 108 injected pops — the
  pop witnesses are identical at 60 ms, at 250 ms and with the de-hisser switched off: the HF crest
  witness is **101 frames on the upload and 1 after the chain**, and the independent pop meter (its own
  RBJ 4 kHz band at the fixture's own pop positions) reads **−15.66 dB** over the clean copy.
* **What the lag still cost was the repair itself** — measured on the hiss fixtures at the doses the law
  asks for, in the band the repair owns:

  | close | hiss-owned band | music-owned | loud |
  |---|---|---|---|
  | 250 ms (as it was) | 6.06 dB | −0.02 dB | −0.24 dB |
  | 120 ms | 7.26 dB | +0.07 dB | −0.24 dB |
  | **60 ms (as it is now)** | **7.94 dB** | **+0.18 dB** | **−0.23 dB** |
  | 30 ms | 8.32 dB | +0.30 dB | −0.23 dB |

  On the acceptance fixture the section's own rows move with it: the quiet passages' ≥4 kHz goes
  −33.39 → **−38.20 dBFS** (was −37.24), **7.7 dB** inside the frames the noise owns (was 5.8), the tilt
  step 18.35 → **10.18 dB** (was 11.16), the music-owned frames 0.13 dB (was 0.02). The slider is worth
  +1.6 dB of band on the frames the noise owns (7.69 → 9.28 dB, tilt step 10.18 → 7.46), and the internal
  arithmetic now closes: the key asks 13.9 dB and the smoothed cut reaches **13.6** (it reached 11.5) —
  the lag, not the ask, was halving the repair. 30 ms buys another 0.4 dB for another 0.1 dB of music;
  60 ms is the knee. The comment, the constant, the README's stage table, the engine test's note and the
  acceptance section's header all carry these numbers instead of the retired argument.

### Fixed — the report printed a hiss gate that cannot move, and never re-uploaded the export

* **`hissAmount` is a 0–1 gate, not a size — and it saturates at a step of 5.3 dB**
  (`tiltEvidence = (step − 0.8)/5`). On section 2's own fixture it reads **1.00 on the input, 1.00 on
  the output and 1.00 on the re-upload**, while the number the card prints — `hissTiltStepDb`, how much
  of the 4–16 kHz top end the programme cannot account for — goes **18.35 → 11.16 → 10.40 dB** and the
  quiet passages' top end comes down **3.84 dB** (independent meter: an RBJ high-pass at 4 kHz over the
  20 ms frames that are 3 dB below the file's own median). A row that printed the gate alone said
  "nothing happened" about a repair that took 7 dB out of the noise; the rows now print the pair and
  the gate's saturation is stated on the row.
* **Where the repair acts, measured rather than asserted.** A quiet frame counts as the *noise's* when
  the clean copy's top end sits below the hiss's own — **48 of the 53** quiet frames. There the band
  comes down **5.8 dB**; in the 5 quiet frames the music owns, and in the loud passages, it moves
  **0.02** and **0.28 dB** — the numbers that have to stay near zero.
* **The dose law is not the lever, and the arithmetic says why.** Every repair is multiplied by
  `0.35 + 0.65·p^0.85` (`presets.js`, `repair()`), i.e. **0.830** at the default intensity, so the
  de-hisser's own ceiling of 0.92 reaches the stage as **0.764**. A certainty override in the dose law
  measured as a **no-op** (render dose 0.7636 before and after, internals already at the ceiling) and
  was withdrawn rather than shipped with a comment claiming something it does not do. What the slider
  is worth on the hiss-owned frames: **+1.25 dB** of band (5.85 → 7.10 dB at dose 1.0); what the stage
  applies of its key's ask (13.99 dB): **8.8 dB** median, energy-weighted 6.2, because the gate closes
  over 250 ms and only five quiet stretches (longest 960 ms) let it settle.
* **The export is re-uploaded for the two classes the user's loop is about.** Crackle: encode the
  finished file at 320 kbit/s, decode, and ask again — pop energy over the clean copy **−10.26 → −10.23
  dB**, the same **3 of 72** pops above it, and the app's own verdict on its own export **healthy**
  (`crackleIndex` 1.00 dry → 0.06 after the chain → **0.04**). Hiss: the export reads `hiss`, and the
  note says why that is the truthful answer — a step of ~10 dB is still a hiss, and no repair of this
  class removes 18 dB without taking the music's top end with it. Both rows take the alignment from a
  correlation (lag 0 samples on this fixture) instead of assuming it, because a window meter that is
  offset measures the bed.
* acceptance 53 → 57 rows.

### Fixed — the report compared a clipped file with a finished render, and what it printed was the EQ's phase

* **§5's first row compared two things that cannot be compared.** The plateau error (the metric the
  engine test uses) is a *phase ruler* on tonal material: rotating the original by **half a sample**
  reads −31.9 dB on the tone fixture and by **three samples** −16.0 — the whole range the row covers.
  Every EQ stage rotates phase and the exciter adds harmonics by design, so a finished render's own
  colouring floor sits ~10 dB above what the de-clipper contributes: measured with the shipped
  parameters, the clipped tone reads −23.46, the chain *without* the de-clipper −13.40, with it
  −15.24. As printed, the row said the chain had made the plateaus ~8 dB *worse* than the clipped
  file, i.e. the opposite of what happened.
* **The verdict is now a one-parameter control inside the chain that runs** — the shipped parameters
  with `declip` at zero — and where the waveform is knowable it comes out the right way (tone
  −13.40 → −15.24). Where it still reads *up* (noise, kick + bass) that is the metric, not the stage:
  how deep a noise crest went cannot be recovered from its run length (the detector's own fallback is
  capped at +3 dB) and no reconstruction can be closer than that guess.
* **The defect's own statistic is on the row again, as the pair the diagnosis actually reads** — the
  share of samples in flat runs at the top, and the peak the run length implies is missing. Tone
  **42.01 % / 2.05 dB, evidence 0.73** → **0.85 % / 0.07 dB, evidence 0.00**. Neither is a verdict
  alone, and both directions are measured: with the tonal stages off, a *restored* arc's smooth top
  reads 7.17 % of flat samples and 0.07 dB implied, while a clipped noise file's finished render
  still reads a 1.40 dB implied peak at a 0.001 % share.
* **An independent counter, which caught a bug in itself.** Runs of same-sign samples equal to within
  1e-4 of the peak (25× tighter than the detector's own tolerance): tone 15 952 runs / 160 256
  samples → **0 runs / 0 samples**, longest 11 → 0; noise 6 762 → 0; kick + bass 6 359 → 0. On the
  tone it counts exactly the app's 15 952 runs and the same longest run (11). The first version left
  the sign rule out and read 7.8 % on the noise fixture where the truth is 4.2 % — it merged two
  opposite clipped crests across a zero crossing.
* The repair-only reference was re-examined for the same reason and **kept**: its finished render
  reads 7.6 % of flat samples, but the independent counter finds 0 runs there and the evidence is
  0.00 — those are a restored arc's tops, not plateaus.
* New dsp row pinning the pair at engine level (`declip` off → on, the SOLO fixture): flat
  42.15 % → 0.13 %, implied 2.07 → 0.08 dB, evidence 0.73 → 0.00. dsp 126 → 127; acceptance
  47 → 53 rows.

### Fixed — the report's "squashed master" row tested a file the app called healthy

* **No fixture in either tool exercised the `squashed` class.** The acceptance row is named after the
  defect — but its crush (the song envelope re-applied at power 0.12, then `tanh × 1.6`) reads
  `dynamicRangeDb` **12.2 dB** with the card coming back **"hiss"**, i.e. a file the diagnosis does
  not consider squashed at all; the suite's wording test checked the *label* existed and nothing
  checked the class ever fired.
* **The wrong knob was saturation.** Measured across the crush constant on this fixture: ×3.2 →
  10.9 dB "healthy", ×5.0 → 9.3 dB "clipping", ×7.0 → 7.7 dB "squashed,clipping". The dynamic range of
  an over-limited master comes from its **envelope**, not from a limiter's knee — and a hard knee also
  writes the flat tops the de-clipper's plateau detector rightly names. Flattening the envelope
  (power 0.02) and keeping the saturation mild (×2.0) is what the class is: measured, the app reads
  **8.7 dB** and the card names `squashed` — and nothing else.
* The row now reads 12.82 → 11.45 dB (the chain's limiter cost on a file with almost no dynamics
  left, as measured in the limiter section below), and its note names what the app itself concluded:
  `the app reads 8.7 dB (its own "squashed" line is 9) · card squashed · glue dose 0.12 · warmth dose
  0.14` — before, the note printed bare doses beside a card that said "hiss".
* New audit row next to the limited-master dosing rows: an over-limited master must be **diagnosed**
  as one (8.7 dB, card `squashed`), not merely dosed for. audit 308 → 309.

### Fixed — a strong room ring came out of the chain still reported boxy

* **The resonance notch's ceiling was a flat 8 dB, and 8 dB is not enough for a strong ring.** On a
  +18 dB Q-4 peak over a bed the scan reports 8.5 dB of excess, the chain cut the ceiling's 8, and
  **the file it had just written still read 3.5 dB of excess at 223 Hz** — the export would have come
  back diagnosed boxy, the same class of dishonesty as the codec card this suite already fixed. A
  +21 dB ring (reported 10.0 dB) came out at 4.9 dB. Measured with the deeper cut: **10 dB closes the
  18 dB ring, 12 dB closes the 21 dB one** (scan 0.0, no resonance listed in either case).
* **Width is not the lever, depth is**: moving the notch from Q 6 to Q 4 (a third of an octave
  instead of a quarter) moves the residue 0.87 → 0.60 dB and pushes the app's own reading *up* to
  3.9 dB — so the depth, not the notch's shape, is what was missing. The ceiling is now 12 dB.
* **What it costs, measured**: over those rings the notch's own third of an octave loses **6.8 dB**
  and the two neighbouring third-octaves (110 and 440 Hz) move **1.0 dB** — the cut stays inside the
  third of an octave the design always wanted it in, which is why it may go deeper at all. Rings the
  scan reports at ≤ 5.5 dB — everything the acceptance fixture and the audit's own room fixture
  write, where `1.45 ×` the report is still ≤ 8 — are **untouched** by this change, which is why
  those rows' numbers do not move.
* Pinned by a new pair of audit rows in `audit · a room, not a note`: a ring stronger than the old
  ceiling could handle must come out **un-reported** (not half-cut), and the price must stay inside
  its own third of an octave.

### Measured — where the de-clicker's detector stops, and what moving it costs

* **The pops a de-clicker cannot see are the ones the statistic under-reads, and that is now a
  number instead of an open item.** At the automatic dose (0.71) the fast/slow ratio map plus the
  knee only let a spike through once the ratio reads ≈ 2.2. The acceptance fixture's *three
  quietest* pops (|a| 0.41–0.48 of a 0.34–1.70 spread) read **1.86–2.02** with `asym` 0.30–0.33 —
  below the 0.32–0.52 band that would discount the threshold for that shape, so the shape term is
  worth 0.007 there, not the 0.18 it could be. Measured in **four beds** (low-passed at 5, 7, 9 and
  12 kHz): 51–52 of 54 pops repaired, and **the same two or three left in every bed** — the floor
  belongs to the statistic, not to a fixture.
* **Moving the gate down is measured, and it is not worth it**: the ratio map lowered to ≈ 2.0 costs
  the drum kit's snare 24 dB of its 55 dB guard (−62.1 → −37.7 dB) and rewrites 30.3 % of a clean
  wide-band master (4.4 % at the shipped map); lowered to ≈ 1.9 it takes the snare to −13.6 dB and
  81.7 % of the master. The shape term cannot reach them at all (its whole budget is `0.25 ×
  amount` = 0.18 of confidence). So the floor is documented in the worklet itself and **pinned by
  an audit row** (`audit · the de-clicker's own floor`), which fails if any of those three numbers
  moves by more than a couple of dB.
* **The fill was suspected and cleared.** Inside a full-replacement window the prediction filter is
  fed its own output, so it has no input left and runs to a fixed point: measured sample by sample
  (#374596), `pred` freezes at −0.1785 for 60+ samples and the window becomes a ≈1.35 ms DC plate.
  It is a real trade — the residual is as loud as the music the window removed (median 0.8 dB of the
  music's own 4–12 kHz, worst 8.1) — and it is **the best of four fills measured** on the same
  fixture: the same filter fed the dry sample is worse on every witness (band median −0.8, leftover
  worst 46.8 dB), 3-tap extrapolation touches 69.7 % of the drum kit (snare −50.4 dB), 4-tap takes
  the snare to −0.3 dB and 98.8 % touched. The window *width* (pre/post 4/8 … 16/48) moves the
  leftover by under 1 dB, so width is not the lever either.
* **One measurement lesson from the same round**: the acceptance row's "3 of 72 pops above the clean
  copy" is a comparison that includes the limiter's local gain (with the de-clicker bypassed the
  same windows read 1.65/2.14 dB, with it engaged 4.01/3.69). On the residual — the chain on the
  dirty file minus the chain on the clean copy — the two untouched pops read 5.9 and 8.1 dB in their
  4–12 kHz band, and the *repaired* ones read ≈ 0.8 dB median, which is the fill's cost and not a
  leftover click. A survivor count is only meaningful with its meter named.

### Measured — what the true-peak limiter costs a squashed master

* **The card names "squashed" correctly and the chain then takes 1–2 dB more of the little
  dynamics the file has left.** Measured on the acceptance fixture at three crush levels, spread =
  the 20 ms envelope's p98 − p05: DR 8.1 dB in 11.38 → **10.38** (−1.00); DR 6.8 in 9.92 → **8.37**
  (−1.55); DR 5.3 in 7.91 → **5.81** (−2.09). The cause is the true-peak limiter, not the glue:
  with the ceiling off the same renders lose 0.44 dB, at −2 dBTP they lose 1.55. The mechanism is
  honest — a master peaking at −1.11 dBFS needs 1.1 dB of reduction to hold a −2 dBTP ceiling — but
  the gain is applied *inside* the loud passages (80 ms release) while the quiet ones come back up,
  so the loud/quiet ratio shrinks by more than the level does. A whole-file static trim would keep
  the ratio: measured, a trim of 0.5/1.0/1.5/2.0 dB (with `refDb` lowered to match) leaves the
  spread at −1.20/−0.89/−0.59/−0.52 dB with the peak still on −2.10. What a trim costs is loudness,
  and choosing between a 1.5 dB dynamic loss at the upload's level and a 0.5 dB loss 1–2 dB quieter
  is a decision about the promise "the output keeps the upload's level" — so it is measured,
  written into the limiter's own code with the numbers, and left as the named decision rather than
  silently changed.

### Fixed — a declared parameter the worklet never read (and the silent stage behind it)

* **`subSrc` was declared, written by the law, plumbed through the harness, read at its call site —
  and never assigned.** The sub-harmonic synthesiser's "look for the fundamental at 95 Hz, unless the
  bottom octave is *empty*, in which case move the corner up to where the bass band is" repair (added
  two rounds ago, with a measured justification in the code) therefore never ran in the worklet:
  `p.subSrc` was `undefined`, `setSource(undefined || 95)` fell back to the design corner, and the
  stage was silent on exactly the files it exists for. Measured with the worklet instrumented at the
  sub's own call site, on a recording high-passed at 200 Hz with the 240 Hz corner *asked for*: the
  stage ticked 384 000 times with `srcHz 95`, its gate shut (median 0.0000, p90 0.0000) because a
  95 Hz low-pass on that file has nothing above its own noise gate, and its output was zero. The
  only place the fault was visible was the row that measures what the stage does — the acceptance
  weak-bass row read −9.30 → −8.77 dB, i.e. nothing happened. With the read in place: `srcHz 240`,
  the gate open (median 1.0000), the tracked note ~150 Hz, the derived octave at 75 Hz, and the
  **34–58 Hz band rises from −96.7 to −85.6 dBFS — 11 dB out of digital silence** (the source has
  *nothing* there), while the band the row measures, 60–200 Hz, moves 0.7 dB because a sub sits
  under the band it was derived from (SUB_CAP 0.70 × dose × drive ≈ −14 dB relative to it). The
  repair is honest about its own size and the code says so.
* **The reverse-direction check is now a test**: every parameter in the worklet's descriptor list
  must appear in a `g('name'` read (the twelve EQ bands are read in a loop, which the check knows).
  This is the class of fault that no other check could see — a declared, wired, never-read parameter
  looks exactly like a working one until the row that measures its effect moves. It found `subSrc`
  to be the only one of the 58.

### Fixed — the app called its own export a codec problem

* **`codecLoss` asked only *where* a file's top end ends, never how steeply.** The card's
  "chopped-off highs (codec)" is driven by a measured ceiling below 17 kHz plus a dullness guard, and
  the app's own 320 kbit/s export satisfied both — because the *de-hisser had just done its job*: on
  a worn record the top octave is largely hiss, and taking the hiss down lowers the measured ceiling
  (`hfCutoff` 15 381 → 13 898 Hz) without touching the encoder's wall at 18.9 kHz. Measured across
  the population, the fall over the 1.6 kHz *above* the ceiling separates the two kinds of ceiling
  cleanly — a real bitrate wall loses **39–55 dB** there (96 kbit/s: 52.2, 128: 39.4, 64: 53.9, 32:
  53.0, 24: 55.1) against **10–20 dB** for a medium's own slope (the worn record 15.3, its 128 kbit/s
  upload 16.9, a vinyl sim 11.2, a cassette sim 10.4) and 24.6 dB for the de-hissed export. Both of
  `codecLoss`'s branches now ask for the size as well as the location: the cliff branch requires the
  cliff to *be* a cliff (`brickwall` > 0 on the same 9 dB definition a codec wall is measured with),
  and the ceiling branch requires the fall at the ceiling to be ≥ 32 dB. Result, end to end: the
  app's own 320 export is diagnosed **"hiss"** instead of "hiss, codec"; the worn upload reads
  crackle, hiss, hum (the wall at 19 kHz removed nothing audible — the medium ends first); the
  acceptance suite's own codec fixtures converge — the 64 kbit/s round trip now re-uploads to
  **healthy** (was "codec") and the 32 kbit/s one to **"dullTop"** (was "dullTop, codec"), so the app
  no longer tells the user to fix the wall it just fixed; and every real wall (24–64 kbit/s, the
  low-bitrate sims) keeps its name. The new audit section 'a ceiling is not a bitrate' builds both
  ceilings within a kilohertz of each other so the rows measure steepness and nothing else.

### Measured — what the de-clicker does when nothing is wrong

* **"The stage touches N % of the file" is a meaningless sentence without its threshold and its
  dose beside it**, and one that read badly — a healthy card's dose touching 60 % of a clean
  bed — turned out to be a `2e-5` threshold at a dose of 0.6, i.e. the wrong pair of numbers
  quoted together. Measured properly, on a clean wide-band master against the same render with the
  stage off, aligned to each side's own latency: at **dose 0.08** (what a healthy card asks) **0.06 %
  of samples move more than 0.002**, the RMS deviation is **−51 dB** and the 6 kHz+ band is unchanged
  to 0.00 dB; at **0.30** it is 0.09 % and −32 dB; at the **0.60 ceiling** 1.65 % and −23 dB with
  0.04 dB of HF. So the stage is a no-op until it is asked for a dose only a worn record asks for,
  and even at the ceiling it does not dull the file. Both halves are now rows in the audit
  ('and on clean material the automatic dose is a no-op', '…and even dosed to its ceiling it does
  not dull the file'), and the meaning of the kit's own touched threshold is written beside it in
  `tests/dsp.test.js`.

### Measured — what the sub-sonic guard cannot do

* **A sustained music note in the bottom end and a turntable floor are the same thing to every
  measurement the app owns**, and that is now measured rather than assumed. The guard is four 2-pole
  high passes at its corner; on one bed with a rumble ladder and a club-style 35 Hz note it takes a
  full-scale rumble's 8–20 Hz band down 28.8 dB and its 20–35 Hz band 9.0 dB for 3.2 dB of the
  music's 30–45 Hz — and it costs a *sustained 35 Hz note* 3.7 dB, because the note reads 10.8 dB of
  "excess" (above the knee that a pink bed clears at 1.6). Three candidate witnesses that would tell
  a drone from a rumble were measured and each fails: **level** (the note reads −10.2 dB against the
  level the music reaches, a full-scale rumble −21.6 — the note is *louder*), **stationarity** (loud
  minus quiet: note −4.0 dB, rumble −6.2) and **tonality** (peakiness over six narrow probes: a
  full-scale rumble 5.3 dB, the note 7.1 — 1.8 dB apart). The arm threshold therefore stays where the
  clean population says it separates, and the cost stays recorded in the code rather than tuned away.

### Fixed — a clean master was read as a *cracked* one

* **The crackle statistic's window selection was absolute, and on tonal material
  that selection *was* the statistic.** `crackleStep` cuts the 8.5 kHz+ band into 20 ms windows and reads
  their crest factors — but it only counted windows above an absolute `rms > 1e-5`, and it took the
  global term from the single largest peak in the whole file. On a sustained tone the 8.5 kHz band is
  nearly empty: the only windows that passed were the ones the analysis's *own* high-pass rings in at
  sample 0, and the 98th percentile of three windows is the second-highest of them. Measured: a pink
  bed read **0.075**, the same bed with three sustained sub-bass tones on it **0.175**, a plain 1 kHz
  sine **0.108** (against 0.000 for white noise). The 0.175 cleared the classifier's own "there is
  crackle here" gate (0.06), and together with the bottom end (read as rumble) it put a **clean,
  tonal master into the vinyl profile**: measured end to end on that file, a **0.45** de-click dose
  on material with no clicks, a 24 Hz sub-sonic guard, a card naming "rumble, crackle", and 2.2 dB of
  level lost. Two fixes, both measured: the window selection is now *relative* to the file's own
  typical HF window (within ~26 dB of the median — scale-invariant by construction, and the statistic
  is scale-invariant by measurement: 0.004 at 0, −10, −20 and −30 dB), and the global term is the
  **third** largest window peak, not the largest, because crackle is a repeated event. The same set
  now reads 0.004 / 0.004 / 0.000 / 0.000, while real crackle is untouched: a garage sim 0.817, a
  vinyl sim 0.956, the worn-record fixture 1.000. Every threshold that reads this number (0.06 in the
  classifier, 0.08 on the card, the dose knee at 0.03…0.40) sits in the gap that opened between
  0.008 and 0.817 — nothing was re-tuned, the measurement was fixed. The clean tonal master is now a
  general profile with a 0.08 dose and a card that names only the bottom end it has.

### Fixed — the loop's own rumble meter read the hum repair

* **The rumble measurement notched the mains out to half an octave past each band, and a 2-pole
  filter does not stop at half an octave.** The harmonics in between leaked: measured on a clean bed
  with one line at −30.5 dBFS, 100 Hz read **+20.0 dB** of infra excess, 150 Hz +13.5, 200 Hz +9.0,
  250 Hz +5.9, 300 Hz +2.6 — and on a bed 10 dB drier, 30.1 / 23.4 / 18.5. So a mains harmonic of a
  recording **with no rumble** was read as rumble and the chain was asked for a 24 Hz high-pass: a
  repair the file did not need, which is the failure this round is about, in the other direction.
  The analysis now cuts the mains once, at the front, with one comb of constant-Q notches shared by
  the three low-band chains, and the reach is the measured gain of the chains themselves (a pure
  line at *f*, as HP → LP leaves it: −14.1 dB at 100 Hz and −21.0 at 150 in the 20–45 Hz band;
  −2.4 / −1.7 / −1.7 / −2.4 / −3.1 / −5.3 / −7.6 at 100/120/150/180/200/250/300 in the 90–203 Hz
  reference band). It covers every harmonic of both grids from the fundamentals to 420 Hz, and it is
  *fewer* biquads than the three banks it replaces. Measured after it: a line at 50, 60, 100, 120,
  150, 200, 250, 300, 350, 400 or 420 Hz reads 0.5–2.0 dB, against 1.6 dB for the bed with no line
  at all — and a realistic hum (50…250 Hz, −8 dB per harmonic, −30 dBFS) on a record that *has* a
  rumble leaves the verdict where it was (16.5 → 16.3 dB, guard 22.4 Hz; before the comb the same
  hum read 14.7). Two rows in the audit hold it: 'a mains line does not hide the rumble underneath
  it' and 'and a mains harmonic cannot fake one' (six frequencies, worst 1.1 dB).
* **What is left is measured and stated**: at 500 Hz the reference band is only 16 dB down, so a
  line there still reads −16.4 dB of excess — a harmonic stops mattering past 420 Hz only because it
  would have to sit within 16 dB of the fundamental. And a line that *wanders* (vinyl and tape
  wobble move it 0.2–2 %, far more than a 2.5 Hz notch follows) raises both bands by ~11 dB while
  the ratio does not move: a clean bed reads −0.1 dB and a rumbly one 14.5. A steady line is the
  case that fakes a rumble; a wandering one is self-cancelling. Both numbers are in the code.

### Fixed — the loop's own rumble meter read the hum repair

* **The row measuring the bottom end used 95–105 Hz as its reference — the second harmonic of a
  50 Hz mains line.** The chain's hum repair takes that line out, so the row read its own reference
  moving: measured, the export read 12.5 dB against a control of 10.8 while the app's own statistic
  said the bottom end had not moved at all (guard 0). The reference is now **82–94 Hz**, beside the
  line rather than on it, and the meter skips the ±5 Hz neighbourhood of every mains harmonic in
  both bands — the same exclusion the app's comb does, for the same reason. The same fixture now
  reads **9.0 → 8.4 dB against a control of 8.9**: honest about a rumble the chain left alone *and*
  about why (below).
* **A fixture whose rumble is a whisper reads like a coin flip, and it is.** The worn record's
  turntable noise is 33.5 dB under its own bed, i.e. right at the foot of the guard's decision
  (measured: 4.12 dB of excess for the upload, 5.2 for the source it was encoded from, against a
  knee that starts at 4.5 — the 128 kbit/s codec discards about a decibel of a noise floor that far
  below the music). Two measured facts decide what to do about it, and neither is a threshold to
  move: the guard would not have helped *anyway* (a 24 Hz two-pole high-pass takes 4 dB off a rumble
  that sits at 20–35 Hz: measured 12.25 → 7.67 on the same fixture with its rumble 12 dB louder),
  and the same fixture with the guard armed converges — the export re-reads 2.26 dB, i.e. the loop
  does not re-report a rumble it removed. The row is left showing the truth, and the gap it exposes
  (a rumble *above* the corner of the guard is not repairable with a high-pass at all) is the next
  item rather than a number to tune.

### Fixed — a line that hid the bottom of the record

* **A 50 Hz mains line walked straight into the reference band of the rumble measurement, and a
  60 Hz one did not.** The statistic compares a quiet passage's 20–45 Hz energy with its 90–203 Hz
  energy, and it notches every mains harmonic out of both bands — but the margin below a band was
  half an octave, and half an octave below 90 Hz is 60 Hz. So on a 60 Hz grid the fundamental was
  notched; on a 50 Hz grid it was not, and it needed to be: the band's own two-pole high pass at
  90 Hz passes 50 Hz at **−10.6 dB** (measured on the band's own chain: −10.6 dB as shipped, −10.7
  with no notch at all, −220 dB with one), which is 25 dB above the floor of a quiet passage.
  Measured on the same record, layer by layer: **+8.5 dB** of infra excess with rumble and hiss,
  **−12.0 dB** with the hum added, the reference band up 22 dB while the 20–45 Hz band did not move.
  The consequence was not cosmetic — the wound fixture's crackle-and-rumble record measured −12.8 dB,
  so the card said "no rumble", the chain was asked for `infraHP 0`, and the turntable's bottom end
  came out of the chain untouched while the card named hum. The margin below a band never goes under
  the mains fundamental now: the same fixture reads **+7.0 dB** and asks **19.5 Hz**, the 128 kbit/s
  upload that carries it reads −12.8 → **+5.8 dB** (18.5 Hz), and the two cases that must not move
  do not: a plain bed still reads +1.5 dB → `infraHP 0`, and the newer-song scenario stays
  healthy → healthy. On the loop's own rumble row the chain now takes the record's bottom end
  **down 3.6 dB** against its control instead of the 3 dB it appeared to add. Two rows in the audit
  hold both halves of it: the same record with 50 + 150 Hz reads 16.3 dB against 16.5 without it
  (guard 22.4 Hz), and a flat bed with the same hum reads 5.0 dB → 0 Hz.

### Fixed — a pop the ratio could not see

* **The de-clicker under-repaired exactly the pops that arrive where the music is loud in the same
  band.** Its detector asks one question — how far above its own recent average is this sample — and
  a one-sample spike is diluted by that average: the same pop reads a ratio of 7 on a quiet bar and
  2.3 on a bright one, while the knee that decides the repair depth sits at 2.2–2.7. Measured on the
  new audit fixture (8 s of pink low-passed at 9 kHz, 9 pops per second, 150 of them 4 dB or more
  over the bed): the median pop fell 22 dB and one pop sat **4.6 dB above the bed** — the loudest
  thing left in the file, and the row that was failing. The detector now reads a second witness, the
  *shape* of the deviation: over the last 2 ms the two polarities of the residual `x − LP4k(x)` are
  occupied equally by the music's own HF (asymmetry ≈ 0) and very unequally by an impulse (≈ 1).
  Measured: **0.85** median at the pops, **0.18** at a snare attack (a hit raises the *signal's*
  envelope too, so its HF is part of it and not a spike on top of it), and 0.8 % of a plain bed of
  the same material crossing 0.4. Two milliseconds is the window that separates the three — at 1 ms
  the music crosses 0.4 five times as often, at 4 ms the pops' own reading falls back into the
  noise's. A shape that is an impulse now asks for less of the ratio's confidence — a quarter of the
  scale at full strength, half that at the automatic dose — and that is what closed the row: the
  surviving pop falls to **−4.9 dB** over the bed, the loudest survivor in the block reads
  **−33.0 dBFS** against its −50 dBFS line, and the median pop still falls 22 dB. The price,
  measured on the same runs: the drum kit's touched fraction 3.2 % → **4.4 %** (the guard is 8 %)
  and its worst snare window −66 → **−62 dB** (the guard is −55). A bare impulse used to come out
  5.5 % intact; it now comes out **0.6 %** — which is the point of the stage, and it is why the
  latency probe in `tests/audit.test.js` was moved: it used to rely on the de-clicker *failing* to
  repair an impulse. The probe now times the delay with the stage engaged but turned down (where it
  repairs nothing, measured for every dose from 0.02 to 0.10), asserts the delay to the sample, and
  the full-dose case asserts the impulse is gone instead.

### Fixed

* **The inter-sample peak was invisible below full scale.** The oversampling walk visited samples
  above an absolute 0.5, so a file 20 dB down reported −240 dB — "no inter-sample peak" — and the
  analyser handed the sample peak on as the true peak. The gate is now relative to the file's own
  peak; at full scale it is the same 0.5 it always was.
* **The flat-top detector read a quieter copy as a *more* clipped one.** The tolerance for "these
  samples are equal" was an absolute 0.0025, so a file 20 dB down had 20 dB more room for runs to
  survive it: run lengths, the median run, the implied overshoot and the de-clip dose all followed
  the upload's volume. Tolerance and silence gate are now relative to the file's peak.
* **The spectrum floor was an absolute −120 dBFS.** On a quiet file that clamps the top octave 20 dB
  early — measured on one fixture, the codec cliff moved from 17 402 Hz to 15 662 Hz and shrank from
  18.5 dB to 13.4 dB. The floor is now that much below the file's own peak, which is the same number
  for a master that reaches full scale.
* **The exciter's and the air synthesiser's noise reference cap (0.02) bit only on loud files.**
  Measured on the vinyl fixture, the reference came out 0.0214 at full scale and 0.002 14 at
  −20 dBFS, so the programme gate sat at a different level *relative to the music* and the same dose
  generated 44 dB less harmonic content. The cap scales with the file's peak.

* **Every render began with a quarter of the unprocessed signal in it.** The master-power
  smoother started at zero and ramped to its target over ~18 ms, so the first ~50 ms of every
  render — and of every *export* — was a dry/wet crossfade, and it carried a quarter to a third
  of whatever the chain had just repaired. Measured on the worn-record fixture, the de-clicker
  took the pop at sample 193 (4 ms in) out completely (detector at k = 1.000, output 0.000) and
  the rendered file still had 25 % of its 1.30 spike in it, which is why the app's own 320 kbit/s
  export was still diagnosed `crackle` on a re-upload. The smoother exists for a *change* of the
  knob: the first block now adopts the target, and the re-upload card of that recording reads
  `hiss, codec` instead of `crackle, hiss, codec`.
* **The de-clicker swallowed the first five milliseconds of every file.** Both envelopes of its
  detector start at zero, so at the first sample `fast / (slow + 1e-9)` is 1e9 — the detector
  called it a click, and the repair replaced the head of the file with the low-pass prediction
  of a signal that had not arrived yet, which is silence. The two feed each other (`inp` comes
  from the *repaired* output), so on a plain pink bed the chain's output was exactly 0.000 for
  its first 256 samples. Seeding the envelopes from the first residual is not enough — the fast
  envelope's 0.6 ms attack against the slow one's 4 ms holds the ratio at 3–8 for another ten
  milliseconds — so the stage now spends its first 1.3 ms listening, seeds its statistic from
  the largest residual in that window, and then has a valid ratio from sample 64 on. An event
  inside the first 1.3 ms is not repaired; that is the stated cost.
### Fixed — the true-peak claim

* **The inter-sample peak was under-read by 0.5 dB on transient material, and the limiter shared the
  error.** The estimator was a seven-tap windowed sinc in both the measurement (`ispDb`) and the
  limiter (`ISP_TABLE`). Measured on a bright percussive master against two independent meters — a
  32-tap interpolator in the test toolkit and ffmpeg's `ebur128` — the app reported −2.10 dBTP for an
  export that both put at −1.60: 0.4 dB *above* the ceiling it had just been asked to hold, with the
  limiter's gain derived from the same wrong number. Both places now build one 32-tap Hann-windowed
  sinc at four phases; the three meters agree to 0.00–0.03 dB, and the ceiling lands at −2.10 dBTP on
  tonal, squashed and percussive material alike. The limiter's look-ahead grew by the kernel's extra
  reach (76 → 88 samples, 1.83 ms).
* **A permanent check that does not use the app's own meter** (`tests/dsp.test.js`, *the true-peak
  claim, measured by somebody else*): a 48-tap Blackman-windowed sinc at eight phases — more taps, a
  different window, twice the phase resolution — has to agree with `ispDb` within 0.15 dB, and a
  limited export has to be under the ceiling by *both* meters.

### Added — six defect classes that had no acceptance row

The matrix had ten classes and the diagnosis names fifteen. The six that were missing — weak bass,
boxy mids, dull top end, harsh presence, a squashed master, an out-of-phase bottom — now each have a
row with a before/after and an independent meter, and building them found four defects in the chain
(the ones below). What they measure today:

* **dull top end** — the air synthesiser rebuilds 8.3 dB of the missing top (9–15 kHz vs 2–4 kHz,
  −32.4 → −24.1 dB on the independent meter), and the analyser's `dullIndex` follows.
* **harsh presence** — the fixture is a 3 kHz honk two filters deep (the analyser compares the 2–4 kHz
  median with the 0.8–1.6 kHz one against a −3 dB/octave reference, so a honk needs +9.5 dB over its
  own slope before it is called harsh): `harshness` 0.93 → 0.54 and the meter 13.7 → 10.6 dB.
* **squashed master** — the chain backs *off*: glue 0.26 → 0.11, warmth 0.31 → 0.09, and the dynamic
  range does not fall further (16.2 → 15.0 dB on the envelope meter; the file is already flat).
* **out-of-phase bottom** — `bassMono` brings the below-200 Hz correlation from −0.55 towards zero
  while the above-2 kHz correlation stays at 1.00, i.e. the repair writes only where it belongs.
* **boxy mids** — a broad 240 Hz hump is cut by 1.3 dB (the per-song EQ takes 2.2 dB at 200 Hz and
  2.0 dB at 450 Hz); it is the shallowest row in the matrix and the next candidate for a dose review.
* **weak bass** — see below: the row is what found the defect.

### Fixed — the bottom octave that was not there

* **A missing bottom octave was being filled where nothing could be filled, and then taken away
  again.** The "weak bass" action is a 60 Hz shelf on the tone curve plus the sub-harmonic
  synthesiser, and both assume the recording has *something* down there: the synthesiser tracks the
  fundamental through a 95 Hz low pass — by design, since looking higher would double a normal bass
  line's second harmonic — and there is nothing to track on a file whose bottom octave is empty.
  Measured on a file high-passed at 200 Hz, with each stage switched on alone: the synthesiser stayed
  silent (34–58 Hz −96.7 → −95.9 dBFS) while the 60 Hz shelf wrote 3.5 dB into the same empty band,
  and the per-song corrective EQ — whose trend reference has been dragged *down* by the hole, so the
  200–500 Hz region measures as a hump — took 2.5 dB at 200 Hz and 3.4 dB at 450 Hz out of the region
  that carries that recording's bass. The chain made the file 2.4 dB *thinner* than it found it. There
  is now a measurement for the hole (`subHoleDb`, the 34–58 Hz median against the 80–150 Hz one:
  −25.6 dB for that file, +5.2 for a flat bed, +4.1 for a vinyl sim, −3.2 for a hummed transfer), and
  three consequences: no fill is dosed into a band that measures empty, the per-song EQ stands down
  (a hole is not a balance), and the synthesiser's analysis corner moves from 95 Hz to where the bass
  band actually is, so the octave it derives is one the recording can carry (200 Hz → 100 Hz). The
  acceptance row for the class: the 60–200 Hz region against 300–900 Hz goes from −9.30 dB on the
  input to −8.77 dB after the chain, where the same file used to come out at −11.69 dB.
* **…and the same measurement now has to run in both modes.** `subSrc` is a parameter, so a profile
  the user picked by hand carries the hole measurement too instead of the fixed 95 Hz corner.

### Fixed — the bottom of the record, and a honk that was not a note

* **The rumble statistic was one FFT bin wide — and the bin next to it is the mains line.** The
  comparison below 45 Hz against a reference band above it took both numbers from the spectrum of
  the 43 ms analysis frames. Those frames are 23 Hz wide, so the whole "20–45 Hz band" was a single
  bin, and on a recording whose bed is high-passed at 150 Hz — nothing below the music at all — that
  one bin read 12.5 dB of *excess* (the 50 Hz line leaking into it), while a plain vinyl sim with
  hum and crackle read +3.7 dB. Both are above the threshold that arms the sub-sonic guard, so the
  guard was taking the bottom off recordings it should have left alone. The measurement is now made
  with filters per sample — three 2-pole pairs (20–45, 45–90, 90–203 Hz), each carrying its own
  notches on the mains line and its harmonics, because a 2-pole high pass at 90 Hz still passes
  50 Hz 10 dB down — and the ratio is taken frame by frame and reduced with a median, since one
  crackle pop lifts all three bands inside a single frame. The reported figure now separates what it
  has to separate: a flat bed 1.4 dB, the same bed with +6 and +10 dB shelves below 150 Hz 2.7 and
  3.7, a bottom-less garage recording −26.0, a plain vinyl sim −14.0 — against 7.4 for the
  acceptance rumble fixture, 15.4 for the worn record with a rumble under it and 16.6 for rumble
  alone. The knee moved with the scale (4.5–11 dB) and the 43 ms-frame version stays in the
  analysis as the documented artifact.
* **A sustained note was reported as a room resonance and notched.** The scan asks whether a bin
  stands ≥ 3 dB above its own smoothed neighbourhood — and a note stands 50–100 dB above it:
  measured with the app's own scan, a 997 Hz sine reports 96.4 dB of "excess", a 220 Hz sine
  52.9 dB, and both pass the narrowness test with Q 6. The depth that fits a colouration was then
  cut out of the note (at 997 Hz, Q 6 is a 166 Hz-wide notch). A resonance is a few dB above its
  trend — the card calls anything over 3 dB boxy and saturates at 9 — so the scan now also requires
  the peak to be a colouration rather than a partial (≤ 24 dB, three times saturation), which also
  stops it from double-notching a mains harmonic that has its own, precise notch.
* **The measured resonance was cut by a third of what was measured.** The dose was 0.55 × the
  reported excess, capped at 3.5 dB, and the cap was what bound: on a +12 dB Q-4 ring over a bed
  the scan reports 5.5 dB and the chain cut 3.0, which left the ring at +1.0 dB above the bed with
  an independent meter (the bed's own reading is −1.2 dB). The scan reports a *narrow peak* while
  the ring it names is wider, and the Q it reports (6, clamped) is narrower than the ring as well,
  so the cut has to match the ring rather than the peak: 1.45 × the measured excess, ceiling 8 dB.
  Measured: the ring now comes out at −1.28 dB against the clean bed's −1.24 — removed, not
  halved — while the sibling third-octaves at 110 and 440 Hz move by 0.3 dB over the whole 0…9 dB
  range. The automatic statistic agrees: `resoExcess` 3.8 → 0.0 dB (was 3.3).
* **A profile the user picked by hand did not notch a measured resonance at all.** The manual
  ceiling table listed only the colour and synthesis parameters; `box`, `width`, `airRoom` and `hum`
  were absent, and a missing ceiling is not a no-op — `clamp(x, 0, undefined)` returns `x` and
  `undefined * n` is NaN, which `num()` turns into 0. Measured before: with a fixture whose
  resonance the scan had just reported as 5.5 dB at 217 Hz, `buildParams('vinyl', …)` asked for
  `boxG1 = 0` — the picked profiles ran the resonance notch, the stereo width and the hum ceiling
  entirely off. The repair ceilings are now inherited from the automatic table.

### Added

* **`refDb` — the file's own peak, as a parameter.** The glue's threshold (−22 dBFS *at that peak*)
  and the warmth's drive read it; at full scale both are exactly the numbers they were. Measured
  before: with the fixed threshold the compressor did nothing at all on a file 20 dB down (effect
  −45.8 dB at 0 dBFS, none at −20 dBFS) and the warmth produced 30 dB fewer harmonics.
* **A permanent invariance test** (`tests/dsp.test.js`, *the analysis and the synthesis do not depend
  on the level*): two fixtures measured at 0 and −20 dBFS have to produce identical metrics with the
  levels exactly 20 dB apart, and every synthesis stage has to render the same file in both
  directions — with the true-peak limiter asserted as the documented exception.

## [1.6.0] — 2026-10-12

**The combination release.** The suite always dosed every stage from a measurement, but it still
picked *one* of the six profiles by a vote and threw the other readings away. Most real files are
not one thing: the classic record in a private archive is a 1970s album, ripped from vinyl, then
compressed to 128 kbit/s by whoever put it online — crackle, surface noise, transfer hiss and a
codec cliff in one file, so whichever profile won the vote, the treatments the other problems needed
were capped by it. Automatic mode now works on a chain instead of a label.

### Added

* **A diagnosis that names every problem, not the loudest one.** `classify` returns a chain of the
  profiles that carry evidence (from 30 % score upwards), the card's sentence becomes *"Sounds like
  several problems at once: vinyl rip + heavily compressed file"*, and the ZIP report carries the
  whole chain (`detected : lowbitrate+vinyl+cassette`). A band-limited source keeps its own name
  (*band-limited recording*) instead of being called a low-bitrate file, while still borrowing that
  profile's top-end rebuild.
* **A tone curve that is the mix of the detected problems.** The six band ceilings are the
  evidence-weighted mean of the detected profiles' curves (70 % vinyl / 30 % codec gets 70/30 of the
  two curves) — not the winner's curve. Measured on a vinyl+128 kbit/s fixture: the 7 kHz ceiling
  lands at **2.38 dB** between the vinyl 1.80 and the codec 2.60 instead of taking either.
* **Repair permissions are the union, doses stay measured.** Each profile's budget for de-hissing,
  de-clicking, sub-bass, air and the rest is a *permission*; a file with two problems gets the wider
  permission per stage, scaled by how much evidence it carries, and the measurement still decides
  the dose. Measured: **cassette tape with a little dirt on it** is diagnosed as cassette (0.60) +
  vinyl (0.40) and takes its spikes down **3.6 dB** at the recommended strength — where the
  single-profile answer managed 0.6 dB, because the cassette ceiling (0.20) was the limit, not the
  detector.
* **A measured codec cliff counts in full.** The low-bitrate score used to be discounted by hiss and
  crackle all the way through, which meant the most common combined file — an old vinyl rip at
  128 kbit/s — lost the codec treatment *because* it was noisy. The cliff is a direct measurement,
  so it now stands on its own (measured brickwall 1.00 → codec score 0.62 on the combined fixture,
  0.28 before), while the circumstantial terms (clean material, a dull top) keep their discounts.

### Notes

* A file with a single problem is still a file with a single problem: on a solo cassette the new
  mixing moves the tone by **0.03 dB** and the repair budgets by **0.00**, and the clean reference
  file is bit-for-bit the same decision as before (no parameter moves at all).
* A hand-picked profile is a decision, not a diagnosis: it is still used exactly as chosen, with no
  blending.
* Nothing about the single slider changed: the amounts still follow the same power curve, and 0 %
  is still a bit-transparent copy of the original.

## [1.5.0] — 2026-10-12

**The per-song release.** Until now the suite chose one of six profiles from the measurements and
the profile's *ceilings* decided how far each stage could go. That is still true — a profile is
never a curve to apply — but seven parameters are no longer amounts at all: they are measurements
of the file itself (where its noise starts, which split its de-hisser should use, where its mains
line sits, how percussive it is, how its bass arrives in the two channels), and four stages are new
and exist only when a file asks for them. Two files of the same kind no longer get the same
treatment: they get the treatment each of them measured.

### Added

* **A sub-sonic guard, dosed from measured rumble.** The quiet passages are compared below the
  music (20–45 Hz against 120–270 Hz, equal relative width, summed) and the guard is a 12 dB/octave
  high-pass at **18–30 Hz** — under the bass, where a turntable's rumble lives and no instrument
  does — and only when the confidence in that measurement is there *and* no mains line could be its
  cause (a 50/60 Hz line leaks into the band below it at any sane FFT resolution, and a hum is a
  notch, not a reason to take the bottom off the record). Measured: a rumbly fixture gets 22 Hz, a
  clean pink programme 0 Hz, the garage fixture 0 Hz.
* **A per-song corrective EQ — twelve bands, 50 Hz … 8 kHz, Q 1.4.** This is the part that is
  different for every song: the file's own departures from its own spectral trend, minus what the
  profile's six bands already shape, with a ±1.5 dB dead zone, a ±6 dB cap, boosts held back within
  18 dB of the measured noise floor, and no correction at all in a band the file does not fill
  (more than 22 dB under its own median). Measured on a dull 6 kHz-limited recording: the curve
  comes out `0 0 0 0 0 0 0 0 −0.1 −0.2 +0.35 +1.64 dB`, and pushing the slider from 0 % to 100 %
  moves the 9–13 kHz band by 6.1 dB.
* **A de-esser that fires on sibilance and only on sibilance.** A dynamic dip over 5.2–9.5 kHz,
  keyed on the fast/slow ratio of that band — a quiet "s" and a loud one are the same problem — and
  dosed from the measured excess of the band over the trend the rest of the spectrum predicts. It
  sits before the synthesisers, so the exciter and the air stage cannot rebuild what it just took
  out. Measured: a sibilant probe asks for 0.46, a recording without sibilance measures 0.00.
* **A bass mono-maker for a bass that arrives out of phase.** If one channel's low end is inverted,
  the two channels cancel below 200 Hz when the file is folded to mono — a mis-wired cartridge or a
  polarity-flipped bass microphone does exactly this. Measured: an inverted bass asks for 1.00, a
  centred bass for 0.00.
* **Measured rates instead of guessed ones.** The glue compressor's attack/release now follow the
  file's **percussive character** (crest factor), and the de-hisser's split point is the measured
  **start of the noise** (2.2–4 kHz), so a tape whose hiss begins at 2.5 kHz is repaired from
  2.5 kHz up instead of from a fixed 3.2 kHz.
* **Every one of them is named in the analysis**, in the same plain sentence as the rest, and the
  worklet's parameter set grew from 36 to **53** (all of them exercised by `tests/audit.test.js`,
  which now also proves that a sibilant, an inverted bass and a rumbly recording each move exactly
  one stage).

### Fixed

* **MP3 export wrote silence.** lamejs copies whatever it is handed straight into 16-bit buffers,
  so the −1…1 float mix from the renderer was written out as samples rounding to zero: a file with
  valid frames, a plausible size, and no sound. Independently decoded (mpg123): the file the old
  path produced measures **−∞ dBFS** — digital silence, 120 960 bytes of it — while the same signal
  through the fixed path measures **−17.8 dBFS RMS, −3.4 dBFS peak**. Both encoder paths (the worker and the main-thread
  fallback) now scale to 16-bit PCM with clipping and dither, and the stream is checked for a frame
  header and a sensible length before the download is offered — an encoder failure is reported as an
  error instead of being saved as a file that "worked". `tests/web.test.js` now listens at the
  encoder's input and fails if the samples stop being 16-bit PCM (the check was verified against the
  old behaviour: peak 2 instead of ≈23 000), and `tests/audit.test.js` checks the conversion itself
  and that *both* paths perform it.
* The de-clicker's amount no longer takes a 30 % cut on material whose crest factor is high
  *because* of its crackle — a crackly record is the one case where full de-clicking is what the
  file needs, and the vinyl profile's ceiling for it rises from 0.75 to 0.85. Measured: the vinyl
  fixture's spike crest comes down 1.9 dB at the recommended strength.
* **Crackle survived the de-clicker on anything that had been through a codec** — a vinyl rip
  downloaded as a 128 kbit/s MP3, the round trip the beta report is full of. Two mistakes in one
  stage. First, the amount scaled the *depth* of every repair, so at the automatic dose (0.715 on a
  crackly record) each detected pop kept 29 % of its amplitude: the knob now moves the detector's
  confidence threshold instead, and a pop that is detected is repaired. Second, and worse, the
  repair was causal: an encoder spreads a three-sample pop over the 26 ms window it codes in, and
  96 % of the pop's energy ends up within ±40 samples of the spike — two thirds of it *before* the
  spike, where no causal repairer can reach. Replacing the waveform with the *ground truth* from the
  peak onwards still measures a crackle index of 0.63–0.68 however long the window is; a causal
  window that fades in leaves the smear behind *and* steps on the residual, which measured 1.00 —
  the repair becoming the click. The stage now takes half a millisecond of look-ahead (0.35 ms:
  17 samples at 48 kHz) and plans the repair window around the detection, 0.33 ms in front and 1 ms
  behind. On a 24 s vinyl fixture with 216 injected pops through 128 kbit/s at the automatic dose,
  the measured crackle index **1.000 → 0.232** (297 → 22 spike frames; the same music encoded
  without the pops reads 0.062) where the old stage reached 0.665, and on a 96 BPM drum kit the
  change in the 2 ms around a snare is **−84 dB** against −31 dB before — the wider window is also
  the *gentler* one, because a repair that covers the whole pop no longer has to fade in on top of
  it. The price is the delay: the master cross-fade delays its dry side with the stage, and the
  processor reports the figure as `this.latency` (`H.renderEx` in the test harness hands it to the
  suites).

## [1.4.0] — 2026-10-12

**The measurement release.** Three repairs that were dosed from a number nobody had ever checked
now measure the defect itself and subtract exactly that: mains hum is notched by the level its own
line stands above the music, hiss is recognised by the tilt of the top end in the gaps rather than
by a level that sane recordings never have, and the two strongest room resonances are found and
notched by hand-picked frequency and depth. A narrow stereo image gets its sides back — but a mono
master stays mono. Nothing about the interface changed.

### Added

* **Mains hum is measured, then removed — and only that.** The exact frequencies are examined
  directly (50 and 60 Hz and their harmonics, each against its own shoulders five hertz away) in a
  one-second Hann window, on a decimated copy of the signal, and the line has to be there for the
  whole file *and* refuse to drop when the music drops: that is what tells mains hum apart from a
  bass note that happens to be written at 50 Hz, and it is why a perfectly steady tune no longer
  has to be damaged to repair a hum that was never there. Measured: a garage recording with
  **13.4 dB** of hum above its own neighbourhood comes out at **2.5 dB** — below the detector's own
  3 dB line for calling something hum — at the recommended strength, and **1.8 dB** at full
  strength. The build before it left the line exactly where it was (its demand law never fired on
  that material) and even added half a decibel; the 100/150 Hz bands are untouched because the hum
  has no energy there, where the old harmonic notch fired whenever the fundamental did and took
  20 dB out of them.
* **The notch is three hertz wide, not five, and it sits last in the chain.** Hum drifts in hertz,
  not in octaves, so the width is absolute and the frequency is the measured one. Placed last,
  after the exciter, the sub synthesiser and the saturator — all of which put energy back at the
  mains frequency — it has the final word; the narrower bell costs the octave below half a
  decibel instead of 2.5 dB.
* **A hiss measurement that works on loud material.** A tape hiss at −49 dBFS is 20 dB *below* the
  quiet parts of a normal recording, so every floor-based detector misses exactly the case a
  listener hears. The analyser now measures the **tilt** of the top end (4 kHz+ against the
  1.45 kHz band) separately in the loud frames and in the quiet ones: programme keeps its tilt
  when it gets quiet, a hiss does not. The difference is a calibrated number of decibels — how
  much of the top end is not programme — and it is what the repair subtracts. Measured: 7.7 dB on
  the 1970s garage fixture, 3.9 dB on the cassette, 0.0–0.1 dB on clean, codec-damaged and vinyl
  material (so nothing happens there).
* **The de-hisser is keyed on the same bands and the same window as the analyser** — a 2048-sample
  sliding RMS of the 4 kHz+ band and of the 1.45 kHz band, where it used to be a peak-ish envelope
  follower, i.e. a different number with an arbitrary constant between it and the measurement. The
  dose is applied **in decibels**: half of the repair is −6 dB of the noise, where a linear
  crossfade of the gate gains is far less than that at the bottom of the range. Measured on the
  garage fixture: the top-end floor between the notes comes down **6.2 dB** and the programme's own
  top end moves by less than 0.3 dB; a steady hiss between the notes of a very quiet bed comes down
  32 dB; a loud, continuous master stays within 0.1 dB.
* **A file that is not made of numbers is refused, not "restored".** One `NaN` sample in a 32-bit
  float WAV poisons every recursive filter behind it — the output is silence, but a silence that
  cost a full render and looks like a successful one. The measurement now reports whether the file
  is numeric, the analyser refuses such a file with a message instead of rendering it, and
  `buildParams` cannot emit a non-finite parameter at all: whatever the measurement was, a stage
  that has no measured value does nothing rather than something undefined.
* **Two measured resonance notches.** The dynamic de-resonator can only pull down what rings above
  its own running average — a *constant* colouration is the average, so a boxy room or a honky
  cabinet survives it. The measurement now finds the two strongest narrow peaks (150–1800 Hz, at
  least 3.2 dB above the local trend) and notches each at its own frequency, depth (up to 3.5 dB)
  and sharpness.
* **Stereo width restoration.** An image whose channels are strongly correlated but not identical
  (a 1970s two-track master, a mono-summed CD) gets up to ~3.4 dB of high-passed side signal above
  200 Hz. A genuinely mono master is left alone: there is no side signal to widen, and inventing
  one would be a fake image.
* **The air synthesiser can now rebuild a top end that was never there.** Its source band used to
  be fixed at 6 kHz; on a codec-damaged file that band sits *above* the cliff, so it was
  synthesising out of rubble. It is now derived from the measured cliff (`0.72 × cliff`, 2.2–6 kHz)
  and the ceiling the synthesised band may reach above it (`airRoom`) is dosed from how much
  programme survived below the cliff.

### Changed

* **Mains hum is interference, not a medium.** The classifier no longer lets a measured hum vote
  for "vinyl rip" — a 1970s home recording on a cheap deck is hummy for the same reason a turntable
  is, and with the hum detector fixed it was single-handedly turning every hummy old recording into
  a vinyl rip. What marks vinyl out is what a needle does: crackle, rumble and surface noise — and
  low-frequency energy only counts as rumble when it is neither part of a flat noise bed (that is
  hiss) nor sitting on a measured mains line.
* **The garage profile gets a hiss term.** Tape hiss is as much a one-mic 1960s recording's problem
  as a cassette's, and the fixture that used to be diagnosed as a dull, thin, noisy recording is
  now measured as just that instead of as a turntable.
* **The analysis got several times cheaper.** The hum measurement used to be 21 resonators running
  over every sample of every frame and was the single most expensive thing in the measurement pass;
  it is now one decimated, windowed DFT of 27 exact frequencies. The four per-sample statistics
  (peak, clipped samples, loudness and dynamic range) used to be four separate walks over the whole
  file; they are now one, and the hiss band measurement fills its frames as it filters instead of
  keeping a copy of the filtered signal to read back — 280 MB of buffers on a three-minute stereo
  file that no longer exist. A three-minute stereo file measures in **1.3 s** in the suite's Node
  run (2.4 s before) and in **1.7–1.9 s** inside the test browser — measured cold, while the test
  process was still building the fixture — which is what keeps a phone inside its progress budget. (The largest remaining cost of an upload
  is not the measurement at all but the 40-second preview render through the worklet: 3.2 s in the
  test browser, measured.)

### Verified

* Five dependency-free suites: **552 checks** (dsp 73 · audit 224 · web 130 · e2e 108 · tuning 17),
  all green.
* The beta suite drives a real headless Chromium (drag-and-drop, Web Audio worklet, downloads,
  phone viewports) and now feeds it the **same synthesised recordings the node suites use**,
  served to the page and dropped like a user file, instead of signals generated inside the page.
  It measures the phases of an upload as well as its total, so a regression can be attributed:
  for a three-minute stereo take, decode 205 ms · measurement 1.3 s · preview render 3.2 s ·
  preview measurement 0.4 s.
* The mains notch has its own law section in the audit: a fixture with a *rich* hum (fundamental
  plus two harmonics) proves each harmonic is dosed from its own measurement, a pure 50 Hz line
  must not notch 100 or 150 Hz, the octave below the mains has to stay within 2 dB, and at 0 % dose
  the notch must be out of the signal path entirely.
* The de-hiss repair is a test, not a claim: the top-end floor between the notes has to come down
  by more than 3 dB while the programme's own top end stays within 0.5 dB.
* The two test bands that straddled the mains line (30–60 Hz and 32–58 Hz) now measure *below* it;
  they were subtracting a repair from a restoration and calling the difference "sub bass".
* The brightness and loudness contracts of 1.2.0 are unchanged and still enforced.

## [1.3.0] — 2026-10-12

**The progress-and-phone release.** A long file now says what it is doing, how far along it is
and how much longer it will take — and the whole interface is built for a phone browser
first, because that is where the suite gets used.

### Added

* **An honest progress bar, in two places.** The card shows the stage it is in
  ("Measuring the sound …", "Restoring the recording …", "Writing the file …"), a percentage
  and a coarse time left ("~12 s", "~3 min" — never fake-precise). A second bar above the file
  list reports the *job*: which file of how many, its name, and the same stage and percentage.
  On a phone that bar docks to the bottom edge, so it stays visible while the list scrolls.
* **Steps that cannot be counted sweep instead of lying.** Reading a file happens inside the
  browser's own decoder; there is no percentage to report, so the bar animates and the number
  stays empty until a real measurement starts.
* **The measurement itself became interruptible.** The analyser used to run 501 numbers over
  the whole file in one blocking pass. It is now sliced into ~26 ms steps that yield to the
  event loop, so the bar paints and the tab stays responsive on a phone — with the results
  proven bit-identical to the synchronous reference (`tests/dsp.test.js`).
* **The screen wake lock** is requested while a job runs and dropped when it ends: a phone that
  dims the display can suspend the tab and stall a queue mid-file.
* **A phone layout, systematically:** 44 px tap targets for every button and both sizes of
  segmented control, 16 px fields (so iOS does not zoom into them), safe-area insets for the
  notch and the home indicator, the footer's long donation addresses allowed to shrink, and a
  halved memory budget (420 MB) so a ZIP of WAVs cannot blow up a mobile browser.
* **Phone wording:** the drop zone says "tap to choose" instead of "drop files here" when the
  device has no hovering pointer, and switches live when the pointer changes (a phone with a
  keyboard attached, a tablet that gets a mouse).

### Fixed

* A single-file job was labelled "1 Dateien" — the batch wording is now only used for batches,
  and a one-file job leads with that file's name.
* The measurement phase (0–74 % of the analysis) was labelled "waiting in the queue", because
  the analyser's stage name was not in the UI's vocabulary. Every stage the analyser can report
  now has a word, checked by the audit.
* The percentage of the docked bar could be pushed off the right edge by a long file name — a
  grid track sized `auto` grows to max-content; both progress blocks now clamp it with
  `minmax(0, 1fr)`.
* **A real phone bug found in the browser:** the footer's donation addresses are long and
  unbreakable, and every `1fr` in the chain honoured their intrinsic width, so a 390 px phone
  laid the page out 449 px wide — the copy buttons for the tip addresses sat 36 px outside the
  screen. Fixed at each step (`minmax(0, …)` tracks, `min-width: 0` on the flex and grid items).
  The page now fits 320 / 360 / 390 / 414 / 768 px exactly, verified in the beta suite.
* Two buttons (the A/B and format segmented controls) measured 39 px on a phone — just under the
  44 px thumb target; they now carry the same minimum as everything else.
* The play/pause button never told a screen reader what it would do; it now carries a translated
  `aria-label` that follows the language switch.
* The audit's "no dead translation keys" check included the dictionary file in the code it
  scanned, so it could never fail. It now scans the application only, discovers the dynamic key
  families (`kind.`, `issue.`, `status.`), and the 17 keys it immediately found were removed.

### Verified

* Five dependency-free suites: **531 checks** (dsp 66 · audit 215 · web 126 · e2e 107 · tuning 17),
  all green.
* The beta suite drives a real headless Chromium: **61 checks, 19 screenshots**, including a
  390 px and a 320 px phone, thumb-target measurements, the docked bar's geometry, and progress
  rates sampled every 50–60 ms to prove the bars only ever move forward within a stage.
* The brightness and loudness contracts of 1.2.0 are unchanged and still enforced.

## [1.2.0] — 2026-10-12

**The tuning release:** the automatic mode was overdriven, and it is now bounded by
measurement at every stage. Nothing about the interface changed — the same slider does less,
and only where there is something to do.

### Fixed

* **The level match could never settle.** The matcher measured a level that its own gain had
  already multiplied, so the feedback loop settled at the *cube root* of the required
  correction, and it applied a `sqrt()` to a ratio of RMS levels, halving every correction.
  It now measures the pre-gain signal and compares plain RMS ratios: the music band
  (300 Hz – 3.4 kHz) comes out within **±0.3 dB** of the original on every test recording.
* **The headroom guard parked loud material on the clip knee.** It judged the *output* peak —
  after the very gain it controls — so on a dense master it kept ducking until the signal sat
  on the soft-clip knee. It is now keyed to the input peak versus the knee (`safe = max(dryPeak,
  knee)`) and only ducks what would actually be clipped. A loud master comes out at −0.28 dB
  mid-band instead of −4.7 dB.
* **The de-hisser coloured everything it touched.** It rebuilt the signal from the two
  Linkwitz-Riley branches; that reconstruction is flat in magnitude but *not in phase*, so it
  overshot the input peak by up to **+4.7 dB** on dense material — the soft-clip guard shaved
  the overshoot and the level matcher pulled the file down, audible as "overdriven and
  quieter". The split is still LR4, but whenever the gate is open the stage now returns the
  input sample unchanged, so it can only ever change what it is repairing (a steady hiss
  between notes goes down by 32 dB; the six test recordings above 6 kHz stay within 0.3 dB).
* **The DC guards rotated the low end.** Single-pole at 8 Hz in and 12 Hz out lifted the
  internal peak of a loud master (up to ×1.5 at 24 Hz) and shifted phase exactly where the
  sub-bass repair works. Both ends are now 2 Hz.
* **The exciters were not level-normalised** (a quiet file got less effect than a loud one)
  and the drive was scaled twice. The amount now scales the mix only.

### Changed

* **The profile anchors are ceilings, not curves.** Every amount is dosed from the
  measurement (`RSPresets.demand`): the bass lift from the measured bottom-octave shortfall,
  the top end from the measured top loss and codec brickwall, the de-resonator from the
  measured box/harsh excess, the de-hiss from the new hiss measurement. A band whose problem
  was not measured gets nothing — a healthy recording now measures as **unchanged** (air,
  exciter and sub are exactly 0, every octave band within 0.01 dB).
* **Repairs scale with the repair, synthesis with the deficit.** De-hiss and de-click keep
  half of the profile's amount and scale the rest with what was detected; sub, exciter and
  air get *nothing at all* when nothing was measured as missing. Nothing is applied "because
  the profile says so" any more.
* **`deriveRoom`** — the factor that separates "rolled off, worth rebuilding" from "gone,
  leave it alone" — now bounds the air and exciter amounts, and a hot, dense master is held
  back further (`headroom`, `dense`).
* **The corrective EQ has a dead zone.** Every recording has ±1.5 dB of natural ripple;
  correcting it was the automatic mode chasing its own tail. It now moves at most 40 % of the
  deviation beyond that dead zone, clamped to ±2.5 dB per band, and the profile curve is
  capped at 9 dB (manual) / 6 dB (automatic).
* **The amount curve** is applied to the EQ bands too (they used the raw slider before, so
  half power gave 3 dB where the slider said 6). Recommended powers: garage 0.85 → **0.75**,
  low-bitrate 0.75 → **0.72**, general 0.65 → **0.62**.
* **New hiss measurement** (`RSDSP.noiseAnalysis`): frame-wise high-frequency versus broadband
  dynamics plus the HF signal-to-noise ratio (`hissDeficitDb`, `hissLevel`, `m.hissAmount`).
  The old detector could not tell tape hiss from a cymbal; this one measures 0 on healthy and
  vinyl material and 1.0 on the cassette sim.
* `Version 1.2` in *About & credits*; README documents the dosing law and the new contract.

### Added

* **`tests/tuning.test.js`** — the tuning contract as 17 checks over nine recordings, because
  "it is too heavy" is a matter of numbers once it is written down: no octave band with
  content may move more than 3 dB (the sub-bass repair 6 dB), the music band must stay as loud
  (±0.8 dB), the soft-clip guard must stay out of material that was below the knee, healthy
  material must not be touched at all, synthesis must add the same dB at any input level, and
  **what the chain changes above 6 kHz must stay ≥ 18 dB below the music band** in automatic
  mode (≥ 12 dB even for a manually chosen profile at 100 %). Filling a dead top octave is a
  repair; a top end that arrives at music level is a fake modern sound — this is the check
  that tells them apart.
* Measured result of the automatic mode at its recommended power (mid = 300 Hz – 3.4 kHz):

  | recording | profile | mid | RMS | octave bands within |
  | --- | --- | --- | --- | --- |
  | garage | garage @0.75 | +0.07 | +0.13 | ±2.5 dB (dead top octave +12, 33 dB below the music) |
  | cassette | cassette @0.68 | +0.00 | +0.01 | ±0.1 dB |
  | vinyl | vinyl @0.70 | +0.03 | +0.20 | ±0.5 dB |
  | low bitrate | lowbitrate @0.72 | +0.06 | −0.30 | ±0.8 dB below 5 kHz, +1.3 above |
  | bright modern | general @0.62 | −0.00 | +0.03 | ±0.1 dB |
  | bass heavy | general @0.62 | +0.07 | +0.02 | ±0.7 dB |
  | hot master | general @0.62 | −0.28 | −0.24 | ±0.3 dB |
  | telephone band | cassette @0.68 | +0.07 | +0.11 | ±1.2 dB |

### Test contracts updated (product behaviour, not tolerance fixes)

* The stage tests (air, exciter, de-hiss, de-click, de-resonator) render with the level match
  switched off: with it on, a single module's change is partly undone by the matcher, which
  measures "how loud is the music" and not "how much did this module do".
* The slider-span bar in `tests/dsp.test.js` is 5 dB instead of 6: the span is measured through
  the shipped chain (matcher included) and measures 5.7 dB.
* `tests/audit.test.js` derives the expected direction of each EQ band from the same material
  and profile it measures, instead of from a different profile's anchors.

## [1.1.0] — 2026-10-12

First public release: the six sound profiles with automatic classification, the 21-parameter
AudioWorklet restoration chain (EQ, de-resonator, exciter, air synthesis, sub-bass, de-hiss,
de-click, glue, warmth/tilt, level match, soft-clip guard), live preview with an honest A/B
switch, batch rendering to WAV/MP3/ZIP, German and English UI, 100 % client-side.
