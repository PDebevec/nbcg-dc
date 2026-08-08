/**
 * Upload orchestration (Epic 07) — turns a processed, described item into a
 * create/replace on the backend (the single source of truth), then write-through
 * to the local mirror + index and repositions the folder to `/processed`.
 *
 * The whole *policy* is in `domain/upload.ts` (pure); this service is the
 * executor that does the I/O in the right order:
 *
 *   preflight → create | replace (metadata) → upload assets (roles + OCR text)
 *   → connect parents → write-through (`metadata.json` + SQLite) → move folder
 *
 * Design:
 *  - **Store-free + fully injectable.** Every backend/native primitive is a
 *    field on {@link UploadDeps} that defaults to the real service/IPC — so the
 *    orchestration is unit-testable with in-memory fakes and no Tauri runtime.
 *  - **Never double-create.** An item with a `backendId` always replaces (stable
 *    id); a create-collision (`409`, e.g. a deterministic COBISS id) surfaces as
 *    a distinct `duplicate` outcome rather than an error.
 *  - **Write-gating is reactive.** No pre-check of scopes — a `403` on
 *    create/upload folds into a `forbidden` outcome with a clear message
 *    (single-user static token; docs/PROJECT-KNOWLEDGE §3).
 *  - **Trust the write response.** The create response carries the full record;
 *    the mirror is built from it, never re-read from search (CDC-lagged).
 *  - **Retry transient failures.** Network / timeout / 5xx are retried a few
 *    times with backoff (injectable sleep); 4xx are not.
 *
 * The reactive run state (progress + per-item results feeding the Upload tab)
 * and the terminal batch-archive (READ-ONLY + release items) are **store
 * coordination** — a future `stores/useUpload` wraps {@link uploadBatch} and, on
 * full success, calls `useBatches.archive()` + refreshes items. This service
 * deliberately does not import Pinia. Stays in Jernej's `.ts` lane.
 */

import { ipc } from "@ipc/bindings";
import type { UploadRecordDto } from "@ipc/bindings";
import { ApiError } from "./api/client";
import {
  createItem as apiCreateItem,
  updateItem as apiUpdateItem,
} from "./api/items";
import {
  listFiles as apiListFiles,
  replaceFile as apiReplaceFile,
  setFileText as apiSetFileText,
  uploadFiles as apiUploadFiles,
  type UploadFile,
} from "./api/files";
import { connectParent as apiConnectParent } from "./api/relations";
import { previewCobiss } from "./api/cobiss";
import { getRecordSchema } from "./api/schema";
import { listIndex, readItemMetadata, writeItemMetadata } from "./indexing";
import type {
  CreateItemDto,
  FileAttachment,
  ItemEntity,
  RelationWriteResult,
  UpdateItemDto,
} from "./api/dto";
import type { ItemType, VisibilityStatus } from "@domain/enums";
import type { FieldLevel, RecordSchema } from "@domain/schema";
import { fieldsForLevel, pruneToSchema } from "@domain/metadata-form";
import type {
  LocalMetadataFile,
  RecordMetadata,
  RecordMetadataInput,
} from "@domain/metadata";
import type { Item } from "@domain/item";
import type { DiscoveredAsset } from "@domain/files";
import { isMangledFilename, isSameUploadedFilename } from "@domain/naming";
import { resolveVersion } from "@domain/sync";
import {
  changedMetadata,
  isUploadable,
  mapValidationErrors,
  planItemUpload,
  textQualityWarnings,
  type BackendFieldError,
  type ItemUploadPlan,
  type UploadBlocker,
  type UploadWarning,
} from "@domain/upload";
import { logger } from "@lib/logger";

// ─── deps (injectable seams) ─────────────────────────────────────────────────

/** The backend/native primitives the orchestration needs, each defaulting to
 * the real service/IPC. Override any subset in tests (or to stub Tauri). */
export interface UploadDeps {
  createItem: typeof apiCreateItem;
  updateItem: typeof apiUpdateItem;
  uploadFiles: typeof apiUploadFiles;
  replaceFile: typeof apiReplaceFile;
  listFiles: typeof apiListFiles;
  /** (Re)set a file's full text by **id** (`PUT /api/files/:fileId/text`). Used to
   * recover text the backend dropped because it mangled the filename. */
  setFileText: typeof apiSetFileText;
  /** Connect one child under one parent (`POST /api/relations/connect`). Resolves
   * to the parent's post-write state — see {@link ItemUploadResult.parentStates}. */
  connectParent: (parentId: string, childId: string) => Promise<RelationWriteResult>;
  /** Read a file's raw bytes off disk (native `fs_read_file`). */
  readFileBytes: (path: string) => Promise<ArrayBuffer>;
  /** Read a UTF-8 text file (OCR `.txt`) off disk. */
  readTextFile: (path: string) => Promise<string>;
  /** Read the folder's `metadata.json` mirror. */
  readMirror: (item: Item) => Promise<LocalMetadataFile | null>;
  /** Write the folder's `metadata.json` mirror (write-through). */
  writeMirror: (item: Item, file: LocalMetadataFile) => Promise<void>;
  /** Persist the upload facts onto the SQLite index row (native). */
  recordUpload: (itemId: string, dto: UploadRecordDto) => Promise<void>;
  /** Resolve the backend id of an already-existing record on a create-collision
   * (409). Default: the deterministic id from the COBISS preview when the item
   * carries a catalogue id, else null. Lets a collision reuse the known id
   * instead of ever double-creating. */
  resolveExistingBackendId: (item: Item) => Promise<string | null>;
  /** Move the item's folder `/unprocessed` → `/processed` (native). */
  moveToProcessed: (item: Item) => Promise<void>;
  /** The tracked local items, used to map a connected `parentId` back to a
   * locally-mirrored item so its bumped version can be adopted (see
   * {@link applyParentStates}). */
  listItems: () => Promise<Item[]>;
  /** Fetch (cached) the record schema for a level, to prune metadata. */
  getSchema: (level: FieldLevel) => Promise<RecordSchema>;
  /** Current ISO timestamp (injectable for deterministic tests). */
  now: () => string;
  /** Sleep between retries (injectable — tests pass a no-op). */
  sleep: (ms: number) => Promise<void>;
}

