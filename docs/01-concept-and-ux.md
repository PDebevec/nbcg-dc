# NBCG-DC — Concept & UX

> Status: planning — aligned to the **v1.4.0 prototype**
> Last updated: 2026-07-23

## Purpose

A fast, low-friction desktop tool for NBCG staff to take folders of scans,
process them, attach correct metadata, and upload the results to the library
website as **records / drafts**. The design goal above all else is **minimum
clicks, maximum automation**.

The app is the operator's cockpit around a fixed pipeline: watched scan folders
arrive → the operator groups them into **batches** → fills/enriches metadata
(helped by COBISS and parent records) → runs the conversion pipeline → uploads
→ a periodic sync keeps the local archive's metadata in step with the backend.

> This document supersedes the earlier "two-pane folder tree + right editor"
> concept. The app is now organised around **batches** and a four-destination
> navigation, exactly as in the
> [v1.4.0 design prototype](../desktop-app-interface-design/project/NBCG%20Archive.dc.html)
> and its [functional spec](../desktop-app-interface-design-requirements.md).

## App structure

A persistent **left rail** with four destinations plus a live connection
footer; the main area swaps between five screens.

```
┌───────────────┬───────────────────────────────────────────────┐
│  NBCG Archive │   OVERVIEW · BATCHES · BATCH-WORK · SYNC · …    │
│               │                                                 │
│  ▸ Overview   │   (the arrivals table / batch cards / the 3-tab │
│  ▸ Batches  ③ │    batch workspace / sync / settings)           │
│  ▸ Sync       │                                                 │
│  ▸ Settings   │                                                 │
│               │                                                 │
│  ● Connected  │                                                 │
│  api.nbcg.me  │                                                 │
└───────────────┴───────────────────────────────────────────────┘
```

- **Overview** — the arrivals table and the entry point to batching.
- **Batches** — cards for every unfinished batch (rail badge = their count).
- **Sync** — pull catalogue metadata from the backend into the local archive.
- **Settings** — Configure (folders, backend, theme, schema) + Data (naming).
- **Connection footer** — backend host + **Connected / Offline**. This mirrors
  *backend reachability only*, a separate axis from any item state.

## The domain objects

Four object types drive the app (full field lists in
[architecture](02-architecture.md)):

- **Item** — one digitised document, backed by a single folder of source TIFFs.
  Carries `folder`, `level` (`main` / `child`), per-stage pipeline status,
  `backendId` (once uploaded), flags (`uploaded`, `reupload`), linked `parents`,
  and `meta` (the catalogue field values, each with provenance).
- **Batch** — a **local** working set of items processed together. Groups one
  item state at a time; only one batch runs the pipeline at a time.
- **Parent record** — a catalogue record an item is filed under (fetched from the
  backend collections list as `{ id, name, collectionType, … }`). A parent is
  **eligible to pass data** (its shared fields copy down) only when its
  `collectionType` is in the data-passing set (a serial-type; exact value(s) TBD
  and configurable — more types may pass data later); other types can be linked
  but never pass data.
- **Metadata field value** — every field stores `{ value, provenance, sourceParentId }`
  so the UI can label it and resolve conflicts (see
  [COBISS/parents/provenance](tasks/05-cobiss-parents-and-provenance.md)).

## Item state (derived, not stored)

An item's state is **computed** from its flags + stage statuses every render.
The SQLite index stores the underlying facts; the state name is re-derived.
Derivation order (first match wins):

| State | Condition | Meaning |
|-------|-----------|---------|
| **Uploaded** | `uploaded` set, or upload stage `done` | Published; source moved to `/processed`. |
| **In progress** | belongs to a batch that isn't uploaded | Locked to that batch; open the batch to work on it. |
| **Needs re-upload** | `reupload` set | Published but changed since; must be pushed again. |
| **Stopped** | any pipeline stage `failed` | Processing halted on an error; needs a rerun/fix. |
| **To process** | none of the above | Fresh scan waiting to be batched. |

## Batches & lifecycle

A batch is the central working unit. Rules:

- **One item type per batch.** A batch is created from a single state (e.g. all
  *To process*), because setup and processing apply uniformly.
- **Lifecycle:** `setup → metadata → processing → ready → uploaded`.
- **One batch processes at a time — per workstation.** Starting/rerunning while
  another batch runs is blocked with a message. (Enforced entirely in the app;
  the deployment is a single workstation, so no backend lock — see
  [decisions](03-open-questions.md).)
- **Single-item short-circuit.** Opening one *To process* item (via the row's
  **⋯ → Open as batch**, or selecting it and hitting **Create batch**) creates a
  one-item batch and drops straight into **Metadata** (no Setup step).
  Multi-item batches start at **Setup**.
- **Local-only.** Batches live in the SQLite index as operator-side working
  state — they are never sent to the backend; only the final per-item uploads
  are. Crash recovery is local.

### Batch work — three tabs

A batch header (number, status pill, "all changes saved", and — for an uploaded
batch — a **READ-ONLY** badge with an **Edit / re-process** unlock) sits above
three tabs. Setup runs once at creation; **Metadata and Processing & Upload stay
revisitable** — you can re-edit a field or re-run a stage on any item at any time
(subject to validation and the single-run lock). Availability by stage:

1. **Setup** (multi-item batches) — batch-wide defaults applied to all items,
   each still overridable later:
   - **Prefill from COBISS** — a batch COBISS ID that prefills every item.
   - **Parent records** — link one or more parents (by id); a parent is
     **eligible to pass data** only if its `collectionType` is in the data-passing
     set (serial-type; exact value TBD). Among eligible parents, exactly **one
     passes data** at a time (its shared fields copy down); ineligible types can be
     linked but never pass data.
   - **Publish as** — Draft / Record. **Visibility** — Public / Private / Hidden.
     (**Batch defaults** — each item can override both in its Metadata screen.)
   - *Next → Metadata* applies the data-passing parent's shared fields to empty
     item fields (provenance `parent`) and, if a batch COBISS ID is set, applies
     COBISS to all fields (provenance `cobiss`) — overriding the parent-copied
     values; at Setup no field is user-edited yet, so no overwrite prompt fires —
     then advances the batch.
2. **Metadata** (per item) — item navigator ("Item 2 of 5 · 3/5 ready", per-item
   ready/incomplete/untouched, Main/Child level pill), the files strip,
   per-item COBISS prefill (with an overwrite prompt), per-item parent linking,
   and the schema-driven form with provenance tags + a per-field source picker.
   Validation blocks *Next / Go to processing* until required fields are filled.
   Each item also carries its **own Publish target + Visibility** — defaulting to
   the batch (Setup) values, freely overridable per item (and the only place a
   single-item batch, which skips Setup, sets them).
3. **Processing & Upload** — a control strip whose primary action changes with
   stage (Start processing → live counts → Rerun all failed → Upload batch), a
   per-item live pipeline list with per-item Rerun, and an upload summary. After
   upload the batch is **READ-ONLY**.

### Re-opening & re-working items

A batch can be created from any selectable state, not just fresh scans — the items
arrive carrying whatever work was already done:

- **Metadata source is per item.** A not-yet-uploaded item (no `backendId`) loads
  its metadata from the local `metadata.json` / SQLite — the local copy is the
  working source of truth until first upload, so a failed run never loses data. An
  already-uploaded item treats the **backend as source** (local is a
  background-refreshed mirror).
- **Editing a published item is deliberate.** A batch of already-uploaded (Done)
  items opens **READ-ONLY**; an explicit **Edit / re-process** action unlocks it,
  and any change flips the item to **Needs re-upload**. The same applies to
  re-running a stage (TIFF→PDF, OCR, …) on a published item.
- **Metadata edit ≠ re-upload.** Changing metadata on an uploaded item is a
  write-through **`PATCH`** (not a re-upload); only **new derived files** (a re-run
  PDF/OCR) set Needs re-upload and use the replace endpoint. A metadata edit on a
  not-yet-uploaded item is just a local save.
- **Uploaded batches release their items.** Once a batch uploads it is archived
  READ-ONLY and its items become `Uploaded` (no longer locked to it), so they can
  be re-selected into a new re-work batch later.
