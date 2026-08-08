/**
 * The **Batch** domain model + its lifecycle rules (Epic 03).
 *
 * A batch is the central working unit: a **local-only** set of items processed
 * together (never sent to the backend — only the final per-item uploads are).
 * It lives in the SQLite index as operator-side working state (the Arch lane
 * owns the table + queries; this module owns the *shape* and the pure rules the
 * store/composables read). See docs/01-concept-and-ux.md §Batches & lifecycle
 * and docs/tasks/03-batches-and-lifecycle.md.
 *
 * Framework-free — imports only sibling domain types — so every lane can consume
 * it without crossing a service seam.
 */

import { ItemState } from "./item";
import { PublishTarget, VisibilityStatus } from "./enums";
import type { ContentKind } from "./pipeline";

/**
 * The batch lifecycle stages, in order. `stage` records the **furthest progress
 * reached**, not a one-way gate — Metadata and Processing stay revisitable
 * (docs/01). `ready` = processed and metadata-complete, awaiting upload;
 * `uploaded` = archived terminal (items released).
 */
export const BatchStage = {
  Setup: "setup",
  Metadata: "metadata",
  Processing: "processing",
  Ready: "ready",
  Uploaded: "uploaded",
} as const;
export type BatchStage = (typeof BatchStage)[keyof typeof BatchStage];

/** Status-pill copy for each stage (the only place batch-stage copy lives). */
export const BATCH_STAGE_LABELS: Record<BatchStage, string> = {
  setup: "Setup",
  metadata: "Metadata",
  processing: "Processing",
  ready: "Ready to upload",
  uploaded: "Uploaded",
};

/**
 * The three workspace tabs. Fewer than the five {@link BatchStage}s: Processing
 * & Upload is one tab that spans `processing → ready → uploaded`.
 */
export const BatchTab = {
  Setup: "setup",
  Metadata: "metadata",
  Processing: "processing",
} as const;
export type BatchTab = (typeof BatchTab)[keyof typeof BatchTab];

/** Tab-header copy. */
export const BATCH_TAB_LABELS: Record<BatchTab, string> = {
  setup: "Setup",
  metadata: "Metadata",
  processing: "Processing & Upload",
};

/**
 * The three-step indicator on a batch card / header (Setup → Metadata →
 * Process). Uses the short "Process" label, distinct from the tab header.
 */
export const BATCH_STEPS: ReadonlyArray<{ key: BatchTab; label: string }> = [
  { key: BatchTab.Setup, label: "Setup" },
  { key: BatchTab.Metadata, label: "Metadata" },
  { key: BatchTab.Processing, label: "Process" },
];

/**
 * A member item's outcome in the batch's **current run** (distinct from the
 * item's own per-stage pipeline statuses — this is the batch's coarse view for
 * the live processing list + progress bar). `idle` = not yet run in this batch.
 */
export const ItemRunStatus = {
  Idle: "idle",
  Queued: "queued",
  Running: "running",
  Done: "done",
  Failed: "failed",
} as const;
export type ItemRunStatus = (typeof ItemRunStatus)[keyof typeof ItemRunStatus];

/**
 * A parent record linked to the batch at Setup. Minimal here — Epic 05 owns the
 * rich parent model (name, `collectionType`, data-passing eligibility). Among
 * eligible parents exactly one `passesData` at a time (invariant enforced in
 * Epic 05); the flag is persisted per parent.
 */
export interface BatchParentRef {
  /** Backend `Draft`/`Record` id of the parent. */
  id: string;
  /** Whether this parent's shared fields copy down to the batch's items. */
  passesData: boolean;
}

/**
 * A per-item override of the batch's publish/visibility defaults. Each item
 * defaults to the batch (Setup) values and may override both (set in Metadata;
 * used at Upload). Stored on the batch keyed by item id — local working state.
 */
