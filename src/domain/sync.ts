/**
 * Sync **policy** (Epic 08) — the pure rules behind the one-way backend →
 * archive refresh. Framework-free and I/O-free: `services/sync` does the
 * fetching and writing, this decides what any given read *means*.
 *
 * The whole module exists because one fact makes naive syncing dangerous:
 *
 * > `GET /api/search/:id` returning **404 does not mean the item was deleted.**
 *
 * The backend answers 404 for four different situations, deliberately
 * indistinguishable (a visibility miss must not leak the item's existence):
 *
 *  1. **CDC lag** — the item was written seconds ago and pgsync has not indexed
 *     it yet;
 *  2. **Visibility** — the token lacks the scope to see it. `PUBLIC` records are
 *     the baseline, but PRIVATE/HIDDEN need `records:view:*`, and **drafts are
 *     invisible without an explicit `drafts:view:*` scope**. The archive
 *     publishes drafts, so a token without those scopes 404s on *every* draft it
 *     ever uploaded;
 *  3. **Infrastructure** — OpenSearch down or an index missing;
 *  4. **Actually deleted** on the website.
 *
 * Only (4) is an orphan. Treating any 404 as one would, with a mis-scoped token,
 * silently flag every draft in the archive as orphaned on the first sync. So
 * orphaning is deliberately hard to reach: it needs an unambiguous miss,
 * repeated across {@link ORPHAN_CONFIRMATIONS} runs hours apart, on an item old
 * enough to be past CDC lag, in a run that did not look systemically broken
 * ({@link isRunSuspicious}).
 *
 * The second rule worth stating up front: **sync never pushes and never changes
 * an item's derived state.** It refreshes the mirror; `uploaded`/`reupload` and
 * every stage status are left exactly as they were, so an item the operator has
 * dirtied stays "Needs re-upload" through any number of syncs.
 */

import type { ItemType, VisibilityStatus } from "./enums";
import type { Item } from "./item";
import type { LocalMetadataFile, RecordMetadata } from "./metadata";

// ─── cadence ────────────────────────────────────────────────────────────────

/** Auto-sync interval — every 6 hours (docs/tasks/08). */
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** When the next automatic sync is due, given the last run (null ⇒ due now). */
export function nextSyncAt(lastSyncedAt: string | null): Date | null {
  if (!lastSyncedAt) return null;
  const last = Date.parse(lastSyncedAt);
  if (Number.isNaN(last)) return null;
  return new Date(last + SYNC_INTERVAL_MS);
}

/** Whether an automatic sync is due. A never-synced archive is always due. */
export function isSyncDue(lastSyncedAt: string | null, now: Date = new Date()): boolean {
  const next = nextSyncAt(lastSyncedAt);
  return next === null || now.getTime() >= next.getTime();
}

// ─── orphan policy ──────────────────────────────────────────────────────────

/**
 * Consecutive unambiguous misses before an item is called orphaned. Two, not
 * one: runs are ~6 h apart, so a second miss rules out every transient cause
 * (CDC lag, a restarting OpenSearch, a token swapped mid-run) while still
 * surfacing a genuine website deletion within a day.
 */
export const ORPHAN_CONFIRMATIONS = 2;

/**
 * How long after an item's last local write its absence may count towards
 * orphaning. CDC lag is seconds; an hour is generous enough that a miss inside
 * the window is never evidence of deletion.
 */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Fraction of checked items that must go missing for a run to look systemically
 * broken. A mis-scoped token or a wiped index makes *everything* 404 at once;
 * genuine deletions arrive one or two at a time.
 */
export const SUSPICIOUS_MISS_RATIO = 0.5;

/** Below this many checked items the ratio is meaningless, so it is not applied
 * (1 of 1 missing is 100% but says nothing). */
export const SUSPICIOUS_MIN_SAMPLE = 4;

/**
 * True when a run's misses look like an infrastructure/scope problem rather than
 * real deletions. Such a run reports its misses but **increments no streaks** —
 * so a bad token can never orphan the archive.
 */
export function isRunSuspicious(checked: number, missing: number): boolean {
  if (checked < SUSPICIOUS_MIN_SAMPLE) return checked > 0 && missing === checked;
  return missing / checked >= SUSPICIOUS_MISS_RATIO;
}

