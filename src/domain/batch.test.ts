import { describe, it, expect } from "vitest";
import { ItemState } from "./item";
import { PublishTarget, VisibilityStatus } from "./enums";
import {
  Batch,
  BatchStage,
  BatchTab,
  ItemRunStatus,
  allItemsDone,
  availableTabs,
  anyOtherRunning,
  batchLabel,
  batchProgress,
  enterMetadata,
  enterProcessing,
  failedItemIds,
  hasSetup,
  initialStageFor,
  isArchived,
  isReworkType,
  isUnfinished,
  needsRecovery,
  newBatchFields,
  openTabFor,
  queueItems,
  recoverBatch,
  resetInFlightRuns,
  requiresUnlock,
  resolveItemPublish,
  resolveItemVisibility,
  runningBatch,
  settleStageAfterRun,
  singleRunBlockedMessage,
  stepIndexForStage,
  tabForStage,
  withItemRun,
  withRunning,
} from "./batch";

/** A batch with sensible defaults; override any field per case. */
function makeBatch(overrides: Partial<Batch> = {}): Batch {
  const itemIds = overrides.itemIds ?? ["i1", "i2"];
  const proc: Record<string, ItemRunStatus> = {};
  for (const id of itemIds) proc[id] = ItemRunStatus.Idle;
  return {
    id: "b1",
    no: 17,
    createdAt: "2026-08-04T00:00:00.000Z",
    type: ItemState.ToProcess,
    itemIds,
    stage: BatchStage.Setup,
    running: false,
    proc,
    cobissId: null,
    parents: [],
    publish: PublishTarget.DRAFT,
    visibility: VisibilityStatus.PRIVATE,
    overrides: {},
    archivedAt: null,
    ...overrides,
  };
}

describe("isReworkType", () => {
  it("is true for Stopped / Needs re-upload / Uploaded", () => {
    expect(isReworkType(ItemState.Stopped)).toBe(true);
    expect(isReworkType(ItemState.NeedsReupload)).toBe(true);
    expect(isReworkType(ItemState.Uploaded)).toBe(true);
  });
  it("is false for To process / In progress", () => {
    expect(isReworkType(ItemState.ToProcess)).toBe(false);
    expect(isReworkType(ItemState.InProgress)).toBe(false);
  });
});

describe("initialStageFor — the start tab (docs/tasks/03)", () => {
  it("a multi-item fresh batch starts at Setup", () => {
    expect(initialStageFor(ItemState.ToProcess, 3)).toBe(BatchStage.Setup);
  });
  it("a single fresh item skips Setup → Metadata", () => {
    expect(initialStageFor(ItemState.ToProcess, 1)).toBe(BatchStage.Metadata);
  });
  it("a re-work batch (any size) starts at Processing", () => {
    expect(initialStageFor(ItemState.Uploaded, 1)).toBe(BatchStage.Processing);
    expect(initialStageFor(ItemState.Stopped, 5)).toBe(BatchStage.Processing);
    expect(initialStageFor(ItemState.NeedsReupload, 2)).toBe(
      BatchStage.Processing,
    );
  });
});

describe("tabForStage", () => {
  it("maps setup/metadata directly and processing/ready/uploaded → Processing", () => {
    expect(tabForStage(BatchStage.Setup)).toBe(BatchTab.Setup);
    expect(tabForStage(BatchStage.Metadata)).toBe(BatchTab.Metadata);
    expect(tabForStage(BatchStage.Processing)).toBe(BatchTab.Processing);
    expect(tabForStage(BatchStage.Ready)).toBe(BatchTab.Processing);
    expect(tabForStage(BatchStage.Uploaded)).toBe(BatchTab.Processing);
  });
});

describe("openTabFor — landing tab when reopening", () => {
  it("a fresh multi-item batch at Setup opens Setup", () => {
    expect(openTabFor(makeBatch({ stage: BatchStage.Setup }))).toBe(
      BatchTab.Setup,
    );
  });
  it("a single fresh item opens Metadata (implicit via its initial stage)", () => {
    const b = makeBatch({
      itemIds: ["i1"],
      stage: initialStageFor(ItemState.ToProcess, 1),
    });
    expect(openTabFor(b)).toBe(BatchTab.Metadata);
  });
  it("a fresh batch that has progressed follows its stage", () => {
    expect(openTabFor(makeBatch({ stage: BatchStage.Metadata }))).toBe(
      BatchTab.Metadata,
    );
    expect(openTabFor(makeBatch({ stage: BatchStage.Processing }))).toBe(
      BatchTab.Processing,
    );
  });
  it("a re-work batch opens Processing", () => {
    const b = makeBatch({ type: ItemState.Stopped, stage: BatchStage.Processing });
    expect(openTabFor(b)).toBe(BatchTab.Processing);
  });
  it("an uploaded/archived batch opens Processing (read-only)", () => {
    expect(openTabFor(makeBatch({ stage: BatchStage.Uploaded }))).toBe(
      BatchTab.Processing,
    );
    expect(
      openTabFor(makeBatch({ archivedAt: "2026-08-04T01:00:00.000Z" })),
    ).toBe(BatchTab.Processing);
  });
});

