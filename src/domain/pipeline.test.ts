import { describe, it, expect } from "vitest";
import { discoverAsset, type DiscoveredAsset } from "./files";
import { emptyStages, type ItemStages, type StageName } from "./item";
import {
  RUNNABLE_STAGES,
  applicableStages,
  buildsArchival,
  classifyInput,
  dirtiesUpload,
  failedRunnableStages,
  markNonApplicableSkipped,
  planPipeline,
  planThumbnail,
  processingComplete,
  stagesToRun,
  uploadCandidates,
} from "./pipeline";

/** Build a folder's discovered+classified assets from bare filenames. */
function folder(folderName: string, ...filenames: string[]): DiscoveredAsset[] {
  return filenames.map((f) => discoverAsset(f, `/scans/${folderName}/${f}`, folderName));
}

/** An item stage map with specific statuses applied. */
function stagesWith(overrides: Partial<Record<StageName, ItemStages[StageName]["status"]>>): ItemStages {
  const s = emptyStages();
  for (const [name, status] of Object.entries(overrides)) {
    s[name as StageName] = { status: status! };
  }
  return s;
}

describe("classifyInput — the adaptive branch (docs/tasks/06 §Source inputs)", () => {
  it("TIFFs present → tiffs (even alongside a PDF/images)", () => {
    expect(classifyInput(folder("nb", "0001.tif", "0002.tif"))).toBe("tiffs");
    expect(classifyInput(folder("nb", "0001.tif", "nb.pdf", "cover.jpg"))).toBe(
      "tiffs",
    );
  });
  it("exactly one PDF, no TIFFs → supplied-pdf", () => {
    expect(classifyInput(folder("nb", "nb.pdf"))).toBe("supplied-pdf");
    expect(classifyInput(folder("nb", "nb.pdf", "cover.jpg"))).toBe("supplied-pdf");
  });
  it("several PDFs, no TIFFs → multiple-pdfs", () => {
    expect(classifyInput(folder("nb", "a.pdf", "b.pdf"))).toBe("multiple-pdfs");
  });
  it("the archival master alone does not count as a supplied web PDF", () => {
    // `<name>_archive.pdf` classifies as archival-pdf, not web-pdf.
    expect(classifyInput(folder("nb", "nb_archive.pdf", "cover.jpg"))).toBe(
      "images-only",
    );
  });
  it("images with no PDF/TIFF → images-only", () => {
    expect(classifyInput(folder("map", "a.jpg", "b.jpg"))).toBe("images-only");
  });
  it("nothing processable → empty", () => {
    expect(classifyInput(folder("nb", "notes.txt", "nb.json"))).toBe("empty");
  });
});

describe("applicableStages / buildsArchival", () => {
  it("PDF-bearing shapes run all three stages", () => {
    for (const shape of ["tiffs", "supplied-pdf", "multiple-pdfs"] as const) {
      expect(applicableStages(shape)).toEqual({ pdf: true, thumbnail: true, ocr: true });
    }
  });
  it("images-only runs thumbnail only (no PDF, no OCR)", () => {
    expect(applicableStages("images-only")).toEqual({
      pdf: false,
      thumbnail: true,
      ocr: false,
    });
  });
  it("empty runs nothing", () => {
    expect(applicableStages("empty")).toEqual({
      pdf: false,
      thumbnail: false,
      ocr: false,
    });
  });
  it("only TIFFs build the archival master", () => {
    expect(buildsArchival("tiffs")).toBe(true);
    expect(buildsArchival("supplied-pdf")).toBe(false);
    expect(buildsArchival("images-only")).toBe(false);
  });
});

