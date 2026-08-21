/**
 * Metadata working-model store (Epic 04/05) — the per-item editor state behind
 * the Metadata tab, shared with Setup (batch-wide prefill) and Processing &
 * Upload (readiness + the metadata to publish).
 *
 * Holds, per item id, the provenance-tagged {@link MetadataValues} the form
 * edits (in the editor's **bare-code** shape — see `domain/metadata-wire`), the
 * record schema per level, and a cache of fetched {@link ParentRecord}s for the
 * parent links. Persistence:
 *
 *  - an item that has **not been uploaded yet** (no `backendId` in its
 *    `metadata.json`) writes its working values straight into the mirror's
 *    `metadata` — the documented pre-upload source of truth, which the upload
 *    reads when no override is passed (debounced autosave, flushed on demand);
 *  - an item that **is** connected to a backend record keeps the mirror as the
 *    backend snapshot (the re-upload PATCH diffs against it) and carries its
 *    working edits in memory for the session, handed to the upload as
 *    `ctx.metadata`.
 *
 * Loaded values come back as provenance `user` (a local/backend record is the
 * operator's — `domain/metadata-form.toMetadataValues`); COBISS / parent
 * provenance is stamped only by the apply-* actions within a session.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { Item, ItemLevel } from "@domain/item";
import type { FieldDescriptor, FieldLevel, RecordSchema } from "@domain/schema";
import type { LocalMetadataFile, MetadataValues } from "@domain/metadata";
import type { ParentRecord } from "@domain/parent";
import {
  buildFormModel,
  flattenValues,
  isItemValid,
  itemReadiness,
  pruneToSchema,
  toMetadataValues,
  type ItemReadiness,
} from "@domain/metadata-form";
import {
  applyCobiss,
  applyParentFields,
  chooseFieldSource,
  type ApplyParentResult,
  type CobissApplyMode,
  type FieldSourceOption,
  type FillOutcome,
} from "@domain/provenance";
import { toFormRecord, toWireRecord } from "@domain/metadata-wire";
import { getRecordSchema } from "@services/api/schema";
import { getParentById, searchParents } from "@services/api/collections";
import { readItemMetadata, writeItemMetadata } from "@services/indexing";
import { logger } from "@lib/logger";
import { useItemsStore } from "./useItems";

/** Autosave debounce for the `metadata.json` working mirror. */
const SAVE_DEBOUNCE_MS = 800;