function defaultDeps(): UploadDeps {
  return {
    createItem: apiCreateItem,
    updateItem: apiUpdateItem,
    uploadFiles: apiUploadFiles,
    replaceFile: apiReplaceFile,
    listFiles: apiListFiles,
    setFileText: apiSetFileText,
    connectParent: (parentId, childId) => apiConnectParent(parentId, childId),
    readFileBytes: (path) => ipc.fs.readFile(path),
    readTextFile: async (path) => new TextDecoder().decode(await ipc.fs.readFile(path)),
    readMirror: (item) => readItemMetadata(item),
    writeMirror: (item, file) => writeItemMetadata(item, file),
    recordUpload: (itemId, dto) => ipc.index.recordUpload(itemId, dto).then(() => {}),
    resolveExistingBackendId: async (item) => {
      if (!item.catalogueId) return null;
      const preview = await previewCobiss(item.catalogueId);
      return preview.itemId ?? null;
    },
    moveToProcessed: async (item) => {
      await ipc.fs.moveToProcessed(item.id);
    },
    listItems: () => listIndex(),
    getSchema: (level) => getRecordSchema(level),
    now: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function withDefaults(overrides?: Partial<UploadDeps>): UploadDeps {
  return { ...defaultDeps(), ...overrides };
}

// ─── per-item context + result ──────────────────────────────────────────────

/** The publish decisions + working values for one item's upload — resolved by
 * the caller from the batch defaults/overrides (`domain/batch`) and the metadata
 * form (`domain/metadata-form`). */
export interface UploadItemContext {
  /** Publish target (DRAFT/RECORD) — the batch default or the item override. */
  targetState: ItemType;
  /** Visibility — the batch default or the item override. */
  visibility: VisibilityStatus;
  /** Linked parent ids to connect this item under (one connect call each). */
  parentIds: string[];
  /** The working metadata to publish. Defaults to the folder mirror's metadata
   * when omitted (the persisted pre-upload working source of truth). */
  metadata?: RecordMetadataInput;
  /** Whether the metadata validates (caller computes via metadata-form). */
  metadataReady: boolean;
  /** The chosen primary-thumbnail filename, or null. */
  primaryThumbnail: string | null;
}

export type ItemUploadStatus =
  /** Created/replaced + assets + links + write-through all succeeded. */
  | "uploaded"
  /** A hard gate stopped it before any backend call (see `blockers`). */
  | "blocked"
  /** The token lacks the required manage scope (`403`). */
  | "forbidden"
  /** A create collided with an existing (deterministic) id (`409`). */
  | "duplicate"
  /** Any other failure (validation, concurrency, transport, …). */
  | "error";

export interface ItemUploadResult {
  itemId: string;
  status: ItemUploadStatus;
  /** The connected backend id on success (or the existing one). */
  backendId: string | null;
  /** Hard gates (only on `blocked`). */
  blockers: UploadBlocker[];
  /** Soft warnings (pre-upload OCR + post-upload text quality). */
  warnings: UploadWarning[];
  /** Backend validation errors mapped onto fields (on a `400`). */
  fieldErrors: BackendFieldError[];
  /** Per-parent connect failures (the record still uploaded). */
  relationErrors: Array<{ parentId: string; message: string }>;
  /**
   * Each successfully-connected parent's state **after** the write — its new
   * `version` and rewritten children counts.
   *
   * Connecting a child bumps the parent's `version` via a DB trigger, so any
   * mirror of that parent goes stale the moment this succeeds, and the parent's
   * next `PATCH` would `409`. The backend now reports the resulting version
   * (2026-08-07) instead of leaving it to a CDC-lagged re-read, so it is carried
   * here rather than discarded.
   *
   * These are **already applied** — {@link applyParentStates} runs inside
   * `uploadItem`, right after the connects. They are surfaced here for the caller
   * to render, not to act on. (This was briefly parked for the deferred upload
   * store on the grounds that mapping a `parentId` back to a local item needs the
   * item list; it needs only a `listItems` dep, and leaving it parked meant a
   * connected parent's next ordinary `PATCH` would `409`.) Parents the archive
   * does not track locally simply have nothing to update.
   */
  parentStates: RelationWriteResult[];
  /** A human message for a toast (on non-`uploaded` outcomes). */
  message: string | null;
}

function result(
  itemId: string,
  status: ItemUploadStatus,
  extra: Partial<ItemUploadResult> = {},
): ItemUploadResult {
  return {
    itemId,
    status,
    backendId: null,
    blockers: [],
    warnings: [],
    fieldErrors: [],
    relationErrors: [],
    parentStates: [],
    message: null,
    ...extra,
  };
}

// ─── retry ────────────────────────────────────────────────────────────────

const DEFAULT_RETRIES = 2;
const RETRY_BASE_MS = 500;

/** Whether a failure is worth retrying — transport + 5xx, never a 4xx. */
function isTransient(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.isNetworkError || err.kind === "server")
  );
}

