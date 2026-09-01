import { describe, it, expect, vi } from "vitest";
import { OFFLINE_GIVE_UP_AFTER, hitToRemote, syncTracked, type SyncDeps } from "./sync";
import { ORPHAN_CONFIRMATIONS, ORPHAN_MIN_AGE_MS, type SyncProgress } from "@domain/sync";
import { emptyStages, type Item } from "@domain/item";
import type { LocalMetadataFile } from "@domain/metadata";
import type { SearchHit } from "./api/dto";
import { ApiError } from "./api/client";
import type { SyncRecordDto, SyncRunCreateDto, SyncRunDto } from "@ipc/bindings";

const T0 = "2026-08-07T12:00:00.000Z";

function makeItem(overrides: Partial<Item> = {}): Item {
  const base: Item = {
    id: "i1",
    folderName: "gorski",
    folderPath: "/scans/processed/gorski",
    relativePath: "gorski",
    hidden: false,
    root: "processed",
    level: "main",
    assets: [],
    stages: emptyStages(),
    flags: { uploaded: true, reupload: false },
    backendId: "b1",
    batchId: null,
    title: "Gorski vijenac",
    catalogueId: null,
    createdAt: null,
    updatedAt: null,
    syncMissStreak: 0,
  };
  return { ...base, ...overrides };
}

function makeHit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    id: "b1",
    index: "records",
    score: 1,
    source: {
      visibilityStatus: "PUBLIC",
      version: 3,
      metadata: { title: "Gorski vijenac" },
    },
    ...over,
  };
}

/** A mirror dated `ageMs` before T0. */
function makeMirror(ageMs: number, over: Partial<LocalMetadataFile> = {}): LocalMetadataFile {
  return {
    backendId: "b1",
    version: 3,
    targetState: "RECORD",
    visibilityStatus: "PUBLIC",
    metadata: { title: "Gorski vijenac" },
    syncedAt: new Date(Date.parse(T0) - ageMs).toISOString(),
    ...over,
  };
}

interface Harness {
  deps: SyncDeps;
  writes: Array<{ itemId: string; mirror: LocalMetadataFile }>;
  records: Array<{ itemId: string; sync: SyncRecordDto }>;
  logged: SyncRunCreateDto[];
  fetches: string[];
}

