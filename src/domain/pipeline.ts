/**
 * Pipeline planning (Epic 06) — the pure, framework-free rules that decide, for
 * one item folder, WHAT the local pipeline must produce and WHICH stages must
 * run.
 *
 * This is the logic-lane's single source of truth for the **adaptive input
 * handling** (docs/tasks/06 §Source inputs): the branch on folder contents
 * (TIFFs / a supplied PDF / images-only / multiple PDFs) lives here, in `.ts`,
 * not duplicated in the Rust runner — exactly as `domain/files.ts` keeps asset
 * *classification* in one documented place. The native runner (Arch lane)
 * receives the resulting plan over IPC (see `ipc.jobs`) and just executes it.
 *
 * The five UI stages an item shows are `pdf · thumbnail · ocr · metadata ·
 * upload` ({@link StageName}). Only the first three are *script-run operations*
 * — `metadata` is validation (Epic 04) and `upload` is Epic 07 — so only those
 * three appear here as {@link RunnableStage}s.
 *
 * Framework-free — imports only sibling domain types.
 */

import {
  autoThumbnail,
  needsThumbnailChoice,
  thumbnailCandidates,
  webPdfAssets,
  type DiscoveredAsset,
} from "./files";
import {
  baseNameOf,
  compareNatural,
  detectPageSequence,
  isVariantFilename,
  webPdfName,
} from "./naming";
import type { ItemStages, StageName } from "./item";

/**
 * The pipeline stages a local script actually produces output for. A `satisfies`
 * check guarantees each is a real {@link StageName}; {@link RunnableStage} is
 * derived from it so the two never drift.
 */
export const RUNNABLE_STAGES = ["pdf", "thumbnail", "ocr"] as const satisfies readonly StageName[];
export type RunnableStage = (typeof RUNNABLE_STAGES)[number];

/**
 * What the folder holds, which selects the branch of the pipeline
 * (docs/tasks/06 §Source inputs). Precedence when several are present: TIFFs win
 * (build the archival master), then PDFs, then images.
 */
export type InputShape =
  /** `*.tif`/`*.tiff` source scans → build `<name>_archive.pdf` + `<name>.pdf`. */
  | "tiffs"
  /** Exactly one finished PDF, no TIFFs → skip the archival build; derive the
   * web PDF + first-page image + OCR from it. */
  | "supplied-pdf"
  /** Several PDFs, no TIFFs → process each independently, preserving each PDF's
   * own base name so its `<base>.txt` matches. */
  | "multiple-pdfs"
  /**
   * **Two or more images** with no PDF/TIFF — a book scanned page by page as
   * JPGs, or any multi-sheet item. Assemble one folder-derived web PDF from the
   * images (numbered order where the names give one, natural order otherwise)
   * and run OCR. No archival master: JPG is already lossy, so there is no
   * lossless source to preserve.
   *
   * This shape exists because the real scanner output is JPG, not TIFF
   * (docs/05-real-scan-data.md). Without it, every book fell into
   * {@link InputShape} `images-only` and silently got **no PDF and no OCR**.
   */
  | "page-images"
  /**
   * **One image** with no PDF/TIFF — a standalone graphical work: a map, a
   * poster, a postcard. The image is the web asset and no PDF is built, because
   * there is nothing to bind a single sheet into.
   *
   * It still gets OCR. A lone graphical work usually does carry text — a
   * poster's title, a map's legend — and `py/ocr.py` reads an image directly
   * (its non-PDF branch), writing `<stem>.txt` beside it. That name is what
   * pairs it back to the image in `domain/upload.textPairs`.
   */
  | "images-only"
  /** Nothing processable found. */
  | "empty";

/**
 * How to read a folder of images: let the app decide, or force it.
 *
 * Detection (a numbered page run — `domain/naming.detectPageSequence`) is right
 * for the whole real corpus, but the two outcomes fail in opposite and equally
 * bad ways: calling a book a graphical work drops its PDF and full text, while
 * calling a map a book turns it into a one-page PDF. So the operator gets an
 * explicit override (Setup tab), persisted per item on the batch
 * (`domain/batch.BatchItemOverride.contentKind`).
 */
