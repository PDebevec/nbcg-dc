import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import type { ReachabilityResult } from "@domain/connection";

// ── the service layer this store sits on, faked ────────────────────────────
// The store's job is orchestration (when a probe runs, which result wins, who
// shares one), so `checkConnection` is a stub and the assertions are about calls.

const probes = {
  count: 0,
  /** Resolvers for each in-flight probe, so a test can settle them by hand. */
  pending: [] as Array<(result: ReachabilityResult) => void>,
};

function result(reachable: boolean): ReachabilityResult {
  return {
    reachable,
    reason: reachable ? "ok" : "unreachable",
    status: reachable ? 200 : 0,
    message: reachable ? "Connected." : "Unreachable.",
    checkedAt: "2026-08-08T00:00:00.000Z",
  };
}

vi.mock("@services/api", () => ({
  checkConnection: () => {
    probes.count += 1;
    return new Promise<ReachabilityResult>((resolve) => probes.pending.push(resolve));
  },
}));

vi.mock("@services/backend", () => ({
  getApiClient: () => ({}),
  isApiClientConfigured: () => true,
}));

vi.mock("./useSettings", () => ({
  useSettingsStore: () => ({ config: { backendBaseUrl: "http://localhost:3000" } }),
}));

const { useConnectionStore } = await import("./useConnection");

beforeEach(() => {
  setActivePinia(createPinia());
  probes.count = 0;
  probes.pending = [];
});

describe("useConnection.check", () => {
  it("reports the probe's verdict", async () => {
    const store = useConnectionStore();
    const task = store.check();
    expect(store.state).toBe("checking");

    probes.pending[0](result(true));
    await task;

    expect(store.state).toBe("connected");
    expect(store.isOnline).toBe(true);
    expect(store.checking).toBe(false);
  });

  // `boot()` fires a check without awaiting it, then `useSync.initialise()` needs
  // a settled answer and awaits one too. Without joining, that is two real health
  // requests every launch to learn one fact.
  it("joins a request already in flight instead of opening a second", async () => {
    const store = useConnectionStore();
    const first = store.check();
    const second = store.check();

    expect(probes.count).toBe(1);
    expect(probes.pending).toHaveLength(1);

    probes.pending[0](result(true));
    expect(await first).toEqual(await second);
    expect(store.state).toBe("connected");
  });

  it("probes again once the previous one has settled", async () => {
    const store = useConnectionStore();
    const first = store.check();
    probes.pending[0](result(true));
    await first;

    const second = store.check();
    expect(probes.count).toBe(2);
    probes.pending[1](result(false));
    await second;

    expect(store.state).toBe("offline");
    expect(store.isOnline).toBe(false);
  });
});
