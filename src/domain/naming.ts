/**
 * Folder-derived naming convention (Epic 10 §Data / docs/01 §Naming) — the
 * single source of truth for how output filenames are built and parsed.
 *
 * The rule: **the scan folder's own name is the base name** for the item's
 * derived outputs. A folder `njegos_gorski_vijenac` yields
 * `njegos_gorski_vijenac.pdf`, `…_archive.pdf`, `…_thumb.png`, `….txt`,
 * `….json`. We build on the assumption folder names are correct and unique at
 * scan time (**for now**) — there is no prefix/base-identifier picker and no
 * backend naming step (docs/03 decisions).
 *
 * Two rules qualify it:
 *
 *  - **Multi-page numbering** — items with several pages append a running,
 *    **unpadded** page number after an underscore (`…_1.pdf` … `…_10.pdf`).
 *  - **The multi-asset exception** — when a folder holds *several* PDFs or
 *    images, those *discovered* files keep their **own** filenames. That is what
 *    pairs a PDF with its full text (`foo.pdf` ↔ `foo.txt`); only the
 *    single-item derived outputs use the folder name.
 *
 * This module exists because the convention was previously implicit in three
 * places: the `_archive`/`_thumb` literals in `domain/files.ts` (classification)
 * and the `${folderName}.pdf` literal in `domain/pipeline.ts` (candidates). Both
 * now build on the helpers here, so the convention is stated once — and the
 * Settings → Data reference screen renders from the same rules the pipeline
 * obeys rather than a hand-written copy that can drift.
 *
 * Framework-free — imports nothing.
 */

// ─── the convention's literals ───────────────────────────────────────────────
// Named so a change lands in one place. The Arch lane's Python scripts write
// these same names (docs/tasks/06 §operations); keep them in sync.

/** Suffix marking the archival master, appended to the base name. */
export const ARCHIVAL_SUFFIX = "_archive";
/** Suffix marking the item's thumbnail. */
export const THUMBNAIL_SUFFIX = "_thumb";
/** Separator between a base name and a multi-page page number. */
export const PAGE_SEPARATOR = "_";

export const PDF_EXT = "pdf";
/** Thumbnails are always normalised to PNG (docs/tasks/06 §Thumbnail). */
export const THUMBNAIL_EXT = "png";
export const OCR_TEXT_EXT = "txt";
export const METADATA_EXT = "json";

/** The fixed name of the per-folder metadata mirror the archive reads/writes. */
export const METADATA_MIRROR_FILENAME = `metadata.${METADATA_EXT}`;

// ─── name parsing primitives ─────────────────────────────────────────────────

/** Lowercased file extension without the dot (`""` when there is none). */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/** File name without its extension (the "base name"). */
export function baseNameOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot <= 0 ? filename : filename.slice(0, dot);
}

/** Whether a *base* name (extension already stripped) marks an archival master. */
export function hasArchivalSuffix(base: string): boolean {
  return base.toLowerCase().endsWith(ARCHIVAL_SUFFIX);
}

/** Whether a *base* name marks a thumbnail. */
export function hasThumbnailSuffix(base: string): boolean {
  return base.toLowerCase().endsWith(THUMBNAIL_SUFFIX);
}

// ─── derived output names (single-item, folder-derived) ──────────────────────

/** `<base>.pdf` — the web-preview PDF, uploaded with `role=WEB`. */
export function webPdfName(base: string): string {
  return `${base}.${PDF_EXT}`;
}

/** `<base>_archive.pdf` — the archival master. Kept local, never uploaded. */
export function archivalPdfName(base: string): string {
  return `${base}${ARCHIVAL_SUFFIX}.${PDF_EXT}`;
}

/** `<base>_thumb.png` — the normalised thumbnail, uploaded as `role=THUMBNAIL`. */
export function thumbnailName(base: string): string {
  return `${base}${THUMBNAIL_SUFFIX}.${THUMBNAIL_EXT}`;
}

/** `<base>.txt` — the OCR full text, pushed via the `extractedTexts` map. */
export function ocrTextName(base: string): string {
  return `${base}.${OCR_TEXT_EXT}`;
}

/** `<base>.json` — the local metadata mirror for a single-item folder. */
export function metadataName(base: string): string {
  return `${base}.${METADATA_EXT}`;
}

