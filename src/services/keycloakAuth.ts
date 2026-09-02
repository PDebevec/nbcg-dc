/**
 * Mints and silently refreshes the Keycloak bearer token from stored
 * username/password, so the operator never has to run the manual
 * `curl .../protocol/openid-connect/token` dance and re-paste a token every
 * ~5 minutes (`expires_in: 300` — docs/tasks/10-settings-and-naming.md).
 *
 * Lives in TypeScript, not Rust, on purpose: `src-tauri/src/lib.rs` states
 * the native core "deliberately does not talk to the `nbcg` backend — all
 * HTTP lives in the TypeScript lane... so the Keycloak token and every wire
 * concern stay in one place" (docs/04-code-structure.md's seam-3 decision).
 * This module is that "wire concern" for Keycloak specifically, alongside
 * `services/api/client.ts` for the backend itself.
 *
 * Realm and client id are not configurable — this app only ever talks to one
 * realm/client (`nbcg`/`nbcg-web`, verified against the team's own
 * `FRONTEND-TODO.md`). Only the Keycloak host differs between dev and prod,
 * which is why that alone is a Settings field (`AppConfig.keycloakUrl`).
 *
 * NOTE: `nbcg-web`'s Direct Access Grant (the password grant this module
 * uses) is, per the team's own `FRONTEND-TODO.md`, disabled in the *saved*
 * realm config and only still works because the live dev Keycloak hasn't
 * been re-imported from it yet. If that ever happens, minting fails with
 * `unauthorized_client`/`invalid_grant` here exactly as it would for the
 * manual curl — this module does not paper over that, it just automates
 * whatever grant is actually live.
 */

import type { FetchLike } from "./api/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { KeycloakCredentials } from "@domain/config";
import { logger } from "@lib/logger";

const KEYCLOAK_REALM = "nbcg";
const KEYCLOAK_CLIENT_ID = "nbcg-web";

/** How long before its real expiry a cached token is treated as already
 * expired — avoids a request racing a token that expires mid-flight. */
const SAFETY_MARGIN_MS = 15_000;

export type KeycloakAuthErrorReason =
  | "invalid_credentials"
  | "not_configured"
  | "network"
  | "server";

export class KeycloakAuthError extends Error {
  readonly reason: KeycloakAuthErrorReason;

  constructor(reason: KeycloakAuthErrorReason, message: string) {
    super(message);
    this.name = "KeycloakAuthError";
    this.reason = reason;
  }
}

/** The subset of a Keycloak OIDC token response this module needs. */
interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
}

interface KeycloakErrorBody {
  error?: string;
  error_description?: string;
}

interface CachedToken {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

export interface KeycloakAuthOptions {
  /** Keycloak host, e.g. `http://localhost:8082`. */
  keycloakUrl: string;
  /** Supplies the currently-saved credentials, read lazily (mirrors
   * `ApiClientOptions.getToken`) so a credentials change applies without
   * reconstructing this. */
  getCredentials: () => Promise<KeycloakCredentials | null>;
  /** Override the transport (default: `@tauri-apps/plugin-http` fetch) —
   * same seam `ApiClient` uses, for the same reason (unit-testable without
   * Tauri). */
  fetchImpl?: FetchLike;
  /** Override the clock — tests advance this instead of real time. */
  now?: () => number;
}

/** Build the `application/x-www-form-urlencoded` body Keycloak's token
 * endpoint expects. */
function formBody(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  return params.toString();
}

export class KeycloakAuth {
  private readonly keycloakUrl: string;
  private readonly getCredentials: () => Promise<KeycloakCredentials | null>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  private cached: CachedToken | null = null;
  private inFlight: Promise<string | null> | null = null;

  constructor(options: KeycloakAuthOptions) {
    this.keycloakUrl = options.keycloakUrl.replace(/\/+$/, "");
    this.getCredentials = options.getCredentials;
    this.fetchImpl = options.fetchImpl ?? (tauriFetch as FetchLike);
    this.now = options.now ?? Date.now;
  }

  /** Discard the cached token — call after credentials change, so the very
   * next request mints fresh rather than riding out a stale cache. */
  clearCache(): void {
    this.cached = null;
  }

