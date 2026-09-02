/**
 * Persisted application configuration (Epic 01 / Epic 10).
 *
 * The Keycloak **password** is a SECRET and is intentionally NOT part of this
 * object — it is stored and read separately (secure store in production; see
 * services/config.ts and services/keycloakAuth.ts, which mint/refresh the
 * actual bearer token from it). The **username** is not sensitive (an
 * identifier, not a credential) and lives right here alongside the other
 * plain settings, same as `backendBaseUrl`.
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
  /**
   * Keycloak host, e.g. `http://localhost:8082` in dev. Realm (`nbcg`) and
   * client id (`nbcg-web`) are not configurable — see
   * `services/keycloakAuth.ts` — only the host differs between dev and prod.
   */
  keycloakUrl: string;
  /** Keycloak username. Not a secret — see this file's header comment. The
   * password pairing it lives in the secure store (`services/config.ts`). */
  kcUsername: string;
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
  keycloakUrl: "http://localhost:8082",
  kcUsername: "",
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

/**
 * Validate the Keycloak host, same rules as {@link validateBaseUrl} minus the
 * `/api`-suffix check (Keycloak is not the `nbcg` backend, so that mistake
 * does not apply here).
 */
export function validateKeycloakUrl(raw: string): string | null {
  const value = normalizeBaseUrl(raw);
  if (!value) return "Enter the Keycloak host.";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Not a valid URL — include the scheme, e.g. http://localhost:8082";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "The URL must start with http:// or https://";
  }
  if (!url.hostname) return "The URL is missing a host.";
  if (url.search || url.hash) {
    return "The Keycloak URL must not carry a query string or fragment.";
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

// ─── Keycloak credentials (Epic 10 §Configure → Backend connection) ──────────
//
// The app used to ask for a manually-minted token pasted in whole. It now
// asks for the Keycloak username (a plain `AppConfig` field, above) and
// password (a secret, handled here + in services/config.ts) once, and mints
// + silently refreshes the actual bearer token itself
// (`services/keycloakAuth.ts`).

/** What `services/keycloakAuth.ts` needs to mint a token. Assembled from two
 * different sources — `AppConfig.kcUsername` (plain) + the secret password
 * (`services/config.ts`) — not stored as a unit anywhere. */
export interface KeycloakCredentials {
  username: string;
  password: string;
}

/** Trim a pasted username. */
export function normalizeUsername(raw: string): string {
  return raw.trim();
}

/**
 * Validate the username/password pair, returning a **warning** message or
 * `null`. Deliberately not a hard error — the app never verifies these
 * itself before Save (docs/PROJECT-KNOWLEDGE §3's "verify on use"
 * philosophy extends to this too; Settings → Test connection is what
 * actually checks them, see `services/keycloakAuth.ts#mintOnce`). This only
 * catches the obvious half-filled-in mistake.
 */
export function validateCredentials(username: string, password: string): string | null {
  const trimmedUsername = normalizeUsername(username);
  if (!trimmedUsername && !password) return null; // neither set is a legal (if limited) configuration
  if (!trimmedUsername || !password) {
    return "Enter both the Keycloak username and password, or leave both blank.";
  }
  return null;
}

/**
 * The masked rendering of a secret for the Settings field's default state. No
 * characters are revealed — the length is capped so a long password does not
 * render as an absurd wall of dots, which also stops the mask from leaking
 * the exact secret length.
 */
export function maskSecret(secret: string | null | undefined, dot = "•"): string {
  if (!secret) return "";
  return dot.repeat(Math.min(secret.length, 24));
}

/** Non-secret facts about the stored password, for the Settings display. */
export interface PasswordSummary {
  present: boolean;
  /** Masked rendering (never the password itself). */
  masked: string;
}

export function summarizePassword(password: string | null | undefined): PasswordSummary {
  const value = password ?? "";
  return {
    present: value.length > 0,
    masked: maskSecret(value),
  };
}

// ─── whole-config validation ─────────────────────────────────────────────────

/** Field-keyed validation messages. A key is absent when that field is fine. */
export type ConfigErrors = Partial<Record<keyof AppConfig | "kcPassword", string>>;

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
  config: Pick<AppConfig, "backendBaseUrl" | "apiPrefix" | "keycloakUrl" | "kcUsername">,
  kcPassword?: string | null,
): ConfigValidation {
  const errors: ConfigErrors = {};
  const warnings: ConfigErrors = {};

  const urlError = validateBaseUrl(config.backendBaseUrl);
  if (urlError) errors.backendBaseUrl = urlError;

  const prefixError = validateApiPrefix(config.apiPrefix);
  if (prefixError) errors.apiPrefix = prefixError;

  const keycloakUrlError = validateKeycloakUrl(config.keycloakUrl);
  if (keycloakUrlError) errors.keycloakUrl = keycloakUrlError;

  const credentialsWarning = validateCredentials(config.kcUsername, kcPassword ?? "");
  if (credentialsWarning) warnings.kcPassword = credentialsWarning;

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
    keycloakUrl: normalizeBaseUrl(config.keycloakUrl),
    kcUsername: normalizeUsername(config.kcUsername),
  };
}
