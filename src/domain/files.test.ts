import { describe, it, expect } from "vitest";
import {
  classifyAsset,
  discoverAsset,
  webPdfAssets,
  thumbnailCandidates,
  autoThumbnail,
  needsThumbnailChoice,
  ocrApplicable,
  uploadRoleFor,
  type DiscoveredAsset,
} from "./files";
import { FileRole } from "./enums";

// `extensionOf` / `baseNameOf` moved to `domain/naming` (Epic 10) — their tests
// live in `naming.test.ts` alongside the rest of the convention.

describe("classifyAsset (docs/01 §Naming)", () => {
  const cases: Array<[string, ReturnType<typeof classifyAsset>]> = [
    ["gorski.tif", "source-tiff"],
    ["gorski.tiff", "source-tiff"],
    ["gorski_archive.pdf", "archival-pdf"],
    ["gorski.pdf", "web-pdf"],
    ["gorski_1.pdf", "web-pdf"],
    ["gorski.txt", "ocr-text"],
    ["gorski.json", "metadata-json"],
    ["metadata.json", "metadata-json"],
    ["gorski_thumb.png", "thumbnail"],
    ["thumbnail.jpg", "thumbnail"],
    ["page_1.jpg", "image"],
    ["cover.jpeg", "image"],
    ["readme.md", "other"],
  ];
  for (const [filename, kind] of cases) {
    it(`${filename} → ${kind}`, () => {
      expect(classifyAsset(filename)).toBe(kind);
    });
  }
});

describe("asset-set helpers", () => {
  const assets: DiscoveredAsset[] = [
    discoverAsset("gorski.pdf", "/p/gorski.pdf"),
    discoverAsset("gorski_archive.pdf", "/p/gorski_archive.pdf"),
    discoverAsset("gorski.tif", "/p/gorski.tif"),
    discoverAsset("page_1.jpg", "/p/page_1.jpg"),
    discoverAsset("gorski_thumb.png", "/p/gorski_thumb.png"),
    discoverAsset("gorski.txt", "/p/gorski.txt"),
  ];

  it("webPdfAssets returns only non-archive PDFs", () => {
    expect(webPdfAssets(assets).map((a) => a.filename)).toEqual(["gorski.pdf"]);
  });

  it("thumbnailCandidates are the raster images (incl. pre-tagged thumbnail)", () => {
    expect(thumbnailCandidates(assets).map((a) => a.filename)).toEqual([
      "page_1.jpg",
      "gorski_thumb.png",
    ]);
  });

  it("ocrApplicable is true when a PDF or TIFF is present", () => {
    expect(ocrApplicable(assets)).toBe(true);
  });

  it("ocrApplicable is false for an images-only folder", () => {
    const imagesOnly = [
      discoverAsset("a.jpg", "/p/a.jpg"),
      discoverAsset("b.png", "/p/b.png"),
    ];
    expect(ocrApplicable(imagesOnly)).toBe(false);
  });
});

describe("thumbnail auto-selection (docs/tasks/04 §Thumbnail picker)", () => {
  const img = (name: string) => discoverAsset(name, `/p/${name}`);

  it("auto-selects a lone candidate, no choice needed", () => {
    const assets = [img("gorski.pdf"), img("page_1.jpg")];
    expect(autoThumbnail(assets)?.filename).toBe("page_1.jpg");
    expect(needsThumbnailChoice(assets)).toBe(false);
  });

  it("a pre-tagged thumbnail wins outright, even beside other images", () => {
    const assets = [img("gorski_thumb.png"), img("page_1.jpg"), img("page_2.jpg")];
    expect(autoThumbnail(assets)?.filename).toBe("gorski_thumb.png");
    expect(needsThumbnailChoice(assets)).toBe(false);
  });

  it("needs a choice when several plain images and no tagged thumbnail", () => {
    const assets = [img("page_1.jpg"), img("page_2.jpg")];
    expect(autoThumbnail(assets)).toBeNull();
    expect(needsThumbnailChoice(assets)).toBe(true);
  });

  it("needs a choice when the tagged thumbnail is itself ambiguous", () => {
    const assets = [img("a_thumb.png"), img("thumbnail.jpg")];
    expect(autoThumbnail(assets)).toBeNull();
    expect(needsThumbnailChoice(assets)).toBe(true);
  });

  it("no candidates → nothing to auto-select and no choice", () => {
    const assets = [img("gorski.pdf"), img("gorski.tif")];
    expect(autoThumbnail(assets)).toBeNull();
    expect(needsThumbnailChoice(assets)).toBe(false);
  });
});

describe("uploadRoleFor", () => {
  const webPdf = discoverAsset("gorski.pdf", "/p/gorski.pdf");
  const image = discoverAsset("page_1.jpg", "/p/page_1.jpg");
  const tiff = discoverAsset("gorski.tif", "/p/gorski.tif");

  it("tags the chosen primary as THUMBNAIL", () => {
    expect(uploadRoleFor(image, "page_1.jpg")).toBe(FileRole.THUMBNAIL);
  });

  it("tags other web assets as WEB", () => {
    expect(uploadRoleFor(webPdf, "page_1.jpg")).toBe(FileRole.WEB);
    expect(uploadRoleFor(image, null)).toBe(FileRole.WEB);
  });

  it("never uploads source TIFFs (null role)", () => {
    expect(uploadRoleFor(tiff, null)).toBeNull();
  });
});
