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
  missingParentMessage,
  missingParentNote,
  NO_PARENT_CHANGES,
  itemParentIds,
  withParentLinked,
  withParentUnlinked,
  passingAfterLink,
  linkChanges,
  nextBackendLinks,
  sameParentIds,
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

describe("missingParentMessage", () => {
  it("says a parent search could not find can't be found, and why that may pass", () => {
    expect(missingParentMessage(["Old maps"], false)).toBe(
      "The parent 'Old maps' can't be found on the backend. Change or remove it in this batch — if it was only just created, try again in a minute.",
    );
  });

  it("says a parent the backend refused no longer exists", () => {
    expect(missingParentMessage(["A", "B"], true)).toBe(
      "The parents 'A', 'B' no longer exist. Change or remove them in this batch, then upload again.",
    );
  });
});

describe("missingParentNote", () => {
  it("words each parent by how the app knows it is missing", () => {
    expect(missingParentNote({ gone: ["A"], notFound: [] })).toBe(missingParentMessage(["A"], true));
    expect(missingParentNote({ gone: [], notFound: ["B"] })).toBe(missingParentMessage(["B"], false));
    expect(missingParentNote({ gone: ["A"], notFound: ["B"] })).toBe(
      `${missingParentMessage(["A"], true)} ${missingParentMessage(["B"], false)}`,
    );
  });

  it("is empty when no parent is missing", () => {
    expect(missingParentNote({ gone: [], notFound: [] })).toBe("");
  });
});

describe("per-item parent changes", () => {
  it("lists the backend links, then pending links, without pending unlinks", () => {
    expect(itemParentIds(["p1", "p2"], { add: ["p9"], remove: ["p1"] })).toEqual(["p2", "p9"]);
  });

  it("never lists a parent twice", () => {
    expect(itemParentIds(["p1"], { add: ["p1"], remove: [] })).toEqual(["p1"]);
  });

  it("linking queues a parent the item doesn't have", () => {
    expect(withParentLinked(NO_PARENT_CHANGES, ["p1"], "p9")).toEqual({ add: ["p9"], remove: [], passing: null });
  });

  it("unlinking a backend link queues it; linking it again takes that back", () => {
    const removed = withParentUnlinked(NO_PARENT_CHANGES, ["p1"], "p1");
    expect(removed).toEqual({ add: [], remove: ["p1"], passing: null });
    expect(withParentLinked(removed, ["p1"], "p1")).toEqual(NO_PARENT_CHANGES);
  });

  it("unlinking a pending link just drops it", () => {
    const linked = withParentLinked(NO_PARENT_CHANGES, [], "p9");
    expect(withParentUnlinked(linked, [], "p9")).toEqual(NO_PARENT_CHANGES);
  });

  it("unlinking the passing parent stops it passing", () => {
    expect(withParentUnlinked({ add: ["p9"], remove: [], passing: "p9" }, [], "p9").passing).toBeNull();
  });
});

describe("passingAfterLink", () => {
  const eligible = (id: string) => id.startsWith("s");

  it("passes through a newly linked parent that is the item's only eligible one", () => {
    expect(passingAfterLink(null, ["c1", "s1"], "s1", eligible)).toBe("s1");
  });

  it("keeps an existing choice", () => {
    expect(passingAfterLink("s1", ["s1", "s2"], "s2", eligible)).toBe("s1");
  });

  it("leaves the choice open when the item then has two eligible parents", () => {
    expect(passingAfterLink(null, ["s1", "s2"], "s2", eligible)).toBeNull();
  });

  it("never starts a backend link passing when an ineligible parent is linked", () => {
    expect(passingAfterLink(null, ["s1", "c1"], "c1", eligible)).toBeNull();
  });
});

describe("linkChanges", () => {
  it("links only what the backend lacks and unlinks only what it has", () => {
    expect(linkChanges(["p1", "p2"], { add: ["p2", "p9"], remove: ["p1", "p5"] })).toEqual({
      connect: ["p9"],
      disconnect: ["p1"],
    });
  });

  it("sends every change when the backend links are not known", () => {
    expect(linkChanges(null, { add: ["p9"], remove: ["p1"] })).toEqual({ connect: ["p9"], disconnect: ["p1"] });
  });

  it("sends nothing without changes", () => {
    expect(linkChanges(["p1"], NO_PARENT_CHANGES)).toEqual({ connect: [], disconnect: [] });
  });
});

describe("nextBackendLinks", () => {
  it("adds what was linked and drops what was unlinked", () => {
    expect(nextBackendLinks(["p1", "p2"], ["p9"], ["p1"])).toEqual(["p2", "p9"]);
  });

  it("keeps an unknown list unknown", () => {
    expect(nextBackendLinks(null, ["p9"], [])).toBeNull();
  });
});

describe("sameParentIds", () => {
  it("ignores order", () => {
    expect(sameParentIds(["p1", "p2"], ["p2", "p1"])).toBe(true);
    expect(sameParentIds(["p1"], ["p2"])).toBe(false);
  });

  it("treats a missing list like an unknown one, and neither like an empty one", () => {
    expect(sameParentIds(undefined, null)).toBe(true);
    expect(sameParentIds(null, [])).toBe(false);
  });
});
