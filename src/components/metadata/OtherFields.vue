<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FieldView, HintView } from "@composables/useMetadataForm";
import MetaField from "./MetaField.vue";

/**
 * Fields the rules hide for this item that still hold a value — typical after
 * "Get data" or a material-type change. A rule never deletes data: they stay
 * editable and upload as they are (schema v2 editor rule 1).
 */
const props = defineProps<{
  fields: FieldView[];
  editable: boolean;
  hintPath: string | null;
  hintItems: HintView[];
}>();

function hasError(field: FieldView): boolean {
  return field.error !== "" || field.children.some(hasError) || field.entries.some((e) => e.some(hasError));
}

/** Collapsed, but opened when a field in it has an error so the error is seen.
 * It does not close again when the error is fixed — mid-edit, that would take
 * the field away from the operator. */
const open = ref(false);
watch(
  computed(() => props.fields.some(hasError)),
  (erroring) => {
    if (erroring) open.value = true;
  },
  { immediate: true },
);

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
</script>

<template>
  <details
    v-if="fields.length > 0"
    class="other"
    :open="open"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary>Other fields ({{ fields.length }})</summary>
    <p class="note">
      Not used for this material type, but they hold a value — it is kept and uploaded as it is.
      Clear a field to drop it.
    </p>
    <div class="grid">
      <MetaField
        v-for="field in fields"
        :key="field.key"
        :field="field"
        :editable="editable"
        :hint-path="hintPath"
        :hint-items="hintItems"
        @change="(path, value) => emit('change', path, value)"
        @add="(key) => emit('add', key)"
        @remove="(key, index) => emit('remove', key, index)"
        @pick-source="(key, parentId) => emit('pickSource', key, parentId)"
        @manual="(key) => emit('manual', key)"
        @query="(path, text) => emit('query', path, text)"
        @pick="(path, index) => emit('pick', path, index)"
        @close-hints="emit('closeHints')"
      />
    </div>
  </details>
</template>

<style scoped>
.other {
  margin-top: 18px;
  border-top: 1px solid var(--c-border-row);
  padding-top: 12px;
}

summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-label);
}

.note {
  font-size: 12px;
  color: var(--c-text-faint);
  margin: 8px 0 12px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px 20px;
}
</style>
