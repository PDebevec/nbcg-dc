/**
 * Metadata schema v2 — rule evaluator and save check.
 *
 * PORTABLE BY DESIGN: no imports, no framework, no I/O. This file is copied
 * verbatim to the web frontend (`frontend/src/utils/schemaRules.ts`) and to the
 * archive app, and `evaluate.spec.ts` fails if the web copy differs — change it
 * here, then copy it over. Every copy runs `conformance.json` next to this file.
 *
 * Contract: docs/shared/plans/metadata-schema-v2.md ("Rule", "Evaluation",
 * "Validation on save").
 */

// ─── Types (the rule-related part of the contract) ──────────────────────────

export interface Label {
  en: string;
  cnr: string;
}

export interface Unit {
  code: string;
  en: string;
  cnr: string;
}

export interface Constraints {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  patternHint?: Label;
}

export type Condition =
  | { ref: string; eq: string | number | boolean }
  | { ref: string; in: Array<string | number | boolean> }
  | { ref: string; empty: boolean }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

/** What a matching rule may change. Nothing else — a field's stored shape never changes. */
export interface RuleEffect {
  visible?: boolean;
  required?: boolean;
  readOnly?: boolean;
  unit?: Unit | null;
  label?: Label;
  help?: Label | null;
  constraints?: Constraints;
}

export interface Rule {
  when: Condition;
  set: RuleEffect;
}

/** The part of a schema field this file reads. A full schema field satisfies it. */
export interface RuleField {
  key: string;
  type: string;
  multiple: boolean;
  label: Label;
  help?: Label | null;
  required: boolean;
  visible: boolean;
  readOnly: boolean;
  unit?: Unit | null;
  constraints?: Constraints | null;
  rules?: Rule[] | null;
  objectShape?: RuleField[] | null;
}

/** A field after its rules ran against one context. */
export interface FieldState {
  visible: boolean;
  required: boolean;
  readOnly: boolean;
  unit: Unit | null;
  label: Label;
  help: Label | null;
  constraints: Constraints;
}

/** Where the item is now — `NEW` when it does not exist yet. */
export type ItemState = 'NEW' | 'DRAFT' | 'RECORD';

/** The state a save goes to: the chosen one on create, the current one on an edit, the new one on a transition. */
export type TargetState = 'DRAFT' | 'RECORD';

export type ContextValue = string | number | boolean | null | Array<string | number>;

/** Keyed by the schema's declared context keys — see `buildContext`. */
export type RuleContext = Record<string, ContextValue | undefined>;

export interface MissingField {
  path: string;
  label: Label;
}

export interface ConstraintViolation {
  path: string;
  label: Label;
  /** A `Constraints` key, or `unit` when a quantity's stored unit is not the evaluated one. */
  constraint: string;
  /** The bound that was broken (`minLength: 3` → 3), or the expected unit code. */
  limit?: number | string;
  hint?: Label;
}

export interface CheckResult {
  missing: MissingField[];
  violations: ConstraintViolation[];
}

// ─── Context ────────────────────────────────────────────────────────────────

/**
 * The values a rule may look at, computed from the item and its parents'
 * metadata. `parents` is the metadata of every parent (or `[]`).
 */
export function buildContext(
  metadata: Record<string, unknown> | null | undefined,
  parents: Array<Record<string, unknown> | null | undefined>,
  itemState: ItemState,
  targetState: TargetState,
): RuleContext {
  const m = metadata ?? {};
  const materialType = codeOf(m.materialType);
  return {
    materialType,
    recordType: codeOf(m.recordType) ?? (materialType ? materialType.charAt(0) : null),
    bibliographicLevel:
      codeOf(m.bibliographicLevel) ??
      (materialType && materialType.length > 1 ? materialType.charAt(1) : null),
    collectionType: collectionTypeOf(m.collectionType),
    isChild: parents.length > 0,
    parentCollectionType: parents.map((p) => collectionTypeOf(p?.collectionType)),
    itemState,
    targetState,
  };
}

function codeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : null;
}

