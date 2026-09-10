/**
 * Files service (Epic 07 assets · Epic 07 re-upload) — attachments on a
 * `Draft`/`Record`.
 *
 * Endpoints (docs/PROJECT-KNOWLEDGE §4):
 *  - `POST /api/files/upload/:itemId` — multipart, file field **`files`** (≤10).
 *    `role` (ONE {@link FileRole} for the whole request — NOT per-file, so a
 *    THUMBNAIL + WEB mix is TWO calls), `doOCR` (default false — the archive
 *    supplies OCR), and `extractedTexts` (a per-file JSON map `filename → text`,
 *    so the backend attaches each text by name and skips Tika).
 *  - `PUT /api/files/:fileId` — **replace** one attachment in place (stable id);
 *    file field `file` (single), `extractedText` (singular).
 *  - `PUT /api/files/:fileId/text` — (re)set the full text without re-uploading
 *    the blob (empty string ⇒ null).
 *  - `POST /api/files/:fileId/extract` — force server-side (re)extraction (PDFs).
 *  - `GET /api/files/:itemId` — list (each `extractedText` OMITTED — can be MBs).
 *  - `DELETE /api/files/:fileId`.
 *
 * The service takes web {@link Blob}s (+ a filename), not disk paths — reading
 * bytes off disk is `services/upload.ts`'s job (via the native fs seam), keeping
 * this module a pure HTTP concern testable with in-memory blobs. Stays in
 * Jernej's `.ts` lane (Seam 3, backend-only).
 */

import type { ApiClient } from "./client";
import type {
  FileAttachment,
  ReextractDto,
  ReextractResult,
  ReplaceFileParts,
  SetTextDto,
  SetTextResult,
  UploadFilesParts,
} from "./dto";
import { getApiClient } from "../backend";

/** A file to upload: its bytes + the filename the backend should record. */
export interface UploadFile {
  blob: Blob;
  filename: string;
}

export interface FilesServiceOptions {
  /** Client to use (defaults to the configured backend singleton). Injectable
   * for tests. */
  client?: ApiClient;
  signal?: AbortSignal;
  /**
   * Override the deadline for this transfer. Leave unset: the default is
   * derived from the bytes being sent (see {@link transferTimeoutMs}), which
   * is almost always what you want.
   */
  timeoutMs?: number;
}

/**
 * Fixed allowance on top of the transfer itself: the connect, and the backend
 * receiving the blob, writing it, and replying.
 */
export const TRANSFER_BASE_TIMEOUT_MS = 60_000;

/**
 * The floor throughput a transfer is held to — 1 Mbit/s. Below this something
 * is genuinely wrong (a half-open connection, a stalled server) rather than
 * merely slow, which is the only thing a deadline should be catching.
 */
export const MIN_TRANSFER_BYTES_PER_SEC = 128 * 1024;

/**
 * How long a transfer of `bytes` is allowed to take.
 *
 * The {@link ApiClient} applies one flat 30 s deadline to every request, armed
 * before the fetch and never reset while bytes are flowing. That is right for
 * a JSON call and wrong for a file: the archive's derived web PDFs run to
 * 65–105 MB, which would need a sustained 18–28 Mbit/s just to beat the clock,
 * and a transfer moving along perfectly well was being aborted mid-flight.
 *
 * So the deadline scales with the payload. It is still a deadline — an
 * overnight batch must not hang forever on one dead socket — but one a
 * healthy transfer cannot trip.
 */
export function transferTimeoutMs(bytes: number): number {
  const seconds = Math.max(0, bytes) / MIN_TRANSFER_BYTES_PER_SEC;
  return TRANSFER_BASE_TIMEOUT_MS + Math.ceil(seconds * 1000);
}

/** Append a boolean part as the string the Nest `ParseBoolPipe`/transform reads. */
function appendBool(form: FormData, key: string, value: boolean | undefined): void {
  if (value !== undefined) form.append(key, value ? "true" : "false");
}

/**
 * Upload one or more attachments to an item (`POST /api/files/upload/:itemId`).
 * The single `role` applies to EVERY file in `files` — split a THUMBNAIL + WEB
 * mix into two calls (see `domain/upload.uploadGroups`). `extractedTexts` maps
 * each PDF filename to its OCR text so the backend stores it and skips Tika;
 * `doOCR` defaults to false. Returns the created {@link FileAttachment}s.
 *
 * Keys in `extractedTexts` must match the uploaded filename EXACTLY, and an
 * empty-string value does NOT skip Tika (it stores NO_TEXT *and* enqueues
 * extraction, which then overwrites it) — use {@link setFileText} for a
 * genuinely empty OCR result. See {@link UploadFilesParts}.
 */
