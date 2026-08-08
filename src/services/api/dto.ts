/**
 * Backend DTO types — the wire contract with `nbcg`.
 *
 * Surveyed and verified against the live backend on 2026-08-03 (adversarially
 * checked; see docs/tasks/09-backend-api-contract.md for the endpoint table).
 * These are the request/response shapes the archive sends and receives. Domain
 * enums and shared vocabulary are re-exported from `@domain` so callers have a
 * single import surface.
 *
 * Ideally this file is eventually generated from the backend OpenAPI; until
 * then it is hand-maintained against the survey.
 */

import type {
  VisibilityStatus,
  ItemType,
  FileRole,
  FileType,
  TextExtractionStatus,
} from "@domain/enums";
import type { RecordMetadata, RecordMetadataInput } from "@domain/metadata";
import type { ResolvedCode, RecordSchema } from "@domain/schema";

export type {
  VisibilityStatus,
  ItemType,
  FileRole,
  FileType,
  TextExtractionStatus,
} from "@domain/enums";
export type { ResolvedCode, FieldDescriptor, RecordSchema } from "@domain/schema";
export type { RecordMetadata } from "@domain/metadata";

// ─── items ────────────────────────────────────────────────────────────────
// POST /api/items · PATCH /api/items/:id · POST /api/items/transition
// DELETE /api/items · GET /api/items/stats

/**
 * POST /api/items body. `visibilityStatus` and `targetState` are REQUIRED;
 * `metadata.title` must be a non-empty string or the server 400s.
 *
 * `targetState` decides the collection (RECORD → `records`, DRAFT → `drafts`)
 * and therefore which `*:manage` scope is checked. `visibilityStatus` is written
 * verbatim. Both confirmed against `items.controller.create` /
 * `items.service.create` (2026-08-07).
 *
 * SERVER-FORCED METADATA (`items.service.create`): the sanitized client metadata
 * is spread between a default and an override block —
 * `{ collectionType: 0, ...client, _source, childrenInDrafts: 0,
 *    childrenInRecords: 0, jeGlavnoGradivo: true }`.
 * So `collectionType` is a **default** the client CAN override, while `_source`,
 * `childrenInDrafts`, `childrenInRecords` and `jeGlavnoGradivo` come *after* the
 * spread and are **not settable** — whatever the client sends for them is
 * overwritten. `_source` is derived: `'cobiss'` when `metadata.cobissId` is
 * present, else `'nbcg'`.
 *
 * Unknown metadata keys are silently DROPPED (`sanitizeMetadata` keeps only keys
 * in `EDITABLE_BASE_METADATA_SHAPE` ∪ `DOMAIN_RECORD_SHAPE`); a known key with
 * the wrong type is a `400` (`Invalid value for metadata field "<key>": …`).
 */
export interface CreateItemDto {
  visibilityStatus: VisibilityStatus;
  targetState: ItemType;
  metadata?: RecordMetadataInput;
}

/**
 * PATCH /api/items/:id body. `expectedVersion` is REQUIRED (`@IsInt() @Min(0)`,
 * optimistic concurrency → 409 on mismatch). `metadata` is SHALLOW-merged
 * (`{ ...existing, ...sanitized }`): only the keys sent are written; nested
 * objects/arrays are replaced wholesale; unknown keys are dropped; there is no
 * way to unset a key. Send ONLY changed fields.
 *
 * **FIXED BACKEND-SIDE 2026-08-07** (`nbcg/todo/backend-patch-noop-skips-404-and-409.md`).
 * The no-op early return used to sit *before* the existence and version guards,
 * so a payload with nothing to write returned `200` + an empty body even with a
 * wrong `expectedVersion`. It now sits **after** both guards, and every success
 * carries `{ version }`:
 *
 *  - wrong `expectedVersion` → `409`, whether or not the payload writes anything;
 *  - nothing to write, right version → `200 { version }` (unchanged);
 *  - a real change → `200 { version: expectedVersion + 1 }`.
 *
 * So the response shape is uniform and the returned version is always
 * trustworthy — see {@link UpdateItemResult}.
 *
 * Still worth knowing: `hasMetadataChanges` is evaluated AFTER sanitisation, so a
 * `metadata` object containing only unknown keys collapses to `{}` and is treated
 * as "nothing to write" — no `400` and no version bump, though now with a correct
 * version in the body. Verify field keys against the schema endpoint before
 * sending, or a typo'd write looks like a successful no-change.
 *
 * `version` is a **write counter, not a change counter** — re-sending an
 * identical value still bumps it (backend decision, deliberate and documented).
 * Never infer "the content changed" from a version bump.
 */
