/**
 * The backend-driven metadata schema — v1 (`GET /api/schema/record`, removed
 * in Task 17 of the schema v2 plan) and v2 (`GET /api/schema/v2/record`).
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
import type { Constraints, Label, Rule, RuleField, Unit } from "./schemaRules";

export type { Constraints, Label, Rule, Unit } from "./schemaRules";

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

// ─── schema v2 — GET /api/schema/v2/record ───────────────────────────────────
//
// Contract: nbcg docs/shared/plans/metadata-schema-v2.md. One schema for every
// item; which fields show and which are required come from the rules, run by
// the vendored evaluator in ./schemaRules.ts.

/** The languages every {@link Label} carries. */
export type Lang = "en" | "cnr";

/** The language field captions and code-list labels are shown in. */
export const LABEL_LANGUAGE: Lang = "cnr";

/** What a field stores. */
export type FieldTypeV2 =
  | "string"
  | "text"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | "quantity"
  | "object";

/** How a field is rendered — decided by the backend. */
export const FIELD_INPUTS = [
  "text",
  "textarea",
  "number",
  "checkbox",
  "date",
  "select",
  "multiselect",
  "autocomplete",
  "object",
] as const;
export type FieldInput = (typeof FIELD_INPUTS)[number];

/** An enum field's vocabulary, and how a picked value is stored. */
export interface FieldValues {
  vocabulary: string;
  /** `resolvedCode` → `{ code, en, cnr }`; `code` → the bare code. */
  storeAs: "resolvedCode" | "code";
}

/** Typeahead from existing data. */
export interface FieldSuggest {
  /** Relative to the API base, with its own query (`/search/suggest?field=…&limit=5`). */
  path: string;
  queryParam: string;
  minChars: number;
  /** true = only a picked hint is accepted. */
  strict: boolean;
}

/** One field of the v2 schema. Recursive through `objectShape`. */
export interface FieldV2 extends RuleField {
  label: Label;
  help: Label | null;
  group: string;
  order: number;
  type: FieldTypeV2;
  input: FieldInput;
  values: FieldValues | null;
  suggest: FieldSuggest | null;
  /** The value a new item starts with (`collectionType` → 0), null for none. */
  default: string | number | boolean | null;
  unit: Unit | null;
  constraints: Constraints | null;
  rules: Rule[];
  objectShape: FieldV2[] | null;
  parentInheritable: boolean;
  issueIdentifying: boolean;
}

/** A code-list value. `collectionType` codes are numbers, the rest strings. */
export interface VocabularyValue {
  code: string | number;
  en: string;
  cnr: string;
}

export interface VocabularySearch {
  path: string;
  queryParam: string;
  minChars: number;
}

/** A closed list: sent whole (`values`) up to `inlineVocabularyMax`, searched (`search`) above. */
export interface Vocabulary {
  size: number;
  values?: VocabularyValue[];
  search?: VocabularySearch;
}

export interface SchemaGroup {
  key: string;
  order: number;
  label: Label;
}

/** A value the rules may read (informational — the evaluator knows them). */
export interface ContextKeyV2 {
  key: string;
  type: string;
  source: "item" | "parent";
  path?: string;
  fallback?: string;
  default?: unknown;
  description?: string;
}

/** The `GET /api/schema/v2/record` response. */
export interface RecordSchemaV2 {
  schemaVersion: number;
  languages: Lang[];
  inlineVocabularyMax: number;
  context: ContextKeyV2[];
  vocabularies: Record<string, Vocabulary>;
  groups: SchemaGroup[];
  fields: FieldV2[];
}

/** A label in {@link LABEL_LANGUAGE}, falling back to the other language. */
export function labelText(label: Label | null | undefined, lang: Lang = LABEL_LANGUAGE): string {
  if (!label) return "";
  return label[lang] || label.en || label.cnr || "";
}