export const useMetadataStore = defineStore("metadata", () => {
  // ── schema ────────────────────────────────────────────────────────────────
  const schemas = ref<Partial<Record<FieldLevel, RecordSchema>>>({});
  const schemaLoading = ref(false);
  const schemaError = ref<string | null>(null);
  const schemaPromises = new Map<FieldLevel, Promise<void>>();

  /** Ordered, level-filtered fields per level (empty until the schema loads). */
  const fieldsByLevel = computed<Record<FieldLevel, FieldDescriptor[]>>(() => ({
    main: schemas.value.main ? buildFormModel(schemas.value.main, "main").fields : [],
    child: schemas.value.child ? buildFormModel(schemas.value.child, "child").fields : [],
  }));

  function fieldsFor(level: ItemLevel): FieldDescriptor[] {
    return fieldsByLevel.value[level];
  }

  /** Fetch (cached / offline-tolerant) the schema for a level, once. */
  function ensureSchema(level: FieldLevel): Promise<void> {
    if (schemas.value[level]) return Promise.resolve();
    const inFlight = schemaPromises.get(level);
    if (inFlight) return inFlight;
    const p = (async () => {
      schemaLoading.value = true;
      try {
        const schema = await getRecordSchema(level);
        schemas.value = { ...schemas.value, [level]: schema };
        schemaError.value = null;
      } catch (err) {
        schemaError.value =
          (err as Error)?.message ?? "Couldn't load the metadata schema.";
        logger.error("metadata", `Failed to load the ${level} schema.`, err);
      } finally {
        schemaLoading.value = false;
        schemaPromises.delete(level);
      }
    })();
    schemaPromises.set(level, p);
    return p;
  }

  // ── per-item working values ───────────────────────────────────────────────
  const values = ref<Map<string, MetadataValues>>(new Map());
  const touched = ref<Set<string>>(new Set());
  const loadedItems = ref<Set<string>>(new Set());
  const loadingItems = ref<Set<string>>(new Set());
  const saving = ref<Set<string>>(new Set());
  const saveError = ref<string | null>(null);

  /** The last-read `metadata.json` per item (null = none on disk). Not reactive:
   * it only feeds the next write. */
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

  /** Replace an item's whole value map (reassigns the Map so computeds re-run)
   * and schedule an autosave. */
  function setValues(itemId: string, next: MetadataValues): void {
    const map = new Map(values.value);
    map.set(itemId, next);
    values.value = map;
    markTouched(itemId);
    scheduleSave(itemId);
  }

  /** Set one field as an operator edit (provenance `user`). */
  function setFieldValue(itemId: string, key: string, value: unknown): void {
    const current = getValues(itemId);
    setValues(itemId, { ...current, [key]: { value, provenance: "user" } });
  }

  /** Load an item's working values from its `metadata.json` (once per item;
   * safe to call repeatedly). Loads the level's schema first so unknown keys
   * can be dropped and enum values normalised. */
  function ensureItemLoaded(item: Item): Promise<void> {
    knownItems.set(item.id, item);
    if (loadedItems.value.has(item.id)) return Promise.resolve();
    const inFlight = loadPromises.get(item.id);
    if (inFlight) return inFlight;
    const p = (async () => {
      const loading = new Set(loadingItems.value);
      loading.add(item.id);
      loadingItems.value = loading;
      try {
        await ensureSchema(item.level);
        let mirror: LocalMetadataFile | null = null;
        try {
          mirror = await readItemMetadata(item);
        } catch (err) {
          logger.warn("metadata", `Couldn't read metadata.json for ${item.id}.`, err);
        }
        mirrors.set(item.id, mirror);
        const fields = fieldsFor(item.level);
        const record = toFormRecord(fields, mirror?.metadata ?? {});
        const loaded = toMetadataValues(record, "user", fields);
        // Don't clobber edits made while the read was in flight.
        if (!values.value.has(item.id)) {
          const map = new Map(values.value);
          map.set(item.id, loaded);
          values.value = map;
        }
        const done = new Set(loadedItems.value);
        done.add(item.id);
        loadedItems.value = done;
      } finally {
        const loading2 = new Set(loadingItems.value);
        loading2.delete(item.id);
        loadingItems.value = loading2;
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

  /** The schema-pruned **wire** metadata for an item (what gets published). */
  function wireMetadata(itemId: string): Record<string, unknown> {
    const item = knownItems.get(itemId);
    const fields = item ? fieldsFor(item.level) : [];
    return pruneToSchema(toWireRecord(fields, plainValues(itemId)), fields);
  }

  /**
   * Write an item's working values to its `metadata.json` — only for items not
   * yet connected to a backend record (see the module doc). Connected items keep
   * their mirror as the backend snapshot; their edits stay in memory.
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
      mirrors.set(itemId, file);
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

  /** Flush any pending autosave for one item (or all) — call before an upload
   * and when leaving the editor. */
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

  // ── readiness ─────────────────────────────────────────────────────────────

  function readinessOf(item: Item): ItemReadiness {
    const fields = fieldsFor(item.level);
    if (fields.length === 0) return "untouched";
    return itemReadiness(fields, plainValues(item.id), {
      touched: isTouched(item.id) || undefined,
    });
  }

  function isReady(item: Item): boolean {
    const fields = fieldsFor(item.level);
    return fields.length > 0 && isItemValid(fields, plainValues(item.id));
  }

  // ── prefill sources ───────────────────────────────────────────────────────

  /** Apply a COBISS preview record onto an item (values normalised to the form
   * shape first). Returns the outcome; the caller raises the overwrite prompt
   * when `conflicts` is non-empty in `fill-empty` mode. */
  function applyCobissTo(
    itemId: string,
    record: Record<string, unknown>,
    mode: CobissApplyMode = "fill-empty",
  ): FillOutcome {
    const item = knownItems.get(itemId);
    const fields = item ? fieldsFor(item.level) : [];
    const outcome = applyCobiss(
      getValues(itemId),
      toFormRecord(fields, record),
      fields,
      mode,
    );
    if (outcome.applied.length > 0) setValues(itemId, outcome.values);
    return outcome;
  }

  /** Copy a data-passing parent's inheritable fields into an item's empties. */
  function applyParentTo(itemId: string, parent: ParentRecord): ApplyParentResult {
    const item = knownItems.get(itemId);
    const fields = item ? fieldsFor(item.level) : [];
    const normalised: ParentRecord = {
      ...parent,
      metadata: toFormRecord(fields, parent.metadata) as ParentRecord["metadata"],
    };
    const outcome = applyParentFields(getValues(itemId), normalised, fields);
    if (outcome.applied.length > 0) setValues(itemId, outcome.values);
    return outcome;
  }

  /** Apply a per-field source-picker choice. */
  function chooseSource(itemId: string, key: string, option: FieldSourceOption): void {
    setValues(itemId, chooseFieldSource(getValues(itemId), key, option));
  }

  // ── parent records (shared cache) ─────────────────────────────────────────
  const parentRecords = ref<Map<string, ParentRecord>>(new Map());
  const parentLoading = ref<Set<string>>(new Set());
  const parentPromises = new Map<string, Promise<void>>();

  function rememberParent(record: ParentRecord): void {
    const map = new Map(parentRecords.value);
    map.set(record.id, record);
    parentRecords.value = map;
  }

  /** Fetch a parent record by id (once), for linked refs whose record we don't
   * hold yet. Missing/404 leaves it absent — the link still renders by id. */
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
      } catch (err) {
        logger.warn("metadata", `Couldn't fetch parent ${id}.`, err);
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
    schemas,
    schemaLoading,
    schemaError,
    fieldsByLevel,
    fieldsFor,
    ensureSchema,
    // values
    values,
    touched,
    loadedItems,
    loadingItems,
    saving,
    saveError,
    getValues,
    plainValues,
    isTouched,
    setValues,
    setFieldValue,
    ensureItemLoaded,
    wireMetadata,
    flush,
    // readiness
    readinessOf,
    isReady,
    // prefill
    applyCobissTo,
    applyParentTo,
    chooseSource,
    // parents
    parentRecords,
    parentLoading,
    ensureParent,
    ensureParents,
    findParents,
    rememberParent,
  };
});
