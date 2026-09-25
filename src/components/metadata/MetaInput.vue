<script setup lang="ts">
import { computed } from "vue";
import type { FieldView } from "@composables/useMetadataForm";

/**
 * The input for one non-object schema field. Emits the value to store: a
 * picked option emits that option's stored value; text, number, quantity and
 * date boxes emit their text (the composable turns it into the stored shape).
 * Object kinds are composed by `MetaField`.
 */
const props = defineProps<{
  field: FieldView;
  editable: boolean;
  /** Tighter sizing inside object sub-forms. */
  compact?: boolean;
}>();

const emit = defineEmits<{ change: [value: unknown] }>();

const disabled = computed(() => !props.editable || props.field.readOnly);
const invalid = computed(() => Boolean(props.field.error));
const flagged = computed(() => Boolean(props.field.flag));
const list = computed<unknown[]>(() => (Array.isArray(props.field.raw) ? props.field.raw : []));
/** Options not chosen yet (multi-enum add list). */
const remainingOptions = computed(() =>
  props.field.options.filter((o) => !props.field.chips.includes(o.value)),
);

function onText(event: Event): void {
  emit("change", (event.target as HTMLInputElement | HTMLTextAreaElement).value);
}

/** A select: emit the picked option's stored value (null for "not set"). */
function onOption(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit("change", props.field.options.find((o) => o.value === value)?.stored ?? null);
}

function onChipKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  const input = event.target as HTMLInputElement;
  const value = input.value.trim();
  if (!value) return;
  event.preventDefault();
  emit("change", [...list.value, value]);
  input.value = "";
}

function removeChip(i: number): void {
  emit("change", list.value.filter((_, idx) => idx !== i));
}

function onOptionAdd(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const option = props.field.options.find((o) => o.value === select.value);
  select.value = "";
  if (option) emit("change", [...list.value, option.stored]);
}
</script>

<template>
  <!-- text, date, single free-hint box -->
  <input
    v-if="field.kind === 'text' || field.kind === 'date' || field.kind === 'hint'"
    :value="field.value"
    :disabled="disabled"
    :placeholder="field.kind === 'date' ? 'YYYY-MM-DD' : field.label"
    :class="{ invalid, flagged, compact }"
    @input="onText"
  />

  <textarea
    v-else-if="field.kind === 'textarea'"
    :value="field.value"
    :disabled="disabled"
    :placeholder="field.label"
    rows="3"
    :class="{ invalid, flagged, compact }"
    @input="onText"
  />

  <input
    v-else-if="field.kind === 'number'"
    :value="field.value"
    :disabled="disabled"
    :placeholder="field.label"
    inputmode="numeric"
    :class="{ invalid, flagged, compact }"
    @input="onText"
  />

  <!-- quantity: the number, with the unit the rules chose -->
  <div v-else-if="field.kind === 'quantity'" class="quantity">
    <input
      :value="field.value"
      :disabled="disabled"
      :placeholder="field.label"
      inputmode="numeric"
      :class="{ invalid, flagged, compact }"
      @input="onText"
    />
    <span class="unit">{{ field.unit }}</span>
  </div>

  <select
    v-else-if="field.kind === 'boolean' || field.kind === 'enum'"
    :value="field.value"
    :disabled="disabled"
    :class="{ invalid, flagged, compact }"
    @change="onOption"
  >
    <option value="">{{ field.kind === "boolean" ? "— not set —" : "— select —" }}</option>
    <option v-for="opt in field.options" :key="opt.value" :value="opt.value">
      {{ opt.label }}
    </option>
  </select>

  <!-- a single searched value (an author's role) -->
  <input
    v-else-if="field.kind === 'vocab'"
    :value="field.value"
    disabled
    :class="{ invalid, flagged, compact }"
  />

  <!-- chips: free text (multi, multi-hint) and coded (multi-enum, multi-vocab) -->
  <div v-else class="chips" :class="{ invalid, flagged }">
    <span v-for="(chip, i) in field.chips" :key="`${chip}-${i}`" class="chip">
      {{ field.chipLabels[i] ?? chip }}
      <button v-if="!disabled" class="chip-x" title="Remove" @click="removeChip(i)">×</button>
    </span>
    <input
      v-if="!disabled && (field.kind === 'multi' || field.kind === 'multi-hint')"
      class="chip-input"
      :class="{ compact }"
      :placeholder="`${field.label} — Enter to add`"
      @keydown="onChipKeydown"
    />
    <select
      v-else-if="!disabled && field.kind === 'multi-enum'"
      class="chip-select"
      :class="{ compact }"
      value=""
      @change="onOptionAdd"
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

textarea {
  width: 100%;
  border: 1.5px solid var(--c-border);
  background: var(--c-surface-input);
  border-radius: var(--r-md);
  padding: 9px 12px;
  font-size: 13.5px;
  color: var(--c-text-strong);
  resize: vertical;
}

textarea.invalid {
  border-color: #e79a90;
}

textarea:disabled {
  background: var(--c-surface-disabled);
  color: var(--c-text-muted);
}

.quantity {
  display: flex;
  align-items: center;
  gap: 8px;
}

.unit {
  font-size: 13px;
  color: var(--c-text-faint);
  min-width: 32px;
}
</style>