/** Run `fn`, retrying transient failures with linear backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  deps: UploadDeps,
  retries = DEFAULT_RETRIES,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransient(err)) throw err;
      await deps.sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

// ─── file reading (disk → multipart) ────────────────────────────────────────

/** Read one asset's bytes into an {@link UploadFile}. */
async function toUploadFile(
  asset: DiscoveredAsset,
  deps: UploadDeps,
): Promise<UploadFile> {
  const bytes = await deps.readFileBytes(asset.path);
  return { blob: new Blob([bytes]), filename: asset.filename };
}

/** Build the `extractedTexts` map (PDF filename → OCR text) from a plan. */
async function buildExtractedTexts(
  plan: ItemUploadPlan,
  deps: UploadDeps,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const pair of plan.texts) {
    map[pair.pdfFilename] = await deps.readTextFile(pair.text.path);
  }
  return map;
}

// ─── metadata assembly ──────────────────────────────────────────────────────

/** The schema-valid, non-empty metadata to send, given the working values and
 * the item level. */
async function prunedMetadata(
  values: RecordMetadataInput,
  level: FieldLevel,
  deps: UploadDeps,
): Promise<{ metadata: RecordMetadataInput; fieldKeys: string[] }> {
  const schema = await deps.getSchema(level);
  const fields = fieldsForLevel(schema, level);
  return {
    metadata: pruneToSchema(values, fields),
    fieldKeys: fields.map((f) => f.key),
  };
}

/** Persist the write-through mirror + index row after a successful upload. */
async function writeThrough(
  item: Item,
  deps: UploadDeps,
  facts: {
    backendId: string;
    version: number | null;
    targetState: ItemType;
    visibility: VisibilityStatus;
    metadata: RecordMetadata;
  },
): Promise<void> {
  const mirror: LocalMetadataFile = {
    backendId: facts.backendId,
    version: facts.version,
    targetState: facts.targetState,
    visibilityStatus: facts.visibility,
    metadata: facts.metadata,
    syncedAt: deps.now(),
  };
  await deps.writeMirror(item, mirror);
  await deps.recordUpload(item.id, {
    backendId: facts.backendId,
    version: facts.version,
    targetState: facts.targetState,
    visibilityStatus: facts.visibility,
  });
}

// ─── the item upload ─────────────────────────────────────────────────────────

/**
 * Upload one item end-to-end. Never throws for an expected backend failure —
 * folds it into a discriminated {@link ItemUploadResult} the caller renders.
 * A truly unexpected error (a bug) still rejects.
 */
