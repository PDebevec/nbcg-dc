import { describe, expect, it } from "vitest";
import type { FieldDescriptor } from "./schema";
import {
  isBlankObject,
  toFormRecord,
  toFormValue,
  toWireRecord,
  toWireValue,
} from "./metadata-wire";

function field(partial: Partial<FieldDescriptor> & { key: string }): FieldDescriptor {
  return {
    type: "string",
    required: false,
    group: "basic",
    order: 0,
    parentInheritable: false,
    issueIdentifying: false,
    levels: ["main"],
    ...partial,
  };
}

const LANG = [
  { code: "cnr", en: "Montenegrin", cnr: "Crnogorski" },
  { code: "srp", en: "Serbian", cnr: "Srpski" },
];

const recordType = field({ key: "recordType", type: "enum", allowedValues: LANG });
const language = field({ key: "language", type: "array", itemType: "enum", allowedValues: LANG });
const collectionType = field({ key: "collectionType", type: "number" });
const publication = field({
  key: "publication",
  type: "object",
  objectShape: [
    field({ key: "place" }),
    field({ key: "year" }),
  ],
});
const authors = field({
  key: "authors",
  type: "array",
  itemType: "object",
  objectShape: [
    field({ key: "familyName" }),
    field({ key: "role", type: "enum", allowedValues: [{ code: "aut", en: "Author", cnr: "Autor" }] }),
  ],
});

describe("toFormValue (wire → form)", () => {
  it("unwraps a ResolvedCode to its code", () => {
    expect(toFormValue(recordType, { code: "cnr", en: "x", cnr: "y" })).toBe("cnr");
    expect(toFormValue(recordType, "cnr")).toBe("cnr");
  });

  it("maps enum arrays and nested object enums", () => {
    expect(toFormValue(language, [{ code: "cnr", en: "", cnr: "" }, "srp"])).toEqual(["cnr", "srp"]);
    expect(
      toFormValue(authors, [{ familyName: "Njegoš", role: { code: "aut", en: "Author", cnr: "Autor" } }]),
    ).toEqual([{ familyName: "Njegoš", role: "aut" }]);
  });

  it("passes null/undefined and unknown shapes through", () => {
    expect(toFormValue(recordType, null)).toBeNull();
    expect(toFormValue(language, "not-a-list")).toBe("not-a-list");
  });
});

describe("toWireValue (form → wire)", () => {
  it("resolves a code against allowedValues (stub for unknown codes)", () => {
    expect(toWireValue(recordType, "cnr")).toEqual(LANG[0]);
    expect(toWireValue(recordType, "zzz")).toEqual({ code: "zzz", en: "zzz", cnr: "zzz" });
    expect(toWireValue(recordType, "")).toBe("");
  });

  it("coerces numeric strings for number fields, leaves junk alone", () => {
    expect(toWireValue(collectionType, "3")).toBe(3);
    expect(toWireValue(collectionType, " 12 ")).toBe(12);
    expect(toWireValue(collectionType, "abc")).toBe("abc");
    expect(toWireValue(collectionType, 7)).toBe(7);
  });

  it("drops blanks inside objects and resolves nested enums", () => {
    expect(toWireValue(publication, { place: "Cetinje", year: "" })).toEqual({ place: "Cetinje" });
    expect(toWireValue(authors, [{ familyName: "Njegoš", role: "aut" }])).toEqual([
      { familyName: "Njegoš", role: { code: "aut", en: "Author", cnr: "Autor" } },
    ]);
  });
});

describe("record helpers", () => {
  const fields = [recordType, language, collectionType, publication];

  it("round-trips a wire record through the form shape", () => {
    const wire = {
      recordType: LANG[1],
      language: [LANG[0]],
      collectionType: 2,
      publication: { place: "Cetinje" },
      unknownKey: "kept",
    };
    const form = toFormRecord(fields, wire);
    expect(form).toEqual({
      recordType: "srp",
      language: ["cnr"],
      collectionType: 2,
      publication: { place: "Cetinje" },
      unknownKey: "kept",
    });
    expect(toWireRecord(fields, form)).toEqual(wire);
  });

  it("detects blank objects", () => {
    expect(isBlankObject({ place: "", year: null })).toBe(true);
    expect(isBlankObject({ place: "Cetinje" })).toBe(false);
    expect(isBlankObject("x")).toBe(false);
  });
});
