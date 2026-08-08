/**
 * Relations service (Epic 05 links · shared with Epic 07 upload) — connect /
 * disconnect the directed parent→child graph.
 *
 * Endpoints: `POST /api/relations/connect` (`201`) and `.../disconnect` (`200` —
 * changed from `204` on 2026-08-07), both taking `{ parentId, childIds[] }` (a
 * SINGLE parent, an array of children) and returning a
 * {@link RelationWriteResult} — the parent's state after the write. connect is
 * idempotent, cycle-guarded, and rejects a self-reference; disconnect is an
 * unchecked directional edge delete. Manage is checked on the **parent's**
 * collection only (docs/PROJECT-KNOWLEDGE.md §4).
 *
 * TIMING (write-through model): both parent and child must already exist on the
 * backend, so a child item that has not been uploaded yet cannot be connected.
 * Epic 05 records the parent links as **local intent** on the batch/item and the
 * *data-passing* (field copy) happens at describe time from the parent metadata;
 * the actual `connect` call fires at **upload** (Epic 07), after the child gets
 * its `backendId`. This thin service is the shared primitive both use.
 *
 * Stays in Jernej's `.ts` lane (Seam 3, backend-only).
 */

import type { ApiClient } from "./client";
import type { ModifyRelationsDto, RelationWriteResult } from "./dto";
import { getApiClient } from "../backend";

export interface RelationsServiceOptions {
  /** Client to use (defaults to the configured backend singleton). Injectable
   * for tests. */
  client?: ApiClient;
  signal?: AbortSignal;
}

/**
 * Link children under a parent (`POST /api/relations/connect`). Idempotent and
 * cycle-guarded server-side; needs the parent collection's `*:manage` scope.
 * `childIds` must be non-empty.
 *
 * A DB trigger bumps the parent's `version` (once per newly-created edge) and
 * rewrites its `childrenInDrafts`/`childrenInRecords` metadata. The returned
 * {@link RelationWriteResult} carries the resulting version, so a caller holding a
 * mirror of that parent can refresh it instead of `409`ing on the parent's next
 * `PATCH`. See {@link ModifyRelationsDto}.
 */
export function connectRelations(
  dto: ModifyRelationsDto,
  options: RelationsServiceOptions = {},
): Promise<RelationWriteResult> {
  const client = options.client ?? getApiClient();
  return client.post<RelationWriteResult>("/relations/connect", {
    json: dto,
    signal: options.signal,
  });
}

/** Convenience: link one child under one parent. */
export function connectParent(
  parentId: string,
  childId: string,
  options?: RelationsServiceOptions,
): Promise<RelationWriteResult> {
  return connectRelations({ parentId, childIds: [childId] }, options);
}

/**
 * Remove parent→child edges (`POST /api/relations/disconnect`). Unchecked
 * directional delete. Returns the parent's post-write state, like connect —
 * note this endpoint is **`200`**, not `204`, precisely so it can carry that body.
 */
export function disconnectRelations(
  dto: ModifyRelationsDto,
  options: RelationsServiceOptions = {},
): Promise<RelationWriteResult> {
  const client = options.client ?? getApiClient();
  return client.post<RelationWriteResult>("/relations/disconnect", {
    json: dto,
    signal: options.signal,
  });
}
