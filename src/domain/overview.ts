/**
 * Overview screen logic (Epic 02) — the segmented filter, selection scoping,
 * and search rules that back the arrivals table.
 *
 * These are pure, framework-free rules (the store composes them reactively and
 * the composable shapes them into view rows). The mapping from a filter to the
 * derived {@link ItemState}(s) it shows lives here so the counts, the filter
 * bar, and the row list all agree.
 */

import { ItemState, deriveItemState, type Item } from "./item";

/**
 * The six segmented filters. `All` shows everything and maps to no state. Of the
 * remaining five, two are relabelled views of a single state
 * (Unprocessed = `To process`, Done = `Uploaded`) and **three** share their state
 * name (In progress, Stopped, Needs re-upload).
 */
export const OverviewFilter = {
  All: "all",
  Unprocessed: "unprocessed",
  InProgress: "in-progress",
  Stopped: "stopped",
  NeedsReupload: "needs-reupload",
  Done: "done",
} as const;
export type OverviewFilter =
  (typeof OverviewFilter)[keyof typeof OverviewFilter];

/** The filter bar, in display order, with labels. */
export const OVERVIEW_FILTERS: ReadonlyArray<{
  key: OverviewFilter;
  label: string;
}> = [
  { key: OverviewFilter.All, label: "All" },
  { key: OverviewFilter.Unprocessed, label: "Unprocessed" },
  { key: OverviewFilter.InProgress, label: "In progress" },
  { key: OverviewFilter.Stopped, label: "Stopped" },
  { key: OverviewFilter.NeedsReupload, label: "Needs re-upload" },
  { key: OverviewFilter.Done, label: "Done" },
];

/**
 * Which item state a filter maps to (`null` for `All`, which matches every
 * state). Encodes the two relabellings: Unprocessed↔To process, Done↔Uploaded.
 */
export function filterState(filter: OverviewFilter): ItemState | null {
  switch (filter) {
    case OverviewFilter.All:
      return null;
    case OverviewFilter.Unprocessed:
      return ItemState.ToProcess;
    case OverviewFilter.InProgress:
      return ItemState.InProgress;
    case OverviewFilter.Stopped:
      return ItemState.Stopped;
    case OverviewFilter.NeedsReupload:
      return ItemState.NeedsReupload;
    case OverviewFilter.Done:
      return ItemState.Uploaded;
  }
}

/**
 * Filters that allow row selection — a batch groups items of one state, so only
 * the four single-state, actionable filters are selectable. `All` and
 * `In progress` are **not** (mixed states / locked to a batch).
 */
export const SELECTABLE_FILTERS: ReadonlyArray<OverviewFilter> = [
  OverviewFilter.Unprocessed,
  OverviewFilter.Stopped,
  OverviewFilter.NeedsReupload,
  OverviewFilter.Done,
];

export function isSelectableFilter(filter: OverviewFilter): boolean {
  return SELECTABLE_FILTERS.includes(filter);
}

/** Whether an item (by its derived state) belongs under a filter. */
export function filterMatchesState(
  filter: OverviewFilter,
  state: ItemState,
): boolean {
  const target = filterState(filter);
  return target === null || target === state;
}

/**
 * Case-insensitive search over an item's title, folder name, and catalogue id.
 * An empty/blank query matches everything.
 */
export function matchesSearch(item: Item, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [item.title, item.folderName, item.catalogueId];
  return haystacks.some((h) => h != null && h.toLowerCase().includes(q));
}

/** Apply the active filter + search to a list, deriving each item's state once. */
export function filterItems(
  items: Item[],
  filter: OverviewFilter,
  query: string,
): Item[] {
  return items.filter(
    (item) =>
      filterMatchesState(filter, deriveItemState(item)) &&
      matchesSearch(item, query),
  );
}

/** A zeroed count map for every filter. */
function zeroCounts(): Record<OverviewFilter, number> {
  return {
    [OverviewFilter.All]: 0,
    [OverviewFilter.Unprocessed]: 0,
    [OverviewFilter.InProgress]: 0,
    [OverviewFilter.Stopped]: 0,
    [OverviewFilter.NeedsReupload]: 0,
    [OverviewFilter.Done]: 0,
  };
}

/** Which single-state filter a given item state falls under. */
const STATE_TO_FILTER: Record<ItemState, OverviewFilter> = {
  [ItemState.ToProcess]: OverviewFilter.Unprocessed,
  [ItemState.InProgress]: OverviewFilter.InProgress,
  [ItemState.Stopped]: OverviewFilter.Stopped,
  [ItemState.NeedsReupload]: OverviewFilter.NeedsReupload,
  [ItemState.Uploaded]: OverviewFilter.Done,
};

/**
 * Live counts per filter. Derives each item's state once, incrementing its
 * single-state filter and `All`. Note: search does **not** affect the segmented
 * counts (they reflect the whole index, like the prototype).
 */
export function countByFilter(items: Item[]): Record<OverviewFilter, number> {
  const counts = zeroCounts();
  for (const item of items) {
    counts[OverviewFilter.All] += 1;
    counts[STATE_TO_FILTER[deriveItemState(item)]] += 1;
  }
  return counts;
}