/** The kinds of derived output a single-item folder produces. */
export type DerivedOutput =
  | "web-pdf"
  | "archival-pdf"
  | "thumbnail"
  | "ocr-text"
  | "metadata";

/** Display order for the Data tab reference + preview. */
export const DERIVED_OUTPUT_ORDER: readonly DerivedOutput[] = [
  "web-pdf",
  "archival-pdf",
  "thumbnail",
  "ocr-text",
  "metadata",
];

/**
 * Every folder-derived output name for a base name. Callers that only build a
 * subset (an images-only folder produces no PDF; only a TIFF build produces an
 * archival master — `domain/pipeline.buildsArchival`) pick from this map; it
 * describes the *convention*, not which stages actually run.
 */
export function derivedOutputNames(base: string): Record<DerivedOutput, string> {
  return {
    "web-pdf": webPdfName(base),
    "archival-pdf": archivalPdfName(base),
    thumbnail: thumbnailName(base),
    "ocr-text": ocrTextName(base),
    metadata: metadataName(base),
  };
}

// ─── multi-page numbering ────────────────────────────────────────────────────

/**
 * `<base>_<n>.<ext>` — a multi-page item's page name. The number is **unpadded**
 * and 1-based, so page 10 is `…_10.pdf`, not `…_010.pdf`.
 *
 * @throws RangeError when `page` is not a positive integer — a padded or
 *   zero-based number would silently break the `foo.pdf` ↔ `foo.txt` pairing.
 */
export function pageName(base: string, page: number, ext: string): string {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError(
      `Page number must be a positive integer, got ${page}.`,
    );
  }
  return `${base}${PAGE_SEPARATOR}${page}.${ext}`;
}

/** The page names for a `count`-page item, in order (`…_1` … `…_count`). */
export function pageNames(base: string, count: number, ext: string): string[] {
  const names: string[] = [];
  for (let page = 1; page <= count; page += 1) {
    names.push(pageName(base, page, ext));
  }
  return names;
}

/**
 * The page number encoded in a name, or `null` when it carries none. Only an
 * unpadded positive integer counts, so `foo_01.pdf` and `foo_archive.pdf` both
 * read as "not a page".
 */
export function pageNumberOf(filename: string): number | null {
  const base = baseNameOf(filename);
  const sep = base.lastIndexOf(PAGE_SEPARATOR);
  if (sep <= 0 || sep === base.length - 1) return null;
  const tail = base.slice(sep + PAGE_SEPARATOR.length);
  if (!/^[1-9][0-9]*$/.test(tail)) return null;
  return Number(tail);
}

// ─── the multi-asset exception (discovered files keep their own names) ───────

/**
 * The OCR-text filename that pairs with a discovered asset — **its own** base
 * name, not the folder's. This is the multi-asset exception: `foo.pdf` pairs with
 * `foo.txt`, which is how a PDF's full text is matched to it when a folder holds
 * several PDFs (docs/01 §Naming).
 */
export function ocrTextNameFor(assetFilename: string): string {
  return ocrTextName(baseNameOf(assetFilename));
}

/** Whether an OCR-text file is the full text *of* a given asset (same base). */
export function isOcrTextFor(textFilename: string, assetFilename: string): boolean {
  return (
    extensionOf(textFilename) === OCR_TEXT_EXT &&
    baseNameOf(textFilename) === baseNameOf(assetFilename)
  );
}

// ─── INCOMING scanner filenames ──────────────────────────────────────────────
// Everything above describes names *we* generate. This section reads the names
// the *scanner* produced, which follow their own conventions — measured against
// the real corpus in docs/05-real-scan-data.md:
//
//   CERNAGORA              1.jpg … 260.jpg        unpadded
//   ОКТОИХ петогласник 2   000.jpg … 161.jpg      zero-padded, 3 digits
//   Pisma iz Liona         SP_001.jpg … SP_052.jpg  prefixed + padded
//
// None of them match our `<base>_<n>` output rule, so {@link pageNumberOf} will
// not parse any of them — hence a separate parser.

/** Minimum run length before a set of images is called a page sequence. Three
 * is enough to distinguish "a numbered run" from a couple of loose images. */