export interface BatchItemOverride {
  publish?: PublishTarget | null;
  visibility?: VisibilityStatus | null;
  /**
   * How to read this item's images — a book's pages, or a standalone graphical
   * work. Omitted/null means detect from the filenames
   * (`domain/pipeline.ContentKind`). Set from the Setup tab when detection gets
   * it wrong; both mistakes are damaging, so the operator can always force it
   * (docs/05-real-scan-data.md).
   */
  contentKind?: ContentKind | null;
}

/**
 * One batch. All fields are **local** working state persisted in SQLite; nothing
 * here is ever uploaded. `id`/`no`/`createdAt` are assigned native-side on
 * create (see {@link CreateBatchInput} / `services/batches`).
 */
export interface Batch {
  /** Stable local id (native-assigned). */
  id: string;
  /** Running human number (native-assigned counter); rendered as "Batch #017". */
  no: number;
  createdAt: string;
  /**
   * The single item state the batch was created from. A batch groups one type
   * (setup + processing apply uniformly), so this is fixed at creation and
   * drives the start tab + whether Setup exists.
   */
  type: ItemState;
  /** Member item ids, in creation order. */
  itemIds: string[];
  /** Furthest lifecycle stage reached (not a one-way gate). */
  stage: BatchStage;
  /** Whether this batch is currently running the pipeline (transient). */
  running: boolean;
  /** Per-item run outcome for the live processing list (keyed by item id). */
  proc: Record<string, ItemRunStatus>;
  /** Batch-wide COBISS prefill id, or null. */
  cobissId: string | null;
  /** Parents linked at Setup (Epic 05 fleshes out). */
  parents: BatchParentRef[];
  /** Batch default publish target (each item may override). */
  publish: PublishTarget;
  /** Batch default visibility (each item may override). */
  visibility: VisibilityStatus;
  /** Per-item publish/visibility overrides (keyed by item id). */
  overrides: Record<string, BatchItemOverride>;
  /** ISO timestamp the batch was archived (uploaded + items released), or null. */
  archivedAt: string | null;
}

/** The fields a caller supplies to create a batch; the rest are defaulted by
 * {@link newBatchFields} and the native id/no/createdAt are assigned on persist. */
export interface CreateBatchInput {
  type: ItemState;
  itemIds: string[];
  cobissId?: string | null;
  publish?: PublishTarget;
  visibility?: VisibilityStatus;
}

/** The batch fields sent to the native `batch_create` (everything except the
 * native-assigned `id`/`no`/`createdAt` and the always-null-at-birth
 * `archivedAt`). */
export type NewBatchFields = Omit<Batch, "id" | "no" | "createdAt" | "archivedAt">;

/** Conservative defaults for a new batch: saved as a Draft, not public. */
export const DEFAULT_BATCH_PUBLISH: PublishTarget = PublishTarget.DRAFT;
export const DEFAULT_BATCH_VISIBILITY: VisibilityStatus = VisibilityStatus.PRIVATE;

/**
 * A batch created from an already-published or errored state is a **re-work**
 * batch (Stopped / Needs re-upload / Done). These skip Setup and open at
 * Processing (docs/tasks/03).
 */
export function isReworkType(type: ItemState): boolean {
  return (
    type === ItemState.Stopped ||
    type === ItemState.NeedsReupload ||
    type === ItemState.Uploaded
  );
}

/**
 * The stage a **new** batch starts at (docs/tasks/03 "choose the start tab"):
 *  - re-work batch → Processing (see where each item sits);
 *  - single fresh item → Metadata (single-item short-circuit, skips Setup);
 *  - multi-item fresh batch → Setup.
 */
export function initialStageFor(type: ItemState, itemCount: number): BatchStage {
  if (isReworkType(type)) return BatchStage.Processing;
  return itemCount === 1 ? BatchStage.Metadata : BatchStage.Setup;
}

/** Map a lifecycle stage to the tab that renders it (Processing & Upload spans
 * `processing`/`ready`/`uploaded`). */
