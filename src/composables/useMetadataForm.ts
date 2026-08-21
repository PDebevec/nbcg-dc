/**
 * `useMetadataForm` (Epic 04/05) — the view-model the batch **Metadata tab**
 * binds to (Seam 1). Schema-driven: the fields come from the backend record
 * schema for the item's level (`main`/`child`), values live in the metadata
 * store (provenance-tagged, autosaved to the folder mirror), validation and
 * readiness come from `domain/metadata-form`, prefill from COBISS / the
 * data-passing parent through `domain/provenance`.
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
import {
  resolveItemPublish,
  resolveItemVisibility,
  type Batch,
  type BatchItemOverride,
} from "@domain/batch";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import type { Item } from "@domain/item";
import type { FieldDescriptor } from "@domain/schema";
import { PROVENANCE_LABELS, type MetadataValues, type Provenance } from "@domain/metadata";
import {
  firstIncompleteIndex,
  humanizeKey,
  isEmptyValue,
  optionLabel,
  validateField,
  type FieldError,
  type ItemReadiness,
} from "@domain/metadata-form";
import { fieldSourceOptions } from "@domain/provenance";
import type { ParentRecord } from "@domain/parent";
import { isBlankObject } from "@domain/metadata-wire";
import { derivedOutputNames } from "@domain/naming";
import { fetchCobissPreview, cobissCollisionMessage } from "@services/api/cobiss";
import { useParentLinks } from "./useParentLinks";

export type { ParentRowView, ParentSearchRow } from "./useParentLinks";

/** How a field renders. Object shapes nest primitive kinds only. */
export type FieldKind =
  | "text"
  | "number"
  | "boolean"
  | "enum"
  | "multi"
  | "multi-enum"
  | "object"
  | "object-list";

export interface FieldOption {
  value: string;
  label: string;
}

/** A source option in a field's per-field source picker. */
export interface FieldSourceOptionView {
  parentId: string;
  name: string;
  /** Preview of the value this parent would supply. */
  preview: string;
  selected: boolean;
}

/** One schema-driven form field, shaped for rendering. */
export interface FieldView {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  /** Spans both form columns. */
  wide: boolean;
  /** The raw current form value (the editor's shape) — composite kinds build
   * their next value from this. */
  raw: unknown;
  /** Scalar rendering for text / number / enum / boolean ('' when unset). */
  value: string;
  /** Multi kinds: the chips (codes for multi-enum). */
  chips: string[];
  /** Display labels for the chips (option labels for multi-enum). */
  chipLabels: string[];
  /** Options for enum / multi-enum / boolean. */
  options: FieldOption[];
  /** `object`: one view per child field, values filled. */
  children: FieldView[];
  /** `object-list`: child-field views per entry. */
  entries: FieldView[][];
  provenance: Provenance | "none";
  /** Provenance-tag copy ("COBISS" / "From parent" / "Edited"), '' = no tag. */
  provLabel: string;
  /** Per-field source picker (2+ parents can supply this field). */
  sourceOptions: FieldSourceOptionView[];
  /** Manual entry is the active source. */
  manualSelected: boolean;
  /** Validation message once validation shows, else ''. */
  error: string;
  /** "Still to fill" hint on empty per-issue fields, else ''. */
  flag: string;
  /** Schema group key + label; `groupStart` marks the first field of a group. */
  group: string;
  groupLabel: string;
  groupStart: boolean;
}

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

const BOOLEAN_OPTIONS: FieldOption[] = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

const ERROR_COPY: Record<FieldError["code"], string> = {
  required: "This field is required.",
  not_allowed: "Choose one of the allowed options.",
  wrong_type: "This value has the wrong type.",
};

function kindOf(field: FieldDescriptor): FieldKind {
  switch (field.type) {
    case "enum":
      return "enum";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "array":
      if (field.itemType === "enum") return "multi-enum";
      if (field.itemType === "object") return "object-list";
      return "multi";
    default:
      return "text";
  }
}

