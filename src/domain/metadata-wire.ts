/**
 * Wire ↔ form value adapters for schema-driven metadata (Epic 04).
 *
 * The backend stores **enum** values as {@link ResolvedCode} objects
 * (`{ code, en, cnr }`) and enum arrays as `ResolvedCode[]` — verified against
 * the live `DomainRecord` shape (`recordType`, `language[]`, `authors[].role`)
 * and the website's own admin editor, which writes `ResolvedCode[]` for
 * `language`. The editor, on the other hand, works in **bare codes**: the
 * `<select>` options are codes, and `domain/metadata-form.validateField` checks
 * an enum value against `allowedValues[].code`.
 *
 * These two pure functions convert between the shapes, recursing through
 * `objectShape` for object / array-of-object fields, so the form never sees a
 * `ResolvedCode` and the wire never sees a bare code:
 *
 *  - {@link toFormValue}  wire → form  (`{code:"cnr",…}` → `"cnr"`)
 *  - {@link toWireValue}  form → wire  (`"cnr"` → `{code:"cnr", en:…, cnr:…}`)
 *
 * **That rule has two exceptions**, and they are not visible in the schema —
 * see {@link BARE_CODE_ENUM_KEYS}. `authors[].responsibility` and
 * `corporateBodies[].responsibility` are declared as ordinary enums by
 * `GET /api/schema/record`, but the backend's write validator wants the bare
 * code string for those two and a `ResolvedCode` for the other twelve.
 *
 * `number` fields are coerced on the way out (`"3"` → `3`), because the backend's
 * `collectionType` validator is `typeof v === "number"`; an unparsable string is
 * left alone for the validator to flag.
 *
 * Framework-free — imports only sibling domain types.
 */

import type { FieldDescriptor, ResolvedCode } from "./schema";

function isResolvedCode(value: unknown): value is ResolvedCode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ResolvedCode).code === "string"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A wire enum value → its bare code (already-bare strings pass through). */
function codeOf(value: unknown): unknown {
  if (isResolvedCode(value)) return value.code;
  return value;
}

/**
 * Enum fields the backend validates as a **bare code string**, not a
 * {@link ResolvedCode} — the exceptions to this module's general rule.
 *
 * The schema endpoint describes these identically to every other enum
 * (`type: "enum"` with `allowedValues`), so there is nothing in the schema
 * that distinguishes them; the difference lives only in the backend's write
 * validator, `DOMAIN_RECORD_SHAPE` in
 * `nbcg/backend/src/modules/import/cobiss/cobiss-util/cobiss.types.ts`:
 *
 * ```ts
 * const authorValidator = sanitizeObj({
 *   role:           resolvedCode,   // { code, en, cnr }
 *   responsibility,                 // 'primary' | 'alternative' | 'secondary'
 * });
 * ```
 *
 * Verified 2026-09-20 against the running backend: of the 14 enum fields the
 * schema declares, 12 want a `ResolvedCode` and exactly these two want a bare
 * string — `authors[].responsibility` and `corporateBodies[].responsibility`.
 * Both are nested object children, so matching on the child key is
 * unambiguous: the three top-level fields whose names contain
 * "responsibility" (`firstResponsibility`, `subsequentResponsibility`,
 * `seriesResponsibility`) are all plain strings, never enums.
 *
 * Sending the expanded object here fails the upload with
 * `[0]: expected "primary" | "alternative" | "secondary"`.
 */
const BARE_CODE_ENUM_KEYS: ReadonlySet<string> = new Set(["responsibility"]);

/** A bare code → the schema's `ResolvedCode` (unknown codes get a self-labelled
 * stub so the value is never silently dropped). */
function resolveCode(field: FieldDescriptor, value: unknown): unknown {
  if (isResolvedCode(value)) return value;
  if (typeof value !== "string" || value === "") return value;
  const known = field.allowedValues?.find((c) => c.code === value);
  return known ?? { code: value, en: value, cnr: value };
}

