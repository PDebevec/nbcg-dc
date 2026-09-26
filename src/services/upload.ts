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
  deleteItems as apiDeleteItems,
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
import { getRecordSchemaV2 } from "./api/schemaV2";
import { deterministicItemId } from "./api/deterministicId";
import { findById, hitToRemote, type SearchHit } from "./api/search";
import { listIndex, readItemMetadata, writeItemMetadata } from "./indexing";
import type {
  CreatedItemEntity,
  CreateItemDto,
  FileAttachment,
  RelationWriteResult,
  UpdateItemDto,
} from "./api/dto";
import type { ItemType, VisibilityStatus } from "@domain/enums";
import type { RecordSchemaV2 } from "@domain/schema";
import { pruneForUpload } from "@domain/schema-values";
import type {
  LocalMetadataFile,
  RecordMetadata,
  RecordMetadataInput,
} from "@domain/metadata";
import type { Item } from "@domain/item";
import type { DiscoveredAsset } from "@domain/files";
import { isMangledFilename, isSameUploadedFilename } from "@domain/naming";
import { missingParentMessage, type MissingParentNames } from "@domain/parent";
import { resolveVersion } from "@domain/sync";
import {
  changedMetadata,
  isUploadable,
  keysToClear,
  mapValidationErrors,
  metadataValidationFailure,
  parentNotFoundIds,
  planItemUpload,
  textQualityWarnings,
  validationFieldErrors,
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
  /**
   * Resolve the record an already-existing create-collision (409) hit, given
   * **the COBISS id that caused it**. Default:
   * {@link resolveExistingRecordWith} against the real search/COBISS reads.
   * Lets a collision reuse the known id (and version) instead of ever
   * double-creating.
   *
   * Takes the id, deliberately NOT the {@link Item}. `item.catalogueId` is the
   * SQLite index row's copy (`indexing.ts` — `catalogueId: dto.cobissId`),
   * refreshed only by a folder rescan, so it lags the value the operator just
   * typed into the form; the id that actually produced the `409` is the one
   * this run sent, i.e. {@link collidingCobissId}. Passing the item here let
   * the resolver look up a *different* record than the one that collided —
   * and because `hitToExisting` then verified that hit against the same stale
   * value, the mismatch guard passed on an unrelated record, which went on to
   * be PATCHed with this item's metadata and have this batch's files attached.
   * Narrowing the parameter is what makes that class of bug unexpressible.
   */
  resolveExistingRecord: (cobissId: string | null) => Promise<ExistingRecord | null>;
  /** Move the item's folder `/unprocessed` → `/processed` (native). */
  moveToProcessed: (item: Item) => Promise<void>;
  /** The tracked local items, used to map a connected `parentId` back to a
   * locally-mirrored item so its bumped version can be adopted (see
   * {@link applyParentStates}). */
  listItems: () => Promise<Item[]>;
  /** Fetch (cached) the v2 record schema, to prune metadata. */
  getSchema: () => Promise<RecordSchemaV2>;
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
    resolveExistingRecord: (cobissId) =>
      resolveExistingRecordWith(cobissId, {
        findById: (id) => findById(id),
        previewCobiss: (id) => previewCobiss(id),
      }),
    moveToProcessed: async (item) => {
      await ipc.fs.moveToProcessed(item.id);
    },
    listItems: () => listIndex(),
    getSchema: () => getRecordSchemaV2(),
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
 * store (`stores/useMetadata`). */
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
  /** Whether the metadata validates (caller computes via the metadata store's save check). */
  metadataReady: boolean;
  /** The chosen primary-thumbnail filename, or null. */
  primaryThumbnail: string | null;
  /** Names of batch parents that are not on the backend (a blocker). */
  missingParents?: MissingParentNames;
  /** Schema keys the operator emptied; a re-upload clears them on the backend. */
  emptied?: string[];
}

export type ItemUploadStatus =
  /** Created/replaced + assets + links + write-through all succeeded. */
  | "uploaded"
  /** A hard gate stopped it before any backend call (see `blockers`). */
  | "blocked"
  /**
   * No valid session — the request reached the backend without an acceptable
   * bearer token (`401`).
   *
   * Deliberately distinct from {@link ItemUploadStatus} `"forbidden"`: the two
   * are fixed in completely different places. A `401` means Settings has no
   * (or bad) Keycloak credentials, so `keycloakAuth.getValidAccessToken()`
   * returned `null` and no `Authorization` header was ever sent. A `403` means
   * the credentials worked and the *account* lacks a manage scope. Collapsing
   * them — as this did until 2026-09-20 — reports an unconfigured app as a
   * permissions problem and sends the operator to Keycloak to check roles that
   * were never the cause.
   */
  | "unauthenticated"
  /** The account lacks the required manage scope (`403`). */
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
  /**
   * Whether **this run** created the record at {@link backendId} — i.e.
   * `createOnBackend` returned it during this very `uploadItem` call.
   *
   * Deliberately NOT inferable from `backendId`. That field is seeded from
   * `item.backendId`, a *persistent local* value read back from the
   * `metadata.json` mirror; it survives across sessions and means only "this
   * item is linked to a backend record", never "this run made it". Inferring
   * creation from it is how a failed replace, a `blocked` item, or a `401` on
   * an item uploaded weeks ago all end up looking like fresh half-made
   * records.
   *
   * That distinction is load-bearing: {@link removableBackendIds} gates a
   * **hard, permanent** `DELETE /api/items` against the live public catalogue
   * on this flag. It is therefore set at exactly the two sites that create —
   * the create branch of {@link uploadItem} and {@link recreateOrphaned} —
   * and defaults to `false` everywhere else.
   */
  created: boolean;
  /** Hard gates (only on `blocked`). */
  blockers: UploadBlocker[];
  /** Soft warnings (pre-upload OCR + post-upload text quality). */
  warnings: UploadWarning[];
  /** Backend validation errors mapped onto fields (on a `400`). */
  fieldErrors: BackendFieldError[];
  /** The backend refused the metadata (`METADATA_VALIDATION_FAILED`). */
  metadataRejected: boolean;
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
  /** Parents the backend said no longer exist (`PARENT_NOT_FOUND`). */
  missingParentIds: string[];
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
    // Safe default: a result that does not go out of its way to say "this run
    // created me" is never eligible for close-time deletion.
    created: false,
    blockers: [],
    warnings: [],
    fieldErrors: [],
    metadataRejected: false,
    relationErrors: [],
    parentStates: [],
    missingParentIds: [],
    message: null,
    ...extra,
  };
}

