import { describe, it, expect } from "vitest";
import { fieldV2 } from "./schema.fixture";
import type { MetadataValues } from "./metadata";
import type { ParentRecord } from "./parent";
import {
  fillValues,
  parentInheritableValues,
  cobissValues,
  applyParentFields,
  parentOverwrites,
  applySerialParent,
  applyCobiss,
  fieldSourceOptions,
  chooseFieldSource,
  issueFields,
  stillToFill,
  routeCase,
  caseBehavior,
  flattenValues,
  toMetadataValues,
} from "./provenance";

// A child (serial issue) field set: shared parent fields + per-issue fields.
const serialTitle = fieldV2({ key: "serialTitle", parentInheritable: true });
const publisher = fieldV2({ key: "publisher", parentInheritable: true });
const place = fieldV2({ key: "place", parentInheritable: true });
const issueNo = fieldV2({ key: "issueNo", issueIdentifying: true, required: true });
const volumeYear = fieldV2({ key: "volumeYear", issueIdentifying: true, required: true });
const FIELDS = [serialTitle, publisher, place, issueNo, volumeYear];

function parent(over: Partial<ParentRecord> & { id: string }): ParentRecord {
  return {
    title: over.title ?? `Parent ${over.id}`,
    collectionType: over.collectionType ?? 5,
    metadata: over.metadata ?? {},
    ...over,
  };
}

describe("parentInheritableValues", () => {
  it("keeps only inheritable, non-issue, non-empty fields, stamped parent", () => {
    const p = parent({
      id: "p1",
      metadata: {
        serialTitle: "Pobjeda",
        publisher: "NBCG",
        place: "   ", // whitespace → empty → dropped
        issueNo: "12", // issue-identifying → never inherited
        title: "ignored (not inheritable)",
      },
    });
    const values = parentInheritableValues(p, FIELDS);
    expect(Object.keys(values).sort()).toEqual(["publisher", "serialTitle"]);
    expect(values.serialTitle).toEqual({
      value: "Pobjeda",
      provenance: "parent",
      sourceParentId: "p1",
    });
  });
});

describe("applyParentFields", () => {
  it("fills empty inheritable fields and flags issue fields still-to-fill", () => {
    const p = parent({
      id: "p1",
      metadata: { serialTitle: "Pobjeda", publisher: "NBCG" },
    });
    const result = applyParentFields({}, p, FIELDS);
    expect(result.values.serialTitle?.value).toBe("Pobjeda");
    expect(result.values.publisher?.provenance).toBe("parent");
    expect(result.conflicts).toHaveLength(0);
    expect(result.stillToFill.sort()).toEqual(["issueNo", "volumeYear"]);
  });

  it("never overwrites an existing value (parent only fills empties)", () => {
    const current: MetadataValues = {
      publisher: { value: "Hand-typed", provenance: "user" },
    };
    const p = parent({ id: "p1", metadata: { serialTitle: "Pobjeda", publisher: "NBCG" } });
    const result = applyParentFields(current, p, FIELDS);
    expect(result.values.publisher).toEqual({ value: "Hand-typed", provenance: "user" });
    expect(result.values.serialTitle?.value).toBe("Pobjeda"); // empty → filled
    expect(result.conflicts).toHaveLength(0); // parent never conflicts
    expect(result.skipped).toContain("publisher");
  });

  it("applySerialParent behaves identically (case 4)", () => {
    const p = parent({ id: "p1", metadata: { serialTitle: "Pobjeda" } });
    expect(applySerialParent({}, p, FIELDS)).toEqual(applyParentFields({}, p, FIELDS));
  });
});

