import { describe, expect, it } from "vitest";
import { fieldV2, schemaV2, SNAPSHOT } from "./schema.fixture";
import {
  defaultValues,
  formatErrors,
  getAtPath,
  isPartialDate,
  isUntouched,
  normalizeRecord,
  normalizeValue,
  numberFromText,
  pruneForUpload,
  quantityFromText,
  setAtPath,
  topKey,
} from "./schema-values";

const language = fieldV2({
  key: "language",
  type: "enum",
  multiple: true,
  input: "autocomplete",
  values: { vocabulary: "language", storeAs: "resolvedCode" },
});
const collectionType = fieldV2({
  key: "collectionType",
  type: "enum",
  input: "select",
  values: { vocabulary: "collectionType", storeAs: "code" },
  default: 0,
});
const materialType = fieldV2({
  key: "materialType",
  type: "enum",
  input: "select",
  values: { vocabulary: "materialType", storeAs: "resolvedCode" },
});
const authors = fieldV2({
  key: "authors",
  type: "object",
  multiple: true,
  input: "object",
  objectShape: [
    fieldV2({ key: "familyName" }),
    fieldV2({
      key: "responsibility",
      type: "enum",
      input: "select",
      values: { vocabulary: "responsibility", storeAs: "code" },
    }),
  ],
});
const extent = fieldV2({ key: "extent", type: "quantity", input: "number" });
const year = fieldV2({ key: "year", type: "integer", input: "number" });
const date = fieldV2({ key: "date", type: "date", input: "date" });

const SCHEMA = schemaV2([language, collectionType, materialType, authors, extent, year, date], {
  language: { size: 449, search: { path: "/search/vocabularies/language?limit=5", queryParam: "q", minChars: 1 } },
  collectionType: {
    size: 2,
    values: [
      { code: 0, en: "Not a collection", cnr: "Nije zbirka" },
      { code: 4, en: "Serial collection", cnr: "Serijska zbirka" },
    ],
  },
  materialType: { size: 1, values: [{ code: "am", en: "Book", cnr: "Knjiga" }] },
  responsibility: { size: 1, values: [{ code: "primary", en: "Primary", cnr: "Primarna" }] },
});

const PAGES = { code: "pages", en: "p.", cnr: "str." };

describe("normalizeValue", () => {
  it("expands a bare code into the stored { code, en, cnr }", () => {
    expect(normalizeValue(SCHEMA, materialType, "am")).toEqual({ code: "am", en: "Book", cnr: "Knjiga" });
  });

  it("keeps a searched-vocabulary object as it is", () => {
    const cnr = { code: "cnr", en: "Montenegrin", cnr: "Crnogorski" };
    expect(normalizeValue(SCHEMA, language, [cnr])).toEqual([cnr]);
  });

  it("stubs an unknown code instead of dropping it", () => {
    expect(normalizeValue(SCHEMA, language, ["xx"])).toEqual([{ code: "xx", en: "xx", cnr: "xx" }]);
  });

  it("reduces to the bare code where storeAs is code, repairing a numeric string", () => {
    expect(normalizeValue(SCHEMA, collectionType, "4")).toBe(4);
    expect(normalizeValue(SCHEMA, collectionType, { code: 4, en: "", cnr: "" })).toBe(4);
  });

  it("recurses into repeatable objects", () => {
    expect(
      normalizeValue(SCHEMA, authors, [
        { familyName: "Njegoš", responsibility: { code: "primary", en: "Primary", cnr: "Primarna" } },
      ]),
    ).toEqual([{ familyName: "Njegoš", responsibility: "primary" }]);
  });

  it("turns a numeric string into a number for integer fields", () => {
    expect(normalizeValue(SCHEMA, year, "1847")).toBe(1847);
  });
});

describe("normalizeRecord", () => {
  it("normalises known keys and passes unknown ones through", () => {
    expect(normalizeRecord(SCHEMA, { materialType: "am", _source: "cobiss" })).toEqual({
      materialType: { code: "am", en: "Book", cnr: "Knjiga" },
      _source: "cobiss",
    });
  });
});

