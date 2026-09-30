/**
 * Parent-collections service (Epic 05) — search-backed lookup of candidate
 * **parent records** for linking.
 *
 * There is **no backend collections endpoint** (docs/PROJECT-KNOWLEDGE.md §4);
 * the parent picker is built on `GET /api/search`. Each hit's `collectionType`
 * (a NUMBER at `source.metadata.collectionType`) is carried through so the
 * caller can flag which parents are **data-passing-eligible**
 * (`domain/parent.isEligibleParent`, with the configured
 * `AppConfig.dataPassingCollectionTypes`).
 *
 * Search reads OpenSearch and is **CDC-lagged** — it lags writes. For "link by
 * id" that means a just-created parent may 404 briefly; trust write responses
 * over search (docs/02-architecture.md). This module only *reads* — eligibility
 * and the link/data-passing invariants live in `domain/parent`. The HTTP itself
 * is delegated to `services/api/search` (Epic 08), so the deep-pagination guard,
 * `limit` clamping, and 404 handling are shared with the general search paths;
 * what stays here is the parent-picker projection (`hitToParent`).
 *
 * Stays in Jernej's `.ts` lane (Seam 3, backend-only).
 */

import type { ApiClient } from "./client";
import type { SearchHit, SearchQuery, SearchType } from "./dto";
import type { RecordMetadata } from "@domain/metadata";
import type { ParentRecord } from "@domain/parent";
import { findById, hitToRemote, searchItems } from "./search";

export interface SearchParentsOptions {
  /** Client to use (defaults to the configured backend singleton). Injectable
   * for tests. */
  client?: ApiClient;
  signal?: AbortSignal;
  /** Which collections to search (defaults to `all`). */
  type?: SearchType;
  /** Page size (defaults to 20; backend caps at 100). */
  limit?: number;
  /** 1-based page number. */
  page?: number;
}

/** Read a record's metadata blob out of a search hit's `source`. */
function metadataOf(hit: SearchHit): RecordMetadata {
  const source = hit.source as { metadata?: unknown };
  const metadata = source.metadata;
  return metadata && typeof metadata === "object"
    ? (metadata as RecordMetadata)
    : {};
}

/** Map a search hit to a {@link ParentRecord}. `collectionType` is only used
 * when it is genuinely a number; a title falls back to the id. */
export function hitToParent(hit: SearchHit): ParentRecord {
  const metadata = metadataOf(hit);
  const collectionType =
    typeof metadata.collectionType === "number" ? metadata.collectionType : null;
  const title =
    typeof metadata.title === "string" && metadata.title.trim() !== ""
      ? metadata.title
      : hit.id;
  return { id: hit.id, title, collectionType, metadata };
}

/** Every collection type, including ones added later. */
const COLLECTIONS_ONLY = ">0";

/** Build the `/api/search` query for the parent picker: collections only, and
 * with nothing typed, the newest first (an empty `q` is dropped and lists all). */
function parentSearchQuery(
  query: string,
  options: SearchParentsOptions,
): SearchQuery {
  return {
    q: query,
    type: options.type ?? "all",
    limit: options.limit ?? 20,
    page: options.page,
    collectionType: COLLECTIONS_ONLY,
    sort: query.trim() === "" ? "newest" : undefined,
    // Keep the payload small but ensure `metadata` (→ collectionType/title) is
    // included; `id` is always added server-side.
    fields: "metadata",
  };
}

/**
 * Search backend records/drafts for collections to offer as parents; with
 * nothing typed, the newest ones. Returns domain {@link ParentRecord}s; the
 * caller applies eligibility with the configured data-passing set.
 * CDC-lagged (search lags writes).
 */
export async function searchParents(
  query: string,
  options: SearchParentsOptions = {},
): Promise<ParentRecord[]> {
  const result = await searchItems(parentSearchQuery(query, options), {
    client: options.client,
    signal: options.signal,
  });
  // A backend without the `collectionType` filter drops it silently and
  // returns every item, so keep only collections here too.
  return result.hits
    .map(hitToParent)
    .filter((p) => p.collectionType != null && p.collectionType > 0);
}

/**
 * Fetch a single record/draft as a parent candidate **by id** — the "link by
 * id" path. Uses `GET /api/search/:id`; returns `null` on a `404` (not
 * found/not visible, or CDC lag for a very fresh record). Other errors throw.
 */
export async function getParentById(
  id: string,
  options: SearchParentsOptions = {},
): Promise<ParentRecord | null> {
  const hit = await findById(id, {
    client: options.client,
    signal: options.signal,
  });
  return hit ? hitToParent(hit) : null;
}

/**
 * An item's own parent ids on the backend (`GET /api/search/:id` →
 * `parent_relations`), or `null` on a `404`. Used once per item whose mirror
 * predates recording them. pgsync writes `null` for an item with no parents,
 * which reads as `[]`.
 */
export async function getItemParentIds(
  backendId: string,
  options: SearchParentsOptions = {},
): Promise<string[] | null> {
  const hit = await findById(backendId, { client: options.client, signal: options.signal });
  return hit ? (hitToRemote(hit).parentIds ?? []) : null;
}
