/**
 * Startup sequence — run once after Pinia is installed, before/at mount.
 *
 * Loads persisted config (which configures the API client), then kicks off an
 * initial backend reachability check in the background so the rail footer
 * settles quickly without blocking first paint.
 */

import type { Pinia } from "pinia";
import { useSettingsStore } from "@stores/useSettings";
import { useConnectionStore } from "@stores/useConnection";
import { useBatchesStore } from "@stores/useBatches";
import { useProcessingStore } from "@stores/useProcessing";
import { useSyncStore } from "@stores/useSync";
import { logger } from "@lib/logger";

export async function boot(pinia: Pinia): Promise<void> {
  const settings = useSettingsStore(pinia);
  try {
    await settings.load();
  } catch (err) {
    logger.error("boot", "Failed to load configuration.", err);
  }

  // Fire-and-forget: don't block startup on the network.
  const connection = useConnectionStore(pinia);
  void connection.check();

  // Load local batches from SQLite on relaunch: this is the one place batch
  // **crash recovery** runs (a batch left `running` by a dead prior session is
  // reset to a resumable state — gated to this first load; see
  // `useBatches.load()`), and it primes the rail's unfinished-batch badge before
  // any screen mounts. Fire-and-forget — the list/badge settle reactively.
  const batches = useBatchesStore(pinia);
  void batches.load();

  // Subscribe to the pipeline job events for the whole session, so a run's
  // coarse outcome (per-item `proc`, the batch `running` flag + `stage`) is
  // folded in and persisted even when the Processing tab isn't mounted — keeping
  // the single-run guard honest. No-op outside Tauri. Fire-and-forget.
  void useProcessingStore(pinia).startWatch();

  // Load the sync history, start the 6-hourly scheduler, and — if a sync is
  // already due — fetch current catalogue state so the archive opens up to date
  // (docs/tasks/08 §On-launch fetch). Fire-and-forget: a sync is background work
  // and must never delay first paint. It self-gates on connectivity, so a launch
  // while offline simply schedules instead of failing.
  void useSyncStore(pinia).initialise();
}