export interface UpdateItemDto {
  visibilityStatus?: VisibilityStatus;
  metadata?: RecordMetadataInput;
  expectedVersion: number;
}

/**
 * POST /api/items/transition body — move ids into `targetState`. Requires
 * BOTH `records:manage` and `drafts:manage`. `ids` must be non-empty.
 *
 * ⚠️ NOT IDEMPOTENT. `items.service.transition` collects every id already in
 * the target collection and throws `400 Items already in state <TARGET>: <ids>`
 * — for the WHOLE batch, in one transaction, so one already-published id fails
 * the transition of every other id with it. A publish step that may be re-run
 * must filter the batch to items actually in the *other* collection first (or
 * treat that specific 400 as success). Other failures: `404` if any id is in
 * neither table, `409` if an id somehow exists in both.
 *
 * The move preserves `id`, copies `metadata`/`visibilityStatus`/`createdAt`,
 * bumps `version`, re-points `file_attachments` at the new collection, and
 * rewrites `item_relations.childType`/`parentType` (which re-fires the
 * children-count trigger on affected parents — see {@link ModifyRelationsDto}).
 *
 * **Since 2026-08-07 the new versions are returned** ({@link TransitionResult}),
 * so they no longer have to be re-read through the CDC-lagged search index. Note
 * they are *read back* rather than computed as `version + 1`: a transitioned item
 * that is itself a parent gets bumped a second time when its children's
 * `childType` is rewritten, so `+1` would have been wrong.
 */
/**
 * One entry of the `POST /api/items/transition` response (`201`) — an item's id
 * and its version after the move. Read back post-trigger, so it is correct even
 * for an item that is itself a parent (whose version is bumped twice).
 */
export interface TransitionResult {
  id: string;
  version: number;
}

export interface TransitionItemsDto {
  ids: string[];
  targetState: ItemType;
}

/**
 * DELETE /api/items body (yes, a body on DELETE). Hard delete; `ids` must be
 * non-empty.
 *
 * ALL-OR-NOTHING: the service resolves every id inside one transaction and
 * throws `404 Items not found: <ids>` if ANY id is missing — nothing is deleted
 * in that case. Attachments cascade (blobs are deleted best-effort afterwards,
 * so a storage failure leaves orphaned blobs but a consistent DB), and relations
 * touching the ids are removed first so the children-count trigger can decrement
 * the parents.
 */
export interface DeleteItemsDto {
  ids: string[];
}

/** The full `Draft`/`Record` entity returned by POST /api/items. Identical
 * columns for both tables. */
export interface ItemEntity {
  id: string;
  visibilityStatus: VisibilityStatus;
  metadata: RecordMetadata;
  /** Optimistic-concurrency counter; starts at 0. */
  version: number;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
  updatedByUserId: string | null;
}

/**
 * PATCH /api/items/:id success body — the item's version after the write.
 *
 * Always present since the 2026-08-07 backend fix: a real change returns
 * `expectedVersion + 1`, and a request with nothing to write returns the
 * unchanged version rather than an empty body. Callers can adopt this
 * unconditionally.
 */
export interface UpdateItemResult {
  version: number;
}

/**
 * Full PATCH response type.
 *
 * Kept as an alias rather than deleted so the intent stays explicit: this used to
 * be `UpdateItemResult | undefined`, because a no-op returned an empty body. The
 * backend now always sends `{ version }`, so the `undefined` arm is gone and
 * `.version` can be read directly.
 */
export type UpdateItemResponse = UpdateItemResult;

/** GET /api/items/stats response (requires `records:view:hidden` +
 * `drafts:view:hidden`). Also used as the connection/token probe. */
export interface ItemStats {
  records: Record<VisibilityStatus, number>;
  drafts: Record<VisibilityStatus, number>;
}

