/**
 * `useParentLinks` (Epic 05) — the parent-link slice shared by the Setup and
 * Metadata tabs: the rows, the search box, link / unlink / undo, the
 * passes-data toggle and link-to-all.
 *
 * Links are per item (docs/superpowers/specs/2026-09-29-per-item-parents-design.md).
 * An item's parents are its backend links — its `metadata.json`, held by the
 * metadata store — plus the batch's pending changes for it
 * (`overrides[item].parents`). `targets` are the items an action applies to:
 * the current item in Metadata, every member in Setup. Changes persist through
 * `useBatches.update`; the upload makes the backend match.
 */

import { computed, onUnmounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { parentChangesOf, withParentChanges, type Batch } from "@domain/batch";
import type { Item } from "@domain/item";
import {
  isEligibleParent,
  itemParentIds,
  passingAfterLink,
  withParentLinked,
  withParentUnlinked,
  type ParentChanges,
  type ParentRecord,
} from "@domain/parent";
import type { ApplyMode } from "@domain/provenance";
import { codeLabel } from "@domain/schema-form";
import { useBatchesStore } from "@stores/useBatches";
import { useMetadataStore } from "@stores/useMetadata";
import { useSettingsStore } from "@stores/useSettings";
import { useToastsStore } from "@stores/useToasts";
import { logger } from "@lib/logger";

/** Where a row's parent stands: on the backend, linked on upload, or unlinked on upload. */
export type ParentRowStatus = "linked" | "new" | "unlinking";

/** A parent of the targets, as the Setup/Metadata parent lists render it. */
export interface ParentRowView {
  id: string;
  name: string;
  /** Its collection type as the schema names it ("Serijska zbirka"), or why it isn't usable. */
  typeLabel: string;
  /** Eligible to pass data (serial-type collectionType). */
  canPassData: boolean;
  /** Passing its shared fields down to every target that has it. */
  passesData: boolean;
  status: ParentRowStatus;
  /** With several targets (Setup): how many of them have it; null for one item. */
  count: { on: number; of: number } | null;
}

/** One search hit in the parent picker. */
export interface ParentSearchRow {
  id: string;
  title: string;
  /** Its collection type ("Zbirka"), with " · can pass data" when it can. */
  meta: string;
  /** Already a parent of every target. */
  linked: boolean;
  /** Already a parent of every item in the batch — Link to all has nothing to do. */
  linkedAll: boolean;
}

/** An item whose passing parent an action changed, and the parent now passing. */
export interface PassingChange {
  itemId: string;
  parent: ParentRecord | null;
}

/** The answer to the parent copy prompt: how the parent's fields go in, or
 * "cancel" — the parent doesn't start passing data. */
export type PassingAnswer = ApplyMode | "cancel";

const SEARCH_DEBOUNCE_MS = 350;

export interface UseParentLinksOptions {
  /** Every item in the batch, for {@link linkParentToAll}; defaults to the targets. */
  members?: () => Item[];
  /** Before an action makes a parent start passing data to some items: how
   * its fields go in, or "cancel" to keep which parent passes as it was (a link
   * still links). Without it they fill only empty fields. */
  confirmPassing?: (changes: PassingChange[]) => Promise<PassingAnswer>;
  /** After an action changed which parent passes data to some items — once per
   * action, with the prompt's answer, so the caller can fill their fields and
   * say so once. */
  onPassingChanged?: (changes: PassingChange[], mode: ApplyMode) => void;
}

/** One item's side: backend links ([] while unknown), pending changes, and the parents they make. */
interface ItemLinks {
  backend: string[];
  changes: ParentChanges;
  ids: string[];
}

type Saved = Map<string, { before: ParentChanges; after: ParentChanges }>;

/** What an action saved, and how the parent it made pass data fills the items. */
interface Applied {
  saved: Saved;
  mode: ApplyMode;
}

export function useParentLinks(
  batch: () => Batch | null,
  targets: () => Item[],
  options: UseParentLinksOptions = {},
) {
  const batches = useBatchesStore();
  const metadata = useMetadataStore();
  const settings = useSettingsStore();
  const toasts = useToastsStore();
  const { parentRecords, parentLoading, parentGone, parentMissing, parentFailed, backendLinks } =
    storeToRefs(metadata);
  const { config } = storeToRefs(settings);

  const dataPassingTypes = computed(() => config.value.dataPassingCollectionTypes);
  const members = (): Item[] => options.members?.() ?? targets();

  function isEligible(id: string): boolean {
    const record = parentRecords.value.get(id);
    return record != null && isEligibleParent(record, dataPassingTypes.value);
  }

  /** A collection type as the schema's Collection type select names it. No
   * type reads as 0, as the backend and the rules treat it. */
  function collectionTypeName(type: number | null): string {
    const code = type ?? 0;
    return codeLabel(metadata.schema, "collectionType", code) ?? `Collection type ${code}`;
  }

  function linksOf(b: Batch, itemId: string): ItemLinks {
    const backend = backendLinks.value.get(itemId) ?? [];
    const changes = parentChangesOf(b, itemId);
    return { backend, changes, ids: itemParentIds(backend, changes) };
  }

  /** What a row list shows for one item: its parents, then its pending unlinks. */
  function shownIds(l: ItemLinks): string[] {
    return [...l.ids, ...l.changes.remove.filter((id) => l.backend.includes(id))];
  }

  const targetLinks = computed<ItemLinks[]>(() => {
    const b = batch();
    return b ? targets().map((t) => linksOf(b, t.id)) : [];
  });

  // Fetch the record of every parent the rows show (on open / after an edit).
  watch(
    () => [...new Set(targetLinks.value.flatMap(shownIds))].sort().join("|"),
    (key) => {
      if (key) void metadata.ensureParents(key.split("|"));
    },
    { immediate: true },
  );

  /** Why a parent is not usable comes first: a parent the upload was refused
   * for keeps its cached record, which would otherwise read as fine. */
  function typeLabelFor(id: string): string {
    if (parentGone.value.has(id)) return "No longer exists";
    if (parentMissing.value.has(id)) return "Not found on backend";
    if (parentFailed.value.has(id)) return "Couldn't load";
    const record = parentRecords.value.get(id);
    if (record) return collectionTypeName(record.collectionType);
    return parentLoading.value.has(id) ? "Loading…" : "Not found on backend";
  }

  const parents = computed<ParentRowView[]>(() => {
    const all = targetLinks.value;
    const order: string[] = [];
    for (const l of all) for (const id of shownIds(l)) if (!order.includes(id)) order.push(id);
    return order.map((id) => {
      const having = all.filter((l) => l.ids.includes(id));
      const status: ParentRowStatus =
        having.length === 0 ? "unlinking" : having.some((l) => l.backend.includes(id)) ? "linked" : "new";
      return {
        id,
        name: parentRecords.value.get(id)?.title ?? id,
        typeLabel: typeLabelFor(id),
        canPassData: isEligible(id),
        passesData: having.length > 0 && having.every((l) => l.changes.passing === id),
        status,
        count: all.length > 1 ? { on: having.length, of: all.length } : null,
      };
    });
  });

  /** The parent passing data to `itemId`, with its record, or null. */
  function passingParentOf(itemId: string): ParentRecord | null {
    const b = batch();
    if (!b) return null;
    const l = linksOf(b, itemId);
    const id = l.changes.passing;
    if (id === null || !l.ids.includes(id) || !isEligible(id)) return null;
    return parentRecords.value.get(id) ?? null;
  }

  /** The first target's passing parent (the Metadata tab's current item). */
  const passingParent = computed<ParentRecord | null>(() => {
    const first = targets()[0];
    return first ? passingParentOf(first.id) : null;
  });

  /** The first target's parents that can pass data, whose records we hold —
   * what the per-field source picker offers. */
  const sourceRecords = computed<ParentRecord[]>(() =>
    (targetLinks.value[0]?.ids ?? [])
      .filter(isEligible)
      .map((id) => parentRecords.value.get(id))
      .filter((r): r is ParentRecord => r != null),
  );

  // ── persistence ──────────────────────────────────────────────────────────

  /** The items whose passing parent changed, with the parent now passing. */
  function passingChanges(saved: Saved): PassingChange[] {
    const changes: PassingChange[] = [];
    for (const [itemId, { before, after }] of saved) {
      if (before.passing === after.passing) continue;
      changes.push({ itemId, parent: after.passing ? (parentRecords.value.get(after.passing) ?? null) : null });
    }
    return changes;
  }

  /** Apply `change` to each of `items`' pending changes and save the batch once.
   * When that makes a parent start passing data, `confirmPassing` is asked
   * first; "cancel" keeps which parent passes as it was. */
  async function apply(items: Item[], change: (l: ItemLinks) => ParentChanges): Promise<Applied | null> {
    const b = batch();
    if (!b || items.length === 0) return null;
    const saved: Saved = new Map();
    for (const item of items) {
      const l = linksOf(b, item.id);
      saved.set(item.id, { before: l.changes, after: change(l) });
    }
    let mode: ApplyMode = "fill-empty";
    const starts = passingChanges(saved).filter((c) => c.parent !== null);
    if (starts.length > 0 && options.confirmPassing) {
      const answer = await options.confirmPassing(starts);
      if (answer === "cancel") {
        for (const s of saved.values()) s.after = { ...s.after, passing: s.before.passing };
      } else {
        mode = answer;
      }
    }
    let next = batch() ?? b;
    for (const [itemId, { after }] of saved) next = withParentChanges(next, itemId, after);
    try {
      await batches.update(next);
      return { saved, mode };
    } catch (err) {
      logger.error("parents", "Couldn't save the parent links.", err);
      toasts.push("Couldn't save the parent links.", "error");
      return null;
    }
  }

  /** Tell the caller which items' passing parent the action changed, and how
   * to fill them. */
  function reportPassing({ saved, mode }: Applied): void {
    const changes = passingChanges(saved);
    if (changes.length > 0) options.onPassingChanged?.(changes, mode);
  }

  // ── search ───────────────────────────────────────────────────────────────

  const parentQuery = ref("");
  const searchResults = ref<ParentRecord[]>([]);
  const searching = ref(false);
  const searchError = ref<string | null>(null);
  /** Whether the picker's list shows: focus or typing opens it; leaving the
   * box, Esc, clearing the text or a link closes it. */
  const pickerOpen = ref(false);
  let abort: AbortController | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const results = computed<ParentSearchRow[]>(() => {
    const b = batch();
    const onAll = (items: Item[], id: string) =>
      b != null && items.length > 0 && items.every((t) => linksOf(b, t.id).ids.includes(id));
    return searchResults.value.map((r) => {
      const eligible = r.collectionType != null && dataPassingTypes.value.includes(r.collectionType);
      return {
        id: r.id,
        title: r.title,
        meta: `${collectionTypeName(r.collectionType)}${eligible ? " · can pass data" : ""}`,
        linked: onAll(targets(), r.id),
        linkedAll: onAll(members(), r.id),
      };
    });
  });

  /** Search the typed text. With nothing typed, clear the list, or with
   * `listNewest`, list the newest collections instead. */
  async function search(listNewest = false): Promise<void> {
    const q = parentQuery.value.trim();
    abort?.abort();
    if (!q && !listNewest) {
      searchResults.value = [];
      searchError.value = null;
      return;
    }
    const controller = new AbortController();
    abort = controller;
    searching.value = true;
    try {
      const hits = await metadata.findParents(q, controller.signal);
      if (controller.signal.aborted) return;
      searchResults.value = hits;
      searchError.value = null;
    } catch (err) {
      if (controller.signal.aborted) return;
      searchError.value = (err as Error)?.message ?? "Search failed.";
      searchResults.value = [];
    } finally {
      if (abort === controller) searching.value = false;
    }
  }

  function setQuery(value: string): void {
    parentQuery.value = value;
    if (debounce) clearTimeout(debounce);
    debounce = null;
    // Clearing the text closes the list at once (× sends an empty query too).
    if (value.trim() === "") {
      pickerOpen.value = false;
      void search();
      return;
    }
    pickerOpen.value = true;
    debounce = setTimeout(() => {
      debounce = null;
      void search();
    }, SEARCH_DEBOUNCE_MS);
  }

  /** The search box got focus: open the list, and with nothing typed, list the
   * newest collections. No new search while text is typed, a list shows or a
   * search runs. */
  function openPicker(): Promise<void> {
    pickerOpen.value = true;
    if (parentQuery.value.trim() !== "" || searchResults.value.length > 0 || searching.value) {
      return Promise.resolve();
    }
    return search(true);
  }

  /** Close the list; the typed text and its hits stay for the next focus. */
  function closePicker(): void {
    pickerOpen.value = false;
  }

  function clearSearch(): void {
    abort?.abort();
    parentQuery.value = "";
    searchResults.value = [];
    searchError.value = null;
    pickerOpen.value = false;
  }

  // ── link / unlink / undo / toggle ────────────────────────────────────────

  async function linkTo(items: Item[], id: string): Promise<void> {
    await metadata.ensureParent(id);
    const applied = await apply(items, (l) => {
      // Only a parent new to the item may start passing: an item that already
      // has it keeps its choice, and a backend link never starts passing on
      // its own (restoring a pending unlink leaves `passing` alone).
      if (l.ids.includes(id)) return l.changes;
      const linked = withParentLinked(l.changes, l.backend, id);
      if (l.backend.includes(id)) return linked;
      const ids = itemParentIds(l.backend, linked);
      return { ...linked, passing: passingAfterLink(linked.passing, ids, id, isEligible) };
    });
    if (!applied) return;
    clearSearch();
    reportPassing(applied);
  }

  /** Link a parent to the targets. */
  function linkParent(id: string): Promise<void> {
    return linkTo(targets(), id);
  }

  /** Link a parent to every item in the batch (the Metadata tab's Link to all). */
  function linkParentToAll(id: string): Promise<void> {
    return linkTo(members(), id);
  }

  /** Unlink a parent from the targets: a pending link is dropped, a backend
   * link unlinks at the next upload. */
  async function removeParent(id: string): Promise<void> {
    const applied = await apply(targets(), (l) => withParentUnlinked(l.changes, l.backend, id));
    if (applied) reportPassing(applied);
  }

  /** Take back a pending unlink (the struck-through row's Undo). */
  async function restoreParent(id: string): Promise<void> {
    await apply(targets(), (l) =>
      l.changes.remove.includes(id) ? withParentLinked(l.changes, l.backend, id) : l.changes,
    );
  }

  /** Toggle whether a parent passes data, for the targets that have it. */
  async function togglePassesData(id: string): Promise<void> {
    const b = batch();
    if (!b) return;
    const having = targets().filter((t) => linksOf(b, t.id).ids.includes(id));
    const on = having.length > 0 && having.every((t) => linksOf(b, t.id).changes.passing === id);
    if (!on && !isEligible(id)) return;
    const applied = await apply(having, (l) => ({ ...l.changes, passing: on ? null : id }));
    if (applied) reportPassing(applied);
  }

  onUnmounted(() => {
    abort?.abort();
    if (debounce) clearTimeout(debounce);
  });

  return {
    parents,
    sourceRecords,
    passingParent,
    passingParentOf,
    // search
    parentQuery,
    setQuery,
    results,
    searching,
    searchError,
    search,
    pickerOpen,
    openPicker,
    closePicker,
    clearSearch,
    // actions
    linkParent,
    linkParentToAll,
    removeParent,
    restoreParent,
    togglePassesData,
  };
}
