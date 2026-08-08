import { describe, it, expect, vi } from "vitest";
import { ApiClient, ApiError, type FetchLike } from "./client";

// ── harness ────────────────────────────────────────────────────────────────
// Every request is captured whole — including headers, which the resource
// services' own harnesses drop. The Bearer token is the one thing every backend
// call in the app depends on, so it is asserted here rather than nowhere.

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
  signal: AbortSignal | undefined;
}

function harness(
  respond: (call: Captured) => Response | Promise<Response> | never = () => json({}),
  options: Partial<ConstructorParameters<typeof ApiClient>[0]> = {},
) {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const call: Captured = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  const client = new ApiClient({
    baseUrl: "https://api.test",
    apiPrefix: "/api",
    fetchImpl,
    ...options,
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── auth ───────────────────────────────────────────────────────────────────

describe("ApiClient — authorization", () => {
  it("sends the static Keycloak token as a Bearer header", async () => {
    const { client, calls } = harness(undefined, { getToken: () => "tok-123" });
    await client.get("/items/stats");
    expect(calls[0].headers.Authorization).toBe("Bearer tok-123");
  });

  it("sends no Authorization header when there is no token", async () => {
    const { client, calls } = harness(undefined, { getToken: () => null });
    await client.get("/health");
    expect(calls[0].headers).not.toHaveProperty("Authorization");
  });

  it("omits the header for an empty-string token rather than sending 'Bearer '", async () => {
    const { client, calls } = harness(undefined, { getToken: () => "" });
    await client.get("/health");
    expect(calls[0].headers).not.toHaveProperty("Authorization");
  });

  // The token is read per request, not captured at construction, so pasting a new
  // one in Settings takes effect without rebuilding the client (which is what
  // `useSettings.applyClient` relies on staying true).
  it("reads the token per request, so a token change applies immediately", async () => {
    let token = "first";
    const { client, calls } = harness(undefined, { getToken: () => token });
    await client.get("/health");
    token = "second";
    await client.get("/health");
    expect(calls.map((c) => c.headers.Authorization)).toEqual([
      "Bearer first",
      "Bearer second",
    ]);
  });

  it("defaults to sending no token at all when getToken is not supplied", async () => {
    const { client, calls } = harness();
    await client.get("/health");
    expect(calls[0].headers).not.toHaveProperty("Authorization");
  });
});

// ── URL building ───────────────────────────────────────────────────────────

describe("ApiClient — URL building", () => {
  it("joins baseUrl + apiPrefix + path", async () => {
    const { client, calls } = harness();
    await client.get("/items/stats");
    expect(calls[0].url).toBe("https://api.test/api/items/stats");
  });

  it("tolerates a trailing slash on the base URL and a missing leading slash", async () => {
    const { client, calls } = harness(undefined, { baseUrl: "https://api.test/" });
    await client.get("health");
    expect(calls[0].url).toBe("https://api.test/api/health");
  });

  it("supports an empty apiPrefix (a proxy that already strips it)", async () => {
    const { client, calls } = harness(undefined, { apiPrefix: "" });
    await client.get("/health");
    expect(calls[0].url).toBe("https://api.test/health");
  });

  it("appends query params and drops null/undefined ones", async () => {
    const { client, calls } = harness();
    await client.get("/search", {
      query: { q: "njegoš", page: 2, fullText: true, author: undefined, isbn: null },
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/search");
    expect(url.searchParams.get("q")).toBe("njegoš");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("fullText")).toBe("true");
    expect(url.searchParams.has("author")).toBe(false);
    expect(url.searchParams.has("isbn")).toBe(false);
  });
});

// ── bodies ─────────────────────────────────────────────────────────────────

describe("ApiClient — request bodies", () => {
  it("serialises a JSON body and sets Content-Type", async () => {
    const { client, calls } = harness();
    await client.post("/items", { json: { title: "Gorski vijenac" } });
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].body).toBe('{"title":"Gorski vijenac"}');
  });

  // The multipart boundary is generated by the runtime; setting Content-Type by
  // hand omits it and the backend cannot parse the body.
  it("passes FormData through without setting Content-Type", async () => {
    const { client, calls } = harness();
    const form = new FormData();
    form.append("files", new Blob(["x"]), "gorski.pdf");
    await client.post("/files/upload/rec_1", { form });

    expect(calls[0].body).toBe(form);
    expect(calls[0].headers).not.toHaveProperty("Content-Type");
  });

  it("sends a body on DELETE (the backend takes one)", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 200 }));
    await client.delete("/items", { json: { ids: ["a"] }, responseType: "void" });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].body).toBe('{"ids":["a"]}');
  });
});

// ── error mapping ──────────────────────────────────────────────────────────

describe("ApiClient — error mapping", () => {
  const cases: Array<[number, string]> = [
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [500, "server"],
    [503, "server"],
    [418, "unknown"],
  ];

  for (const [status, kind] of cases) {
    it(`maps HTTP ${status} to kind "${kind}"`, async () => {
      const { client } = harness(() => json({ message: "nope" }, status));
      await expect(client.get("/items/stats")).rejects.toMatchObject({
        name: "ApiError",
        kind,
        status,
      });
    });
  }

  it("uses the Nest message as the error message", async () => {
    const { client } = harness(() =>
      json({ statusCode: 409, message: "Version conflict: expected 0, current 1." }, 409),
    );
    await expect(client.patch("/items/x", { json: {} })).rejects.toThrow(
      "Version conflict: expected 0, current 1.",
    );
  });

  it("joins a Nest validation message array", async () => {
    const { client } = harness(() =>
      json({ message: ["title should not be empty", "year must be a string"] }, 400),
    );
    await expect(client.post("/items", { json: {} })).rejects.toThrow(
      "title should not be empty; year must be a string",
    );
  });

  // A proxy or an SPA fallback answers with HTML, not the Nest envelope. Parsing
  // must not throw a SyntaxError over the top of the real HTTP failure.
  it("survives a non-JSON error body and keeps it on the error", async () => {
    const { client } = harness(
      () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );
    const err = await client.get("/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("server");
    expect((err as ApiError).body).toBe("<html>502 Bad Gateway</html>");
    expect((err as ApiError).message).toContain("502");
  });

  it("reports a transport failure as a network error, not an HTTP one", async () => {
    const { client } = harness(() => {
      throw new TypeError("Failed to fetch");
    });
    const err = await client.get("/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("network");
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).isNetworkError).toBe(true);
  });

  it("carries the method and URL on the error, for the log line", async () => {
    const { client } = harness(() => json({}, 404));
    const err = await client.post("/items", { json: {} }).catch((e: unknown) => e);
    expect(err).toMatchObject({ method: "POST", url: "https://api.test/api/items" });
  });
});

