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
const batch = {
  id: "b1",
  parents: [] as Array<{ id: string; passesData: boolean }>,
  publish: "DRAFT" as "DRAFT" | "RECORD",
  overrides: {} as Record<string, { publish?: "DRAFT" | "RECORD" | null }>,
};

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
  batch.parents = [];
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

  it("is not ready while a batch parent is missing on the backend", async () => {
    batch.parents = [{ id: "gone", passesData: false }];
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureParents(["gone"]);
    store.setFieldValue("i1", "title", "T");
    store.setFieldValue("i1", "materialType", BOOK);
    expect(store.batchParentsOf(item()).missing).toEqual(["gone"]);
    expect(store.missingParentNamesOf(item())).toEqual({ gone: [], notFound: ["gone"] });
    expect(store.isReady(item())).toBe(false);
  });

  it("holds a parent the backend refused on upload as gone, though its record had loaded", async () => {
    batch.parents = [{ id: "p1", passesData: false }];
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
    expect(store.batchParentsOf(item())).toMatchObject({ records: [], gone: ["p1"], missing: [] });
  });

  it("keeps a gone parent gone when a later search finds it", async () => {
    batch.parents = [{ id: "p1", passesData: false }];
    const pobjeda = { id: "p1", title: "Pobjeda", collectionType: null, metadata: {} };
    backendParents.set("p1", pobjeda);
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureParents(["p1"]);
    store.markParentsGone(["p1"]);

    store.rememberParent(pobjeda);

    expect(store.batchParentsOf(item()).gone).toEqual(["p1"]);
    expect(store.parentGone.has("p1")).toBe(true);
  });

  it("keeps the form open but not ready while a batch parent failed to load", async () => {
    batch.parents = [{ id: "p1", passesData: false }];
    unreachableParents.add("p1");
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureParents(["p1"]);
    store.setFieldValue("i1", "title", "T");
    store.setFieldValue("i1", "materialType", BOOK);
    expect(store.batchParentsOf(item()).failed).toEqual(["p1"]);
    expect(store.checkOf(item())).not.toBeNull();
    expect(store.isReady(item())).toBe(false);
  });

  it("clears the failure when a retry loads the parent, and the item can become ready", async () => {
    batch.parents = [{ id: "p1", passesData: false }];
    unreachableParents.add("p1");
    const store = useMetadataStore();
    await store.ensureItemLoaded(item());
    await store.ensureParents(["p1"]);
    store.setFieldValue("i1", "title", "T");
    store.setFieldValue("i1", "materialType", BOOK);
    unreachableParents.clear();
    backendParents.set("p1", { id: "p1", title: "Pobjeda", collectionType: null, metadata: {} });
    await store.ensureParents(["p1"]);
    expect(store.batchParentsOf(item()).failed).toEqual([]);
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
