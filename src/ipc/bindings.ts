/**
 * Typed Tauri command bridge (Seam 2 — Application ↔ Native).
 *
 * This is Jernej's *contract*; the Arch lane implements each `#[tauri::command]`
 * in `src-tauri/src/commands/`. Eventually `tauri-specta` will GENERATE typed
 * wrappers from the Rust signatures and replace the hand-written bodies here —
 * until then these wrappers document the surface both lanes agree on.
 *
 * Conventions:
 *  - Command names are `snake_case`, grouped by domain (`config_*`, `fs_*`,
 *    `jobs_*`, `index_*`, `python_*`).
 *  - Arguments are passed as a single named object (Tauri camelCases keys).
 *  - Each wrapper throws {@link IpcUnavailableError} when not running under
 *    Tauri (e.g. a plain `vite` browser session), so callers can fall back.
 */

import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "@domain/config";
import type { ItemLevel, ScanRoot, StageName, StageStatus, ItemState } from "@domain/item";
import type { InputShape, RunnableStage } from "@domain/pipeline";
import type { ItemType, PublishTarget, VisibilityStatus } from "@domain/enums";
import type {
  BatchStage,
  ItemRunStatus,
  BatchParentRef,
  BatchItemOverride,
} from "@domain/batch";
import type { LocalMetadataFile } from "@domain/metadata";

/** Reliable runtime marker for a Tauri webview (v2). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export class IpcUnavailableError extends Error {
  readonly command: string;
  constructor(command: string) {
    super(
      `IPC command "${command}" is unavailable — not running under Tauri.`,
    );
    this.name = "IpcUnavailableError";
    this.command = command;
  }
}

async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) throw new IpcUnavailableError(command);
  return invoke<T>(command, args);
}

/**
 * The command-name registry — the single source of truth for the IPC surface.
 * Adding a command here signals a contract change for the Arch lane.
 */
export const Commands = {
  configLoad: "config_load",
  configSave: "config_save",
  configGetSecret: "config_get_secret",
  configSetSecret: "config_set_secret",
  configDeleteSecret: "config_delete_secret",
  fsPickDirectory: "fs_pick_directory",
  fsPathExists: "fs_path_exists",
  fsReadMetadata: "fs_read_metadata",
  fsWriteMetadata: "fs_write_metadata",
  fsReveal: "fs_reveal_path",
  fsMoveToProcessed: "fs_move_to_processed",
  fsReadFile: "fs_read_file",
  fsPeekFolder: "fs_peek_folder",
  indexScan: "index_scan",
  indexList: "index_list",
  indexRebuild: "index_rebuild",
  indexRebuildImpact: "index_rebuild_impact",
  indexRecordUpload: "index_record_upload",
  indexRecordSync: "index_record_sync",
  indexSetHidden: "index_set_hidden",
  syncLogAppend: "sync_log_append",
  syncLogList: "sync_log_list",
  batchList: "batch_list",
  batchCreate: "batch_create",
  batchUpdate: "batch_update",
  batchArchive: "batch_archive",
  jobsStart: "jobs_start",
  jobsCancel: "jobs_cancel",
  jobsReprocess: "jobs_reprocess",
} as const;

/** What the native secure store persists (non-secret config only; the token is
 * a separate secret). Stored partially, so callers merge with defaults. */
export type PersistedConfig = Partial<AppConfig>;

// ─── local index DTOs (Seam 2, Epic 02) ─────────────────────────────────────
// The raw shape the Rust `core/fs` scan + `core/db` SQLite index return for one
// item folder. `services/indexing` maps these to the domain `Item` (classifying
// assets by naming convention and filling any missing stages as `pending`).
// Vocabulary (`ScanRoot`, `ItemLevel`, `StageName`, `StageStatus`) is shared
// with `@domain/item` so the contract is single-sourced.

/** One discovered file, as the native scan reports it (unclassified — the
 * logic lane classifies by name via `@domain/files`). */
export interface IndexedAssetDto {
  filename: string;
  path: string;
  sizeBytes?: number | null;
}

/** An ad-hoc "view contents" look at a folder (Overview row action) — not
 * necessarily a tracked item. Direct files only, same as the native scan
 * itself never recurses into subfolders when observing one folder. */