export async function uploadFiles(
  itemId: string,
  files: UploadFile[],
  parts: UploadFilesParts = {},
  options: FilesServiceOptions = {},
): Promise<FileAttachment[]> {
  const client = options.client ?? getApiClient();
  const form = new FormData();
  let bytes = 0;
  for (const f of files) {
    form.append("files", f.blob, f.filename);
    bytes += f.blob.size;
  }
  if (parts.role) form.append("role", parts.role);
  appendBool(form, "doOCR", parts.doOCR);
  if (parts.extractedTexts && Object.keys(parts.extractedTexts).length > 0) {
    // A book's OCR text rides along in this same request and is not small —
    // count it, or the deadline understates what is on the wire.
    const texts = JSON.stringify(parts.extractedTexts);
    form.append("extractedTexts", texts);
    bytes += texts.length;
  }
  return client.post<FileAttachment[]>(
    `/files/upload/${encodeURIComponent(itemId)}`,
    {
      form,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? transferTimeoutMs(bytes),
    },
  );
}

/**
 * Replace an existing attachment's blob in place (`PUT /api/files/:fileId`) —
 * keeps the stable attachment id and `role` (docs/tasks/07 re-upload). Single
 * file field `file`; `extractedText` is singular here. `filename`, `mimeType`
 * and `fileType` are overwritten from the new blob.
 *
 * ⚠️ ALWAYS pass `extractedText` when replacing a PDF whose text the archive
 * owns. The backend has no "leave the text alone" branch: omitting it clears
 * `extractedText` to null, resets the status to `NOT_EXTRACTED` and enqueues
 * Tika — so a re-uploaded WEB PDF silently loses the archive's OCR. See
 * {@link ReplaceFileParts}.
 */
export async function replaceFile(
  fileId: string,
  file: UploadFile,
  parts: ReplaceFileParts = {},
  options: FilesServiceOptions = {},
): Promise<FileAttachment> {
  const client = options.client ?? getApiClient();
  const form = new FormData();
  form.append("file", file.blob, file.filename);
  let bytes = file.blob.size;
  appendBool(form, "doOCR", parts.doOCR);
  if (parts.extractedText !== undefined) {
    form.append("extractedText", parts.extractedText);
    bytes += parts.extractedText.length;
  }
  return client.put<FileAttachment>(`/files/${encodeURIComponent(fileId)}`, {
    form,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? transferTimeoutMs(bytes),
  });
}

/**
 * (Re)set an attachment's full text without re-uploading the blob
 * (`PUT /api/files/:fileId/text`) — the "only the OCR text changed" path
 * (docs/tasks/07). An empty string is stored as null.
 */
export async function setFileText(
  fileId: string,
  text: string,
  options: FilesServiceOptions = {},
): Promise<SetTextResult> {
  const client = options.client ?? getApiClient();
  const body: SetTextDto = { text };
  // A book's full text is megabytes of JSON, so this is a transfer too — the
  // recovery path for a mangled filename must not be the one call that still
  // dies on the flat deadline.
  return client.put<SetTextResult>(
    `/files/${encodeURIComponent(fileId)}/text`,
    {
      json: body,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? transferTimeoutMs(text.length),
    },
  );
}

/**
 * Force server-side (re)extraction of a PDF attachment
 * (`POST /api/files/:fileId/extract`). `doOCR` defaults to true on the backend
 * (this endpoint exists to force OCR). Enqueues a background job.
 */
export async function reextractFile(
  fileId: string,
  dto: ReextractDto = {},
  options: FilesServiceOptions = {},
): Promise<ReextractResult> {
  const client = options.client ?? getApiClient();
  return client.post<ReextractResult>(
    `/files/${encodeURIComponent(fileId)}/extract`,
    { json: dto, signal: options.signal },
  );
}

/**
 * List an item's attachments (`GET /api/files/:itemId`). NOTE: `extractedText`
 * is OMITTED from list responses (can be megabytes) — read it via download or
 * the item detail if needed. Used by the re-upload flow to match local files to
 * their existing attachment ids.
 */
export async function listFiles(
  itemId: string,
  options: FilesServiceOptions = {},
): Promise<FileAttachment[]> {
  const client = options.client ?? getApiClient();
  return client.get<FileAttachment[]>(
    `/files/${encodeURIComponent(itemId)}`,
    { signal: options.signal },
  );
}

/** Delete an attachment (`DELETE /api/files/:fileId`). Empty response. */
export async function deleteFile(
  fileId: string,
  options: FilesServiceOptions = {},
): Promise<void> {
  const client = options.client ?? getApiClient();
  await client.delete<void>(`/files/${encodeURIComponent(fileId)}`, {
    responseType: "void",
    signal: options.signal,
  });
}
