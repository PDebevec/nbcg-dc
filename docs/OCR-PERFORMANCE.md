# OCR performance: what to change, and what it was measured to be worth

Recognition is the pipeline's long pole, and this document is the result of
taking it apart on real archive material. The headline was not a tuning knob:
**`ocr.py` ran with PaddlePaddle's optimised CPU backend switched off, because
of a bug in a model that accounts for about 3% of the runtime.** Turning it back
on for the other 97% needed no new dependency and measured *slightly more
accurate*, not less.

The changes in section 7 have been applied. Sections 1-6 are the evidence that
led to them, kept because the next person to tune this will need to know how
these numbers were arrived at - and how easy it is to measure them wrongly.

Everything below was measured on this machine (Intel Core Ultra 7 155H, 16
cores / 22 threads, 15.4 GB, no NVIDIA GPU) against `arh/Cèrnagora`
(19th-century German, Latin script) and `processed/Budua und Cetinje` (an 1886
map).

> **A warning about measuring this on a laptop.** Sustained recognition
> downclocks this machine hard: the *same* configuration measured 15.2 s/page in
> one run and 47.7 s/page half an hour later. Every comparison below is either
> interleaved inside a single process or run back-to-back, and single numbers
> from different runs are not comparable. `py/tools/bench_ocr.py` should keep
> doing the same.

## 1. Where the time actually goes

Per page, measured stage by stage (`Cèrnagora/100.jpg`, 31 text lines):

| stage | seconds | share |
|---|---|---|
| detection | 1.3–3.4 | ~3% |
| textline orientation | 0.7–2.2 | ~2% |
| **recognition** | **14–48 per language** | **~95%** |

This kills one idea before it starts: detection is language-independent, and
`ocr_image` runs the whole pipeline once per language, so a lone image detects
twice. Sharing it saves **3.7–5.1%**. Not worth the code.

Recognition is the only thing worth attacking.

## 2. The finding: oneDNN is off for the wrong reason

`ocr.py` passes `enable_mkldnn=False` with an accurate comment saying it raises
`NotImplementedError: (Unimplemented) ConvertPirAttribute2RuntimeAttribute` on
paddlepaddle 3.3.1. That reproduces. But it is **only the detector** that
crashes. The recognisers run fine under oneDNN — and they are the 95%.

`enable_mkldnn` is passed through `**kwargs` to every submodel at once, so today
there is no way to have it for one and not the other. Hence the global `False`,
and hence the recogniser running on unoptimised kernels.

PaddleX already has the mechanism for exactly this situation: an
`MKLDNN_BLOCKLIST` of models that must fall back to the plain backend, which it
does with a log line rather than a crash. `PP-OCRv5_mobile_det` is simply
missing from that list — an upstream omission, not a decision.

Registering it makes the whole thing work:

```
oneDNN on the recogniser, interleaved twice in one process, same 31 crops:
    ON   15.67s   16.87s
    OFF  47.60s   53.43s
    identical_text: true   (31/31 lines byte-identical)
```

## 3. The second finding: the batch-size table was measured on the wrong backend

`DEFAULT_REC_BATCH_SIZE = None` is documented as "PaddleOCR's own choice, which
measured fastest — 20.20 s/page at the library default, 21.88 at 16, 24.74 at
32". That default is effectively **1**, and the table was taken with oneDNN off,
where batching cannot pay. With oneDNN on the ordering reverses completely:

| batch | 1 | 8 | 16 | 32 |
|---|---|---|---|---|
| seconds | 16.9 | 6.2 | 4.8 | **4.0** |

The two settings are coupled. Changing either one alone is why this was missed.

## 4. The third finding: oneDNN ignores `cpu_threads`

A worker is supposed to stay in a two-core lane. Under oneDNN it does not:

| | cores used | peak RSS | seconds |
|---|---|---|---|
| oneDNN off, `cpu_threads=2` | 2.0 | 342 MB | 43.6 |
| oneDNN on, `cpu_threads=2` | **13.5** | **729 MB** | 4.0 |