// ─── files ──────────────────────────────────────────────────────────────
// POST /api/files/upload/:itemId · PUT /api/files/:fileId (replace)
// PUT /api/files/:fileId/text · POST /api/files/:fileId/extract
// GET /api/files/:itemId · GET /api/files/:fileId/download · DELETE /api/files/:fileId

/** Max files accepted per `POST /api/files/upload/:itemId` request
 * (`FilesInterceptor('files', 10)`). */
export const UPLOAD_MAX_FILES = 10;

/** Per-file size cap enforced by multer on upload and replace (2 GB). */
export const UPLOAD_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Multipart parts for POST /api/files/upload/:itemId. The file field name is
 * `files` (up to {@link UPLOAD_MAX_FILES}, each ≤ {@link UPLOAD_MAX_FILE_BYTES}).
 * CAUTION: `role` applies to EVERY file in the request — it is NOT per-file. A
 * THUMBNAIL + WEB mix requires two separate uploads. `extractedTexts` IS
 * genuinely per-file (keyed by filename).
 *
 * `extractedTexts` is matched on the EXACT multipart filename
 * (`file.originalname`) — not the basename, not case-insensitively. A key that
 * matches no uploaded file is silently ignored, and the file it was meant for
 * falls through to backend Tika extraction.
 *
 * ⚠️ AN EMPTY-STRING ENTRY DOES NOT SUPPRESS EXTRACTION. `files.service.upload`
 * stores text when the key is *present* (`suppliedText !== undefined` → text
 * `null`, status `NO_TEXT`) but selects the Tika queue with a truthiness test
 * (`!extractedTexts?.[filename]`). So `{ "x.pdf": "" }` writes NO_TEXT *and*
 * enqueues server-side extraction, which later overwrites it. If OCR genuinely
 * produced nothing, upload without the key and call
 * `PUT /api/files/:fileId/text` with `""` afterwards.
 *
 * Non-PDF files are never enqueued. `fileType` is derived from the MIME type
 * (`image/jpeg`, `image/png` → IMAGE; `application/pdf` → PDF; anything else →
 * UNKNOWN), and an omitted `role` falls back to the Prisma default `SOURCE`.
 * Enqueue failures (e.g. Redis down) are swallowed — the upload still returns
 * `201`, and extraction must be re-triggered via `POST /api/files/:fileId/extract`.
 */
export interface UploadFilesParts {
  /** JSON-stringified map `{ "<filename>": "<ocr text>" }`. Malformed JSON, or
   * JSON that is not a plain object, is a `400`. */
  extractedTexts?: Record<string, string>;
  /** Ask the backend's extraction worker to OCR PDFs it processes. Default
   * false. Only reaches files with no supplied text — the archive uploads with
   * `false` because it supplies its own OCR. */
  doOCR?: boolean;
  /** Applied to all files in this request. Omitted → `SOURCE`. */
  role?: FileRole;
}

/**
 * PUT /api/files/:fileId (replace) parts. Single file field named `file`
 * (≤ {@link UPLOAD_MAX_FILE_BYTES}); a request with no file part is a `400`.
 * `extractedText` is singular here. The attachment `id` and `role` are stable
 * across a replace — but `filename`, `mimeType` and `fileType` are overwritten
 * from the new file.
 *
 * ⚠️ OMITTING `extractedText` WIPES THE EXISTING TEXT. `files.service.replace`
 * has no "leave text alone" branch: when `extractedText` is `undefined` it sets
 * `extractedText: null` + `textExtractionStatus: NOT_EXTRACTED` and enqueues
 * Tika. Re-uploading a WEB PDF therefore destroys the archive's OCR unless the
 * text is re-sent in the same call (or restored afterwards via
 * `PUT /api/files/:fileId/text`).
 */
export interface ReplaceFileParts {
  doOCR?: boolean;
  extractedText?: string;
}

/** PUT /api/files/:fileId/text body. Empty string is stored as null (status
 * `NO_TEXT`); otherwise the backend classifies it as `EXTRACTED` or `GARBAGE`.
 * Unlike upload, this endpoint never enqueues extraction — it is the safe way
 * to set or clear text after the fact. `404` on an unknown fileId. */
export interface SetTextDto {
  text: string;
}

/** POST /api/files/:fileId/extract body. Defaults to true (this endpoint exists
 * to force OCR). PDFs ONLY — any other `mimeType` is a `400`. */