  /**
   * Return a currently-valid access token, minting or refreshing as needed.
   * `null` only when no credentials have ever been saved (today's exact
   * "no token configured" behavior — the request goes out unauthenticated).
   * Any *active* failure (wrong password, Keycloak unreachable,
   * `invalid_grant`) throws {@link KeycloakAuthError} instead.
   *
   * Concurrent callers share one in-flight mint/refresh rather than each
   * firing their own — near expiry, several backend requests can all land
   * here at once.
   */
  async getValidAccessToken(): Promise<string | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.resolveToken();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async resolveToken(): Promise<string | null> {
    const now = this.now();

    if (this.cached && now < this.cached.accessExpiresAt - SAFETY_MARGIN_MS) {
      return this.cached.accessToken;
    }

    if (
      this.cached?.refreshToken &&
      this.cached.refreshExpiresAt !== undefined &&
      now < this.cached.refreshExpiresAt - SAFETY_MARGIN_MS
    ) {
      try {
        return await this.mint({
          grant_type: "refresh_token",
          refresh_token: this.cached.refreshToken,
          client_id: KEYCLOAK_CLIENT_ID,
        });
      } catch (err) {
        // The refresh token was rejected despite our own bookkeeping saying
        // it should still be valid (revoked, realm re-imported, clock
        // drift) — fall through to a fresh password grant rather than
        // failing the caller outright.
        logger.warn("keycloakAuth", "Refresh token rejected; re-minting.", err);
      }
    }

    const credentials = await this.getCredentials();
    if (!credentials) return null;

    return this.mint({
      grant_type: "password",
      client_id: KEYCLOAK_CLIENT_ID,
      username: credentials.username,
      password: credentials.password,
    });
  }

  /**
   * A cache-bypassing one-off mint against arbitrary (possibly unsaved)
   * credentials, for Settings → Test connection to validate them
   * immediately rather than waiting for the first real backend write to
   * surface a bad password as a bare 401
   * (docs/tasks/10-settings-and-naming.md's "No token probe" gap).
   *
   * Never touches the shared cache — a probe of draft credentials must not
   * repoint the running app's token.
   */
  async mintOnce(username: string, password: string): Promise<void> {
    await this.request({
      grant_type: "password",
      client_id: KEYCLOAK_CLIENT_ID,
      username,
      password,
    });
  }

  private async mint(fields: Record<string, string>): Promise<string> {
    const response = await this.request(fields);
    this.cached = {
      accessToken: response.access_token,
      accessExpiresAt: this.now() + response.expires_in * 1000,
      refreshToken: response.refresh_token,
      refreshExpiresAt:
        response.refresh_expires_in !== undefined
          ? this.now() + response.refresh_expires_in * 1000
          : undefined,
    };
    return response.access_token;
  }

  private async request(fields: Record<string, string>): Promise<TokenResponse> {
    const url = `${this.keycloakUrl}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody(fields),
      });
    } catch (err) {
      throw new KeycloakAuthError(
        "network",
        `Could not reach Keycloak at ${this.keycloakUrl}: ${(err as Error)?.message ?? err}`,
      );
    }

    if (!response.ok) {
      const body = await safeParseJson<KeycloakErrorBody>(response);
      if (response.status === 400 || response.status === 401) {
        throw new KeycloakAuthError(
          "invalid_credentials",
          body?.error_description ?? "Invalid Keycloak username or password.",
        );
      }
      throw new KeycloakAuthError(
        "server",
        `Keycloak returned ${response.status}${body?.error ? ` (${body.error})` : ""}.`,
      );
    }

    return (await response.json()) as TokenResponse;
  }
}

async function safeParseJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

let instance: KeycloakAuth | null = null;

export function configureKeycloakAuth(options: KeycloakAuthOptions): KeycloakAuth {
  instance = new KeycloakAuth(options);
  return instance;
}

export function getKeycloakAuth(): KeycloakAuth {
  if (!instance) {
    throw new Error(
      "Keycloak auth not configured — call configureKeycloakAuth() during boot.",
    );
  }
  return instance;
}
