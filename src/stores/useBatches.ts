/**
 * Batches store (Epic 03) — the reactive collection of local batches.
 *
 * Holds every batch tracked by the native SQLite store and exposes the CRUD the
 * Batches screen + the batch workspace bind to (via composables), plus the
 * cross-cutting rules: the rail-badge count of unfinished batches, the
 * **single-run guard** (`anyOtherRunning`, consumed by Epic 06), and
 * **crash recovery** on load (a batch left `running` after a crash is reset to a
 * resumable state and written back).
 *
 * Creating or archiving a batch changes item↔batch membership native-side, so
 * those actions refresh the items store afterwards to keep the Overview's
 * derived states (In progress ↔ Uploaded) in step.
 */

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
  anyOtherRunning as anyOtherRunningFn,
  isUnfinished,
  needsRecovery,
  recoverBatch,
  runningBatch,
  type Batch,
  type CreateBatchInput,
} from "@domain/batch";
import {
  archiveBatch,
  createBatch,
  listBatches,
  updateBatch,
} from "@services/batches";
import { logger } from "@lib/logger";
import { useItemsStore } from "./useItems";

export const useBatchesStore = defineStore("batches", () => {
  const batches = ref<Batch[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loaded = ref(false);

  // ── derived ───────────────────────────────────────────────────────────────

  const byId = computed(() => {
    const map = new Map<string, Batch>();
    for (const b of batches.value) map.set(b.id, b);
    return map;
  });

  /** Batches shown on the Batches list (and counted in the rail badge). */
  const unfinished = computed(() => batches.value.filter(isUnfinished));

  /** Rail badge count — unfinished batches. */
  const badgeCount = computed(() => unfinished.value.length);

  /** The batch currently running the pipeline, if any (single-run invariant). */
  const running = computed(() => runningBatch(batches.value));

  function get(id: string): Batch | null {
    return byId.value.get(id) ?? null;
  }

  /** Single-run guard: is any batch other than `exceptId` running? */
  function anyOtherRunning(exceptId?: string): boolean {
    return anyOtherRunningFn(batches.value, exceptId);
  }

  // ── mutations ───────────────────────────────────────────────────────────

  function replaceInList(saved: Batch): void {
    const next = batches.value.slice();
    const i = next.findIndex((b) => b.id === saved.id);
    if (i >= 0) next[i] = saved;
    else next.unshift(saved);
    batches.value = next;
  }

  // ── loading + crash recovery ───────────────────────────────────────────────

  /**
   * Reconcile batches left `running` by a crashed prior session into a resumable
   * state (persisted write-through). Best-effort: if the write-back fails, the
   * recovered value is still applied locally. Runs **only on the first load of
   * the session** — see {@link load}.
   */
  async function reconcileCrashedRuns(loadedBatches: Batch[]): Promise<Batch[]> {
    const reconciled: Batch[] = [];
    for (const b of loadedBatches) {
      if (!needsRecovery(b)) {
        reconciled.push(b);
        continue;
      }
      const recovered = recoverBatch(b);
      try {
        reconciled.push(await updateBatch(recovered));
      } catch (err) {
        logger.error(
          "batches",
          `Failed to persist crash-recovery for batch ${b.id}; applying locally.`,
          err,
        );
        reconciled.push(recovered);
      }
    }
    return reconciled;
  }

  /**
   * Load all batches from the native store.
   *
   * Crash recovery runs **only on the first load of the session** (relaunch),
   * per docs/tasks/03 §Concurrency/recovery. `load()` is called on every visit
   * to the Batches screen and on `refresh()`, so recovering on every call would
   * reset a batch that is *legitimately* running right now (once Epic 06 sets
   * `running`), diverging from the native runner and breaking the single-run
   * guard. Gating on `loaded` (a singleton flag, never reset) confines recovery
   * to exactly one pass per app process — the relaunch.
   */
  async function load(): Promise<void> {
    const firstLoad = !loaded.value;
    loading.value = true;
    error.value = null;
    try {
      const loadedBatches = await listBatches();
      batches.value = firstLoad
        ? await reconcileCrashedRuns(loadedBatches)
        : loadedBatches;
      loaded.value = true;
    } catch (err) {
      error.value = (err as Error)?.message ?? "Failed to load batches.";
      logger.error("batches", "Failed to load batches.", err);
    } finally {
      loading.value = false;
    }
  }

  /**
   * Create a batch from a selection, then refresh the items store so the
   * members reflect their new `batchId` (→ In progress). Returns the batch so
   * the caller can navigate to it.
   */
  async function create(input: CreateBatchInput): Promise<Batch> {
    const batch = await createBatch(input);
    replaceInList(batch);
    await useItemsStore().load();
    return batch;
  }

  /** Persist a full batch (write-through). */
  async function update(batch: Batch): Promise<Batch> {
    const saved = await updateBatch(batch);
    replaceInList(saved);
    return saved;
  }

  /**
   * Apply a coarse run update from the pipeline (Epic 06) and write through
   * best-effort. Unlike {@link update}, the in-memory batch is replaced
   * **synchronously** first, so rapid job events (which fold `proc`/`running`/
   * `stage` in quick succession) always read the latest value — a plain
   * `await update()` would leave a stale-read window between events. The
   * write-through is fire-and-forget for **durability only**: it deliberately
   * does NOT re-apply the returned row, because the store is the sole writer of
   * the batch during a run and has already applied `batch` optimistically —
   * re-applying an out-of-order echo could revert newer state (worst case, a
   * stale `running=true`). On write failure the optimistic value is kept (a crash
   * would leave `running` set → recovered on next launch).
   */
  function persistRun(batch: Batch): void {
    replaceInList(batch);
    void updateBatch(batch).catch((err) => {
      logger.error("batches", "Failed to persist run update.", err);
    });
  }

  /**
   * Archive an uploaded batch (releases its items → Uploaded), then refresh the
   * items store so the released members leave In progress. Triggered by the
   * upload flow (Epic 07).
   */
  async function archive(batchId: string): Promise<Batch> {
    const saved = await archiveBatch(batchId);
    replaceInList(saved);
    await useItemsStore().load();
    return saved;
  }

  return {
    // state
    batches,
    loading,
    error,
    loaded,
    // derived
    byId,
    unfinished,
    badgeCount,
    running,
    // queries
    get,
    anyOtherRunning,
    // actions
    load,
    create,
    update,
    persistRun,
    archive,
  };
});
