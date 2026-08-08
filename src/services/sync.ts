/**
 * Sync service (Epic 08) — the one-way **backend → archive** refresh.
 *
 * Pulls current catalogue metadata for every item the archive already tracks,
 * rewrites each folder's `metadata.json` mirror + its SQLite row, and records a
 * run summary for the Sync screen. It **never pushes** (upload is Epic 07) and
 * **never creates a folder** for a record that only exists on the website — the
 * archive discovers items from the filesystem, not from the backend.
 *
 * Structured like `services/upload`: store-free and fully injectable via
 * {@link SyncDeps}, so the whole run is unit-testable with no Tauri, no network,
 * and no Pinia. `stores/useSync` is the thin reactive wrapper.
 *
 * The run is **two-phase on purpose**:
 *
 *   1. *fetch* every tracked item, recording found / not-found / failed;
 *   2. *then* decide what each result means.
 *
 * Phase 2 cannot start early because the meaning of a single 404 depends on the
 * whole run: if most of the archive went missing at once, that is a token-scope
 * or index problem, not dozens of deletions, and no orphan streak may advance
 * (`domain/sync.isRunSuspicious`). A one-pass loop would have already written
 * the damage before it could tell.
 */

import type { Item } from "@domain/item";
import type { LocalMetadataFile, RecordMetadata } from "@domain/metadata";
import {
  isOrphanedStreak,
  isRunSuspicious,
  mirrorDiffers,
  nextMissStreak,
  progressFraction,
  projectMirror,
  summariseRun,
  syncableItems,
  type MissReason,
  type RemoteRecord,
  type SyncOutcome,
  type SyncProgress,
  type SyncStage,
} from "@domain/sync";
import { ApiError } from "./api/client";
import type { SearchHit } from "./api/dto";
import { findById, searchIndexToItemType } from "./api/search";
import {
  listIndex,
  readItemMetadata,
  recordItemSync,
  writeItemMetadata,
} from "./indexing";
import {
  ipc,
  isTauri,
  type SyncRecordDto,
  type SyncRunCreateDto,
  type SyncRunDto,
} from "@ipc/bindings";
import { logger } from "@lib/logger";

/** How many item reads are in flight at once. Small on purpose: the archive is
 * one workstation talking to a shared production API, and a sync is background
 * work that must never starve an operator's foreground upload. */
export const SYNC_CONCURRENCY = 4;

/**
 * Consecutive transport failures after which the run stops asking. Once the host
 * is unreachable every remaining request would burn the full client timeout
 * (30 s each), turning a 40-item sync into 20 minutes of certain failure.
 */
export const OFFLINE_GIVE_UP_AFTER = 3;

/** Everything the run touches, injected so it can be tested in isolation. */
export interface SyncDeps {
  /** The tracked item list (defaults to the local index). */
  listItems: () => Promise<Item[]>;
  /** Read a folder's `metadata.json` mirror. */
  readMirror: (item: Item) => Promise<LocalMetadataFile | null>;
  /** Write a folder's `metadata.json` mirror. */
  writeMirror: (item: Item, mirror: LocalMetadataFile) => Promise<void>;
  /** Fold the refreshed facts onto the item's SQLite row. */
  recordSync: (itemId: string, sync: SyncRecordDto) => Promise<Item>;
  /** Fetch one record from the backend by id (`null` ⇒ the backend said 404). */
  fetchRemote: (backendId: string, signal?: AbortSignal) => Promise<SearchHit | null>;
  /** Persist the finished run in the sync log. */
  appendLog: (run: SyncRunCreateDto) => Promise<SyncRunDto>;
  /** Current time as an ISO string (injectable for deterministic tests). */
  now: () => string;
}

export interface SyncOptions {
  deps?: Partial<SyncDeps>;
  signal?: AbortSignal;
  /** Live progress for the bar + stage text. */
  onProgress?: (progress: SyncProgress) => void;
  /** What started this run — recorded in the log. */
  trigger?: SyncRunCreateDto["trigger"];
}

/** The result of one run: the persisted summary plus the per-item detail. */
export interface SyncRunResult {
  run: SyncRunDto;
  outcomes: SyncOutcome[];
  /** True when the run stopped early because the backend was unreachable. */
  gaveUpOffline: boolean;
}

function defaultDeps(): SyncDeps {
  return {
    listItems: listIndex,
    readMirror: readItemMetadata,
    writeMirror: writeItemMetadata,
    recordSync: recordItemSync,
    fetchRemote: (backendId, signal) => findById(backendId, { signal }),
    appendLog: (run) => ipc.sync.logAppend(run),
    now: () => new Date().toISOString(),
  };
}

function resolveDeps(overrides?: Partial<SyncDeps>): SyncDeps {
  return { ...defaultDeps(), ...overrides };
}

/** Project a search hit into the framework-free {@link RemoteRecord} the domain
 * policy consumes. The index name carries `targetState` — the document itself
 * has no such field (see `services/api/search.searchIndexToItemType`). */
