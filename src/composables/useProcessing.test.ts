import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { reactive, ref } from "vue";
import { discoverAsset, type DiscoveredAsset } from "@domain/files";
import { emptyStages, ItemState, type Item, type ItemStages, type StageName } from "@domain/item";
import { BatchStage, ItemRunStatus, type Batch } from "@domain/batch";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import type { BatchRunRequest } from "@ipc/bindings";
import type { JobDoneEvent, JobProgressEvent, JobStageChangedEvent } from "@ipc/events";

// This composable never touches the DOM: getCurrentInstance() is null outside
// a mounted component, so onMounted(init) is simply skipped — no jsdom needed.

// ── fixtures (mirrors services/pipeline.test.ts) ────────────────────────────

function asset(folderName: string, f: string): DiscoveredAsset {
  return discoverAsset(f, `/scans/${folderName}/${f}`, folderName);
}

function stagesWith(
  overrides: Partial<Record<StageName, ItemStages[StageName]["status"]>>,
): ItemStages {
  const s = emptyStages();
  for (const [name, status] of Object.entries(overrides)) {
    s[name as StageName] = { status: status! };
  }
  return s;
}

function makeItem(over: Partial<Item> & { id: string; folderName: string }): Item {
  return {
    id: over.id,
    folderName: over.folderName,
    folderPath: over.folderPath ?? `/scans/${over.folderName}`,
    relativePath: over.relativePath ?? over.folderName,
    hidden: over.hidden ?? false,
    root: over.root ?? "unprocessed",
    level: over.level ?? "main",
    assets: over.assets ?? [],
    stages: over.stages ?? emptyStages(),
    flags: over.flags ?? { uploaded: false, reupload: false },
    backendId: over.backendId ?? null,
    batchId: over.batchId ?? null,
    title: over.title ?? null,
    catalogueId: over.catalogueId ?? null,
    createdAt: over.createdAt ?? null,
    updatedAt: over.updatedAt ?? null,
    syncMissStreak: over.syncMissStreak ?? 0,
  };
}

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

// ── mocks (same seams as stores/useProcessing.test.ts, plus the composable's
// own metadata/upload dependencies) ─────────────────────────────────────────

const drive = {
  start: [] as BatchRunRequest[],
  cancel: [] as string[],
  rejectWith: null as Error | null,
};
const watch = {
  stage: [] as Array<(e: JobStageChangedEvent) => void>,
  done: [] as Array<(e: JobDoneEvent) => void>,
  progress: [] as Array<(e: JobProgressEvent) => void>,
};

vi.mock("@services/pipeline", async (importOriginal) => {
  const real = await importOriginal<typeof import("@services/pipeline")>();
  const maybeThrow = () => {
    if (drive.rejectWith) throw drive.rejectWith;
  };
  return {
    ...real,
    startRun: async (r: BatchRunRequest) => {
      drive.start.push(r);
      maybeThrow();
    },
    reprocessRun: async (r: BatchRunRequest) => {
      maybeThrow();
      return r;
    },
    cancelRun: async (id: string) => {
      drive.cancel.push(id);
      maybeThrow();
    },
    watchJobStageChanged: async (h: (e: JobStageChangedEvent) => void) => {
      watch.stage.push(h);
      return () => {};
    },
    watchJobDone: async (h: (e: JobDoneEvent) => void) => {
      watch.done.push(h);
      return () => {};
    },
    watchJobProgress: async (h: (e: JobProgressEvent) => void) => {
      watch.progress.push(h);
      return () => {};
    },
  };
});

vi.mock("@services/batches", () => ({
  listBatches: async () => [] as Batch[],
  createBatch: async (f: unknown) => f as Batch,
  updateBatch: async (b: Batch) => b,
  archiveBatch: async (b: Batch) => b,
}));

