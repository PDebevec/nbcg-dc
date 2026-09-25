/**
 * Metadata values under schema v2. The editor keeps every value in the shape
 * the backend stores, so what autosaves to metadata.json is what uploads: an
 * enum as the bare code or `{ code, en, cnr }` (`values.storeAs`), a quantity
 * as `{ value, unit }`, numbers as numbers.
 *
 * Values that come from elsewhere — a COBISS preview, a parent, a metadata.json
 * written by an older build — are normalised once on the way in
 * ({@link normalizeRecord}). An upload sends {@link pruneForUpload}'s result.
 *
 * Framework-free; imports only sibling domain modules.
 */

import { isEmpty, type FieldState, type Label } from "./schemaRules";
import type { FieldV2, RecordSchemaV2, VocabularyValue } from "./schema";

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inlineValues(schema: RecordSchemaV2, field: FieldV2): VocabularyValue[] {
  return field.values ? (schema.vocabularies[field.values.vocabulary]?.values ?? []) : [];
}

// ─── normalising what comes in ───────────────────────────────────────────────

function normalizeEnum(schema: RecordSchemaV2, field: FieldV2, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return value;
  const code = isPlainObject(value) && "code" in value ? value.code : value;
  // `collectionType` codes are numbers; an old file may hold "4".
  const match = inlineValues(schema, field).find(
    (v) => v.code === code || String(v.code) === String(code),
  );
  if (field.values?.storeAs === "code") return match ? match.code : code;
  if (isPlainObject(value) && "code" in value) return value;
  if (match) return { code: match.code, en: match.en, cnr: match.cnr };
  // An unknown code keeps a self-labelled stub, so nothing is silently lost.
  return typeof code === "string" ? { code, en: code, cnr: code } : value;
}

function toNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? value : n;
}

function normalizeOne(schema: RecordSchemaV2, field: FieldV2, value: unknown): unknown {
  switch (field.type) {
    case "enum":
      return normalizeEnum(schema, field, value);
    case "integer":
    case "number":
      return toNumber(value);
    case "object":
      return isPlainObject(value) ? normalizeObject(schema, field.objectShape ?? [], value) : value;
    default:
      return value;
  }
}

function normalizeObject(schema: RecordSchemaV2, shape: FieldV2[], value: Plain): Plain {
  const out: Plain = { ...value };
  for (const child of shape) {
    if (child.key in value) out[child.key] = normalizeValue(schema, child, value[child.key]);
  }
  return out;
}

/** One field's value in its stored shape. */
export function normalizeValue(schema: RecordSchemaV2, field: FieldV2, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (field.multiple && Array.isArray(value)) return value.map((v) => normalizeOne(schema, field, v));
  return normalizeOne(schema, field, value);
}

/** {@link normalizeValue} over a whole record; keys the schema does not know pass through. */
export function normalizeRecord(schema: RecordSchemaV2, record: Plain): Plain {
  const byKey = new Map(schema.fields.map((f) => [f.key, f]));
  const out: Plain = {};
  for (const [key, value] of Object.entries(record)) {
    const field = byKey.get(key);
    out[key] = field ? normalizeValue(schema, field, value) : value;
  }
  return out;
}

// ─── what the inputs produce ─────────────────────────────────────────────────

/** A number box's text → a number, `null` when blank, or the text itself when
 * it is not a number (the format check then flags it). */
export function numberFromText(text: string): number | string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? text : n;
}

/** A quantity box's text → `{ value, unit }` with the unit the rules chose.
 * `null` when blank, or when the field has no unit in this context. */
export function quantityFromText(text: string, state: Pick<FieldState, "unit">): unknown {
  const value = numberFromText(text);
  if (value === null || !state.unit) return null;
  return { value, unit: state.unit.code };
}

// ─── what goes out ───────────────────────────────────────────────────────────

