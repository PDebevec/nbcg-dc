import { describe, expect, it } from "vitest";
import { SNAPSHOT } from "@domain/schema.fixture";
import { buildContext, evaluateAll, type ItemState } from "@domain/schemaRules";
import { orderedFields } from "@domain/schema-form";
import type { MetadataValues } from "@domain/metadata";
import { buildFieldViews, entryFromHint, toHintView, type FieldView } from "./metadataFieldViews";

const BOOK = { code: "am", en: "Book", cnr: "Knjiga" };

function views(
  plain: Record<string, unknown>,
  opts: { parents?: Record<string, unknown>[]; itemState?: ItemState; errors?: Record<string, string> } = {},
): FieldView[] {
  const ctx = buildContext(plain, opts.parents ?? [], opts.itemState ?? "NEW", "DRAFT");
  const values: MetadataValues = Object.fromEntries(
    Object.entries(plain).map(([k, v]) => [k, { value: v, provenance: "user" as const }]),
  );
  return buildFieldViews({
    schema: SNAPSHOT,
    fields: orderedFields(SNAPSHOT),
    states: evaluateAll(SNAPSHOT, ctx),
    values,
    errors: opts.errors ?? {},
  });
}

const find = (list: FieldView[], key: string): FieldView => list.find((v) => v.key === key)!;

describe("buildFieldViews", () => {
  it("labels fields in the caption language, as the rules set them", () => {
    expect(find(views({ materialType: BOOK }), "extent")).toMatchObject({
      label: "Broj strana",
      kind: "quantity",
      unit: "str.",
    });
  });

  it("offers collection types as options that store the number", () => {
    const ct = find(views({ collectionType: 4 }), "collectionType");
    expect(ct.value).toBe("4");
    expect(ct.options.find((o) => o.value === "4")?.stored).toBe(4);
  });

  it("points strict vocabulary fields at the vocabulary search", () => {
    const lang = find(views({ language: [{ code: "cnr", en: "Montenegrin", cnr: "Crnogorski" }] }), "language");
    expect(lang.kind).toBe("multi-vocab");
    expect(lang.chipLabels).toEqual(["Crnogorski"]);
    expect(lang.hints).toMatchObject({ path: "/search/vocabularies/language?limit=5", strict: true });
  });

  it("gives free-text fields their hint source", () => {
    expect(find(views({}), "keywords").hints).toMatchObject({ strict: false, fillsEntry: false });
  });

  it("builds object children and entries with their paths", () => {
    const list = views({ publication: { place: "Cetinje" }, authors: [{ familyName: "Njegoš" }] });
    expect(find(list, "publication").children.map((c) => c.path)).toContain("publication.place");
    const entry = find(list, "authors").entries[0];
    expect(entry[0]).toMatchObject({ path: "authors[0].familyName", value: "Njegoš" });
    expect(entry[0].hints).toMatchObject({ fillsEntry: true });
  });

  it("locks cobissId once the item exists", () => {
    expect(find(views({}, { itemState: "DRAFT" }), "cobissId").readOnly).toBe(true);
  });

  it("shows the stored unit when it no longer matches the rules", () => {
    const extent = find(
      views({ materialType: { code: "gm", en: "Video", cnr: "Video" }, extent: { value: 253, unit: "pages" } }),
      "extent",
    );
    expect(extent.unit).toBe("str.");
  });

  it("attaches errors by path", () => {
    const list = views({ authors: [{ familyName: "" }] }, { errors: { "authors[0].familyName": "This field is required." } });
    expect(find(list, "authors").entries[0][0].error).toBe("This field is required.");
  });

  it("marks where each group starts", () => {
    const starts = views({}).filter((v) => v.groupStart).map((v) => v.group);
    expect(starts).toEqual(SNAPSHOT.groups.slice().sort((a, b) => a.order - b.order).map((g) => g.key));
  });
});

describe("toHintView", () => {
  const base = find(views({}), "keywords");

  it("uses a free hint's text as label and value", () => {
    expect(toHintView(base, "computers", null)).toEqual({ label: "computers", stored: "computers" });
  });

  it("stores a vocabulary hint per storeAs", () => {
    const lang = find(views({}), "language");
    const cnr = { code: "cnr", en: "Montenegrin", cnr: "Crnogorski" };
    expect(toHintView(lang, cnr, "resolvedCode")).toEqual({ label: "Crnogorski", stored: cnr });
    expect(toHintView(lang, cnr, "code")).toEqual({ label: "Crnogorski", stored: "cnr" });
  });

  it("labels an author hint by name", () => {
    const familyName = find(views({ authors: [{}] }), "authors").entries[0][0];
    expect(toHintView(familyName, { familyName: "Njegoš", firstName: "Petar" }, null)?.label).toBe("Njegoš, Petar");
  });
});

describe("entryFromHint", () => {
  it("takes only the entry's own sub-fields", () => {
    expect(entryFromHint({ role: "r" }, { familyName: "Njegoš", count: 3 }, ["familyName", "firstName", "role"])).toEqual({
      role: "r",
      familyName: "Njegoš",
    });
  });
});