/**
 * One enum value, form → wire: a `ResolvedCode` for most fields, a bare code
 * for the {@link BARE_CODE_ENUM_KEYS} exceptions.
 *
 * `codeOf` rather than a pass-through, so a value that is *already* a
 * `ResolvedCode` is unwrapped back down to its code. That matters for repair,
 * not just for new edits: a `metadata.json` written by an earlier build holds
 * the expanded object, and this is what turns it back into something the
 * backend accepts on the next upload.
 */
function toWireEnum(field: FieldDescriptor, form: unknown): unknown {
  return BARE_CODE_ENUM_KEYS.has(field.key)
    ? codeOf(form)
    : resolveCode(field, form);
}

/** Convert one field's **wire** value into the editor's **form** shape. */
export function toFormValue(field: FieldDescriptor, wire: unknown): unknown {
  if (wire === undefined || wire === null) return wire;

  switch (field.type) {
    case "enum":
      return codeOf(wire);
    case "array": {
      if (!Array.isArray(wire)) return wire;
      if (field.itemType === "enum") return wire.map(codeOf);
      if (field.itemType === "object") {
        return wire.map((entry) =>
          isPlainObject(entry) ? toFormObject(field.objectShape ?? [], entry) : entry,
        );
      }
      return wire;
    }
    case "object":
      return isPlainObject(wire) ? toFormObject(field.objectShape ?? [], wire) : wire;
    default:
      return wire;
  }
}

/** Convert one field's **form** value into the backend **wire** shape. */
export function toWireValue(field: FieldDescriptor, form: unknown): unknown {
  if (form === undefined || form === null) return form;

  switch (field.type) {
    case "enum":
      return toWireEnum(field, form);
    case "number": {
      if (typeof form === "string") {
        const trimmed = form.trim();
        if (trimmed === "") return form;
        const n = Number(trimmed);
        return Number.isNaN(n) ? form : n;
      }
      return form;
    }
    case "array": {
      if (!Array.isArray(form)) return form;
      if (field.itemType === "enum") return form.map((v) => toWireEnum(field, v));
      if (field.itemType === "object") {
        return form.map((entry) =>
          isPlainObject(entry) ? toWireObject(field.objectShape ?? [], entry) : entry,
        );
      }
      return form;
    }
    case "object":
      return isPlainObject(form) ? toWireObject(field.objectShape ?? [], form) : form;
    default:
      return form;
  }
}

function toFormObject(
  shape: readonly FieldDescriptor[],
  wire: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...wire };
  for (const child of shape) {
    if (child.key in wire) out[child.key] = toFormValue(child, wire[child.key]);
  }
  return out;
}

function toWireObject(
  shape: readonly FieldDescriptor[],
  form: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    const child = shape.find((c) => c.key === key);
    const wire = child ? toWireValue(child, value) : value;
    // Drop blanks inside nested objects so an untouched sub-form doesn't send
    // `{ place: "", publisher: "" }` as a "filled" publication.
    if (wire === undefined || wire === null) continue;
    if (typeof wire === "string" && wire.trim() === "") continue;
    if (Array.isArray(wire) && wire.length === 0) continue;
    out[key] = wire;
  }
  return out;
}

/** Convert a whole wire record (keyed by field key) to form values. Keys the
 * schema does not know are passed through unchanged. */
export function toFormRecord(
  fields: readonly FieldDescriptor[],
  record: Record<string, unknown>,
): Record<string, unknown> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const field = byKey.get(key);
    out[key] = field ? toFormValue(field, value) : value;
  }
  return out;
}

/** Convert a whole form value map to the wire shape. Keys the schema does not
 * know are passed through unchanged (upload prunes them anyway). */
export function toWireRecord(
  fields: readonly FieldDescriptor[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    out[key] = field ? toWireValue(field, value) : value;
  }
  return out;
}

/** Whether an object-shaped value holds nothing but blanks (drives "empty"
 * checks for object fields, which `isEmptyValue` treats as filled). */
export function isBlankObject(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(
    (v) =>
      v === undefined ||
      v === null ||
      (typeof v === "string" && v.trim() === "") ||
      (Array.isArray(v) && v.length === 0) ||
      isBlankObject(v),
  );
}
