<script setup lang="ts">
import { computed } from "vue";
import type { BatchCardView } from "@composables/useBatches";
import StepIndicator from "./StepIndicator.vue";
import ProgressBar from "./ProgressBar.vue";
import Spinner from "@ui/common/Spinner.vue";
import Pill from "@ui/common/Pill.vue";

const props = defineProps<{ card: BatchCardView }>();

defineEmits<{ open: [id: string]; delete: [id: string] }>();

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
      <!-- The wrapper carries the tooltip (a disabled button gets no hover)
           and stops the click from opening the card. -->
      <span class="delete-wrap" :title="card.deleteBlocked ?? 'Delete batch'" @click.stop>
        <button
          class="delete-btn"
          :disabled="card.deleteBlocked != null"
          aria-label="Delete batch"
          @click="$emit('delete', card.id)"
        >
          <svg
            viewBox="0 0 20 20"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
          >
            <path d="M3.5 5.5h13M8 5.5V4h4v1.5M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5M11.5 8.5v5" />
          </svg>
        </button>
      </span>
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

.delete-wrap {
  display: inline-flex;
}

.delete-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  color: #9aa1bb;
  display: flex;
  align-items: center;
  justify-content: center;
}

.delete-btn:hover:not(:disabled) {
  background: var(--c-danger-bg);
  color: var(--c-danger-text);
}

.delete-btn:disabled {
  opacity: 0.4;
  cursor: default;
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
