/**
 * Asset-discovery vocabulary (Epic 02) — the classification of the files found
 * inside an item folder, and the naming-convention rules that derive their
 * roles.
 *
 * The native `core/fs` (Arch lane) *discovers* the raw file list; this module
 * *classifies* each entry by the folder-derived naming convention
 * (docs/01-concept-and-ux.md §Naming / §Files per item), so classification is a
 * single documented rule set in the logic lane rather than duplicated in Rust.
 *
 * The convention's *literals* (the `_archive` / `_thumb` suffixes, the derived
 * output names) live in {@link module:domain/naming} — this module only decides
 * what a discovered file **is**, using the predicates from there.
 *
 * Framework-free — imports only sibling domain modules.
 */

import { FileRole } from "./enums";
import {
  extensionOf,
  baseNameOf,
  hasArchivalSuffix,
  hasThumbnailSuffix,
} from "./naming";

/**
 * What a discovered file is, by naming convention. This is the archive's local
 * classification, distinct from the backend {@link FileRole} an asset is
 * uploaded as (see {@link uploadRoleFor}).
 */
export type AssetKind =
  /** `*.tif` / `*.tiff` — the source scans. Kept local, never uploaded. */
  | "source-tiff"
  /** `<name>_archive.pdf` — the archival master. Kept local. */
  | "archival-pdf"
  /** `<name>.pdf` (or any non-archive PDF) — the web PDF. Uploaded (`role=WEB`). */
  | "web-pdf"
  /** A page/standalone raster image — a thumbnail candidate; uploaded. */
  | "image"
  /** `<name>_thumb.png`, or an image literally named `thumbnail` — auto-primary. */
  | "thumbnail"
  /** `<base>.txt` — OCR full text. Uploaded via the `extractedTexts` map. */
  | "ocr-text"
  /** `<name>.json` / `metadata.json` — the local metadata mirror. Never uploaded. */
  | "metadata-json"
  /** Anything else. */
  | "other";

/** One discovered file in an item folder, classified. */
export interface DiscoveredAsset {
  filename: string;
  /** Absolute path on disk. */
  path: string;
  kind: AssetKind;
  sizeBytes?: number | null;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const TIFF_EXTS = new Set(["tif", "tiff"]);

/**
 * Classify a discovered file by its name. `folderName` is accepted for future
 * folder-relative rules; classification currently depends only on the filename.
 */
export function classifyAsset(filename: string, _folderName?: string): AssetKind {
  const ext = extensionOf(filename);
  const base = baseNameOf(filename).toLowerCase();

  if (TIFF_EXTS.has(ext)) return "source-tiff";
  if (ext === "txt") return "ocr-text";
  if (ext === "json") return "metadata-json";
  if (ext === "pdf") return hasArchivalSuffix(base) ? "archival-pdf" : "web-pdf";
  if (IMAGE_EXTS.has(ext)) {
    if (hasThumbnailSuffix(base) || base === "thumbnail") return "thumbnail";
    return "image";
  }
  return "other";
}

/** Build a classified {@link DiscoveredAsset} from a raw filename + path. */
export function discoverAsset(
  filename: string,
  path: string,
  folderName?: string,
  sizeBytes?: number | null,
): DiscoveredAsset {
  return { filename, path, kind: classifyAsset(filename, folderName), sizeBytes };
}

/** The web PDFs in a folder (a folder may hold several — all upload as `WEB`). */
export function webPdfAssets(assets: DiscoveredAsset[]): DiscoveredAsset[] {
  return assets.filter((a) => a.kind === "web-pdf");
}

/**
 * The thumbnail candidates — every raster image (page images + standalone +
 * any pre-tagged `thumbnail`). One candidate → auto; a `thumbnail`-kind asset is
 * the auto-primary; several plain images → the operator must pick one.
 */
export function thumbnailCandidates(assets: DiscoveredAsset[]): DiscoveredAsset[] {
  return assets.filter((a) => a.kind === "image" || a.kind === "thumbnail");
}

/**
 * The thumbnail chosen automatically, when no operator pick is needed
 * (docs/tasks/04 §Thumbnail picker):
 *  - a single pre-tagged `thumbnail` asset (e.g. `*_thumb.png` / `thumbnail.*`)
 *    wins outright;
 *  - otherwise, a lone candidate auto-selects.
 * Returns `null` when the operator must choose (see {@link needsThumbnailChoice}).
 */
export function autoThumbnail(assets: DiscoveredAsset[]): DiscoveredAsset | null {
  const candidates = thumbnailCandidates(assets);
  const tagged = candidates.filter((a) => a.kind === "thumbnail");
  if (tagged.length === 1) return tagged[0];
  if (tagged.length === 0 && candidates.length === 1) return candidates[0];
  return null;
}

/**
 * Whether the item needs the operator to pick a primary thumbnail — two or more
 * candidates with no unambiguous auto-choice. The Metadata tab flags such an
 * item as incomplete until a primary is set.
 */
export function needsThumbnailChoice(assets: DiscoveredAsset[]): boolean {
  return (
    thumbnailCandidates(assets).length >= 2 && autoThumbnail(assets) === null
  );
}

/**
 * Whether OCR applies to this asset set. It does when there is a PDF or source
 * TIFFs to extract text from; an **images-only** folder (a map/graphical work)
 * carries no full text, so the OCR stage is N/A (docs/01 §Asset variations).
 */
export function ocrApplicable(assets: DiscoveredAsset[]): boolean {
  return assets.some(
    (a) =>
      a.kind === "web-pdf" || a.kind === "archival-pdf" || a.kind === "source-tiff",
  );
}

/**
 * The backend upload role an asset maps to, once a primary thumbnail is chosen.
 * `primaryThumbnailFilename` is the operator's pick; that file becomes
 * `THUMBNAIL`, every other web image/PDF is `WEB`. Returns `null` for assets
 * that are never uploaded (TIFFs, archival master, OCR text, metadata).
 */
export function uploadRoleFor(
  asset: DiscoveredAsset,
  primaryThumbnailFilename: string | null,
): FileRole | null {
  if (primaryThumbnailFilename && asset.filename === primaryThumbnailFilename) {
    return FileRole.THUMBNAIL;
  }
  switch (asset.kind) {
    case "web-pdf":
    case "image":
      return FileRole.WEB;
    case "thumbnail":
      // A pre-tagged thumbnail that wasn't explicitly picked still uploads as an
      // image; the caller decides the primary.
      return FileRole.WEB;
    default:
      return null;
  }
}
