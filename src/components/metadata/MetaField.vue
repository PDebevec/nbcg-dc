<script setup lang="ts">
import { ref } from "vue";
import type { FieldView } from "@composables/useMetadataForm";

const props = defineProps<{ field: FieldView; editable: boolean }>();

const emit = defineEmits<{
  change: [key: string, value: string];
  addChip: [key: string, value: string];
  pickSource: [key: string, parentId: string];
  manual: [key: string];
}>();

const menuOpen = ref(false);

function onInput(event: Event): void {
  emit("change", props.field.key, (event.target as HTMLInputElement).value);
}

function onSelect(event: Event): void {
  emit("change", props.field.key, (event.target as HTMLSelectElement).value);
}

function onChipKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  const input = event.target as HTMLInputElement;
  if (!input.value.trim()) return;
  event.preventDefault();
  emit("addChip", props.field.key, input.value);
  input.value = "";
}

function pick(parentId: string): void {
  menuOpen.value = false;
  emit("pickSource", props.field.key, parentId);
}

function manual(): void {
  menuOpen.value = false;
  emit("manual", props.field.key);
}
</script>

<template>
  <div class="field" :class="{ wide: field.wide }">
    <div class="head">
      <label>{{ field.label }}</label>
      <span v-if="field.required" class="req">*</span>
      <span
        v-if="field.provLabel && field.sourceOptions.length === 0"
        class="prov"
        :class="field.provenance"
      >{{ field.provLabel }}</span>
      <span v-if="field.flag" class="flag">{{ field.flag }}</span>

      <!-- per-field source picker -->
      <div v-if="field.sourceOptions.length > 0 && editable" class="src-slot">
        <button
          class="src-pill"
          :class="field.provenance"
          title="Choose which parent this field comes from"
          @click.stop="menuOpen = !menuOpen"
        >
          <span class="src-dot" />
          {{ field.provLabel || "Choose source" }}
          <span class="caret">▼</span>
        </button>
        <div v-if="menuOpen" class="src-menu" @click.stop>
          <div class="src-menu-head">Fill this field from</div>
          <button
            v-for="opt in field.sourceOptions"
            :key="opt.parentId"
            class="src-opt"
            :class="{ selected: opt.selected }"
            @click="pick(opt.parentId)"
          >
            <span class="radio" :class="{ selected: opt.selected }">
              <span class="radio-dot" />
            </span>
            <span class="src-opt-text">
              <span class="src-opt-name">{{ opt.name }}</span>
              <span class="src-opt-preview">{{ opt.preview }}</span>
            </span>
          </button>
          <button
            class="src-opt manual-opt"
            :class="{ selected: field.manualSelected }"
            @click="manual()"
          >
            <span class="radio" :class="{ selected: field.manualSelected }">
              <span class="radio-dot" />
            </span>
            <span class="src-opt-name">Manual entry</span>
          </button>
        </div>
      </div>
    </div>

    <input
      v-if="field.kind === 'text'"
      :value="field.value"
      :disabled="!editable"
      :placeholder="field.label"
      :class="{ invalid: field.error, flagged: field.flag }"
      @input="onInput"
    />
    <input
      v-else-if="field.kind === 'date'"
      type="date"
      :value="field.value"
      :disabled="!editable"
      :class="{ invalid: field.error, flagged: field.flag }"
      @input="onInput"
    />
    <select
      v-else-if="field.kind === 'enum'"
      :value="field.value"
      :disabled="!editable"
      :class="{ invalid: field.error, flagged: field.flag }"
      @change="onSelect"
    >
      <option value="">— select —</option>
      <option v-for="opt in field.options" :key="opt" :value="opt">
        {{ opt }}
      </option>
    </select>
    <div v-else class="chips">
      <span v-for="chip in field.chips" :key="chip" class="chip">{{ chip }}</span>
      <input
        v-if="editable"
        class="chip-input"
        :placeholder="field.label"
        @keydown="onChipKeydown"
      />
    </div>

    <div v-if="field.error" class="error">{{ field.error }}</div>
  </div>