// Reactive so the composable's computeds (rows/statuses/…) actually re-derive
// when a test seeds new items after the composable has already read them once.
const itemsFake = reactive({
  items: [] as Item[],
  loaded: true,
  refreshCalls: 0,
  replaceItem(i: Item) {
    const k = itemsFake.items.findIndex((x) => x.id === i.id);
    if (k >= 0) itemsFake.items.splice(k, 1, i);
  },
  async refresh() {
    itemsFake.refreshCalls += 1;
  },
  async load() {},
});
vi.mock("@stores/useItems", () => ({ useItemsStore: () => itemsFake }));

const metadataFake = {
  ready: true,
  async ensureItemLoaded() {},
  isReady(): boolean {
    return metadataFake.ready;
  },
  wireMetadata(): Record<string, unknown> {
    return {};
  },
  async flush() {},
};
vi.mock("@stores/useMetadata", () => ({ useMetadataStore: () => metadataFake }));

vi.mock("@stores/useUpload", () => ({
  useUploadStore: () => ({
    activeBatchId: ref<string | null>(null),
    progress: ref(null),
    results: ref(new Map()),
    error: ref<string | null>(null),
    run: async () => true,
    resultsFor: () => new Map(),
  }),
}));

// Deferred imports so the mock factories above close over already-initialised
// fixtures (same pattern as stores/useSettings.test.ts).
const { useProcessing } = await import("./useProcessing");
const { useProcessingStore } = await import("@stores/useProcessing");
const { useBatchesStore } = await import("@stores/useBatches");
const { useToastsStore } = await import("@stores/useToasts");

function seed(batch: Batch, items: Item[]) {
  const batches = useBatchesStore();
  batches.batches = [batch];
  itemsFake.items = items;
  return batches;
}

beforeEach(() => {
  setActivePinia(createPinia());
  drive.start = [];
  drive.cancel = [];
  drive.rejectWith = null;
  watch.stage = [];
  watch.done = [];
  watch.progress = [];
  itemsFake.items = [];
  itemsFake.loaded = true;
  itemsFake.refreshCalls = 0;
  metadataFake.ready = true;
});

describe("showCancel", () => {
  it("is true only once this session's own launch is the batch that's running", async () => {
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    seed(makeBatch(["nb"], { stage: BatchStage.Metadata }), [item]);
    const view = useProcessing(() => "b1");
    expect(view.showCancel.value).toBe(false);

    await view.start();
    expect(view.showCancel.value).toBe(true);
  });

  it("is false when the batch is running but this session never launched it", () => {
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    seed(makeBatch(["nb"], { running: true }), [item]);
    const view = useProcessing(() => "b1");
    expect(view.showCancel.value).toBe(false);
  });
});

describe("cancel", () => {
  it("drives cancelRun and toasts on failure", async () => {
    seed(makeBatch(["nb"], { running: true }), [makeItem({ id: "nb", folderName: "nb" })]);
    drive.rejectWith = new Error("native cancel failed");
    const toasts = useToastsStore();
    const view = useProcessing(() => "b1");

    await view.cancel();

    expect(drive.cancel).toEqual(["b1"]);
    expect(
      toasts.toasts.some((t) => t.message === "native cancel failed" && t.kind === "error"),
    ).toBe(true);
  });
});

describe("start gating", () => {
  it("is a no-op while another batch is running (blockedNote)", async () => {
    const a = makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.tif")] });
    const z = makeItem({ id: "z", folderName: "z", assets: [asset("z", "z.tif")] });
    const batches = useBatchesStore();
    batches.batches = [makeBatch(["a"], { id: "b1" }), makeBatch(["z"], { id: "b2", running: true })];
    itemsFake.items = [a, z];
    const view = useProcessing(() => "b1");

    expect(view.blockedNote.value).not.toBeNull();
    await view.start();
    expect(drive.start).toHaveLength(0);
  });

  it("is a no-op once the batch is already running", async () => {
    seed(makeBatch(["nb"], { running: true }), [makeItem({ id: "nb", folderName: "nb" })]);
    const view = useProcessing(() => "b1");
    expect(view.showStart.value).toBe(false);

    await view.start();
    expect(drive.start).toHaveLength(0);
  });
});

