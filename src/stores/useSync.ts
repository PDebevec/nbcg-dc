/**
 * Sync store (Epic 08) — the reactive state behind the **Sync** screen and the
 * 6-hourly automatic backend → archive refresh.
 *
 * A thin wrapper: all the policy lives in `domain/sync` and all the work in
 * `services/sync`. What this owns is the *session* concerns — the live progress
 * feed, the run history, cancellation, and the scheduler.
 *
 * Two scheduling decisions worth stating, because both are about not making
 * things worse when the backend is unhappy:
 *
 *  - The scheduler is a **1-minute tick that asks whether a sync is due**, not a
 *    6-hour timer. A single long timer silently loses time across sleep/hibernate
 *    (an overnight-suspended workstation would wake believing it had just synced),
 *    and cannot react to the clock changing. The tick re-derives due-ness from
 *    the persisted timestamp every minute, so it is correct after any suspension.
 *  - Due-ness is measured from the last **successful** run, but retries are
 *    additionally rate-limited by {@link RETRY_MIN_INTERVAL_MS}. Without that,
 *    an unreachable backend would leave the archive permanently "due" and the
 *    tick would launch a doomed sync every single minute.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  SYNC_INTERVAL_MS,
  isSyncDue,
  nextSyncAt,
  progressFraction,
  type SyncProgress,
  type SyncStats,
} from "@domain/sync";
import { SYNC_STAGE_LABELS } from "@domain/sync";
import { listSyncRuns, syncTracked } from "@services/sync";
import type { SyncRunDto } from "@ipc/bindings";
import { logger } from "@lib/logger";
import { useConnectionStore } from "./useConnection";
import { useItemsStore } from "./useItems";
import { useSettingsStore } from "./useSettings";

/** How often the scheduler re-checks whether a sync is due. */
export const SCHEDULER_TICK_MS = 60_000;

/**
 * Minimum gap between *attempts*, regardless of due-ness. Guards the case where
 * every run fails: the archive stays due (nothing succeeded), so without this the
 * tick would retry every minute forever.
 */
export const RETRY_MIN_INTERVAL_MS = 15 * 60 * 1000;

/** How many runs the screen's log keeps in view. */
export const RUN_HISTORY_LIMIT = 20;

const EMPTY_STATS: SyncStats = { checked: 0, updated: 0, upToDate: 0, missed: 0 };