`OMP_NUM_THREADS` is what oneDNN actually honours, and it brings the memory back
down too:

| `OMP_NUM_THREADS` | 1 | 2 | 4 | 22 |
|---|---|---|---|---|
| seconds | 16.99 | 10.70 | 6.53 | 3.58 |
| cores used | 1.1 | 2.1 | 4.2 | 13.5 |
| peak RSS | 483 MB | 485 MB | 487 MB | 503 MB |

It must be set **before `numpy`/`cv2`/`paddle` are imported** — whichever loads
the OpenMP runtime first fixes the pool size, and a later assignment is silently
ignored. Setting it below `import cv2` measurably does nothing. Spawned workers
inherit it from the parent's environment.

This matters most to `nbcg_pipeline.workers`, whose `WORKER_FOOTPRINT_MB = 500`
is only true while the pin is in place (485 MB with it, ~730 MB without).
Without the pin the memory ceiling promises more workers than the machine holds.

## 5. What it is worth, end to end

| case | today | changed | factor |
|---|---|---|---|
| One page, full pipeline | 78.5s | 16.9s | **4.6x** |
| The 1886 map, both scripts (`ocr_image`) | 737.6s | 66.5s | **11.1x** |
| 24-page book, 6 workers, back to back | 389.0s | 147.2s | **2.6x** |
| 48-page book, 6 workers | 1066.2s | 484.0s | **2.2x** |

The book path gains less than a single page does, and that is expected: six
workers already saturate the machine, so making each one faster runs into the
same ceiling. The lone-image path gains most because nothing competes with it —
which is exactly the case that hurt worst, since the map took over twelve
minutes.

The 737.6s baseline for the map matches the ~720s measured on the real run
earlier, so the harness is measuring what the app does.

## 6. Accuracy: it goes slightly up

Scored as the share of alphabetic tokens that are real German words against a
50k frequency list — **not** confidence, which `nbcg_pipeline/ocr_lang.py`
already documents as ranking the wrong model first:

| sample | today | changed |
|---|---|---|
| 4 pages, recognition only | 73.06% | **74.13%** |
| 48-page run, real `.txt` output | 73.39% | **74.11%** |
| 24-page run, real `.txt` output | 72.42% | **73.25%** |

Three independent samples, all slightly up; the output text is 98–99.5%
identical. On the map the output is *exactly* identical in both scripts (796
letters at confidence 0.5023 Latin, 608 at 0.4295 Cyrillic) — a pure 11x with no
change at all to what was read.

**Where the small differences come from.** PP-OCR pads the line crops in a batch
to the width of the widest one, so batch composition perturbs CTC decoding.
Confirmed directly: pre-padding every crop to a uniform width makes batch size
irrelevant (batch 1 and batch 32 then agree exactly). oneDNN on its own, at
batch 1, is byte-identical; the differences come from the batching, and they
measured net positive.

## 7. The changes

**These have been applied.** What follows is what was done and why; section 5
records what it was worth on the bench, and the end of this section records the
same thing re-measured through the shipped code.

All in `py/ocr.py` unless noted.

**1. Pin the OpenMP pool — must be the first statement in the file**, above
`import numpy` / `import cv2`:

```python
import os
os.environ.setdefault("OMP_NUM_THREADS", "2")   # == DEFAULT_CPU_THREADS
```

**2. Register the detector in PaddleX's oneDNN blocklist**, next to
`DET_MODEL`. It does *not* have to precede `import paddleocr`: the append
mutates the same list object `runner.py` imported, and that list is read when a
predictor is built, so registering it afterwards works (verified). Wrap it, so a
PaddleX upgrade that moves this private module degrades to today's behaviour
instead of failing to start:

```python
try:
    from paddlex.inference.models.runners.paddle_static.config import blocklists
    if DET_MODEL not in blocklists.MKLDNN_BLOCKLIST:
        blocklists.MKLDNN_BLOCKLIST.append(DET_MODEL)
    ONEDNN = True
except Exception:
    ONEDNN = False           # detector would crash; keep oneDNN off entirely
```

**3. Turn oneDNN on** in `_build_engine`: `enable_mkldnn=ONEDNN`, replacing the
"left off deliberately" comment with why it is now on for the recogniser and off
for the detector.

**4. `DEFAULT_REC_BATCH_SIZE = 32`**, replacing `None`.

**5. Correct the stale comments.** The `DEFAULT_CPU_THREADS` table and the
`rec_batch_size` note were both measured with oneDNN off and should say so. The
thread conclusion itself still holds — re-measured with oneDNN on it is flat
(1 thread 15.6s, 2 → 14.6s, 4 → 14.8s, 8 → 15.3s, 16 → 16.2s), so
`DEFAULT_CPU_THREADS = 2` stays.

**6. `py/tools/bench_ocr.py`** has `mkldnn: bool = False` in its `Config`,
mirroring what ships. Once the above lands that default must flip, and the
batch-size row of its matrix needs re-measuring — the numbers quoted in
`ocr.py` today are only valid for the old backend.

**7. `nbcg_pipeline/workers.py`**: record in `WORKER_FOOTPRINT_MB` that the
500 MB figure depends on the `OMP_NUM_THREADS` pin, and is ~730 MB without it.

**8. `--cpu-threads` no longer governs recognition** on its own, since oneDNN
reads `OMP_NUM_THREADS`. Its `--help` says so, so that a bigger number is not
quietly ignored.

**Re-test after any paddlepaddle upgrade.** If the detector bug is fixed
upstream the blocklist entry becomes unnecessary and detection gets faster too;
it stays harmless in the meantime.

### Verified through the shipped code

Re-measured by running `py/ocr.py` itself, not the bench harness:

| case | before | after | factor |
|---|---|---|---|
| The 1886 map (`processed/Budua und Cetinje`) | ~720s | **38.9s** | **18.5x** |
| 24 pages of `Cèrnagora`, 3 workers | 389.0s | **131.8s** | **3.0x** |

The map still picks `rs_latin` at confidence **0.545** and still writes a
934-byte `.txt` carrying the same toponyms (Dalmatien, ČAKAVICA, SKADARSKO
JEZERO, Kp1516) - the same reading, and in one place a better one
("mittlerer" where the old run had "mitlerer"). The book run still detects the
dominant script correctly (`rs_latin=5602 confident letters` against
`rs_cyrillic=5221`) and still spreads across worker processes, which confirms
the blocklist registration survives the `spawn` re-import in each worker.

`py/tests` could not be run: `pytest` is not installed in this environment,
which `docs/OUTSTANDING.md` section 6 already records as a standing blocker.

### The regression this caused, and the fix

Making each worker faster also made it **much heavier**, and the first real
book run after the change was *slower*, not faster. It is worth being precise
about why, because the failure is invisible in any per-page benchmark.

oneDNN roughly doubles a worker's resident set (342 MB -> ~660 MB on the same
page). The app then compounded that in two ways this document had not
measured:

- **The PDF path is heavier than the page-image path.** Every measurement in
  sections 1-6 fed `ocr.py` a list of page images. The app more often hands it
  a PDF, and each worker then opens its own pdfium handle and rasterises into
  it. Measured in the app on a 522-page, 61 MB PDF with 11 workers: **mean
  643 MB, peak 745 MB** per worker.
- **`worker_count` sized from *total* RAM, against a 500 MB estimate.** Both
  halves were wrong after oneDNN, and the error multiplied: the memory ceiling
  computed 27 permitted workers on a 15.4 GB machine, so it never bound, and
  the core rule (`22 // 2`) started 11 workers regardless of what was free.

