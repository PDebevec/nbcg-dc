<script setup lang="ts">
import { ref } from "vue";
import { useMetadataForm } from "@composables/useMetadataForm";
import ProgressBar from "../../components/batch/ProgressBar.vue";
import ParentRecordsCard from "../../components/batch/ParentRecordsCard.vue";
import SegmentedControl from "../../components/common/SegmentedControl.vue";
import FilesStrip from "../../components/metadata/FilesStrip.vue";
import MetaField from "../../components/metadata/MetaField.vue";

const props = defineProps<{ batchId: string }>();

const emit = defineEmits<{ "go-processing": [] }>();

const {
  nav,
  files,
  fields,
  editable,
  loading,
  schemaError,
  saving,
  validationBanner,
  nextLabel,
  canNext,
  jump,
  prev,
  next,
  setField,
  setFieldSource,
  setFieldManual,
  cobissId,
  setCobissId,
  getCobiss,
  cobissLoading,
  cobissDone,
  cobissNote,
  overwritePrompt,
  applyCobiss,
  parents,
  parentQuery,
  setParentQuery,
  parentResults,
  parentSearching,
  parentSearchError,
  linkParent,
  removeParent,
  togglePassesData,
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
} = useMetadataForm(() => props.batchId);

const pickerOpen = ref(false);

function pick(i: number): void {
  pickerOpen.value = false;
  jump(i);
}

function onNext(): void {
  if (next()) emit("go-processing");
}

const statusColors: Record<string, string> = {
  ready: "var(--c-success)",
  incomplete: "var(--c-warn)",
  untouched: "var(--c-idle-dot)",
};

const statusLabels: Record<string, string> = {
  ready: "Ready",
  incomplete: "Incomplete",
  untouched: "Untouched",
};

const publishOptions = [
  { value: "DRAFT", label: "Draft" },
  { value: "RECORD", label: "Record" },
];

const visibilityOptions = [
  { value: "PUBLIC", label: "Public" },
  { value: "PRIVATE", label: "Private" },
  { value: "HIDDEN", label: "Hidden" },
];

const enumLabel: Record<string, string> = {
  DRAFT: "Draft",
  RECORD: "Record",
  PUBLIC: "Public",
  PRIVATE: "Private",
  HIDDEN: "Hidden",
};
</script>