export function tabForStage(stage: BatchStage): BatchTab {
  switch (stage) {
    case BatchStage.Setup:
      return BatchTab.Setup;
    case BatchStage.Metadata:
      return BatchTab.Metadata;
    case BatchStage.Processing:
    case BatchStage.Ready:
    case BatchStage.Uploaded:
      return BatchTab.Processing;
  }
}

/** True once the batch has uploaded and been archived (items released). */
export function isArchived(batch: Batch): boolean {
  return batch.archivedAt != null;
}

/**
 * Whether the batch shows the READ-ONLY badge + **Edit / re-process** unlock
 * affordance: a live (not-yet-archived) re-work batch of **Done** items opens
 * read-only until the operator explicitly unlocks it (docs/01 "Editing a
 * published item is deliberate"). Stopped / Needs-re-upload re-work batches are
 * already unpublished-dirty and open editable.
 */
export function requiresUnlock(batch: Batch): boolean {
  return !isArchived(batch) && batch.type === ItemState.Uploaded;
}

/**
 * Which tab to land on when **opening an existing** batch (docs/tasks/03):
 *  - archived / uploaded → Processing (read-only view of the result);
 *  - re-work batch → Processing (see where each item sits);
 *  - otherwise the tab matching the furthest `stage`.
 *
 * The "single fresh item → Metadata" rule is implicit: such a batch is created
 * at `stage = metadata` ({@link initialStageFor}), so `tabForStage` returns
 * Metadata until it progresses.
 */
export function openTabFor(batch: Batch): BatchTab {
  if (isArchived(batch) || batch.stage === BatchStage.Uploaded) {
    return BatchTab.Processing;
  }
  if (isReworkType(batch.type)) return BatchTab.Processing;
  return tabForStage(batch.stage);
}

/**
 * Whether the batch has a **Setup** tab. Setup runs once at creation and only
 * for a fresh, multi-item batch — single-item and re-work batches skip it.
 */
export function hasSetup(batch: Batch): boolean {
  return !isReworkType(batch.type) && batch.itemIds.length > 1;
}

/**
 * The tabs available for a batch. Metadata and Processing are always available
 * once a batch exists (revisitable, not a one-way gate); Setup only when the
 * batch {@link hasSetup}.
 */
export function availableTabs(batch: Batch): BatchTab[] {
  const tabs: BatchTab[] = [];
  if (hasSetup(batch)) tabs.push(BatchTab.Setup);
  tabs.push(BatchTab.Metadata, BatchTab.Processing);
  return tabs;
}

/** Which of the three steps (0=Setup, 1=Metadata, 2=Process) a stage sits in. */
export function stepIndexForStage(stage: BatchStage): number {
  switch (stage) {
    case BatchStage.Setup:
      return 0;
    case BatchStage.Metadata:
      return 1;
    case BatchStage.Processing:
    case BatchStage.Ready:
    case BatchStage.Uploaded:
      return 2;
  }
}

/** Progress across the batch's items by completed pipeline runs. */
export interface BatchProgress {
  done: number;
  total: number;
  /** 0–1 fraction (0 when the batch is empty). */
  ratio: number;
}

export function batchProgress(batch: Batch): BatchProgress {
  const total = batch.itemIds.length;
  let done = 0;
  for (const id of batch.itemIds) {
    if (batch.proc[id] === ItemRunStatus.Done) done += 1;
  }
  return { done, total, ratio: total === 0 ? 0 : done / total };
}

/** Member items whose last run failed (drives "Rerun all failed"). */
export function failedItemIds(batch: Batch): string[] {
  return batch.itemIds.filter((id) => batch.proc[id] === ItemRunStatus.Failed);
}

/** The batch currently running the pipeline, if any (single-run invariant). */
export function runningBatch(batches: Batch[]): Batch | null {
  return batches.find((b) => b.running) ?? null;
}

/**
 * Single-run guard: is any batch **other than** `exceptId` currently running?
 * One batch runs at a time per workstation; Start/Rerun is blocked otherwise
 * (docs/tasks/03; consumed by Epic 06 processing).
 */
