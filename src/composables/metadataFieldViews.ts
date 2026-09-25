/**
 * Builds the Metadata tab's field views from the v2 schema, the evaluated field
 * states and the editor values. Pure (no Vue, no stores), so it is tested on
 * its own; `useMetadataForm` adds the parent-source pickers and the "Still to
 * fill" flags on top.
 */

import { isEmpty, type FieldState, type Label } from "@domain/schemaRules";
import { labelText, type FieldV2, type RecordSchemaV2 } from "@domain/schema";
import { fieldKind, inlineOptions, type FieldKind } from "@domain/schema-form";
import { PROVENANCE_LABELS, type MetadataValues, type Provenance } from "@domain/metadata";

export type { FieldKind } from "@domain/schema-form";

/** One option of a select: its text, and the exact value picking it stores. */
export interface FieldOption {
  value: string;
  label: string;
  stored: unknown;
}

/** Where a field's typeahead asks, and how a pick is used. */
export interface HintSource {
  path: string;
  queryParam: string;
  minChars: number;
  /** Only a picked hint is accepted (a vocabulary). */
  strict: boolean;
  /** Picking fills the whole entry (an author hint fills that author). */
  fillsEntry: boolean;
}

/** A source option in a field's per-field source picker. */
export interface FieldSourceOptionView {
  parentId: string;
  name: string;
  /** Preview of the value this parent would supply. */
  preview: string;
  selected: boolean;
}

/** One schema-driven form field, shaped for rendering. */
export interface FieldView {
  key: string;
  /** Where the value lives: `title`, `publication.place`, `authors[1].role`. */
  path: string;
  label: string;
  help: string;
  kind: FieldKind;
  required: boolean;
  readOnly: boolean;
  /** Spans both form columns. */
  wide: boolean;
  /** The stored value. */
  raw: unknown;
  /** Scalar rendering ('' when unset): the text, the number, the option code, a vocabulary label. */
  value: string;
  /** Multi kinds: one chip per stored element (codes for coded chips). */
  chips: string[];
  chipLabels: string[];
  /** Options for enum, multi-enum and boolean. */
  options: FieldOption[];
  /** Quantity: the unit shown after the number — the stored one when it no longer matches. */
  unit: string;
  hints: HintSource | null;
  /** `object`: one view per sub-field. */
  children: FieldView[];
  /** `object-list`: the sub-field views of each entry. */
  entries: FieldView[][];
  provenance: Provenance | "none";
  provLabel: string;
  sourceOptions: FieldSourceOptionView[];
  manualSelected: boolean;
  /** Validation message once validation shows, else ''. */
  error: string;
  /** "Still to fill" on an empty per-issue field, else ''. */
  flag: string;
  group: string;
  groupLabel: string;
  /** First field of its group. */
  groupStart: boolean;
}

export interface BuildViewsInput {
  schema: RecordSchemaV2;
  /** Top-level fields, in the order to render. */
  fields: readonly FieldV2[];
  states: Record<string, FieldState>;
  values: MetadataValues;
  /** Messages by path (empty until validation shows). */
  errors: Record<string, string>;
}

type Plain = Record<string, unknown>;

const MULTI_KINDS: ReadonlySet<FieldKind> = new Set(["multi", "multi-enum", "multi-hint", "multi-vocab"]);

const BOOLEAN_OPTIONS: FieldOption[] = [
  { value: "true", label: "Yes", stored: true },
  { value: "false", label: "No", stored: false },
];