/** Inputs to the per-item miss decision. */
export interface MissContext {
  /** The item's current persisted streak. */
  currentStreak: number;
  /** Age of the item's most recent local write/sync, in ms (null ⇒ unknown). */
  ageMs: number | null;
  /** Whether the run as a whole looked systemically broken. */
  runSuspicious: boolean;
}

/**
 * The streak value to persist after a miss. Only an **unambiguous** miss counts:
 * a suspicious run, or an item too fresh to be past CDC lag, leaves the streak
 * untouched rather than advancing it.
 */
export function nextMissStreak(context: MissContext): number {
  if (context.runSuspicious) return context.currentStreak;
  if (context.ageMs !== null && context.ageMs < ORPHAN_MIN_AGE_MS) {
    return context.currentStreak;
  }
  return context.currentStreak + 1;
}

/** Whether a streak has reached the confirmation threshold. */
export function isOrphanedStreak(streak: number): boolean {
  return streak >= ORPHAN_CONFIRMATIONS;
}

/**
 * Whether an item should be shown as orphaned — its backend record is confirmed
 * gone. Only ever true for an item that *has* a `backendId`: an item that was
 * never uploaded cannot be orphaned.
 */
export function isOrphaned(item: Item): boolean {
  return item.backendId !== null && isOrphanedStreak(item.syncMissStreak);
}

// ─── CDC-lag version guard ──────────────────────────────────────────────────

/**
 * Whether a `version` read from search may overwrite the locally-stored one.
 *
 * Search is CDC-fed, so a read can legitimately return an **older** version than
 * the archive already knows (it just wrote, the index has not caught up).
 * Accepting it would rewrite the mirror with a stale `expectedVersion` and make
 * the next `PATCH` fail with a 409. So the rule is: never move a version
 * backwards. A local `null` (never written) accepts anything.
 */
export function acceptRemoteVersion(
  local: number | null,
  remote: number | null | undefined,
): boolean {
  if (remote === null || remote === undefined) return false;
  if (local === null) return true;
  return remote >= local;
}

/** The version to store after a read — the remote one when acceptable, else the
 * local one unchanged. */
export function resolveVersion(
  local: number | null,
  remote: number | null | undefined,
): number | null {
  return acceptRemoteVersion(local, remote) ? (remote as number) : local;
}

// ─── mirror projection ──────────────────────────────────────────────────────

/** The backend facts a sync read yields for one item, already normalised out of
 * the wire shape by `services/sync` (kept framework-free here). */
export interface RemoteRecord {
  id: string;
  /** Which collection the backend has it in (it may have been transitioned). */
  targetState: ItemType | null;
  visibilityStatus: VisibilityStatus | null;
  version: number | null;
  metadata: RecordMetadata;
}

/**
 * Build the `metadata.json` mirror to write for an item, folding a remote read
 * over the previous mirror.
 *
 * The metadata blob is **replaced wholesale**, not merged: the backend is the
 * single source of truth and its `metadata` is the complete object. Merging
 * would resurrect fields deleted on the website. The version is the one
 * exception — it goes through {@link resolveVersion} so CDC lag cannot move it
 * backwards.
 */
export function projectMirror(
  previous: LocalMetadataFile | null,
  remote: RemoteRecord,
  syncedAt: string,
): LocalMetadataFile {
  return {
    backendId: remote.id,
    version: resolveVersion(previous?.version ?? null, remote.version),
    targetState: remote.targetState ?? previous?.targetState ?? null,
    visibilityStatus: remote.visibilityStatus ?? previous?.visibilityStatus ?? null,
    metadata: remote.metadata,
    syncedAt,
  };
}

/**
 * Whether a freshly-projected mirror differs from the stored one in any way that
 * matters. `syncedAt` is excluded on purpose — it changes every run, and letting
 * it count would rewrite every folder's file on every sync and report every item
 * as "updated", making the stat tiles meaningless.
 */
export function mirrorDiffers(
  previous: LocalMetadataFile | null,
  next: LocalMetadataFile,
): boolean {
  if (!previous) return true;
  return (
    previous.backendId !== next.backendId ||
    previous.version !== next.version ||
    (previous.targetState ?? null) !== (next.targetState ?? null) ||
    (previous.visibilityStatus ?? null) !== (next.visibilityStatus ?? null) ||
    !sameMetadata(previous.metadata, next.metadata)
  );
}