function collectionTypeOf(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

/**
 * `null`, `undefined`, a blank string, `[]` and `{}` are empty. Used both by the
 * `empty` condition and by the "required but empty" save check.
 */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Whether a condition holds. On an array context value (`parentCollectionType`)
 * `eq`/`in` hold when any element matches. Comparison is strict: `4` ≠ `"4"`.
 */
export function matches(cond: Condition, ctx: RuleContext): boolean {
  if ('all' in cond) return cond.all.every((c) => matches(c, ctx));
  if ('any' in cond) return cond.any.some((c) => matches(c, ctx));
  if ('not' in cond) return !matches(cond.not, ctx);

  const value = ctx[cond.ref];
  if ('empty' in cond) return isEmpty(value) === cond.empty;

  const values: unknown[] = Array.isArray(value) ? value : [value];
  if ('eq' in cond) return values.some((v) => v === cond.eq);
  if ('in' in cond) return values.some((v) => (cond.in as unknown[]).includes(v));
  return false;
}

/** Apply a field's rules in order (a later match wins). A hidden field is never required. */
export function evaluateField(field: RuleField, ctx: RuleContext): FieldState {
  const s: FieldState = {
    visible: field.visible,
    required: field.required,
    readOnly: field.readOnly,
    unit: field.unit ?? null,
    label: field.label,
    help: field.help ?? null,
    constraints: { ...(field.constraints ?? {}) },
  };

  for (const rule of field.rules ?? []) {
    if (!matches(rule.when, ctx)) continue;
    const set = rule.set;
    if (set.visible !== undefined) s.visible = set.visible;
    if (set.required !== undefined) s.required = set.required;
    if (set.readOnly !== undefined) s.readOnly = set.readOnly;
    if (set.unit !== undefined) s.unit = set.unit;
    if (set.label !== undefined) s.label = set.label;
    if (set.help !== undefined) s.help = set.help;
    if (set.constraints !== undefined) s.constraints = { ...s.constraints, ...set.constraints };
  }

  if (!s.visible) s.required = false;
  return s;
}

/**
 * Every field's state, keyed by dotted path (`extent`, `issue.number`,
 * `authors.role`). A hidden object hides everything inside it.
 */
export function evaluateAll(
  schema: { fields: RuleField[] },
  ctx: RuleContext,
): Record<string, FieldState> {
  const out: Record<string, FieldState> = {};
  const walk = (fields: RuleField[], prefix: string, parentVisible: boolean) => {
    for (const field of fields) {
      const state = evaluateField(field, ctx);
      if (!parentVisible) {
        state.visible = false;
        state.required = false;
      }
      const path = prefix + field.key;
      out[path] = state;
      if (field.objectShape) walk(field.objectShape, `${path}.`, state.visible);
    }
  };
  walk(schema.fields, '', true);
  return out;
}

// ─── Save check ─────────────────────────────────────────────────────────────

/**
 * What stands between this metadata and saving it in the context's
 * `targetState`: fields that are visible, required and empty (`missing`), and
 * values that break their `constraints` (`violations`). An empty field is never
 * format-checked, so one path is missing or violating, not both. Hidden fields
 * are skipped entirely — a rule never makes old data an error. Repeatable objects are checked per element
 * (`corporateBodies[1].name`); a single object that is absent is checked as
 * `{}`, so its required sub-fields still count as missing.
 */
export function checkMetadata(
  schema: { fields: RuleField[] },
  metadata: Record<string, unknown> | null | undefined,
  ctx: RuleContext,
): CheckResult {
  const states = evaluateAll(schema, ctx);
  const result: CheckResult = { missing: [], violations: [] };

  const walk = (
    fields: RuleField[],
    value: Record<string, unknown>,
    statePrefix: string,
    pathPrefix: string,
  ) => {
    for (const field of fields) {
      const statePath = statePrefix + field.key;
      const state = states[statePath];
      if (!state || !state.visible) continue;

      const path = pathPrefix + field.key;
      const v = value[field.key];
      const shape = field.type === 'object' ? field.objectShape : null;

      if (isEmpty(v)) {
        if (state.required) result.missing.push({ path, label: state.label });
        if (shape && !field.multiple) walk(shape, {}, `${statePath}.`, `${path}.`);
        continue;
      }

      checkConstraints(field, state, v, path, result.violations);

      if (shape && field.multiple && Array.isArray(v)) {
        v.forEach((el, i) => walk(shape, asRecord(el), `${statePath}.`, `${path}[${i}].`));
      } else if (shape && !field.multiple) {
        walk(shape, asRecord(v), `${statePath}.`, `${path}.`);
      }
    }
  };

  walk(schema.fields, metadata ?? {}, '', '');
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function checkConstraints(
  field: RuleField,
  state: FieldState,
  value: unknown,
  path: string,
  out: ConstraintViolation[],
): void {
  const c = state.constraints;
  const report = (at: string, constraint: string, limit?: number | string, hint?: Label) =>
    out.push({
      path: at,
      label: state.label,
      constraint,
      ...(limit !== undefined ? { limit } : {}),
      ...(hint ? { hint } : {}),
    });

  const checkOne = (v: unknown, at: string) => {
    if (typeof v === 'string') {
      if (c.minLength !== undefined && v.length < c.minLength) report(at, 'minLength', c.minLength);
      if (c.maxLength !== undefined && v.length > c.maxLength) report(at, 'maxLength', c.maxLength);
      if (c.pattern !== undefined && !new RegExp(c.pattern).test(v)) {
        report(at, 'pattern', undefined, c.patternHint);
      }
    }

    let n: unknown = v;
    if (field.type === 'quantity') {
      const q = asRecord(v);
      n = q.value;
      if (state.unit && q.unit !== state.unit.code) report(at, 'unit', state.unit.code);
    }
    if (typeof n === 'number') {
      if (c.min !== undefined && n < c.min) report(at, 'min', c.min);
      if (c.max !== undefined && n > c.max) report(at, 'max', c.max);
    }
  };

  if (field.multiple && Array.isArray(value)) {
    if (c.minItems !== undefined && value.length < c.minItems) report(path, 'minItems', c.minItems);
    if (c.maxItems !== undefined && value.length > c.maxItems) report(path, 'maxItems', c.maxItems);
    if (field.type !== 'object') value.forEach((el, i) => checkOne(el, `${path}[${i}]`));
  } else {
    checkOne(value, path);
  }
}
