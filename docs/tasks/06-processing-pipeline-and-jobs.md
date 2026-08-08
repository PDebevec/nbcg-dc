# Epic 06 — Processing pipeline & jobs

> Depends on: 01, 02, 03, 04 · Blocks: 07, 11
> Logic-lane (`.ts`) pass: **2026-08-05** — the adaptive-pipeline planning, the
> job IPC/event contract, the orchestration service, and the run store landed
> (see **Progress** below). The Rust job runner (`.rs`/`.py`) and the Processing
> tab (`.vue`) are the remaining work.

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

**Lane legend:** each item notes its lane status — `.ts` = Jernej (logic),
`.vue` = GUI, `.rs`/`.py` = Arch. ✅ done · ◻ to do. Checkboxes stay unticked
until a task is complete **end-to-end** (all lanes); the logic-lane (`.ts`)
portion of Epic 06 is done — see **Progress**.

- [ ] ⛔ Choose the **Python invocation strategy** (sidecar / system / native) —
      see [overview](../00-project-overview.md) and
      [architecture](../02-architecture.md).
      — **`.rs`/`.py` ◻ (Arch, open question)** blocks *runtime* execution only;
      the `.ts` contract (`ipc.jobs`, `ItemRunRequest`) is invocation-agnostic.
- [ ] Make [`py/ocr.py`](../../py/ocr.py) **cross-platform**: replace the
      Linux-only `resource.setrlimit` cap with a Windows-safe approach.
      — **`.py` ◻ (Arch).**
