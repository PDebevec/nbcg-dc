import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { BatchStage, newBatchFields, type Batch } from "@domain/batch";
import { ItemState } from "@domain/item";
import type { ItemUploadResult } from "@services/upload";

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

// The real deleteItems is mocked at its api module so this pins the whole
// path end to end: services/upload.cleanupUnfinishedRecords calling a
// rejecting delete must not stop useUpload.closeBatch from archiving.
vi.mock("@services/api/items", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@services/api/items")>();
  return { ...actual, deleteItems: vi.fn().mockRejectedValue(new Error("boom")) };
});

const { useUploadStore } = await import("./useUpload");
const { useBatchesStore } = await import("./useBatches");
const { deleteItems } = await import("@services/api/items");

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

  // Regression coverage for the fix: closeBatch() must reset `error` on entry
  // — otherwise a successful close following a prior failure would inherit
  // the stale error and useProcessing.closeBatch() would wrongly report
  // failure. (The "failure surfaces" half of the fix — error ends up set,
  // not left unset — is already covered above by "a rejecting archive sets
  // an error rather than throwing"; the toast branch itself is pinned at the
  // composable layer, in useProcessing.test.ts.)

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

// The exclusion policy itself (which records are removable) is pure and lives
// in — and is tested in — services/upload.test.ts (`removableBackendIds`,
// `cleanupUnfinishedRecords`). This suite covers only the store-level
// integration: closing must still succeed when that best-effort delete fails.
describe("useUpload.closeBatch — cleanup", () => {
  const unfinished: ItemUploadResult = {
    itemId: "i1",
    status: "error",
    backendId: "b2",
    // Created this run and left unfinished — exactly the removable shape
    // `cleanupUnfinishedRecords` is expected to attempt to delete.
    created: true,
    blockers: [],
    warnings: [],
    fieldErrors: [],
    relationErrors: [],
    parentStates: [],
    message: null,
  };

  it("still archives when the cleanup delete fails, and tells the operator", async () => {
    // The module-level mock above rejects every `deleteItems` call.
    const batches = useBatchesStore();
    batches.batches = [makeBatch()];
    vi.spyOn(batches, "update").mockResolvedValue({} as never);
    const archive = vi.spyOn(batches, "archive").mockResolvedValue({} as never);
    const store = useUploadStore();
    store.results = new Map([["b1", new Map([["i1", unfinished]])]]);

    await store.closeBatch("b1", { cleanup: true });

    // The batch closes either way — cleanup is best-effort, never blocking.
    expect(archive).toHaveBeenCalledWith("b1");
    // But a failed cleanup must reach the operator, not just `logger.warn`.
    expect(store.error).toBe(
      "The batch was closed, but unfinished records could not be removed from the backend.",
    );
  });

  it("does not set an error when cleanup succeeds", async () => {
    // Non-vacuous against always setting the error on `cleanup: true`: flip
    // this one call to resolve and confirm `error` stays null.
    vi.mocked(deleteItems).mockResolvedValueOnce(undefined as never);
    const batches = useBatchesStore();
    batches.batches = [makeBatch()];
    vi.spyOn(batches, "update").mockResolvedValue({} as never);
    vi.spyOn(batches, "archive").mockResolvedValue({} as never);
    const store = useUploadStore();
    store.results = new Map([["b1", new Map([["i1", unfinished]])]]);

    await store.closeBatch("b1", { cleanup: true });

    expect(deleteItems).toHaveBeenCalledWith({ ids: ["b2"] });
    expect(store.error).toBeNull();
  });
});
