/**
 * `useMetadataForm` (Epic 04/05) — the view-model the batch **Metadata tab**
 * binds to (Seam 1).
 *
 * ⚠ STUB (GUI lane, per docs/04 "getting started") — mock in-memory items and a
 * hard-coded schema so the Metadata screen is fully navigable without the logic
 * lane. Epic 04/05 replaces the internals (backend-driven schema, real
 * provenance, COBISS fetch, persistence); **the returned shape is the
 * contract** and should survive the swap.
 */

import {
  computed,
  reactive,
  ref,
  toValue,
  type MaybeRefOrGetter,
} from "vue";
import type { ParentRowView } from "./useBatchSetup";

export type FieldKind = "text" | "date" | "enum" | "multi";
export type Provenance = "cobiss" | "parent" | "user" | "none";

/** A source option in a field's per-field source picker. */
export interface FieldSourceOption {
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
  /** Spans both form columns (long text / multi fields). */
  wide: boolean;
  value: string;
  chips: string[];
  options: string[];
  provenance: Provenance;
  /** Provenance-tag copy ("COBISS" / "From parent" / "Edited"), '' = no tag. */
  provLabel: string;
  /** Per-field source picker (2+ parents can supply this field). */
  sourceOptions: FieldSourceOption[];
  /** Manual entry is the active source. */
  manualSelected: boolean;
  /** "This field is required." once validation shows, else ''. */
  error: string;
  /** "Still to fill" hint on empty per-issue fields, else ''. */
  flag: string;
}

