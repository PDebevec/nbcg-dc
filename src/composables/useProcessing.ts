/**
 * `useProcessing` (Epic 06/07) — the view-model the batch **Processing & Upload
 * tab** binds to (Seam 1). Binds the processing-run store (start / rerun /
 * cancel, live `job://*` progress, run log) and the upload store (per-item
 * results, archive on success), plus the pre-upload gates computed from
 * `domain/upload` with the metadata store's readiness.
 */

import {
  computed,
  getCurrentInstance,
  onMounted,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from "vue";
import { storeToRefs } from "pinia";
import { useBatchesStore } from "@stores/useBatches";
import { useBatchWorkStore } from "@stores/useBatchWork";
import { useItemsStore } from "@stores/useItems";
import { useMetadataStore } from "@stores/useMetadata";
import { useProcessingStore } from "@stores/useProcessing";
import { useUploadStore } from "@stores/useUpload";
import { useToastsStore } from "@stores/useToasts";
import {
  BatchStage,
  ItemRunStatus,
  isArchived,
  resolveItemPublish,
  resolveItemVisibility,
  singleRunBlockedMessage,
  type Batch,
} from "@domain/batch";
import { firstStageError, type Item } from "@domain/item";
import { planPipeline } from "@domain/pipeline";
import { planItemUpload, type UploadBlocker, type UploadWarning } from "@domain/upload";
import { procFromProcessing, seedProcFromItems } from "@services/pipeline";
import type { ItemUploadResult, ItemUploadStatus, UploadItemContext } from "@services/upload";

export type RunStatus = ItemRunStatus;

export interface GateNoteView {
  code: string;
  message: string;
  /** Hard blocker (vs soft warning). */
  hard: boolean;
}

export interface UploadResultView {
  status: ItemUploadStatus;
  label: string;
  message: string;
  fieldErrors: string[];
  warnings: string[];
}

/** One row of the per-item live pipeline list. */
export interface ProcessingItemView {
  id: string;
  title: string;
  sub: string;
  status: RunStatus;
  statusLabel: string;
  error: string;
  canRerun: boolean;
  /** Live progress of the running stage, 0–1 (null = indeterminate / idle). */
  progress: number | null;
  /** "ocr · 42%" / "pdf" while running, '' otherwise. */
  progressLabel: string;
  /** Pre-upload gates: hard blockers + soft warnings (empty = clear). */
  gates: GateNoteView[];
  upload: UploadResultView | null;
}

const STATUS_LABELS: Record<RunStatus, string> = {
  idle: "Not started",
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

const UPLOAD_LABELS: Record<ItemUploadStatus, string> = {
  uploaded: "Uploaded",
  blocked: "Blocked",
  forbidden: "No write access",
  duplicate: "Already on backend",
  error: "Upload failed",
};

const PUBLISH_LABELS: Record<string, string> = { DRAFT: "Draft", RECORD: "Record" };
const VISIBILITY_LABELS: Record<string, string> = {
  PUBLIC: "Public",
  PRIVATE: "Private",
  HIDDEN: "Hidden",
};

/** GUI copy for the soft warnings — the backend no longer extracts text, so a
 * missing OCR is permanent unless the operator runs it. */
function warningCopy(w: UploadWarning): string {
  if (w.code === "ocr-missing") {
    return "No OCR text — the backend doesn't extract full text any more, so this item will have none. Run OCR first, or continue without it.";
  }
  return w.message;
}

function blockerCopy(b: UploadBlocker): string {
  switch (b.code) {
    case "metadata-invalid":
      return "Metadata incomplete — fix it on the Metadata tab.";
    case "thumbnail-unresolved":
      return "Several thumbnail candidates — a primary thumbnail must be chosen (picker coming in the next phase).";
    default:
      return b.message;
  }
}

function describeAssets(item: Item): string {
  const plan = planPipeline(item.assets, item.folderName);
  const tiffs = item.assets.filter((a) => a.kind === "source-tiff").length;
  const images = item.assets.filter((a) => a.kind === "image").length;
  const pdfs = item.assets.filter((a) => a.kind === "web-pdf").length;
  const parts: string[] = [];
  if (tiffs) parts.push(`${tiffs} TIFF${tiffs === 1 ? "" : "s"}`);
  if (images) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  if (pdfs) parts.push(`${pdfs} PDF${pdfs === 1 ? "" : "s"}`);
  if (parts.length === 0) parts.push("no inputs");
  parts.push(plan.inputShape.replace(/-/g, " "));
  return parts.join(" · ");
}

export function useProcessing(batchId: MaybeRefOrGetter<string>) {
  const batches = useBatchesStore();
  const work = useBatchWorkStore();
  const itemsStore = useItemsStore();
  const metadata = useMetadataStore();
  const processing = useProcessingStore();
  const uploadStore = useUploadStore();
  const toasts = useToastsStore();
  const { readOnly } = storeToRefs(work);
  const { running: runningBatch } = storeToRefs(batches);
  const { progress: liveProgress, log, error: procError, activeBatchId } = storeToRefs(processing);
  const {
    activeBatchId: uploadingBatchId,
    progress: uploadProgress,
    results: uploadResults,
    error: uploadError,
  } = storeToRefs(uploadStore);

  const batch = computed<Batch | null>(() => batches.get(toValue(batchId)));

  const items = computed<Item[]>(() => {
    const b = batch.value;
    if (!b) return [];
    const byId = new Map(itemsStore.items.map((i) => [i.id, i]));
    return b.itemIds.map((id) => byId.get(id)).filter((i): i is Item => i != null);
  });

  // Load working metadata for the gates (readiness) — best-effort.
  watch(
    () => items.value.map((i) => i.id).join("|"),
    () => {
      for (const item of items.value) void metadata.ensureItemLoaded(item);
    },
    { immediate: true },
  );

  const uploaded = computed(() => {
    const b = batch.value;
    return b != null && (isArchived(b) || b.stage === BatchStage.Uploaded);
  });
  const running = computed(() => batch.value?.running ?? false);
  const uploading = computed(() => uploadingBatchId.value === batch.value?.id);
  const editable = computed(() => !readOnly.value && !uploaded.value);

  /** Display status per item: the batch's run outcome, or — before any run —
   * what its recorded stages already say (so pre-processed items read Done). */
  function displayStatus(item: Item): RunStatus {
    const b = batch.value;
    const proc = b?.proc[item.id] ?? ItemRunStatus.Idle;
    if (proc !== ItemRunStatus.Idle) return proc;
    const kind = b?.overrides[item.id]?.contentKind ?? "auto";
    return procFromProcessing(item, kind);
  }

  const statuses = computed(() => items.value.map(displayStatus));
  const doneCount = computed(() => statuses.value.filter((s) => s === "done").length);
  const failCount = computed(() => statuses.value.filter((s) => s === "failed").length);
  const allDone = computed(() => items.value.length > 0 && doneCount.value === items.value.length);
  const ratio = computed(() => (items.value.length ? doneCount.value / items.value.length : 0));

  // When every member is already processed (e.g. derived files were picked up
  // by an index rebuild, or a re-work batch of finished items) and no run is
  // underway, settle the batch at Ready so the header/progress and the Upload
  // button agree — the same fold `useProcessing.start()` applies when it finds
  // nothing left to run.
  watch(
    () => [allDone.value, running.value, batch.value?.stage, batch.value?.id] as const,
    () => {
      const b = batch.value;
      if (!b || !allDone.value || running.value || uploaded.value) return;
      if (b.stage === BatchStage.Ready || b.stage === BatchStage.Uploaded) return;
      const seeded = seedProcFromItems(b, new Map(items.value.map((i) => [i.id, i])));
      batches.persistRun({ ...seeded, stage: BatchStage.Ready });
    },
    { immediate: true },
  );

  const blockedNote = computed<string | null>(() => {
    const b = batch.value;
    if (!b || uploaded.value) return null;
    return batches.anyOtherRunning(b.id) ? singleRunBlockedMessage(runningBatch.value) : null;
  });

  // ── gates + results ──────────────────────────────────────────────────────

  function gatesFor(item: Item): GateNoteView[] {
    const status = displayStatus(item);
    if (status !== "done" || uploaded.value) return [];
    const b = batch.value;
    const plan = planItemUpload(item, {
      metadataReady: metadata.isReady(item),
      primaryThumbnail: null,
      contentKind: b?.overrides[item.id]?.contentKind ?? "auto",
    });
    return [
      ...plan.blockers.map((x) => ({ code: x.code, message: blockerCopy(x), hard: true })),
      ...plan.warnings.map((x) => ({ code: x.code, message: warningCopy(x), hard: false })),
    ];
  }

  function uploadViewFor(item: Item): UploadResultView | null {
    const b = batch.value;
    if (!b) return null;
    const r: ItemUploadResult | undefined = uploadResults.value.get(b.id)?.get(item.id);
    if (!r) return null;
    return {
      status: r.status,
      label: UPLOAD_LABELS[r.status],
      message:
        r.message ??
        (r.status === "uploaded"
          ? r.relationErrors.length
            ? `Uploaded, but ${r.relationErrors.length} parent link${r.relationErrors.length === 1 ? "" : "s"} failed.`
            : ""
          : ""),
      fieldErrors: r.fieldErrors.map((e) => (e.key ? `${e.key}: ${e.message}` : e.message)),
      warnings: r.warnings.map(warningCopy),
    };
  }

  const rows = computed<ProcessingItemView[]>(() =>
    items.value.map((item, i) => {
      const status = statuses.value[i];
      const live = status === "running" ? liveProgress.value.get(item.id) : undefined;
      const pct = live?.progress != null ? ` · ${Math.round(live.progress * 100)}%` : "";
      return {
        id: item.id,
        title: item.title ?? item.folderName,
        sub: `${item.folderName} · ${describeAssets(item)}`,
        status,
        statusLabel: STATUS_LABELS[status],
        error: status === "failed" ? (firstStageError(item) ?? "Processing failed.") : "",
        canRerun: status === "failed" && !running.value && !uploaded.value && editable.value,
        progress: live?.progress ?? null,
        progressLabel: live ? `${live.stage}${pct}` : "",
        gates: gatesFor(item),
        upload: uploadViewFor(item),
      };
    }),
  );

  const hasBlockers = computed(() => rows.value.some((r) => r.gates.some((g) => g.hard)));

  // ── summary + buttons ────────────────────────────────────────────────────

  const summary = computed(() => {
    const n = items.value.length;
    const word = n === 1 ? "item" : "items";
    if (uploaded.value) return `${n} ${word} uploaded and archived.`;
    if (uploading.value) {
      const p = uploadProgress.value;
      return p ? `Uploading ${p.index} of ${p.total}…` : "Uploading…";
    }
    if (running.value) return `${doneCount.value} done · ${failCount.value} failed · ${n - doneCount.value - failCount.value} remaining — running…`;
    if (allDone.value) return hasBlockers.value ? `All ${n} ${word} processed — resolve the notes below before uploading.` : `All ${n} ${word} processed. Ready to upload.`;
    if (failCount.value > 0) return `${doneCount.value} done · ${failCount.value} failed. Rerun failures, then upload.`;
    if (doneCount.value > 0) return `${doneCount.value} of ${n} processed. Start to process the rest.`;
    return `PDF · Thumbnail · OCR for ${n} ${word}. Start when ready.`;
  });

  const showStart = computed(() => editable.value && !running.value && !allDone.value && !uploading.value);
  const showRerunAll = computed(() => editable.value && failCount.value > 0 && !running.value && !uploading.value);
  const showUpload = computed(() => editable.value && allDone.value && !running.value && !uploading.value);
  const canUpload = computed(() => showUpload.value && !hasBlockers.value && uploadingBatchId.value == null);
  const showCancel = computed(() => running.value && activeBatchId.value === batch.value?.id);

  const publishLabel = computed(() => {
    const b = batch.value;
    if (!b) return "";
    const base = PUBLISH_LABELS[b.publish] ?? b.publish;
    const overrides = Object.values(b.overrides).filter((o) => o?.publish != null).length;
    return overrides ? `${base} (+${overrides} per-item)` : base;
  });
  const visibilityLabel = computed(() => {
    const b = batch.value;
    if (!b) return "";
    const base = VISIBILITY_LABELS[b.visibility] ?? b.visibility;
    const overrides = Object.values(b.overrides).filter((o) => o?.visibility != null).length;
    return overrides ? `${base} (+${overrides} per-item)` : base;
  });

  const recentLog = computed(() => log.value.slice(-40));
  const uploadRatio = computed(() => {
    const p = uploadProgress.value;
    if (!p || !uploading.value) return 0;
    return p.phase === "done" ? p.index / p.total : (p.index - 1) / p.total;
  });

  // ── actions ──────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    const b = batch.value;
    if (!b || !showStart.value || blockedNote.value) return;
    await processing.start(b.id);
    if (procError.value) toasts.push(procError.value, "error");
  }

  async function rerunItem(id: string): Promise<void> {
    const b = batch.value;
    if (!b) return;
    await processing.rerunItem(b.id, id);
    if (procError.value) toasts.push(procError.value, "error");
  }

  async function rerunAllFailed(): Promise<void> {
    const b = batch.value;
    if (!b) return;
    await processing.rerunFailed(b.id);
    if (procError.value) toasts.push(procError.value, "error");
  }

  async function cancel(): Promise<void> {
    const b = batch.value;
    if (!b) return;
    await processing.cancel(b.id);
    if (procError.value) toasts.push(procError.value, "error");
  }

  async function upload(): Promise<void> {
    const b = batch.value;
    if (!b || !canUpload.value) return;
    const members = items.value;
    await Promise.all(members.map((m) => metadata.ensureItemLoaded(m)));
    await metadata.flush();
    const resolveContext = (item: Item): UploadItemContext => ({
      targetState: resolveItemPublish(b, item.id),
      visibility: resolveItemVisibility(b, item.id),
      parentIds: b.parents.map((p) => p.id),
      metadata: metadata.wireMetadata(item.id),
      metadataReady: metadata.isReady(item),
      primaryThumbnail: null,
    });
    const ok = await uploadStore.run(b.id, members, resolveContext);
    if (ok) {
      toasts.push(`Batch uploaded — ${members.length} item${members.length === 1 ? "" : "s"} published.`, "success");
    } else if (uploadError.value) {
      toasts.push(uploadError.value, "error");
    } else {
      const res = uploadStore.resultsFor(b.id);
      const failed = Array.from(res.values()).filter((r) => r.status !== "uploaded").length;
      toasts.push(`${failed} item${failed === 1 ? "" : "s"} did not upload — see the list.`, "warning");
    }
  }

  async function init(): Promise<void> {
    if (!itemsStore.loaded) await itemsStore.load();
  }

  if (getCurrentInstance()) onMounted(init);

  return {
    rows,
    summary,
    ratio,
    running,
    uploading,
    uploadRatio,
    uploaded,
    showStart,
    showRerunAll,
    showUpload,
    canUpload,
    showCancel,
    blockedNote,
    publishLabel,
    visibilityLabel,
    log: recentLog,
    start,
    rerunItem,
    rerunAllFailed,
    cancel,
    upload,
  };
}
