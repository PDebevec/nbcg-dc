<script setup lang="ts">
import type { StagePipView } from "@composables/useOverview";
import Spinner from "@ui/common/Spinner.vue";

defineProps<{ pips: StagePipView[] }>();
</script>

<!-- Renders one <td> per stage — must sit directly inside the row's <tr>. -->
<template>
  <td v-for="pip in pips" :key="pip.stage" class="pip-cell">
    <span class="pip" :title="`${pip.label} — ${pip.status}`">
      <Spinner v-if="pip.status === 'running'" />
      <span v-else class="dot" :class="pip.status" />
    </span>
  </td>
</template>

<style scoped>
.pip-cell {
  text-align: center;
  padding: 11px 6px;
}

.pip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.dot.done {
  background: var(--c-success);
}

.dot.failed {
  background: var(--c-danger);
}

.dot.re-upload {
  background: var(--c-warn);
}

.dot.pending {
  background: transparent;
  border: 1.5px solid var(--c-idle-dot);
}

.dot.queued {
  background: transparent;
  border: 1.5px solid var(--c-info);
}

.dot.skipped {
  background: var(--c-border-strong);
  height: 3px;
  border-radius: 2px;
}
</style>
