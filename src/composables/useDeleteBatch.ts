/**
 * `useDeleteBatch` — the delete-batch confirmation, shared by the Batches list
 * and the batch workspace (docs/superpowers/specs/2026-09-29-delete-batch-design.md).
 *
 * `request(id)` opens the dialog and loads the native dry run; `confirm()`
 * deletes. The delete itself is native — every member's folder and index state
 * go back to their pre-batch snapshot. What only this side can do is stop the
 * members' pending metadata autosaves first (one landing after the restore
 * would write the deleted batch's edits back) and drop the batch's upload
 * results after.
 */

import { computed, ref } from "vue";
import { useBatchesStore } from "@stores/useBatches";
import { useMetadataStore } from "@stores/useMetadata";
import { useUploadStore } from "@stores/useUpload";
import { useToastsStore } from "@stores/useToasts";
import { batchLabel, type BatchDeletePlan } from "@domain/batch";
import { ITEM_STATE_LABELS, deriveItemState } from "@domain/item";
import { logger } from "@lib/logger";

/** One file the delete removes. */
export interface DeleteBatchFileView {
  path: string;
  /** Not named like any of the app's outputs — someone added it by hand. */
  handAdded: boolean;
}

/** One member in the confirmation. */
export interface DeleteBatchItemView {
  id: string;
  name: string;
  /** The state it returns to ("To process", "Uploaded", …), when known. */
  returnsTo: string | null;
  remove: DeleteBatchFileView[];
  restore: string[];
  /** Nothing to remove or put back. */
  unchanged: boolean;
  error: string | null;
}

/** The confirmation's content. */
export interface DeleteBatchPlanView {
  batchId: string;
  /** "Batch #003". */
  label: string;
  /** Made before snapshots: deleting only unlocks its items. */
  legacy: boolean;
  blockedReason: string | null;
  items: DeleteBatchItemView[];
  itemCount: number;
  handAddedCount: number;
}

export function toDeletePlanView(plan: BatchDeletePlan, no: number | null): DeleteBatchPlanView {
  const items = plan.items.map((item) => {
    const remove = item.remove.map((f) => ({ path: f.path, handAdded: !f.generated }));
    return {
      id: item.itemId,
      name: item.folderName,
      returnsTo: item.before ? ITEM_STATE_LABELS[deriveItemState(item.before)] : null,
      remove,
      restore: [...item.restore],
      unchanged: remove.length === 0 && item.restore.length === 0 && item.error == null,
      error: item.error,
    };
  });
  return {
    batchId: plan.batchId,
    label: no != null ? batchLabel(no) : "this batch",
    legacy: !plan.hasSnapshot,
    blockedReason: plan.blockedReason,
    items,
    itemCount: items.length,
    handAddedCount: items.reduce((n, i) => n + i.remove.filter((f) => f.handAdded).length, 0),
  };
}

/** Tauri rejects with the native error as a plain string. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Something went wrong.";
}

export function useDeleteBatch(options: { onDeleted?: (batchId: string) => void } = {}) {
  const batches = useBatchesStore();
  const metadata = useMetadataStore();
  const upload = useUploadStore();
  const toasts = useToastsStore();

  const open = ref(false);
  const loading = ref(false);
  const deleting = ref(false);
  const error = ref<string | null>(null);
  const plan = ref<DeleteBatchPlanView | null>(null);

  /** Delete is possible: the dry run loaded, nothing blocks it, and every
   * member's folder could be compared with its snapshot. */
  const canConfirm = computed(
    () =>
      open.value &&
      !loading.value &&
      !deleting.value &&
      plan.value != null &&
      plan.value.blockedReason == null &&
      plan.value.items.every((i) => i.error == null),
  );

  async function request(batchId: string): Promise<void> {
    open.value = true;
    loading.value = true;
    error.value = null;
    plan.value = null;
    try {
      const preview = await batches.previewDelete(batchId);
      plan.value = toDeletePlanView(preview, batches.get(batchId)?.no ?? null);
    } catch (err) {
      error.value = `Couldn't check what this batch changed: ${messageOf(err)}`;
      logger.error("batches", "Delete preview failed.", err);
    } finally {
      loading.value = false;
    }
  }

  function cancel(): void {
    if (deleting.value) return;
    open.value = false;
    plan.value = null;
    error.value = null;
  }

  async function confirm(): Promise<void> {
    const current = plan.value;
    if (!current || !canConfirm.value) return;
    const memberIds = batches.get(current.batchId)?.itemIds ?? current.items.map((i) => i.id);
    deleting.value = true;
    error.value = null;
    metadata.forget(memberIds);
    try {
      await batches.remove(current.batchId);
    } catch (err) {
      error.value = messageOf(err);
      logger.error("batches", "Batch delete failed.", err);
      deleting.value = false;
      return;
    }
    upload.clearResults(current.batchId);
    deleting.value = false;
    open.value = false;
    plan.value = null;
    toasts.push(
      current.legacy
        ? `${current.label} deleted — its items are unlocked.`
        : `${current.label} deleted — its items are back as they were.`,
      "success",
    );
    options.onDeleted?.(current.batchId);
  }

  return { open, loading, deleting, error, plan, canConfirm, request, cancel, confirm };
}