export type ContentKind =
  /** Detect from the filenames (the default). */
  | "auto"
  /** Treat images as a book's pages, whatever their names. */
  | "book"
  /** Treat images as a standalone graphical work — no PDF, no OCR. */
  | "graphical";

/** The source TIFFs in a folder (kept local; never uploaded). */
function sourceTiffs(assets: DiscoveredAsset[]): DiscoveredAsset[] {
  return assets.filter((a) => a.kind === "source-tiff");
}

/**
 * The web PDFs that count as *input* — every one the pipeline did not write
 * itself.
 *
 * Only classification filters these out. `uploadGroups` and friends must still
 * see the derived web PDF: it is the file that actually gets uploaded.
 */
function inputPdfs(
  assets: DiscoveredAsset[],
  context: ClassifyContext,
): DiscoveredAsset[] {
  const pdfs = webPdfAssets(assets);
  if (!context.webPdfIsOurs || !context.folderName) return pdfs;
  const ours = webPdfName(context.folderName).toLowerCase();
  return pdfs.filter((a) => a.filename.toLowerCase() !== ours);
}

/**
 * What the index already knows about an item, for {@link classifyInput}.
 *
 * Optional, and omitting it reproduces the old behaviour exactly — so a caller
 * that genuinely has no item yet (a first scan) is unaffected.
 */
export interface ClassifyContext {
  /**
   * The item's derived-output naming base, i.e. its folder name.
   */
  folderName?: string;
  /**
   * True when the index records that **we** built this item's web PDF — the
   * `pdf` stage having completed for it before.
   *
   * Without this, an item is re-classified from its own output: the pipeline
   * writes `<folderName>.pdf`, and every later scan then sees a folder with a
   * PDF in it and calls it a supplied-PDF item. A 391-page book whose scans
   * are sitting right there gets its OCR run against the pipeline's own
   * 1600px downscale instead, and the `--pages` fast path — built precisely to
   * read the originals — can never fire again.
   *
   * Deliberately taken from recorded state rather than inferred from the
   * filename: a supplied PDF that happens to be named after its folder must
   * not be mistaken for ours and silently rebuilt from the page images.
   */
  webPdfIsOurs?: boolean;
}

/**
 * Classify a folder's discovered assets into an {@link InputShape}. Keys off the
 * presence of TIFFs, then web PDFs (count), then images — see the type's doc for
 * the precedence and the reason for each branch.
 *
 * Files the pipeline itself produced are **not** input: see
 * {@link ClassifyContext.webPdfIsOurs}.
 */
export function classifyInput(
  assets: DiscoveredAsset[],
  kind: ContentKind = "auto",
  context: ClassifyContext = {},
): InputShape {
  const tiffs = sourceTiffs(assets);
  const allPdfs = webPdfAssets(assets);
  const pdfs = inputPdfs(assets, context);
  const images = thumbnailCandidates(assets);
  if (tiffs.length > 0) return "tiffs";
  // A filed original outranks everything below: the item was already decided
  // to be a supplied-PDF one, and the pristine PDF it derives from is still
  // on disk under `source/`. Re-deciding it from the page images beside it
  // would rebuild the web PDF out of a downscale of itself.
  if (assets.some((a) => a.kind === "source-pdf")) return "supplied-pdf";
  if (pdfs.length > 1) return "multiple-pdfs";
  if (pdfs.length === 1) return "supplied-pdf";
  // Discounting our own output must never make an item look *empty*. A folder
  // whose web PDF is the only thing in it is a real, complete item — an
  // already-processed supplied-pdf whose original was filed away, say — and
  // calling it empty marks every finished stage inapplicable and reports the
  // item as unprocessed. Discounting is only safe while something else is
  // left to classify from.
  if (images.length === 0) return allPdfs.length > 0 ? "supplied-pdf" : "empty";

  // Images only, so the question is just how many sheets there are.
  //
  // One image is a standalone work — a map, a poster, a postcard — and there
  // is no PDF to build out of a single sheet. Two or more are bound into one
  // PDF, whether or not their names happen to form a numbered run: an
  // unnumbered pair is still two sheets of one item. Either way they get OCR.
  if (kind === "book") return "page-images";
  if (kind === "graphical") return "images-only";
  return sourceImages(assets).length <= 1 ? "images-only" : "page-images";
}

