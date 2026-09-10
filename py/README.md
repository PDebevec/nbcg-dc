# `py/` — the pipeline scripts

Four standalone CLI scripts that do the archive's heavy file work: build PDFs +
a thumbnail from a scanned item folder (`web.py`) or from a supplied PDF
(`pdf_derive.py`), split 2-page spreads into single pages
(`split_spreads.py`), and OCR a PDF or image (`ocr.py`). Each maps to an
"operation" in
[docs/06-processing-pipeline-and-jobs.md](../docs/tasks/06-processing-pipeline-and-jobs.md):
`web.py`/`pdf_derive.py` → `pdf` + `thumbnail`, `ocr.py` → `ocr`, and
`split_spreads.py` runs as an invisible **sub-step** of `pdf` when the item
asks for it — not a visible stage of its own (see its own docstring).

**Wired to the Rust job runner (first slice).** All three scripts are spawned
for real by `core::jobs`/`core::python` in `src-tauri/`, via system
`python`/`py` on `PATH` (no sidecar bundling yet — that's Epic 11, deferred
while the app is dev-only). All six input shapes are handled. See
[docs/06-native-core-and-dev-setup.md](../docs/06-native-core-and-dev-setup.md)
§1 and [docs/06-processing-pipeline-and-jobs.md](../docs/tasks/06-processing-pipeline-and-jobs.md)
for what's still open (concurrency/queueing, true mid-process cancellation).
The scripts remain fully usable by hand from the command line too — nothing
about being driven by Rust changes that.

## Setup

```bash
pip install -r requirements.txt
```

- Python 3.13 — that is what the app actually ships and runs these scripts
  under (`scripts/vendor-python.ps1` vendors 3.13.15). **Not 3.14**, despite
  3.14.7 being the version originally verified here: `paddlepaddle` publishes
  no Windows wheel for 3.14, so `ocr.py` cannot run there at all. The other
  three scripts are fine on either.
- `web.py` and `split_spreads.py` need only Pillow.
- `pdf_derive.py` additionally needs **pypdfium2** — a self-contained wheel, so
  nothing to install by hand. Chosen over the alternatives on licensing as much
  as capability: PyMuPDF is AGPL (which would make the whole app AGPL for
  anyone it is handed to) and `pdf2image` needs poppler on `PATH`, a system
  binary. pypdfium2 is BSD/Apache with no system dependency.
- `ocr.py` additionally needs `paddleocr`, `paddlepaddle`, `numpy`,
  `opencv-python` (recognition), plus `reportlab`/`pypdf` (embedding the
  recognized text into the PDF) and `pypdfium2` (the PDF-rasterization
  fallback used only when no source images are available — see its own
  section below). No system dependency for any of it — `ocr.py` no longer
  needs poppler at all. The exact recognition-stack versions are unverified
  on Windows beyond one real end-to-end run.

**Editor / type checking.** `pyrightconfig.json` at the repo root scopes
Pylance (and the `pyright` CLI) to `py/` alone. Without it the vendored
runtime drops ~11k library `.py` files into the workspace — ~22k once
`src-tauri/target/` holds Tauri's bundled copy of it — against the 20 that
are actually ours, and Pylance warns that the workspace is large and offers
to slow down. Measured after: 20 files analyzed. This has to be a *tracked*
file rather than an editor setting, because `.gitignore` keeps `.vscode/`
local except `extensions.json`, so a settings-only fix would never reach
anyone else who clones and vendors. VS Code's own watcher/search exclusions
(`src-tauri/target` is ~12 GB, `arh/` ~3 GB) stay in `.vscode/settings.json`,
per-machine by that same convention.

## The seam-4 contract

Every script here follows the same CLI contract (Native ↔ Python, per
[docs/04-code-structure.md](../docs/04-code-structure.md)):

**arguments in → output files on disk + a JSON summary on stdout, with
human-readable logs on stderr, and an exit code.**

This split matters because stdout is meant to be machine-parsed: mixing log
lines into it would make the summary unparseable. `0` always means success;
scripts differ slightly on what `1`/`2` mean (below). All three pin their
streams to UTF-8 (`nbcg_pipeline.force_utf8_streams`) — Windows consoles
default to a legacy code page that cannot encode Cyrillic, and Montenegrin
scan folders routinely are.

### `web.py`

