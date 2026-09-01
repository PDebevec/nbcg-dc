import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { discoverAsset, type DiscoveredAsset } from "@domain/files";
import { emptyStages, ItemState, type Item, type ItemStages, type StageName } from "@domain/item";
import { BatchStage, ItemRunStatus, type Batch } from "@domain/batch";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import type { BatchRunRequest } from "@ipc/bindings";
import type { JobDoneEvent, JobProgressEvent, JobStageChangedEvent } from "@ipc/events";

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

// ── the service layer this store sits on, faked ─────────────────────────────
// The side-effecting half of @services/pipeline (the native drive + the three
// subscriptions) is faked; the pure half (buildRunRequest / seedProcFromItems /
// applyJobDone / applyStageChanged) stays real via importOriginal — that pure
// logic is exactly what these tests exist to exercise through the store, so
// stubbing it would test the mock instead of the store.

const drive = {
  start: [] as BatchRunRequest[],
  reprocess: [] as BatchRunRequest[],
  cancel: [] as string[],
  /** Set to make the next drive call reject — "never launched natively". */
  rejectWith: null as Error | null,
};
const watch = {
  stage: [] as Array<(e: JobStageChangedEvent) => void>,
  done: [] as Array<(e: JobDoneEvent) => void>,
  progress: [] as Array<(e: JobProgressEvent) => void>,
  unlistens: 0,
};

vi.mock("@services/pipeline", async (importOriginal) => {
  const real = await importOriginal<typeof import("@services/pipeline")>();
  const unlisten = () => {
    watch.unlistens += 1;
  };
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
      drive.reprocess.push(r);
      maybeThrow();
    },
    cancelRun: async (id: string) => {
      drive.cancel.push(id);
      maybeThrow();
    },
    watchJobStageChanged: async (h: (e: JobStageChangedEvent) => void) => {
      watch.stage.push(h);
      return unlisten;
    },
    watchJobDone: async (h: (e: JobDoneEvent) => void) => {
      watch.done.push(h);
      return unlisten;
    },
    watchJobProgress: async (h: (e: JobProgressEvent) => void) => {
      watch.progress.push(h);
      return unlisten;
    },
  };
});

const persisted: Batch[] = [];
vi.mock("@services/batches", () => ({
  listBatches: async () => [] as Batch[],
  createBatch: async (f: unknown) => f as Batch,
  updateBatch: async (b: Batch) => {
    persisted.push(b);
    return b;
  },
  archiveBatch: async (b: Batch) => b,
}));

const itemsFake = {
  items: [] as Item[],
  loaded: true,
  refreshCalls: 0,
  replaceItem(i: Item) {
    const k = itemsFake.items.findIndex((x) => x.id === i.id);
    if (k >= 0) itemsFake.items = itemsFake.items.map((x, n) => (n === k ? i : x));
  },
  async refresh() {
    itemsFake.refreshCalls += 1;
  },
  async load() {},
};
vi.mock("./useItems", () => ({ useItemsStore: () => itemsFake }));

const { useProcessingStore } = await import("./useProcessing");
const { useBatchesStore } = await import("./useBatches");

/** Seed the batches store with one batch and its items, replacing whatever was
 * there before (a full reassignment, not a merge — safe to call repeatedly
 * within one test). */
function seed(batch: Batch, items: Item[]) {
  const batches = useBatchesStore();
  batches.batches = [batch];
  itemsFake.items = items;
  return batches;
}

beforeEach(() => {
  setActivePinia(createPinia());
  drive.start = [];
  drive.reprocess = [];
  drive.cancel = [];
  drive.rejectWith = null;
  watch.stage = [];
  watch.done = [];
  watch.progress = [];
  watch.unlistens = 0;
  persisted.length = 0;
  itemsFake.items = [];
  itemsFake.loaded = true;
  itemsFake.refreshCalls = 0;
});

