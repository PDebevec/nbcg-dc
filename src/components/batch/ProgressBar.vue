<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** 0–1 fraction. */
    ratio: number;
    /** Bar thickness in px. */
    height?: number;
    /** Green (metadata-readiness) variant instead of the indigo default. */
    green?: boolean;
  }>(),
  { height: 7, green: false },
);

const pct = computed(() => `${Math.round(props.ratio * 100)}%`);
</script>

<template>
  <div class="track" :style="{ height: `${height}px` }">
    <div class="fill" :class="{ green }" :style="{ width: pct }" />
  </div>
</template>

<style scoped>
.track {
  flex: 1;
  background: var(--c-bg-page);
  border-radius: 5px;
  overflow: hidden;
}

.fill {
  height: 100%;
  background: var(--c-primary-gradient);
  border-radius: 5px;
  transition: width 0.4s;
}

.fill.green {
  background: linear-gradient(90deg, #1f9d57, #3bbd77);
}
</style>
