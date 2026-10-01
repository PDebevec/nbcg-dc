/**
 * The **provenance engine** (Epic 05) — the pure rules behind COBISS/parent
 * prefill, the overwrite prompt, the per-field source picker, the serial/issue
 * flow, and the four-case routing (docs/tasks/05, docs/01 §"four ingestion
 * cases").
 *
 * Every field value in the editor is a {@link MetadataFieldValue} carrying its
 * `provenance` (`cobiss` | `parent` | `user`) and, for a parent value, the
 * `sourceParentId`. This module applies incoming sources onto that map under a
 * single precedence rule:
 *
 *  - an **empty** field always fills (silently);
 *  - a **user**-edited field is protected — overwriting it is a *conflict* (drives
 *    the "Overwrite all" vs "Keep mine, fill empties" prompt), applied only in
 *    `overwrite-all`;
 *  - a **machine** field (`cobiss`/`parent`) is overwritten only when the incoming
 *    source outranks it: **COBISS wins over a parent copy**, a parent copy never
 *    clobbers an existing value.
 *
 * That single rule expresses both flows the docs describe: at Setup a parent
 * fills empties then COBISS overrides the parent copies (no user values exist
 * yet → no prompt); per item, COBISS "Get data" fills empties + overrides parent
 * copies silently and only prompts on a user-edited field.
 *
 * Framework-free — imports only sibling domain types + the pure form helpers.
 * The batch-wide "apply to all items" loop and the load/autosave wiring live in
 * the (deferred, GUI-shaped) metadata store/composable.
 */

import type { MetadataValues, Provenance } from "./metadata";
import type { ParentRecord } from "./parent";
import { isEmpty } from "./schemaRules";

/** The part of a schema field the provenance rules read (a v2 `FieldV2` fits). */
export interface ProvenanceField {
  key: string;
  parentInheritable: boolean;
  issueIdentifying: boolean;
  /** Repeatable: an object list passes whole, entries and all. */
  multiple?: boolean;
  /** An object field's sub-fields: a parent passes only the inheritable ones. */
  objectShape?: readonly ProvenanceField[] | null;
}

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The sub-fields a parent passes inside an object field: only those the
 * schema marks inheritable, never a per-issue one (publication's place and
 * publisher, not its year). Null when the value passes whole. */
function passedSubKeys(field: ProvenanceField): string[] | null {
  if (field.multiple || !field.objectShape || field.objectShape.length === 0) return null;
  return field.objectShape.filter((c) => c.parentInheritable && !c.issueIdentifying).map((c) => c.key);
}

/** What `parent` passes down for `field`: its value, or for an object field
 * only the passed sub-fields. Empty when it passes nothing. */
function passedValue(parent: ParentRecord, field: ProvenanceField): unknown {
  const value = parent.metadata[field.key];
  const keys = passedSubKeys(field);
  if (!keys) return value;
  if (!isPlainObject(value)) return undefined;
  const out: Plain = {};
  for (const key of keys) if (!isEmpty(value[key])) out[key] = value[key];
  return out;
}

/** A parent's value written into the field: an object's passed sub-fields go
 * over the current object, which keeps its others (an issue's own year); any
 * other value replaces it whole. */
function overPassedPart(field: ProvenanceField, current: unknown, incoming: unknown): unknown {
  if (!passedSubKeys(field) || !isPlainObject(incoming)) return incoming;
  return { ...(isPlainObject(current) ? current : {}), ...incoming };
}

/** `incoming`'s sub-fields written into the object `current` where it has
 * none; null when that changes nothing. */
function fillEmptySubFields(current: unknown, incoming: unknown): Plain | null {
  if (!isPlainObject(current) || !isPlainObject(incoming)) return null;
  const merged: Plain = { ...current };
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    if (!isEmpty(merged[key])) continue;
    merged[key] = value;
    changed = true;
  }
  return changed ? merged : null;
}

// ─── the core fill rule ──────────────────────────────────────────────────────