export interface FolderPeekDto {
  folderName: string;
  assets: IndexedAssetDto[];
}

/** One stage's recorded outcome in the SQLite index. */
export interface IndexedStageDto {
  status: StageStatus;
  error?: string | null;
  updatedAt?: string | null;
}

/** One item folder as tracked by the native index. `stages` may omit stages the
 * index has never recorded — the logic lane defaults those to `pending`. */
export interface IndexedItemDto {
  id: string;
  folderName: string;
  folderPath: string;
  /**
   * This item's path relative to its scan root, forward-slash-joined (e.g.
   * `"Cèrnagora/CERNAGORA"`) — equal to `folderName` at depth 1. `core::fs`
   * now recurses to any depth (see `docs/tasks/nested-record-folders-and-manual-selection.md`),
   * so a folder no longer has to sit directly under the configured root to be
   * a candidate item; this drives the Overview list's indentation.
   */
  relativePath: string;
  /** Operator-hidden from the default Overview list. Never set automatically —
   * see `domain/overview`'s hidden-row filtering. */
  hidden: boolean;
  root: ScanRoot;
  /** From the folder's `metadata.json`; null when undetermined (defaults to
   * `main`). */
  level: ItemLevel | null;
  assets: IndexedAssetDto[];
  stages: Partial<Record<StageName, IndexedStageDto>>;
  uploaded: boolean;
  reupload: boolean;
  /** Only meaningful while `reupload` is true: whether the pending re-upload
   * needs the blob replaced (`false`) or only its OCR text pushed (`true`) —
   * see `core::db::items::ReuploadKind`. Lets `services/upload`'s
   * `pushReplaceAssets` skip an unnecessary blob PUT when a reprocess only
   * touched OCR text. */
  reuploadTextOnly: boolean;
  backendId: string | null;
  batchId: string | null;
  title?: string | null;
  cobissId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /**
   * Consecutive sync misses for this item's `backendId` (see
   * {@link SyncRecordDto.missStreak}); "orphaned" is derived from it, never
   * stored. Omitted/null reads as `0`.
   *
   * Note there is no `version` here on purpose — the backend version lives in
   * the folder's `metadata.json` mirror, which is where `services/upload` reads
   * it for `PATCH expectedVersion`. One source of truth.
   */
  missStreak?: number | null;
}

/**
 * One item an `index.rebuild()` would downgrade from "uploaded" to "not
 * uploaded" if it ran right now — because a fresh scan can no longer
 * corroborate the backend connection the index currently has on record,
 * whether the folder's `metadata.json` mirror lost the backend id or the
 * folder itself is gone. Returned by `index.rebuildImpact()` so the operator
 * can be warned before committing to `rebuild()`, which has no undo.
 */
export interface RebuildDowngradeDto {
  id: string;
  folderName: string;
  backendId: string;
}

/**
 * The upload facts to persist onto an item's index row after a successful
 * backend create/replace (Epic 07 write-through). The native side records the
 * connected `backendId` + published state, sets the `uploaded` flag, clears
 * `reupload`, and marks the `upload` stage `done`; it returns the updated row.
 * The per-folder `metadata.json` mirror is written separately by the logic lane
 * (`services/indexing.writeItemMetadata`).
 */
export interface UploadRecordDto {
  /** Connected backend `Draft`/`Record` id. */
  backendId: string;
  /** Backend optimistic-concurrency `version` at this write (null if unknown). */
  version: number | null;
  /** Which collection it was published to. */
  targetState: ItemType;
  visibilityStatus: VisibilityStatus;
}

// ─── sync DTOs (Seam 2, Epic 08) ─────────────────────────────────────────────
// Backend → archive refresh. Sync only ever *reads* the backend and *rewrites*
// the local mirror, so these two commands are the whole native surface it needs:
// one to fold a refreshed record into an item's index row, one to persist the
// run history the Sync screen shows.

