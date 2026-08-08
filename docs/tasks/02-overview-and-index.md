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

> **Checkboxes track the logic lane (`.ts`, Jernej).** `[x]` = the `.ts` work for
> this item is complete (typechecks + builds clean; unit-tested where noted). The
> GUI (`.vue`) and Arch (`.rs`/`.py`) portions each item still needs are listed in
> [Handoff](#handoff--gui-vue--arch-rspy) below. `⤳` = a *behaviour* handed to a
> later epic (03 Batches / 07 Upload); only the seam/contract is built here.
> _Logic lane completed 2026-08-04._

- [x] Scan the configured **`/unprocessed` and `/processed` roots** and build the
      item list (one folder = one item), each with folder, its **discovered asset
      set** (TIFFs / PDF(s) / image(s) / text), level (`main`/`child`), per-stage
      status, `backendId`, and flags. — logic ✓ (`ipc.index.scan` contract +
      `services/indexing.toItem`, assets classified by `domain/files`); ⤳ Arch fs scan.
- [x] **SQLite index** (see [architecture](../02-architecture.md)): schema +
      Rust-core helpers tracking, per item: path, per-stage state
      (`pdf`/`thumbnail`/`ocr`/`metadata`/`upload`), connected backend id, upload
      + reupload flags, timestamps. — logic ✓ (`IndexedItemDto` + `index_*`
      contract consumed by `services/indexing`); ⤳ Arch owns the SQLite schema/queries.
- [x] **Per-folder `metadata.json`** read/write (the mirror of the backend
      record's metadata) — written on create/update/sync. — logic ✓ (envelope
      `domain/metadata.LocalMetadataFile` + `fs_read/write_metadata` contract +
      `read/writeItemMetadata`); ⤳ write *triggers* land in Epics 07/08; Arch owns the file I/O.
- [x] **Index rebuild**: if SQLite is lost, reconstruct from folders
      (`metadata.json` + presence of derived files). — logic ✓ (`ipc.index.rebuild`
      + `services/indexing.rebuildIndex` + `useItems.rebuild()`); ⤳ Arch owns reconstruction.
- [x] **Derived-state helper** implementing the order above; unit-tested against
      representative flag combinations. — logic ✓✓ **fully done, no other lane**
      (`domain/item.deriveItemState`, 19 cases in `item.test.ts`).
- [x] **Segmented filter** with live counts: **All · Unprocessed · In progress ·
      Stopped · Needs re-upload · Done**. Counts come from the derived states.
      Filter labels map to item states: **Unprocessed = To process**,
      **Done = Uploaded** (the other three share their state names; `All` maps to
      no state). — logic ✓
      (`domain/overview` + `useItems.counts` + `useOverview.filters`); GUI renders the control.
- [x] **State-scoped selection**: only **Unprocessed, Stopped, Needs re-upload,
      Done** allow row selection (a batch groups one type). **All** and **In
      progress** are non-selectable — show the explanatory info line, and render
      a **lock icon** on In-progress rows. — logic ✓ (`SELECTABLE_FILTERS`,
      `useItems.selectable/selection`, `useOverview.infoLine` + `row.locked`); GUI renders lock/info line.
- [x] **Search** filtering by title, folder, or catalogue id. — logic ✓
      (`domain/overview.matchesSearch` + `useItems.search/setSearch`); GUI binds the search box.
- [x] **Per-row stage indicators**: five dots/spinners for **PDF · Thumbnail ·
      OCR · Metadata · Uploaded** (`pending`=ring, `running`=spinner,
      `done`/`failed`/`re-upload`=coloured dot), plus a coloured **state pill**
      and, for Stopped rows, the error message. — logic ✓ (`stagePipStatus`,
      `firstStageError`, `useOverview.rows[].pips/stateLabel/errorMessage`); GUI renders pips/pill.
- [x] **Row interaction**: on selectable filters, click toggles selection; on
      non-selectable filters, click **opens** the item. **Select all visible**
      control on selectable filters. — logic ✓ (`useOverview.onRowClick`,
      `selectAllVisible`, `allVisibleSelected`); ⤳ *open* navigates in Epic 03; GUI wires clicks.
- [x] **⋯ row menu**: **Open as batch** (also the gesture that starts the
      single-item short-circuit — see [batches](03-batches-and-lifecycle.md)) and
      **Open in Explorer** (opens the item's local folder in the OS file manager
      via Tauri). — logic ✓ Open in Explorer (`useOverview.openInExplorer` →
      `fs_reveal_path`); ⤳ Open as batch is an Epic 03 seam; Arch implements `fs_reveal_path`.
- [x] **Create batch** bar appears when items are selected → creates a batch and
      moves the selection to **In progress** (hands off to
      [batches](03-batches-and-lifecycle.md)). — logic ✓ *signal* only
      (`useItems.canCreateBatch/selectedItems`); ⤳ `createBatch()` action is an Epic 03 seam (stubbed).
- [x] Detect **new / changed folders** (watch or refresh) so freshly scanned
      items appear without a restart. — logic ✓ (`services/indexing.watchIndexChanges`
      + debounced `useItems.startWatching`, consuming the `fs://changed` event); ⤳ Arch emits the event.
- [x] **Move to `/processed`**: on successful upload, move the item's folder from
      `/unprocessed` to `/processed` and update the index (this is the
      "reposition" action; see [upload](07-upload-and-publish.md)). — logic ✓
      *contract + service* (`fs_move_to_processed` + `services/indexing.moveToProcessed`);
      ⤳ the *trigger* fires in Epic 07; Arch implements the move.

## Acceptance

- Newly scanned folders appear under the correct filter with a state derived from
  the index; counts are live and correct.
- Selection is allowed only on the four state-scoped filters; All / In progress
  are non-selectable with the info line + lock icon.
- Per-row indicators reflect the five stages; the ⋯ menu opens the folder in
  Explorer.
- Selecting items and hitting **Create batch** produces a batch and moves the
  items to In progress.

## Handoff — GUI (`.vue`) & Arch (`.rs`/`.py`)

_Logic lane (Jernej, `.ts`) done 2026-08-04. Typechecks (`vue-tsc`) + builds
(`vite build`) clean; the pure logic is unit-tested (`npm test` — 57 cases across
`item`/`overview`/`files`; re-counted 2026-08-08). Adversarially reviewed; two defects found + fixed (the
Uploaded-vs-In-progress precedence for re-work batches, and an fs-watch listener
leak on fast mount/unmount)._

### What the logic lane built (`.ts`)

| Area | Files |
|---|---|
| Domain model + **derived state machine** | `src/domain/item.ts` (`Item`, `ItemState`, `deriveItemState`, `stagePipStatus`, `firstStageError`, `STAGE_NAMES`/`STAGE_LABELS`) + `item.test.ts` |
| Asset classification (naming convention) | `src/domain/files.ts` (`classifyAsset`, `thumbnailCandidates`, `ocrApplicable`, `uploadRoleFor`) + `files.test.ts` |
| Filters / selection scoping / search / counts | `src/domain/overview.ts` (`OVERVIEW_FILTERS`, `filterState`, `SELECTABLE_FILTERS`, `matchesSearch`, `countByFilter`) + `overview.test.ts` |
| `metadata.json` envelope | `src/domain/metadata.ts` (`LocalMetadataFile`) |
| Native contract (Seam 2) | `src/ipc/bindings.ts` (`index_scan/list/rebuild`, `fs_read/write_metadata`, `fs_reveal_path`, `fs_move_to_processed`, `IndexedItemDto`) |
| Index service | `src/services/indexing.ts` (DTO→`Item` map, scan/list/rebuild, metadata I/O, reveal, move, `watchIndexChanges`) |
| Reactive state | `src/stores/useItems.ts` (items, filter, search, state-scoped selection, live counts, debounced fs-watch) |
| View-model (Seam 1) | `src/composables/useOverview.ts` (`rows`, `filters`, `search`, `infoLine`, selection signals, row actions) |

### GUI dev (`.vue` / `.css`) — bind `useOverview()` only

Import **only** `composables/useOverview` (+ `domain` types); never `services`/
`ipc`/`stores`. Everything below is already reactive off that one composable:

- **Arrivals table** (`views/OverviewView.vue`, `components/table/*`): render
  `rows` — each row has `folderName`, `title`, `catalogueId`, `level`, `state` +
  `stateLabel`, `pips` (5 × `{stage,label,status}`), `errorMessage`, `selected`,
  `selectable`, `locked`.
- **Stage pips** (`StagePips.vue`): map each `pip.status`
  (`pending`=ring · `queued`/`running`=spinner · `done`/`failed`/`re-upload`/`skipped`=coloured dot).
- **State pill** (`StatePill.vue`): colour by `row.state`; show `errorMessage` on Stopped rows.
- **Segmented filter**: bind `filters` (`{key,label,count,active}`) → `setFilter(key)`.
- **Selection**: click row → `onRowClick(id)`; show a checkbox only when
  `row.selectable`; render a **lock icon** when `row.locked`; show `infoLine`
  when it is non-null (non-selectable filter); **Select all visible** →
  `selectAllVisible()` / `allVisibleSelected`.
- **Search box**: `v-model` → `search` / `setSearch(q)`.
- **⋯ menu**: **Open in Explorer** → `openInExplorer(id)`; **Open as batch** →
  `openAsBatch(id)` (stub toast until Epic 03).
- **Create-batch bar**: show when `canCreateBatch`; button → `createBatch()`
  (stub toast until Epic 03); `selectionCount` for the label.
- Call `init()` on mount / `dispose()` on unmount **only if** you don't rely on
  the composable's built-in `onMounted`/`onUnmounted` (it self-manages when used
  inside `setup()`).