/** The page images of a folder, **in page order** (natural sort). Empty unless
 * the folder is a {@link InputShape} `page-images` run. */
export function pageImages(
  assets: DiscoveredAsset[],
  kind: ContentKind = "auto",
  context: ClassifyContext = {},
): DiscoveredAsset[] {
  if (classifyInput(assets, kind, context) !== "page-images") return [];
  const images = sourceImages(assets);
  const sequence = detectPageSequence(images.map((a) => a.filename));
  if (sequence.isSequence) {
    // Detection already ordered the run numerically; map back to the assets.
    const byName = new Map(images.map((a) => [a.filename, a]));
    return sequence.filenames
      .map((f) => byName.get(f))
      .filter((a): a is DiscoveredAsset => Boolean(a));
  }
  // Unnumbered names (an unnumbered multi-sheet item, or a forced `book`) —
  // fall back to natural order.
  return [...images].sort((a, b) => compareNatural(a.filename, b.filename));
}

/** Which of the three runnable stages apply to an input shape. Stages that do
 * **not** apply are N/A for the item and should be recorded `skipped` (e.g. OCR
 * on an images-only folder). */
/** Which stages a shape can run at all. */
export function applicableStages(
  shape: InputShape,
): Record<RunnableStage, boolean> {
  switch (shape) {
    case "tiffs":
    case "supplied-pdf":
    case "multiple-pdfs":
    case "page-images":
      // The `pdf` stage covers "archival + web" for TIFFs, "web only" for a
      // supplied PDF or a page run; the input shape carries that nuance for the
      // runner.
      return { pdf: true, thumbnail: true, ocr: true };
    case "images-only":
      return { pdf: false, thumbnail: true, ocr: true };
    case "empty":
      return { pdf: false, thumbnail: false, ocr: false };
  }
}

/** Whether the pipeline builds an archival master (`<name>_archive.pdf`) — only
 * from source TIFFs; a supplied PDF is already finished. */
export function buildsArchival(shape: InputShape): boolean {
  return shape === "tiffs";
}

/**
 * How the item's thumbnail (`<name>_thumb.png`) source resolves
 * (docs/tasks/06 §Thumbnail source selection).
 *
 * Candidates are the standalone images already in the folder **or**, when the
 * folder ships no standalone image, the first-page image(s) processing will
 * generate (one per source PDF). Present images take precedence — so the common
 * "PDF + one image" case is a single candidate (auto), while several PDFs (each
 * yielding a first-page image) or several images need an operator pick.
 */
export interface ThumbnailPlan {
  /** Raster images already present in the folder (standalone + any pre-tagged
   * `*_thumb`/`thumbnail`). */
  present: DiscoveredAsset[];
  /** First-page images processing will GENERATE — counted as candidates only
   * when no standalone image is present. */
  generatedCount: number;
  /** Total number of candidates the operator would choose among. */
  candidateCount: number;
  /** The auto-selected primary when it is a concrete, already-present image
   * (a lone or pre-tagged image); null when the pick is deferred to a generated
   * file or an operator choice (see {@link ThumbnailPlan.resolved}). */
  autoPrimary: DiscoveredAsset | null;
  /** True when there are ≥2 candidates and no unambiguous auto-pick — the item
   * is "choose thumbnail" and the Thumbnail stage must not reach `done`. */
  needsChoice: boolean;
  /** Whether the thumbnail source is settled without operator input — either an
   * auto-primary image or a single generated first-page image. `!needsChoice`. */
  resolved: boolean;
}

/** The number of first-page images the pipeline generates for a shape (one per
 * source PDF; a TIFF build yields a single web PDF → one). */
