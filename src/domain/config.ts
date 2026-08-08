/**
 * Persisted application configuration (Epic 01 / Epic 10).
 *
 * The `apiToken` is a SECRET and is intentionally NOT part of this object — it
 * is stored and read separately (secure store in production; see
 * services/config.ts). Everything here is non-secret and safe to mirror to a
 * plain settings store.
 */

export type ThemePreference = "light" | "dark" | "system";

/** Non-secret, persisted config. */
export interface AppConfig {
  /** Root folder of incoming scans awaiting work. */
  unprocessedRoot: string | null;
  /** Root folder that processed + uploaded items are moved into. */
  processedRoot: string | null;
  /** Backend host, e.g. `https://api.nbcg.me`. */
  backendBaseUrl: string;
  /**
   * Path prefix the API is served under. The backend sets
   * `app.setGlobalPrefix("api")`, so requests go to `<baseUrl><apiPrefix>/...`.
   * Kept configurable in case a reverse proxy rewrites it.
   */
  apiPrefix: string;
  theme: ThemePreference;
  /**
   * Which `collectionType` numbers make a linked parent eligible to pass its
   * shared fields down (serial-type). Exact value(s) TBD, so it is a
   * configurable list (see docs/03 decisions).
   */
  dataPassingCollectionTypes: number[];
  // NOTE: the record-schema cache (ETag + offline copy) lives in
  // `services/api/schema.ts`, keyed per `?level`, not in this settings object.
}

/** Defaults for a fresh install (first run). */
export const DEFAULT_CONFIG: AppConfig = {
  unprocessedRoot: null,
  processedRoot: null,
  backendBaseUrl: "https://api.nbcg.me",
  apiPrefix: "/api",
  theme: "system",
  dataPassingCollectionTypes: [],
};

/** True when the app has enough config to be useful (drives first-run card). */
export function isConfigured(config: AppConfig): boolean {
  return Boolean(
    config.unprocessedRoot && config.processedRoot && config.backendBaseUrl,
  );
}

// ─── folder roots (Epic 10 §Configure → Folder locations) ────────────────────

/**
 * A configured root's status. `invalid` means "set, but the path is not a
 * directory we can see" — which is distinct from `not-set` because it is an
 * *error* the operator must fix, whereas not-set is just an unfinished first run.
 *
 * Determining `invalid` needs the filesystem, so it is resolved by
 * `services/config.probeRoot` (via `ipc.fs.pathExists`), not here.
 *
 * `unknown` is the honest answer when there is no filesystem to ask — a plain
 * `vite` dev session outside Tauri. It exists so a dev run does not have to
 * choose between claiming a path is Valid (a lie the operator could act on) and
 * flagging every configured root as broken.
 */
export type RootValidity = "valid" | "not-set" | "invalid" | "unknown";

/** Which of the two configured roots a status refers to. */
export type RootKey = "unprocessedRoot" | "processedRoot";

export const ROOT_KEYS: readonly RootKey[] = ["unprocessedRoot", "processedRoot"];

/** A root's configured path plus its resolved validity. */
export interface RootStatus {
  key: RootKey;
  path: string | null;
  validity: RootValidity;
}

/** Human-readable label for a root status (Settings shows Valid / Not set / …). */
export function describeRootValidity(validity: RootValidity): string {
  switch (validity) {
    case "valid":
      return "Valid";
    case "not-set":
      return "Not set";
    case "invalid":
      return "Invalid path";
    case "unknown":
      return "Not checked";
  }
}

/** Whether a root is usable for a pipeline run (set, and not known-broken). */
export function isRootUsable(validity: RootValidity): boolean {
  return validity === "valid" || validity === "unknown";
}

// ─── backend URL (Epic 10 §Configure → Backend connection) ───────────────────

/**
 * Canonical form of a base URL: trimmed, with any trailing slashes removed. The
 * {@link ApiClient} also trims trailing slashes, but normalising here means what
 * we *persist* and *display* is the same string we send — so the Settings field
 * does not silently disagree with the request URL.
 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Validate a base URL, returning an operator-facing error message or `null` when
 * it is usable.
 *
 * The host must **not** include the `/api` prefix — the backend applies that
 * globally and the client joins `<baseUrl><apiPrefix><path>`, so a base URL
 * ending in `/api` produces `/api/api/health` (a 404 that looks like an outage).
 * That mistake is common enough to be worth catching in the field.
 */
export function validateBaseUrl(raw: string): string | null {
  const value = normalizeBaseUrl(raw);
  if (!value) return "Enter the backend base URL.";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Not a valid URL — include the scheme, e.g. https://api.nbcg.me";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "The URL must start with http:// or https://";
  }
  if (!url.hostname) return "The URL is missing a host.";
  if (url.search || url.hash) {
    return "The base URL must not carry a query string or fragment.";
  }
  if (/\/api$/i.test(url.pathname)) {
    return "Leave off the /api suffix — it is added automatically.";
  }
  return null;
}

/** Canonical form of the API prefix: leading slash, no trailing slash. `""`
 * stays empty (a proxy that already serves the API at the root). */
