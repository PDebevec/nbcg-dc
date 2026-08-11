<script setup lang="ts">
import { computed } from "vue";
import { useProcessing } from "@composables/useProcessing";
import ProgressBar from "../../components/batch/ProgressBar.vue";

const props = defineProps<{ batchId: string }>();

const {
  rows,
  summary,
  ratio,
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
} = useProcessing(() => props.batchId);

const pct = computed(() => `${Math.round(ratio.value * 100)}%`);

const statusGlyphs: Record<string, string> = {
  idle: "○",
  queued: "○",
  done: "✓",
  failed: "✗",
};
</script>

<template>
  <div class="tab">
    <!-- uploaded banner -->
    <div v-if="uploaded" class="uploaded-banner">
      <span class="check">✓</span>
      <div>
        <div class="ub-title">Batch uploaded</div>
        <div class="ub-sub">
          Published as {{ publishLabel.toLowerCase() }}s ·
          {{ visibilityLabel.toLowerCase() }}
        </div>
      </div>
    </div>

    <!-- control strip -->
    <div class="card control">
      <div class="control-row">
        <div class="control-text">
          <div class="heading">Batch processing</div>
          <div class="summary">{{ summary }}</div>
        </div>
        <button v-if="showRerunAll" class="rerun-all" @click="rerunAllFailed()">
          ↻ Rerun all failed
        </button>
        <button
          v-if="showStart"
          class="start-btn"
          :class="{ blocked: blockedNote }"
          :disabled="!!blockedNote"
          @click="start()"
        >
          ▶ Start processing
        </button>
        <button v-if="showUpload" class="upload-btn" @click="upload()">
          ⇧ Upload batch
        </button>
      </div>
      <div class="progress-row">
        <ProgressBar :ratio="ratio" :height="9" />
        <span class="pct">{{ pct }}</span>
      </div>
      <div v-if="blockedNote" class="blocked-note">{{ blockedNote }}</div>
    </div>

    <!-- per-item list -->
    <div class="card list">
      <div
        v-for="row in rows"
        :key="row.id"
        class="proc-row"
        :class="{ failed: row.status === 'failed' }"
      >
        <span class="status-chip" :class="row.status">
          <span v-if="row.status === 'running'" class="spinner" />
          <template v-else>{{ statusGlyphs[row.status] }}</template>
        </span>
        <div class="proc-text">
          <div class="proc-title">{{ row.title }}</div>
          <div class="proc-sub">{{ row.sub }}</div>
        </div>
        <span v-if="row.error" class="proc-error">{{ row.error }}</span>
        <span class="proc-status" :class="row.status">{{ row.statusLabel }}</span>
        <button v-if="row.canRerun" class="rerun-btn" @click="rerunItem(row.id)">
          ↻ Rerun
        </button>
      </div>
    </div>

    <!-- upload summary -->
    <div class="card upload-summary">
      <div>
        <div class="us-label">Publish as</div>
        <div class="us-value">{{ publishLabel }}</div>
      </div>
      <div class="divider" />
      <div>
        <div class="us-label">Visibility</div>
        <div class="us-value">{{ visibilityLabel }}</div>
      </div>
      <div class="divider" />
      <div class="us-note">
        document.pdf · thumbnail.png · ocr.txt · metadata.json per item. Source
        TIFFs stay local.
      </div>
    </div>
  </div>
</template>

<style scoped>
.tab {
  max-width: 1000px;
  margin: 0 auto;
}

.card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-xl);
  margin-bottom: 14px;
}

.uploaded-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--c-success-bg);
  border: 1px solid var(--c-success-border);
  border-radius: 12px;
  padding: 15px 18px;
  margin-bottom: 16px;
  animation: fadein 0.2s;
}

.check {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 50%;
  background: var(--c-surface);
  color: var(--c-success);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 700;
}

.ub-title {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--c-success-text);
}

.ub-sub {
  font-size: 12.5px;
  color: #3f8a60;
}

/* ── control strip ──────────────────────────────────────────────────── */
.control {
  padding: 16px 20px;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 14px;
}

.control-text {
  flex: 1;
  min-width: 0;
}

.heading {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 3px;
}

.summary {
  font-size: 13px;
  color: var(--c-text-muted);
}

.rerun-all {
  height: 38px;
  padding: 0 15px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-danger-border);
  background: #fdf0ee;
  color: var(--c-danger-text);
  font-weight: 600;
  font-size: 13px;
  flex: none;
}

.start-btn {
  height: 42px;
  padding: 0 22px;
  border-radius: 10px;
  background: var(--c-primary);
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  flex: none;
}

.start-btn.blocked {
  background: var(--c-disabled-btn);
  opacity: 0.7;
  cursor: default;
}

.upload-btn {
  height: 42px;
  padding: 0 24px;
  border-radius: 10px;
  background: var(--c-success);
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  flex: none;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pct {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--c-primary);
  min-width: 38px;
  text-align: right;
}

.blocked-note {
  font-size: 12px;
  color: var(--c-warn);
  margin-top: 8px;
}

/* ── per-item list ──────────────────────────────────────────────────── */
.list {
  overflow: hidden;
  padding: 0;
}

.proc-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 18px;
  border-top: 1px solid var(--c-border-row);
  background: var(--c-surface);
}

.proc-row:first-child {
  border-top: none;
}

.proc-row.failed {
  background: var(--c-danger-row);
}

.status-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 700;
}

.status-chip.idle,
.status-chip.queued {
  color: var(--c-idle-dot);
  background: var(--c-idle-bg-alt);
}

.status-chip.running {
  color: var(--c-info);
  background: var(--c-info-bg);
}

.status-chip.done {
  color: var(--c-success);
  background: var(--c-success-bg);
}

.status-chip.failed {
  color: var(--c-danger);
  background: var(--c-danger-bg);
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2.5px solid #cfe0ff;
  border-top-color: var(--c-info);
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.7s linear infinite;
}

.proc-text {
  flex: 1;
  min-width: 0;
}

.proc-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--c-text-mid);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.proc-sub {
  font-size: 11.5px;
  color: var(--c-text-faint);
  font-family: var(--font-mono);
}

.proc-error {
  font-size: 11.5px;
  color: var(--c-danger-text);
  max-width: 260px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.proc-status {
  width: 88px;
  text-align: right;
  font-size: 12px;
  font-weight: 600;
  flex: none;
}

.proc-status.idle,
.proc-status.queued {
  color: var(--c-idle-dot);
}

.proc-status.running {
  color: var(--c-info);
}

.proc-status.done {
  color: var(--c-success);
}

.proc-status.failed {
  color: var(--c-danger);
}

.rerun-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--c-danger-border);
  background: var(--c-surface);
  color: var(--c-danger-text);
  font-weight: 600;
  font-size: 12px;
  flex: none;
}

/* ── upload summary ─────────────────────────────────────────────────── */
.upload-summary {
  padding: 15px 20px;
  display: flex;
  align-items: center;
  gap: 22px;
}

.us-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--c-text-faint);
  font-weight: 600;
  margin-bottom: 4px;
}

.us-value {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--c-text-mid);
}

.divider {
  width: 1px;
  height: 34px;
  background: var(--c-border-row);
}

.us-note {
  font-size: 12px;
  color: var(--c-text-dim);
  flex: 1;
}
</style>