function generatedFirstPageCount(assets: DiscoveredAsset[], shape: InputShape): number {
  switch (shape) {
    case "tiffs":
    case "supplied-pdf":
      return 1;
    case "multiple-pdfs":
      return webPdfAssets(assets).length;
    case "page-images":
      // Handled before this is reached: a page run's thumbnail is its first
      // page, an image already on disk, so nothing is generated.
      return 0;
    case "images-only":
    case "empty":
      return 0;
  }
}

/** Resolve the {@link ThumbnailPlan} for a folder. */
/**
 * The folder's **source** images — the scans themselves.
 *
 * Deliberately not {@link thumbnailCandidates}, which also returns
 * `kind: "thumbnail"`: that includes the `<name>_thumb.png` this app
 * *generates*. Counting a derived output as a source scan made a processed
 * one-image folder look like a two-image one, and picking one as the OCR
 * input would have read the downscaled thumbnail instead of the full scan.
 */
export function sourceImages(assets: DiscoveredAsset[]): DiscoveredAsset[] {
  return assets.filter(
    (a) => a.kind === "image" && !isVariantFilename(a.filename),
  );
}

export function planThumbnail(
  assets: DiscoveredAsset[],
  shape: InputShape,
  kind: ContentKind = "auto",
): ThumbnailPlan {
  const present = thumbnailCandidates(assets);

  // A book's thumbnail is its FIRST PAGE — there is nothing to choose. Without
  // this, a 260-page scan reported 260 equal candidates and blocked the item on
  // an operator "choice" that has exactly one sensible answer.
  //
  // Unless something already picked one. A tagged image — one the operator
  // named `thumbnail`, or the `<name>_thumb.png` a previous run generated — is
  // a deliberate choice and outranks page one, which is only ever a fallback.
  // The cover is usually the better catalogue image anyway
  // (docs/tasks/cover-shots-and-thumbnail-choice.md).
  if (shape === "page-images") {
    const pages = pageImages(assets, kind);
    const first = autoThumbnail(assets) ?? pages[0] ?? null;
    return {
      present: pages,
      generatedCount: 0,
      candidateCount: pages.length,
      autoPrimary: first,
      needsChoice: false,
      resolved: first !== null,
    };
  }

  if (present.length > 0) {
    // Present images are the candidate pool; the PDF's first page is a fallback
    // used only when the folder ships no standalone image.
    const needsChoice = needsThumbnailChoice(assets);
    return {
      present,
      generatedCount: 0,
      candidateCount: present.length,
      autoPrimary: autoThumbnail(assets),
      needsChoice,
      resolved: !needsChoice,
    };
  }

  // No standalone image → the generated first-page image(s) are the pool. A lone
  // generated image auto-selects (no concrete asset exists yet, so autoPrimary
  // stays null but the item is still resolved); several PDFs → operator picks.
  const generatedCount = generatedFirstPageCount(assets, shape);
  const needsChoice = generatedCount >= 2;
  return {
    present: [],
    generatedCount,
    candidateCount: generatedCount,
    autoPrimary: null,
    needsChoice,
    // An `empty` folder has no thumbnail and never will, which is NOT the same as
    // "settled". Reporting it resolved made `processingComplete` true for a folder
    // with nothing in it, so an empty item showed every stage done.
    resolved: shape === "empty" ? false : !needsChoice,
  };
}

/**
 * An asset the pipeline yields that becomes an upload candidate. Each keeps its
 * own **base name** so its OCR text (`<base>.txt`) matches by base name — the
 * multiple-PDFs invariant (docs/tasks/06).
 */
export interface UploadCandidate {
  /** The output filename in the folder. */
  name: string;
  /** Base name without extension — the OCR-text match key. */
  base: string;
  kind: "web-pdf" | "image";
}

/**
 * The upload candidates the pipeline produces. A single supplied PDF and a TIFF
 * build are **folder-derived** (`<folderName>.pdf`); multiple discovered PDFs
 * each keep their own base name; an images-only folder yields its images.
 * (Standalone images inside a PDF folder are handled at upload — Epic 07's
 * `uploadRoleFor` — not here, which keeps this focused on the PDF/OCR pairing.)
 */
