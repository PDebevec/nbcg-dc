import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { BatchStage, ItemRunStatus, type Batch } from "@domain/batch";
import { DEFAULT_CONFIG } from "@domain/config";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import { ItemState, type Item } from "@domain/item";
import type { ParentRecord } from "@domain/parent";

function makeBatch(itemIds: string[], over: Partial<Batch> = {}): Batch {
  const proc: Record<string, ItemRunStatus> = {};
  for (const id of itemIds) proc[id] = ItemRunStatus.Idle;
  return {
    id: "b1",
    no: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    type: ItemState.ToProcess,
    itemIds,
    stage: BatchStage.Metadata,
    running: false,
    proc,
    cobissId: null,
    publish: PublishTarget.DRAFT,
    visibility: VisibilityStatus.PRIVATE,
    overrides: {},
    archivedAt: null,
    backendTouchedAt: null,
    ...over,
  };
}

function item(id: string): Item {
  return { id, batchId: "b1", folderName: id, folderPath: `/p/${id}`, title: null } as unknown as Item;
}

function record(id: string, collectionType: number | null = null): ParentRecord {
  return { id, title: `Parent ${id}`, collectionType, metadata: { collectionType: collectionType ?? undefined } };
}

vi.mock("@services/batches", () => ({
  listBatches: async () => [] as Batch[],
  createBatch: async (f: unknown) => f as Batch,
  updateBatch: async (b: unknown) => b as Batch,
  archiveBatch: async (b: unknown) => b as Batch,
}));

const metadataFake = {
  parentRecords: ref(new Map<string, ParentRecord>()),
  parentLoading: ref(new Set<string>()),
  parentGone: ref(new Set<string>()),
  parentMissing: ref(new Set<string>()),
  parentFailed: ref(new Set<string>()),
  backendLinks: ref(new Map<string, string[] | null>()),
  ensureParents: async () => {},
  ensureParent: async () => {},
  findParents: async (_q: string, _signal?: AbortSignal) => [] as ParentRecord[],
};
vi.mock("@stores/useMetadata", () => ({ useMetadataStore: () => metadataFake }));

const { useParentLinks } = await import("./useParentLinks");
const { useBatchesStore } = await import("@stores/useBatches");
const { useSettingsStore } = await import("@stores/useSettings");

const SERIAL = 4;

function setup(opts: {
  targets: string[];
  members?: string[];
  backend?: Record<string, string[]>;
  changes?: Batch["overrides"];
}) {
  const batches = useBatchesStore();
  const members = opts.members ?? opts.targets;
  batches.batches = [makeBatch(members, { overrides: opts.changes ?? {} })];
  metadataFake.backendLinks.value = new Map(members.map((id) => [id, opts.backend?.[id] ?? []]));
  const passing: Array<{ itemId: string; parent: ParentRecord | null }> = [];
  const links = useParentLinks(
    () => batches.get("b1"),
    () => opts.targets.map(item),
    { members: () => members.map(item), onPassingChanged: (changes) => passing.push(...changes) },
  );
  const changesOf = (id: string) => batches.get("b1")?.overrides[id]?.parents ?? null;
  return { links, passing, changesOf };
}

beforeEach(() => {
  setActivePinia(createPinia());
  metadataFake.parentRecords.value = new Map();
  metadataFake.parentGone.value = new Set();
  metadataFake.parentMissing.value = new Set();
  metadataFake.parentFailed.value = new Set();
  metadataFake.findParents = async () => [];
  useSettingsStore().config = { ...DEFAULT_CONFIG, dataPassingCollectionTypes: [SERIAL] };
});

describe("rows for one item (Metadata)", () => {
  it("lists the item's backend links, then its pending ones", () => {
    const { links } = setup({
      targets: ["i1"],
      backend: { i1: ["p1"] },
      changes: { i1: { parents: { add: ["p9"], remove: [], passing: null } } },
    });
    expect(links.parents.value.map((p) => [p.id, p.status, p.count])).toEqual([
      ["p1", "linked", null],
      ["p9", "new", null],
    ]);
  });

  it("keeps a pending unlink in the list, marked", () => {
    const { links } = setup({
      targets: ["i1"],
      backend: { i1: ["p1"] },
      changes: { i1: { parents: { add: [], remove: ["p1"], passing: null } } },
    });
    expect(links.parents.value.map((p) => [p.id, p.status])).toEqual([["p1", "unlinking"]]);
  });

  it("shows only the pending links while the item's backend links are unknown", () => {
    const { links } = setup({
      targets: ["i1"],
      changes: { i1: { parents: { add: ["p9"], remove: [], passing: null } } },
    });
    metadataFake.backendLinks.value = new Map([["i1", null]]);
    expect(links.parents.value.map((p) => [p.id, p.status])).toEqual([["p9", "new"]]);
  });
});