describe("single-run guards", () => {
  it("blocks on an unknown batch id", async () => {
    const store = useProcessingStore();
    await store.start("ghost");
    expect(drive.start).toHaveLength(0);
    expect(persisted).toHaveLength(0);
  });

  it("blocks on an archived batch", async () => {
    const item = makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.tif")] });
    seed(makeBatch(["a"], { archivedAt: "2026-08-20T00:00:00.000Z" }), [item]);
    const store = useProcessingStore();
    await store.start("b1");
    expect(drive.start).toHaveLength(0);
  });

  it("blocks starting a batch that is already running", async () => {
    const item = makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.tif")] });
    seed(makeBatch(["a"], { running: true }), [item]);
    const store = useProcessingStore();
    await store.start("b1");
    expect(drive.start).toHaveLength(0);
  });

  it("blocks starting while another batch is running", async () => {
    const a = makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.tif")] });
    const z = makeItem({ id: "z", folderName: "z", assets: [asset("z", "z.tif")] });
    const batches = useBatchesStore();
    batches.batches = [makeBatch(["a"], { id: "b1" }), makeBatch(["z"], { id: "b2", running: true })];
    itemsFake.items = [a, z];
    const store = useProcessingStore();
    await store.start("b1");
    expect(drive.start).toHaveLength(0);
  });
});

