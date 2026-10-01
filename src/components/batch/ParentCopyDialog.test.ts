/**
 * Render smoke tests for the parent copy prompt: what would be replaced and
 * the three ways out must reach the operator.
 */

import { describe, it, expect } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import type { CopyPromptView } from "@composables/useParentCopyPrompt";
import ParentCopyDialog from "./ParentCopyDialog.vue";

function render(prompt: CopyPromptView | null): Promise<string> {
  return renderToString(createSSRApp(ParentCopyDialog, { prompt }));
}

describe("ParentCopyDialog", () => {
  it("names the fields one item would lose, old and new, with the three ways out", async () => {
    const html = await render({
      source: "Pobjeda",
      itemCount: 1,
      fields: [{ key: "subtitle", label: "Podnaslov", current: "Mine", incoming: "Dnevni list", items: 1 }],
    });
    expect(html).toContain("Pobjeda");
    expect(html).toContain("Podnaslov");
    expect(html).toContain("Mine");
    expect(html).toContain("Dnevni list");
    expect(html).toContain("Overwrite them");
    expect(html).toContain("Fill only empty fields");
    expect(html).toContain('title="Cancel"');
  });

  it("says in how many items each field is filled when several would change", async () => {
    const html = await render({
      source: null,
      itemCount: 3,
      fields: [{ key: "subtitle", label: "Podnaslov", current: "A", incoming: "B", items: 2 }],
    });
    expect(html).toContain("3 items");
    expect(html).toContain("in 2 items");
    expect(html).not.toContain("→");
  });

  it("shows no dialog while there's nothing to ask", async () => {
    expect(await render(null)).not.toContain('role="dialog"');
  });
});
