import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { newBatchFields, type Batch } from "@domain/batch";
import { ItemState } from "@domain/item";

const refresh = vi.fn(async () => {});
vi.mock("./useItems", () => ({ useItemsStore: () => ({ refresh, load: async () => {} }) }));
vi.mock("@services/batches", () => ({
  listBatches: vi.fn(async () => []),
  createBatch: vi.fn(),
  updateBatch: vi.fn(),
  archiveBatch: vi.fn(),
  previewBatchDelete: vi.fn(),
  deleteBatch: vi.fn(async () => {}),
  markBatchBackendTouched: vi.fn(),
}));

const { useBatchesStore } = await import("./useBatches");
const services = await import("@services/batches");

function makeBatch(over: Partial<Batch> = {}): Batch {
  return {
    ...newBatchFields({ type: ItemState.ToProcess, itemIds: ["i1"] }),
    id: "b1",
    no: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    archivedAt: null,
    backendTouchedAt: null,
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  refresh.mockClear();
  vi.mocked(services.deleteBatch).mockReset().mockResolvedValue();
});

describe("useBatchesStore delete", () => {
  it("remove deletes natively, drops the batch and rescans", async () => {
    const store = useBatchesStore();
    store.batches = [makeBatch(), makeBatch({ id: "b2", no: 2 })];

    await store.remove("b1");

    expect(services.deleteBatch).toHaveBeenCalledWith("b1");
    expect(store.batches.map((b) => b.id)).toEqual(["b2"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the batch when the native delete fails", async () => {
    const store = useBatchesStore();
    store.batches = [makeBatch()];
    vi.mocked(services.deleteBatch).mockRejectedValueOnce("file in use");

    await expect(store.remove("b1")).rejects.toBe("file in use");

    expect(store.batches).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("markBackendTouched stores the marked batch", async () => {
    const store = useBatchesStore();
    store.batches = [makeBatch()];
    const marked = makeBatch({ backendTouchedAt: "2026-09-29T10:00:00.000Z" });
    vi.mocked(services.markBatchBackendTouched).mockResolvedValueOnce(marked);

    await store.markBackendTouched("b1");

    expect(store.get("b1")?.backendTouchedAt).toBe("2026-09-29T10:00:00.000Z");
  });
});
