# Listening tests: golden samples for Air synthesis, De-Click and BWE

Measures catch what they were written to catch. They do not say whether a restored
recording sounds right. This document is the manual protocol that closes that gap for three
psychoacoustic stages of the chain:

| Stage | What it adds or removes | Why a number is not enough |
|---|---|---|
| **Air synthesis** (`engine.js`, the air stage) | Synthesised content above the measured roll-off | A band can be "present" in a spectrum and still sound like a whistle, sheen or hiss |
| **De-Click** (stage 4) | Removes impulsive clicks by predicted repair | A click count can drop while the repair is audible as a smear or a lisp |
| **BWE** (bandwidth extension, the neural stage with DSP fallback) | Reconstructs the band above the source's cut-off | The result can be spectrally right and perceptually wrong (buzz, metallic ring, "wrong" sibilance) |

The protocol uses **3 to 5 golden samples**. Each one is a real archive recording, chosen
because it is a known hard case for one of the stages. The set is fixed for a major version,
so results from different releases can be compared.

**No audio is committed to this repository.** Samples are referenced by source URL, licence and
SHA-256 hash only. Keep the files outside the repository (for example `~/golden-samples/`).

## 1. The golden samples

Each sample needs a written entry in `docs/listening/golden-samples.md` before the first session
(the template is in section 6). The set below is the target; it is not yet sourced.

| ID | Source type | Era | Why it is in the set | Primary stage |
|---|---|---|---|---|
| **GS-1** | MP3, 128 kbit/s, 60 s excerpt of a studio pop or rock track | 1970s | Dull top end after a lossy encode; the ideal case for Air synthesis and BWE together | Air, BWE |
| **GS-2** | Vinyl rip (WAV or FLAC), mono, 60 s excerpt | 1960s | Dense clicks and crackle on a quiet passage; the benchmark for De-Click | De-Click |
| **GS-3** | MP3, 96–128 kbit/s, 70 s excerpt of a cassette-era recording | 1980s | Hiss, a soft top end and a cut-off around 14–16 kHz; the BWE stress test | BWE, Air |
| **GS-4** | Vinyl rip (WAV or FLAC), stereo, 60 s excerpt with fast transients | 1970s | Surface noise plus percussion. Tests that De-Click leaves real transients alone | De-Click, Air |
| **GS-5** *(control)* | Clean, already-good 70 s recording (MP3 at 320 kbit/s or better) | 1970s | Must come out unchanged. Any audible difference is a false positive | All three |

Rules for choosing a sample:

* **Only lawful sources.** Public domain (verified per item), a licence that allows the use,
  or a recording the tester owns. Record the licence in the golden-samples entry.
* **Historical character.** The point is the real artefacts of the medium: surface noise, clicks,
  tape hiss, lossy-encoder roll-off. Do not use synthetic test signals here; those are in the
  automated suite already.
* **Excerpts of 60 s or 70 s**, so one session can cover all five. Keep the original length and
  start time in the entry.
* **Fixed once chosen.** Replace a sample only for a documented reason, and in a new major version.

## 2. Preparing a session

1. **Process the sample** with the release candidate. Export the restored file as WAV at the same
   sample rate as the source. Keep the stage settings in the results (the profile and the
   slider value, or the default).
2. **Build the three conditions** for each sample:
   * **A** — the original, unprocessed.
   * **B** — the restored file with the stage under test **on**.
   * **C** — the same restored file with the stage under test **off** (the rest of the chain is
     identical). C is the control for the stage, not for the whole suite.
3. **Level-match A, B and C** before listening, with the suite's own level match or an external
   loudness meter. The residual difference must be below 0.1 dB. A louder file is always
   preferred; level-matching removes that bias.
4. **Blind the labels.** Name the files with random letters, and let a second person (or a script
   that keeps the key in a separate file) assign them. The tester does not know which is which.
5. **Listen** on the same reference chain for every session: the same headphones or monitors, at the
   same volume, with the chain and volume written in the session notes.

## 3. The tests

### 3.1 ABX: is there an audible difference at all?

For each stage and each sample pair that matters (B against C for the stage, and A against C on
GS-5):