describe("a parent replacing values the item already has", () => {
  const p = parent({ id: "p1", metadata: { serialTitle: "Pobjeda", publisher: "NBCG", place: "Cetinje" } });

  it("lists the filled-in fields whose value it would change, whoever filled them in", () => {
    const current: MetadataValues = {
      serialTitle: { value: "Dan", provenance: "user" },
      publisher: { value: "Other", provenance: "parent", sourceParentId: "p0" },
      place: { value: "Cetinje", provenance: "cobiss" }, // the same value: nothing to replace
    };
    expect(parentOverwrites(current, p, FIELDS)).toEqual([
      { key: "serialTitle", currentValue: "Dan", incomingValue: "Pobjeda", incomingProvenance: "parent" },
      { key: "publisher", currentValue: "Other", incomingValue: "NBCG", incomingProvenance: "parent" },
    ]);
  });

  it("treats a code list in another key order as the same value", () => {
    const lang = fieldV2({ key: "language", parentInheritable: true });
    const withLanguage = parent({ id: "p1", metadata: { language: [{ code: "cnr", en: "Montenegrin", cnr: "Crnogorski" }] } });
    const current: MetadataValues = {
      language: { value: [{ cnr: "Crnogorski", code: "cnr", en: "Montenegrin" }], provenance: "user" },
    };
    expect(parentOverwrites(current, withLanguage, [lang])).toEqual([]);
  });

  it("replaces them in overwrite-all mode, and fills the empty ones too", () => {
    const current: MetadataValues = {
      serialTitle: { value: "Dan", provenance: "user" },
      publisher: { value: "Other", provenance: "parent", sourceParentId: "p0" },
    };
    const result = applyParentFields(current, p, FIELDS, "overwrite-all");
    expect(result.values.serialTitle).toEqual({ value: "Pobjeda", provenance: "parent", sourceParentId: "p1" });
    expect(result.values.publisher).toEqual({ value: "NBCG", provenance: "parent", sourceParentId: "p1" });
    expect(result.values.place?.value).toBe("Cetinje");
  });
});

describe("an object field a parent passes in part (publication)", () => {
  const publication = fieldV2({
    key: "publication",
    type: "object",
    input: "object",
    parentInheritable: true,
    objectShape: [
      fieldV2({ key: "place", parentInheritable: true }),
      fieldV2({ key: "publisher", parentInheritable: true }),
      fieldV2({ key: "year", issueIdentifying: true }),
      fieldV2({ key: "placeOfManufacture" }),
    ],
  });
  const obod = parent({
    id: "p1",
    metadata: {
      publication: { place: "Cetinje", publisher: "Obod", year: "1944", placeOfManufacture: "Podgorica" },
    },
  });

  it("passes only the sub-fields the schema marks inheritable, never the year", () => {
    expect(parentInheritableValues(obod, [publication]).publication?.value).toEqual({
      place: "Cetinje",
      publisher: "Obod",
    });
  });

  it("fills the item's empty sub-fields and keeps the year it already has", () => {
    const current: MetadataValues = { publication: { value: { year: "1950" }, provenance: "user" } };
    const result = applyParentFields(current, obod, [publication]);
    expect(result.values.publication?.value).toEqual({ year: "1950", place: "Cetinje", publisher: "Obod" });
    expect(result.applied).toEqual(["publication"]);
  });

  it("counts only a passed sub-field held differently as replaced, and overwriting keeps the year", () => {
    const yearOnly: MetadataValues = { publication: { value: { year: "1950" }, provenance: "user" } };
    expect(parentOverwrites(yearOnly, obod, [publication])).toEqual([]);

    const current: MetadataValues = {
      publication: { value: { year: "1950", place: "Nikšić" }, provenance: "user" },
    };
    expect(parentOverwrites(current, obod, [publication])).toEqual([
      {
        key: "publication",
        currentValue: { place: "Nikšić" },
        incomingValue: { place: "Cetinje", publisher: "Obod" },
        incomingProvenance: "parent",
      },
    ]);
    const result = applyParentFields(current, obod, [publication], "overwrite-all");
    expect(result.values.publication?.value).toEqual({ year: "1950", place: "Cetinje", publisher: "Obod" });
  });

  it("offers only the passed part as a field source, and picking it keeps the item's year", () => {
    const [option] = fieldSourceOptions(publication, {}, [obod]).filter((o) => o.kind === "parent");
    expect(option.value).toEqual({ place: "Cetinje", publisher: "Obod" });
    const current: MetadataValues = {
      publication: { value: { year: "1950", place: "Nikšić" }, provenance: "user" },
    };
    expect(chooseFieldSource(current, publication, option).publication).toEqual({
      value: { year: "1950", place: "Cetinje", publisher: "Obod" },
      provenance: "parent",
      sourceParentId: "p1",
    });
  });
});

