import { describe, it, expect } from "vitest";
import {
  uploadBlockers,
  uploadWarnings,
  textQualityWarnings,
  resolvePrimaryThumbnail,
  uploadGroups,
  textPairs,
  uploadMode,
  changedMetadataKeys,
  changedMetadata,
  mapValidationErrors,
  planItemUpload,
  isUploadable,
  MAX_FILES_PER_REQUEST,
} from "./upload";
import { UPLOAD_MAX_FILES } from "@services/api/dto";
import { discoverAsset, type DiscoveredAsset } from "./files";
import { emptyStages, type Item, type ItemStages, type StageName } from "./item";
import { FileRole, TextExtractionStatus } from "./enums";

// ── fixtures ──────────────────────────────────────────────────────────────

function stagesWith(overrides: Partial<Record<StageName, ItemStages[StageName]>>): ItemStages {
  return { ...emptyStages(), ...overrides };
}

/** A processed, unambiguous single-PDF item (pdf + thumb + ocr). */
function makeItem(overrides: Partial<Item> = {}): Item {
  const assets: DiscoveredAsset[] =
    overrides.assets ??
    [
      discoverAsset("gorski.pdf", "/p/gorski.pdf"),
      discoverAsset("gorski_archive.pdf", "/p/gorski_archive.pdf"),
      discoverAsset("gorski.tif", "/p/gorski.tif"),
      discoverAsset("gorski.txt", "/p/gorski.txt"),
      discoverAsset("gorski_thumb.png", "/p/gorski_thumb.png"),
    ];
  const base: Item = {
    id: "item-1",
    folderName: "gorski",
    folderPath: "/p",
    relativePath: "gorski",
    hidden: false,
    root: "unprocessed",
    level: "main",
    assets,
    stages: stagesWith({
      pdf: { status: "done" },
      thumbnail: { status: "done" },
      ocr: { status: "done" },
    }),
    flags: { uploaded: false, reupload: false },
    backendId: null,
    batchId: "batch-1",
    title: "Gorski vijenac",
    catalogueId: null,
    createdAt: null,
    updatedAt: null,
    syncMissStreak: 0,
  };
  return { ...base, ...overrides };
}

const READY = { metadataReady: true, primaryThumbnail: null };

// ── gating ──────────────────────────────────────────────────────────────

describe("uploadBlockers", () => {
  it("passes a processed, metadata-ready, unambiguous item", () => {
    expect(uploadBlockers(makeItem(), READY)).toEqual([]);
  });

  it("blocks when the PDF/thumbnail stage is not done", () => {
    const item = makeItem({
      stages: stagesWith({ pdf: { status: "running" }, thumbnail: { status: "done" } }),
    });
    const codes = uploadBlockers(item, READY).map((b) => b.code);
    expect(codes).toContain("not-processed");
  });

  it("treats a skipped required stage as satisfied", () => {
    const item = makeItem({
      stages: stagesWith({ pdf: { status: "skipped" }, thumbnail: { status: "done" } }),
    });
    expect(uploadBlockers(item, READY)).toEqual([]);
  });

  it("blocks a failed stage as processing-failed (not not-processed)", () => {
    const item = makeItem({
      stages: stagesWith({ pdf: { status: "failed", error: "boom" }, thumbnail: { status: "done" } }),
    });
    const codes = uploadBlockers(item, READY).map((b) => b.code);
    expect(codes).toEqual(["processing-failed"]);
  });

  it("hard-blocks a multi-image item with no chosen primary", () => {
    const assets = [
      discoverAsset("page_1.jpg", "/p/page_1.jpg"),
      discoverAsset("page_2.jpg", "/p/page_2.jpg"),
    ];
    const item = makeItem({ assets });
    const codes = uploadBlockers(item, { metadataReady: true, primaryThumbnail: null }).map((b) => b.code);
    expect(codes).toContain("thumbnail-unresolved");
  });

  it("clears the thumbnail gate once a primary is chosen", () => {
    const assets = [
      discoverAsset("page_1.jpg", "/p/page_1.jpg"),
      discoverAsset("page_2.jpg", "/p/page_2.jpg"),
    ];
    const item = makeItem({ assets });
    const codes = uploadBlockers(item, { metadataReady: true, primaryThumbnail: "page_1.jpg" }).map((b) => b.code);
    expect(codes).not.toContain("thumbnail-unresolved");
  });

  // The gate used `domain/files.needsThumbnailChoice`, which counts only images
  // ALREADY PRESENT in the folder. A multi-PDF item has none — its thumbnail
  // candidates are the first-page images the pipeline will GENERATE — so the
  // candidate count was 0, the hard gate never fired, and an item with a genuinely
  // ambiguous thumbnail sailed through to publish. `domain/pipeline.planThumbnail`
  // reports `needsChoice: true` for exactly this case; Epic 06's own notes told
  // Epic 07 to use it, and Epic 07 did not.
  it("hard-blocks a multi-PDF item whose thumbnail is unresolved (no present images)", () => {
    const assets = [
      discoverAsset("prvi_dio.pdf", "/p/prvi_dio.pdf"),
      discoverAsset("drugi_dio.pdf", "/p/drugi_dio.pdf"),
    ];
    const item = makeItem({ assets });
    const codes = uploadBlockers(item, { metadataReady: true, primaryThumbnail: null }).map((b) => b.code);
    expect(codes).toContain("thumbnail-unresolved");
  });

  it("does not block a single-PDF item, whose first page auto-resolves", () => {
    const assets = [discoverAsset("gorski.pdf", "/p/gorski.pdf")];
    const item = makeItem({ assets });
    const codes = uploadBlockers(item, { metadataReady: true, primaryThumbnail: null }).map((b) => b.code);
    expect(codes).not.toContain("thumbnail-unresolved");
  });

  it("blocks invalid metadata", () => {
    const codes = uploadBlockers(makeItem(), { metadataReady: false, primaryThumbnail: null }).map((b) => b.code);
    expect(codes).toContain("metadata-invalid");
  });
});