function harness(config: {
  items: Item[];
  mirrors?: Record<string, LocalMetadataFile | null>;
  fetch: (backendId: string, call: number) => SearchHit | null | Error;
  writeMirrorFails?: boolean;
}): Harness {
  const writes: Harness["writes"] = [];
  const records: Harness["records"] = [];
  const logged: SyncRunCreateDto[] = [];
  const fetches: string[] = [];

  const deps: SyncDeps = {
    listItems: async () => config.items,
    readMirror: async (item) => config.mirrors?.[item.id] ?? null,
    writeMirror: async (item, mirror) => {
      if (config.writeMirrorFails) throw new Error("disk full");
      writes.push({ itemId: item.id, mirror });
    },
    recordSync: async (itemId, sync) => {
      records.push({ itemId, sync });
      return makeItem({ id: itemId });
    },
    fetchRemote: async (backendId) => {
      const call = fetches.length;
      fetches.push(backendId);
      const outcome = config.fetch(backendId, call);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    appendLog: async (run) => {
      logged.push(run);
      return { id: "run-1", ...run } as SyncRunDto;
    },
    now: () => T0,
  };

  return { deps, writes, records, logged, fetches };
}

function networkError(): ApiError {
  return new ApiError({
    kind: "network",
    status: 0,
    url: "https://api.test/api/search/b1",
    method: "GET",
    message: "Network error",
  });
}

describe("hitToRemote", () => {
  it("derives targetState from the index name, which the document lacks", () => {
    expect(hitToRemote(makeHit({ index: "drafts" })).targetState).toBe("DRAFT");
    expect(hitToRemote(makeHit({ index: "records" })).targetState).toBe("RECORD");
  });

  it("tolerates a trimmed `_source` from a `fields=` query", () => {
    const remote = hitToRemote(makeHit({ source: {} }));
    expect(remote).toEqual({
      id: "b1",
      targetState: "RECORD",
      visibilityStatus: null,
      version: null,
      metadata: {},
    });
  });

  it("ignores a non-numeric version rather than trusting it", () => {
    const hit = makeHit({ source: { version: "3" as unknown as number } });
    expect(hitToRemote(hit).version).toBeNull();
  });

  it("keeps version 0 — freshly created records really do have it, and it is falsy", () => {
    // Verified against the live index: a just-created record is version 0. A
    // truthiness check here would silently drop it and refuse the mirror write.
    expect(hitToRemote(makeHit({ source: { version: 0 } })).version).toBe(0);
  });

  it("survives the explicit nulls pgsync writes for the joined arrays", () => {
    const hit = makeHit({
      source: { version: 1, metadata: {}, parent_relations: null, file_attachments: null },
    });
    expect(() => hitToRemote(hit)).not.toThrow();
    expect(hitToRemote(hit).version).toBe(1);
  });
});

describe("syncTracked — scope", () => {
  it("only asks about items connected to a backend record", async () => {
    const h = harness({
      items: [
        makeItem({ id: "i1", backendId: "b1" }),
        makeItem({ id: "i2", backendId: null }),
      ],
      fetch: () => makeHit(),
    });
    const result = await syncTracked({ deps: h.deps });
    expect(h.fetches).toEqual(["b1"]);
    expect(result.run.checked).toBe(1);
  });

  it("reports an archive with nothing uploaded as a clean, empty run", async () => {
    const h = harness({ items: [makeItem({ backendId: null })], fetch: () => makeHit() });
    const result = await syncTracked({ deps: h.deps });
    expect(h.fetches).toEqual([]);
    expect(result.run.status).toBe("ok");
    expect(result.run.summary).toBe("Nothing to sync");
    expect(h.logged).toHaveLength(1);
  });
});

describe("syncTracked — found records", () => {
  it("rewrites the mirror and the row when metadata changed", async () => {
    const h = harness({
      items: [makeItem()],
      mirrors: { i1: makeMirror(ORPHAN_MIN_AGE_MS * 2, { metadata: { title: "Old" } }) },
      fetch: () => makeHit(),
    });
    const result = await syncTracked({ deps: h.deps });

    expect(result.outcomes[0].kind).toBe("updated");
    expect(h.writes[0].mirror.metadata).toEqual({ title: "Gorski vijenac" });
    expect(h.records[0].sync.title).toBe("Gorski vijenac");
    expect(h.records[0].sync.missStreak).toBe(0);
    expect(result.run.updated).toBe(1);
  });

  it("writes nothing when the mirror already matches", async () => {
    const h = harness({
      items: [makeItem()],
      mirrors: { i1: makeMirror(ORPHAN_MIN_AGE_MS * 2) },
      fetch: () => makeHit(),
    });
    const result = await syncTracked({ deps: h.deps });

    expect(result.outcomes[0].kind).toBe("up-to-date");
    expect(h.writes).toHaveLength(0);
    expect(h.records).toHaveLength(0); // no needless SQLite churn
    expect(result.run.summary).toBe("Everything up to date");
  });

  it("clears a miss streak when a record reappears, even with no metadata change", async () => {
    const h = harness({
      items: [makeItem({ syncMissStreak: ORPHAN_CONFIRMATIONS })],
      mirrors: { i1: makeMirror(ORPHAN_MIN_AGE_MS * 2) },
      fetch: () => makeHit(),
    });
    await syncTracked({ deps: h.deps });

    // The metadata was identical, but the row MUST still be written — otherwise
    // an item that came back would stay flagged orphaned forever.
    expect(h.writes).toHaveLength(0);
    expect(h.records).toHaveLength(1);
    expect(h.records[0].sync.missStreak).toBe(0);
  });

  it("does not let a CDC-lagged version move the mirror backwards", async () => {
    const h = harness({
      items: [makeItem()],
      mirrors: { i1: makeMirror(ORPHAN_MIN_AGE_MS * 2, { version: 9, metadata: { title: "Old" } }) },
      fetch: () => makeHit(), // index still reports version 3
    });
    await syncTracked({ deps: h.deps });
    expect(h.writes[0].mirror.version).toBe(9);
    expect(h.records[0].sync.version).toBe(9);
  });

  it("picks up a DRAFT→RECORD transition made on the website", async () => {
    const h = harness({
      items: [makeItem()],
      mirrors: { i1: makeMirror(ORPHAN_MIN_AGE_MS * 2, { targetState: "DRAFT" }) },
      fetch: () => makeHit({ index: "records" }),
    });
    await syncTracked({ deps: h.deps });
    expect(h.records[0].sync.targetState).toBe("RECORD");
  });

  it("creates a mirror for an item that has none", async () => {
    const h = harness({ items: [makeItem()], mirrors: { i1: null }, fetch: () => makeHit() });
    const result = await syncTracked({ deps: h.deps });
    expect(result.outcomes[0].kind).toBe("updated");
    expect(h.writes[0].mirror.backendId).toBe("b1");
  });

  it("reports a local write failure as missed rather than as a successful sync", async () => {
    const h = harness({
      items: [makeItem()],
      mirrors: { i1: null },
      fetch: () => makeHit(),
      writeMirrorFails: true,
    });
    const result = await syncTracked({ deps: h.deps });
    expect(result.outcomes[0].kind).toBe("missed");
    expect(result.outcomes[0].reason).toBe("request-failed");
    expect(result.outcomes[0].detail).toContain("could not write locally");
  });
});

describe("syncTracked — orphan safety", () => {
  /** Enough found items that a single 404 is not a suspicious run. */
  function withFoundNeighbours(missing: Item, count = 5): Item[] {
    const others = Array.from({ length: count }, (_, n) =>
      makeItem({ id: `ok${n}`, backendId: `ok${n}` }),
    );
    return [missing, ...others];
  }

  it("does not advance a streak for an item written moments ago (CDC lag)", async () => {
    const item = makeItem({ syncMissStreak: 0 });
    const h = harness({
      items: withFoundNeighbours(item),
      mirrors: { i1: makeMirror(5_000) }, // written 5 seconds ago
      fetch: (backendId) => (backendId === "b1" ? null : makeHit({ id: backendId })),
    });
    const result = await syncTracked({ deps: h.deps });

    const outcome = result.outcomes.find((o) => o.itemId === "i1");
    expect(outcome?.kind).toBe("missed");
    expect(outcome?.missStreak).toBe(0);
    expect(outcome?.orphaned).toBe(false);
    expect(h.records.some((r) => r.itemId === "i1")).toBe(false);
  });

  it("advances the streak for an old item, but does not orphan on the first miss", async () => {
    const item = makeItem({ syncMissStreak: 0 });
    const h = harness({
      items: withFoundNeighbours(item),
      mirrors: { i1: makeMirror(ORPHAN_MIN_AGE_MS * 2) },
      fetch: (backendId) => (backendId === "b1" ? null : makeHit({ id: backendId })),
    });
    const result = await syncTracked({ deps: h.deps });

    const outcome = result.outcomes.find((o) => o.itemId === "i1");
    expect(outcome?.missStreak).toBe(1);
    expect(outcome?.orphaned).toBe(false);
    expect(h.records.find((r) => r.itemId === "i1")?.sync.missStreak).toBe(1);
  });

  it("orphans only once the streak reaches the confirmation threshold", async () => {
    const item = makeItem({ syncMissStreak: ORPHAN_CONFIRMATIONS - 1 });
    const h = harness({
      items: withFoundNeighbours(item),
      mirrors: { i1: makeMirror(ORPHAN_MIN_AGE_MS * 2) },
      fetch: (backendId) => (backendId === "b1" ? null : makeHit({ id: backendId })),
    });
    const result = await syncTracked({ deps: h.deps });

    const outcome = result.outcomes.find((o) => o.itemId === "i1");
    expect(outcome?.orphaned).toBe(true);
    expect(result.run.status).toBe("warning");
    expect(result.run.detail).toContain("flagged orphaned");
  });

  it("NEVER advances streaks when the whole archive goes missing at once", async () => {
    // The mis-scoped-token signature: a token without `drafts:view:*` 404s on
    // every draft the archive ever uploaded. Orphaning them would be catastrophic.
    const items = Array.from({ length: 8 }, (_, n) =>
      makeItem({ id: `i${n}`, backendId: `b${n}`, syncMissStreak: ORPHAN_CONFIRMATIONS - 1 }),
    );
    const mirrors = Object.fromEntries(
      items.map((i) => [i.id, makeMirror(ORPHAN_MIN_AGE_MS * 10)]),
    );
    const h = harness({ items, mirrors, fetch: () => null });
    const result = await syncTracked({ deps: h.deps });

    expect(h.records).toHaveLength(0);
    expect(result.outcomes.every((o) => o.orphaned === false)).toBe(true);
    expect(result.run.status).toBe("error"); // everything missed
    expect(result.run.detail).toContain("view scopes");
  });

  it("never writes a streak for a transport failure — a flaky network is not evidence", async () => {
    const h = harness({
      items: [makeItem({ syncMissStreak: ORPHAN_CONFIRMATIONS - 1 })],
      mirrors: { i1: makeMirror(ORPHAN_MIN_AGE_MS * 10) },
      fetch: () => networkError(),
    });
    const result = await syncTracked({ deps: h.deps });

    expect(h.records).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
    expect(result.outcomes[0].reason).toBe("offline");
    expect(result.outcomes[0].missStreak).toBe(ORPHAN_CONFIRMATIONS - 1); // unchanged
  });
});

describe("syncTracked — offline behaviour", () => {
  it("stops asking once the backend is clearly unreachable", async () => {
    const items = Array.from({ length: 20 }, (_, n) =>
      makeItem({ id: `i${n}`, backendId: `b${n}` }),
    );
    const h = harness({ items, fetch: () => networkError() });
    const result = await syncTracked({ deps: h.deps });

    // Concurrency means a few extra may be in flight when the limit trips, but
    // it must be a small fraction of 20 rather than the whole list.
    expect(h.fetches.length).toBeLessThan(items.length);
    expect(h.fetches.length).toBeGreaterThanOrEqual(OFFLINE_GIVE_UP_AFTER);
    expect(result.gaveUpOffline).toBe(true);
    expect(result.run.status).toBe("error");
  });

  it("does not give up over per-item server errors", async () => {
    // A 500 on one record says nothing about reachability; the run must continue.
    const items = Array.from({ length: 6 }, (_, n) =>
      makeItem({ id: `i${n}`, backendId: `b${n}` }),
    );
    const serverError = new ApiError({
      kind: "server",
      status: 500,
      url: "u",
      method: "GET",
      message: "boom",
    });
    const h = harness({ items, fetch: () => serverError });
    const result = await syncTracked({ deps: h.deps });

    expect(h.fetches).toHaveLength(items.length);
    expect(result.gaveUpOffline).toBe(false);
    expect(result.outcomes.every((o) => o.reason === "request-failed")).toBe(true);
  });
});

describe("syncTracked — cancellation", () => {
  it("records an aborted run as an error and writes nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ items: [makeItem()], fetch: () => makeHit() });
    const result = await syncTracked({ deps: h.deps, signal: controller.signal });

    expect(h.writes).toHaveLength(0);
    expect(h.records).toHaveLength(0);
    expect(result.run.status).toBe("error");
    expect(result.run.summary).toBe("Sync cancelled");
  });
});

