import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { emptyStages, type Item } from "@domain/item";
import type { FolderPeekDto } from "@ipc/bindings";

/**
 * Coverage for the recursive-discovery additions to the items store: hide/
 * unhide, the "show hidden" toggle, and the folder-contents peek. The rest
 * of the store (load/refresh/rebuild/watch) is exercised implicitly by the
 * Overview composable and is lower-risk plain IPC pass-through — this file
 * is scoped to what's new, following `stores/useSettings.test.ts`'s pattern
 * of faking the service layer the store sits on.
 */

function makeItem(overrides: Partial<Item> = {}): Item {
  const base: Item = {
    id: "i1",
    folderName: "BOOK",
    folderPath: "/unprocessed/BOOK",
    relativePath: "BOOK",
    hidden: false,
    root: "unprocessed",
    level: "main",
    assets: [],
    stages: emptyStages(),
    flags: { uploaded: false, reupload: false, reuploadTextOnly: false },
    backendId: null,
    batchId: null,
    title: null,
    catalogueId: null,
    createdAt: null,
    updatedAt: null,
    syncMissStreak: 0,
  };
  return { ...base, ...overrides };
}

const calls = {
  setItemHidden: [] as Array<{ id: string; hidden: boolean }>,
  peekFolder: [] as string[],
};
const state = {
  peekResult: null as FolderPeekDto | null,
  peekError: null as Error | null,
};

vi.mock("@services/indexing", () => ({
  listIndex: async () => [] as Item[],
  scanIndex: async () => [] as Item[],
  rebuildIndex: async () => [] as Item[],
  revealItem: async () => {},
  setItemHidden: async (id: string, hidden: boolean) => {
    calls.setItemHidden.push({ id, hidden });
    return makeItem({ id, hidden });
  },
  peekFolder: async (path: string) => {
    calls.peekFolder.push(path);
    if (state.peekError) throw state.peekError;
    return state.peekResult as FolderPeekDto;
  },
  watchIndexChanges: async () => () => {},
}));

const { useItemsStore } = await import("./useItems");

beforeEach(() => {
  setActivePinia(createPinia());
  calls.setItemHidden = [];
  calls.peekFolder = [];
  state.peekResult = null;
  state.peekError = null;
});

describe("useItemsStore — hide / unhide", () => {
  it("setHidden(id, true) calls the service and replaces the item in place", async () => {
    const store = useItemsStore();
    store.items = [makeItem({ id: "a", hidden: false })];

    await store.setHidden("a", true);

    expect(calls.setItemHidden).toEqual([{ id: "a", hidden: true }]);
    expect(store.items.find((i) => i.id === "a")?.hidden).toBe(true);
  });

  it("a hidden item drops out of visibleItems until showHidden is toggled on", () => {
    const store = useItemsStore();
    store.items = [
      makeItem({ id: "a", hidden: false }),
      makeItem({ id: "b", hidden: true }),
    ];

    expect(store.visibleItems.map((i) => i.id)).toEqual(["a"]);

    store.toggleShowHidden();
    expect(store.showHidden).toBe(true);
    expect(store.visibleItems.map((i) => i.id).sort()).toEqual(["a", "b"]);

    store.toggleShowHidden();
    expect(store.showHidden).toBe(false);
    expect(store.visibleItems.map((i) => i.id)).toEqual(["a"]);
  });

  it("setHidden on an unknown id still calls the service but touches nothing local", async () => {
    const store = useItemsStore();
    store.items = [makeItem({ id: "a" })];

    await store.setHidden("missing", true);

    expect(calls.setItemHidden).toEqual([{ id: "missing", hidden: true }]);
    expect(store.items).toHaveLength(1);
  });
});

describe("useItemsStore — folder-contents peek", () => {
  it("peek(path) populates peekResult from the service", async () => {
    const store = useItemsStore();
    state.peekResult = {
      folderName: "BOOK",
      assets: [{ filename: "1.jpg", path: "/unprocessed/BOOK/1.jpg", sizeBytes: 1234 }],
    };

    await store.peek("/unprocessed/BOOK");

    expect(calls.peekFolder).toEqual(["/unprocessed/BOOK"]);
    expect(store.peekResult?.folderName).toBe("BOOK");
    expect(store.peekLoading).toBe(false);
    expect(store.peekError).toBeNull();
  });

  it("a failed peek records the error and leaves peekResult null", async () => {
    const store = useItemsStore();
    state.peekError = new Error("boom");

    await store.peek("/unprocessed/GONE");

    expect(store.peekResult).toBeNull();
    expect(store.peekError).toBe("boom");
  });

  it("clearPeek resets both result and error", async () => {
    const store = useItemsStore();
    state.peekResult = { folderName: "BOOK", assets: [] };
    await store.peek("/unprocessed/BOOK");
    expect(store.peekResult).not.toBeNull();

    store.clearPeek();

    expect(store.peekResult).toBeNull();
    expect(store.peekError).toBeNull();
  });
});