- [ ] Wrap the scripts as first-class **operations** producing folder-named
      outputs: `pdf` (archival `<name>_archive.pdf` + web `<name>.pdf`),
      `thumbnail` (`<name>_thumb.png`), `ocr` (`<name>.txt`). Reuse
      [`py/web.py`](../../py/web.py) and [`py/ocr.py`](../../py/ocr.py).
      — **`.ts` ✅ (contract)** the operation vocabulary + naming is single-sourced:
      `RunnableStage` (`pdf`/`thumbnail`/`ocr`) + `PipelinePlan.candidates`
      (folder-derived single outputs / discovered PDFs' own base names) in
      `domain/pipeline.ts`, carried to the runner as the per-item `ItemRunRequest`
      (`stages` + `inputShape` + `webPdfBases` + `primaryThumbnail` +
      `thumbnailNeedsChoice`). **`.rs`/`.py`
      ◻** map each `(inputShape, stage)` → the right script + write the outputs.
- [ ] **Adaptive input handling**: branch the pipeline on folder contents (TIFFs
      / supplied PDF with no TIFFs / images with no PDF), and process **multiple
      PDFs/images** into multiple upload candidates — preserving each discovered
      file's own filename so its OCR text matches by base name.
      — **`.ts` ✅** `domain/pipeline.ts`: `classifyInput` (tiffs / supplied-pdf /
      multiple-pdfs / **page-images** / images-only / empty), `applicableStages`
      (images-only ⇒ no PDF, **no OCR**), `uploadCandidates` (preserves each PDF's
      base name; single supplied PDF, TIFF build, and page runs are
      folder-derived). Passed to the runner via `inputShape` + `webPdfBases` +
      `pageImages` + `splitSpreads`. **`.rs`/`.py` ◻** execute each branch.

      > **Revised 2026-08-07 after seeing real scans** (docs/05-real-scan-data.md).
      > The original five shapes assumed TIFFs marked "pages to assemble", so
      > `images-only` meant "a graphical work — no PDF, no OCR". Real scanner
      > output is **JPG**, which made every book match that branch: a 260-page
      > volume got **no PDF and no OCR**, uploaded 260 loose JPGs, and demanded a
      > thumbnail choice among 260 candidates. Three of four sample folders were
      > wrong. Added **`page-images`** (a detected numbered run ⇒ assemble one
      > folder-derived PDF + OCR, thumbnail = page 1, no archival master since JPG
      > is already lossy), narrowed `images-only` to genuine standalone works, and
      > added the **`ContentKind`** override (`auto`/`book`/`graphical`) because
      > both misclassifications are damaging. Page order comes from a **natural
      > sort** — lexicographic gives `1, 10, 100, 2, …`.
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
  — **`.ts` ✅** `planThumbnail` in `domain/pipeline.ts` extends
  `domain/files.ts` to the **multi-PDF** case (each PDF's first-page image is a
  candidate → needs a choice) and the "PDF + one image" / pre-tagged-`thumbnail`
  auto cases; exposes `needsChoice`/`resolved`, and `processingComplete` keeps
  the Thumbnail stage from completing while unresolved. **NB for Epics 04/07:**
  use the plan's `thumbnail.needsChoice` (not `files.needsThumbnailChoice` alone)
  so the multi-PDF case is caught. **◻ (logic)** persist the operator's pick on
  the item (with the Epic 04 metadata store). **`.vue` ◻** the grid picker.
- [ ] **Job runner** in the Rust core: queue, concurrency limit (OCR is
      memory-heavy), start/cancel, per-item success/failure, streaming
      progress + logs to the UI as events.
      — **`.ts` ✅ (contract + drive)** `ipc.jobs` (`start`/`cancel`/`reprocess`)
      + the `job://progress` / `job://stage-changed` / `job://done` events
      (`ipc/events.ts`); `services/pipeline.ts` builds the request + wraps the
      calls; `stores/useProcessing.ts` folds events → coarse batch state
      (write-through) + live progress. **`.rs` ◻** the actual queue / concurrency
      cap / cancel / streaming behind the commands.
- [ ] **Per-workstation single-run lock**: enforce one batch processing at a
      time; Start/Rerun while another batch runs is blocked with the standard
      message (uses the guard from [batches](03-batches-and-lifecycle.md)).
      — **`.ts` ✅** `anyOtherRunning`/`singleRunBlockedMessage` (Epic 03) checked
      in `useProcessing` before every start/rerun/reprocess; `useBatch` already
      surfaces `runBlocked`/`runBlockedMessage`. **`.rs` ◻** the native
      belt-and-suspenders lock.
- [ ] **Processing & Upload tab — processing half**:
  - control strip with a summary line, batch progress bar, and the
    stage-changing **primary action** (Start processing → live counts while
    running → **Rerun all failed** if any failed → hand to **Upload batch** when
    ready);
  - a **per-item list** with live status (queued/running/done/failed), the error
    message on failure, and a per-item **Rerun**;
  - the start-blocked note when another batch is running.
  — **`.ts` ✅ (state + actions)** `useProcessing` store: `start` / `rerunItem` /
  `rerunFailed` / `reprocess` / `cancel`, live `progress` + `log`, and coarse
  `proc`/`running`/`stage` write-through; `batchProgress`/`failedItemIds`
  (Epic 03) drive the bar + the primary-action transitions. **◻ (logic —
  deferred with GUI)** the `useProcessing` **composable** (the view-model, per
  the Epic 04 precedent). **`.vue` ◻** the tab itself.
- [ ] **Rerun at two grains**: a single failed item, or all failed items in the
      batch. On all-resolved, the batch stage becomes `ready`.
      — **`.ts` ✅** `useProcessing.rerunItem` (re-runs an item's failed stage +
      any downstream stages the failure left pending) and `rerunFailed`
      (`failedItemIds`); `settleStageAfterRun` → `ready` once every item's run is
      `done`, else stays `processing`. **`.vue` ◻** the two controls.
- [ ] **Atomic writes**: write each derived output to a temp file then rename, so
      a crashed/re-run step never leaves a partial that looks "done".
      — **`.rs` ◻ (Arch).** Contract: the logic lane treats a stage as `done`
      only on a `job://stage-changed` with `status: done`, so a half-written
      output never reads complete.
- [ ] **Dirty flag → needs re-upload**: producing new derived outputs (e.g. after
      TIFFs change) sets a SQLite "derived-changed-since-upload" flag that
      surfaces as **Needs re-upload** (Epics 02, 07). Driven by new PDF/OCR only —
      **never** by metadata.
      — **`.ts` ✅ (rule)** `dirtiesUpload(stage)` / `DERIVED_STAGES` in
      `domain/pipeline.ts` (any derived output — PDF/thumbnail/OCR — dirties;
      **never** `metadata`/`upload`); `Item.flags.reupload` already drives the
      state machine (Epic 02). **`.rs` ◻** set the SQLite flag when the runner
      writes new outputs (the run's `mode` distinguishes a fresh run from a
      re-process).
- [ ] **Re-process action** (explicit): rebuild any stage (archival PDF, web PDF,
      thumbnail, OCR) on demand, overwriting old outputs. On an already-uploaded
      item it is an explicit, guarded action (the same **Edit / re-process** gate
      as Metadata) and **marks the item Needs re-upload**; optionally auto-detect
      new/changed TIFFs and suggest it. Re-runs obey the per-workstation
      single-run lock.
      — **`.ts` ✅** `useProcessing.reprocess(itemId, stages)` → `ipc.jobs.reprocess`
      (force-overwrite, `mode: reprocess`), guarded by the single-run lock + the
      Edit/re-process gate (`useBatch.readOnly`/`unlock`, Epic 03). **`.rs` ◻**
      rebuild + set the dirty flag. **`.vue` ◻** the action control + the
      auto-detect suggestion.
- [ ] **Skip-if-done**: skip stages SQLite marks complete unless the user forces a
      re-run, so big batches don't needlessly re-OCR.
      — **`.ts` ✅** `stagesToRun` reduces each item to the stages that actually
      need running (skips `done` unless `force`); the runner receives exactly that
      list. **`.rs` ◻** honour it (no re-derivation needed).
- [ ] Concurrency/memory limits informed by real volumes — open question #3.
      — **`.rs` ◻ (Arch) + open question #3.**

## Progress — logic lane (`.ts`) pass, 2026-08-05

**Shipped (typechecks + builds clean; `vitest` green — 59 new tests, 249 total;
adversarially reviewed across correctness / contract / convention / test-coverage,
all confirmed findings fixed).** The `.ts` decision here (consistent with how
`domain/files.ts` keeps asset classification out of Rust): the **adaptive
branching is computed in `.ts`** and handed to the native runner as a
fully-decided per-item request, so the runner just executes — it never re-derives
what a folder needs.

- `domain/pipeline.ts` (new) — the pure planning rules: `classifyInput` /
  `planPipeline` (the adaptive branch + applicable stages + upload candidates
  with preserved base names), `planThumbnail` (source selection incl. the
  multi-PDF case), `stagesToRun` (skip-if-done + `only`/`force` selection),
  `failedRunnableStages`, `processingComplete`, `markNonApplicableSkipped`, and
  `dirtiesUpload`/`DERIVED_STAGES` (the Needs-re-upload rule). Fully unit-tested.
- `domain/batch.ts` — added the pure run reducers the store folds events with:
  `withRunning`, `withItemRun`, `queueItems`, `allItemsDone`, `enterProcessing`,
  `settleStageAfterRun` (→ `ready` when all items succeed, else `processing`).
- `ipc/bindings.ts` — the **`ipc.jobs`** surface (`start` / `cancel` /
  `reprocess`) + the `BatchRunRequest`/`ItemRunRequest` DTOs (the decided plan).
- `ipc/events.ts` — the three job channels: `job://progress` (ephemeral live
  fraction), `job://stage-changed` (authoritative per-stage transition), and
  `job://done` (coarse per-item outcome + the batch-complete signal), with typed
  listeners.
- `services/pipeline.ts` (new) — `buildRunRequest`/`buildItemRunRequest` (plan →
  request), the `start`/`cancel`/`reprocess` drivers + the `watchJob*`
  subscriptions, and the pure event-fold reducers the run store applies (all
  unit-tested): `applyStageChanged` (per-stage → item), `applyJobDone`
  (per-item outcome + batch-complete settle), and `procFromProcessing` /
  `seedProcFromItems` (so an already-complete member still counts toward Ready —
  a batch no longer stalls in Processing because one item had no work to run).
- `stores/useProcessing.ts` (new) — the run store: guarded `start`/`rerunItem`/
  `rerunFailed`/`reprocess`/`cancel`, the boot-started job-event bridge that
  write-throughs coarse batch state (`proc`/`running`/`stage`) and reflects live
  per-stage item updates, plus the ephemeral `progress`/`log` feed. Wired into
  `app/boot.ts` (session-wide watch) and the stores barrel; leans on new
  `useItems.replaceItem` + `useBatches.persistRun` (sync-apply-then-write-through,
  so rapid job events don't lose updates).

**Still owed by the logic lane (`.ts`) — deferred with the frontend:** the
**`useProcessing` composable** (the Seam-1 view-model the Processing tab binds —
control-strip summary, primary-action state machine, per-item rows, the live-bar
projection over the store), mirroring how Epic 04 deferred `useMetadataForm`.
Also the operator's **thumbnail pick persistence** on the item (lands with the
Epic 04 metadata store; the plan already exposes `needsChoice` + a
`primaryThumbnails` input on `buildRunRequest`). All the pure pieces exist now.

**Owed by Arch (`.rs`/`.py`):** the **job runner** behind `ipc.jobs`
(queue, OCR-aware concurrency cap, cancel, streaming the three `job://*` events),
**atomic writes** (temp→rename), the **dirty-flag** SQLite write when new outputs
are produced, the native single-run lock, and the two open Python questions
(invocation strategy; cross-platform `ocr.py`). The runner receives a decided
request (`inputShape` + per-item `stages` + `primaryThumbnail` +
`thumbnailNeedsChoice` + `webPdfBases`) and only maps `(inputShape, stage)` →
script + writes folder-named outputs. **NB:** complete the Thumbnail stage only
when `thumbnailNeedsChoice` is false (name `primaryThumbnail`, else the single
generated first-page image); when true, generate candidates but hold it pending.

**Owed by GUI (`.vue`/`.css`):** the Processing & Upload tab (processing half) —
control strip + stage-changing primary action, the per-item live list with
per-item Rerun + Rerun-all-failed, the start-blocked note — plus the thumbnail
grid picker (shared with Epic 04's files strip).

## Acceptance

- A batch runs the full pipeline from the Processing tab with a live progress bar
  and per-item status; the primary action changes with stage.
- A failed item shows its error and can be rerun individually; "Rerun all failed"
  clears the fail set; the batch reaches `ready` when all items succeed.
- Starting a batch while another is running is blocked (per workstation).
- Derived outputs are folder-named, written atomically, and recorded in SQLite;
  new outputs flag the item Needs re-upload.

## Audit pass, 2026-08-08

Two of this epic's own safeguards turned out not to be connected to anything.

### The ContentKind override was inert — every run planned with `auto`

`BuildRunOptions.contentKinds` carried the comment *"Sourced from
`Batch.overrides[itemId].contentKind`"* — and nothing did that sourcing. Every
caller in `stores/useProcessing` omitted the option, so `buildItemRunRequest` fell
through to `opts.contentKinds?.[item.id] ?? "auto"` on **every real run**, and the
operator override this epic added was silently dead.

That override is not a nicety. Auto-detection is wrong in **both** directions on
real scanner output, and each mistake is damaging (docs/05-real-scan-data.md): a
260-page book misread as a graphical work gets **no PDF and no OCR**. Forcing the
answer is the entire point.

**Fixed in `services/pipeline.buildRunRequest`**, which already receives the
`Batch` — it now sources `contentKinds` from `batch.overrides` itself, so no
caller has to remember. An explicit `opts.contentKinds` still wins. Pinned by
tests, including one confirmed to fail without the fix.

> The general lesson, again: a comment saying where a value "is sourced from" is
> not a mechanism. If the object that has the data is already in scope, read it
> there rather than documenting that someone else should pass it.

**Still owed by GUI:** the action that *sets* `overrides[itemId].contentKind` —
the Setup-tab book/graphical control. Nothing populates it yet, so the override is
now wired end-to-end but always empty in practice.

**Still owed, same shape:** `primaryThumbnails` (already flagged as deferred) and
`splitSpreads` — the latter has **no `BatchItemOverride` field at all**, so it is
hard-coded `false` in every run and needs a home on the batch before any UI can
set it.

### This epic's warning to Epic 07 had not been followed

The Progress note said, verbatim: *"NB for Epics 04/07: use the plan's
`thumbnail.needsChoice` (not `files.needsThumbnailChoice` alone) so the multi-PDF
case is caught."* `domain/upload.uploadBlockers` used
`files.needsThumbnailChoice` directly — which counts only images **already
present** — so a multi-PDF item, whose candidates are first-page images the
pipeline has yet to generate, scored zero candidates and the hard
`thumbnail-unresolved` gate never fired. Such an item could publish with an
unresolved thumbnail.

Fixed in Epic 07 (`uploadBlockers` now goes through `planThumbnail`); see
[Epic 07 §Audit pass](07-upload-and-publish.md).
