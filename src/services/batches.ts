/**
 * Batches service (Epic 03) — the application-layer bridge between the native
 * batch store (SQLite, owned by the Arch lane) and the domain {@link Batch}
 * model the batch stores/composables consume.
 *
 * Responsibilities:
 *  - map the raw {@link BatchDto} ↔ domain {@link Batch} (near-identity; the
 *    read path normalises: every member item gets a `proc` entry, and the
 *    collection fields default to empty);
 *  - expose list / create / update / archive.
 *
 * Non-Tauri fallback (a plain `vite` browser session — the GUI lane's dev mode):
 * the read path (`listBatches`) returns `[]` so the logic lane stays runnable
 * without Rust; the side-effecting paths throw {@link IpcUnavailableError}
 * there, because silently succeeding would hide a real failure (consistent with
 * `services/indexing`).
 */

import {
  ipc,
  isTauri,
  type BatchDto,
  type BatchCreateDto,
} from "@ipc/bindings";
import {
  newBatchFields,
  ItemRunStatus,
  type Batch,
  type CreateBatchInput,
  type NewBatchFields,
} from "@domain/batch";

/** Map one native batch row to a domain {@link Batch}, normalising the maps so
 * every member item has a `proc` entry (defaults to `idle`). */
export function toBatch(dto: BatchDto): Batch {
  const proc: Record<string, ItemRunStatus> = {};
  for (const id of dto.itemIds) {
    proc[id] = dto.proc?.[id] ?? ItemRunStatus.Idle;
  }
  return {
    id: dto.id,
    no: dto.no,
    createdAt: dto.createdAt,
    type: dto.type,
    itemIds: [...dto.itemIds],
    stage: dto.stage,
    running: dto.running,
    proc,
    cobissId: dto.cobissId ?? null,
    parents: dto.parents ?? [],
    publish: dto.publish,
    visibility: dto.visibility,
    overrides: dto.overrides ?? {},
    archivedAt: dto.archivedAt ?? null,
  };
}

/** Map a domain {@link Batch} to the wire DTO for `batch_update` (identity in
 * shape; explicit so a future DTO/domain divergence is caught here). */
export function toBatchDto(batch: Batch): BatchDto {
  return {
    id: batch.id,
    no: batch.no,
    createdAt: batch.createdAt,
    type: batch.type,
    itemIds: batch.itemIds,
    stage: batch.stage,
    running: batch.running,
    proc: batch.proc,
    cobissId: batch.cobissId,
    parents: batch.parents,
    publish: batch.publish,
    visibility: batch.visibility,
    overrides: batch.overrides,
    archivedAt: batch.archivedAt,
  };
}

/** The create fields as the wire DTO (identity in shape). */
function toCreateDto(fields: NewBatchFields): BatchCreateDto {
  return fields;
}

/** All batches tracked by the native store (empty outside Tauri). */
export async function listBatches(): Promise<Batch[]> {
  if (!isTauri()) return [];
  const dtos = await ipc.batch.list();
  return dtos.map(toBatch);
}

/**
 * Create a batch from a selection: builds the create payload (defaults applied
 * by {@link newBatchFields}), persists it, and returns the created batch. The
 * native side assigns `id`/`no`/`createdAt` and stamps `batchId` onto each
 * member item (→ In progress). Throws outside Tauri (side-effecting).
 */
export async function createBatch(input: CreateBatchInput): Promise<Batch> {
  const dto = await ipc.batch.create(toCreateDto(newBatchFields(input)));
  return toBatch(dto);
}

/** Persist a full batch (write-through). Throws outside Tauri. */
export async function updateBatch(batch: Batch): Promise<Batch> {
  const dto = await ipc.batch.update(toBatchDto(batch));
  return toBatch(dto);
}

/**
 * Archive an uploaded batch (releases its items → Uploaded). Triggered by the
 * upload flow in Epic 07. Throws outside Tauri.
 */
export async function archiveBatch(batchId: string): Promise<Batch> {
  const dto = await ipc.batch.archive(batchId);
  return toBatch(dto);
}
