import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import OtherFields from "./OtherFields.vue";
import type { FieldView } from "@composables/useMetadataForm";

function view(over: Partial<FieldView>): FieldView {
  return {
    key: "x", path: "x", label: "X", help: "", kind: "text", required: false, readOnly: false,
    wide: false, raw: null, value: "", chips: [], chipLabels: [], options: [], unit: "",
    hints: null, children: [], entries: [], provenance: "none", provLabel: "", sourceOptions: [],
    manualSelected: false, error: "", flag: "", group: "basic", groupLabel: "Osnovno", groupStart: false,
    ...over,
  };
}

function render(fields: FieldView[]): Promise<string> {
  return renderToString(
    createSSRApp({ render: () => h(OtherFields, { fields, editable: true, hintPath: null, hintItems: [] }) }),
  );
}

describe("OtherFields", () => {
  it("lists hidden fields that hold a value, collapsed, with a note", async () => {
    const html = await render([view({ key: "cartographicMathematicalData", label: "Razmjera", value: "1:25 000" })]);
    expect(html).toContain("Other fields (1)");
    expect(html).toContain("Razmjera");
    expect(html).toContain("kept and uploaded");
  });

  it("renders nothing when there are none", async () => {
    expect(await render([])).not.toContain("Other fields");
  });
});