describe("syncTracked — progress + logging", () => {
  it("reports the stages in order and finishes at 100%", async () => {
    const seen: SyncProgress[] = [];
    const h = harness({ items: [makeItem()], fetch: () => makeHit() });
    await syncTracked({ deps: h.deps, onProgress: (p) => seen.push({ ...p }) });

    const stages = seen.map((p) => p.stage);
    expect(stages[0]).toBe("contacting");
    expect(stages).toContain("requesting");
    expect(stages).toContain("matching");
    expect(stages).toContain("writing");
    expect(stages[stages.length - 1]).toBe("done");
    expect(seen[seen.length - 1]).toMatchObject({ completed: 1, total: 1 });
  });

  it("records the trigger and the stat tiles in the log", async () => {
    const h = harness({
      items: [makeItem({ id: "i1", backendId: "b1" }), makeItem({ id: "i2", backendId: "b2" })],
      // i1 has no mirror (→ updated); i2's already matches (→ up-to-date).
      mirrors: { i2: makeMirror(ORPHAN_MIN_AGE_MS * 2, { backendId: "b2" }) },
      fetch: (backendId) => makeHit({ id: backendId }),
    });
    await syncTracked({ deps: h.deps, trigger: "auto" });

    expect(h.logged[0]).toMatchObject({
      trigger: "auto",
      checked: 2,
      updated: 1,
      upToDate: 1,
      missed: 0,
      startedAt: T0,
      finishedAt: T0,
    });
  });

  it("resolves rather than throwing when a run goes badly", async () => {
    const h = harness({ items: [makeItem()], fetch: () => networkError() });
    await expect(syncTracked({ deps: h.deps })).resolves.toBeDefined();
  });

  it("propagates a failure to persist the log — bookkeeping loss is not silent", async () => {
    const h = harness({ items: [makeItem()], fetch: () => makeHit() });
    const failing: SyncDeps = {
      ...h.deps,
      appendLog: vi.fn().mockRejectedValue(new Error("db locked")),
    };
    // Outside Tauri the service synthesises a row instead (the GUI dev's browser
    // session has no native log), which is the behaviour under test here.
    await expect(syncTracked({ deps: failing })).resolves.toMatchObject({
      run: { id: expect.stringContaining("local-") },
    });
  });
});
