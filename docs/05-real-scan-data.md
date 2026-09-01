# NBCG-DC — Real scan data (measured)

> Status: measured facts · **classifier fixed 2026-08-07** · some decisions open
> Last updated: 2026-08-07
> Source: `C:\Users\jerne\Desktop\nbcg_archive` (supplied by Jernej, 2026-08-07)

The first look at **actual library scanner output**. Every planning assumption
about folder contents up to this point came from the docs; this is what the
scanner really produces. It **invalidates the pipeline's input classification**
for 3 of the 4 sample folders — see [§Impact](#impact-on-domainpipeline).

## The corpus

Two roots, `scanned/` and `processed/`. **`processed/` is empty**, so there is no
example yet of what a finished item looks like on disk.

| Folder | Files | Image size | Shape | What it is |
| --- | --- | --- | --- | --- |
| `CERNAGORA` | 260 jpg + `Thumbs.db` | 1131×2014 portrait (uniform) | `1.jpg…260.jpg`, unpadded | A book, 260 pages |
| `Pisma iz Liona` | 53 jpg + 1 pdf | 4841×7941 portrait; the odd one 293×480 | `SP_001.jpg…SP_052.jpg`, plus `SP_001 (Small).jpg` and `Писма из Лиона_(310).pdf` | A book, 52 pages, **already has a PDF** |
| `ОКТОИХ петогласник 2` | 162 jpg + `Thumbs.db` | ~3592×2550 **landscape** | `000.jpg…161.jpg` (zero-padded) | A book scanned as **2-page spreads** → ~324 pages |
| `sa vodenim zigom` | 1 jpg | 1536×926 landscape | `Budua and Cetinje  zone 36 col XX. – Wien, 1886 Kr1516 id=21964048.jpg` | A single **map** |

### Facts that matter

1. **JPG, not TIFF.** Not one `.tif` in the corpus. The pipeline's primary branch
   keys off TIFFs (`InputShape.tiffs`) and is therefore never taken.
2. **Three different page-numbering schemes**, none of them ours: unpadded
   (`1…260`), zero-padded (`000…161`), and prefixed+padded (`SP_001`). Our
   convention is `<base>_<n>` with an **unpadded** number, which matches none of
   them — and `domain/naming.pageNumberOf` deliberately rejects padded numbers.
3. **Lexicographic order is not page order.** `1.jpg, 10.jpg, 100.jpg, 2.jpg…`
   Anything assembling a PDF needs a **natural/numeric sort**; a plain
   `readdir()` order silently produces a shuffled book.
4. **`ОКТОИХ` is 2-up spreads.** Uniformly landscape at ~1.41 aspect (two
   portrait pages side by side), unlike the other two books' portrait pages. The
   pipeline has **no spread-splitting stage**.
5. **Derived variants sit next to sources.** `SP_001 (Small).jpg` (293×480) is a
   preview of `SP_001.jpg` (4841×7941). It must not be treated as a page or as a
   thumbnail candidate on equal footing.
6. **`Thumbs.db`** (Windows Explorer artifact) appears in two folders. Correctly
   classified as `other` and ignored — no change needed.
7. **Folder names carry spaces, Cyrillic, and prose.** `ОКТОИХ петогласник 2`,
   `sa vodenim zigom` ("with a watermark" — a *description*, not an identifier).
   The folder-name-as-base-name rule produces `sa vodenim zigom.pdf`, which is not
   a usable identifier for anything.
8. **The map's filename embeds real metadata**, including a COBISS id:
   `… Wien, 1886 Kr1516 id=21964048.jpg` → title, place, year, signature
   `Kr1516`, `cobissId=21964048`. A prefill opportunity, and evidence that
   operators encode metadata in filenames when nothing else will hold it.
9. **`Pisma iz Liona` already contains a PDF** named `Писма из Лиона_(310).pdf`
   (`310` is not the page count — there are 52 pages). Unclear whether it is a
   source or an already-built product.

## Impact on `domain/pipeline`

Ran the real planner (`planPipeline` + `classifyInput`) over the four folders as
they sit on disk. **Three of four are mishandled**, all from the same root cause:

| Folder | `inputShape` | Stages planned | Verdict |
| --- | --- | --- | --- |
| `CERNAGORA` | `images-only` | pdf ✗ · thumbnail ✓ · **ocr ✗** | ❌ A 391-page book gets **no PDF and no OCR**, uploads 391 loose JPGs, and asks the operator to pick a thumbnail from **391 candidates** |
| `ОКТОИХ петогласник 2` | `images-only` | pdf ✗ · thumbnail ✓ · **ocr ✗** | ❌ Same, 162 candidates; spreads never split |
| `Pisma iz Liona` | `supplied-pdf` | pdf ✓ · thumbnail ✓ · ocr ✓ | ❌ Produces **one** candidate, `Pisma iz Liona.pdf` — **silently discards all 52 page JPGs** and renames the existing Cyrillic PDF |
| `sa vodenim zigom` | `images-only` | pdf ✗ · thumbnail ✓ · ocr ✗ | ✅ Correct — and it is the only genuine graphical work |

### The root cause

`classifyInput` treats **"images with no PDF/TIFF"** as "a map / graphical work →
no PDF, no OCR". That inference was sound only while TIFFs were the marker of
"pages to assemble". With JPG scans, `images-only` conflates two completely
different things:

- **a folder of page images** → must build a PDF and run OCR (3 of 4 folders), and
- **a standalone graphical work** → correctly no PDF, no OCR (1 of 4).

So the branch fires on the wrong one almost every time. This is not a tuning
problem; the classifier is missing an input it cannot derive from file extensions
alone.

### What the real data suggests

A **detected numbering sequence** separates the two cleanly across the whole
corpus: the three books are contiguous runs (`1…260`, `000…161`,
`SP_001…SP_052`), while the map is a single file with a descriptive name. That is
a strong signal, and it is derivable from filenames alone — no image probing.
Uniform dimensions corroborate it (the books are each internally uniform), but
that needs pixel access, which lives in the Arch/Python lane.

Neither should be the only answer: a wrong guess here either mangles a book or
turns a map into a one-page PDF, so the operator needs an explicit override.
**This is an open decision, not something to implement on a hunch** — see below.

## Decisions taken 2026-08-07 (and what shipped)

1. **Pages vs graphical work → detect the numbering, operator can override.**
   Implemented: `domain/naming.detectPageSequence` finds the run;
   `domain/pipeline.ContentKind` (`auto` | `book` | `graphical`) forces it. The
   override is persisted per item on the batch
   (`domain/batch.BatchItemOverride.contentKind`) and belongs on the Setup tab.
2. **`CERNAGORA`'s `C001…C131` were double-page versions of the same content and
   have been deleted** by Jernej — the folder is now a clean `1…260`. So one
   folder still means one item, and the one-folder-one-item model stands.
   (`detectPageSequence` picks the largest run anyway, so a reappearance of a
   second prefix degrades gracefully rather than defeating detection.)
3. **2-up spreads → split, via a standalone Python script for now.**
   `py/split_spreads.py`, **written and verified on the real folder**. It is
   deliberately **not** a visible pipeline stage: the intent is to fold it into
   the image→PDF step as a toggleable sub-step, so the contract already carries
   `ItemRunRequest.splitSpreads: boolean`.

   Measured over all of `ОКТОИХ петогласник 2` (Python 3.14.7 + Pillow 12.3.0):
   **162 images → 321 pages** in ~29s — 159 spreads split, 3 portrait singles
   copied through — **zero errors**, gutter detected on all 159 with no
   fallbacks. Every output re-opened cleanly; split balance (narrow/wide half)
   median **0.96**; two pages inspected visually are complete, margins intact, no
   clipped text. Originals are never touched (output goes to a separate folder).

   Three things worth knowing:

   - **A `UnicodeEncodeError` bug only running it could have found.** The JSON
     summary — the machine-readable half of the seam-4 contract — crashed on this
     folder, because Windows stdout defaults to a legacy code page (cp1250 here)
     that cannot encode Cyrillic. Any Python in this project that prints a summary
     containing a filename must pin its streams to UTF-8; `force_utf8_streams()`
     does it. Montenegrin material is routinely Cyrillic, so this would have hit
     in production on day one.
   - **The folder is not homogeneous.** `000`, `001` and `160` are portrait single
     pages (front matter) and `161` is the **open leather cover** — only the
     middle 159 are true text spreads. So "this folder is spreads" is not a
     per-folder truth; the script decides per image, which is the right level.
   - **The cover is the one bad split** (balance 0.76 — the spine is a wide dark
     band, so the darkest-column rule lands on its edge). Cutting at the dark
     band's *centre* instead was implemented, measured, and **reverted**: it made
     the cover worse (1578/2078 → 1456/2200) while moving text spreads by ~5px. A
     cover photographed open should not be split at all, which is a content
     decision for the operator, not a detection heuristic. Open question below.

### Verified after the fix

Re-ran the real planner over the four folders on disk:

| Folder | `inputShape` | Stages | Candidates | Pages (order) | Thumbnail |
| --- | --- | --- | --- | --- | --- |
| `CERNAGORA` | `page-images` | pdf ✓ thumb ✓ **ocr ✓** | `CERNAGORA.pdf` | 260, `1,2,3…260` | auto `1.jpg` |
| `ОКТОИХ петогласник 2` | `page-images` | pdf ✓ thumb ✓ **ocr ✓** | `ОКТОИХ петогласник 2.pdf` | 162, `000,001…161` | auto `000.jpg` |
| `sa vodenim zigom` | `images-only` | pdf ✗ thumb ✓ ocr ✗ | the JPG itself | — | auto (the map) |
| `Pisma iz Liona` | `supplied-pdf` | pdf ✓ thumb ✓ ocr ✓ | `Pisma iz Liona.pdf` | — | needs choice |

All four are now right, and **no operator is asked to choose among 260
thumbnails**. `Pisma iz Liona` still resolves to the supplied PDF, but now emits
a warning naming the 52 ignored page images instead of dropping them silently.

## Bug found after the fix (2026-08-07)

**Duplicate page numbers were accepted silently.** `detectPageSequence` groups by
prefix+suffix and reads the trailing number, so a folder holding **two formats per
page** (`1.jpg` *and* `1.png`) or **mixed padding** (`1.jpg` and `01.jpg`) produced
a run containing every page twice — and the assembled PDF would duplicate all of
it, with no warning. Neither pattern is exotic: a converted set, or a scanner
emitting both formats, gets there.

Fixed: `PageSequence.duplicates` reports the clashing numbers and `planPipeline`
warns, naming the consequence. It **does not auto-pick** a winner — choosing
between `1.jpg` and `1.png` is a content decision (the PNG may be the better
scan), so the operator cleans the folder.

## Still open

1. ~~**Is `Писма из Лиона_(310).pdf` a source or an output?**~~ **Answered
   2026-08-21 (Peter): a source.** A `supplied-pdf` item derives
   `<folderName>.pdf` from it, and the original is **filed under
   `<folder>/source/`** — kept forever, never modified, and travelling with the
   folder into `/processed`.

   Filing it is not tidiness. `classifyAsset` calls every non-`_archive` PDF a
   `web-pdf` and `classifyInput` branches on how many the folder holds, so a
   derived PDF left beside its original makes the item read as `multiple-pdfs`
   on the very next scan: the shape changes silently and the full-size original
   uploads as a web asset. `core::fs::describe_folder` lists files without
   recursing, so one subfolder is enough to keep the count at one. Implemented
   in `core::jobs::resolve_supplied_source`; pinned by
   `core_jobs::supplied_pdf_derives_the_web_pdf_and_files_the_original_under_source`,
   whose real assertion is that the folder root holds exactly one PDF
   afterwards.

   Re-runs derive from the filed original rather than from the previous output —
   otherwise each one downscales a downscale and the web PDF rots a little more
   every time.

   Unchanged: which *wins* when a folder holds both page images and a PDF. The
   PDF still does, and `planPipeline` still warns, naming the ignored pages.
   That part of the question is a separate call about the 52 JPGs in
   `Pisma iz Liona`, and it stays open.
2. **Does the folder name survive as the naming base?** `sa vodenim zigom`
   ("with a watermark") is a description, not an identifier, and yields
   `sa vodenim zigom.pdf`. Related: whether Cyrillic and spaces in derived
   filenames survive upload (`ОКТОИХ петогласник 2.pdf` is the live case).
3. **Should filename-embedded metadata be parsed?** The map's `id=21964048` is a
   COBISS id that could drive prefill; the rest of that filename carries
   title/place/year/signature (`Kr1516`).
4. **Spread detection needs pixel access.** The `.ts` lane cannot tell a 2-up
   spread from a landscape map — `splitSpreads` is therefore an explicit flag,
   not something detected in the plan. Deciding it automatically (uniform
   landscape + ~1.41 aspect) means probing images, which lives in the Arch lane.
5. **Should cover shots be excluded from splitting?** `ОКТОИХ`'s `161.jpg` is the
   open leather binding and is the only badly-split image in 159. Options: skip
   the first/last image when splitting (fragile — `161` is last here but front
   matter `000`/`001` are portrait, so position is not reliable), let the operator
   mark non-page images, or accept a poor split on one image per book. Related:
   the cover is arguably the **best thumbnail** for the item, which the current
   "thumbnail = first page" rule would miss.
5. **`web.py` does not match reality** (see below).
6. **A fuller real slice (`arh/`, 2026-08-26) surfaced a shape the four
   folders above never had: a collection folder wrapping two or more
   distinct books** (`Cèrnagora/` holds `CERNAGORA/` (392 files) and
   `CERNAGORA... 1851/` (132 files) as siblings, plus loose files of its
   own). `core::fs::scan_root` only scans one level deep, so these are
   invisible unless the root is pointed at the wrapper folder by hand — and
   no structural heuristic reliably tells "a wrapper to descend into" apart
   from "a record with an unrelated subfolder to ignore" (`Budua und
   Cetinje/` has the identical loose-file-plus-subfolder shape and the
   opposite correct answer). Decision and task:
   [nested-record-folders-and-manual-selection](tasks/nested-record-folders-and-manual-selection.md).

## Bugs found smoke-testing against `arh/` (2026-08-26)

Driving the real app against a fuller real slice of the corpus (`arh/`, see
`Still open` #6 above) surfaced two real bugs, both fixed same-day:

- **An `images-only` item's upload gate never cleared.** `domain/pipeline.markNonApplicableSkipped`
  existed and was unit-tested, but was never actually called from production
  code — `services/indexing.toItem` (the sole DTO→`Item` mapping every read
  path funnels through) left a stage the index never recorded at its raw
  default, `pending`, rather than downgrading a genuinely-N/A one (e.g. `pdf`
  on a standalone map image) to `skipped`. `domain/upload.uploadBlockers`
  only accepts `done`/`skipped` as satisfied, so every real `images-only`
  item (`Budua und Cetinje`, `Успомена са Цетиња`) showed a permanent, false
  "Not fully processed yet (pdf)" blocker — a graphical work could never
  upload. Fixed by wiring `markNonApplicableSkipped` into `toItem` (`services/indexing.ts`);
  regression test in the new `services/indexing.test.ts`.
- **An early cancel could leave OCR permanently `Failed` instead of settling
  `Pending`** — see the "second cancel bug, found smoke-testing... 2026-08-26"
  addendum in [06-processing-pipeline-and-jobs](tasks/06-processing-pipeline-and-jobs.md)'s
  cancellation section for the full root cause and fix
  (`core::jobs::run_ocr_stage`).

Both were invisible to every existing test — including the extensive unit
suites written earlier the same session — because they only manifest against
a real, multi-stage item under real subprocess timing: the exact reason this
whole real-data pass exists.

## Two mismatches in `py/` for the Arch lane

Found while reading `py/web.py` against the real corpus. Neither is my lane, both
matter:

- **`web.py` requires `jpg/` and `tif/` subfolders**; every real folder is a flat
  directory of JPGs. As written it processes none of them.
- **`web.py` sorts pages by plain filename** ("sorted by filename", `find_images`)
  → `1, 10, 100, 2, …`. On `CERNAGORA` that produces a **shuffled 260-page book**,
  silently. It needs a natural sort; `py/split_spreads.py:natural_key` has one,
  and the `.ts` side already hands over `ItemRunRequest.pageImages` **in page
  order** precisely so the runner does not have to re-derive it.
- **`web.py`'s output naming contradicts the documented convention**: it writes
  `<name>.pdf` for the *archival* master, `<name>_web.pdf`, and `<name>_thumb.jpg`,
  whereas the convention (docs/01 §Naming, `domain/naming.ts`) is
  `<name>_archive.pdf` for archival, `<name>.pdf` for **web**, `<name>_thumb.png`.
  The plain `<name>.pdf` means the *opposite thing* in each — the most dangerous
  kind of disagreement.

## Not affected

- **`Thumbs.db`** handling was already correct (classified `other`, ignored).
- **The backend contract** is unaffected — this is entirely local pipeline logic.
- **`domain/naming`'s output convention** is unchanged. Note the split of concerns
  inside that module: `pageNumberOf` reads *our* `<base>_<n>` outputs and
  deliberately rejects padding, while `parseScanPageName` /
  `detectPageSequence` / `compareNatural` read *incoming* scanner names, which are
  padded and prefixed. They must not be conflated.
