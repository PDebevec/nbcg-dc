/**
 * `useParentCopyPrompt` (Epic 05) — the prompt before a data-passing parent's
 * fields go into items that already hold different values: it lists those
 * fields, and the operator overwrites them, fills only the empty ones, or
 * cancels. Shared by the Metadata tab (a link or the passes-data toggle) and
 * the Setup tab (Next). With nothing to replace it doesn't ask.
 */

import { ref } from "vue";
import { labelText } from "@domain/schema";
import { useMetadataStore } from "@stores/useMetadata";
import { previewValue } from "./metadataFieldViews";
import type { PassingAnswer, PassingChange } from "./useParentLinks";

/** One field the parent would replace. */
export interface CopyPromptField {
  key: string;
  /** The field's caption, as the form shows it. */
  label: string;
  /** What the item holds now and what the parent has (the first item's). */
  current: string;
  incoming: string;
  /** How many of the items hold it. */
  items: number;
}

/** The prompt, while it is open. */
export interface CopyPromptView {
  /** The parent's title, or null when several parents would pass data. */
  source: string | null;
  /** How many items hold values the parent would replace. */
  itemCount: number;
  fields: CopyPromptField[];
}

export function useParentCopyPrompt() {
  const metadata = useMetadataStore();
  const prompt = ref<CopyPromptView | null>(null);
  let pending: ((answer: PassingAnswer) => void) | null = null;

  function labelOf(key: string): string {
    return labelText(metadata.fields.find((f) => f.key === key)?.label) || key;
  }

  /** What the prompt shows for `changes`, or null when nothing would be replaced. */
  function promptOf(changes: readonly PassingChange[]): CopyPromptView | null {
    const fields = new Map<string, CopyPromptField>();
    let itemCount = 0;
    for (const { itemId, parent } of changes) {
      if (!parent) continue;
      const replaced = metadata.parentOverwritesFor(itemId, parent);
      if (replaced.length === 0) continue;
      itemCount += 1;
      for (const c of replaced) {
        const row = fields.get(c.key);
        if (row) row.items += 1;
        else {
          fields.set(c.key, {
            key: c.key,
            label: labelOf(c.key),
            current: previewValue(c.currentValue),
            incoming: previewValue(c.incomingValue),
            items: 1,
          });
        }
      }
    }
    if (itemCount === 0) return null;
    const parents = new Map(changes.filter((c) => c.parent).map((c) => [c.parent!.id, c.parent!]));
    return {
      source: parents.size === 1 ? [...parents.values()][0].title : null,
      itemCount,
      fields: [...fields.values()],
    };
  }

  /** How the parent's fields go into the items: asks when they would replace
   * filled-in values, else fills the empty ones. */
  function confirm(changes: readonly PassingChange[]): Promise<PassingAnswer> {
    const view = promptOf(changes);
    if (!view) return Promise.resolve("fill-empty");
    answer("cancel"); // a prompt left open is dropped
    prompt.value = view;
    return new Promise((resolve) => {
      pending = resolve;
    });
  }

  /** The operator answered (Cancel = ✕). */
  function answer(choice: PassingAnswer): void {
    const resolve = pending;
    pending = null;
    prompt.value = null;
    resolve?.(choice);
  }

  return { prompt, confirm, answer };
}
