/**
 * Pipeline service (Epic 06) — the application-layer orchestration between the
 * domain plan (`domain/pipeline`), the native job runner (`ipc.jobs`), and the
 * run store (`stores/useProcessing`).
 *
 * Two halves:
 *  - **Request building** — turn a {@link Batch} + its {@link Item}s into a
 *    fully-decided {@link BatchRunRequest} (the adaptive branch, skip-if-done,
 *    resolved thumbnail, preserved PDF base names). Pure + testable; no I/O.
 *  - **Drive + observe** — start / cancel / reprocess a run, and subscribe to
 *    the `job://*` events, plus the pure `applyStageChanged` reducer the items
 *    store uses to reflect live per-stage transitions.
 *
 * Non-Tauri fallback (a plain `vite` browser session — the GUI lane's dev mode):
 * request building is pure and always works; the side-effecting calls throw
 * {@link IpcUnavailableError} (via `ipc.jobs`), and the event subscriptions
 * return a no-op unlisten — consistent with `services/indexing` + `batches`.
 */

import { ipc, type BatchRunRequest, type ItemRunRequest, type JobRunMode } from "@ipc/bindings";
import {
  onJobDone,
  onJobProgress,
  onJobStageChanged,
  type JobDoneEvent,
  type JobProgressEvent,
  type JobStageChangedEvent,
} from "@ipc/events";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ItemRunStatus,
  resetInFlightRuns,
  settleStageAfterRun,
  withItemRun,
  withRunning,
  type Batch,
} from "@domain/batch";
import type { Item, StageOutcome } from "@domain/item";
import {
  failedRunnableStages,
  planPipeline,
  processingComplete,
  stagesToRun,
  type ContentKind,
  type RunnableStage,
} from "@domain/pipeline";

/** Options shaping a {@link buildRunRequest} call — the four operator actions
 * map to distinct combinations (see the store wrappers). */
export interface BuildRunOptions {
  mode: JobRunMode;
  /** Restrict the run to these member item ids. Omit → every batch member.
   * (Rerun-failed passes the failed ids; a per-item rerun/reprocess passes one.) */
  itemIds?: string[];
  /** Force re-running stages already `done` (explicit re-process). */
  force?: boolean;
  /** Restrict each item to these stages (a re-process stage pick). Omit → all
   * applicable stages, minus skip-if-done. */
  only?: RunnableStage[] | null;
  /** Operator-chosen primary thumbnail per item id; falls back to the plan's
   * auto-primary, else null (unresolved). */
  primaryThumbnails?: Record<string, string | null>;
  /** Per-item content override (book / graphical work); omit to detect from the
   * filenames. Sourced from `Batch.overrides[itemId].contentKind`. */
  contentKinds?: Record<string, ContentKind | null>;
  /** Per-item spread splitting — split 2-up scans into single pages inside the
   * `pdf` stage. Omit/false to leave scans as they are. */
  splitSpreads?: Record<string, boolean>;
}

/**
 * Build the {@link ItemRunRequest} for one item, or `null` when it has no work
 * to do (every applicable stage already satisfied under the given selection).
 */
export function buildItemRunRequest(
  item: Item,
  opts: BuildRunOptions,
): ItemRunRequest | null {
  const kind = opts.contentKinds?.[item.id] ?? "auto";
  const plan = planPipeline(item.assets, item.folderName, kind);
  const stages = stagesToRun(item.stages, plan, {
    force: opts.force,
    only: opts.only ?? null,
  });
  if (stages.length === 0) return null;

  const primary =
    opts.primaryThumbnails?.[item.id] ??
    plan.thumbnail.autoPrimary?.filename ??
    null;

  return {
    itemId: item.id,
    folderPath: item.folderPath,
    folderName: item.folderName,
    inputShape: plan.inputShape,
    stages,
    primaryThumbnail: primary,
    thumbnailNeedsChoice: plan.thumbnail.needsChoice,
    webPdfBases: plan.candidates
      .filter((c) => c.kind === "web-pdf")
      .map((c) => c.base),
    // Page order is decided here, once, and must not be re-sorted native-side.
    pageImages: plan.pages.map((p) => p.filename),
    splitSpreads: opts.splitSpreads?.[item.id] ?? false,
  };
}

/**
 * Build a whole {@link BatchRunRequest}. Items with nothing to run are dropped,
 * so a request may carry fewer items than the batch (or none — the caller should
 * treat an empty `items` as "nothing to do" and not start a run).
 *
 * **Sources the per-item content override from the batch itself.**
 * `BuildRunOptions.contentKinds` documented itself as "sourced from
 * `Batch.overrides[itemId].contentKind`" but nothing ever did that sourcing —
 * every caller omitted it, so every real run planned with `kind: "auto"` and the
 * operator's book/graphical override was silently inert. That override exists
 * because auto-detection is wrong in *both* directions on real scanner output,
 * and each mistake is damaging (docs/05-real-scan-data.md): a 260-page book read
 * as a graphical work gets no PDF and no OCR. An explicit `opts.contentKinds`
 * still wins, so a caller can override the override.
 */
export function buildRunRequest(
  batch: Batch,
  itemsById: Map<string, Item>,
  opts: BuildRunOptions,
): BatchRunRequest {
  const ids = opts.itemIds ?? batch.itemIds;
  const contentKinds = { ...contentKindsFrom(batch), ...opts.contentKinds };
  const items: ItemRunRequest[] = [];
  for (const id of ids) {
    const item = itemsById.get(id);
    if (!item) continue;
    const req = buildItemRunRequest(item, { ...opts, contentKinds });
    if (req) items.push(req);
  }
  return { batchId: batch.id, mode: opts.mode, items };
}

