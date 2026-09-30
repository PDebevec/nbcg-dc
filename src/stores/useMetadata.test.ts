import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { SNAPSHOT } from "@domain/schema.fixture";
import type { Item } from "@domain/item";
import type { LocalMetadataFile } from "@domain/metadata";

const mirrors = new Map<string, LocalMetadataFile | null>();
const backendParents = new Map<string, { id: string; title: string; collectionType: number | null; metadata: Record<string, unknown> }>();
/** Parent ids whose fetch throws (offline), as opposed to a 404. */
const unreachableParents = new Set<string>();
/** Folder paths no longer on disk (an upload moved them to /processed). */
const movedFolders = new Set<string>();
/** Item ids whose metadata.json read throws. */
const unreadableMirrors = new Set<string>();
const writeMirror = vi.fn(async (item: Item, file: LocalMetadataFile) => {
  mirrors.set(item.id, file);
});
type Changes = { add: string[]; remove: string[]; passing: string | null };
const batch = {
  id: "b1",
  publish: "DRAFT" as "DRAFT" | "RECORD",
  overrides: {} as Record<string, { publish?: "DRAFT" | "RECORD" | null; parents?: Changes | null }>,
};
/** Each uploaded item's parent ids on the backend, by backend id (absent → 404). */
const itemLinks = new Map<string, string[]>();
/** Backend ids whose read throws (offline), as opposed to a 404. */
const unreachableItems = new Set<string>();
const getItemParentIds = vi.fn(async (backendId: string) => {
  if (unreachableItems.has(backendId)) throw new Error("Network error");
  return itemLinks.get(backendId) ?? null;
});

/** Give `itemId` pending parent links in the batch. */
function pendingLinks(itemId: string, ...add: string[]): void {
  batch.overrides = { ...batch.overrides, [itemId]: { parents: { add, remove: [], passing: null } } };
}

vi.mock("@services/api/schemaV2", () => ({ getRecordSchemaV2: async () => SNAPSHOT }));
vi.mock("@services/indexing", () => ({
  readItemMetadata: async (item: Item) => {
    if (unreadableMirrors.has(item.id)) throw new Error("read failed");
    return mirrors.get(item.id) ?? null;
  },
  writeItemMetadata: (item: Item, file: LocalMetadataFile) => writeMirror(item, file),
  itemFolderExists: async (item: Item) => !movedFolders.has(item.folderPath),
}));
vi.mock("@services/api/collections", () => ({
  getParentById: async (id: string) => {
    if (unreachableParents.has(id)) throw new Error("Network error");
    return backendParents.get(id) ?? null;
  },
  searchParents: async () => [],
  getItemParentIds: (id: string) => getItemParentIds(id),
}));
vi.mock("@lib/logger", () => ({ logger: { debug() {}, info() {}, warn() {}, error() {} } }));
vi.mock("./useBatches", () => ({
  useBatchesStore: () => ({ get: (id: string) => (id === batch.id ? batch : null) }),
}));
vi.mock("./useItems", () => ({ useItemsStore: () => ({ items: [], replaceItem: () => {} }) }));

const { useMetadataStore } = await import("./useMetadata");

const BOOK = { code: "am", en: "Book", cnr: "Knjiga" };

function item(id = "i1"): Item {
  return { id, batchId: "b1", title: null, folderName: id, folderPath: `/p/${id}` } as Item;
}

beforeEach(() => {
  setActivePinia(createPinia());
  mirrors.clear();
  backendParents.clear();
  unreachableParents.clear();
  movedFolders.clear();
  unreadableMirrors.clear();
  writeMirror.mockClear();
  itemLinks.clear();
  unreachableItems.clear();
  getItemParentIds.mockClear();
  batch.publish = "DRAFT";
  batch.overrides = {};
});

