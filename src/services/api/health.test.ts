import { describe, it, expect } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import { checkReachable, checkConnection } from "./health";

/** A client whose single response (or thrown transport error) is scripted. */
function harness(respond: () => Response | never) {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return respond();
  };
  const client = new ApiClient({
    baseUrl: "https://api.test",
    apiPrefix: "/api",
    fetchImpl,
  });
  return { client, urls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The real payload, verified against the running backend on 2026-08-07. */
const HEALTH = { status: "ok", timestamp: "2026-08-07T09:42:18.178Z" };

describe("checkConnection", () => {
  it("reports ok for the real /api/health payload", async () => {
    const { client, urls } = harness(() => json(HEALTH));
    const result = await checkConnection(client);
    expect(result).toMatchObject({
      reachable: true,
      reason: "ok",
      status: 200,
    });
    expect(result.message).toMatch(/Connected/);
    expect(urls).toEqual(["https://api.test/api/health"]);
    expect(Date.parse(result.checkedAt)).not.toBeNaN();
  });

  it("reports not-nbcg-api for a 404 — the wrong-prefix case", async () => {
    // Verified: the same host serves /api/health as 200 and /health as 404, so a
    // wrong apiPrefix reaches a live host and must NOT read as Connected.
    const { client } = harness(() => json({ message: "Cannot GET /health" }, 404));
    const result = await checkConnection(client);
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe("not-nbcg-api");
    expect(result.status).toBe(404);
    expect(result.message).toMatch(/base URL and API prefix/);
  });

  it("names the tested base URL in the message when given one", async () => {
    const { client } = harness(() => json({}, 404));
    const result = await checkConnection(client, {
      baseUrl: "http://localhost:3000",
    });
    expect(result.message).toContain("http://localhost:3000");
  });

  it("reports not-nbcg-api for a 200 that is not the health payload", async () => {
    // A proxy landing page / SPA index.html fallback.
    const { client } = harness(
      () => new Response("<!doctype html><title>nginx</title>", { status: 200 }),
    );
    const result = await checkConnection(client);
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe("not-nbcg-api");
  });

  it("reports server-error for a 5xx", async () => {
    const { client } = harness(() => json({ message: "boom" }, 503));
    const result = await checkConnection(client);
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe("server-error");
    expect(result.status).toBe(503);
    expect(result.message).toMatch(/unhealthy/);
  });

  it("reports unreachable for a transport failure", async () => {
    const { client } = harness(() => {
      throw new TypeError("fetch failed");
    });
    const result = await checkConnection(client);
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe("unreachable");
    expect(result.status).toBe(0);
    expect(result.message).toMatch(/unreachable/);
  });

  it("never throws — an unexpected non-ApiError still resolves", async () => {
    const { client } = harness(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "not an error object";
    });
    await expect(checkConnection(client)).resolves.toMatchObject({
      reachable: false,
      reason: "unreachable",
    });
  });
});

describe("checkReachable", () => {
  it("is true only for the nbcg API", async () => {
    const okClient = harness(() => json(HEALTH)).client;
    await expect(checkReachable(okClient)).resolves.toBe(true);

    const wrongPath = harness(() => json({}, 404)).client;
    await expect(checkReachable(wrongPath)).resolves.toBe(false);

    const offline = harness(() => {
      throw new TypeError("fetch failed");
    }).client;
    await expect(checkReachable(offline)).resolves.toBe(false);
  });
});