export function hitToRemote(hit: SearchHit): RemoteRecord {
  const source = hit.source ?? {};
  return {
    id: hit.id,
    targetState: searchIndexToItemType(hit.index),
    visibilityStatus: source.visibilityStatus ?? null,
    version: typeof source.version === "number" ? source.version : null,
    metadata: (source.metadata ?? {}) as RecordMetadata,
  };
}

/** The record title to cache on the index row, if the backend has one. */
function titleOf(metadata: RecordMetadata): string | null {
  const title = metadata.title;
  return typeof title === "string" && title.trim() !== "" ? title : null;
}

/** Age of an item's last confirmed local write, in ms — the CDC-lag guard's
 * input. `null` when the item has no mirror to date it by. */
function ageOf(mirror: LocalMetadataFile | null, nowIso: string): number | null {
  if (!mirror?.syncedAt) return null;
  const written = Date.parse(mirror.syncedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(written) || Number.isNaN(now)) return null;
  return Math.max(0, now - written);
}

/** What one fetch produced, before the run-wide interpretation in phase 2. */
interface FetchResult {
  item: Item;
  hit: SearchHit | null;
  /** Set when the request itself failed (as opposed to a clean 404). */
  failure?: { reason: Exclude<MissReason, "not-found">; detail: string };
  /** True when the run had already given up and never asked. */
  unasked?: boolean;
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Run a full backend → archive sync.
 *
 * Resolves even when things go wrong — a failed run is a recorded run with a
 * `warning`/`error` status, not a thrown exception. The only rejection path is a
 * failure to persist the log itself.
 */
export async function syncTracked(
  options: SyncOptions = {},
): Promise<SyncRunResult> {
  const deps = resolveDeps(options.deps);
  const startedAt = deps.now();
  const signal = options.signal;

  const report = (stage: SyncStage, completed: number, total: number): void => {
    options.onProgress?.({ stage, completed, total });
  };

  // ── phase 0: what is there to sync ────────────────────────────────────────
  report("contacting", 0, 0);
  const allItems = await deps.listItems();
  const targets = syncableItems(allItems);
  const total = targets.length;

  if (total === 0) {
    report("done", 0, 0);
    return finish(deps, [], { startedAt, trigger: options.trigger });
  }

  // ── phase 1: fetch ────────────────────────────────────────────────────────
  report("requesting", 0, total);
  let completed = 0;
  // Shared across workers: once the host is clearly unreachable, stop asking.
  let consecutiveTransportFailures = 0;
  let gaveUpOffline = false;

  const fetched = await mapWithConcurrency(targets, SYNC_CONCURRENCY, async (item) => {
    const result: FetchResult = { item, hit: null };

    if (signal?.aborted) {
      result.unasked = true;
      return result;
    }
    if (gaveUpOffline) {
      result.unasked = true;
      result.failure = { reason: "offline", detail: "Backend unreachable." };
      completed += 1;
      report("requesting", completed, total);
      return result;
    }

    try {
      result.hit = await deps.fetchRemote(item.backendId as string, signal);
      consecutiveTransportFailures = 0;
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const offline = apiError?.isNetworkError ?? false;
      if (offline) {
        consecutiveTransportFailures += 1;
        if (consecutiveTransportFailures >= OFFLINE_GIVE_UP_AFTER) {
          gaveUpOffline = true;
          logger.warn(
            "sync",
            `Backend unreachable after ${OFFLINE_GIVE_UP_AFTER} attempts — abandoning the rest of the run.`,
          );
        }
      } else {
        // A non-transport failure (5xx, 403, malformed response) is per-item;
        // it says nothing about reachability, so it must not trip the give-up.
        consecutiveTransportFailures = 0;
      }
      result.failure = {
        reason: offline ? "offline" : "request-failed",
        detail: (err as Error)?.message ?? String(err),
      };
    }

    completed += 1;
    report("requesting", completed, total);
    return result;
  });

  if (signal?.aborted) {
    report("done", completed, total);
    return finish(deps, [], {
      startedAt,
      trigger: options.trigger,
      aborted: true,
      checkedForAbort: completed,
    });
  }

  // ── phase 2: interpret the run as a whole ─────────────────────────────────
  report("matching", completed, total);
  const notFound = fetched.filter((f) => f.hit === null && !f.failure).length;
  const runSuspicious = isRunSuspicious(total, notFound);
  if (runSuspicious) {
    logger.warn(
      "sync",
      `${notFound}/${total} tracked records were missing at once — treating the run as ` +
        "suspicious (token scopes or search index), not as deletions. No orphan streaks advanced.",
    );
  }

  // ── phase 3: write through ────────────────────────────────────────────────
  report("writing", completed, total);
  const outcomes: SyncOutcome[] = [];
  for (const result of fetched) {
    outcomes.push(await applyResult(result, deps, runSuspicious));
  }

  report("done", total, total);
  return finish(deps, outcomes, {
    startedAt,
    trigger: options.trigger,
    runSuspicious,
    gaveUpOffline,
  });
}

/** Apply one fetch result: rewrite the mirror + row, or advance a miss streak. */
async function applyResult(
  result: FetchResult,
  deps: SyncDeps,
  runSuspicious: boolean,
): Promise<SyncOutcome> {
  const { item } = result;
  const syncedAt = deps.now();

  // ── the request failed, or was never made: record nothing ────────────────
  // A transport failure is not evidence about the record. Writing anything here
  // (least of all a streak) would let a flaky network drift the archive towards
  // orphaning items that are perfectly fine.
  if (result.failure) {
    return {
      itemId: item.id,
      kind: "missed",
      reason: result.failure.reason,
      missStreak: item.syncMissStreak,
      orphaned: isOrphanedStreak(item.syncMissStreak),
      detail: result.failure.detail,
    };
  }
  if (result.unasked) {
    return { itemId: item.id, kind: "missed", reason: "offline", missStreak: item.syncMissStreak };
  }

  let previousMirror: LocalMetadataFile | null = null;
  try {
    previousMirror = await deps.readMirror(item);
  } catch (err) {
    // An unreadable mirror is not fatal — treat it as absent and rewrite it.
    logger.warn("sync", `Could not read the mirror for ${item.folderName}.`, err);
  }

  // ── a clean 404 ───────────────────────────────────────────────────────────
  if (result.hit === null) {
    const streak = nextMissStreak({
      currentStreak: item.syncMissStreak,
      ageMs: ageOf(previousMirror, syncedAt),
      runSuspicious,
    });
    const orphaned = isOrphanedStreak(streak);

    if (streak !== item.syncMissStreak) {
      try {
        await deps.recordSync(item.id, {
          version: null,
          targetState: null,
          visibilityStatus: null,
          title: null,
          missStreak: streak,
          syncedAt,
        });
      } catch (err) {
        logger.error("sync", `Failed to record a miss for ${item.folderName}.`, err);
      }
    }

    return {
      itemId: item.id,
      kind: "missed",
      reason: "not-found",
      missStreak: streak,
      orphaned,
      detail: orphaned
        ? "Confirmed missing from the backend; flagged orphaned. Local files kept."
        : "Not found on the backend this run.",
    };
  }

  // ── found ─────────────────────────────────────────────────────────────────
  const remote = hitToRemote(result.hit);
  const nextMirror = projectMirror(previousMirror, remote, syncedAt);
  const changed = mirrorDiffers(previousMirror, nextMirror);

  try {
    if (changed) await deps.writeMirror(item, nextMirror);
    // The row is refreshed even on a no-change read, because finding the record
    // is what CLEARS a miss streak — an item that reappears must stop being
    // orphaned regardless of whether its metadata happened to change.
    if (changed || item.syncMissStreak !== 0) {
      await deps.recordSync(item.id, {
        version: nextMirror.version,
        targetState: remote.targetState,
        visibilityStatus: remote.visibilityStatus,
        title: titleOf(remote.metadata),
        missStreak: 0,
        syncedAt,
      });
    }
  } catch (err) {
    logger.error("sync", `Failed to write the refresh for ${item.folderName}.`, err);
    return {
      itemId: item.id,
      kind: "missed",
      reason: "request-failed",
      missStreak: item.syncMissStreak,
      detail: `Fetched, but could not write locally: ${(err as Error)?.message ?? err}`,
    };
  }

  return { itemId: item.id, kind: changed ? "updated" : "up-to-date" };
}

/** Summarise, persist, and return the run. */
async function finish(
  deps: SyncDeps,
  outcomes: SyncOutcome[],
  context: {
    startedAt: string;
    trigger?: SyncRunCreateDto["trigger"];
    aborted?: boolean;
    runSuspicious?: boolean;
    gaveUpOffline?: boolean;
    checkedForAbort?: number;
  },
): Promise<SyncRunResult> {
  const summary = summariseRun(outcomes, {
    aborted: context.aborted,
    runSuspicious: context.runSuspicious,
  });
  const create: SyncRunCreateDto = {
    startedAt: context.startedAt,
    finishedAt: deps.now(),
    status: summary.status,
    trigger: context.trigger ?? "manual",
    checked: context.aborted ? (context.checkedForAbort ?? 0) : summary.stats.checked,
    updated: summary.stats.updated,
    upToDate: summary.stats.upToDate,
    missed: summary.stats.missed,
    summary: summary.summary,
    detail: summary.detail,
  };

  let run: SyncRunDto;
  try {
    run = await deps.appendLog(create);
  } catch (err) {
    // Outside Tauri (the GUI lane's browser dev mode) there is no native log.
    // The run still happened and its result is still useful, so synthesise a
    // row rather than failing a completed sync over its bookkeeping.
    if (!isTauri()) {
      run = { id: `local-${context.startedAt}`, ...create };
    } else {
      logger.error("sync", "Failed to persist the sync run.", err);
      throw err;
    }
  }

  return { run, outcomes, gaveUpOffline: context.gaveUpOffline ?? false };
}

/** Read the persisted run history (newest first). Empty outside Tauri. */
export async function listSyncRuns(limit?: number): Promise<SyncRunDto[]> {
  if (!isTauri()) return [];
  return ipc.sync.logList(limit);
}

/** Convenience re-export so the store can render a progress bar without also
 * importing from `@domain/sync`. */
export { progressFraction };