describe("useMetadataStore on schema v2", () => {
  it("starts a new item from the schema's defaults", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    expect(store.plainValues("i1")).toEqual({ collectionType: 0 });
    expect(store.readinessOf(item())).toBe("untouched");
  });

  it("a draft needs a title and a material type; a record also its pages", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "title", "Gorski vijenac");
    expect(store.isReady(item())).toBe(false);
    store.setFieldValue("i1", "materialType", BOOK);
    expect(store.isReady(item())).toBe(true);
    batch.publish = "RECORD";
    expect(store.isReady(item())).toBe(false);
    store.setFieldValue("i1", "extent", { value: 253, unit: "pages" });
    expect(store.isReady(item())).toBe(true);
  });

  it("checks an uploaded item against its backend state, not the choice", async () => {
    mirrors.set("i1", {
      backendId: "rec_1",
      version: 1,
      targetState: "RECORD",
      visibilityStatus: "PUBLIC",
      metadata: { title: "T", materialType: BOOK, collectionType: 0 },
      syncedAt: "2026-09-25T00:00:00.000Z",
    });
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    expect(store.backendStates.get("i1")).toBe("RECORD");
    expect(store.checkOf(item())?.missing.map((m) => m.path)).toEqual(["extent"]);
  });

  it("is not ready while one of its parents is missing on the backend", async () => {
    pendingLinks("i1", "gone");
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureParents(["gone"]);
    store.setFieldValue("i1", "title", "T");
    store.setFieldValue("i1", "materialType", BOOK);
    expect(store.parentsOf(item()).missing).toEqual(["gone"]);
    expect(store.missingParentNamesOf(item())).toEqual({ gone: [], notFound: ["gone"] });
    expect(store.isReady(item())).toBe(false);
  });

  it("holds a parent the backend refused on upload as gone, though its record had loaded", async () => {
    pendingLinks("i1", "p1");
    backendParents.set("p1", { id: "p1", title: "Pobjeda", collectionType: null, metadata: {} });
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureParents(["p1"]);
    store.setFieldValue("i1", "title", "T");
    store.setFieldValue("i1", "materialType", BOOK);
    expect(store.isReady(item())).toBe(true);

    store.markParentsGone(["p1"]);

    expect(store.isReady(item())).toBe(false);
    expect(store.missingParentNamesOf(item())).toEqual({ gone: ["Pobjeda"], notFound: [] });
    expect(store.parentsOf(item())).toMatchObject({ records: [], gone: ["p1"], missing: [] });
  });

  it("keeps a gone parent gone when a later search finds it", async () => {
    pendingLinks("i1", "p1");
    const pobjeda = { id: "p1", title: "Pobjeda", collectionType: null, metadata: {} };
    backendParents.set("p1", pobjeda);
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureParents(["p1"]);
    store.markParentsGone(["p1"]);

    store.rememberParent(pobjeda);

    expect(store.parentsOf(item()).gone).toEqual(["p1"]);
    expect(store.parentGone.has("p1")).toBe(true);
  });

  it("keeps the form open but not ready while one of its parents failed to load", async () => {
    pendingLinks("i1", "p1");
    unreachableParents.add("p1");
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureParents(["p1"]);
    store.setFieldValue("i1", "title", "T");
    store.setFieldValue("i1", "materialType", BOOK);
    expect(store.parentsOf(item()).failed).toEqual(["p1"]);
    expect(store.checkOf(item())).not.toBeNull();
    expect(store.isReady(item())).toBe(false);
  });

  it("clears the failure when a retry loads the parent, and the item can become ready", async () => {
    pendingLinks("i1", "p1");
    unreachableParents.add("p1");
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureParents(["p1"]);
    store.setFieldValue("i1", "title", "T");
    store.setFieldValue("i1", "materialType", BOOK);
    unreachableParents.clear();
    backendParents.set("p1", { id: "p1", title: "Pobjeda", collectionType: null, metadata: {} });
    await store.ensureParents(["p1"]);
    expect(store.parentsOf(item()).failed).toEqual([]);
    expect(store.parentFailed.has("p1")).toBe(false);
    expect(store.isReady(item())).toBe(true);
  });

  it("normalises a value picked from a parent in the source picker", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.chooseSource("i1", "language", { kind: "parent", parentId: "p1", value: ["cnr"] });
    expect(store.getValues("i1").language).toEqual({
      value: [{ code: "cnr", en: "cnr", cnr: "cnr" }],
      provenance: "parent",
      sourceParentId: "p1",
    });
  });

  it("sends only schema keys, without blanks", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "title", "T");
    store.setFieldValue("i1", "subtitle", "  ");
    store.setFieldValue("i1", "bogus", "x");
    expect(store.wireMetadata("i1")).toEqual({ collectionType: 0, title: "T" });
  });

  it("normalises a COBISS record's bare codes on the way in", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.applyCobissTo("i1", { title: "X", materialType: "am" });
    expect((store.plainValues("i1").materialType as { code: string }).code).toBe("am");
  });
});