function optionsOf(field: FieldDescriptor): FieldOption[] {
  if (field.type === "boolean") return BOOLEAN_OPTIONS;
  return (field.allowedValues ?? []).map((c) => ({ value: c.code, label: optionLabel(c) }));
}

function scalarString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
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

function fieldIsEmpty(field: FieldDescriptor, value: unknown): boolean {
  if (isEmptyValue(value)) return true;
  if (field.type === "object") return isBlankObject(value);
  return false;
}

/** Build the nested child views of an object-shaped field (no provenance,
 * no source picker — those live on the top-level field). */
function childViews(
  shape: readonly FieldDescriptor[],
  value: Record<string, unknown>,
): FieldView[] {
  return shape.map((child) => baseView(child, value[child.key], { nested: true }));
}

function baseView(
  field: FieldDescriptor,
  raw: unknown,
  opts: { nested: boolean },
): FieldView {
  const kind = kindOf(field);
  const options = optionsOf(field);
  const optionLabelFor = (code: string) =>
    options.find((o) => o.value === code)?.label ?? code;
  const chips =
    (kind === "multi" || kind === "multi-enum") && Array.isArray(raw)
      ? raw.map((v) => scalarString(v))
      : [];
  const objectValue =
    kind === "object" && raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const entries =
    kind === "object-list" && Array.isArray(raw)
      ? raw.map((entry) =>
          childViews(
            field.objectShape ?? [],
            entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {},
          ),
        )
      : [];
  return {
    key: field.key,
    label: humanizeKey(field.key),
    kind,
    required: field.required,
    wide:
      !opts.nested &&
      (kind === "object" || kind === "object-list" || kind === "multi" || kind === "multi-enum"),
    raw,
    value: scalarString(raw),
    chips,
    chipLabels: kind === "multi-enum" ? chips.map(optionLabelFor) : chips,
    options,
    children: kind === "object" ? childViews(field.objectShape ?? [], objectValue) : [],
    entries,
    provenance: "none",
    provLabel: "",
    sourceOptions: [],
    manualSelected: false,
    error: "",
    flag: "",
    group: field.group,
    groupLabel: humanizeKey(field.group),
    groupStart: false,
  };
}