describe("command routing + request shape", () => {
  it("start sends only the runnable items, seeding done members and queueing the rest", async () => {
    const runnable = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    const done = makeItem({
      id: "old",
      folderName: "old",
      assets: [asset("old", "old.pdf")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    const batches = seed(makeBatch(["nb", "old"]), [runnable, done]);
    const store = useProcessingStore();

    await store.start("b1");

    expect(drive.start).toHaveLength(1);
    expect(drive.start[0].mode).toBe("run");
    expect(drive.start[0].items.map((i) => i.itemId)).toEqual(["nb"]);
    expect(drive.reprocess).toHaveLength(0);
    const current = batches.get("b1")!;
    expect(current.proc.old).toBe(ItemRunStatus.Done);
    expect(current.proc.nb).toBe(ItemRunStatus.Queued);
    expect(current.running).toBe(true);
    expect(current.stage).toBe(BatchStage.Processing);
  });

  it("settles straight to Ready when nothing is runnable and every member is actually done", async () => {
    const done = makeItem({
      id: "old",
      folderName: "old",
      assets: [asset("old", "old.pdf")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    const batches = seed(makeBatch(["old"], { stage: BatchStage.Processing }), [done]);
    const store = useProcessingStore();

    await store.start("b1");

    expect(drive.start).toHaveLength(0);
    const current = batches.get("b1")!;
    expect(current.running).toBe(false);
    expect(current.stage).toBe(BatchStage.Ready);
  });

  it("does nothing when there is no work but a member is genuinely blocked, not done", async () => {
    // images-only, 2 candidates: the thumbnail stage already reads "done" (so
    // stagesToRun has nothing left to run) but the pick is unresolved, so
    // procFromProcessing reads Idle, not Done — a real blocker, not "all set".
    const item = makeItem({
      id: "map",
      folderName: "map",
      assets: [asset("map", "a.jpg"), asset("map", "b.jpg")],
      stages: stagesWith({ thumbnail: "done" }),
    });
    const batches = seed(makeBatch(["map"], { stage: BatchStage.Metadata }), [item]);
    const store = useProcessingStore();

    await store.start("b1");

    expect(drive.start).toHaveLength(0);
    expect(persisted).toHaveLength(0);
    const current = batches.get("b1")!;
    expect(current.stage).toBe(BatchStage.Metadata);
    expect(current.running).toBe(false);
  });

  it("rerunFailed restricts the request to failed items", async () => {
    const failed = makeItem({
      id: "f",
      folderName: "f",
      assets: [asset("f", "f.pdf")],
      stages: stagesWith({ pdf: "failed" }),
    });
    const ok = makeItem({ id: "ok", folderName: "ok", assets: [asset("ok", "ok.pdf")] });
    const batch = makeBatch(["f", "ok"], {
      proc: { f: ItemRunStatus.Failed, ok: ItemRunStatus.Idle },
    });
    seed(batch, [failed, ok]);
    const store = useProcessingStore();

    await store.rerunFailed("b1");

    expect(drive.start).toHaveLength(1);
    expect(drive.start[0].mode).toBe("rerun");
    expect(drive.start[0].items.map((i) => i.itemId)).toEqual(["f"]);
  });

  it("rerunItem targets exactly the one item", async () => {
    const a = makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.pdf")] });
    const b = makeItem({ id: "b", folderName: "b", assets: [asset("b", "b.pdf")] });
    seed(makeBatch(["a", "b"]), [a, b]);
    const store = useProcessingStore();

    await store.rerunItem("b1", "b");

    expect(drive.start[0].mode).toBe("rerun");
    expect(drive.start[0].items.map((i) => i.itemId)).toEqual(["b"]);
  });

  it("reprocess forces the chosen stage even though it is already done, via reprocessRun", async () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "0001.tif")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    seed(makeBatch(["nb"]), [item]);
    const store = useProcessingStore();

    await store.reprocess("b1", "nb", ["ocr"]);

    expect(drive.reprocess).toHaveLength(1);
    expect(drive.start).toHaveLength(0);
    expect(drive.reprocess[0].mode).toBe("reprocess");
    expect(drive.reprocess[0].items[0].stages).toEqual(["ocr"]);
  });

  it("cancel reaches cancelRun even for a batch id the store holds nothing for — not gated by the run guard", async () => {
    const store = useProcessingStore();
    await store.cancel("ghost-batch");
    expect(drive.cancel).toEqual(["ghost-batch"]);
  });

  it("a rejecting cancelRun sets an error rather than throwing", async () => {
    drive.rejectWith = new Error("native cancel failed");
    const store = useProcessingStore();
    await expect(store.cancel("b1")).resolves.toBeUndefined();
    expect(store.error).toBe("native cancel failed");
  });
});

describe("optimistic launch + rollback", () => {
  it("a successful launch persists running + Processing + queued before/through the drive resolving", async () => {
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    seed(makeBatch(["nb"], { stage: BatchStage.Metadata }), [item]);
    const store = useProcessingStore();

    await store.start("b1");

    expect(persisted.length).toBeGreaterThan(0);
    const first = persisted[0];
    expect(first.running).toBe(true);
    expect(first.stage).toBe(BatchStage.Processing);
    expect(first.proc.nb).toBe(ItemRunStatus.Queued);
    expect(store.activeBatchId).toBe("b1");
  });

  // The regression test for the bug the non-blocking-runner plan fixed: a run
  // that never launched natively must not leave items stuck Queued with
  // running=false — crash recovery can't rescue that (it only gates on
  // running===true).
  it("rolls back an optimistic launch when the native start rejects", async () => {
    drive.rejectWith = new Error("native refused");
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    seed(makeBatch(["nb"], { stage: BatchStage.Metadata }), [item]);
    const store = useProcessingStore();

    await store.start("b1");

    expect(store.error).toBe("native refused");
    expect(store.activeBatchId).toBeNull();
    const last = persisted[persisted.length - 1];
    expect(last.running).toBe(false);
    expect(Object.values(last.proc)).not.toContain(ItemRunStatus.Queued);
  });

  it("does not leave the run lock held after a rejected launch", async () => {
    drive.rejectWith = new Error("native refused");
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    seed(makeBatch(["nb"], { stage: BatchStage.Metadata }), [item]);
    const store = useProcessingStore();
    await store.start("b1");
    expect(drive.start).toHaveLength(1);

    drive.rejectWith = null;
    await store.start("b1");

    expect(drive.start).toHaveLength(2);
  });
});

describe("event bridge", () => {
  it("startWatch subscribes once per channel and is idempotent", async () => {
    const store = useProcessingStore();
    await store.startWatch();
    await store.startWatch();
    expect(watch.stage).toHaveLength(1);
    expect(watch.done).toHaveLength(1);
    expect(watch.progress).toHaveLength(1);
  });

  it("stopWatch tears down every subscription, and a following startWatch resubscribes", async () => {
    const store = useProcessingStore();
    await store.startWatch();
    store.stopWatch();
    expect(watch.unlistens).toBe(3);

    await store.startWatch();
    expect(watch.stage).toHaveLength(2);
  });

  it("a running stage-changed reflects on the item and bumps proc to running", async () => {
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    const batches = seed(makeBatch(["nb"]), [item]);
    const store = useProcessingStore();
    await store.startWatch();

    watch.stage[0]({ batchId: "b1", itemId: "nb", stage: "pdf", status: "running" });

    expect(itemsFake.items[0].stages.pdf.status).toBe("running");
    expect(batches.get("b1")!.proc.nb).toBe(ItemRunStatus.Running);
  });

  it("ignores a late running event for an item whose proc already settled done", async () => {
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    const batch = makeBatch(["nb"], { proc: { nb: ItemRunStatus.Done } });
    const batches = seed(batch, [item]);
    const store = useProcessingStore();
    await store.startWatch();

    watch.stage[0]({ batchId: "b1", itemId: "nb", stage: "pdf", status: "running" });

    expect(batches.get("b1")!.proc.nb).toBe(ItemRunStatus.Done);
  });

  it("a stage-changed for an unknown item id is a no-op, not a throw", async () => {
    seed(makeBatch(["nb"]), [makeItem({ id: "nb", folderName: "nb" })]);
    const store = useProcessingStore();
    await store.startWatch();

    expect(() =>
      watch.stage[0]({ batchId: "b1", itemId: "ghost", stage: "pdf", status: "running" }),
    ).not.toThrow();
    expect(itemsFake.items).toHaveLength(1);
  });

  it("progress updates the live map, and logs a line only when a message is present", async () => {
    seed(makeBatch(["nb"]), [makeItem({ id: "nb", folderName: "nb" })]);
    const store = useProcessingStore();
    await store.startWatch();

    watch.progress[0]({ batchId: "b1", itemId: "nb", stage: "ocr", progress: 0.5 });
    expect(store.progress.get("nb")?.progress).toBe(0.5);
    expect(store.log).toHaveLength(0);

    watch.progress[0]({ batchId: "b1", itemId: "nb", stage: "ocr", progress: 0.6, message: "page 3/5" });
    expect(store.log).toHaveLength(1);
    expect(store.log[0]).toContain("page 3/5");
  });

  it("a non-terminal done sets the item outcome without clearing the run", async () => {
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    const batches = seed(makeBatch(["nb"], { stage: BatchStage.Metadata }), [item]);
    const store = useProcessingStore();
    await store.startWatch();
    await store.start("b1");
    expect(store.activeBatchId).toBe("b1");

    watch.done[0]({ batchId: "b1", itemId: "nb", outcome: "done", batchComplete: false });

    expect(batches.get("b1")!.proc.nb).toBe(ItemRunStatus.Done);
    expect(store.activeBatchId).toBe("b1");
    expect(itemsFake.refreshCalls).toBe(0);
  });

  // The frontend half of the just-built Rust cancellation work: a terminal
  // cancel must clear the run and drop in-flight items back to idle — never
  // settle the batch at Ready, and never leave anything looking Failed.
  it("a terminal cancel clears the run and settles in-flight items to idle, not Ready", async () => {
    const a = makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.tif")] });
    const b = makeItem({ id: "b", folderName: "b", assets: [asset("b", "b.tif")] });
    const batch = makeBatch(["a", "b"], {
      stage: BatchStage.Processing,
      running: true,
      proc: { a: ItemRunStatus.Done, b: ItemRunStatus.Running },
    });
    const batches = seed(batch, [a, b]);
    const store = useProcessingStore();
    await store.startWatch();
    store.activeBatchId = "b1";

    watch.done[0]({ batchId: "b1", itemId: null, outcome: "cancelled", batchComplete: true });

    expect(store.activeBatchId).toBeNull();
    expect(store.progress.size).toBe(0);
    expect(itemsFake.refreshCalls).toBe(1);
    const current = batches.get("b1")!;
    expect(current.running).toBe(false);
    expect(current.proc).toEqual({ a: ItemRunStatus.Done, b: ItemRunStatus.Idle });
    expect(current.stage).toBe(BatchStage.Processing);
  });

  it("a done event for an unknown batch id is a no-op, not a throw", async () => {
    const store = useProcessingStore();
    await store.startWatch();
    expect(() =>
      watch.done[0]({ batchId: "ghost", itemId: null, outcome: "done", batchComplete: true }),
    ).not.toThrow();
    expect(persisted).toHaveLength(0);
  });
});
