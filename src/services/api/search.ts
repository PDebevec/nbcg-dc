/**
 * Search service (Epic 08) — the archive's read window onto the backend
 * catalogue: `GET /api/search`, `/api/search/:id`, `/api/search/:id/children`,
 * and `/api/search/suggest`.
 *
 * This is the **only** way to read an item back. There is deliberately no
 * `GET /api/items/:id` (dropped in Epic 09), so every backend→archive refresh,
 * the parent picker, and the browse UI all land here.
 *
 * Three properties of this endpoint shape everything built on top of it:
 *
 *  1. **CDC-lagged.** Search reads OpenSearch, fed from Postgres by pgsync. A
 *     just-written item is not immediately visible, and an indexed `version` can
 *     be older than the one the write returned. Trust write responses over
 *     search (docs/02-architecture.md).
 *  2. **A `404` is ambiguous.** Not-indexed-yet, not-visible-to-this-token, and
 *     genuinely-deleted are indistinguishable — the backend returns 404 for a
 *     visibility miss on purpose, so hidden items aren't leaked. {@link findById}
 *     therefore returns `null` rather than throwing, and the *interpretation* is
 *     left to `domain/sync` (which never orphans an item on one miss).
 *  3. **Visibility is scope-gated.** `PUBLIC` records are the baseline for
 *     everyone; PRIVATE/HIDDEN need `records:view:private`/`:hidden`, and
 *     **drafts are invisible without an explicit `drafts:view:*` scope**. A
 *     token missing those sees an empty catalogue, not an error.
 *
 * Stays in Jernej's `.ts` lane (Seam 3, backend-only).
 */

import type { ApiClient } from "./client";
import { ApiError } from "./client";
import {
  SEARCH_DEEP_PAGINATION_LIMIT,
  SEARCH_MAX_LIMIT,
  type SearchHit,
  type SearchIndex,
  type SearchQuery,
  type SearchResult,
  type SuggestQuery,
  type SuggestResult,
} from "./dto";
import { ItemType } from "@domain/enums";
import { getApiClient } from "../backend";

/** Default page size when the caller does not specify one (mirrors the backend
 * default, stated explicitly so paging maths never depends on a server default). */
export const DEFAULT_SEARCH_LIMIT = 20;

export interface SearchOptions {
  /** Client to use (defaults to the configured backend singleton). Injectable
   * for tests. */
  client?: ApiClient;
  signal?: AbortSignal;
}

/**
 * Which collection a hit belongs to. The index name **is** the collection, so
 * this is how a search read recovers an item's `targetState` (DRAFT vs RECORD) —
 * there is no `targetState` field on the document itself.
 */
export function searchIndexToItemType(index: string): ItemType | null {
  if (index === "records") return ItemType.RECORD;
  if (index === "drafts") return ItemType.DRAFT;
  return null;
}

/** The reverse mapping — the `type` filter that scopes a query to one collection. */
export function itemTypeToSearchIndex(type: ItemType): SearchIndex {
  return type === ItemType.RECORD ? "records" : "drafts";
}

/**
 * Thrown before the request when a page is past OpenSearch's `from + size <
 * 10000` window. The backend would answer `400`; failing locally keeps the
 * distinction between "you asked for the impossible" and "the query was
 * malformed" clear, and costs nothing.
 */
export class DeepPaginationError extends Error {
  readonly page: number;
  readonly limit: number;
  constructor(page: number, limit: number) {
    super(
      `Page ${page} at limit ${limit} exceeds the backend's ${SEARCH_DEEP_PAGINATION_LIMIT}-result window ` +
        `(from + limit must stay below it). Narrow the query instead of paging further.`,
    );
    this.name = "DeepPaginationError";
    this.page = page;
    this.limit = limit;
  }
}

/** True when `page`/`limit` would land past the deep-pagination window. */
export function isBeyondPaginationWindow(page: number, limit: number): boolean {
  return (page - 1) * limit + limit >= SEARCH_DEEP_PAGINATION_LIMIT;
}

/** Serialise a {@link SearchQuery} to query params, dropping empty values and
 * clamping `limit` to the backend's cap so a caller's `limit: 500` becomes a
 * valid request instead of a `400`. */
function toQueryParams(
  query: SearchQuery,
): Record<string, string | number | undefined> {
  const params: Record<string, string | number | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    params[key] = value as string | number;
  }
  if (query.limit !== undefined) {
    params.limit = Math.min(Math.max(1, Math.trunc(query.limit)), SEARCH_MAX_LIMIT);
  }
  return params;
}

