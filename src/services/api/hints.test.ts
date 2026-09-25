import { describe, expect, it } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import { fetchHints, splitSchemaPath } from "./hints";

function client(body: unknown, seen: string[]): ApiClient {
  const fetchImpl: FetchLike = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return new ApiClient({ baseUrl: "https://api.test", apiPrefix: "/api", fetchImpl });
}

describe("splitSchemaPath", () => {
  it("splits a schema path from its own query", () => {
    expect(splitSchemaPath("/search/suggest?field=publisher&limit=5")).toEqual({
      path: "/search/suggest",
      query: { field: "publisher", limit: "5" },
    });
  });

  it("handles a path without a query", () => {
    expect(splitSchemaPath("/search/x")).toEqual({ path: "/search/x", query: {} });
  });
});

describe("fetchHints", () => {
  it("adds the typed text as the schema's query parameter", async () => {
    const seen: string[] = [];
    const hints = await fetchHints("/search/suggest?field=publisher&limit=5", "q", "Ob", {
      client: client({ field: "publisher", suggestions: [{ value: "Obod", count: 12 }] }, seen),
    });
    expect(seen).toEqual(["https://api.test/api/search/suggest?field=publisher&limit=5&q=Ob"]);
    expect(hints).toEqual([{ value: "Obod", count: 12 }]);
  });

  it("returns no hints when the body has none", async () => {
    expect(
      await fetchHints("/search/vocabularies/language?limit=5", "q", "crn", { client: client({}, []) }),
    ).toEqual([]);
  });
});