```
python web.py <folder> [--recursive/-r]
              [--mode {flat,paired}] [--name BASE] [--out-dir DIR]
              [--pages FILE ...] [--thumbnail-only] [--thumbnail-source FILE]
```

Detects the folder shape (or, given `--mode`, trusts the caller instead —
see below) and builds:

- **flat** (a plain folder of JPGs — every real scanner folder is this shape):
  `<name>.pdf` (web PDF, downscaled) + `<name>_thumb.png`. No archival PDF —
  the source JPGs are already lossy, so a same-quality PDF copy wouldn't be a
  genuinely higher-fidelity master; the source JPGs themselves remain on disk
  as the archival material.
- **paired** (`jpg/` + `tif/` sibling subfolders — secondary/legacy path):
  `<name>_archive.pdf` (from the TIFFs, full quality) + `<name>.pdf` (web,
  downscaled from the JPGs) + `<name>_thumb.png`.

`--recursive`/`-r` walks the tree and processes every folder found that looks
like an item; a folder that matches stops the walk descending into it. Not
usable together with `--out-dir` or `--mode` (the job runner, the only caller
of either, always processes one folder per call).

Flags added for the job runner, all optional and backward-compatible —
omitting them reproduces exactly the standalone auto-detecting behavior above:

- `--mode {flat,paired}` — force the shape instead of auto-detecting it by
  scanning for jpg/tif subfolders. The job runner already knows the shape
  (`ItemRunRequest.inputShape`, decided once in the `.ts` lane) and passes it
  here, so this script never re-derives a second, possibly-disagreeing
  answer — e.g. a genuine `page-images` folder that happens to also contain
  an unrelated `jpg/`+`tif/` pair would otherwise auto-detect as `paired` and
  build from the wrong source entirely, silently.
- `--name BASE` — name the outputs `<BASE>.pdf` / `<BASE>_thumb.png` instead of
  deriving the base from the processed folder's own name. The job runner passes
  `ItemRunRequest.folderName` — the naming base the `.ts` lane already decided
  (`domain/naming`, via `planPipeline`) — so this script never re-derives a
  second answer either. It is also what lets the runner assemble from a staging
  folder of split pages while the outputs are still named after the item.
- `--out-dir DIR` — write outputs into `DIR` instead of the source folder.
  The job runner stages here, then renames into place itself, for atomic
  writes (`docs/06-processing-pipeline-and-jobs.md`'s "atomic writes"
  requirement — the script itself doesn't do temp-then-rename, the caller
  does, using this).
- `--pages FILE [FILE ...]` — flat-mode only: the exact ordered filename list
  to assemble, instead of re-scanning and re-sorting the folder. The job
  runner passes `ItemRunRequest.pageImages` (the TS-computed authoritative
  order) through verbatim, so ordering is single-sourced — this script never
  re-derives it when driven by Rust.
- `--thumbnail-only` — skip PDF assembly entirely, build only the thumbnail.
  For `images-only` items (a standalone graphical work with no PDF at all).
- `--thumbnail-source FILE` — build the thumbnail from this exact file
  instead of the natural-first image. The job runner passes
  `ItemRunRequest.primaryThumbnail` through when the TS lane already resolved
  it (an auto-tagged `thumbnail.*` file, or an operator's pick) — this is
  independent of whichever images go into the PDF, and independent of shape.
  Falls back to the natural-first image (with an error noted in the summary)
  if the named file isn't found. May be an **absolute path**, which is how a
  chosen thumbnail stays whole while the PDF is built from split spreads
  staged elsewhere — the cover is the one image in a book of spreads that
  should not be cut in half.

JSON summary: `{"targets": [{"folder", "mode", "pages", "outputs", "errors"}, ...]}`.
Exit codes: `0` all folders OK, `1` one or more folders errored, `2` no
matching folder found at all.

### `pdf_derive.py`

```
python pdf_derive.py <source.pdf> --name BASE [--out-dir DIR] [--thumbnail-only]
```

The **PDF-source** branch — a finished PDF dropped into an item folder rather
than scans to assemble. Rasterises the source with pypdfium2, downscales
through the *same* `nbcg_pipeline.images` rules `web.py` uses (so the same item
gets the same web preview whichever branch produced it), and writes
`<BASE>.pdf` + `<BASE>_thumb.png` (page 1). No archival master: a supplied PDF
is already finished.

`--name` is **required** rather than derived from the source filename — the
naming base is decided once in the `.ts` lane (`ItemRunRequest.folderName`) and
the source's own name routinely contradicts it (`Pisma iz Liona` holds
`Писма из Лиона_(310).pdf`). `--thumbnail-only` renders page 1 alone, for the
`multiple-pdfs` case where each PDF is already its own web PDF.

