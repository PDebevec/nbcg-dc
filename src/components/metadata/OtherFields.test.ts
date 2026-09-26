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

  it("opens itself when a field in it has an error, so the error is seen", async () => {
    const open = /<details[^>]*\sopen/;
    expect(await render([view({ key: "extent" })])).not.toMatch(open);
    expect(await render([view({ key: "extent", error: "Must be a number." })])).toMatch(open);
    // An error on a sub-field of a hidden object counts too.
    const nested = view({ key: "publication", kind: "object", children: [view({ key: "place", error: "Too long." })] });
    expect(await render([nested])).toMatch(open);
  });

  it("renders nothing when there are none", async () => {
    expect(await render([])).not.toContain("Other fields");
  });

  it("passes a field's source options through to MetaField (pickSource/manual stay reachable)", async () => {
    const html = await render([
      view({
        sourceOptions: [{ parentId: "p1", name: "Parent A", preview: "some value", selected: false }],
      }),
    ]);
    // The picker pill only renders when `field.sourceOptions` reaches MetaField — this
    // is as far as an SSR smoke test can exercise it: the menu (and its "Manual entry"
    // option) only appears after a click, which renderToString cannot simulate. The
    // pickSource/manual forwarding itself is guarded by vue-tsc: OtherFields' template
    // binds `@pick-source`/`@manual` against MetaField's typed emits, so a signature
    // mismatch or a dropped listener fails the type check.
    expect(html).toContain("Choose source");
  });
});
