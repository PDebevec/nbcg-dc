/**
 * Render smoke tests for the parent card: the pending link states and the
 * bulk actions must actually reach the operator (see ProcessingTab.test.ts).
 */

import { describe, it, expect } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import type { ParentRowView, ParentSearchRow } from "@composables/useParentLinks";
import ParentRecordsCard from "./ParentRecordsCard.vue";

function row(over: Partial<ParentRowView> & { id: string }): ParentRowView {
  return {
    name: `Parent ${over.id}`,
    typeLabel: "Record",
    canPassData: false,
    passesData: false,
    status: "linked",
    count: null,
    ...over,
  };
}

function render(props: {
  parents?: ParentRowView[];
  results?: ParentSearchRow[];
  query?: string;
  linkAllCount?: number;
}): Promise<string> {
  return renderToString(
    createSSRApp(ParentRecordsCard, {
      parents: [],
      editable: true,
      query: "",
      results: [],
      searching: false,
      searchError: null,
      ...props,
    }),
  );
}

describe("ParentRecordsCard", () => {
  it("marks a parent that links on upload", async () => {
    expect(await render({ parents: [row({ id: "p9", status: "new" })] })).toContain("New — links on upload");
  });

  it("strikes through a parent that unlinks on upload and offers Undo instead of Unlink", async () => {
    const html = await render({ parents: [row({ id: "p1", status: "unlinking" })] });
    expect(html).toContain('class="parent-row unlinking"');
    expect(html).toContain("Unlinks on upload");
    expect(html).toContain("Undo");
    expect(html).not.toContain('title="Unlink"');
  });

  it("says how many items have each parent in Setup", async () => {
    const html = await render({
      parents: [row({ id: "p1", count: { on: 2, of: 4 } }), row({ id: "p2", count: { on: 4, of: 4 } })],
    });
    expect(html).toContain("on 2 of 4 items");
    expect(html).toContain("on all 4 items");
  });

  it("offers Link to all only when the batch has more than one item", async () => {
    const results: ParentSearchRow[] = [
      { id: "p9", title: "Pobjeda", meta: "Record", linked: false, linkedAll: false },
    ];
    expect(await render({ query: "pob", results, linkAllCount: 3 })).toContain("Link to all 3 items");
    expect(await render({ query: "pob", results, linkAllCount: 1 })).not.toContain("Link to all");
  });
});