<template>
  <div class="tab" @click="pickerOpen = false">
    <!-- item navigator -->
    <div class="card nav-card">
      <div class="nav-head">
        <div class="nav-titles">
          <div class="nav-count">
            Item {{ nav.total ? nav.index + 1 : 0 }} of {{ nav.total }} ·
            {{ nav.readyCount }}/{{ nav.total }} ready
            <span v-if="saving" class="saving">· saving…</span>
          </div>
          <div class="nav-title">{{ nav.title || "—" }}</div>
        </div>
        <span class="level-pill" :class="nav.level">{{ nav.levelLabel }}</span>
      </div>

      <div v-if="nav.total > 1" class="nav-body">
        <div class="picker-slot" @click.stop>
          <button class="picker-btn" @click="pickerOpen = !pickerOpen">
            <span
              class="picker-dot"
              :style="{ background: statusColors[nav.status] }"
            />
            <span class="picker-label"
              >{{ nav.index + 1 }}/{{ nav.total }} · {{ nav.title }}</span
            >
            <span class="caret">▾</span>
          </button>
          <div v-if="pickerOpen" class="picker-menu">
            <button
              v-for="(item, i) in nav.items"
              :key="item.id"
              class="picker-item"
              :class="{ active: item.active }"
              @click="pick(i)"
            >
              <span
                class="badge"
                :style="{ background: statusColors[item.status] }"
              >{{
                item.status === "ready"
                  ? "✓"
                  : item.status === "incomplete"
                    ? "!"
                    : i + 1
              }}</span>
              <span class="picker-item-text">
                <span class="picker-item-title">{{ item.title }}</span>
                <span class="picker-item-sub">{{ item.folderName }}</span>
              </span>
              <span
                class="picker-item-status"
                :style="{ color: statusColors[item.status] }"
              >{{ statusLabels[item.status] }}</span>
            </button>
          </div>
        </div>
        <div class="ready-bar">
          <div class="ready-note">{{ nav.readyCount }} of {{ nav.total }} ready</div>
          <ProgressBar :ratio="nav.total ? nav.readyCount / nav.total : 0" green />
        </div>
      </div>
    </div>

    <div v-if="schemaError" class="validation-banner">
      ✗ {{ schemaError }} — the form needs the backend schema (Settings → Refresh
      schema once the backend is reachable).
    </div>
    <div v-if="validationBanner" class="validation-banner">
      ✗ {{ validationBanner }}
    </div>

    <div v-if="nav.total === 0" class="card empty-card">
      This batch has no items the index knows about. Rescan the folders on the
      Overview and reopen the batch.
    </div>

    <template v-else>
      <FilesStrip :files="files" />

      <!-- COBISS per item -->
      <div v-if="editable" class="card">
        <div class="heading">Prefill from COBISS</div>
        <div class="cobiss-row">
          <div class="cobiss-box">
            <span class="cobiss-label">COBISS.CG-ID</span>
            <input
              :value="cobissId"
              placeholder="e.g. 24512006"
              @input="setCobissId(($event.target as HTMLInputElement).value)"
              @keydown.enter.prevent="getCobiss()"
            />
          </div>
          <button class="btn-primary" :disabled="cobissLoading" @click="getCobiss()">
            <span v-if="cobissLoading" class="spinner" />
            {{ cobissLoading ? "Fetching…" : "Get data" }}
          </button>
          <span v-if="cobissDone" class="cobiss-done">✓ Filled from COBISS</span>
          <span v-if="cobissNote" class="cobiss-note">{{ cobissNote }}</span>
        </div>
      </div>

      <!-- overwrite prompt -->
      <div v-if="overwritePrompt" class="overwrite">
        <div class="ow-title">Overwrite existing values?</div>
        <div class="ow-sub">
          {{ overwritePrompt }} already {{ overwritePrompt.includes(" and ") ? "have values" : "has a value" }} you entered. Apply COBISS data
          over {{ overwritePrompt.includes(" and ") ? "them" : "it" }}, or keep yours — empty fields were already filled.
        </div>
        <div class="ow-actions">
          <button class="ow-apply" @click="applyCobiss(true)">Overwrite all</button>
          <button class="ow-keep" @click="applyCobiss(false)">
            Keep mine
          </button>
        </div>
      </div>

      <ParentRecordsCard
        :parents="parents"
        :editable="editable"
        :query="parentQuery"
        :results="parentResults"
        :searching="parentSearching"
        :search-error="parentSearchError"
        description="Linked parents apply to the whole batch. The data-passing parent fills this item's empty shared fields."
        @update-query="setParentQuery($event)"
        @link="linkParent($event)"
        @remove="removeParent($event)"
        @toggle-pass="togglePassesData($event)"
      />

      <!-- per-item publish + visibility -->
      <div class="two-col">
        <div class="card slim">
          <div class="heading-row">
            <span class="heading">Publish this item as</span>
            <button
              v-if="publishOverridden && editable"
              class="reset-link"
              @click="resetPublishToBatch()"
            >
              reset to batch ({{ enumLabel[batchPublish] }})
            </button>
            <span v-else class="default-note">batch default</span>
          </div>
          <SegmentedControl
            :options="publishOptions"
            :model-value="publish"
            :disabled="!editable"
            @update:model-value="setPublish($event as 'DRAFT' | 'RECORD')"
          />
        </div>
        <div class="card slim">
          <div class="heading-row">
            <span class="heading">Visibility</span>
            <button
              v-if="visibilityOverridden && editable"
              class="reset-link"
              @click="resetVisibilityToBatch()"
            >
              reset to batch ({{ enumLabel[batchVisibility] }})
            </button>
            <span v-else class="default-note">batch default</span>
          </div>
          <SegmentedControl
            :options="visibilityOptions"
            :model-value="visibility"
            :disabled="!editable"
            @update:model-value="
              setVisibility($event as 'PUBLIC' | 'PRIVATE' | 'HIDDEN')
            "
          />
        </div>
      </div>

      <!-- fields -->
      <div class="card fields-card">
        <div v-if="loading" class="loading">Loading schema and metadata…</div>
        <div v-else-if="fields.length === 0" class="loading">
          No schema fields available.
        </div>
        <div v-else class="fields-grid">
          <template v-for="field in fields" :key="field.key">
            <div v-if="field.groupStart" class="group-head">
              {{ field.groupLabel }}
            </div>
            <MetaField
              :field="field"
              :editable="editable"
              @change="setField"
              @pick-source="setFieldSource"
              @manual="setFieldManual"
            />
          </template>
        </div>
        <div class="footer-nav">
          <button
            class="prev-btn"
            :disabled="nav.index === 0"
            @click="prev()"
          >
            ‹ Previous
          </button>
          <span class="pos">{{ nav.index + 1 }} / {{ nav.total }}</span>
          <div class="next-slot">
            <span v-if="!canNext" class="next-helper"
              >Complete required fields to continue</span
            >
            <button
              class="next-btn"
              :class="{ ready: canNext, last: canNext && nextLabel.startsWith('Go') }"
              @click="onNext()"
            >
              {{ nextLabel }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tab {
  max-width: 1080px;
  margin: 0 auto;
}

.card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-xl);
  padding: 16px 18px;
  margin-bottom: 14px;
}

