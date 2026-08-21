<script setup lang="ts">
import { computed, ref } from "vue";
import { useProcessing } from "@composables/useProcessing";
import ProgressBar from "../../components/batch/ProgressBar.vue";

const props = defineProps<{ batchId: string }>();

const {
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
  log,
  start,
  rerunItem,
  rerunAllFailed,
  cancel,
  upload,
} = useProcessing(() => props.batchId);

const pct = computed(() => `${Math.round(ratio.value * 100)}%`);
const logOpen = ref(false);

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
          Published as {{ publishLabel.toLowerCase() }} ·
          {{ visibilityLabel.toLowerCase() }} · items released and archived
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
        <button v-if="showCancel" class="cancel-btn" @click="cancel()">
          ■ Cancel
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
        <button
          v-if="showUpload"
          class="upload-btn"
          :disabled="!canUpload"
          :title="canUpload ? '' : 'Resolve the notes on the items first'"
          @click="upload()"
        >
          ⇧ Upload batch
        </button>
        <span v-if="uploading" class="uploading-pill">
          <span class="spinner" /> Uploading…
        </span>
      </div>
      <div class="progress-row">
        <ProgressBar :ratio="uploading ? uploadRatio : ratio" :height="9" :green="uploading" />
        <span class="pct">{{ uploading ? `${Math.round(uploadRatio * 100)}%` : pct }}</span>
      </div>
      <div v-if="blockedNote" class="blocked-note">{{ blockedNote }}</div>
    </div>

    <!-- per-item list -->
    <div class="card list">
      <div v-if="rows.length === 0" class="empty">
        No items the index knows about — rescan the folders on the Overview.
      </div>
      <div
        v-for="row in rows"
        :key="row.id"
        class="proc-row"
        :class="{ failed: row.status === 'failed' }"
      >
        <div class="proc-main">
          <span class="status-chip" :class="row.status">
            <span v-if="row.status === 'running'" class="spinner dark" />
            <template v-else>{{ statusGlyphs[row.status] }}</template>
          </span>
          <div class="proc-text">
            <div class="proc-title">{{ row.title }}</div>
            <div class="proc-sub">{{ row.sub }}</div>
          </div>
          <span v-if="row.error" class="proc-error" :title="row.error">{{ row.error }}</span>
          <span v-if="row.progressLabel" class="proc-live">{{ row.progressLabel }}</span>
          <span class="proc-status" :class="row.status">{{ row.statusLabel }}</span>
          <button v-if="row.canRerun" class="rerun-btn" @click="rerunItem(row.id)">
            ↻ Rerun
          </button>
        </div>

        <!-- pre-upload gates -->
        <div v-if="row.gates.length > 0 && !row.upload" class="notes">
          <div
            v-for="g in row.gates"
            :key="g.code"
            class="note"
            :class="g.hard ? 'hard' : 'soft'"
          >
            <span class="note-glyph">{{ g.hard ? "✗" : "⚠" }}</span>
            {{ g.message }}
          </div>
        </div>

        <!-- upload result -->
        <div v-if="row.upload" class="notes">
          <div class="note" :class="row.upload.status === 'uploaded' ? 'ok' : 'hard'">
            <span class="note-glyph">{{ row.upload.status === "uploaded" ? "✓" : "✗" }}</span>
            <b>{{ row.upload.label }}</b>
            <span v-if="row.upload.message"> — {{ row.upload.message }}</span>
          </div>
          <div v-for="e in row.upload.fieldErrors" :key="e" class="note hard indent">
            {{ e }}
          </div>
          <div v-for="w in row.upload.warnings" :key="w" class="note soft indent">
            <span class="note-glyph">⚠</span>{{ w }}
          </div>
        </div>
      </div>
    </div>

    <!-- run log -->
    <div v-if="log.length > 0" class="card log-card">
      <button class="log-toggle" @click="logOpen = !logOpen">
        {{ logOpen ? "▾" : "▸" }} Run log ({{ log.length }})
        <span v-if="running" class="spinner dark small" />
      </button>
      <pre v-if="logOpen" class="log">{{ log.join("\n") }}</pre>
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
        Web PDF · thumbnail · OCR text · metadata per item are uploaded. Source
        scans and the archival master stay local; the folder moves to
        /processed.
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
  flex-wrap: wrap;
}

.control-text {
  flex: 1;
  min-width: 240px;
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

.cancel-btn {
  height: 38px;
  padding: 0 15px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-muted);
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

.upload-btn:disabled {
  background: var(--c-disabled-btn);
  cursor: default;
}

.uploading-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-success);
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

.empty {
  padding: 18px;
  font-size: 13px;
  color: var(--c-text-faint);
}

.proc-row {
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

.proc-main {
  display: flex;
  align-items: center;
  gap: 14px;
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
  border: 2.5px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.7s linear infinite;
}

.spinner.dark {
  border-color: #cfe0ff;
  border-top-color: var(--c-info);
}

.spinner.small {
  width: 11px;
  height: 11px;
  border-width: 2px;
}

.uploading-pill .spinner {
  border-color: rgba(31, 157, 87, 0.3);
  border-top-color: var(--c-success);
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

.proc-live {
  font-size: 11.5px;
  color: var(--c-info);
  font-family: var(--font-mono);
  white-space: nowrap;
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

.notes {
  margin: 8px 0 0 42px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.note {
  font-size: 12px;
  display: flex;
  gap: 6px;
  align-items: baseline;
  line-height: 1.4;
}

.note.hard {
  color: var(--c-danger-text);
}

.note.soft {
  color: #9a7a34;
}

.note.ok {
  color: var(--c-success-text);
}

.note.indent {
  margin-left: 18px;
}

.note-glyph {
  flex: none;
  font-weight: 700;
}

/* ── log ────────────────────────────────────────────────────────────── */
.log-card {
  padding: 10px 16px;
}

.log-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--c-text-muted);
}

.log {
  margin: 10px 0 4px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--c-text-muted);
  background: var(--c-surface-input-alt);
  border: 1px solid var(--c-border-row);
  border-radius: var(--r-md);
  padding: 10px 12px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
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