describe("hasSetup / availableTabs", () => {
  it("a fresh multi-item batch has Setup", () => {
    const b = makeBatch({ type: ItemState.ToProcess, itemIds: ["i1", "i2"] });
    expect(hasSetup(b)).toBe(true);
    expect(availableTabs(b)).toEqual([
      BatchTab.Setup,
      BatchTab.Metadata,
      BatchTab.Processing,
    ]);
  });
  it("a single fresh item has no Setup", () => {
    const b = makeBatch({ itemIds: ["i1"] });
    expect(hasSetup(b)).toBe(false);
    expect(availableTabs(b)).toEqual([BatchTab.Metadata, BatchTab.Processing]);
  });
  it("a re-work batch has no Setup even with many items", () => {
    const b = makeBatch({ type: ItemState.Uploaded, itemIds: ["i1", "i2", "i3"] });
    expect(hasSetup(b)).toBe(false);
    expect(availableTabs(b)).toEqual([BatchTab.Metadata, BatchTab.Processing]);
  });
});

describe("requiresUnlock — Done batches open read-only", () => {
  it("a live Done (Uploaded-type) batch requires unlock", () => {
    expect(requiresUnlock(makeBatch({ type: ItemState.Uploaded }))).toBe(true);
  });
  it("a Stopped / Needs-re-upload re-work batch opens editable", () => {
    expect(requiresUnlock(makeBatch({ type: ItemState.Stopped }))).toBe(false);
    expect(requiresUnlock(makeBatch({ type: ItemState.NeedsReupload }))).toBe(
      false,
    );
  });
  it("an archived batch does not offer unlock (terminal read-only)", () => {
    const b = makeBatch({
      type: ItemState.Uploaded,
      archivedAt: "2026-08-04T01:00:00.000Z",
    });
    expect(requiresUnlock(b)).toBe(false);
    expect(isArchived(b)).toBe(true);
  });
});

describe("stepIndexForStage", () => {
  it("maps each stage to its step", () => {
    expect(stepIndexForStage(BatchStage.Setup)).toBe(0);
    expect(stepIndexForStage(BatchStage.Metadata)).toBe(1);
    expect(stepIndexForStage(BatchStage.Processing)).toBe(2);
    expect(stepIndexForStage(BatchStage.Ready)).toBe(2);
    expect(stepIndexForStage(BatchStage.Uploaded)).toBe(2);
  });
});

describe("batchProgress / failedItemIds", () => {
  it("counts done runs and computes the ratio", () => {
    const b = makeBatch({
      itemIds: ["a", "b", "c", "d"],
      proc: {
        a: ItemRunStatus.Done,
        b: ItemRunStatus.Done,
        c: ItemRunStatus.Running,
        d: ItemRunStatus.Failed,
      },
    });
    expect(batchProgress(b)).toEqual({ done: 2, total: 4, ratio: 0.5 });
    expect(failedItemIds(b)).toEqual(["d"]);
  });
  it("an empty batch is 0/0 with ratio 0", () => {
    expect(batchProgress(makeBatch({ itemIds: [], proc: {} }))).toEqual({
      done: 0,
      total: 0,
      ratio: 0,
    });
  });
});

describe("single-run guard", () => {
  const running = makeBatch({ id: "b1", no: 12, running: true });
  const idle = makeBatch({ id: "b2", no: 13, running: false });

  it("runningBatch finds the live batch, else null", () => {
    expect(runningBatch([idle, running])?.id).toBe("b1");
    expect(runningBatch([idle])).toBeNull();
  });
  it("anyOtherRunning ignores the excepted batch", () => {
    expect(anyOtherRunning([running, idle])).toBe(true);
    expect(anyOtherRunning([running, idle], "b1")).toBe(false); // b1 is the runner
    expect(anyOtherRunning([running, idle], "b2")).toBe(true); // b1 still runs
    expect(anyOtherRunning([idle])).toBe(false);
  });
  it("the block message names the running batch", () => {
    expect(singleRunBlockedMessage(running)).toContain("Batch #012");
    expect(singleRunBlockedMessage(null)).toContain("Another batch");
  });
});