describe("uploadWarnings", () => {
  it("warns when OCR applies but no text is present", () => {
    const assets = [
      discoverAsset("gorski.pdf", "/p/gorski.pdf"),
      discoverAsset("gorski_thumb.png", "/p/gorski_thumb.png"),
    ];
    const codes = uploadWarnings(makeItem({ assets })).map((w) => w.code);
    expect(codes).toEqual(["ocr-missing"]);
  });

  it("does not warn for an images-only item (OCR N/A)", () => {
    const assets = [
      discoverAsset("map.jpg", "/p/map.jpg"),
      discoverAsset("map_thumb.png", "/p/map_thumb.png"),
    ];
    expect(uploadWarnings(makeItem({ assets }))).toEqual([]);
  });

  it("does not warn when the text file is present", () => {
    expect(uploadWarnings(makeItem())).toEqual([]);
  });
});

describe("textQualityWarnings", () => {
  it("warns on GARBAGE and NO_TEXT, not on EXTRACTED", () => {
    const files = [
      { filename: "a.pdf", textExtractionStatus: TextExtractionStatus.EXTRACTED },
      { filename: "b.pdf", textExtractionStatus: TextExtractionStatus.GARBAGE },
      { filename: "c.pdf", textExtractionStatus: TextExtractionStatus.NO_TEXT },
    ];
    const warned = textQualityWarnings(files).map((w) => w.message);
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("b.pdf");
    expect(warned[1]).toContain("c.pdf");
  });
});

// ── upload set ──────────────────────────────────────────────────────────

describe("resolvePrimaryThumbnail", () => {
  it("prefers the explicit pick", () => {
    const assets = [discoverAsset("page_1.jpg", "/p/1"), discoverAsset("page_2.jpg", "/p/2")];
    expect(resolvePrimaryThumbnail(assets, "page_2.jpg")).toBe("page_2.jpg");
  });

  it("falls back to the auto thumbnail (tagged *_thumb)", () => {
    const assets = [discoverAsset("gorski.pdf", "/p"), discoverAsset("gorski_thumb.png", "/p")];
    expect(resolvePrimaryThumbnail(assets, null)).toBe("gorski_thumb.png");
  });

  it("is null when nothing resolves", () => {
    const assets = [discoverAsset("page_1.jpg", "/p/1"), discoverAsset("page_2.jpg", "/p/2")];
    expect(resolvePrimaryThumbnail(assets, null)).toBeNull();
  });
});