export function normalizeApiPrefix(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return "";
  return value.startsWith("/") ? value : `/${value}`;
}

/** Validate the API prefix, returning an error message or `null`. */
export function validateApiPrefix(raw: string): string | null {
  const value = normalizeApiPrefix(raw);
  if (!value) return null; // empty is legal — the API is served at the root
  if (!/^\/[A-Za-z0-9\-._~/]*$/.test(value)) {
    return "The prefix may only contain URL-safe path characters.";
  }
  return null;
}

// ─── API token (Epic 10 §Configure → API access token) ───────────────────────

/**
 * Clean up a pasted token. Operators mint tokens with the `curl` in
 * docs/00-project-overview.md, which prints the **whole Keycloak JSON envelope**
 * — so a paste is as likely to be `{"access_token":"eyJ…","expires_in":300,…}`
 * as the bare token. This unwraps that, and strips the quoting/`Bearer ` prefix
 * a copy-paste tends to bring along, rather than storing a token that fails every
 * request with an unexplained 401.
 */
export function normalizeApiToken(raw: string): string {
  let value = raw.trim();
  if (!value) return "";

  // The full Keycloak token response, pasted wholesale.
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { access_token?: unknown };
      if (typeof parsed.access_token === "string") {
        value = parsed.access_token.trim();
      }
    } catch {
      // Not JSON after all — fall through and treat it as a literal token.
    }
  }

  // Surrounding quotes from a shell copy, then an `Authorization:`-style prefix.
  value = value.replace(/^["'`]|["'`]$/g, "").trim();
  value = value.replace(/^Bearer\s+/i, "").trim();
  // A wrapped paste can carry newlines/spaces a JWT never contains.
  return value.replace(/\s+/g, "");
}

/** Whether a token has the three dot-separated segments of a JWT. */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return (
    parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))
  );
}

/**
 * Validate a token, returning a **warning** message or `null`. Deliberately not
 * a hard error: the app never verifies the token itself (single-user, static
 * token, verify-on-use — docs/PROJECT-KNOWLEDGE §3), so a shape that merely
 * *looks* wrong must not block saving. It only flags an obvious paste mistake.
 */
export function validateApiToken(raw: string): string | null {
  const token = normalizeApiToken(raw);
  if (!token) return null; // no token is a legal (if limited) configuration
  if (!looksLikeJwt(token)) {
    return "This does not look like a Keycloak JWT (expected three dot-separated parts).";
  }
  return null;
}

/**
 * The masked rendering of a token for the Settings field's default state. No
 * characters of the secret are revealed — the length is capped so a long JWT
 * does not render as an absurd wall of dots, which also stops the mask from
 * leaking the exact token length.
 */
export function maskToken(token: string | null | undefined, dot = "•"): string {
  if (!token) return "";
  return dot.repeat(Math.min(token.length, 24));
}

/** Non-secret facts about the stored token, for the Settings display. */
export interface TokenSummary {
  present: boolean;
  /** Masked rendering (never the token itself). */
  masked: string;
  /** Whether it has a JWT's shape. */
  jwtShaped: boolean;
}

export function summarizeToken(token: string | null | undefined): TokenSummary {
  const value = token ?? "";
  return {
    present: value.length > 0,
    masked: maskToken(value),
    jwtShaped: value.length > 0 && looksLikeJwt(value),
  };
}

// ─── whole-config validation ─────────────────────────────────────────────────

/** Field-keyed validation messages. A key is absent when that field is fine. */
export type ConfigErrors = Partial<Record<keyof AppConfig | "apiToken", string>>;

/**
 * Validate the editable config. Splits **errors** (block Save) from **warnings**
 * (shown, but savable) because the only genuinely un-saveable state is a
 * malformed URL — everything else, including an empty token and unset roots, is
 * a legitimate mid-first-run configuration.
 *
 * Path *existence* is not checked here (it needs the filesystem); the roots'
 * {@link RootValidity} is resolved separately and surfaced alongside.
 */
export interface ConfigValidation {
  errors: ConfigErrors;
  warnings: ConfigErrors;
  valid: boolean;
}

export function validateConfig(
  config: Pick<AppConfig, "backendBaseUrl" | "apiPrefix">,
  apiToken?: string | null,
): ConfigValidation {
  const errors: ConfigErrors = {};
  const warnings: ConfigErrors = {};

  const urlError = validateBaseUrl(config.backendBaseUrl);
  if (urlError) errors.backendBaseUrl = urlError;

  const prefixError = validateApiPrefix(config.apiPrefix);
  if (prefixError) errors.apiPrefix = prefixError;

  const tokenWarning = validateApiToken(apiToken ?? "");
  if (tokenWarning) warnings.apiToken = tokenWarning;

  return {
    errors,
    warnings,
    valid: Object.keys(errors).length === 0,
  };
}

/** Normalise the user-editable string fields of a config in one pass, so what is
 * persisted is always canonical. */
export function normalizeConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    backendBaseUrl: normalizeBaseUrl(config.backendBaseUrl),
    apiPrefix: normalizeApiPrefix(config.apiPrefix),
  };
}
