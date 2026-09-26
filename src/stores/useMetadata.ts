/**
 * Metadata working-model store (Epic 04/05) — the per-item editor state behind
 * the Metadata tab, shared with Setup (batch-wide prefill) and Processing &
 * Upload (readiness + the metadata to publish).
 *
 * Built on metadata schema v2 (`GET /api/schema/v2/record`): one schema for
 * every item. Which fields show, which are required and whose rules apply come
 * from the schema's rules (`domain/schemaRules`), evaluated against the item's
 * values, its batch's parents and its state — a new item is checked against its
 * Draft/Record choice, an uploaded one against the state it has on the backend.
 * Values are kept in the shape the backend stores (`domain/schema-values`).
 *
 * Persistence:
 *  - an item that has **not been uploaded yet** (no `backendId` in its
 *    `metadata.json`) writes its working values straight into the mirror's
 *    `metadata` — the documented pre-upload source of truth, which the upload
 *    reads when no override is passed (debounced autosave, flushed on demand);
 *  - an item that **is** connected to a backend record keeps the mirror as the
 *    backend snapshot (the re-upload PATCH diffs against it) and carries its
 *    working edits in memory for the session, handed to the upload as
 *    `ctx.metadata`.
 *
 * Loaded values come back as provenance `user`; COBISS / parent provenance is
 * stamped only by the apply-* actions within a session.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { Item } from "@domain/item";
import type { FieldV2, RecordSchemaV2 } from "@domain/schema";
import type { TargetState } from "@domain/schemaRules";
import type { LocalMetadataFile, MetadataValues } from "@domain/metadata";
import type { ParentRecord } from "@domain/parent";
import { resolveItemPublish } from "@domain/batch";
import { orderedFields } from "@domain/schema-form";
import { checkItem, type ItemCheck, type ItemReadiness } from "@domain/schema-check";
import { defaultValues, isUntouched, normalizeRecord, pruneForUpload } from "@domain/schema-values";
import {
  applyCobiss,
  applyParentFields,
  chooseFieldSource,
  flattenValues,
  toMetadataValues,
  type ApplyParentResult,
  type CobissApplyMode,
  type FieldSourceOption,
  type FillOutcome,
} from "@domain/provenance";
import { getRecordSchemaV2 } from "@services/api/schemaV2";
import { getParentById, searchParents } from "@services/api/collections";
import { readItemMetadata, writeItemMetadata } from "@services/indexing";
import { logger } from "@lib/logger";
import { useBatchesStore } from "./useBatches";
import { useItemsStore } from "./useItems";

/** Autosave debounce for the `metadata.json` working mirror. */
const SAVE_DEBOUNCE_MS = 800;

/** A batch's parents as far as this session knows them. */
export interface BatchParents {
  /** The parents whose records have loaded. */
  records: ParentRecord[];
  /** Ids the backend answered 404 for. */
  missing: string[];
  /** Ids whose fetch failed without proving they are gone (e.g. offline). */
  failed: string[];
  /** Some have not been fetched yet (neither loaded, missing nor failed). */
  pending: boolean;
}

/** The item's state on the backend, from its mirror; null before its first upload. */
function backendStateOf(mirror: LocalMetadataFile | null): TargetState | null {
  if (!mirror?.backendId) return null;
  // A mirror written before targetState was recorded: assume the stricter rules.
  return mirror.targetState ?? "RECORD";
}

