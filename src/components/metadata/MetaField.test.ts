import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import MetaField from "./MetaField.vue";
import type { FieldView } from "@composables/useMetadataForm";

function view(over: Partial<FieldView>): FieldView {
  return {
    key: "x",
    path: "x",
    label: "X",
    help: "",
    kind: "text",
    required: false,
    readOnly: false,
    wide: false,
    raw: null,
    value: "",
    chips: [],
    chipLabels: [],
    options: [],
    unit: "",
    hints: null,
    children: [],
    entries: [],
    provenance: "none",
    provLabel: "",
    sourceOptions: [],
    manualSelected: false,
    error: "",
    flag: "",
    group: "basic",
    groupLabel: "Osnovno",
    groupStart: false,
    ...over,
  };
}

function render(field: FieldView, editable = true): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(MetaField, { field, editable }) }));
}

describe("MetaField", () => {
  it("shows a quantity with the unit the rules chose", async () => {
    const html = await render(view({ kind: "quantity", label: "Broj strana", value: "253", unit: "str." }));
    expect(html).toContain("Broj strana");
    expect(html).toContain("str.");
  });

  it("renders each entry's fields with their own labels and errors", async () => {
    const child = view({ key: "name", path: "corporateBodies[0].name", label: "Naziv", required: true, error: "This field is required." });
    const html = await render(view({ key: "corporateBodies", kind: "object-list", label: "Organizacije", entries: [[child]] }));
    expect(html).toContain("Naziv");
    expect(html).toContain("This field is required.");
    expect(html).toContain("+ Add");
  });

  it("disables a read-only field", async () => {
    expect(await render(view({ kind: "text", readOnly: true, value: "123" }))).toMatch(/<input[^>]*disabled/);
  });
});
