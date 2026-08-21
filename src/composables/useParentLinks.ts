/**
 * `useParentLinks` (Epic 05) — the parent-record linking slice shared by the
 * Setup and Metadata tabs: the linked-parent rows, the search box, link/unlink,
 * and the "exactly one passes data" toggle.
 *
 * Links are persisted on the batch (`Batch.parents`, `{ id, passesData }`); the
 * resolved records + eligibility come from the metadata store's parent cache
 * and the configured `dataPassingCollectionTypes`. Persisting goes through
 * `useBatches.update` (write-through), so both tabs and the upload read the same
 * list.
 */

import { computed, onUnmounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import type { Batch } from "@domain/batch";
import {
  dataPassingParent,
  resolveLinkedParents,
  toParentRefs,
  toggleDataPassing,
  withDefaultPassing,
  type LinkedParent,
  type ParentRecord,
} from "@domain/parent";
import { useBatchesStore } from "@stores/useBatches";
import { useMetadataStore } from "@stores/useMetadata";
import { useSettingsStore } from "@stores/useSettings";
import { useToastsStore } from "@stores/useToasts";
import { logger } from "@lib/logger";

/** A linked parent record, as the Setup/Metadata parent lists render it. */
export interface ParentRowView {
  id: string;
  name: string;
  /** "Serial" (data-passing type) / "Record" — shown under the name. */
  typeLabel: string;
  /** Eligible to pass data (serial-type collectionType). */
  canPassData: boolean;
  /** The one parent currently passing its shared fields down. */
  passesData: boolean;
}

/** One search hit in the parent picker. */
export interface ParentSearchRow {
  id: string;
  title: string;
  /** "Serial · can pass data" / "Record". */
  meta: string;
  /** Already linked to this batch. */
  linked: boolean;
}

const SEARCH_DEBOUNCE_MS = 350;

export interface UseParentLinksOptions {
  /** Called after the data-passing parent changes (link / toggle) with the
   * parent now passing, or null. Lets the caller copy its fields down. */
  onPassingChanged?: (parent: ParentRecord | null) => void;
}

export function useParentLinks(
  batch: () => Batch | null,
  options: UseParentLinksOptions = {},
) {
  const batches = useBatchesStore();
  const metadata = useMetadataStore();
  const settings = useSettingsStore();
  const toasts = useToastsStore();
  const { parentRecords, parentLoading } = storeToRefs(metadata);
  const { config } = storeToRefs(settings);

  const dataPassingTypes = computed(() => config.value.dataPassingCollectionTypes);

  /** The batch's links resolved against fetched records + config. */
  const linkedParents = computed<LinkedParent[]>(() => {
    const b = batch();
    if (!b) return [];
    return resolveLinkedParents(b.parents, parentRecords.value, dataPassingTypes.value);
  });

  // Fetch any linked record we don't hold yet (deep-link / reopen).
  watch(
    () => batch()?.parents.map((p) => p.id).join("|") ?? "",
    () => {
      const b = batch();
      if (b && b.parents.length) void metadata.ensureParents(b.parents.map((p) => p.id));
    },
    { immediate: true },
  );

  function typeLabelFor(link: LinkedParent): string {
    if (link.record) return link.eligible ? "Serial" : "Record";
    return parentLoading.value.has(link.parentId) ? "Loading…" : "Not found on backend";
  }

  const parents = computed<ParentRowView[]>(() =>
    linkedParents.value.map((l) => ({
      id: l.parentId,
      name: l.record?.title ?? l.parentId,
      typeLabel: typeLabelFor(l),
      canPassData: l.eligible,
      passesData: l.passesData,
    })),
  );

  /** The linked parent currently passing data (with its record), or null. */
  const passingParent = computed<ParentRecord | null>(
    () => dataPassingParent(linkedParents.value)?.record ?? null,
  );

  /** Every linked parent whose record we hold (for the per-field source picker). */
  const linkedRecords = computed<ParentRecord[]>(() =>
    linkedParents.value
      .map((l) => l.record)
      .filter((r): r is ParentRecord => r != null),
  );

  // ── persistence ──────────────────────────────────────────────────────────

  async function persist(links: LinkedParent[]): Promise<boolean> {
    const b = batch();
    if (!b) return false;
    try {
      await batches.update({ ...b, parents: toParentRefs(links) });
      return true;
    } catch (err) {
      logger.error("parents", "Couldn't save the parent links.", err);
      toasts.push("Couldn't save the parent links.", "error");
      return false;
    }
  }

  // ── search ───────────────────────────────────────────────────────────────

  const parentQuery = ref("");
  const searchResults = ref<ParentRecord[]>([]);
  const searching = ref(false);
  const searchError = ref<string | null>(null);
  let abort: AbortController | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const results = computed<ParentSearchRow[]>(() => {
    const linkedIds = new Set(linkedParents.value.map((l) => l.parentId));
    return searchResults.value.map((r) => {
      const eligible =
        r.collectionType != null && dataPassingTypes.value.includes(r.collectionType);
      return {
        id: r.id,
        title: r.title,
        meta: eligible ? "Serial · can pass data" : "Record",
        linked: linkedIds.has(r.id),
      };
    });
  });

  async function search(): Promise<void> {
    const q = parentQuery.value.trim();
    abort?.abort();
    if (!q) {
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
    debounce = setTimeout(() => {
      debounce = null;
      void search();
    }, SEARCH_DEBOUNCE_MS);
  }

  function clearSearch(): void {
    abort?.abort();
    parentQuery.value = "";
    searchResults.value = [];
    searchError.value = null;
  }

  // ── link / unlink / toggle ───────────────────────────────────────────────

  async function linkParent(id: string): Promise<void> {
    const b = batch();
    if (!b || b.parents.some((p) => p.id === id)) return;
    await metadata.ensureParent(id);
    const before = dataPassingParent(linkedParents.value)?.parentId ?? null;
    let links = resolveLinkedParents(
      [...b.parents, { id, passesData: false }],
      parentRecords.value,
      dataPassingTypes.value,
    );
    links = withDefaultPassing(links);
    if (await persist(links)) {
      clearSearch();
      const after = dataPassingParent(links);
      if ((after?.parentId ?? null) !== before) {
        options.onPassingChanged?.(after?.record ?? null);
      }
    }
  }

  async function removeParent(id: string): Promise<void> {
    const was = dataPassingParent(linkedParents.value)?.parentId === id;
    const links = linkedParents.value.filter((l) => l.parentId !== id);
    if ((await persist(links)) && was) options.onPassingChanged?.(null);
  }

  /** Toggle which parent passes data — at most one at a time. */
  async function togglePassesData(id: string): Promise<void> {
    const links = toggleDataPassing(linkedParents.value, id);
    if (await persist(links)) {
      options.onPassingChanged?.(dataPassingParent(links)?.record ?? null);
    }
  }

  onUnmounted(() => {
    abort?.abort();
    if (debounce) clearTimeout(debounce);
  });

  return {
    parents,
    linkedParents,
    linkedRecords,
    passingParent,
    // search
    parentQuery,
    setQuery,
    results,
    searching,
    searchError,
    search,
    clearSearch,
    // actions
    linkParent,
    removeParent,
    togglePassesData,
  };
}