describe("uploadGroups", () => {
  it("splits a PDF + tagged thumb into WEB (pdf) + THUMBNAIL (thumb)", () => {
    const assets = [
      discoverAsset("gorski.pdf", "/p/gorski.pdf"),
      discoverAsset("gorski_thumb.png", "/p/gorski_thumb.png"),
      discoverAsset("gorski_archive.pdf", "/p/gorski_archive.pdf"),
      discoverAsset("gorski.tif", "/p/gorski.tif"),
    ];
    const groups = uploadGroups(assets, null);
    const thumb = groups.find((g) => g.role === FileRole.THUMBNAIL)!;
    const web = groups.find((g) => g.role === FileRole.WEB)!;
    expect(thumb.assets.map((a) => a.filename)).toEqual(["gorski_thumb.png"]);
    expect(web.assets.map((a) => a.filename)).toEqual(["gorski.pdf"]);
    // archival + tiff never upload.
    expect(groups.flatMap((g) => g.assets.map((a) => a.filename))).not.toContain(
      "gorski_archive.pdf",
    );
  });

  it("puts the chosen primary image in THUMBNAIL and the rest in WEB", () => {
    const assets = [
      discoverAsset("page_1.jpg", "/p/1"),
      discoverAsset("page_2.jpg", "/p/2"),
      discoverAsset("page_3.jpg", "/p/3"),
    ];
    const groups = uploadGroups(assets, "page_2.jpg");
    expect(groups.find((g) => g.role === FileRole.THUMBNAIL)!.assets.map((a) => a.filename)).toEqual([
      "page_2.jpg",
    ]);
    expect(groups.find((g) => g.role === FileRole.WEB)!.assets.map((a) => a.filename)).toEqual([
      "page_1.jpg",
      "page_3.jpg",
    ]);
  });

  it("omits an empty group (all-WEB when no thumbnail resolves)", () => {
    const assets = [discoverAsset("gorski.pdf", "/p/gorski.pdf")];
    const groups = uploadGroups(assets, null);
    expect(groups).toHaveLength(1);
    expect(groups[0].role).toBe(FileRole.WEB);
  });
});

describe("textPairs", () => {
  it("pairs each web PDF with its same-base .txt", () => {
    const assets = [
      discoverAsset("a.pdf", "/p/a.pdf"),
      discoverAsset("a.txt", "/p/a.txt"),
      discoverAsset("b.pdf", "/p/b.pdf"),
      discoverAsset("b.txt", "/p/b.txt"),
    ];
    const pairs = textPairs(assets);
    expect(pairs.map((p) => [p.pdfFilename, p.text.filename])).toEqual([
      ["a.pdf", "a.txt"],
      ["b.pdf", "b.txt"],
    ]);
  });

  it("omits a PDF with no matching text", () => {
    const assets = [discoverAsset("a.pdf", "/p/a.pdf")];
    expect(textPairs(assets)).toEqual([]);
  });

  it("pairs case-insensitively (Windows folders are case-preserving)", () => {
    const assets = [
      discoverAsset("Gorski.pdf", "/p/Gorski.pdf"),
      discoverAsset("gorski.txt", "/p/gorski.txt"),
    ];
    const pairs = textPairs(assets);
    expect(pairs.map((p) => [p.pdfFilename, p.text.filename])).toEqual([
      ["Gorski.pdf", "gorski.txt"],
    ]);
  });
});

// ── mode + change detection ─────────────────────────────────────────────

describe("uploadMode", () => {
  it("is create with no backendId", () => {
    expect(uploadMode(makeItem({ backendId: null }))).toBe("create");
  });
  it("is replace once a backendId is connected", () => {
    expect(uploadMode(makeItem({ backendId: "rec_1" }))).toBe("replace");
  });
});

describe("changedMetadataKeys / changedMetadata", () => {
  it("reports added and modified keys, ignores unchanged", () => {
    const prev = { title: "A", year: "2020", note: "x" };
    const next = { title: "A", year: "2021", extra: "new" };
    expect(changedMetadataKeys(next, prev).sort()).toEqual(["extra", "year"]);
    expect(changedMetadata(next, prev)).toEqual({ year: "2021", extra: "new" });
  });

  it("does not emit keys only present in prev (no unset)", () => {
    expect(changedMetadataKeys({}, { gone: "1" })).toEqual([]);
  });

  it("compares nested values structurally", () => {
    const prev = { authors: [{ familyName: "Njegoš" }] };
    const nextSame = { authors: [{ familyName: "Njegoš" }] };
    const nextDiff = { authors: [{ familyName: "Petrović" }] };
    expect(changedMetadataKeys(nextSame, prev)).toEqual([]);
    expect(changedMetadataKeys(nextDiff, prev)).toEqual(["authors"]);
  });

  it("is insensitive to nested object key order (no spurious change)", () => {
    const prev = { author: { familyName: "Njegoš", firstName: "Petar" } };
    const next = { author: { firstName: "Petar", familyName: "Njegoš" } };
    expect(changedMetadataKeys(next, prev)).toEqual([]);
  });

  it("stays sensitive to array element order (order is meaningful)", () => {
    const prev = { langs: ["cnr", "en"] };
    const next = { langs: ["en", "cnr"] };
    expect(changedMetadataKeys(next, prev)).toEqual(["langs"]);
  });
});

// ── validation error mapping ────────────────────────────────────────────

