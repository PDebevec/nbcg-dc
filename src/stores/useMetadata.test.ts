import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { SNAPSHOT } from "@domain/schema.fixture";
import type { Item } from "@domain/item";
import type { LocalMetadataFile } from "@domain/metadata";

const mirrors = new Map<string, LocalMetadataFile | null>();
const backendParents = new Map<string, { id: string; title: string; collectionType: number | null; metadata: Record<string, unknown> }>();
const batch = {
  id: "b1",
  parents: [] as Array<{ id: string; passesData: boolean }>,
  publish: "DRAFT" as "DRAFT" | "RECORD",
  overrides: {} as Record<string, { publish?: "DRAFT" | "RECORD" | null }>,
};

vi.mock("@services/api/schemaV2", () => ({ getRecordSchemaV2: async () => SNAPSHOT }));
vi.mock("@services/indexing", () => ({
  readItemMetadata: async (item: Item) => mirrors.get(item.id) ?? null,
  writeItemMetadata: async (item: Item, file: LocalMetadataFile) => {
    mirrors.set(item.id, file);
  },
}));
vi.mock("@services/api/collections", () => ({
  getParentById: async (id: string) => backendParents.get(id) ?? null,
  searchParents: async () => [],
}));
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
    expect(store.isReady(item())).toBe(false);
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
