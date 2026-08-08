/**
 * Metadata value vocabulary — provenance + the record metadata JSON blob.
 *
 * Two shapes matter:
 *  - The archive's editor working model, where every field value remembers
 *    where it came from (`MetadataFieldValue`) so the UI can tag it and resolve
 *    conflicts (see docs/tasks/05).
 *  - The wire shape (`RecordMetadata`) — the flat `metadata` JSON stored on a
 *    `Draft`/`Record`. The backend shallow-merges only the keys it is sent, so
 *    the archive must send ONLY changed fields on PATCH.
 */

/** Where a field's current value came from. Drives coloured tags, the per-field
 * source picker, and the overwrite prompt. */
export type Provenance = "cobiss" | "parent" | "user";

/** Display labels for the provenance tags (docs/tasks/04 §Provenance display).
 * `user` reads as "Edited" — an operator-set value overrides its origin. */
export const PROVENANCE_LABELS: Record<Provenance, string> = {
  cobiss: "COBISS",
  parent: "From parent",
  user: "Edited",
};

/** One field's value in the editor, with its provenance. */
export interface MetadataFieldValue<T = unknown> {
  value: T;
  provenance: Provenance;
  /** When `provenance === "parent"`, which linked parent supplied it. */
  sourceParentId?: string | null;
}

/** The editor's per-field working map (keyed by `FieldDescriptor.key`). */
export type MetadataValues = Record<string, MetadataFieldValue>;

/**
 * The non-COMARC metadata fields — the ones the backend's `BaseMetadata` defines
 * rather than the COBISS schema. They split into two groups, and the split
 * matters on write (verified against `items.service.create` /
 * `core/types/metadata.types.ts`, 2026-08-07):
 *
 * **Writable** — `title` and `collectionType` are the only two keys in
 * `EDITABLE_BASE_METADATA_SHAPE`, so they survive sanitisation on create and
 * PATCH. `title` must be a non-empty string on create or the backend 400s;
 * `collectionType` defaults to `0` when not sent.
 *
 * **Server-owned** — `_source`, `childrenInDrafts`, `childrenInRecords` and
 * `jeGlavnoGradivo` are applied *after* the client metadata on create and are
 * dropped by the sanitiser on PATCH. The archive can never write them; they only
 * arrive on read. (`_source` is `"cobiss"` when a `cobissId` is present, else
 * `"nbcg"`; the two child counts are maintained by a DB trigger on
 * `item_relations`.)
 */
export interface SystemMetadata {
  /** Writable. Required non-empty on create. */
  title: string;
  /** Writable. A NUMBER inside the metadata JSON — not a Prisma column, not an
   * enum. Drives parent "data-passing" eligibility (see domain/parent,
   * docs/tasks/05). Defaults to `0` server-side when omitted on create. */
  collectionType: number;
  /** Server-owned — maintained by the `item_relations` children-count trigger. */
  childrenInDrafts: number;
  /** Server-owned — maintained by the `item_relations` children-count trigger. */
  childrenInRecords: number;
  /**
   * Server-owned, and a dead CONSTANT: every create path hardcodes `true`
   * (`items.service.create`, `import-queue.processor`), the sanitiser drops it
   * on PATCH, no trigger ever clears it, and the website never reads it either.
   * There is **no way to mark an item as non-main through the API** — and no
   * need to: the archive's main-vs-child concept is local
   * ({@link ItemLevel} in `domain/item.ts`, which drives
   * `domain/metadata-form.fieldsForLevel` and `domain/provenance`). Do not build
   * child/issue logic on this flag. See docs/tasks/09 → Backend gaps.
   */
  jeGlavnoGradivo: boolean;
  /** Server-owned — derived from the presence of `cobissId` on create. */
  _source: "cobiss" | "nbcg";
}

/**
 * The `metadata` JSON as read back from a `Draft`/`Record`. System fields are
 * present; the remaining keys are schema-driven domain fields (dynamic), so we
 * keep an open index signature rather than enumerating every COMARC field here.
 */
export type RecordMetadata = Partial<SystemMetadata> & {
  [key: string]: unknown;
};

/**
 * The flat metadata object the archive SENDS on create/patch — user + domain
 * fields only. The backend sanitises unknown keys and re-injects system fields,
 * so callers pass just the fields they mean to write.
 */
export type RecordMetadataInput = Record<string, unknown>;

/**
 * The per-folder `metadata.json` mirror (Epic 02 / write-through in 07 & 08).
 *
 * Each item folder holds one of these so it is **self-describing** — enough to
 * rebuild the SQLite index if it is lost (the `backendId` + the presence of
 * derived files; see docs/02-architecture.md). It is written from the backend
 * response on create/update/sync — never uploaded itself. Before an item's
 * first upload there is no backend record, so `backendId`/`version` are null and
 * the `metadata` here is the working source of truth.
 */
export interface LocalMetadataFile {
  /** Connected backend `Draft`/`Record` id, or null before first upload. */
  backendId: string | null;
  /** Backend optimistic-concurrency `version` at last write, or null. */
  version: number | null;
  /** Draft vs Record, once published (mirrors `ItemType`). */
  targetState?: "DRAFT" | "RECORD" | null;
  /** Visibility, once published (mirrors `VisibilityStatus`). */
  visibilityStatus?: "PUBLIC" | "PRIVATE" | "HIDDEN" | null;
  /** The record metadata blob (mirror of the backend `metadata`). */
  metadata: RecordMetadata;
  /** ISO timestamp this mirror was last written from the backend. */
  syncedAt: string;
}