describe("cobissValues", () => {
  it("keeps schema keys, drops unknown + empty, stamps cobiss", () => {
    const record = {
      serialTitle: "Pobjeda",
      publisher: "",
      unknownKey: "x",
      issueNo: "12",
    };
    const values = cobissValues(record, FIELDS);
    expect(Object.keys(values).sort()).toEqual(["issueNo", "serialTitle"]);
    expect(values.serialTitle.provenance).toBe("cobiss");
  });
});

describe("fillValues precedence", () => {
  const incoming: MetadataValues = { k: { value: "new", provenance: "cobiss" } };

  it("fills an empty field", () => {
    const out = fillValues({}, incoming, { overwriteMachine: false, onUserConflict: "skip-silent" });
    expect(out.values.k.value).toBe("new");
    expect(out.applied).toEqual(["k"]);
  });

  it("overwrites a machine value when overwriteMachine is true", () => {
    const current: MetadataValues = { k: { value: "old", provenance: "parent" } };
    const out = fillValues(current, incoming, { overwriteMachine: true, onUserConflict: "skip-silent" });
    expect(out.values.k).toEqual({ value: "new", provenance: "cobiss" });
  });

  it("keeps a machine value when overwriteMachine is false", () => {
    const current: MetadataValues = { k: { value: "old", provenance: "parent" } };
    const out = fillValues(current, incoming, { overwriteMachine: false, onUserConflict: "skip-silent" });
    expect(out.values.k.value).toBe("old");
    expect(out.skipped).toEqual(["k"]);
  });

  it("keeps a user value silently under skip-silent (no conflict — the parent path)", () => {
    const current: MetadataValues = { k: { value: "mine", provenance: "user" } };
    const out = fillValues(current, incoming, { overwriteMachine: false, onUserConflict: "skip-silent" });
    expect(out.values.k.value).toBe("mine");
    expect(out.conflicts).toHaveLength(0);
    expect(out.skipped).toEqual(["k"]);
  });

  it("records a conflict but keeps a user value under skip-conflict", () => {
    const current: MetadataValues = { k: { value: "mine", provenance: "user" } };
    const out = fillValues(current, incoming, { overwriteMachine: true, onUserConflict: "skip-conflict" });
    expect(out.values.k.value).toBe("mine");
    expect(out.conflicts).toEqual([
      { key: "k", currentValue: "mine", incomingValue: "new", incomingProvenance: "cobiss" },
    ]);
  });

  it("replaces a user value under overwrite (still reports the conflict)", () => {
    const current: MetadataValues = { k: { value: "mine", provenance: "user" } };
    const out = fillValues(current, incoming, { overwriteMachine: true, onUserConflict: "overwrite" });
    expect(out.values.k.value).toBe("new");
    expect(out.conflicts).toHaveLength(1);
  });

  it("does not mutate the input map", () => {
    const current: MetadataValues = { k: { value: "old", provenance: "parent" } };
    fillValues(current, incoming, { overwriteMachine: true, onUserConflict: "skip-silent" });
    expect(current.k.value).toBe("old");
  });
});

describe("applyCobiss", () => {
  const record = { serialTitle: "Pobjeda", publisher: "NBCG" };

  it("fills empties and overrides parent copies silently", () => {
    const current: MetadataValues = {
      serialTitle: { value: "Old serial", provenance: "parent", sourceParentId: "p1" },
    };
    const out = applyCobiss(current, record, FIELDS);
    expect(out.values.serialTitle).toEqual({ value: "Pobjeda", provenance: "cobiss" });
    expect(out.values.publisher?.value).toBe("NBCG");
    expect(out.conflicts).toHaveLength(0);
  });

  it("keeps user values but reports the conflict in fill-empty mode", () => {
    const current: MetadataValues = {
      serialTitle: { value: "Hand-typed", provenance: "user" },
    };
    const out = applyCobiss(current, record, FIELDS, "fill-empty");
    expect(out.values.serialTitle.value).toBe("Hand-typed");
    expect(out.conflicts.map((c) => c.key)).toEqual(["serialTitle"]);
  });

  it("replaces user values in overwrite-all mode", () => {
    const current: MetadataValues = {
      serialTitle: { value: "Hand-typed", provenance: "user" },
    };
    const out = applyCobiss(current, record, FIELDS, "overwrite-all");
    expect(out.values.serialTitle.value).toBe("Pobjeda");
    expect(out.values.serialTitle.provenance).toBe("cobiss");
  });
});

