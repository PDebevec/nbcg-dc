import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { BatchStage, ItemRunStatus, type Batch } from "@domain/batch";
import { DEFAULT_CONFIG } from "@domain/config";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import { ItemState, type Item } from "@domain/item";
import type { ParentRecord } from "@domain/parent";
import type { ApplyMode, OverwriteConflict } from "@domain/provenance";
import type { FieldV2 } from "@domain/schema";

function makeBatch(itemIds: string[], over: Partial<Batch> = {}): Batch {
  const proc: Record<string, ItemRunStatus> = {};
  for (const id of itemIds) proc[id] = ItemRunStatus.Idle;
  return {
    id: "b1",
    no: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    type: ItemState.ToProcess,
    itemIds,
    stage: BatchStage.Setup,
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

function serial(id: string): ParentRecord {
  return { id, title: `Serial ${id}`, collectionType: 4, metadata: { collectionType: 4 } };
}

vi.mock("@services/batches", () => ({
  listBatches: async () => [] as Batch[],
  createBatch: async (f: unknown) => f as Batch,
  updateBatch: async (b: unknown) => b as Batch,
  archiveBatch: async (b: unknown) => b as Batch,
}));

const itemsFake = { items: [] as Item[], loaded: true, load: async () => {} };
vi.mock("@stores/useItems", () => ({ useItemsStore: () => itemsFake }));

const metadataFake = {
  parentRecords: ref(new Map<string, ParentRecord>()),
  parentLoading: ref(new Set<string>()),
  parentGone: ref(new Set<string>()),
  parentMissing: ref(new Set<string>()),
  parentFailed: ref(new Set<string>()),
  backendLinks: ref(new Map<string, string[] | null>()),
  ensureParents: async () => {},
  ensureParent: async () => {},
  findParents: async () => [] as ParentRecord[],
  ensureItemLoaded: async () => {},
  fields: [] as FieldV2[],
  parentOverwritesFor: vi.fn((_itemId: string, _parent: ParentRecord): OverwriteConflict[] => []),
  applyParentTo: vi.fn((_itemId: string, _parent: ParentRecord, _mode?: ApplyMode) => ({
    values: {},
    conflicts: [],
    applied: [],
    skipped: [],
    stillToFill: [],
  })),
  applyCobissTo: vi.fn(),
  flush: async () => {},
};
vi.mock("@stores/useMetadata", () => ({ useMetadataStore: () => metadataFake }));

const { useBatchSetup } = await import("./useBatchSetup");
const { useBatchesStore } = await import("@stores/useBatches");
const { useSettingsStore } = await import("@stores/useSettings");

beforeEach(() => {
  setActivePinia(createPinia());
  metadataFake.applyParentTo.mockClear();
  metadataFake.parentOverwritesFor.mockReset();
  metadataFake.parentOverwritesFor.mockReturnValue([]);
  useSettingsStore().config = { ...DEFAULT_CONFIG, dataPassingCollectionTypes: [4] };
});

/** Item i1 passes data from serial s1. */
function batchWithPassingSerial(): void {
  metadataFake.parentRecords.value = new Map([["s1", serial("s1")]]);
  metadataFake.backendLinks.value = new Map([["i1", []]]);
  useBatchesStore().batches = [
    makeBatch(["i1"], { overrides: { i1: { parents: { add: ["s1"], remove: [], passing: "s1" } } } }),
  ];
  itemsFake.items = [item("i1")];
}

const SUBTITLE_REPLACED: OverwriteConflict = {
  key: "subtitle",
  currentValue: "Mine",
  incomingValue: "Dnevni list",
  incomingProvenance: "parent",
};

describe("Apply & continue over filled-in fields", () => {
  it("asks first; Cancel stays on Setup and copies nothing", async () => {
    batchWithPassingSerial();
    metadataFake.parentOverwritesFor.mockReturnValue([SUBTITLE_REPLACED]);
    const setup = useBatchSetup(() => "b1");

    const next = setup.applyAndContinue();
    await new Promise((r) => setTimeout(r, 0));
    expect(setup.copyPrompt.value?.fields.map((f) => f.key)).toEqual(["subtitle"]);
    setup.answerCopyPrompt("cancel");

    expect(await next).toBe(false);
    expect(metadataFake.applyParentTo).not.toHaveBeenCalled();
  });

  it("copies over them when the operator chooses Overwrite", async () => {
    batchWithPassingSerial();
    metadataFake.parentOverwritesFor.mockReturnValue([SUBTITLE_REPLACED]);
    const setup = useBatchSetup(() => "b1");

    const next = setup.applyAndContinue();
    await new Promise((r) => setTimeout(r, 0));
    setup.answerCopyPrompt("overwrite-all");

    expect(await next).toBe(true);
    expect(metadataFake.applyParentTo.mock.calls.map(([id, p, mode]) => [id, p.id, mode])).toEqual([
      ["i1", "s1", "overwrite-all"],
    ]);
  });
});

describe("Apply & continue", () => {
  it("fills each item from its own passing parent", async () => {
    metadataFake.parentRecords.value = new Map([
      ["s1", serial("s1")],
      ["s2", serial("s2")],
    ]);
    metadataFake.backendLinks.value = new Map([
      ["i1", []],
      ["i2", []],
    ]);
    useBatchesStore().batches = [
      makeBatch(["i1", "i2"], {
        overrides: {
          i1: { parents: { add: ["s1"], remove: [], passing: "s1" } },
          i2: { parents: { add: ["s2"], remove: [], passing: "s2" } },
        },
      }),
    ];
    itemsFake.items = [item("i1"), item("i2")];
    const setup = useBatchSetup(() => "b1");

    expect(await setup.applyAndContinue()).toBe(true);

    expect(metadataFake.applyParentTo.mock.calls.map(([id, p]) => [id, p.id])).toEqual([
      ["i1", "s1"],
      ["i2", "s2"],
    ]);
  });
});
