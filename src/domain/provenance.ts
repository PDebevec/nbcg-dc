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

import type { FieldDescriptor } from "./schema";
import type { ItemLevel } from "./item";
import type { MetadataValues, Provenance } from "./metadata";
import { isEmptyValue } from "./metadata-form";
import type { ParentRecord } from "./parent";

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
    const existingEmpty = !existing || isEmptyValue(existing.value);

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
 * provenance (with `sourceParentId`), dropping empties. */
export function parentInheritableValues(
  parent: ParentRecord,
  fields: readonly FieldDescriptor[],
): MetadataValues {
  const out: MetadataValues = {};
  for (const field of fields) {
    if (!field.parentInheritable) continue;
    if (field.issueIdentifying) continue; // per-issue — never inherited
    const value = parent.metadata[field.key];
    if (isEmptyValue(value)) continue;
    out[field.key] = { value, provenance: "parent", sourceParentId: parent.id };
  }
  return out;
}

/** Stamp a COBISS/COMARC record's fields as `cobiss` provenance, keeping only
 * keys the schema knows and dropping empties. (The backend preview `metadata`
 * shares the schema's COMARC field keys; unknown keys are ignored.) */
export function cobissValues(
  record: Record<string, unknown>,
  fields: readonly FieldDescriptor[],
): MetadataValues {
  const known = new Set(fields.map((f) => f.key));
  const out: MetadataValues = {};
  for (const [key, value] of Object.entries(record)) {
    if (!known.has(key)) continue;
    if (isEmptyValue(value)) continue;
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
 * item's **empty** matching fields (provenance `parent`). A parent copy never
 * overwrites an existing value — so there are no conflicts — and per-issue
 * fields are intentionally left for the operator ({@link stillToFill}).
 */
export function applyParentFields(
  current: MetadataValues,
  parent: ParentRecord,
  fields: readonly FieldDescriptor[],
): ApplyParentResult {
  const incoming = parentInheritableValues(parent, fields);
  // A parent copy only ever fills empties — it never overwrites and never
  // raises the overwrite prompt (skip-silent), so it produces no conflicts.
  const outcome = fillValues(current, incoming, {
    overwriteMachine: false,
    onUserConflict: "skip-silent",
  });
  return { ...outcome, stillToFill: stillToFill(fields, outcome.values) };
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
  fields: readonly FieldDescriptor[],
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
  fields: readonly FieldDescriptor[],
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
 * inheritable value for it, plus a **Manual entry** option. Shown when two or
 * more parents could supply the same field (docs/tasks/05 §per-field source).
 */
export function fieldSourceOptions(
  field: FieldDescriptor,
  current: MetadataValues,
  parents: readonly ParentRecord[],
): FieldSourceOption[] {
  const options: FieldSourceOption[] = [];
  if (field.parentInheritable) {
    for (const parent of parents) {
      const value = parent.metadata[field.key];
      if (isEmptyValue(value)) continue;
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
 * parent's value (provenance `parent`, `sourceParentId`); **Manual entry** keeps
 * the current value but flips provenance to `user` (the operator now owns it).
 */
export function chooseFieldSource(
  current: MetadataValues,
  fieldKey: string,
  option: FieldSourceOption,
): MetadataValues {
  const values: MetadataValues = { ...current };
  if (option.kind === "manual") {
    values[fieldKey] = { value: current[fieldKey]?.value, provenance: "user" };
  } else {
    values[fieldKey] = {
      value: option.value,
      provenance: "parent",
      sourceParentId: option.parentId,
    };
  }
  return values;
}

// ─── issue fields + case routing ─────────────────────────────────────────────

/** The issue-identifying fields (must be filled per child even with a parent). */
export function issueFields(
  fields: readonly FieldDescriptor[],
): FieldDescriptor[] {
  return fields.filter((f) => f.issueIdentifying);
}

/** The issue-identifying field keys still empty in `values` — the "Still to
 * fill" set for the serial/issue flow. */
export function stillToFill(
  fields: readonly FieldDescriptor[],
  values: MetadataValues,
): string[] {
  return issueFields(fields)
    .filter((f) => isEmptyValue(values[f.key]?.value))
    .map((f) => f.key);
}

/** The four ingestion cases (docs/01 §"four ingestion cases"). */
export type IngestionCase = 1 | 2 | 3 | 4;

export interface CaseRouteInput {
  level: ItemLevel;
  /** Whether a COBISS ID is set (per item, or the batch prefill). */
  hasCobissId: boolean;
}

/**
 * Route to the ingestion case from level + COBISS presence:
 *  1. Main · no COBISS  → fill manually;
 *  2. Main · COBISS      → COBISS prefill;
 *  3. Child · COBISS     → COBISS prefill (same as 2);
 *  4. Child · no COBISS  → link a serial parent, fill the per-issue fields.
 *
 * COBISS and parents are **non-exclusive** prefillers — the case is a hint for
 * the primary path, never a gate (using one never blocks the other).
 */
export function routeCase(input: CaseRouteInput): IngestionCase {
  if (input.hasCobissId) return input.level === "main" ? 2 : 3;
  return input.level === "main" ? 1 : 4;
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
