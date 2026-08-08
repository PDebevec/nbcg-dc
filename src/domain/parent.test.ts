import { describe, it, expect } from "vitest";
import type { ParentRecord, ParentRef } from "./parent";
import {
  isDataPassingType,
  isEligibleParent,
  resolveLinkedParents,
  toParentRefs,
  setDataPassingParent,
  toggleDataPassing,
  dataPassingParentId,
  dataPassingParent,
  eligibleParents,
  withDefaultPassing,
  collectAncestors,
  wouldCreateCycle,
} from "./parent";

const SERIAL_TYPES = [5, 7];

function parent(over: Partial<ParentRecord> & { id: string }): ParentRecord {
  return {
    title: over.title ?? `Parent ${over.id}`,
    collectionType: over.collectionType ?? null,
    metadata: over.metadata ?? {},
    ...over,
  };
}

describe("eligibility", () => {
  it("is data-passing only for a collectionType in the set", () => {
    expect(isDataPassingType(5, SERIAL_TYPES)).toBe(true);
    expect(isDataPassingType(7, SERIAL_TYPES)).toBe(true);
    expect(isDataPassingType(1, SERIAL_TYPES)).toBe(false);
  });

  it("treats null/undefined collectionType as ineligible", () => {
    expect(isDataPassingType(null, SERIAL_TYPES)).toBe(false);
    expect(isDataPassingType(undefined, SERIAL_TYPES)).toBe(false);
    expect(isEligibleParent(parent({ id: "a" }), SERIAL_TYPES)).toBe(false);
  });

  it("resolves eligibility from a parent record", () => {
    expect(isEligibleParent(parent({ id: "a", collectionType: 5 }), SERIAL_TYPES)).toBe(true);
    expect(isEligibleParent(parent({ id: "b", collectionType: 2 }), SERIAL_TYPES)).toBe(false);
  });
});

describe("resolveLinkedParents", () => {
  const records = new Map<string, ParentRecord>([
    ["a", parent({ id: "a", collectionType: 5 })], // eligible
    ["b", parent({ id: "b", collectionType: 2 })], // ineligible
    ["c", parent({ id: "c", collectionType: 7 })], // eligible
  ]);

  it("recomputes eligibility and carries the record", () => {
    const links = resolveLinkedParents(
      [{ id: "a", passesData: false }, { id: "b", passesData: false }],
      records,
      SERIAL_TYPES,
    );
    expect(links.map((l) => l.eligible)).toEqual([true, false]);
    expect(links[0].record?.id).toBe("a");
  });

  it("forces an ineligible parent's passesData to false even if persisted true", () => {
    const links = resolveLinkedParents(
      [{ id: "b", passesData: true }],
      records,
      SERIAL_TYPES,
    );
    expect(links[0].passesData).toBe(false);
  });

  it("enforces at most one passesData (first eligible wins)", () => {
    const links = resolveLinkedParents(
      [{ id: "a", passesData: true }, { id: "c", passesData: true }],
      records,
      SERIAL_TYPES,
    );
    expect(links.filter((l) => l.passesData).map((l) => l.parentId)).toEqual(["a"]);
  });

  it("marks an unfetched (missing record) link ineligible", () => {
    const links = resolveLinkedParents([{ id: "zzz", passesData: true }], records, SERIAL_TYPES);
    expect(links[0].record).toBeNull();
    expect(links[0].eligible).toBe(false);
    expect(links[0].passesData).toBe(false);
  });

  it("round-trips to persisted refs", () => {
    const links = resolveLinkedParents(
      [{ id: "a", passesData: true }, { id: "b", passesData: false }],
      records,
      SERIAL_TYPES,
    );
    const refs: ParentRef[] = toParentRefs(links);
    expect(refs).toEqual([
      { id: "a", passesData: true },
      { id: "b", passesData: false },
    ]);
  });
});