export async function uploadItem(
  item: Item,
  ctx: UploadItemContext,
  depsOverride?: Partial<UploadDeps>,
): Promise<ItemUploadResult> {
  const deps = withDefaults(depsOverride);
  const plan = planItemUpload(item, {
    metadataReady: ctx.metadataReady,
    primaryThumbnail: ctx.primaryThumbnail,
  });

  if (!isUploadable(plan)) {
    return result(item.id, "blocked", {
      backendId: item.backendId,
      blockers: plan.blockers,
      warnings: plan.warnings,
      message: plan.blockers[0]?.message ?? "Not ready to upload.",
    });
  }

  // `backendId` is hoisted so the catch reports the id we actually created (a
  // failure *after* create must not lose it — that would double-create on retry).
  let backendId = item.backendId;
  // `fieldKeys` is hoisted for validation-error mapping; populated once the
  // schema is fetched (inside the try, so a schema-fetch failure folds into an
  // error result rather than escaping and crashing the batch).
  let fieldKeys: string[] = [];

  try {
    const warnings = [...plan.warnings];

    // Resolve the working metadata (ctx override, else the folder mirror) and the
    // schema-valid subset to send. Inside the try: `getRecordSchema` rethrows on a
    // cold cache + backend error, and that must become an error result.
    const mirror = await deps.readMirror(item);
    const workingValues = ctx.metadata ?? mirror?.metadata ?? {};
    const pruneResult = await prunedMetadata(workingValues, item.level, deps);
    const pruned = pruneResult.metadata;
    fieldKeys = pruneResult.fieldKeys;

    let version: number | null;
    let mirrorMetadata: RecordMetadata;

    if (plan.mode === "create") {
      let created: ItemEntity;
      try {
        created = await createOnBackend(
          { visibilityStatus: ctx.visibility, targetState: ctx.targetState, metadata: pruned },
          deps,
        );
      } catch (err) {
        // A create-collision (409) means a record with this (deterministic
        // COBISS) id already exists — reuse it instead of ever creating a second.
        const recovered = await recoverCreateCollision(item, ctx, err, deps);
        if (recovered) return recovered;
        throw err;
      }
      backendId = created.id;
      version = created.version;
      mirrorMetadata = created.metadata;

      // Persist the connection + mirror BEFORE the assets, so a mid-flight
      // failure (or crash) leaves a recoverable link — a retry then REPLACEs
      // (never double-creates). The item reads `uploaded` briefly while assets
      // are still pending, but the batch only archives on an all-`uploaded` run,
      // so it stays In progress until the assets land.
      await writeThrough(item, deps, {
        backendId,
        version,
        targetState: ctx.targetState,
        visibility: ctx.visibility,
        metadata: mirrorMetadata,
      });

      const attachments = await uploadCreateAssets(backendId, plan, deps, warnings);
      warnings.push(...textQualityWarnings(attachments));
    } else {
      // Replace (re-upload) — stable id, stays in `/processed`.
      backendId = plan.backendId as string;
      if (!mirror || mirror.version == null) {
        // A connected item with no local version can't do optimistic-concurrency;
        // don't silently write an unconfirmed mirror — ask for a re-sync.
        return result(item.id, "error", {
          backendId,
          message:
            "Local sync state is missing this item's version — re-sync it (Sync) before re-uploading.",
        });
      }
      const prevMeta = (mirror.metadata ?? {}) as RecordMetadata;
      version = await patchOnBackend(item, backendId, pruned, ctx, mirror, deps);
      mirrorMetadata = { ...prevMeta, ...pruned };

      // Persist the confirmed metadata/version FIRST (the PATCH already
      // succeeded), then reconcile files. Only re-push blobs when a derived file
      // actually changed (`flags.reupload`); a metadata-only edit still uploads
      // any file the backend is missing, but never re-PUTs unchanged ones.
      await writeThrough(item, deps, {
        backendId,
        version,
        targetState: ctx.targetState,
        visibility: ctx.visibility,
        metadata: mirrorMetadata,
      });

      const attachments = await pushReplaceAssets(
        backendId,
        plan,
        deps,
        item.flags.reupload,
        warnings,
      );
      warnings.push(...textQualityWarnings(attachments));
    }

    // Link parents (idempotent server-side); a per-parent failure doesn't undo
    // the upload — record it and continue. Each success reports the parent's new
    // version, which the caller needs to keep that parent's mirror usable.
    const { errors: relationErrors, states: parentStates } = await connectParents(
      backendId,
      ctx.parentIds,
      deps,
    );

    // Each connect bumped the parent's version server-side; adopt it now or the
    // parent's next PATCH 409s. Never throws — see `applyParentStates`.
    await applyParentStates(parentStates, deps);

    // Reposition to `/processed` on first upload (a replace already lives there).
    if (item.root === "unprocessed") {
      try {
        await deps.moveToProcessed(item);
      } catch (err) {
        logger.warn("upload", `Uploaded ${item.id} but failed to move to /processed.`, err);
      }
    }

    return result(item.id, "uploaded", {
      backendId,
      warnings,
      relationErrors,
      parentStates,
    });
  } catch (err) {
    return mapUploadError(item.id, backendId, err, fieldKeys);
  }
}

/**
 * Handle a create-collision (`409`): a record with this item's deterministic
 * COBISS id already exists. Reuse it — resolve the existing backend id, record
 * the local link (so we never create a second record and a retry replaces), and
 * surface a `duplicate` outcome. We do NOT blind-PATCH it: we have no version for
 * a record we did not create; Epic 08 sync reconciles its metadata. Returns null
 * when the error is not a recoverable collision (the caller rethrows).
 */
async function recoverCreateCollision(
  item: Item,
  ctx: UploadItemContext,
  err: unknown,
  deps: UploadDeps,
): Promise<ItemUploadResult | null> {
  if (!(err instanceof ApiError) || err.kind !== "conflict") return null;
  const existingId = await deps.resolveExistingBackendId(item).catch(() => null);
  if (!existingId) return null;
  try {
    await deps.recordUpload(item.id, {
      backendId: existingId,
      version: null,
      targetState: ctx.targetState,
      visibilityStatus: ctx.visibility,
    });
  } catch (recErr) {
    logger.warn("upload", `Linked ${item.id} to existing ${existingId} but failed to persist.`, recErr);
  }
  return result(item.id, "duplicate", {
    backendId: existingId,
    message: "Already on the backend — linked to the existing record; re-sync to edit it.",
  });
}

// ─── backend steps ───────────────────────────────────────────────────────────

async function createOnBackend(
  dto: CreateItemDto,
  deps: UploadDeps,
): Promise<ItemEntity> {
  return withRetry(() => deps.createItem(dto), deps);
}

