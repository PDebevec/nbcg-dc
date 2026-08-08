/**
 * Processing-run store (Epic 06) — drives the local pipeline for a batch and
 * folds the `job://*` events back into state.
 *
 * Responsibilities:
 *  - the operator run actions — **Start processing**, per-item **Rerun**,
 *    **Rerun all failed**, explicit **Re-process**, and **Cancel** — each guarded
 *    by the single-run lock (`useBatches.anyOtherRunning`);
 *  - the **job-event bridge** (started once at boot): translate native events
 *    into coarse batch state (`running` + the `proc` map + `stage`, persisted
 *    write-through via `useBatches`) and live per-stage item updates
 *    (`useItems`), plus the ephemeral live-progress feed the Processing tab reads.
 *
 * The batch row is **logic-lane-owned**: the native runner writes item stage
 * statuses + emits events but never the batch row — this store is its sole
 * writer, so `running`/`proc`/`stage` stay consistent with the single-run guard.
 *
 * The GUI-facing view-model (`composables/useProcessing`) is deferred with the
 * Processing tab `.vue`; it will bind this store's state + actions.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ItemRunStatus,
  allItemsDone,
  enterProcessing,
  failedItemIds,
  isArchived,
  queueItems,
  resetInFlightRuns,
  settleStageAfterRun,
  withItemRun,
  withRunning,
  type Batch,
} from "@domain/batch";
import type { Item } from "@domain/item";
import type { RunnableStage } from "@domain/pipeline";
import type { BatchRunRequest } from "@ipc/bindings";
import type {
  JobDoneEvent,
  JobProgressEvent,
  JobStageChangedEvent,
} from "@ipc/events";
import {
  applyJobDone,
  applyStageChanged,
  buildRunRequest,
  cancelRun,
  reprocessRun,
  seedProcFromItems,
  startRun,
  watchJobDone,
  watchJobProgress,
  watchJobStageChanged,
} from "@services/pipeline";
import { logger } from "@lib/logger";
import { useBatchesStore } from "./useBatches";
import { useItemsStore } from "./useItems";

/** How many log lines to keep in the ephemeral run log. */
const LOG_CAP = 200;

