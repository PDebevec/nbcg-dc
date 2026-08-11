<script setup lang="ts">
import type { FileChipView } from "@composables/useMetadataForm";

defineProps<{ files: FileChipView[] }>();
</script>

<template>
  <div class="card">
    <div class="heading">Files</div>
    <div class="strip">
      <div v-for="f in files" :key="f.name" class="chip" :class="{ local: f.local }">
        <span class="glyph">{{ f.glyph }}</span>
        <div class="text">
          <div class="name">{{ f.name }}</div>
          <div class="meta">{{ f.meta }}</div>
        </div>
        <span v-if="f.tag" class="tag">{{ f.tag }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-xl);
  padding: 13px 16px;
  margin-bottom: 14px;
}

.heading {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted);
  margin-bottom: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.strip {
  display: flex;
  gap: 9px;
  flex-wrap: wrap;
}

.chip {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--c-border-row);
  border-radius: var(--r-md);
  padding: 8px 11px;
  background: var(--c-surface-input);
  min-width: 196px;
}

.chip.local {
  background: #f3f4fb;
  border-color: #dde2f0;
}

.glyph {
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 6px;
  background: var(--c-primary-soft);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--c-primary);
}

.chip.local .glyph {
  background: #e2e7f5;
  color: #4a5580;
}

.text {
  min-width: 0;
  flex: 1;
}

.name {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-mid);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  font-size: 10.5px;
  color: var(--c-text-faint);
}

.tag {
  font-size: 9px;
  font-weight: 700;
  color: #5a678f;
  background: #e2e7f5;
  padding: 2px 6px;
  border-radius: var(--r-xs);
  letter-spacing: 0.4px;
  flex: none;
}
</style>