describe("planThumbnail — source selection", () => {
  it("a lone present image auto-selects (the common 'PDF + one image' case)", () => {
    const t = planThumbnail(folder("nb", "nb.pdf", "cover.jpg"), "supplied-pdf");
    expect(t.candidateCount).toBe(1);
    expect(t.autoPrimary?.filename).toBe("cover.jpg");
    expect(t.needsChoice).toBe(false);
    expect(t.resolved).toBe(true);
  });
  it("a pre-tagged `thumbnail` image wins even among several", () => {
    const t = planThumbnail(
      folder("nb", "a.jpg", "b.jpg", "thumbnail.png"),
      "images-only",
    );
    expect(t.autoPrimary?.filename).toBe("thumbnail.png");
    expect(t.needsChoice).toBe(false);
  });
  it("two or more plain present images need an operator choice", () => {
    const t = planThumbnail(folder("map", "a.jpg", "b.jpg"), "images-only");
    expect(t.candidateCount).toBe(2);
    expect(t.autoPrimary).toBeNull();
    expect(t.needsChoice).toBe(true);
    expect(t.resolved).toBe(false);
  });
  it("a single PDF with no image auto-resolves to its generated first page", () => {
    const t = planThumbnail(folder("nb", "nb.pdf"), "supplied-pdf");
    expect(t.generatedCount).toBe(1);
    expect(t.candidateCount).toBe(1);
    expect(t.autoPrimary).toBeNull(); // the file doesn't exist yet…
    expect(t.needsChoice).toBe(false); // …but no choice is needed
    expect(t.resolved).toBe(true);
  });
  it("several PDFs (no images) each yield a first page → needs a choice", () => {
    const t = planThumbnail(folder("nb", "a.pdf", "b.pdf"), "multiple-pdfs");
    expect(t.generatedCount).toBe(2);
    expect(t.needsChoice).toBe(true);
    expect(t.resolved).toBe(false);
  });
});

describe("uploadCandidates — base names preserved for OCR matching", () => {
  it("a TIFF build and a single supplied PDF are folder-derived", () => {
    expect(uploadCandidates(folder("nb", "0001.tif"), "nb", "tiffs")).toEqual([
      { name: "nb.pdf", base: "nb", kind: "web-pdf" },
    ]);
    expect(uploadCandidates(folder("nb", "scan.pdf"), "nb", "supplied-pdf")).toEqual([
      { name: "nb.pdf", base: "nb", kind: "web-pdf" },
    ]);
  });
  it("multiple PDFs keep their own base names", () => {
    expect(
      uploadCandidates(folder("nb", "vol1.pdf", "vol2.pdf"), "nb", "multiple-pdfs"),
    ).toEqual([
      { name: "vol1.pdf", base: "vol1", kind: "web-pdf" },
      { name: "vol2.pdf", base: "vol2", kind: "web-pdf" },
    ]);
  });
  it("images-only yields the images", () => {
    expect(
      uploadCandidates(folder("map", "a.jpg", "b.jpg"), "map", "images-only"),
    ).toEqual([
      { name: "a.jpg", base: "a", kind: "image" },
      { name: "b.jpg", base: "b", kind: "image" },
    ]);
  });
});

describe("planPipeline — integration", () => {
  it("images-only marks pdf/ocr N/A and needs a thumbnail choice", () => {
    const plan = planPipeline(folder("map", "a.jpg", "b.jpg"), "map");
    expect(plan.inputShape).toBe("images-only");
    expect(plan.ocrApplicable).toBe(false);
    expect(plan.stages).toEqual({ pdf: false, thumbnail: true, ocr: false });
    expect(plan.thumbnail.needsChoice).toBe(true);
  });
  it("a TIFF folder builds archival + web + thumb + ocr", () => {
    const plan = planPipeline(folder("nb", "0001.tif", "0002.tif"), "nb");
    expect(plan.inputShape).toBe("tiffs");
    expect(plan.buildsArchival).toBe(true);
    expect(plan.stages).toEqual({ pdf: true, thumbnail: true, ocr: true });
    expect(plan.candidates).toEqual([{ name: "nb.pdf", base: "nb", kind: "web-pdf" }]);
    expect(plan.thumbnail.resolved).toBe(true);
  });
});

