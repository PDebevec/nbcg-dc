/**
 * Items service (Epic 07 create/patch · Epic 08 stats) — the `Draft`/`Record`
 * resource. The backend has no single `Item` model; `targetState` on create
 * decides which table (`DRAFT`/`RECORD`) the row lands in, and the manage scope
 * required follows from it (docs/PROJECT-KNOWLEDGE §4).
 *
 * Endpoints:
 *  - `POST /api/items` — create; returns the full entity (with the assigned
 *    `id` + `version: 0`). A `cobissId` in the metadata yields a deterministic
 *    id, so a re-create of the same COBISS record `409`s ("already exists").
 *  - `PATCH /api/items/:id` — optimistic-concurrency update: `expectedVersion`
 *    is REQUIRED, metadata is SHALLOW-merged (send only changed keys), and the
 *    response always carries `{ version }` — the new one on a real change, the
 *    unchanged one when there was nothing to write (it returned an empty body
 *    before the 2026-08-07 fix). `409` on version mismatch.
 *  - `POST /api/items/transition` — move ids between DRAFT/RECORD (needs BOTH
 *    manage scopes).
 *  - `DELETE /api/items` — hard delete (body-on-DELETE).
 *  - `GET /api/items/stats` — visibility counts (the only scoped GET).
 *
 * This service is deliberately thin (raw calls + typed {@link ApiError}); the
 * write-gating (`403`), create-collision (`409`), and validation-error mapping
 * are folded in by `services/upload.ts` / `domain/upload.ts`, so the policy lives
 * in one place. Stays in Jernej's `.ts` lane (Seam 3, backend-only).
 */

import type { ApiClient } from "./client";
import type {
  CreateItemDto,
  DeleteItemsDto,
  ItemEntity,
  ItemStats,
  TransitionItemsDto,
  TransitionResult,
  UpdateItemDto,
  UpdateItemResponse,
} from "./dto";
import { getApiClient } from "../backend";

export interface ItemsServiceOptions {
  /** Client to use (defaults to the configured backend singleton). Injectable
   * for tests. */
  client?: ApiClient;
  signal?: AbortSignal;
}

/**
 * Create a `Draft`/`Record` (`POST /api/items`). `metadata.title` must be a
 * non-empty string or the backend `400`s; the caller sends only schema-valid
 * fields. Returns the full entity — capture `.id` (and `.version`, which starts
 * at 0) for the write-through mirror.
 */
export async function createItem(
  dto: CreateItemDto,
  options: ItemsServiceOptions = {},
): Promise<ItemEntity> {
  const client = options.client ?? getApiClient();
  return client.post<ItemEntity>("/items", {
    json: dto,
    signal: options.signal,
  });
}

/**
 * Update a `Draft`/`Record` (`PATCH /api/items/:id`). `expectedVersion` is
 * required (409 on mismatch); metadata is shallow-merged, so pass ONLY the
 * changed keys.
 *
 * Always resolves to `{ version }` — the new version on a real change, the
 * unchanged one when the payload had nothing to write. Since the 2026-08-07
 * backend fix the version guard runs *before* that no-op check, so the returned
 * version is authoritative and a wrong `expectedVersion` is always a `409`
 * (it used to be a silent `200` + empty body — see {@link UpdateItemDto}).
 *
 * A `metadata` object whose keys are all unknown still sanitises to `{}` and
 * counts as "nothing to write" — no `400`. Validate keys against the schema
 * endpoint so a typo does not read as a successful no-change.
 */
export async function updateItem(
  id: string,
  dto: UpdateItemDto,
  options: ItemsServiceOptions = {},
): Promise<UpdateItemResponse> {
  const client = options.client ?? getApiClient();
  return client.patch<UpdateItemResponse>(`/items/${encodeURIComponent(id)}`, {
    json: dto,
    signal: options.signal,
  });
}

/**
 * Move items between DRAFT and RECORD (`POST /api/items/transition`). Requires
 * BOTH `records:manage` and `drafts:manage`.
 *
 * NOT idempotent, and it fails as a batch: any id already in `targetState`
 * throws `400 Items already in state …` and nothing in the call moves. Callers
 * that can be re-run must send only ids currently in the other collection.
 *
 * Returns each moved item's **post-move version** (since 2026-08-07), so a mirror
 * can be updated without a CDC-lagged re-read. The versions are read back rather
 * than computed, which matters for an item that is itself a parent — see
 * {@link TransitionItemsDto}.
 */
export function transitionItems(
  dto: TransitionItemsDto,
  options: ItemsServiceOptions = {},
): Promise<TransitionResult[]> {
  const client = options.client ?? getApiClient();
  return client.post<TransitionResult[]>("/items/transition", {
    json: dto,
    signal: options.signal,
  });
}

/**
 * Hard-delete items (`DELETE /api/items` — a body on DELETE). Manage checked per
 * collection touched. Empty response.
 */
export async function deleteItems(
  dto: DeleteItemsDto,
  options: ItemsServiceOptions = {},
): Promise<void> {
  const client = options.client ?? getApiClient();
  await client.delete<void>("/items", {
    json: dto,
    responseType: "void",
    signal: options.signal,
  });
}

/**
 * Visibility counts per collection (`GET /api/items/stats`). Requires
 * `records:view:hidden` + `drafts:view:hidden` — the only scoped GET, so it also
 * doubles as a token/scope probe when needed (Epic 08).
 */
export async function getItemStats(
  options: ItemsServiceOptions = {},
): Promise<ItemStats> {
  const client = options.client ?? getApiClient();
  return client.get<ItemStats>("/items/stats", { signal: options.signal });
}
