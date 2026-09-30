import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { BatchStage, newBatchFields, type Batch } from "@domain/batch";
import { ItemState, type Item } from "@domain/item";
import { missingParentMessage } from "@domain/parent";
import type { ItemUploadResult, UploadItemContext } from "@services/upload";

// ── fixtures ─────────────────────────────────────────────────────────────

function makeBatch(over: Partial<Batch> = {}): Batch {
  return {
    ...newBatchFields({ type: ItemState.ToProcess, itemIds: ["i1"] }),
    id: "b1",
    no: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    archivedAt: null,
    backendTouchedAt: null,
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

// `run` is driven with a scripted outcome: the real `uploadBatch` needs the
// backend and Tauri. Everything else in the module stays real — the cleanup
// suite below goes through the genuine `cleanupUnfinishedRecords`.
vi.mock("@services/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@services/upload")>();
  return { ...actual, uploadBatch: vi.fn() };
});

const { useUploadStore } = await import("./useUpload");
const { useBatchesStore } = await import("./useBatches");
const { useItemsStore } = await import("./useItems");
const { useMetadataStore } = await import("./useMetadata");
const { deleteItems } = await import("@services/api/items");
const { uploadBatch } = await import("@services/upload");

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
    metadataRejected: false,
    relationErrors: [],
    parentStates: [],
    missingParentIds: [],
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

describe("useUpload.run", () => {
  const item = { id: "i1", batchId: "b1", folderName: "i1", folderPath: "/p/i1" } as Item;
  const ctx: UploadItemContext = {
    targetState: "DRAFT",
    visibility: "PRIVATE",
    parentChanges: { add: ["p1"], remove: [] },
    metadataReady: true,
    primaryThumbnail: null,
  };

  function outcome(over: Partial<ItemUploadResult> = {}): ItemUploadResult {
    return {
      itemId: "i1",
      status: "uploaded",
      backendId: "rec_1",
      created: false,
      blockers: [],
      warnings: [],
      fieldErrors: [],
      metadataRejected: false,
      relationErrors: [],
      parentStates: [],
      missingParentIds: [],
      message: null,
      ...over,
    };
  }

  beforeEach(() => {
    vi.spyOn(useItemsStore(), "refresh").mockResolvedValue();
  });

  it("marks the parents the backend refused as gone, and says they no longer exist", async () => {
    const metadata = useMetadataStore();
    metadata.rememberParent({ id: "p1", title: "Pobjeda", collectionType: null, metadata: {} });
    vi.mocked(uploadBatch).mockResolvedValueOnce({
      results: [outcome({ status: "error", missingParentIds: ["p1"] })],
      allUploaded: false,
      missingParentIds: ["p1"],
    });
    const store = useUploadStore();

    const ok = await store.run("b1", [item], () => ctx);

    expect(ok).toBe(false);
    expect(metadata.parentGone.has("p1")).toBe(true);
    expect(store.error).toBe(missingParentMessage(["Pobjeda"], true));
  });

  it("reloads an adopted item's values from its new mirror, the others' link only", async () => {
    const other = { ...item, id: "i2", folderName: "i2", folderPath: "/p/i2" };
    useItemsStore().items = [item, other];
    const metadata = useMetadataStore();
    const reload = vi.spyOn(metadata, "reloadMirror").mockResolvedValue();
    vi.mocked(uploadBatch).mockResolvedValueOnce({
      results: [
        outcome({ warnings: [{ code: "adopted-existing", message: "" }] }),
        outcome({ itemId: "i2" }),
      ],
      allUploaded: false,
      missingParentIds: [],
    });

    await useUploadStore().run("b1", [item, other], () => ctx);

    expect(reload).toHaveBeenCalledWith(item, { values: true });
    expect(reload).toHaveBeenCalledWith(other, { values: false });
  });

  it("still refreshes the items and reloads their mirrors when the run throws", async () => {
    useItemsStore().items = [item];
    const refresh = vi.mocked(useItemsStore().refresh);
    const reload = vi.spyOn(useMetadataStore(), "reloadMirror").mockResolvedValue();
    vi.mocked(uploadBatch).mockRejectedValueOnce(new Error("bug"));
    const store = useUploadStore();

    const ok = await store.run("b1", [item], () => ctx);

    expect(ok).toBe(false);
    expect(store.error).toBe("bug");
    expect(refresh).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledWith(item, { values: false });
    expect(store.activeBatchId).toBeNull();
  });

  it("marks the batch before the upload's first backend write", async () => {
    const batches = useBatchesStore();
    batches.batches = [makeBatch()];
    const mark = vi.spyOn(batches, "markBackendTouched").mockResolvedValue();
    let markedBeforeWrite = false;
    vi.mocked(uploadBatch).mockImplementationOnce(async (_items, options) => {
      const before = mark.mock.calls.length;
      // No API client is configured here, so the write itself fails without
      // reaching the network — only whether the mark came first matters.
      await options.deps?.createItem?.({} as never).catch(() => undefined);
      markedBeforeWrite = before === 0 && mark.mock.calls.length === 1;
      return { results: [], allUploaded: false, missingParentIds: [] };
    });

    await useUploadStore().run("b1", [item], () => ctx);

    expect(markedBeforeWrite).toBe(true);
    expect(mark).toHaveBeenCalledWith("b1");
  });

  it("logs a failed reload instead of failing the run", async () => {
    useItemsStore().items = [item];
    vi.spyOn(useMetadataStore(), "reloadMirror").mockRejectedValue(new Error("disk"));
    vi.mocked(uploadBatch).mockResolvedValueOnce({
      results: [outcome({ status: "error" })],
      allUploaded: false,
      missingParentIds: [],
    });
    const store = useUploadStore();

    await expect(store.run("b1", [item], () => ctx)).resolves.toBe(false);

    expect(store.error).toBeNull();
    expect(store.activeBatchId).toBeNull();
  });
});