/**
 * PATCH the changed metadata (+ visibility, if changed) for a replace. The
 * caller guarantees a known `mirror.version` (it errors out otherwise), so
 * optimistic concurrency always applies. Sends ONLY changed keys.
 *
 * Returns the version to mirror: the backend's reported version when a request
 * was made, or the prior version when we determined locally that there was
 * nothing to send and skipped the call entirely.
 *
 * The response is read defensively for the same reason {@link connectParents}
 * reads its own: `PATCH` returned an **empty body** for a no-op before the
 * 2026-08-07 fix, which decodes to `undefined`. The app is installed on a
 * workstation while the backend is deployed independently, so a newer app
 * talking to an older backend is a real scenario — and `res.version` on
 * `undefined` throws a `TypeError`, which is not an `ApiError`, so it would reach
 * the operator as a raw "Cannot read properties of undefined" instead of a
 * handled outcome. Falling back to the prior version costs nothing: against an
 * old backend a no-op left the version unchanged anyway, and a real change still
 * reports one.
 */
async function patchOnBackend(
  _item: Item,
  backendId: string,
  pruned: RecordMetadataInput,
  ctx: UploadItemContext,
  mirror: LocalMetadataFile,
  deps: UploadDeps,
): Promise<number> {
  const prevMeta = (mirror.metadata ?? {}) as RecordMetadata;
  const changed = changedMetadata(pruned, prevMeta);
  const visibilityChanged = mirror.visibilityStatus
    ? mirror.visibilityStatus !== ctx.visibility
    : true;
  const priorVersion = mirror.version as number;

  if (Object.keys(changed).length === 0 && !visibilityChanged) {
    return priorVersion; // nothing to PATCH
  }

  const body: UpdateItemDto = { expectedVersion: priorVersion };
  if (Object.keys(changed).length > 0) body.metadata = changed;
  if (visibilityChanged) body.visibilityStatus = ctx.visibility;

  const res = await withRetry(() => deps.updateItem(backendId, body, {}), deps);
  return typeof res?.version === "number" ? res.version : priorVersion;
}

/** Upload a create's assets: one request per role group, `extractedTexts` (PDF
 * OCR) attached to the WEB group. `doOCR` is always false (OCR runs on the
 * archive). Returns all created attachments. */
async function uploadCreateAssets(
  backendId: string,
  plan: ItemUploadPlan,
  deps: UploadDeps,
  warnings: UploadWarning[],
): Promise<FileAttachment[]> {
  const extractedTexts = await buildExtractedTexts(plan, deps);
  const all: FileAttachment[] = [];
  for (const group of plan.groups) {
    const files = await Promise.all(group.assets.map((a) => toUploadFile(a, deps)));
    // Scope the text map to the filenames actually in this request (only the WEB
    // group carries PDFs, so the THUMBNAIL request sends none), then hold back
    // any empty entry — sending one enqueues the Tika run this upload exists to
    // avoid (see `splitEmptyTexts`).
    const groupTexts = pickTexts(extractedTexts, group.assets);
    const { supplied, emptyFilenames } = splitEmptyTexts(groupTexts);
    const attachments = await withRetry(
      () =>
        deps.uploadFiles(backendId, files, {
          role: group.role,
          doOCR: false,
          extractedTexts: supplied,
        }),
      deps,
    );
    await repairMangledText(attachments, group.assets, supplied, deps, warnings);
    await settleEmptyTexts(attachments, group.assets, emptyFilenames, deps);
    all.push(...attachments);
  }
  return all;
}

/**
 * Recover the full text of any file whose filename the backend altered.
 *
 * Verified 2026-08-07, corrected 2026-08-08: the backend parses a multipart
 * filename as Latin-1 when it is really UTF-8, so a non-ASCII name comes back
 * altered — as **mojibake** (`ОКТОИХ…` → `ÐÐÐ¢…`, reversible) or, from a stack
 * that transcodes first, as a lossy `??????`. Either way, since `extractedTexts`
 * is keyed **by filename**, the backend finds no match and stores nothing,
 * returning `201` with `textExtractionStatus: NOT_EXTRACTED`. Silent full-text
 * loss on exactly the Cyrillic material this library catalogues
 * (`nbcg/todo/backend-multipart-filename-not-utf8.md`, P1).
 *
 * `PUT /api/files/:fileId/text` is keyed by **id**, not filename, so it is immune
 * to the same bug — re-sending the text there fixes the content. The stored
 * filename stays corrupted (only the backend can fix that), so a
 * `filename-mangled` warning is raised either way.
 *
 * Detection is positional: the backend returns one attachment per uploaded file,
 * in request order, so `attachments[i]` corresponds to `sent[i]`. Matching by name
 * is exactly what is broken here, so it cannot be used.
 */
async function repairMangledText(
  attachments: FileAttachment[],
  sent: DiscoveredAsset[],
  texts: Record<string, string>,
  deps: UploadDeps,
  warnings: UploadWarning[],
): Promise<void> {
  if (attachments.length !== sent.length) {
    // Positional pairing is not safe — don't guess which text belongs where.
    logger.warn(
      "upload",
      `Upload returned ${attachments.length} attachments for ${sent.length} files; skipping filename check.`,
    );
    return;
  }

  for (let i = 0; i < sent.length; i += 1) {
    const expected = sent[i].filename;
    const attachment = attachments[i];
    if (attachment.filename === expected) continue;

    warnings.push(mangledFilenameWarning(expected, attachment.filename));

    const text = texts[expected];
    if (!text) continue; // nothing to recover for this file

    try {
      await withRetry(() => deps.setFileText(attachment.id, text), deps);
      logger.info(
        "upload",
        `Re-attached the full text of "${expected}" by file id after a filename mismatch.`,
      );
    } catch (err) {
      logger.error("upload", `Could not re-attach the text of "${expected}".`, err);
      warnings.push({
        code: "ocr-missing",
        message: `The full text of "${expected}" could not be attached — re-upload it.`,
      });
    }
  }
}

