<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Diameter in px. */
    size?: number;
    /** Ring thickness in px. */
    weight?: number;
    /**
     * Which surface it sits on. `on-primary` is the white ring for a filled
     * indigo button; `info` and `primary` are the two on-white variants.
     */
    tone?: "info" | "primary" | "on-primary";
  }>(),
  { size: 13, weight: 2, tone: "info" },
);
</script>

<template>
  <span
    class="spinner"
    :class="`tone-${tone}`"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      borderWidth: `${weight}px`,
    }"
  />
</template>

<style scoped>
.spinner {
  display: inline-block;
  flex: none;
  border-style: solid;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.tone-info {
  border-color: var(--c-spinner-track);
  border-top-color: var(--c-info);
}

.tone-primary {
  border-color: var(--c-border);
  border-top-color: var(--c-primary);
}

.tone-on-primary {
  border-color: var(--c-on-primary-track);
  border-top-color: var(--c-on-primary);
}
</style>
