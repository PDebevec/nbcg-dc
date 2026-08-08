import { describe, it, expect } from "vitest";
import {
  OverviewFilter,
  filterState,
  isSelectableFilter,
  filterMatchesState,
  matchesSearch,
  filterItems,
  countByFilter,
} from "./overview";
import { ItemState, emptyStages, type Item } from "./item";

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: overrides.id ?? "i",
    folderName: "folder",
    folderPath: "/unprocessed/folder",
    root: "unprocessed",
    level: "main",
    assets: [],
    stages: emptyStages(),
    flags: { uploaded: false, reupload: false },
    backendId: null,
    batchId: null,
    title: null,
    catalogueId: null,
    createdAt: null,
    updatedAt: null,
    syncMissStreak: 0,
    ...overrides,
  };
}

describe("filter ↔ state mapping", () => {
  it("All maps to no single state (matches everything)", () => {
    expect(filterState(OverviewFilter.All)).toBeNull();
  });

  it("relabels Unprocessed→To process and Done→Uploaded", () => {
    expect(filterState(OverviewFilter.Unprocessed)).toBe(ItemState.ToProcess);
    expect(filterState(OverviewFilter.Done)).toBe(ItemState.Uploaded);
  });

  it("the other three share their state name", () => {
    expect(filterState(OverviewFilter.InProgress)).toBe(ItemState.InProgress);
    expect(filterState(OverviewFilter.Stopped)).toBe(ItemState.Stopped);
    expect(filterState(OverviewFilter.NeedsReupload)).toBe(
      ItemState.NeedsReupload,
    );
  });
});

describe("selection scoping", () => {
  it("only the four single-state actionable filters are selectable", () => {
    expect(isSelectableFilter(OverviewFilter.Unprocessed)).toBe(true);
    expect(isSelectableFilter(OverviewFilter.Stopped)).toBe(true);
    expect(isSelectableFilter(OverviewFilter.NeedsReupload)).toBe(true);
    expect(isSelectableFilter(OverviewFilter.Done)).toBe(true);
  });

  it("All and In progress are not selectable", () => {
    expect(isSelectableFilter(OverviewFilter.All)).toBe(false);
    expect(isSelectableFilter(OverviewFilter.InProgress)).toBe(false);
  });
});

describe("filterMatchesState", () => {
  it("All matches any state", () => {
    expect(filterMatchesState(OverviewFilter.All, ItemState.Stopped)).toBe(true);
  });

  it("a single-state filter matches only its state", () => {
    expect(
      filterMatchesState(OverviewFilter.Unprocessed, ItemState.ToProcess),
    ).toBe(true);
    expect(
      filterMatchesState(OverviewFilter.Unprocessed, ItemState.Uploaded),
    ).toBe(false);
  });
});

describe("matchesSearch", () => {
  const item = makeItem({
    title: "Gorski vijenac",
    folderName: "njegos_gorski",
    catalogueId: "COBISS-123",
  });

  it("blank query matches everything", () => {
    expect(matchesSearch(item, "   ")).toBe(true);
  });

  it("is case-insensitive across title, folder, and catalogue id", () => {
    expect(matchesSearch(item, "gorski VIJENAC")).toBe(true);
    expect(matchesSearch(item, "njegos")).toBe(true);
    expect(matchesSearch(item, "cobiss-123")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(matchesSearch(item, "zzz")).toBe(false);
  });

  it("tolerates null fields", () => {
    expect(matchesSearch(makeItem({ title: null }), "x")).toBe(false);
  });
});

describe("countByFilter + filterItems", () => {
  const items: Item[] = [
    makeItem({ id: "a" }), // To process
    makeItem({ id: "b" }), // To process
    makeItem({ id: "c", batchId: "b1" }), // In progress
    makeItem({ id: "d", stages: { ...emptyStages(), pdf: { status: "failed" } } }), // Stopped
    makeItem({ id: "e", flags: { uploaded: true, reupload: false } }), // Uploaded
    makeItem({ id: "f", flags: { uploaded: true, reupload: true } }), // Needs re-upload
  ];

  it("counts each state under its filter and totals under All", () => {
    const counts = countByFilter(items);
    expect(counts[OverviewFilter.All]).toBe(6);
    expect(counts[OverviewFilter.Unprocessed]).toBe(2);
    expect(counts[OverviewFilter.InProgress]).toBe(1);
    expect(counts[OverviewFilter.Stopped]).toBe(1);
    expect(counts[OverviewFilter.Done]).toBe(1);
    expect(counts[OverviewFilter.NeedsReupload]).toBe(1);
  });

  it("filterItems applies the filter then the search", () => {
    const unprocessed = filterItems(items, OverviewFilter.Unprocessed, "");
    expect(unprocessed.map((i) => i.id)).toEqual(["a", "b"]);

    const all = filterItems(items, OverviewFilter.All, "");
    expect(all).toHaveLength(6);

    const searched = filterItems(items, OverviewFilter.All, "folder");
    expect(searched).toHaveLength(6); // every item's folderName contains "folder"
  });
});
