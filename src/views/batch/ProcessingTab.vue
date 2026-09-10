<script setup lang="ts">
import { computed, ref } from "vue";
import { useProcessing, type ProcessingItemView } from "@composables/useProcessing";
import type { StepState, StepView } from "@domain/steps";
import type { RunnableStage } from "@domain/pipeline";
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
  rerunStep,
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

// ── expansion ───────────────────────────────────────────
// A row that needs a person opens by itself — nobody should have to expand
// a hundred items to find the two that are stuck. Manual clicks win either
// way, so the two sets are kept apart rather than pre-seeding one.
const opened = ref(new Set<string>());
const closed = ref(new Set<string>());

function isOpen(row: ProcessingItemView): boolean {
  if (opened.value.has(row.id)) return true;
  if (closed.value.has(row.id)) return false;
  return row.attention !== null;
}

function toggle(row: ProcessingItemView): void {
  const open = isOpen(row);
  const next = { opened: new Set(opened.value), closed: new Set(closed.value) };
  next.opened.delete(row.id);
  next.closed.delete(row.id);
  (open ? next.closed : next.opened).add(row.id);
  opened.value = next.opened;
  closed.value = next.closed;
}

const allOpen = computed(() => rows.value.length > 0 && rows.value.every(isOpen));

function toggleAll(): void {
  const open = !allOpen.value;
  opened.value = new Set(open ? rows.value.map((r) => r.id) : []);
  closed.value = new Set(open ? [] : rows.value.map((r) => r.id));
}

// ── step presentation ─────────────────────────────────────
const STEP_GLYPHS: Record<StepState, string> = {
  done: "✓",
  running: "",
  queued: "○",
  failed: "✗",
  held: "!",
  waiting: "○",
  skipped: "–",
};

const STEP_STATE_LABELS: Record<StepState, string> = {
  done: "Done",
  running: "Running",
  queued: "Queued",
  failed: "Failed",
  held: "Needs you",
  waiting: "Not run",
  skipped: "N/A",
};

/** What the step's own button offers, given where the step got to. */
function stepAction(step: StepView): string {
  if (step.state === "failed") return "Try again";
  if (step.state === "done") return "Run again";
  return "Run step";
}

function runStep(row: ProcessingItemView, step: StepView): void {
  void rerunStep(row.id, step.stage as RunnableStage);
}
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
      <div v-else class="list-head">
        <span class="list-title">Items</span>
        <button class="link-btn" @click="toggleAll()">
          {{ allOpen ? "Collapse all steps" : "Expand all steps" }}
        </button>
      </div>
      <div
        v-for="row in rows"
        :key="row.id"
        class="proc-row"
        :class="{ failed: row.status === 'failed', open: isOpen(row) }"
      >
        <div class="proc-main" role="button" tabindex="0" @click="toggle(row)" @keydown.enter="toggle(row)" @keydown.space.prevent="toggle(row)">
          <span class="chevron" :class="{ open: isOpen(row) }">▸</span>
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
          <button
            v-if="row.canRerun"
            class="rerun-btn"
            @click.stop="rerunItem(row.id)"
          >
            ↻ Rerun
          </button>
        </div>

        <!-- the row's own progress, so a long item is legible while collapsed -->
        <div class="item-progress">
          <ProgressBar :ratio="row.completion" :height="4" />
          <span class="item-pct">{{ Math.round(row.completion * 100) }}%</span>
        </div>

        <!-- what needs a person, visible without expanding -->
        <div
          v-if="row.attention && !isOpen(row)"
          class="attention"
          :class="row.attention.state"
        >
          <span class="note-glyph">{{ row.attention.state === "failed" ? "✗" : "!" }}</span>
          <b>{{ row.attention.label }}</b>
          <span>— {{ row.attention.error ?? row.attention.action }}</span>
        </div>

        <!-- expanded: one row per step -->
        <div v-if="isOpen(row)" class="steps">
          <div
            v-for="step in row.steps"
            :key="step.stage"
            class="step"
            :class="step.state"
          >
            <span class="step-glyph" :class="step.state">
              <span v-if="step.state === 'running'" class="spinner dark small" />
              <template v-else>{{ STEP_GLYPHS[step.state] }}</template>
            </span>
            <span class="step-label">{{ step.label }}</span>
            <span class="step-detail">{{ step.detail }}</span>
            <span class="step-state" :class="step.state">
              {{ STEP_STATE_LABELS[step.state] }}
            </span>
            <button
              v-if="step.rerunnable"
              class="step-btn"
              :disabled="!row.canRerunStep"
              :title="
                row.canRerunStep
                  ? `Run only this step — nothing else is re-processed`
                  : 'Not while a batch is running, or after upload'
              "
              @click.stop="runStep(row, step)"
            >
              {{ stepAction(step) }}
            </button>
            <span v-else class="step-btn-spacer" />

            <!-- the error, or the decision, in full -->
            <div v-if="step.error" class="step-note hard">{{ step.error }}</div>
            <div v-else-if="step.action" class="step-note soft">{{ step.action }}</div>
          </div>
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