/**
 * The operator-facing warning for a filename the backend stored corrupted.
 *
 * One builder for both paths (first upload and re-upload), because they describe
 * the same backend bug and used to word it differently — one said the characters
 * were "lost", which is wrong for the mojibake shape and would have the operator
 * expect unrecoverable damage. The text is deliberately about the *stored name*
 * only: `services/upload` repairs the full text either way, and the name is the
 * part solely the backend can fix.
 */
function mangledFilenameWarning(sent: string, stored: string): UploadWarning {
  return {
    code: "filename-mangled",
    message:
      `The backend stored "${sent}" as "${stored}" — it corrupts non-ASCII ` +
      `filenames. The full text was attached correctly; only the stored name is affected.`,
  };
}

/** The subset of `texts` whose keys are among this group's filenames. */
function pickTexts(
  texts: Record<string, string>,
  assets: DiscoveredAsset[],
): Record<string, string> {
  const names = new Set(assets.map((a) => a.filename));
  const out: Record<string, string> = {};
  for (const [filename, text] of Object.entries(texts)) {
    if (names.has(filename)) out[filename] = text;
  }
  return out;
}

/**
 * Split an `extractedTexts` map into the entries that are safe to send and the
 * filenames whose OCR text turned out to be **empty**.
 *
 * An empty-string entry is the one shape that must never reach the map.
 * `files.service.upload` stores text when the key is *present*
 * (`suppliedText !== undefined` → `null` + `NO_TEXT`) but picks the Tika queue
 * with a **truthiness** test (`!extractedTexts?.[filename]`) — so `{"x.pdf": ""}`
 * writes `NO_TEXT` *and* enqueues server-side extraction, which then overwrites
 * it. The stored result is whatever Tika happened to find, on a `201`, for a file
 * the archive explicitly uploaded with `doOCR: false`.
 *
 * Reachable in ordinary use: a blank scan, or an OCR run that wrote `<base>.txt`
 * and found nothing. `domain/upload.textPairs` pairs on the file *existing*, not
 * on it having content.
 *
 * The remedy is the one `dto.ts` prescribes — omit the key here, then set the
 * text explicitly by id afterwards ({@link settleEmptyTexts}).
 */
export function splitEmptyTexts(texts: Record<string, string>): {
  supplied: Record<string, string>;
  emptyFilenames: string[];
} {
  const supplied: Record<string, string> = {};
  const emptyFilenames: string[] = [];
  for (const [filename, text] of Object.entries(texts)) {
    if (text === "") emptyFilenames.push(filename);
    else supplied[filename] = text;
  }
  return { supplied, emptyFilenames };
}

/**
 * Record a genuinely-empty OCR result on the files it belongs to, by **id**.
 *
 * `PUT /api/files/:fileId/text` with `""` stores null + `NO_TEXT` and — unlike
 * upload — never enqueues extraction, so this is the only way to say "we ran OCR
 * and it found nothing" and have it stick.
 *
 * Pairing is **positional**, for the same reason {@link repairMangledText} is:
 * the backend returns one attachment per uploaded file in request order, and the
 * filename it returns cannot be trusted (see `domain/naming`).
 *
 * Best-effort. The upload itself succeeded, and the fallback state (whatever the
 * backend's own extraction produced) is imperfect but not damaging, so a failure
 * here is logged rather than failing the item.
 */
async function settleEmptyTexts(
  attachments: FileAttachment[],
  sent: DiscoveredAsset[],
  emptyFilenames: readonly string[],
  deps: UploadDeps,
): Promise<void> {
  if (emptyFilenames.length === 0) return;
  if (attachments.length !== sent.length) {
    logger.warn(
      "upload",
      `Upload returned ${attachments.length} attachments for ${sent.length} files; ` +
        "cannot pair the empty OCR results positionally.",
    );
    return;
  }

  const empty = new Set(emptyFilenames);
  for (let i = 0; i < sent.length; i += 1) {
    if (!empty.has(sent[i].filename)) continue;
    try {
      await withRetry(() => deps.setFileText(attachments[i].id, ""), deps);
    } catch (err) {
      logger.warn(
        "upload",
        `Could not record the empty OCR result for "${sent[i].filename}".`,
        err,
      );
    }
  }
}

