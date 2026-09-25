import { describe, expect, it } from "vitest";
import { fieldV2, SNAPSHOT } from "./schema.fixture";
import type { FieldV2 } from "./schema";
import type { FieldState } from "./schemaRules";
import {
  fieldAtPath,
  fieldKind,
  inlineOptions,
  orderedFields,
  splitByVisibility,
  statePathOf,
  type FieldKind,
} from "./schema-form";

const kindOf = (over: Partial<FieldV2>) => fieldKind(fieldV2({ key: "x", ...over }));

describe("fieldKind", () => {
  it.each<[Partial<FieldV2>, FieldKind]>([
    [{ input: "text" }, "text"],
    [{ input: "text", multiple: true }, "multi"],
    [{ input: "textarea", type: "text" }, "textarea"],
    [{ input: "textarea", type: "text", multiple: true }, "multi"],
    [{ input: "number", type: "integer" }, "number"],
    [{ input: "number", type: "quantity" }, "quantity"],
    [{ input: "checkbox", type: "boolean" }, "boolean"],
    [{ input: "date", type: "date" }, "date"],
    [{ input: "select", type: "enum" }, "enum"],
    [{ input: "multiselect", type: "enum", multiple: true }, "multi-enum"],
    [{ input: "autocomplete", type: "enum" }, "vocab"],
    [{ input: "autocomplete", type: "enum", multiple: true }, "multi-vocab"],
    [{ input: "autocomplete" }, "hint"],
    [{ input: "autocomplete", multiple: true }, "multi-hint"],
    [{ input: "object", type: "object" }, "object"],
    [{ input: "object", type: "object", multiple: true }, "object-list"],
  ])("%o → %s", (over, kind) => expect(kindOf(over)).toBe(kind));
});

describe("orderedFields", () => {
  it("orders by group, then by field order", () => {
    expect(orderedFields(SNAPSHOT).slice(0, 4).map((f) => f.key)).toEqual([
      "title",
      "collectionType",
      "issue",
      "cobissId",
    ]);
  });
});

describe("inlineOptions", () => {
  it("lists a small vocabulary and nothing for a searched one", () => {
    const byKey = new Map(SNAPSHOT.fields.map((f) => [f.key, f]));
    expect(inlineOptions(SNAPSHOT, byKey.get("collectionType")!).map((v) => v.code)).toEqual([0, 1, 3, 4]);
    expect(inlineOptions(SNAPSHOT, byKey.get("language")!)).toEqual([]);
  });
});

describe("splitByVisibility", () => {
  it("keeps hidden fields that hold a value apart, and drops hidden empty ones", () => {
    const a = fieldV2({ key: "a" });
    const b = fieldV2({ key: "b" });
    const c = fieldV2({ key: "c" });
    const state = (visible: boolean) => ({ visible }) as FieldState;
    const split = splitByVisibility([a, b, c], { a: state(true), b: state(false), c: state(false) }, { c: "kept" });
    expect(split.shown.map((f) => f.key)).toEqual(["a"]);
    expect(split.other.map((f) => f.key)).toEqual(["c"]);
  });
});

describe("paths", () => {
  it("drops indices for the state path", () => {
    expect(statePathOf("authors[1].role")).toBe("authors.role");
  });

  it("finds the field at a path", () => {
    expect(fieldAtPath(SNAPSHOT.fields, "authors[1].role")?.key).toBe("role");
    expect(fieldAtPath(SNAPSHOT.fields, "authors[1]")?.key).toBe("authors");
    expect(fieldAtPath(SNAPSHOT.fields, "nope")).toBeNull();
  });
});