describe("numberFromText / quantityFromText", () => {
  it("parses numbers, turns blanks into null, keeps junk for the format check", () => {
    expect(numberFromText(" 253 ")).toBe(253);
    expect(numberFromText("")).toBeNull();
    expect(numberFromText("12a")).toBe("12a");
  });

  it("writes the evaluated unit next to the number", () => {
    expect(quantityFromText("253", { unit: PAGES })).toEqual({ value: 253, unit: "pages" });
    expect(quantityFromText("", { unit: PAGES })).toBeNull();
    expect(quantityFromText("253", { unit: null })).toBeNull();
  });
});

describe("pruneForUpload", () => {
  it("drops unknown keys and blanks but keeps false, 0 and hidden fields", () => {
    const schema = schemaV2([
      fieldV2({ key: "title" }),
      fieldV2({ key: "flag", type: "boolean", input: "checkbox" }),
      fieldV2({ key: "n", type: "integer", input: "number", visible: false }),
      fieldV2({ key: "notes", multiple: true }),
    ]);
    expect(pruneForUpload(schema, { title: "  ", flag: false, n: 0, notes: ["", "a"], other: "x" })).toEqual({
      flag: false,
      n: 0,
      notes: ["a"],
    });
  });

  it("cleans nested objects and drops entries left empty", () => {
    expect(
      pruneForUpload(SCHEMA, { authors: [{ familyName: "" }, { familyName: "Njegoš", responsibility: "" }] }),
    ).toEqual({ authors: [{ familyName: "Njegoš" }] });
  });
});

describe("formatErrors", () => {
  it("flags a word in a number box and an unreadable date", () => {
    const errors = formatErrors(SCHEMA, { year: "18a", date: "1950-13" });
    expect(errors.map((e) => e.path)).toEqual(["year", "date"]);
    expect(errors.every((e) => e.constraint === "format")).toBe(true);
  });

  it("flags a negative quantity", () => {
    expect(formatErrors(SCHEMA, { extent: { value: -1, unit: "pages" } }).map((e) => e.path)).toEqual(["extent"]);
  });

  it("accepts good values", () => {
    expect(formatErrors(SCHEMA, { year: 1847, date: "1950-03", extent: { value: 253, unit: "pages" } })).toEqual([]);
  });
});

describe("isPartialDate", () => {
  it.each<[string, boolean]>([
    ["1950", true],
    ["1950-03", true],
    ["1950-03-12", true],
    ["2023-02-30", false],
    ["1950-3", false],
    ["", false],
  ])("%s → %s", (value, ok) => expect(isPartialDate(value)).toBe(ok));
});

describe("defaultValues / isUntouched", () => {
  it("starts a new item from the schema's defaults", () => {
    expect(defaultValues(SNAPSHOT)).toEqual({ collectionType: 0 });
  });

  it("counts only defaults and blanks as untouched", () => {
    expect(isUntouched(SCHEMA, { collectionType: 0, language: [] })).toBe(true);
    expect(isUntouched(SCHEMA, { collectionType: 4 })).toBe(false);
  });
});

describe("paths", () => {
  it("finds the top-level key", () => {
    expect(topKey("authors[1].role")).toBe("authors");
    expect(topKey("title")).toBe("title");
  });

  it("sets a value deep inside a copy", () => {
    const root = [{ familyName: "A" }];
    expect(setAtPath(root, "[1].familyName", "B")).toEqual([{ familyName: "A" }, { familyName: "B" }]);
    expect(root).toEqual([{ familyName: "A" }]);
    expect(setAtPath(undefined, ".place", "Cetinje")).toEqual({ place: "Cetinje" });
  });

  it("reads a value deep inside", () => {
    expect(getAtPath([{ familyName: "A" }], "[0].familyName")).toBe("A");
    expect(getAtPath(undefined, ".place")).toBeUndefined();
  });
});
