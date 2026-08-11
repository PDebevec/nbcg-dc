/**
 * `useProcessing` (Epic 06/07) — the view-model the batch **Processing & Upload
 * tab** binds to (Seam 1).
 *
 * ⚠ STUB (GUI lane, per docs/04 "getting started") — a timer-driven mock run so
 * the Processing screen is fully demonstrable without the logic lane (the real
 * pipeline is Rust/Python via IPC, Epic 06). **The returned shape is the
 * contract** and should survive the swap.
 */

import {
  computed,
  onUnmounted,
  reactive,
  ref,
  toValue,
  type MaybeRefOrGetter,
} from "vue";

export type RunStatus = "idle" | "queued" | "running" | "done" | "failed";

/** One row of the per-item live pipeline list. */
export interface ProcessingItemView {
  id: string;
  title: string;
  sub: string;
  status: RunStatus;
  statusLabel: string;
  error: string;
  canRerun: boolean;
}

const STATUS_LABELS: Record<RunStatus, string> = {
  idle: "Not started",
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

interface StubProcItem {
  id: string;
  title: string;
  sub: string;
  status: RunStatus;
  error: string;
  /** Stub only: this item fails on the first run to demo the rerun flow. */
  failsFirstRun: boolean;
}

export function useProcessing(_batchId: MaybeRefOrGetter<string>) {
  void toValue(_batchId); // stub: real impl resolves the batch through the store

  const items = reactive<StubProcItem[]>([
    { id: "pobjeda1", title: "Pobjeda, 1948, br. 1", sub: "pobjeda_1948_01 · 30 TIFFs", status: "idle", error: "", failsFirstRun: false },
    { id: "pobjeda2", title: "Pobjeda, 1948, br. 2", sub: "pobjeda_1948_02 · 28 TIFFs", status: "idle", error: "", failsFirstRun: false },
    { id: "pobjeda3", title: "Pobjeda, 1948, br. 3", sub: "pobjeda_1948_03 · 26 TIFFs", status: "idle", error: "", failsFirstRun: true },
  ]);

  const running = ref(false);
  const uploaded = ref(false);
  const publishLabel = ref("Draft");
  const visibilityLabel = ref("Public");
  /** Non-null when another batch holds the single-run lock (stub: never). */
  const blockedNote = ref<string | null>(null);

  let timer: ReturnType<typeof setInterval> | undefined;

  const started = computed(() => items.some((i) => i.status !== "idle"));
  const doneCount = computed(
    () => items.filter((i) => i.status === "done").length,
  );
  const failCount = computed(
    () => items.filter((i) => i.status === "failed").length,
  );
  const resolvedCount = computed(() => doneCount.value + failCount.value);
  const ratio = computed(() =>
    items.length === 0 ? 0 : resolvedCount.value / items.length,
  );
  const ready = computed(
    () => started.value && !running.value && failCount.value === 0,
  );

  const summary = computed(() => {
    const n = items.length;
    const word = n === 1 ? "item" : "items";
    if (uploaded.value) return `${n} ${word} archived and published.`;
    if (running.value)
      return `${doneCount.value} done · ${failCount.value} failed · ${n - resolvedCount.value} remaining — running…`;
    if (ready.value) return `All ${n} ${word} processed. Ready to upload.`;
    if (failCount.value > 0)
      return `${doneCount.value} done · ${failCount.value} failed. Rerun failures, then upload.`;
    return `TIFF → PDF · Thumbnail · OCR · Metadata for ${n} ${word}. Start when ready.`;
  });

  const showStart = computed(() => !started.value && !uploaded.value);
  const showRerunAll = computed(
    () => failCount.value > 0 && !running.value && !uploaded.value,
  );
  const showUpload = computed(() => ready.value && !uploaded.value);

  const rows = computed<ProcessingItemView[]>(() =>
    items.map((i) => ({
      id: i.id,
      title: i.title,
      sub: i.sub,
      status: i.status,
      statusLabel: STATUS_LABELS[i.status],
      error: i.status === "failed" ? i.error : "",
      canRerun: i.status === "failed" && !running.value && !uploaded.value,
    })),
  );

  // ── stub run simulation ──────────────────────────────────────────────────

  function tick(): void {
    const current = items.find((i) => i.status === "running");
    if (current) {
      if (current.failsFirstRun) {
        current.status = "failed";
        current.error = "OCR engine crashed on page 9 — corrupt image stream.";
        current.failsFirstRun = false;
      } else {
        current.status = "done";
      }
    }
    const nextItem = items.find((i) => i.status === "queued");
    if (nextItem) {
      nextItem.status = "running";
    } else if (!items.some((i) => i.status === "running")) {
      running.value = false;
      clearInterval(timer);
    }
  }

  function start(): void {
    if (running.value || uploaded.value) return;
    for (const i of items) i.status = "queued";
    running.value = true;
    clearInterval(timer);
    timer = setInterval(tick, 650);
  }

  function rerunItem(id: string): void {
    const item = items.find((i) => i.id === id);
    if (!item || item.status !== "failed" || running.value) return;
    item.status = "running";
    item.error = "";
    running.value = true;
    clearInterval(timer);
    timer = setInterval(tick, 800);
  }

  function rerunAllFailed(): void {
    const failed = items.filter((i) => i.status === "failed");
    if (failed.length === 0 || running.value) return;
    for (const i of failed) {
      i.status = "queued";
      i.error = "";
    }
    running.value = true;
    clearInterval(timer);
    timer = setInterval(tick, 800);
  }

  function upload(): void {
    if (!ready.value) return;
    uploaded.value = true;
  }

  onUnmounted(() => clearInterval(timer));

  return {
    rows,
    summary,
    ratio,
    running,
    uploaded,
    showStart,
    showRerunAll,
    showUpload,
    blockedNote,
    publishLabel,
    visibilityLabel,
    start,
    rerunItem,
    rerunAllFailed,
    upload,
  };
}