- The **single-run lock** still holds: only one batch processes at a time per
  workstation, re-runs included.

## The processing pipeline (five stages, local)

For each item, five stages run in order — status `pending → running → done | failed`
(plus `queued` while a batch run is scheduled):

| Stage | Input → output | Notes |
|-------|----------------|-------|
| **PDF** | Source TIFFs → `<name>_archive.pdf` (archival) **and** `<name>.pdf` (web); or a supplied PDF when there are no TIFFs | Can yield multiple web PDFs. |
| **Thumbnail** | A folder image (or PDF first page) → `<name>_thumb.png` | One image → auto; **2+ images → the operator picks one** (see below). |
| **OCR** | Pages → `<name>.txt` | Runs locally (PaddleOCR); Cyrillic/Latin. |
| **Metadata** | Catalogue fields → `<name>.json` | Only `done` once required fields validate. |
| **Uploaded** | Web PDF(s) + image(s) + OCR text + metadata → backend | Publishes; assigns `backendId`; moves folder to `/processed`. |

- The pipeline runs **locally** on the workstation (Tauri invokes the Python
  scripts). The backend is involved only at **Uploaded**. See
  [architecture](02-architecture.md) and [decisions](03-open-questions.md).
- **Source TIFFs and the archival master stay local** — only the web PDF(s),
  image(s), OCR text and metadata are pushed.
- Rerun exists at two grains: a single failed item, or all failed items.

## Metadata & the four ingestion cases

Terminology: **Gradivo** (the item), **Glavno gradivo** (main record),
**Podgradivo** (child record, e.g. one serial issue), **COBISS ID** (identifier
in the shared bibliographic system).

The four cases still drive editor behaviour, now expressed through Setup +
Metadata:

| # | Level | COBISS ID? | Flow |
|---|-------|-----------|------|
| 1 | Main | No | Fill fields manually in the editor. |
| 2 | Main | Yes | Enter COBISS ID → "Get data" prefills; edit/override as needed. |
| 3 | Child | Yes | Same as case 2. |
| 4 | Child | No | Link a parent serial → its shared fields copy down → fill the per-issue fields (volume/year, issue number, date). |

- **COBISS and parents are both just prefillers** and are not mutually
  exclusive. Empty fields fill silently; a field the user already edited raises
  an **overwrite prompt** ("Overwrite all" vs "Keep mine, fill empties").
- **Provenance:** every field remembers whether its value came from `COBISS`, a
  `parent`, or the `user` — driving coloured tags, the per-field source picker,
  and the overwrite prompt.
- **Per-field source picker:** when two or more linked parents could supply the
  same field, a picker lets the cataloguer choose which parent, or **Manual
  entry**.
- Everything copied stays **fully editable** — the copy guarantees correctness
  and saves re-typing shared metadata.

The **schema is backend-driven**: field definitions come from the backend and
are refreshable in Settings; the form renders whatever the schema says (main vs
child level). See [metadata editor](tasks/04-metadata-editor-and-schema.md).

## Files per item

An item folder holds a **variable set of assets**. The typical case — produced
from TIFF scans — is:

- source TIFFs (kept **local**),
- `<name>_archive.pdf` — archival master (kept **local**),
- `<name>.pdf` — web PDF (**uploaded**),
- a first-page **image** → `<name>_thumb.png`, the thumbnail (**uploaded**),
- `<name>.txt` — OCR full text (**uploaded** — sent in the upload's
  `extractedTexts` map keyed by the PDF filename, not as a separate attachment),
- `<name>.json` — metadata mirror (**local**; written from the backend response
  on create/update/sync; may or may not embed the full text). The metadata
  *values* are sent in the upload request body, not this file — the `.json`
  itself is never uploaded.

**Uploaded set:** web PDF(s) + image(s) + full text (via `extractedTexts`) +
metadata. Source TIFFs and the archival master stay **local**.

### Asset variations

A folder isn't always one PDF + one image:

- **Multiple web PDFs** — we don't distinguish which is which: upload them all
  (each `role=WEB`) and match each one's full text by **shared base name**
  (`foo.pdf` ↔ `foo.txt` → `extractedTexts={"foo.pdf":…,"bar.pdf":…}`). All
  discovered PDFs show as upload options.
- **Multiple images** — upload them all; **one must be the primary/thumbnail**
  (`role=THUMBNAIL`), the rest `role=WEB`.
- **A PDF with no TIFFs** — a finished PDF dropped straight in: skip the archival
  build; derive the web PDF + first-page thumbnail + OCR from it.
- **Images with no PDF** — a map or graphical work delivered as images: the
  images are the web assets; the primary is the thumbnail. **No OCR runs** — these
  items carry no full text (the OCR stage is N/A).

### Thumbnail source

Thumbnail candidates are the folder's images — the generated first-page image(s)
plus any standalone images. **One candidate → auto**; an image named `thumbnail`
→ auto-primary; **several → the operator picks one** in a picker, and **upload is
blocked until a thumbnail is chosen**. The primary is tagged `role=THUMBNAIL`,
other images/PDFs `role=WEB` (the backend's `FileRole` enum: `SOURCE`,
`ARCHIVAL`, `WEB`, `THUMBNAIL`).

## Naming (folder-derived)

The scanner produces one folder per item, and **the folder name is the base
name** for the derived outputs — we build on the assumption that folder names are
correct and unique at scan time (**for now**). So a folder `njegos_gorski_vijenac`
yields `njegos_gorski_vijenac.pdf`, `njegos_gorski_vijenac_archive.pdf`,
`njegos_gorski_vijenac.txt`, `njegos_gorski_vijenac.json`, etc. Multi-page items
append a running, unpadded page number (`…_1.pdf`, `…_2.pdf`, … `…_10.pdf`).

When a folder carries **several PDFs or images**, those discovered files keep
their **own filenames** — that's how a PDF's full text is matched to it (same
base name, `foo.pdf` ↔ `foo.txt`); only the single-item derived outputs use the
folder name.

> This replaces the prototype's prefix / base-identifier picker
> (COBISS/Signature/Accession/Title). There is **no picker** and no backend
> naming step — naming is derived locally. Settings → Data shows this convention
> read-only for reference.

## Publishing

On upload each item is published according to the batch's **publish target** —
Draft (saved, not live) or Record (a live catalogue record) — and **visibility**
— Public / Private / Hidden (the backend already models these as
`VisibilityStatus`). A published item can later be flagged **Needs re-upload**
and pushed again via the backend's replace endpoint. See
[upload & publish](tasks/07-upload-and-publish.md).

## Sync

A one-way **backend → archive** refresh that updates catalogue metadata for
records the archive already tracks. Runs on demand and automatically **every
6 h**. The Sync screen shows source host, last-synced/next-sync, a live progress
+ stage line, four stat tiles (records checked, metadata updated, up-to-date,
missed), and a recent-syncs log with per-run status/duration (including warnings
like a backend timeout). See [sync](tasks/08-sync-and-backend-data.md).

## Local storage & sync model

- The backend is the **single source of truth**; the archive is a client plus
  **downstream local storage**. We never read authoritative data from the
  archive.
- The **SQLite index** tracks folders, per-stage processing state, connected
  `backendId`, upload state, **and batches** (local working state). Each folder
  also holds a `metadata.json` mirror so it is self-describing.
- **Write-through:** create/edit goes to the backend first, then the archive
  rewrites the local `metadata.json`.
- **Sync** is a manual/scheduled **backend → archive** refresh; links are by
  immutable id, so web-side renames/edits reflect on the next read — nothing to
  reconcile.

## Design principles

- **Fewest clicks.** The happy path (select scans → Create batch → COBISS
  prefill → process → upload) is a handful of interactions.
- **Automate, then let the human correct.** Never block editing.
- **Show state clearly.** Every item and batch shows where it is in the pipeline.
- **Batch-friendly.** Group many items of one type and run one job across them.
- **The website's record type is the source of truth** for what fields exist —
  the form adapts to the schema, it does not hard-code fields.
