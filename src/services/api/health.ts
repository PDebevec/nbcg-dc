/**
 * Backend reachability — powers the rail footer and Settings → Test connection.
 *
 * Reachability is probed with the unauthenticated `GET /api/health`. There is
 * intentionally NO token/identity verification: the app is single-user with a
 * static token, so a bad token surfaces as a 401/403 on the first real write
 * ("verify on use"), and the backend has no identity endpoint anyway. See
 * docs/03 decisions and docs/PROJECT-KNOWLEDGE.md §3.
 *
 * What the probe *does* distinguish is **reached the host** from **reached the
 * nbcg API**. Verified against the running backend (2026-08-07): `/api/health`
 * returns `200 {"status":"ok","timestamp":…}`, while `/health` — i.e. the same
 * host with a wrong/empty `apiPrefix` — returns `404`. Treating any HTTP answer
 * as "reachable" therefore reported a misconfigured URL as Connected, which is
 * the one thing Test connection exists to catch.
 */

import type { ApiClient } from "./client";
import { ApiError } from "./client";
import type { HealthResponse } from "./dto";
import type { ReachabilityReason, ReachabilityResult } from "@domain/connection";

/**
 * A 200 body only counts if it parses as JSON carrying the health payload's
 * `status` string — a proxy landing page or an SPA `index.html` fallback would
 * otherwise pass. Note the body is fetched as **text** and parsed here on
 * purpose: decoding it as JSON would raise a `SyntaxError` on an HTML body, and
 * that is not an {@link ApiError}, so it would fall through to "unreachable" and
 * report a misconfigured URL as a network fault.
 */
function isHealthPayload(text: string | undefined): boolean {
  if (!text) return false;
  try {
    const body = JSON.parse(text) as HealthResponse;
    return (
      typeof body === "object" &&
      body !== null &&
      typeof body.status === "string"
    );
  } catch {
    return false;
  }
}

/** What the probe concluded, before it is dressed up as a {@link ReachabilityResult}. */
interface Probe {
  reason: ReachabilityReason;
  status: number;
}

/** Hit `GET /api/health` and classify the outcome. Never throws. */
async function probeHealth(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<Probe> {
  try {
    const res = await client.getDetailed<string>("/health", {
      signal,
      responseType: "text",
    });
    return {
      reason: isHealthPayload(res.data) ? "ok" : "not-nbcg-api",
      status: res.status,
    };
  } catch (err) {
    if (!(err instanceof ApiError)) return { reason: "unreachable", status: 0 };
    // Transport failure — nothing answered.
    if (err.isNetworkError) return { reason: "unreachable", status: 0 };
    // Something answered, but not the API we expect. `/health` is
    // unauthenticated, so any 4xx here means we are asking the wrong path/host;
    // a 5xx means the backend itself is unhealthy.
    return {
      reason: err.status >= 500 ? "server-error" : "not-nbcg-api",
      status: err.status,
    };
  }
}

function messageFor(probe: Probe, baseUrl?: string): string {
  switch (probe.reason) {
    case "ok":
      return "Connected — backend reachable.";
    case "not-nbcg-api":
      return baseUrl
        ? `Reached ${baseUrl}, but the nbcg API is not there (HTTP ${probe.status}) — check the base URL and API prefix.`
        : `Reached the host, but the nbcg API is not there (HTTP ${probe.status}) — check the base URL and API prefix.`;
    case "server-error":
      return `Backend reachable but unhealthy (HTTP ${probe.status}) — try again shortly.`;
    case "unreachable":
      return "Backend unreachable — check the base URL and your network.";
  }
}

/**
 * Fast boolean reachability check. True only when the nbcg API answered — a wrong
 * base URL/prefix is **not** reachable, because the app cannot do anything with it.
 *
 * NOTE: nothing calls this today. The footer poll (`stores/useConnection`) uses
 * {@link checkConnection} instead, because it needs the *reason* to tell the
 * operator "wrong URL" apart from "network down" — collapsing that to a boolean
 * is the exact mistake `domain/connection` exists to prevent. Kept for callers
 * that genuinely only need a yes/no; prefer `checkConnection` if you might ever
 * want to explain the answer.
 */
export async function checkReachable(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await probeHealth(client, signal)).reason === "ok";
}

export interface CheckConnectionOptions {
  signal?: AbortSignal;
  /** The base URL being tested, so the message can name it (Settings tests a
   * *draft* URL that is not necessarily the configured one). */
  baseUrl?: string;
}

/** Full check returning a {@link ReachabilityResult} for the UI. Never throws. */
export async function checkConnection(
  client: ApiClient,
  options: CheckConnectionOptions = {},
): Promise<ReachabilityResult> {
  const checkedAt = new Date().toISOString();
  const probe = await probeHealth(client, options.signal);
  return {
    reachable: probe.reason === "ok",
    reason: probe.reason,
    status: probe.status,
    message: messageFor(probe, options.baseUrl),
    checkedAt,
  };
}
