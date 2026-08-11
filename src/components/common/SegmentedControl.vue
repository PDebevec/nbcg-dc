<script setup lang="ts">
defineProps<{
  options: ReadonlyArray<{ value: string; label: string }>;
  modelValue: string;
  disabled?: boolean;
}>();

defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <div class="track">
    <button
      v-for="opt in options"
      :key="opt.value"
      class="seg"
      :class="{ active: opt.value === modelValue }"
      :disabled="disabled"
      @click="$emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.track {
  display: flex;
  gap: 4px;
  background: var(--c-surface-seg);
  padding: 4px;
  border-radius: var(--r-md);
}

.seg {
  flex: 1;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  font-size: 13px;
  font-weight: 500;
  color: var(--c-text-muted);
  white-space: nowrap;
}

.seg.active {
  font-weight: 600;
  color: var(--c-primary);
  background: var(--c-surface);
}

.seg:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}
</style>