export function anyOtherRunning(batches: Batch[], exceptId?: string): boolean {
  return batches.some((b) => b.running && b.id !== exceptId);
}

/** The standard "one batch at a time" block message. */
export function singleRunBlockedMessage(running: Batch | null): string {
  const who = running ? batchLabel(running.no) : "Another batch";
  return `${who} is already processing — only one batch runs at a time. Wait for it to finish, then try again.`;
}

/** A batch is "unfinished" (shown on the Batches list; counted in the rail
 * badge) until it uploads/archives. */
export function isUnfinished(batch: Batch): boolean {
  return !isArchived(batch) && batch.stage !== BatchStage.Uploaded;
}

/** The item's effective publish target (its override, else the batch default). */
export function resolveItemPublish(batch: Batch, itemId: string): PublishTarget {
  return batch.overrides[itemId]?.publish ?? batch.publish;
}

/** The item's effective visibility (its override, else the batch default). */
export function resolveItemVisibility(
  batch: Batch,
  itemId: string,
): VisibilityStatus {
  return batch.overrides[itemId]?.visibility ?? batch.visibility;
}

/** "Batch #017" — the human label from the running number (zero-padded to 3). */
export function batchLabel(no: number): string {
  return `Batch #${String(no).padStart(3, "0")}`;
}

/** A batch is stale-running if it was left `running` (only possible after a
 * crash — the app enforces one live run and clears it on completion). */
export function needsRecovery(batch: Batch): boolean {
  return batch.running;
}

/**
 * Downgrade any in-flight (`running`/`queued`) item runs back to `idle`, leaving
 * `done`/`failed` outcomes intact. Shared by crash recovery and the
 * cancel/early-stop path: a run that ends without a terminal event for every
 * scheduled item (a cancel, or a runner that stopped early) must not leave items
 * stuck Queued/Running. Pure; a no-op (same reference) when nothing is in flight.
 */
export function resetInFlightRuns(batch: Batch): Batch {
  const proc: Record<string, ItemRunStatus> = { ...batch.proc };
  let changed = false;
  for (const id of batch.itemIds) {
    if (proc[id] === ItemRunStatus.Running || proc[id] === ItemRunStatus.Queued) {
      proc[id] = ItemRunStatus.Idle;
      changed = true;
    }
  }
  return changed ? { ...batch, proc } : batch;
}

/**
 * Crash recovery: normalise a batch that was left `running` (the app died
 * mid-run) into a **resumable** state — clear `running` and downgrade any
 * in-flight (`running`/`queued`) item runs back to `idle`, leaving `done` /
 * `failed` outcomes intact. Pure — the store persists the result via
 * `batch_update`. Returns the input unchanged when no recovery is needed.
 */
export function recoverBatch(batch: Batch): Batch {
  if (!needsRecovery(batch)) return batch;
  return { ...resetInFlightRuns(batch), running: false };
}

// ── processing-run reducers (Epic 06) ──────────────────────────────────────
// Pure updates the run store applies as pipeline events arrive, then persists
// via `batch_update` (write-through). Kept here beside `recoverBatch` so every
// mutation of the coarse run state (`running` + the `proc` map + `stage`) is a
// single, testable rule set.

/** Set the batch's `running` flag (no-op when unchanged, to avoid a needless
 * write-through). */
export function withRunning(batch: Batch, running: boolean): Batch {
  return batch.running === running ? batch : { ...batch, running };
}

/** Set one member item's run outcome (no-op for a non-member or unchanged
 * value). */
export function withItemRun(
  batch: Batch,
  itemId: string,
  status: ItemRunStatus,
): Batch {
  if (!batch.itemIds.includes(itemId)) return batch;
  if (batch.proc[itemId] === status) return batch;
  return { ...batch, proc: { ...batch.proc, [itemId]: status } };
}

/** Mark the given member items `queued` (scheduling them for a run). Ignores
 * ids that aren't members. */
