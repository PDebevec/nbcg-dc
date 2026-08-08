# Epic 04 — Metadata editor & schema

> Depends on: 01, 03, 09 · Blocks: 05, 06, 07
> Logic-lane (`.ts`) pass: **2026-08-04** — schema backend service + the pure
> schema→form/validation/pruning rules landed (see **Progress** below). The GUI
> (`.vue`) form + the metadata working-model store/composable are the remaining
> work.

Goal: the batch **Metadata tab** — a schema-driven, per-item form that always
matches the website's record type, with the item navigator, files strip, and
validation that gates a batch from advancing to processing. The prefill/
provenance automation that feeds it lives in
[COBISS, parents & provenance](05-cobiss-parents-and-provenance.md).

**Lane legend for the checklist:** each item notes its lane status —
`.ts` = Jernej (logic), `.vue` = GUI, `.rs`/`.py` = Arch. ✅ done · ◻ to do.

## Schemas (from the backend, main vs child)

Two schemas, chosen by item `level` (mirrors the prototype's `MAIN`/`CHILD`):

- **Main:** `title`\* · `author` · `year` · `language` (enum) · `place` ·
  `publisher` · `subject` (multi) · `physical` · `note`.
- **Child (serial issue):** `serialTitle`\* (parent) · `publisher` (parent) ·
  `place` (parent) · `language` (parent, enum) · `subject` (parent, multi) ·
  `volumeYear`\* (issue) · `issueNo`\* (issue) · `issueDate`\* (issue, date).

Field types: `text`, `enum`, `multi`, `date`. "parent" fields are
parent-inheritable; "issue" fields identify the specific issue. The language
enum currently offers: Montenegrin, Serbian, Church Slavonic, Italian, Russian.

## Tasks

- [x] Fetch and **cache the field schema** from the backend
      `GET /api/schema/record` including per field: key, label, type, required,
      enum options, and the **parent-inheritable / issue-identifying** flags. Use
      the cache offline.
      — **`.ts` ✅** `services/api/schema.ts` (`getRecordSchema` + `peekRecordSchema`
      + `clearRecordSchemaCache`): ETag conditional GET (`If-None-Match` → 304),
      24h `max-age` fast-path, per-`?level` cache in memory + `localStorage`, and
      an **offline fallback** to the cached copy. NB: the schema has **no field
      `label`** (labels live on enum-option codes only) — `domain/metadata-form`
      exposes `optionLabel()` + a `humanizeKey()` fallback for the field label.
      Backend already ships the endpoint (see PROJECT-KNOWLEDGE §4) — no backend
      task outstanding.
- [ ] **Dynamic form renderer**: build inputs from the schema — text, enum
      (`<select>`), multi (tag chips + add-on-Enter), date — with labels,
      required markers, two-column layout, and full-width for long/multi fields.
      — **`.ts` ✅ (model)** `buildFormModel()` / `fieldsForLevel()` in
      `domain/metadata-form.ts` give the level-filtered, group+order-sorted field
      model; `optionLabel()` resolves enum labels. **`.vue` ◻** GUI renders the
      inputs from that model (widget per `FieldDescriptor.type`/`itemType`).
- [ ] **Validation**: required fields non-empty (a multi field needs ≥1 tag);
      enum values constrained to allowed options; inline errors; the field
      border/flag reflects required-but-empty vs issue-still-to-fill.
      — **`.ts` ✅** `validateField()` / `validateItem()` / `isItemValid()`
      (required, enum + array-of-enum membership, array shape, numeric). **`.vue`
      ◻** GUI renders inline errors from the returned `FieldError[]` (`code`
      distinguishes required vs. type); the required-vs-issue flag uses
      `FieldDescriptor.issueIdentifying`.
- [ ] **Item navigator**: dropdown + progress ("Item 2 of 5 · 3/5 ready"),
      per-item status (**ready / incomplete / untouched**), a **Main/Child level
      pill**, Previous/Next, and a per-batch ready progress bar. `Next` validates
      the current item; the last item's `Next` becomes **Go to processing**.
      — **`.ts` ✅ (rules)** `itemReadiness()`, `readyProgress()`. **◻ (logic —
      next)** the composable/store that holds the item list + current index and
      exposes these to the navigator. **`.vue` ◻** dropdown, pill, bar, Prev/Next.
- [ ] **Validation gating**: block `Next` / `Go to processing` until required
      fields are filled; on a blocked "go to processing", jump to the first
      incomplete item and report how many remain.
      — **`.ts` ✅ (rules)** `firstIncompleteIndex()`, `canAdvance()`. **◻ (logic
      — next)** wire into the batch-work store's advance action; **`.vue` ◻**
      button state + "N remaining" toast.
- [ ] **Files strip**: the item's assets with live state — source TIFFs (local),
      `<name>_archive.pdf`, the **web PDF(s)**, the **image(s)**, `<name>.txt`,
      `<name>.json` — reflecting stage status and names (folder-derived for
      single-item outputs; discovered extra PDFs/images keep their own names —
      see [naming](10-settings-and-naming.md)). The set is **variable** (a folder
      may hold several PDFs/images), and each web PDF/image shows whether it will
      be uploaded.
      — **`.ts` ✅ (classification)** `domain/files.ts` already classifies assets
      (`classifyAsset`, `webPdfAssets`, `uploadRoleFor` → "will be uploaded").
      **`.rs`/`.py` ◻** native `core/fs` discovers the file list + live stage
      status (Epic 02/06). **`.vue` ◻** the strip UI.
- [ ] **Thumbnail picker** (multiple candidates): when an item has **two or more
      image candidates** (standalone images and/or per-PDF first-page images),
      show a picker in/near the files strip — a grid of the candidates, click to
      choose the primary/thumbnail, chosen one highlighted — and mark the item as
      **needing a choice** until one is set. One candidate (or an image named
      `thumbnail`) auto-selects with no prompt. Feeds the Thumbnail stage
      ([Epic 06](06-processing-pipeline-and-jobs.md)) and the upload gate
      ([Epic 07](07-upload-and-publish.md)).
      — **`.ts` ✅ (rule)** `thumbnailCandidates()`, `autoThumbnail()`,
      `needsThumbnailChoice()` in `domain/files.ts`. **◻ (logic — next)** persist
      the operator's pick on the item; **`.vue` ◻** the grid picker UI.
- [x] **Provenance display**: render each field's provenance tag, mapping the
      stored provenance value to its label (`cobiss` → **COBISS**, `parent` →
      **From parent**, `user` → **Edited**), and the per-field source picker
      affordance; the values behind them are set by Epic 05.
      — **`.ts` ✅** `PROVENANCE_LABELS` in `domain/metadata.ts`. **`.vue` ◻** the
      tag + source-picker affordance; **the provenance *values* are Epic 05.**
- [ ] Bind the form to the item's metadata **per item, by upload state**: a
      not-yet-uploaded item (no `backendId`) loads from the local `metadata.json` /
      SQLite (the working source of truth until first upload — a failed run loses
      nothing); an uploaded item treats the backend as source (local mirror,
      background-refreshed). Edits **autosave** locally as the user types;
      write-through happens on upload (create) or, for uploaded items, via `PATCH`
      (see [upload](07-upload-and-publish.md)).
      — **`.ts` ✅ (adapters)** `flattenValues()` / `toMetadataValues()` bridge the
      wire `RecordMetadata` ↔ the provenance-tagged editor map. **◻ (logic —
      next)** the metadata working-model store: load-by-upload-state (uses
      `services/indexing.readItemMetadata`), autosave (`writeItemMetadata`), and
      the `PATCH` path (Epic 07). **`.rs` ◻** `fs.read/writeMetadata` + SQLite.
- [ ] **Per-item Publish target + Visibility**: Draft/Record + Public/Private/Hidden
      controls per item, defaulting to the batch (Setup) values and overridable
      here — this is where a **single-item batch** (which skips Setup) sets them.
      Feeds [upload](07-upload-and-publish.md).
      — **`.ts` ✅ (vocab)** `ItemType`/`PublishTarget` + `VisibilityStatus` in
      `domain/enums.ts`. **◻ (logic — next)** per-item override state in the store.
      **`.vue` ◻** the two controls.
- [ ] **Read-only mode + Edit gate**: an uploaded batch's form is disabled
      (inputs greyed, no source pickers) — READ-ONLY — until the operator presses
      **Edit / re-process**, which unlocks editing and marks the item **Needs
      re-upload**. Metadata edits on an uploaded item write through via `PATCH`
      (not a file re-upload).
      — **`.ts` ✅ (shell)** `useBatch` already exposes `readOnly` + `unlock()`
      (Epic 03); the `reupload` flag lives on `Item.flags`. **◻ (logic — next)**
      the metadata `PATCH` write-through on edit. **`.vue` ◻** disabled-input
      styling driven by `readOnly`.
- [x] **Schema-evolution robustness**: on upload validate against the current
      schema and send **only currently-valid fields**; drop stale/unknown fields
      rather than erroring.
      — **`.ts` ✅** `pruneToSchema()` (drops unknown keys + empties) +
      `validateItem()`. Called by the upload service in
      [Epic 07](07-upload-and-publish.md).

## Progress — logic lane (`.ts`) pass, 2026-08-04

**Shipped (typechecks + builds clean; `vitest` green — schema service + form
rules covered):**

- `services/api/schema.ts` — the schema **backend service**: `getRecordSchema(level?)`
  with ETag conditional revalidation, a 24h `max-age` fast-path, per-level
  in-memory + `localStorage` cache, and an **offline fallback**; plus
  `peekRecordSchema()` (cache-only, for instant first paint) and
  `clearRecordSchemaCache()` (tests).
  - **Epic 10 added** `refreshRecordSchema()` — what the Settings "Refresh
    metadata schema" button calls. It **revalidates** both levels instead of
    clearing the cache first, so a failed refresh leaves the previous schema in
    place rather than leaving the editor with no field definitions, and it reports
    `stale` separately from `ok` (a read degrades to cache when offline, which
    would otherwise make a refresh that did nothing look successful). Also added
    `recordSchemaCacheInfo()` for the Settings cache display.
  - **Guard added:** a `200` with `fields: []` no longer replaces a non-empty
    cached schema. The endpoint does not validate `?level` — verified, an unknown
    level returns `200 { fields: [] }` — so an empty schema was cacheable and
    would have emptied this form for the full 24h max-age, offline copy included.
- `services/api/client.ts` — added `requestDetailed()` / `getDetailed()` returning
  `{ status, data, headers, etag }` and honouring `acceptStatuses` (so `304` is a
  cache-hit, not an error). `request()` behaviour is unchanged (shared `send()`).
- `domain/metadata-form.ts` (new) — the pure schema→form rules: `buildFormModel`,
  `fieldsForLevel`, `validateField`/`validateItem`/`isItemValid`, `itemReadiness`
  + `firstIncompleteIndex`/`readyProgress`/`canAdvance`, `pruneToSchema`,
  `flattenValues`/`toMetadataValues`, and `optionLabel`/`humanizeKey`.
- `domain/files.ts` — `autoThumbnail()` + `needsThumbnailChoice()` (the picker's
  auto-select rule).
- `domain/metadata.ts` — `PROVENANCE_LABELS`.
- Tests: `domain/metadata-form.test.ts`, `services/api/schema.test.ts`, and
  thumbnail cases added to `domain/files.test.ts`.

**Still owed by the logic lane (`.ts`) — next pass, GUI/store-shaped so deferred
with the frontend:** the **metadata working-model store + `useMetadataForm`
composable** — holds the item list + current index, loads values by upload state
(local `metadata.json`/SQLite vs. backend mirror via `services/indexing`),
autosaves edits, exposes the model/validation/readiness above to the view, and
does the `PATCH` write-through for uploaded items (with Epic 07). All the pure
pieces it needs now exist.

**Owed by GUI (`.vue`/`.css`):** the Metadata tab itself — dynamic form widgets
per field type, the item navigator (dropdown / Main·Child pill / ready bar /
Prev·Next / Go-to-processing), inline validation errors, the files strip, the
thumbnail grid picker, provenance tags + per-field source picker, the Publish
target + Visibility controls, and read-only styling driven by `useBatch.readOnly`.

**Owed by Arch (`.rs`/`.py`):** nothing new for the schema/form — the schema
endpoint exists on the backend. The files strip's live file list + per-stage
status come from `core/fs` + SQLite (Epic 02/06); metadata read/write goes
through the existing `ipc.fs.read/writeMetadata` commands (Epic 02/07).

## Acceptance

- The form is generated entirely from the backend schema (no hard-coded fields),
  and switches between the main and child field sets by item level.
- Required/enum validation works; a batch cannot advance to processing until
  every item is ready, and the UI jumps to the first incomplete item.
- The navigator's per-item status and the ready progress bar are correct.
- The files strip shows the item's assets — a variable set (TIFFs, PDF(s),
  image(s), text, metadata) — with live stage status.
