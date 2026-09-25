import { describe, expect, it } from "vitest";
import { FIELD_INPUTS, labelText, type FieldV2 } from "./schema";
import { SNAPSHOT } from "./schema.fixture";

describe("labelText", () => {
  it("uses the caption language", () => {
    expect(labelText({ en: "Publisher", cnr: "Izdavač" })).toBe("Izdavač");
  });
  it("can be asked for English", () => {
    expect(labelText({ en: "Publisher", cnr: "Izdavač" }, "en")).toBe("Publisher");
  });
  it("falls back to the other language when one is blank", () => {
    expect(labelText({ en: "Scale", cnr: "" })).toBe("Scale");
  });
  it("is empty for a missing label", () => {
    expect(labelText(null)).toBe("");
  });
});

describe("the v2 schema snapshot", () => {
  const all = (fields: FieldV2[]): FieldV2[] =>
    fields.flatMap((f) => [f, ...all(f.objectShape ?? [])]);

  it("uses only inputs the app renders", () => {
    for (const f of all(SNAPSHOT.fields)) expect(FIELD_INPUTS, f.key).toContain(f.input);
  });

  it("names only vocabularies it ships", () => {
    for (const f of all(SNAPSHOT.fields)) {
      if (f.values) expect(SNAPSHOT.vocabularies[f.values.vocabulary], f.key).toBeDefined();
    }
  });
});
