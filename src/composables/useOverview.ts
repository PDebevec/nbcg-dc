/**
 * `useOverview` (Epic 02) — the view-model the Overview screen binds to
 * (Seam 1: Presentation ↔ Application). The `.vue` view imports only this; it
 * never touches the store, services, or IPC directly.
 *
 * It shapes the {@link useItemsStore} into ready-to-render **rows** (derived
 * state, stage pips, error text, selection/lock flags), the segmented **filter**
 * bar with live counts, the search box, and the selection/Create-batch signals,
 * plus the row actions (toggle/open/reveal).
 *
 * Cross-epic seams: `createBatch`, `openAsBatch`, and `openItem` create a batch
 * (via `useBatches`) and navigate to the batch workspace — wired in **Epic 03
 * (Batches)**. Selection is state-scoped, so a Create-batch selection is always
 * one item state → the batch's `type`.
 */

import { computed, getCurrentInstance, onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { useItemsStore } from "@stores/useItems";
import { useToastsStore } from "@stores/useToasts";
import { useBatchesStore } from "@stores/useBatches";
import type { CreateBatchInput } from "@domain/batch";
import {
  STAGE_NAMES,
  STAGE_LABELS,
  ITEM_STATE_LABELS,
  deriveItemState,
  stagePipStatus,
  firstStageError,
  type Item,
  type ItemState,
  type ItemLevel,
  type StageName,
  type StagePipStatus,
} from "@domain/item";
import {
  OVERVIEW_FILTERS,
  OverviewFilter,
  depthOf,
  isSelectableFilter,
} from "@domain/overview";
import { logger } from "@lib/logger";

/** One stage indicator in a row. */
export interface StagePipView {
  stage: StageName;
  label: string;
  status: StagePipStatus;
}

/** A fully-shaped Overview table row. */
export interface OverviewRow {
  id: string;
  folderName: string;
  /** Path relative to this item's scan root — equal to `folderName` at
   * depth 1. Shown as a muted sub-line for a nested row. */
  relativePath: string;
  /** How deeply nested this row is (`0` = depth 1, every row before
   * recursive discovery existed). Drives table indentation. */
  depth: number;
  title: string | null;
  catalogueId: string | null;
  level: ItemLevel;
  state: ItemState;
  stateLabel: string;
  pips: StagePipView[];
  /** Failure message on a Stopped row, else null. */
  errorMessage: string | null;
  selected: boolean;
  /** Whether this row can be selected under the active filter. */
  selectable: boolean;
  /** In-progress rows are locked to their batch (show a lock icon). */
  locked: boolean;
  /** Operator-hidden — only ever true when shown via the "Show hidden" toggle
   * (a hidden row is otherwise excluded from `visibleItems` entirely). */
  hidden: boolean;
}

/** One entry in the segmented filter bar. */
export interface FilterView {
  key: OverviewFilter;
  label: string;
  count: number;
  active: boolean;
}

function toRow(item: Item, selected: boolean, selectable: boolean): OverviewRow {
  const state = deriveItemState(item);
  return {
    id: item.id,
    folderName: item.folderName,
    relativePath: item.relativePath,
    depth: depthOf(item.relativePath),
    title: item.title,
    catalogueId: item.catalogueId,
    level: item.level,
    state,
    stateLabel: ITEM_STATE_LABELS[state],
    pips: STAGE_NAMES.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      status: stagePipStatus(item, stage),
    })),
    errorMessage: firstStageError(item),
    selected,
    selectable,
    locked: state === "in-progress",
    hidden: item.hidden,
  };
}

