/**
 * Upload planning + gating (Epic 07) — the pure rules behind turning a
 * processed, described {@link Item} into a create/replace on the backend.
 *
 * This module owns every decision that can be made without I/O, so the upload
 * orchestration (`services/upload.ts`) is a thin executor and the whole policy
 * is unit-testable without Tauri or the network:
 *
 *  - **Gating** — the hard blockers (not processed, unresolved multi-image
 *    thumbnail, invalid metadata) and the soft warnings (empty / garbled OCR)
 *    that the Upload summary surfaces (docs/tasks/07 §Upload gating / Thumbnail
 *    gate / Text quality).
 *  - **The upload set** — which discovered assets upload and as which
 *    {@link FileRole}, grouped into the ≤2 multipart requests the backend needs
 *    (role is batch-wide, not per-file — a THUMBNAIL + WEB mix is two requests).
 *  - **The `extractedTexts` pairing** — each web PDF ↔ its `<base>.txt`, so the
 *    OCR full text rides the same upload with `doOCR=false`.
 *  - **Create vs replace** — a first upload creates; a re-upload of an item with
 *    a `backendId` replaces in place (stable id).
 *  - **PATCH change detection** — the changed metadata keys only (the backend
 *    shallow-merges what it is sent).
 *  - **Validation-error mapping** — Nest `400` bodies back onto field keys.
 *
 * Framework-free — imports only sibling domain types — so every lane can consume
 * it without crossing a service seam.
 */

import { FileRole, TextExtractionStatus } from "./enums";
import {
  autoThumbnail,
  ocrApplicable,
  uploadRoleFor,
  type DiscoveredAsset,
} from "./files";
import { baseNameOf } from "./naming";
import { classifyInput, planThumbnail, type ContentKind } from "./pipeline";
import {
  hasFailedStage,
  type Item,
  type StageName,
  type StageStatus,
} from "./item";

// ─── gating ──────────────────────────────────────────────────────────────────

/** A hard reason an item cannot be uploaded yet (a blocker gates publish). */
export type UploadBlockerCode =
  /** A required pipeline stage (PDF / downscale / thumbnail) is not complete. */
  | "not-processed"
  /** A multi-image item has no chosen primary thumbnail (docs/tasks/07 hard gate). */
  | "thumbnail-unresolved"
  /** Required metadata fields are missing/invalid (computed by the caller from
   * `domain/metadata-form`, passed in as `metadataReady`). */
  | "metadata-invalid"
  /** A pipeline stage failed — the item is Stopped, not Ready. */
  | "processing-failed"
  /**
   * The folder holds nothing that would be uploaded.
   *
   * Without this an **empty folder was publishable**: no stage is applicable, so
   * `markNonApplicableSkipped` records every stage `skipped`, which counts as
   * satisfied — no `not-processed` blocker — and `needsThumbnailChoice([])` is
   * false. Give it a title and every gate passed, creating a **published record
   * with no files** on the live website. Verified 2026-08-07.
   */
  | "no-assets";

/** A soft reason to warn before uploading (does not block — the operator may
 * continue). */
export type UploadWarningCode =
  /** OCR applies to this item but no full text is present. */
  | "ocr-missing"
  /** The backend classified the supplied text as garbled/no-text. */
  | "ocr-garbage"
  /**
   * The backend stored a **different filename** than the one sent — verified
   * 2026-08-07: a multipart filename with non-ASCII characters comes back as
   * `??????` (`nbcg/todo/backend-multipart-filename-not-utf8.md`).
   *
   * It matters beyond cosmetics because `extractedTexts` is keyed **by filename**,
   * so a mangled name silently drops the full text. `services/upload` re-attaches
   * the text by file id, which fixes the text — but the stored filename stays
   * corrupted, so the operator is told.
   */
  | "filename-mangled";

export interface UploadBlocker {
  code: UploadBlockerCode;
  message: string;
}

export interface UploadWarning {
  code: UploadWarningCode;
  message: string;
}

/** A stage counts as satisfied when it completed or does not apply. */
function stageSatisfied(status: StageStatus): boolean {
  return status === "done" || status === "skipped";
}

/**
 * The pre-upload gate for one item: the hard {@link UploadBlocker}s and soft
 * {@link UploadWarning}s. `metadataReady` is computed by the caller from the
 * schema + working values (`domain/metadata-form.isItemValid`) — the schema is
 * not available here, so it is injected. `primaryThumbnail` is the resolved
 * operator/auto pick (see {@link resolvePrimaryThumbnail}).
 */
