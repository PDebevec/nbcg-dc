/**
 * Schema-driven metadata form rules (Epic 04) — the pure logic behind the
 * Metadata tab's dynamic form, its validation, the item navigator's status, and
 * the schema-evolution field pruning done on upload.
 *
 * The backend {@link RecordSchema} (fetched by `services/api/schema`) is the only
 * source of fields. This module turns it into a renderable, ordered model and
 * validates values against it, so the form is generated entirely from the
 * schema — no hard-coded field list — and the same rules gate a batch from
 * advancing to processing.
 *
 * Framework-free (imports only sibling domain types): the GUI renders the model
 * these functions return; a composable/store binds the values. Values are held
 * as plain `Record<string, unknown>` maps (the wire shape); the provenance
 * overlay ({@link MetadataValues}, Epic 05) flattens to this via
 * {@link flattenValues}.
 */

import type {
  FieldDescriptor,
  FieldLevel,
  RecordSchema,
  ResolvedCode,
} from "./schema";
import type { MetadataValues, Provenance } from "./metadata";

// ─── the renderable form model (task 2) ──────────────────────────────────────

/** A group of fields the form renders together (schema `group` key). */
export interface FormGroupModel {
  /** The schema `group` value (e.g. `basic`, `publication`). */
  key: string;
  fields: FieldDescriptor[];
}

/** The schema shaped for one record level: a flat ordered field list plus the
 * same fields bucketed into ordered groups. */
export interface SchemaFormModel {
  level: FieldLevel;
  /** Level-filtered fields, sorted by `order` then `key`. */
  fields: FieldDescriptor[];
  /** The fields grouped by `group`, each group in earliest-field order. */
  groups: FormGroupModel[];
}

/** The fields that appear on a given record level. */
export function fieldsForLevel(
  schema: RecordSchema,
  level: FieldLevel,
): FieldDescriptor[] {
  return schema.fields.filter((f) => f.levels.includes(level));
}

/** Stable field ordering: by `order` ascending, ties broken by `key`. */
function compareFields(a: FieldDescriptor, b: FieldDescriptor): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Build the form model for a level. Fields are filtered to the level, globally
 * sorted, then bucketed into groups whose order follows their earliest field —
 * so both the flat list and the grouped layout agree on ordering.
 */
export function buildFormModel(
  schema: RecordSchema,
  level: FieldLevel,
): SchemaFormModel {
  const fields = fieldsForLevel(schema, level).slice().sort(compareFields);
  const byGroup = new Map<string, FieldDescriptor[]>();
  for (const field of fields) {
    const bucket = byGroup.get(field.group);
    if (bucket) bucket.push(field);
    else byGroup.set(field.group, [field]); // first-seen order = earliest `order`
  }
  const groups: FormGroupModel[] = Array.from(byGroup, ([key, groupFields]) => ({
    key,
    fields: groupFields,
  }));
  return { level, fields, groups };
}

// ─── value emptiness + labels ────────────────────────────────────────────────

/**
 * Whether a field value counts as "empty" for required-checks. Blank/whitespace
 * strings and empty arrays are empty; `false` and `0` are NOT (a filled boolean
 * / number is a value).
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Resolve an enum option's display label. The schema carries NO field labels —
 * bilingual text lives only on the option codes. Defaults to Montenegrin
 * (`cnr`) for the National Library, falling back to English then the raw code.
 */
export function optionLabel(
  code: ResolvedCode,
  lang: "cnr" | "en" = "cnr",
): string {
  const primary = lang === "en" ? code.en : code.cnr;
  return primary || code.en || code.cnr || code.code;
}

/**
 * A humanised fallback label for a field, derived from its `key` — the schema
 * has no per-field label, so the GUI needs either an i18n table or this default
 * (`publicationYear` / `publication_year` → `Publication year`).
 */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

// ─── validation (task 3) ─────────────────────────────────────────────────────

export type FieldErrorCode = "required" | "not_allowed" | "wrong_type";

/** One validation failure on a field. `message` is an English default; the GUI
 * may localise from `code` + the field. */
export interface FieldError {
  key: string;
  code: FieldErrorCode;
  message: string;
}

function allowedCodeSet(field: FieldDescriptor): Set<string> {
  return new Set((field.allowedValues ?? []).map((c) => c.code));
}

function fieldError(
  key: string,
  code: FieldErrorCode,
  message: string,
): FieldError {
  return { key, code, message };
}

/**
 * Validate one field's value against its descriptor. Returns `null` when valid.
 * Rules (task 3): required fields must be non-empty (a multi/array field needs
 * ≥1 element); enum values (single and array-of-enum) must be an allowed code;
 * arrays must be arrays; a numeric field rejects a non-numeric string. Optional
 * empty values pass.
 */