JSON summary: `{"source", "name", "pages", "outputs", "errors"}`.
Exit codes: `0` success, `1` error, `2` the source PDF has no pages.

**Driven by the runner** for two shapes:

- `supplied-pdf` — the runner moves the operator's PDF into `<folder>/source/`
  *before* deriving. That is required, not tidiness:
  `domain/files.classifyAsset` calls every non-`_archive` PDF a `web-pdf` and
  `classifyInput` branches on how many the folder holds, so a derived PDF left
  beside its original makes the item read as `multiple-pdfs` on the next scan —
  a silent shape change, with the full-size original then uploading as a web
  asset. Re-runs derive from the filed original, never from the previous
  output, or each run would downscale a downscale.
- `multiple-pdfs` — the `pdf` stage builds nothing (the discovered PDFs already
  *are* the web PDFs and are never rewritten); this script only renders one
  `<base>_thumb.png` candidate per PDF for the operator to choose from.

### `ocr.py`

```
python ocr.py <image-or-pdf> [--lang rs_latin rs_cyrillic] [--out-dir DIR]
              [--pages FILE ... | --pages-file LIST.txt]
              [--cpu-threads N] [--rec-batch-size N]
              [--no-textline-orientation] [--no-gpu]
```

OCRs a single image, an explicit `--pages` list of page images, or every
page of a PDF; writes `<input-stem>.txt`, and prints a JSON summary in
addition (not instead of the `.txt` file):
`{"input", "output_text", "output_pdf", "pages", "avg_confidence",
"memory_cap_applied", "elapsed_seconds", "language", "pages_retried",
"errors"}`.

`--pages-file` takes the same list as `--pages`, one path per line in a UTF-8
file, and takes precedence over it. **The job runner always uses the file**,
because a command line has a hard length limit and a page list does not:
Windows caps an entire command line at 32767 characters, one page path runs
about 100, so a 522-page book comes to roughly 52000 and the spawn fails
outright — on exactly the long books that most need OCR. Measured against this
archive, the 391-page item sat at ~31300, four percent under the limit. The
file is written into the staging directory the runner already creates and
deletes (`core::python::run_ocr`). `split_spreads.py`/`web.py` keep passing
`--pages` as arguments: their lists are bounded by one item's page run and
have never approached the limit.

**Device.** OCR runs on the GPU when one is genuinely usable and falls back to
the CPU otherwise, including when a GPU was advertised but the engine failed
to build (`nbcg_pipeline/device.py`). Three things must all hold for the GPU
path: an **NVIDIA** card (PaddlePaddle's GPU support is CUDA — an Intel or AMD
integrated GPU does not qualify), its CUDA runtime, and **`paddlepaddle-gpu`
rather than the plain `paddlepaddle`** pinned in `requirements.txt`, which is
CPU-only and reports `is_compiled_with_cuda() == False` on any hardware. On a
stock install this reports CPU, correctly; the log line names which of the
three was missing. `--no-gpu` skips the probe entirely.

**Models are all pinned by name in `_get_engine`, on purpose — including the
ones PaddleOCR would choose anyway.** Leaving one to the library's default
caused a roughly tenfold slowdown that took a full investigation to trace:
this script pinned the detector and the *cyrillic* recognizer but not the
Latin one, and paddleocr 3.7.0 introduced PP-OCRv6 and re-routed every
Latin-script language to the much heavier `PP-OCRv6_medium_rec`. `git log
--follow py/ocr.py` shows the engine setup was byte-identical to the initial
commit throughout — a plain `pip install` swapped the model underneath
unchanged code. The exact-version pins in `requirements.txt` are the second
line of defence; naming every model here is the first. Re-measure with
`tools/bench_ocr.py` before changing any of them.

