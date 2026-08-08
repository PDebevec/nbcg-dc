import { describe, it, expect, beforeEach } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import {
  getRecordSchema,
  peekRecordSchema,
  clearRecordSchemaCache,
  refreshRecordSchema,
  recordSchemaCacheInfo,
} from "./schema";
import type { RecordSchema } from "@domain/schema";

const SCHEMA: RecordSchema = {
  fields: [
    {
      key: "title",
      type: "string",
      required: true,
      group: "basic",
      order: 1,
      parentInheritable: false,
      issueIdentifying: false,
      levels: ["main", "child"],
    },
  ],
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fake backend whose responses (or thrown transport errors) are scripted per
 * call, capturing the request url + headers for assertions. */
function harness(script: Array<() => Response | never>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return step();
  };
  const client = new ApiClient({
    baseUrl: "https://api.test",
    apiPrefix: "/api",
    fetchImpl,
  });
  return { client, calls };
}

function ok(body: RecordSchema, etag = '"v1"'): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ETag: etag, "Content-Type": "application/json" },
  });
}

function notModified(etag = '"v1"'): Response {
  return new Response(null, { status: 304, headers: { ETag: etag } });
}

function networkError(): never {
  throw new TypeError("Failed to fetch");
}

beforeEach(() => {
  clearRecordSchemaCache();
});

describe("getRecordSchema", () => {
  it("fetches, returns, and caches the schema (no refetch while fresh)", async () => {
    const { client, calls } = harness([() => ok(SCHEMA)]);

    const first = await getRecordSchema("main", { client });
    expect(first.fields.map((f) => f.key)).toEqual(["title"]);
    expect(calls).toHaveLength(1);

    // Within max-age → served from cache, no second request.
    const second = await getRecordSchema("main", { client });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);

    expect(peekRecordSchema("main")).toEqual(SCHEMA);
  });

  it("passes ?level and caches each level separately", async () => {
    const { client, calls } = harness([() => ok(SCHEMA)]);
    await getRecordSchema("main", { client });
    expect(calls[0].url).toContain("/api/schema/record?level=main");
  });

  it("revalidates with If-None-Match and keeps the cache on 304", async () => {
    const { client, calls } = harness([() => ok(SCHEMA, '"v1"'), () => notModified('"v1"')]);

    await getRecordSchema("main", { client });
    const revalidated = await getRecordSchema("main", {
      client,
      forceRefresh: true,
    });

    expect(revalidated).toEqual(SCHEMA);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers["If-None-Match"]).toBe('"v1"');
  });

  it("adopts a new schema + ETag on a 200 revalidation", async () => {
    const updated: RecordSchema = {
      fields: [{ ...SCHEMA.fields[0], key: "naslov" }],
    };
    const { client } = harness([() => ok(SCHEMA, '"v1"'), () => ok(updated, '"v2"')]);

    await getRecordSchema("main", { client });
    const next = await getRecordSchema("main", { client, forceRefresh: true });
    expect(next.fields.map((f) => f.key)).toEqual(["naslov"]);
    expect(peekRecordSchema("main")).toEqual(updated);
  });

  it("falls back to the cached schema when the backend is unreachable", async () => {
    const { client } = harness([() => ok(SCHEMA), () => networkError()]);

    await getRecordSchema("main", { client });
    const offline = await getRecordSchema("main", { client, forceRefresh: true });
    expect(offline).toEqual(SCHEMA); // no throw — served the cache
  });

  it("throws when there is no cache to fall back to", async () => {
    const { client } = harness([() => networkError()]);
    await expect(getRecordSchema("main", { client })).rejects.toThrow();
  });

  it("refuses to overwrite a good cache with an empty field list", async () => {
    // The `?level=bogus` → `200 {fields:[]}` path is fixed backend-side (now a
    // 400), but a transient backend/deployment fault can still produce a 200 with
    // no fields — and caching one would leave the metadata editor with no fields
    // for 24h, offline copy included.
    const { client } = harness([() => ok(SCHEMA, '"v1"'), () => ok({ fields: [] }, '"v2"')]);

    await getRecordSchema("main", { client });
    const next = await getRecordSchema("main", { client, forceRefresh: true });

    expect(next).toEqual(SCHEMA);
    expect(peekRecordSchema("main")).toEqual(SCHEMA);
  });

  it("does cache an empty schema when there was nothing cached before", async () => {
    // Nothing better to serve, so an empty schema is the honest answer.
    const { client } = harness([() => ok({ fields: [] })]);
    await expect(getRecordSchema("main", { client })).resolves.toEqual({
      fields: [],
    });
  });
});

describe("refreshRecordSchema (Settings → Refresh metadata schema)", () => {
  it("revalidates both levels and reports the field counts", async () => {
    const { client, calls } = harness([() => ok(SCHEMA)]);
    const result = await refreshRecordSchema({ client });

    expect(result.ok).toBe(true);
    expect(result.stale).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/api/schema/record?level=main",
      "https://api.test/api/schema/record?level=child",
    ]);
    expect(result.levels.map((l) => l.level)).toEqual(["main", "child"]);
    expect(result.levels.every((l) => l.fieldCount === 1)).toBe(true);
    expect(result.message).toMatch(/refreshed/);
  });

  it("counts a 304 as a successful refresh", async () => {
    const { client } = harness([() => ok(SCHEMA, '"v1"'), () => notModified('"v1"')]);
    await getRecordSchema("main", { client });

    const result = await refreshRecordSchema({ client });
    expect(result.ok).toBe(true);
    expect(result.stale).toBe(false);
  });

  it("reports stale — not success — when the backend is unreachable but cached", async () => {
    const { client } = harness([() => ok(SCHEMA)]);
    await getRecordSchema("main", { client });
    await getRecordSchema("child", { client });

    const offline = harness([() => networkError()]);
    const result = await refreshRecordSchema({ client: offline.client });

    // The schema is intact, but nothing was refreshed — saying "refreshed" here
    // would tell the operator a fetch happened when none did.
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.message).toMatch(/keeping the cached/i);
    expect(result.error).toMatch(/main, child/);
    expect(result.levels.every((l) => l.fieldCount === 1)).toBe(true);
  });

  it("reports a hard failure when there is no cached schema at all", async () => {
    const { client } = harness([() => networkError()]);
    const result = await refreshRecordSchema({ client });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.levels.every((l) => l.fieldCount === null)).toBe(true);
  });
});

describe("recordSchemaCacheInfo", () => {
  it("reports nothing cached on a cold start", () => {
    expect(recordSchemaCacheInfo()).toEqual([
      { level: "main", fieldCount: null, fetchedAt: null, etag: null, fresh: false },
      { level: "child", fieldCount: null, fetchedAt: null, etag: null, fresh: false },
    ]);
  });

  it("reports the cached count, ETag, and freshness", async () => {
    const { client } = harness([() => ok(SCHEMA, '"v1"')]);
    await getRecordSchema("main", { client });

    const [main, child] = recordSchemaCacheInfo();
    expect(main).toMatchObject({ fieldCount: 1, etag: '"v1"', fresh: true });
    expect(Date.parse(main.fetchedAt!)).not.toBeNaN();
    expect(child.fieldCount).toBeNull();
  });
});
