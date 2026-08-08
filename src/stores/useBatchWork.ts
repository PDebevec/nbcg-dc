/**
 * Batch-work session store (Epic 03) — the state of the **currently-open**
 * batch: which batch, which tab, and the READ-ONLY / unlock state.
 *
 * It reads the batch from {@link useBatchesStore} (the single source of truth
 * for batch data) and layers on the transient, session-only working state that
 * doesn't belong in the persisted batch:
 *  - `activeTab` — the operator's explicit tab pick (falls back to
 *    {@link openTabFor} until they choose, so a late-loading batch still lands
 *    on the right tab);
 *  - `unlocked` — whether a read-only (Done) batch has been unlocked for re-work
 *    via **Edit / re-process** (not persisted; a fresh open re-locks it).
 */

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
  BatchTab,
  availableTabs as availableTabsFn,
  enterMetadata,
  isArchived,
  openTabFor,
  requiresUnlock,
  type Batch,
} from "@domain/batch";
import { useBatchesStore } from "./useBatches";

export const useBatchWorkStore = defineStore("batchWork", () => {
  const batches = useBatchesStore();

  const currentId = ref<string | null>(null);
  /** The operator's explicit tab pick; null means "use the default for the
   * batch's stage" (see {@link resolvedTab}). */
  const activeTab = ref<BatchTab | null>(null);
  /** Whether a read-only (Done) batch has been unlocked for re-work this session. */
  const unlocked = ref(false);

  const current = computed<Batch | null>(() =>
    currentId.value ? batches.get(currentId.value) : null,
  );

  const availableTabs = computed<BatchTab[]>(() =>
    current.value ? availableTabsFn(current.value) : [],
  );

  /** The tab actually shown: the explicit pick if still valid, else the default
   * for the batch's stage (resolves once the batch has loaded). */
  const resolvedTab = computed<BatchTab | null>(() => {
    const b = current.value;
    if (!b) return null;
    if (activeTab.value && availableTabs.value.includes(activeTab.value)) {
      return activeTab.value;
    }
    return openTabFor(b);
  });

  /** Whether the open batch offers the Edit / re-process unlock affordance. */
  const showsUnlock = computed<boolean>(
    () => current.value != null && requiresUnlock(current.value),
  );

  /** Whether the open batch is read-only right now (archived, or a Done batch
   * not yet unlocked). Edits/re-runs are blocked while true. */
  const readOnly = computed<boolean>(() => {
    const b = current.value;
    if (!b) return false;
    if (isArchived(b)) return true;
    return requiresUnlock(b) && !unlocked.value;
  });

  // ── actions ─────────────────────────────────────────────────────────────

  /** Open a batch by id — resets the tab pick + re-locks (a fresh open of a
   * Done batch is always read-only until re-unlocked). */
  function open(id: string): void {
    currentId.value = id;
    activeTab.value = null;
    unlocked.value = false;
  }

  /**
   * Switch tabs (no-op for an unavailable tab, e.g. Setup on a single-item
   * batch), advancing the batch's furthest-stage marker if this moves it on.
   *
   * The advance lives **here**, not in the view. `Batch.stage` records the
   * furthest progress reached, but only `initialStageFor` (at create) and
   * `enterProcessing` ever wrote it — so a multi-item batch sat at `setup` until
   * its first processing run however much metadata work was done, and reopening
   * it dropped the operator back on Setup (`open()` clears the session tab, so
   * `resolvedTab` falls back to `tabForStage`). `enterMetadata` existed as the
   * missing counterpart but had no caller; a doc note assigning that caller to
   * the GUI left the fix inert, which is the failure this project keeps
   * repeating. Persisting where the tab actually changes needs no view code and
   * cannot be forgotten.
   */
  function setTab(tab: BatchTab): void {
    if (!availableTabs.value.includes(tab)) return;
    activeTab.value = tab;
    advanceStageFor(tab);
  }

  /**
   * Move `stage` forward for a tab the operator just entered. Fire-and-forget via
   * `persistRun`: a tab switch must stay instant, and the marker is a progress
   * hint — a failed write is retried by the next switch, not worth blocking on.
   *
   * `enterMetadata` owns the "never regress" rule and returns the same object
   * when there is nothing to do, so this is safe to call on every switch.
   */
  function advanceStageFor(tab: BatchTab): void {
    const b = current.value;
    if (!b || tab !== BatchTab.Metadata) return;
    const next = enterMetadata(b);
    if (next !== b) batches.persistRun(next);
  }

  /** Unlock a read-only (Done) batch for re-work (docs/01 "Editing a published
   * item is deliberate"). Only meaningful when {@link showsUnlock}. */
  function unlock(): void {
    if (showsUnlock.value) unlocked.value = true;
  }

  /** Clear the session (e.g. leaving the workspace). */
  function close(): void {
    currentId.value = null;
    activeTab.value = null;
    unlocked.value = false;
  }

  return {
    // state
    currentId,
    unlocked,
    // derived
    current,
    availableTabs,
    resolvedTab,
    showsUnlock,
    readOnly,
    // actions
    open,
    setTab,
    unlock,
    close,
  };
});
