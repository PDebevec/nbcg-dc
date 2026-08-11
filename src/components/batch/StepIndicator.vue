<script setup lang="ts">
/** One step of the Setup → Metadata → Process indicator. */
export interface Step {
  label: string;
  done: boolean;
  active: boolean;
}

defineProps<{ steps: Step[] }>();
</script>

<template>
  <div class="steps">
    <div v-for="(step, i) in steps" :key="step.label" class="step">
      <span
        class="glyph"
        :class="{ done: step.done, active: step.active }"
      >{{ step.done ? "✓" : i + 1 }}</span>
      <span class="label" :class="{ done: step.done, active: step.active }">{{
        step.label
      }}</span>
      <span
        v-if="i < steps.length - 1"
        class="connector"
        :class="{ done: step.done }"
      />
    </div>
  </div>
</template>

<style scoped>
.steps {
  display: flex;
  align-items: center;
  gap: 6px;
}

.step {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
}

.glyph {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--c-idle-dot);
  background: var(--c-surface);
  border: 1.5px solid var(--c-border-strong);
}

.glyph.active {
  color: var(--c-info);
  background: var(--c-info-bg);
  border: none;
}

.glyph.done {
  color: var(--c-success);
  background: var(--c-success-bg);
  border: none;
}

.label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--c-text-dim);
  white-space: nowrap;
}

.label.active {
  font-weight: 700;
  color: var(--c-text-mid);
}

.label.done {
  color: #4a5170;
}

.connector {
  flex: 1;
  height: 2px;
  border-radius: 2px;
  background: var(--c-border);
}

.connector.done {
  background: var(--c-success-border);
}
</style>