const MIN_PAGE_SEQUENCE = 3;

/**
 * Compare two filenames treating digit runs as **numbers**, so `2.jpg` sorts
 * before `10.jpg`.
 *
 * Plain lexicographic order gives `1, 10, 100, 2, …` — which silently shuffles a
 * 260-page book. Any code that assembles pages in order must sort with this.
 */
export function compareNatural(a: string, b: string): number {
  const split = (s: string) => s.split(/(\d+)/);
  const left = split(a);
  const right = split(b);
  const len = Math.min(left.length, right.length);

  for (let i = 0; i < len; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === r) continue;
    // Odd indices are the digit runs produced by the capturing split.
    const bothNumeric = i % 2 === 1;
    if (bothNumeric) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff;
      continue; // same value, different padding — fall through to the next part
    }
    return l < r ? -1 : 1;
  }
  return left.length - right.length;
}

/** Sort filenames in natural order (non-mutating). */
export function sortNatural(filenames: string[]): string[] {
  return [...filenames].sort(compareNatural);
}

/** One incoming filename decomposed around its trailing number. */
export interface ScanPageName {
  /** Everything before the number (`""`, `"SP_"`, …). */
  prefix: string;
  /** Everything after the number, before the extension (usually `""`). */
  suffix: string;
  number: number;
  /** Digit count as written, so `000` reports 3 (padding is preserved). */
  digits: number;
}

/**
 * Parse an incoming scan filename as `<prefix><number><suffix>.<ext>`, or return
 * `null` when it carries no trailing number.
 *
 * Unlike {@link pageNumberOf} (which reads *our* output convention and rejects
 * padding), this accepts padded and prefixed numbers, because that is what the
 * scanner actually produces.
 */
export function parseScanPageName(filename: string): ScanPageName | null {
  const stem = baseNameOf(filename);
  const match = /^(.*?)(\d+)(\D*)$/.exec(stem);
  if (!match) return null;
  return {
    prefix: match[1],
    suffix: match[3],
    number: Number(match[2]),
    digits: match[2].length,
  };
}

/**
 * A derived preview sitting beside its original — `SP_001 (Small).jpg` (293×480)
 * next to `SP_001.jpg` (4841×7941). Such a file is neither a page nor a
 * first-class thumbnail candidate, so it is excluded from both.
 */
export function isVariantFilename(filename: string): boolean {
  return /\((?:small|medium|large|copy|preview|thumb)\)\s*$/i.test(
    baseNameOf(filename),
  );
}

/** The outcome of looking for a numbered page run among a folder's images. */
export interface PageSequence {
  /** Whether a run long enough to be a book's pages was found. */
  isSequence: boolean;
  /** The run's filenames, in page order. */
  filenames: string[];
  /** Shared prefix of the run (`""` for `1.jpg`, `"SP_"` for `SP_001.jpg`). */
  prefix: string;
  /** True when the run is zero-padded to a fixed width. */
  padded: boolean;
  /** Numbers present in the run, ascending. May repeat — see {@link duplicates}. */
  numbers: number[];
  /** Numbers missing between the first and last (a gap may be a skipped scan). */
  missing: number[];
  /**
   * Numbers claimed by **more than one file**, ascending and de-duplicated.
   *
   * Reachable in two ordinary ways: a folder holding two formats per page
   * (`1.jpg` **and** `1.png`), or mixed padding (`1.jpg` and `01.jpg`). Both parse
   * to the same page number, so without this the run silently contains every page
   * twice and the assembled PDF duplicates all of it. Which copy to keep is a
   * content decision (a PNG may be the better scan), so this reports the clash
   * rather than guessing.
   */
  duplicates: number[];
}

const EMPTY_SEQUENCE: PageSequence = {
  isSequence: false,
  filenames: [],
  prefix: "",
  padded: false,
  numbers: [],
  missing: [],
  duplicates: [],
};

/**
 * Detect whether a folder's image filenames form a **numbered page run**.
 *
 * This is what separates "a book scanned page by page" from "a standalone
 * graphical work" — the distinction the pipeline cannot make from file
 * extensions alone, and the one it previously got wrong for 3 of the 4 real
 * folders (docs/05-real-scan-data.md). Verified against the real corpus: all
 * three books produce a run; the single descriptively-named map does not.
 *
 * Files are grouped by `prefix`+`suffix`, and the largest group wins, so a
 * stray `cover.jpg` beside `001…160.jpg` does not defeat detection.
 */
