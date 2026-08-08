import { describe, it, expect } from "vitest";
import { discoverAsset, type DiscoveredAsset } from "@domain/files";
import { emptyStages, type Item, type ItemStages, type StageName } from "@domain/item";
import {
  BatchStage,
  ItemRunStatus,
  type Batch,
} from "@domain/batch";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import { ItemState } from "@domain/item";
import {
  applyJobDone,
  applyStageChanged,
  buildRunRequest,
  procFromProcessing,
  seedProcFromItems,
} from "./pipeline";

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

function makeBatch(itemIds: string[]): Batch {
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
  };
}

function mapOf(...items: Item[]): Map<string, Item> {
  return new Map(items.map((i) => [i.id, i]));
}

describe("buildRunRequest", () => {
  it("includes only items with work, with the decided plan per item", () => {
    const tiff = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });
    const done = makeItem({
      id: "old",
      folderName: "old",
      assets: [asset("old", "old.pdf")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    const batch = makeBatch(["nb", "old"]);

    const req = buildRunRequest(batch, mapOf(tiff, done), { mode: "run" });

    expect(req.batchId).toBe("b1");
    expect(req.mode).toBe("run");
    // `old` is fully done → dropped; only `nb` carries work.
    expect(req.items).toHaveLength(1);
    expect(req.items[0]).toEqual({
      itemId: "nb",
      folderPath: "/scans/nb",
      folderName: "nb",
      inputShape: "tiffs",
      stages: ["pdf", "thumbnail", "ocr"],
      // a lone generated first-page image → resolved with no concrete file yet
      primaryThumbnail: null,
      thumbnailNeedsChoice: false,
      webPdfBases: ["nb"],
      // A TIFF build is not a page run, and spread splitting is opt-in.
      pageImages: [],
      splitSpreads: false,
    });
  });

  it("preserves each PDF's base name for multi-PDF folders", () => {
    const item = makeItem({
      id: "multi",
      folderName: "multi",
      assets: [asset("multi", "vol1.pdf"), asset("multi", "vol2.pdf")],
    });
    const req = buildRunRequest(makeBatch(["multi"]), mapOf(item), { mode: "run" });
    expect(req.items[0].inputShape).toBe("multiple-pdfs");
    expect(req.items[0].webPdfBases).toEqual(["vol1", "vol2"]);
  });

  it("restricts to the given item ids (rerun/reprocess)", () => {
    const a = makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.pdf")] });
    const b = makeItem({ id: "b", folderName: "b", assets: [asset("b", "b.pdf")] });
    const req = buildRunRequest(makeBatch(["a", "b"]), mapOf(a, b), {
      mode: "rerun",
      itemIds: ["b"],
    });
    expect(req.items.map((i) => i.itemId)).toEqual(["b"]);
  });

  it("reprocess forces the chosen stages only", () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "0001.tif")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    const req = buildRunRequest(makeBatch(["nb"]), mapOf(item), {
      mode: "reprocess",
      itemIds: ["nb"],
      only: ["ocr"],
      force: true,
    });
    expect(req.items[0].stages).toEqual(["ocr"]);
  });

  it("falls back to the plan's auto-primary thumbnail when no override is given", () => {
    // The common "supplied PDF + one cover image" shape: the lone standalone
    // image auto-selects, so the request must carry it as the primary.
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf"), asset("nb", "cover.jpg")],
    });
    const req = buildRunRequest(makeBatch(["nb"]), mapOf(item), { mode: "run" });
    expect(req.items[0].inputShape).toBe("supplied-pdf");
    expect(req.items[0].primaryThumbnail).toBe("cover.jpg");
  });

  it("carries no PDF/OCR work and no web-pdf bases for an images-only item", () => {
    // The adaptive contract: images-only ⇒ thumbnail stage only, empty
    // webPdfBases (DTO: "Empty for images-only").
    const item = makeItem({
      id: "map",
      folderName: "map",
      assets: [asset("map", "a.jpg"), asset("map", "b.jpg")],
    });
    const req = buildRunRequest(makeBatch(["map"]), mapOf(item), { mode: "run" });
    expect(req.items[0].inputShape).toBe("images-only");
    expect(req.items[0].stages).toEqual(["thumbnail"]);
    expect(req.items[0].webPdfBases).toEqual([]);
    // no operator pick + 2 candidates ⇒ unresolved primary, held pending
    expect(req.items[0].primaryThumbnail).toBeNull();
    expect(req.items[0].thumbnailNeedsChoice).toBe(true);
  });

  it("uses an operator-chosen primary thumbnail over the plan default", () => {
    const item = makeItem({
      id: "map",
      folderName: "map",
      assets: [asset("map", "a.jpg"), asset("map", "b.jpg")],
    });
    const req = buildRunRequest(makeBatch(["map"]), mapOf(item), {
      mode: "run",
      primaryThumbnails: { map: "b.jpg" },
    });
    expect(req.items[0].primaryThumbnail).toBe("b.jpg");
  });

  it("skips ids missing from the item map", () => {
    const a = makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.pdf")] });
    const req = buildRunRequest(makeBatch(["a", "ghost"]), mapOf(a), { mode: "run" });
    expect(req.items.map((i) => i.itemId)).toEqual(["a"]);
  });

  // Regression: `BuildRunOptions.contentKinds` documented itself as "sourced from
  // Batch.overrides[itemId].contentKind", but nothing did the sourcing — every
  // caller omitted it, so the operator's book/graphical override was inert and
  // every run planned with "auto". Auto-detection is wrong in both directions on
  // real scanner output, and forcing it is the whole point of the override.
  it("honours the batch's per-item contentKind override", () => {
    // A numbered image run auto-detects as a book's pages.
    const item = makeItem({
      id: "pages",
      folderName: "pages",
      assets: [asset("pages", "1.jpg"), asset("pages", "2.jpg"), asset("pages", "3.jpg")],
    });
    const auto = buildRunRequest(makeBatch(["pages"]), mapOf(item), { mode: "run" });
    expect(auto.items[0].inputShape).toBe("page-images");

    const batch = makeBatch(["pages"]);
    batch.overrides = { pages: { contentKind: "graphical" } };
    const forced = buildRunRequest(batch, mapOf(item), { mode: "run" });
    expect(forced.items[0].inputShape).toBe("images-only");
  });

  it("lets an explicit contentKinds option beat the batch override", () => {
    const item = makeItem({
      id: "pages",
      folderName: "pages",
      assets: [asset("pages", "1.jpg"), asset("pages", "2.jpg"), asset("pages", "3.jpg")],
    });
    const batch = makeBatch(["pages"]);
    batch.overrides = { pages: { contentKind: "graphical" } };
    const req = buildRunRequest(batch, mapOf(item), {
      mode: "run",
      contentKinds: { pages: "book" },
    });
    expect(req.items[0].inputShape).toBe("page-images");
  });

  it("leaves items without an override on auto detection", () => {
    const a = makeItem({ id: "a", folderName: "a", assets: [asset("a", "a.pdf")] });
    const b = makeItem({
      id: "b",
      folderName: "b",
      assets: [asset("b", "1.jpg"), asset("b", "2.jpg"), asset("b", "3.jpg")],
    });
    const batch = makeBatch(["a", "b"]);
    batch.overrides = { a: { publish: PublishTarget.RECORD } }; // no contentKind
    const req = buildRunRequest(batch, mapOf(a, b), { mode: "run" });
    expect(req.items.find((i) => i.itemId === "b")?.inputShape).toBe("page-images");
  });
});

