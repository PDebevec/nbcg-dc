# NBCG-DC — Decisions & Open Questions

> Status: mostly resolved
> Last updated: 2026-07-20

## Resolved decisions

- **Connection model** — The `nbcg` backend is the **single source of truth**;
  the archive is a **thick client** + downstream local storage. We never read
  authoritative data from the archive; writes are write-through (backend first,
  then rewrite the local copy); links are by immutable id. See
  [architecture](02-architecture.md).

- **Folder → record cardinality** — **One folder = one record/item.** A serial
  with 15 issues is **15 sibling folders**, each its own record, each linked to
  the parent serial record via `relations/connect`.

- **Local storage** — A **SQLite index** (app-managed) tracks folders,
  processing state, the connected backend id, and upload state; each folder also
  holds a **`metadata.json` mirror** so it is self-describing. (This replaces
  the earlier "manifest sidecar" idea and resolves the manifest-location
  question.)

- **Sync direction/scope** — One-way **backend → archive**, and **refresh local
  only**: sync updates copies for records the archive already tracks; it does
  not create folders for web-only records (those remain browsable via search).

- **OCR location** — **On the archive** (PaddleOCR). Upload the downscaled web
  PDF with `doOCR=false` (backend skips Tika) and **push the OCR text** to the
  backend. **Implemented**: the archive sends the text in an `extractedTexts`
  JSON map (PDF filename → text) alongside the upload, and the backend stores it
  on the matching file and classifies it (EXTRACTED / GARBAGE / NO_TEXT). See
  `nbcg/todo/backend-archive-external-fulltext-ingest.md`; `PUT /files/:fileId/text`
  resets it after the fact.

- **Upload gating** — Enforce the deterministic pipeline (TIFF→PDF, downscale,
  OCR are always produced), but treat **text as a soft warning**: if the
  extracted text is empty, warn the user — "confirm you don't need full text
  (`fullText = ""`), or go and extract it" — and let them proceed.

- **Draft vs. published** — A user-selected parameter at upload
  (`targetState` / `transition`), not a hard rule.

- **Multiple parents** — True many-to-many graph; cycles allowed. Backend
  models this in `item_relations` (no cycle guard — intended).

- **Parent-metadata copy** — Client-side in the archive, fully editable; flags
  the required per-issue fields (issue no. + date).

- **Schema-driven form** — Core approach. Backend will expose field defs
  (`nbcg/todo/backend-archive-metadata-schema-endpoint.md`); on upload send only
  current-schema fields.

- **Auth mechanism** — For now, a **static API token issued from Keycloak**,
  configured in the app and sent as the bearer token. (Per-user login can come
  later; the token just needs the right `nbcg-api` roles.)

- **Folder lifecycle / "reposition"** — Two folders: **`/unprocessed`** and
  **`/processed`**. New scans land in `/unprocessed`; the archive lists those
  folder names as needing tiff→pdf + OCR + metadata. Once an item is processed
  and described (recorded in SQLite), the archive **moves its folder to
  `/processed`**. That move *is* the "reposition"/DONE action. `/processed`
  means **processed *and* uploaded**; a re-processed item stays in `/processed`
  but is flagged **needs-re-upload** (below).

- **Re-run / idempotency (scoped by data type)** —
  - **Metadata** is never diffed locally *for uploaded items*: the editor
    **loads from the backend** (local is a background-refreshed mirror) and edits
    are **write-through** (`PATCH` the backend, then rewrite the folder
    `metadata.json`), so an uploaded item's metadata can't be locally stale. **A
    not-yet-uploaded item has no backend record**, so it loads from the local
    `metadata.json` / SQLite — the working source of truth until first upload
    (nothing is lost if a run fails).
  - **Derived files (PDF/OCR)**: if the user **adds or changes TIFFs**, the
    archive offers a **re-process** action that rebuilds the archival PDF, web
    PDF, and OCR (overwriting the old outputs, written atomically). This sets a
    **SQLite flag** ("derived outputs changed since last upload") and marks the
    item **"needs re-upload"** in the GUI. We flag on **new outputs made**, not
    on metadata.
  - **Re-upload** calls a backend endpoint that **replaces the PDF + fullText**
    in place (new backend task `nbcg/todo/backend-archive-replace-file.md`).
  - **New scan → always a new record / new id.** Exception: COBISS ids yield
    **deterministic** ids, so re-using one is detected as "already exists,"
    never duplicated.