export interface ReextractDto {
  doOCR?: boolean;
}

/** A file attachment row. `extractedText` is present on upload/replace
 * responses but OMITTED from GET list responses (can be megabytes). */
export interface FileAttachment {
  id: string;
  draft_id: string | null;
  record_id: string | null;
  fileType: FileType;
  role: FileRole;
  /** SeaweedFS blob id. */
  originalFid: string;
  extractedText?: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  textExtractionStatus: TextExtractionStatus;
  createdAt: string;
}

export interface SetTextResult {
  updated: true;
}
export interface ReextractResult {
  enqueued: true;
}

// ─── relations ────────────────────────────────────────────────────────────
// POST /api/relations/connect · POST /api/relations/disconnect

/**
 * Both connect and disconnect share this. `parentId` is a SINGLE id;
 * `childIds` is a non-empty array. Manage is checked against the parent's
 * collection only. connect is idempotent + cycle-guarded; disconnect is an
 * unchecked directional edge delete.
 *
 * Both return a {@link RelationWriteResult}. **`disconnect` is `200`, not `204`**
 * — the status changed on 2026-08-07 because a `204` must not carry a body.
 *
 * A relation write still bumps the **parent**'s `version`: the
 * `trg_item_relations_children_count` trigger (migration
 * `20260725120000_add_version_optimistic_concurrency`) fires per edge row and
 * runs `UPDATE drafts|records SET metadata = jsonb_set(…childrenIn*…),
 * version = version + 1 WHERE id = <parentId>`, so linking N children advances it
 * by N. The difference is that the caller is now **told** the resulting version
 * instead of having to re-read it through the CDC-lagged search index
 * (`nbcg/todo/backend-archive-relations-return-parent-version.md`).
 *
 * One caveat survives the fix: the trigger writes via raw SQL, so the parent's
 * `updatedAt` does **not** move even though its version and metadata did.
 * `updatedAt` is not a usable change signal for parents.
 */
export interface ModifyRelationsDto {
  parentId: string;
  childIds: string[];
}

/**
 * Response body of `POST /api/relations/connect` (`201`) and `/disconnect`
 * (`200`) — the parent's state *after* the write.
 *
 * This is what makes a write-through mirror correct without a re-read: a parent
 * that is itself a locally-tracked item can adopt `version` directly, so its next
 * `PATCH` carries the right `expectedVersion` instead of `409`ing. The children
 * counts mirror `metadata.childrenInDrafts` / `childrenInRecords`, which the
 * trigger has just rewritten.
 */
export interface RelationWriteResult {
  parentId: string;
  /** The parent's version after the trigger ran (read back, not computed). */
  version: number;
  childrenInDrafts: number;
  childrenInRecords: number;
}

// ─── search (OpenSearch-backed, CDC-lagged) ─────────────────────────────────
// GET /api/search · GET /api/search/:id · GET /api/search/:id/children

export type SearchType = "all" | "records" | "drafts";
export type SearchSort = "relevance" | "newest";

/** The OpenSearch index a hit came from. Maps 1:1 to {@link ItemType}
 * (`"records"` → `RECORD`, `"drafts"` → `DRAFT`) — see `searchIndexToItemType`. */
export type SearchIndex = "records" | "drafts";

/** Backend cap on `limit` (`@Max(100)` on the query DTO). */
export const SEARCH_MAX_LIMIT = 100;

/**
 * OpenSearch refuses `from + size >= 10000`; the backend pre-empts that with a
 * `400` ("Page out of range"). Callers should not walk past it — a sync that
 * needs more than this must narrow its query instead.
 */
export const SEARCH_DEEP_PAGINATION_LIMIT = 10_000;

/** Query params for GET /api/search and /api/search/:id/children. Multi-select
 * filters (publisher/language/materialType) are comma-separated strings. */
export interface SearchQuery {
  q?: string;
  type?: SearchType;
  page?: number;
  limit?: number;
  title?: string;
  author?: string;
  fullText?: string;
  publisher?: string;
  language?: string;
  materialType?: string;
  yearFrom?: string;
  yearTo?: string;
  isbn?: string;
  issn?: string;
  cobissId?: string;
  /** Comma-separated `_source` includes; `id` is always added server-side. */
  fields?: string;
  sort?: SearchSort;
}