describe("applyStageChanged", () => {
  const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "0001.tif")] });

  it("updates the targeted stage with status/error/timestamp", () => {
    const next = applyStageChanged(item, {
      batchId: "b1",
      itemId: "nb",
      stage: "ocr",
      status: "failed",
      error: "boom",
      at: "2026-08-05T10:00:00.000Z",
    });
    expect(next).not.toBe(item);
    expect(next.stages.ocr).toEqual({
      status: "failed",
      error: "boom",
      updatedAt: "2026-08-05T10:00:00.000Z",
    });
    // other stages untouched
    expect(next.stages.pdf.status).toBe("pending");
    // pure — original untouched
    expect(item.stages.ocr.status).toBe("pending");
  });

  it("is a no-op (same reference) for a different item", () => {
    const next = applyStageChanged(item, {
      batchId: "b1",
      itemId: "other",
      stage: "pdf",
      status: "running",
    });
    expect(next).toBe(item);
  });
});

describe("procFromProcessing", () => {
  it("Done when every applicable stage is complete and the thumbnail is resolved", () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    expect(procFromProcessing(item)).toBe(ItemRunStatus.Done);
  });
  it("Failed when an applicable stage failed", () => {
    const item = makeItem({
      id: "nb",
      folderName: "nb",
      assets: [asset("nb", "nb.pdf")],
      stages: stagesWith({ pdf: "failed" }),
    });
    expect(procFromProcessing(item)).toBe(ItemRunStatus.Failed);
  });
  it("Idle when work still remains", () => {
    const item = makeItem({ id: "nb", folderName: "nb", assets: [asset("nb", "nb.pdf")] });
    expect(procFromProcessing(item)).toBe(ItemRunStatus.Idle);
  });
  it("not Done while a thumbnail choice is unresolved (images-only, ≥2 images)", () => {
    const item = makeItem({
      id: "map",
      folderName: "map",
      assets: [asset("map", "a.jpg"), asset("map", "b.jpg")],
      stages: stagesWith({ thumbnail: "done" }),
    });
    expect(procFromProcessing(item)).toBe(ItemRunStatus.Idle);
  });
});

