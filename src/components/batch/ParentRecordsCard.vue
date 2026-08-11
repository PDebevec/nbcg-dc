<script setup lang="ts">
import type { ParentRowView } from "@composables/useBatchSetup";

defineProps<{
  parents: ParentRowView[];
  editable: boolean;
  /** Card description under the heading. */
  description?: string;
}>();

defineEmits<{
  add: [];
  remove: [id: string];
  togglePass: [id: string];
}>();
</script>

<template>
  <div class="card">
    <div class="heading">Parent records</div>
    <div v-if="description" class="desc">{{ description }}</div>

    <div v-if="parents.length > 0" class="list">
      <div v-for="p in parents" :key="p.id" class="parent-row">
        <span class="type-chip">{{ p.typeLabel.charAt(0) }}</span>
        <div class="parent-text">
          <div class="parent-name">{{ p.name }}</div>
          <div class="parent-meta">{{ p.typeLabel }} · {{ p.id }}</div>
        </div>
        <button
          v-if="p.canPassData && editable"
          class="pass-btn"
          :class="{ passing: p.passesData }"
          :title="
            p.passesData
              ? 'Passing its shared fields down — click to stop'
              : 'Click to make this the data-passing parent'
          "
          @click="$emit('togglePass', p.id)"
        >
          {{ p.passesData ? "↧ passes data" : "○ can pass data" }}
        </button>
        <button
          v-if="editable"
          class="remove-btn"
          title="Unlink"
          @click="$emit('remove', p.id)"
        >
          <svg
            viewBox="0 0 20 20"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <line x1="5" y1="5" x2="15" y2="15" />
            <line x1="15" y1="5" x2="5" y2="15" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="editable" class="add-row">
      <div class="search-box">
        <span class="search-glyph">⌕</span>
        <input placeholder="Search serials & collections to link…" />
      </div>
      <button class="add-btn" @click="$emit('add')">+ Link parent</button>
    </div>
  </div>
</template>

<style scoped>
.card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-xl);
  padding: 16px 18px;
  margin-bottom: 14px;
}

.heading {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.desc {
  font-size: 12.5px;
  color: var(--c-text-faint);
  margin-bottom: 11px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 11px;
}

.parent-row {
  display: flex;
  align-items: center;
  gap: 11px;
  background: var(--c-parent-card);
  border: 1px solid var(--c-parent-card-border);
  border-radius: 10px;
  padding: 10px 12px;
}

.type-chip {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 8px;
  background: var(--c-parent-icon-bg);
  color: var(--c-parent-icon);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 12px;
}

.parent-text {
  min-width: 0;
  flex: 1;
}

.parent-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--c-parent-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.parent-meta {
  font-size: 11px;
  color: var(--c-parent-meta);
  font-family: var(--font-mono);
}

.pass-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  padding: 5px 10px;
  border-radius: var(--r-sm);
  color: var(--c-text-thead);
  background: var(--c-idle-bg-alt);
  border: 1px solid #dfe2ee;
  white-space: nowrap;
  flex: none;
}

.pass-btn.passing {
  color: var(--c-success);
  background: var(--c-success-bg);
  border-color: var(--c-success-border);
}

.remove-btn {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: var(--r-sm);
  color: var(--c-text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
}

.remove-btn:hover {
  background: var(--c-idle-bg);
  color: var(--c-text-muted);
}

.add-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.search-box {
  display: flex;
  align-items: center;
  background: var(--c-surface-input-alt);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  padding: 0 11px;
  height: 38px;
  flex: 1;
  max-width: 340px;
}

.search-glyph {
  color: #9aa1bb;
}

.search-box input {
  border: none;
  background: none;
  padding: 0 8px;
  font-size: 13px;
  width: 100%;
}

.add-btn {
  height: 38px;
  padding: 0 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-parent-btn-border);
  background: var(--c-parent-btn-bg);
  color: var(--c-parent-btn);
  font-weight: 600;
  font-size: 13px;
}
</style>