describe("primary-action buttons agree with batch state", () => {
  it("a fresh batch offers Start only", () => {
    seed(makeBatch(["a"], { stage: BatchStage.Metadata }), [
      makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.tif")] }),
    ]);
    const view = useProcessing(() => "b1");
    expect(view.showStart.value).toBe(true);
    expect(view.showRerunAll.value).toBe(false);
    expect(view.showUpload.value).toBe(false);
  });

  it("an all-done batch offers Upload, not Start", () => {
    const done = makeItem({
      id: "done",
      folderName: "done",
      assets: [asset("done", "done.pdf")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    seed(makeBatch(["done"], { stage: BatchStage.Processing, proc: { done: ItemRunStatus.Done } }), [
      done,
    ]);
    const view = useProcessing(() => "b1");
    expect(view.showStart.value).toBe(false);
    expect(view.showUpload.value).toBe(true);
  });

  it("a batch with a failed item offers Rerun all failed alongside Start", () => {
    const failed = makeItem({
      id: "f",
      folderName: "f",
      assets: [asset("f", "f.pdf")],
      stages: stagesWith({ pdf: "failed" }),
    });
    seed(makeBatch(["f"], { stage: BatchStage.Processing, proc: { f: ItemRunStatus.Failed } }), [
      failed,
    ]);
    const view = useProcessing(() => "b1");
    expect(view.showRerunAll.value).toBe(true);
    expect(view.showStart.value).toBe(true);
  });
});

describe("canUpload", () => {
  it("is blocked by a hard metadata gate, and clears once metadata is ready", () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf"), asset("nb", "cover.jpg")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    seed(makeBatch(["nb"], { stage: BatchStage.Processing, proc: { nb: ItemRunStatus.Done } }), [
      item,
    ]);

    metadataFake.ready = false;
    let view = useProcessing(() => "b1");
    expect(view.canUpload.value).toBe(false);
    expect(view.rows.value[0].gates.some((g) => g.hard)).toBe(true);

    metadataFake.ready = true;
    view = useProcessing(() => "b1");
    expect(view.canUpload.value).toBe(true);
  });
});

describe("live rows", () => {
  it("progressLabel is populated only for the running row, from the live job://progress feed", async () => {
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    seed(makeBatch(["nb"], { stage: BatchStage.Metadata }), [item]);
    const view = useProcessing(() => "b1");
    await view.start();
    const processing = useProcessingStore();
    await processing.startWatch();

    watch.stage[0]({ batchId: "b1", itemId: "nb", stage: "pdf", status: "running" });
    watch.progress[0]({ batchId: "b1", itemId: "nb", stage: "pdf", progress: 0.3 });

    const row = view.rows.value.find((r) => r.id === "nb")!;
    expect(row.status).toBe("running");
    expect(row.progressLabel).toContain("pdf");
    expect(row.progressLabel).toContain("30%");
  });

  // Direct GUI-side confirmation of the Rust settle behaviour just built: a
  // cancel leaves the interrupted item Pending, never Failed, and the item's
  // proc drops back to idle — so the operator sees "Not started" and Start
  // is offered again, not a red error they didn't cause.
  it("a cancelled, half-processed item reads Not started, and Start is offered again", () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "0001.tif")],
      stages: stagesWith({ pdf: "done", thumbnail: "pending", ocr: "pending" }),
    });
    seed(
      makeBatch(["nb"], { stage: BatchStage.Processing, running: false, proc: { nb: ItemRunStatus.Idle } }),
      [item],
    );
    const view = useProcessing(() => "b1");

    expect(view.rows.value[0].status).toBe("idle");
    expect(view.rows.value[0].statusLabel).toBe("Not started");
    expect(view.showStart.value).toBe(true);
  });
});
