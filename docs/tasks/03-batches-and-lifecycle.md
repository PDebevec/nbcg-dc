# Epic 03 — Batches & lifecycle

> Depends on: 01, 02 · Blocks: 04, 05, 06, 07 · **New — the central working unit**

Goal: the **Batches** screen and the batch model + lifecycle that the whole
workspace hangs off. A batch is **local-only** working state in the SQLite index
(never sent to the backend); only the final per-item uploads are. See
[concept & UX](../01-concept-and-ux.md).

## Batch model (SQLite)

Per batch: `id` / human `no` (Batch #017), `created`, ordered `itemIds`, `type`
(the single item state it was created from), `stage`
(`setup → metadata → processing → ready → uploaded`), `running`,
`proc` (per-item run outcome: `queued`/`running`/`done`/`failed`),
`cobissId` (batch prefill), `parents` (+ which one passes data), `publish`
(`draft`/`record`) and `visibility` (`public`/`private`/`hidden`) — **batch
defaults; each item may override its own `publish`/`visibility`** (stored per item
in `overrides`, which also carries the per-item `contentKind`).

> **`progress` and `failSet` are NOT stored** (corrected 2026-08-08 — the list
> above used to name them). Both are **derived** from `itemIds` + `proc` on demand,
> by `domain/batch.batchProgress` and `domain/batch.failedItemIds`. Persisting them
> would be a second source of truth for something already implied by `proc`, and
> the two could disagree. `progress` exists only as a view-model field on
> `BatchHeaderView`/`BatchCardView`; `failSet` exists nowhere as a stored field.

## Rules

- **One item type per batch** — created from a single Overview state.
- **One batch processes at a time, per workstation** — app-enforced; starting or
  rerunning while another batch runs is blocked with a message. Single machine,
  so no backend lock (see [decisions](../03-open-questions.md)).
- **Single-item short-circuit** — opening one *To process* item (via the row's
  **⋯ → Open as batch**, or selecting it and hitting **Create batch**) creates a
  one-item batch and drops straight into **Metadata** (skip Setup). Multi-item
  batches start at **Setup**.
- **Revisitable, not linear** — Setup runs once at creation; **Metadata** and
  **Processing & Upload** stay open for the batch's life, so any item can be
  re-edited or any stage re-run at any time. `stage` tracks *furthest progress
  reached*, not a one-way gate. Validation still gates the **first** processing
  run, and the single-run lock still applies.
- **Metadata source is per item** — a not-yet-uploaded item (no `backendId`)
  loads from the local `metadata.json` / SQLite (the working source of truth until
  first upload, so a failed run loses nothing); an uploaded item treats the
  **backend** as source (local is a background-refreshed mirror).
- **Re-working published items is explicit** — a batch of already-uploaded (Done)
  items opens **READ-ONLY**; an explicit **Edit / re-process** action unlocks it,
  and any change flips the item to **Needs re-upload**. Metadata edits then go via
  `PATCH`; re-running a stage (TIFF→PDF, OCR, …) produces new files handled by the
  replace endpoint. An uploaded batch is archived READ-ONLY and **releases its
  items** so they can be re-batched later.

## Tasks

> **Checkboxes track the logic lane (`.ts`, Jernej).** `[x]` = the `.ts` work for
> this item is complete (typechecks + builds clean; the pure batch logic is
> unit-tested). The GUI (`.vue`) and Arch (`.rs`/`.py`) portions each item still
> needs are listed in [Handoff](#handoff--gui-vue--arch-rspy) below. `⤳` = a
> *behaviour* handed to a later epic (04/05/06/07); only the seam/contract is
> built here. _Logic lane completed 2026-08-04._

- [x] **Batch store** in the SQLite index: create/read/update batches; assign the
      running human number; persist every **stored** field above (`progress` and
      `failSet` are derived, not columns). Items gain a `batchId`
      while a member; on upload the batch is archived and its items are
      **released** (`batchId` cleared, state → `Uploaded`) so they can be
      re-selected into a later re-work batch. — logic ✓ (`domain/batch` model +
      `services/batches` list/create/update/archive + `stores/useBatches`; the
      `batch_*` IPC contract + `BatchDto`/`BatchCreateDto`); ⤳ Arch owns the
      SQLite batch table, the running-`no` counter, the item↔batch link writes,
      and archive/release.
- [x] **Create batch** from an Overview selection: move members to *In progress*,
      set `type`, choose the start tab (Setup for a fresh multi-item batch,
      Metadata for a single fresh item, **Processing** for a re-work batch of
      Stopped / Needs-re-upload / Done items), open the batch. — logic ✓
      (`useOverview.createBatch`/`openAsBatch` → `useBatches.create` →
      `batch_create`; `type` from `deriveItemState`, start stage from
      `initialStageFor`; refreshes `useItems` so members read In progress; then
      navigates to the workspace); GUI renders the Create-batch bar / ⋯ menu
      (already bound to these actions in Epic 02).
- [x] **Batches list screen**: a card per **unfinished** batch (the rail badge
      count) showing number, **status pill** (Setup / Metadata / Processing /
      Ready to upload / Uploaded — spinner while running), created time, item
      count, a **three-step indicator** (Setup → Metadata → Process), and a
      progress bar. Clicking opens the batch **at the tab for its stage**. —
      logic ✓ (`composables/useBatches.cards` — label/status/running/createdAt/
      itemCount/steps/progress — + `badgeCount`, `open()`); GUI renders the cards
      + rail badge.
- [x] **Empty state** ("No batches yet") and a **+ New from Overview** shortcut. —
      logic ✓ (`useBatches.isEmpty` + `newFromOverview()`); GUI renders the empty
      state + shortcut.
- [x] **Open-at-correct-tab** logic: uploaded → Processing (READ-ONLY until
      **Edit / re-process** is pressed); single fresh item → Metadata; a re-work
      batch (Stopped / Needs-re-upload / Done) → Processing to see where each item
      sits; else the tab matching `stage`. Metadata and Processing stay revisitable
      regardless of entry tab. — logic ✓ (`domain/batch.openTabFor`/`tabForStage`
      + `useBatchWork.resolvedTab`; single-item→Metadata is implicit via
      `initialStageFor`); GUI binds the active tab.
- [x] **Batch header** (shared by the three tabs): number, status pill,
      **READ-ONLY** badge once uploaded — with an **Edit / re-process** action that
      unlocks a published item for re-work and marks it Needs re-upload — and an
      "all changes saved" / "Archived" indicator. A back control returns to the
      Batches list. — logic ✓ (`useBatch.header` —
      label/status/running/readOnly/showsUnlock/savedLabel — + `unlock()`,
      `back()`); GUI renders the header, badges, and controls. ⤳ the *edit flips
      item → Needs re-upload* write is Epic 07 (this exposes the unlock signal).
- [x] **Three-tab availability**: Setup runs once at creation (multi-item only).
      Once a batch exists, **Metadata and Processing & Upload are both available
      and revisitable** — not a one-way gate — so items can be re-edited or re-run
      at any time. The only hard lock is an uploaded batch, READ-ONLY until the
      operator presses **Edit / re-process**. — logic ✓
      (`domain/batch.hasSetup`/`availableTabs` + `useBatch.tabs` +
      `useBatchWork.setTab` guard + `readOnly`); GUI renders the tab bar + the
      three tab bodies (Setup/Metadata/Processing land with Epics 05/04/06).
- [x] **Single-run guard** (`anyOtherRunning`): a per-workstation check that
      blocks Start/Rerun when another batch is running, with the standard
      message. Consumed by [processing](06-processing-pipeline-and-jobs.md). —
      logic ✓ (`domain/batch.anyOtherRunning`/`runningBatch`/
      `singleRunBlockedMessage` + `useBatches.anyOtherRunning`/`running` +
      `useBatch.runBlocked`/`runBlockedMessage`); ⤳ Epic 06 consumes it to gate
      Start/Rerun; Arch enforces the hard native-side lock in `core/jobs`.
- [x] **Concurrency / recovery**: on relaunch, reconstruct batches from SQLite;
      a batch left `running` after a crash resets to a resumable state. — logic ✓
      (`domain/batch.needsRecovery`/`recoverBatch` + `useBatches.load()` with
      recovery **gated to the first load of the session** + a relaunch load in
      `app/boot.ts`); ⤳ Arch reconstructs from SQLite (`batch_list`) and persists
      the recovered state (`batch_update`).

## Acceptance

- Selecting items in Overview and hitting Create batch produces a batch, moves
  the items to In progress, and opens the right start tab.
- The Batches screen lists every unfinished batch with correct status, step
  indicator, and progress; the rail badge matches.
- Opening a batch lands on the tab appropriate to its stage; uploaded batches are
  read-only.
- Attempting to start a second batch while one runs is blocked with the
  one-at-a-time message.

## Handoff — GUI (`.vue`) & Arch (`.rs`/`.py`)

_Logic lane (Jernej, `.ts`) done 2026-08-04. Typechecks (`vue-tsc`) + builds
(`vite build`) clean; the pure batch logic is unit-tested (`npm test` — 41 cases
in `batch.test.ts` as of 2026-08-08, some of them Epic 06's run reducers; the
whole suite is 566). Adversarially reviewed (reactivity / lane-boundaries /
completeness); two real defects found + fixed: crash-recovery was running on
every `load()` (would reset a legitimately-running batch once Epic 06 lands) —
now **gated to the first load of the session**; and the batch workspace didn't
self-load the batches store (empty on deep-link / cold-store open) — now
load-if-cold on mount, plus a relaunch load in `app/boot.ts`. The
`correctness` review dimension did not complete (agent hit the session token
limit); the 34 unit tests cover that axis._

### What the logic lane built (`.ts`)

| Area | Files |
|---|---|
| Batch domain model + **lifecycle rules** | `src/domain/batch.ts` (`Batch`, `BatchStage`, `BatchTab`, `ItemRunStatus`, `initialStageFor`, `openTabFor`, `tabForStage`, `hasSetup`, `availableTabs`, `requiresUnlock`, `isArchived`, `stepIndexForStage`, `batchProgress`, `failedItemIds`, `anyOtherRunning`, `runningBatch`, `singleRunBlockedMessage`, `isUnfinished`, `resolveItemPublish/Visibility`, `recoverBatch`, `newBatchFields`, `batchLabel`, `BATCH_STAGE_LABELS`/`BATCH_TAB_LABELS`/`BATCH_STEPS`) + `batch.test.ts` |
| Native contract (Seam 2) | `src/ipc/bindings.ts` (`batch_list`/`batch_create`/`batch_update`/`batch_archive`, `BatchDto`, `BatchCreateDto`) |
| Batch service | `src/services/batches.ts` (`BatchDto`↔`Batch` map, list/create/update/archive) |
| Reactive state | `src/stores/useBatches.ts` (collection, `unfinished`/`badgeCount`, single-run guard, crash recovery, create/update/archive with `useItems` refresh) + `src/stores/useBatchWork.ts` (open-batch session: current, `resolvedTab`, `readOnly`, `showsUnlock`, unlock) |
| View-models (Seam 1) | `src/composables/useBatches.ts` (list: `cards`, `isEmpty`, `badgeCount`, `open`, `newFromOverview`) + `src/composables/useBatch.ts` (work shell: `header`, `tabs`, `steps`, `activeTab`, `readOnly`, `runBlocked`/`runBlockedMessage`, `setTab`, `unlock`, `back`) |
| Overview seams wired | `src/composables/useOverview.ts` (`createBatch`/`openAsBatch`/`openItem` now create a batch + navigate) |
| Boot | `src/app/boot.ts` (relaunch batch load → crash recovery + rail badge) |

> **Note on composables:** the code-structure doc named only `useBatch`; the
> logic lane split it into **`useBatches`** (the list VM `BatchesView.vue` binds)
> and **`useBatch`** (the work-shell VM `BatchWorkView.vue` binds) so each screen
> binds exactly one composable, per Seam 1.

### GUI dev (`.vue` / `.css`) — bind `useBatches()` / `useBatch()` only

Import **only** the composable (+ `domain` types); never `services`/`ipc`/
`stores`.

- **Batches list** (`views/BatchesView.vue`, `components/batch/BatchCard.vue`,
  `StepIndicator.vue`, `ProgressBar.vue`): render `cards` — each has `id`,
  `label` ("Batch #017"), `status`, `running` (spinner), `createdAt`,
  `itemCount`, `steps` (`{label,done,active}` × 3), `progress` (`{done,total,ratio}`).
  Show the empty state when `isEmpty`; **+ New from Overview** → `newFromOverview()`;
  click a card → `open(id)`. The **rail badge** binds `badgeCount` (also exposed
  on the `useBatches` store for `AppRail.vue`).
- **Batch workspace** (`views/BatchWorkView.vue`): `useBatch(() => props.batchId)`
  (pass the route prop as a getter). Render `header`
  (`label`/`status`/`running`/`readOnly`/`showsUnlock`/`savedLabel`/`progress`);
  the **Edit / re-process** control → `unlock()` (shown when `header.showsUnlock`);
  a **back** control → `back()`. Render the tab bar from `tabs`
  (`{key,label,active}`) → `setTab(key)`, and the three-step indicator from
  `steps`. Gate the Processing tab's Start/Rerun on `runBlocked` and show
  `runBlockedMessage`. The three **tab bodies** (Setup / Metadata / Processing)
  are authored with Epics 05 / 04 / 06 — this epic ships only the shell.

### Arch dev (`.rs` / `.py`) — implement the Seam-2 `batch_*` commands

Implement in `src-tauri/src/commands/` backed by `core/db`, keeping `dto.rs` in
serde-sync with `BatchDto` (camelCase over IPC). Batches are a **new SQLite
table** (local-only working state; never sent to the backend).

- `batch_list` → `BatchDto[]` — all batches (finished + unfinished).
- `batch_create({ fields: BatchCreateDto })` → `BatchDto` — **atomically**:
  assign `id` + the running human `no` (a persistent counter) + `createdAt`, and
  **stamp `batchId` onto every item in `fields.itemIds`** in the items table (so
  the Overview's `index_list`/`index_scan` immediately report them as In
  progress). Return the created batch.
- `batch_update({ batch: BatchDto })` → `BatchDto` — persist the full row
  (stage/running/proc/parents/publish/visibility/overrides/cobissId).
- `batch_archive({ batchId })` → `BatchDto` — set `archivedAt` + `stage =
  uploaded`, `running = false`, and **release the items** (clear their `batchId`
  → they settle to Uploaded). Triggered by the upload flow (Epic 07). Return the
  archived batch.
- On relaunch the logic lane recovers batches left `running`; make sure
  `batch_list` returns the persisted `running`/`proc` truthfully so recovery can
  act on it (the `.ts` side write-backs the recovered rows via `batch_update`).
- The single-run **hard lock** (block a second concurrent job) lives in
  `core/jobs` (Epic 06); this epic provides only the app-level guard signal.

### Python (`py/`)

Nothing in Epic 03 — the pipeline scripts belong to Epic 06.

### Cross-epic seams (built here, wired later)

- **Epic 04 (Metadata):** the **Metadata** tab body binds `useMetadataForm`; the
  per-item publish/visibility **overrides** persisted on the batch
  (`resolveItemPublish/Visibility`) are set there.
- **Epic 05 (COBISS/parents):** the **Setup** tab body sets the batch `cobissId`
  + `parents` (the `BatchParentRef` shape is a placeholder — Epic 05 owns the
  rich parent model + data-passing eligibility).
- **Epic 06 (Processing):** the **Processing** tab consumes `runBlocked` +
  advances `stage`/`running`/`proc` via `useBatches.update` and the `jobs_*`
  events.
- **Epic 07 (Upload):** on successful upload calls `useBatches.archive(batchId)`
  (releases items → Uploaded) and flips an unlocked-then-edited published item to
  Needs re-upload.

## Audit pass, 2026-08-08

Two gaps found by checking the code against this doc rather than the reverse.

### `stage` never advanced Setup → Metadata (partly fixed)

`Batch.stage` is documented as "the **furthest progress reached**, not a one-way
gate", but only two things ever wrote it: `initialStageFor` (at create) and
`enterProcessing`. `initialStageFor` starts a **single-item** batch at
`metadata` and a **multi-item** batch at `setup` — and nothing moved it on. So a
multi-item batch sat at `setup` right up until its first processing run, no
matter how much metadata work had been done.

Two visible consequences:

- **Reopening the batch dropped the operator back on Setup.**
  `useBatchWork.open()` clears the session-local tab, so `resolvedTab` falls back
  to `openTabFor(batch)` → `tabForStage(batch.stage)` → Setup. After a relaunch,
  a batch whose metadata was fully filled in still opened on Setup.
- **The three-step indicator never showed Metadata as active** — it jumped Setup
  → Processing, marking Metadata done only retroactively.

**Fixed the half that is logic:** `domain/batch.enterMetadata` now exists as the
missing counterpart to `enterProcessing` (idempotent, never regresses a later
stage, safe to call on every tab change).

**Owed by GUI:** the *caller*. Advancing on "operator left Setup for Metadata" is
a UI event, and `useBatchWork.setTab` only mutates the session-local `activeTab`
today — it must also persist `enterMetadata(batch)` through `useBatches.update`.

### "One item type per batch" is enforced by construction only

`useOverview.createBatch()` derives the batch `type` from
`deriveItemState(items[0])` — the **first** selected item — and never checks the
rest agree. It is safe *today* because selection is scoped to one selectable
filter (`SELECTABLE_FILTERS` / `filterMatchesState`), so a selection cannot span
states. But the invariant lives entirely in the Overview store's selection logic:
`domain/batch.newBatchFields` and `CreateBatchInput` have no guard, so a future
change to selection (a bug in `pruneSelection`, or a "select all" that ignores the
filter) would silently create a mixed-state batch with nothing to catch it.

**Not fixed** — deliberately. The right guard needs the item states at the call
site, which means either passing them into `newBatchFields` or validating in the
store; both touch the Overview seam that is still moving. Recorded here so it is a
decision rather than an oversight.
