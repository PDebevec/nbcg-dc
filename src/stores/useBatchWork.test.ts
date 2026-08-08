import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import {
  BatchStage,
  BatchTab,
  ItemRunStatus,
  newBatchFields,
  type Batch,
} from "@domain/batch";
import { ItemState } from "@domain/item";

// ── the service layer the batches store sits on, faked ─────────────────────
// This suite is about the *session* store's behaviour (tab resolution, and the
// stage advance that rides on a tab change), so persistence is a spy.

const persisted: Batch[] = [];

vi.mock("@services/batches", () => ({
  listBatches: async () => [] as Batch[],
  createBatch: async (fields: unknown) => fields as Batch,
  updateBatch: async (batch: Batch) => {
    persisted.push(batch);
    return batch;
  },
  archiveBatch: async (batch: Batch) => batch,
}));

vi.mock("./useItems", () => ({
  useItemsStore: () => ({ load: async () => {}, refresh: async () => {} }),
}));

const { useBatchWorkStore } = await import("./useBatchWork");
const { useBatchesStore } = await import("./useBatches");

function makeBatch(over: Partial<Batch> = {}): Batch {
  return {
    ...newBatchFields({ type: ItemState.ToProcess, itemIds: ["i1", "i2"] }),
    id: "b1",
    no: 17,
    createdAt: "2026-08-08T00:00:00.000Z",
    archivedAt: null,
    ...over,
  };
}

/** Seed the batches store with one batch and open it in the work session. */
function openWith(batch: Batch) {
  const batches = useBatchesStore();
  batches.batches = [batch];
  const work = useBatchWorkStore();
  work.open(batch.id);
  return { batches, work };
}

beforeEach(() => {
  setActivePinia(createPinia());
  persisted.length = 0;
});

describe("useBatchWork.setTab", () => {
  it("ignores a tab the batch does not offer", () => {
    // A single-item batch has no Setup tab.
    const { work } = openWith(
      makeBatch({ itemIds: ["i1"], proc: { i1: ItemRunStatus.Idle }, stage: BatchStage.Metadata }),
    );
    work.setTab(BatchTab.Setup);
    expect(work.resolvedTab).toBe(BatchTab.Metadata);
  });

  // Regression: `Batch.stage` is "the furthest progress reached", but only
  // `initialStageFor` and `enterProcessing` ever wrote it — so a multi-item batch
  // sat at `setup` until its first processing run, and reopening it dropped the
  // operator back on Setup however much metadata work was done. `enterMetadata`
  // was added to fix that and then had no caller at all.
  it("advances the batch from Setup to Metadata and persists it", async () => {
    const { work } = openWith(makeBatch({ stage: BatchStage.Setup }));

    work.setTab(BatchTab.Metadata);

    expect(work.current?.stage).toBe(BatchStage.Metadata);
    // `persistRun` writes through fire-and-forget; let it settle.
    await Promise.resolve();
    expect(persisted.map((b) => b.stage)).toEqual([BatchStage.Metadata]);
  });

  it("reopening after the advance lands on Metadata, not Setup", () => {
    const { work } = openWith(makeBatch({ stage: BatchStage.Setup }));
    work.setTab(BatchTab.Metadata);

    work.open("b1"); // clears the session tab, as a relaunch would
    expect(work.resolvedTab).toBe(BatchTab.Metadata);
  });

  it("never regresses a later stage, and writes nothing when there is nothing to do", async () => {
    const { work } = openWith(makeBatch({ stage: BatchStage.Processing }));

    work.setTab(BatchTab.Metadata);

    expect(work.current?.stage).toBe(BatchStage.Processing);
    await Promise.resolve();
    expect(persisted).toHaveLength(0);
  });

  it("does not advance on a move back to Setup", async () => {
    const { work } = openWith(makeBatch({ stage: BatchStage.Setup }));

    work.setTab(BatchTab.Setup);

    expect(work.current?.stage).toBe(BatchStage.Setup);
    await Promise.resolve();
    expect(persisted).toHaveLength(0);
  });
});
