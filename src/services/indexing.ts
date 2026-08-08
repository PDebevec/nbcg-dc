/**
 * Indexing service (Epic 02) — the application-layer bridge between the native
 * local index (SQLite + folder scan, owned by the Arch lane) and the domain
 * {@link Item} model the Overview store/composable consume.
 *
 * Responsibilities:
 *  - map the raw {@link IndexedItemDto} to a domain {@link Item} — classifying
 *    each discovered file by naming convention and filling any stages the index
 *    has not recorded with `pending`;
 *  - expose scan / list / rebuild, the per-folder `metadata.json` mirror I/O,
 *    reveal-in-Explorer, and move-to-`/processed`.
 *
 * Non-Tauri fallback: running under a plain `vite` browser session (the GUI
 * lane's dev mode) there is no native index, so the read paths return an empty
 * list instead of throwing — the logic lane stays runnable without Rust. The
 * side-effecting paths (reveal/move/write) throw {@link IpcUnavailableError}
 * there, because silently succeeding would hide a real failure.
 */

import {
  ipc,
  isTauri,
  type IndexedItemDto,
  type IndexedStageDto,
  type SyncRecordDto,
} from "@ipc/bindings";
import { onFsChanged } from "@ipc/events";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { discoverAsset, type DiscoveredAsset } from "@domain/files";
import {
  STAGE_NAMES,
  emptyStages,
  type Item,
  type ItemStages,
  type StageName,
} from "@domain/item";
import type { LocalMetadataFile } from "@domain/metadata";
import { logger } from "@lib/logger";

/** Fill in every stage, defaulting any the index omitted to `pending`. */
function toStages(
  dtoStages: Partial<Record<StageName, IndexedStageDto>>,
): ItemStages {
  const stages = emptyStages();
  for (const name of STAGE_NAMES) {
    const outcome = dtoStages[name];
    if (outcome) {
      stages[name] = {
        status: outcome.status,
        error: outcome.error ?? null,
        updatedAt: outcome.updatedAt ?? null,
      };
    }
  }
  return stages;
}

function toAssets(dto: IndexedItemDto): DiscoveredAsset[] {
  return dto.assets.map((a) =>
    discoverAsset(a.filename, a.path, dto.folderName, a.sizeBytes),
  );
}

/** Map one native index row to a domain {@link Item}. */
export function toItem(dto: IndexedItemDto): Item {
  return {
    id: dto.id,
    folderName: dto.folderName,
    folderPath: dto.folderPath,
    root: dto.root,
    level: dto.level ?? "main",
    assets: toAssets(dto),
    stages: toStages(dto.stages),
    flags: { uploaded: dto.uploaded, reupload: dto.reupload },
    backendId: dto.backendId,
    batchId: dto.batchId,
    title: dto.title ?? null,
    catalogueId: dto.cobissId ?? null,
    createdAt: dto.createdAt ?? null,
    updatedAt: dto.updatedAt ?? null,
    syncMissStreak: dto.missStreak ?? 0,
  };
}

/** Rescan the configured roots, reconcile the index, and return the item list. */
export async function scanIndex(): Promise<Item[]> {
  if (!isTauri()) {
    logger.debug("indexing", "scanIndex: no Tauri runtime — returning [].");
    return [];
  }
  const dtos = await ipc.index.scan();
  return dtos.map(toItem);
}

/** Return the currently-tracked items without a rescan. */
export async function listIndex(): Promise<Item[]> {
  if (!isTauri()) return [];
  const dtos = await ipc.index.list();
  return dtos.map(toItem);
}

/** Reconstruct the SQLite index from folders, then return the item list. */
export async function rebuildIndex(): Promise<Item[]> {
  if (!isTauri()) return [];
  const dtos = await ipc.index.rebuild();
  return dtos.map(toItem);
}

/** Read an item's `metadata.json` mirror (null if absent, or outside Tauri). */
export function readItemMetadata(item: Item): Promise<LocalMetadataFile | null> {
  if (!isTauri()) return Promise.resolve(null);
  return ipc.fs.readMetadata(item.folderPath);
}

/** Write an item's `metadata.json` mirror (write-through; Epics 07 & 08). */
export function writeItemMetadata(
  item: Item,
  metadata: LocalMetadataFile,
): Promise<void> {
  return ipc.fs.writeMetadata(item.folderPath, metadata);
}

/**
 * Fold a backend→archive sync read onto an item's index row (Epic 08) and
 * return the updated item.
 *
 * Deliberately distinct from `recordUpload`: this must not touch `uploaded`,
 * `reupload`, or any stage status — sync is a read, and changing those would
 * move the item's derived state (see `ipc/bindings.SyncRecordDto`).
 */
export async function recordItemSync(
  itemId: string,
  sync: SyncRecordDto,
): Promise<Item> {
  const dto = await ipc.index.recordSync(itemId, sync);
  return toItem(dto);
}

/** Reveal an item's folder in the OS file manager. */
export function revealItem(item: Item): Promise<void> {
  return ipc.fs.reveal(item.folderPath);
}

/**
 * Move an item's folder `/unprocessed` → `/processed` and return the updated
 * row (the "reposition" on successful upload; triggered in Epic 07).
 */
export async function moveToProcessed(item: Item): Promise<Item> {
  const dto = await ipc.fs.moveToProcessed(item.id);
  return toItem(dto);
}

/**
 * Subscribe to native scan-root changes (new/changed/removed folders) so the
 * index can refresh without a restart. Returns an unlisten function; outside
 * Tauri the handler simply never fires (a no-op unlisten). Keeps the store's
 * native access behind this service, consistent with scan/list/rebuild.
 */
export function watchIndexChanges(handler: () => void): Promise<UnlistenFn> {
  return onFsChanged(handler);
}