export const useMetadataStore = defineStore("metadata", () => {
  // ── schema ────────────────────────────────────────────────────────────────
  const schema = ref<RecordSchemaV2 | null>(null);
  const schemaLoading = ref(false);
  const schemaError = ref<string | null>(null);
  let schemaPromise: Promise<void> | null = null;

  /** Top-level fields in form order (empty until the schema loads). */
  const fields = computed<FieldV2[]>(() => (schema.value ? orderedFields(schema.value) : []));

  /** Fetch the schema once (revalidated per session, offline-tolerant). */
  function ensureSchema(): Promise<void> {
    if (schema.value) return Promise.resolve();
    if (schemaPromise) return schemaPromise;
    schemaPromise = (async () => {
      schemaLoading.value = true;
      try {
        schema.value = await getRecordSchemaV2();
        schemaError.value = null;
      } catch (err) {
        schemaError.value = (err as Error)?.message ?? "Couldn't load the metadata schema.";
        logger.error("metadata", "Failed to load the metadata schema.", err);
      } finally {
        schemaLoading.value = false;
        schemaPromise = null;
      }
    })();
    return schemaPromise;
  }

  // ── per-item working values ───────────────────────────────────────────────
  const values = ref<Map<string, MetadataValues>>(new Map());
  const touched = ref<Set<string>>(new Set());
  const loadedItems = ref<Set<string>>(new Set());
  const loadingItems = ref<Set<string>>(new Set());
  const saving = ref<Set<string>>(new Set());
  const saveError = ref<string | null>(null);
  /** Each loaded item's state on the backend (null = not uploaded yet). */
  const backendStates = ref<Map<string, TargetState | null>>(new Map());

  /** The last-read `metadata.json` per item (null = none on disk). Not reactive:
   * it only feeds the next write; its backend state lives in `backendStates`. */
  const mirrors = new Map<string, LocalMetadataFile | null>();
  /** The Item each loaded id refers to (folder path for the write). */
  const knownItems = new Map<string, Item>();
  const loadPromises = new Map<string, Promise<void>>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function getValues(itemId: string): MetadataValues {
    return values.value.get(itemId) ?? {};
  }

  function plainValues(itemId: string): Record<string, unknown> {
    return flattenValues(getValues(itemId));
  }

  function isTouched(itemId: string): boolean {
    return touched.value.has(itemId);
  }

  function markTouched(itemId: string): void {
    if (touched.value.has(itemId)) return;
    const next = new Set(touched.value);
    next.add(itemId);
    touched.value = next;
  }

  /** Replace an item's whole value map and schedule an autosave. */
  function setValues(itemId: string, next: MetadataValues): void {
    const map = new Map(values.value);
    map.set(itemId, next);
    values.value = map;
    markTouched(itemId);
    scheduleSave(itemId);
  }

  /** Set one top-level field as an operator edit (provenance `user`). */
  function setFieldValue(itemId: string, key: string, value: unknown): void {
    const current = getValues(itemId);
    setValues(itemId, { ...current, [key]: { value, provenance: "user" } });
  }

  /** Record an item's mirror and the backend state it implies. */
  function rememberMirror(itemId: string, mirror: LocalMetadataFile | null): void {
    mirrors.set(itemId, mirror);
    const map = new Map(backendStates.value);
    map.set(itemId, backendStateOf(mirror));
    backendStates.value = map;
  }

  function setLoading(itemId: string, on: boolean): void {
    const next = new Set(loadingItems.value);
    if (on) next.add(itemId);
    else next.delete(itemId);
    loadingItems.value = next;
  }

  /** Load an item's working values from its `metadata.json` (once per item). */
  function ensureItemLoaded(item: Item): Promise<void> {
    knownItems.set(item.id, item);
    if (loadedItems.value.has(item.id)) return Promise.resolve();
    const inFlight = loadPromises.get(item.id);
    if (inFlight) return inFlight;
    const p = (async () => {
      setLoading(item.id, true);
      try {
        await ensureSchema();
        const s = schema.value;
        // No schema, no form. Loading nothing also keeps a stray edit from
        // autosaving an empty metadata.json over the real one.
        if (!s) return;
        let mirror: LocalMetadataFile | null = null;
        try {
          mirror = await readItemMetadata(item);
        } catch (err) {
          logger.warn("metadata", `Couldn't read metadata.json for ${item.id}.`, err);
        }
        rememberMirror(item.id, mirror);
        const stored = mirror?.metadata ?? {};
        // A new item starts from the schema's defaults (collectionType → 0).
        const start = mirror?.backendId ? stored : { ...defaultValues(s), ...stored };
        const known = new Set(s.fields.map((f) => f.key));
        const loaded = toMetadataValues(normalizeRecord(s, start), "user", known);
        // Don't clobber edits made while the read was in flight.
        if (!values.value.has(item.id)) {
          const map = new Map(values.value);
          map.set(item.id, loaded);
          values.value = map;
        }
        const done = new Set(loadedItems.value);
        done.add(item.id);
        loadedItems.value = done;
        void ensureParents(batchParentIds(item));
      } finally {
        setLoading(item.id, false);
        loadPromises.delete(item.id);
      }
    })();
    loadPromises.set(item.id, p);
    return p;
  }

  // ── persistence ───────────────────────────────────────────────────────────

  function scheduleSave(itemId: string): void {
    const existing = saveTimers.get(itemId);
    if (existing) clearTimeout(existing);
    saveTimers.set(
      itemId,
      setTimeout(() => {
        saveTimers.delete(itemId);
        void saveItem(itemId);
      }, SAVE_DEBOUNCE_MS),
    );
  }

  /** What an upload sends for an item: schema keys only, without blanks. */
  function wireMetadata(itemId: string): Record<string, unknown> {
    return schema.value ? pruneForUpload(schema.value, plainValues(itemId)) : {};
  }

  /** Schema keys the item holds in the editor but would not send (emptied). */
  function emptiedKeys(itemId: string): string[] {
    const s = schema.value;
    if (!s) return [];
    const known = new Set(s.fields.map((f) => f.key));
    const sent = wireMetadata(itemId);
    return Object.keys(getValues(itemId)).filter((key) => known.has(key) && !(key in sent));
  }

  /**
   * Write an item's working values to its `metadata.json` — only for items not
   * yet connected to a backend record (see the module doc).
   */
  async function saveItem(itemId: string): Promise<void> {
    const item = knownItems.get(itemId);
    if (!item || !loadedItems.value.has(itemId)) return;
    const mirror = mirrors.get(itemId) ?? null;
    if (mirror?.backendId) return; // connected → in-memory working copy only
    const metadata = wireMetadata(itemId);
    const file: LocalMetadataFile = {
      backendId: null,
      version: null,
      targetState: mirror?.targetState ?? null,
      visibilityStatus: mirror?.visibilityStatus ?? null,
      metadata,
      syncedAt: new Date().toISOString(),
    };
    const s = new Set(saving.value);
    s.add(itemId);
    saving.value = s;
    try {
      await writeItemMetadata(item, file);
      rememberMirror(itemId, file);
      saveError.value = null;
      // Keep the Overview's cached title in step without a rescan.
      const title = typeof metadata.title === "string" ? metadata.title : null;
      if (title !== item.title) {
        const items = useItemsStore();
        const live = items.items.find((i) => i.id === itemId);
        if (live) items.replaceItem({ ...live, title });
      }
    } catch (err) {
      saveError.value = (err as Error)?.message ?? "Couldn't save metadata.json.";
      logger.error("metadata", `Failed to write metadata.json for ${itemId}.`, err);
    } finally {
      const s2 = new Set(saving.value);
      s2.delete(itemId);
      saving.value = s2;
    }
  }

  /** Flush any pending autosave for one item (or all). */
  async function flush(itemId?: string): Promise<void> {
    const ids = itemId ? [itemId] : Array.from(saveTimers.keys());
    for (const id of ids) {
      const timer = saveTimers.get(id);
      if (!timer) continue;
      clearTimeout(timer);
      saveTimers.delete(id);
      await saveItem(id);
    }
  }

  /**
   * Re-read an item's metadata.json after something else wrote it — an upload's
   * write-through, a sync — so its backend link and state (the Draft/Record
   * lock) are current, and a later autosave goes to the folder the item now
   * lives in. Values stay: they are what was just sent.
   */
  async function reloadMirror(item: Item): Promise<void> {
    if (!loadedItems.value.has(item.id)) return;
    knownItems.set(item.id, item);
    try {
      rememberMirror(item.id, await readItemMetadata(item));
    } catch (err) {
      logger.warn("metadata", `Couldn't re-read metadata.json for ${item.id}.`, err);
    }
  }

  /** {@link reloadMirror} for each of `items` this session has loaded. */
  async function reloadMirrors(items: readonly Item[]): Promise<void> {
    await Promise.all(items.map(reloadMirror));
  }

  // ── the save check + readiness ───────────────────────────────────────────

  function batchOf(item: Item) {
    return item.batchId ? useBatchesStore().get(item.batchId) : null;
  }

  function batchParentIds(item: Item): string[] {
    return batchOf(item)?.parents.map((p) => p.id) ?? [];
  }

  /** The item's batch's parents, as far as this session knows them. */
  function batchParentsOf(item: Item): BatchParents {
    const records: ParentRecord[] = [];
    const missing: string[] = [];
    const failed: string[] = [];
    let pending = false;
    for (const id of batchParentIds(item)) {
      const record = parentRecords.value.get(id);
      if (record) records.push(record);
      else if (parentMissing.value.has(id)) missing.push(id);
      else if (parentFailed.value.has(id)) failed.push(id);
      else pending = true;
    }
    return { records, missing, failed, pending };
  }

  /** Whose rules apply to the item and what they still need — null while the
   * schema or a batch parent is still loading. A parent that failed to load
   * does not hold the form back: the rules run with the parents that did. */
  function checkOf(item: Item): ItemCheck | null {
    const s = schema.value;
    if (!s) return null;
    const parents = batchParentsOf(item);
    if (parents.pending) return null;
    const batch = batchOf(item);
    return checkItem({
      schema: s,
      values: plainValues(item.id),
      parents: parents.records.map((p) => p.metadata),
      backendState: backendStates.value.get(item.id) ?? null,
      choice: batch ? resolveItemPublish(batch, item.id) : "DRAFT",
    });
  }

  /** Ready to upload: the check passes and every batch parent loaded. */
  function isReady(item: Item): boolean {
    const check = checkOf(item);
    if (check == null || !check.ok) return false;
    const parents = batchParentsOf(item);
    return parents.missing.length === 0 && parents.failed.length === 0;
  }

  /** Names of the item's batch parents the backend answered 404 for. */
  function missingParentNamesOf(item: Item): string[] {
    return batchParentsOf(item).missing.map((id) => parentRecords.value.get(id)?.title ?? id);
  }

  function readinessOf(item: Item): ItemReadiness {
    const s = schema.value;
    if (!s) return "untouched";
    if (!isTouched(item.id) && isUntouched(s, plainValues(item.id))) return "untouched";
    return isReady(item) ? "ready" : "incomplete";
  }

  // ── prefill sources ───────────────────────────────────────────────────────

  /** Apply a COBISS preview record onto an item (values normalised first). */
  function applyCobissTo(
    itemId: string,
    record: Record<string, unknown>,
    mode: CobissApplyMode = "fill-empty",
  ): FillOutcome {
    const s = schema.value;
    if (!s) return { values: getValues(itemId), conflicts: [], applied: [], skipped: [] };
    const outcome = applyCobiss(getValues(itemId), normalizeRecord(s, record), fields.value, mode);
    if (outcome.applied.length > 0) setValues(itemId, outcome.values);
    return outcome;
  }

  /** Copy a data-passing parent's inheritable fields into an item's empties. */
  function applyParentTo(itemId: string, parent: ParentRecord): ApplyParentResult {
    const s = schema.value;
    if (!s) return { values: getValues(itemId), conflicts: [], applied: [], skipped: [], stillToFill: [] };
    const normalised: ParentRecord = {
      ...parent,
      metadata: normalizeRecord(s, parent.metadata) as ParentRecord["metadata"],
    };
    const outcome = applyParentFields(getValues(itemId), normalised, fields.value);
    if (outcome.applied.length > 0) setValues(itemId, outcome.values);
    return outcome;
  }

  /** Apply a per-field source-picker choice (a parent's value normalised first). */
  function chooseSource(itemId: string, key: string, option: FieldSourceOption): void {
    const s = schema.value;
    const picked =
      option.kind === "parent" && s
        ? { ...option, value: normalizeRecord(s, { [key]: option.value })[key] }
        : option;
    setValues(itemId, chooseFieldSource(getValues(itemId), key, picked));
  }

  // ── parent records (shared cache) ─────────────────────────────────────────
  const parentRecords = ref<Map<string, ParentRecord>>(new Map());
  const parentLoading = ref<Set<string>>(new Set());
  /** Parents the backend answered 404 for (search; see `domain/parent`). */
  const parentMissing = ref<Set<string>>(new Set());
  /** Parents whose last fetch failed without an answer (e.g. offline); a later
   * `ensureParent` fetches them again. */
  const parentFailed = ref<Set<string>>(new Set());
  const parentPromises = new Map<string, Promise<void>>();

  /** A copy of `set` without `id` (the same set when it isn't there). */
  function without(set: Set<string>, id: string): Set<string> {
    if (!set.has(id)) return set;
    const next = new Set(set);
    next.delete(id);
    return next;
  }

  function rememberParent(record: ParentRecord): void {
    const map = new Map(parentRecords.value);
    map.set(record.id, record);
    parentRecords.value = map;
    parentMissing.value = without(parentMissing.value, record.id);
    parentFailed.value = without(parentFailed.value, record.id);
  }

  function markParentsMissing(ids: readonly string[]): void {
    const next = new Set(parentMissing.value);
    for (const id of ids) {
      next.add(id);
      parentFailed.value = without(parentFailed.value, id);
    }
    parentMissing.value = next;
  }

  function markParentFailed(id: string): void {
    if (parentFailed.value.has(id)) return;
    const next = new Set(parentFailed.value);
    next.add(id);
    parentFailed.value = next;
  }

  /** Fetch a parent record by id (once). A 404 marks it missing; any other
   * failure marks it failed until a later fetch succeeds. */
  function ensureParent(id: string): Promise<void> {
    if (parentRecords.value.has(id)) return Promise.resolve();
    const inFlight = parentPromises.get(id);
    if (inFlight) return inFlight;
    const p = (async () => {
      const l = new Set(parentLoading.value);
      l.add(id);
      parentLoading.value = l;
      try {
        const record = await getParentById(id);
        if (record) rememberParent(record);
        else markParentsMissing([id]);
      } catch (err) {
        logger.warn("metadata", `Couldn't fetch parent ${id}.`, err);
        markParentFailed(id);
      } finally {
        const l2 = new Set(parentLoading.value);
        l2.delete(id);
        parentLoading.value = l2;
        parentPromises.delete(id);
      }
    })();
    parentPromises.set(id, p);
    return p;
  }

  function ensureParents(ids: readonly string[]): Promise<void> {
    return Promise.all(ids.map(ensureParent)).then(() => {});
  }

  /** Search candidate parents; results are remembered so linking is instant. */
  async function findParents(query: string, signal?: AbortSignal): Promise<ParentRecord[]> {
    const hits = await searchParents(query, { signal });
    for (const h of hits) rememberParent(h);
    return hits;
  }

  return {
    // schema
    schema,
    schemaLoading,
    schemaError,
    fields,
    ensureSchema,
    // values
    values,
    touched,
    loadedItems,
    loadingItems,
    saving,
    saveError,
    backendStates,
    getValues,
    plainValues,
    isTouched,
    setValues,
    setFieldValue,
    ensureItemLoaded,
    wireMetadata,
    emptiedKeys,
    flush,
    reloadMirror,
    reloadMirrors,
    // check + readiness
    batchParentsOf,
    checkOf,
    readinessOf,
    isReady,
    missingParentNamesOf,
    // prefill
    applyCobissTo,
    applyParentTo,
    chooseSource,
    // parents
    parentRecords,
    parentLoading,
    parentMissing,
    parentFailed,
    markParentsMissing,
    ensureParent,
    ensureParents,
    findParents,
    rememberParent,
  };
});
