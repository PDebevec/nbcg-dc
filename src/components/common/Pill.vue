<script setup lang="ts">
/**
 * The status pill. One place for the tone → colour mapping that
 * `BatchCard`, `BatchWorkView` and `StatePill` each used to restate.
 *
 * The default slot is the label; `marker` replaces the leading dot (a batch
 * card swaps in a spinner while its run is live).
 */
withDefaults(
  defineProps<{
    tone?: "idle" | "info" | "success" | "warn" | "danger" | "parent";
    /** Tighter padding and type, for a dense header row. */
    dense?: boolean;
  }>(),
  { tone: "idle", dense: false },
);
</script>

<template>
  <span class="pill" :class="[`tone-${tone}`, { dense }]">
    <slot name="marker"><span class="dot" /></slot>
    <slot />
  </span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-small);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.pill.dense {
  padding: 2px 9px;
  font-size: var(--fs-tiny);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.tone-idle {
  color: var(--c-idle);
  background: var(--c-idle-bg);
}

.tone-info {
  color: var(--c-info);
  background: var(--c-info-bg);
}

.tone-success {
  color: var(--c-success);
  background: var(--c-success-bg);
}

.tone-warn {
  color: var(--c-warn);
  background: var(--c-warn-bg);
}

.tone-danger {
  color: var(--c-danger);
  background: var(--c-danger-bg);
}

.tone-parent {
  color: var(--c-parent);
  background: var(--c-parent-bg);
}
</style>
