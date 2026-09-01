# Epic 07 — Upload & publish

> Depends on: 02, 03, 04, 05, 06, 09 · Blocks: — (closes the loop)

Goal: the **Upload** half of the Processing & Upload tab — turn a processed,
described batch into records/drafts on the backend (single source of truth),
write-through to the local copies, move folders to `/processed`, and support
re-upload after re-processing.

## Tasks

- [x] **Upload gating**: only available when the batch is **Ready** (all items
      processed, no failures). Pre-flight per item: required fields valid; PDF +
      downscale + thumbnail done. **OCR text is a soft warning** — if empty, warn
      ("not processed to the end — confirm you don't need full text, or go
      extract it") but allow continue.
- [x] **Write-gating**: there is no pre-check of write access (single-user,
      static token, no identity endpoint). If the token lacks the required
      `*:manage` scope, the create/upload call returns `403` — catch it and
      surface a clear message ("token lacks write access") rather than a raw
      error.
- [x] **Thumbnail gate**: block upload until every **multi-image** item has a
      chosen thumbnail source (single-image / PDF-first-page items resolve
      automatically — Epic 06). If unresolved, surface the picker (Epic 04) and
      don't allow publish — a **hard gate**, not a soft warning.
- [x] **Upload summary** (in the tab): each item's **publish target** (Draft /
      Record) and **visibility** (Public / Private / Hidden) — batch defaults with
      any per-item overrides shown — and the **upload
      set** per item — every discovered **web PDF** and **image** shown as an
      include/exclude option (all included by default), which image is the
      **primary/thumbnail**, plus the full text (via `extractedTexts`) and
      metadata. Source TIFFs + archival master stay local.
- [x] **Create**: `POST /api/items` with each item's own `targetState: DRAFT|RECORD`
      and `visibilityStatus: PUBLIC|PRIVATE|HIDDEN` (the batch default unless the
      item overrides; already supported by the backend) → capture the returned **id**. COBISS items have deterministic
      ids — detect "already exists".
- [x] **Upload assets**: `POST /api/files/upload/:id` (multipart) with **all
      selected web PDFs and images** as file parts, and the OCR full text in the
      **`extractedTexts` form field** — a JSON string mapping **PDF filename →
      text**, one entry per PDF (e.g.
      `extractedTexts={"foo.pdf":"…","bar.pdf":"…"}`) — in the **same request**,
      with `doOCR=false`. The backend stores each text on the matching file **by
      name** and **skips Tika** for it (**implemented** —
      `nbcg/todo/backend-archive-external-fulltext-ingest.md`). Tag each file's
      **role** via `FileRole` (`SOURCE | ARCHIVAL | WEB | THUMBNAIL`): PDFs and
      non-primary images → **`WEB`**; the primary image → **`THUMBNAIL`**
      (**implemented** — `nbcg/todo/backend-archive-file-attachment-roles.md`).
      Archival + source files stay local and are not uploaded.
- [x] **Text quality**: the backend classifies supplied text (EXTRACTED /
      GARBAGE / NO_TEXT, via `looksGarbled`); treat a GARBAGE / empty result the
      same as the empty-OCR **soft warning** above.
- [x] **Link parents**: `POST /api/relations/connect { parentId, childIds }` —
      **one call per linked parent** (`childIds: [itemId]`), since an item may sit
      under several parents (many-to-many). Confirm the shape in
      [Epic 09](09-backend-api-contract.md).
      — **Updated 2026-08-07:** the endpoint now returns the parent's post-write
      state (`{ parentId, version, childrenInDrafts, childrenInRecords }`), so the
      stale-parent-version problem this epic worked around is solved at the source.
      `services/upload` collects them into `ItemUploadResult.parentStates`.
      — **Closed 2026-08-08:** they are now *applied* too, by
      `services/upload.applyParentStates`, called from `uploadItem` right after
      `connectParents`. This was previously parked for the deferred upload store on
      the grounds that mapping a `parentId` back to a local item needs the item
      list; it does not need a store — a `listItems` dep (`services/indexing.listIndex`)
      is enough, and leaving it parked meant a connected parent's next ordinary
      `PATCH` would `409`. Guarded by `domain/sync.resolveVersion`, so a version
      never moves backwards when several children in one batch connect under the
      same parent. A parent that is not tracked locally is skipped; a failure to
      write a parent's mirror is logged and never fails the upload.
- [x] **Write-through**: after success, write `<name>.json` into the folder and
      record id + upload state in the **SQLite index**; reflect in Overview.
