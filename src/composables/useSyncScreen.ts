/**
 * `useSyncScreen` (Epic 08) — the view-model the **Sync** screen binds to
 * (Seam 1: Presentation ↔ Application). `SyncView.vue` imports only this; it
 * never touches the store, services, or IPC directly.
 *
 * Shapes the sync store into the header card (host, last/next sync, the live
 * progress + stage line), the four stat tiles, and the recent-syncs log.
 */

import { computed, getCurrentInstance, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useSyncStore } from "@stores/useSync";
import { useToastsStore } from "@stores/useToasts";
import type { SyncRunStatus } from "@ipc/bindings";

/** One of the four stat tiles. */
export interface SyncStatTile {
  label: string;
  value: string;
  /** Accent kind: 'plain' | 'info' | 'warn'. */
  accent: "plain" | "info" | "warn";
}

/** One row of the recent-syncs log. */
export interface SyncLogRow {
  id: string;
  status: SyncRunStatus;
  summary: string;
  detail: string;
  /** Finished-at, formatted for the row's right edge. */
  time: string;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return `Today · ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return `Yesterday · ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} · ${time}`;
}

export function useSyncScreen() {
  const store = useSyncStore();
  const toasts = useToastsStore();
  const {
    runs,
    running,
    error,
    host,
    lastSyncedAt,
    nextSyncDueAt,
    stats,
    canSync,
    progressFraction,
    stageLabel,
  } = storeToRefs(store);

  const hostLabel = computed(() => {
    const raw = host.value?.trim() ?? "";
    if (!raw) return "not configured";
    return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  });

  const lastSyncLabel = computed(() => formatTimestamp(lastSyncedAt.value));

  const nextSyncLabel = computed(() => {
    const due = nextSyncDueAt.value;
    if (!due) return "Every 6h";
    const time = due.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `Every 6h · next ${time}`;
  });

  const tiles = computed<SyncStatTile[]>(() => [
    {
      label: "Records checked",
      value: stats.value.checked.toLocaleString(),
      accent: "plain",
    },
    {
      label: "Metadata updated",
      value: stats.value.updated.toLocaleString(),
      accent: "info",
    },
    {
      label: "Up to date",
      value: stats.value.upToDate.toLocaleString(),
      accent: "plain",
    },
    {
      label: "Missed",
      value: stats.value.missed.toLocaleString(),
      accent: stats.value.missed > 0 ? "warn" : "plain",
    },
  ]);

  const log = computed<SyncLogRow[]>(() =>
    runs.value.map((run) => ({
      id: run.id,
      status: run.status,
      summary: run.summary,
      detail: run.detail,
      time: formatTimestamp(run.finishedAt),
    })),
  );

  async function syncNow(): Promise<void> {
    if (!canSync.value) {
      toasts.push("Backend unreachable — check the connection in Settings.", "warning");
      return;
    }
    await store.syncNow();
    if (!error.value) toasts.push("Sync complete — metadata up to date.", "success");
  }

  async function init(): Promise<void> {
    if (!store.loaded) await store.loadHistory();
  }

  if (getCurrentInstance()) onMounted(init);

  return {
    syncing: running,
    error,
    canSync,
    hostLabel,
    lastSyncLabel,
    nextSyncLabel,
    progressFraction,
    stageLabel,
    tiles,
    log,
    syncNow,
    cancel: store.cancel,
  };
}
