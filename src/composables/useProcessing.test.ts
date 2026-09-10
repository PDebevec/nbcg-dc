import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { reactive, ref } from "vue";
import { discoverAsset, type DiscoveredAsset } from "@domain/files";
import { emptyStages, ItemState, type Item, type ItemStages, type StageName } from "@domain/item";
import { BatchStage, ItemRunStatus, type Batch } from "@domain/batch";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import type { BatchRunRequest } from "@ipc/bindings";
import type { JobDoneEvent, JobProgressEvent, JobStageChangedEvent } from "@ipc/events";
import type { ItemUploadResult } from "@services/upload";

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
    flags: over.flags ?? { uploaded: false, reupload: false, reuploadTextOnly: false },
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
  reprocess: [] as BatchRunRequest[],
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
      drive.reprocess.push(r);
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

// Module-level so a test can seed an upload result and have the composable's
// `results` computed see it (a fresh object per call could not be reached).
const uploadFake = {
  activeBatchId: ref<string | null>(null),
  progress: ref(null),
  results: ref(new Map<string, Map<string, ItemUploadResult>>()),
  error: ref<string | null>(null),
  run: async () => true,
  resultsFor: () => new Map(),
};
vi.mock("@stores/useUpload", () => ({ useUploadStore: () => uploadFake }));

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
  drive.reprocess = [];
  drive.cancel = [];
  drive.rejectWith = null;
  watch.stage = [];
  watch.done = [];
  watch.progress = [];
  itemsFake.items = [];
  itemsFake.loaded = true;
  itemsFake.refreshCalls = 0;
  metadataFake.ready = true;
  uploadFake.results.value = new Map();
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

// ── the expanded per-step view ──────────────────────────────────────────────
//
// Built for the operator who was told only "Not fully processed yet
// (thumbnail)." at upload time, with no way to see which step was outstanding
// or to run just that one.

describe("per-step rows", () => {
  it("gives every item one row per pipeline stage", () => {
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "nb.pdf")] });
    seed(makeBatch(["nb"]), [item]);
    const view = useProcessing(() => "b1");

    expect(view.rows.value[0].steps.map((s) => s.stage)).toEqual([
      "pdf",
      "thumbnail",
      "ocr",
      "metadata",
      "upload",
    ]);
  });

  // The exact shape that stalled: the run finished, nothing failed, and the
  // thumbnail stage sits at Pending because 53 loose images are 53 equal
  // candidates (`settle_web_stages` holds it there on purpose).
  it("names the step that is holding a finished-looking item, and offers to run it", () => {
    const item = makeItem({
      id: "liona",
      folderName: "liona",
      assets: [
        asset("liona", "Pisma_iz_Liona_310.pdf"),
        asset("liona", "01.jpg"),
        asset("liona", "02.jpg"),
      ],
      stages: stagesWith({ pdf: "done", thumbnail: "pending", ocr: "done" }),
    });
    seed(
      makeBatch(["liona"], {
        stage: BatchStage.Processing,
        proc: { liona: ItemRunStatus.Done },
      }),
      [item],
    );
    const view = useProcessing(() => "b1");
    const row = view.rows.value[0];
    const thumbnail = row.steps.find((s) => s.stage === "thumbnail")!;

    expect(thumbnail.state).toBe("held");
    expect(thumbnail.action).toBeTruthy();
    expect(thumbnail.rerunnable).toBe(true);
    expect(row.attention?.stage).toBe("thumbnail");
  });

  it("surfaces a stage failure as the step's own error, not just a row-level string", () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf")],
      stages: { ...emptyStages(), ocr: { status: "failed", error: "ocr.py failed: exit 3" } },
    });
    seed(
      makeBatch(["nb"], { stage: BatchStage.Processing, proc: { nb: ItemRunStatus.Failed } }),
      [item],
    );
    const view = useProcessing(() => "b1");
    const ocr = view.rows.value[0].steps.find((s) => s.stage === "ocr")!;

    expect(ocr.state).toBe("failed");
    expect(ocr.error).toBe("ocr.py failed: exit 3");
  });

  // The sentence the operator was actually left with. `services/upload` puts
  // only the first blocker's bare text on the result, so "Not fully processed
  // yet (thumbnail)." arrived with no next move attached.
  it("re-renders a blocked upload result through the GUI copy, with a next move", () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf")],
      stages: stagesWith({ pdf: "done", thumbnail: "pending", ocr: "done" }),
    });
    seed(
      makeBatch(["nb"], { stage: BatchStage.Processing, proc: { nb: ItemRunStatus.Done } }),
      [item],
    );
    uploadFake.results.value = new Map([
      [
        "b1",
        new Map([
          [
            "nb",
            {
              itemId: "nb",
              status: "blocked" as const,
              backendId: null,
              blockers: [
                { code: "not-processed" as const, message: "Not fully processed yet (thumbnail)." },
                { code: "metadata-invalid" as const, message: "Required metadata is incomplete or invalid." },
              ],
              warnings: [],
              fieldErrors: [],
              relationErrors: [],
              parentStates: [],
              message: "Not fully processed yet (thumbnail).",
            },
          ],
        ]),
      ],
    ]);
    const view = useProcessing(() => "b1");
    const upload = view.rows.value[0].upload!;

    expect(upload.message).toContain("thumbnail");
    expect(upload.message).toMatch(/run just that step/i);
    // Every gate, not only the first — two blockers meant two trips before.
    expect(upload.fieldErrors).toHaveLength(1);
    expect(upload.fieldErrors[0]).toMatch(/Metadata tab/);
  });
});