export function queueItems(batch: Batch, itemIds: string[]): Batch {
  const proc: Record<string, ItemRunStatus> = { ...batch.proc };
  let changed = false;
  for (const id of itemIds) {
    if (batch.itemIds.includes(id) && proc[id] !== ItemRunStatus.Queued) {
      proc[id] = ItemRunStatus.Queued;
      changed = true;
    }
  }
  return changed ? { ...batch, proc } : batch;
}

/** True when every member item's run outcome is `done` (a non-empty batch fully
 * processed). */
export function allItemsDone(batch: Batch): boolean {
  return (
    batch.itemIds.length > 0 &&
    batch.itemIds.every((id) => batch.proc[id] === ItemRunStatus.Done)
  );
}

/**
 * Record that a batch has entered the Metadata step — advances the
 * furthest-stage marker from Setup to Metadata, never regressing a later stage.
 *
 * **Call this when the operator leaves Setup for Metadata.** Without it a
 * multi-item batch is stuck at `setup` until its first processing run, because
 * {@link initialStageFor} only starts a *single-item* batch at Metadata and
 * {@link enterProcessing} was the only other writer. Two visible consequences,
 * both of which contradict "`stage` records the furthest progress reached":
 *
 *  - reopening the batch resets the tab to Setup (`useBatchWork.open` clears the
 *    session tab, so `openTabFor` falls back to `tabForStage(stage)`) — even
 *    after every item's metadata was filled in;
 *  - the three-step indicator never shows Metadata as *active*; it jumps from
 *    Setup straight to Processing and only marks Metadata done retroactively.
 *
 * Added 2026-08-08 as the missing counterpart to `enterProcessing`. The *caller*
 * is still owed by the GUI lane — advancing on tab change is a UI event, and
 * `useBatchWork.setTab` only mutates the session-local tab today.
 */
export function enterMetadata(batch: Batch): Batch {
  if (batch.stage === BatchStage.Setup) {
    return { ...batch, stage: BatchStage.Metadata };
  }
  return batch;
}

/** Record that a batch has entered processing — advances the furthest-stage
 * marker from Setup/Metadata to Processing, never regressing a later stage. */
export function enterProcessing(batch: Batch): Batch {
  if (batch.stage === BatchStage.Setup || batch.stage === BatchStage.Metadata) {
    return { ...batch, stage: BatchStage.Processing };
  }
  return batch;
}

/**
 * The batch stage after a processing run settles: `ready` once every item's run
 * is `done` (Epic 06 acceptance — "reaches ready when all items succeed"),
 * otherwise `processing` (a partial/failed run stays revisitable there). Leaves
 * an already-`uploaded` batch untouched.
 *
 * NB: when Epic 04's metadata working-model lands, the move to `ready` should
 * additionally require every item's metadata to validate; a batch may then bounce
 * back from `ready` to `metadata`/`processing`. That gate composes on top of this
 * — this reducer covers only the processing dimension.
 */
export function settleStageAfterRun(batch: Batch): BatchStage {
  if (batch.stage === BatchStage.Uploaded) return batch.stage;
  return allItemsDone(batch) ? BatchStage.Ready : BatchStage.Processing;
}

/**
 * Build the create payload from {@link CreateBatchInput}, applying defaults:
 * initial stage from type+count, all items `idle`, no parents/overrides, and
 * the conservative publish/visibility defaults unless overridden.
 */
export function newBatchFields(input: CreateBatchInput): NewBatchFields {
  const proc: Record<string, ItemRunStatus> = {};
  for (const id of input.itemIds) proc[id] = ItemRunStatus.Idle;
  return {
    type: input.type,
    itemIds: [...input.itemIds],
    stage: initialStageFor(input.type, input.itemIds.length),
    running: false,
    proc,
    cobissId: input.cobissId ?? null,
    parents: [],
    publish: input.publish ?? DEFAULT_BATCH_PUBLISH,
    visibility: input.visibility ?? DEFAULT_BATCH_VISIBILITY,
    overrides: {},
  };
}
