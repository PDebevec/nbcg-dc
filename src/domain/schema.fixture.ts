/**
 * Builders for v2 schemas in tests, and the real schema snapshot
 * (`schemaRules.schema.json`, written by `scripts/sync-schema-rules.ps1`).
 * Not used by the app.
 */
import type { FieldV2, RecordSchemaV2, Vocabulary } from "./schema";
import snapshot from "./schemaRules.schema.json";

/** The live schema as the backend served it when the snapshot was taken. */
export const SNAPSHOT = snapshot as unknown as RecordSchemaV2;

/** A plain visible string field; override what the test needs. */
export function fieldV2(over: Partial<FieldV2> & { key: string }): FieldV2 {
  return {
    label: { en: over.key, cnr: over.key },
    help: null,
    group: "basic",
    order: 0,
    type: "string",
    multiple: false,
    input: "text",
    values: null,
    suggest: null,
    required: false,
    visible: true,
    readOnly: false,
    default: null,
    unit: null,
    constraints: {},
    rules: [],
    objectShape: null,
    parentInheritable: false,
    issueIdentifying: false,
    ...over,
  };
}

/** A schema of the given fields in one "basic" group. */
export function schemaV2(
  fields: FieldV2[],
  vocabularies: Record<string, Vocabulary> = {},
): RecordSchemaV2 {
  return {
    schemaVersion: 2,
    languages: ["en", "cnr"],
    inlineVocabularyMax: 50,
    context: [],
    vocabularies,
    groups: [{ key: "basic", order: 0, label: { en: "Basic", cnr: "Osnovno" } }],
    fields,
  };
}
