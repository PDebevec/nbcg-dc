/**
 * Runs the backend's conformance fixture against the vendored copy of its rule
 * evaluator. The evaluator, the fixture and the schema snapshot are copied by
 * `scripts/sync-schema-rules.ps1` — never edit them by hand.
 */
import { describe, expect, it } from "vitest";
import {
  buildContext,
  checkMetadata,
  evaluateAll,
  isEmpty,
  type FieldState,
  type ItemState,
  type RuleContext,
  type RuleField,
  type TargetState,
} from "./schemaRules";
import conformance from "./schemaRules.conformance.json";
import snapshot from "./schemaRules.schema.json";

// The fixture is the backend's data, typed loosely on purpose.
const fixture = conformance as any;
const schema = snapshot as unknown as { fields: RuleField[] };

/** Compare only the properties a case lists; units and labels by code / English text. */
function project(state: FieldState, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === "unit") out.unit = state.unit ? state.unit.code : null;
    else if (k === "label") out.label = state.label.en;
    else if (k === "help") out.help = state.help ? state.help.en : null;
    else out[k] = (state as unknown as Record<string, unknown>)[k];
  }
  return out;
}

function runCase(fields: RuleField[], defaults: RuleContext, c: any): void {
  const states = evaluateAll({ fields }, { ...defaults, ...c.context });
  for (const [path, expected] of Object.entries<Record<string, unknown>>(c.expected)) {
    expect(states[path], path).toBeDefined();
    expect({ path, ...project(states[path], Object.keys(expected)) }).toEqual({ path, ...expected });
  }
}

describe("schema rules — conformance fixture", () => {
  describe("isEmpty", () => {
    const isEmptyCases: Array<[string, unknown, boolean]> = fixture.isEmpty.map((c: any) => [
      JSON.stringify(c.value),
      c.value,
      c.expected,
    ]);
    it.each(isEmptyCases)("isEmpty(%s)", (_label, value, expected) => expect(isEmpty(value)).toBe(expected));
  });

  describe("buildContext", () => {
    const buildContextCases: Array<[string, any]> = fixture.buildContext.map((c: any) => [c.name, c]);
    it.each(buildContextCases)("%s", (_name, c) => {
      const ctx = buildContext(c.metadata, c.parents, c.itemState as ItemState, c.targetState as TargetState);
      expect(ctx).toMatchObject(c.expected);
    });
  });

  describe("mechanics", () => {
    const mechanicsCases: Array<[string, any]> = fixture.mechanics.cases.map((c: any) => [c.name, c]);
    it.each(mechanicsCases)("%s", (_name, c) =>
      runCase(fixture.mechanics.fields, fixture.mechanics.contextDefaults, c),
    );
  });

  describe("record rule table (against the schema snapshot)", () => {
    const recordCases: Array<[string, any]> = fixture.record.cases.map((c: any) => [c.name, c]);
    it.each(recordCases)("%s", (_name, c) => runCase(schema.fields, fixture.record.contextDefaults, c));
  });

  describe("checkMetadata", () => {
    const checkCases: Array<[string, any]> = fixture.check.cases.map((c: any) => [c.name, c]);
    it.each(checkCases)("%s", (_name, c) => {
      const ctx = buildContext(c.metadata, c.parents, c.itemState, c.targetState);
      const result = checkMetadata(schema, c.metadata, ctx);
      expect({
        missing: result.missing.map((m) => m.path),
        violations: result.violations.map((v) => ({ path: v.path, constraint: v.constraint })),
      }).toEqual(c.expected);
    });
  });
});