export interface MatchedFile {
  id: string;
  filename: string;
  highlights: string[];
}

/**
 * A file attachment **as indexed** (nested under the search `source`). Mirrors
 * the Postgres row minus the blob pointer: pgsync copies `file_attachments`
 * without `originalFid`/`draft_id`/`record_id`, and both search paths strip
 * `extractedText` (it can be megabytes). For the authoritative attachment list —
 * including `originalFid` — use `GET /api/files/:itemId` instead.
 */
export interface IndexedFileAttachment {
  id: string;
  fileType: FileType;
  role: FileRole;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  textExtractionStatus: TextExtractionStatus;
  createdAt: string;
}

/** One inbound edge in the indexed doc — the item's parents. */
export interface IndexedParentRelation {
  parentId: string;
  parentType: ItemType;
}

/**
 * The indexed document behind {@link SearchHit.source}.
 *
 * Verified against `nbcg/infrastructure/docker/pgsync/schema.json`: the record /
 * draft columns plus two pgsync child joins (`file_attachments`,
 * `item_relations` relabelled `parent_relations`). **`version` is indexed**, so
 * a search read can refresh the local mirror's optimistic-concurrency counter —
 * but it is CDC-lagged, so never let it overwrite a newer locally-known version
 * (`domain/sync.acceptRemoteVersion`).
 *
 * Every field is optional at the type level: `?fields=` trims `_source` to the
 * requested includes, so a narrowed query legitimately returns a partial doc.
 *
 * The two joined arrays are `| null` rather than merely optional — verified
 * against the live index 2026-08-07: pgsync writes an explicit **`null`** (not
 * an absent key) when an item has no parents, so `parent_relations` is
 * `null` far more often than it is missing. Narrow with `?? []`, never with a
 * bare optional-chain-and-assume-array.
 */
export interface IndexedItemSource {
  id?: string;
  visibilityStatus?: VisibilityStatus;
  metadata?: RecordMetadata;
  /** Optimistic-concurrency counter as last indexed (lags writes). NOTE: this
   * starts at **0**, which is falsy — always test it with `typeof`/`== null`,
   * never with a truthiness check. */
  version?: number;
  /**
   * ISO timestamps **with a UTC offset** (`…T15:47:27.504+00:00`), safe to
   * `Date.parse()`.
   *
   * They were not always: until the 2026-08-07 backend fix the indexed copy came
   * out of a naive `timestamp` column as `…T15:47:27.504` — **no `Z`** — which JS
   * parses as *local* time, so every consumer was off by the UTC offset while the
   * REST representation of the same field was correct. The columns are now
   * `timestamptz` and the corpus was reindexed
   * (`nbcg/todo/backend-search-index-timestamps-missing-timezone.md`), so the
   * indexed and REST values parse to the same instant. Do **not** add a
   * compensating `Z` — that would now double-correct.
   */
  createdAt?: string;
  updatedAt?: string;
  createdByUserId?: string;
  updatedByUserId?: string | null;
  file_attachments?: IndexedFileAttachment[] | null;
  parent_relations?: IndexedParentRelation[] | null;
  /** pgsync bookkeeping (source primary keys per joined table). Present on every
   * document; of no use to the archive — ignore it. */
  _meta?: unknown;
  [key: string]: unknown;
}

/** One search hit. `source` is the indexed doc ({@link IndexedItemSource}).
 * `matchedFiles`/`highlights` appear only for `fullText` queries. */
export interface SearchHit {
  id: string;
  /** Which OpenSearch index matched — `"records"` or `"drafts"`. */
  index: string;
  /** Relevance score; `GET /api/search/:id` returns a constant `1`. */
  score: number;
  source: IndexedItemSource;
  matchedFiles?: MatchedFile[];
  highlights?: string[];
}

/** GET /api/search and /:id/children envelope. */
export interface SearchResult {
  total: number;
  page: number;
  limit: number;
  pages: number;
  hits: SearchHit[];
}

// ─── suggest (typeahead) ────────────────────────────────────────────────────
// GET /api/search/suggest?field=&q=&limit=&type=

/**
 * The suggestable fields, from the backend allowlist (`suggest-fields.ts`). An
 * unknown field is a `400`, so this union is the guard. Values come back as
 * plain strings for the text fields and as {@link ResolvedCode} objects for the
 * code-backed ones (`language`, `materialType`, …) — hence `SuggestItem.value`
 * is `unknown`, matching the backend's own type.
 */