/**
 * How an incoming source treats an existing **user**-edited value:
 *  - `skip-silent` — keep it, and do **not** raise a conflict (a parent copy,
 *    which only ever fills empties);
 *  - `skip-conflict` — keep it, but record the conflict so the caller can raise
 *    the "Overwrite all / Keep mine" prompt (COBISS "Keep mine, fill empties");
 *  - `overwrite` — replace it, and record the conflict (COBISS "Overwrite all").
 */
export type UserConflictPolicy = "skip-silent" | "skip-conflict" | "overwrite";

/**
 * How an incoming source treats existing values. `overwriteMachine` = may
 * replace a `cobiss`/`parent` value; `onUserConflict` governs `user` values.
 */
export interface FillPolicy {
  overwriteMachine: boolean;
  onUserConflict: UserConflictPolicy;
}

/** A field an incoming source wanted, but which already holds a **user** value —
 * the payload of the overwrite prompt. */
export interface OverwriteConflict {
  key: string;
  currentValue: unknown;
  incomingValue: unknown;
  incomingProvenance: Provenance;
}

/** The result of applying an incoming source onto a value map. */
export interface FillOutcome {
  /** The merged values (a new object; the input is not mutated). */
  values: MetadataValues;
  /** User-edited fields the source collided with (empty when there were none,
   * or the caller chose `overwrite-all`). Drives the overwrite prompt. */
  conflicts: OverwriteConflict[];
  /** Keys actually written. */
  applied: string[];
  /** Keys left unchanged (protected user value, or a higher-ranked machine value). */
  skipped: string[];
}

/**
 * Merge `incoming` (already provenance-stamped) onto `current` under a
 * {@link FillPolicy}. The single primitive every apply-* helper builds on.
 * Incoming values are expected to be non-empty (the builders drop empties).
 */
export function fillValues(
  current: MetadataValues,
  incoming: MetadataValues,
  policy: FillPolicy,
): FillOutcome {
  const values: MetadataValues = { ...current };
  const conflicts: OverwriteConflict[] = [];
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, next] of Object.entries(incoming)) {
    const existing = values[key];
    const existingEmpty = !existing || isEmpty(existing.value);

    if (existingEmpty) {
      values[key] = { ...next };
      applied.push(key);
      continue;
    }

    if (existing.provenance === "user") {
      if (policy.onUserConflict !== "skip-silent") {
        conflicts.push({
          key,
          currentValue: existing.value,
          incomingValue: next.value,
          incomingProvenance: next.provenance,
        });
      }
      if (policy.onUserConflict === "overwrite") {
        values[key] = { ...next };
        applied.push(key);
      } else {
        skipped.push(key);
      }
      continue;
    }

    // existing is a machine value (cobiss / parent)
    if (policy.overwriteMachine) {
      values[key] = { ...next };
      applied.push(key);
    } else {
      skipped.push(key);
    }
  }

  return { values, conflicts, applied, skipped };
}

// ─── building incoming value maps from a source ──────────────────────────────

/** Stamp a parent's **inheritable, non-issue** field values as `parent`
 * provenance (with `sourceParentId`), dropping empties. An object field
 * carries only its inheritable sub-fields. */
export function parentInheritableValues(
  parent: ParentRecord,
  fields: readonly ProvenanceField[],
): MetadataValues {
  const out: MetadataValues = {};
  for (const field of fields) {
    if (!field.parentInheritable) continue;
    if (field.issueIdentifying) continue; // per-issue — never inherited
    const value = passedValue(parent, field);
    if (isEmpty(value)) continue;
    out[field.key] = { value, provenance: "parent", sourceParentId: parent.id };
  }
  return out;
}

/** Stamp a COBISS/COMARC record's fields as `cobiss` provenance, keeping only
 * keys the schema knows and dropping empties. (The backend preview `metadata`
 * shares the schema's COMARC field keys; unknown keys are ignored.) */
export function cobissValues(
  record: Record<string, unknown>,
  fields: readonly ProvenanceField[],
): MetadataValues {
  const known = new Set(fields.map((f) => f.key));
  const out: MetadataValues = {};
  for (const [key, value] of Object.entries(record)) {
    if (!known.has(key)) continue;
    if (isEmpty(value)) continue;
    out[key] = { value, provenance: "cobiss" };
  }
  return out;
}

