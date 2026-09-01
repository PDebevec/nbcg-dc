# Epic 06 — Processing pipeline & jobs

> Depends on: 01, 02, 03, 04 · Blocks: 07, 11
> Logic-lane (`.ts`) pass: **2026-08-05** — the adaptive-pipeline planning, the
> job IPC/event contract, the orchestration service, and the run store landed
> (see **Progress** below). The Rust job runner landed 2026-08-21 (first slice)
> and 2026-08-24 (real cancel). **Correction, 2026-08-25:** this line used to
> also list the Processing tab (`.vue`) as remaining work — it isn't.
> `src/views/batch/ProcessingTab.vue` and `src/composables/useProcessing.ts`
> already exist and call the real `jobs_*` IPC, committed in `15511db "Frontend
> v2, my TODO"`; the docs simply hadn't caught up. **The queue/OCR-aware
> concurrency cap landed 2026-09-01** — a bounded worker pool
> (`std::thread::scope`) runs up to `maxConcurrentItems` items at once, each
> through its own `pdf` → `thumbnail` → `ocr` stages in order, with OCR
> additionally gated batch-wide by `maxConcurrentOcr` (a hand-rolled
> `Semaphore`) since PaddleOCR is the heavy stage. Both caps default to a
> conservative guess (3 / 1) and are tunable **only** by hand-editing
> `config.json` (`PersistedConfig.maxConcurrentItems`/`maxConcurrentOcr`) —
> open question #3's real volume data still doesn't exist, so this ships a
> first-slice default rather than a measured one; see
> `src-tauri/src/core/jobs/mod.rs`'s `JobLimits`. What's actually still open
> here is the thumbnail grid picker.

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
`.vue` = GUI, `.rs`/`.py` = Arch. ✅ done · ◻ to do.

