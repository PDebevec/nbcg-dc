# Epic 04 — Metadata editor & schema

> Depends on: 01, 03, 09 · Blocks: 05, 06, 07

Goal: the batch **Metadata tab** — a schema-driven, per-item form that always
matches the website's record type, with the item navigator, files strip, and
validation that gates a batch from advancing to processing. The prefill/
provenance automation that feeds it lives in
[COBISS, parents & provenance](05-cobiss-parents-and-provenance.md).

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

- [ ] Fetch and **cache the field schema** from the backend
      `GET /api/schema/record` (backend task:
      `nbcg/todo/backend-archive-metadata-schema-endpoint.md`), including per
      field: key, label, type, required, enum options, and the
      **parent-inheritable / issue-identifying** flags. Use the cache offline.
- [ ] **Dynamic form renderer**: build inputs from the schema — text, enum
      (`<select>`), multi (tag chips + add-on-Enter), date — with labels,
      required markers, two-column layout, and full-width for long/multi fields.
- [ ] **Validation**: required fields non-empty (a multi field needs ≥1 tag);
      enum values constrained to allowed options; inline errors; the field
      border/flag reflects required-but-empty vs issue-still-to-fill.
- [ ] **Item navigator**: dropdown + progress ("Item 2 of 5 · 3/5 ready"),
      per-item status (**ready / incomplete / untouched**), a **Main/Child level
      pill**, Previous/Next, and a per-batch ready progress bar. `Next` validates
      the current item; the last item's `Next` becomes **Go to processing**.
- [ ] **Validation gating**: block `Next` / `Go to processing` until required
      fields are filled; on a blocked "go to processing", jump to the first
      incomplete item and report how many remain.
- [ ] **Files strip**: the item's assets with live state — source TIFFs (local),
      `<name>_archive.pdf`, the **web PDF(s)**, the **image(s)**, `<name>.txt`,
      `<name>.json` — reflecting stage status and names (folder-derived for
      single-item outputs; discovered extra PDFs/images keep their own names —
      see [naming](10-settings-and-naming.md)). The set is **variable** (a folder
      may hold several PDFs/images), and each web PDF/image shows whether it will
      be uploaded.
- [ ] **Thumbnail picker** (multiple candidates): when an item has **two or more
      image candidates** (standalone images and/or per-PDF first-page images),
      show a picker in/near the files strip — a grid of the candidates, click to
      choose the primary/thumbnail, chosen one highlighted — and mark the item as
      **needing a choice** until one is set. One candidate (or an image named
      `thumbnail`) auto-selects with no prompt. Feeds the Thumbnail stage
      ([Epic 06](06-processing-pipeline-and-jobs.md)) and the upload gate
      ([Epic 07](07-upload-and-publish.md)).
- [ ] **Provenance display**: render each field's provenance tag, mapping the
      stored provenance value to its label (`cobiss` → **COBISS**, `parent` →
      **From parent**, `user` → **Edited**), and the per-field source picker
      affordance; the values behind them are set by Epic 05.
- [ ] Bind the form to the item's metadata **per item, by upload state**: a
      not-yet-uploaded item (no `backendId`) loads from the local `metadata.json` /
      SQLite (the working source of truth until first upload — a failed run loses
      nothing); an uploaded item treats the backend as source (local mirror,
      background-refreshed). Edits **autosave** locally as the user types;
      write-through happens on upload (create) or, for uploaded items, via `PATCH`
      (see [upload](07-upload-and-publish.md)).
- [ ] **Per-item Publish target + Visibility**: Draft/Record + Public/Private/Hidden
      controls per item, defaulting to the batch (Setup) values and overridable
      here — this is where a **single-item batch** (which skips Setup) sets them.
      Feeds [upload](07-upload-and-publish.md).
- [ ] **Read-only mode + Edit gate**: an uploaded batch's form is disabled
      (inputs greyed, no source pickers) — READ-ONLY — until the operator presses
      **Edit / re-process**, which unlocks editing and marks the item **Needs
      re-upload**. Metadata edits on an uploaded item write through via `PATCH`
      (not a file re-upload).
- [ ] **Schema-evolution robustness**: on upload validate against the current
      schema and send **only currently-valid fields**; drop stale/unknown fields
      rather than erroring.

## Acceptance

- The form is generated entirely from the backend schema (no hard-coded fields),
  and switches between the main and child field sets by item level.
- Required/enum validation works; a batch cannot advance to processing until
  every item is ready, and the UI jumps to the first incomplete item.
- The navigator's per-item status and the ready progress bar are correct.
- The files strip shows the item's assets — a variable set (TIFFs, PDF(s),
  image(s), text, metadata) — with live stage status.
