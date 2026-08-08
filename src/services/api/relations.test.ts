import { describe, it, expect } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import type { RelationWriteResult } from "./dto";
import {
  connectRelations,
  connectParent,
  disconnectRelations,
} from "./relations";

interface Call {
  method: string;
  url: string;
  body: string | undefined;
}

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

/** The parent's post-write state — what both endpoints return since 2026-08-07. */
const STATE: RelationWriteResult = {
  parentId: "par_1",
  version: 3,
  childrenInDrafts: 2,
  childrenInRecords: 1,
};

describe("connectRelations", () => {
  it("POSTs /relations/connect and returns the parent's new state", async () => {
    const { client, calls } = harness(() => json(STATE, 201));
    const res = await connectRelations(
      { parentId: "par_1", childIds: ["c1", "c2"] },
      { client },
    );

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.test/api/relations/connect");
    expect(JSON.parse(calls[0].body!)).toEqual({
      parentId: "par_1",
      childIds: ["c1", "c2"],
    });
    // The version is the whole point: the connect trigger bumps the parent, and
    // this is what saves the caller a CDC-lagged re-read before its next PATCH.
    expect(res).toEqual(STATE);
  });

  it("connectParent wraps a single child", async () => {
    const { client, calls } = harness(() => json(STATE, 201));
    const res = await connectParent("par_1", "c1", { client });
    expect(JSON.parse(calls[0].body!)).toEqual({
      parentId: "par_1",
      childIds: ["c1"],
    });
    expect(res.version).toBe(3);
  });

  it("propagates a rejected connect (e.g. a cycle) as an ApiError", async () => {
    const { client } = harness(() =>
      json({ statusCode: 400, message: "An item cannot be its own child" }, 400),
    );
    await expect(
      connectParent("par_1", "par_1", { client }),
    ).rejects.toMatchObject({ kind: "bad_request", status: 400 });
  });
});

describe("disconnectRelations", () => {
  it("POSTs /relations/disconnect and returns the parent's new state", async () => {
    // 200, not 204 — the status changed precisely so this body could exist.
    const { client, calls } = harness(() =>
      json({ ...STATE, childrenInDrafts: 1 }, 200),
    );
    const res = await disconnectRelations(
      { parentId: "par_1", childIds: ["c1"] },
      { client },
    );
    expect(calls[0].url).toBe("https://api.test/api/relations/disconnect");
    expect(res.childrenInDrafts).toBe(1);
    expect(res.parentId).toBe("par_1");
  });
});