`--cpu-threads` (default 8) sets inference threads per OCR process. More is
**not** reliably better: on a 22-core machine, 16 threads measured roughly
30× *slower* than 10. `--rec-batch-size` (default 16) batches the recognition
of a page's detected lines — pure throughput, it changes what the model is
fed at once, not what it is asked to read. `--no-textline-orientation` drops
the per-line orientation classifier; on upright book scans it changed nothing
measurable and costs real time, but it is what rescues a page that went
through the scanner sideways, so it stays **on** by default — an unattended
overnight batch is precisely where nobody would notice that happening.

`enable_mkldnn` is left off, though it is PaddleOCR's own default and the
obvious speed lever: on paddlepaddle 3.3.1 it raises
`NotImplementedError: (Unimplemented) ConvertPirAttribute2Run` during
inference. Measured, not assumed — and almost certainly why it was switched
off here originally. Worth re-testing after any paddlepaddle upgrade.

**Script selection** (`nbcg_pipeline/ocr_lang.py`). Given more than one
`--lang`, this does *not* run every language over every page — that is an
exact 2× on the dominant cost of a run, and a book is normally one script
throughout. Instead it samples a handful of interior pages (never the
covers: page 1 of a real book recognizes almost nothing, so a "first N"
sample decides the document off no evidence), picks the dominant script by
**how much text each recogniser actually read**, and runs only that one per
page. A page that comes back *detected but not read* - lines found, almost no
letters in them - is re-run with the other script and the better reading
kept, so documents that genuinely mix Latin and Cyrillic still come out
right; and if the retry wins several pages in a row, it becomes the primary,
so a book that switches script halfway does not pay the retry on every page
of its second half.

**It does not rank by confidence, and that is the whole point.** Measured on
ОКТОИХ петогласник p200 (Church Slavonic) the Latin recogniser reported
confidence **0.650** and produced `HLZLXNM + BLZAHM`, while the Cyrillic one
reported **0.457** and produced the real text. A recogniser facing an
alphabet it cannot read still *detects* the lines - the counts are identical,
66 either way - it just returns them nearly empty, and is serenely confident
about the emptiness. Ranking on confidence therefore picks the nonsense and
would have written a 522-page file of it. Correct readings measured 13.7-37.8
letters per line, wrong ones 1.2-1.9, so `MIN_LETTERS_PER_LINE` sits in that
gap. This also stopped a second, quieter waste: the old confidence threshold
fired on merely *hard* pages (faint print, a stain) where the retry could not
possibly help, and each false retry doubles that page's cost. `language` and `pages_retried`
in the summary report what that actually cost — `pages_retried` is the
number to watch if OCR runtime regresses. Passing a single `--lang` skips
detection and retries entirely.

The policy lives in `nbcg_pipeline` rather than here for the same reason
`pdf_text` does — `ocr.py` cannot be imported at all without paddleocr, and
this is pure decision-making with no engine in it, so keeping it separate
means it is unit-testable anywhere (`tests/test_ocr_lang.py`, which needs
no OCR stack at all).

`--out-dir DIR` writes the `.txt` (and, for a PDF input, the embedded-text
`.pdf` — see below) there instead of next to the input — same atomic-write
staging purpose as `web.py`'s, used by the job runner.

`--pages FILE [FILE ...]` OCRs those exact image files directly, in order,
instead of rasterizing `input`. The runner uses this for `page-images` items
so OCR reads the same original scans `web.py` built the PDF from — higher
fidelity than the web PDF's downscaled copy, and no PDF rasterization at
all. `input` is still required in this mode: it still names the outputs and,
if it's a PDF, is still the file the recognized text gets embedded into.
Without `--pages`, a PDF `input` is rasterized via **pypdfium2** (no system
dependency — see `requirements.txt`); this is the fallback for shapes with
no source images to OCR directly (`supplied-pdf`/`multiple-pdfs`, and the
legacy jpg/tif `paired` shape).

