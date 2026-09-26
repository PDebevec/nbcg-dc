import { describe, expect, it } from "vitest";
import { SNAPSHOT } from "./schema.fixture";
import {
  checkItem,
  firstIncompleteIndex,
  itemRole,
  publishNote,
  violationMessage,
  type ItemCheckInput,
} from "./schema-check";

const BOOK = { code: "am", en: "Book", cnr: "Knjiga" };
const SERIAL = { title: "Pobjeda", collectionType: 4 };

function check(values: Record<string, unknown>, over: Partial<ItemCheckInput> = {}) {
  return checkItem({ schema: SNAPSHOT, values, parents: [], backendState: null, choice: "DRAFT", ...over });
}

describe("checkItem", () => {
  it("a draft book needs only a title, a material type and a collection type", () => {
    expect(check({ title: "Gorski vijenac", materialType: BOOK, collectionType: 0 })).toMatchObject({
      ok: true,
      targetState: "DRAFT",
      missingToPublish: 1,
    });
  });

  it("blocks a draft without a material type", () => {
    expect(check({ title: "T", collectionType: 0 }).missing.map((m) => m.path)).toEqual(["materialType"]);
  });

  it("a record book also needs its number of pages", () => {
    const base = { title: "T", materialType: BOOK, collectionType: 0 };
    expect(check(base, { choice: "RECORD" }).missing.map((m) => m.path)).toEqual(["extent"]);
    expect(check({ ...base, extent: { value: 253, unit: "pages" } }, { choice: "RECORD" }).ok).toBe(true);
  });

  it("an issue of a serial, as a record, needs its number and date and hides the authors", () => {
    const c = check(
      { title: "Pobjeda 1234", materialType: BOOK, extent: { value: 8, unit: "pages" } },
      { choice: "RECORD", parents: [SERIAL] },
    );
    expect(c.missing.map((m) => m.path)).toEqual(["issue.number", "issue.date"]);
    expect(c.states.authors.visible).toBe(false);
  });

  it("a book in a collection keeps its authors", () => {
    expect(check({ title: "T", materialType: BOOK }, { parents: [{ collectionType: 3 }] }).states.authors.visible).toBe(true);
  });

  it("uses the backend state, not the choice, once the item is uploaded", () => {
    const c = check({ title: "T", materialType: BOOK, collectionType: 0 }, { backendState: "RECORD", choice: "DRAFT" });
    expect(c.targetState).toBe("RECORD");
    expect(c.missing.map((m) => m.path)).toEqual(["extent"]);
    expect(c.states.cobissId.readOnly).toBe(true);
  });

  it("reports a value the backend cannot read, once per path", () => {
    const c = check({ title: "T", materialType: BOOK, issue: { date: "1950-13" } }, { parents: [SERIAL] });
    expect(c.violations.map((v) => v.path)).toEqual(["issue.date"]);
    expect(c.ok).toBe(false);
  });

  it("ignores blank strings the way the upload does", () => {
    expect(check({ title: "  ", materialType: BOOK, collectionType: 0 }).missing.map((m) => m.path)).toEqual(["title"]);
  });
});

describe("violationMessage", () => {
  it("names the bound or the expected format", () => {
    expect(violationMessage({ constraint: "maxLength", limit: 500 })).toBe("At most 500 characters.");
    expect(violationMessage({ constraint: "unit", limit: "minutes" })).toMatch(/minutes/);
    expect(violationMessage({ constraint: "format", hint: { en: "A number", cnr: "Broj" } })).toBe("Expected: Broj.");
  });
});

describe("firstIncompleteIndex", () => {
  it("finds the first item that is not ready", () => {
    expect(firstIncompleteIndex(["ready", "untouched", "incomplete"])).toBe(1);
    expect(firstIncompleteIndex(["ready"])).toBe(-1);
  });
});

describe("itemRole", () => {
  it("reads what the batch's parents make the item", () => {
    const base = { title: "T", materialType: BOOK };
    expect(itemRole(check(base))).toEqual({ role: "standalone", label: "Standalone record" });
    expect(itemRole(check(base, { parents: [{ collectionType: 3 }] }))).toEqual({ role: "child", label: "In a collection" });
    expect(itemRole(check(base, { parents: [SERIAL] }))).toEqual({ role: "issue", label: "Issue of a serial" });
  });
});

describe("publishNote", () => {
  it("explains the lock once the item is on the backend", () => {
    expect(publishNote(null, "RECORD")).toBe("On the backend as a record — change that in the web app.");
  });

  it("counts what a draft still needs to publish", () => {
    const c = check({ title: "T", materialType: BOOK, collectionType: 0 });
    expect(publishNote(c, null)).toBe("1 more field needed to publish as a record.");
  });

  it("says nothing when there is nothing to say", () => {
    expect(publishNote(check({ title: "T", materialType: BOOK, collectionType: 0 }, { choice: "RECORD" }), null)).toBe("");
  });
});