describe("isUnfinished", () => {
  it("is true until uploaded/archived", () => {
    expect(isUnfinished(makeBatch({ stage: BatchStage.Setup }))).toBe(true);
    expect(isUnfinished(makeBatch({ stage: BatchStage.Ready }))).toBe(true);
  });
  it("is false once uploaded or archived", () => {
    expect(isUnfinished(makeBatch({ stage: BatchStage.Uploaded }))).toBe(false);
    expect(
      isUnfinished(makeBatch({ archivedAt: "2026-08-04T01:00:00.000Z" })),
    ).toBe(false);
  });
});

describe("resolveItemPublish / resolveItemVisibility", () => {
  it("falls back to the batch defaults", () => {
    const b = makeBatch({
      publish: PublishTarget.DRAFT,
      visibility: VisibilityStatus.PRIVATE,
    });
    expect(resolveItemPublish(b, "i1")).toBe(PublishTarget.DRAFT);
    expect(resolveItemVisibility(b, "i1")).toBe(VisibilityStatus.PRIVATE);
  });
  it("uses a per-item override when present", () => {
    const b = makeBatch({
      overrides: {
        i1: { publish: PublishTarget.RECORD, visibility: VisibilityStatus.PUBLIC },
      },
    });
    expect(resolveItemPublish(b, "i1")).toBe(PublishTarget.RECORD);
    expect(resolveItemVisibility(b, "i1")).toBe(VisibilityStatus.PUBLIC);
    // other items still see the batch default
    expect(resolveItemPublish(b, "i2")).toBe(PublishTarget.DRAFT);
  });
});

describe("batchLabel", () => {
  it("zero-pads to three digits", () => {
    expect(batchLabel(17)).toBe("Batch #017");
    expect(batchLabel(1)).toBe("Batch #001");
    expect(batchLabel(1234)).toBe("Batch #1234");
  });
});

describe("crash recovery", () => {
  it("needsRecovery only for a left-running batch", () => {
    expect(needsRecovery(makeBatch({ running: false }))).toBe(false);
    expect(needsRecovery(makeBatch({ running: true }))).toBe(true);
  });
  it("recoverBatch clears running and resets in-flight items, keeping done/failed", () => {
    const b = makeBatch({
      running: true,
      itemIds: ["a", "b", "c", "d"],
      proc: {
        a: ItemRunStatus.Running,
        b: ItemRunStatus.Queued,
        c: ItemRunStatus.Done,
        d: ItemRunStatus.Failed,
      },
    });
    const r = recoverBatch(b);
    expect(r.running).toBe(false);
    expect(r.proc).toEqual({
      a: ItemRunStatus.Idle,
      b: ItemRunStatus.Idle,
      c: ItemRunStatus.Done,
      d: ItemRunStatus.Failed,
    });
    // pure — the original is untouched
    expect(b.running).toBe(true);
  });
  it("recoverBatch returns the input untouched when not running", () => {
    const b = makeBatch({ running: false });
    expect(recoverBatch(b)).toBe(b);
  });
  it("resetInFlightRuns clears queued/running (cancel path), keeping done/failed", () => {
    const b = makeBatch({
      itemIds: ["a", "b", "c", "d"],
      proc: {
        a: ItemRunStatus.Queued,
        b: ItemRunStatus.Running,
        c: ItemRunStatus.Done,
        d: ItemRunStatus.Failed,
      },
    });
    expect(resetInFlightRuns(b).proc).toEqual({
      a: ItemRunStatus.Idle,
      b: ItemRunStatus.Idle,
      c: ItemRunStatus.Done,
      d: ItemRunStatus.Failed,
    });
    // no-op identity when nothing is in flight
    const settled = makeBatch({ proc: { i1: ItemRunStatus.Done, i2: ItemRunStatus.Failed } });
    expect(resetInFlightRuns(settled)).toBe(settled);
  });
});

