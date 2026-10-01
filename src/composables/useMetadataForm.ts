/**
 * `useMetadataForm` (Epic 04/05) — the view-model the batch **Metadata tab**
 * binds to (Seam 1). Schema-driven: the fields come from the backend's v2
 * record schema; which show, which are required and whose rules apply come
 * from the store's save check (`checkOf`), values live in the metadata store
 * in their stored shape, prefill comes from COBISS / the data-passing parent
 * through `domain/provenance`.
 */

import {
  computed,
  getCurrentInstance,
  onMounted,
  onUnmounted,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from "vue";
import { storeToRefs } from "pinia";
import { useBatchesStore } from "@stores/useBatches";
import { useBatchWorkStore } from "@stores/useBatchWork";
import { useItemsStore } from "@stores/useItems";
import { useMetadataStore } from "@stores/useMetadata";
import { useToastsStore } from "@stores/useToasts";
import { useUploadStore } from "@stores/useUpload";
import {
  resolveItemPublish,
  resolveItemVisibility,
  type Batch,
  type BatchItemOverride,
} from "@domain/batch";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import type { Item } from "@domain/item";
import { labelText, type FieldV2 } from "@domain/schema";
import { isEmpty } from "@domain/schemaRules";
import type { MetadataValues } from "@domain/metadata";
import { fieldAtPath, splitByVisibility, statePathOf } from "@domain/schema-form";
import {
  firstIncompleteIndex,
  itemRole,
  publishNote,
  violationMessage,
  type ItemCheck,
  type ItemReadiness,
} from "@domain/schema-check";
import { getAtPath, keptUnit, numberFromText, quantityFromText, setAtPath, topKey } from "@domain/schema-values";
import { fieldSourceOptions } from "@domain/provenance";
import { missingParentNote, type ParentRecord } from "@domain/parent";
import { buildFieldViews, entryFromHint, toHintView, type FieldView, type HintView } from "./metadataFieldViews";
import { derivedOutputNames } from "@domain/naming";
import { fetchCobissPreview, cobissCollisionMessage } from "@services/api/cobiss";
import { fetchHints } from "@services/api/hints";
import { logger } from "@lib/logger";
import { useParentLinks } from "./useParentLinks";

export type { ParentRowView, ParentSearchRow } from "./useParentLinks";
export type {
  FieldKind,
  FieldOption,
  FieldSourceOptionView,
  FieldView,
  HintSource,
  HintView,
} from "./metadataFieldViews";

const HINT_DEBOUNCE_MS = 250;

/** One entry in the item navigator dropdown. */
export interface NavItemView {
  id: string;
  title: string;
  folderName: string;
  status: ItemReadiness;
  active: boolean;
}

/** One chip in the files strip. */
export interface FileChipView {
  name: string;
  meta: string;
  glyph: string;
  /** Role tag ("SOURCE"), '' = none. */
  tag: string;
  /** Muted (kept-local) styling. */
  local: boolean;
}

function previewOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(previewOf).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(previewOf)
      .filter(Boolean)
      .join(" · ");
  }
  return String(value);
}

