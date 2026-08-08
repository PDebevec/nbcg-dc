import { describe, it, expect } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import type { ItemEntity } from "./dto";
import {
  createItem,
  updateItem,
  transitionItems,
  deleteItems,
  getItemStats,
} from "./items";

interface Call {
  method: string;
  url: string;
  body: string | undefined;
}

/** Fake backend recording each request; `step` scripts the response. */
function harness(step: () => Response) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return step();
  };
  const client = new ApiClient({ baseUrl: "https://api.test", apiPrefix: "/api", fetchImpl });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ENTITY: ItemEntity = {
  id: "rec_1",
  visibilityStatus: "PUBLIC",
  metadata: { title: "Gorski vijenac" },
  version: 0,
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
  createdByUserId: "u1",
  updatedByUserId: null,
};

describe("createItem", () => {
  it("POSTs /items with the create dto and returns the entity", async () => {
    const { client, calls } = harness(() => json(ENTITY));
    const entity = await createItem(
      { visibilityStatus: "PUBLIC", targetState: "RECORD", metadata: { title: "Gorski vijenac" } },
      { client },
    );
    expect(entity.id).toBe("rec_1");
    expect(entity.version).toBe(0);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.test/api/items");
    expect(JSON.parse(calls[0].body!)).toEqual({
      visibilityStatus: "PUBLIC",
      targetState: "RECORD",
      metadata: { title: "Gorski vijenac" },
    });
  });
});

describe("updateItem", () => {
  it("PATCHes /items/:id (encoded) with expectedVersion and returns the version", async () => {
    const { client, calls } = harness(() => json({ version: 4 }));
    const res = await updateItem(
      "rec/1",
      { expectedVersion: 3, metadata: { title: "New" } },
      { client },
    );
    expect(res).toEqual({ version: 4 });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("https://api.test/api/items/rec%2F1");
    expect(JSON.parse(calls[0].body!)).toEqual({ expectedVersion: 3, metadata: { title: "New" } });
  });

  it("returns the unchanged version when the backend wrote nothing", async () => {
    // Since the 2026-08-07 backend fix the no-op arm carries `{version}` too, so
    // the response shape is uniform and callers can always adopt it. It used to be
    // an empty body — indistinguishable from a skipped version check.
    const { client } = harness(() => json({ version: 3 }));
    const res = await updateItem("rec_1", { expectedVersion: 3 }, { client });
    expect(res).toEqual({ version: 3 });
  });

  it("surfaces a version conflict as a 409", async () => {
    const { client } = harness(() =>
      json({ statusCode: 409, message: "Version conflict: expected 0, current 1." }, 409),
    );
    await expect(
      updateItem("rec_1", { expectedVersion: 0, metadata: { title: "x" } }, { client }),
    ).rejects.toMatchObject({ kind: "conflict", status: 409 });
  });
});

describe("transitionItems", () => {
  it("POSTs /items/transition and returns each moved item's new version", async () => {
    const { client, calls } = harness(() =>
      json([{ id: "a", version: 4 }, { id: "b", version: 2 }], 201),
    );
    const res = await transitionItems(
      { ids: ["a", "b"], targetState: "RECORD" },
      { client },
    );
    expect(calls[0].url).toBe("https://api.test/api/items/transition");
    expect(JSON.parse(calls[0].body!)).toEqual({ ids: ["a", "b"], targetState: "RECORD" });
    // Read back post-trigger, so an item that is itself a parent reports the
    // version it actually ended on rather than expectedVersion + 1.
    expect(res).toEqual([{ id: "a", version: 4 }, { id: "b", version: 2 }]);
  });
});

describe("deleteItems", () => {
  it("DELETEs /items with a body", async () => {
    const { client, calls } = harness(() => new Response("", { status: 200 }));
    await deleteItems({ ids: ["a"] }, { client });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.test/api/items");
    expect(JSON.parse(calls[0].body!)).toEqual({ ids: ["a"] });
  });
});

describe("getItemStats", () => {
  it("GETs /items/stats", async () => {
    const stats = { records: { PUBLIC: 1, PRIVATE: 0, HIDDEN: 0 }, drafts: { PUBLIC: 0, PRIVATE: 2, HIDDEN: 0 } };
    const { client, calls } = harness(() => json(stats));
    expect(await getItemStats({ client })).toEqual(stats);
    expect(calls[0].url).toBe("https://api.test/api/items/stats");
  });
});