/**
 * Reconcile a re-upload's assets against what the backend already has, listing
 * once and matching by filename:
 *  - **missing** files are uploaded fresh (covers a new derived file, and
 *    recovery of a create whose asset step failed after the id was recorded);
 *  - **present** files are replaced in place (stable id) **only when
 *    `replaceExisting`** — i.e. a derived file actually changed
 *    (`item.flags.reupload`). A metadata-only re-upload leaves unchanged blobs
 *    untouched (docs/tasks/07: "Metadata-only changes go via PATCH, not
 *    re-upload"), so it never re-PUTs identical bytes.
 *
 * The paired OCR text rides along (singular `extractedText` on a replace; the
 * per-file map on a fresh upload). Returns the touched attachments (for
 * text-quality warnings).
 *
 * ⚠️ **Matching is mangling-tolerant, and must stay that way.** The backend
 * stores a non-ASCII multipart filename corrupted (see
 * `domain/naming.isSameUploadedFilename`), so a plain `stored === local` lookup
 * never matches Cyrillic material — every re-upload then took the "not on the
 * backend" branch and **added a duplicate attachment** instead of replacing in
 * place. Live-verified before the fix: two attachments after one re-upload of
 * `ОКТОИХ петогласник 2.pdf`.
 *
 * NOTE: a changed file re-pushes the whole blob. The "only the OCR text changed
 * → PUT /text (no blob)" optimisation needs a native per-file "what changed"
 * signal (Arch handoff, docs/tasks/07 §Re-upload); `setFileText` is already
 * wired for it.
 */
async function pushReplaceAssets(
  backendId: string,
  plan: ItemUploadPlan,
  deps: UploadDeps,
  replaceExisting: boolean,
  warnings: UploadWarning[],
): Promise<FileAttachment[]> {
  const existing = await withRetry(() => deps.listFiles(backendId), deps);
  const textByPdf = new Map(plan.texts.map((t) => [t.pdfFilename, t.text]));
  const out: FileAttachment[] = [];
  // Attachments already claimed by an asset this run, so two local files can
  // never both replace the same backend attachment.
  const claimed = new Set<string>();

  for (const group of plan.groups) {
    // Files not yet on the backend → one fresh upload request per group.
    const fresh: DiscoveredAsset[] = [];
    for (const asset of group.assets) {
      const match = existing.find(
        (f) =>
          !claimed.has(f.id) && isSameUploadedFilename(f.filename, asset.filename),
      );
      if (!match) {
        fresh.push(asset);
        continue;
      }
      claimed.add(match.id);
      if (isMangledFilename(match.filename, asset.filename)) {
        warnings.push(mangledFilenameWarning(asset.filename, match.filename));
      }
      if (!replaceExisting) continue; // present + unchanged → leave it be
      const file = await toUploadFile(asset, deps);
      const textAsset = textByPdf.get(asset.filename);
      const extractedText = textAsset
        ? await deps.readTextFile(textAsset.path)
        : undefined;
      const replaced = await withRetry(
        () => deps.replaceFile(match.id, file, { doOCR: false, extractedText }),
        deps,
      );
      out.push(replaced);
    }
    if (fresh.length > 0) {
      const files = await Promise.all(fresh.map((a) => toUploadFile(a, deps)));
      const extractedTexts: Record<string, string> = {};
      for (const asset of fresh) {
        const textAsset = textByPdf.get(asset.filename);
        if (textAsset) extractedTexts[asset.filename] = await deps.readTextFile(textAsset.path);
      }
      // Same empty-entry hazard as the create path — see `splitEmptyTexts`.
      const { supplied, emptyFilenames } = splitEmptyTexts(extractedTexts);
      const created = await withRetry(
        () =>
          deps.uploadFiles(backendId, files, {
            role: group.role,
            doOCR: false,
            extractedTexts: supplied,
          }),
        deps,
      );
      await settleEmptyTexts(created, fresh, emptyFilenames, deps);
      out.push(...created);
    }
  }
  return out;
}

/**
 * Adopt each connected parent's post-write state into that parent's local mirror.
 *
 * **Why this is not optional.** `POST /api/relations/connect` fires a Postgres
 * trigger that rewrites the parent's `childrenIn*` counts and **bumps the
 * parent's `version`** — once per edge. So connecting a child silently
 * invalidates the parent's mirrored version, and the parent's next `PATCH`
 * (an ordinary metadata edit) fails with `409 Version conflict`. Live-verified:
 * `PATCH` at `expectedVersion: 0` right after a connect → `409 current 1`.
 *
 * The connect response carries the authoritative post-trigger version, so this
 * needs no re-read — which matters, because the relation edge is CDC-lagged
 * *independently* of the item document, so reading it back would not work
 * anyway (see `dto.ts` {@link RelationWriteResult}).
 *
 * Only parents the archive tracks locally have a mirror to update; a parent that
 * exists solely on the backend is skipped. Failures are logged and swallowed —
 * the item is already uploaded, and a stale parent mirror is a recoverable
 * inconvenience (the next sync fixes it), not a reason to fail the upload.
 *
 * `domain/sync.resolveVersion` guards the write so a version never moves
 * backwards, which keeps this correct when several children in one batch connect
 * under the same parent and the responses are applied out of order.
 */
