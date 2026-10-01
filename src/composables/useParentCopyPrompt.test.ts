import { describe, expect, it, vi } from "vitest";
import { fieldV2 } from "@domain/schema.fixture";
import type { OverwriteConflict } from "@domain/provenance";
import type { ParentRecord } from "@domain/parent";

/** What each item holds that the parent would replace, by item id. */
const replaced = new Map<string, OverwriteConflict[]>();

const metadataFake = {
  fields: [
    fieldV2({ key: "subtitle", label: { en: "Subtitle", cnr: "Podnaslov" } }),
    fieldV2({ key: "language", label: { en: "Language", cnr: "Jezik" } }),
  ],
  parentOverwritesFor: (itemId: string, _parent: ParentRecord) => replaced.get(itemId) ?? [],
};
vi.mock("@stores/useMetadata", () => ({ useMetadataStore: () => metadataFake }));

const { useParentCopyPrompt } = await import("./useParentCopyPrompt");

const POBJEDA: ParentRecord = { id: "s1", title: "Pobjeda", collectionType: 4, metadata: {} };

function conflict(key: string, currentValue: unknown, incomingValue: unknown): OverwriteConflict {
  return { key, currentValue, incomingValue, incomingProvenance: "parent" };
}

describe("useParentCopyPrompt", () => {
  it("fills the empty fields without asking when nothing would be replaced", async () => {
    replaced.clear();
    const copy = useParentCopyPrompt();
    expect(await copy.confirm([{ itemId: "i1", parent: POBJEDA }])).toBe("fill-empty");
    expect(copy.prompt.value).toBeNull();
  });

  it("lists what one item would lose, with both values, and answers with the choice", async () => {
    replaced.clear();
    replaced.set("i1", [
      conflict("subtitle", "Mine", "Dnevni list"),
      conflict("language", [{ code: "en", en: "English", cnr: "Engleski" }], [{ code: "cnr", en: "Montenegrin", cnr: "Crnogorski" }]),
    ]);
    const copy = useParentCopyPrompt();
    const answer = copy.confirm([{ itemId: "i1", parent: POBJEDA }]);
    expect(copy.prompt.value).toEqual({
      source: "Pobjeda",
      itemCount: 1,
      fields: [
        { key: "subtitle", label: "Podnaslov", current: "Mine", incoming: "Dnevni list", items: 1 },
        { key: "language", label: "Jezik", current: "Engleski", incoming: "Crnogorski", items: 1 },
      ],
    });
    copy.answer("overwrite-all");
    expect(await answer).toBe("overwrite-all");
    expect(copy.prompt.value).toBeNull();
  });

  it("counts, for several items, how many hold each field", async () => {
    replaced.clear();
    replaced.set("i1", [conflict("subtitle", "A", "Dnevni list")]);
    replaced.set("i2", [conflict("subtitle", "B", "Dnevni list"), conflict("language", "x", "y")]);
    const copy = useParentCopyPrompt();
    const answer = copy.confirm([
      { itemId: "i1", parent: POBJEDA },
      { itemId: "i2", parent: POBJEDA },
      { itemId: "i3", parent: POBJEDA },
    ]);
    expect(copy.prompt.value?.itemCount).toBe(2);
    expect(copy.prompt.value?.fields.map((f) => [f.key, f.items])).toEqual([
      ["subtitle", 2],
      ["language", 1],
    ]);
    copy.answer("cancel");
    expect(await answer).toBe("cancel");
  });
});