export function useOverview() {
  const store = useItemsStore();
  const toasts = useToastsStore();
  const batches = useBatchesStore();
  const router = useRouter();
  const {
    loading,
    error,
    activeFilter,
    search,
    counts,
    selectable,
    visibleItems,
    selectionCount,
    canCreateBatch,
    allVisibleSelected,
    showHidden,
    peekResult,
    peekLoading,
    peekError,
  } = storeToRefs(store);

  const rows = computed<OverviewRow[]>(() =>
    visibleItems.value.map((item) =>
      toRow(item, store.isSelected(item.id), selectable.value),
    ),
  );

  /** Stage column headers, in pipeline order (single source: domain/item). */
  const stageColumns: readonly string[] = STAGE_NAMES.map((s) => STAGE_LABELS[s]);

  const filters = computed<FilterView[]>(() =>
    OVERVIEW_FILTERS.map((f) => ({
      key: f.key,
      label: f.label,
      count: counts.value[f.key],
      active: f.key === activeFilter.value,
    })),
  );

  /** Explanatory line shown when the active filter is not selectable, else null. */
  const infoLine = computed<string | null>(() => {
    if (selectable.value) return null;
    if (activeFilter.value === OverviewFilter.InProgress) {
      return "In-progress items are locked to their batch — open the batch to work on them.";
    }
    return "Choose a single state (Unprocessed, Stopped, Needs re-upload, or Done) to select items for a batch.";
  });

  // ── row interaction ─────────────────────────────────────────────────────

  /** Click on a row: toggle selection on selectable filters, else open it. */
  function onRowClick(id: string): void {
    if (isSelectableFilter(activeFilter.value)) store.toggle(id);
    else openItem(id);
  }

  function toggleRow(id: string): void {
    store.toggle(id);
  }

  function selectAllVisible(): void {
    store.selectAllVisible();
  }

  function clearSelection(): void {
    store.clearSelection();
  }

  function setFilter(filter: OverviewFilter): void {
    store.setFilter(filter);
  }

  function setSearch(query: string): void {
    store.setSearch(query);
  }

  async function openInExplorer(id: string): Promise<void> {
    try {
      await store.reveal(id);
    } catch {
      toasts.push("Couldn't open the folder in Explorer.", "error");
    }
  }

  function toggleShowHidden(): void {
    store.toggleShowHidden();
  }

  /** ⋯ → Hide/Unhide. Per-row only — never cascades (see `domain/overview`). */
  async function hideRow(id: string): Promise<void> {
    try {
      await store.setHidden(id, true);
    } catch {
      toasts.push("Couldn't hide the item.", "error");
    }
  }

  async function unhideRow(id: string): Promise<void> {
    try {
      await store.setHidden(id, false);
    } catch {
      toasts.push("Couldn't unhide the item.", "error");
    }
  }

  /** ⋯ → View contents: a lightweight in-app peek at a folder's direct files. */
  async function viewContents(id: string): Promise<void> {
    const item = store.items.find((i) => i.id === id);
    if (!item) return;
    await store.peek(item.folderPath);
    if (peekError.value) toasts.push("Couldn't read the folder's contents.", "error");
  }

  function closePeek(): void {
    store.clearPeek();
  }

  /**
   * Rebuild the local index from the folders (recovery path, and the way
   * already-present derived files — `<name>.pdf`, `_thumb.png`, `.txt` — are
   * picked up as completed stages). Batches survive: item ids are derived
   * from folder names.
   */
  async function rebuildIndex(): Promise<void> {
    await store.rebuild();
    if (store.error) toasts.push(`Rebuild failed: ${store.error}`, "error");
    else toasts.push(`Index rebuilt from folders — ${store.items.length} item${store.items.length === 1 ? "" : "s"}.`, "success");
  }

  // ── Epic 03 (Batches) seams ───────────────────────────────────────────────

  function navigateToBatch(batchId: string): void {
    void router.push({ name: "batch-work", params: { batchId } });
  }

  /** Create a batch from a set of same-state items and open its workspace. */
  async function createBatchFor(input: CreateBatchInput): Promise<void> {
    try {
      const batch = await batches.create(input);
      store.clearSelection();
      navigateToBatch(batch.id);
    } catch (err) {
      logger.error("overview", "Failed to create the batch.", err);
      toasts.push("Couldn't create the batch.", "error");
    }
  }

  /** ⋯ → Open as batch / opening a row: the single-item short-circuit. Creates a
   * one-item batch (dropping straight into its stage's tab), or — if the item is
   * already in a batch (In progress) — opens that batch. */
  async function openAsBatch(id: string): Promise<void> {
    const item = store.items.find((i) => i.id === id);
    if (!item) return;
    if (item.batchId) {
      navigateToBatch(item.batchId);
      return;
    }
    await createBatchFor({ type: deriveItemState(item), itemIds: [id] });
  }

  /** Open a row on a non-selectable filter (All / In progress). */
  function openItem(id: string): Promise<void> {
    return openAsBatch(id);
  }

  /** Create a batch from the current selection and move it to In progress.
   * Selection is state-scoped, so every selected item shares one state → the
   * batch `type`. */
  async function createBatch(): Promise<void> {
    const items = store.selectedItems;
    if (items.length === 0) return;
    await createBatchFor({
      type: deriveItemState(items[0]),
      itemIds: items.map((i) => i.id),
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Initial load + start watching for new/changed folders. */
  async function init(): Promise<void> {
    await store.load();
    await store.startWatching();
  }

  function dispose(): void {
    store.stopWatching();
  }

  // Auto-manage lifecycle when used inside a component's setup().
  if (getCurrentInstance()) {
    onMounted(init);
    onUnmounted(dispose);
  }

  return {
    // state
    loading,
    error,
    rows,
    filters,
    stageColumns,
    activeFilter,
    search,
    infoLine,
    selectable,
    selectionCount,
    canCreateBatch,
    allVisibleSelected,
    showHidden,
    peekResult,
    peekLoading,
    peekError,
    // filter / search
    setFilter,
    setSearch,
    // selection + row actions
    onRowClick,
    toggleRow,
    selectAllVisible,
    clearSelection,
    openInExplorer,
    openAsBatch,
    openItem,
    createBatch,
    toggleShowHidden,
    hideRow,
    unhideRow,
    viewContents,
    closePeek,
    // data lifecycle / recovery
    refresh: store.refresh,
    rebuild: store.rebuild,
    rebuildIndex,
    checkRebuildImpact: store.checkRebuildImpact,
    init,
    dispose,
  };
}