export function validateField(
  field: FieldDescriptor,
  value: unknown,
): FieldError | null {
  const empty = isEmptyValue(value);
  if (empty) {
    return field.required
      ? fieldError(field.key, "required", `${field.key} is required.`)
      : null;
  }

  if (field.type === "array") {
    if (!Array.isArray(value)) {
      return fieldError(field.key, "wrong_type", `${field.key} must be a list.`);
    }
    if (field.itemType === "enum") {
      const allowed = allowedCodeSet(field);
      if (allowed.size && !value.every((v) => allowed.has(String(v)))) {
        return fieldError(
          field.key,
          "not_allowed",
          `${field.key} has a value outside the allowed options.`,
        );
      }
    }
    return null;
  }

  if (field.type === "enum") {
    const allowed = allowedCodeSet(field);
    if (allowed.size && !allowed.has(String(value))) {
      return fieldError(
        field.key,
        "not_allowed",
        `${field.key} must be one of the allowed options.`,
      );
    }
    return null;
  }

  if (field.type === "number") {
    const numeric =
      typeof value === "number"
        ? Number.isFinite(value)
        : typeof value === "string"
          ? !Number.isNaN(Number(value.trim()))
          : false;
    if (!numeric) {
      return fieldError(field.key, "wrong_type", `${field.key} must be a number.`);
    }
  }

  return null;
}

/** Validate every field of a level against a plain value map. */
export function validateItem(
  fields: FieldDescriptor[],
  values: Record<string, unknown>,
): FieldError[] {
  const errors: FieldError[] = [];
  for (const field of fields) {
    const error = validateField(field, values[field.key]);
    if (error) errors.push(error);
  }
  return errors;
}

/** True when every field of the level validates (the item is uploadable). */
export function isItemValid(
  fields: FieldDescriptor[],
  values: Record<string, unknown>,
): boolean {
  return validateItem(fields, values).length === 0;
}

// ─── navigator status + gating (tasks 4 & 5) ─────────────────────────────────

/** Per-item status shown in the navigator (mirrors the prototype). */
export type ItemReadiness = "ready" | "incomplete" | "untouched";

/** True when none of the level's fields hold a value. */
export function allFieldsEmpty(
  fields: FieldDescriptor[],
  values: Record<string, unknown>,
): boolean {
  return fields.every((f) => isEmptyValue(values[f.key]));
}

/**
 * Derive an item's navigator status. `untouched` = nothing entered yet;
 * otherwise `ready` when all required/enum rules pass, else `incomplete`.
 *
 * `touched` defaults to "the item has any value" so a COBISS/parent prefill
 * reads as ready/incomplete rather than untouched; pass it explicitly to honour
 * a separate "operator has opened this item" signal.
 */
export function itemReadiness(
  fields: FieldDescriptor[],
  values: Record<string, unknown>,
  opts: { touched?: boolean } = {},
): ItemReadiness {
  const empty = allFieldsEmpty(fields, values);
  const touched = opts.touched ?? !empty;
  if (!touched && empty) return "untouched";
  return isItemValid(fields, values) ? "ready" : "incomplete";
}

/**
 * Index of the first item that is not `ready` (for the blocked "go to
 * processing" jump), or `-1` when every item is ready. Both `incomplete` and
 * `untouched` block advancement.
 */
export function firstIncompleteIndex(readinesses: ItemReadiness[]): number {
  return readinesses.findIndex((r) => r !== "ready");
}

/** Ready-vs-total counts for the per-batch progress bar ("3/5 ready"). */
export function readyProgress(readinesses: ItemReadiness[]): {
  ready: number;
  total: number;
} {
  return {
    ready: readinesses.filter((r) => r === "ready").length,
    total: readinesses.length,
  };
}

/** Whether a batch may advance to processing — every item ready. */
export function canAdvance(readinesses: ItemReadiness[]): boolean {
  return readinesses.length > 0 && readinesses.every((r) => r === "ready");
}

// ─── value adapters + schema-evolution pruning (tasks 9 & 12) ─────────────────

/** Flatten the provenance-tagged editor map to a plain value map for validation
 * / the wire. See {@link MetadataValues}. */
export function flattenValues(
  values: MetadataValues,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(values)) out[key] = field.value;
  return out;
}

/** Wrap plain values in the editor's provenance map (e.g. loading a COBISS
 * prefill as `cobiss`, a local/backend record as `user`). Keys not in `fields`,
 * when `fields` is given, are dropped. */
export function toMetadataValues(
  record: Record<string, unknown>,
  provenance: Provenance,
  fields?: FieldDescriptor[],
): MetadataValues {
  const known = fields ? new Set(fields.map((f) => f.key)) : null;
  const out: MetadataValues = {};
  for (const [key, value] of Object.entries(record)) {
    if (known && !known.has(key)) continue;
    out[key] = { value, provenance };
  }
  return out;
}

export interface PruneOptions {
  /** Drop empty values as well as unknown keys (default `true`). */
  dropEmpty?: boolean;
}

/**
 * Keep only the values whose key is in the current schema, dropping stale /
 * unknown fields rather than erroring (task 12 — schema-evolution robustness).
 * By default empty values are dropped too, so an upload sends only the fields
 * the operator actually filled (the backend shallow-merges what it receives).
 */
export function pruneToSchema(
  values: Record<string, unknown>,
  fields: FieldDescriptor[],
  options: PruneOptions = {},
): Record<string, unknown> {
  const dropEmpty = options.dropEmpty ?? true;
  const known = new Set(fields.map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!known.has(key)) continue;
    if (dropEmpty && isEmptyValue(value)) continue;
    out[key] = value;
  }
  return out;
}
