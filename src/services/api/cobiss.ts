/**
 * COBISS preview service (Epic 05) — the synchronous, no-persist prefill lookup.
 *
 * Endpoint: `GET /api/import/cobiss/preview/:cobissId` (requires the
 * `import:execute` scope). Returns the deterministic id a create *would* use,
 * whether it already exists, and the raw `DomainRecord` metadata — so the editor
 * can prefill the form **without** creating a draft, and can detect an
 * already-imported record *before* creating (docs/tasks/05; verified contract in
 * docs/PROJECT-KNOWLEDGE.md §4).
 *
 * ERROR SEMANTICS (important): a genuinely-absent record and an
 * unreachable/timed-out COBISS upstream **both** surface as a single `404` —
 * they are indistinguishable to the client. There is no "multiple records"
 * error (the first match wins). {@link fetchCobissPreview} folds this into a
 * discriminated {@link CobissPreviewOutcome} the UI can branch on without
 * touching {@link ApiError}.
 *
 * Stays in Jernej's `.ts` lane (Seam 3, backend-only).
 */

import type { ApiClient } from "./client";
import { ApiError } from "./client";
import type { CobissPreview } from "./dto";
import type { ItemType } from "@domain/enums";
import { getApiClient } from "../backend";

export interface CobissServiceOptions {
  /** Client to use (defaults to the configured backend singleton). Injectable
   * for tests. */
  client?: ApiClient;
  signal?: AbortSignal;
}

/**
 * Request timeout for a COBISS preview — deliberately longer than the client
 * default.
 *
 * The backend fetches `ws.cobiss.net` with its own `AbortSignal.timeout(30_000)`
 * (`cobiss-util/cobiss-fetch.ts`), so a preview can legitimately block for a
 * full 30 s before the backend has any answer to give. The archive's default
 * timeout is *also* 30 s and its clock starts earlier — so on a slow-but-working
 * COBISS the archive aborted first, every time, and reported the timeout as
 * "Backend unreachable — check your connection", sending the operator hunting
 * for a network fault that does not exist.
 *
 * This must stay **above** the backend's 30 s budget plus its response overhead.
 * If `FETCH_TIMEOUT_MS` changes backend-side, change this with it.
 */
export const COBISS_PREVIEW_TIMEOUT_MS = 45_000;

/**
 * Raw preview call — resolves to the {@link CobissPreview} or throws
 * {@link ApiError}. Prefer {@link fetchCobissPreview} in UI code, which maps the
 * error kinds to a friendly outcome.
 */
export async function previewCobiss(
  cobissId: string,
  options: CobissServiceOptions = {},
): Promise<CobissPreview> {
  const client = options.client ?? getApiClient();
  const id = encodeURIComponent(cobissId.trim());
  return client.get<CobissPreview>(`/import/cobiss/preview/${id}`, {
    signal: options.signal,
    timeoutMs: COBISS_PREVIEW_TIMEOUT_MS,
  });
}

/** A branchable result for the per-item "Get data" action. */
export type CobissPreviewOutcome =
  | { status: "found"; preview: CobissPreview }
  /** `404` — the record was not found **or** the COBISS upstream is
   * unreachable/timed out (the backend conflates the two). */
  | { status: "not-found"; message: string }
  /** `401`/`403` — the static token lacks `import:execute`. */
  | { status: "forbidden"; message: string }
  /** Transport failure — the backend host itself is unreachable. */
  | { status: "offline"; message: string }
  /** Any other failure (bad request, 5xx, …). */
  | { status: "error"; message: string };

/**
 * Fetch a COBISS preview and fold failures into a {@link CobissPreviewOutcome}.
 * Never throws — the caller switches on `status`.
 */
export async function fetchCobissPreview(
  cobissId: string,
  options: CobissServiceOptions = {},
): Promise<CobissPreviewOutcome> {
  if (cobissId.trim() === "") {
    return { status: "error", message: "Enter a COBISS ID." };
  }
  try {
    const preview = await previewCobiss(cobissId, options);
    return { status: "found", preview };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.isNetworkError) {
        return {
          status: "offline",
          message: "Backend unreachable — check your connection and try again.",
        };
      }
      switch (err.kind) {
        case "not_found":
          return {
            status: "not-found",
            message:
              "No COBISS record found for that ID (or COBISS is temporarily unreachable).",
          };
        case "unauthorized":
        case "forbidden":
          return {
            status: "forbidden",
            message: "This token is not allowed to import from COBISS.",
          };
        default:
          return { status: "error", message: err.message };
      }
    }
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The "already imported?" facts a preview carries (deterministic id +
 * existence), extracted for the create-collision guard. */
export interface CobissCollision {
  /** The deterministic backend id a create would use. */
  itemId: string;
  alreadyExists: boolean;
  /** Which collection it already exists in, or `null`. */
  existsAs: ItemType | null;
}

/** Pull the collision facts out of a preview. Because COBISS ids yield a
 * deterministic backend id, `alreadyExists` tells you a create would collide
 * (409) before you attempt it. */
export function cobissCollision(preview: CobissPreview): CobissCollision {
  return {
    itemId: preview.itemId,
    alreadyExists: preview.alreadyExists,
    existsAs: preview.existsAs,
  };
}

/** A human "already imported as a Draft/Record" note, or `null` when importing
 * would not collide. */
export function cobissCollisionMessage(preview: CobissPreview): string | null {
  if (!preview.alreadyExists) return null;
  const as = preview.existsAs === "RECORD" ? "record" : "draft";
  return `Already imported as a ${as}.`;
}
