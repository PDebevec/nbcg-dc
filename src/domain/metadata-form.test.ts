import { describe, it, expect } from "vitest";
import type { FieldDescriptor, RecordSchema } from "./schema";
import {
  fieldsForLevel,
  buildFormModel,
  isEmptyValue,
  optionLabel,
  humanizeKey,
  validateField,
  validateItem,
  isItemValid,
  itemReadiness,
  firstIncompleteIndex,
  readyProgress,
  canAdvance,
  flattenValues,
  toMetadataValues,
  pruneToSchema,
} from "./metadata-form";

function field(over: Partial<FieldDescriptor> & { key: string }): FieldDescriptor {
  return {
    type: "string",
    required: false,
    group: "basic",
    order: 0,
    parentInheritable: false,
    issueIdentifying: false,
    levels: ["main"],
    ...over,
  };
}

const language = field({
  key: "language",
  type: "enum",
  group: "publication",
  order: 5,
  levels: ["main", "child"],
  allowedValues: [
    { code: "cnr", en: "Montenegrin", cnr: "Crnogorski" },
    { code: "srp", en: "Serbian", cnr: "Srpski" },
  ],
});

const schema: RecordSchema = {
  fields: [
    field({ key: "author", group: "basic", order: 2 }),
    field({ key: "title", group: "basic", order: 1, required: true }),
    language,
    field({
      key: "subject",
      type: "array",
      itemType: "string",
      group: "publication",
      order: 6,
    }),
    field({
      key: "issueNo",
      group: "issue",
      order: 3,
      required: true,
      issueIdentifying: true,
      levels: ["child"],
    }),
  ],
};

describe("fieldsForLevel + buildFormModel (task 2)", () => {
  it("filters fields to the requested level", () => {
    expect(fieldsForLevel(schema, "main").map((f) => f.key)).toEqual([
      "author",
      "title",
      "language",
      "subject",
    ]);
    expect(fieldsForLevel(schema, "child").map((f) => f.key)).toEqual([
      "language",
      "issueNo",
    ]);
  });

  it("sorts the flat list by order then key", () => {
    expect(buildFormModel(schema, "main").fields.map((f) => f.key)).toEqual([
      "title", // order 1
      "author", // order 2
      "language", // order 5
      "subject", // order 6
    ]);
  });

  it("groups fields, ordering groups by their earliest field", () => {
    const groups = buildFormModel(schema, "main").groups;
    expect(groups.map((g) => g.key)).toEqual(["basic", "publication"]);
    expect(groups[0].fields.map((f) => f.key)).toEqual(["title", "author"]);
    expect(groups[1].fields.map((f) => f.key)).toEqual(["language", "subject"]);
  });
});

describe("isEmptyValue", () => {
  it("treats null/undefined/blank strings/empty arrays as empty", () => {
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue("   ")).toBe(true);
    expect(isEmptyValue([])).toBe(true);
  });

  it("treats false and 0 as present values", () => {
    expect(isEmptyValue(false)).toBe(false);
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue("x")).toBe(false);
    expect(isEmptyValue(["a"])).toBe(false);
  });
});

describe("labels", () => {
  it("optionLabel prefers Montenegrin, falls back to English then code", () => {
    expect(optionLabel({ code: "cnr", en: "Montenegrin", cnr: "Crnogorski" })).toBe(
      "Crnogorski",
    );
    expect(
      optionLabel({ code: "cnr", en: "Montenegrin", cnr: "Crnogorski" }, "en"),
    ).toBe("Montenegrin");
    expect(optionLabel({ code: "x", en: "", cnr: "" })).toBe("x");
  });

  it("humanizeKey splits camelCase and snake/kebab case", () => {
    expect(humanizeKey("publicationYear")).toBe("Publication year");
    expect(humanizeKey("serial_title")).toBe("Serial title");
    expect(humanizeKey("issue-no")).toBe("Issue no");
  });
});