/** Drop blank strings, `null`, and arrays/objects left empty after cleaning. */
function clean(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (Array.isArray(value)) {
    const items = value.map(clean).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (isPlainObject(value)) {
    const out: Plain = {};
    for (const [key, v] of Object.entries(value)) {
      const c = clean(v);
      if (c !== undefined) out[key] = c;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value;
}

/** What an upload sends: only fields the schema knows — hidden ones included,
 * a rule never deletes data — without blanks. */
export function pruneForUpload(schema: RecordSchemaV2, values: Plain): Plain {
  const known = new Set(schema.fields.map((f) => f.key));
  const out: Plain = {};
  for (const [key, value] of Object.entries(values)) {
    if (!known.has(key)) continue;
    const c = clean(value);
    if (c !== undefined) out[key] = c;
  }
  return out;
}

// ─── format ──────────────────────────────────────────────────────────────────

const PARTIAL_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

/** A date the backend accepts: `YYYY`, `YYYY-MM`, or a real `YYYY-MM-DD`. */
export function isPartialDate(value: unknown): boolean {
  if (typeof value !== "string" || !PARTIAL_DATE.test(value)) return false;
  return value.length < 10 || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** A value the backend's shape check would refuse. */
export interface FormatError {
  path: string;
  label: Label;
  constraint: "format";
  hint: Label;
}

const FORMAT_HINTS: Partial<Record<FieldV2["type"], Label>> = {
  integer: { en: "A whole number", cnr: "Cijeli broj" },
  number: { en: "A number", cnr: "Broj" },
  quantity: { en: "A whole number, 0 or more", cnr: "Cijeli broj, 0 ili više" },
  date: { en: "YYYY, YYYY-MM or YYYY-MM-DD", cnr: "GGGG, GGGG-MM ili GGGG-MM-DD" },
};

function formatOk(field: FieldV2, value: unknown): boolean {
  switch (field.type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "quantity": {
      const n = isPlainObject(value) ? value.value : undefined;
      return typeof n === "number" && Number.isInteger(n) && n >= 0;
    }
    case "date":
      return isPartialDate(value);
    default:
      return true;
  }
}

/**
 * Values in a shape the backend would refuse — a word in a number box, a date
 * it cannot read. The rules' own check (`checkMetadata`) does not look at
 * types; the backend's shape validator does, on every field that has a value,
 * hidden or not.
 */
export function formatErrors(schema: RecordSchemaV2, values: Plain): FormatError[] {
  const out: FormatError[] = [];
  const walk = (fields: FieldV2[], value: Plain, prefix: string): void => {
    for (const field of fields) {
      const v = value[field.key];
      if (isEmpty(v)) continue;
      const path = prefix + field.key;
      const each: Array<[unknown, string]> =
        field.multiple && Array.isArray(v) ? v.map((el, i) => [el, `${path}[${i}]`]) : [[v, path]];
      for (const [el, at] of each) {
        if (field.type === "object") {
          if (isPlainObject(el)) walk(field.objectShape ?? [], el, `${at}.`);
          continue;
        }
        const hint = FORMAT_HINTS[field.type];
        if (hint && !formatOk(field, el)) out.push({ path: at, label: field.label, constraint: "format", hint });
      }
    }
  };
  walk(schema.fields, pruneForUpload(schema, values), "");
  return out;
}

// ─── new items ───────────────────────────────────────────────────────────────

/** A new item's starting values: every field with a `default`. */
export function defaultValues(schema: RecordSchemaV2): Plain {
  const out: Plain = {};
  for (const field of schema.fields) {
    if (field.default !== null && field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

/** True when nothing but blanks and defaults has been entered. */
export function isUntouched(schema: RecordSchemaV2, values: Plain): boolean {
  const defaults = new Map(schema.fields.map((f) => [f.key, f.default]));
  return Object.entries(values).every(([key, v]) => {
    const d = defaults.get(key);
    return isEmpty(v) || (d !== null && d !== undefined && v === d);
  });
}

// ─── paths (`authors[1].role`) ───────────────────────────────────────────────

/** The top-level key of a path: `authors[1].role` → `authors`. */
export function topKey(path: string): string {
  return path.split(/[.[]/, 1)[0];
}

function pathTokens(rest: string): Array<string | number> {
  return Array.from(rest.matchAll(/\.([^.[\]]+)|\[(\d+)\]/g), (m) =>
    m[2] !== undefined ? Number(m[2]) : m[1],
  );
}

/** A copy of `root` with `value` at `rest` (relative to root: `.place`,
 * `[1].role`). Missing objects and arrays are created. */
export function setAtPath(root: unknown, rest: string, value: unknown): unknown {
  const tokens = pathTokens(rest);
  const put = (node: unknown, i: number): unknown => {
    if (i === tokens.length) return value;
    const token = tokens[i];
    if (typeof token === "number") {
      const arr = Array.isArray(node) ? [...node] : [];
      arr[token] = put(arr[token], i + 1);
      return arr;
    }
    const obj: Plain = isPlainObject(node) ? { ...node } : {};
    obj[token] = put(obj[token], i + 1);
    return obj;
  };
  return put(root, 0);
}

/** The value at `rest` inside `root`, or undefined. */
export function getAtPath(root: unknown, rest: string): unknown {
  let node = root;
  for (const token of pathTokens(rest)) {
    if (typeof token === "number") node = Array.isArray(node) ? node[token] : undefined;
    else node = isPlainObject(node) ? node[token] : undefined;
  }
  return node;
}