> **Checkboxes track the logic lane**, per
> [the roadmap convention](README.md#what-a-checkbox-means) — so `[x]` here means
> the `.ts` work is done and the per-item `.rs`/`.py`/`.vue` annotations say what
> is left. This doc previously held out for end-to-end completion, which made a
> finished logic lane read as unstarted and made `[x]` mean something different
> here than in Epics 03/07/08/10.

- [x] Choose the **Python invocation strategy** (sidecar / system / native) —
      see [overview](../00-project-overview.md) and
      [architecture](../02-architecture.md).
      — **`.rs`/`.py` ✅ (Arch), 2026-08-21.** System `python`/`py` on `PATH`
      (`core::python::spawn_python`, tries `python` then falls back to `py`
      on `NotFound`) — a deliberate dev-only choice, not a final decision:
      sidecar bundling (a portable Python runtime shipped in the installer)
      is deferred to [Epic 11](11-packaging-and-distribution.md), which is
      entirely unstarted. The `.ts` contract (`ipc.jobs`, `ItemRunRequest`)
      was already invocation-agnostic, so nothing there needed to change.
- [x] Make [`py/ocr.py`](../../py/ocr.py) **cross-platform**: replace the
      Linux-only `resource.setrlimit` cap with a Windows-safe approach.
      — **`.py` ✅ (Arch), 2026-08-20.** `nbcg_pipeline.limits.apply_memory_cap`
      — a no-op (not an error) where `resource` is unavailable, i.e. Windows.
      Not a real enforced cap there (would need Job Objects) — see
      §Concurrency below for why that's an acceptable gap for now.
- [x] Wrap the scripts as first-class **operations** producing folder-named
      outputs: `pdf` (archival `<name>_archive.pdf` + web `<name>.pdf`),
      `thumbnail` (`<name>_thumb.png`), `ocr` (`<name>.txt`). Reuse
      [`py/web.py`](../../py/web.py) and [`py/ocr.py`](../../py/ocr.py).
      — **`.ts` ✅ (contract)** the operation vocabulary + naming is single-sourced:
      `RunnableStage` (`pdf`/`thumbnail`/`ocr`) + `PipelinePlan.candidates`
      (folder-derived single outputs / discovered PDFs' own base names) in
      `domain/pipeline.ts`, carried to the runner as the per-item `ItemRunRequest`
      (`stages` + `inputShape` + `webPdfBases` + `primaryThumbnail` +
      `thumbnailNeedsChoice`).
      **`.rs`/`.py` ✅ for all six shapes, 2026-08-21** (`core::jobs`'s
      `(input_shape, stage) → script` mapping). `supplied-pdf` and
      `multiple-pdfs` landed last, on the new `py/pdf_derive.py`
      (pypdfium2) — see the progress note below for the shape-flip problem
      they turned out to carry.
- [x] **Adaptive input handling**: branch the pipeline on folder contents (TIFFs
      / supplied PDF with no TIFFs / images with no PDF), and process **multiple
      PDFs/images** into multiple upload candidates — preserving each discovered
      file's own filename so its OCR text matches by base name.
      — **`.ts` ✅** `domain/pipeline.ts`: `classifyInput` (tiffs / supplied-pdf /
      multiple-pdfs / **page-images** / images-only / empty), `applicableStages`
      (images-only ⇒ no PDF, **no OCR**), `uploadCandidates` (preserves each PDF's
      base name; single supplied PDF, TIFF build, and page runs are
      folder-derived). Passed to the runner via `inputShape` + `webPdfBases` +
      `pageImages` + `splitSpreads`.
      **`.rs`/`.py` ✅ for all six shapes** — same status as the
      operation-mapping item just above (they're the same piece of work).
      **`splitSpreads` ✅,
      2026-08-21:** `core::jobs` runs `py/split_spreads.py` into a staging
      folder first and assembles the PDF from its reported page order, as the
      invisible sub-step of `pdf` this was always meant to be — not a visible
      stage. `page-images` only; on `tiffs` the runner **refuses** rather than
      ignoring (the archival master must come from the TIFFs at full
      fidelity), and on `images-only` it is inapplicable, since no PDF is
      built at all. Two supporting flags, both closing the same
      re-derivation gap as `--mode`/`--pages` before them:
      `split_spreads.py --pages` (the `.ts` page order, not a re-scan) and
      `web.py --name` (the `.ts` naming base, not the folder's own name —
      which is also what lets the outputs be named after the item while being
      assembled from a staging folder).

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
  **`.rs`/`.py` ✅, 2026-08-21:** the runner honours both fields already —
  `ItemRunRequest.primaryThumbnail` reaches `web.py` as `--thumbnail-source`
  (an explicit pick, independent of shape/PDF page selection), and
  `thumbnailNeedsChoice: true` withholds the Thumbnail stage's `done`
  transition (writes `Pending` instead), so a resolved choice can't be masked
  by a stale `done`. Pinned by
  `core_jobs::images_only_honours_the_tagged_thumbnail_over_the_natural_first_image`.
  What's still missing is entirely upstream of Arch: nothing sets
  `primaryThumbnail` yet, since the Setup-tab picker (`.vue`) and its
  persistence (`.ts`, deferred with Epic 04) don't exist — so this is
  correctly wired end to end but exercised by no real UI path today, same
  situation as `contentKind`/`splitSpreads` before it.
- [x] **Job runner** in the Rust core: queue, concurrency limit (OCR is
      memory-heavy), start/cancel, per-item success/failure, streaming
      progress + logs to the UI as events.
      — **`.ts` ✅ (contract + drive)** `ipc.jobs` (`start`/`cancel`/`reprocess`)
      + the `job://progress` / `job://stage-changed` / `job://done` events
      (`ipc/events.ts`); `services/pipeline.ts` builds the request + wraps the
      calls; `stores/useProcessing.ts` folds events → coarse batch state
      (write-through) + live progress.
      **`.rs` ⏳ (first slice, 2026-08-21; real cancel, 2026-08-24):** real
      per-item/per-stage execution, streaming, and per-stage success/failure
      all work (`core::jobs`/`core::python`) — `src-tauri/tests/core_jobs.rs`
      runs `web.py`/`split_spreads.py`/`pdf_derive.py` for real end to end,
      across all six input shapes. Cancel is now real: `jobs_start`/
      `jobs_reprocess` were plain sync commands, which Tauri v2 runs on the
      **main thread** — so a whole batch ran inside one IPC call (freezing the
      window) and `jobs_cancel` could not even be delivered until that run
      finished on its own, making the runner's own cancel check unreachable
      from any UI. Fixed by making both `#[tauri::command(async)]` and giving
      `core::python` a spawn-then-poll loop
      (`core::cancel::CancelToken`, `Command::kill()`) instead of a single
      blocking `Command::output()` call; a cancelled stage settles `Pending`,
      never `Failed`, and `run_batch` resets any stage still `Queued`/
      `Running` the same way rather than leaving it stuck forever. **Still
      ◻:** the actual **queue** (today it's strictly sequential, one
      item/stage at a time — no concurrency at all, let alone an OCR-aware
      cap). See [06-native-core-and-dev-setup §1](../06-native-core-and-dev-setup.md).
- [x] **Per-workstation single-run lock**: enforce one batch processing at a
      time; Start/Rerun while another batch runs is blocked with the standard
      message (uses the guard from [batches](03-batches-and-lifecycle.md)).
      — **`.ts` ✅** `anyOtherRunning`/`singleRunBlockedMessage` (Epic 03) checked
      in `useProcessing` before every start/rerun/reprocess; `useBatch` already
      surfaces `runBlocked`/`runBlockedMessage`.
      **`.rs` ✅, 2026-08-21:** `core::jobs::JobRunLock` — an `AppState`-held
      mutex holding the running batch id, checked/set atomically in
      `try_acquire`, released unconditionally by the guard's `Drop` (covers
      `Ok`/`Err`/panic-unwind alike, since the mutex is only ever held for
      the instant of the check, never across the run). Pinned by
      `core_jobs::a_second_batch_is_rejected_while_the_first_holds_the_lock`.
- [x] **Processing & Upload tab — processing half**:
  - control strip with a summary line, batch progress bar, and the
    stage-changing **primary action** (Start processing → live counts while
    running → **Rerun all failed** if any failed → hand to **Upload batch** when
    ready);
  - a **per-item list** with live status (queued/running/done/failed), the error
    message on failure, and a per-item **Rerun**;
  - the start-blocked note when another batch is running.
  — **`.ts` ✅** `useProcessing` store: `start` / `rerunItem` /
  `rerunFailed` / `reprocess` / `cancel`, live `progress` + `log`, and coarse
  `proc`/`running`/`stage` write-through; `batchProgress`/`failedItemIds`
  (Epic 03) drive the bar + the primary-action transitions.
  **`.ts` ✅, corrected 2026-08-25:** the `useProcessing` **composable**
  (`src/composables/useProcessing.ts`) exists — this doc previously said it
  was deferred with the GUI; it landed alongside it instead, undocumented.
  **`.vue` ✅, corrected 2026-08-25:** `ProcessingTab.vue` — control strip,
  per-item list with rerun, run log — binds the composable and is routed from
  `BatchWorkView.vue`. Both committed in `15511db "Frontend v2, my TODO"`, no
  test coverage yet for the IPC-calling paths (tracked separately).
- [x] **Rerun at two grains**: a single failed item, or all failed items in the
      batch. On all-resolved, the batch stage becomes `ready`.
      — **`.ts` ✅** `useProcessing.rerunItem` (re-runs an item's failed stage +
      any downstream stages the failure left pending) and `rerunFailed`
      (`failedItemIds`); `settleStageAfterRun` → `ready` once every item's run is
      `done`, else stays `processing`. **`.vue` ◻** the two controls.
- [x] **Atomic writes**: write each derived output to a temp file then rename, so
      a crashed/re-run step never leaves a partial that looks "done".
      — **`.rs` ✅ (Arch), 2026-08-21.** Each `web.py`/`ocr.py` call stages
      into a fresh `.nbcg-tmp-<uuid>/` folder (`--out-dir`); on success, every
      output file is finalized one at a time via `sync_all()` + rename
      (`core::fs::finalize_staged_output`), verbatim against what the
      script's own JSON summary reported it wrote; the staging dir is removed
      either way. Contract: the logic lane treats a stage as `done` only on a
      `job://stage-changed` with `status: done`, so a half-written output
      never reads complete — holds, since `set_stage`/the event both fire
      strictly after finalize succeeds. One known gap: if a multi-file
      finalize partially succeeds (e.g. renaming the archival PDF works, the
      web PDF's rename then fails), the successfully-renamed file is real on
      disk but the stage is still marked `Failed` — self-heals on the next
      run/rescan, not a correctness bug, just noted.
- [x] **Dirty flag → needs re-upload**: producing new derived outputs (e.g. after
      TIFFs change) sets a SQLite "derived-changed-since-upload" flag that
      surfaces as **Needs re-upload** (Epics 02, 07). Driven by new PDF/OCR only —
      **never** by metadata.
      — **`.ts` ✅ (rule)** `dirtiesUpload(stage)` / `DERIVED_STAGES` in
      `domain/pipeline.ts` (any derived output — PDF/thumbnail/OCR — dirties;
      **never** `metadata`/`upload`); `Item.flags.reupload` already drives the
      state machine (Epic 02).
      **`.rs` ✅, 2026-08-21:** new `db::items::mark_needs_reupload`, called
      from `core::jobs` when `mode == Reprocess` produced `Done` output on an
      item already `uploaded`. Scoped to `Reprocess` specifically, not every
      mode — matches `stores/useProcessing.reprocess`'s own doc comment
      ("marks an uploaded item Needs re-upload native-side"), and `Run`/
      `Rerun` cannot reach an uploaded item in normal operation anyway
      (`rerunItem`/`rerunFailed` run mid-processing, before upload; upload is
      a separate, later step — confirmed against `resolveRunnable`/`launch`
      in `stores/useProcessing.ts`).
- [x] **Re-process action** (explicit): rebuild any stage (archival PDF, web PDF,
      thumbnail, OCR) on demand, overwriting old outputs. On an already-uploaded
      item it is an explicit, guarded action (the same **Edit / re-process** gate
      as Metadata) and **marks the item Needs re-upload**; optionally auto-detect
      new/changed TIFFs and suggest it. Re-runs obey the per-workstation
      single-run lock.
      — **`.ts` ✅** `useProcessing.reprocess(itemId, stages)` → `ipc.jobs.reprocess`
      (force-overwrite, `mode: reprocess`), guarded by the single-run lock + the
      Edit/re-process gate (`useBatch.readOnly`/`unlock`, Epic 03).
      **`.rs` ✅, 2026-08-21:** `jobs_reprocess` shares `jobs_start`'s
      execution path (`core::jobs::run_batch` doesn't branch on `mode` except
      for the dirty-flag call) — rebuild works and sets the flag. Auto-detect
      of new/changed TIFFs is not implemented (no TIFF-change-detection
      exists anywhere yet; not attempted). **`.vue` ◻** the action control +
      the auto-detect suggestion.
- [x] **Skip-if-done**: skip stages SQLite marks complete unless the user forces a
      re-run, so big batches don't needlessly re-OCR.
      — **`.ts` ✅** `stagesToRun` reduces each item to the stages that actually
      need running (skips `done` unless `force`); the runner receives exactly that
      list.
      **`.rs` ✅, 2026-08-21:** trivially — `core::jobs` only ever executes
      `item.stages` as given, with no independent notion of "done" to
      re-derive from, so there was nothing to build here beyond trusting the
      request (per the same single-source-of-truth principle as page order).
- [x] Concurrency/memory limits — a first-slice default, not measured on real
      volumes (open question #3 is still open on the *number*, just no longer
      blocking).
      — **`.rs` ✅, 2026-09-01:** `core::jobs::JobLimits` (3 concurrent items /
      1 concurrent OCR, hand-edit `config.json` to change — no GUI control).

## Progress — logic lane (`.ts`) pass, 2026-08-05

**Shipped (typechecks + builds clean; `vitest` green — 59 new tests at the time;
suite total in [PROJECT-KNOWLEDGE §5](../PROJECT-KNOWLEDGE.md); adversarially
reviewed across correctness / contract / convention / test-coverage,
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

~~Still owed by the logic lane (`.ts`) — deferred with the frontend: the
`useProcessing` composable~~ — **built, 2026-08-25 correction:**
`src/composables/useProcessing.ts` exists (the Seam-1 view-model — control-strip
summary, primary-action state machine, per-item rows, the live-bar projection
over the store), landed in the `15511db` frontend pass this doc never recorded.
Still genuinely open: the operator's **thumbnail pick persistence** on the item
(lands with the Epic 04 metadata store; the plan already exposes `needsChoice` +
a `primaryThumbnails` input on `buildRunRequest`).

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

~~Owed by GUI (`.vue`/`.css`): the Processing & Upload tab (processing half)~~ —
**built, 2026-08-25 correction:** `ProcessingTab.vue` (control strip,
stage-changing primary action, per-item live list with Rerun/Rerun-all-failed,
start-blocked note) exists and is routed. Still owed by GUI: the thumbnail grid
picker (shared with Epic 04's files strip).

## Progress — Arch lane, first slice, 2026-08-21

The paragraph above (2026-08-05) is superseded for everything except the
concurrency cap and the two unsupported input shapes:

- ✅ **Job runner** — `core::jobs`/`core::python` (new), spawning
  `py/web.py`/`py/ocr.py` via system `python`/`py` on `PATH`. Sequential only
  — **not** a queue, **no** concurrency cap (open question #3 still open).
- ✅ **Atomic writes**, **dirty-flag write**, **native single-run lock** —
  all real, all tested (`src-tauri/tests/core_jobs.rs`, 10 tests; `web.py`
  runs for real against fixture JPGs).
- ✅ **Both Python questions** — invocation strategy (system Python, sidecar
  deferred to Epic 11) and `ocr.py` cross-platform (Windows no-ops the
  memory cap rather than crashing at import).
- ✅ **The `(inputShape, stage) → script` map**, for `tiffs`/`page-images`/
  `images-only`, **driven by `inputShape` itself, not folder re-sniffing**
  (`web.py --mode {flat,paired}`, `core::jobs::web_mode`).
  `supplied-pdf`/`multiple-pdfs` followed later the same day — see below.
- ✅ **The Thumbnail `primaryThumbnail`/`thumbnailNeedsChoice` NB, honoured
  correctly** — `web.py` gained `--thumbnail-source` for this specifically
  (independent of `--pages`, which only controls PDF assembly).
- ✅ **`split_spreads` integration** — added in a follow-up the same day (see
  below). ◻ **true mid-process cancellation** (`jobs_cancel` only stops the
  next item/stage, not `Command::kill()` on one already running) — untouched,
  as planned.

**Two review-pass corrections, both the same root cause and same day:**
the first merge of this slice ignored `primaryThumbnail` entirely (always
thumbnailed the natural-first image — silently wrong whenever a folder has a
file conventionally named `thumbnail.*`, per `domain/files.autoThumbnail`),
and separately had `web.py` decide flat-vs-paired by re-scanning the folder
itself rather than trusting `inputShape` — the identical "script re-derives
something `.ts` already decided" mistake the doc's own page-order warning was
about, just for shape instead of order. Both caught in review before
anything downstream depended on either, both fixed the same session. Pinned
by `core_jobs::images_only_honours_the_tagged_thumbnail_over_the_natural_first_image`
and `core_jobs::page_images_shape_is_not_misclassified_as_paired_by_web_pys_own_folder_sniffing`
respectively — the latter plants a red-herring jpg/tif pair inside a genuine
`page-images` folder and confirms `web.py` ignores it.

### `splitSpreads`, the third and last of them — 2026-08-21

Same bug class as the two above, found by looking for the rest of it rather
than by a failure: `ItemRunRequest.splitSpreads` reached the runner and was
**dropped**. Turning the operator's toggle on produced byte-identical output to
leaving it off, so `ОКТОИХ петогласник 2` — 162 landscape scans, ~324 real
pages — would assemble with two pages on every sheet, and OCR would read
across the gutter. It builds, it opens, nothing fails; only a reader notices.

Fixed by running `py/split_spreads.py` into the staging folder before
`web.py`, then assembling from the page order it reports. The two new flags
(`split_spreads.py --pages`, `web.py --name`) exist so neither script
re-derives page order or the naming base — the same reason `--mode` and
`--pages` exist. A chosen `primaryThumbnail` is passed as an **absolute path**
so it is built from the whole original: the cover is the one image in a book of
spreads that must not be cut in half (docs/05 open question #5, still open —
this makes the operator's pick honourable, it does not automate the decision).

Pinned by `core_jobs::split_spreads_halves_each_scan_before_the_pdf_is_assembled`
(a red-left/blue-right spread fixture; one pixel of the thumbnail says whether
it came from half the spread or all of it),
`split_spreads_keeps_the_operators_thumbnail_pick_unsplit`, and
`split_spreads_on_a_tiffs_item_fails_clearly_instead_of_being_ignored`. Each
was confirmed to fail against the specific mistake it exists to catch.

**Still not detected automatically** (docs/05 open question #4): telling a 2-up
spread from a landscape map needs pixel access, so `splitSpreads` stays an
operator toggle. And nothing sets it yet — `BatchItemOverride.splitSpreads`
exists, the Setup-tab control is `.vue`. Same standing situation as
`contentKind` and `primaryThumbnail`: wired end to end, exercised by no real
UI path today.

### The two PDF-source shapes — 2026-08-21

`supplied-pdf` and `multiple-pdfs` were the last shapes the runner refused.
`Pisma iz Liona` — one of the four real corpus folders — is `supplied-pdf`, so
it could not be processed at all. Both now run, on a new `py/pdf_derive.py`.

**Implementing `supplied-pdf` as the contract literally reads would have
corrupted the item's shape between runs.** `uploadCandidates` says the output
is `<folderName>.pdf`, but `classifyAsset` calls *every* non-`_archive` PDF a
`web-pdf` and `classifyInput` branches on how many the folder holds — so
writing the derived PDF beside the original makes the folder hold two, and the
next scan reads the item as `multiple-pdfs`. The shape changes silently and the
next upload pushes the full-size original as a web asset. That was
[docs/05 open question #1](../05-real-scan-data.md), unanswered until now.

**Answered by Peter, 2026-08-21: the supplied PDF is a source.** The runner
files it under `<folder>/source/` before deriving, so the folder root keeps
exactly one PDF and the shape is stable across runs. It is preserved
byte-for-byte, never modified, and travels with the folder into `/processed`
(`move_to_processed` recurses). Re-runs derive from the filed original, not from
the previous output — otherwise each run downscales a downscale.
`core::fs::describe_folder` lists files without recursing, so no scanner or
`.ts` change was needed for any of this.

**`multiple-pdfs`: the `pdf` stage builds nothing.** `uploadCandidates` already
keeps each discovered PDF's own filename, so the operator's PDFs *are* the web
PDFs — the stage verifies they exist and marks done, and never rewrites them.
Each yields a `<base>_thumb.png` candidate (a new convention, but the
consistent one: `classifyAsset` already treats `*_thumb` as kind `thumbnail`,
so they become exactly the candidate pool `planThumbnail` expects), the stage
holds `Pending` until the operator picks, and OCR writes one `<base>.txt` per
PDF — the "text matches by base name" invariant, finally real.

**`pypdfium2`, chosen on licensing as much as capability.** PyMuPDF is AGPL,
which would have made the whole app AGPL for anyone it is ever handed to;
`pdf2image` needs poppler, a system binary every developer and the eventual
installer must carry. pypdfium2 is BSD/Apache and ships self-contained wheels,
so `pip install -r requirements.txt` is still the entire setup.

Pinned by six `core_jobs` tests, each checked against the mistake it exists to
catch. The load-bearing one is
`supplied_pdf_derives_the_web_pdf_and_files_the_original_under_source`, whose
real assertion is not that the outputs exist but that **the folder root holds
exactly one PDF afterwards** — the thing that stops the shape flipping.

See [06-native-core-and-dev-setup §1](../06-native-core-and-dev-setup.md) for
the fuller writeup and [py-real-data-mismatches](py-real-data-mismatches.md)
for the companion `.py`-side fixes.

### Real mid-process cancellation — 2026-08-24

The last unblocked item in the "Still ◻" list above turned out to be hiding a
worse bug. `jobs_start`/`jobs_reprocess` were plain `#[tauri::command]`s with
no `async`, which Tauri v2 runs inline on the **main thread**
(`ExecutionContext::Blocking` in `tauri-macros`) rather than dispatching to a
worker. So a whole batch ran *inside one IPC call*: the window would freeze
for the run's duration, and — the part that made this more than a UX
complaint — `jobs_cancel`, also an invoke, could not be **delivered** until
the run it was meant to cancel had already finished on its own. The
cooperative between-items cancel check `run_batch` already had was correct
and entirely unreachable from any real click, by construction. **Correction,
2026-08-25:** this used to say "no UI calls `jobs_start` yet" — wrong;
`ProcessingTab.vue`/`useProcessing` already did, since `15511db`. Nothing had
caught it simply because nobody had yet clicked through a real run to observe
the freeze — that click-through is the logical next step now that the fix and
its own test coverage are in place.

Fixed in two parts. **`jobs_start`/`jobs_reprocess` are now
`#[tauri::command(async)]`**, so the body dispatches onto a tokio worker and
the main thread stays free to handle `jobs_cancel` promptly (`jobs_cancel`
itself stays sync — it only flips a flag and must be handled fast, so there's
nothing to gain by moving it off the main thread). That alone would still only
stop the *next* stage from starting, so **`core::python::spawn_python` was
rewritten from one blocking `Command::output()` call into a spawn-then-poll
loop**: stdout/stderr are piped and drained on their own threads (skipping
this deadlocks the moment a chatty script — `ocr.py` logs a line per page —
fills an undrained pipe buffer), and every 100 ms the loop checks both
`try_wait()` and a new `core::cancel::CancelToken`, killing the child
immediately on a match. A killed run now returns `AppError::Cancelled`, kept
distinct from a real script failure so the stage-settle points in
`core::jobs` can tell them apart and write `Pending` — never `Failed` — per
the operator's own framing: a cancel isn't a failure, and `stagesToRun`
already re-runs anything not `done`. A related bug found while implementing
this: `run_batch` queues every stage of every item up front and never reset
that on the cancel path, so an un-started item's stages sat `Queued` in
SQLite forever after a cancel; a new `reset_unfinished_stages` reads each
item's current status back from the index and resets anything still
`Queued`/`Running` to `Pending`, self-correcting rather than tracking a
separate bookkeeping set.

Pinned by two `core::python` unit tests (a cancelled child is killed within
about a second rather than waited out for 30; a script that floods stderr
still completes, the regression test for the undrained-pipe deadlock) and two
`core_jobs.rs` integration tests (a cancel requested before the run starts
leaves every stage `Pending`, not stuck `Queued`; a cancel fired the instant
the first stage goes `Running` — deterministic, since the cancel token is set
before the child is ever spawned — settles that stage `Pending`, never
`Failed`, and emits exactly one terminal `Cancelled` event with no misleading
per-item `Done`).

**Still open, unchanged:** the actual queue / OCR-aware concurrency cap (open
question #3), and `child.kill()` reaching the interpreter process only on
Windows — a stated limit, not a bug, since none of the four scripts spawns
its own children today.

**A second cancel bug, found smoke-testing against real archive data,
2026-08-26.** The two `core_jobs.rs` cancel tests above only ever queued
`[Pdf, Thumbnail]` — never `Ocr` behind them. Against a real `page-images`
item (`InputShape::PageImages`/`Tiffs`), `run_pdf_thumbnail_ocr` calls
`run_web_stage(...)` then unconditionally `run_ocr_stage(...)`, with no
cancel check in between. A cancel landing mid-`run_web_stage` correctly
settled `pdf`/`thumbnail` to `Pending` (the mechanism above) — but
`run_ocr_stage`'s "does the web PDF exist yet" precondition
(`core/jobs/mod.rs:452-467`) is entirely synchronous, no subprocess, so
there's no `spawn_and_wait` cancel-poll on that path to catch it: it always
failed immediately with a permanent `Failed` and a misleading "run the pdf
stage first," even though `pdf` had already reset to `Pending` and would
rerun on the very next Start. Recoverable via a full re-Start, but not via
per-item **Rerun** (which only retargets stages currently `status ==
"failed"` — `pdf` reads `Pending`, so Rerun would retry only `ocr` forever).

Fixed with a one-function guard: `run_ocr_stage` now checks
`cancel.is_cancelled()` as its first statement and returns `Ok(())`
untouched if set, leaving the stage `Queued` for `reset_unfinished_stages`
(already existing machinery, see above) to settle to `Pending` — no new
state-transition logic. Pinned by a third `core_jobs.rs` test queuing all
three stages and confirming `ocr` settles `Pending` with no stale error.
Confirmed against real data too: re-ran the exact cancel-mid-`pdf` scenario
against a real 522-image item post-fix — the item now reads "Not started,"
not red.

## Progress — Arch lane, the queue / OCR-aware concurrency cap, 2026-09-01

The last item the two entries above marked "still open, unchanged." `run_batch`
was a plain sequential loop; it now runs up to `JobLimits.max_concurrent_items`
items at once, each on its own worker thread (`std::thread::scope`, so `db`/the
cancel token are borrowed, not `Arc`-wrapped), still through its own `pdf` →
`thumbnail` → `ocr` stages in strict per-item order. OCR is additionally gated
**batch-wide** by `JobLimits.max_concurrent_ocr` — a small hand-rolled counting
`Semaphore` (`Mutex<usize>` + `Condvar`, ~100ms poll so a wait can still notice
a cancel) — since PaddleOCR is the heavy stage and PDF/thumbnail assembly
(Pillow/pypdfium2) is comparatively light; it's acquired once per item's whole
OCR stage (covering every PDF that item's OCR pass runs, not once per PDF).

Both caps default to a conservative, unmeasured guess (3 concurrent items, 1
concurrent OCR) — open question #3's real hardware/volume data still doesn't
exist. Rather than block on that, they're a `config.json`-only knob
(`PersistedConfig.maxConcurrentItems`/`maxConcurrentOcr`, hand-edited, no
Settings UI): `commands::config::config_save` restores whichever of the two is
already on disk before writing, so an ordinary Settings save from the GUI
(whose `.ts` type doesn't carry these fields at all) can never silently reset
a hand-tuned value back to default. See `core::jobs::JobLimits`.

Two mechanical consequences worth recording, both verified safe rather than
assumed:

- **`emit` stays a plain `FnMut`, not `Fn + Send + Sync`.** Worker threads
  report events over an `mpsc` channel instead of calling `emit` directly; a
  single collector loop — on the calling thread, inside the same
  `thread::scope`, draining live while workers are still running rather than
  after they all finish — is the only thing that ever calls `emit`. This
  meant every existing test's `|e| events.push(e)`-style collector needed no
  changes at all beyond the new `JobLimits` argument.
- **`batch_complete: true` is now always its own synthetic event**
  (`item_id: None`), emitted exactly once after every worker has joined,
  never piggy-backed on "the last item by index" (meaningless once items run
  concurrently). Verified safe against `src/services/pipeline.ts`'s
  `applyJobDone` before making the change, not after: it already treated
  `itemId` and `batchComplete` as fully orthogonal, and the cancellation and
  empty-batch paths already used exactly this separate-event shape — so this
  is a new *use* of an existing, already-handled contract, not a new one,
  and needed no `.ts` change.

Tests: every pre-existing `core_jobs.rs` test now runs under a `SEQUENTIAL`
(`{1,1}`) `JobLimits` constant, forcing the exact ordering those tests already
asserted on, unchanged. New: two `core::jobs::tests` unit tests pin the
`Semaphore` itself against a synthetic, timing-controlled workload (never
exceeds its permit count under real contention; a released permit is really
reusable) plus one for `JobLimits::from_config`'s zero/oversized/`None`
clamping — deterministic, no subprocess involved. One new `core_jobs.rs`
integration test runs three items under the real default caps (real `web.py`
calls) and asserts *outcome* correctness — every item still reaches `Done`,
exactly one terminal event fires, and nothing arrives after it — rather than
timing, which would be flaky against real subprocess scheduling. Two new
`config_store.rs` tests pin the preserve-on-save behavior directly.

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

### `splitSpreads` had the same hole, one step worse — fixed 2026-08-08

Flagged in this section as "needs a home on the batch before any UI can set it",
and then left there. It was worse than `contentKinds`: that at least had a
`BatchItemOverride` field nothing read, whereas `splitSpreads` had **no field at
all**, so `buildItemRunRequest` fell through to `false` on every run and
`py/split_spreads.py` could never be asked to run. `ОКТОИХ петогласник 2` — the
landscape 2-up book that is the *reason* the option exists (docs/05) — could not
be split by any code path.

**Fixed:** `BatchItemOverride.splitSpreads` exists, and `buildRunRequest` sources
it off the batch exactly as it sources `contentKinds`, so no caller has to
remember. Pinned by two tests in `services/pipeline.test.ts`.

**Still owed by GUI:** the per-item control that sets it (Setup tab, next to the
book/graphical toggle). As with `contentKind`, the path is now wired end-to-end
and simply always empty until something populates it.

**Still deferred:** `primaryThumbnails` — genuinely blocked, not overlooked. The
operator's thumbnail pick has to be *persisted somewhere* first, and that is the
Epic 04 metadata working-model store, which lands with the GUI.

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
