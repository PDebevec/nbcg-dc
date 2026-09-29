import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { newBatchFields, type Batch, type BatchDeletePlan } from "@domain/batch";
import { emptyStages, ItemState, type Item } from "@domain/item";
import { useBatchesStore } from "@stores/useBatches";
import { useMetadataStore } from "@stores/useMetadata";
import { useUploadStore } from "@stores/useUpload";
import { toDeletePlanView, useDeleteBatch } from "./useDeleteBatch";

function makeBatch(over: Partial<Batch> = {}): Batch {
  return {
    ...newBatchFields({ type: ItemState.ToProcess, itemIds: ["i1", "i2"] }),
    id: "b1",
    no: 3,
    createdAt: "2026-09-29T00:00:00.000Z",
    archivedAt: null,
    backendTouchedAt: null,
    ...over,
  };
}

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: "i1",
    folderName: "BOOK",
    folderPath: "/scanned/BOOK",
    relativePath: "BOOK",
    hidden: false,
    root: "unprocessed",
    assets: [],
    stages: emptyStages(),
    flags: { uploaded: false, reupload: false, reuploadTextOnly: false },
    backendId: null,
    batchId: null,
    title: null,
    catalogueId: null,
    createdAt: null,
    updatedAt: null,
    syncMissStreak: 0,
    ...over,
  };
}

function makePlan(over: Partial<BatchDeletePlan> = {}): BatchDeletePlan {
  return {
    batchId: "b1",
    hasSnapshot: true,
    blockedReason: null,
    items: [
      {
        itemId: "i1",
        folderName: "BOOK",
        before: makeItem(),
        remove: [
          { path: "BOOK.pdf", generated: true },
          { path: "notes.docx", generated: false },
        ],
        restore: ["metadata.json"],
        error: null,
      },
      {
        itemId: "i2",
        folderName: "MAP",
        before: makeItem({
          id: "i2",
          folderName: "MAP",
          flags: { uploaded: true, reupload: false, reuploadTextOnly: false },
        }),
        remove: [],
        restore: [],
        error: null,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("toDeletePlanView", () => {
  it("names the state each item returns to and flags hand-added files", () => {
    const view = toDeletePlanView(makePlan(), 3);

    expect(view.label).toBe("Batch #003");
    expect(view.legacy).toBe(false);
    expect(view.handAddedCount).toBe(1);
    expect(view.items[0].returnsTo).toBe("To process");
    expect(view.items[0].remove).toEqual([
      { path: "BOOK.pdf", handAdded: false },
      { path: "notes.docx", handAdded: true },
    ]);
    expect(view.items[1].returnsTo).toBe("Uploaded");
    expect(view.items[1].unchanged).toBe(true);
  });

  it("marks a batch without snapshots as legacy", () => {
    expect(toDeletePlanView(makePlan({ hasSnapshot: false }), 1).legacy).toBe(true);
  });
});

describe("useDeleteBatch", () => {
  function setup(onDeleted = vi.fn()) {
    const batches = useBatchesStore();
    batches.batches = [makeBatch()];
    vi.spyOn(batches, "previewDelete").mockResolvedValue(makePlan());
    const del = useDeleteBatch({ onDeleted });
    return { batches, del, onDeleted };
  }

  it("loads the dry run when opened", async () => {
    const { del } = setup();

    await del.request("b1");

    expect(del.open.value).toBe(true);
    expect(del.plan.value?.label).toBe("Batch #003");
    expect(del.canConfirm.value).toBe(true);
  });

  it("can't confirm a blocked batch", async () => {
    const { batches, del } = setup();
    vi.mocked(batches.previewDelete).mockResolvedValueOnce(
      makePlan({ blockedReason: "Uploaded batches can't be deleted." }),
    );

    await del.request("b1");

    expect(del.canConfirm.value).toBe(false);
  });

  it("stops pending autosaves before deleting, then cleans up and closes", async () => {
    const { batches, del, onDeleted } = setup();
    const calls: string[] = [];
    vi.spyOn(useMetadataStore(), "forget").mockImplementation((ids) => {
      calls.push(`forget:${ids.join(",")}`);
    });
    vi.spyOn(batches, "remove").mockImplementation(async () => {
      calls.push("remove");
    });
    const clearResults = vi.spyOn(useUploadStore(), "clearResults");

    await del.request("b1");
    await del.confirm();

    expect(calls).toEqual(["forget:i1,i2", "remove"]);
    expect(clearResults).toHaveBeenCalledWith("b1");
    expect(onDeleted).toHaveBeenCalledWith("b1");
    expect(del.open.value).toBe(false);
  });

  it("keeps the dialog open with the reason when the delete fails", async () => {
    const { batches, del, onDeleted } = setup();
    vi.spyOn(batches, "remove").mockRejectedValue("Couldn't put back BOOK (file in use).");

    await del.request("b1");
    await del.confirm();

    expect(del.open.value).toBe(true);
    expect(del.error.value).toBe("Couldn't put back BOOK (file in use).");
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