export async function applyParentStates(
  states: RelationWriteResult[],
  deps: UploadDeps,
): Promise<void> {
  if (states.length === 0) return;

  let tracked: Item[];
  try {
    tracked = await deps.listItems();
  } catch (err) {
    logger.warn(
      "upload",
      "Could not list local items to refresh connected parents' versions.",
      err,
    );
    return;
  }

  const byBackendId = new Map<string, Item>();
  for (const item of tracked) {
    if (item.backendId) byBackendId.set(item.backendId, item);
  }

  for (const state of states) {
    const parent = byBackendId.get(state.parentId);
    if (!parent) continue; // backend-only parent — nothing local to update

    try {
      const mirror = await deps.readMirror(parent);
      if (!mirror) continue; // never uploaded from here — no mirror to correct
      const version = resolveVersion(mirror.version, state.version);
      if (version === mirror.version) continue; // already current

      await deps.writeMirror(parent, {
        ...mirror,
        version,
        metadata: {
          ...mirror.metadata,
          childrenInDrafts: state.childrenInDrafts,
          childrenInRecords: state.childrenInRecords,
        },
        syncedAt: deps.now(),
      });
      logger.info(
        "upload",
        `Adopted parent ${state.parentId}'s post-connect version ${version}.`,
      );
    } catch (err) {
      logger.warn(
        "upload",
        `Could not refresh the mirrored version of parent ${state.parentId}.`,
        err,
      );
    }
  }
}

/**
 * Connect the item under each linked parent (one call each). Collects per-parent
 * failures without aborting — the record is already uploaded — and returns each
 * successful connect's parent state so the caller can refresh that parent's
 * mirrored version (see {@link ItemUploadResult.parentStates}).
 */
async function connectParents(
  childId: string,
  parentIds: string[],
  deps: UploadDeps,
): Promise<{
  errors: Array<{ parentId: string; message: string }>;
  states: RelationWriteResult[];
}> {
  const errors: Array<{ parentId: string; message: string }> = [];
  const states: RelationWriteResult[] = [];
  for (const parentId of parentIds) {
    try {
      const state = await withRetry(() => deps.connectParent(parentId, childId), deps);
      // Tolerate a version skew: this endpoint returned `204` + an empty body
      // before 2026-08-07, which decodes to `undefined`. The app is installed on a
      // workstation while the backend is deployed independently, so a newer app
      // talking to an older backend is a real scenario — and pushing `undefined`
      // in here would crash whoever reads `state.version` rather than simply
      // losing an optimisation.
      if (state && typeof state.version === "number") states.push(state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("upload", `Failed to link ${childId} under parent ${parentId}.`, err);
      errors.push({ parentId, message });
    }
  }
  return { errors, states };
}

/** Fold a thrown error into the right {@link ItemUploadResult} outcome. */
function mapUploadError(
  itemId: string,
  backendId: string | null,
  err: unknown,
  fieldKeys: string[],
): ItemUploadResult {
  if (err instanceof ApiError) {
    if (err.kind === "forbidden" || err.kind === "unauthorized") {
      return result(itemId, "forbidden", {
        backendId,
        message: "This token lacks write access to the backend.",
      });
    }
    if (err.kind === "conflict") {
      // A create hit an existing deterministic id (COBISS), or a PATCH lost the
      // optimistic-concurrency race.
      return result(itemId, backendId ? "error" : "duplicate", {
        backendId,
        message: backendId
          ? "The record changed on the server since it was last synced — refresh and retry."
          : "A record with this identifier already exists on the backend.",
      });
    }
    if (err.kind === "bad_request") {
      return result(itemId, "error", {
        backendId,
        fieldErrors: mapValidationErrors(err.body, fieldKeys),
        message: err.message,
      });
    }
    return result(itemId, "error", { backendId, message: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error("upload", `Unexpected error uploading ${itemId}.`, err);
  return result(itemId, "error", { backendId, message });
}

// ─── batch driver ──────────────────────────────────────────────────────────

/** A phase signal for the live progress feed (the Upload tab). */
export type UploadPhase = "start" | "created" | "assets" | "linked" | "done";

export interface UploadProgress {
  itemId: string;
  phase: UploadPhase;
  /** 1-based index of this item in the run. */
  index: number;
  total: number;
}

export interface BatchUploadResult {
  results: ItemUploadResult[];
  /** True when every attempted item reached `uploaded` — the caller then
   * archives the batch READ-ONLY and releases its items. */
  allUploaded: boolean;
}

export interface UploadBatchOptions {
  /** Resolve the per-item publish context (batch defaults/overrides + form
   * values + readiness). Called once per item, in order. */
  resolveContext: (item: Item) => UploadItemContext | Promise<UploadItemContext>;
  /** Progress callback for the live feed (optional). */
  onProgress?: (progress: UploadProgress) => void;
  /** Override injectable deps (tests / stubbing Tauri). */
  deps?: Partial<UploadDeps>;
}

/**
 * Upload a batch's items as one run: sequentially publish each item (create or
 * replace), reporting progress and collecting per-item results. Sequential by
 * design — one batch runs at a time and the backend/disk work is heavy — so a
 * failure on one item never corrupts another, and the caller gets a complete
 * per-item outcome list. Does NOT archive the batch (store coordination); the
 * caller archives on `allUploaded`.
 */
export async function uploadBatch(
  items: Item[],
  options: UploadBatchOptions,
): Promise<BatchUploadResult> {
  const results: ItemUploadResult[] = [];
  const total = items.length;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const index = i + 1;
    options.onProgress?.({ itemId: item.id, phase: "start", index, total });
    const ctx = await options.resolveContext(item);
    const res = await uploadItem(item, ctx, options.deps);
    results.push(res);
    options.onProgress?.({ itemId: item.id, phase: "done", index, total });
  }
  return { results, allUploaded: results.every((r) => r.status === "uploaded") };
}
