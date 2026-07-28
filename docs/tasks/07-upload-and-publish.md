# Epic 07 — Upload & publish

> Depends on: 02, 03, 04, 05, 06, 09 · Blocks: — (closes the loop)

Goal: the **Upload** half of the Processing & Upload tab — turn a processed,
described batch into records/drafts on the backend (single source of truth),
write-through to the local copies, move folders to `/processed`, and support
re-upload after re-processing.

## Tasks

- [ ] **Upload gating**: only available when the batch is **Ready** (all items
      processed, no failures). Pre-flight per item: required fields valid; PDF +
      downscale + thumbnail done. **OCR text is a soft warning** — if empty, warn
      ("not processed to the end — confirm you don't need full text, or go
      extract it") but allow continue.
- [ ] **Write-gating**: disable/block upload when the verified identity lacks
      **write** access (the access level from Settings → Test connection, Epic 10,
      via `nbcg/todo/backend-archive-identity-verify.md`) — surface a clear
      message up front rather than failing mid-upload.
- [ ] **Thumbnail gate**: block upload until every **multi-image** item has a
      chosen thumbnail source (single-image / PDF-first-page items resolve
      automatically — Epic 06). If unresolved, surface the picker (Epic 04) and
      don't allow publish — a **hard gate**, not a soft warning.
- [ ] **Upload summary** (in the tab): each item's **publish target** (Draft /
      Record) and **visibility** (Public / Private / Hidden) — batch defaults with
      any per-item overrides shown — and the **upload
      set** per item — every discovered **web PDF** and **image** shown as an
      include/exclude option (all included by default), which image is the
      **primary/thumbnail**, plus the full text (via `extractedTexts`) and
      metadata. Source TIFFs + archival master stay local.
- [ ] **Create**: `POST /api/items` with each item's own `targetState: DRAFT|RECORD`
      and `visibilityStatus: PUBLIC|PRIVATE|HIDDEN` (the batch default unless the
      item overrides; already supported by the backend) → capture the returned **id**. COBISS items have deterministic
      ids — detect "already exists".
- [ ] **Upload assets**: `POST /api/files/upload/:id` (multipart) with **all
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
- [ ] **Text quality**: the backend classifies supplied text (EXTRACTED /
      GARBAGE / NO_TEXT, via `looksGarbled`); treat a GARBAGE / empty result the
      same as the empty-OCR **soft warning** above.
- [ ] **Link parents**: `POST /api/relations/connect { parentId, childIds }` —
      **one call per linked parent** (`childIds: [itemId]`), since an item may sit
      under several parents (many-to-many). Confirm the shape in
      [Epic 09](09-backend-api-contract.md).
- [ ] **Write-through**: after success, write `<name>.json` into the folder and
      record id + upload state in the **SQLite index**; reflect in Overview.
- [ ] Send **only current-schema-valid fields**; metadata edits go via
      `PATCH /api/items/:id` sending **only changed keys** (backend
      shallow-merges).
- [ ] **Move folder to `/processed`** on successful upload (updates SQLite;
      hands to [overview](02-overview-and-index.md)).
- [ ] **Batch upload** (per-item branch): publish every ready item as one job with
      progress + per-item results — **new** items via `POST /api/items` (create),
      **Needs-re-upload** items via the replace endpoint (stable id, stay in
      `/processed`). On success the batch is archived **READ-ONLY**, its items are
      released, and it shows the published confirmation.
- [ ] **Re-upload after re-processing**: when an item is flagged **Needs
      re-upload** (new PDF/OCR), call the backend **replace** endpoint
      (`nbcg/todo/backend-archive-replace-file.md`) to swap the web PDF + full
      text in place (stable attachment id), keep the item in `/processed`, and
      clear the flag. If **only the OCR text** changed (not the PDF), use
      `PUT /api/files/:fileId/text` to (re)set the text without re-uploading the
      blob. Metadata-only changes go via `PATCH`, not re-upload.
- [ ] **Resilience**: queue/retry uploads when offline or on transient errors;
      never double-create (reuse the deterministic/known id, or check existing).
      Respect **read-after-write lag** — trust the write response and update the
      local mirror from it; if you must re-read, use `GET /api/search/:id` and
      expect CDC lag (never assume an immediate read reflects the write).
- [ ] Surface backend **validation errors** back onto the relevant fields.

## Acceptance

- A ready batch uploads (record/draft + all selected web PDFs + images + OCR text
  + parent links, with the chosen targetState + visibility, roles tagged) and
  appears correctly on the website.
- Each folder's `metadata.json` + the SQLite index reflect the uploaded state and
  the connected id; the folder moves to `/processed`; the batch becomes
  READ-ONLY.
- Re-uploading a Needs-re-upload item replaces its files in place (stable id) and
  clears the flag; re-running an upload never creates duplicates.