describe("editing one item", () => {
  it("links a parent to the item only, and saves it on the batch", async () => {
    const { links, changesOf } = setup({ targets: ["i1"], members: ["i1", "i2"] });
    await links.linkParent("p9");
    expect(changesOf("i1")).toEqual({ add: ["p9"], remove: [], passing: null });
    expect(changesOf("i2")).toBeNull();
  });

  it("queues an unlink of a backend link, and Undo takes it back", async () => {
    const { links, changesOf } = setup({ targets: ["i1"], backend: { i1: ["p1"] } });
    await links.removeParent("p1");
    expect(changesOf("i1")).toEqual({ add: [], remove: ["p1"], passing: null });
    await links.restoreParent("p1");
    expect(changesOf("i1")).toBeNull();
  });

  it("Link to all reaches every item in the batch", async () => {
    const { links, changesOf } = setup({ targets: ["i1"], members: ["i1", "i2"], backend: { i2: ["p9"] } });
    await links.linkParentToAll("p9");
    expect(changesOf("i1")).toEqual({ add: ["p9"], remove: [], passing: null });
    expect(changesOf("i2")).toBeNull(); // it already has p9 on the backend
  });
});

describe("rows for several items (Setup)", () => {
  it("counts how many items have each parent", () => {
    const { links } = setup({ targets: ["i1", "i2"], backend: { i1: ["p1"] } });
    expect(links.parents.value.map((p) => [p.id, p.count])).toEqual([["p1", { on: 1, of: 2 }]]);
  });

  it("links and unlinks for every item", async () => {
    const { links, changesOf } = setup({ targets: ["i1", "i2"] });
    await links.linkParent("p9");
    expect(links.parents.value.map((p) => [p.id, p.count])).toEqual([["p9", { on: 2, of: 2 }]]);
    await links.removeParent("p9");
    expect(changesOf("i1")).toBeNull();
    expect(changesOf("i2")).toBeNull();
  });
});

describe("passing data", () => {
  it("passes through a newly linked serial that is the item's only one, and reports it once", async () => {
    metadataFake.parentRecords.value = new Map([["s1", record("s1", SERIAL)]]);
    const { links, changesOf, passing } = setup({ targets: ["i1"] });
    await links.linkParent("s1");
    expect(changesOf("i1")?.passing).toBe("s1");
    expect(passing).toEqual([{ itemId: "i1", parent: record("s1", SERIAL) }]);
  });

  it("never starts passing through a backend link on its own", async () => {
    metadataFake.parentRecords.value = new Map([
      ["s1", record("s1", SERIAL)],
      ["c1", record("c1")],
    ]);
    const { links, changesOf, passing } = setup({ targets: ["i1"], backend: { i1: ["s1"] } });
    await links.linkParent("c1");
    expect(changesOf("i1")?.passing).toBeNull();
    expect(passing).toEqual([]);
  });

  it("toggles passing on and off for the items that have the parent", async () => {
    metadataFake.parentRecords.value = new Map([["s1", record("s1", SERIAL)]]);
    const { links, changesOf } = setup({ targets: ["i1", "i2"], backend: { i1: ["s1"] } });
    await links.togglePassesData("s1");
    expect(changesOf("i1")?.passing).toBe("s1");
    expect(changesOf("i2")).toBeNull();
    await links.togglePassesData("s1");
    expect(changesOf("i1")).toBeNull();
  });

  it("Link to all leaves an item that already has the parent alone", async () => {
    metadataFake.parentRecords.value = new Map([["s1", record("s1", SERIAL)]]);
    const { links, changesOf, passing } = setup({ targets: ["i1"], members: ["i1", "i2"], backend: { i2: ["s1"] } });
    await links.linkParentToAll("s1");
    expect(changesOf("i1")).toEqual({ add: ["s1"], remove: [], passing: "s1" });
    expect(changesOf("i2")).toBeNull();
    expect(passing).toEqual([{ itemId: "i1", parent: record("s1", SERIAL) }]);
  });

  it("linking a backend link back after a pending unlink doesn't start it passing", async () => {
    metadataFake.parentRecords.value = new Map([["s1", record("s1", SERIAL)]]);
    const { links, changesOf, passing } = setup({
      targets: ["i1"],
      backend: { i1: ["s1"] },
      changes: { i1: { parents: { add: [], remove: ["s1"], passing: null } } },
    });
    await links.linkParent("s1");
    expect(changesOf("i1")).toBeNull();
    expect(passing).toEqual([]);
  });
});

describe("the per-field source picker", () => {
  it("offers only the item's parents that can pass data", () => {
    useSettingsStore().config = { ...DEFAULT_CONFIG, dataPassingCollectionTypes: [3, 4] };
    metadataFake.parentRecords.value = new Map([
      ["s1", record("s1", 4)],
      ["c1", record("c1", 1)],
      ["z1", record("z1", 3)],
    ]);
    const { links } = setup({ targets: ["i1"], backend: { i1: ["s1", "c1", "z1"] } });
    expect(links.sourceRecords.value.map((r) => r.id)).toEqual(["s1", "z1"]);
  });
});

describe("the picker's list", () => {
  it("lists the newest collections when opened with nothing typed, once", async () => {
    const asked: string[] = [];
    metadataFake.findParents = async (q: string) => {
      asked.push(q);
      return [record("c1", 3)];
    };
    const { links } = setup({ targets: ["i1"] });
    await links.openPicker();
    await links.openPicker(); // already listed: no second request
    expect(asked).toEqual([""]);
    expect(links.results.value.map((r) => r.id)).toEqual(["c1"]);
  });

  it("closes the list at once when the typed text is cleared, as × does", async () => {
    metadataFake.findParents = async () => [record("c1", 3)];
    const { links } = setup({ targets: ["i1"] });
    await links.openPicker();
    links.setQuery("");
    expect(links.results.value).toEqual([]);
  });
});