.empty-card {
  font-size: 13px;
  color: var(--c-text-muted);
}

.heading {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted);
  margin-bottom: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.heading-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}

.heading-row .heading {
  margin-bottom: 0;
}

.reset-link {
  font-size: 11.5px;
  color: var(--c-primary);
  font-weight: 600;
  margin-left: auto;
}

.default-note {
  font-size: 11px;
  color: var(--c-text-dim);
  margin-left: auto;
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.slim {
  padding: 14px 18px;
}

.loading {
  font-size: 13px;
  color: var(--c-text-faint);
  padding: 12px 0;
}

/* ── navigator ──────────────────────────────────────────────────────── */
.nav-card {
  padding: 13px 16px;
}

.nav-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.nav-titles {
  min-width: 0;
  flex: 1;
}

.nav-count {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--c-text-faint);
  font-weight: 600;
  white-space: nowrap;
}

.saving {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
}

.nav-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--c-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 520px;
}

.level-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 6px;
  flex: none;
}

.level-pill.main {
  color: var(--c-primary);
  background: var(--c-primary-soft);
}

.level-pill.child {
  color: var(--c-parent);
  background: var(--c-parent-bg);
}

.nav-body {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.picker-slot {
  position: relative;
  flex: none;
}

.picker-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 12px;
  border: 1.5px solid var(--c-border);
  border-radius: 10px;
  background: var(--c-surface-input);
  min-width: 300px;
  text-align: left;
}

.picker-dot {
  width: 11px;
  height: 11px;
  flex: none;
  border-radius: 50%;
}

.picker-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.caret {
  font-size: 11px;
  color: var(--c-text-faint);
}

.picker-menu {
  position: absolute;
  top: 48px;
  left: 0;
  width: 360px;
  max-height: 52vh;
  overflow: auto;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  box-shadow: var(--shadow-menu);
  z-index: 20;
  padding: 6px;
  animation: fadein 0.12s;
}

.picker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 9px 10px;
  border-radius: var(--r-md);
}

.picker-item.active {
  background: var(--c-primary-soft);
}

.badge {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
}

.picker-item-text {
  min-width: 0;
  flex: 1;
}

.picker-item-title {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--c-text-mid);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-item.active .picker-item-title {
  font-weight: 600;
  color: var(--c-primary);
}