/**
 * What *this run* actually created on the backend, recorded the moment it
 * happens so the outer `catch` can still report it.
 *
 * Mutable and threaded down on purpose. A create can happen several frames
 * deep — the create branch of {@link uploadItem}, or {@link recreateOrphaned}
 * reached from a replace whose `PATCH` 404'd — while the failure that strands
 * the new record is mapped back up in `uploadItem`'s own `catch`. There is no
 * other way for that `catch` to tell a record this run made from one the item
 * has been linked to since an earlier session (see
 * {@link ItemUploadResult.created}).
 */
interface RunCreation {
  /** True once `createOnBackend` has returned a record in this run. */
  created: boolean;
  /**
   * The id that create returned.
   *
   * Tracked separately from `uploadItem`'s hoisted `backendId` because the two
   * can disagree: an orphaned replace re-created under a freshly minted
   * (non-COBISS) id leaves the hoisted value pointing at the id the backend
   * has already authoritatively 404'd. Reporting that dead id would send
   * close-time cleanup at a record that no longer exists — and `DELETE
   * /api/items` is all-or-nothing, so one such id fails the whole request and
   * the genuinely half-made records in the same batch survive.
   */
  backendId: string | null;
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

/**
 * The retry rule for a **file transfer**: same as {@link isTransient}, minus
 * timeouts.
 *
 * A dropped connection is worth another go. A timeout is not: the deadline is
 * already derived from the payload (`api/files.transferTimeoutMs`), so a
 * second attempt sends the same bytes against the same clock and fails the
 * same way — it just does it three times. That is what turned one 105 MB web
 * PDF into ~92 seconds of re-uploading before the batch was told anything.
 */
function isTransientTransfer(err: unknown): boolean {
  return isTransient(err) && !(err instanceof ApiError && err.kind === "timeout");
}

/** Run `fn`, retrying transient failures with linear backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  deps: UploadDeps,
  options: {
    retries?: number;
    /** Which failures to repeat (default {@link isTransient}). */
    retryable?: (err: unknown) => boolean;
  } = {},
): Promise<T> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryable = options.retryable ?? isTransient;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !retryable(err)) throw err;
      await deps.sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * {@link withRetry} for the calls that carry a payload — the file transfers and
 * the full-text writes, i.e. exactly the ones whose deadline is derived from
 * their own size.
 */