// ─── the high-level apply helpers ────────────────────────────────────────────

/** Extra result of a parent apply: the issue-identifying fields still empty. */
export interface ApplyParentResult extends FillOutcome {
  /** Issue-identifying fields left empty after the copy — the "Still to fill"
   * flags for the serial/issue flow (case 4). */
  stillToFill: string[];
}

/**
 * Copy a data-passing parent's shared (inheritable, non-issue) fields into the
 * item's **empty** matching fields (provenance `parent`); an object field gets
 * its empty sub-fields filled and keeps the rest. A parent copy never
 * overwrites an existing value — so there are no conflicts — and per-issue
 * fields are intentionally left for the operator ({@link stillToFill}).
 */
export function applyParentFields(
  current: MetadataValues,
  parent: ParentRecord,
  fields: readonly ProvenanceField[],
): ApplyParentResult {
  const incoming = parentInheritableValues(parent, fields);
  const values: MetadataValues = { ...current };
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const field of fields) {
    const next = incoming[field.key];
    if (!next) continue;
    const existing = values[field.key];
    if (!existing || isEmpty(existing.value)) {
      values[field.key] = { ...next };
      applied.push(field.key);
      continue;
    }
    const merged = passedSubKeys(field) ? fillEmptySubFields(existing.value, next.value) : null;
    if (merged === null) {
      skipped.push(field.key);
      continue;
    }
    values[field.key] = { ...existing, value: merged };
    applied.push(field.key);
  }
  return { values, conflicts: [], applied, skipped, stillToFill: stillToFill(fields, values) };
}

/**
 * The serial/issue flow (case 4): linking a serial parent copies its shared
 * fields down and leaves the per-issue fields (volume/year, issue number, date)
 * flagged **"Still to fill"**. Identical mechanics to {@link applyParentFields};
 * named for the case it implements.
 */
export function applySerialParent(
  current: MetadataValues,
  parent: ParentRecord,
  fields: readonly ProvenanceField[],
): ApplyParentResult {
  return applyParentFields(current, parent, fields);
}

/** The prompt options the UI offers when COBISS would overwrite user edits. */
export type CobissApplyMode = "fill-empty" | "overwrite-all";

/**
 * Apply a COBISS preview record onto the item's values (provenance `cobiss`).
 * COBISS fills empties and **overrides parent copies** silently; a user-edited
 * field is a conflict — kept in `fill-empty` ("Keep mine, fill empties"),
 * replaced in `overwrite-all` ("Overwrite all"). The default `fill-empty`
 * outcome already carries the conflict list, so a caller can: apply once, and if
 * `conflicts` is non-empty raise the prompt and re-apply with `overwrite-all`
 * only if the operator chooses it.
 */
export function applyCobiss(
  current: MetadataValues,
  record: Record<string, unknown>,
  fields: readonly ProvenanceField[],
  mode: CobissApplyMode = "fill-empty",
): FillOutcome {
  const incoming = cobissValues(record, fields);
  return fillValues(current, incoming, {
    overwriteMachine: true,
    onUserConflict: mode === "overwrite-all" ? "overwrite" : "skip-conflict",
  });
}

// ─── per-field source picker ─────────────────────────────────────────────────

/** One option in the per-field source picker: a specific linked parent, or a
 * `manual` entry that hands the field back to the operator. */
export interface FieldSourceOption {
  kind: "parent" | "manual";
  /** The parent supplying the value (`null` for manual). */
  parentId: string | null;
  /** The value this source would set (the parent's value, or — for manual — the
   * field's current value, which the operator then edits). */
  value: unknown;
}

/**
 * The source options for a field: every linked parent that holds a non-empty,
 * inheritable value for it (for an object, its passed sub-fields), plus a
 * **Manual entry** option. Shown when two or more parents could supply the same
 * field (docs/tasks/05 §per-field source).
 */
export function fieldSourceOptions(
  field: ProvenanceField,
  current: MetadataValues,
  parents: readonly ParentRecord[],
): FieldSourceOption[] {
  const options: FieldSourceOption[] = [];
  if (field.parentInheritable) {
    for (const parent of parents) {
      const value = passedValue(parent, field);
      if (isEmpty(value)) continue;
      options.push({ kind: "parent", parentId: parent.id, value });
    }
  }
  options.push({
    kind: "manual",
    parentId: null,
    value: current[field.key]?.value,
  });
  return options;
}

