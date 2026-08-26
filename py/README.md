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

- Python 3.14+ (verified: 3.14.7 on Windows).
- `web.py` and `split_spreads.py` need only Pillow.
- `pdf_derive.py` additionally needs **pypdfium2** — a self-contained wheel, so
  nothing to install by hand. Chosen over the alternatives on licensing as much
  as capability: PyMuPDF is AGPL (which would make the whole app AGPL for
  anyone it is handed to) and `pdf2image` needs poppler on `PATH`, a system
  binary. pypdfium2 is BSD/Apache with no system dependency.
- `ocr.py` additionally needs `paddleocr`, `paddlepaddle`, `pdf2image`,
  `numpy`, `opencv-python` — and **poppler on `PATH`** (a system dependency,
  not pip-installable; see `requirements.txt` for platform-specific install
  notes). `ocr.py` has not yet been run end-to-end on Windows in this repo —
  the exact dependency versions there are unverified.

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
```

OCRs a single image or every page of a PDF, writes `<input-stem>.txt`, and
prints a JSON summary in addition (not instead of the `.txt` file):
`{"input", "output_text", "pages", "avg_confidence", "memory_cap_applied",
"elapsed_seconds", "errors"}`.

`--out-dir DIR` writes the `.txt` there instead of next to the input — same
atomic-write staging purpose as `web.py`'s, used by the job runner.

The runner calls this **once per web PDF**, from
`ItemRunRequest.webPdfBases` — one for most shapes, one per discovered PDF for
`multiple-pdfs`, so `<base>.pdf` and `<base>.txt` keep matching by name. The
precondition (every PDF present) is checked for *all* bases before any OCR
starts: discovering the fourth PDF is missing after OCR-ing three of them wastes
minutes to reach the same failure.

Exit codes: `0` success, `1` input path doesn't exist, `2` input converted to
zero OCR-able pages (e.g. an empty PDF).

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
  `pdf_derive.py` turned out to need identical rules. A supplied PDF and a
  folder of JPGs must produce the same-sized web preview for the same item;
  two copies of `WEB_MAX_DIMENSION` is precisely how that stops being true.

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
pip install pytest pypdf
pytest tests/
```

`pypdf` is a test-only dependency (decodes built PDFs to verify pages landed
in the right order) — neither `requirements.txt` nor the scripts themselves
need it.

No real scanner corpus is available in every environment (it lives on a
staff machine, not in this repo), so tests use synthetic fixtures that
reproduce the real corpus's documented shapes: unpadded numbering, zero-padded
numbering under a Cyrillic folder name, and a prefixed/padded set with a
derived-variant file alongside. `ocr.py`-specific tests are skipped
(`pytest.importorskip("paddleocr")`) wherever `paddleocr` isn't installed —
a real end-to-end OCR pass still needs to happen once on a machine with the
full stack (`paddleocr`/`paddlepaddle`/`pdf2image`/poppler) before that
script is verified beyond its Windows import-time fix.

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
