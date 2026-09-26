/**
 * Upload-run store (Epic 07) — wraps `services/upload.uploadBatch` with the
 * reactive run state the Processing & Upload tab reads (live progress, per-item
 * results) and the terminal coordination the service deliberately leaves to a
 * store: on an all-`uploaded` run the batch is marked `uploaded`, archived
 * (READ-ONLY, items released) and the items index refreshed.
 *
 * One upload runs at a time (the backend/disk work is heavy and the batch is
 * the unit of work); a second `run()` while one is active is ignored.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { BatchStage } from "@domain/batch";
import type { Item } from "@domain/item";
import { missingParentMessage } from "@domain/parent";
import {
  cleanupUnfinishedRecords,
  uploadBatch,
  type ItemUploadResult,
  type UploadItemContext,
  type UploadProgress,
} from "@services/upload";
import { logger } from "@lib/logger";
import { useBatchesStore } from "./useBatches";
import { useItemsStore } from "./useItems";
import { useMetadataStore } from "./useMetadata";

export const useUploadStore = defineStore("upload", () => {
  /** The batch currently uploading, or null. */
  const activeBatchId = ref<string | null>(null);
  /** Live progress of the active run. */
  const progress = ref<UploadProgress | null>(null);
  /** Per-item results of the **last** run per batch (kept after the run so the
   * tab can show them; keyed by batch id → item id). */
  const results = ref<Map<string, Map<string, ItemUploadResult>>>(new Map());
  /** Last run-level error (a bug / unexpected rejection), for a toast. */
  const error = ref<string | null>(null);
  /** Whether the last run for a batch uploaded every item. */
  const completed = ref<Map<string, boolean>>(new Map());

  const isRunning = computed(() => activeBatchId.value != null);

  function resultsFor(batchId: string): Map<string, ItemUploadResult> {
    return results.value.get(batchId) ?? new Map();
  }

  function setResult(batchId: string, res: ItemUploadResult): void {
    const all = new Map(results.value);
    const mine = new Map(all.get(batchId) ?? new Map<string, ItemUploadResult>());
    mine.set(res.itemId, res);
    all.set(batchId, mine);
    results.value = all;
  }

  function clearResults(batchId: string): void {
    const all = new Map(results.value);
    all.delete(batchId);
    results.value = all;
    const c = new Map(completed.value);
    c.delete(batchId);
    completed.value = c;
  }

  /**
   * Mark a batch finished and archive it, regardless of whether every item
   * uploaded.
   *
   * `run()` calls this automatically on an all-`uploaded` outcome. It is exposed
   * so the operator can also close a batch they have decided is done — an item
   * that legitimately cannot upload (duplicate that only needs a Sync, a blocked
   * folder they will redo later) would otherwise pin the batch "In progress"
   * with no way out, since this is the only archive call site in the app.
   *
   * `options.cleanup` additionally removes the backend records this batch
   * created and left unfinished (see `services/upload.removableBackendIds`) —
   * a create that succeeded but whose asset upload didn't, stranding a record
   * on the live website with metadata and no files. Cleanup is best-effort
   * (`cleanupUnfinishedRecords` never throws): the close the operator asked
   * for must still complete even if the delete fails.
   */
  async function closeBatch(
    batchId: string,
    options: { cleanup?: boolean } = {},
  ): Promise<void> {
    error.value = null;
    if (options.cleanup) {
      const cleaned = await cleanupUnfinishedRecords(resultsFor(batchId).values());
      if (!cleaned) {
        error.value =
          "The batch was closed, but unfinished records could not be removed from the backend.";
      }
    }
    const batches = useBatchesStore();
    const batch = batches.get(batchId);
    if (batch) {
      try {
        await batches.update({ ...batch, stage: BatchStage.Uploaded });
      } catch (err) {
        logger.warn("upload", "Couldn't mark the batch uploaded.", err);
      }
    }
    try {
      await batches.archive(batchId);
    } catch (err) {
      logger.error("upload", "Couldn't archive the batch.", err);
      error.value = "The batch could not be archived.";
    }
  }

  /**
   * Upload a batch's items. `resolveContext` supplies each item's publish
   * decisions + working metadata + readiness (from the batch + metadata store).
   * Returns true when every item uploaded (the batch is then archived).
   */
  async function run(
    batchId: string,
    items: Item[],
    resolveContext: (item: Item) => UploadItemContext | Promise<UploadItemContext>,
  ): Promise<boolean> {
    if (activeBatchId.value) {
      logger.warn("upload", "Upload ignored — another upload is running.");
      return false;
    }
    if (items.length === 0) return false;
    activeBatchId.value = batchId;
    error.value = null;
    clearResults(batchId);
    progress.value = null;
    try {
      const outcome = await uploadBatch(items, {
        resolveContext,
        onProgress: (p) => {
          progress.value = p;
        },
      });
      for (const res of outcome.results) setResult(batchId, res);
      if (outcome.missingParentIds.length > 0) {
        const metadata = useMetadataStore();
        metadata.markParentsGone(outcome.missingParentIds);
        const names = outcome.missingParentIds.map((id) => metadata.parentRecords.get(id)?.title ?? id);
        error.value = missingParentMessage(names, true);
      }
      const c = new Map(completed.value);
      c.set(batchId, outcome.allUploaded);
      completed.value = c;

      if (outcome.allUploaded) {
        await closeBatch(batchId);
      }
      // Whatever the outcome, some items may have moved / gained a backend id.
      const itemsStore = useItemsStore();
      await itemsStore.refresh();
      // The editor must see both: the new backend link locks Draft/Record and
      // is what a re-upload diffs against; the new folder is where it autosaves.
      const ran = new Set(items.map((i) => i.id));
      await useMetadataStore().reloadMirrors(itemsStore.items.filter((i) => ran.has(i.id)));
      return outcome.allUploaded;
    } catch (err) {
      error.value = (err as Error)?.message ?? "Upload failed unexpectedly.";
      logger.error("upload", "Upload run failed.", err);
      return false;
    } finally {
      activeBatchId.value = null;
      progress.value = null;
    }
  }

  return {
    activeBatchId,
    progress,
    results,
    completed,
    error,
    isRunning,
    resultsFor,
    clearResults,
    closeBatch,
    run,
  };
});