describe("processing-run reducers (Epic 06)", () => {
  it("withRunning flips the flag and is a no-op when unchanged", () => {
    const b = makeBatch({ running: false });
    expect(withRunning(b, true).running).toBe(true);
    expect(withRunning(b, false)).toBe(b); // identity — no needless write-through
  });

  it("withItemRun sets a member's outcome; ignores non-members and no-ops", () => {
    const b = makeBatch({ itemIds: ["a", "b"] });
    const ran = withItemRun(b, "a", ItemRunStatus.Running);
    expect(ran.proc).toEqual({ a: ItemRunStatus.Running, b: ItemRunStatus.Idle });
    expect(b.proc.a).toBe(ItemRunStatus.Idle); // pure — original untouched
    expect(withItemRun(b, "ghost", ItemRunStatus.Done)).toBe(b); // non-member
    expect(withItemRun(ran, "a", ItemRunStatus.Running)).toBe(ran); // unchanged
  });

  it("queueItems marks members queued, ignoring unknown ids", () => {
    const b = makeBatch({ itemIds: ["a", "b"] });
    const q = queueItems(b, ["a", "ghost"]);
    expect(q.proc).toEqual({ a: ItemRunStatus.Queued, b: ItemRunStatus.Idle });
    expect(queueItems(q, [])).toBe(q); // no change → identity
  });

  it("allItemsDone requires every member done (false when empty)", () => {
    expect(
      allItemsDone(
        makeBatch({ itemIds: ["a", "b"], proc: { a: ItemRunStatus.Done, b: ItemRunStatus.Done } }),
      ),
    ).toBe(true);
    expect(
      allItemsDone(
        makeBatch({ itemIds: ["a", "b"], proc: { a: ItemRunStatus.Done, b: ItemRunStatus.Failed } }),
      ),
    ).toBe(false);
    expect(allItemsDone(makeBatch({ itemIds: [], proc: {} }))).toBe(false);
  });

  it("enterMetadata advances from Setup only, never regressing", () => {
    expect(enterMetadata(makeBatch({ stage: BatchStage.Setup })).stage).toBe(
      BatchStage.Metadata,
    );
    // Already at or past Metadata → identity, so it can be called freely on
    // every tab change without walking the stage backwards.
    for (const stage of [
      BatchStage.Metadata,
      BatchStage.Processing,
      BatchStage.Ready,
      BatchStage.Uploaded,
    ]) {
      const batch = makeBatch({ stage });
      expect(enterMetadata(batch)).toBe(batch);
    }
  });

  it("enterProcessing advances from Setup/Metadata only, never regressing", () => {
    expect(enterProcessing(makeBatch({ stage: BatchStage.Setup })).stage).toBe(
      BatchStage.Processing,
    );
    expect(enterProcessing(makeBatch({ stage: BatchStage.Metadata })).stage).toBe(
      BatchStage.Processing,
    );
    const ready = makeBatch({ stage: BatchStage.Ready });
    expect(enterProcessing(ready)).toBe(ready); // no regression, identity
  });

  it("settleStageAfterRun → ready when all done, else processing; keeps uploaded", () => {
    const done = makeBatch({
      itemIds: ["a", "b"],
      proc: { a: ItemRunStatus.Done, b: ItemRunStatus.Done },
      stage: BatchStage.Processing,
    });
    expect(settleStageAfterRun(done)).toBe(BatchStage.Ready);

    const partial = makeBatch({
      itemIds: ["a", "b"],
      proc: { a: ItemRunStatus.Done, b: ItemRunStatus.Failed },
      stage: BatchStage.Ready, // a rerun that failed drops back to processing
    });
    expect(settleStageAfterRun(partial)).toBe(BatchStage.Processing);

    expect(settleStageAfterRun(makeBatch({ stage: BatchStage.Uploaded }))).toBe(
      BatchStage.Uploaded,
    );
  });
});

describe("newBatchFields — create defaults", () => {
  it("defaults stage from type+count, seeds idle proc, and applies safe defaults", () => {
    const f = newBatchFields({ type: ItemState.ToProcess, itemIds: ["a", "b"] });
    expect(f.stage).toBe(BatchStage.Setup);
    expect(f.running).toBe(false);
    expect(f.proc).toEqual({ a: ItemRunStatus.Idle, b: ItemRunStatus.Idle });
    expect(f.cobissId).toBeNull();
    expect(f.parents).toEqual([]);
    expect(f.overrides).toEqual({});
    expect(f.publish).toBe(PublishTarget.DRAFT);
    expect(f.visibility).toBe(VisibilityStatus.PRIVATE);
  });
  it("honours explicit cobissId/publish/visibility and single-item stage", () => {
    const f = newBatchFields({
      type: ItemState.ToProcess,
      itemIds: ["only"],
      cobissId: "123456789",
      publish: PublishTarget.RECORD,
      visibility: VisibilityStatus.PUBLIC,
    });
    expect(f.stage).toBe(BatchStage.Metadata); // single fresh item
    expect(f.cobissId).toBe("123456789");
    expect(f.publish).toBe(PublishTarget.RECORD);
    expect(f.visibility).toBe(VisibilityStatus.PUBLIC);
  });
  it("copies itemIds (no aliasing of the caller's array)", () => {
    const ids = ["a"];
    const f = newBatchFields({ type: ItemState.ToProcess, itemIds: ids });
    ids.push("b");
    expect(f.itemIds).toEqual(["a"]);
  });
});
