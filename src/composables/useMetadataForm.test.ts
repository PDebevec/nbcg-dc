import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { reactive, ref } from "vue";
import { vi } from "vitest";
import { BatchStage, ItemRunStatus, type Batch } from "@domain/batch";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import { ItemState } from "@domain/item";

// This composable never touches the DOM: getCurrentInstance() is null outside
// a mounted component, so its onMounted(init) is simply skipped (see
// useProcessing.test.ts for the same reasoning) — no jsdom needed. The batch
// here has no member items, so every item-scoped computed (`current`, `check`,
// `views`, …) short-circuits on an empty array; only `editable` and the fix's
// new `uploadingNote` are under test.

function makeBatch(itemIds: string[], over: Partial<Batch> = {}): Batch {
  const proc: Record<string, ItemRunStatus> = {};
  for (const id of itemIds) proc[id] = ItemRunStatus.Idle;
  return {
    id: "b1",
    no: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    type: ItemState.ToProcess,
    itemIds,
    stage: BatchStage.Metadata,
    running: false,
    proc,
    cobissId: null,
    parents: [],
    publish: PublishTarget.DRAFT,
    visibility: VisibilityStatus.PRIVATE,
    overrides: {},
    archivedAt: null,
    ...over,
  };
}

// ── mocks (same seams as useProcessing.test.ts, plus the composable's own
// parent-links dependency) ──────────────────────────────────────────────────

vi.mock("@services/batches", () => ({
  listBatches: async () => [] as Batch[],
  createBatch: async (f: unknown) => f as Batch,
  updateBatch: async (b: unknown) => b as Batch,
  archiveBatch: async (b: unknown) => b as Batch,
}));

vi.mock("@stores/useItems", () => ({
  useItemsStore: () => ({ items: [], loaded: true, load: async () => {} }),
}));

const metadataFake = {
  values: ref(new Map()),
  schemaLoading: ref(false),
  schemaError: ref<string | null>(null),
  loadedItems: ref(new Set<string>()),
  saving: ref(new Set<string>()),
  parentRecords: ref(new Map()),
  parentLoading: ref(new Set<string>()),
  parentGone: ref(new Set<string>()),
  parentMissing: ref(new Set<string>()),
  parentFailed: ref(new Set<string>()),
  fields: [],
  ensureItemLoaded: async () => {},
  checkOf: () => null,
  readinessOf: () => "untouched" as const,
  batchParentsOf: () => ({ records: [], missing: [], failed: [], pending: false }),
  plainValues: () => ({}),
  ensureParents: async () => {},
  ensureParent: async () => {},
  findParents: async () => [],
  flush: async () => {},
};
vi.mock("@stores/useMetadata", () => ({ useMetadataStore: () => metadataFake }));

// Module-level (not recreated per test) so a test's mid-run mutation of
// `activeBatchId` is what the composable's already-built computeds observe.
// `reactive`, not a plain object holding a ref: the real store is a Pinia
// reactive proxy, which auto-unwraps a top-level ref on both read and write —
// the composable reads `uploadStore.activeBatchId` (no `.value`), so a plain
// `{ activeBatchId: ref(null) }` would compare the Ref instance itself to a
// string and never match.
const uploadFake = reactive({ activeBatchId: null as string | null });
vi.mock("@stores/useUpload", () => ({ useUploadStore: () => uploadFake }));

// Deferred imports so the mock factories above are in place first (same
// pattern as useProcessing.test.ts / useSettings.test.ts).
const { useMetadataForm } = await import("./useMetadataForm");
const { useBatchesStore } = await import("@stores/useBatches");

beforeEach(() => {
  setActivePinia(createPinia());
  uploadFake.activeBatchId = null;
  metadataFake.parentRecords.value = new Map();
  metadataFake.parentGone.value = new Set();
  metadataFake.parentMissing.value = new Set();
  metadataFake.parentFailed.value = new Set();
});

describe("editable", () => {
  // Pins the round-1 fix: `uploadBatch` writes each item's mirror as it
  // finishes (one at a time), and the store only reloads them once the whole
  // run is done. Until this, an edit typed in that window would autosave
  // `backendId: null` back over a mirror the upload had just linked to the
  // backend — exactly the bug the task set out to fix. Locking the tab while
  // this batch is the one uploading closes that window.
  it("turns false only while this batch is the one uploading, and recovers after", () => {
    const batches = useBatchesStore();
    batches.batches = [makeBatch([])];
    const view = useMetadataForm(() => "b1");

    expect(view.editable.value).toBe(true);
    expect(view.uploadingNote.value).toBe("");

    uploadFake.activeBatchId = "b1";
    expect(view.editable.value).toBe(false);
    expect(view.uploadingNote.value).toBe(
      "Uploading — editing is paused until the upload finishes.",
    );

    uploadFake.activeBatchId = null;
    expect(view.editable.value).toBe(true);
    expect(view.uploadingNote.value).toBe("");
  });

  it("is unaffected by a different batch uploading", () => {
    const batches = useBatchesStore();
    batches.batches = [makeBatch([])];
    uploadFake.activeBatchId = "some-other-batch";

    const view = useMetadataForm(() => "b1");

    expect(view.editable.value).toBe(true);
    expect(view.uploadingNote.value).toBe("");
  });
});

describe("parent rows", () => {
  function record(id: string) {
    return { id, title: `Parent ${id}`, collectionType: null, metadata: {} };
  }

  it("say why a parent is missing before its cached record's own type", () => {
    const batches = useBatchesStore();
    batches.batches = [
      makeBatch([], {
        parents: ["gone", "notFound", "failed", "ok"].map((id) => ({ id, passesData: false })),
      }),
    ];
    // The gone parent had loaded before the upload refused it: its record stays cached.
    metadataFake.parentRecords.value = new Map([
      ["gone", record("gone")],
      ["ok", record("ok")],
    ]);
    metadataFake.parentGone.value = new Set(["gone"]);
    metadataFake.parentMissing.value = new Set(["notFound"]);
    metadataFake.parentFailed.value = new Set(["failed"]);

    const view = useMetadataForm(() => "b1");

    expect(view.parents.value.map((p) => p.typeLabel)).toEqual([
      "No longer exists",
      "Not found on backend",
      "Couldn't load",
      "Record",
    ]);
  });
});
