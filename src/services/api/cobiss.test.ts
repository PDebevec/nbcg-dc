import { describe, it, expect, vi } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import type { CobissPreview } from "./dto";
import {
  previewCobiss,
  fetchCobissPreview,
  cobissCollision,
  cobissCollisionMessage,
  COBISS_PREVIEW_TIMEOUT_MS,
} from "./cobiss";

const PREVIEW: CobissPreview = {
  cobissId: "12345",
  itemId: "det-id-12345",
  alreadyExists: false,
  existsAs: null,
  metadata: { cobissId: "12345", title: "Gorski vijenac" },
};

interface Call {
  url: string;
}

/** Fake backend: a scripted response (or thrown transport error) per call. */
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

function status(code: number): Response {
  return new Response(JSON.stringify({ statusCode: code, message: "nope" }), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });
}

function networkError(): never {
  throw new TypeError("Failed to fetch");
}

describe("previewCobiss", () => {
  it("hits the exact preview path with an encoded id", async () => {
    const { client, calls } = harness(() => json(PREVIEW));
    const preview = await previewCobiss("ID/42", { client });
    expect(preview.itemId).toBe("det-id-12345");
    expect(calls[0].url).toBe("https://api.test/api/import/cobiss/preview/ID%2F42");
  });

  it("trims the id before sending", async () => {
    const { client, calls } = harness(() => json(PREVIEW));
    await previewCobiss("  12345  ", { client });
    expect(calls[0].url).toBe("https://api.test/api/import/cobiss/preview/12345");
  });

  it("throws ApiError on a 404", async () => {
    const { client } = harness(() => status(404));
    await expect(previewCobiss("nope", { client })).rejects.toThrow();
  });
});

describe("fetchCobissPreview", () => {
  it("returns { found } on 200", async () => {
    const { client } = harness(() => json(PREVIEW));
    const out = await fetchCobissPreview("12345", { client });
    expect(out).toEqual({ status: "found", preview: PREVIEW });
  });

  it("maps 404 to not-found (conflates absent + upstream-down)", async () => {
    const { client } = harness(() => status(404));
    const out = await fetchCobissPreview("nope", { client });
    expect(out.status).toBe("not-found");
  });

  it("maps 403/401 to forbidden", async () => {
    const forbidden = harness(() => status(403));
    expect((await fetchCobissPreview("x", { client: forbidden.client })).status).toBe("forbidden");
    const unauth = harness(() => status(401));
    expect((await fetchCobissPreview("x", { client: unauth.client })).status).toBe("forbidden");
  });

  it("maps a transport failure to offline", async () => {
    const { client } = harness(() => networkError());
    const out = await fetchCobissPreview("12345", { client });
    expect(out.status).toBe("offline");
  });

  it("maps a 500 to error", async () => {
    const { client } = harness(() => status(500));
    const out = await fetchCobissPreview("12345", { client });
    expect(out.status).toBe("error");
  });

  it("rejects an empty id without calling the backend", async () => {
    const { client, calls } = harness(() => json(PREVIEW));
    const out = await fetchCobissPreview("   ", { client });
    expect(out.status).toBe("error");
    expect(calls).toHaveLength(0);
  });
});

describe("collision helpers", () => {
  it("extracts the deterministic id + existence", () => {
    expect(cobissCollision(PREVIEW)).toEqual({
      itemId: "det-id-12345",
      alreadyExists: false,
      existsAs: null,
    });
  });

  it("has no collision message when the record does not exist", () => {
    expect(cobissCollisionMessage(PREVIEW)).toBeNull();
  });

  it("describes an existing record vs draft", () => {
    expect(
      cobissCollisionMessage({ ...PREVIEW, alreadyExists: true, existsAs: "RECORD" }),
    ).toBe("Already imported as a record.");
    expect(
      cobissCollisionMessage({ ...PREVIEW, alreadyExists: true, existsAs: "DRAFT" }),
    ).toBe("Already imported as a draft.");
  });
});

// The backend fetches ws.cobiss.net with its own AbortSignal.timeout(30_000), so
// a preview can legitimately block for 30 s. The archive's default timeout is
// also 30 s and starts earlier, so it used to abort first on every slow COBISS
// and report a bogus "Backend unreachable". The override is the fix; these pin it.
describe("COBISS preview timeout budget", () => {
  it("outlasts the backend's own 30 s upstream fetch", () => {
    expect(COBISS_PREVIEW_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("does not abort before the backend's budget elapses", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const client = new ApiClient({
        baseUrl: "https://api.test",
        apiPrefix: "/api",
        // Reproduce the real default: without the per-request override this is
        // exactly what aborted the request too early.
        timeoutMs: 30_000,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      });

      const pending = previewCobiss("12345", { client }).catch(() => "failed");

      // Past the backend's own 30 s budget — a working-but-slow COBISS is still
      // in flight here, so the archive must NOT have given up.
      await vi.advanceTimersByTimeAsync(31_000);
      expect(aborted).toBe(false);

      // It still has a bound, though — it is not allowed to hang forever.
      await vi.advanceTimersByTimeAsync(COBISS_PREVIEW_TIMEOUT_MS);
      expect(aborted).toBe(true);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