/** One entry in the item navigator dropdown. */
export interface NavItemView {
  title: string;
  folderName: string;
  status: "ready" | "incomplete" | "untouched";
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

interface StubItem {
  title: string;
  folderName: string;
  level: "main" | "child";
  visited: boolean;
  meta: Record<string, { v: string | string[]; p: Provenance; src?: string }>;
}

/** Hard-coded main-level schema (mirrors the prototype; real one is backend-driven). */
const SCHEMA: ReadonlyArray<{
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
}> = [
  { key: "title", label: "Title", kind: "text", required: true },
  { key: "author", label: "Author", kind: "text", required: false },
  { key: "year", label: "Publication year", kind: "text", required: false },
  { key: "lang", label: "Language", kind: "enum", required: false },
  { key: "place", label: "Place of publication", kind: "text", required: false },
  { key: "publisher", label: "Publisher", kind: "text", required: false },
  { key: "subject", label: "Subject", kind: "multi", required: false },
  { key: "phys", label: "Physical description", kind: "text", required: false },
  { key: "note", label: "Note", kind: "text", required: false },
];

const LANG_OPTIONS = [
  "Montenegrin",
  "Serbian",
  "Church Slavonic",
  "Italian",
  "Russian",
];

const COBISS_SAMPLE: Record<string, string | string[]> = {
  title: "Gorski vijenac : istoričesko sobitije pri svršetku XVII vijeka",
  author: "Petar II Petrović Njegoš",
  year: "1847",
  lang: "Montenegrin",
  place: "Beč",
  publisher: "Jermenski manastir",
  subject: ["Epska poezija", "Crnogorska književnost"],
  phys: "IV, 264 str. ; 21 cm",
  note: "Prvo izdanje.",
};

function makeStubItems(): StubItem[] {
  return [
    {
      title: "Pobjeda, 1948, br. 1",
      folderName: "pobjeda_1948_01",
      level: "main",
      visited: true,
      meta: { title: { v: "Pobjeda", p: "user" } },
    },
    {
      title: "Pobjeda, 1948, br. 2",
      folderName: "pobjeda_1948_02",
      level: "main",
      visited: false,
      meta: {},
    },
    {
      title: "Pobjeda, 1948, br. 3",
      folderName: "pobjeda_1948_03",
      level: "main",
      visited: false,
      meta: {},
    },
  ];
}

export function useMetadataForm(_batchId: MaybeRefOrGetter<string>) {
  void toValue(_batchId); // stub: real impl resolves the batch through the store

  const items = reactive(makeStubItems());
  const index = ref(0);
  const showValidation = ref(false);
  const editable = ref(true);

  const cobissId = ref("");
  const cobissLoading = ref(false);
  const cobissDone = ref(false);
  /** Field label that would be overwritten, null = no prompt. */
  const overwritePrompt = ref<string | null>(null);

  const parents = reactive<ParentRowView[]>([]);

  const current = computed(() => items[index.value]);

  function missingCount(item: StubItem): number {
    return SCHEMA.filter((f) => {
      if (!f.required) return false;
      const mv = item.meta[f.key];
      if (!mv) return true;
      return Array.isArray(mv.v) ? mv.v.length === 0 : !mv.v;
    }).length;
  }

  function statusOf(item: StubItem): NavItemView["status"] {
    if (missingCount(item) === 0) return "ready";
    return item.visited ? "incomplete" : "untouched";
  }

  const nav = computed(() => ({
    index: index.value,
    total: items.length,
    title: current.value.title,
    level: current.value.level,
    levelLabel: current.value.level === "child" ? "Child record" : "Main record",
    readyCount: items.filter((i) => missingCount(i) === 0).length,
    status: statusOf(current.value),
    items: items.map<NavItemView>((item, i) => ({
      title: item.title,
      folderName: item.folderName,
      status: statusOf(item),
      active: i === index.value,
    })),
  }));

  const files = computed<FileChipView[]>(() => [
    { name: "28 TIFF images", meta: "Source scans · kept local", glyph: "▦", tag: "SOURCE", local: true },
    { name: `${current.value.folderName}_archive.pdf`, meta: "archival master", glyph: "▤", tag: "", local: false },
    { name: `${current.value.folderName}.pdf`, meta: "web-ready", glyph: "▢", tag: "", local: false },
    { name: `${current.value.folderName}_thumb.png`, meta: "first page", glyph: "◧", tag: "", local: false },
    { name: `${current.value.folderName}.txt`, meta: "full text", glyph: "≣", tag: "", local: false },
    { name: `${current.value.folderName}.json`, meta: missingCount(current.value) === 0 ? "catalog fields ready" : "incomplete", glyph: "{ }", tag: "", local: false },
  ]);

  const fields = computed<FieldView[]>(() =>
    SCHEMA.map((f) => {
      const mv = current.value.meta[f.key];
      const value = mv?.v ?? (f.kind === "multi" ? [] : "");
      const empty = Array.isArray(value) ? value.length === 0 : !value;
      const prov: Provenance = mv?.p ?? "none";
      const error =
        showValidation.value && f.required && empty
          ? "This field is required."
          : "";
      const provLabel =
        prov === "cobiss"
          ? "COBISS"
          : prov === "parent"
            ? "From parent"
            : prov === "user" && !empty
              ? "Edited"
              : "";
      return {
        key: f.key,
        label: f.label,
        kind: f.kind,
        required: f.required,
        wide: f.kind === "multi" || f.key === "note" || f.key === "phys",
        value: Array.isArray(value) ? "" : value,
        chips: Array.isArray(value) ? value : [],
        options: f.kind === "enum" ? LANG_OPTIONS : [],
        provenance: prov,
        provLabel,
        sourceOptions: [],
        manualSelected: prov === "user",
        error,
        flag: "",
      };
    }),
  );

  const missing = computed(() => missingCount(current.value));

  const validationBanner = computed(() =>
    showValidation.value && missing.value > 0
      ? `${missing.value} required field${missing.value > 1 ? "s are" : " is"} still missing on this item.`
      : "",
  );

  const isLast = computed(() => index.value === items.length - 1);
  const nextLabel = computed(() =>
    isLast.value ? "Go to processing →" : "Next item →",
  );
  const canNext = computed(() => missing.value === 0);

  // ── actions ──────────────────────────────────────────────────────────────

  function setField(key: string, value: string): void {
    current.value.meta[key] = { v: value, p: "user" };
  }

  function addChip(key: string, value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    const mv = current.value.meta[key];
    const list = mv && Array.isArray(mv.v) ? mv.v : [];
    current.value.meta[key] = { v: [...list, trimmed], p: "user" };
  }

  function setFieldSource(_key: string, _parentId: string): void {
    // stub: real impl copies that parent's value + provenance onto the field
  }

  function setFieldManual(key: string): void {
    const mv = current.value.meta[key];
    current.value.meta[key] = { v: mv?.v ?? "", p: "user" };
  }

  function jump(i: number): void {
    if (i < 0 || i >= items.length) return;
    index.value = i;
    items[i].visited = true;
    showValidation.value = false;
    cobissDone.value = false;
    overwritePrompt.value = null;
  }

  function prev(): void {
    jump(index.value - 1);
  }

  /** Next item, or — on the last item — signal "go to processing" (returns
   * true) once the current item validates. */
  function next(): boolean {
    if (missing.value > 0) {
      showValidation.value = true;
      return false;
    }
    if (!isLast.value) {
      jump(index.value + 1);
      return false;
    }
    return true;
  }

  function setCobissId(value: string): void {
    cobissId.value = value;
  }

  /** Stub COBISS fetch: fills fields after a short delay; raises the overwrite
   * prompt when a user-edited field would be clobbered. */
  function getCobiss(): void {
    if (cobissLoading.value) return;
    cobissLoading.value = true;
    setTimeout(() => {
      const conflict = Object.keys(COBISS_SAMPLE).find((k) => {
        const mv = current.value.meta[k];
        return mv && mv.p === "user" && (Array.isArray(mv.v) ? mv.v.length : mv.v);
      });
      cobissLoading.value = false;
      if (conflict) {
        overwritePrompt.value =
          SCHEMA.find((f) => f.key === conflict)?.label ?? conflict;
      } else {
        applyCobiss(true);
      }
    }, 900);
  }

  function applyCobiss(overwrite: boolean): void {
    for (const [k, v] of Object.entries(COBISS_SAMPLE)) {
      const mv = current.value.meta[k];
      const has = mv && (Array.isArray(mv.v) ? mv.v.length : mv.v);
      if (!has || overwrite) current.value.meta[k] = { v, p: "cobiss" };
    }
    overwritePrompt.value = null;
    cobissDone.value = true;
  }

  function addParent(): void {
    // stub: same sample pool behaviour as Setup
    const pool: ParentRowView[] = [
      { id: "NB-9021", name: "Prosvjeta (serial)", typeLabel: "Serial", canPassData: true, passesData: false },
      { id: "NB-9044", name: "Glas Crnogorca (serial)", typeLabel: "Serial", canPassData: true, passesData: false },
    ];
    const nextP = pool.find((p) => !parents.some((x) => x.id === p.id));
    if (!nextP) return;
    const anyPasser = parents.some((p) => p.passesData);
    parents.push({ ...nextP, passesData: nextP.canPassData && !anyPasser });
  }

  function removeParent(id: string): void {
    const i = parents.findIndex((p) => p.id === id);
    if (i !== -1) parents.splice(i, 1);
  }

  function togglePassesData(id: string): void {
    for (const p of parents) {
      p.passesData = p.id === id ? p.canPassData && !p.passesData : false;
    }
  }

  return {
    nav,
    files,
    fields,
    parents,
    editable,
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
    addChip,
    setFieldSource,
    setFieldManual,
    // COBISS
    cobissId,
    setCobissId,
    getCobiss,
    cobissLoading,
    cobissDone,
    overwritePrompt,
    applyCobiss,
    // parents
    addParent,
    removeParent,
    togglePassesData,
  };
}