describe("reloadMirror", () => {
  it("picks up the backend link an upload wrote, and the item's new folder", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    expect(store.backendStates.get("i1")).toBeNull();
    mirrors.set("i1", {
      backendId: "rec_1",
      version: 0,
      targetState: "DRAFT",
      visibilityStatus: "PRIVATE",
      metadata: { title: "T" },
      syncedAt: "2026-09-25T00:00:00.000Z",
    });
    await store.reloadMirrors([{ ...item(), folderPath: "/processed/i1" }]);
    expect(store.backendStates.get("i1")).toBe("DRAFT");
  });

  it("keeps the editor's values, or takes an adopted record's when asked", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "title", "Mine");
    store.setFieldValue("i1", "subtitle", "Sub");
    store.setFieldValue("i1", "subtitle", "");
    expect(store.emptiedKeys("i1")).toEqual(["subtitle"]);
    mirrors.set("i1", {
      backendId: "rec_9",
      version: 7,
      targetState: "RECORD",
      visibilityStatus: "PUBLIC",
      metadata: { title: "Existing", materialType: BOOK, collectionType: 0, language: ["cnr"] },
      syncedAt: "2026-09-25T00:00:00.000Z",
    });

    await store.reloadMirror(item());
    expect(store.plainValues("i1").title).toBe("Mine");

    await store.reloadMirror(item(), { values: true });
    expect(store.plainValues("i1")).toEqual({
      title: "Existing",
      materialType: BOOK,
      collectionType: 0,
      // normalised on the way in, as on load
      language: [{ code: "cnr", en: "cnr", cnr: "cnr" }],
    });
    expect(store.emptiedKeys("i1")).toEqual([]);
  });
});

describe("autosave", () => {
  const LINKED: LocalMetadataFile = {
    backendId: "rec_1",
    version: 0,
    targetState: "RECORD",
    visibilityStatus: "PRIVATE",
    metadata: { title: "T" },
    syncedAt: "2026-09-25T00:00:00.000Z",
  };

  it("writes an item that is not uploaded yet to its metadata.json", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "title", "Mine");
    await store.flush();
    expect(writeMirror).toHaveBeenCalledTimes(1);
    expect(mirrors.get("i1")).toMatchObject({ backendId: null, metadata: { title: "Mine" } });
  });

  it("does not write over a mirror an upload linked meanwhile, and picks up its state", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "title", "Mine");
    // The upload wrote the backend link while Setup was still editable.
    mirrors.set("i1", LINKED);

    await store.flush();

    expect(writeMirror).not.toHaveBeenCalled();
    expect(mirrors.get("i1")).toBe(LINKED);
    expect(store.backendStates.get("i1")).toBe("RECORD");
    expect(store.plainValues("i1").title).toBe("Mine");
  });

  it("does not write when the upload moved the item's folder away", async () => {
    mirrors.set("i1", { ...LINKED, backendId: null, version: null, targetState: null });
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "title", "Mine");
    mirrors.delete("i1");
    movedFolders.add("/p/i1");

    await store.flush();

    expect(writeMirror).not.toHaveBeenCalled();
    expect(store.plainValues("i1").title).toBe("Mine");
  });

  it("does not write when metadata.json can't be re-read", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "title", "Mine");
    unreadableMirrors.add("i1");

    await store.flush();

    expect(writeMirror).not.toHaveBeenCalled();
    expect(store.plainValues("i1").title).toBe("Mine");
  });
});