describe("mapValidationErrors", () => {
  const keys = ["title", "publicationDate1", "publication"];

  it("attributes a leading-key message to that field", () => {
    const body = { message: ["title should not be empty"] };
    expect(mapValidationErrors(body, keys)).toEqual([
      { key: "title", message: "title should not be empty" },
    ]);
  });

  it("prefers the longest matching key (publicationDate1 over publication)", () => {
    const body = { message: ["publicationDate1 must be a string"] };
    expect(mapValidationErrors(body, keys)[0].key).toBe("publicationDate1");
  });

  it("returns key null for an unattributable message", () => {
    const body = { message: "Unexpected error" };
    expect(mapValidationErrors(body, keys)).toEqual([{ key: null, message: "Unexpected error" }]);
  });

  it("handles a non-validation body", () => {
    expect(mapValidationErrors(undefined, keys)).toEqual([]);
    expect(mapValidationErrors({ statusCode: 500 }, keys)).toEqual([]);
  });
});

// ── assembled plan ───────────────────────────────────────────────────────

describe("planItemUpload / isUploadable", () => {
  it("assembles a create plan for a ready item", () => {
    const plan = planItemUpload(makeItem(), READY);
    expect(plan.mode).toBe("create");
    expect(plan.backendId).toBeNull();
    expect(plan.primaryThumbnail).toBe("gorski_thumb.png");
    expect(plan.groups.map((g) => g.role)).toEqual([FileRole.THUMBNAIL, FileRole.WEB]);
    expect(plan.texts.map((t) => t.pdfFilename)).toEqual(["gorski.pdf"]);
    expect(isUploadable(plan)).toBe(true);
  });

  it("carries blockers and is not uploadable when unresolved", () => {
    const assets = [
      discoverAsset("page_1.jpg", "/p/1"),
      discoverAsset("page_2.jpg", "/p/2"),
    ];
    const plan = planItemUpload(makeItem({ assets }), { metadataReady: false, primaryThumbnail: null });
    expect(isUploadable(plan)).toBe(false);
    expect(plan.blockers.map((b) => b.code).sort()).toEqual([
      "metadata-invalid",
      "thumbnail-unresolved",
    ]);
  });

  it("assembles a replace plan for a connected item", () => {
    const plan = planItemUpload(makeItem({ backendId: "rec_1", flags: { uploaded: true, reupload: true } }), READY);
    expect(plan.mode).toBe("replace");
    expect(plan.backendId).toBe("rec_1");
  });
});

describe("upload request chunking (backend caps files per request)", () => {
  const img = (n: string) => discoverAsset(n, `/p/${n}`);

  it("stays in step with the backend's documented cap", () => {
    // The constant is restated in `domain/` because domain may not import
    // services; this assertion is what stops the two from drifting apart.
    expect(MAX_FILES_PER_REQUEST).toBe(UPLOAD_MAX_FILES);
  });

  it("splits a large WEB set into request-sized groups", () => {
    // 25 images → 1 THUMBNAIL + 24 WEB → 1 + ceil(24/10) = 4 groups.
    const assets = Array.from({ length: 25 }, (_, i) => img(`${i + 1}.jpg`));
    const groups = uploadGroups(assets, "1.jpg");

    expect(groups[0]).toEqual({ role: FileRole.THUMBNAIL, assets: [assets[0]] });
    const web = groups.slice(1);
    expect(web.every((g) => g.role === FileRole.WEB)).toBe(true);
    expect(web.map((g) => g.assets.length)).toEqual([10, 10, 4]);
    // Nothing lost and nothing duplicated across the chunks.
    const all = groups.flatMap((g) => g.assets.map((a) => a.filename));
    expect(all).toHaveLength(25);
    expect(new Set(all).size).toBe(25);
  });

  it("never exceeds the cap for a book forced to `graphical`", () => {
    // The escape hatch in domain/pipeline.ContentKind makes this reachable at
    // scale: 260 loose page images would otherwise be one 260-file request.
    const assets = Array.from({ length: 260 }, (_, i) => img(`${i + 1}.jpg`));
    const groups = uploadGroups(assets, null);
    expect(groups.length).toBeGreaterThan(1);
    expect(Math.max(...groups.map((g) => g.assets.length))).toBeLessThanOrEqual(
      MAX_FILES_PER_REQUEST,
    );
    expect(groups.reduce((n, g) => n + g.assets.length, 0)).toBe(260);
  });

  it("leaves a small item as a single group per role", () => {
    const assets = [img("gorski_thumb.png"), discoverAsset("gorski.pdf", "/p/gorski.pdf")];
    const groups = uploadGroups(assets, "gorski_thumb.png");
    expect(groups.map((g) => g.assets.length)).toEqual([1, 1]);
  });

  it("honours an explicit maxPerRequest", () => {
    const assets = Array.from({ length: 5 }, (_, i) => img(`${i + 1}.jpg`));
    const groups = uploadGroups(assets, null, 2);
    expect(groups.map((g) => g.assets.length)).toEqual([2, 2, 1]);
  });
});