describe("stagesToRun — skip-if-done + selection", () => {
  const plan = planPipeline(folder("nb", "0001.tif"), "nb"); // all three apply

  it("runs applicable stages that aren't already done", () => {
    const stages = stagesWith({ pdf: "done", thumbnail: "pending", ocr: "failed" });
    expect(stagesToRun(stages, plan)).toEqual(["thumbnail", "ocr"]);
  });
  it("force re-runs even done stages", () => {
    const stages = stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" });
    expect(stagesToRun(stages, plan, { force: true })).toEqual([
      "pdf",
      "thumbnail",
      "ocr",
    ]);
  });
  it("`only` restricts to the intersection with applicable stages", () => {
    const stages = stagesWith({ pdf: "failed", thumbnail: "failed", ocr: "failed" });
    expect(stagesToRun(stages, plan, { only: ["ocr"] })).toEqual(["ocr"]);
  });
  it("never returns a non-applicable stage (images-only → no pdf/ocr)", () => {
    const imgPlan = planPipeline(folder("map", "a.jpg", "b.jpg"), "map");
    const stages = stagesWith({ pdf: "pending", thumbnail: "pending", ocr: "pending" });
    expect(stagesToRun(stages, imgPlan, { force: true })).toEqual(["thumbnail"]);
  });
});

describe("failedRunnableStages", () => {
  it("returns only applicable, failed stages", () => {
    const plan = planPipeline(folder("map", "a.jpg", "b.jpg"), "map"); // thumbnail only
    const stages = stagesWith({ pdf: "failed", thumbnail: "failed", ocr: "failed" });
    // pdf/ocr are N/A for images-only, so only thumbnail counts.
    expect(failedRunnableStages(stages, plan)).toEqual(["thumbnail"]);
  });
});

describe("processingComplete", () => {
  const pdfPlan = planPipeline(folder("nb", "0001.tif"), "nb");

  it("is false until every applicable stage is done", () => {
    expect(
      processingComplete(stagesWith({ pdf: "done", thumbnail: "done", ocr: "running" }), pdfPlan),
    ).toBe(false);
  });
  it("is true when all applicable stages are done and the thumbnail is resolved", () => {
    expect(
      processingComplete(stagesWith({ pdf: "done", thumbnail: "done", ocr: "done" }), pdfPlan),
    ).toBe(true);
  });
  it("ignores non-applicable stages (images-only needs only thumbnail)", () => {
    const imgPlan = planPipeline(folder("nb", "cover.jpg"), "nb"); // single image → resolved
    expect(processingComplete(stagesWith({ thumbnail: "done" }), imgPlan)).toBe(true);
  });
  it("stays incomplete while the thumbnail choice is unresolved", () => {
    const imgPlan = planPipeline(folder("map", "a.jpg", "b.jpg"), "map"); // needs choice
    expect(processingComplete(stagesWith({ thumbnail: "done" }), imgPlan)).toBe(false);
  });
});

describe("markNonApplicableSkipped", () => {
  it("downgrades untouched non-applicable stages to skipped, leaving real outcomes", () => {
    const imgPlan = planPipeline(folder("map", "a.jpg", "b.jpg"), "map");
    const out = markNonApplicableSkipped(
      stagesWith({ pdf: "pending", ocr: "pending", thumbnail: "running" }),
      imgPlan,
    );
    expect(out.pdf.status).toBe("skipped");
    expect(out.ocr.status).toBe("skipped");
    expect(out.thumbnail.status).toBe("running"); // applicable → untouched
  });
  it("never overwrites a recorded non-pending outcome", () => {
    const imgPlan = planPipeline(folder("map", "a.jpg", "b.jpg"), "map");
    const out = markNonApplicableSkipped(stagesWith({ ocr: "done" }), imgPlan);
    expect(out.ocr.status).toBe("done");
  });
});

describe("dirtiesUpload — derived outputs dirty, metadata never", () => {
  it("every runnable stage dirties a published item", () => {
    for (const s of RUNNABLE_STAGES) expect(dirtiesUpload(s)).toBe(true);
  });
  it("metadata and upload never dirty", () => {
    expect(dirtiesUpload("metadata")).toBe(false);
    expect(dirtiesUpload("upload")).toBe(false);
  });
});

