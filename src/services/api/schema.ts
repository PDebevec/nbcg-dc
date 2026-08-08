/**
 * Record-schema service (Epic 04, task 1) — fetches and caches the backend's
 * metadata field schema so the editor's dynamic form always matches the
 * website's record type.
 *
 * Endpoint: `GET /api/schema/record?level=main|child` → `{ fields }`
 * (anonymous-OK). The backend serves it with a **strong ETag** + `Cache-Control:
 * max-age=86400`, so this module treats it as an HTTP cache:
 *
 *  - **Fresh (< 24h) cache** is served without touching the network.
 *  - Otherwise we **revalidate** with `If-None-Match: <etag>`; a `304` keeps the
 *    cached copy, a `200` replaces it.
 *  - When the backend is **unreachable** (or errors), a previously-cached schema
 *    is returned so the form still renders **offline**; with no cache the
 *    {@link ApiError} propagates.
 *
 * The cache is per `?level` (`main` / `child` / — for the unfiltered fetch —
 * `all`). It lives in memory and, when a webview `localStorage` is present
 * (Tauri and the `vite` dev server), is persisted there so the offline copy
 * survives a restart. In the plain Node test environment `localStorage` is
 * absent and the cache is memory-only — see the mirroring guard in
 * `services/config.ts`.
 *
 * Stays in Jernej's `.ts` lane (Seam 3, backend-only). The form renderer (GUI)
 * consumes the returned {@link RecordSchema} via a composable; the pure
 * schema→form rules live in `domain/metadata-form.ts`.
 */

import type { ApiClient } from "./client";
import { ApiError } from "./client";
import type { FieldLevel, RecordSchema } from "@domain/schema";
import { getApiClient } from "../backend";
import { logger } from "@lib/logger";

/** How long a fetched schema is considered fresh — mirrors the backend's
 * `Cache-Control: max-age=86400` (24h). Past this we revalidate via ETag. */
export const SCHEMA_MAX_AGE_MS = 86_400_000;

/** localStorage key namespace (bump the suffix to invalidate persisted caches
 * across an incompatible {@link CacheEntry} shape change). */
const CACHE_LS_PREFIX = "nbcg-dc.schema.v1";

/** The cache key for a level (`undefined` = the unfiltered "all levels" fetch). */
type CacheKey = FieldLevel | "all";
const ALL_KEYS: readonly CacheKey[] = ["all", "main", "child"];

interface CacheEntry {
  schema: RecordSchema;
  /** The `ETag` sent back with this schema, for `If-None-Match` revalidation. */
  etag: string | null;
  /** ISO time this copy was last fetched/revalidated (drives freshness). */
  fetchedAt: string;
}

/** In-memory cache, authoritative within a session; `localStorage` is the
 * cross-restart mirror it is hydrated from on first access. */
const memory = new Map<CacheKey, CacheEntry>();