/**
 * The refreshed backend facts to fold onto an item's index row after a sync
 * read. Distinct from {@link UploadRecordDto} on three counts, all deliberate:
 *
 *  - it **never sets `uploaded`/`reupload`** — sync is a read, so it must not
 *    change an item's derived state (`domain/item.deriveItemState`). An item
 *    the operator has dirtied stays "Needs re-upload" through any number of
 *    syncs;
 *  - it carries `title`, so the Overview table reflects a title edited on the
 *    website;
 *  - it carries {@link SyncRecordDto.missStreak}, the consecutive-miss counter
 *    that "orphaned" is **derived** from (`domain/sync.isOrphaned`). There is no
 *    `orphaned` field, deliberately — a stored flag would need un-setting when a
 *    record reappears, and the counter already implies it.
 *
 * `version` may be **null** when the read was CDC-lagged or ambiguous; a null
 * means "leave the stored version alone", not "clear it" — the stored version
 * gates `PATCH expectedVersion`, so clearing it would break the next re-upload.
 */
export interface SyncRecordDto {
  /** Backend `version` as last read, or null to leave the stored one untouched. */
  version: number | null;
  /** Which collection the backend says it lives in (it may have been
   * transitioned DRAFT↔RECORD on the website). */
  targetState: ItemType | null;
  visibilityStatus: VisibilityStatus | null;
  /** Cached record title for the Overview table; null leaves it untouched. */
  title: string | null;
  /**
   * How many **consecutive** sync runs have failed to find this item's connected
   * `backendId`; `0` when it was found. Persisted rather than derived because
   * "orphaned" must be confirmed across runs, and runs are hours apart — an
   * in-memory counter would reset on every relaunch and could never confirm.
   *
   * The logic lane owns the value (`domain/sync.nextMissStreak`) and only ever
   * increments it for an *unambiguous* miss; a network failure, a suspicious
   * run, or a too-fresh item leaves it alone. `orphaned` is then **derived**
   * from it (`domain/sync.isOrphaned`) rather than stored, so there is one
   * source of truth. Files are always kept — an orphaned item is flagged for the
   * operator, never auto-resurrected, re-created, or merged (docs/tasks/08).
   */
  missStreak: number;
  /** ISO timestamp of this refresh, for "last synced" per item. */
  syncedAt: string;
}

/** How a finished sync run turned out — drives the log's status dot. */
export type SyncRunStatus = "ok" | "warning" | "error";

/**
 * One persisted sync-run summary (the Sync screen's recent-syncs log + the four
 * stat tiles). Local-only working state, like batches — never sent to the
 * backend. The native side assigns `id` and keeps the newest N rows.
 */
export interface SyncRunDto {
  /** Native-assigned row id (ignored on append). */
  id: string;
  startedAt: string;
  finishedAt: string;
  status: SyncRunStatus;
  /** Whether this run was the 6-hourly automatic one or an operator's Sync now. */
  trigger: "auto" | "manual" | "launch";
  /** The four stat tiles. */
  checked: number;
  updated: number;
  upToDate: number;
  missed: number;
  /** One-line operator summary, e.g. "2 missed — backend timeout". */
  summary: string;
  /** Longer detail for the expanded log row (may be empty). */
  detail: string;
}

/** The append payload — everything except the native-assigned `id`. */
export type SyncRunCreateDto = Omit<SyncRunDto, "id">;

// ─── batch DTOs (Seam 2, Epic 03) ────────────────────────────────────────────
// A batch is local-only working state persisted in the SQLite index (the Arch
// lane owns the table, the running-`no` counter, and the item↔batch link). The
// DTO reuses the `@domain/batch` value types so labels/enums are single-sourced;
// `services/batches` maps it to the domain `Batch` (near-identity + normalising
// defaults). Field names are camelCase over IPC.

/** One batch row as tracked by the native index. */
export interface BatchDto {
  id: string;
  no: number;
  createdAt: string;
  /** The single item state the batch was created from (e.g. "to-process"). */
  type: ItemState;
  itemIds: string[];
  stage: BatchStage;
  running: boolean;
  /** Per-item run outcome, keyed by item id. */
  proc: Record<string, ItemRunStatus>;
  cobissId: string | null;
  parents: BatchParentRef[];
  publish: PublishTarget;
  visibility: VisibilityStatus;
  overrides: Record<string, BatchItemOverride>;
  archivedAt: string | null;
}

