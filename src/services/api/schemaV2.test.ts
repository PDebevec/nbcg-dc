import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import {
  clearRecordSchemaV2Cache,
  getRecordSchemaV2,
  peekRecordSchemaV2,
  recordSchemaV2CacheInfo,
  refreshRecordSchemaV2,
} from "./schemaV2";
import { fieldV2, schemaV2 } from "@domain/schema.fixture";
import type { RecordSchemaV2 } from "@domain/schema";

const SCHEMA = schemaV2([fieldV2({ key: "title", required: true })]);

interface Call {
  url: string;
  headers: Record<string, string>;
}

function harness(script: Array<() => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return step();
  };
  const client = new ApiClient({ baseUrl: "https://api.test", apiPrefix: "/api", fetchImpl });
  return { client, calls };
}

function ok(body: RecordSchemaV2, etag = '"v2"'): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ETag: etag, "Content-Type": "application/json" },
  });
}

function notModified(): Response {
  return new Response(null, { status: 304, headers: { ETag: '"v2"' } });
}

function networkError(): Response {
  throw new TypeError("Failed to fetch");
}

/** A minimal `Storage` double, so a test can simulate booting with a schema
 * persisted from a previous session (Tauri / the dev server) — this project's
 * plain Node test environment has no real `localStorage` (see schemaV2.ts's
 * module doc). */
function fakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  clearRecordSchemaV2Cache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getRecordSchemaV2", () => {
  it("asks the backend once per session", async () => {
    const { client, calls } = harness([() => ok(SCHEMA)]);
    expect((await getRecordSchemaV2({ client })).fields[0].key).toBe("title");
    await getRecordSchemaV2({ client });
    expect(calls.map((c) => c.url)).toEqual(["https://api.test/api/schema/v2/record"]);
  });

  it("revalidates with the kept ETag and keeps the copy on a 304", async () => {
    const { client, calls } = harness([() => ok(SCHEMA), notModified]);
    await getRecordSchemaV2({ client });
    expect(await getRecordSchemaV2({ client, forceRefresh: true })).toEqual(SCHEMA);
    expect(calls[1].headers["If-None-Match"]).toBe('"v2"');
  });

  it("serves the kept copy when the backend cannot be reached", async () => {
    const { client } = harness([() => ok(SCHEMA), networkError]);
    await getRecordSchemaV2({ client });
    expect(await getRecordSchemaV2({ client, forceRefresh: true })).toEqual(SCHEMA);
  });

  it("throws when nothing is kept and the backend cannot be reached", async () => {
    const { client } = harness([networkError]);
    await expect(getRecordSchemaV2({ client })).rejects.toThrow();
  });

  it("never replaces a kept copy with an empty field list", async () => {
    const { client } = harness([() => ok(SCHEMA), () => ok(schemaV2([]), '"empty"')]);
    await getRecordSchemaV2({ client });
    expect((await getRecordSchemaV2({ client, forceRefresh: true })).fields).toHaveLength(1);
    expect(peekRecordSchemaV2()?.fields).toHaveLength(1);
  });

  it("settles into memory once a failed first read falls back to a persisted copy", async () => {
    // Simulates booting offline with a schema persisted from a previous
    // session: `cached` is already populated (via `localStorage` hydration)
    // before this session's very first read ever reaches the backend, so a
    // failed first attempt must still mark the session checked — otherwise
    // every later non-forced read hits the network again and waits out its
    // timeout instead of settling on the copy it already has.
    vi.stubGlobal("localStorage", fakeLocalStorage());
    localStorage.setItem(
      "nbcg-dc.schema.v2",
      JSON.stringify({ schema: SCHEMA, etag: '"v2"', fetchedAt: new Date().toISOString() }),
    );

    const { client, calls } = harness([networkError, networkError]);
    expect(await getRecordSchemaV2({ client })).toEqual(SCHEMA);
    expect(await getRecordSchemaV2({ client })).toEqual(SCHEMA);

    expect(calls).toHaveLength(1);
  });
});

describe("refreshRecordSchemaV2", () => {
  it("reports the field count after a real refresh", async () => {
    const { client } = harness([() => ok(SCHEMA)]);
    expect(await refreshRecordSchemaV2({ client })).toMatchObject({
      ok: true,
      stale: false,
      cache: { fieldCount: 1, etag: '"v2"' },
    });
  });

  it("says stale, not refreshed, when it had to serve the kept copy", async () => {
    const { client } = harness([() => ok(SCHEMA), networkError]);
    await getRecordSchemaV2({ client });
    expect(await refreshRecordSchemaV2({ client })).toMatchObject({ ok: false, stale: true });
  });

  it("says stale, not refreshed, when the backend's answer was empty", async () => {
    const { client } = harness([() => ok(SCHEMA), () => ok(schemaV2([]), '"empty"')]);
    await getRecordSchemaV2({ client });
    const result = await refreshRecordSchemaV2({ client });
    expect(result).toMatchObject({ ok: false, stale: true, cache: { fieldCount: 1 } });
    expect(result.message).toMatch(/empty/i);
  });

  it("reports an error when there is nothing to fall back to", async () => {
    const { client } = harness([networkError]);
    const result = await refreshRecordSchemaV2({ client });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(recordSchemaV2CacheInfo().fieldCount).toBeNull();
  });
});
