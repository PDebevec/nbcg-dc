/**
 * `useBatches` (Epic 03) — the view-model the **Batches list** screen binds to
 * (Seam 1: Presentation ↔ Application). `BatchesView.vue` imports only this; it
 * never touches the store, services, or IPC directly.
 *
 * It shapes the unfinished batches into ready-to-render **cards** (number,
 * status pill + running flag, created time, item count, the three-step
 * indicator, and a progress bar), the empty state, the rail badge count, and the
 * open action (navigates to the batch workspace).
 */

import { computed, getCurrentInstance, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { useBatchesStore } from "@stores/useBatches";
import { useToastsStore } from "@stores/useToasts";
import {
  BATCH_STAGE_LABELS,
  BATCH_STEPS,
  batchLabel,
  batchProgress,
  stepIndexForStage,
  type Batch,
  type BatchProgress,
} from "@domain/batch";

/** One step in a card's three-step indicator. */
export interface BatchStepView {
  label: string;
  /** A step the batch has completed (index < the current step). */
  done: boolean;
  /** The step the batch is currently on. */
  active: boolean;
}

/** A fully-shaped Batches-list card. */
export interface BatchCardView {
  id: string;
  /** "Batch #017". */
  label: string;
  /** Status-pill text (the stage label). */
  status: string;
  /** Whether the pill should show a running spinner. */
  running: boolean;
  createdAt: string;
  itemCount: number;
  steps: BatchStepView[];
  progress: BatchProgress;
}

function toCard(batch: Batch): BatchCardView {
  const currentStep = stepIndexForStage(batch.stage);
  return {
    id: batch.id,
    label: batchLabel(batch.no),
    status: BATCH_STAGE_LABELS[batch.stage],
    running: batch.running,
    createdAt: batch.createdAt,
    itemCount: batch.itemIds.length,
    steps: BATCH_STEPS.map((step, i) => ({
      label: step.label,
      done: i < currentStep,
      active: i === currentStep,
    })),
    progress: batchProgress(batch),
  };
}

export function useBatches() {
  const store = useBatchesStore();
  const toasts = useToastsStore();
  const router = useRouter();

  const { unfinished, badgeCount, loading, error, loaded } = storeToRefs(store);

  const cards = computed<BatchCardView[]>(() => unfinished.value.map(toCard));

  /** Show the "No batches yet" empty state once loaded with nothing unfinished. */
  const isEmpty = computed(() => loaded.value && cards.value.length === 0);

  /** Open a batch in the workspace (clicking a card). */
  function open(id: string): void {
    void router.push({ name: "batch-work", params: { batchId: id } });
  }

  /** Go to the Overview to start a new batch (the "+ New from Overview"
   * shortcut / empty-state CTA). */
  function newFromOverview(): void {
    void router.push({ name: "overview" });
  }

  async function refresh(): Promise<void> {
    try {
      await store.load();
    } catch {
      toasts.push("Couldn't refresh batches.", "error");
    }
  }

  async function init(): Promise<void> {
    await store.load();
  }

  if (getCurrentInstance()) onMounted(init);

  return {
    cards,
    isEmpty,
    badgeCount,
    loading,
    error,
    open,
    newFromOverview,
    refresh,
    init,
  };
}
