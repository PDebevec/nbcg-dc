# Epic 03 — Batches & lifecycle

> Depends on: 01, 02 · Blocks: 04, 05, 06, 07 · **New — the central working unit**

Goal: the **Batches** screen and the batch model + lifecycle that the whole
workspace hangs off. A batch is **local-only** working state in the SQLite index
(never sent to the backend); only the final per-item uploads are. See
[concept & UX](../01-concept-and-ux.md).

## Batch model (SQLite)

Per batch: `id` / human `no` (Batch #017), `created`, ordered `itemIds`, `type`
(the single item state it was created from), `stage`
(`setup → metadata → processing → ready → uploaded`), `running`, `progress`,
`proc` (per-item run outcome: `queued`/`running`/`done`/`failed`), `failSet`,
`cobissId` (batch prefill), `parents` (+ which one passes data), `publish`
(`draft`/`record`) and `visibility` (`public`/`private`/`hidden`) — **batch
defaults; each item may override its own `publish`/`visibility`** (stored per item).

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

- [ ] **Batch store** in the SQLite index: create/read/update batches; assign the
      running human number; persist all fields above. Items gain a `batchId`
      while a member; on upload the batch is archived and its items are
      **released** (`batchId` cleared, state → `Uploaded`) so they can be
      re-selected into a later re-work batch.
- [ ] **Create batch** from an Overview selection: move members to *In progress*,
      set `type`, choose the start tab (Setup for a fresh multi-item batch,
      Metadata for a single fresh item, **Processing** for a re-work batch of
      Stopped / Needs-re-upload / Done items), open the batch.
- [ ] **Batches list screen**: a card per **unfinished** batch (the rail badge
      count) showing number, **status pill** (Setup / Metadata / Processing /
      Ready to upload / Uploaded — spinner while running), created time, item
      count, a **three-step indicator** (Setup → Metadata → Process), and a
      progress bar. Clicking opens the batch **at the tab for its stage**.
- [ ] **Empty state** ("No batches yet") and a **+ New from Overview** shortcut.
- [ ] **Open-at-correct-tab** logic: uploaded → Processing (READ-ONLY until
      **Edit / re-process** is pressed); single fresh item → Metadata; a re-work
      batch (Stopped / Needs-re-upload / Done) → Processing to see where each item
      sits; else the tab matching `stage`. Metadata and Processing stay revisitable
      regardless of entry tab.
- [ ] **Batch header** (shared by the three tabs): number, status pill,
      **READ-ONLY** badge once uploaded — with an **Edit / re-process** action that
      unlocks a published item for re-work and marks it Needs re-upload — and an
      "all changes saved" / "Archived" indicator. A back control returns to the
      Batches list.
- [ ] **Three-tab availability**: Setup runs once at creation (multi-item only).
      Once a batch exists, **Metadata and Processing & Upload are both available
      and revisitable** — not a one-way gate — so items can be re-edited or re-run
      at any time. The only hard lock is an uploaded batch, READ-ONLY until the
      operator presses **Edit / re-process**.
- [ ] **Single-run guard** (`anyOtherRunning`): a per-workstation check that
      blocks Start/Rerun when another batch is running, with the standard
      message. Consumed by [processing](06-processing-pipeline-and-jobs.md).
- [ ] **Concurrency / recovery**: on relaunch, reconstruct batches from SQLite;
      a batch left `running` after a crash resets to a resumable state.

## Acceptance

- Selecting items in Overview and hitting Create batch produces a batch, moves
  the items to In progress, and opens the right start tab.
- The Batches screen lists every unfinished batch with correct status, step
  indicator, and progress; the rail badge matches.
- Opening a batch lands on the tab appropriate to its stage; uploaded batches are
  read-only.
- Attempting to start a second batch while one runs is blocked with the
  one-at-a-time message.
