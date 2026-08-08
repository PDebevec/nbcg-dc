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
  for (const f of files) form.append("files", f.blob, f.filename);
  if (parts.role) form.append("role", parts.role);
  appendBool(form, "doOCR", parts.doOCR);
  if (parts.extractedTexts && Object.keys(parts.extractedTexts).length > 0) {
    form.append("extractedTexts", JSON.stringify(parts.extractedTexts));
  }
  return client.post<FileAttachment[]>(
    `/files/upload/${encodeURIComponent(itemId)}`,
    { form, signal: options.signal },
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
  appendBool(form, "doOCR", parts.doOCR);
  if (parts.extractedText !== undefined) {
    form.append("extractedText", parts.extractedText);
  }
  return client.put<FileAttachment>(`/files/${encodeURIComponent(fileId)}`, {
    form,
    signal: options.signal,
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
  return client.put<SetTextResult>(
    `/files/${encodeURIComponent(fileId)}/text`,
    { json: body, signal: options.signal },
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