export const SUGGEST_FIELDS = [
  "title",
  "subtitle",
  "seriesTitle",
  "publisher",
  "place",
  "firstResponsibility",
  "edition",
  "notes",
  "language",
  "originalLanguage",
  "materialType",
  "country",
  "recordType",
  "bibliographicLevel",
  "author",
] as const;
export type SuggestField = (typeof SUGGEST_FIELDS)[number];

/** Query params for GET /api/search/suggest. `limit` is capped at 50. */
export interface SuggestQuery {
  field: SuggestField;
  q?: string;
  limit?: number;
  type?: SearchType;
}

/** `value` is a `string` for text fields, a {@link ResolvedCode} for code
 * fields, and an author object for `field=author`. */
export interface SuggestItem {
  value: unknown;
  count: number;
}

export interface SuggestResult {
  field: string;
  suggestions: SuggestItem[];
}

// ─── COBISS import / preview ────────────────────────────────────────────────
// GET /api/import/cobiss/preview/:cobissId  (synchronous, no persist)
// POST /api/import/cobiss  ·  GET /api/import/jobs/:jobId  (async)

/**
 * GET /api/import/cobiss/preview/:cobissId response. Requires `import:execute`.
 * `itemId` is the deterministic id a subsequent create would use, so
 * `alreadyExists`/`existsAs` tell you whether importing would collide.
 * `metadata` is the RAW `DomainRecord` (no title fallback, no system-field
 * wrapper) — so `metadata.title` may be undefined.
 *
 * ERROR SEMANTICS: a genuinely-absent record AND an unreachable/timed-out
 * COBISS both surface as a single 404 — they are indistinguishable to the
 * client. There is no "multiple records" error (the first match wins).
 *
 * Confirmed against `cobiss-import.controller.previewCobiss` +
 * `cobiss-util/cobiss-fetch` (2026-08-07): `fetchCobissRecord` returns `null` —
 * and the controller turns every `null` into the same
 * `404 No record found in COBISS for id <id>` — for ALL of: a non-2xx from
 * `ws.cobiss.net`, a network/DNS failure, the 30 s `AbortSignal.timeout`, and a
 * response whose XML contains no record. Only `alreadyExists`/`existsAs` are
 * looked up locally, so a 404 tells you nothing about the local DB either.
 *
 * ⚠️ The upstream fetch alone can take 30 s. The archive's own request timeout
 * must exceed that, or a slow-but-working COBISS surfaces as a client-side
 * timeout and hides the backend's real answer.
 */
export interface CobissPreview {
  cobissId: string;
  itemId: string;
  alreadyExists: boolean;
  existsAs: ItemType | null;
  metadata: DomainRecord;
}

/** POST /api/import/cobiss body (async import — the archive prefers preview +
 * POST /api/items to avoid orphan drafts). */
export interface CobissImportDto {
  ids: string[];
  target: ItemType;
  visibilityStatus: VisibilityStatus;
}

export interface CobissImportResult {
  jobId: string;
}

export interface ImportJobProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ id: string; reason: string }>;
}

/** GET /api/import/jobs/:jobId response. `state` is a BullMQ job state. Job
 * disappears (→ 404) after its TTL (24h complete / 7d failed). */
export interface ImportJobStatus {
  jobId: string;
  source: "cobiss" | "local";
  state: string;
  requestedAt: string;
  progress: ImportJobProgress | null;
  failedReason: string | null;
  finishedAt: string | null;
}

/**
 * Normalised COBISS/COMARC record (the preview `metadata`). All fields
 * optional. Faithful to the backend's *active* (uncommented) `DomainRecord`
 * fields as of 2026-08-03 (`cobiss.types.ts`); commented-out COMARC fields are
 * omitted. An index signature keeps it forward-compatible.
 */
export interface CobissAuthor {
  familyName?: string;
  firstName?: string;
  prefix?: string;
  romanNumerals?: string;
  dates?: string;
  role?: ResolvedCode;
  responsibility?: "primary" | "alternative" | "secondary";
}

export interface CobissCorporateBody {
  name: string;
  responsibility?: "primary" | "alternative" | "secondary";
}

