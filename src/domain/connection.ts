/**
 * Backend connection / reachability vocabulary.
 *
 * The rail footer shows *backend reachability only* — a separate axis from any
 * item state (docs/tasks/01, /08).
 *
 * There is deliberately NO identity/token verification here: the app is
 * single-workstation, single-user (no login), and the static Keycloak token is
 * authenticated by the backend at the point of use (a bad token fails the first
 * real write with 401/403). So "Test connection" is just a reachability ping
 * against the unauthenticated `GET /api/health`. See docs/03 decisions.
 */

export type ConnectionState =
  /** Not yet checked. */
  | "unknown"
  /** A check is in flight. */
  | "checking"
  /** Backend reachable. */
  | "connected"
  /** Host unreachable (network error / timeout). */
  | "offline";

/**
 * Why a reachability check came out the way it did.
 *
 * The distinction that matters is **`not-nbcg-api`**: verified against the
 * running backend, `GET /api/health` is `200` but `GET /health` is `404`, so a
 * base URL or `apiPrefix` that is merely *wrong* still reaches a live host. A
 * check that only asked "did the transport fail?" reported that as Reachable —
 * sending the operator hunting for a network fault instead of the typo in
 * Settings that actually caused it.
 */
export type ReachabilityReason =
  /** `/api/health` answered and it is the nbcg API. */
  | "ok"
  /** The host answered, but the API is not at `<baseUrl><apiPrefix>` — a wrong
   * base URL or prefix (a 4xx, or a 200 that is not the health payload). */
  | "not-nbcg-api"
  /** The API answered with a 5xx — the host is up but the backend is unhealthy. */
  | "server-error"
  /** Transport failure: host unreachable, DNS failure, or timeout. */
  | "unreachable";

/** Outcome of a reachability check. */
export interface ReachabilityResult {
  /** True only when we reached **the nbcg API** — see {@link ReachabilityReason}. */
  reachable: boolean;
  reason: ReachabilityReason;
  /** HTTP status when the host answered at all; `0` for a transport failure. */
  status: number;
  /** Human-readable summary for the footer / Settings. */
  message: string;
  /** ISO timestamp of the check. */
  checkedAt: string;
}

/** Reduce a {@link ReachabilityResult} to the footer state. */
export function connectionStateFromResult(
  result: ReachabilityResult,
): ConnectionState {
  return result.reachable ? "connected" : "offline";
}

/**
 * Whether the failure is one the operator fixes in Settings (a wrong URL/prefix)
 * rather than by waiting for the network. Lets Settings point at the field
 * instead of showing a generic "Unreachable".
 */
export function isConfigurationFault(result: ReachabilityResult): boolean {
  return result.reason === "not-nbcg-api";
}
