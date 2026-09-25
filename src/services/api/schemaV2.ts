/**
 * Metadata schema v2 service — `GET /api/schema/v2/record`, the one schema the
 * metadata editor is built from (contract: nbcg
 * docs/shared/plans/metadata-schema-v2.md).
 *
 * Served with an ETag and `Cache-Control: no-cache`, so the copy kept here only
 * saves the download:
 *  - the first read of a session always revalidates (`If-None-Match` → `304`
 *    keeps the copy, `200` replaces it); later reads in the session use memory;
 *  - Settings → Refresh forces a revalidation ({@link refreshRecordSchemaV2});
 *  - when the backend cannot be reached the kept copy is served, so an open
 *    editor keeps working; with nothing kept the error propagates;
 *  - a `200` with no fields never replaces a kept copy (a backend fault, not a
 *    schema).
 *
 * Kept in memory and mirrored to `localStorage` when there is one (Tauri, the
 * dev server; not the Node test environment).
 */

import type { ApiClient } from "./client";
import { ApiError } from "./client";
import type { RecordSchemaV2 } from "@domain/schema";
import { getApiClient } from "../backend";
import { logger } from "@lib/logger";

const CACHE_KEY = "nbcg-dc.schema.v2";

interface CacheEntry {
  schema: RecordSchemaV2;
  etag: string | null;
  fetchedAt: string;
}

let memory: CacheEntry | null = null;
/** Whether this session already asked the backend. */
let checkedThisSession = false;

export interface GetSchemaV2Options {
  /** Client to use (defaults to the configured backend singleton). */
  client?: ApiClient;
  signal?: AbortSignal;
  /** Revalidate even if this session already did. */
  forceRefresh?: boolean;
}

/** How a read was satisfied — a refresh must not claim what it did not do. */
type Outcome = "memory" | "revalidated" | "replaced" | "rejected-empty" | "cache-offline";

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function readCache(): CacheEntry | null {
  if (memory) return memory;
  if (!hasLocalStorage()) return null;
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as CacheEntry;
    if (!Array.isArray(entry?.schema?.fields)) return null;
    memory = entry;
    return entry;
  } catch {
    logger.warn("schema", "Corrupt cached v2 schema; ignoring.");
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  memory = entry;
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch (err) {
    logger.warn("schema", "Could not persist the v2 schema.", err);
  }
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.status ? `${err.kind} ${err.status}` : err.kind;
  return err instanceof Error ? err.message : String(err);
}

async function fetchSchema(
  options: GetSchemaV2Options,
): Promise<{ schema: RecordSchemaV2; outcome: Outcome }> {
  const cached = readCache();
  if (!options.forceRefresh && checkedThisSession && cached) {
    return { schema: cached.schema, outcome: "memory" };
  }
  const client = options.client ?? getApiClient();
  try {
    const res = await client.requestDetailed<RecordSchemaV2>("GET", "/schema/v2/record", {
      headers: cached?.etag ? { "If-None-Match": cached.etag } : undefined,
      acceptStatuses: [304],
      signal: options.signal,
    });
    checkedThisSession = true;
    if (res.status === 304 && cached) {
      writeCache({ ...cached, fetchedAt: new Date().toISOString() });
      return { schema: cached.schema, outcome: "revalidated" };
    }
    const schema = res.data;
    if (!schema || !Array.isArray(schema.fields) || schema.fields.length === 0) {
      if (cached) {
        logger.warn("schema", "Backend returned an empty v2 schema; keeping the cached copy.");
        return { schema: cached.schema, outcome: "rejected-empty" };
      }
      throw new Error("The backend returned an empty metadata schema.");
    }
    writeCache({ schema, etag: res.etag, fetchedAt: new Date().toISOString() });
    return { schema, outcome: "replaced" };
  } catch (err) {
    if (cached) {
      logger.warn("schema", `v2 schema fetch failed (${describeError(err)}); serving the cached copy.`);
      return { schema: cached.schema, outcome: "cache-offline" };
    }
    throw err;
  }
}

/** The v2 record schema (see the module doc for caching). */
export async function getRecordSchemaV2(options: GetSchemaV2Options = {}): Promise<RecordSchemaV2> {
  return (await fetchSchema(options)).schema;
}

/** The kept schema without any network access, or null. */
export function peekRecordSchemaV2(): RecordSchemaV2 | null {
  return readCache()?.schema ?? null;
}

/** Forget the kept copy and the session check (tests). */
export function clearRecordSchemaV2Cache(): void {
  memory = null;
  checkedThisSession = false;
  if (hasLocalStorage()) localStorage.removeItem(CACHE_KEY);
}

/** What is kept, for the Settings display. */
export interface SchemaV2CacheInfo {
  fieldCount: number | null;
  fetchedAt: string | null;
  etag: string | null;
}

export function recordSchemaV2CacheInfo(): SchemaV2CacheInfo {
  const entry = readCache();
  return {
    fieldCount: entry ? entry.schema.fields.length : null,
    fetchedAt: entry?.fetchedAt ?? null,
    etag: entry?.etag ?? null,
  };
}

/** Outcome of Settings → Refresh schema. */
export interface SchemaV2RefreshResult {
  /** True only when the backend actually answered. */
  ok: boolean;
  /** The backend was unreachable and the previous copy is still in place. */
  stale: boolean;
  cache: SchemaV2CacheInfo;
  /** One line for a toast. */
  message: string;
  error?: string;
}

/** Revalidate now. Never throws. */
export async function refreshRecordSchemaV2(
  options: Pick<GetSchemaV2Options, "client" | "signal"> = {},
): Promise<SchemaV2RefreshResult> {
  try {
    const { outcome } = await fetchSchema({ ...options, forceRefresh: true });
    const cache = recordSchemaV2CacheInfo();
    if (outcome === "cache-offline") {
      return {
        ok: false,
        stale: true,
        cache,
        message: "Could not reach the backend — keeping the cached metadata schema.",
      };
    }
    return {
      ok: true,
      stale: false,
      cache,
      message: `Metadata schema refreshed (${cache.fieldCount ?? 0} fields).`,
    };
  } catch (err) {
    return {
      ok: false,
      stale: false,
      cache: recordSchemaV2CacheInfo(),
      message: "Could not refresh the metadata schema.",
      error: describeError(err),
    };
  }
}