/** Guard the deep-pagination window using the *effective* page/limit. */
function assertPageable(query: SearchQuery): void {
  const page = query.page ?? 1;
  const limit = Math.min(query.limit ?? DEFAULT_SEARCH_LIMIT, SEARCH_MAX_LIMIT);
  if (isBeyondPaginationWindow(page, limit)) {
    throw new DeepPaginationError(page, limit);
  }
}

/**
 * `GET /api/search` — browse/search records and drafts.
 *
 * Note the visibility rule above: with no `drafts:view:*` scope this silently
 * returns records only. An empty result is never proof an item is absent.
 */
export async function searchItems(
  query: SearchQuery = {},
  options: SearchOptions = {},
): Promise<SearchResult> {
  assertPageable(query);
  const client = options.client ?? getApiClient();
  return client.get<SearchResult>("/search", {
    query: toQueryParams(query),
    signal: options.signal,
  });
}

/**
 * `GET /api/search/:id` — one item by backend id, or `null` when the backend
 * says 404.
 *
 * **`null` does not mean "deleted"** — see the module header. A 404 conflates CDC
 * lag, a visibility miss, an OpenSearch fault, and actual deletion. Callers
 * deciding an item's fate must go through the confirmation policy in
 * `domain/sync` — `nextMissStreak` (which only counts an *unambiguous* miss, and
 * refuses to count anything during a run `isRunSuspicious` flags) and then
 * `isOrphaned` / `isOrphanedStreak`. Never go straight from this `null` to a
 * destructive conclusion.
 */
export async function findById(
  id: string,
  options: SearchOptions = {},
): Promise<SearchHit | null> {
  const client = options.client ?? getApiClient();
  try {
    return await client.get<SearchHit>(`/search/${encodeURIComponent(id)}`, {
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof ApiError && err.kind === "not_found") return null;
    throw err;
  }
}

/**
 * `GET /api/search/:id/children` — the items whose `parent_relations` name
 * `:id`. Accepts the same filters/paging as {@link searchItems}.
 */
export async function searchChildren(
  parentId: string,
  query: SearchQuery = {},
  options: SearchOptions = {},
): Promise<SearchResult> {
  assertPageable(query);
  const client = options.client ?? getApiClient();
  return client.get<SearchResult>(
    `/search/${encodeURIComponent(parentId)}/children`,
    { query: toQueryParams(query), signal: options.signal },
  );
}

/**
 * `GET /api/search/suggest` — typeahead values for one allowlisted field. An
 * unknown field is a `400`, so pass a {@link SuggestQuery} `field` from
 * `SUGGEST_FIELDS`.
 */
export async function suggest(
  query: SuggestQuery,
  options: SearchOptions = {},
): Promise<SuggestResult> {
  const client = options.client ?? getApiClient();
  return client.get<SuggestResult>("/search/suggest", {
    query: {
      field: query.field,
      q: query.q,
      limit: query.limit,
      type: query.type,
    },
    signal: options.signal,
  });
}

/**
 * Walk every page of a query and return the flattened hits.
 *
 * Bounded twice on purpose: it stops at the deep-pagination window, and at
 * `maxHits` (default 1000) so a broad query cannot pull the whole catalogue into
 * memory. `truncated` tells the caller the result set was cut — a sync run
 * surfaces that as a warning rather than silently reporting a partial view as
 * complete.
 */
export async function searchAllPages(
  query: SearchQuery = {},
  options: SearchOptions & { maxHits?: number } = {},
): Promise<{ hits: SearchHit[]; total: number; truncated: boolean }> {
  const maxHits = options.maxHits ?? 1000;
  const limit = Math.min(query.limit ?? SEARCH_MAX_LIMIT, SEARCH_MAX_LIMIT);
  const hits: SearchHit[] = [];
  let page = query.page ?? 1;
  let total = 0;
  let truncated = false;

  for (;;) {
    if (isBeyondPaginationWindow(page, limit)) {
      truncated = true;
      break;
    }
    const result = await searchItems({ ...query, page, limit }, options);
    total = result.total;
    hits.push(...result.hits);

    if (hits.length >= maxHits) {
      truncated = hits.length < total;
      hits.length = maxHits;
      break;
    }
    // `pages` is derived from `total`, which `track_total_hits` makes exact.
    // Also stop on an empty page so a shrinking result set can't loop forever.
    if (page >= result.pages || result.hits.length === 0) break;
    page += 1;
  }

  return { hits, total, truncated };
}
