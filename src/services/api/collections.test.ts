import { describe, it, expect } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import type { SearchHit, SearchResult } from "./dto";
import { hitToParent, searchParents, getParentById, getItemParentIds } from "./collections";

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

  it("asks for collections only, ranking a typed query by relevance", async () => {
    const { client, calls } = harness(() => json(RESULT));
    await searchParents("dan", { client });
    const params = new URL(calls[0].url).searchParams;
    expect(params.get("q")).toBe("dan");
    expect(params.get("collectionType")).toBe(">0");
    expect(params.has("sort")).toBe(false);
  });

  it("lists the newest collections when nothing is typed", async () => {
    const { client, calls } = harness(() => json(RESULT));
    await searchParents("", { client });
    const params = new URL(calls[0].url).searchParams;
    expect(params.has("q")).toBe(false);
    expect(params.get("sort")).toBe("newest");
    expect(params.get("collectionType")).toBe(">0");
  });

  it("drops hits that aren't collections, which a backend without the filter returns", async () => {
    const { client } = harness(() =>
      json({
        ...RESULT,
        total: 3,
        hits: [
          hit({ id: "plain", source: { metadata: { title: "An item", collectionType: 0 } } }),
          hit({ id: "untyped", source: { metadata: { title: "No type" } } }),
          hit({ id: "fond", source: { metadata: { title: "A fond", collectionType: 3 } } }),
        ],
      }),
    );
    expect((await searchParents("x", { client })).map((p) => p.id)).toEqual(["fond"]);
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

describe("getItemParentIds", () => {
  it("reads the item's parent ids from its indexed doc", async () => {
    const { client, calls } = harness(() =>
      json(hit({ id: "c2", index: "drafts", source: { parent_relations: [{ parentId: "p1", parentType: "RECORD" }] } })),
    );
    expect(await getItemParentIds("c2", { client })).toEqual(["p1"]);
    expect(calls[0].url).toBe("https://api.test/api/search/c2");
  });

  it("reads pgsync's null as no parents", async () => {
    const { client } = harness(() => json(hit({ id: "c2", source: { parent_relations: null } })));
    expect(await getItemParentIds("c2", { client })).toEqual([]);
  });

  it("is null when the backend says 404", async () => {
    const { client } = harness(() => json({ statusCode: 404, message: "Item with id \"c2\" not found" }, 404));
    expect(await getItemParentIds("c2", { client })).toBeNull();
  });
});
