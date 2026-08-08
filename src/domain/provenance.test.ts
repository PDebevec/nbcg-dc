import { describe, it, expect } from "vitest";
import type { FieldDescriptor } from "./schema";
import type { MetadataValues } from "./metadata";
import type { ParentRecord } from "./parent";
import {
  fillValues,
  parentInheritableValues,
  cobissValues,
  applyParentFields,
  applySerialParent,
  applyCobiss,
  fieldSourceOptions,
  chooseFieldSource,
  issueFields,
  stillToFill,
  routeCase,
  caseBehavior,
} from "./provenance";

function field(over: Partial<FieldDescriptor> & { key: string }): FieldDescriptor {
  return {
    type: "string",
    required: false,
    group: "basic",
    order: 0,
    parentInheritable: false,
    issueIdentifying: false,
    levels: ["main", "child"],
    ...over,
  };
}

// A child (serial issue) field set: shared parent fields + per-issue fields.
const serialTitle = field({ key: "serialTitle", parentInheritable: true });
const publisher = field({ key: "publisher", parentInheritable: true });
const place = field({ key: "place", parentInheritable: true });
const issueNo = field({ key: "issueNo", issueIdentifying: true, required: true });
const volumeYear = field({ key: "volumeYear", issueIdentifying: true, required: true });
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
    const nonInherit = field({ key: "title" });
    const opts = fieldSourceOptions(nonInherit, {}, [p1]);
    expect(opts).toEqual([{ kind: "manual", parentId: null, value: undefined }]);
  });

  it("chooses a parent source (provenance parent + sourceParentId)", () => {
    const next = chooseFieldSource({}, "serialTitle", {
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
    const next = chooseFieldSource(current, "serialTitle", {
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
    expect(routeCase({ level: "main", hasCobissId: false })).toBe(1);
    expect(routeCase({ level: "main", hasCobissId: true })).toBe(2);
    expect(routeCase({ level: "child", hasCobissId: true })).toBe(3);
    expect(routeCase({ level: "child", hasCobissId: false })).toBe(4);
  });

  it("maps each case to a primary path", () => {
    expect(caseBehavior({ level: "main", hasCobissId: false })).toEqual({ case: 1, primary: "manual" });
    expect(caseBehavior({ level: "main", hasCobissId: true }).primary).toBe("cobiss");
    expect(caseBehavior({ level: "child", hasCobissId: true }).primary).toBe("cobiss");
    expect(caseBehavior({ level: "child", hasCobissId: false })).toEqual({ case: 4, primary: "parent" });
  });
});
