/**
 * `useConnection` (Epic 01) — the view-model the rail's connection footer binds
 * to (Seam 1: Presentation ↔ Application). `ConnectionFooter.vue` imports only
 * this; it never touches the store, services, or IPC directly.
 *
 * Shapes the connection store into the footer's dot + label + host line and
 * keeps the state fresh with a low-frequency poll while mounted (boot() runs
 * the first check; Settings' "Test connection" shares the same store).
 */

import { computed, getCurrentInstance, onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { useConnectionStore } from "@stores/useConnection";
import type { ConnectionState } from "@domain/connection";

/** How often the footer re-pings the backend while the app is open. */
const POLL_INTERVAL_MS = 30_000;

const STATE_LABELS: Record<ConnectionState, string> = {
  unknown: "Not connected",
  checking: "Checking…",
  connected: "Connected",
  offline: "Offline",
};

export function useConnection() {
  const store = useConnectionStore();
  const { state, host, isOnline } = storeToRefs(store);

  const label = computed(() => STATE_LABELS[state.value]);

  /** Host shown in the footer — the base URL without scheme/trailing slash. */
  const hostLabel = computed(() => {
    const raw = host.value?.trim() ?? "";
    if (!raw) return "not configured";
    return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  });

  function check(): void {
    void store.check();
  }

  if (getCurrentInstance()) {
    let timer: ReturnType<typeof setInterval> | undefined;
    onMounted(() => {
      timer = setInterval(check, POLL_INTERVAL_MS);
    });
    onUnmounted(() => clearInterval(timer));
  }

  return { state, label, hostLabel, online: isOnline, check };
}