/**
 * Apply a source-picker choice to a single field. A parent choice sets the
 * parent's value (provenance `parent`, `sourceParentId`) — into an object
 * field, only over its passed sub-fields; **Manual entry** keeps the current
 * value but flips provenance to `user` (the operator now owns it).
 */
export function chooseFieldSource(
  current: MetadataValues,
  field: ProvenanceField,
  option: FieldSourceOption,
): MetadataValues {
  const values: MetadataValues = { ...current };
  const held = current[field.key]?.value;
  if (option.kind === "manual") {
    values[field.key] = { value: held, provenance: "user" };
  } else {
    values[field.key] = {
      value: overPassedPart(field, held, option.value),
      provenance: "parent",
      sourceParentId: option.parentId,
    };
  }
  return values;
}

// ─── issue fields + case routing ─────────────────────────────────────────────

/** The issue-identifying fields (must be filled per child even with a parent). */
export function issueFields(
  fields: readonly ProvenanceField[],
): ProvenanceField[] {
  return fields.filter((f) => f.issueIdentifying);
}

/** The issue-identifying field keys still empty in `values` — the "Still to
 * fill" set for the serial/issue flow. */
export function stillToFill(
  fields: readonly ProvenanceField[],
  values: MetadataValues,
): string[] {
  return issueFields(fields)
    .filter((f) => isEmpty(values[f.key]?.value))
    .map((f) => f.key);
}

/** The four ingestion cases (docs/01 §"four ingestion cases"). */
export type IngestionCase = 1 | 2 | 3 | 4;

export interface CaseRouteInput {
  /** `collectionType` of each of the item's parents ([] when it has none). */
  parentCollectionTypes: readonly number[];
  /** Whether a COBISS ID is set (per item, or the batch prefill). */
  hasCobissId: boolean;
}

/**
 * Route to the ingestion case from the item's parents + COBISS presence:
 *  1. No COBISS, no serial parent → fill manually;
 *  2. No parent · COBISS          → COBISS prefill;
 *  3. A parent · COBISS           → COBISS prefill (same as 2);
 *  4. A serial parent · no COBISS → the per-issue fields; the rest comes from the serial.
 * A non-serial parent without COBISS is case 1: under schema v2 such an item
 * keeps its own author, ISBN etc. (fields are hidden only under a serial).
 *
 * COBISS and parents are **non-exclusive** prefillers — the case is a hint for
 * the primary path, never a gate.
 */
export function routeCase(input: CaseRouteInput): IngestionCase {
  const isChild = input.parentCollectionTypes.length > 0;
  if (input.hasCobissId) return isChild ? 3 : 2;
  return input.parentCollectionTypes.includes(4) ? 4 : 1;
}

/** The highlighted (primary) prefill path for a case — a UI hint only. */
export type CasePrimaryPath = "manual" | "cobiss" | "parent";

/** The primary path + case number for the editor to emphasise. */
export function caseBehavior(input: CaseRouteInput): {
  case: IngestionCase;
  primary: CasePrimaryPath;
} {
  const c = routeCase(input);
  const primary: CasePrimaryPath =
    c === 1 ? "manual" : c === 4 ? "parent" : "cobiss";
  return { case: c, primary };
}

// ─── the provenance map ↔ plain values ───────────────────────────────────────

/** The editor's provenance map as plain values (what the check and the wire see). */
export function flattenValues(values: MetadataValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(values)) out[key] = field.value;
  return out;
}

/** Wrap plain values in the provenance map; with `known`, other keys are dropped. */
export function toMetadataValues(
  record: Record<string, unknown>,
  provenance: Provenance,
  known?: ReadonlySet<string>,
): MetadataValues {
  const out: MetadataValues = {};
  for (const [key, value] of Object.entries(record)) {
    if (known && !known.has(key)) continue;
    out[key] = { value, provenance };
  }
  return out;
}