export interface GetSchemaOptions {
  /** Client to use (defaults to the configured backend singleton). Injectable
   * for tests. */
  client?: ApiClient;
  /** Skip the freshness fast-path and force an ETag revalidation. */
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

function levelKey(level?: FieldLevel): CacheKey {
  return level ?? "all";
}

function nowIso(): string {
  return new Date().toISOString();
}

function isFresh(entry: CacheEntry): boolean {
  const age = Date.now() - Date.parse(entry.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < SCHEMA_MAX_AGE_MS;
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function lsKey(key: CacheKey): string {
  return `${CACHE_LS_PREFIX}.${key}`;
}

/** Read a cache entry, hydrating memory from `localStorage` on a cold miss. */
function readCache(key: CacheKey): CacheEntry | null {
  const inMemory = memory.get(key);
  if (inMemory) return inMemory;
  if (!hasLocalStorage()) return null;
  const raw = localStorage.getItem(lsKey(key));
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry?.schema?.fields) return null;
    memory.set(key, entry);
    return entry;
  } catch {
    logger.warn("schema", `Corrupt cached schema for "${key}"; ignoring.`);
    return null;
  }
}

function writeCache(key: CacheKey, entry: CacheEntry): void {
  memory.set(key, entry);
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(lsKey(key), JSON.stringify(entry));
  } catch (err) {
    // A full/again-disabled quota shouldn't break fetching — memory still holds it.
    logger.warn("schema", "Could not persist schema cache.", err);
  }
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.status ? `${err.kind} ${err.status}` : err.kind;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * How a schema read was actually satisfied. Needed because "returned a schema"
 * and "reached the backend" are different facts: the offline fallback makes a
 * successful return ambiguous, and a Settings **refresh** must not claim to have
 * updated something it served from cache (see {@link refreshRecordSchema}).
 */
export type SchemaFetchOutcome =
  /** Served from a still-fresh cache; no request made. */
  | "cache-fresh"
  /** Backend answered `304` — the cached copy is confirmed current. */
  | "revalidated"
  /** Backend answered `200` with a schema, which replaced the cache. */
  | "replaced"
  /** Backend answered `200` with an empty field list; the cache was kept. */
  | "rejected-empty"
  /** The request failed and the cached copy was served instead. */
  | "cache-offline";

interface SchemaFetch {
  schema: RecordSchema;
  outcome: SchemaFetchOutcome;
}

/** The read behind {@link getRecordSchema}, reporting how it was satisfied. */
async function fetchRecordSchema(
  level: FieldLevel | undefined,
  options: GetSchemaOptions,
): Promise<SchemaFetch> {
  const key = levelKey(level);
  const cached = readCache(key);

  // Fresh cache → serve straight from cache (honours the backend max-age; no
  // network round-trip on repeated opens within the day).
  if (!options.forceRefresh && cached && isFresh(cached)) {
    return { schema: cached.schema, outcome: "cache-fresh" };
  }

  const client = options.client ?? getApiClient();
  try {
    const res = await client.requestDetailed<RecordSchema>(
      "GET",
      "/schema/record",
      {
        query: level ? { level } : undefined,
        headers: cached?.etag ? { "If-None-Match": cached.etag } : undefined,
        acceptStatuses: [304],
        signal: options.signal,
      },
    );

    // 304 Not Modified → our cached copy is still current.
    if (res.status === 304 && cached) {
      writeCache(key, { ...cached, fetchedAt: nowIso() });
      return { schema: cached.schema, outcome: "revalidated" };
    }

    const schema = res.data ?? { fields: [] };

    // An EMPTY field list must never replace a good cache.
    //
    // The original reason is gone: `?level` is now validated backend-side, so an
    // unrecognised value is a `400` instead of `200 { fields: [] }`
    // (nbcg/todo/backend-schema-level-validation.md, fixed 2026-08-07). The guard
    // stays because it never depended on that specific cause — a `200` carrying no
    // fields is *still* indistinguishable from a transient backend or deployment
    // fault, and caching one would persist an empty schema for the full 24h
    // max-age, offline copy included, leaving the metadata editor a form with no
    // fields. Cheap insurance against a class of fault, not one instance of it.
    if (schema.fields.length === 0 && cached && cached.schema.fields.length > 0) {
      logger.warn(
        "schema",
        `Backend returned an empty schema for "${key}"; keeping the cached copy.`,
      );
      return { schema: cached.schema, outcome: "rejected-empty" };
    }

    writeCache(key, { schema, etag: res.etag, fetchedAt: nowIso() });
    return { schema, outcome: "replaced" };
  } catch (err) {
    // Offline / backend error: degrade to the cached schema so the form still
    // renders. Only re-throw when there is nothing cached to fall back to.
    if (cached) {
      logger.warn(
        "schema",
        `Schema fetch failed (${describeError(err)}); serving cached copy.`,
      );
      return { schema: cached.schema, outcome: "cache-offline" };
    }
    throw err;
  }
}

/**
 * Return the record schema for a level, using the cache as described above.
 *
 * @param level `"main"` / `"child"`, or omit for the unfiltered schema (every
 *   field; filter client-side with `fieldsForLevel` in `domain/metadata-form`).
 */
export async function getRecordSchema(
  level?: FieldLevel,
  options: GetSchemaOptions = {},
): Promise<RecordSchema> {
  return (await fetchRecordSchema(level, options)).schema;
}

/** The cached schema for a level without any network access, or `null`. Lets a
 * view render instantly from cache while {@link getRecordSchema} revalidates. */
export function peekRecordSchema(level?: FieldLevel): RecordSchema | null {
  return readCache(levelKey(level))?.schema ?? null;
}

/** Drop all cached schemas (memory + `localStorage`). Used to isolate tests; a
 * Settings refresh should prefer {@link refreshRecordSchema}, which revalidates
 * without a window where the app has no schema at all. */
export function clearRecordSchemaCache(): void {
  memory.clear();
  if (!hasLocalStorage()) return;
  for (const key of ALL_KEYS) localStorage.removeItem(lsKey(key));
}

// ─── Settings → Refresh metadata schema (Epic 10) ────────────────────────────

/** What the cache holds for one level, for the Settings display. */
export interface SchemaCacheInfo {
  level: FieldLevel;
  /** Number of cached field descriptors; `null` when nothing is cached. */
  fieldCount: number | null;
  /** ISO time the copy was last fetched or revalidated. */
  fetchedAt: string | null;
  etag: string | null;
  fresh: boolean;
}

/** The levels the app actually uses — the main and child record forms. */
const REFRESH_LEVELS: readonly FieldLevel[] = ["main", "child"];

/** Cache state per level, without any network access. */
export function recordSchemaCacheInfo(): SchemaCacheInfo[] {
  return REFRESH_LEVELS.map((level) => {
    const entry = readCache(levelKey(level));
    return {
      level,
      fieldCount: entry ? entry.schema.fields.length : null,
      fetchedAt: entry?.fetchedAt ?? null,
      etag: entry?.etag ?? null,
      fresh: entry ? isFresh(entry) : false,
    };
  });
}

/** Outcome of a Settings schema refresh. */
export interface SchemaRefreshResult {
  /** True only when every level actually reached the backend. */
  ok: boolean;
  /**
   * True when the backend could not be reached and the **previous** schema is
   * still in place. Distinct from `ok: false` with an `error`, which means a level
   * has no schema at all. Reporting these the same way would tell the operator
   * "refreshed" after a refresh that did nothing.
   */
  stale: boolean;
  /** Per-level cache state after the refresh. */
  levels: SchemaCacheInfo[];
  /** One-line operator summary (toast / status line). */
  message: string;
  /** Set when a level could not be refreshed. */
  error?: string;
}

/**
 * Re-fetch the record schema for both levels and update the cache.
 *
 * Forces an **ETag revalidation** rather than clearing the cache first: the
 * backend answers `304` when nothing changed (verified), so a refresh is cheap,
 * and — more importantly — a failed refresh leaves the previous schema intact
 * instead of leaving the app with no field definitions at all.
 *
 * Never throws; the outcome is reported in the returned {@link SchemaRefreshResult}
 * so Settings can show it inline.
 */
export async function refreshRecordSchema(
  options: Pick<GetSchemaOptions, "client" | "signal"> = {},
): Promise<SchemaRefreshResult> {
  const failures: string[] = [];
  const staleLevels: FieldLevel[] = [];

  for (const level of REFRESH_LEVELS) {
    try {
      // A read degrades to the cached copy when the backend is unreachable —
      // deliberately, so the editor keeps working offline. That makes a successful
      // return ambiguous for a *refresh*, which must not claim to have updated
      // anything it did not, so we go through the outcome-reporting read.
      const { outcome } = await fetchRecordSchema(level, {
        ...options,
        forceRefresh: true,
      });
      if (outcome === "cache-offline") staleLevels.push(level);
    } catch (err) {
      failures.push(`${level}: ${describeError(err)}`);
    }
  }

  const levels = recordSchemaCacheInfo();

  if (failures.length > 0) {
    // getRecordSchema only throws when it had no cached copy to serve, so a
    // failure here means that level genuinely has no schema.
    return {
      ok: false,
      stale: staleLevels.length > 0,
      levels,
      message: "Could not refresh the metadata schema.",
      error: failures.join("; "),
    };
  }

  if (staleLevels.length > 0) {
    return {
      ok: false,
      stale: true,
      levels,
      message:
        "Could not reach the backend — keeping the cached metadata schema.",
      error: `Not refreshed: ${staleLevels.join(", ")}.`,
    };
  }

  const counts = levels.map((l) => `${l.level} ${l.fieldCount ?? 0}`).join(", ");
  return {
    ok: true,
    stale: false,
    levels,
    message: `Metadata schema refreshed (${counts} fields).`,
  };
}
