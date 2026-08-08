/**
 * `useBatch` (Epic 03) — the view-model the **batch workspace** binds to
 * (Seam 1: Presentation ↔ Application). `BatchWorkView.vue` imports only this
 * and passes its `batchId` route prop; the per-tab content (Setup / Metadata /
 * Processing) is authored against its own composable in later epics
 * (`useMetadataForm` — 04, `useProcessing` — 06).
 *
 * It provides the **shell**: the batch header (number, status pill, READ-ONLY
 * badge + Edit/re-process unlock, "all changes saved" / "Archived" indicator),
 * the three-step indicator, the available-tabs bar with the active tab, tab
 * switching, the back control, and the **single-run guard** signals the
 * Processing tab consumes.
 */

import {
  computed,
  getCurrentInstance,
  onMounted,
  onUnmounted,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { useBatchesStore } from "@stores/useBatches";
import { useBatchWorkStore } from "@stores/useBatchWork";
import {
  BATCH_STAGE_LABELS,
  BATCH_STEPS,
  BATCH_TAB_LABELS,
  batchLabel,
  batchProgress,
  singleRunBlockedMessage,
  stepIndexForStage,
  type BatchProgress,
  type BatchTab,
} from "@domain/batch";

/** The batch header view (null when the id doesn't resolve to a batch). */
export interface BatchHeaderView {
  id: string;
  /** "Batch #017". */
  label: string;
  /** Status-pill text (the stage label). */
  status: string;
  running: boolean;
  itemCount: number;
  /** Whether the batch is read-only right now (archived, or Done-not-unlocked). */
  readOnly: boolean;
  /** Whether the Edit / re-process unlock control should show. */
  showsUnlock: boolean;
  /** "Archived" once uploaded, else "All changes saved". */
  savedLabel: string;
  progress: BatchProgress;
}

/** One tab in the workspace tab bar. */
export interface BatchTabView {
  key: BatchTab;
  label: string;
  active: boolean;
}

/** One step in the three-step indicator. */
export interface BatchStepView {
  label: string;
  done: boolean;
  active: boolean;
}

export function useBatch(batchId: MaybeRefOrGetter<string>) {
  const batches = useBatchesStore();
  const work = useBatchWorkStore();
  const router = useRouter();

  const { current, resolvedTab, availableTabs, readOnly, showsUnlock } =
    storeToRefs(work);
  const { running: runningBatchRef } = storeToRefs(batches);

  // Bind the session to the route's batch id — on mount and whenever it changes
  // (opening a different batch re-locks + resets the tab pick).
  watch(
    () => toValue(batchId),
    (id) => {
      if (id) work.open(id);
    },
    { immediate: true },
  );

  const header = computed<BatchHeaderView | null>(() => {
    const b = current.value;
    if (!b) return null;
    return {
      id: b.id,
      label: batchLabel(b.no),
      status: BATCH_STAGE_LABELS[b.stage],
      running: b.running,
      itemCount: b.itemIds.length,
      readOnly: readOnly.value,
      showsUnlock: showsUnlock.value,
      savedLabel: b.archivedAt != null ? "Archived" : "All changes saved",
      progress: batchProgress(b),
    };
  });

  const tabs = computed<BatchTabView[]>(() =>
    availableTabs.value.map((key) => ({
      key,
      label: BATCH_TAB_LABELS[key],
      active: key === resolvedTab.value,
    })),
  );

  const steps = computed<BatchStepView[]>(() => {
    const b = current.value;
    const currentStep = b ? stepIndexForStage(b.stage) : -1;
    return BATCH_STEPS.map((step, i) => ({
      label: step.label,
      done: i < currentStep,
      active: i === currentStep,
    }));
  });

  /** Whether this batch is blocked from starting/rerunning because another
   * batch is running (single-run guard; consumed by the Processing tab, Epic 06). */
  const runBlocked = computed(() =>
    current.value ? batches.anyOtherRunning(current.value.id) : false,
  );

  /** The block message when {@link runBlocked}, else null. */
  const runBlockedMessage = computed<string | null>(() =>
    runBlocked.value ? singleRunBlockedMessage(runningBatchRef.value) : null,
  );

  // ── actions ─────────────────────────────────────────────────────────────

  function setTab(tab: BatchTab): void {
    work.setTab(tab);
  }

  /** Edit / re-process — unlock a read-only (Done) batch for re-work. */
  function unlock(): void {
    work.unlock();
  }

  /** Back to the Batches list. */
  function back(): void {
    void router.push({ name: "batches" });
  }

  // Ensure the batches store is populated even when the workspace is the first
  // (or only) screen reached — a deep-link/reload onto /batches/:id, or opening
  // an In-progress item from a cold store — so `current`/`header` resolve
  // instead of staying null. Load-if-cold (not an unconditional refresh): the
  // singleton store is normally already primed at boot / by the Batches list,
  // and re-loading could clobber in-session state. Mirrors useOverview/useBatches.
  async function init(): Promise<void> {
    if (!batches.loaded) await batches.load();
  }

  if (getCurrentInstance()) {
    onMounted(init);
    onUnmounted(() => work.close());
  }

  return {
    // shell state
    header,
    tabs,
    steps,
    activeTab: resolvedTab,
    readOnly,
    // single-run guard (Epic 06 seam)
    runBlocked,
    runBlockedMessage,
    // actions
    setTab,
    unlock,
    back,
  };
}