describe("validateField (task 3)", () => {
  const title = field({ key: "title", required: true });

  it("flags a required field left empty", () => {
    expect(validateField(title, "")?.code).toBe("required");
    expect(validateField(title, "Gorski vijenac")).toBeNull();
  });

  it("passes an optional empty field", () => {
    expect(validateField(field({ key: "author" }), "")).toBeNull();
  });

  it("constrains enum values to allowed codes", () => {
    expect(validateField(language, "cnr")).toBeNull();
    expect(validateField(language, "de")?.code).toBe("not_allowed");
  });

  it("checks array shape and array-of-enum membership", () => {
    const multi = field({ key: "subject", type: "array", itemType: "string" });
    expect(validateField(multi, ["poetry"])).toBeNull();
    expect(validateField(multi, "not-a-list")?.code).toBe("wrong_type");

    const langs = field({
      key: "langs",
      type: "array",
      itemType: "enum",
      allowedValues: language.allowedValues,
    });
    expect(validateField(langs, ["cnr", "srp"])).toBeNull();
    expect(validateField(langs, ["cnr", "xx"])?.code).toBe("not_allowed");
  });

  it("rejects a non-numeric string on a number field", () => {
    const year = field({ key: "year", type: "number" });
    expect(validateField(year, "1847")).toBeNull();
    expect(validateField(year, 1847)).toBeNull();
    expect(validateField(year, "soon")?.code).toBe("wrong_type");
  });
});

describe("validateItem / isItemValid", () => {
  const mainFields = fieldsForLevel(schema, "main");

  it("collects one error per invalid field", () => {
    const errors = validateItem(mainFields, { language: "de" });
    // title required + language not allowed
    expect(errors.map((e) => e.key).sort()).toEqual(["language", "title"]);
    expect(isItemValid(mainFields, { language: "de" })).toBe(false);
  });

  it("passes when required fields are filled and enums are valid", () => {
    expect(
      isItemValid(mainFields, { title: "Gorski vijenac", language: "cnr" }),
    ).toBe(true);
  });
});

describe("navigator status + gating (tasks 4 & 5)", () => {
  const mainFields = fieldsForLevel(schema, "main");

  it("is untouched when nothing is entered", () => {
    expect(itemReadiness(mainFields, {})).toBe("untouched");
  });

  it("is incomplete when touched but a required field is missing", () => {
    expect(itemReadiness(mainFields, { author: "Njegoš" })).toBe("incomplete");
  });

  it("is ready when all required/enum rules pass", () => {
    expect(
      itemReadiness(mainFields, { title: "Gorski vijenac", language: "cnr" }),
    ).toBe("ready");
  });

  it("honours an explicit touched override", () => {
    // Empty but explicitly opened → not untouched, so it reads as incomplete.
    expect(itemReadiness(mainFields, {}, { touched: true })).toBe("incomplete");
  });

  it("firstIncompleteIndex finds the first non-ready item (or -1)", () => {
    expect(
      firstIncompleteIndex(["ready", "ready", "incomplete", "untouched"]),
    ).toBe(2);
    expect(firstIncompleteIndex(["ready", "ready"])).toBe(-1);
  });

  it("readyProgress and canAdvance summarise the batch", () => {
    expect(readyProgress(["ready", "incomplete", "ready"])).toEqual({
      ready: 2,
      total: 3,
    });
    expect(canAdvance(["ready", "ready"])).toBe(true);
    expect(canAdvance(["ready", "incomplete"])).toBe(false);
    expect(canAdvance([])).toBe(false);
  });
});

describe("value adapters (task 9 groundwork)", () => {
  it("flattenValues pulls the value out of the provenance map", () => {
    expect(
      flattenValues({
        title: { value: "Gorski vijenac", provenance: "cobiss" },
        language: { value: "cnr", provenance: "user" },
      }),
    ).toEqual({ title: "Gorski vijenac", language: "cnr" });
  });

  it("toMetadataValues wraps values with a provenance and can drop unknowns", () => {
    const values = toMetadataValues(
      { title: "T", stale: "x" },
      "cobiss",
      fieldsForLevel(schema, "main"),
    );
    expect(values.title).toEqual({ value: "T", provenance: "cobiss" });
    expect(values.stale).toBeUndefined(); // not a schema field → dropped
  });
});

describe("pruneToSchema (task 12 — schema evolution)", () => {
  const mainFields = fieldsForLevel(schema, "main");

  it("drops unknown keys and empty values by default", () => {
    expect(
      pruneToSchema({ title: "T", author: "", legacy: "gone" }, mainFields),
    ).toEqual({ title: "T" });
  });

  it("keeps empty known keys when dropEmpty is false", () => {
    expect(
      pruneToSchema({ title: "T", author: "" }, mainFields, { dropEmpty: false }),
    ).toEqual({ title: "T", author: "" });
  });
});
