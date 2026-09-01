/**
 * The **Item** domain model + its derived state machine (Epic 02).
 *
 * An item is one digitised document, backed by a single scan folder. The SQLite
 * index (owned by the Arch lane) stores the underlying *facts* — per-stage
 * outcomes, flags, batch membership, connected backend id. The item's
 * user-facing **state** is never stored: it is **re-derived** from those facts
 * every render by {@link deriveItemState}, so there is a single source of truth
 * for "where is this item" (see docs/01-concept-and-ux.md and docs/tasks/02).
 *
 * Framework-free (imports only sibling domain types), so every lane can consume
 * it without crossing a service seam.
 */

import type { DiscoveredAsset } from "./files";

/** Which record level an item is catalogued at (drives the schema field-set). */
export type ItemLevel = "main" | "child";

/** The two scan roots an item folder can live under. */
export type ScanRoot = "unprocessed" | "processed";

/**
 * The five pipeline stages, in run order. This ordering is also the left→right
 * order of the per-row stage indicators in the Overview table
 * (PDF · Thumbnail · OCR · Metadata · Uploaded).
 */
export const STAGE_NAMES = [
  "pdf",
  "thumbnail",
  "ocr",
  "metadata",
  "upload",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/** Human labels for the stage pips (the only place stage copy is centralised). */
export const STAGE_LABELS: Record<StageName, string> = {
  pdf: "PDF",
  thumbnail: "Thumbnail",
  ocr: "OCR",
  metadata: "Metadata",
  upload: "Uploaded",
};

/**
 * A single stage's status. `queued` is the transient state while a batch run is
 * scheduled; `skipped` marks a stage that does not apply to this item (e.g. OCR
 * on an images-only item — see {@link DiscoveredAsset}/`ocrApplicable`).
 */
export type StageStatus =
  | "pending"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "skipped";

/** One stage's recorded outcome in the index. */
export interface StageOutcome {
  status: StageStatus;
  /** Failure message for a `failed` stage (shown on Stopped rows). */
  error?: string | null;
  /** ISO timestamp of the last status change, if the index tracks it. */
  updatedAt?: string | null;
}

/** The per-stage status map. Always carries all five stages. */
export type ItemStages = Record<StageName, StageOutcome>;

/**
 * The two persisted boolean flags the state machine reads (everything else it
 * derives from stage statuses / batch membership).
 *  - `uploaded`  — the item has been published to the backend at least once.
 *  - `reupload`  — a published item changed since (new derived file) and must be
 *    pushed again.
 */
export interface ItemFlags {
  uploaded: boolean;
  reupload: boolean;
}

/**
 * One digitised document. Assembled by `services/indexing` from the native
 * index DTO; consumed by the Overview store/composable and (later) the batch
 * and upload flows.
 */
export interface Item {
  /** Stable local index id (relative-path derived native-side — see
   * `core::fs::item_id_for`). */
  id: string;
  /** Folder base name — the derived-output naming base (docs/01 §Naming). */
  folderName: string;
  /** Absolute path to the item's folder on disk. */
  folderPath: string;
  /** Path relative to this item's scan root, forward-slash-joined (equal to
   * `folderName` at depth 1 — a folder no longer has to sit directly under
   * the root to be an item, see
   * `docs/tasks/nested-record-folders-and-manual-selection.md`). Drives the
   * Overview list's indentation via `domain/overview.depthOf`. */
  relativePath: string;
  /** Operator-hidden from the default Overview list (never set automatically —
   * see `domain/overview`'s hidden-row filtering). */
  hidden: boolean;
  root: ScanRoot;
  level: ItemLevel;
  /** Discovered files in the folder, classified by naming convention. */
  assets: DiscoveredAsset[];
  stages: ItemStages;
  flags: ItemFlags;
  /** The connected backend `Draft`/`Record` id once uploaded, else null. */
  backendId: string | null;
  /** Local batch this item belongs to while being worked, else null. Batches
   * are local-only working state; an uploaded batch releases its items (clears
   * this) — so a non-null value implies an *active* (unfinished) batch. */
  batchId: string | null;
  /** Cached title (from the local `metadata.json` mirror) for the table + search. */
  title: string | null;
  /** COBISS / catalogue id, for search. */
  catalogueId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * Consecutive backend→archive sync runs that could not find this item's
   * `backendId` (Epic 08). `0` whenever it was last seen. "Orphaned" is derived
   * from this — `domain/sync.isOrphaned` — rather than stored, so there is one
   * source of truth for a state that must be *confirmed* across runs and can be
   * un-confirmed by the record reappearing.
   */
  syncMissStreak: number;
}

/**
 * The derived item states (stable machine keys; {@link ITEM_STATE_LABELS} maps
 * them to display text). Not stored — computed by {@link deriveItemState}.
 */
export const ItemState = {
  Uploaded: "uploaded",
  InProgress: "in-progress",
  NeedsReupload: "needs-reupload",
  Stopped: "stopped",
  ToProcess: "to-process",
} as const;
export type ItemState = (typeof ItemState)[keyof typeof ItemState];

export const ITEM_STATE_LABELS: Record<ItemState, string> = {
  "uploaded": "Uploaded",
  "in-progress": "In progress",
  "needs-reupload": "Needs re-upload",
  "stopped": "Stopped",
  "to-process": "To process",
};

/** True when any pipeline stage has failed. */
export function hasFailedStage(stages: ItemStages): boolean {
  return STAGE_NAMES.some((s) => stages[s].status === "failed");
}

/** True when the item has been published (flag set or the upload stage is done). */
export function isPublished(item: Item): boolean {
  return item.flags.uploaded || item.stages.upload.status === "done";
}

/**
 * Derive an item's state from its facts. **First match wins**, in the order from
 * docs/01-concept-and-ux.md:
 *
 *   Uploaded → In progress → Needs re-upload → Stopped → To process
 *
 * Two refinements the summary table leaves implicit (both required to satisfy
 * the concept prose in docs/01 and the Epic 02/03 acceptance criteria):
 *
 *  - **Uploaded requires not-`reupload`** — a published item that was dirtied
 *    carries BOTH `uploaded` and `reupload`; without this, "Needs re-upload"
 *    would be unreachable.
 *  - **Uploaded requires no active batch** (`batchId == null`) — a re-work batch
 *    is created from Done items *before* any edit sets `reupload`, so a clean
 *    published item locked to that batch must read **In progress** ("locked to
 *    that batch"; "Create batch → In progress"), not Uploaded. On upload the
 *    batch releases its items (`batchId` cleared) and they settle to Uploaded
 *    or, if still dirty, Needs re-upload.
 *
 * Net effect: In progress wins over the published states for any item currently
 * in an active batch, while a released clean item is Uploaded.
 */
export function deriveItemState(item: Item): ItemState {
  const published = isPublished(item);

  // 1. Uploaded — published, in sync, and not locked to an active batch.
  if (published && !item.flags.reupload && item.batchId == null) {
    return ItemState.Uploaded;
  }

  // 2. In progress — locked to an active (unfinished) batch (beats a stale
  //    published/reupload/failed state: the item is actively being worked).
  if (item.batchId != null) return ItemState.InProgress;

  // 3. Needs re-upload — published earlier, changed since, must be pushed again.
  if (item.flags.reupload) return ItemState.NeedsReupload;

  // 4. Stopped — a pipeline stage errored.
  if (hasFailedStage(item.stages)) return ItemState.Stopped;

  // 5. To process — a fresh scan awaiting batching.
  return ItemState.ToProcess;
}

/** Display status for a single stage pip. Adds `re-upload` — the upload pip's
 * appearance when a published item is dirty (docs/tasks/02: dots are
 * `done`/`failed`/`re-upload`). */
export type StagePipStatus = StageStatus | "re-upload";

/** Resolve the *display* status of one stage's pip, folding the re-upload flag
 * into the upload stage. */
export function stagePipStatus(item: Item, stage: StageName): StagePipStatus {
  if (stage === "upload" && item.flags.reupload && isPublished(item)) {
    return "re-upload";
  }
  return item.stages[stage].status;
}

/** The first failed stage's error message, if any (shown on Stopped rows). */
export function firstStageError(item: Item): string | null {
  for (const s of STAGE_NAMES) {
    const outcome = item.stages[s];
    if (outcome.status === "failed" && outcome.error) return outcome.error;
  }
  return null;
}

/** A fresh, all-pending stage map — the default for a newly scanned folder. */
export function emptyStages(): ItemStages {
  return {
    pdf: { status: "pending" },
    thumbnail: { status: "pending" },
    ocr: { status: "pending" },
    metadata: { status: "pending" },
    upload: { status: "pending" },
  };
}
