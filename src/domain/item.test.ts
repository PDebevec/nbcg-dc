import { describe, it, expect } from "vitest";
import {
  ItemState,
  deriveItemState,
  hasFailedStage,
  isPublished,
  stagePipStatus,
  firstStageError,
  emptyStages,
  type Item,
  type ItemStages,
  type StageName,
  type StageStatus,
} from "./item";

/** A fresh "To process" item; override any field per case. */
function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "i1",
    folderName: "gorski_vijenac",
    folderPath: "/unprocessed/gorski_vijenac",
    root: "unprocessed",
    level: "main",
    assets: [],
    stages: emptyStages(),
    flags: { uploaded: false, reupload: false },
    backendId: null,
    batchId: null,
    title: null,
    catalogueId: null,
    createdAt: null,
    updatedAt: null,
    syncMissStreak: 0,
    ...overrides,
  };
}

function stagesWith(stage: StageName, status: StageStatus, error?: string): ItemStages {
  return { ...emptyStages(), [stage]: { status, error: error ?? null } };
}

describe("deriveItemState — first match wins (docs/01)", () => {
  it("a fresh scan is To process", () => {
    expect(deriveItemState(makeItem())).toBe(ItemState.ToProcess);
  });

  it("membership in a batch is In progress", () => {
    expect(deriveItemState(makeItem({ batchId: "b1" }))).toBe(
      ItemState.InProgress,
    );
  });

  it("a failed stage (no batch) is Stopped", () => {
    const item = makeItem({ stages: stagesWith("pdf", "failed", "boom") });
    expect(deriveItemState(item)).toBe(ItemState.Stopped);
  });

  it("the uploaded flag is Uploaded", () => {
    expect(
      deriveItemState(makeItem({ flags: { uploaded: true, reupload: false } })),
    ).toBe(ItemState.Uploaded);
  });

  it("a done upload stage is Uploaded even without the flag", () => {
    const item = makeItem({ stages: stagesWith("upload", "done") });
    expect(deriveItemState(item)).toBe(ItemState.Uploaded);
  });

  it("published + reupload is Needs re-upload (Uploaded excludes reupload)", () => {
    const item = makeItem({ flags: { uploaded: true, reupload: true } });
    expect(deriveItemState(item)).toBe(ItemState.NeedsReupload);
  });

  it("reupload alone (never cleanly uploaded) is still Needs re-upload", () => {
    const item = makeItem({ flags: { uploaded: false, reupload: true } });
    expect(deriveItemState(item)).toBe(ItemState.NeedsReupload);
  });

  it("a dirtied published item in an active re-work batch is In progress", () => {
    const item = makeItem({
      flags: { uploaded: true, reupload: true },
      batchId: "b9",
    });
    expect(deriveItemState(item)).toBe(ItemState.InProgress);
  });

  it("a clean uploaded item in an active re-work batch is In progress (locked to that batch)", () => {
    // A re-work batch is created from Done items before any edit sets reupload,
    // so this is the initial state of every re-work batch — it must read In
    // progress, not Uploaded (docs/01 "locked to that batch"; Create batch → In
    // progress). It settles back to Uploaded only once the batch releases it.
    const item = makeItem({
      flags: { uploaded: true, reupload: false },
      batchId: "b9",
    });
    expect(deriveItemState(item)).toBe(ItemState.InProgress);
  });

  it("a clean uploaded item with no batch is Uploaded", () => {
    const item = makeItem({ flags: { uploaded: true, reupload: false } });
    expect(deriveItemState(item)).toBe(ItemState.Uploaded);
  });

  it("published wins over a stale failed stage", () => {
    const item = makeItem({
      flags: { uploaded: true, reupload: false },
      stages: stagesWith("ocr", "failed", "bad"),
    });
    expect(deriveItemState(item)).toBe(ItemState.Uploaded);
  });

  it("a batch beats a failed stage for a not-yet-published item", () => {
    const item = makeItem({
      batchId: "b1",
      stages: stagesWith("pdf", "failed", "x"),
    });
    expect(deriveItemState(item)).toBe(ItemState.InProgress);
  });

  it("every state is reachable", () => {
    const states = new Set([
      deriveItemState(makeItem()),
      deriveItemState(makeItem({ batchId: "b" })),
      deriveItemState(makeItem({ flags: { uploaded: false, reupload: true } })),
      deriveItemState(makeItem({ stages: stagesWith("pdf", "failed") })),
      deriveItemState(makeItem({ flags: { uploaded: true, reupload: false } })),
    ]);
    expect(states).toEqual(
      new Set([
        ItemState.ToProcess,
        ItemState.InProgress,
        ItemState.NeedsReupload,
        ItemState.Stopped,
        ItemState.Uploaded,
      ]),
    );
  });
});

describe("helpers", () => {
  it("hasFailedStage detects any failed stage", () => {
    expect(hasFailedStage(emptyStages())).toBe(false);
    expect(hasFailedStage(stagesWith("thumbnail", "failed"))).toBe(true);
  });

  it("isPublished reflects flag or upload-done", () => {
    expect(isPublished(makeItem())).toBe(false);
    expect(
      isPublished(makeItem({ flags: { uploaded: true, reupload: false } })),
    ).toBe(true);
    expect(isPublished(makeItem({ stages: stagesWith("upload", "done") }))).toBe(
      true,
    );
  });

  it("firstStageError returns the earliest failed stage's message", () => {
    const stages: ItemStages = {
      ...emptyStages(),
      thumbnail: { status: "failed", error: "thumb boom" },
      ocr: { status: "failed", error: "ocr boom" },
    };
    expect(firstStageError(makeItem({ stages }))).toBe("thumb boom");
    expect(firstStageError(makeItem())).toBeNull();
  });
});

describe("stagePipStatus", () => {
  it("maps the upload pip to re-upload when a published item is dirty", () => {
    const item = makeItem({ flags: { uploaded: true, reupload: true } });
    expect(stagePipStatus(item, "upload")).toBe("re-upload");
  });

  it("does not show re-upload when the item was never published", () => {
    const item = makeItem({ flags: { uploaded: false, reupload: true } });
    expect(stagePipStatus(item, "upload")).toBe("pending");
  });

  it("passes through a stage's own status", () => {
    const item = makeItem({ stages: stagesWith("ocr", "skipped") });
    expect(stagePipStatus(item, "ocr")).toBe("skipped");
    expect(stagePipStatus(item, "pdf")).toBe("pending");
  });
});