### Arch dev (`.rs` / `.py`) — implement the Seam-2 commands + event

The `.ts` side calls these; implement them in `src-tauri/src/commands/{index,fs}.rs`
backed by `core/fs` + `core/db`, and keep `dto.rs` in serde-sync with
`IndexedItemDto`/`IndexedAssetDto`/`IndexedStageDto` (field names camelCase over IPC).

- `index_scan` / `index_list` / `index_rebuild` → `IndexedItemDto[]`. Scan
  `/unprocessed` + `/processed` (one folder = one item), reconcile the **SQLite
  index** (path, per-stage status, `uploaded`/`reupload`, `backendId`, `batchId`,
  timestamps), and for each folder return the raw file list (`assets`: filename +
  path + optional size — **do not** classify; the `.ts` lane does that) plus
  `level`/`title`/`cobissId` read from `metadata.json` when present. `rebuild`
  reconstructs the DB purely from folders (`metadata.json` + derived-file presence).
- `fs_read_metadata(path)` → `LocalMetadataFile | null`; `fs_write_metadata(path, metadata)`
  (**atomic** write). `fs_reveal_path(path)` → reveal in the OS file manager
  (the bundled `@tauri-apps/plugin-opener` `revealItemInDir` is fine).
  `fs_move_to_processed(itemId)` → move the folder `/unprocessed`→`/processed`,
  update the index, return the updated `IndexedItemDto`.
- Emit **`fs://changed`** (`{root, kind, path}`, see `src/ipc/events.ts`) from a
  native watcher on both roots so new/changed folders refresh without a restart.
- Register `tauri-plugin-http` + `@tauri-apps/plugin-opener` and their
  capabilities. (`tauri-specta` will later regenerate `bindings.ts` from these
  signatures — until then the hand-written contract is the agreement.)

### Python (`py/`)

Nothing in Epic 02 — the pipeline scripts belong to Epic 06.

### Cross-epic seams (built here, wired later)

- **Epic 03 (Batches):** `useOverview.createBatch()` / `openAsBatch()` /
  `openItem()` are stubs; `canCreateBatch` + `selectedItems` are the real signals.
  Batch creation must set each selected item's `batchId` (→ In progress) and, on
  upload, clear it (→ Uploaded), matching `deriveItemState`.
- **Epic 07 (Upload):** `moveToProcessed()` + `writeItemMetadata()` exist; their
  triggers fire from the upload flow.