export const useProcessingStore = defineStore("processing", () => {
  /** The batch this session started running, or null. Mirrors the native run;
   * the authoritative `running` flag lives on the batch (`useBatches`). */
  const activeBatchId = ref<string | null>(null);
  /** Latest live progress per item id (ephemeral — cleared each run). */
  const progress = ref<Map<string, JobProgressEvent>>(new Map());
  /** Recent run-log lines (capped), newest last. */
  const log = ref<string[]>([]);
  /** Last action error (start/cancel), for a toast. */
  const error = ref<string | null>(null);

  const isRunning = computed(() => activeBatchId.value != null);

  // ── helpers ─────────────────────────────────────────────────────────────

  function itemsMap(): Map<string, Item> {
    const map = new Map<string, Item>();
    for (const it of useItemsStore().items) map.set(it.id, it);
    return map;
  }

  function resetLive(): void {
    progress.value = new Map();
    log.value = [];
  }

  function pushLog(line: string): void {
    const next = log.value.length >= LOG_CAP ? log.value.slice(1) : log.value.slice();
    next.push(line);
    log.value = next;
  }

  /**
   * Launch a built request: optimistically mark the batch running + its
   * scheduled items queued (persisted so the single-run guard + reopened views
   * see it immediately), then hand off to the native runner. On a start failure
   * (never launched natively) revert `running`.
   */
  async function launch(
    batch: Batch,
    request: BatchRunRequest,
    drive: (r: BatchRunRequest) => Promise<void>,
  ): Promise<void> {
    const batches = useBatchesStore();
    error.value = null;
    const runIds = request.items.map((i) => i.itemId);
    // Seed proc from each member's actual processing state (already-complete
    // members read `done`, so the batch can still reach Ready), then overlay
    // `queued` on the items this run will actually process.
    const seeded = seedProcFromItems(batch, itemsMap());
    const next = withRunning(enterProcessing(queueItems(seeded, runIds)), true);
    batches.persistRun(next);
    activeBatchId.value = batch.id;
    resetLive();
    try {
      await drive(request);
    } catch (err) {
      logger.error("processing", "Failed to start the run.", err);
      error.value = (err as Error)?.message ?? "Failed to start processing.";
      // The run never launched natively, so no job://done will arrive to settle
      // the items we optimistically queued — reset them here (symmetric with the
      // onDone batch-complete path), else they stay stuck Queued with
      // running=false (crash recovery won't help: it gates on running===true).
      const current = batches.get(batch.id) ?? next;
      batches.persistRun(withRunning(resetInFlightRuns(current), false));
      activeBatchId.value = null;
    }
  }

  /** Guarded resolve of a batch for an action: returns it unless missing or
   * another batch is already running. */
  function resolveRunnable(batchId: string): Batch | null {
    const batches = useBatchesStore();
    const batch = batches.get(batchId);
    if (!batch) return null;
    if (isArchived(batch)) {
      logger.warn("processing", `Run blocked — batch ${batchId} is archived.`);
      return null;
    }
    // One run at a time — block when this batch is already running (no
    // double-start) or any other batch is (the single-run lock).
    if (batch.running || batches.anyOtherRunning(batchId)) {
      logger.warn("processing", `Run blocked — a batch is already processing.`);
      return null;
    }
    return batch;
  }

  // ── actions ─────────────────────────────────────────────────────────────

  /** Start processing every member item that has work to do (skip-if-done). */
  async function start(batchId: string): Promise<void> {
    const batch = resolveRunnable(batchId);
    if (!batch) return;
    const request = buildRunRequest(batch, itemsMap(), { mode: "run" });
    if (request.items.length === 0) {
      // Nothing left to run. If every member is actually processed, advance the
      // batch to Ready (e.g. a re-work batch whose items are all complete);
      // otherwise there's a genuine blocker (e.g. an unresolved thumbnail choice).
      const seeded = seedProcFromItems(batch, itemsMap());
      if (allItemsDone(seeded)) {
        useBatchesStore().persistRun({
          ...withRunning(seeded, false),
          stage: settleStageAfterRun(seeded),
        });
      } else {
        logger.info("processing", `Nothing runnable for batch ${batchId}.`);
      }
      return;
    }
    await launch(batch, request, startRun);
  }

  /** Re-run one item's outstanding stages (its failed stage + any downstream
   * stages left pending by the failure). */
  async function rerunItem(batchId: string, itemId: string): Promise<void> {
    const batch = resolveRunnable(batchId);
    if (!batch) return;
    const request = buildRunRequest(batch, itemsMap(), {
      mode: "rerun",
      itemIds: [itemId],
    });
    if (request.items.length === 0) return;
    await launch(batch, request, startRun);
  }

  /** Re-run every failed item in the batch. */
  async function rerunFailed(batchId: string): Promise<void> {
    const batch = resolveRunnable(batchId);
    if (!batch) return;
    const request = buildRunRequest(batch, itemsMap(), {
      mode: "rerun",
      itemIds: failedItemIds(batch),
    });
    if (request.items.length === 0) return;
    await launch(batch, request, startRun);
  }

  /** Explicit re-process — force-rebuild the chosen stages of one item,
   * overwriting old outputs (marks an uploaded item Needs re-upload native-side). */
  async function reprocess(
    batchId: string,
    itemId: string,
    stages: RunnableStage[],
  ): Promise<void> {
    const batch = resolveRunnable(batchId);
    if (!batch) return;
    const request = buildRunRequest(batch, itemsMap(), {
      mode: "reprocess",
      itemIds: [itemId],
      only: stages,
      force: true,
    });
    if (request.items.length === 0) return;
    await launch(batch, request, reprocessRun);
  }

  /** Cancel the active run. The native runner emits a terminal `job://done`
   * (`cancelled`, `batchComplete`) which the bridge folds in to clear `running`. */
  async function cancel(batchId: string): Promise<void> {
    try {
      await cancelRun(batchId);
    } catch (err) {
      logger.error("processing", "Failed to cancel the run.", err);
      error.value = (err as Error)?.message ?? "Failed to cancel processing.";
    }
  }

  // ── job-event bridge ──────────────────────────────────────────────────────

  function onProgress(event: JobProgressEvent): void {
    const next = new Map(progress.value);
    next.set(event.itemId, event);
    progress.value = next;
    if (event.message) pushLog(`${event.itemId} · ${event.stage}: ${event.message}`);
  }

  function onStageChanged(event: JobStageChangedEvent): void {
    const items = useItemsStore();
    const item = items.items.find((i) => i.id === event.itemId);
    if (item) items.replaceItem(applyStageChanged(item, event));

    // Reflect coarse Running in the batch proc on the first stage that starts, so
    // the live per-item list shows queued → running → done/failed. Leave a
    // terminal outcome (done/failed) untouched against out-of-order events.
    if (event.status === "running") {
      const batches = useBatchesStore();
      const batch = batches.get(event.batchId);
      const prior = batch?.proc[event.itemId];
      if (
        batch &&
        prior !== ItemRunStatus.Done &&
        prior !== ItemRunStatus.Failed &&
        prior !== ItemRunStatus.Running
      ) {
        batches.persistRun(withItemRun(batch, event.itemId, ItemRunStatus.Running));
      }
    }

    pushLog(
      `${event.itemId} · ${event.stage} → ${event.status}` +
        (event.error ? `: ${event.error}` : ""),
    );
  }

  function onDone(event: JobDoneEvent): void {
    const batches = useBatchesStore();
    const batch = batches.get(event.batchId);
    if (!batch) return;
    const { batch: next, batchComplete } = applyJobDone(batch, event);
    if (batchComplete) {
      if (activeBatchId.value === event.batchId) activeBatchId.value = null;
      progress.value = new Map();
      // Pull the authoritative stage statuses + dirty flags the runner wrote.
      void useItemsStore().refresh();
    }
    batches.persistRun(next);
  }

  let unlisteners: UnlistenFn[] = [];
  let watchGen = 0;

  /** Subscribe to the job events (idempotent; safe against overlapping
   * start/stop). Started once at boot so coarse run state persists regardless of
   * which screen is mounted. Outside Tauri the handlers never fire. */
  async function startWatch(): Promise<void> {
    if (unlisteners.length) return;
    const gen = ++watchGen;
    const fns = await Promise.all([
      watchJobStageChanged(onStageChanged),
      watchJobDone(onDone),
      watchJobProgress(onProgress),
    ]);
    if (gen !== watchGen || unlisteners.length) {
      fns.forEach((f) => f());
      return;
    }
    unlisteners = fns;
  }

  function stopWatch(): void {
    watchGen++;
    unlisteners.forEach((f) => f());
    unlisteners = [];
  }

  return {
    // state
    activeBatchId,
    progress,
    log,
    error,
    // derived
    isRunning,
    // actions
    start,
    rerunItem,
    rerunFailed,
    reprocess,
    cancel,
    // bridge lifecycle
    startWatch,
    stopWatch,
  };
});