</template>

<style scoped>
.field.wide {
  grid-column: 1 / -1;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
}

label {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-label);
}

.req {
  color: var(--c-danger);
  font-weight: 700;
}

.prov,
.flag {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: var(--r-xs);
}

.prov.cobiss {
  color: var(--c-prov-cobiss);
  background: var(--c-prov-cobiss-bg);
}

.prov.parent {
  color: var(--c-prov-parent);
  background: var(--c-prov-parent-bg);
}

.prov.user {
  color: var(--c-prov-user);
  background: var(--c-prov-user-bg);
}

.flag {
  color: #b07d16;
  background: var(--c-warn-bg);
}

/* ── inputs ─────────────────────────────────────────────────────────── */
input,
select {
  width: 100%;
  height: 39px;
  border: 1.5px solid var(--c-border);
  background: var(--c-surface-input);
  border-radius: var(--r-md);
  padding: 0 12px;
  font-size: 13.5px;
  color: var(--c-text-strong);
}

input.invalid,
select.invalid {
  border-color: #e79a90;
}

input.flagged,
select.flagged {
  border-color: #e6cf95;
}

input:disabled,
select:disabled {
  background: var(--c-surface-disabled);
  color: var(--c-text-muted);
  cursor: not-allowed;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  align-items: center;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--c-primary-soft);
  border: 1px solid #d7ddf7;
  color: var(--c-primary);
  padding: 4px 9px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
}

.chip-input {
  min-width: 160px;
  flex: 1;
  height: 36px;
  border: 1.5px dashed var(--c-border-dashed);
  background: var(--c-surface-input);
  border-radius: 8px;
  padding: 0 11px;
  font-size: 13px;
  width: auto;
}

.error {
  font-size: 12px;
  color: var(--c-danger);
  margin-top: 6px;
  font-weight: 500;
}

/* ── source picker ──────────────────────────────────────────────────── */
.src-slot {
  position: relative;
  margin-left: auto;
}

.src-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 8px 2px 7px;
  border-radius: 6px;
  color: var(--c-text-thead);
  background: var(--c-idle-bg-alt);
}

.src-pill.parent {
  color: var(--c-prov-parent);
  background: var(--c-prov-parent-bg);
}

.src-pill.cobiss {
  color: var(--c-prov-cobiss);
  background: var(--c-prov-cobiss-bg);
}

.src-pill.user {
  color: var(--c-prov-user);
  background: var(--c-prov-user-bg);
}

.src-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.75;
}

.caret {
  opacity: 0.55;
  font-size: 9px;
}

.src-menu {
  position: absolute;
  top: 26px;
  right: 0;
  width: 256px;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-menu);
  z-index: 30;
  padding: 6px;
  animation: fadein 0.12s;
}

.src-menu-head {
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--c-text-dim);
  padding: 4px 8px 6px;
}

.src-opt {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 7px 9px;
  border-radius: 8px;
}

.src-opt:hover {
  background: #f6f4fc;
}

.src-opt.selected {
  background: var(--c-prov-parent-bg);
}

.manual-opt {
  margin-top: 3px;
  border-top: 1px solid #f2f3f8;
  border-radius: 0 0 8px 8px;
}

.manual-opt.selected {
  background: var(--c-prov-user-bg);
}

.radio {
  width: 15px;
  height: 15px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid #c9cee0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.radio.selected {
  border-color: var(--c-prov-parent);
}

.manual-opt .radio.selected {
  border-color: var(--c-prov-user);
}

.radio-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: transparent;
}

.radio.selected .radio-dot {
  background: var(--c-prov-parent);
}

.manual-opt .radio.selected .radio-dot {
  background: var(--c-prov-user);
}

.src-opt-text {
  min-width: 0;
  flex: 1;
}

.src-opt-name {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--c-parent-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.manual-opt .src-opt-name {
  color: var(--c-text-label);
}

.src-opt-preview {
  display: block;
  font-size: 11px;
  color: var(--c-text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