describe("per-field source picker", () => {
  const p1 = parent({ id: "p1", metadata: { serialTitle: "Pobjeda", publisher: "NBCG" } });
  const p2 = parent({ id: "p2", metadata: { serialTitle: "Dan", publisher: "" } });

  it("lists parents with a non-empty inheritable value plus Manual", () => {
    const opts = fieldSourceOptions(serialTitle, {}, [p1, p2]);
    expect(opts).toEqual([
      { kind: "parent", parentId: "p1", value: "Pobjeda" },
      { kind: "parent", parentId: "p2", value: "Dan" },
      { kind: "manual", parentId: null, value: undefined },
    ]);
  });

  it("omits parents whose value is empty for the field", () => {
    const opts = fieldSourceOptions(publisher, {}, [p1, p2]);
    expect(opts.filter((o) => o.kind === "parent").map((o) => o.parentId)).toEqual(["p1"]);
  });

  it("offers only Manual for a non-inheritable field", () => {
    const nonInherit = fieldV2({ key: "title" });
    const opts = fieldSourceOptions(nonInherit, {}, [p1]);
    expect(opts).toEqual([{ kind: "manual", parentId: null, value: undefined }]);
  });

  it("chooses a parent source (provenance parent + sourceParentId)", () => {
    const next = chooseFieldSource({}, serialTitle, {
      kind: "parent",
      parentId: "p2",
      value: "Dan",
    });
    expect(next.serialTitle).toEqual({ value: "Dan", provenance: "parent", sourceParentId: "p2" });
  });

  it("Manual entry keeps the value but flips provenance to user", () => {
    const current: MetadataValues = {
      serialTitle: { value: "Pobjeda", provenance: "parent", sourceParentId: "p1" },
    };
    const next = chooseFieldSource(current, serialTitle, {
      kind: "manual",
      parentId: null,
      value: "Pobjeda",
    });
    expect(next.serialTitle).toEqual({ value: "Pobjeda", provenance: "user" });
  });
});

describe("issue fields", () => {
  it("lists issue-identifying fields", () => {
    expect(issueFields(FIELDS).map((f) => f.key).sort()).toEqual(["issueNo", "volumeYear"]);
  });

  it("stillToFill reports empty issue fields only", () => {
    const values: MetadataValues = { issueNo: { value: "12", provenance: "user" } };
    expect(stillToFill(FIELDS, values)).toEqual(["volumeYear"]);
  });
});

describe("case routing", () => {
  it("routes the four ingestion cases", () => {
    expect(routeCase({ parentCollectionTypes: [], hasCobissId: false })).toBe(1);
    expect(routeCase({ parentCollectionTypes: [], hasCobissId: true })).toBe(2);
    expect(routeCase({ parentCollectionTypes: [3], hasCobissId: true })).toBe(3);
    expect(routeCase({ parentCollectionTypes: [4], hasCobissId: false })).toBe(4);
    expect(routeCase({ parentCollectionTypes: [3], hasCobissId: false })).toBe(1);
  });

  it("maps each case to a primary path", () => {
    expect(caseBehavior({ parentCollectionTypes: [4], hasCobissId: false })).toEqual({ case: 4, primary: "parent" });
  });
});

describe("flattenValues / toMetadataValues", () => {
  it("round-trips values, keeping only known keys", () => {
    const wrapped = toMetadataValues({ title: "T", bogus: 1 }, "user", new Set(["title"]));
    expect(wrapped).toEqual({ title: { value: "T", provenance: "user" } });
    expect(flattenValues(wrapped)).toEqual({ title: "T" });
  });
});