export interface UploadGateInput {
  /** Whether every required/enum metadata rule passes for this item. */
  metadataReady: boolean;
  /** The chosen primary-thumbnail filename, or null (unresolved / not needed). */
  primaryThumbnail: string | null;
  /**
   * The operator's book/graphical override, if one was applied when this item was
   * processed (`domain/batch.BatchItemOverride.contentKind`).
   *
   * Defaults to `"auto"`, which re-derives the same shape the pipeline used on the
   * default path. Pass it when the item was run with an override, or the gate
   * reasons about a different input shape than the run did — e.g. a folder forced
   * to `graphical` has per-image candidates where `auto` would have seen one book
   * cover.
   */
  contentKind?: ContentKind;
}

/** The pipeline stages that must be complete before an item can upload. OCR is
 * intentionally excluded — a missing/garbled OCR result is a soft warning, not a
 * gate (docs/tasks/07). */
const REQUIRED_UPLOAD_STAGES: readonly StageName[] = ["pdf", "thumbnail"];

/** Hard blockers preventing an item from uploading. Empty ⇒ uploadable. */
export function uploadBlockers(
  item: Item,
  input: UploadGateInput,
): UploadBlocker[] {
  const blockers: UploadBlocker[] = [];

  if (hasFailedStage(item.stages)) {
    blockers.push({
      code: "processing-failed",
      message: "A processing stage failed — re-process before uploading.",
    });
  } else {
    const unfinished = REQUIRED_UPLOAD_STAGES.filter(
      (s) => !stageSatisfied(item.stages[s].status),
    );
    if (unfinished.length > 0) {
      blockers.push({
        code: "not-processed",
        message: `Not fully processed yet (${unfinished.join(", ")}).`,
      });
    }
  }

  // Nothing to publish. Checked against the actual upload grouping rather than
  // `assets.length`, so a folder holding only never-uploaded files (TIFF sources,
  // an archival master, OCR text) is caught too — those produce no request.
  if (uploadGroups(item.assets, input.primaryThumbnail).length === 0) {
    blockers.push({
      code: "no-assets",
      message:
        "Nothing to upload — this folder has no web PDF, image, or thumbnail.",
    });
  }

  // Hard thumbnail gate: a genuine ambiguity with no pick chosen.
  //
  // Asked via `planThumbnail`, NOT `files.needsThumbnailChoice`. The latter counts
  // only images already present in the folder, so a **multi-PDF** item — whose
  // candidates are the first-page images the pipeline has yet to generate — scored
  // zero candidates and slipped through the gate entirely, publishing with an
  // unresolved thumbnail. `planThumbnail` reasons about generated candidates too,
  // which is exactly why docs/tasks/06 tells this epic to use it.
  const kind = input.contentKind ?? "auto";
  const thumbnail = planThumbnail(item.assets, classifyInput(item.assets, kind), kind);
  if (thumbnail.needsChoice && input.primaryThumbnail == null) {
    blockers.push({
      code: "thumbnail-unresolved",
      message: "Choose a primary thumbnail before uploading.",
    });
  }

  if (!input.metadataReady) {
    blockers.push({
      code: "metadata-invalid",
      message: "Required metadata is incomplete or invalid.",
    });
  }

  return blockers;
}

/**
 * Soft warnings for the Upload summary, derived from the item's assets **before**
 * upload: an OCR-applicable item with no `<base>.txt` present ("not processed to
 * the end"). The post-upload text-quality warning (GARBAGE / NO_TEXT) is a
 * separate check on the backend response — see {@link textQualityWarnings}.
 */
export function uploadWarnings(item: Item): UploadWarning[] {
  const warnings: UploadWarning[] = [];
  const hasOcrText = item.assets.some((a) => a.kind === "ocr-text");
  if (ocrApplicable(item.assets) && !hasOcrText) {
    warnings.push({
      code: "ocr-missing",
      message:
        "No OCR text found — confirm you don't need full text, or extract it first.",
    });
  }
  return warnings;
}

/**
 * Post-upload text-quality warnings: the backend classifies supplied text
 * (`looksGarbled`) into a {@link TextExtractionStatus}; a GARBAGE / NO_TEXT
 * result is treated like the empty-OCR soft warning (docs/tasks/07 §Text
 * quality). Keyed off the returned {@link TextExtractionStatus} per file.
 */
export function textQualityWarnings(
  files: ReadonlyArray<{ filename: string; textExtractionStatus: TextExtractionStatus }>,
): UploadWarning[] {
  const warnings: UploadWarning[] = [];
  for (const f of files) {
    if (
      f.textExtractionStatus === TextExtractionStatus.GARBAGE ||
      f.textExtractionStatus === TextExtractionStatus.NO_TEXT
    ) {
      warnings.push({
        code: "ocr-garbage",
        message: `Full text for "${f.filename}" looks empty or garbled.`,
      });
    }
  }
  return warnings;
}

// ─── the upload set ────────────────────────────────────────────────────────