/** The create payload — everything except the native-assigned id/no/createdAt
 * (and archivedAt, always null at birth). */
export type BatchCreateDto = Omit<
  BatchDto,
  "id" | "no" | "createdAt" | "archivedAt"
>;

// ─── pipeline job DTOs (Seam 2, Epic 06) ─────────────────────────────────────
// The logic lane computes the *plan* (which stages each item needs, the input
// branch, the resolved thumbnail) via `domain/pipeline` and hands the native
// runner a fully-decided request — so the adaptive branching lives in one place
// (`.ts`), not duplicated in Rust. The runner owns queueing, the concurrency
// limit, atomic writes, the single-run lock, and emits the `job://*` events
// (see `ipc/events.ts`). Built by `services/pipeline`.

/** Why a run was started — informs the native dirty-flag semantics. `reprocess`
 * force-rebuilds and marks an already-uploaded item **Needs re-upload**. */
export type JobRunMode = "run" | "rerun" | "reprocess";

/** One item's work in a run. `stages` is already reduced by skip-if-done
 * (`domain/pipeline.stagesToRun`), so the runner executes exactly these. */
export interface ItemRunRequest {
  itemId: string;
  folderPath: string;
  /** Derived-output naming base (the folder's own name). */
  folderName: string;
  /** The adaptive branch decided in `.ts` (TIFFs / supplied-pdf / …). */
  inputShape: InputShape;
  /** Runnable stages to (re)execute for this item, in run order. */
  stages: RunnableStage[];
  /** The primary-thumbnail filename when a concrete present image is picked
   * (operator or auto-selected), else null. A null does **not** by itself mean
   * "unresolved" — a single generated first-page image resolves with no concrete
   * file yet; {@link ItemRunRequest.thumbnailNeedsChoice} disambiguates. */
  primaryThumbnail: string | null;
  /** Whether the primary thumbnail is an unresolved operator choice (≥2
   * candidates). The runner completes the Thumbnail stage only when this is
   * **false** — normalising `primaryThumbnail` if set, otherwise the single
   * generated first-page image, to `<name>_thumb.png`. When **true** it may
   * generate candidate images but must hold the stage pending (docs/tasks/06
   * "don't let the Thumbnail stage reach `done`"). This is what separates the
   * auto-resolved happy path from a real "choose thumbnail" — both of which carry
   * `primaryThumbnail: null`. */
  thumbnailNeedsChoice: boolean;
  /** Base names of the discovered web PDFs to preserve (multi-PDF), so each web
   * PDF + its `<base>.txt` keep matching names. Empty for images-only. */
  webPdfBases: string[];
  /**
   * For `inputShape: "page-images"`, the page image filenames **in page order** —
   * the pages to assemble into `<folderName>.pdf`.
   *
   * The order is authoritative and must be used as given. Real scanner output is
   * numbered inconsistently (`1…260`, `000…161`, `SP_001…052`), and a plain
   * directory read or lexicographic sort yields `1, 10, 100, 2, …` — a silently
   * shuffled book. The logic lane has already applied the natural sort
   * (`domain/naming.compareNatural`), so the runner must not re-sort.
   * Empty for every other shape.
   */
  pageImages: string[];
  /**
   * Whether to split two-page spreads into single pages during the `pdf` stage.
   *
   * Not a visible stage — a sub-step of the image→PDF build, toggleable (decided
   * 2026-08-07). `py/split_spreads.py` holds the implementation; ~1.41-aspect
   * landscape scans like `ОКТОИХ петогласник 2` need it, portrait page scans do
   * not. When true the runner splits each spread before assembling the PDF, so
   * the page count roughly doubles.
   */
  splitSpreads: boolean;
}

/** A whole run: the batch, why, and the per-item work. `reprocess` may carry a
 * single item that is not part of any active batch (the guarded per-item
 * re-process action). */
export interface BatchRunRequest {
  batchId: string;
  mode: JobRunMode;
  items: ItemRunRequest[];
}