/** The per-item content overrides recorded on a batch, as `buildItemRunRequest`
 * wants them. Items with no override are omitted, so they fall through to
 * `"auto"` detection. */
function contentKindsFrom(batch: Batch): Record<string, ContentKind | null> {
  const kinds: Record<string, ContentKind | null> = {};
  for (const [itemId, override] of Object.entries(batch.overrides)) {
    if (override?.contentKind != null) kinds[itemId] = override.contentKind;
  }
  return kinds;
}

// ── drive ─────────────────────────────────────────────────────────────────
// Thin wrappers over `ipc.jobs` (which throws IpcUnavailableError outside Tauri).

/** Start a run (Start processing / Rerun). Skip-if-done is already applied. */
export function startRun(request: BatchRunRequest): Promise<void> {
  return ipc.jobs.start(request);
}

/** Cancel the active run for a batch. */
export function cancelRun(batchId: string): Promise<void> {
  return ipc.jobs.cancel(batchId);
}

/** Explicit re-process — force-rebuild the requested stages (marks uploaded
 * items Needs re-upload native-side). */
export function reprocessRun(request: BatchRunRequest): Promise<void> {
  return ipc.jobs.reprocess(request);
}

// ── observe ─────────────────────────────────────────────────────────────────
// Passthroughs keeping the store's native-event access behind this service
// (consistent with `services/indexing.watchIndexChanges`).

export function watchJobProgress(
  handler: (e: JobProgressEvent) => void,
): Promise<UnlistenFn> {
  return onJobProgress(handler);
}

export function watchJobStageChanged(
  handler: (e: JobStageChangedEvent) => void,
): Promise<UnlistenFn> {
  return onJobStageChanged(handler);
}

export function watchJobDone(
  handler: (e: JobDoneEvent) => void,
): Promise<UnlistenFn> {
  return onJobDone(handler);
}

/**
 * Pure reducer: apply a `job://stage-changed` event to an item, returning a new
 * {@link Item} with that stage's recorded status/error/timestamp updated. A
 * no-op (returns the same reference) when the event targets a different item.
 * The items store uses this to reflect live per-stage transitions between the
 * authoritative index refreshes.
 */
export function applyStageChanged(item: Item, event: JobStageChangedEvent): Item {
  if (event.itemId !== item.id) return item;
  const prev = item.stages[event.stage];
  const next: StageOutcome = {
    status: event.status,
    error: event.error ?? null,
    updatedAt: event.at ?? prev.updatedAt ?? null,
  };
  return { ...item, stages: { ...item.stages, [event.stage]: next } };
}

// ── run-status reducers (Epic 06) ───────────────────────────────────────────
// Pure folds of job state → Batch, kept beside the request builder so the whole
// event→state mapping is unit-testable without Pinia. The run store persists the
// results (write-through via `useBatches.persistRun`).

/**
 * The coarse run status an item deserves purely from its **recorded processing
 * state** (independent of the current run): `done` once every applicable script
 * stage is complete and the thumbnail is resolved, `failed` when an applicable
 * stage failed, else `idle`. This is what lets a batch member that is already
 * processed — and therefore excluded from a run (skip-if-done drops it) — still
 * count toward the batch reaching Ready.
 */
export function procFromProcessing(
  item: Item,
  kind: ContentKind = "auto",
): ItemRunStatus {
  // The kind must match the one the run used: it changes which stages are
  // applicable, so reading status under "auto" for an item the operator forced
  // to `graphical` would judge completeness against the wrong stage set.
  const plan = planPipeline(item.assets, item.folderName, kind);
  if (processingComplete(item.stages, plan)) return ItemRunStatus.Done;
  if (failedRunnableStages(item.stages, plan).length > 0) return ItemRunStatus.Failed;
  return ItemRunStatus.Idle;
}

/**
 * Seed a batch's `proc` map from every member's actual processing state, so an
 * already-complete member reads `done` rather than the stale `idle` that would
 * otherwise keep the batch stuck in Processing. The caller overlays `queued` on
 * the items it is about to run. Skips ids missing from the map.
 */
export function seedProcFromItems(
  batch: Batch,
  itemsById: Map<string, Item>,
): Batch {
  let b = batch;
  for (const id of batch.itemIds) {
    const item = itemsById.get(id);
    if (item) b = withItemRun(b, id, procFromProcessing(item));
  }
  return b;
}

/** The result of folding a `job://done` into a batch. */
export interface JobDoneReduction {
  batch: Batch;
  /** True on the run's terminal event — the caller clears live state + refreshes
   * items. */
  batchComplete: boolean;
}

/**
 * Pure fold of a `job://done` event into a batch: set the item's coarse outcome
 * (`done`/`failed`; a `cancelled` item drops back to `idle`), and on the terminal
 * event clear `running`, reset any still-in-flight items (a cancel leaves items
 * without a terminal event), and settle the stage (→ `ready` once every member
 * is `done`).
 */
export function applyJobDone(batch: Batch, event: JobDoneEvent): JobDoneReduction {
  let b = batch;
  if (event.itemId) {
    const status =
      event.outcome === "done"
        ? ItemRunStatus.Done
        : event.outcome === "failed"
          ? ItemRunStatus.Failed
          : ItemRunStatus.Idle;
    b = withItemRun(b, event.itemId, status);
  }
  if (event.batchComplete) {
    b = resetInFlightRuns(withRunning(b, false));
    b = { ...b, stage: settleStageAfterRun(b) };
  }
  return { batch: b, batchComplete: event.batchComplete };
}