The result was 6.7 GB of workers plus 3.8 GB of desktop on a 15.4 GB laptop:
**0.7 GB free and ~1400 hard page faults per second.** The workers were waiting
on the pagefile, so the machine ran slower than it had before oneDNN.

Three constants in `nbcg_pipeline/workers.py` now reflect what was measured:

| | was | now | why |
|---|---|---|---|
| `WORKER_FOOTPRINT_MB` | 500 | **800** | measured peak 745, and a ceiling should budget peak |
| `RESERVED_MB` | 2048 | **4096** | non-OCR processes actually held 3.8 GB during a run |
| memory basis | `total` | **`available`** | total assumes an idle machine; this is a desktop app |

On the machine that failed, that is 8 workers and 6.4 GB instead of 11 and
8.2 GB. It matters far more on the small end, which is the whole point: an
8 GB laptop with 6 GB free now gets 2 workers rather than a number derived
from its core count.

**The general lesson for this pipeline:** throughput here is bounded by memory,
not cores. Overshooting cores costs a little; overshooting memory costs
everything, because paging replaces computing. A change that makes a worker
faster and fatter has to be re-checked against `worker_count`, not just against
a stopwatch on one page.

## 8. Considered and rejected

- **PP-OCRv6.** Exists as `PP-OCRv6_tiny/small/medium_rec` and is faster, but
  only for generic Chinese/English — there are **no Latin or Cyrillic v6
  recognisers**. It cannot read this archive.
- **Sharing detection between the two language passes.** 3.7–5.1%.
- **More inference threads.** Re-measured under oneDNN; still flat to worse.
- **Using `LanguageStrategy.run_page` for lone images**, so the second script is
  only tried when the first reads badly. Sound for text documents, but it does
  not help the case that motivated it: a correctly-read map yields **2.01
  letters per line**, well under `MIN_LETTERS_PER_LINE = 5.0`, so the retry
  fires anyway. That heuristic is calibrated for prose, and a map is captions.
- **Switching OCR engine** (Tesseract, EasyOCR, docTR). The current models are
  already validated against this material; swapping them risks accuracy on
  exactly the documents that matter, to solve a speed problem that turned out to
  be a configuration bug.

## 9. Later, if install size or GPU support matters

The app ships 924 MB of `site-packages`, almost all of it the PaddlePaddle
runtime; the four models themselves total ~22 MB. `onnxruntime` is a 14.3 MB
wheel, and **PaddleX 3.7.2 already contains an ONNX Runtime runner** with
arbitrary execution-provider support.

That is also the only realistic path to GPU acceleration here.
`nbcg_pipeline/device.py` is right that the GPU path needs CUDA, and therefore
NVIDIA — which this machine (Intel Arc iGPU) does not have, and neither will
most target machines. `onnxruntime-directml` runs on any Direct3D 12 GPU,
including Intel and AMD integrated graphics.

The cost is a one-time model conversion: `paddle2onnx` has no Python 3.13 wheel
(pip silently falls back to the 2021-era 0.9.2, which cannot read the current
PIR model format), so it would have to be a build step on 3.12. Note also that
the pre-converted multilingual ONNX models published on HuggingFace are **not**
drop-in: the "eslav" recogniser covers Russian, Bulgarian and Ukrainian, not
Serbian Cyrillic (ђ, ј, љ, њ, ћ, џ).

Worth doing for packaging and for GPU support. Not worth doing for CPU speed
alone, now that oneDNN is available.

## Appendix: two things worth knowing about this repo's Python

- The vendored interpreter has `python313._pth`, so it **ignores
  `PYTHONPATH`**. A script that imports `nbcg_pipeline` has to live in `py/`.
- Many narrow worker processes still beat few wide ones, even with oneDNN
  parallelising internally. On 24 pages: 1 worker 569s, 2 workers 175s, 6
  workers 152s. The architecture in `nbcg_pipeline/workers.py` is correct.
