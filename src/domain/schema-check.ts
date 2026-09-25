/**
 * The save check for one item — what blocks "Go to processing" and the upload.
 *
 * It runs the backend's own check (`checkMetadata`) on exactly what an upload
 * would send, plus a format check the backend does separately (numbers, dates,
 * quantities). The rules see the item's batch's parents and whose rules apply:
 * a new item is checked against its Draft/Record choice; an item already on the
 * backend against the state it has there — the backend checks every edit
 * against the current state, and the app never moves an item between the two.
 */

import {
  buildContext,
  checkMetadata,
  evaluateAll,
  type ConstraintViolation,
  type FieldState,
  type ItemState,
  type Label,
  type MissingField,
  type RuleContext,
  type TargetState,
} from "./schemaRules";
import { labelText, type RecordSchemaV2 } from "./schema";
import { formatErrors, pruneForUpload, type FormatError } from "./schema-values";

export interface ItemCheckInput {
  schema: RecordSchemaV2;
  /** The editor's values (plain). */
  values: Record<string, unknown>;
  /** The metadata of the batch's parents. */
  parents: ReadonlyArray<Record<string, unknown>>;
  /** The item's state on the backend; null until its first upload. */
  backendState: TargetState | null;
  /** The Draft/Record choice — counts only while the item is not on the backend. */
  choice: TargetState;
}

export interface ItemCheck {
  /** Whose rules apply. */
  targetState: TargetState;
  context: RuleContext;
  /** Field states keyed by dotted path (`extent`, `issue.number`). */
  states: Record<string, FieldState>;
  missing: MissingField[];
  violations: Array<ConstraintViolation | FormatError>;
  ok: boolean;
  /** Draft only: required fields still empty under the record rules (never blocks). */
  missingToPublish: number;
}

/** The rules' context for an item. `values` default to what the upload would send. */
export function itemContext(
  input: ItemCheckInput,
  values: Record<string, unknown> = pruneForUpload(input.schema, input.values),
): RuleContext {
  const itemState: ItemState = input.backendState ?? "NEW";
  const targetState: TargetState = input.backendState ?? input.choice;
  return buildContext(values, [...input.parents], itemState, targetState);
}

export function checkItem(input: ItemCheckInput): ItemCheck {
  const values = pruneForUpload(input.schema, input.values);
  const context = itemContext(input, values);
  const targetState = context.targetState as TargetState;
  const states = evaluateAll(input.schema, context);
  const { missing, violations } = checkMetadata(input.schema, values, context);
  const seen = new Set(violations.map((v) => v.path));
  const all = [...violations, ...formatErrors(input.schema, values).filter((e) => !seen.has(e.path))];
  const missingToPublish =
    targetState === "DRAFT"
      ? checkMetadata(input.schema, values, { ...context, targetState: "RECORD" }).missing.length
      : 0;
  return {
    targetState,
    context,
    states,
    missing,
    violations: all,
    ok: missing.length === 0 && all.length === 0,
    missingToPublish,
  };
}

/** One line for a broken constraint (the field's label goes in front where needed). */
export function violationMessage(v: { constraint: string; limit?: number | string; hint?: Label }): string {
  switch (v.constraint) {
    case "minLength":
      return `At least ${v.limit} characters.`;
    case "maxLength":
      return `At most ${v.limit} characters.`;
    case "min":
      return `At least ${v.limit}.`;
    case "max":
      return `At most ${v.limit}.`;
    case "minItems":
      return `At least ${v.limit} entries.`;
    case "maxItems":
      return `At most ${v.limit} entries.`;
    case "unit":
      return `Saved in another unit — retype the number to save it in ${v.limit}.`;
    case "pattern":
    case "format":
      return v.hint ? `Expected: ${labelText(v.hint)}.` : "Wrong format.";
    default:
      return "Invalid value.";
  }
}

// ─── navigator status ────────────────────────────────────────────────────────

/** Per-item status in the navigator. */
export type ItemReadiness = "ready" | "incomplete" | "untouched";

/** Index of the first item that is not ready, or -1. */
export function firstIncompleteIndex(readinesses: readonly ItemReadiness[]): number {
  return readinesses.findIndex((r) => r !== "ready");
}
