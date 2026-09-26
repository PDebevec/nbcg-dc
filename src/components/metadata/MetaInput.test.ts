import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import MetaInput from "./MetaInput.vue";
import type { FieldView, HintView } from "@composables/useMetadataForm";

function view(over: Partial<FieldView>): FieldView {
  return {
    key: "x", path: "x", label: "X", help: "", kind: "text", required: false, readOnly: false,
    wide: false, raw: null, value: "", chips: [], chipLabels: [], options: [], unit: "",
    hints: null, children: [], entries: [], provenance: "none", provLabel: "", sourceOptions: [],
    manualSelected: false, error: "", flag: "", group: "basic", groupLabel: "Osnovno", groupStart: false,
    ...over,
  };
}

function render(field: FieldView, hints: HintView[] | null): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(MetaInput, { field, editable: true, hints }) }));
}

const SOURCE = { path: "/search/suggest?field=publisher&limit=5", queryParam: "q", minChars: 2, strict: false, fillsEntry: false };

describe("MetaInput hints", () => {
  it("lists the open hints under a free-text box", async () => {
    const html = await render(view({ kind: "hint", hints: SOURCE }), [{ label: "Obod", stored: "Obod" }]);
    expect(html).toContain("Obod");
    expect(html).toContain('class="hints"');
  });

  it("shows no list when its hints are closed", async () => {
    expect(await render(view({ kind: "hint", hints: SOURCE }), null)).not.toContain('class="hints"');
  });

  it("offers a search box beside the chips of a vocabulary field", async () => {
    const html = await render(
      view({ kind: "multi-vocab", chips: ["cnr"], chipLabels: ["Crnogorski"], hints: { ...SOURCE, strict: true } }),
      null,
    );
    expect(html).toContain("Crnogorski");
    expect(html).toContain("Search…");
  });
});