export function useMetadataForm(batchId: MaybeRefOrGetter<string>) {
  const batches = useBatchesStore();
  const work = useBatchWorkStore();
  const itemsStore = useItemsStore();
  const metadata = useMetadataStore();
  const toasts = useToastsStore();
  const uploadStore = useUploadStore();
  const { readOnly } = storeToRefs(work);
  const { values: allValues, schemaLoading, schemaError, loadedItems, saving } =
    storeToRefs(metadata);

  const batch = computed<Batch | null>(() => batches.get(toValue(batchId)));

  /** Member items in batch order (those the index currently knows). */
  const items = computed<Item[]>(() => {
    const b = batch.value;
    if (!b) return [];
    const byId = new Map(itemsStore.items.map((i) => [i.id, i]));
    return b.itemIds.map((id) => byId.get(id)).filter((i): i is Item => i != null);
  });

  const index = ref(0);
  const showValidation = ref(false);
  const current = computed<Item | null>(() => items.value[index.value] ?? null);

  /**
   * Read-only while the batch is uploading, on top of the archived/locked
   * checks below — `uploadBatch` writes each item's mirror as it finishes, one
   * item at a time, and the store only reloads them once the whole run is
   * done; an edit made in that window would autosave `backendId: null` over a
   * mirror the upload just gave a backend link (bug spec decision 6).
   */
  const editable = computed(
    () =>
      batch.value != null &&
      batch.value.archivedAt == null &&
      !readOnly.value &&
      uploadStore.activeBatchId !== batch.value.id,
  );

  /** Shown while `editable` is false specifically because this batch is
   * uploading, so the operator knows the fields aren't stuck — just paused. */
  const uploadingNote = computed(() =>
    batch.value && uploadStore.activeBatchId === batch.value.id
      ? "Uploading — editing is paused until the upload finishes."
      : "",
  );

  // ── parents (the current item's own links; Link to all reaches every item) ──

  const links = useParentLinks(
    () => batch.value,
    () => (current.value ? [current.value] : []),
    {
      members: () => items.value,
      onPassingChanged: (changes) => {
        if (!editable.value) return;
        let fields = 0;
        let filled = 0;
        for (const { itemId, parent } of changes) {
          if (!parent) continue;
          const applied = metadata.applyParentTo(itemId, parent).applied.length;
          fields += applied;
          if (applied > 0) filled += 1;
        }
        if (fields === 0) return;
        toasts.push(
          filled === 1
            ? `Filled ${fields} field${fields === 1 ? "" : "s"} from the parent.`
            : `Filled ${fields} fields in ${filled} items from the parent.`,
          "success",
        );
      },
    },
  );

  // ── loading ──────────────────────────────────────────────────────────────

  const loading = computed(() => {
    const c = current.value;
    if (schemaLoading.value) return true;
    if (c == null) return false;
    return !loadedItems.value.has(c.id) || (metadata.schema != null && check.value == null);
  });

  watch(
    () => items.value.map((i) => i.id).join("|"),
    () => {
      for (const item of items.value) void metadata.ensureItemLoaded(item);
      if (index.value >= items.value.length) index.value = Math.max(0, items.value.length - 1);
    },
    { immediate: true },
  );

  // ── schema + values for the current item ─────────────────────────────────

  const fields = computed<FieldV2[]>(() => metadata.fields);
  const values = computed<MetadataValues>(() =>
    current.value ? (allValues.value.get(current.value.id) ?? {}) : {},
  );
  /** Whose rules apply to the current item and what they still need; null
   * while the schema or the item's parents are still loading. */
  const check = computed<ItemCheck | null>(() =>
    current.value ? metadata.checkOf(current.value) : null,
  );

  function readinessOf(item: Item): ItemReadiness {
    return metadata.readinessOf(item);
  }

  const readinesses = computed(() => items.value.map(readinessOf));

  const nav = computed(() => {
    const c = current.value;
    const total = items.value.length;
    return {
      index: index.value,
      total,
      title: c ? (c.title ?? c.folderName) : "",
      role: itemRole(check.value).role,
      roleLabel: itemRole(check.value).label,
      readyCount: readinesses.value.filter((r) => r === "ready").length,
      status: c ? readinessOf(c) : ("untouched" as ItemReadiness),
      items: items.value.map<NavItemView>((item, i) => ({
        id: item.id,
        title: item.title ?? item.folderName,
        folderName: item.folderName,
        status: readinesses.value[i],
        active: i === index.value,
      })),
    };
  });

  // ── files strip ──────────────────────────────────────────────────────────

  const files = computed<FileChipView[]>(() => {
    const c = current.value;
    if (!c) return [];
    const chips: FileChipView[] = [];
    const tiffs = c.assets.filter((a) => a.kind === "source-tiff").length;
    const images = c.assets.filter((a) => a.kind === "image").length;
    if (tiffs > 0) {
      chips.push({ name: `${tiffs} TIFF image${tiffs === 1 ? "" : "s"}`, meta: "Source scans · kept local", glyph: "▦", tag: "SOURCE", local: true });
    }
    if (images > 0) {
      chips.push({ name: `${images} image${images === 1 ? "" : "s"}`, meta: tiffs > 0 ? "extra images" : "page scans / thumbnail candidates", glyph: "▦", tag: tiffs > 0 ? "" : "SOURCE", local: tiffs > 0 });
    }
    const names = derivedOutputNames(c.folderName);
    const has = (kind: string) => c.assets.find((a) => a.kind === kind);
    const archival = has("archival-pdf");
    if (archival) chips.push({ name: archival.filename, meta: "archival master · kept local", glyph: "▤", tag: "", local: true });
    for (const pdf of c.assets.filter((a) => a.kind === "web-pdf")) {
      chips.push({ name: pdf.filename, meta: "web PDF · uploaded", glyph: "▢", tag: "", local: false });
    }
    const thumb = has("thumbnail");
    if (thumb) chips.push({ name: thumb.filename, meta: "thumbnail · uploaded", glyph: "◧", tag: "", local: false });
    for (const txt of c.assets.filter((a) => a.kind === "ocr-text")) {
      chips.push({ name: txt.filename, meta: "full text · uploaded", glyph: "≣", tag: "", local: false });
    }
    const ready = readinessOf(c) === "ready";
    chips.push({ name: names.metadata, meta: ready ? "catalogue fields ready" : "catalogue fields incomplete", glyph: "{ }", tag: "", local: false });
    return chips;
  });

  // ── fields ───────────────────────────────────────────────────────────────

  /** Validation messages by path — shown once the operator tried to move on. */
  const errors = computed<Record<string, string>>(() => {
    const c = check.value;
    if (!showValidation.value || !c) return {};
    const out: Record<string, string> = {};
    for (const m of c.missing) out[m.path] = "This field is required.";
    for (const v of c.violations) out[v.path] = violationMessage(v);
    return out;
  });

  /** Adds what needs the linked parents: the "Still to fill" flag and the
   * per-field source picker (shown when 2+ parents that can pass data have a
   * value for the field). */
  function decorate(list: FieldView[]): FieldView[] {
    const vals = values.value;
    const parentsForPicker: ParentRecord[] = links.sourceRecords.value;
    const hasPassingParent = links.passingParent.value != null;
    const byKey = new Map(fields.value.map((f) => [f.key, f]));
    return list.map((view) => {
      const field = byKey.get(view.key);
      if (!field) return view;
      const entry = vals[field.key];
      if (field.issueIdentifying && isEmpty(entry?.value) && hasPassingParent) view.flag = "Still to fill";
      if (field.parentInheritable && parentsForPicker.length >= 2) {
        const opts = fieldSourceOptions(field, vals, parentsForPicker).filter((o) => o.kind === "parent");
        if (opts.length >= 2) {
          view.sourceOptions = opts.map((o) => {
            const record = parentsForPicker.find((p) => p.id === o.parentId);
            return {
              parentId: o.parentId as string,
              name: record?.title ?? (o.parentId as string),
              preview: previewOf(o.value),
              selected: view.provenance === "parent" && entry?.sourceParentId === o.parentId,
            };
          });
          view.manualSelected = view.provenance === "user";
        }
      }
      return view;
    });
  }

  /** The fields to show, and the hidden ones that still hold a value. */
  const views = computed<{ shown: FieldView[]; other: FieldView[] }>(() => {
    const s = metadata.schema;
    const c = check.value;
    const cur = current.value;
    if (!s || !c || !cur) return { shown: [], other: [] };
    const split = splitByVisibility(fields.value, c.states, metadata.plainValues(cur.id));
    const build = (list: FieldV2[]) =>
      decorate(buildFieldViews({ schema: s, fields: list, states: c.states, values: values.value, errors: errors.value }));
    return { shown: build(split.shown), other: build(split.other) };
  });

  const fieldViews = computed(() => views.value.shown);
  const otherFieldViews = computed(() => views.value.other);

  const missing = computed(() => {
    const c = check.value;
    return c ? c.missing.length + c.violations.length : 0;
  });

  const validationBanner = computed(() =>
    showValidation.value && missing.value > 0
      ? `${missing.value} field${missing.value > 1 ? "s" : ""} still need${missing.value > 1 ? "" : "s"} attention on this item.`
      : "",
  );

  /** Why the current item's parents aren't usable yet, '' = they are: its own
   * links couldn't be read, or a parent's record failed to load (offline). The
   * form still works; the item is not ready until they load. */
  const parentsBanner = computed(() => {
    const c = current.value;
    if (!c) return "";
    const parents = metadata.parentsOf(c);
    if (parents.linksUnknown) {
      return "Couldn't read this item's parent links from the backend. Check the connection and retry.";
    }
    const names = parents.failed.map((id) => `'${id}'`);
    if (names.length === 0) return "";
    const list =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return `Couldn't load the parent${names.length === 1 ? "" : "s"} ${list}. Check the connection and retry.`;
  });

  /** Try the current item's parents again (after a failed load). */
  function retryParents(): Promise<void> {
    const c = current.value;
    return c ? metadata.retryItemParents(c) : Promise.resolve();
  }

  /** One banner when one of the item's parents is not on the backend (it
   * blocks the upload): "no longer exists" once an upload was refused, else
   * "can't be found". */
  const parentBanner = computed(() => {
    const c = current.value;
    return c ? missingParentNote(metadata.missingParentNamesOf(c)) : "";
  });

  const isLast = computed(() => index.value >= items.value.length - 1);
  const nextLabel = computed(() => (isLast.value ? "Go to processing →" : "Next item →"));
  const canNext = computed(() => current.value != null && readinessOf(current.value) === "ready");

  // ── field edits ──────────────────────────────────────────────────────────

  /** Set a value at a path (`title`, `publication.place`, `authors[1].role`)
   * as an operator edit. A number box's text is stored as a number, a
   * quantity box's as `{ value, unit }` with the unit the rules chose — or,
   * hidden in "Other fields" where they choose none, the unit it already had. */
  function setField(path: string, value: unknown): void {
    const c = current.value;
    const s = metadata.schema;
    if (!c || !s || !editable.value) return;
    const field = fieldAtPath(s.fields, path);
    if (!field) return;
    const key = topKey(path);
    let next = value;
    if (typeof value === "string") {
      if (field.type === "integer" || field.type === "number") next = numberFromText(value);
      else if (field.type === "quantity") {
        const held = getAtPath(values.value[key]?.value, path.slice(key.length));
        next = quantityFromText(
          value,
          check.value?.states[statePathOf(path)] ?? { unit: null },
          keptUnit(field, held),
        );
      }
    }
    const stored = key === path ? next : setAtPath(values.value[key]?.value, path.slice(key.length), next);
    metadata.setFieldValue(c.id, key, stored);
  }

  /** Add an empty entry to a repeatable object field. */
  function addEntry(key: string): void {
    const raw = values.value[key]?.value;
    setField(key, [...(Array.isArray(raw) ? raw : []), {}]);
  }

  /** Remove one entry of a repeatable object field. */
  function removeEntry(key: string, index: number): void {
    const raw = values.value[key]?.value;
    setField(key, (Array.isArray(raw) ? raw : []).filter((_, i) => i !== index));
  }

  function setFieldSource(key: string, parentId: string): void {
    const c = current.value;
    if (!c || !editable.value) return;
    const field = fields.value.find((f) => f.key === key);
    if (!field) return;
    const option = fieldSourceOptions(field, values.value, links.sourceRecords.value).find(
      (o) => o.kind === "parent" && o.parentId === parentId,
    );
    if (option) metadata.chooseSource(c.id, key, option);
  }

  function setFieldManual(key: string): void {
    const c = current.value;
    if (!c || !editable.value) return;
    metadata.chooseSource(c.id, key, {
      kind: "manual",
      parentId: null,
      value: values.value[key]?.value,
    });
  }

  // ── typeahead ────────────────────────────────────────────────────────────

  /** The one open hint list: which field it belongs to, and its hints. */
  const hintPath = ref<string | null>(null);
  const hintItems = ref<HintView[]>([]);
  let hintAbort: AbortController | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;

  function findView(
    path: string,
    list: FieldView[] = [...views.value.shown, ...views.value.other],
  ): FieldView | null {
    for (const v of list) {
      if (v.path === path) return v;
      const inner = findView(path, [...v.children, ...v.entries.flat()]);
      if (inner) return inner;
    }
    return null;
  }

  function closeHints(): void {
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = null;
    hintAbort?.abort();
    hintAbort = null;
    hintPath.value = null;
    hintItems.value = [];
  }

  /** Look up hints for what was typed into the field at `path` (debounced). */
  function requestHints(path: string, text: string): void {
    const view = findView(path);
    const source = view?.hints;
    closeHints();
    const q = text.trim();
    if (!view || !source || q.length < source.minChars) return;
    const storeAs = metadata.schema ? (fieldAtPath(metadata.schema.fields, path)?.values?.storeAs ?? null) : null;
    hintTimer = setTimeout(async () => {
      hintTimer = null;
      const controller = new AbortController();
      hintAbort = controller;
      try {
        const hints = await fetchHints(source.path, source.queryParam, q, { signal: controller.signal });
        if (controller.signal.aborted) return;
        hintPath.value = path;
        hintItems.value = hints
          .map((h) => toHintView(view, h.value, storeAs))
          .filter((h): h is HintView => h != null);
      } catch (err) {
        if (!controller.signal.aborted) logger.warn("metadata", `Couldn't load hints for ${path}.`, err);
      }
    }, HINT_DEBOUNCE_MS);
  }

  /** Use a hint: a free hint fills the box, a vocabulary hint sets or adds the
   * value, an author hint fills that author's sub-fields. */
  function pickHint(path: string, index: number): void {
    const view = findView(path);
    const hint = hintItems.value[index];
    closeHints();
    if (!view || !hint) return;
    if (view.hints?.fillsEntry) {
      const entryPath = path.slice(0, path.lastIndexOf("."));
      const key = topKey(entryPath);
      const entry = getAtPath(values.value[key]?.value, entryPath.slice(key.length));
      const shape = metadata.schema ? (fieldAtPath(metadata.schema.fields, entryPath)?.objectShape ?? []) : [];
      setField(entryPath, entryFromHint(entry, hint.stored, shape.map((c) => c.key)));
      return;
    }
    if (view.kind === "multi-hint" || view.kind === "multi-vocab") {
      const list = Array.isArray(view.raw) ? view.raw : [];
      const code = (x: unknown) =>
        x && typeof x === "object" && "code" in x ? String((x as { code: unknown }).code) : String(x);
      if (list.some((x) => code(x) === code(hint.stored))) return;
      setField(path, [...list, hint.stored]);
      return;
    }
    setField(path, hint.stored);
  }

  // ── navigation ───────────────────────────────────────────────────────────

  function jump(i: number): void {
    if (i < 0 || i >= items.value.length) return;
    closeHints();
    const prev = current.value;
    if (prev && prev.id !== items.value[i].id) void metadata.flush(prev.id);
    index.value = i;
    showValidation.value = false;
    cobissDone.value = false;
    cobissNote.value = null;
    overwritePrompt.value = null;
    pendingCobiss = null;
  }

  function prev(): void {
    jump(index.value - 1);
  }

  /** Next item, or — on the last item — signal "go to processing" (returns
   * true) once every item validates; otherwise jump to the first incomplete
   * one. */
  function next(): boolean {
    const c = current.value;
    if (!c) return false;
    if (readinessOf(c) !== "ready") {
      showValidation.value = true;
      return false;
    }
    if (!isLast.value) {
      jump(index.value + 1);
      return false;
    }
    const firstIncomplete = firstIncompleteIndex(readinesses.value);
    if (firstIncomplete !== -1) {
      const remaining = readinesses.value.filter((r) => r !== "ready").length;
      jump(firstIncomplete);
      showValidation.value = true;
      toasts.push(`${remaining} item${remaining === 1 ? "" : "s"} still need${remaining === 1 ? "s" : ""} metadata.`, "warning");
      return false;
    }
    void metadata.flush();
    return true;
  }

  // ── COBISS (per item) ────────────────────────────────────────────────────

  const cobissDraft = ref<string | null>(null);
  const cobissId = computed(
    () => cobissDraft.value ?? current.value?.catalogueId ?? batch.value?.cobissId ?? "",
  );
  const cobissLoading = ref(false);
  const cobissDone = ref(false);
  /** Outcome note (not found / forbidden / collision), null = none. */
  const cobissNote = ref<string | null>(null);
  /** Field label(s) that would be overwritten, null = no prompt. */
  const overwritePrompt = ref<string | null>(null);
  let pendingCobiss: Record<string, unknown> | null = null;

  function setCobissId(value: string): void {
    cobissDraft.value = value;
  }

  async function getCobiss(): Promise<void> {
    const c = current.value;
    if (!c || cobissLoading.value || !editable.value) return;
    const id = cobissId.value.trim();
    if (!id) {
      cobissNote.value = "Enter a COBISS ID.";
      return;
    }
    cobissLoading.value = true;
    cobissNote.value = null;
    overwritePrompt.value = null;
    try {
      const outcome = await fetchCobissPreview(id);
      if (outcome.status !== "found") {
        cobissNote.value = outcome.message;
        return;
      }
      const record = outcome.preview.metadata as Record<string, unknown>;
      // Carry the COBISS id itself so the upload can reuse the deterministic id.
      if (!record.cobissId) record.cobissId = outcome.preview.cobissId ?? id;
      const collision = cobissCollisionMessage(outcome.preview);
      const result = metadata.applyCobissTo(c.id, record, "fill-empty");
      if (result.conflicts.length > 0) {
        pendingCobiss = record;
        const labels = result.conflicts.map(
          (k) => labelText(fields.value.find((f) => f.key === k.key)?.label) || k.key,
        );
        overwritePrompt.value =
          labels.length <= 2
            ? labels.join(" and ")
            : `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`;
      } else {
        cobissDone.value = true;
      }
      if (collision) cobissNote.value = collision;
    } finally {
      cobissLoading.value = false;
    }
  }

  /** Resolve the overwrite prompt: overwrite user edits, or keep them (the
   * empties were already filled). */
  function applyCobiss(overwrite: boolean): void {
    const c = current.value;
    if (c && overwrite && pendingCobiss) metadata.applyCobissTo(c.id, pendingCobiss, "overwrite-all");
    pendingCobiss = null;
    overwritePrompt.value = null;
    cobissDone.value = true;
  }

  // ── per-item publish + visibility ────────────────────────────────────────

  /** The item's state on the backend; null before its first upload. */
  const backendState = computed(() =>
    current.value ? (metadata.backendStates.get(current.value.id) ?? null) : null,
  );
  /** Draft/Record is chosen only for a new item; the web app moves it after. */
  const publishLocked = computed(() => backendState.value != null);
  const publish = computed<PublishTarget>(() =>
    backendState.value ??
    (batch.value && current.value ? resolveItemPublish(batch.value, current.value.id) : PublishTarget.DRAFT),
  );
  const publishHint = computed(() => publishNote(check.value, backendState.value));
  const visibility = computed<VisibilityStatus>(() =>
    batch.value && current.value
      ? resolveItemVisibility(batch.value, current.value.id)
      : VisibilityStatus.PRIVATE,
  );
  const publishOverridden = computed(
    () => batch.value?.overrides[current.value?.id ?? ""]?.publish != null,
  );
  const visibilityOverridden = computed(
    () => batch.value?.overrides[current.value?.id ?? ""]?.visibility != null,
  );
  const batchPublish = computed(() => batch.value?.publish ?? PublishTarget.DRAFT);
  const batchVisibility = computed(() => batch.value?.visibility ?? VisibilityStatus.PRIVATE);

  async function patchOverride(patch: BatchItemOverride): Promise<void> {
    const b = batch.value;
    const c = current.value;
    if (!b || !c || !editable.value) return;
    const existing = b.overrides[c.id] ?? {};
    try {
      await batches.update({
        ...b,
        overrides: { ...b.overrides, [c.id]: { ...existing, ...patch } },
      });
    } catch {
      toasts.push("Couldn't save the item's publish settings.", "error");
    }
  }

  function setPublish(value: PublishTarget): void {
    if (publishLocked.value) return;
    void patchOverride({ publish: value });
  }

  function setVisibility(value: VisibilityStatus): void {
    void patchOverride({ visibility: value });
  }

  function resetPublishToBatch(): void {
    void patchOverride({ publish: null });
  }

  function resetVisibilityToBatch(): void {
    void patchOverride({ visibility: null });
  }

  // Opened from Processing → "Edit metadata": start on that item with its
  // validation shown. (Placed last: `jump` reads state declared above.)
  watch(
    () => items.value.map((i) => i.id).join("|"),
    () => {
      const id = work.focusItemId;
      if (!id) return;
      const i = items.value.findIndex((it) => it.id === id);
      if (i === -1) return;
      work.takeFocus();
      jump(i);
      showValidation.value = true;
    },
    { immediate: true },
  );

  // ── lifecycle ────────────────────────────────────────────────────────────

  async function init(): Promise<void> {
    if (!itemsStore.loaded) await itemsStore.load();
  }

  if (getCurrentInstance()) {
    onMounted(init);
    onUnmounted(() => {
      closeHints();
      void metadata.flush();
    });
  }

  return {
    nav,
    files,
    fields: fieldViews,
    otherFields: otherFieldViews,
    editable,
    uploadingNote,
    loading,
    schemaError,
    saving: computed(() => saving.value.size > 0),
    validationBanner,
    parentsBanner,
    parentBanner,
    nextLabel,
    canNext,
    isLast,
    // navigation
    jump,
    prev,
    next,
    // field edits
    setField,
    addEntry,
    removeEntry,
    setFieldSource,
    setFieldManual,
    // typeahead
    hintPath,
    hintItems,
    requestHints,
    pickHint,
    closeHints,
    // COBISS
    cobissId,
    setCobissId,
    getCobiss,
    cobissLoading,
    cobissDone,
    cobissNote,
    overwritePrompt,
    applyCobiss,
    // parents
    parents: links.parents,
    parentQuery: links.parentQuery,
    setParentQuery: links.setQuery,
    parentPickerOpen: links.pickerOpen,
    openParentPicker: links.openPicker,
    closeParentPicker: links.closePicker,
    parentResults: links.results,
    parentSearching: links.searching,
    parentSearchError: links.searchError,
    linkParent: links.linkParent,
    removeParent: links.removeParent,
    restoreParent: links.restoreParent,
    linkParentToAll: links.linkParentToAll,
    memberCount: computed(() => items.value.length),
    togglePassesData: links.togglePassesData,
    retryParents,
    // publish / visibility (per item)
    publish,
    publishLocked,
    publishHint,
    visibility,
    publishOverridden,
    visibilityOverridden,
    batchPublish,
    batchVisibility,
    setPublish,
    setVisibility,
    resetPublishToBatch,
    resetVisibilityToBatch,
  };
}
