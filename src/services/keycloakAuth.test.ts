import { describe, it, expect } from "vitest";
import type { FetchLike } from "./api/client";
import { KeycloakAuth, KeycloakAuthError } from "./keycloakAuth";

// ── harness ────────────────────────────────────────────────────────────────

interface Captured {
  url: string;
  body: string;
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return json({
    access_token: "access-1",
    expires_in: 300,
    refresh_token: "refresh-1",
    refresh_expires_in: 1800,
    ...overrides,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function harness(
  respond: (call: Captured) => Response | Promise<Response> = () => tokenResponse(),
  options: {
    credentials?: { username: string; password: string } | null;
    now?: () => number;
  } = {},
) {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const call: Captured = { url, body: String(init?.body ?? "") };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  let clock = options.now ?? (() => 1_000_000);
  const auth = new KeycloakAuth({
    keycloakUrl: "http://localhost:8082",
    getCredentials: async () =>
      options.credentials === undefined
        ? { username: "alice", password: "secret" }
        : options.credentials,
    fetchImpl,
    now: () => clock(),
  });
  return { auth, calls, advance: (fn: () => number) => (clock = fn) };
}

function fields(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

// ── minting ────────────────────────────────────────────────────────────────

describe("KeycloakAuth — minting", () => {
  it("mints a fresh access token via the password grant on first use", async () => {
    const { auth, calls } = harness();
    const token = await auth.getValidAccessToken();
    expect(token).toBe("access-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://localhost:8082/realms/nbcg/protocol/openid-connect/token",
    );
    const sent = fields(calls[0].body);
    expect(sent.get("grant_type")).toBe("password");
    expect(sent.get("client_id")).toBe("nbcg-web");
    expect(sent.get("username")).toBe("alice");
    expect(sent.get("password")).toBe("secret");
  });

  it("returns null without making a request when no credentials are saved", async () => {
    const { auth, calls } = harness(undefined, { credentials: null });
    const token = await auth.getValidAccessToken();
    expect(token).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("reuses the cached token within the safety margin, no second request", async () => {
    const { auth, calls } = harness();
    await auth.getValidAccessToken();
    const token = await auth.getValidAccessToken();
    expect(token).toBe("access-1");
    expect(calls).toHaveLength(1);
  });
});

// ── refresh ────────────────────────────────────────────────────────────────

describe("KeycloakAuth — refresh", () => {
  it("uses the refresh_token grant once the access token is stale but the refresh token is not", async () => {
    let now = 1_000_000;
    const { auth, calls } = harness(
      (call) => {
        const grant = fields(call.body).get("grant_type");
        return grant === "refresh_token"
          ? tokenResponse({ access_token: "access-2" })
          : tokenResponse();
      },
      { now: () => now },
    );

    await auth.getValidAccessToken(); // mints access-1, expires_in 300s
    now += 290_000; // past the 15s safety margin, refresh token still fresh
    const token = await auth.getValidAccessToken();

    expect(token).toBe("access-2");
    expect(calls).toHaveLength(2);
    expect(fields(calls[1].body).get("refresh_token")).toBe("refresh-1");
  });

  it("falls back to a password grant once the refresh token itself is stale", async () => {
    let now = 1_000_000;
    const grants: string[] = [];
    const { auth } = harness(
      (call) => {
        grants.push(fields(call.body).get("grant_type") ?? "");
        return tokenResponse();
      },
      { now: () => now },
    );

    await auth.getValidAccessToken();
    now += 1_800_000; // past refresh_expires_in too
    await auth.getValidAccessToken();

    expect(grants).toEqual(["password", "password"]);
  });

  it("re-mints via password grant when a refresh attempt is rejected", async () => {
    let now = 1_000_000;
    let refreshAttempted = false;
    const { auth } = harness(
      (call) => {
        const grant = fields(call.body).get("grant_type");
        if (grant === "refresh_token") {
          refreshAttempted = true;
          return json({ error: "invalid_grant" }, 400);
        }
        return tokenResponse();
      },
      { now: () => now },
    );

    await auth.getValidAccessToken();
    now += 290_000;
    const token = await auth.getValidAccessToken();

    expect(refreshAttempted).toBe(true);
    expect(token).toBe("access-1"); // the password-grant fallback's response
  });
});

// ── errors ─────────────────────────────────────────────────────────────────

describe("KeycloakAuth — errors", () => {
  it("throws a clear invalid_credentials error on a rejected password grant", async () => {
    const { auth } = harness(() =>
      json({ error: "invalid_grant", error_description: "Invalid user credentials" }, 401),
    );
    await expect(auth.getValidAccessToken()).rejects.toMatchObject({
      reason: "invalid_credentials",
      message: "Invalid user credentials",
    } satisfies Partial<KeycloakAuthError>);
  });

  it("throws a network error when Keycloak is unreachable", async () => {
    const { auth } = harness(() => {
      throw new Error("fetch failed");
    });
    await expect(auth.getValidAccessToken()).rejects.toMatchObject({
      reason: "network",
    } satisfies Partial<KeycloakAuthError>);
  });

  it("throws a server error on an unexpected non-2xx status", async () => {
    const { auth } = harness(() => json({}, 503));
    await expect(auth.getValidAccessToken()).rejects.toMatchObject({
      reason: "server",
    } satisfies Partial<KeycloakAuthError>);
  });
});

// ── concurrency ────────────────────────────────────────────────────────────

describe("KeycloakAuth — concurrency", () => {
  it("de-duplicates concurrent calls into one request", async () => {
    const { auth, calls } = harness();
    const [a, b, c] = await Promise.all([
      auth.getValidAccessToken(),
      auth.getValidAccessToken(),
      auth.getValidAccessToken(),
    ]);
    expect([a, b, c]).toEqual(["access-1", "access-1", "access-1"]);
    expect(calls).toHaveLength(1);
  });
});

// ── cache invalidation ─────────────────────────────────────────────────────

describe("KeycloakAuth — clearCache", () => {
  it("mints fresh instead of reusing the cache after clearCache()", async () => {
    const { auth, calls } = harness();
    await auth.getValidAccessToken();
    auth.clearCache();
    await auth.getValidAccessToken();
    expect(calls).toHaveLength(2);
  });
});

// ── mintOnce (Test connection) ────────────────────────────────────────────

describe("KeycloakAuth — mintOnce", () => {
  it("mints against arbitrary credentials without touching the shared cache", async () => {
    const { auth, calls } = harness(undefined, { credentials: null });
    await auth.mintOnce("bob", "hunter2");
    expect(calls).toHaveLength(1);
    const sent = fields(calls[0].body);
    expect(sent.get("username")).toBe("bob");
    expect(sent.get("password")).toBe("hunter2");

    // The probe must not have cached anything for the real getCredentials
    // (which resolves to null here) to pick up.
    const token = await auth.getValidAccessToken();
    expect(token).toBeNull();
    expect(calls).toHaveLength(1); // no second mint attempted
  });

  it("rejects with the same typed error as a real mint on bad credentials", async () => {
    const { auth } = harness(() =>
      json({ error: "invalid_grant", error_description: "Invalid user credentials" }, 401),
    );
    await expect(auth.mintOnce("bob", "wrong")).rejects.toBeInstanceOf(KeycloakAuthError);
  });
});