/** Order-insensitive deep comparison of two metadata blobs. JSON round-tripping
 * would report a false difference purely from key order, which the backend does
 * not guarantee. */
function sameMetadata(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameMetadata(item, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(bObj, key) &&
      sameMetadata(aObj[key], bObj[key]),
  );
}

// ─── per-item outcomes ──────────────────────────────────────────────────────

/**
 * What a sync run concluded about one item.
 *
 *  - `updated`    — found, and the mirror changed;
 *  - `up-to-date` — found, mirror already matched;
 *  - `missed`     — could not be confirmed this run (404 or a request failure).
 *    The `reason` says which, and `orphaned` says whether the streak has now
 *    reached the confirmation threshold;
 *  - `skipped`    — not eligible (no `backendId`, i.e. never uploaded).
 */
export type SyncOutcomeKind = "updated" | "up-to-date" | "missed" | "skipped";

/** Why an item was missed — separates "the backend says it's gone" from "we
 * could not ask". Only `not-found` can ever advance an orphan streak. */
export type MissReason = "not-found" | "request-failed" | "offline";

export interface SyncOutcome {
  itemId: string;
  kind: SyncOutcomeKind;
  /** Set when `kind === "missed"`. */
  reason?: MissReason;
  /** Set when `kind === "missed"` — the streak after this run. */
  missStreak?: number;
  /** Whether the item is now confirmed orphaned. */
  orphaned?: boolean;
  /** Human detail for the log (an error message, typically). */
  detail?: string;
}

// ─── run summary ────────────────────────────────────────────────────────────

/** The four stat tiles on the Sync screen. */
export interface SyncStats {
  /** Items with a `backendId` that this run tried to confirm. */
  checked: number;
  updated: number;
  upToDate: number;
  missed: number;
}

export type SyncRunStatus = "ok" | "warning" | "error";

export interface SyncRunSummary {
  status: SyncRunStatus;
  stats: SyncStats;
  /** One-line operator summary, e.g. "2 missed — backend timeout". */
  summary: string;
  /** Longer detail for the expanded log row. */
  detail: string;
}

/** Tally outcomes into the four tiles. `skipped` items are not "checked" — the
 * run never asked the backend about them. */
export function tally(outcomes: readonly SyncOutcome[]): SyncStats {
  const stats: SyncStats = { checked: 0, updated: 0, upToDate: 0, missed: 0 };
  for (const outcome of outcomes) {
    if (outcome.kind === "skipped") continue;
    stats.checked += 1;
    if (outcome.kind === "updated") stats.updated += 1;
    else if (outcome.kind === "up-to-date") stats.upToDate += 1;
    else if (outcome.kind === "missed") stats.missed += 1;
  }
  return stats;
}

function pluralItems(n: number): string {
  return n === 1 ? "1 record" : `${n} records`;
}

