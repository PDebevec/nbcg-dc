<script setup lang="ts">
import { ref } from "vue";
import type { FieldView, HintView } from "@composables/useMetadataForm";
import MetaInput from "./MetaInput.vue";

/**
 * One schema field with its caption, provenance tag and source picker. Every
 * edit is emitted with the path it belongs to (`title`, `publication.place`,
 * `authors[1].role`); the composable writes it into the right place.
 */
defineProps<{ field: FieldView; editable: boolean; hintPath?: string | null; hintItems?: HintView[] }>();

const emit = defineEmits<{
  change: [path: string, value: unknown];
  add: [key: string];
  remove: [key: string, index: number];
  pickSource: [key: string, parentId: string];
  manual: [key: string];
  query: [path: string, text: string];
  pick: [path: string, index: number];
  closeHints: [];
}>();

const menuOpen = ref(false);

function pick(key: string, parentId: string): void {
  menuOpen.value = false;
  emit("pickSource", key, parentId);
}

function manual(key: string): void {
  menuOpen.value = false;
  emit("manual", key);
}
</script>

<template>
  <div class="field" :class="{ wide: field.wide }">
    <div class="head">
      <label :title="field.help || undefined">{{ field.label }}</label>
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
            @click="pick(field.key, opt.parentId)"
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
            @click="manual(field.key)"
          >
            <span class="radio" :class="{ selected: field.manualSelected }">
              <span class="radio-dot" />
            </span>
            <span class="src-opt-name">Manual entry</span>
          </button>
        </div>
      </div>
    </div>
    <div v-if="field.help" class="help">{{ field.help }}</div>

    <!-- object: a sub-form -->
    <div v-if="field.kind === 'object'" class="sub-form" :class="{ invalid: field.error }">
      <div v-for="child in field.children" :key="child.path" class="sub-field">
        <span class="sub-label">{{ child.label }}<span v-if="child.required" class="req"> *</span></span>
        <MetaInput
          :field="child"
          :editable="editable"
          compact
          :hints="hintPath === child.path ? hintItems : null"
          @change="emit('change', child.path, $event)"
          @query="emit('query', child.path, $event)"
          @pick="emit('pick', child.path, $event)"
          @close="emit('closeHints')"
        />
        <div v-if="child.error" class="error">{{ child.error }}</div>
      </div>
    </div>

    <!-- object-list: repeatable sub-forms -->
    <div v-else-if="field.kind === 'object-list'" class="entries">
      <div v-for="(entry, i) in field.entries" :key="i" class="entry">
        <div class="entry-head">
          <span class="entry-no">#{{ i + 1 }}</span>
          <button
            v-if="editable && !field.readOnly"
            class="entry-remove"
            title="Remove"
            @click="emit('remove', field.key, i)"
          >
            ×
          </button>
        </div>
        <div class="sub-form">
          <div v-for="child in entry" :key="child.path" class="sub-field">
            <span class="sub-label">{{ child.label }}<span v-if="child.required" class="req"> *</span></span>
            <MetaInput
              :field="child"
              :editable="editable"
              compact
              :hints="hintPath === child.path ? hintItems : null"
              @change="emit('change', child.path, $event)"
              @query="emit('query', child.path, $event)"
              @pick="emit('pick', child.path, $event)"
              @close="emit('closeHints')"
            />
            <div v-if="child.error" class="error">{{ child.error }}</div>
          </div>
        </div>
      </div>
      <button v-if="editable && !field.readOnly" class="add-entry" @click="emit('add', field.key)">
        + Add
      </button>
      <span v-else-if="field.entries.length === 0" class="none">—</span>
    </div>

    <MetaInput
      v-else
      :field="field"
      :editable="editable"
      :hints="hintPath === field.path ? hintItems : null"
      @change="emit('change', field.path, $event)"
      @query="emit('query', field.path, $event)"
      @pick="emit('pick', field.path, $event)"
      @close="emit('closeHints')"
    />

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

/* ── object sub-forms ────────────────────────────────────────────────── */
.sub-form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px 14px;
  padding: 12px 14px;
  border: 1.5px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-input-alt);
}

.sub-form.invalid {
  border-color: #e79a90;
}

.sub-field {
  min-width: 0;
}

.sub-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--c-text-faint);
  margin-bottom: 4px;
}

.entries {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.entry {
  border: 1.5px solid var(--c-border);
  border-radius: var(--r-md);
  overflow: hidden;
}

.entry .sub-form {
  border: none;
  border-radius: 0;
}

.entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 12px;
  background: var(--c-surface-input-alt);
  border-bottom: 1px solid var(--c-border-row);
}

.entry-no {
  font-size: 11px;
  font-weight: 700;
  color: var(--c-text-faint);
  font-family: var(--font-mono);
}

.entry-remove {
  color: var(--c-text-dim);
  font-size: 16px;
  line-height: 1;
}

.entry-remove:hover {
  color: var(--c-danger);
}

.add-entry {
  align-self: flex-start;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1.5px dashed var(--c-border-dashed);
  color: var(--c-primary);
  font-size: 12.5px;
  font-weight: 600;
}

.none {
  font-size: 13px;
  color: var(--c-text-dim);
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

.help {
  font-size: 11.5px;
  color: var(--c-text-faint);
  margin: -3px 0 6px;
}
</style>