export function uploadCandidates(
  assets: DiscoveredAsset[],
  folderName: string,
  shape: InputShape,
): UploadCandidate[] {
  switch (shape) {
    case "tiffs":
    case "supplied-pdf":
    case "page-images":
      // One folder-derived web PDF. For `page-images` the pages are assembled
      // into it, so the individual JPGs are inputs, not upload candidates.
      return [{ name: webPdfName(folderName), base: folderName, kind: "web-pdf" }];
    case "multiple-pdfs":
      return webPdfAssets(assets).map((a) => ({
        name: a.filename,
        base: baseNameOf(a.filename),
        kind: "web-pdf",
      }));
    case "images-only":
      return thumbnailCandidates(assets).map((a) => ({
        name: a.filename,
        base: baseNameOf(a.filename),
        kind: "image",
      }));
    case "empty":
      return [];
  }
}

/** The full plan for one item folder: the branch, the applicable stages, the
 * upload candidates, and the thumbnail resolution. */
export interface PipelinePlan {
  inputShape: InputShape;
  /** Which of the three runnable stages apply. Stages not here are N/A → record
   * them `skipped` in the item's stage map. */
  stages: Record<RunnableStage, boolean>;
  /** Convenience mirror of `stages.ocr`. */
  ocrApplicable: boolean;
  /** Whether an archival master is built (TIFFs only). */
  buildsArchival: boolean;
  candidates: UploadCandidate[];
  thumbnail: ThumbnailPlan;
  /** The folder's page images in page order — empty unless `page-images`. */
  pages: DiscoveredAsset[];
  /**
   * Non-fatal things the operator should know about this folder, e.g. page
   * images that the chosen shape ignores. Surfaced rather than swallowed:
   * silently dropping 52 scans is how `Pisma iz Liona` went wrong
   * (docs/05-real-scan-data.md).
   */
  warnings: string[];
}

/** Render a number list for an operator message, capped so a 200-gap run does
 * not produce an unreadable warning. */
function summarizeNumbers(numbers: number[], cap = 10): string {
  const head = numbers.slice(0, cap).join(", ");
  return numbers.length > cap ? `${head}… (${numbers.length} in total)` : head;
}

/** Build the {@link PipelinePlan} for one item folder. `folderName` is the
 * derived-output naming base (the folder's own name — docs/tasks/10 §Naming);
 * `kind` is the operator's content override (default: detect). */
export function planPipeline(
  assets: DiscoveredAsset[],
  folderName: string,
  kind: ContentKind = "auto",
  webPdfIsOurs = false,
): PipelinePlan {
  const context: ClassifyContext = { folderName, webPdfIsOurs };
  const inputShape = classifyInput(assets, kind, context);
  const stages = applicableStages(inputShape);
  const pages = pageImages(assets, kind, context);
  const warnings: string[] = [];

  // A folder holding BOTH a PDF and a numbered page run is ambiguous — is the
  // PDF a source or an already-built output? Only genuinely ambiguous for a
  // PDF we did *not* write: once the index records the `pdf` stage as ours,
  // `classifyInput` stops counting it as input (docs/05 open question #4 —
  // resolved for the re-run case, still open for the first run, which is what
  // this warning is for).
  if (inputShape === "supplied-pdf" || inputShape === "multiple-pdfs") {
    const images = thumbnailCandidates(assets).filter(
      (a) => !isVariantFilename(a.filename),
    );
    const sequence = detectPageSequence(images.map((a) => a.filename));
    if (sequence.isSequence) {
      warnings.push(
        `Folder holds a PDF and ${sequence.filenames.length} numbered page images; ` +
          `the PDF is being used and the page images ignored.`,
      );
    }
  }

  const sequence = detectPageSequence(
    thumbnailCandidates(assets).map((a) => a.filename),
  );
  if (inputShape === "page-images") {
    if (sequence.missing.length > 0) {
      warnings.push(
        `Page numbers ${summarizeNumbers(sequence.missing)} are missing from the run.`,
      );
    }
    // Two files claiming one page number (`1.jpg` + `1.png`, or `1` + `01`) would
    // put every affected page into the PDF twice. Which copy to keep is a content
    // decision, so flag it rather than picking one.
    if (sequence.duplicates.length > 0) {
      warnings.push(
        `Page numbers ${summarizeNumbers(sequence.duplicates)} are claimed by more ` +
          `than one file — the PDF would contain them twice. Remove the duplicates ` +
          `(e.g. two formats of the same page) before processing.`,
      );
    }
  }

  return {
    inputShape,
    stages,
    ocrApplicable: stages.ocr,
    buildsArchival: buildsArchival(inputShape),
    candidates: uploadCandidates(assets, folderName, inputShape),
    thumbnail: planThumbnail(assets, inputShape, kind),
    pages,
    warnings,
  };
}

