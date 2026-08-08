import { describe, it, expect } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import type { SearchHit, SearchResult } from "./dto";
import {
  DeepPaginationError,
  findById,
  isBeyondPaginationWindow,
  itemTypeToSearchIndex,
  searchAllPages,
  searchChildren,
  searchIndexToItemType,
  searchItems,
  suggest,
} from "./search";
import { ItemType } from "@domain/enums";

interface Call {
  url: string;
}

/** `step` receives the 0-based call index so a test can vary pages. */
function harness(step: (n: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const response = step(calls.length);
    calls.push({ url });
    return response;
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
  return { index: "records", score: 1, source: {}, ...over };
}

function result(over: Partial<SearchResult> = {}): SearchResult {
  return { total: 1, page: 1, limit: 20, pages: 1, hits: [hit({ id: "a" })], ...over };
}

describe("searchIndexToItemType", () => {
  it("maps the index name to the collection", () => {
    expect(searchIndexToItemType("records")).toBe(ItemType.RECORD);
    expect(searchIndexToItemType("drafts")).toBe(ItemType.DRAFT);
  });

  it("returns null for an unrecognised index rather than guessing", () => {
    expect(searchIndexToItemType("")).toBeNull();
    expect(searchIndexToItemType("record")).toBeNull();
  });

  it("round-trips with itemTypeToSearchIndex", () => {
    for (const t of [ItemType.RECORD, ItemType.DRAFT]) {
      expect(searchIndexToItemType(itemTypeToSearchIndex(t))).toBe(t);
    }
  });
});

describe("isBeyondPaginationWindow", () => {
  it("allows pages inside the 10k window", () => {
    expect(isBeyondPaginationWindow(1, 20)).toBe(false);
    expect(isBeyondPaginationWindow(99, 100)).toBe(false); // from 9800 → 9900
  });

  it("matches the backend's `from + limit >= 10000` boundary exactly", () => {
    // page 100 @ limit 100 → from 9900, +100 = 10000 → the backend 400s here.
    expect(isBeyondPaginationWindow(100, 100)).toBe(true);
    expect(isBeyondPaginationWindow(101, 100)).toBe(true);
  });
});

describe("searchItems", () => {
  it("sends the query params it was given", async () => {
    const { client, calls } = harness(() => json(result()));
    await searchItems({ q: "dan", type: "drafts", sort: "newest" }, { client });
    expect(calls[0].url).toContain("/api/search?");
    expect(calls[0].url).toContain("q=dan");
    expect(calls[0].url).toContain("type=drafts");
    expect(calls[0].url).toContain("sort=newest");
  });

  it("omits undefined and blank params instead of sending empty values", async () => {
    const { client, calls } = harness(() => json(result()));
    await searchItems({ q: "", title: undefined, author: "  " }, { client });
    expect(calls[0].url).not.toContain("q=");
    expect(calls[0].url).not.toContain("title=");
    expect(calls[0].url).not.toContain("author=");
  });

  it("clamps limit to the backend cap of 100", async () => {
    const { client, calls } = harness(() => json(result()));
    await searchItems({ limit: 500 }, { client });
    expect(calls[0].url).toContain("limit=100");
  });

  it("clamps a non-positive limit up to 1", async () => {
    const { client, calls } = harness(() => json(result()));
    await searchItems({ limit: 0 }, { client });
    expect(calls[0].url).toContain("limit=1");
  });

  it("throws DeepPaginationError before issuing a doomed request", async () => {
    const { client, calls } = harness(() => json(result()));
    await expect(searchItems({ page: 101, limit: 100 }, { client })).rejects.toBeInstanceOf(
      DeepPaginationError,
    );
    expect(calls).toHaveLength(0);
  });

  it("applies the clamp before the pagination guard", async () => {
    // limit 500 clamps to 100; page 101 then lands past the window.
    const { client } = harness(() => json(result()));
    await expect(searchItems({ page: 101, limit: 500 }, { client })).rejects.toBeInstanceOf(
      DeepPaginationError,
    );
  });
});

describe("findById", () => {
  it("returns the hit when found", async () => {
    const { client, calls } = harness(() => json(hit({ id: "abc", index: "drafts" })));
    const found = await findById("abc", { client });
    expect(found?.index).toBe("drafts");
    expect(calls[0].url).toBe("https://api.test/api/search/abc");
  });

  it("returns null on 404 — not-indexed, not-visible, and deleted are one status", async () => {
    const { client } = harness(() => json({ statusCode: 404 }, 404));
    expect(await findById("gone", { client })).toBeNull();
  });

  it("rethrows non-404 failures so they are never mistaken for absence", async () => {
    const { client } = harness(() => json({ statusCode: 503 }, 503));
    await expect(findById("x", { client })).rejects.toThrow();
  });

  it("percent-encodes the id", async () => {
    const { client, calls } = harness(() => json(hit({ id: "a/b" })));
    await findById("a/b", { client });
    expect(calls[0].url).toBe("https://api.test/api/search/a%2Fb");
  });
});

describe("searchChildren", () => {
  it("hits the children path and forwards filters", async () => {
    const { client, calls } = harness(() => json(result()));
    await searchChildren("parent1", { limit: 50 }, { client });
    expect(calls[0].url).toContain("/api/search/parent1/children?");
    expect(calls[0].url).toContain("limit=50");
  });

  it("guards deep pagination like the top-level search", async () => {
    const { client } = harness(() => json(result()));
    await expect(
      searchChildren("p", { page: 200, limit: 100 }, { client }),
    ).rejects.toBeInstanceOf(DeepPaginationError);
  });
});

describe("suggest", () => {
  it("sends field/q/limit/type", async () => {
    const { client, calls } = harness(() => json({ field: "title", suggestions: [] }));
    await suggest({ field: "title", q: "pob", limit: 5, type: "records" }, { client });
    expect(calls[0].url).toContain("/api/search/suggest?");
    expect(calls[0].url).toContain("field=title");
    expect(calls[0].url).toContain("q=pob");
    expect(calls[0].url).toContain("limit=5");
  });
});

describe("searchAllPages", () => {
  it("walks every page and flattens the hits", async () => {
    const pages: SearchResult[] = [
      { total: 3, page: 1, limit: 2, pages: 2, hits: [hit({ id: "a" }), hit({ id: "b" })] },
      { total: 3, page: 2, limit: 2, pages: 2, hits: [hit({ id: "c" })] },
    ];
    const { client, calls } = harness((n) => json(pages[n]));
    const out = await searchAllPages({ limit: 2 }, { client });
    expect(out.hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(out.total).toBe(3);
    expect(out.truncated).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("stops at maxHits and reports truncation", async () => {
    const page = (n: number): SearchResult => ({
      total: 100,
      page: n + 1,
      limit: 2,
      pages: 50,
      hits: [hit({ id: `${n}a` }), hit({ id: `${n}b` })],
    });
    const { client } = harness((n) => json(page(n)));
    const out = await searchAllPages({ limit: 2 }, { client, maxHits: 3 });
    expect(out.hits).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it("does not report truncation when maxHits happens to equal the total", async () => {
    const pages: SearchResult[] = [
      { total: 2, page: 1, limit: 2, pages: 1, hits: [hit({ id: "a" }), hit({ id: "b" })] },
    ];
    const { client } = harness((n) => json(pages[n]));
    const out = await searchAllPages({ limit: 2 }, { client, maxHits: 2 });
    expect(out.hits).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });

  it("stops on an empty page even when `pages` claims there are more", async () => {
    // A result set shrinking mid-walk (items deleted between pages) must not loop.
    const { client, calls } = harness(() =>
      json({ total: 999, page: 1, limit: 2, pages: 500, hits: [] }),
    );
    const out = await searchAllPages({ limit: 2 }, { client });
    expect(out.hits).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });
});
