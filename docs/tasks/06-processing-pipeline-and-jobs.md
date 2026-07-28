# Epic 06 — Processing pipeline & jobs

> Depends on: 01, 02, 03, 04 · Blocks: 07, 11

Goal: run the five-stage pipeline per batch (with live progress and robust error
handling) and drive the **Processing** half of the Processing & Upload tab.
Processing runs **locally**; only **one batch runs at a time, per workstation**.

## The pipeline (five stages, deterministic)

```
TIFFs ──▶ <name>_archive.pdf (archival)  ──downscale──▶ <name>.pdf (web, uploaded)
           │                                            <name>_thumb.png (uploaded)
           └──ocr──▶ <name>.txt (uploaded)              <name>.json (metadata, uploaded)
```

Stages, each `pending → running → done | failed` (+ `queued` while scheduled):
**PDF** (archival + web from one source set) · **Thumbnail** (a folder image, or
PDF first page) ·
**OCR** (PaddleOCR, local) · **Metadata** (`done` only once required fields
validate — see [metadata](04-metadata-editor-and-schema.md)) · **Uploaded**
(see [upload](07-upload-and-publish.md)). Source TIFFs + the archival master stay
**local**; only the web PDF(s) + image(s) + OCR text + metadata are pushed.

### Source inputs (adaptive)

A folder's input isn't always "TIFFs → one PDF". The pipeline branches on what's
in the folder:

- **TIFFs present** → build `<name>_archive.pdf` + `<name>.pdf` (web) + a
  first-page image.
- **A PDF with no TIFFs** — a finished PDF dropped straight in → **skip the
  archival build**; derive the web PDF (downscale if needed) + first-page image +
  OCR from that PDF.
- **Images with no PDF** — a map / graphical work delivered as images → the
  images are the web assets; no PDF is built, and **no OCR runs** (the OCR stage is
  N/A — image-only items carry no full text; the empty-text soft warning at upload
  covers it).
- **Multiple PDFs** → process each independently (web PDF + first-page image +
  OCR text per PDF); keep each PDF's **own filename** so its text matches by base
  name. All become upload candidates.
- **Multiple images** → all are thumbnail/upload candidates; one is the primary
  (see below).

## Tasks

- [ ] ⛔ Choose the **Python invocation strategy** (sidecar / system / native) —
      see [overview](../00-project-overview.md) and
      [architecture](../02-architecture.md).
- [ ] Make [`py/ocr.py`](../../py/ocr.py) **cross-platform**: replace the
      Linux-only `resource.setrlimit` cap with a Windows-safe approach.
- [ ] Wrap the scripts as first-class **operations** producing folder-named
      outputs: `pdf` (archival `<name>_archive.pdf` + web `<name>.pdf`),
      `thumbnail` (`<name>_thumb.png`), `ocr` (`<name>.txt`). Reuse
      [`py/web.py`](../../py/web.py) and [`py/ocr.py`](../../py/ocr.py).
- [ ] **Adaptive input handling**: branch the pipeline on folder contents (TIFFs
      / supplied PDF with no TIFFs / images with no PDF), and process **multiple
      PDFs/images** into multiple upload candidates — preserving each discovered
      file's own filename so its OCR text matches by base name.
- [ ] **Thumbnail source selection**: the thumbnail (`<name>_thumb.png`) is
      derived from a folder image. Candidates = the generated **first-page
      image(s)** + any **standalone images** —
  - **one candidate** → auto-select it (no prompt); the common "PDF + one image"
    case;
  - an image conventionally named **`thumbnail`** → auto-select as primary;
  - **two or more candidates** (a graphical work; a map/atlas as images; several
    PDFs each yielding a first-page image) → **unresolved** until the operator
    picks one: mark the item "choose thumbnail" and **don't let the Thumbnail
    stage reach `done`**.

  Always normalise to `<name>_thumb.png`. Detect candidates when the folder is
  scanned/processed; the picker UI lives in the Metadata files strip
  ([Epic 04](04-metadata-editor-and-schema.md)) and **upload is blocked** until
  it's resolved ([Epic 07](07-upload-and-publish.md)).
  *(Open detail: what counts as a selectable image vs a source page-scan — pin
  the rule to how the scanner delivers folders.)*
- [ ] **Job runner** in the Rust core: queue, concurrency limit (OCR is
      memory-heavy), start/cancel, per-item success/failure, streaming
      progress + logs to the UI as events.
- [ ] **Per-workstation single-run lock**: enforce one batch processing at a
      time; Start/Rerun while another batch runs is blocked with the standard
      message (uses the guard from [batches](03-batches-and-lifecycle.md)).
- [ ] **Processing & Upload tab — processing half**:
  - control strip with a summary line, batch progress bar, and the
    stage-changing **primary action** (Start processing → live counts while
    running → **Rerun all failed** if any failed → hand to **Upload batch** when
    ready);
  - a **per-item list** with live status (queued/running/done/failed), the error
    message on failure, and a per-item **Rerun**;
  - the start-blocked note when another batch is running.
- [ ] **Rerun at two grains**: a single failed item, or all failed items in the
      batch. On all-resolved, the batch stage becomes `ready`.
- [ ] **Atomic writes**: write each derived output to a temp file then rename, so
      a crashed/re-run step never leaves a partial that looks "done".
- [ ] **Dirty flag → needs re-upload**: producing new derived outputs (e.g. after
      TIFFs change) sets a SQLite "derived-changed-since-upload" flag that
      surfaces as **Needs re-upload** (Epics 02, 07). Driven by new PDF/OCR only —
      **never** by metadata.
- [ ] **Re-process action** (explicit): rebuild any stage (archival PDF, web PDF,
      thumbnail, OCR) on demand, overwriting old outputs. On an already-uploaded
      item it is an explicit, guarded action (the same **Edit / re-process** gate
      as Metadata) and **marks the item Needs re-upload**; optionally auto-detect
      new/changed TIFFs and suggest it. Re-runs obey the per-workstation
      single-run lock.
- [ ] **Skip-if-done**: skip stages SQLite marks complete unless the user forces a
      re-run, so big batches don't needlessly re-OCR.
- [ ] Concurrency/memory limits informed by real volumes — open question #3.

## Acceptance

- A batch runs the full pipeline from the Processing tab with a live progress bar
  and per-item status; the primary action changes with stage.
- A failed item shows its error and can be rerun individually; "Rerun all failed"
  clears the fail set; the batch reaches `ready` when all items succeed.
- Starting a batch while another is running is blocked (per workstation).
- Derived outputs are folder-named, written atomically, and recorded in SQLite;
  new outputs flag the item Needs re-upload.