describe("emptiedKeys", () => {
  const MIRROR: LocalMetadataFile = {
    backendId: null,
    version: null,
    targetState: null,
    visibilityStatus: null,
    metadata: { title: "T", subtitle: "S" },
    syncedAt: "2026-09-25T00:00:00.000Z",
  };

  it("lists a key the item had that the editor emptied", async () => {
    mirrors.set("i1", MIRROR);
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "subtitle", "");
    expect(store.emptiedKeys("i1")).toEqual(["subtitle"]);
  });

  it("does not list a key the editor never held", async () => {
    mirrors.set("i1", { ...MIRROR, metadata: { title: "T" } });
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    expect(store.emptiedKeys("i1")).toEqual([]);
  });

  it("does not list a key the schema does not know", async () => {
    mirrors.set("i1", MIRROR);
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "bogus", "");
    expect(store.emptiedKeys("i1")).toEqual([]);
  });
});

describe("forget", () => {
  it("cancels a pending autosave so nothing is written after a batch delete", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    vi.useFakeTimers();
    try {
      store.setFieldValue("i1", "title", "Typed just before the delete");
      store.forget(["i1"]);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    expect(writeMirror).not.toHaveBeenCalled();
    expect(store.getValues("i1")).toEqual({});
    expect(store.loadedItems.has("i1")).toBe(false);
  });

  it("re-reads the item from disk on its next load", async () => {
    mirrors.set("i1", {
      backendId: null,
      version: null,
      targetState: null,
      visibilityStatus: null,
      metadata: { title: "Before the batch", collectionType: 0 },
      syncedAt: "2026-09-29T00:00:00.000Z",
    });
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    store.setFieldValue("i1", "title", "Changed in the batch");

    store.forget(["i1"]);
    await store.ensureItemLoaded(item());

    expect(store.plainValues("i1").title).toBe("Before the batch");
  });
});

describe("each item's own parents", () => {
  const SERIAL = { id: "s1", title: "Pobjeda", collectionType: 4, metadata: { title: "Pobjeda", collectionType: 4 } };

  function uploaded(parentIds?: string[]): LocalMetadataFile {
    return {
      backendId: "rec_1",
      version: 1,
      targetState: "DRAFT",
      visibilityStatus: "PUBLIC",
      ...(parentIds ? { parentIds } : {}),
      metadata: { title: "T", materialType: BOOK, collectionType: 0 },
      syncedAt: "2026-09-29T00:00:00.000Z",
    };
  }

  it("checks each item against its own parents", async () => {
    backendParents.set("s1", SERIAL);
    mirrors.set("i1", uploaded(["s1"]));
    const store = useMetadataStore();
    await store.ensureItemLoaded(item("i1"));
    await store.ensureItemLoaded(item("i2"));
    await store.ensureItemParents(item("i1"));

    expect(store.checkOf(item("i1"))?.context.parentCollectionType).toEqual([4]);
    expect(store.checkOf(item("i2"))?.context.parentCollectionType).toEqual([]);
  });

  it("adds the batch's pending links and drops its pending unlinks", async () => {
    mirrors.set("i1", uploaded(["p1"]));
    batch.overrides = { i1: { parents: { add: ["p9"], remove: ["p1"], passing: null } } };
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    expect(store.parentIdsOf(item())).toEqual(["p9"]);
  });

  it("reads an uploaded item's links once when its mirror has none, and records them", async () => {
    mirrors.set("i1", uploaded());
    itemLinks.set("rec_1", ["p1"]);
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureItemParents(item());

    expect(store.parentIdsOf(item())).toEqual(["p1"]);
    expect(mirrors.get("i1")?.parentIds).toEqual(["p1"]);
    expect(getItemParentIds).toHaveBeenCalledTimes(1);
  });

  it("is not ready while an uploaded item's links can't be read, until a retry reads them", async () => {
    mirrors.set("i1", uploaded());
    unreachableItems.add("rec_1");
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureItemParents(item());
    expect(store.parentsOf(item()).linksUnknown).toBe(true);
    expect(store.isReady(item())).toBe(false);

    unreachableItems.clear();
    itemLinks.set("rec_1", []);
    await store.retryItemParents(item());

    expect(store.parentsOf(item()).linksUnknown).toBe(false);
    expect(store.isReady(item())).toBe(true);
  });

  it("never asks the backend about an item that was never uploaded", async () => {
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureItemParents(item());
    expect(getItemParentIds).not.toHaveBeenCalled();
    expect(store.parentIdsOf(item())).toEqual([]);
  });
});