/** The dominant miss reason, for the one-line summary. */
function dominantMissReason(outcomes: readonly SyncOutcome[]): MissReason | null {
  const counts = new Map<MissReason, number>();
  for (const outcome of outcomes) {
    if (outcome.kind !== "missed" || !outcome.reason) continue;
    counts.set(outcome.reason, (counts.get(outcome.reason) ?? 0) + 1);
  }
  let best: MissReason | null = null;
  let bestCount = 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

const MISS_REASON_TEXT: Record<MissReason, string> = {
  "not-found": "not found on the backend",
  "request-failed": "backend timeout",
  offline: "archive offline",
};

/**
 * Reduce a run's outcomes to the summary the log row shows.
 *
 * `error` is reserved for a run that could not do its job at all (it was aborted
 * before checking anything, or every check failed); partial misses are a
 * `warning`, because the records that did sync are genuinely synced.
 */
export function summariseRun(
  outcomes: readonly SyncOutcome[],
  options: { aborted?: boolean; runSuspicious?: boolean; truncated?: boolean } = {},
): SyncRunSummary {
  const stats = tally(outcomes);
  const orphaned = outcomes.filter((o) => o.orphaned).length;
  const details: string[] = [];

  if (options.aborted) {
    return {
      status: "error",
      stats,
      summary: "Sync cancelled",
      detail: `Cancelled after checking ${pluralItems(stats.checked)}.`,
    };
  }

  if (stats.checked === 0) {
    return {
      status: "ok",
      stats,
      summary: "Nothing to sync",
      detail: "No uploaded records are tracked locally yet.",
    };
  }

  let status: SyncRunStatus = "ok";
  let summary: string;

  if (stats.missed === stats.checked) {
    status = "error";
    const reason = dominantMissReason(outcomes);
    summary = `Sync failed — ${MISS_REASON_TEXT[reason ?? "request-failed"]}`;
  } else if (stats.missed > 0) {
    status = "warning";
    const reason = dominantMissReason(outcomes);
    summary = `${stats.missed} missed — ${MISS_REASON_TEXT[reason ?? "request-failed"]}`;
  } else if (stats.updated > 0) {
    summary = `${pluralItems(stats.updated)} updated`;
  } else {
    summary = "Everything up to date";
  }

  details.push(
    `Checked ${pluralItems(stats.checked)}: ${stats.updated} updated, ` +
      `${stats.upToDate} already current, ${stats.missed} missed.`,
  );

  if (options.runSuspicious) {
    status = status === "ok" ? "warning" : status;
    details.push(
      "Most records were missing at once, which usually means the API token " +
        "lacks view scopes or the search index is unavailable — not that the " +
        "records were deleted. No item was flagged orphaned this run.",
    );
  }

  if (orphaned > 0) {
    status = status === "ok" ? "warning" : status;
    details.push(
      `${orphaned} confirmed missing from the backend across ` +
        `${ORPHAN_CONFIRMATIONS} runs and flagged orphaned. Local files are kept.`,
    );
  }

  if (options.truncated) {
    status = status === "ok" ? "warning" : status;
    details.push("Result set was truncated; some records were not listed.");
  }

  return { status, stats, summary, detail: details.join(" ") };
}

// ─── progress stages ────────────────────────────────────────────────────────

/** The run's coarse phases, in order — the Sync screen's stage text. */
export const SYNC_STAGES = [
  "contacting",
  "requesting",
  "matching",
  "writing",
  "done",
] as const;
export type SyncStage = (typeof SYNC_STAGES)[number];

/** Operator-facing stage text (docs/tasks/08 §Sync screen). */
export const SYNC_STAGE_LABELS: Record<SyncStage, string> = {
  contacting: "Contacting…",
  requesting: "Requesting catalog metadata…",
  matching: "Matching against archive records…",
  writing: "Writing updated metadata…",
  done: "Done",
};

/** Live progress for the bar + stage text. */
export interface SyncProgress {
  stage: SyncStage;
  /** Items confirmed so far, of `total`. */
  completed: number;
  total: number;
}

/** Progress as a 0–1 fraction; a run with nothing to do reads as complete. */
export function progressFraction(progress: SyncProgress): number {
  if (progress.total <= 0) return progress.stage === "done" ? 1 : 0;
  return Math.min(1, progress.completed / progress.total);
}

// ─── matching backend results to local folders ──────────────────────────────

/**
 * A backend record paired with the local item tracking it, if any. Drives the
 * "already local / web-only" marker in the search UI.
 */
export interface MatchedRecord<H> {
  hit: H;
  /** The local item whose `backendId` is this record's id, else null. */
  item: Item | null;
  /** Convenience: `item !== null`. */
  isLocal: boolean;
}

/**
 * Pair search hits with local items by connected `backendId`.
 *
 * Web-only records stay `item: null` — sync never creates a folder for a record
 * the archive does not already track (docs/tasks/08 §Refresh-local-only).
 */
export function matchHitsToItems<H extends { id: string }>(
  hits: readonly H[],
  items: readonly Item[],
): MatchedRecord<H>[] {
  const byBackendId = new Map<string, Item>();
  for (const item of items) {
    if (item.backendId) byBackendId.set(item.backendId, item);
  }
  return hits.map((hit) => {
    const item = byBackendId.get(hit.id) ?? null;
    return { hit, item, isLocal: item !== null };
  });
}

/** The items a sync run is allowed to refresh: those connected to a backend
 * record. Everything else has nothing to refresh *from*. */
export function syncableItems(items: readonly Item[]): Item[] {
  return items.filter((item) => item.backendId !== null);
}