export interface CobissPublication {
  place?: string;
  publisher?: string;
  year?: string;
  placeOfManufacture?: string;
  manufacturerName?: string;
}

export interface CobissTextualMaterialCodes {
  illustrationCodes?: ResolvedCode[];
  contentTypeCodes?: ResolvedCode[];
  conferencePublication?: boolean;
  festschrift?: boolean;
  indexIndicator?: boolean;
  literaryForm?: ResolvedCode;
  biographyCode?: ResolvedCode;
}

export interface DomainRecord {
  cobissId?: string;
  recordType?: ResolvedCode;
  bibliographicLevel?: ResolvedCode;
  materialType?: ResolvedCode;
  documentTypology?: string;
  isbn?: string[];
  issn?: string[];
  ismn?: string[];
  publicationDate1?: string;
  publicationDate2?: string;
  language?: ResolvedCode[];
  originalLanguage?: ResolvedCode[];
  translationLanguages?: ResolvedCode[];
  country?: ResolvedCode[];
  textualMaterialCodes?: CobissTextualMaterialCodes;
  title?: string;
  titleMediumDesignation?: string;
  titleByAnotherAuthor?: string;
  parallelTitle?: string[];
  subtitle?: string;
  firstResponsibility?: string;
  subsequentResponsibility?: string[];
  edition?: string;
  cartographicMathematicalData?: string;
  numberingAndDates?: string;
  musicEditionStatement?: string;
  publication?: CobissPublication;
  physicalDescription?: string;
  otherPhysicalDetails?: string;
  dimensions?: string;
  seriesTitle?: string;
  seriesSubtitle?: string;
  seriesResponsibility?: string;
  seriesIssn?: string;
  seriesVolume?: string;
  notes?: string[];
  titleInOtherScript?: string[];
  authors?: CobissAuthor[];
  corporateBodies?: CobissCorporateBody[];
  electronicLocation?: Array<{ url: string }>;
  [key: string]: unknown;
}

// ─── schema ─────────────────────────────────────────────────────────────
// GET /api/schema/record?level=main|child  → { fields }  (strong ETag)

/**
 * `GET /api/schema/record` response. Anonymous-OK; strong quoted-md5 `ETag` +
 * `Cache-Control: public, max-age=86400`, and `If-None-Match` correctly yields
 * `304` (live-verified 2026-08-07, including for the empty body below).
 *
 * Live counts: **41 main · 31 child · 41 unfiltered**. Child is a strict SUBSET
 * of main — there are no child-only fields — so the level filter only ever
 * removes fields, and a main-level form is a superset of a child-level one.
 * Only two fields are `issueIdentifying` (`numberingAndDates`, `seriesVolume`);
 * 23 are `parentInheritable`.
 *
 * ⚠️ `FieldDescriptor.required` IS A UI HINT, NOT A SERVER CONSTRAINT. The
 * schema marks both `title` and `collectionType` required, but
 * `items.service.create` enforces only a non-empty `title`
 * (`REQUIRED_METADATA_VALIDATORS`) and defaults `collectionType` to `0`. Treat
 * `required` as "the editor should ask for it", never as "the backend will
 * reject it".
 *
 * `?level` **IS** validated (fixed backend-side 2026-08-07; re-verified live
 * 2026-08-08): an unrecognised value is a `400`, and it is case-sensitive, so
 * `?level=Main` fails while `?level=` (empty) keeps its "all fields" meaning.
 * The old trap — an unknown level returning a cacheable `200 { fields: [] }` —
 * is gone.
 *
 * `services/api/schema` nonetheless still refuses to let an empty field list
 * replace a non-empty cached copy. Not for that cause, which no longer exists,
 * but because a `200` with no fields remains reachable from a transient backend
 * fault, and storing it would leave the metadata editor a form with no fields
 * for the full 24 h `max-age` — offline copy included.
 *
 * The backend's ETag cache (`SchemaController.etagCache`) is per-process and has
 * no invalidation, so a schema change on the backend only reaches clients after
 * a backend restart.
 */
export type RecordSchemaResponse = RecordSchema;

// ─── health ─────────────────────────────────────────────────────────────
// GET /api/health  (unauthenticated liveness probe)

export interface HealthResponse {
  status: string;
  timestamp: string;
}
