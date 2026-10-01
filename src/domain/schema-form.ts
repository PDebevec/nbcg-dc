/**
 * The schema v2 form model: how a field renders, in which order, with which
 * options, and which fields show. Pure; the composable turns this into views.
 */

import { isEmpty, type FieldState } from "./schemaRules";
import { labelText, type FieldV2, type RecordSchemaV2, type VocabularyValue } from "./schema";

/** How a field renders — the backend's `input`, refined by `multiple` and `type`. */
export type FieldKind =
  | "text"
  | "textarea"
  | "number"
  | "quantity"
  | "date"
  | "boolean"
  | "enum"
  | "multi-enum"
  | "multi"
  | "hint"
  | "multi-hint"
  | "vocab"
  | "multi-vocab"
  | "object"
  | "object-list";

export function fieldKind(field: FieldV2): FieldKind {
  switch (field.input) {
    case "textarea":
      return field.multiple ? "multi" : "textarea";
    case "number":
      return field.type === "quantity" ? "quantity" : "number";
    case "checkbox":
      return "boolean";
    case "date":
      return "date";
    case "select":
      return "enum";
    case "multiselect":
      return "multi-enum";
    case "autocomplete":
      if (field.type === "enum") return field.multiple ? "multi-vocab" : "vocab";
      return field.multiple ? "multi-hint" : "hint";
    case "object":
      return field.multiple ? "object-list" : "object";
    default:
      return field.multiple ? "multi" : "text";
  }
}

/** Top-level fields in form order: by group order, then field order, then key. */
export function orderedFields(schema: RecordSchemaV2): FieldV2[] {
  const groupOrder = new Map(schema.groups.map((g) => [g.key, g.order]));
  const rank = (f: FieldV2) => groupOrder.get(f.group) ?? Number.MAX_SAFE_INTEGER;
  return schema.fields
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A code's label in a vocabulary sent whole, as its select shows it; null
 * when the schema doesn't list it. */
export function codeLabel(
  schema: RecordSchemaV2 | null | undefined,
  vocabulary: string,
  code: string | number,
): string | null {
  const value = schema?.vocabularies[vocabulary]?.values?.find((v) => v.code === code);
  return value ? labelText(value) || null : null;
}

/** An enum field's inline code list (`[]` for a searched vocabulary). */
export function inlineOptions(schema: RecordSchemaV2, field: FieldV2): VocabularyValue[] {
  return field.values ? (schema.vocabularies[field.values.vocabulary]?.values ?? []) : [];
}

/** The fields to show, and the hidden ones that still hold a value ("Other fields"). */
export function splitByVisibility(
  fields: readonly FieldV2[],
  states: Record<string, FieldState>,
  values: Record<string, unknown>,
): { shown: FieldV2[]; other: FieldV2[] } {
  const shown: FieldV2[] = [];
  const other: FieldV2[] = [];
  for (const field of fields) {
    if (states[field.key]?.visible ?? field.visible) shown.push(field);
    else if (!isEmpty(values[field.key])) other.push(field);
  }
  return { shown, other };
}

/** The path the evaluator keys states by: `authors[1].role` → `authors.role`. */
export function statePathOf(path: string): string {
  return path.replace(/\[\d+\]/g, "");
}

/** The schema field a value path points at, or null. */
export function fieldAtPath(fields: readonly FieldV2[], path: string): FieldV2 | null {
  let level: readonly FieldV2[] = fields;
  let found: FieldV2 | null = null;
  for (const key of statePathOf(path).split(".")) {
    found = level.find((f) => f.key === key) ?? null;
    if (!found) return null;
    level = found.objectShape ?? [];
  }
  return found;
}