/* ── expandable steps ─────────────────────────────────── */
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 18px;
  border-bottom: 1px solid var(--c-border-row);
}

.list-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--c-text-faint);
}

.link-btn {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-primary);
  background: none;
  border: none;
  padding: 0;
}

.proc-row.open {
  background: var(--c-surface-input-alt);
}

.proc-row.open.failed {
  background: var(--c-danger-row);
}

.proc-main {
  cursor: pointer;
}

.chevron {
  flex: none;
  width: 12px;
  font-size: 10px;
  color: var(--c-text-faint);
  transition: transform 0.15s;
}

.chevron.open {
  transform: rotate(90deg);
}

.item-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0 0 54px;
}

.item-pct {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--c-text-faint);
  min-width: 32px;
  text-align: right;
}

.attention {
  display: flex;
  gap: 6px;
  align-items: baseline;
  margin: 8px 0 0 54px;
  font-size: 12px;
  line-height: 1.4;
}

.attention.failed {
  color: var(--c-danger-text);
}

.attention.held {
  color: var(--c-warn-deep);
}

.steps {
  margin: 10px 0 2px 54px;
  border-left: 2px solid var(--c-border-row);
}

/* Fixed track widths, not `auto`: each step row is its own grid, so `auto`
   columns would size themselves per row and the labels would stagger down the
   list instead of lining up. */
.step {
  display: grid;
  grid-template-columns: 18px 76px 1fr 68px 92px;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  font-size: 12.5px;
}

.step + .step {
  border-top: 1px solid var(--c-border-row);
}

.step.skipped {
  opacity: 0.6;
}

.step-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 700;
  color: var(--c-idle-dot);
  background: var(--c-idle-bg-alt);
}

.step-glyph.done {
  color: var(--c-success);
  background: var(--c-success-bg);
}

.step-glyph.failed {
  color: var(--c-danger);
  background: var(--c-danger-bg);
}

.step-glyph.held {
  color: var(--c-warn-deep);
  background: var(--c-warn-bg);
}

.step-glyph.running,
.step-glyph.queued {
  color: var(--c-info);
  background: var(--c-info-bg);
}

.step-label {
  font-weight: 600;
  color: var(--c-text-mid);
}

.step-detail {
  color: var(--c-text-muted);
  min-width: 0;
}

.step-state {
  font-size: 11px;
  font-weight: 600;
  color: var(--c-text-faint);
  white-space: nowrap;
}

.step-state.done {
  color: var(--c-success);
}

.step-state.failed {
  color: var(--c-danger);
}

.step-state.held {
  color: var(--c-warn-deep);
}

.step-state.running,
.step-state.queued {
  color: var(--c-info);
}

.step-btn {
  width: 100%;
  height: 26px;
  padding: 0 6px;
  border-radius: 7px;
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-mid);
  font-weight: 600;
  font-size: 11.5px;
  white-space: nowrap;
}

.step-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.step-btn-spacer {
  display: block;
}

/* The error text / the decision, on its own line under the step it belongs
   to — the one place a librarian can read the whole message. */
.step-note {
  grid-column: 2 / -1;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  border-radius: var(--r-sm);
  padding: 7px 9px;
}

.step-note.hard {
  color: var(--c-danger-text);
  background: var(--c-danger-bg);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.step-note.soft {
  color: var(--c-warn-deep);
  background: var(--c-warn-bg);
}

.notes {
  margin: 8px 0 0 54px;
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