export function detectPageSequence(filenames: string[]): PageSequence {
  const groups = new Map<string, Array<{ filename: string; parsed: ScanPageName }>>();

  for (const filename of filenames) {
    if (isVariantFilename(filename)) continue;
    const parsed = parseScanPageName(filename);
    if (!parsed) continue;
    const key = `${parsed.prefix} ${parsed.suffix}`;
    const group = groups.get(key);
    if (group) group.push({ filename, parsed });
    else groups.set(key, [{ filename, parsed }]);
  }

  let best: Array<{ filename: string; parsed: ScanPageName }> | null = null;
  for (const group of groups.values()) {
    if (!best || group.length > best.length) best = group;
  }
  if (!best || best.length < MIN_PAGE_SEQUENCE) return EMPTY_SEQUENCE;

  const sorted = [...best].sort((a, b) => a.parsed.number - b.parsed.number);
  const numbers = sorted.map((e) => e.parsed.number);
  const first = numbers[0];
  const last = numbers[numbers.length - 1];

  const seen = new Set<number>();
  const duplicated = new Set<number>();
  for (const n of numbers) {
    if (seen.has(n)) duplicated.add(n);
    else seen.add(n);
  }
  const missing: number[] = [];
  for (let n = first; n <= last; n += 1) {
    if (!seen.has(n)) missing.push(n);
  }

  const widths = new Set(sorted.map((e) => e.parsed.digits));
  // Zero-padded when every name is the same width AND the smallest number was
  // widened to reach it (`000…161` → yes; `1…260` → widths differ → no).
  const padded =
    widths.size === 1 && String(first).length < sorted[0].parsed.digits;

  return {
    isSequence: true,
    filenames: sorted.map((e) => e.filename),
    prefix: sorted[0].parsed.prefix,
    padded,
    numbers,
    missing,
    duplicates: [...duplicated].sort((a, b) => a - b),
  };
}

// ─── filenames as the BACKEND stores them ────────────────────────────────────
// Everything above is about names on disk. This section is about getting a name
// back out of the backend, which does not return what it was sent.
//
// `POST /api/files/upload/:itemId` (and `PUT /api/files/:fileId`) parse the
// multipart `Content-Disposition` filename as **Latin-1** when it is really
// UTF-8, so `ОКТОИХ петогласник 2.pdf` is stored as
// `ÐÐÐ¢ÐÐÐ¥ Ð¿ÐµÑÐ¾Ð³Ð»Ð°ÑÐ½Ð¸Ðº 2.pdf`
// (live-verified 2026-08-08; `nbcg/todo/backend-multipart-filename-not-utf8.md`).
//
// This is not cosmetic. `services/upload.pushReplaceAssets` decides
// "replace this attachment" vs "upload a new one" by matching the local filename
// against the stored one — so on Cyrillic material every re-upload MISSED and
// **added a duplicate attachment** instead of replacing in place. Verified live:
// two attachments after one re-upload.
//
// Two mangled shapes are handled, because which one occurs depends on the HTTP
// stack that built the multipart body:
//   - **mojibake** (undici / Tauri `plugin-http`): UTF-8 bytes read as Latin-1.
//     Losslessly reversible, so it is decoded and compared exactly.
//   - **lossy `?`**: every non-ASCII character replaced by `?` (the shape
//     recorded in the 2026-08-07 notes). Not reversible, so it is matched
//     structurally instead.

/**
 * Reverse the backend's UTF-8-read-as-Latin-1 mangling, or `null` when `stored`
 * is not recoverable mojibake.
 *
 * A pure-ASCII name decodes to itself, which is harmless — callers try an exact
 * match first. The rare false positive is a name genuinely containing Latin-1
 * sequences that also form valid UTF-8 (`Ã©.pdf` → `é.pdf`); accepting it is
 * still better than the duplicate-attachment bug it prevents, and the exact
 * match takes precedence.
 */
