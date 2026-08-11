<script setup lang="ts">
import { computed } from "vue";
import type { BatchCardView } from "@composables/useBatches";
import StepIndicator from "./StepIndicator.vue";
import ProgressBar from "./ProgressBar.vue";

const props = defineProps<{ card: BatchCardView }>();

defineEmits<{ open: [id: string] }>();

/** Pill palette per status label (BATCH_STAGE_LABELS copy). */
const pillClass = computed(() => {
  switch (props.card.status) {
    case "Metadata":
      return "purple";
    case "Processing":
      return "blue";
    case "Ready to upload":
    case "Uploaded":
      return "green";
    default:
      return "gray";
  }
});

const pct = computed(() => `${Math.round(props.card.progress.ratio * 100)}%`);
</script>

<template>
  <div
    class="card"
    :class="{ running: card.running }"
    @click="$emit('open', card.id)"
  >
    <div class="head">
      <span class="number">{{ card.label }}</span>
      <span class="pill" :class="pillClass">
        <span v-if="card.running" class="spinner" />
        <span v-else class="dot" />
        {{ card.status }}
      </span>
      <span class="created">{{ card.createdAt }}</span>
    </div>
    <div class="count">
      {{ card.itemCount }} item{{ card.itemCount === 1 ? "" : "s" }}
      · {{ card.status.toLowerCase() }}
    </div>

    <div class="steps-slot">
      <StepIndicator :steps="card.steps" />
    </div>

    <div class="progress-row">
      <ProgressBar :ratio="card.progress.ratio" />
      <span class="pct">{{ pct }}</span>
    </div>
  </div>
</template>

<style scoped>
.card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 14px;
  padding: 16px 18px;
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: border-color 0.12s;
}

.card:hover,
.card.running {
  border-color: var(--c-primary-soft-border);
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 3px;
}

.number {
  font-size: 15px;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--c-text-strong);
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: var(--r-pill);
  font-size: 11.5px;
  font-weight: 600;
}

.pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.pill.gray {
  color: var(--c-idle);
  background: var(--c-idle-bg);
}

.pill.purple {
  color: var(--c-parent);
  background: var(--c-parent-bg);
}

.pill.blue {
  color: var(--c-info);
  background: var(--c-info-bg);
}

.pill.green {
  color: var(--c-success);
  background: var(--c-success-bg);
}

.spinner {
  width: 11px;
  height: 11px;
  border: 2px solid rgba(47, 111, 237, 0.35);
  border-top-color: var(--c-info);
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.7s linear infinite;
}

.created {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--c-text-dim);
  font-family: var(--font-mono);
}

.count {
  font-size: 13px;
  color: var(--c-text-muted);
  margin-bottom: 13px;
}

.steps-slot {
  margin-bottom: 12px;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pct {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--c-primary);
  min-width: 34px;
  text-align: right;
}
</style>