// ── the real corpus (docs/05-real-scan-data.md) ─────────────────────────────
// These four folders are the reason `page-images` exists. Before it, three of
// the four were mishandled: the two JPG books got NO PDF and NO OCR, and the
// operator was asked to pick a thumbnail from 260/162 equal candidates.

/** `count` page images named by `fmt`, as a real scan folder would hold them. */
function pages(folderName: string, count: number, fmt: (n: number) => string, from = 1) {
  return folder(
    folderName,
    ...Array.from({ length: count }, (_, i) => fmt(from + i)),
  );
}

describe("real scan folders", () => {
  it("CERNAGORA (260 unpadded JPGs) is a book: PDF + OCR, first page as thumb", () => {
    const assets = pages("CERNAGORA", 260, (n) => `${n}.jpg`);
    const plan = planPipeline(assets, "CERNAGORA");

    expect(plan.inputShape).toBe("page-images");
    expect(plan.stages).toEqual({ pdf: true, thumbnail: true, ocr: true });
    // JPG is already lossy — there is no lossless source to preserve.
    expect(plan.buildsArchival).toBe(false);
    // One PDF assembled from the pages, not 260 loose uploads.
    expect(plan.candidates).toEqual([
      { name: "CERNAGORA.pdf", base: "CERNAGORA", kind: "web-pdf" },
    ]);
    // The thumbnail is page 1 — nothing to choose.
    expect(plan.thumbnail.needsChoice).toBe(false);
    expect(plan.thumbnail.resolved).toBe(true);
    expect(plan.thumbnail.autoPrimary?.filename).toBe("1.jpg");
    // Page order is numeric, not lexicographic.
    expect(plan.pages.slice(0, 3).map((p) => p.filename)).toEqual([
      "1.jpg",
      "2.jpg",
      "3.jpg",
    ]);
    expect(plan.pages).toHaveLength(260);
    expect(plan.warnings).toEqual([]);
  });

  it("ОКТОИХ (162 zero-padded JPGs) is a book", () => {
    const assets = pages(
      "ОКТОИХ петогласник 2",
      162,
      (n) => `${String(n).padStart(3, "0")}.jpg`,
      0,
    );
    const plan = planPipeline(assets, "ОКТОИХ петогласник 2");

    expect(plan.inputShape).toBe("page-images");
    expect(plan.ocrApplicable).toBe(true);
    expect(plan.pages[0].filename).toBe("000.jpg");
    expect(plan.thumbnail.autoPrimary?.filename).toBe("000.jpg");
  });

  it("the watermarked map stays a graphical work: no PDF, no OCR", () => {
    const assets = folder(
      "sa vodenim zigom",
      "Budua and Cetinje  zone 36 col XX. – Wien, 1886 Kr1516 id=21964048.jpg",
    );
    const plan = planPipeline(assets, "sa vodenim zigom");

    expect(plan.inputShape).toBe("images-only");
    expect(plan.stages).toEqual({ pdf: false, thumbnail: true, ocr: false });
    expect(plan.ocrApplicable).toBe(false);
    expect(plan.thumbnail.resolved).toBe(true);
    expect(plan.pages).toEqual([]);
  });

  it("Pisma iz Liona (PDF + 52 pages) warns instead of silently dropping them", () => {
    const assets = [
      ...pages("Pisma iz Liona", 52, (n) => `SP_${String(n).padStart(3, "0")}.jpg`),
      ...folder("Pisma iz Liona", "SP_001 (Small).jpg", "Писма из Лиона_(310).pdf"),
    ];
    const plan = planPipeline(assets, "Pisma iz Liona");

    // The PDF still wins (docs/05 open question #4) — but audibly.
    expect(plan.inputShape).toBe("supplied-pdf");
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/52 numbered page images/);
    expect(plan.warnings[0]).toMatch(/ignored/);
  });

  it("ignores Thumbs.db when classifying", () => {
    const assets = pages("CERNAGORA", 5, (n) => `${n}.jpg`).concat(
      folder("CERNAGORA", "Thumbs.db"),
    );
    expect(classifyInput(assets)).toBe("page-images");
    expect(planPipeline(assets, "CERNAGORA").pages).toHaveLength(5);
  });
});

