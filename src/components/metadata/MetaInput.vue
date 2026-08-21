<script setup lang="ts">
import { computed, ref } from "vue";
import type { FieldView } from "@composables/useMetadataForm";

/**
 * The primitive input for one schema field (text / number / boolean / enum /
 * multi / multi-enum). Emits the field's whole next value; object kinds are
 * composed by `MetaField`.
 */
const props = defineProps<{
  field: FieldView;
  editable: boolean;
  /** Tighter sizing inside object sub-forms. */
  compact?: boolean;
}>();

const emit = defineEmits<{ change: [value: unknown] }>();

const enumAdd = ref("");

const invalid = computed(() => Boolean(props.field.error));
const flagged = computed(() => Boolean(props.field.flag));

/** Options not yet chosen (multi-enum add list). */
const remainingOptions = computed(() =>
  props.field.options.filter((o) => !props.field.chips.includes(o.value)),
);

function onText(event: Event): void {
  emit("change", (event.target as HTMLInputElement).value);
}

function onEnum(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit("change", value === "" ? null : value);
}

function onBoolean(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit("change", value === "" ? null : value === "true");
}

function onChipKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  const input = event.target as HTMLInputElement;
  const value = input.value.trim();
  if (!value) return;
  event.preventDefault();
  emit("change", [...props.field.chips, value]);
  input.value = "";
}

function removeChip(i: number): void {
  emit(
    "change",
    props.field.chips.filter((_, idx) => idx !== i),
  );
}

function onEnumAdd(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (!value) return;
  emit("change", [...props.field.chips, value]);
  enumAdd.value = "";
  (event.target as HTMLSelectElement).value = "";
}
</script>

<template>
  <!-- text -->
  <input
    v-if="field.kind === 'text'"
    :value="field.value"
    :disabled="!editable"
    :placeholder="field.label"
    :class="{ invalid, flagged, compact }"
    @input="onText"
  />

  <!-- number -->
  <input
    v-else-if="field.kind === 'number'"
    :value="field.value"
    :disabled="!editable"
    :placeholder="field.label"
    inputmode="numeric"
    :class="{ invalid, flagged, compact }"
    @input="onText"
  />

  <!-- boolean -->
  <select
    v-else-if="field.kind === 'boolean'"
    :value="field.value"
    :disabled="!editable"
    :class="{ invalid, flagged, compact }"
    @change="onBoolean"
  >
    <option value="">— not set —</option>
    <option v-for="opt in field.options" :key="opt.value" :value="opt.value">
      {{ opt.label }}
    </option>
  </select>

  <!-- enum -->
  <select
    v-else-if="field.kind === 'enum'"
    :value="field.value"
    :disabled="!editable"
    :class="{ invalid, flagged, compact }"
    @change="onEnum"
  >
    <option value="">— select —</option>
    <option v-for="opt in field.options" :key="opt.value" :value="opt.value">
      {{ opt.label }}
    </option>
  </select>

  <!-- multi (free text chips) / multi-enum (coded chips) -->
  <div v-else class="chips" :class="{ invalid, flagged }">
    <span v-for="(chip, i) in field.chips" :key="`${chip}-${i}`" class="chip">
      {{ field.chipLabels[i] ?? chip }}
      <button
        v-if="editable"
        class="chip-x"
        title="Remove"
        @click="removeChip(i)"
      >
        ×
      </button>
    </span>
    <input
      v-if="editable && field.kind === 'multi'"
      class="chip-input"
      :class="{ compact }"
      :placeholder="`${field.label} — Enter to add`"
      @keydown="onChipKeydown"
    />
    <select
      v-else-if="editable && field.kind === 'multi-enum'"
      class="chip-select"
      :class="{ compact }"
      :value="enumAdd"
      @change="onEnumAdd"
    >
      <option value="">+ add…</option>
      <option v-for="opt in remainingOptions" :key="opt.value" :value="opt.value">
        {{ opt.label }}
      </option>
    </select>
    <span v-else-if="field.chips.length === 0" class="none">—</span>
  </div>
</template>

<style scoped>
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

input.compact,
select.compact {
  height: 34px;
  font-size: 13px;
}

input.invalid,
select.invalid,
.chips.invalid {
  border-color: #e79a90;
}

input.flagged,
select.flagged,
.chips.flagged {
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
  min-height: 39px;
  border: 1.5px solid transparent;
  border-radius: var(--r-md);
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

.chip-x {
  color: var(--c-primary);
  opacity: 0.6;
  font-size: 14px;
  line-height: 1;
}

.chip-x:hover {
  opacity: 1;
}

.chip-input,
.chip-select {
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

.chip-select {
  max-width: 260px;
  flex: none;
}

.none {
  font-size: 13px;
  color: var(--c-text-dim);
  padding: 0 4px;
}
</style>
