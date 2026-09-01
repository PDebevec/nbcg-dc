import { describe, expect, it } from "vitest";
import type { IndexedItemDto } from "@ipc/bindings";
import { uploadBlockers } from "@domain/upload";
import { toItem } from "./indexing";

/**
 * Regression coverage for a real bug found running the app against real
 * archive data: the native index only ever writes a DB row for a stage it
 * actually ran, so an `images-only` item (no `pdf`/`ocr` — see
 * `domain/pipeline.applicableStages`) comes back with no `pdf`/`ocr` rows at
 * all, not `skipped` ones. Before `toItem` applied `markNonApplicableSkipped`,
 * that left `pdf`/`ocr` reading `pending` forever, which `uploadBlockers`
 * treats as an outstanding blocker — a graphical work could never upload.
 */

function imagesOnlyDto(overrides: Partial<IndexedItemDto> = {}): IndexedItemDto {
  const base: IndexedItemDto = {
    id: "map1",
    folderName: "A watermarked map",
    folderPath: "/unprocessed/A watermarked map",
    relativePath: "A watermarked map",
    hidden: false,
    root: "unprocessed",
    level: "main",
    assets: [{ filename: "map.jpg", path: "map.jpg", sizeBytes: 12345 }],
    stages: { thumbnail: { status: "done" } },
    uploaded: false,
    reupload: false,
    reuploadTextOnly: false,
    backendId: null,
    batchId: null,
  };
  return { ...base, ...overrides };
}

describe("toItem — recursive folder discovery fields", () => {
  it("maps relativePath and hidden straight through", () => {
    const item = toItem(
      imagesOnlyDto({ relativePath: "Wrapper/A watermarked map", hidden: true }),
    );
    expect(item.relativePath).toBe("Wrapper/A watermarked map");
    expect(item.hidden).toBe(true);
  });
});

describe("toItem — non-applicable stages", () => {
  it("reads pdf/ocr as skipped, not pending, for an images-only item with no DB row for them", () => {
    const item = toItem(imagesOnlyDto());
    expect(item.stages.thumbnail.status).toBe("done");
    expect(item.stages.pdf.status).toBe("skipped");
    expect(item.stages.ocr.status).toBe("skipped");
  });

  it("no longer blocks upload on pdf/ocr once they're correctly skipped", () => {
    const item = toItem(imagesOnlyDto());
    const blockers = uploadBlockers(item, { metadataReady: true, primaryThumbnail: "map.jpg" });
    expect(blockers.find((b) => b.code === "not-processed")).toBeUndefined();
  });

  it("still blocks upload when thumbnail itself is genuinely unfinished (pending, not missing-and-N/A)", () => {
    const item = toItem(imagesOnlyDto({ stages: {} }));
    expect(item.stages.thumbnail.status).toBe("pending");
    const blockers = uploadBlockers(item, { metadataReady: true, primaryThumbnail: "map.jpg" });
    expect(blockers.find((b) => b.code === "not-processed")?.message).toContain("thumbnail");
  });
});