- [x] Send **only current-schema-valid fields**; metadata edits go via
      `PATCH /api/items/:id` sending **only changed keys** (backend
      shallow-merges).
- [x] **Move folder to `/processed`** on successful upload (updates SQLite;
      hands to [overview](02-overview-and-index.md)).
- [x] **Batch upload** (per-item branch): publish every ready item as one job with
      progress + per-item results — **new** items via `POST /api/items` (create),
      **Needs-re-upload** items via the replace endpoint (stable id, stay in
      `/processed`). On success the batch is archived **READ-ONLY**, its items are
      released, and it shows the published confirmation.
- [x] **Re-upload after re-processing**: when an item is flagged **Needs
      re-upload** (new PDF/OCR), call the backend **replace** endpoint
      (`nbcg/todo/backend-archive-replace-file.md`) to swap the web PDF + full
      text in place (stable attachment id), keep the item in `/processed`, and
      clear the flag. If **only the OCR text** changed (not the PDF), use
      `PUT /api/files/:fileId/text` to (re)set the text without re-uploading the
      blob. Metadata-only changes go via `PATCH`, not re-upload.
- [x] **Resilience**: queue/retry uploads when offline or on transient errors;
      never double-create (reuse the deterministic/known id, or check existing).
      Respect **read-after-write lag** — trust the write response and update the
      local mirror from it; if you must re-read, use `GET /api/search/:id` and
      expect CDC lag (never assume an immediate read reflects the write).
- [x] Surface backend **validation errors** back onto the relevant fields.

## Progress — logic lane (`.ts`) pass, 2026-08-06

