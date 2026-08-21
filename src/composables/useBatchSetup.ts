/**
 * `useBatchSetup` (Epic 03/05) — the view-model the batch **Setup tab** binds to
 * (Seam 1). Batch-wide defaults: the COBISS prefill id, the linked parent
 * records (+ which one passes data), the publish target and visibility — all
 * persisted on the batch — and **Apply & continue**, which copies the
 * data-passing parent's shared fields and the COBISS record onto every member
 * item's empty fields, then hands over to the Metadata tab.
 */

import { computed, getCurrentInstance, onMounted, onUnmounted, ref, toValue, type MaybeRefOrGetter } from "vue";
import { storeToRefs } from "pinia";
import { useBatchesStore } from "@stores/useBatches";
import { useBatchWorkStore } from "@stores/useBatchWork";
import { useItemsStore } from "@stores/useItems";
import { useMetadataStore } from "@stores/useMetadata";
import { useToastsStore } from "@stores/useToasts";
import { PublishTarget, VisibilityStatus } from "@domain/enums";
import type { Batch } from "@domain/batch";
import type { Item } from "@domain/item";
import { fetchCobissPreview } from "@services/api/cobiss";
import { logger } from "@lib/logger";
import { useParentLinks } from "./useParentLinks";

export type { ParentRowView, ParentSearchRow } from "./useParentLinks";

/** Persist delay for the batch-wide COBISS id while typing. */
const COBISS_PERSIST_MS = 500;

export function useBatchSetup(batchId: MaybeRefOrGetter<string>) {
  const batches = useBatchesStore();
  const work = useBatchWorkStore();
  const items = useItemsStore();
  const metadata = useMetadataStore();
  const toasts = useToastsStore();
  const { readOnly } = storeToRefs(work);

  const batch = computed<Batch | null>(() => batches.get(toValue(batchId)));
  const links = useParentLinks(() => batch.value);

  const editable = computed(
    () => batch.value != null && batch.value.archivedAt == null && !readOnly.value,
  );
  const itemCount = computed(() => batch.value?.itemIds.length ?? 0);

  /** Member items in batch order (those the index currently knows). */
  const memberItems = computed<Item[]>(() => {
    const b = batch.value;
    if (!b) return [];
    const byId = new Map(items.items.map((i) => [i.id, i]));
    return b.itemIds.map((id) => byId.get(id)).filter((i): i is Item => i != null);
  });

  async function persistBatch(patch: Partial<Batch>): Promise<void> {
    const b = batch.value;
    if (!b) return;
    try {
      await batches.update({ ...b, ...patch });
    } catch (err) {
      logger.error("setup", "Couldn't save the batch settings.", err);
      toasts.push("Couldn't save the batch settings.", "error");
    }
  }

  // ── COBISS prefill id ────────────────────────────────────────────────────

  const cobissDraft = ref<string | null>(null);
  let cobissTimer: ReturnType<typeof setTimeout> | null = null;

  const cobissId = computed(() => cobissDraft.value ?? batch.value?.cobissId ?? "");
  const cobissSet = computed(() => cobissId.value.trim() !== "");

  async function flushCobiss(): Promise<void> {
    if (cobissTimer) {
      clearTimeout(cobissTimer);
      cobissTimer = null;
    }
    if (cobissDraft.value === null) return;
    const value = cobissDraft.value.trim() || null;
    cobissDraft.value = null;
    if (value !== (batch.value?.cobissId ?? null)) await persistBatch({ cobissId: value });
  }

  function setCobissId(value: string): void {
    cobissDraft.value = value;
    if (cobissTimer) clearTimeout(cobissTimer);
    cobissTimer = setTimeout(() => void flushCobiss(), COBISS_PERSIST_MS);
  }

  // ── publish + visibility defaults ────────────────────────────────────────

  const publish = computed<PublishTarget>(() => batch.value?.publish ?? PublishTarget.DRAFT);
  const visibility = computed<VisibilityStatus>(
    () => batch.value?.visibility ?? VisibilityStatus.PRIVATE,
  );

  function setPublish(value: PublishTarget): void {
    if (value !== publish.value) void persistBatch({ publish: value });
  }

  function setVisibility(value: VisibilityStatus): void {
    if (value !== visibility.value) void persistBatch({ visibility: value });
  }

  // ── Apply & continue ─────────────────────────────────────────────────────

  const applying = ref(false);

  /**
   * Copy the batch defaults onto every member item — the data-passing parent's
   * shared fields, then the COBISS record (which outranks the parent copy) — and
   * persist. Returns true when the caller may switch to Metadata.
   */
  async function applyAndContinue(): Promise<boolean> {
    const b = batch.value;
    if (!b || applying.value) return false;
    applying.value = true;
    try {
      await flushCobiss();
      if (!items.loaded) await items.load();
      const members = memberItems.value;
      await Promise.all(members.map((m) => metadata.ensureItemLoaded(m)));

      const passing = links.passingParent.value;
      let preview: Record<string, unknown> | null = null;
      const id = (batch.value?.cobissId ?? "").trim();
      if (id) {
        const outcome = await fetchCobissPreview(id);
        if (outcome.status === "found") {
          preview = outcome.preview.metadata as Record<string, unknown>;
        } else {
          toasts.push(`COBISS prefill skipped — ${outcome.message}`, "warning");
        }
      }

      let parentApplied = 0;
      let cobissApplied = 0;
      for (const m of members) {
        if (passing) parentApplied += metadata.applyParentTo(m.id, passing).applied.length;
        if (preview) cobissApplied += metadata.applyCobissTo(m.id, preview).applied.length;
      }
      await metadata.flush();

      if (parentApplied + cobissApplied > 0) {
        const sources = [passing ? "the parent" : null, preview ? "COBISS" : null]
          .filter(Boolean)
          .join(" and ");
        toasts.push(`Prefilled ${members.length} item${members.length === 1 ? "" : "s"} from ${sources}.`, "success");
      }
      return true;
    } catch (err) {
      logger.error("setup", "Apply & continue failed.", err);
      toasts.push("Couldn't apply the batch defaults.", "error");
      return false;
    } finally {
      applying.value = false;
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async function init(): Promise<void> {
    if (!items.loaded) await items.load();
  }

  if (getCurrentInstance()) {
    onMounted(init);
    onUnmounted(() => void flushCobiss());
  }

  return {
    cobissId,
    cobissSet,
    setCobissId,
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
    // publish
    publish,
    setPublish,
    visibility,
    setVisibility,
    editable,
    itemCount,
    applying,
    applyAndContinue,
  };
}
