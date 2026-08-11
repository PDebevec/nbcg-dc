/**
 * `useBatchSetup` — the view-model the batch **Setup tab** binds to (Seam 1).
 *
 * ⚠ STUB (GUI lane, per docs/04 "getting started") — mock in-memory data so the
 * Setup screen is fully navigable without the logic lane. Epic 03/05 replaces
 * the internals with real store/service wiring; **the returned shape is the
 * contract** and should survive the swap.
 */

import { computed, reactive, ref, toValue, type MaybeRefOrGetter } from "vue";

/** A linked parent record, as the Setup/Metadata parent lists render it. */
export interface ParentRowView {
  id: string;
  name: string;
  /** "Serial" / "Collection" — shown under the name. */
  typeLabel: string;
  /** Eligible to pass data (serial-type collectionType). */
  canPassData: boolean;
  /** The one parent currently passing its shared fields down. */
  passesData: boolean;
}

export type PublishTarget = "draft" | "record";
export type Visibility = "public" | "private" | "hidden";

const SAMPLE_POOL: ParentRowView[] = [
  { id: "NB-9021", name: "Prosvjeta (serial)", typeLabel: "Serial", canPassData: true, passesData: false },
  { id: "NB-9044", name: "Glas Crnogorca (serial)", typeLabel: "Serial", canPassData: true, passesData: false },
  { id: "NB-9077", name: "Cetinjski ljetopis (serial)", typeLabel: "Serial", canPassData: true, passesData: false },
  { id: "NB-COL-3", name: "Digitized periodicals", typeLabel: "Collection", canPassData: false, passesData: false },
];

export function useBatchSetup(_batchId: MaybeRefOrGetter<string>) {
  void toValue(_batchId); // stub: real impl resolves the batch through the store

  const cobissId = ref("");
  const parents = reactive<ParentRowView[]>([]);
  const parentQuery = ref("");
  const publish = ref<PublishTarget>("draft");
  const visibility = ref<Visibility>("public");
  const editable = ref(true);
  const itemCount = ref(3);

  const cobissSet = computed(() => cobissId.value.trim() !== "");

  function setCobissId(value: string): void {
    cobissId.value = value;
  }

  /** Stub: links the next sample parent; real impl searches the backend. */
  function addParent(): void {
    const next = SAMPLE_POOL.find((p) => !parents.some((x) => x.id === p.id));
    if (!next) return;
    const anyPasser = parents.some((p) => p.passesData);
    parents.push({ ...next, passesData: next.canPassData && !anyPasser });
  }

  function removeParent(id: string): void {
    const i = parents.findIndex((p) => p.id === id);
    if (i !== -1) parents.splice(i, 1);
  }

  /** Toggle which parent passes data — at most one at a time. */
  function togglePassesData(id: string): void {
    for (const p of parents) {
      p.passesData = p.id === id ? p.canPassData && !p.passesData : false;
    }
  }

  function setPublish(value: PublishTarget): void {
    publish.value = value;
  }

  function setVisibility(value: Visibility): void {
    visibility.value = value;
  }

  /** Apply batch defaults to all items and advance to Metadata. The stub only
   * signals completion; BatchWorkView switches the tab. */
  function applyAndContinue(): void {
    // real impl: copy the data-passing parent's shared fields + batch COBISS
    // prefill onto every member item, then advance the batch stage.
  }

  return {
    cobissId,
    cobissSet,
    setCobissId,
    parents,
    parentQuery,
    addParent,
    removeParent,
    togglePassesData,
    publish,
    setPublish,
    visibility,
    setVisibility,
    editable,
    itemCount,
    applyAndContinue,
  };
}
