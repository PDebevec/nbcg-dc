/**
 * Connection store — backend reachability for the rail footer's
 * Connected / Offline dot. This is a separate axis from any item state
 * (docs/tasks/01). No token/identity check — see docs/PROJECT-KNOWLEDGE.md §3.
 */

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { checkConnection } from "@services/api";
import { getApiClient, isApiClientConfigured } from "@services/backend";
import {
  connectionStateFromResult,
  type ConnectionState,
  type ReachabilityResult,
} from "@domain/connection";
import { logger } from "@lib/logger";
import { useSettingsStore } from "./useSettings";

export const useConnectionStore = defineStore("connection", () => {
  const state = ref<ConnectionState>("unknown");
  const lastResult = ref<ReachabilityResult | null>(null);
  const checking = ref(false);

  const host = computed(() => useSettingsStore().config.backendBaseUrl);
  const isOnline = computed(() => state.value === "connected");

  // Monotonic token: overlapping checks (e.g. the footer poll racing a manual
  // Test connection) resolve out of order, so only the newest one applies its
  // result — a slower earlier check must not clobber a fresher state.
  let generation = 0;

  /** Ping the backend for reachability and update state. */
  async function check(): Promise<ReachabilityResult | null> {
    if (!isApiClientConfigured()) {
      state.value = "unknown";
      return null;
    }
    const gen = ++generation;
    checking.value = true;
    state.value = "checking";
    try {
      const result = await checkConnection(getApiClient(), {
        baseUrl: host.value,
      });
      if (gen !== generation) return result; // superseded — don't apply
      lastResult.value = result;
      state.value = connectionStateFromResult(result);
      return result;
    } catch (err) {
      if (gen === generation) {
        logger.error("connection", "Reachability check failed unexpectedly.", err);
        state.value = "offline";
      }
      return null;
    } finally {
      if (gen === generation) checking.value = false;
    }
  }

  return { state, lastResult, checking, host, isOnline, check };
});