// ── timeout vs. cancellation ───────────────────────────────────────────────
// These must stay distinguishable: a timeout is "the backend is slow", a
// caller-driven abort is "the operator cancelled". Reporting the second as the
// first sends someone hunting a network fault that does not exist.

describe("ApiClient — timeout and cancellation", () => {
  it("times out at the client default and says so", async () => {
    vi.useFakeTimers();
    try {
      const { client } = harness(
        (call) =>
          new Promise<Response>((_, reject) => {
            call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }) as unknown as Response,
        { timeoutMs: 5_000 },
      );

      const task = client.get("/health").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const err = (await task) as ApiError;

      expect(err.kind).toBe("timeout");
      expect(err.isNetworkError).toBe(true);
      expect(err.message).toContain("5000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  // Needed because a few endpoints wait on a third party: the COBISS preview
  // blocks on a 30 s upstream fetch, so the archive must outlast the backend's own
  // budget or it reports a slow-but-working COBISS as "backend unreachable".
  it("honours a per-request timeout override", async () => {
    vi.useFakeTimers();
    try {
      const { client } = harness(
        (call) =>
          new Promise<Response>((_, reject) => {
            call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }) as unknown as Response,
        { timeoutMs: 5_000 },
      );

      const task = client
        .get("/import/cobiss/preview/1", { timeoutMs: 45_000 })
        .catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(5_000);
      // The client default has passed; the override has not.
      await vi.advanceTimersByTimeAsync(39_999);
      await vi.advanceTimersByTimeAsync(1);

      const err = (await task) as ApiError;
      expect(err.kind).toBe("timeout");
      expect(err.message).toContain("45000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a caller-driven abort as cancelled, not as a timeout", async () => {
    const controller = new AbortController();
    const { client } = harness(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }) as unknown as Response,
    );

    const task = client.get("/search", { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    const err = (await task) as ApiError;

    expect(err.kind).toBe("network");
    expect(err.message).toContain("cancelled");
  });

  it("fails immediately when handed an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = harness(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          if (call.signal?.aborted) reject(new Error("aborted"));
        }) as unknown as Response,
    );

    const err = (await client
      .get("/search", { signal: controller.signal })
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain("cancelled");
  });
});

// ── decoding ───────────────────────────────────────────────────────────────

describe("ApiClient — response decoding", () => {
  it("decodes JSON by default", async () => {
    const { client } = harness(() => json({ status: "ok" }));
    await expect(client.get("/health")).resolves.toEqual({ status: "ok" });
  });

  // `transition` and `delete` answer with no body; JSON.parse("") would throw.
  it("decodes an empty 2xx body to undefined instead of throwing", async () => {
    const { client } = harness(() => new Response(null, { status: 200 }));
    await expect(client.post("/items/transition", { json: {} })).resolves.toBeUndefined();
  });

  it("returns raw text when asked, so the caller can parse it itself", async () => {
    const { client } = harness(() => new Response("<html>hi</html>", { status: 200 }));
    await expect(client.get("/health", { responseType: "text" })).resolves.toBe(
      "<html>hi</html>",
    );
  });
});

// ── requestDetailed (conditional caching) ──────────────────────────────────

describe("ApiClient — requestDetailed", () => {
  it("exposes the status and ETag for a conditional GET", async () => {
    const { client } = harness(
      () => new Response(JSON.stringify({ fields: [] }), { status: 200, headers: { ETag: '"abc"' } }),
    );
    const res = await client.getDetailed<{ fields: unknown[] }>("/schema/record");
    expect(res.status).toBe(200);
    expect(res.etag).toBe('"abc"');
    expect(res.data).toEqual({ fields: [] });
  });

  // A 304 is a cache hit, not a failure — the schema service serves its cached
  // copy off the back of it.
  it("treats a listed non-2xx status as success and decodes no body", async () => {
    const { client } = harness(() => new Response(null, { status: 304, headers: { ETag: '"abc"' } }));
    const res = await client.getDetailed("/schema/record", { acceptStatuses: [304] });
    expect(res.status).toBe(304);
    expect(res.data).toBeUndefined();
    expect(res.etag).toBe('"abc"');
  });

  it("still throws for a non-2xx status that was not listed", async () => {
    const { client } = harness(() => json({ message: "bad level" }, 400));
    await expect(
      client.getDetailed("/schema/record", { acceptStatuses: [304] }),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("forwards request headers such as If-None-Match", async () => {
    const { client, calls } = harness(() => new Response(null, { status: 304 }));
    await client.getDetailed("/schema/record", {
      headers: { "If-None-Match": '"abc"' },
      acceptStatuses: [304],
    });
    expect(calls[0].headers["If-None-Match"]).toBe('"abc"');
  });
});