**Embedding**: when `input` is a PDF and OCR found at least one page, the
recognized text is also burned into that PDF as an invisible, searchable
text layer (positioned per line from PaddleOCR's own detection boxes),
overwriting it in place — same filename, same visual content and quality,
just now with real selectable/searchable text (see
`nbcg_pipeline/pdf_text.py`). Idempotent: a PDF that already carries the
embedded layer (checked via a marker in its Info dictionary) is left alone
on a re-run — only the `.txt` is rewritten. A failure during embedding
(e.g. a missing font asset) is logged and skipped, never fails the whole
run — the `.txt` output it doesn't affect either way.

The runner calls this **once per web PDF**, from
`ItemRunRequest.webPdfBases` — one for most shapes, one per discovered PDF for
`multiple-pdfs`, so `<base>.pdf` and `<base>.txt` keep matching by name. The
precondition (every PDF present) is checked for *all* bases before any OCR
starts: discovering the fourth PDF is missing after OCR-ing three of them wastes
minutes to reach the same failure.

Exit codes: `0` success, `1` bad input path or an unexpected failure during
OCR, `2` input converted to zero OCR-able pages (e.g. an empty PDF).

`memory_cap_applied` is `false` on Windows by design — see
`nbcg_pipeline.limits.apply_memory_cap`. A real enforced memory cap on
Windows would need Job Objects or a `psutil` watchdog; not implemented, since
the job runner's own OCR-aware concurrency limit (still open — Epic 06) is
the intended real control, not a per-process hard cap.

### `split_spreads.py`

See its own module docstring — the fullest-documented of the three and the
reference pattern the others were brought in line with. In short:

```
python split_spreads.py <folder> [--out DIR] [--pages FILE ...] [--rtl]
                        [--dry-run] ...
```

Splits landscape 2-page spreads into single pages (natural order, gutter
detection with a middle-split fallback); portrait singles are copied through
unchanged. Originals are never modified — output goes to `<folder>/split` by
default. Exit codes: `0` success, `1` error, `2` no images found.

- `--pages FILE [FILE ...]` — the same flag, and the same reasoning, as
  `web.py`'s: the exact ordered list to split, so the page order the `.ts` lane
  decided isn't re-derived here. Files named but missing are reported and
  skipped (exit `1`), which outranks the "found nothing" exit `2`.

**Driven by the runner** when `ItemRunRequest.splitSpreads` is true on a
`page-images` item: `core::jobs` splits into a staging folder first, then hands
`Summary.pages` — the resulting page order — straight to `web.py --pages`, with
`--name` keeping the outputs named after the item rather than the staging
folder. `splitSpreads` cannot be detected in `.ts` (telling a 2-up spread from
a landscape map needs pixel access, docs/05 open question #4), so it is an
operator toggle. On a `tiffs` item the runner **refuses** it rather than
quietly ignoring it — the archival master has to come from the TIFFs at full
fidelity.

## `nbcg_pipeline/` — shared helpers

Factored out once real scanner data (see
[docs/05-real-scan-data.md](../docs/05-real-scan-data.md)) showed all three
scripts needed the same fixes independently
([docs/tasks/py-real-data-mismatches.md](../docs/tasks/py-real-data-mismatches.md)):

- `natural_key` / `find_images` — numeric-aware sort (`2.jpg` before
  `10.jpg`; plain lexicographic sort silently shuffles a book), plus
  filtering of OS artifacts (`Thumbs.db`) and derived preview variants
  (`SP_001 (Small).jpg`) that sit next to real pages.
- `force_utf8_streams` — Windows' default console code page can't encode
  Cyrillic; this pins stdout/stderr to UTF-8 so a Cyrillic folder name can't
  crash a script after it's already done the work.
- `apply_memory_cap` — Windows has no `resource` module; this makes the
  memory-cap attempt a safe no-op there instead of an import-time crash.
- `print_summary` — the one shared piece of the JSON-on-stdout contract
  (serialization only; each script's summary fields genuinely differ).
- `images` — `load_rgb` / `resize_for_web` / `build_pdf` / `build_thumbnail`
  and the size, quality and DPI constants, lifted out of `web.py` when
  `pdf_derive.py` turned out to need identical rules. **Both PDF builders
  stream**: pages are produced one at a time and handed to Pillow as a
  generator, never collected into a list first. A web-sized page is ~4 MB, so
  the obvious list version held about 1.7 GB resident for a 391-page book
  before writing a byte — fine on one test file, a memory gamble in the
  unattended overnight batch this app exists to run. Measured on 60 pages:
  **+415 MB as a list against +7.4 MB streamed**, for a byte-identical PDF.
  Nothing is closed explicitly any more; Pillow writes each page as it pulls
  it, so the previous one is freed when the generator advances, which is
  precisely what keeps the footprint flat. A supplied PDF and a
  folder of JPGs must produce the same-sized web preview for the same item;
  two copies of `WEB_MAX_DIMENSION` is precisely how that stops being true.
- `pdf_text` — `embed_text_layer` / `already_embedded` / `RecognizedLine`,
  `ocr.py`'s invisible-searchable-text-layer embedding, factored out for the
  same reason `limits.py` was: it needs only `pypdf`/`reportlab`, not the
  full `paddleocr` stack `ocr.py` itself requires at import time, so it's
  independently unit-testable (`test_pdf_text.py`) in any environment.
- `pages` — `ImageFilePages` / `PdfPages`, page images produced **one at a
  time** rather than all at once. `ocr.py` used to rasterize an entire PDF
  before recognizing anything, which at OCR-quality DPI is ~13 MB per page —
  several GB resident for a long book, before the first line of text. Fine
  with one small test file, and a memory gamble for the unattended overnight
  batch this app exists to run. Neither source caches: script detection
  samples interior pages that the recognition loop then reads again, and
  re-rendering a handful of pages costs far less than recognizing them, while
  a cache would quietly restore the growth. `pypdfium2` is imported lazily so
  the package still costs only Pillow to import.
- `ocr_lang` — `LanguageStrategy` / `sample_indices`, deciding which script
  each page is OCR'd as and when a second attempt is worth paying for (see
  `ocr.py` above). Same separation as `pdf_text`, for the same testability
  reason, but with no third-party dependency at all — it is pure policy,
  with the engine and the logger both injected — so unlike `pdf_text` it
  *is* re-exported from the package's `__init__`.

Scripts are invoked as `python <path>/web.py …` (script-path invocation),
which puts `py/` on `sys.path[0]` automatically, so `import nbcg_pipeline`
resolves as a sibling package with no packaging step needed. The Rust job
runner (`core::python`) resolves that path at **compile time** via
`CARGO_MANIFEST_DIR` (`src-tauri/`'s absolute path on the build machine), so
it's immune to whatever CWD Tauri happens to launch with — but that also
means it's not relocatable/packageable as-is; bundling a portable Python
runtime is Epic 11's job, not this one's.

## Tests

```bash
pip install pytest
pytest tests/
```

(`pypdf` is also used to decode built PDFs and verify pages landed in the
right order — already a real `requirements.txt` dependency, see
`pdf_text.py` above, not test-only anymore.)

No real scanner corpus is available in every environment (it lives on a
staff machine, not in this repo), so tests use synthetic fixtures that
reproduce the real corpus's documented shapes: unpadded numbering, zero-padded
numbering under a Cyrillic folder name, and a prefixed/padded set with a
derived-variant file alongside. `test_pdf_text.py` needs only
`reportlab`/`pypdf` (both real dependencies now) and runs fully in any
environment — no `paddleocr` involved, by design (see its own module
docstring). `test_ocr_lang.py` goes further and needs nothing at all: the
per-page script-selection policy takes an injected fake engine, so the
decisions that drive both OCR's runtime and its correctness are pinned
without a single model on disk — including the assertion that a confident
page is recognized exactly *once*, which is the whole speed win and would
otherwise regress silently. The remaining `ocr.py`-specific tests are skipped
(`pytest.importorskip("paddleocr")`) wherever `paddleocr` isn't installed —
a real end-to-end OCR pass still needs to happen once on a machine with the
full recognition stack (`paddleocr`/`paddlepaddle`) before `ocr.py` itself
is verified beyond its Windows import-time fix. Rasterization (`pypdfium2`)
and text embedding (`reportlab`/`pypdf`) need no such machine-specific
verification — both are pure pip installs, already exercised directly by
`test_pdf_derive.py` and `test_pdf_text.py` respectively.

**The Rust side has its own test suite** (`src-tauri/tests/core_jobs.rs`, 18
tests) that exercises `web.py`/`split_spreads.py`/`pdf_derive.py` for real
through `core::jobs`/`core::python` — real subprocess, real PDFs/thumbnails on
disk, real SQLite writes — using `src-tauri/tests/fixtures/*.jpg` as source images
(Pillow is installed there too; Rust itself has no image-encoding/decoding
crate in this project, hence fixture files rather than generated-in-test
images). `fixtures/spread.jpg` is a red-left/blue-right landscape spread
specifically so a test can prove from one pixel whether an output came from
half a spread or the whole one. Same OCR gap as here: only the
precondition-failure path is pinned without a live `paddleocr` install.