export const ipc = {
  /** Config persistence — non-secret config via a store, the token via the OS
   * secret store. Owned by `core/config` (Arch). */
  config: {
    load: () => call<PersistedConfig | null>(Commands.configLoad),
    save: (config: AppConfig) => call<void>(Commands.configSave, { config }),
    getSecret: (key: string) =>
      call<string | null>(Commands.configGetSecret, { key }),
    setSecret: (key: string, value: string) =>
      call<void>(Commands.configSetSecret, { key, value }),
    deleteSecret: (key: string) =>
      call<void>(Commands.configDeleteSecret, { key }),
  },

  /** Filesystem helpers — folder picking/validity (Settings → Configure) and the
   * per-folder `metadata.json` mirror + folder moves/reveal. Owned by `core/fs`
   * (Arch). */
  fs: {
    pickDirectory: (title?: string) =>
      call<string | null>(Commands.fsPickDirectory, { title }),
    pathExists: (path: string) =>
      call<boolean>(Commands.fsPathExists, { path }),
    /** Read a folder's `metadata.json` mirror (null if absent/unreadable). */
    readMetadata: (path: string) =>
      call<LocalMetadataFile | null>(Commands.fsReadMetadata, { path }),
    /** Write (atomically) a folder's `metadata.json` mirror. */
    writeMetadata: (path: string, metadata: LocalMetadataFile) =>
      call<void>(Commands.fsWriteMetadata, { path, metadata }),
    /** Reveal a folder in the OS file manager (Overview ⋯ → Open in Explorer). */
    reveal: (path: string) => call<void>(Commands.fsReveal, { path }),
    /** Move an item's folder `/unprocessed` → `/processed` on successful upload
     * and update the index (the "reposition" action; triggered in Epic 07). */
    moveToProcessed: (itemId: string) =>
      call<IndexedItemDto>(Commands.fsMoveToProcessed, { itemId }),
    /**
     * Read a file's raw bytes off disk, for building a multipart upload in the
     * logic lane (Epic 07). Reading blobs is a `core/fs` concern; the backend
     * HTTP that consumes them stays in TypeScript (docs/04 seam-3 decision).
     * Returns the bytes as an `ArrayBuffer` (Arch: return `tauri::ipc::Response`
     * from the byte vec so this transfers as binary, not a JSON number array).
     */
    readFile: (path: string) =>
      call<ArrayBuffer>(Commands.fsReadFile, { path }),
    /** An ad-hoc "view contents" look at a folder (Overview row action) —
     * works whether or not the folder is a tracked item. */
    peekFolder: (path: string) =>
      call<FolderPeekDto>(Commands.fsPeekFolder, { path }),
  },

  /**
   * Local index — scan the configured roots, read the tracked item list, and
   * rebuild from folders if the SQLite index is lost. Owned by `core/fs` +
   * `core/db` (Arch); the logic lane consumes via `services/indexing`.
   */
  index: {
    /** Rescan `/unprocessed` + `/processed`, reconcile the index, return items. */
    scan: () => call<IndexedItemDto[]>(Commands.indexScan),
    /** Return the currently-tracked items without a rescan. */
    list: () => call<IndexedItemDto[]>(Commands.indexList),
    /** Reconstruct the SQLite index from folders (`metadata.json` + derived-file
     * presence) when it is missing/corrupt, then return items. */
    rebuild: () => call<IndexedItemDto[]>(Commands.indexRebuild),
    /** Read-only dry-run of `rebuild()`: which currently-uploaded items would
     * lose that state if it ran right now. Call before `rebuild()` to warn the
     * operator — see {@link RebuildDowngradeDto}. */
    rebuildImpact: () =>
      call<RebuildDowngradeDto[]>(Commands.indexRebuildImpact),
    /** Record a successful upload on an item's index row (Epic 07 write-through):
     * set `backendId` + published state, flip `uploaded` on, clear `reupload`,
     * mark the `upload` stage done. Returns the updated row. */
    recordUpload: (itemId: string, upload: UploadRecordDto) =>
      call<IndexedItemDto>(Commands.indexRecordUpload, { itemId, upload }),
    /**
     * Fold a backend→archive **sync** read onto an item's index row (Epic 08).
     * Read-only with respect to item state: it updates version/targetState/
     * visibility/title and the orphan flag, and must **not** touch `uploaded`,
     * `reupload`, or any stage status. Null fields mean "leave unchanged".
     * Returns the updated row.
     */
    recordSync: (itemId: string, sync: SyncRecordDto) =>
      call<IndexedItemDto>(Commands.indexRecordSync, { itemId, sync }),
    /** Hide or unhide an item from the default Overview list — pure operator
     * curation, never inferred (Overview ⋯ → Hide/Unhide). Returns the
     * updated row. */
    setHidden: (itemId: string, hidden: boolean) =>
      call<IndexedItemDto>(Commands.indexSetHidden, { itemId, hidden }),
  },

  /**
   * Sync-run history (Epic 08) — the Sync screen's four stat tiles and its
   * recent-syncs log, persisted so they survive a relaunch. Local-only, like
   * batches; owned by `core/db` (Arch), consumed via `services/sync` +
   * `stores/useSync`.
   */
  sync: {
    /** Persist a finished run; returns the stored row with its assigned id. */
    logAppend: (run: SyncRunCreateDto) =>
      call<SyncRunDto>(Commands.syncLogAppend, { run }),
    /** The most recent runs, newest first (native side caps the history). */
    logList: (limit?: number) =>
      call<SyncRunDto[]>(Commands.syncLogList, { limit }),
  },

  /**
   * Batch persistence (Epic 03) — local-only working state in the SQLite index.
   * `create` atomically writes the batch row, assigns the running `no`, and
   * stamps `batchId` onto each member item (→ In progress); `archive` marks the
   * batch uploaded and **releases** its items (clears `batchId` → Uploaded).
   * Owned by `core/db` (Arch); the logic lane consumes via `services/batches`.
   */
  batch: {
    /** All batches (finished + unfinished); the store filters for the list. */
    list: () => call<BatchDto[]>(Commands.batchList),
    /** Create a batch: persist it, assign `no`, and set each item's `batchId`. */
    create: (fields: BatchCreateDto) =>
      call<BatchDto>(Commands.batchCreate, { fields }),
    /** Persist a full batch (write-through for stage/running/proc/parents/…). */
    update: (batch: BatchDto) => call<BatchDto>(Commands.batchUpdate, { batch }),
    /** Archive an uploaded batch and release its items (clears their `batchId`). */
    archive: (batchId: string) =>
      call<BatchDto>(Commands.batchArchive, { batchId }),
  },

  /**
   * Pipeline job control (Epic 06). One batch runs at a time per workstation,
   * enforced native-side (the logic lane also guards via
   * `domain/batch.anyOtherRunning`). Owned by `core/jobs` (Arch). Progress and
   * outcomes stream back as `job://*` events (`ipc/events.ts`). The logic lane
   * drives these through `services/pipeline` + `stores/useProcessing`.
   */
  jobs: {
    /** Start a run (Start processing / Rerun all failed / per-item Rerun — the
     * `mode` + per-item `stages` scope it). Skip-if-done is already applied. */
    start: (request: BatchRunRequest) => call<void>(Commands.jobsStart, { request }),
    /** Cancel the active run for a batch. */
    cancel: (batchId: string) => call<void>(Commands.jobsCancel, { batchId }),
    /** Explicit re-process — force-rebuild the requested stages, overwriting old
     * outputs, and mark already-uploaded items **Needs re-upload**. Same
     * single-run lock. */
    reprocess: (request: BatchRunRequest) =>
      call<void>(Commands.jobsReprocess, { request }),
  },
} as const;

/** The secret-store key under which the old, manually-pasted Keycloak API
 * token used to be kept. Superseded by {@link KC_PASSWORD_SECRET_KEY} — kept
 * here only so any leftover stored value is inert rather than a dangling
 * reference; nothing reads or writes this key anymore. */
export const API_TOKEN_SECRET_KEY = "apiToken";

/** The secret-store key under which the Keycloak password is kept (the
 * username is not a secret — see `AppConfig.kcUsername`). See
 * `services/keycloakAuth.ts`, which mints and silently refreshes the actual
 * bearer token from the pair. */
export const KC_PASSWORD_SECRET_KEY = "kcPassword";