function withTransferRetry<T>(fn: () => Promise<T>, deps: UploadDeps): Promise<T> {
  return withRetry(fn, deps, { retryable: isTransientTransfer });
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

/** The schema-known, non-blank metadata to send, given the working values. */
async function prunedMetadata(
  values: RecordMetadataInput,
  deps: UploadDeps,
): Promise<{ metadata: RecordMetadataInput; fieldKeys: string[] }> {
  const schema = await deps.getSchema();
  return {
    metadata: pruneForUpload(schema, values),
    fieldKeys: schema.fields.map((f) => f.key),
  };
}

/**
 * The COBISS id that a create `409` was about — i.e. the one this run actually
 * put on the wire.
 *
 * `pruned` is literally the `metadata` the create sent, and the backend only
 * ever derives an explicit (collidable) item id from `sanitizedMetadata.cobissId`
 * (`items.service.create`). So a collision is always about *this* value.
 *
 * `item.catalogueId` is the fallback, not the source: it is the SQLite index
 * row's copy (`indexing.ts` — `catalogueId: dto.cobissId ?? null`), rewritten
 * only by a folder rescan. Two ordinary situations made it wrong at exactly
 * the moment it was needed:
 *  - a COBISS id typed **this session** — `useMetadata.saveItem` refreshes only
 *    the row's `title`, and the debounced rescan lands after `upload()` has
 *    captured its members — so `catalogueId` is still `null` and adoption
 *    never fired at all, on the very press this branch exists to fix;
 *  - a **corrected** COBISS id (`111` → `222`) — the create collides on
 *    `id(222)` while `catalogueId` still reads `111`, so the resolver fetched
 *    the record for `111` and `hitToExisting` verified it against `111` too.
 *    The guard passed on an unrelated record, which was then PATCHed with this
 *    item's metadata and given this batch's files.
 *
 * It stays as the fallback because a re-upload whose form never loaded the
 * field (schema without `cobissId`, so `pruneForUpload` drops it) still has a
 * genuine indexed id, and using it is strictly better than resolving nothing.
 */
function collidingCobissId(pruned: RecordMetadataInput, item: Item): string | null {
  // `pruneForUpload` drops empty values, so a present key is a non-empty string;
  // the type guard is belt-and-braces against a non-string sneaking through an
  // unusual schema.
  const sent = (pruned as { cobissId?: unknown }).cobissId;
  if (typeof sent === "string" && sent !== "") return sent;
  return item.catalogueId;
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

/**
 * The links a create made through `parentIds`, or null when the response does
 * not report them (a backend without `parentIds`) and the upload has to
 * connect as before.
 */
function linkedByCreate(created: CreatedItemEntity, ctx: UploadItemContext): RelationWriteResult[] | null {
  if (created.parents) return created.parents;
  return ctx.parentIds.length === 0 ? [] : null;
}

/**
 * Finish an upload once the record and its assets are already on the
 * backend: connect parents, adopt their bumped versions, reposition the
 * folder to `/processed`, and build the `"uploaded"` result.
 *
 * Shared tail for all three paths that end in a successful write — the
 * create branch of {@link uploadItem}, {@link replaceOnBackend}, and
 * {@link recreateOrphaned} (an orphaned replace re-created as a fresh
 * record). It used to be copied into each; extracted so the parent-linking
 * and move-to-processed behaviour can't drift between them.
 *
 * Links parents only when the create did not already (see `linkedOnCreate`).
 */
async function finishUpload(
  item: Item,
  backendId: string,
  ctx: UploadItemContext,
  deps: UploadDeps,
  warnings: UploadWarning[],
  run: RunCreation,
  /** The links a create made itself (`parentIds`), already adopted — null
   * when this path still has to connect (re-upload, takeover). */
  linkedOnCreate: RelationWriteResult[] | null = null,
): Promise<ItemUploadResult> {
  let relationErrors: Array<{ parentId: string; message: string }> = [];
  let parentStates: RelationWriteResult[];
  if (linkedOnCreate) {
    parentStates = linkedOnCreate;
  } else {
    // Link parents (idempotent server-side); a per-parent failure doesn't undo
    // the upload — record it and continue. Each success reports the parent's
    // new version, which the caller needs to keep that parent's mirror usable.
    const connected = await connectParents(backendId, ctx.parentIds, deps);
    relationErrors = connected.errors;
    parentStates = connected.states;
    // Each connect bumped the parent's version server-side; adopt it now or the
    // parent's next PATCH 409s. Never throws — see `applyParentStates`.
    await applyParentStates(parentStates, deps);
  }

  // Reposition to `/processed` on first upload (a replace already lives there).
  if (item.root === "unprocessed") {
    try {
      await deps.moveToProcessed(item);
    } catch (err) {
      logger.warn("upload", `Uploaded ${item.id} but failed to move to /processed.`, err);
    }
  }

  // `created` is carried onto the success result too. `removableBackendIds`
  // drops `uploaded` before it ever looks at the flag, so nothing depends on
  // it here — but a field documented as "this run created this record" must
  // not quietly read `false` on the one outcome where it is most obviously
  // true.
  return result(item.id, "uploaded", {
    backendId,
    created: run.created,
    warnings,
    relationErrors,
    parentStates,
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
    missingParents: ctx.missingParents,
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
  // Seeded "nothing created yet". Note what `backendId` above already is at
  // this point: for a replace it is the *persisted* link from an earlier
  // session, which is exactly why creation cannot be inferred from it.
  const run: RunCreation = { created: false, backendId: null };
  // `fieldKeys` is hoisted for validation-error mapping; populated once the
  // schema is fetched (inside the try, so a schema-fetch failure folds into an
  // error result rather than escaping and crashing the batch).
  let fieldKeys: string[] = [];
  // Hoisted out of the `try` so the `catch` can hand them to `mapUploadError`.
  // A failed upload's warnings are not decoration: `"adopted-existing"` is the
  // second guard that stops close-time cleanup hard-deleting a record this
  // batch merely adopted, and it can only do that job if it survives onto a
  // non-`uploaded` result. The OCR and mangled-filename warnings the operator
  // needs in order to know *what* to fix rode on the same list.
  const warnings: UploadWarning[] = [...plan.warnings];
  // The links a create made itself (`parentIds`) — passed to `finishUpload` so
  // it does not connect a second time. Stays null on the replace path.
  let linked: RelationWriteResult[] | null = null;

  try {
    // Resolve the working metadata (ctx override, else the folder mirror) and the
    // schema-valid subset to send. Inside the try: `getRecordSchemaV2` rethrows on a
    // cold cache + backend error, and that must become an error result.
    const mirror = await deps.readMirror(item);
    const workingValues = ctx.metadata ?? mirror?.metadata ?? {};
    const pruneResult = await prunedMetadata(workingValues, deps);
    const pruned = pruneResult.metadata;
    fieldKeys = pruneResult.fieldKeys;

    let version: number | null;
    let mirrorMetadata: RecordMetadata;

    if (plan.mode === "create") {
      let created: CreatedItemEntity;
      try {
        created = await createOnBackend(
          {
            visibilityStatus: ctx.visibility,
            targetState: ctx.targetState,
            metadata: pruned,
            parentIds: ctx.parentIds,
          },
          deps,
        );
      } catch (err) {
        if (!(err instanceof ApiError) || err.kind !== "conflict") throw err;

        // The id this run sent, not the item's indexed one — `collidingCobissId`
        // documents the two ways the indexed copy is wrong exactly here.
        const adopted = await adoptExistingRecord(
          item,
          collidingCobissId(pruned, item),
          deps,
        );
        if (!adopted) {
          return result(item.id, "duplicate", {
            backendId: null,
            warnings,
            message:
              "Already on the backend, but its current state could not be read — run Sync, then upload again.",
          });
        }

        if (
          adopted.targetState !== ctx.targetState ||
          adopted.visibilityStatus !== ctx.visibility
        ) {
          warnings.push({
            code: "adopted-existing",
            message: `Adopted the existing ${adopted.targetState} on the backend; this batch's publish and visibility settings were not applied to it.`,
          });
        } else {
          warnings.push({
            code: "adopted-existing",
            message: "Adopted the record that already existed on the backend.",
          });
        }

        const adoptedCtx: UploadItemContext = {
          ...ctx,
          targetState: adopted.targetState ?? ctx.targetState,
          visibility: adopted.visibilityStatus ?? ctx.visibility,
        };
        // `mode` flips too: the plan was assembled as a create, and leaving it
        // saying "create" would mislead anyone reading the plan downstream even
        // though `replaceOnBackend` only reads `backendId`.
        const adoptedPlan: ItemUploadPlan = {
          ...plan,
          mode: "replace",
          backendId: adopted.backendId,
        };
        // Hoisted `backendId` must reflect the adopted record from here on: a
        // failure inside `replaceOnBackend` (a PATCH 409, a 403, an exhausted
        // retry, a `pushReplaceAssets` failure) rejects up to this function's own
        // `catch`, and `mapUploadError` reports `duplicate` with no id whenever
        // `backendId` still reads the pre-adoption `null` — masking a real,
        // already-identified record as an unresolvable collision.
        backendId = adopted.backendId;
        // `await` (not a bare return): this statement is textually inside a
        // `catch`, but that `catch` is itself nested inside `uploadItem`'s outer
        // `try`. A bare `return replaceOnBackend(...)` settles this function's
        // promise directly from the returned promise, bypassing the outer
        // `catch` — so any rejection here would reject `uploadItem` itself
        // instead of folding into a mapped `ItemUploadResult`, which in turn
        // rejects `uploadBatch` and discards every already-uploaded item's
        // result in the run.
        // `run` stays untouched here on purpose: adoption did NOT create
        // anything — it attached to a record that already existed, possibly a
        // librarian's own. (The `"adopted-existing"` warning pushed above is
        // the second, independent guard against ever deleting it.)
        return await replaceOnBackend(
          item,
          adoptedCtx,
          adoptedPlan,
          pruned,
          adopted,
          deps,
          warnings,
          run,
          { suppressVisibility: true, keepEmptied: true },
        );
      }
      backendId = created.id;
      // The create site. From here on this run owns the record: if anything
      // below fails, close-time cleanup may delete it.
      run.created = true;
      run.backendId = created.id;
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

      // The create linked the parents and bumped their versions: adopt them now,
      // before the files — if an asset fails, the links still exist.
      linked = linkedByCreate(created, ctx);
      if (linked) await applyParentStates(linked, deps);

      const attachments = await uploadCreateAssets(backendId, plan, deps, warnings);
      warnings.push(...textQualityWarnings(attachments));
    } else {
      // Replace (re-upload) — stable id, stays in `/processed`.
      return await replaceOnBackend(item, ctx, plan, pruned, mirror, deps, warnings, run);
    }

    return await finishUpload(item, backendId, ctx, deps, warnings, run, linked);
  } catch (err) {
    // Prefer the id this run actually minted. They agree on the create branch;
    // they diverge only when `recreateOrphaned` replaced a 404'd link with a
    // fresh id, and there the hoisted value is the dead one (see
    // `RunCreation.backendId`).
    return mapUploadError(
      item.id,
      run.backendId ?? backendId,
      err,
      fieldKeys,
      run.created,
      warnings,
    );
  }
}

/** Options that tune how {@link replaceOnBackend} PATCHes, without changing
 * what it writes through to the local mirror. */
interface ReplaceOnBackendOptions {
  /** Never let `visibilityStatus` onto the PATCH body, no matter what `ctx` or
   * `mirror` say. Set by the adoption path in {@link uploadItem}: the archive
   * did not create the record it just adopted, so its own batch-level
   * publish/visibility settings must never reach that record's PATCH — not
   * even when the backend's visibility happens to be unknown (`null` from a
   * search hit that omitted the field, {@link hitToRemote}) and would
   * otherwise take the "unknown → treat as changed" branch below. */
  suppressVisibility?: boolean;
  /** Never clear keys (a taken-over record: the operator never saw its fields). */
  keepEmptied?: boolean;
}

/**
 * Replace (re-upload) path of {@link uploadItem} — stable id, stays in
 * `/processed`. Extracted so a later step can fall through into it from a
 * failed create.
 */
async function replaceOnBackend(
  item: Item,
  ctx: UploadItemContext,
  plan: ItemUploadPlan,
  pruned: RecordMetadataInput,
  mirror: LocalMetadataFile | null,
  deps: UploadDeps,
  warnings: UploadWarning[],
  run: RunCreation,
  options: ReplaceOnBackendOptions = {},
): Promise<ItemUploadResult> {
  const backendId = plan.backendId as string;
  if (!mirror || mirror.version == null) {
    // A connected item with no local version can't do optimistic-concurrency;
    // don't silently write an unconfirmed mirror — ask for a re-sync.
    //
    // `created` is left at its `false` default, and that is the whole point:
    // NOT ONE backend call has been made in this run, yet `backendId` here is
    // a live, possibly curated record from an earlier session. This is the
    // sharpest case the `created` flag exists to stop.
    return result(item.id, "error", {
      backendId,
      // Carried for the same reasons `mapUploadError` carries them: the
      // operator's pre-upload notes survive the failure, and an
      // `"adopted-existing"` marker reaches `removableBackendIds`. This branch
      // is reachable *after* an adoption only if the resolved record's version
      // vanished, but a result that silently dropped the marker would be one
      // more place where the cleanup exclusion cannot fire.
      warnings,
      message:
        "Local sync state is missing this item's version — re-sync it (Sync) before re-uploading.",
    });
  }
  const prevMeta = (mirror.metadata ?? {}) as RecordMetadata;
  const cleared = options.keepEmptied ? [] : keysToClear(ctx.emptied ?? [], prevMeta);
  let version: number;
  try {
    version = await patchOnBackend(item, backendId, pruned, ctx, mirror, deps, options, cleared);
  } catch (err) {
    // A PATCH 404 comes from Postgres, not the CDC-lagged search index
    // (backend items.service.ts:190-196), so it is authoritative: the record
    // really is gone — deleted on the website after we linked to it. Without
    // this branch the item is permanently stuck, because `uploadMode()` returns
    // "replace" for as long as `backendId` is set and nothing ever clears it.
    //
    // Re-creating is safe precisely because the absence is authoritative. For a
    // COBISS item the backend regenerates the SAME deterministic id, so the
    // local link stays valid; for a non-COBISS item it mints a new one and
    // `writeThrough` records it.
    if (err instanceof ApiError && err.kind === "not_found") {
      // `await` (not a bare return): this `catch` is nested inside
      // `replaceOnBackend`, which is itself called from `uploadItem`'s own
      // `try` (directly, or via the adoption path's `catch`). A bare `return
      // recreateOrphaned(...)` would settle `replaceOnBackend`'s promise
      // directly from the returned promise, bypassing every enclosing `catch`
      // — so a later rejection here would reject `uploadItem` itself instead
      // of folding into a mapped `ItemUploadResult`, which in turn rejects
      // `uploadBatch` and discards every already-uploaded item's result in
      // the run.
      return await recreateOrphaned(item, ctx, plan, pruned, mirror, deps, warnings, run);
    }
    throw err;
  }
  const mirrorMetadata: RecordMetadata = { ...prevMeta, ...pruned };
  for (const key of cleared) delete mirrorMetadata[key];

  // Persist the confirmed metadata/version FIRST (the PATCH already
  // succeeded), then reconcile files. Only re-push blobs when a derived file
  // actually changed (`flags.reupload`), and only the OCR text — no blob —
  // when that's *all* that changed (`flags.reuploadTextOnly`); a
  // metadata-only edit still uploads any file the backend is missing, but
  // never re-PUTs unchanged ones.
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
    replaceKindFor(item.flags),
    warnings,
  );
  warnings.push(...textQualityWarnings(attachments));

  return await finishUpload(item, backendId, ctx, deps, warnings, run);
}

/** A backend record that already exists at the id this item would have created.
 * `version` is non-null by construction — a record we cannot do optimistic
 * concurrency against is not adoptable, so the resolver returns null instead. */
export interface ExistingRecord {
  id: string;
  version: number;
  targetState: ItemType;
  visibilityStatus: VisibilityStatus | null;
  metadata: RecordMetadata;
}

/** The two reads `resolveExistingRecordWith` needs, injectable for tests. */
export interface ResolveExistingDeps {
  findById: (id: string) => Promise<SearchHit | null>;
  previewCobiss: (cobissId: string) => Promise<{ itemId?: string | null }>;
}

/** Project a search hit into an {@link ExistingRecord}, but ONLY if it really is
 * this item's record. See `services/api/deterministicId` for why the check is
 * not optional. */
function hitToExisting(
  hit: SearchHit | null,
  expectCobissId: string,
): ExistingRecord | null {
  if (!hit) return null;
  const remote = hitToRemote(hit);
  if (remote.version === null) return null;
  if (remote.targetState === null) return null;
  const cobissId = (remote.metadata as { cobissId?: unknown }).cobissId;
  if (cobissId !== expectCobissId) return null;
  return {
    id: remote.id,
    version: remote.version,
    targetState: remote.targetState,
    visibilityStatus: remote.visibilityStatus,
    metadata: remote.metadata,
  };
}

/**
 * Find the record a create-`409` collided with.
 *
 * `cobissId` must be the id **this run actually sent** ({@link
 * collidingCobissId}) — never the item's indexed `catalogueId`. Both the
 * lookup and `hitToExisting`'s verification key off this one value, so a stale
 * input does not merely miss: it looks up the wrong record and then verifies
 * that record against the same wrong input, which passes.
 *
 * Fast path: compute the id locally and read it back. Offline-capable and
 * instant. Fallback: ask the backend what id it would use, which costs a
 * COBISS upstream round-trip — used only when the fast path does not verify,
 * i.e. when the backend's derivation has drifted from our port.
 *
 * `null` is a legitimate answer (CDC lag, or a genuinely unresolvable id) and
 * the caller degrades to a `duplicate` outcome rather than failing.
 */
export async function resolveExistingRecordWith(
  cobissId: string | null,
  deps: ResolveExistingDeps,
): Promise<ExistingRecord | null> {
  if (!cobissId) return null;

  const computed = await deterministicItemId(cobissId).catch(() => null);
  if (computed) {
    const hit = await deps.findById(computed).catch(() => null);
    const found = hitToExisting(hit, cobissId);
    if (found) return found;
  }

  const previewed = await deps
    .previewCobiss(cobissId)
    .then((p) => p.itemId ?? null)
    .catch(() => null);
  if (!previewed || previewed === computed) return null;

  const hit = await deps.findById(previewed).catch(() => null);
  return hitToExisting(hit, cobissId);
}

/**
 * Adopt the record a create-`409` collided with.
 *
 * Pulls the backend's authoritative state down into the mirror FIRST — id,
 * version, targetState, visibilityStatus and the complete metadata — so that
 * the replace path which follows diffs the operator's values against what the
 * backend really holds, and sends only genuine changes. This is what keeps the
 * backend the single source of truth through a path that ends in a write.
 *
 * The batch's own `targetState`/`visibilityStatus` are deliberately NOT
 * applied: the archive did not create this record and must not silently
 * re-publish or hide one somebody else curated. The caller warns instead.
 *
 * `cobissId` is the id this run sent, not the item's indexed one — see
 * {@link collidingCobissId} for why that distinction decides *which record*
 * gets adopted.
 *
 * `null` when the record could not be resolved (CDC lag, or a drifted id
 * derivation) — the caller then degrades to today's `duplicate` outcome.
 */
async function adoptExistingRecord(
  item: Item,
  cobissId: string | null,
  deps: UploadDeps,
): Promise<LocalMetadataFile | null> {
  const existing = await deps.resolveExistingRecord(cobissId).catch(() => null);
  if (!existing) return null;

  // One resolution of "the backend didn't tell us its visibility", used by BOTH
  // local stores. A search hit may omit `visibilityStatus` (`hitToRemote`
  // yields `null`), and the SQLite row's `UploadRecordDto.visibilityStatus` is
  // non-null, so *something* has to be invented for it. Inventing it twice is
  // how the `metadata.json` mirror came to say `null` while the index row said
  // `PRIVATE` for the very same unknown — and, worse, how the batch's own
  // visibility then leaked back in: with a `null` here, the caller's
  // `adopted.visibilityStatus ?? ctx.visibility` fell through to the batch
  // setting, which `replaceOnBackend`'s write-through persisted as if it were
  // the record's real state — a value adoption deliberately never pushed.
  //
  // `PRIVATE` is the conservative invention: a later run comparing against it
  // can only ever *reveal* a record it already intended to publish, never hide
  // one somebody curated.
  const visibilityStatus = existing.visibilityStatus ?? "PRIVATE";

  const mirror: LocalMetadataFile = {
    backendId: existing.id,
    version: existing.version,
    targetState: existing.targetState,
    visibilityStatus,
    metadata: existing.metadata,
    syncedAt: deps.now(),
  };
  await writeThrough(item, deps, {
    backendId: existing.id,
    version: existing.version,
    targetState: existing.targetState,
    visibility: visibilityStatus,
    metadata: existing.metadata,
  });
  return mirror;
}

/**
 * Re-create a record the backend has authoritatively lost, then finish the
 * upload as a create (assets, parents, move). See the caller for why this
 * cannot double-create.
 *
 * **Publish state comes from the mirror, not the batch.** This is a
 * restoration, not a publication: the record existed, the operator is
 * re-uploading files to it, and the batch's `targetState`/`visibility` are
 * whatever this run's defaults happen to be — typically DRAFT/PRIVATE for
 * routine work. Using them brought a PUBLIC RECORD back as a PRIVATE DRAFT,
 * silently unpublishing material that had been on the live catalogue, on a
 * path the operator experiences as "the upload retried and worked". The
 * mirror holds the last state the archive actually observed on the backend
 * (write-through on every upload, and `sync` refreshes it), so it is the
 * closest thing to what was lost.
 *
 * `ctx` is still the fallback: a mirror written before `targetState` /
 * `visibilityStatus` existed, or one that never recorded them, leaves nothing
 * better to use.
 */
async function recreateOrphaned(
  item: Item,
  ctx: UploadItemContext,
  plan: ItemUploadPlan,
  pruned: RecordMetadataInput,
  mirror: LocalMetadataFile,
  deps: UploadDeps,
  warnings: UploadWarning[],
  run: RunCreation,
): Promise<ItemUploadResult> {
  warnings.push({
    code: "recreated-orphaned",
    message:
      "The linked record no longer exists on the backend — it was re-created from the local copy.",
  });
  const targetState = mirror.targetState ?? ctx.targetState;
  const visibility = mirror.visibilityStatus ?? ctx.visibility;
  const created = await createOnBackend(
    { targetState, visibilityStatus: visibility, metadata: pruned, parentIds: ctx.parentIds },
    deps,
  );
  // The second (and last) create site. The old link was authoritatively 404'd
  // and this record is brand new, so if the assets below fail there is nothing
  // here but a record this run stranded.
  run.created = true;
  run.backendId = created.id;
  await writeThrough(item, deps, {
    backendId: created.id,
    version: created.version,
    targetState,
    visibility,
    metadata: created.metadata,
  });
  const linked = linkedByCreate(created, ctx);
  if (linked) await applyParentStates(linked, deps);
  const attachments = await uploadCreateAssets(
    created.id,
    { ...plan, backendId: created.id },
    deps,
    warnings,
  );
  warnings.push(...textQualityWarnings(attachments));
  return await finishUpload(item, created.id, ctx, deps, warnings, run, linked);
}

// ─── backend steps ───────────────────────────────────────────────────────────

async function createOnBackend(
  dto: CreateItemDto,
  deps: UploadDeps,
): Promise<CreatedItemEntity> {
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
 *
 * `options.suppressVisibility` forces `visibilityChanged` to `false` — used by
 * the adoption path so the batch's visibility never overwrites a record the
 * archive did not create, regardless of whether the backend's own value is
 * known (see {@link ReplaceOnBackendOptions}).
 */
async function patchOnBackend(
  _item: Item,
  backendId: string,
  pruned: RecordMetadataInput,
  ctx: UploadItemContext,
  mirror: LocalMetadataFile,
  deps: UploadDeps,
  options: ReplaceOnBackendOptions = {},
  cleared: readonly string[] = [],
): Promise<number> {
  const prevMeta = (mirror.metadata ?? {}) as RecordMetadata;
  const changed = changedMetadata(pruned, prevMeta, cleared);
  const visibilityChanged = options.suppressVisibility
    ? false
    : mirror.visibilityStatus
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
    const attachments = await withTransferRetry(
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
      await withTransferRetry(() => deps.setFileText(attachment.id, text), deps);
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
      await withTransferRetry(() => deps.setFileText(attachments[i].id, ""), deps);
    } catch (err) {
      logger.warn(
        "upload",
        `Could not record the empty OCR result for "${sent[i].filename}".`,
        err,
      );
    }
  }
}

/** What `pushReplaceAssets` should do with an already-matched attachment,
 * derived from the item's persisted reupload flags
 * (`core::db::items::ReuploadKind` on the native side — see
 * `IndexedItemDto.reuploadTextOnly`). */
type ReplaceKind = "none" | "text-only" | "full";

function replaceKindFor(flags: Item["flags"]): ReplaceKind {
  if (!flags.reupload) return "none";
  return flags.reuploadTextOnly ? "text-only" : "full";
}

/**
 * Reconcile a re-upload's assets against what the backend already has, listing
 * once and matching by filename:
 *  - **missing** files are uploaded fresh (covers a new derived file, and
 *    recovery of a create whose asset step failed after the id was recorded);
 *  - **present** files are left alone when `kind === "none"` — a
 *    metadata-only re-upload (docs/tasks/07: "Metadata-only changes go via
 *    PATCH, not re-upload"), so it never re-PUTs identical bytes;
 *  - **present + `kind === "text-only"`** — only the paired OCR text is
 *    pushed (`PUT /files/:fileId/text`, no blob), for a reprocess that only
 *    re-ran OCR (`core::jobs::reupload_kind_for`). A cheaper path than a full
 *    replace, and the whole point of `reuploadTextOnly` existing;
 *  - **present + `kind === "full"`** — replaced in place (stable id), same
 *    as every `kind` used to mean before `reuploadTextOnly` existed.
 *
 * The paired OCR text rides along on a full replace (singular `extractedText`
 * — the backend wipes stored text and re-enqueues extraction if it's
 * omitted) and on a fresh upload (the per-file map). Returns the touched
 * attachments (for text-quality warnings) — a text-only push doesn't produce
 * one (`PUT /text` returns no classification), so it's a known gap that a
 * text-only re-upload never raises a post-push text-quality warning; not
 * worth an extra fetch to close.
 *
 * ⚠️ **Matching is mangling-tolerant, and must stay that way.** The backend
 * stores a non-ASCII multipart filename corrupted (see
 * `domain/naming.isSameUploadedFilename`), so a plain `stored === local` lookup
 * never matches Cyrillic material — every re-upload then took the "not on the
 * backend" branch and **added a duplicate attachment** instead of replacing in
 * place. Live-verified before the fix: two attachments after one re-upload of
 * `ОКТОИХ петогласник 2.pdf`.
 */
async function pushReplaceAssets(
  backendId: string,
  plan: ItemUploadPlan,
  deps: UploadDeps,
  kind: ReplaceKind,
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
      if (kind === "none") continue; // present + unchanged → leave it be
      if (kind === "text-only") {
        const textAsset = textByPdf.get(asset.filename);
        if (!textAsset) continue; // e.g. a thumbnail asset — nothing to push
        const text = await deps.readTextFile(textAsset.path);
        await withTransferRetry(() => deps.setFileText(match.id, text), deps);
        continue; // no blob PUT — the whole point of "text-only"
      }
      const file = await toUploadFile(asset, deps);
      const textAsset = textByPdf.get(asset.filename);
      const extractedText = textAsset
        ? await deps.readTextFile(textAsset.path)
        : undefined;
      const replaced = await withTransferRetry(
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
      const created = await withTransferRetry(
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
      // A parent that no longer exists is gone for the whole batch — let it
      // stop the run instead of listing it as one failed link.
      if (err instanceof ApiError && parentNotFoundIds(err.body)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("upload", `Failed to link ${childId} under parent ${parentId}.`, err);
      errors.push({ parentId, message });
    }
  }
  return { errors, states };
}

/**
 * Fold a thrown error into the right {@link ItemUploadResult} outcome.
 *
 * `created` says whether *this run* created `backendId` before the throw (see
 * {@link RunCreation}); it is stamped onto every outcome below rather than
 * guessed from `backendId`. A `401`, a `403` or a lost `PATCH` race proves the
 * opposite of creation — nothing was written — yet each of them reports the
 * item's long-standing link in `backendId`.
 *
 * `warnings` is the run's accumulated list, carried onto the failure for two
 * reasons. It is what the operator needs in order to act (which file's OCR is
 * missing, whose filename the backend mangled) — dropping it lost that on
 * every failed upload. And `"adopted-existing"` is a *safety* marker:
 * {@link removableBackendIds} refuses to hard-delete a record carrying it, and
 * that exclusion can only ever fire on a non-`uploaded` result, i.e. exactly
 * the ones this function builds. Until it was threaded through, that second
 * guard was unreachable in production and the whole protection rested on the
 * `created` flag alone.
 */
function mapUploadError(
  itemId: string,
  backendId: string | null,
  err: unknown,
  fieldKeys: string[],
  created: boolean,
  warnings: UploadWarning[],
): ItemUploadResult {
  if (err instanceof ApiError) {
    if (err.kind === "unauthorized") {
      return result(itemId, "unauthenticated", {
        backendId,
        created,
        warnings,
        message:
          "Not signed in — the request carried no valid token. Check the Keycloak username and password in Settings.",
      });
    }
    if (err.kind === "forbidden") {
      return result(itemId, "forbidden", {
        backendId,
        created,
        warnings,
        message:
          "Signed in, but this account lacks write access (records:manage / drafts:manage).",
      });
    }
    if (err.kind === "conflict") {
      // A create hit an existing deterministic id (COBISS), or a PATCH lost the
      // optimistic-concurrency race.
      return result(itemId, backendId ? "error" : "duplicate", {
        backendId,
        created,
        warnings,
        message: backendId
          ? "The record changed on the server since it was last synced — refresh and retry."
          : "A record with this identifier already exists on the backend.",
      });
    }
    if (err.kind === "bad_request") {
      const missingParents = parentNotFoundIds(err.body);
      if (missingParents) {
        return result(itemId, "error", {
          backendId,
          created,
          warnings,
          missingParentIds: missingParents,
          message: missingParentMessage(missingParents, true),
        });
      }
      const failure = metadataValidationFailure(err.body);
      if (failure) {
        return result(itemId, "error", {
          backendId,
          created,
          warnings,
          metadataRejected: true,
          fieldErrors: validationFieldErrors(failure),
          message: err.message,
        });
      }
      return result(itemId, "error", {
        backendId,
        created,
        warnings,
        fieldErrors: mapValidationErrors(err.body, fieldKeys),
        message: err.message,
      });
    }
    return result(itemId, "error", { backendId, created, warnings, message: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error("upload", `Unexpected error uploading ${itemId}.`, err);
  return result(itemId, "error", { backendId, created, warnings, message });
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
  /** Parents the backend said no longer exist; the run stopped at the item
   * that hit it. */
  missingParentIds: string[];
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
    // The parent is gone for every item of the batch: stop instead of failing each one.
    if (res.missingParentIds.length > 0) {
      return { results, allUploaded: false, missingParentIds: res.missingParentIds };
    }
  }
  return { results, allUploaded: results.every((r) => r.status === "uploaded"), missingParentIds: [] };
}

// ─── close-time cleanup ──────────────────────────────────────────────────────

/**
 * Backend ids this batch CREATED and did not finish — the only records a
 * close may remove.
 *
 * The gate is {@link ItemUploadResult.created}: positive, this-run provenance,
 * stamped at the two sites that actually create. Creation is **not** inferred
 * from `backendId`, and this is the single most important line in the
 * function. `backendId` is seeded from `item.backendId`, a persistent local
 * field read back from the `metadata.json` mirror — it survives sessions and
 * means "linked", not "made here". Inferring from it hard-deleted live,
 * curated records out of the National Library's public catalogue in three
 * ordinary situations:
 *  - a **failed replace** (a `409`, a `403`, a dropped connection) of an item
 *    uploaded in an earlier session, whose error result carries that
 *    pre-existing id and no warning at all — including `replaceOnBackend`'s
 *    missing-local-version branch, which makes zero backend calls;
 *  - a **`blocked`** item, which by definition never reached the backend this
 *    run, yet reports the id it was published under previously;
 *  - `unauthenticated` / `forbidden`, where the `401`/`403` is itself proof
 *    that nothing was written.
 *
 * Three further exclusions, each still load-bearing — necessary, no longer
 * sufficient:
 *  - `uploaded` items are legitimately published; in a mixed batch the
 *    operator is closing because of some *other* item.
 *  - an `"adopted-existing"` warning means the record pre-dated this batch
 *    (see `adoptExistingRecord`). It may be a librarian's own record —
 *    deleting it would destroy third-party data. Kept ahead of `created` in
 *    spirit: an adopted record must stay un-removable even if some future
 *    path sets the flag on its way through (the adoption path can reach
 *    `recreateOrphaned`, which does exactly that).
 *  - no `backendId` means there is nothing to address a delete to.
 *
 * `"recreated-orphaned"` is deliberately NOT excluded: that warning means
 * *this run* re-created a record the backend had authoritatively lost
 * (`recreateOrphaned`), so if the run then failed, deleting it only returns
 * things to the state before the run — Task 5 re-creates it on the next
 * upload.
 */
export function removableBackendIds(
  results: Iterable<ItemUploadResult>,
): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (!r.created) continue;
    if (r.status === "uploaded") continue;
    if (!r.backendId) continue;
    if (r.warnings.some((w) => w.code === "adopted-existing")) continue;
    out.push(r.backendId);
  }
  return out;
}

/** The one primitive {@link cleanupUnfinishedRecords} needs, injectable so it
 * can be tested without a network — mirrors the {@link UploadDeps} seam
 * pattern at a smaller scale. Defaults to the real `DELETE /api/items`. */
export interface CleanupDeps {
  deleteItems: (ids: string[]) => Promise<void>;
}

function defaultCleanupDeps(): CleanupDeps {
  return { deleteItems: (ids) => apiDeleteItems({ ids }) };
}

/**
 * Best-effort removal of the backend records {@link removableBackendIds}
 * says this batch created and left unfinished.
 *
 * Calls `deleteItems` **once** with every removable id — `DELETE /api/items`
 * is all-or-nothing (docs/PROJECT-KNOWLEDGE §"DELETE /api/items": a `404` on
 * any id deletes nothing), so the caller must send only ids it is confident
 * exist, in a single request. A failure here must not stop the close the
 * operator asked for, so it is logged rather than thrown — **never throws**.
 *
 * Still reports whether it worked: `true` on success or when there was
 * nothing to remove, `false` when `deleteItems` rejected. The caller
 * (`useUpload.closeBatch`) uses that to tell the operator the records are
 * still out there — a silently-swallowed failure here would mean nobody was
 * ever told a "removed" record actually wasn't.
 *
 * The local link is left alone on purpose: the next upload's authoritative
 * `404` re-creates the record (Task 5). Clearing it would need a `dto.rs`
 * change (`UploadRecordDto.backend_id` is a non-null `String`), which this
 * plan deliberately avoids.
 */
export async function cleanupUnfinishedRecords(
  results: Iterable<ItemUploadResult>,
  depsOverride?: Partial<CleanupDeps>,
): Promise<boolean> {
  const deps = { ...defaultCleanupDeps(), ...depsOverride };
  const ids = removableBackendIds(results);
  if (ids.length === 0) return true;
  try {
    await deps.deleteItems(ids);
    return true;
  } catch (err) {
    logger.warn(
      "upload",
      `Closed the batch but could not remove ${ids.length} unfinished record(s).`,
      err,
    );
    return false;
  }
}
