import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { BatchStage, newBatchFields, type Batch } from "@domain/batch";
import { ItemState } from "@domain/item";

// ── fixtures ─────────────────────────────────────────────────────────────

function makeBatch(over: Partial<Batch> = {}): Batch {
  return {
    ...newBatchFields({ type: ItemState.ToProcess, itemIds: ["i1"] }),
    id: "b1",
    no: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    archivedAt: null,
    ...over,
  };
}

const { useUploadStore } = await import("./useUpload");
const { useBatchesStore } = await import("./useBatches");

beforeEach(() => {
  setActivePinia(createPinia());
});

// This suite is about `closeBatch` (S14's escape hatch), tested at the level
// the store actually exposes: it goes through `useBatchesStore.update` /
// `.archive`, spied on directly rather than faking `@services/batches` — the
// store's own methods are the seam this behaviour is defined against.

describe("useUpload.closeBatch", () => {
  it("closeBatch archives a batch that did not fully upload", async () => {
    // S14: without this, a batch containing any non-uploaded item stays "In
    // progress" forever — archive() exists but nothing in the UI reaches it.
    const batches = useBatchesStore();
    batches.batches = [makeBatch({ stage: BatchStage.Processing })];
    const archive = vi.spyOn(batches, "archive").mockResolvedValue({} as never);
    const update = vi.spyOn(batches, "update").mockResolvedValue({} as never);
    const store = useUploadStore();

    await store.closeBatch("b1");

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ stage: BatchStage.Uploaded }));
    expect(archive).toHaveBeenCalledWith("b1");
  });

  it("still archives an id the local store holds nothing for, skipping update", async () => {
    const batches = useBatchesStore();
    const archive = vi.spyOn(batches, "archive").mockResolvedValue({} as never);
    const update = vi.spyOn(batches, "update").mockResolvedValue({} as never);
    const store = useUploadStore();

    await store.closeBatch("ghost");

    expect(update).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledWith("ghost");
  });

  it("a rejecting update does not stop the archive that follows", async () => {
    const batches = useBatchesStore();
    batches.batches = [makeBatch()];
    const update = vi.spyOn(batches, "update").mockRejectedValue(new Error("write failed"));
    const archive = vi.spyOn(batches, "archive").mockResolvedValue({} as never);
    const store = useUploadStore();

    await store.closeBatch("b1");

    expect(update).toHaveBeenCalled();
    expect(archive).toHaveBeenCalledWith("b1");
    expect(store.error).toBeNull();
  });

  it("a rejecting archive sets an error rather than throwing", async () => {
    const batches = useBatchesStore();
    batches.batches = [makeBatch()];
    vi.spyOn(batches, "update").mockResolvedValue({} as never);
    vi.spyOn(batches, "archive").mockRejectedValue(new Error("archive failed"));
    const store = useUploadStore();

    await expect(store.closeBatch("b1")).resolves.toBeUndefined();

    expect(store.error).toBe("The batch could not be archived.");
  });

  // Regression coverage for the fix: closeBatch() must reset `error` on entry,
  // and a caller (useProcessing.closeBatch) must only toast success when
  // `error` is still null afterwards — otherwise a failed close reports
  // "Batch closed." and a successful close after a prior failure inherits a
  // stale error and wrongly reports failure.

  it("a failed close surfaces the failure rather than leaving error unset", async () => {
    const batches = useBatchesStore();
    batches.batches = [makeBatch()];
    vi.spyOn(batches, "update").mockResolvedValue({} as never);
    vi.spyOn(batches, "archive").mockRejectedValue(new Error("archive failed"));
    const store = useUploadStore();

    await store.closeBatch("b1");

    // This is what useProcessing.closeBatch() checks to decide between a
    // success and an error toast — it must be non-null here.
    expect(store.error).not.toBeNull();
  });

  it("a close that succeeds after a prior failed close reports success, not the stale error", async () => {
    const batches = useBatchesStore();
    batches.batches = [makeBatch()];
    vi.spyOn(batches, "update").mockResolvedValue({} as never);
    const archive = vi.spyOn(batches, "archive");
    archive.mockRejectedValueOnce(new Error("first close failed"));
    archive.mockResolvedValueOnce({} as never);
    const store = useUploadStore();

    await store.closeBatch("b1");
    expect(store.error).toBe("The batch could not be archived.");

    await store.closeBatch("b1");

    // Proves closeBatch() resets `error` on entry: without that reset, this
    // second, successful close would still show the first call's error and
    // useProcessing.closeBatch() would wrongly toast failure.
    expect(store.error).toBeNull();
  });
});
