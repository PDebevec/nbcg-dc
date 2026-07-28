# Epic 02 — Overview & local index

> Depends on: 01 · Blocks: 03, 06, 07, 08

Goal: the **Overview** screen — the arrivals table that lists everything that has
arrived, derives each item's state, and is the entry point to batching — backed
by a **SQLite index** (plus a per-folder `metadata.json` mirror). Replaces the
old "folder tree" left panel.

## Item state machine (derived, not stored)

Compute each item's state every render from its flags + stage statuses, first
match wins (see [concept & UX](../01-concept-and-ux.md)):

`Uploaded` → `In progress` → `Needs re-upload` → `Stopped` → `To process`.

The SQLite index stores the underlying facts (`uploaded`, `reupload`, per-stage
outcomes, batch membership); the state name is re-derived. Connection status is
a **separate axis** (backend reachability), never mixed into item state.

## Tasks

- [ ] Scan the configured **`/unprocessed` and `/processed` roots** and build the
      item list (one folder = one item), each with folder, its **discovered asset
      set** (TIFFs / PDF(s) / image(s) / text), level (`main`/`child`), per-stage
      status, `backendId`, and flags.
- [ ] **SQLite index** (see [architecture](../02-architecture.md)): schema +
      Rust-core helpers tracking, per item: path, per-stage state
      (`pdf`/`thumbnail`/`ocr`/`metadata`/`upload`), connected backend id, upload
      + reupload flags, timestamps.
- [ ] **Per-folder `metadata.json`** read/write (the mirror of the backend
      record's metadata) — written on create/update/sync.
- [ ] **Index rebuild**: if SQLite is lost, reconstruct from folders
      (`metadata.json` + presence of derived files).
- [ ] **Derived-state helper** implementing the order above; unit-tested against
      representative flag combinations.
- [ ] **Segmented filter** with live counts: **All · Unprocessed · In progress ·
      Stopped · Needs re-upload · Done**. Counts come from the derived states.
      Filter labels map to item states: **Unprocessed = To process**,
      **Done = Uploaded** (the other four share their state names).
- [ ] **State-scoped selection**: only **Unprocessed, Stopped, Needs re-upload,
      Done** allow row selection (a batch groups one type). **All** and **In
      progress** are non-selectable — show the explanatory info line, and render
      a **lock icon** on In-progress rows.
- [ ] **Search** filtering by title, folder, or catalogue id.
- [ ] **Per-row stage indicators**: five dots/spinners for **PDF · Thumbnail ·
      OCR · Metadata · Uploaded** (`pending`=ring, `running`=spinner,
      `done`/`failed`/`re-upload`=coloured dot), plus a coloured **state pill**
      and, for Stopped rows, the error message.
- [ ] **Row interaction**: on selectable filters, click toggles selection; on
      non-selectable filters, click **opens** the item. **Select all visible**
      control on selectable filters.
- [ ] **⋯ row menu**: **Open as batch** (also the gesture that starts the
      single-item short-circuit — see [batches](03-batches-and-lifecycle.md)) and
      **Open in Explorer** (opens the item's local folder in the OS file manager
      via Tauri).
- [ ] **Create batch** bar appears when items are selected → creates a batch and
      moves the selection to **In progress** (hands off to
      [batches](03-batches-and-lifecycle.md)).
- [ ] Detect **new / changed folders** (watch or refresh) so freshly scanned
      items appear without a restart.
- [ ] **Move to `/processed`**: on successful upload, move the item's folder from
      `/unprocessed` to `/processed` and update the index (this is the
      "reposition" action; see [upload](07-upload-and-publish.md)).

## Acceptance

- Newly scanned folders appear under the correct filter with a state derived from
  the index; counts are live and correct.
- Selection is allowed only on the four state-scoped filters; All / In progress
  are non-selectable with the info line + lock icon.
- Per-row indicators reflect the five stages; the ⋯ menu opens the folder in
  Explorer.
- Selecting items and hitting **Create batch** produces a batch and moves the
  items to In progress.