export const useSyncStore = defineStore("sync", () => {
  const runs = ref<SyncRunDto[]>([]);
  const running = ref(false);
  const progress = ref<SyncProgress>({ stage: "done", completed: 0, total: 0 });
  const error = ref<string | null>(null);
  const loaded = ref(false);

  /** Set while a run is in flight, so it can be cancelled. */
  let controller: AbortController | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Guards against two runs overlapping (a tick firing into a manual sync). */
  let inFlight: Promise<void> | null = null;
  /** Last attempt, successful or not — feeds the retry rate-limit. */
  const lastAttemptAt = ref<string | null>(null);

  // ── derived ───────────────────────────────────────────────────────────────

  const host = computed(() => useSettingsStore().config.backendBaseUrl);

  /** The most recent run of any outcome — the log's top row. */
  const lastRun = computed<SyncRunDto | null>(() => runs.value[0] ?? null);

  /**
   * The newest run that actually synced something. An `error` run (cancelled, or
   * every record missed) must NOT count as a sync, or a failure would push the
   * next attempt six hours out.
   */
  const lastSuccessfulRun = computed<SyncRunDto | null>(
    () => runs.value.find((run) => run.status !== "error") ?? null,
  );

  const lastSyncedAt = computed<string | null>(
    () => lastSuccessfulRun.value?.finishedAt ?? null,
  );

  const nextSyncDueAt = computed<Date | null>(() => nextSyncAt(lastSyncedAt.value));

  /** The four stat tiles from the last run. */
  const stats = computed<SyncStats>(() => {
    const run = lastRun.value;
    if (!run) return EMPTY_STATS;
    return {
      checked: run.checked,
      updated: run.updated,
      upToDate: run.upToDate,
      missed: run.missed,
    };
  });

  const isOnline = computed(() => useConnectionStore().isOnline);

  /** Sync is a backend-dependent action: unavailable while offline or running. */
  const canSync = computed(() => !running.value && isOnline.value);

  const progressFractionValue = computed(() => progressFraction(progress.value));
  const stageLabel = computed(() => SYNC_STAGE_LABELS[progress.value.stage]);

  // ── history ───────────────────────────────────────────────────────────────

  /** Load the persisted run log (call once on boot). */
  async function loadHistory(): Promise<void> {
    try {
      runs.value = await listSyncRuns(RUN_HISTORY_LIMIT);
      loaded.value = true;
    } catch (err) {
      logger.error("sync", "Failed to load the sync history.", err);
    }
  }

  // ── running ───────────────────────────────────────────────────────────────

  /** Whether enough time has passed since the last attempt to try again. */
  function retryAllowed(now: number): boolean {
    if (!lastAttemptAt.value) return true;
    const last = Date.parse(lastAttemptAt.value);
    if (Number.isNaN(last)) return true;
    return now - last >= RETRY_MIN_INTERVAL_MS;
  }

  /**
   * Run a sync. Concurrent calls join the run already in flight rather than
   * starting a second one — the tick and a manual **Sync now** can easily
   * coincide, and two runs writing the same mirrors would race.
   */
  async function run(trigger: SyncRunDto["trigger"] = "manual"): Promise<void> {
    if (inFlight) return inFlight;

    const task = (async () => {
      running.value = true;
      error.value = null;
      controller = new AbortController();
      lastAttemptAt.value = new Date().toISOString();
      try {
        const result = await syncTracked({
          signal: controller.signal,
          trigger,
          onProgress: (next) => {
            progress.value = next;
          },
        });
        // Newest first; the native log is capped, this view is too.
        runs.value = [result.run, ...runs.value].slice(0, RUN_HISTORY_LIMIT);

        // Titles, orphan flags, and published state may all have moved — refresh
        // the Overview so the table reflects the archive we just rewrote.
        if (result.run.updated > 0 || result.run.missed > 0) {
          await useItemsStore().load();
        }
      } catch (err) {
        error.value = (err as Error)?.message ?? "Sync failed.";
        logger.error("sync", "Sync run failed.", err);
      } finally {
        running.value = false;
        controller = null;
        inFlight = null;
      }
    })();

    inFlight = task;
    return task;
  }

  /** The operator's **Sync now**. */
  function syncNow(): Promise<void> {
    return run("manual");
  }

  /** Cancel the in-flight run (the service records it as a cancelled run). */
  function cancel(): void {
    controller?.abort();
  }

  // ── scheduler ─────────────────────────────────────────────────────────────

  /** One scheduler tick: sync if due, allowed to retry, and actually able to. */
  async function tick(): Promise<void> {
    if (running.value || !isOnline.value) return;
    const now = Date.now();
    if (!isSyncDue(lastSyncedAt.value, new Date(now))) return;
    if (!retryAllowed(now)) return;
    await run("auto");
  }

  /** Start the 6-hourly auto-sync. Idempotent. */
  function startScheduler(): void {
    if (tickTimer) return;
    tickTimer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
  }

  function stopScheduler(): void {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  /**
   * The on-launch fetch — open the archive with current catalogue state.
   *
   * Loads the history first so due-ness is judged against the persisted last
   * run, not against an empty list (which would re-sync on every single launch).
   * Then waits for reachability to actually settle: `boot()` kicks the check off
   * without awaiting it, so reading `isOnline` here would still see the initial
   * "unknown" and skip the launch fetch every time.
   */
  async function initialise(): Promise<void> {
    await loadHistory();
    startScheduler();

    const connection = useConnectionStore();
    if (connection.state === "unknown" || connection.state === "checking") {
      await connection.check();
    }

    if (isOnline.value && isSyncDue(lastSyncedAt.value)) {
      await run("launch");
    }
  }

  return {
    // state
    runs,
    running,
    progress,
    error,
    loaded,
    lastAttemptAt,
    // derived
    host,
    lastRun,
    lastSuccessfulRun,
    lastSyncedAt,
    nextSyncDueAt,
    stats,
    isOnline,
    canSync,
    progressFraction: progressFractionValue,
    stageLabel,
    syncIntervalMs: SYNC_INTERVAL_MS,
    // actions
    loadHistory,
    syncNow,
    cancel,
    startScheduler,
    stopScheduler,
    initialise,
  };
});