/**
 * The resolved primary-thumbnail filename: the operator's explicit pick, else
 * the auto-selected candidate (a single pre-tagged `*_thumb.png` / a lone
 * image), else null. Mirrors the pipeline's resolution so the roles the backend
 * receives match what was processed.
 */
export function resolvePrimaryThumbnail(
  assets: DiscoveredAsset[],
  primaryThumbnail: string | null,
): string | null {
  if (primaryThumbnail) return primaryThumbnail;
  return autoThumbnail(assets)?.filename ?? null;
}

/** One multipart upload request: a single {@link FileRole} applied to a group of
 * files (the backend applies `role` batch-wide, so each role is its own
 * request). */
export interface UploadGroup {
  role: FileRole;
  assets: DiscoveredAsset[];
}

/**
 * How many files one `POST /api/files/upload/:itemId` may carry.
 *
 * Mirrors `services/api/dto.UPLOAD_MAX_FILES` — the backend's multer cap. It is
 * restated here because `domain/` may not import from `services/`; a test asserts
 * the two stay equal.
 */
export const MAX_FILES_PER_REQUEST = 10;

/**
 * Group an item's uploadable assets into the requests the backend needs. The
 * resolved primary thumbnail becomes the sole `THUMBNAIL`; every other web PDF /
 * image is `WEB`. TIFFs, the archival master, OCR text, and metadata are never
 * uploaded (they map to a `null` role and are dropped). Groups with no files are
 * omitted.
 *
 * Each role is **chunked to {@link MAX_FILES_PER_REQUEST}**, so an item with many
 * images yields several `WEB` groups rather than one oversized request. Without
 * that split the whole upload `400`s: the cap was documented but never enforced,
 * and it is easy to exceed — a graphical work with a dozen plates does it, and so
 * does any book the operator marks as `graphical` (`domain/pipeline.ContentKind`),
 * which for a 260-page scan would have sent 260 files in one request.
 */
export function uploadGroups(
  assets: DiscoveredAsset[],
  primaryThumbnail: string | null,
  maxPerRequest: number = MAX_FILES_PER_REQUEST,
): UploadGroup[] {
  const primary = resolvePrimaryThumbnail(assets, primaryThumbnail);
  const byRole = new Map<FileRole, DiscoveredAsset[]>();
  for (const asset of assets) {
    const role = uploadRoleFor(asset, primary);
    if (role == null) continue;
    const bucket = byRole.get(role);
    if (bucket) bucket.push(asset);
    else byRole.set(role, [asset]);
  }
  // Deterministic order: THUMBNAIL first, then WEB (purely for stable output),
  // each split into request-sized chunks.
  const groups: UploadGroup[] = [];
  for (const role of [FileRole.THUMBNAIL, FileRole.WEB] as const) {
    const bucket = byRole.get(role);
    if (!bucket?.length) continue;
    for (let i = 0; i < bucket.length; i += maxPerRequest) {
      groups.push({ role, assets: bucket.slice(i, i + maxPerRequest) });
    }
  }
  return groups;
}

/** A web PDF paired with the OCR-text asset whose name matches it (`<base>.txt`),
 * for building the `extractedTexts` map (PDF filename → text). */
export interface TextPair {
  /** The web PDF's filename (the `extractedTexts` map key). */
  pdfFilename: string;
  /** The `<base>.txt` asset to read the text from. */
  text: DiscoveredAsset;
}

/**
 * Pair each web PDF with its OCR text file by shared base name. A PDF with no
 * matching `.txt` is omitted (the empty-OCR soft warning covers that case); a
 * `.txt` with no matching PDF is ignored (text is attached by PDF name).
 */
export function textPairs(assets: DiscoveredAsset[]): TextPair[] {
  // Key by lower-cased base name: the folder is case-preserving-but-insensitive
  // on Windows, so `Gorski.pdf` must still pair with `gorski.txt`.
  const texts = new Map<string, DiscoveredAsset>();
  for (const a of assets) {
    if (a.kind === "ocr-text") texts.set(baseNameOf(a.filename).toLowerCase(), a);
  }
  const pairs: TextPair[] = [];
  for (const a of assets) {
    if (a.kind !== "web-pdf") continue;
    const text = texts.get(baseNameOf(a.filename).toLowerCase());
    if (text) pairs.push({ pdfFilename: a.filename, text });
  }
  return pairs;
}

// ─── create vs replace + change detection ────────────────────────────────────

/** Whether an upload creates a new backend item or replaces an existing one. */
export type UploadMode = "create" | "replace";

/**
 * The mode for uploading an item: `replace` once it has a connected
 * `backendId` (a re-upload — stable id, stays in `/processed`), else `create`.
 * The item flags (`uploaded`/`reupload`) describe *why* a replace is due; the
 * `backendId` is what makes it safe to reuse the record (never double-create).
 */