describe("rerunStep", () => {
  it("re-processes exactly the one step asked for, forced, and nothing downstream", async () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    seed(
      makeBatch(["nb"], { stage: BatchStage.Processing, proc: { nb: ItemRunStatus.Done } }),
      [item],
    );
    const view = useProcessing(() => "b1");

    await view.rerunStep("nb", "thumbnail");

    expect(drive.reprocess).toHaveLength(1);
    expect(drive.reprocess[0].items).toHaveLength(1);
    expect(drive.reprocess[0].items[0].itemId).toBe("nb");
    // Not pdf, not ocr — an hours-long OCR must never be a side effect of
    // fixing a thumbnail.
    expect(drive.reprocess[0].items[0].stages).toEqual(["thumbnail"]);
  });

  it("does nothing while a batch is already running", async () => {
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "nb.pdf")] });
    seed(makeBatch(["nb"], { running: true }), [item]);
    const view = useProcessing(() => "b1");

    expect(view.rows.value[0].canRerunStep).toBe(false);
    await view.rerunStep("nb", "ocr");
    expect(drive.reprocess).toHaveLength(0);
  });
});

describe("the batch progress bar", () => {
  it("moves while a single long item is still running, instead of sitting at zero", () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "pending" }),
    });
    seed(makeBatch(["nb"], { stage: BatchStage.Processing }), [item]);
    const view = useProcessing(() => "b1");

    expect(view.ratio.value).toBeGreaterThan(0);
    // …but the hours-long step is still ahead, so it must not read nearly done.
    expect(view.ratio.value).toBeLessThan(0.25);
  });

  it("stops short of 100% when a step is still outstanding on a done-looking item", () => {
    const held = makeItem({
      id: "liona",
      folderName: "liona",
      assets: [
        asset("liona", "Pisma_iz_Liona_310.pdf"),
        asset("liona", "01.jpg"),
        asset("liona", "02.jpg"),
      ],
      stages: stagesWith({ pdf: "done", thumbnail: "pending", ocr: "done" }),
    });
    seed(
      makeBatch(["liona"], {
        stage: BatchStage.Processing,
        proc: { liona: ItemRunStatus.Done },
      }),
      [held],
    );
    const view = useProcessing(() => "b1");

    expect(view.ratio.value).toBeLessThan(1);
    expect(view.ratio.value).toBeGreaterThan(0.9);
  });

  it("reaches 100% when every applicable step really is done", () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf"), asset("nb", "cover.jpg")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    seed(
      makeBatch(["nb"], { stage: BatchStage.Processing, proc: { nb: ItemRunStatus.Done } }),
      [item],
    );
    const view = useProcessing(() => "b1");

    expect(view.ratio.value).toBe(1);
  });
});
