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
import {
  uploadBatch,
  type ItemUploadResult,
  type UploadItemContext,
  type UploadProgress,
} from "@services/upload";
import { logger } from "@lib/logger";
import { useBatchesStore } from "./useBatches";
import { useItemsStore } from "./useItems";

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
    const batches = useBatchesStore();
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
      const c = new Map(completed.value);
      c.set(batchId, outcome.allUploaded);
      completed.value = c;

      if (outcome.allUploaded) {
        const batch = batches.get(batchId);
        if (batch) {
          try {
            await batches.update({ ...batch, stage: BatchStage.Uploaded });
          } catch (err) {
            logger.warn("upload", "Couldn't mark the batch uploaded.", err);
          }
          try {
            await batches.archive(batchId);
          } catch (err) {
            logger.error("upload", "Uploaded, but couldn't archive the batch.", err);
            error.value = "Uploaded, but the batch could not be archived.";
          }
        }
      }
      // Whatever the outcome, some items may have moved / gained a backend id.
      await useItemsStore().refresh();
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
    run,
  };
});
