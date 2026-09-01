/**
 * Items store (Epic 02) — the reactive backbone of the Overview screen.
 *
 * Holds the scanned item list, the active segmented filter, the search query,
 * and the selection set; derives live per-filter counts and the filtered row
 * list. Selection is **state-scoped**: it is only meaningful on a selectable
 * filter and is pruned/cleared as the filter or the underlying states change,
 * because a batch groups items of a single state.
 *
 * The store owns no view copy — the GUI binds through `composables/useOverview`.
 */

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  deriveItemState,
  type Item,
  type ItemState,
} from "@domain/item";
import {
  OverviewFilter,
  countByFilter,
  filterItems,
  filterMatchesState,
  isSelectableFilter,
} from "@domain/overview";
import type { FolderPeekDto } from "@ipc/bindings";
import {
  listIndex,
  scanIndex,
  rebuildIndex,
  revealItem,
  setItemHidden,
  peekFolder,
  watchIndexChanges,
} from "@services/indexing";
import { logger } from "@lib/logger";

/** Debounce window for coalescing filesystem-change events into one refresh. */
const FS_REFRESH_DEBOUNCE_MS = 400;

export const useItemsStore = defineStore("items", () => {
  const items = ref<Item[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const loaded = ref(false);

  const activeFilter = ref<OverviewFilter>(OverviewFilter.All);
  const search = ref("");
  const selection = ref<Set<string>>(new Set());
  /** Show operator-hidden rows too (Overview toolbar toggle). Off by default —
   * hidden is meant to declutter, not just annotate. */
  const showHidden = ref(false);
  /** The current "view contents" peek result, if any (Overview row action) —
   * ephemeral, not part of the tracked item list. */
  const peekResult = ref<FolderPeekDto | null>(null);
  const peekLoading = ref(false);
  const peekError = ref<string | null>(null);

  // ── derived ───────────────────────────────────────────────────────────────

  /** Each item's derived state, computed once per items change. */
  const statesById = computed(() => {
    const map = new Map<string, ItemState>();
    for (const item of items.value) map.set(item.id, deriveItemState(item));
    return map;
  });

  /** Live counts per filter (over the whole index; search does not affect them).
   * Excludes hidden items unless `showHidden`, matching the row list. */
  const counts = computed(() => countByFilter(items.value, showHidden.value));

  /** Whether the active filter permits selection. */
  const selectable = computed(() => isSelectableFilter(activeFilter.value));

  /** Items shown under the active filter + search, in index order. Rows
   * arrive parent-before-descendants (`core::fs::scan_root`'s sort), so no
   * re-sorting is needed here for the Overview table to read as hierarchical —
   * see `domain/overview.depthOf` for the indentation. */
  const visibleItems = computed(() =>
    filterItems(items.value, activeFilter.value, search.value, showHidden.value),
  );

  const selectionCount = computed(() => selection.value.size);

  const selectedItems = computed(() =>
    items.value.filter((i) => selection.value.has(i.id)),
  );

  /** The Create-batch bar shows only on a selectable filter with a selection. */
  const canCreateBatch = computed(
    () => selectable.value && selectionCount.value > 0,
  );

  /** Whether every currently-visible row is selected (drives Select all). */
  const allVisibleSelected = computed(() => {
    const vis = visibleItems.value;
    return vis.length > 0 && vis.every((i) => selection.value.has(i.id));
  });

  // ── selection helpers ───────────────────────────────────────────────────

  function setSelection(next: Set<string>): void {
    selection.value = next; // reassign so computeds re-run
  }

  function clearSelection(): void {
    if (selection.value.size) setSelection(new Set());
  }

  /** Drop selected ids that no longer exist or no longer match the active
   * filter's state (e.g. an item that moved to In progress). */
  function pruneSelection(): void {
    if (!selection.value.size) return;
    const next = new Set<string>();
    for (const id of selection.value) {
      const state = statesById.value.get(id);
      if (state && filterMatchesState(activeFilter.value, state)) next.add(id);
    }
    if (next.size !== selection.value.size) setSelection(next);
  }

  function isSelected(id: string): boolean {
    return selection.value.has(id);
  }

  /** Toggle a row's selection (no-op on a non-selectable filter). */
  function toggle(id: string): void {
    if (!selectable.value) return;
    const next = new Set(selection.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
  }

  /** Select every currently-visible row (no-op on a non-selectable filter). */
  function selectAllVisible(): void {
    if (!selectable.value) return;
    const next = new Set(selection.value);
    for (const i of visibleItems.value) next.add(i.id);
    setSelection(next);
  }

  // ── filter / search ───────────────────────────────────────────────────────

  function setFilter(filter: OverviewFilter): void {
    if (filter === activeFilter.value) return;
    activeFilter.value = filter;
    clearSelection(); // selection is scoped to a single filter/state
  }

  function setSearch(query: string): void {
    search.value = query;
  }

  // ── loading ─────────────────────────────────────────────────────────────

  async function runLoad(source: () => Promise<Item[]>): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      items.value = await source();
      loaded.value = true;
      pruneSelection();
    } catch (err) {
      error.value = (err as Error)?.message ?? "Failed to load the index.";
      logger.error("items", "Failed to load the local index.", err);
    } finally {
      loading.value = false;
    }
  }

  /** Initial load — list the tracked index (fast; no rescan). */
  function load(): Promise<void> {
    return runLoad(listIndex);
  }

  /** Rescan the roots and reconcile the index. */
  function refresh(): Promise<void> {
    return runLoad(scanIndex);
  }

  /** Rebuild the index from folders (recovery path). */
  function rebuild(): Promise<void> {
    return runLoad(rebuildIndex);
  }

  /** Replace one item in the list (reassigns the array so computeds re-run).
   * Used by the processing run store to reflect live per-stage transitions
   * (`job://stage-changed`) between authoritative index refreshes; a no-op for
   * an unknown id. */
  function replaceItem(item: Item): void {
    const i = items.value.findIndex((x) => x.id === item.id);
    if (i < 0) return;
    const next = items.value.slice();
    next[i] = item;
    items.value = next;
  }

  /** Reveal an item's folder in the OS file manager. */
  async function reveal(id: string): Promise<void> {
    const item = items.value.find((i) => i.id === id);
    if (!item) return;
    try {
      await revealItem(item);
    } catch (err) {
      logger.error("items", "Failed to reveal item folder.", err);
      throw err;
    }
  }

  /** Toggle whether operator-hidden rows are shown in the list. */
  function toggleShowHidden(): void {
    showHidden.value = !showHidden.value;
  }

  /** Hide or unhide an item from the default Overview list. Per-row only —
   * never cascades to descendants or ancestors (see `domain/overview.filterItems`). */
  async function setHidden(id: string, hidden: boolean): Promise<void> {
    try {
      const updated = await setItemHidden(id, hidden);
      replaceItem(updated);
    } catch (err) {
      logger.error("items", "Failed to update the hidden flag.", err);
      throw err;
    }
  }

  /** An ad-hoc "view contents" look at a folder (Overview row action) — takes
   * a raw path since a candidate may not be a tracked item yet. */
  async function peek(path: string): Promise<void> {
    peekLoading.value = true;
    peekError.value = null;
    try {
      peekResult.value = await peekFolder(path);
    } catch (err) {
      peekError.value = (err as Error)?.message ?? "Failed to read the folder.";
      logger.error("items", "Failed to peek a folder's contents.", err);
    } finally {
      peekLoading.value = false;
    }
  }

  function clearPeek(): void {
    peekResult.value = null;
    peekError.value = null;
  }

  // ── filesystem watch ──────────────────────────────────────────────────────

  let unlisten: UnlistenFn | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic generation so an in-flight subscribe that is superseded by a
  // stop() (or a second start()) tears itself down instead of leaking — the
  // subscribe is async, so `unlisten` isn't set until it resolves and a plain
  // `if (unlisten)` guard can't cover that window (cf. useConnection.ts).
  let watchGeneration = 0;

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, FS_REFRESH_DEBOUNCE_MS);
  }

  /** Subscribe to native scan-root changes so new/changed folders appear
   * without a restart. Idempotent and safe against overlapping start/stop. */
  async function startWatching(): Promise<void> {
    if (unlisten) return; // already watching (settled)
    const gen = ++watchGeneration; // claim this subscribe
    const fn = await watchIndexChanges(() => scheduleRefresh());
    if (gen !== watchGeneration || unlisten) {
      // superseded by a stopWatching()/another startWatching() mid-subscribe.
      fn();
      return;
    }
    unlisten = fn;
  }

  function stopWatching(): void {
    watchGeneration++; // invalidate any in-flight subscribe
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  }

  return {
    // state
    items,
    loading,
    error,
    loaded,
    activeFilter,
    search,
    selection,
    showHidden,
    peekResult,
    peekLoading,
    peekError,
    // derived
    statesById,
    counts,
    selectable,
    visibleItems,
    selectionCount,
    selectedItems,
    canCreateBatch,
    allVisibleSelected,
    // mutation
    replaceItem,
    // selection
    isSelected,
    toggle,
    selectAllVisible,
    clearSelection,
    // filter / search
    setFilter,
    setSearch,
    // loading
    load,
    refresh,
    rebuild,
    reveal,
    toggleShowHidden,
    setHidden,
    peek,
    clearPeek,
    // watch
    startWatching,
    stopWatching,
  };
});