The Upload **backend connection + functionality** (Jernej's `.ts` lane) is built.
Typechecks (`vue-tsc`) + builds (`vite build`) clean; 58 new unit tests at the
time (the suite total lives in
[PROJECT-KNOWLEDGE §5](../PROJECT-KNOWLEDGE.md)); adversarially reviewed. The checkboxes above reflect the
logic-lane work — the GUI rendering + native impls each bullet also needs are the
handoffs below. This pass was **scoped to backend/functionality**, so the Pinia
run store + the composable + the tab `.vue` are intentionally deferred (see
"Still owed" / "Owed by GUI").

**What was built (logic lane `.ts`):**

- `domain/upload.ts` (new, fully unit-tested) — the pure upload **policy**:
  `uploadBlockers` (Ready + preflight: PDF/Thumbnail stage `done`|`skipped`, a
  failed stage → `processing-failed`, the **multi-image hard thumbnail gate**,
  `metadata-invalid`), `uploadWarnings` + `textQualityWarnings` (empty / GARBAGE /
  NO_TEXT OCR → **soft** warnings, never blocking), `uploadGroups` (the upload-set
  → the **≤2 role requests**: the resolved primary is the sole `THUMBNAIL`, every
  other web PDF/image is `WEB`; TIFFs/archival/`.txt`/`.json` never upload),
  `textPairs` (web PDF ↔ `<base>.txt` for `extractedTexts`), `uploadMode`
  (create vs replace by `backendId`), `changedMetadata`/`changedMetadataKeys`
  (PATCH sends only changed keys; never emits a prev-only key — the backend
  cannot unset), `mapValidationErrors` (Nest `400` → per-field), and
  `planItemUpload` (the assembled, I/O-free plan the service executes).
- `services/api/items.ts` (new, tested) — `createItem`, `updateItem` (PATCH;
  `expectedVersion` required; `undefined` on the no-op empty body),
  `transitionItems`, `deleteItems`, `getItemStats`.
- `services/api/files.ts` (new, tested) — multipart `uploadFiles` (field
  **`files`**, one batch-wide `role`, `doOCR`, `extractedTexts` JSON),
  `replaceFile` (field **`file`**, singular `extractedText`), `setFileText`,
  `reextractFile`, `listFiles`, `deleteFile`. Takes web `Blob`s, **not** disk
  paths — reading bytes is the orchestrator's job (keeps this a pure HTTP concern).
- `services/upload.ts` (new, tested; **store-free + fully injectable** via
  `UploadDeps`) — `uploadItem` end-to-end (**preflight → create | replace →
  assets → connect parents → write-through → move to `/processed`**) and the
  `uploadBatch` sequential driver (per-item results + `onProgress` feed).
  Backend failures fold into a discriminated result the UI renders —
  `blocked` / `forbidden` (403, "token lacks write access") / `duplicate`
  (create-409) / `error` (validation/concurrency) / `uploaded`. **Never
  double-creates**: the connection is written through **immediately after create,
  before assets**, so a mid-flight failure (or crash) leaves a recoverable link
  and a retry REPLACEs; and a create-409 (a deterministic COBISS id already
  exists) **reuses** the existing id (resolved via the COBISS preview) and links
  it rather than reporting a dead end. **Retries transient** (network/timeout/5xx)
  only; **trusts the write response** for the mirror (no CDC-lagged read-back);
  `extractedTexts` is scoped to the group that holds the PDFs; `doOCR` is always
  `false`. A replace with a missing local `version` refuses to write an
  unconfirmed mirror and asks for a re-sync instead.
- `services/api/index.ts` — barrel now exports `items` + `files`.
- `ipc/bindings.ts` — **two new contract commands for Arch** (+ the
  `UploadRecordDto`): `fs_read_file(path) → ArrayBuffer` (file bytes for the
  multipart, since backend HTTP stays in TS per docs/04) and
  `index_record_upload(itemId, UploadRecordDto) → IndexedItemDto` (persist the
  upload facts on the SQLite row). `fs_move_to_processed` already existed.
- Relations `connect` shape (`{ parentId, childIds[] }`, one call per parent) is
  the already-verified [Epic 09](09-backend-api-contract.md) contract — used via
  the existing `services/api/relations.connectParent`.

**Still owed by the logic lane (`.ts`) — deferred with the frontend** (mirrors how
Epics 04/06 deferred their composables/stores):

- `stores/useUpload.ts` — the reactive run store wrapping `uploadBatch`: holds
  per-item results + the live progress feed, and on `allUploaded` calls
  `useBatches.archive(batchId)` (→ batch READ-ONLY + items released) then
  `useItems.refresh()`. (Epic 06 built its `useProcessing` store in-lane; this was
  held back only because this pass was scoped to backend/functionality —
  `services/upload` is designed to be its thin target.) **Note:** parent-version
  adoption is *no longer* part of this store's job — it moved into
  `services/upload.applyParentStates` on 2026-08-08.
- `composables/useUpload.ts` — the Seam-1 view-model the Upload tab binds.
- The **per-item context resolver** (`resolveContext` passed to `uploadBatch`):
  reads `resolveItemPublish/Visibility` (batch), the batch `parents` ids, the
  working metadata values + `metadataReady` (from the Epic 04 metadata
  working-model store — itself deferred), and the operator's `primaryThumbnail`.

**Owed by Arch (`.rs` / `.py`):**

> **Done, 2026-08-12** (verified against the code 2026-08-21 — this list said
> they were owed long after they had shipped): `fs_read_file`,
> `index_record_upload` and `fs_move_to_processed` are all implemented and
> registered in `src-tauri/src/lib.rs`'s `invoke_handler!`. `fs_read_file`
> returns raw bytes via `tauri::ipc::Response`, as specified.

- ~~**Re-upload granularity**~~ — **done, 2026-09-01.** Deliberately
  **item-level/per-stage**, not true per-file: `core::jobs::ItemOutcome`
  splits into `content_changed` (a `pdf`/`thumbnail` stage produced new
  bytes) and `text_changed` (only `ocr` did), and `reupload_kind_for` maps
  that to `db::items::ReuploadKind::Full`/`TextOnly` — content always wins as
  `Full`, even alongside a text change in the same pass. Persisted as a new
  `items.reupload_text_only` column (`mark_needs_reupload`'s SQL never
  downgrades an already-pending `Full` back to `TextOnly`), surfaced as
  `IndexedItemDto.reuploadTextOnly`. `services/upload.pushReplaceAssets`
  consumes it: `kind === "text-only"` pushes just the paired OCR text via
  `setFileText` (no blob PUT) instead of `replaceFile`. True per-file
  granularity (independent per-base tracking within a `multiple-pdfs` item)
  was considered and deliberately deferred — it would require
  `item_assets`'s scan-time delete-and-reinsert (`reconcile`) to start
  preserving a per-row flag across an ordinary rescan, a materially bigger
  change for uncertain benefit at today's scale. Found and fixed along the
  way: `run_multiple_pdfs`'s `Pdf` arm only ever *verifies* the operator's
  PDFs for that shape (never writes anything), so it no longer counts as
  "content changed" — a plain re-verify used to spuriously flag `reupload`
  on a `multiple-pdfs` item even when nothing on disk changed.
- Ensure the `@tauri-apps/plugin-http` capability allow-lists the backend host
  (from Epic 01) — the multipart upload uses it.

**Owed by GUI (`.vue` / `.css`):** the Processing & Upload tab's **Upload half** —
the upload summary (per-item target/visibility incl. overrides; the
include/exclude upload-set list + primary-thumbnail marker; full-text + metadata
preview), gate/blocker + soft-warning surfacing (routing an unresolved thumbnail
to the Epic 04 picker), the batch **Upload** action + live progress + per-item
result rows, the published confirmation, and binding backend validation errors
onto the relevant fields. Binds `composables/useUpload` only.

**Not yet built (future, noted):** a **persistent** offline upload queue.
`uploadBatch` retries transient failures within a run and reports per-item
outcomes, but does not persist a queue across app restarts (docs/tasks/07
§Resilience) — add only if offline uploads prove common in practice.

## Fixed by self-audit, 2026-08-07

Three silent-failure bugs in this epic's gating and asset push, all found by
probing edge cases rather than by a failing test:

- **An empty folder was publishable.** No assets ⇒ every stage N/A ⇒ recorded
  `skipped` ⇒ counted as satisfied, and `needsThumbnailChoice([])` is false — so
  `uploadBlockers` returned `[]` and a titled empty folder would have created a
  **published record with no files**. Added the **`no-assets`** blocker (checked
  against `uploadGroups`, so a folder holding only never-uploaded files — TIFF
  sources, an archival master, OCR text — is caught too), and `planThumbnail` no
  longer reports an `empty` folder's thumbnail as resolved, so
  `processingComplete` is no longer true for it.
- **`UPLOAD_MAX_FILES = 10` was never enforced.** Every WEB asset went into one
  multipart request; an item with >10 images `400`s the whole upload.
  `domain/upload.uploadGroups` now chunks each role to `MAX_FILES_PER_REQUEST`,
  and a test asserts that constant stays equal to the `dto.ts` one (domain may not
  import services, so it is restated).
- **Duplicate page numbers doubled the PDF** — see
  [05-real-scan-data](../05-real-scan-data.md); the plan now warns.

## Audit pass, 2026-08-08 (live backend)

Re-verified this epic's assumptions against the **running** backend rather than
against the notes. Two silent-failure bugs found and fixed, both in the re-upload
path, both invisible to the existing tests because each produced a `201`.

### 1. Re-uploading Cyrillic material duplicated its files instead of replacing

`pushReplaceAssets` decided "replace this attachment" vs "upload a new one" by
matching the local filename against the stored one. But the backend stores a
non-ASCII multipart filename **corrupted**, so the stored name never equals the
local one — the lookup missed, the file took the "not on the backend" branch, and
every re-upload **added a duplicate attachment**.

Live-verified before the fix: uploading `ОКТОИХ петогласник 2.pdf` twice left
**two** attachments on the item. This hits precisely the material the library
catalogues, and it grows the item silently on every re-process.

Fixed with `domain/naming.isSameUploadedFilename` — matching now tolerates the
mangling, attachments are claimed at most once per run, and a corrupted stored
name raises the existing `filename-mangled` warning on the replace path too (it
previously only fired on first upload).

> **The mangling is not what the notes said.** They recorded it as lossy
> (`?????? ??????????? 2.pdf` — "characters destroyed"). Live it is **mojibake**:
> UTF-8 bytes read as Latin-1, which is losslessly **reversible**. Which shape
> occurs depends on the HTTP stack that built the multipart body, so
> `domain/naming` handles both — mojibake by decoding, the lossy form by a strict
> positional match. The unit tests **derive** the mangled string rather than
> pasting it, because the real value contains unprintable C1 bytes that a paste
> silently drops (a pasted copy came out 35 chars instead of 41 and the tests
> passed for the wrong reason).

### 2. A slow COBISS lookup was reported as "Backend unreachable"

`previewCobiss` used the client's **30 s** default timeout, while the backend's
own `ws.cobiss.net` fetch has `AbortSignal.timeout(30_000)`
(`cobiss-util/cobiss-fetch.ts`). Equal budgets, and the archive's clock starts
earlier — so on a slow-but-working COBISS the archive **always** aborted first and
surfaced a transport timeout as *"Backend unreachable — check your connection"*,
sending the operator hunting for a network fault that does not exist.

The requirement was written down in `dto.ts` and PROJECT-KNOWLEDGE §4 and never
implemented — the same "a rule stated only in a doc comment is not enforced"
shape as `UPLOAD_MAX_FILES`. Fixed by adding a per-request
`RequestOptions.timeoutMs` to `ApiClient` and a `COBISS_PREVIEW_TIMEOUT_MS`
(45 s) that outlasts the backend's budget. The test was checked to **fail**
without the fix.

### 3. A multi-PDF item could publish with an unresolved thumbnail

The hard thumbnail gate asked `domain/files.needsThumbnailChoice`, which counts
only images **already present in the folder**. A multi-PDF item has none — its
thumbnail candidates are the first-page images the pipeline has yet to *generate*
— so the candidate count was `0`, `needsThumbnailChoice` returned `false`, and the
gate never fired. The item published with whatever thumbnail resolution happened
to fall out, despite `domain/pipeline.planThumbnail` correctly reporting
`needsChoice: true` for exactly that case.

[Epic 06's own progress note](06-processing-pipeline-and-jobs.md) had warned this
epic about it in as many words — *"use the plan's `thumbnail.needsChoice` (not
`files.needsThumbnailChoice` alone) so the multi-PDF case is caught"* — and the
warning was not followed. `uploadBlockers` now goes through `planThumbnail`, and
`UploadGateInput` gained an optional `contentKind` so a caller that ran the item
with a book/graphical override can have the gate reason about the same input shape
the run did. Test confirmed to fail without the fix.

## Doc-vs-code review, 2026-08-08 (second pass)

Two more in this epic's upload path, both found by reading `dto.ts`'s own
warnings against the code that is supposed to obey them.

### 1. An empty OCR result triggered the exact Tika run the upload avoids

`dto.UploadFilesParts` says it in capitals: an **empty-string** `extractedTexts`
entry stores `NO_TEXT` *and still enqueues Tika* (the queue filter is a
truthiness test), which then overwrites it — "if OCR genuinely produced nothing,
upload without the key and call `PUT /api/files/:fileId/text` with `""`
afterwards."

`buildExtractedTexts` read every paired `.txt` straight into the map with no
emptiness check, and so did the fresh-upload branch of `pushReplaceAssets`. A
blank scan, or an OCR run that wrote `<base>.txt` and found nothing, produced
exactly the documented failure — on a `201`, for a file uploaded with
`doOCR: false` precisely to keep the backend out of it. `domain/upload.textPairs`
pairs on the text file *existing*, not on it having content, so nothing upstream
filtered it either.

Fixed with `splitEmptyTexts` (hold the empty entries back) + `settleEmptyTexts`
(state them afterwards by **file id**, where nothing is enqueued — paired
positionally, since the returned filename cannot be trusted). Three tests, one
confirmed to fail without the fix — it asserted the sent payload was `{}` and got
`{"gorski.pdf": ""}`.

**The shape, again:** the rule was written correctly in `dto.ts`, restated
correctly in PROJECT-KNOWLEDGE §4, and enforced nowhere. Same as
`UPLOAD_MAX_FILES`, same as the COBISS timeout.

### 2. `patchOnBackend` trusted a response shape its own neighbour distrusts

`connectParents`, twenty lines away, explicitly tolerates a pre-2026-08-07
backend answering with an empty body, and says why: *"the app is installed on a
workstation while the backend is deployed independently, so a newer app talking
to an older backend is a real scenario."* `patchOnBackend` then did
`return res.version` on the same class of response. Against that backend it
throws a `TypeError` — not an `ApiError`, so it escapes the outcome mapping and
reaches the operator as `Cannot read properties of undefined (reading 'version')`.

Now falls back to the prior version, which is what an old backend's no-op meant
anyway. Test confirmed to fail without the fix (with that exact `TypeError`).

### Still open — deliberately not built

- **`transitionItems` has no caller.** PROJECT-KNOWLEDGE §7 lists "filter the
  batch before any `transitionItems` call" as a follow-up, but nothing in the
  archive calls it: publish target is chosen at create, and a re-upload replaces.
  Building a filtering wrapper for zero call sites would be speculative, so the
  trap is documented at the call surface (`services/api/items.transitionItems`)
  instead. **Whoever adds the first call must filter to ids currently in the
  *other* collection** — one already-transitioned id `400`s the entire batch.

## Acceptance

- A ready batch uploads (record/draft + all selected web PDFs + images + OCR text
  + parent links, with the chosen targetState + visibility, roles tagged) and
  appears correctly on the website.
- Each folder's `metadata.json` + the SQLite index reflect the uploaded state and
  the connected id; the folder moves to `/processed`; the batch becomes
  READ-ONLY.
- Re-uploading a Needs-re-upload item replaces its files in place (stable id) and
  clears the flag; re-running an upload never creates duplicates.
