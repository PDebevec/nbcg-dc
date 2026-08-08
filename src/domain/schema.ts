/**
 * The backend-driven metadata schema (`GET /api/schema/record`).
 *
 * Shared vocabulary: the metadata form (composables/GUI) renders whatever these
 * describe, and the API client fetches them. Kept in `domain/` (framework-free,
 * no imports) so both lanes can consume it without crossing the service seam.
 *
 * Mirrors `nbcg/backend` `src/modules/schema/schema.types.ts`, verified
 * 2026-08-03. Important shape facts:
 *  - There is NO `label` field — human labels live only inside
 *    `allowedValues[].en` / `.cnr`.
 *  - There is NO `relevantForTypes` — the main/child distinction is the
 *    per-field `levels` array (+ the `?level=main|child` query filter).
 *  - `parentInheritable` / `issueIdentifying` flags already exist (the docs
 *    said they "need adding" — they do not).
 */

/** A resolved code + its bilingual labels. The ONLY source of human-readable
 * labels in the schema. `cnr` = Crnogorski (Montenegrin). */
export interface ResolvedCode {
  code: string;
  en: string;
  cnr: string;
}

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "date" // defined by the backend union but currently unused by any field
  | "enum"
  | "array"
  | "object";

/** Element type for `type: "array"` fields. */
export type FieldItemType = "string" | "enum" | "object";

/** Which record levels a field appears on. Also the values of `?level`. */
export type FieldLevel = "main" | "child";

/** One field definition from the record schema. Recursive via `objectShape`. */
export interface FieldDescriptor {
  /** Machine field name, e.g. `title`, `publication`, `authors`. */
  key: string;
  type: FieldType;
  required: boolean;
  /** Present only for `type: "array"` — the element type. */
  itemType?: FieldItemType;
  /** Enum options for `type: "enum"` or array-of-enum. */
  allowedValues?: ResolvedCode[];
  /** Nested fields for `type: "object"` / array-of-object. */
  objectShape?: FieldDescriptor[];
  /** UI section key (e.g. `basic`, `publication`, `title`). */
  group: string;
  /** Display order within the group (lower = earlier). */
  order: number;
  /** Whether a linked parent record can pass this field down to children. */
  parentInheritable: boolean;
  /** Whether the field identifies a specific issue and must be filled per
   * child even when a parent is linked (e.g. issue number, year). */
  issueIdentifying: boolean;
  /** Record levels this field appears on. */
  levels: FieldLevel[];
}

/** The `GET /api/schema/record` response envelope: `{ fields }`. */
export interface RecordSchema {
  fields: FieldDescriptor[];
}