/** Options selecting which stages a run should (re)execute. */
export interface RunSelection {
  /** Re-run even stages already `done` (explicit re-process / forced rerun). */
  force?: boolean;
  /** Restrict to these stages (e.g. only the failed ones, or a re-process pick).
   * Always intersected with the item's *applicable* stages. */
  only?: RunnableStage[] | null;
}

/**
 * **Skip-if-done**: the runnable stages that actually need to execute for an
 * item, given its recorded stage statuses and a {@link RunSelection}. Applicable
 * stages already `done` are skipped unless `force`; non-applicable stages are
 * never returned. This is what a batch run enqueues per item.
 */
export function stagesToRun(
  stages: ItemStages,
  plan: PipelinePlan,
  sel: RunSelection = {},
): RunnableStage[] {
  const applicable = RUNNABLE_STAGES.filter((s) => plan.stages[s]);
  const restricted = sel.only
    ? applicable.filter((s) => sel.only!.includes(s))
    : applicable;
  return restricted.filter((s) => sel.force || stages[s].status !== "done");
}

/** The item's applicable runnable stages that are currently `failed` — the set a
 * per-item "Rerun" re-executes. */
export function failedRunnableStages(
  stages: ItemStages,
  plan: PipelinePlan,
): RunnableStage[] {
  return RUNNABLE_STAGES.filter(
    (s) => plan.stages[s] && stages[s].status === "failed",
  );
}

/**
 * Whether the item's **processing** is complete: every applicable runnable stage
 * is `done` and the thumbnail source is resolved (no pending operator choice).
 * Does not consider `metadata`/`upload` — the batch's move to `ready` combines
 * this with metadata validity in the run store / Epic 04.
 */
export function processingComplete(
  stages: ItemStages,
  plan: PipelinePlan,
): boolean {
  const applicableDone = RUNNABLE_STAGES.every(
    (s) => !plan.stages[s] || stages[s].status === "done",
  );
  return applicableDone && plan.thumbnail.resolved;
}

/**
 * The stage-map patch that records which stages are N/A for an item as
 * `skipped`. The native index owns the authoritative statuses; the logic lane
 * uses this to reflect "OCR N/A" etc. in a derived view without a round-trip.
 * Only downgrades untouched (`pending`) non-applicable stages — never rewrites a
 * real outcome.
 */
export function markNonApplicableSkipped(
  stages: ItemStages,
  plan: PipelinePlan,
): ItemStages {
  const next: ItemStages = { ...stages };
  for (const s of RUNNABLE_STAGES) {
    if (!plan.stages[s] && next[s].status === "pending") {
      next[s] = { ...next[s], status: "skipped" };
    }
  }
  return next;
}

/**
 * Whether (re)running a stage dirties a published item → **Needs re-upload**.
 *
 * True for every derived output (PDF, thumbnail, OCR), **never** for
 * `metadata`: regenerating a derived asset on an already-uploaded item sets
 * the "derived-changed-since-upload" flag (docs/tasks/06; Epics 02/07), while
 * metadata edits write through by `PATCH` and never dirty the assets.
 */
export function dirtiesUpload(stage: StageName): boolean {
  return (RUNNABLE_STAGES as readonly StageName[]).includes(stage);
}
