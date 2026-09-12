<script setup lang="ts">
import { computed } from "vue";
import type { BatchCardView } from "@composables/useBatches";
import StepIndicator from "./StepIndicator.vue";
import ProgressBar from "./ProgressBar.vue";
import Spinner from "@ui/common/Spinner.vue";
import Pill from "@ui/common/Pill.vue";

const props = defineProps<{ card: BatchCardView }>();

defineEmits<{ open: [id: string] }>();

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
      <Pill :tone="card.tone">
        <template v-if="card.running" #marker>
          <Spinner :size="11" />
        </template>
        {{ card.status }}
      </Pill>
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