.picker-item-sub {
  display: block;
  font-size: 10.5px;
  color: var(--c-text-dim);
  font-family: var(--font-mono);
}

.picker-item-status {
  font-size: 10.5px;
  font-weight: 600;
}

.ready-bar {
  flex: 1;
  min-width: 0;
}

.ready-note {
  font-size: 11.5px;
  color: var(--c-text-faint);
  margin-bottom: 5px;
}

/* ── banners ────────────────────────────────────────────────────────── */
.validation-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  background: var(--c-danger-bg);
  border: 1px solid var(--c-danger-border);
  border-radius: 10px;
  padding: 11px 15px;
  margin-bottom: 14px;
  color: var(--c-danger-deep);
  font-size: 13px;
  font-weight: 500;
}

.overwrite {
  background: var(--c-warn-banner);
  border: 1px solid var(--c-warn-border);
  border-radius: var(--r-lg);
  padding: 13px 16px;
  margin-bottom: 14px;
  animation: fadein 0.15s;
}

.ow-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--c-warn-deep);
  margin-bottom: 4px;
}

.ow-sub {
  font-size: 12.5px;
  color: #9a7a34;
  margin-bottom: 11px;
}

.ow-actions {
  display: flex;
  gap: 9px;
}

.ow-apply {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  background: var(--c-warn);
  color: #fff;
  font-weight: 600;
  font-size: 13px;
}

.ow-keep {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--c-warn-border);
  background: var(--c-surface);
  color: var(--c-warn-deep);
  font-weight: 600;
  font-size: 13px;
}

/* ── COBISS row ─────────────────────────────────────────────────────── */
.cobiss-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.cobiss-box {
  display: flex;
  align-items: center;
  background: var(--c-surface-input-alt);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  padding: 0 12px;
  height: 40px;
  flex: 1;
  max-width: 280px;
}

.cobiss-label {
  font-size: 12px;
  color: var(--c-text-faint);
  font-family: var(--font-mono);
  margin-right: 6px;
  white-space: nowrap;
}

.cobiss-box input {
  border: none;
  background: none;
  font-family: var(--font-mono);
  font-size: 14px;
  width: 100%;
}

.btn-primary {
  height: 40px;
  padding: 0 16px;
  border-radius: var(--r-md);
  background: var(--c-primary);
  color: #fff;
  font-weight: 600;
  font-size: 13.5px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-primary:disabled {
  opacity: 0.7;
  cursor: default;
}

.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.7s linear infinite;
}

.cobiss-done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--c-success);
}

.cobiss-note {
  font-size: 12.5px;
  color: var(--c-warn-deep);
  font-weight: 500;
}

/* ── fields ─────────────────────────────────────────────────────────── */
.fields-card {
  padding: 18px 20px;
}

.fields-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px 22px;
}

.group-head {
  grid-column: 1 / -1;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--c-text-faint);
  padding-top: 6px;
  border-bottom: 1px solid var(--c-border-row);
  padding-bottom: 6px;
}

.group-head:first-child {
  padding-top: 0;
}

.footer-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 18px;
  border-top: 1px solid #f2f3f8;
  margin-top: 18px;
}

.prev-btn {
  height: 40px;
  padding: 0 16px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-muted);
  font-weight: 600;
  font-size: 13.5px;
}

.prev-btn:disabled {
  color: #c3c8dc;
  opacity: 0.5;
  cursor: default;
}

.pos {
  font-size: 12px;
  color: var(--c-text-dim);
}

.next-slot {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.next-helper {
  font-size: 12px;
  color: var(--c-warn);
  font-weight: 500;
}

.next-btn {
  height: 40px;
  padding: 0 20px;
  border-radius: var(--r-md);
  background: var(--c-disabled-btn);
  color: #fff;
  font-weight: 600;
  font-size: 14px;
}

.next-btn.ready {
  background: var(--c-primary);
}

.next-btn.ready.last {
  background: var(--c-success);
}
</style>