function isPlainObject(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codeOf(value: unknown): string {
  if (isPlainObject(value) && "code" in value) return String(value.code);
  return value === null || value === undefined ? "" : String(value);
}

function scalarString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asLabel(value: unknown): Label | null {
  return isPlainObject(value) && typeof value.en === "string" && typeof value.cnr === "string"
    ? (value as unknown as Label)
    : null;
}

function optionsFor(schema: RecordSchemaV2, field: FieldV2): FieldOption[] {
  if (field.type === "boolean") return BOOLEAN_OPTIONS;
  const bare = field.values?.storeAs === "code";
  return inlineOptions(schema, field).map((v) => ({
    value: String(v.code),
    label: labelText(v),
    stored: bare ? v.code : { code: v.code, en: v.en, cnr: v.cnr },
  }));
}

/** The text for a stored enum value: its own labels, else the option's, else the code. */
function displayOf(options: FieldOption[], value: unknown): string {
  const label = asLabel(value);
  if (label) return labelText(label) || codeOf(value);
  return options.find((o) => o.value === codeOf(value))?.label ?? codeOf(value);
}

function hintsFor(schema: RecordSchemaV2, field: FieldV2): HintSource | null {
  if (field.type === "object") return null; // an object's hints sit on its entries
  if (field.suggest) return { ...field.suggest, fillsEntry: false };
  if (field.type === "enum" && field.values) {
    const search = schema.vocabularies[field.values.vocabulary]?.search;
    if (search) return { ...search, strict: true, fillsEntry: false };
  }
  return null;
}

function unitText(schema: RecordSchemaV2, raw: unknown, state: FieldState | undefined): string {
  const stored = isPlainObject(raw) && typeof raw.unit === "string" ? raw.unit : null;
  if (stored && stored !== state?.unit?.code) {
    const known = schema.vocabularies.extentUnit?.values?.find((u) => u.code === stored);
    return known ? labelText(known) : stored;
  }
  return state?.unit ? labelText(state.unit) : "";
}

function childViews(
  input: BuildViewsInput,
  shape: readonly FieldV2[],
  value: Plain,
  path: string,
  statePath: string,
  entryHints: HintSource | null,
): FieldView[] {
  const firstText = shape.find((c) => c.type === "string");
  return shape
    .filter((c) => input.states[`${statePath}.${c.key}`]?.visible !== false || !isEmpty(value[c.key]))
    .map((c) =>
      view(input, c, value[c.key], `${path}.${c.key}`, `${statePath}.${c.key}`, c === firstText ? entryHints : null),
    );
}

function view(
  input: BuildViewsInput,
  field: FieldV2,
  raw: unknown,
  path: string,
  statePath: string,
  entryHints: HintSource | null,
): FieldView {
  const { schema, states, errors } = input;
  const state = states[statePath];
  const kind = fieldKind(field);
  const options = optionsFor(schema, field);
  const list = MULTI_KINDS.has(kind) && Array.isArray(raw) ? raw : [];
  const top = !path.includes(".") && !path.includes("[");
  let value: string;
  if (kind === "quantity") value = scalarString(isPlainObject(raw) ? raw.value : undefined);
  else if (kind === "enum" || kind === "boolean") value = codeOf(raw);
  else if (kind === "vocab") value = raw === null || raw === undefined ? "" : displayOf(options, raw);
  else value = scalarString(raw);
  const entryHintsForList = field.suggest ? { ...field.suggest, fillsEntry: true } : null;
  return {
    key: field.key,
    path,
    label: labelText(state?.label ?? field.label),
    help: labelText(state?.help ?? field.help),
    kind,
    required: state?.required ?? field.required,
    readOnly: state?.readOnly ?? field.readOnly,
    wide: top && (kind === "object" || kind === "object-list" || kind === "textarea" || MULTI_KINDS.has(kind)),
    raw,
    value,
    chips: list.map(codeOf),
    chipLabels: list.map((x) => displayOf(options, x)),
    options,
    unit: kind === "quantity" ? unitText(schema, raw, state) : "",
    hints: entryHints ?? hintsFor(schema, field),
    children:
      kind === "object"
        ? childViews(input, field.objectShape ?? [], isPlainObject(raw) ? raw : {}, path, statePath, null)
        : [],
    entries:
      kind === "object-list" && Array.isArray(raw)
        ? raw.map((entry, i) =>
            childViews(input, field.objectShape ?? [], isPlainObject(entry) ? entry : {}, `${path}[${i}]`, statePath, entryHintsForList),
          )
        : [],
    provenance: "none",
    provLabel: "",
    sourceOptions: [],
    manualSelected: false,
    error: errors[path] ?? "",
    flag: "",
    group: field.group,
    groupLabel: labelText(schema.groups.find((g) => g.key === field.group)?.label) || field.group,
    groupStart: false,
  };
}

/** The views for the top-level fields, with provenance tags and group starts. */
export function buildFieldViews(input: BuildViewsInput): FieldView[] {
  let lastGroup: string | null = null;
  return input.fields.map((field) => {
    const entry = input.values[field.key];
    const raw = entry?.value;
    const v = view(input, field, raw, field.key, field.key, null);
    const provenance: Provenance | "none" = entry && !isEmpty(raw) ? entry.provenance : "none";
    v.provenance = provenance;
    v.provLabel = provenance === "none" ? "" : PROVENANCE_LABELS[provenance];
    v.groupStart = field.group !== lastGroup;
    lastGroup = field.group;
    return v;
  });
}