- **App structure (v1.4.0 design)** — The app is organised around **batches**
  and a four-destination rail (Overview · Batches · Sync · Settings), per the
  [design prototype](../desktop-app-interface-design/project). This supersedes
  the earlier two-pane "folder tree + right editor" concept. See
  [concept & UX](01-concept-and-ux.md).

- **Batches are local-only** — A batch is client-side working state stored in
  the **SQLite index** (membership, stage, publish/visibility, per-item run
  outcome). Batches are **never** sent to the backend; only the final per-item
  uploads are. Crash recovery is local. (Resolves the spec's "where do batches
  live" open decision.)

- **Processing concurrency = one batch at a time, per workstation** — Enforced
  entirely in the app. The deployment is a single workstation, so **no backend
  single-flight lock** is needed. (Resolves the spec's "concurrency scope"
  decision.)

- **Naming is folder-derived** — The scanner produces one folder per item and
  **the folder name is the base name** for the derived outputs (`<name>.pdf`,
  `<name>_archive.pdf`, `<name>_thumb.png`, `<name>.txt`, `<name>.json`) — **for
  now**; multi-page items append an unpadded page number (`…_1.pdf`, `…_2.pdf`,
  …). We build on the assumption that **folder names are correct/unique at scan
  time**. *(2026-08-27: "unique" is now enforced per-relative-path, not just per
  bare name — `core::fs::item_id_for` hashes the path relative to the scan root,
  so two folders at different depths sharing a leaf name, e.g. `arh/BookA/1` and
  `arh/BookB/1`, no longer collide onto the same item id now that folders can
  nest to any depth; see
  [nested-record-folders-and-manual-selection](tasks/nested-record-folders-and-manual-selection.md).)*
  When a folder holds **several PDFs/images**, those discovered files
  keep their own filenames (used to match a PDF's text by base name). There is
  **no prefix/base-identifier picker** (the prototype's
  COBISS/Signature/Accession/Title picker is dropped) and **no backend naming
  step** — naming is local. (Resolves the spec's "who owns naming" decision.)

- **Item asset model (variable set)** — A folder is not fixed at one PDF + one
  image. It may contain **multiple web PDFs** (all uploaded, `role=WEB`; each
  PDF's OCR text matched by base name), **multiple images** (all uploaded; one
  primary `role=THUMBNAIL`, the rest `role=WEB`), **a PDF with no TIFFs** (skip
  the archival build), or **images with no PDF** (a map/graphical work). The
  pipeline adapts to what's in the folder; the operator picks the primary image
  when there's more than one candidate, and **upload is blocked** until they do.
  Roles use the backend's `FileRole { SOURCE, ARCHIVAL, WEB, THUMBNAIL }`
  (**implemented**). See [concept & UX](01-concept-and-ux.md),
  [processing](tasks/06-processing-pipeline-and-jobs.md),
  [upload](tasks/07-upload-and-publish.md).

- **Visibility** — A user-selected parameter at the batch level (Public /
  Private / Hidden). The backend **already** models this as
  `VisibilityStatus { PUBLIC, PRIVATE, HIDDEN }` on `Draft`/`Record`
  (required in `CreateItemDto`) — no backend change; the app just sends
  `visibilityStatus`.

- **No identity/verify endpoint — auth is a static token, verified on use.**
  The app is single-workstation, single-user (no login), so there is no caller
  to identify. The static Keycloak bearer token is authenticated by the backend
  at the point of use (a bad token fails the first real write with `401`/`403`).
  Settings → Test connection is therefore just a reachability ping
  (`GET /api/health`); it does **not** show email/access level. (The backend has
  no `/api/me` or `/api/auth/verify` route, and none is needed. Revisit only if
  per-user login is ever added — then an identity endpoint + display can follow.)

## Still open

1. **Target OS.** Confirm Windows-only (`ocr.py` needs a cross-platform fix).

2. **Exact field set.** Formalized by the backend schema endpoint; the shapes
   already exist in the backend (`EDITABLE_BASE_METADATA_SHAPE`,
   `DOMAIN_RECORD_SHAPE`).

3. **Expected volumes & file sizes.** Pages/issue, MB/TIFF, items/batch — to set
   OCR/PDF concurrency and memory limits.

4. **Python invocation strategy** (sidecar / system / native). Blocks Epic 06
   (⛔) and Epic 11 packaging; parked as "Decided later" in
   [overview](00-project-overview.md) but was missing from this register.
