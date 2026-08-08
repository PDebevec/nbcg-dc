import { describe, it, expect } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import type { SearchHit, SearchResult } from "./dto";
import { hitToParent, searchParents, getParentById } from "./collections";

interface Call {
  url: string;
}

function harness(step: () => Response | never) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push({ url });
    return step();
  };
  const client = new ApiClient({
    baseUrl: "https://api.test",
    apiPrefix: "/api",
    fetchImpl,
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hit(over: Partial<SearchHit> & { id: string }): SearchHit {
  return {
    index: "records",
    score: 1,
    source: {},
    ...over,
  };
}

const RESULT: SearchResult = {
  total: 2,
  page: 1,
  limit: 20,
  pages: 1,
  hits: [
    hit({ id: "p1", source: { metadata: { title: "Pobjeda", collectionType: 5 } } }),
    hit({ id: "p2", source: { metadata: { collectionType: 2 } } }), // no title
  ],
};

describe("hitToParent", () => {
  it("extracts id, title, and numeric collectionType from source.metadata", () => {
    const p = hitToParent(RESULT.hits[0]);
    expect(p).toEqual({
      id: "p1",
      title: "Pobjeda",
      collectionType: 5,
      metadata: { title: "Pobjeda", collectionType: 5 },
    });
  });

  it("falls back to the id when there is no title", () => {
    expect(hitToParent(RESULT.hits[1]).title).toBe("p2");
  });

  it("uses null when collectionType is missing or not a number", () => {
    expect(hitToParent(hit({ id: "x", source: { metadata: {} } })).collectionType).toBeNull();
    // Deliberately wrong-typed wire data: `collectionType` is a NUMBER in the
    // contract, so this cast is the point of the test — the runtime `typeof`
    // guard must hold even when the backend sends a string.
    const stringTyped = { metadata: { collectionType: "5" } } as unknown as SearchHit["source"];
    expect(hitToParent(hit({ id: "y", source: stringTyped })).collectionType).toBeNull();
  });

  it("tolerates a hit with no metadata object", () => {
    const p = hitToParent(hit({ id: "z", source: {} }));
    expect(p).toEqual({ id: "z", title: "z", collectionType: null, metadata: {} });
  });
});

describe("searchParents", () => {
  it("maps hits to parent records", async () => {
    const { client } = harness(() => json(RESULT));
    const parents = await searchParents("pobjeda", { client });
    expect(parents.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(parents[0].collectionType).toBe(5);
  });

  it("passes q/type/limit/fields as query params", async () => {
    const { client, calls } = harness(() => json(RESULT));
    await searchParents("dan", { client, type: "records", limit: 5 });
    expect(calls[0].url).toContain("/api/search?");
    expect(calls[0].url).toContain("q=dan");
    expect(calls[0].url).toContain("type=records");
    expect(calls[0].url).toContain("limit=5");
    expect(calls[0].url).toContain("fields=metadata");
  });
});

describe("getParentById", () => {
  it("returns the parent for a found id", async () => {
    const { client, calls } = harness(() =>
      json(hit({ id: "p1", source: { metadata: { title: "Pobjeda", collectionType: 5 } } })),
    );
    const p = await getParentById("p1", { client });
    expect(p?.title).toBe("Pobjeda");
    expect(calls[0].url).toBe("https://api.test/api/search/p1");
  });

  it("returns null on a 404", async () => {
    const { client } = harness(() => json({ statusCode: 404 }, 404));
    expect(await getParentById("missing", { client })).toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    const { client } = harness(() => json({ statusCode: 500 }, 500));
    await expect(getParentById("x", { client })).rejects.toThrow();
  });
});