export function decodeMojibakeFilename(stored: string): string | null {
  const bytes = new Uint8Array(stored.length);
  for (let i = 0; i < stored.length; i += 1) {
    const code = stored.charCodeAt(i);
    if (code > 0xff) return null; // not a Latin-1 byte string — nothing to undo
    bytes[i] = code;
  }
  try {
    // `fatal` matters: without it invalid sequences become U+FFFD and every
    // name would "decode", producing false matches.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Whether `stored` is `local` with every non-ASCII character replaced by `?`.
 *
 * Deliberately strict — same length, identical ASCII positions, and a `?` in
 * `stored` exactly where `local` is non-ASCII — so it cannot match two different
 * files that merely share a shape.
 */
export function matchesLossyFilename(stored: string, local: string): boolean {
  if (stored.length !== local.length) return false;
  let sawReplacement = false;
  for (let i = 0; i < local.length; i += 1) {
    const localChar = local[i];
    const storedChar = stored[i];
    if (localChar.charCodeAt(0) < 0x80) {
      if (storedChar !== localChar) return false;
    } else {
      if (storedChar !== "?") return false;
      sawReplacement = true;
    }
  }
  // An all-ASCII name is handled by the exact match; requiring at least one
  // replacement keeps this from claiming equality it did not establish.
  return sawReplacement;
}

/**
 * Whether a filename the backend reports refers to the local file `local` —
 * tolerating the mangling described above.
 *
 * Use this instead of `===` for **any** comparison between a local filename and
 * one that came back from the backend.
 */
export function isSameUploadedFilename(stored: string, local: string): boolean {
  if (stored === local) return true;
  if (decodeMojibakeFilename(stored) === local) return true;
  return matchesLossyFilename(stored, local);
}

/** Whether the backend stored `local` under a corrupted name (worth warning the
 * operator about, since only the backend can repair the stored value). */
export function isMangledFilename(stored: string, local: string): boolean {
  return stored !== local && isSameUploadedFilename(stored, local);
}

// ─── Settings → Data live preview ────────────────────────────────────────────

/** The folder name the Data tab's reference example uses (docs/tasks/10). */
export const SAMPLE_FOLDER_NAME = "njegos_gorski_vijenac";

/** How many pages the preview illustrates the numbering rule with. */
const PREVIEW_PAGE_COUNT = 3;

/** One row of the preview: a derived output and the filename it gets. */
export interface NamingPreviewRow {
  output: DerivedOutput;
  filename: string;
}

/** One row of the multi-asset example: a discovered file and its paired text. */
export interface MultiAssetPreviewRow {
  /** The discovered file, which keeps its **own** name. */
  source: string;
  /** Its full text, matched by base name. */
  text: string;
}

/**
 * Everything the read-only Data tab renders, derived from a folder name. The
 * screen is pure presentation over this — it must not restate the convention in
 * markup, or the reference and the pipeline can drift.
 */
export interface NamingPreview {
  folderName: string;
  /** The single-item derived outputs, in {@link DERIVED_OUTPUT_ORDER}. */
  derived: NamingPreviewRow[];
  /** The multi-page numbering rule, illustrated on the web PDF. */
  pages: string[];
  /** The multi-asset exception, illustrated with two discovered PDFs. */
  multiAsset: MultiAssetPreviewRow[];
}

/**
 * Build the {@link NamingPreview} for a folder name. Blank/whitespace-only input
 * falls back to {@link SAMPLE_FOLDER_NAME} so the preview is never empty or
 * showing bare extensions while the operator is mid-edit.
 */
export function buildNamingPreview(folderName?: string | null): NamingPreview {
  const base = folderName?.trim() ? folderName.trim() : SAMPLE_FOLDER_NAME;
  const names = derivedOutputNames(base);
  return {
    folderName: base,
    derived: DERIVED_OUTPUT_ORDER.map((output) => ({
      output,
      filename: names[output],
    })),
    pages: pageNames(base, PREVIEW_PAGE_COUNT, PDF_EXT),
    // Two arbitrary discovered names, deliberately unrelated to `base` — the
    // point of the example is that they are *not* renamed to the folder name.
    multiAsset: ["prvi_dio", "drugi_dio"].map((source) => ({
      source: webPdfName(source),
      text: ocrTextNameFor(webPdfName(source)),
    })),
  };
}