* 16 trials per pair. X is randomly A or B; the tester answers which of the two it is.
* **Significance threshold: 12 of 16 correct** (one-sided binomial p = 0.038). With 11 of 16
  the result is not significant (p = 0.105), and it is recorded as "no reliable difference".
* On the control **GS-5, the answer must be "no reliable difference"** for at least two of the
  three listeners. A reliable difference on the control means the stage changes material it
  should leave alone, whatever the other samples say.

### 3.2 Preference: is B better than C?

Use a MUSHRA-style rating with hidden references and anchors, simplified for three conditions:

* Rate B and C on a 0–100 scale for **overall quality** and for the **stage-specific question**
  (below). A is shown as the reference and is not rated.
* Each rating is made after listening to the whole excerpt at least once.
* Record the rating and a one-line comment about any artefact heard, even if the rating is high.

Stage-specific questions:

| Stage | Question |
|---|---|
| Air synthesis | "Is the added top end air, or hiss or sheen?" |
| De-Click | "Are the clicks gone, and is the sound around them still natural?" |
| BWE | "Does the extended band sound like the recording, or like a separate layer?" |

### 3.3 Artefact check (free text, every sample)

Each listener writes down, for B, any of: *whistle, sheen, buzz, smear, lisp, pumping, metallic
ring, sibilance change, loss of transient, anything new*. Each word counts as one observation; a
word is not a score. Repeated observations on one sample are the signal.

## 4. Pass criteria

A stage **passes** a release on the golden set when all three hold:

1. **Control:** on GS-5, at most one of three listeners reports a reliable ABX difference for the
   stage.
2. **Preference:** on the samples where the stage is primary (table in section 1), B is rated
   higher than C by the median listener on at least **two of the three** samples, and it is not
   rated lower by more than 5 points on any sample.
3. **Artefacts:** no artefact word from section 3.3 appears on B for two or more listeners on the
   same sample. A single report is recorded and discussed, not ignored.

A stage that fails is **not** tuned to pass the test after the fact. Open an issue with the
results, the sample IDs and the measured values from section 5. Change the threshold only in a
dated entry in `CHANGELOG.md`, with the reason.

## 5. Companion measures

Each session also records the objective values of the same sample, so that a listening result
can be read against a number later:

* the acceptance matrix row for the stage (`node tools/acceptance.js`, with ffmpeg; the row name and
  value go into the session notes);
* the click count before and after (De-Click), and the band level above the source's cut-off
  before and after (Air and BWE);
* the file's true peak and integrated loudness, to show that the level match was done.

Measured values are a second opinion. They never override a failed listening criterion.

## 6. Recording the results

Results go in `docs/listening/results/YYYY-MM-DD-<stage>.md`, one file per session. Text only;
no audio. Use this template:

```markdown
# Listening session · YYYY-MM-DD · <stage> · release <version>

## Set
| ID | Source (URL) | Licence | SHA-256 of the source file | Excerpt | Stage settings |
|---|---|---|---|---|---|
| GS-1 | … | … | … | 0:00–1:00 | profile …, slider … |

## Chain
Playback device, headphones or monitors, volume setting, level-match method and residual (dB).

## Listeners
| Listener | Experience | Note |
|---|---|---|
| L1 | … | … |

## ABX (16 trials, threshold 12)
| Sample | Pair | Listener | Correct | Significant |
|---|---|---|---|---|

## Ratings (0–100, B and C)
| Sample | Listener | B overall | C overall | B stage | C stage | Comment |
|---|---|---|---|---|---|---|

## Artefact words (B only)
| Sample | Listener | Words |
|---|---|---|

## Objective companions
| Sample | Measure | Before | After |
|---|---|---|---|

## Verdict
Stage: pass / fail against section 4, with the reasons in one paragraph.
```

## 7. Status

* **Golden set:** not yet sourced. The entries in `docs/listening/golden-samples.md` are to be
  written when the samples are chosen.
* **Sessions:** none recorded yet. The first session is the baseline for the release that
  introduced this protocol.
* **Automated tests:** the acceptance matrix and the suite's own DSP checks run in CI on every
  change (see the README, *Tests*). They do not replace the sessions above.