describe("seedProcFromItems", () => {
  it("seeds each member from its actual processing state", () => {
    const done = makeItem({
      id: "done",
      folderName: "done",
      assets: [asset("done", "done.pdf")],
      stages: stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }),
    });
    const pending = makeItem({
      id: "todo",
      folderName: "todo",
      assets: [asset("todo", "todo.pdf")],
    });
    const seeded = seedProcFromItems(makeBatch(["done", "todo"]), mapOf(done, pending));
    expect(seeded.proc).toEqual({
      done: ItemRunStatus.Done,
      todo: ItemRunStatus.Idle,
    });
  });
});

describe("applyJobDone", () => {
  const base = makeBatch(["a", "b"]);

  it("sets an item outcome without completing the batch", () => {
    const running = {
      ...base,
      running: true,
      proc: { a: ItemRunStatus.Running, b: ItemRunStatus.Queued },
    };
    const r = applyJobDone(running, {
      batchId: "b1",
      itemId: "a",
      outcome: "done",
      batchComplete: false,
    });
    expect(r.batchComplete).toBe(false);
    expect(r.batch.proc.a).toBe(ItemRunStatus.Done);
    expect(r.batch.running).toBe(true);
  });

  it("a cancelled item drops back to idle", () => {
    const running = { ...base, running: true, proc: { a: ItemRunStatus.Running, b: ItemRunStatus.Idle } };
    const r = applyJobDone(running, {
      batchId: "b1",
      itemId: "a",
      outcome: "cancelled",
      batchComplete: false,
    });
    expect(r.batch.proc.a).toBe(ItemRunStatus.Idle);
  });

  it("batchComplete with all items done → running cleared, stage Ready", () => {
    const running = {
      ...base,
      running: true,
      stage: BatchStage.Processing,
      proc: { a: ItemRunStatus.Done, b: ItemRunStatus.Running },
    };
    const r = applyJobDone(running, {
      batchId: "b1",
      itemId: "b",
      outcome: "done",
      batchComplete: true,
    });
    expect(r.batch.running).toBe(false);
    expect(r.batch.proc).toEqual({ a: ItemRunStatus.Done, b: ItemRunStatus.Done });
    expect(r.batch.stage).toBe(BatchStage.Ready);
  });

  it("a terminal cancel (no item) resets in-flight items and stays Processing", () => {
    const running = {
      ...base,
      running: true,
      stage: BatchStage.Processing,
      proc: { a: ItemRunStatus.Done, b: ItemRunStatus.Running },
    };
    const r = applyJobDone(running, {
      batchId: "b1",
      itemId: null,
      outcome: "cancelled",
      batchComplete: true,
    });
    expect(r.batch.running).toBe(false);
    expect(r.batch.proc).toEqual({ a: ItemRunStatus.Done, b: ItemRunStatus.Idle });
    expect(r.batch.stage).toBe(BatchStage.Processing);
  });
});
