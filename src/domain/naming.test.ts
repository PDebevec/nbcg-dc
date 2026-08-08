import { describe, it, expect } from "vitest";
import {
  extensionOf,
  baseNameOf,
  hasArchivalSuffix,
  hasThumbnailSuffix,
  webPdfName,
  archivalPdfName,
  thumbnailName,
  ocrTextName,
  metadataName,
  derivedOutputNames,
  DERIVED_OUTPUT_ORDER,
  pageName,
  pageNames,
  pageNumberOf,
  ocrTextNameFor,
  isOcrTextFor,
  buildNamingPreview,
  SAMPLE_FOLDER_NAME,
  sortNatural,
  parseScanPageName,
  isVariantFilename,
  detectPageSequence,
  decodeMojibakeFilename,
  matchesLossyFilename,
  isSameUploadedFilename,
  isMangledFilename,
} from "./naming";

describe("name parsing primitives", () => {
  it("extensionOf lowercases and handles dotless / dotfile names", () => {
    expect(extensionOf("a.PDF")).toBe("pdf");
    expect(extensionOf("a.tar.gz")).toBe("gz");
    expect(extensionOf("noext")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
    // A trailing dot carries no extension.
    expect(extensionOf("trailing.")).toBe("");
  });

  it("baseNameOf strips the extension", () => {
    expect(baseNameOf("gorski_vijenac.pdf")).toBe("gorski_vijenac");
    expect(baseNameOf("noext")).toBe("noext");
    expect(baseNameOf(".gitignore")).toBe(".gitignore");
  });

  it("suffix predicates are case-insensitive", () => {
    expect(hasArchivalSuffix("gorski_archive")).toBe(true);
    expect(hasArchivalSuffix("gorski_ARCHIVE")).toBe(true);
    expect(hasArchivalSuffix("gorski")).toBe(false);
    // "_archive" must be a suffix, not merely present.
    expect(hasArchivalSuffix("gorski_archive_v2")).toBe(false);

    expect(hasThumbnailSuffix("gorski_thumb")).toBe(true);
    expect(hasThumbnailSuffix("gorski_Thumb")).toBe(true);
    expect(hasThumbnailSuffix("thumbnail")).toBe(false);
  });
});

describe("folder-derived output names (docs/tasks/10 §Data)", () => {
  const base = "njegos_gorski_vijenac";

  it("matches the documented convention exactly", () => {
    expect(webPdfName(base)).toBe("njegos_gorski_vijenac.pdf");
    expect(archivalPdfName(base)).toBe("njegos_gorski_vijenac_archive.pdf");
    expect(thumbnailName(base)).toBe("njegos_gorski_vijenac_thumb.png");
    expect(ocrTextName(base)).toBe("njegos_gorski_vijenac.txt");
    expect(metadataName(base)).toBe("njegos_gorski_vijenac.json");
  });

  it("derivedOutputNames covers every DerivedOutput", () => {
    const names = derivedOutputNames(base);
    expect(Object.keys(names).sort()).toEqual([...DERIVED_OUTPUT_ORDER].sort());
    expect(names["archival-pdf"]).toBe(archivalPdfName(base));
  });

  it("the derived names round-trip through classification's predicates", () => {
    // Guards the seam with `domain/files`: an archival master must not read as a
    // web PDF, and the thumbnail must be recognised as one.
    expect(hasArchivalSuffix(baseNameOf(archivalPdfName(base)))).toBe(true);
    expect(hasArchivalSuffix(baseNameOf(webPdfName(base)))).toBe(false);
    expect(hasThumbnailSuffix(baseNameOf(thumbnailName(base)))).toBe(true);
  });
});

describe("multi-page numbering (unpadded)", () => {
  it("appends an unpadded 1-based page number", () => {
    expect(pageName("gorski", 1, "pdf")).toBe("gorski_1.pdf");
    expect(pageName("gorski", 10, "pdf")).toBe("gorski_10.pdf");
  });

  it("pageNames runs 1..count in order", () => {
    expect(pageNames("gorski", 3, "pdf")).toEqual([
      "gorski_1.pdf",
      "gorski_2.pdf",
      "gorski_3.pdf",
    ]);
    expect(pageNames("gorski", 0, "pdf")).toEqual([]);
  });

  it("rejects a non-positive or fractional page rather than padding it", () => {
    expect(() => pageName("gorski", 0, "pdf")).toThrow(RangeError);
    expect(() => pageName("gorski", -1, "pdf")).toThrow(RangeError);
    expect(() => pageName("gorski", 1.5, "pdf")).toThrow(RangeError);
  });

  it("pageNumberOf reads only unpadded page numbers", () => {
    expect(pageNumberOf("gorski_1.pdf")).toBe(1);
    expect(pageNumberOf("gorski_10.pdf")).toBe(10);
    // Padded is not the convention, so it is not a page number.
    expect(pageNumberOf("gorski_01.pdf")).toBeNull();
    expect(pageNumberOf("gorski.pdf")).toBeNull();
    expect(pageNumberOf("gorski_archive.pdf")).toBeNull();
    expect(pageNumberOf("gorski_.pdf")).toBeNull();
    // A leading-underscore name has no base to number.
    expect(pageNumberOf("_1.pdf")).toBeNull();
  });
});

describe("the multi-asset exception", () => {
  it("pairs a discovered file's text by its OWN base name", () => {
    expect(ocrTextNameFor("prvi_dio.pdf")).toBe("prvi_dio.txt");
    // Not renamed to the folder name — that is the whole point of the exception.
    expect(ocrTextNameFor("foo.pdf")).not.toBe("njegos_gorski_vijenac.txt");
  });

  it("isOcrTextFor matches on base name and .txt only", () => {
    expect(isOcrTextFor("foo.txt", "foo.pdf")).toBe(true);
    expect(isOcrTextFor("foo.txt", "bar.pdf")).toBe(false);
    expect(isOcrTextFor("foo.json", "foo.pdf")).toBe(false);
  });
});

describe("incoming scanner filenames (docs/05-real-scan-data.md)", () => {
  it("compareNatural orders digit runs numerically", () => {
    expect(sortNatural(["10.jpg", "2.jpg", "1.jpg", "100.jpg"])).toEqual([
      "1.jpg",
      "2.jpg",
      "10.jpg",
      "100.jpg",
    ]);
    // The failure this exists to prevent: lexicographic order shuffles a book.
    expect(["10.jpg", "2.jpg", "1.jpg", "100.jpg"].sort()).not.toEqual([
      "1.jpg",
      "2.jpg",
      "10.jpg",
      "100.jpg",
    ]);
  });

  it("compareNatural handles prefixes, padding, and equal values", () => {
    expect(sortNatural(["SP_010.jpg", "SP_002.jpg"])).toEqual([
      "SP_002.jpg",
      "SP_010.jpg",
    ]);
    // Same number, different padding — deterministic, and adjacent.
    expect(sortNatural(["01.jpg", "1.jpg"])).toHaveLength(2);
    expect(sortNatural(["b1.jpg", "a2.jpg"])).toEqual(["a2.jpg", "b1.jpg"]);
  });

  it("parseScanPageName reads padded and prefixed numbers", () => {
    expect(parseScanPageName("1.jpg")).toEqual({
      prefix: "",
      suffix: "",
      number: 1,
      digits: 1,
    });
    expect(parseScanPageName("000.jpg")).toEqual({
      prefix: "",
      suffix: "",
      number: 0,
      digits: 3,
    });
    expect(parseScanPageName("SP_001.jpg")).toEqual({
      prefix: "SP_",
      suffix: "",
      number: 1,
      digits: 3,
    });
    expect(parseScanPageName("cover.jpg")).toBeNull();
  });

  it("isVariantFilename spots a derived preview beside its original", () => {
    expect(isVariantFilename("SP_001 (Small).jpg")).toBe(true);
    expect(isVariantFilename("page (Copy).jpg")).toBe(true);
    expect(isVariantFilename("SP_001.jpg")).toBe(false);
  });

  describe("detectPageSequence against the real corpus", () => {
    const range = (from: number, to: number, fmt: (n: number) => string) =>
      Array.from({ length: to - from + 1 }, (_, i) => fmt(from + i));

    it("CERNAGORA — unpadded 1..260 is a sequence", () => {
      const seq = detectPageSequence(range(1, 260, (n) => `${n}.jpg`));
      expect(seq.isSequence).toBe(true);
      expect(seq.filenames).toHaveLength(260);
      expect(seq.filenames[0]).toBe("1.jpg");
      expect(seq.filenames[259]).toBe("260.jpg");
      expect(seq.padded).toBe(false);
      expect(seq.missing).toEqual([]);
    });

    it("ОКТОИХ — zero-padded 000..161 is a padded sequence", () => {
      const seq = detectPageSequence(
        range(0, 161, (n) => `${String(n).padStart(3, "0")}.jpg`),
      );
      expect(seq.isSequence).toBe(true);
      expect(seq.filenames[0]).toBe("000.jpg");
      expect(seq.padded).toBe(true);
      expect(seq.prefix).toBe("");
    });

    it("Pisma iz Liona — SP_001..SP_052, ignoring the (Small) variant", () => {
      const names = [
        ...range(1, 52, (n) => `SP_${String(n).padStart(3, "0")}.jpg`),
        "SP_001 (Small).jpg",
      ];
      const seq = detectPageSequence(names);
      expect(seq.isSequence).toBe(true);
      expect(seq.filenames).toHaveLength(52);
      expect(seq.prefix).toBe("SP_");
      expect(seq.filenames).not.toContain("SP_001 (Small).jpg");
    });

    it("the map — one descriptively-named file is NOT a sequence", () => {
      const seq = detectPageSequence([
        "Budua and Cetinje  zone 36 col XX. – Wien, 1886 Kr1516 id=21964048.jpg",
      ]);
      expect(seq.isSequence).toBe(false);
    });
  });

  it("needs at least three files to call something a sequence", () => {
    expect(detectPageSequence(["1.jpg", "2.jpg"]).isSequence).toBe(false);
    expect(detectPageSequence(["1.jpg", "2.jpg", "3.jpg"]).isSequence).toBe(true);
  });

  it("survives a stray unnumbered file beside a run", () => {
    const seq = detectPageSequence(["cover.jpg", "1.jpg", "2.jpg", "3.jpg"]);
    expect(seq.isSequence).toBe(true);
    expect(seq.filenames).toEqual(["1.jpg", "2.jpg", "3.jpg"]);
  });

  it("picks the largest run when two prefixes are present", () => {
    // CERNAGORA once held `1..260` plus `C001..C131` (double-page variants).
    const names = [
      ...Array.from({ length: 20 }, (_, i) => `${i + 1}.jpg`),
      ...Array.from({ length: 5 }, (_, i) => `C${String(i + 1).padStart(3, "0")}.jpg`),
    ];
    const seq = detectPageSequence(names);
    expect(seq.prefix).toBe("");
    expect(seq.filenames).toHaveLength(20);
  });

  it("reports gaps in the run", () => {
    const seq = detectPageSequence(["1.jpg", "2.jpg", "4.jpg", "5.jpg"]);
    expect(seq.isSequence).toBe(true);
    expect(seq.missing).toEqual([3]);
  });
});

describe("buildNamingPreview (Settings → Data live preview)", () => {
  it("derives every row from the given folder name", () => {
    const preview = buildNamingPreview("mapa_1878");
    expect(preview.folderName).toBe("mapa_1878");
    expect(preview.derived.map((r) => r.filename)).toEqual([
      "mapa_1878.pdf",
      "mapa_1878_archive.pdf",
      "mapa_1878_thumb.png",
      "mapa_1878.txt",
      "mapa_1878.json",
    ]);
    expect(preview.pages).toEqual([
      "mapa_1878_1.pdf",
      "mapa_1878_2.pdf",
      "mapa_1878_3.pdf",
    ]);
  });

  it("shows the multi-asset files keeping their own names", () => {
    const preview = buildNamingPreview("mapa_1878");
    expect(preview.multiAsset).toEqual([
      { source: "prvi_dio.pdf", text: "prvi_dio.txt" },
      { source: "drugi_dio.pdf", text: "drugi_dio.txt" },
    ]);
    // None of them adopt the folder name.
    for (const row of preview.multiAsset) {
      expect(row.source.startsWith("mapa_1878")).toBe(false);
    }
  });

  it("falls back to the sample name for blank input", () => {
    expect(buildNamingPreview("").folderName).toBe(SAMPLE_FOLDER_NAME);
    expect(buildNamingPreview("   ").folderName).toBe(SAMPLE_FOLDER_NAME);
    expect(buildNamingPreview(null).folderName).toBe(SAMPLE_FOLDER_NAME);
    expect(buildNamingPreview(undefined).folderName).toBe(SAMPLE_FOLDER_NAME);
  });

  it("trims surrounding whitespace from a folder name", () => {
    expect(buildNamingPreview("  mapa  ").folderName).toBe("mapa");
    expect(buildNamingPreview("  mapa  ").derived[0].filename).toBe("mapa.pdf");
  });
});

describe("duplicate page numbers (detectPageSequence)", () => {
  it("flags two files claiming the same page number", () => {
    // A folder holding both formats of each page — entirely ordinary, and it
    // would otherwise put every page into the PDF twice.
    const seq = detectPageSequence([
      "1.jpg", "1.png", "2.jpg", "2.png", "3.jpg", "3.png",
    ]);
    expect(seq.isSequence).toBe(true);
    expect(seq.duplicates).toEqual([1, 2, 3]);
    expect(seq.missing).toEqual([]);
  });

  it("flags mixed padding of the same number", () => {
    const seq = detectPageSequence(["1.jpg", "01.jpg", "2.jpg", "3.jpg"]);
    expect(seq.duplicates).toEqual([1]);
  });

  it("reports no duplicates for a clean run", () => {
    expect(detectPageSequence(["1.jpg", "2.jpg", "3.jpg"]).duplicates).toEqual([]);
  });

  it("counts a number claimed three times only once", () => {
    const seq = detectPageSequence(["1.jpg", "1.png", "1.webp", "2.jpg", "3.jpg"]);
    expect(seq.duplicates).toEqual([1]);
  });

  it("still computes gaps correctly alongside duplicates", () => {
    const seq = detectPageSequence(["1.jpg", "1.png", "2.jpg", "4.jpg"]);
    expect(seq.duplicates).toEqual([1]);
    expect(seq.missing).toEqual([3]);
  });
});

// ─── backend-mangled filenames ──────────────────────────────────────────────
// The strings below were captured from the LIVE backend on 2026-08-08 by
// uploading `ОКТОИХ петогласник 2.pdf` — a real folder name in the sample set.
// Pinning the actual observed output keeps this honest: if the backend is fixed,
// these tests are what tell us the workaround can go.

const CYRILLIC_LOCAL = "ОКТОИХ петогласник 2.pdf";
const CYRILLIC_LOSSY = "?????? ??????????? 2.pdf";

/**
 * The name the backend stored, built the way the backend builds it: take the
 * UTF-8 bytes and read them as Latin-1.
 *
 * Derived rather than pasted as a literal on purpose — the real value contains
 * unprintable C1 control characters (`0x9E`, `0x9A`, …), and pasting it into a
 * source file silently drops them (verified: a pasted copy came out 35 chars
 * instead of 41, and the tests passed for the wrong reason). Confirmed against
 * the live backend 2026-08-08: uploading `CYRILLIC_LOCAL` stores exactly this.
 */
const CYRILLIC_STORED = Array.from(
  new TextEncoder().encode(CYRILLIC_LOCAL),
  (byte) => String.fromCharCode(byte),
).join("");

describe("filenames as the backend stores them", () => {
  it("decodes the real captured mojibake back to the sent name", () => {
    expect(decodeMojibakeFilename(CYRILLIC_STORED)).toBe(CYRILLIC_LOCAL);
  });

  it("leaves a pure-ASCII name alone", () => {
    expect(decodeMojibakeFilename("gorski_vijenac.pdf")).toBe("gorski_vijenac.pdf");
  });

  it("returns null when the string is not recoverable mojibake", () => {
    // Already-correct Cyrillic: code points above 0xFF are not Latin-1 bytes.
    expect(decodeMojibakeFilename(CYRILLIC_LOCAL)).toBeNull();
    // 0xFF is never a valid UTF-8 lead byte. `fatal: true` must reject it rather
    // than yield U+FFFD — without that, every name would "decode" and the
    // matcher would produce false positives.
    expect(decodeMojibakeFilename("\xFF\xFE.pdf")).toBeNull();
  });

  it("matches the lossy `?` shape strictly", () => {
    expect(matchesLossyFilename(CYRILLIC_LOSSY, CYRILLIC_LOCAL)).toBe(true);
    // Same length and shape, but an ASCII position differs — a different file.
    expect(matchesLossyFilename("?????? ??????????? 3.pdf", CYRILLIC_LOCAL)).toBe(false);
    expect(matchesLossyFilename("?????.pdf", CYRILLIC_LOCAL)).toBe(false);
    // An all-ASCII pair is the exact-match case; this must not claim it.
    expect(matchesLossyFilename("a.pdf", "a.pdf")).toBe(false);
  });

  it("isSameUploadedFilename recognises exact, mojibake and lossy forms", () => {
    expect(isSameUploadedFilename("a.pdf", "a.pdf")).toBe(true);
    expect(isSameUploadedFilename(CYRILLIC_STORED, CYRILLIC_LOCAL)).toBe(true);
    expect(isSameUploadedFilename(CYRILLIC_LOSSY, CYRILLIC_LOCAL)).toBe(true);
    expect(isSameUploadedFilename("something_else.pdf", CYRILLIC_LOCAL)).toBe(false);
  });

  it("does not confuse two different mangled names", () => {
    expect(isSameUploadedFilename(CYRILLIC_STORED, "ОКТОИХ петогласник 3.pdf")).toBe(false);
  });

  it("isMangledFilename is true only when the stored name differs", () => {
    expect(isMangledFilename(CYRILLIC_STORED, CYRILLIC_LOCAL)).toBe(true);
    expect(isMangledFilename("a.pdf", "a.pdf")).toBe(false);
    expect(isMangledFilename("unrelated.pdf", CYRILLIC_LOCAL)).toBe(false);
  });
});