export function useMetadataForm(batchId: MaybeRefOrGetter<string>) {
  const batches = useBatchesStore();
  const work = useBatchWorkStore();
  const itemsStore = useItemsStore();
  const metadata = useMetadataStore();
  const toasts = useToastsStore();
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

  const editable = computed(
    () => batch.value != null && batch.value.archivedAt == null && !readOnly.value,
  );

  // ── parents (batch-level links; data passes to the current item) ─────────

  const links = useParentLinks(
    () => batch.value,
    {
      onPassingChanged: (parent) => {
        if (parent && current.value && editable.value) {
          const r = metadata.applyParentTo(current.value.id, parent);
          if (r.applied.length) toasts.push(`Filled ${r.applied.length} field${r.applied.length === 1 ? "" : "s"} from the parent.`, "success");
        }
      },
    },
  );

  // ── loading ──────────────────────────────────────────────────────────────

  const loading = computed(() => {
    const c = current.value;
    return schemaLoading.value || (c != null && !loadedItems.value.has(c.id));
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

  const fields = computed<FieldDescriptor[]>(() =>
    current.value ? metadata.fieldsFor(current.value.level) : [],
  );
  const values = computed<MetadataValues>(() =>
    current.value ? (allValues.value.get(current.value.id) ?? {}) : {},
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
      level: c?.level ?? "main",
      levelLabel: c?.level === "child" ? "Child record" : "Main record",
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

  const fieldViews = computed<FieldView[]>(() => {
    const c = current.value;
    if (!c) return [];
    const vals = values.value;
    const parentsForPicker: ParentRecord[] = links.linkedRecords.value;
    const hasPassingParent = links.passingParent.value != null;
    let lastGroup: string | null = null;
    return fields.value.map((field) => {
      const entry = vals[field.key];
      const raw = entry?.value;
      const view = baseView(field, raw, { nested: false });
      const empty = fieldIsEmpty(field, raw);
      const prov: Provenance | "none" = entry && !empty ? entry.provenance : "none";
      view.provenance = prov;
      view.provLabel = prov === "none" ? "" : PROVENANCE_LABELS[prov];
      if (showValidation.value) {
        const err = validateField(field, raw);
        view.error = err ? ERROR_COPY[err.code] : "";
      }
      if (field.issueIdentifying && empty && hasPassingParent) view.flag = "Still to fill";
      // Per-field source picker — shown when 2+ parents could supply the field.
      if (field.parentInheritable && parentsForPicker.length >= 2) {
        const opts = fieldSourceOptions(field, vals, parentsForPicker).filter(
          (o) => o.kind === "parent",
        );
        if (opts.length >= 2) {
          view.sourceOptions = opts.map((o) => {
            const record = parentsForPicker.find((p) => p.id === o.parentId);
            return {
              parentId: o.parentId as string,
              name: record?.title ?? (o.parentId as string),
              preview: previewOf(o.value),
              selected: prov === "parent" && entry?.sourceParentId === o.parentId,
            };
          });
          view.manualSelected = prov === "user";
        }
      }
      view.groupStart = field.group !== lastGroup;
      lastGroup = field.group;
      return view;
    });
  });

  const missing = computed(() => {
    const c = current.value;
    if (!c) return 0;
    const vals = metadata.plainValues(c.id);
    return fields.value.filter((f) => validateField(f, vals[f.key]) != null).length;
  });

  const validationBanner = computed(() =>
    showValidation.value && missing.value > 0
      ? `${missing.value} field${missing.value > 1 ? "s" : ""} still need${missing.value > 1 ? "" : "s"} attention on this item.`
      : "",
  );

  const isLast = computed(() => index.value >= items.value.length - 1);
  const nextLabel = computed(() => (isLast.value ? "Go to processing →" : "Next item →"));
  const canNext = computed(() => current.value != null && readinessOf(current.value) === "ready");

  // ── field edits ──────────────────────────────────────────────────────────

  function setField(key: string, value: unknown): void {
    const c = current.value;
    if (!c || !editable.value) return;
    metadata.setFieldValue(c.id, key, value);
  }

  function setFieldSource(key: string, parentId: string): void {
    const c = current.value;
    if (!c || !editable.value) return;
    const field = fields.value.find((f) => f.key === key);
    if (!field) return;
    const option = fieldSourceOptions(field, values.value, links.linkedRecords.value).find(
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

  // ── navigation ───────────────────────────────────────────────────────────

  function jump(i: number): void {
    if (i < 0 || i >= items.value.length) return;
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
        const labels = result.conflicts.map((k) => humanizeKey(k.key));
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

  const publish = computed<PublishTarget>(() =>
    batch.value && current.value
      ? resolveItemPublish(batch.value, current.value.id)
      : PublishTarget.DRAFT,
  );
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

  // ── lifecycle ────────────────────────────────────────────────────────────

  async function init(): Promise<void> {
    if (!itemsStore.loaded) await itemsStore.load();
  }

  if (getCurrentInstance()) {
    onMounted(init);
    onUnmounted(() => void metadata.flush());
  }

  return {
    nav,
    files,
    fields: fieldViews,
    editable,
    loading,
    schemaError,
    saving: computed(() => saving.value.size > 0),
    validationBanner,
    nextLabel,
    canNext,
    isLast,
    // navigation
    jump,
    prev,
    next,
    // field edits
    setField,
    setFieldSource,
    setFieldManual,
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
    parentResults: links.results,
    parentSearching: links.searching,
    parentSearchError: links.searchError,
    linkParent: links.linkParent,
    removeParent: links.removeParent,
    togglePassesData: links.togglePassesData,
    // publish / visibility (per item)
    publish,
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
