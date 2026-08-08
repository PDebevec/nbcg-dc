/**
 * Backend-mirrored enums and the scope catalogue.
 *
 * These mirror `nbcg/backend` (`generated/prisma/enums.ts`) verbatim — the
 * archive is a thick client of the same API, so its vocabulary must match the
 * source of truth exactly. Each is a `const` object (runtime values) plus a
 * derived union type (compile-time), so a single name serves both roles.
 *
 * Verified against the live backend on 2026-08-03 (see docs/tasks/09).
 */

/** `Draft`/`Record` visibility. Required on create. */
export const VisibilityStatus = {
  PUBLIC: "PUBLIC",
  PRIVATE: "PRIVATE",
  HIDDEN: "HIDDEN",
} as const;
export type VisibilityStatus =
  (typeof VisibilityStatus)[keyof typeof VisibilityStatus];

/**
 * Which table an item lives in. The backend has NO single `Item` model — it
 * splits into parallel `drafts` and `records` tables with identical columns.
 * `targetState` on create/transition is typed as this enum (there is no
 * separate `ItemState` enum in the backend, despite older doc wording).
 */
export const ItemType = {
  DRAFT: "DRAFT",
  RECORD: "RECORD",
} as const;
export type ItemType = (typeof ItemType)[keyof typeof ItemType];

/**
 * The operator-facing "Publish as" choice at upload maps 1:1 to `ItemType`
 * (`targetState`). Alias kept for readability in batch/upload code.
 */
export const PublishTarget = ItemType;
export type PublishTarget = ItemType;

/** Attachment role. NOTE: on upload the backend applies ONE role to the whole
 * multipart batch — it is not per-file. Uploading a THUMBNAIL + WEB mix means
 * TWO upload requests (see docs/tasks/07). */
export const FileRole = {
  SOURCE: "SOURCE",
  ARCHIVAL: "ARCHIVAL",
  WEB: "WEB",
  THUMBNAIL: "THUMBNAIL",
} as const;
export type FileRole = (typeof FileRole)[keyof typeof FileRole];

/** Derived server-side from the uploaded file's MIME type. */
export const FileType = {
  IMAGE: "IMAGE",
  PDF: "PDF",
  UNKNOWN: "UNKNOWN",
} as const;
export type FileType = (typeof FileType)[keyof typeof FileType];

/** Full-text extraction outcome on a file attachment. */
export const TextExtractionStatus = {
  NOT_EXTRACTED: "NOT_EXTRACTED",
  EXTRACTED: "EXTRACTED",
  GARBAGE: "GARBAGE",
  NO_TEXT: "NO_TEXT",
} as const;
export type TextExtractionStatus =
  (typeof TextExtractionStatus)[keyof typeof TextExtractionStatus];

/**
 * Keycloak client roles carried in the JWT (`resource_access[clientId].roles`)
 * that populate the backend `Principal.scopes`. These are bare string literals
 * scattered across the backend (NOT a backend enum), captured here so the
 * archive can reason about write-gating and the connection probe.
 *
 * The archive's static token needs the `*:manage` scopes to create/patch/upload
 * and `import:execute` for COBISS preview.
 */
export const Scope = {
  RecordsManage: "records:manage",
  DraftsManage: "drafts:manage",
  RecordsViewPrivate: "records:view:private",
  RecordsViewHidden: "records:view:hidden",
  DraftsViewPublic: "drafts:view:public",
  DraftsViewPrivate: "drafts:view:private",
  DraftsViewHidden: "drafts:view:hidden",
  ImportExecute: "import:execute",
} as const;
export type Scope = (typeof Scope)[keyof typeof Scope];
