<script setup lang="ts">
import type { ItemState } from "@domain/item";

defineProps<{ state: ItemState; label: string }>();
</script>

<template>
  <span class="pill" :class="state">
    <span class="dot" />
    {{ label }}
  </span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: var(--r-pill);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.pill.to-process {
  color: var(--c-idle);
  background: var(--c-idle-bg);
}

.pill.in-progress {
  color: var(--c-info);
  background: var(--c-info-bg);
}

.pill.stopped {
  color: var(--c-danger);
  background: var(--c-danger-bg);
}

.pill.needs-reupload {
  color: var(--c-warn);
  background: var(--c-warn-bg);
}

.pill.uploaded {
  color: var(--c-success);
  background: var(--c-success-bg);
}
</style>