describe("ContentKind override", () => {
  const book = pages("bk", 5, (n) => `${n}.jpg`);
  const map = folder("mp", "veliki_zemljovid.jpg");

  it("auto-detects by default", () => {
    expect(classifyInput(book)).toBe("page-images");
    expect(classifyInput(map)).toBe("images-only");
  });

  it("`graphical` forces a detected book to be a graphical work", () => {
    expect(classifyInput(book, "graphical")).toBe("images-only");
    const plan = planPipeline(book, "bk", "graphical");
    expect(plan.stages.pdf).toBe(false);
    expect(plan.stages.ocr).toBe(false);
    expect(plan.pages).toEqual([]);
  });

  it("`book` forces unnumbered images to be pages, in natural order", () => {
    const odd = folder("odd", "b.jpg", "a.jpg", "c.jpg");
    expect(classifyInput(odd)).toBe("images-only");
    const plan = planPipeline(odd, "odd", "book");
    expect(plan.inputShape).toBe("page-images");
    expect(plan.stages.ocr).toBe(true);
    expect(plan.pages.map((p) => p.filename)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("the override does not affect folders with TIFFs or PDFs", () => {
    const tiffs = folder("t", "a.tif", "b.tif");
    expect(classifyInput(tiffs, "graphical")).toBe("tiffs");
    const pdf = folder("p", "doc.pdf");
    expect(classifyInput(pdf, "book")).toBe("supplied-pdf");
  });

  it("warns about gaps in a page run", () => {
    const gappy = folder("g", "1.jpg", "2.jpg", "4.jpg", "5.jpg");
    const plan = planPipeline(gappy, "g");
    expect(plan.inputShape).toBe("page-images");
    expect(plan.warnings.some((w) => /missing/.test(w))).toBe(true);
  });

  it("excludes a (Small) variant from the pages", () => {
    const assets = [
      ...pages("v", 4, (n) => `SP_${String(n).padStart(3, "0")}.jpg`),
      ...folder("v", "SP_001 (Small).jpg"),
    ];
    const plan = planPipeline(assets, "v");
    expect(plan.pages.map((p) => p.filename)).not.toContain("SP_001 (Small).jpg");
    expect(plan.pages).toHaveLength(4);
  });
});

describe("plan warnings for a malformed page run", () => {
  it("warns that duplicated page numbers would double the PDF", () => {
    const assets = folder("dup", "1.jpg", "1.png", "2.jpg", "2.png", "3.jpg", "3.png");
    const plan = planPipeline(assets, "dup");
    expect(plan.inputShape).toBe("page-images");
    const warning = plan.warnings.find((w) => /more than one file/.test(w));
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/1, 2, 3/);
    expect(warning).toMatch(/twice/);
  });

  it("caps a long list of missing pages in the message", () => {
    // 1..2 then 40 — 37 missing numbers must not render as a wall of digits.
    const names = ["1.jpg", "2.jpg", "40.jpg"];
    const plan = planPipeline(folder("gap", ...names), "gap");
    const warning = plan.warnings.find((w) => /missing/.test(w));
    expect(warning).toMatch(/in total/);
  });
});

describe("an empty folder is neither complete nor publishable", () => {
  it("does not report its thumbnail as resolved", () => {
    const plan = planPipeline([], "empty");
    expect(plan.inputShape).toBe("empty");
    // Reporting `resolved: true` here made processingComplete() true for a folder
    // with nothing in it — every stage pip showed done.
    expect(plan.thumbnail.resolved).toBe(false);
    expect(processingComplete(markAllSkipped([]), plan)).toBe(false);
  });
});

/** Stage map with every non-applicable stage recorded skipped, as the index does. */
function markAllSkipped(assets: DiscoveredAsset[]): ItemStages {
  const plan = planPipeline(assets, "x");
  const base = emptyStages();
  return { ...base, ...markNonApplicableSkipped(base, plan) };
}