export function uploadMode(item: Item): UploadMode {
  return item.backendId ? "replace" : "create";
}

/**
 * Deep structural value equality for metadata keys. Objects are compared
 * **key-order-insensitively** (a freshly-serialised form value and the
 * last-written mirror can carry the same content in a different key order — we
 * must not treat that as a change, or every no-op re-upload would fire a
 * needless version-bumping PATCH). Arrays stay order-**sensitive** (element
 * order is meaningful for COMARC lists like `authors`).
 */
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => valueEquals(v, b[i]));
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && valueEquals(ao[k], bo[k]),
  );
}

/**
 * The metadata keys whose value changed vs the last-written mirror — the only
 * keys a PATCH should send (the backend shallow-merges what it receives; sending
 * unchanged keys is wasteful and, for a no-op, avoidable). A key present in
 * `next` but absent in `prev` counts as changed; a key only in `prev` is NOT
 * emitted (the backend cannot unset a key — docs/PROJECT-KNOWLEDGE §4).
 */
export function changedMetadataKeys(
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(next)) {
    if (!valueEquals(next[key], prev[key])) changed.push(key);
  }
  return changed;
}

/** Project `next` down to only its changed keys (for the PATCH body). Returns an
 * empty object when nothing changed (the caller can then skip the PATCH). */
export function changedMetadata(
  next: Record<string, unknown>,
  prev: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of changedMetadataKeys(next, prev)) out[key] = next[key];
  return out;
}

// ─── backend validation-error mapping ────────────────────────────────────────

/** One backend validation failure mapped onto a field (best-effort). */
export interface BackendFieldError {
  /** The metadata field key the message appears to concern, or null if the
   * message is not field-specific. */
  key: string | null;
  message: string;
}

/**
 * Map a Nest `ValidationPipe` `400` body (`{ message: string | string[] }`) to
 * per-field errors so the editor can surface them on the relevant fields
 * (docs/tasks/07 §Surface validation errors). Nest emits messages like
 * `"title should not be empty"`; we attribute a message to a field when it
 * starts with (or contains) a known field key. Unattributable messages come
 * back with `key: null` for a general banner.
 */
export function mapValidationErrors(
  body: unknown,
  fieldKeys: readonly string[],
): BackendFieldError[] {
  const messages = extractNestMessages(body);
  const keys = [...fieldKeys].sort((a, b) => b.length - a.length); // longest first
  return messages.map((message) => {
    const lower = message.toLowerCase();
    const key =
      keys.find((k) => lower.startsWith(k.toLowerCase() + " ")) ??
      keys.find((k) => new RegExp(`\\b${escapeRegExp(k.toLowerCase())}\\b`).test(lower)) ??
      null;
    return { key, message };
  });
}

function extractNestMessages(body: unknown): string[] {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message: unknown }).message;
    if (Array.isArray(m)) return m.filter((x): x is string => typeof x === "string");
    if (typeof m === "string") return [m];
  }
  return [];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── the assembled per-item plan ─────────────────────────────────────────────

/**
 * The fully-decided, I/O-free plan for uploading one item. `services/upload.ts`
 * executes it: read each group's file bytes, read each text pair, then create /
 * replace + upload + connect. When `blockers` is non-empty the item must not be
 * uploaded (the summary shows why).
 */
export interface ItemUploadPlan {
  itemId: string;
  mode: UploadMode;
  /** The connected backend id for a replace, else null (a create assigns it). */
  backendId: string | null;
  /** The resolved primary-thumbnail filename actually used for roles. */
  primaryThumbnail: string | null;
  /** The ≤2 multipart groups (role + files). Empty when the item has no
   * uploadable assets (e.g. metadata-only). */
  groups: UploadGroup[];
  /** Web PDF ↔ OCR text pairings for the `extractedTexts` map. */
  texts: TextPair[];
  blockers: UploadBlocker[];
  warnings: UploadWarning[];
}

/** Assemble the {@link ItemUploadPlan} from an item + its gate input. Pure. */
export function planItemUpload(
  item: Item,
  input: UploadGateInput,
): ItemUploadPlan {
  const primaryThumbnail = resolvePrimaryThumbnail(
    item.assets,
    input.primaryThumbnail,
  );
  return {
    itemId: item.id,
    mode: uploadMode(item),
    backendId: item.backendId,
    primaryThumbnail,
    groups: uploadGroups(item.assets, primaryThumbnail),
    texts: textPairs(item.assets),
    blockers: uploadBlockers(item, input),
    warnings: uploadWarnings(item),
  };
}

/** Whether a plan may proceed to upload (no hard blockers). */
export function isUploadable(plan: ItemUploadPlan): boolean {
  return plan.blockers.length === 0;
}