describe("the one-passes-data invariant", () => {
  const links = resolveLinkedParents(
    [{ id: "a", passesData: false }, { id: "c", passesData: false }, { id: "b", passesData: false }],
    new Map<string, ParentRecord>([
      ["a", parent({ id: "a", collectionType: 5 })],
      ["c", parent({ id: "c", collectionType: 7 })],
      ["b", parent({ id: "b", collectionType: 2 })],
    ]),
    SERIAL_TYPES,
  );

  it("sets a single passer and clears the rest", () => {
    const next = setDataPassingParent(links, "c");
    expect(dataPassingParentId(next)).toBe("c");
    expect(next.filter((l) => l.passesData)).toHaveLength(1);
  });

  it("refuses to pass data through an ineligible parent", () => {
    const next = setDataPassingParent(links, "b");
    expect(dataPassingParentId(next)).toBeNull();
  });

  it("clears everyone when passed null", () => {
    const set = setDataPassingParent(links, "a");
    expect(dataPassingParentId(setDataPassingParent(set, null))).toBeNull();
  });

  it("toggles off when the same parent is toggled again", () => {
    const on = toggleDataPassing(links, "a");
    expect(dataPassingParentId(on)).toBe("a");
    const off = toggleDataPassing(on, "a");
    expect(dataPassingParentId(off)).toBeNull();
  });

  it("toggling a new parent moves the flag", () => {
    const on = toggleDataPassing(links, "a");
    const moved = toggleDataPassing(on, "c");
    expect(dataPassingParentId(moved)).toBe("c");
  });

  it("dataPassingParent returns the resolved link", () => {
    const next = setDataPassingParent(links, "a");
    expect(dataPassingParent(next)?.parentId).toBe("a");
    expect(dataPassingParent(links)).toBeNull();
  });

  it("lists eligible parents", () => {
    expect(eligibleParents(links).map((l) => l.parentId)).toEqual(["a", "c"]);
  });
});

describe("withDefaultPassing", () => {
  const recs = new Map<string, ParentRecord>([
    ["a", parent({ id: "a", collectionType: 5 })],
    ["c", parent({ id: "c", collectionType: 7 })],
    ["b", parent({ id: "b", collectionType: 2 })],
  ]);

  it("auto-selects the sole eligible parent", () => {
    const links = resolveLinkedParents(
      [{ id: "a", passesData: false }, { id: "b", passesData: false }],
      recs,
      SERIAL_TYPES,
    );
    expect(dataPassingParentId(withDefaultPassing(links))).toBe("a");
  });

  it("leaves the choice open when two are eligible", () => {
    const links = resolveLinkedParents(
      [{ id: "a", passesData: false }, { id: "c", passesData: false }],
      recs,
      SERIAL_TYPES,
    );
    expect(dataPassingParentId(withDefaultPassing(links))).toBeNull();
  });

  it("does not override an existing choice", () => {
    const links = setDataPassingParent(
      resolveLinkedParents([{ id: "a", passesData: false }, { id: "c", passesData: false }], recs, SERIAL_TYPES),
      "c",
    );
    expect(dataPassingParentId(withDefaultPassing(links))).toBe("c");
  });
});

describe("cycle-safe traversal", () => {
  // graph: a → b → c → a  (a cycle), plus d → b
  const edges: Record<string, string[]> = {
    a: ["b"],
    b: ["c"],
    c: ["a"],
    d: ["b"],
  };
  const getParents = (id: string) => edges[id] ?? [];

  it("terminates on a cyclic graph and collects reachable ancestors", () => {
    const ancestors = collectAncestors(["d"], getParents);
    expect([...ancestors].sort()).toEqual(["a", "b", "c"]);
  });

  it("includes a start id only when a cycle reaches back to it", () => {
    expect(collectAncestors(["a"], getParents).has("a")).toBe(true); // a→b→c→a
  });

  it("detects a would-be cycle (proposed parent is a descendant of the child)", () => {
    // Linking c under d is fine; linking a under c would close a→b→c→a again.
    expect(wouldCreateCycle("a", "c", getParents)).toBe(true);
    expect(wouldCreateCycle("d", "c", getParents)).toBe(false);
  });

  it("rejects a self-link", () => {
    expect(wouldCreateCycle("x", "x", getParents)).toBe(true);
  });
});
