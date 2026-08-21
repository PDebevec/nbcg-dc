<script setup lang="ts">
import { computed } from "vue";
import type { ParentRowView, ParentSearchRow } from "@composables/useParentLinks";

const props = defineProps<{
  parents: ParentRowView[];
  editable: boolean;
  /** Card description under the heading. */
  description?: string;
  /** Parent search box state (owned by the composable). */
  query: string;
  results: ParentSearchRow[];
  searching: boolean;
  searchError: string | null;
}>();

const emit = defineEmits<{
  updateQuery: [value: string];
  link: [id: string];
  remove: [id: string];
  togglePass: [id: string];
}>();

const trimmedQuery = computed(() => props.query.trim());
const showResults = computed(() => trimmedQuery.value.length > 0);
const noMatches = computed(
  () =>
    showResults.value &&
    !props.searching &&
    !props.searchError &&
    props.results.length === 0,
);

function onInput(event: Event): void {
  emit("updateQuery", (event.target as HTMLInputElement).value);
}
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
        <span v-else-if="p.passesData" class="pass-btn passing static">↧ passes data</span>
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
    <div v-else-if="!editable" class="empty">No parent records linked.</div>

    <div v-if="editable" class="add-slot">
      <div class="add-row">
        <div class="search-box">
          <span class="search-glyph">⌕</span>
          <input
            :value="query"
            placeholder="Search serials & collections to link… (title or id)"
            @input="onInput"
          />
          <span v-if="searching" class="spinner" />
          <button
            v-else-if="query"
            class="clear-btn"
            title="Clear"
            @click="emit('updateQuery', '')"
          >
            ×
          </button>
        </div>
      </div>

      <div v-if="showResults" class="results">
        <div v-if="searchError" class="results-note error">✗ {{ searchError }}</div>
        <button
          v-for="r in results"
          :key="r.id"
          class="result-row"
          :disabled="r.linked"
          @click="emit('link', r.id)"
        >
          <span class="result-text">
            <span class="result-title">{{ r.title }}</span>
            <span class="result-meta">{{ r.meta }} · {{ r.id }}</span>
          </span>
          <span class="result-action">{{ r.linked ? "Linked" : "+ Link" }}</span>
        </button>
        <div v-if="noMatches" class="results-note">
          No matches.
          <button class="link-id" @click="emit('link', trimmedQuery)">
            Link “{{ trimmedQuery }}” as a record id
          </button>
        </div>
      </div>
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

.empty {
  font-size: 12.5px;
  color: var(--c-text-faint);
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

.pass-btn.static {
  cursor: default;
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

.add-slot {
  position: relative;
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
  max-width: 440px;
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

.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--c-border);
  border-top-color: var(--c-primary);
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.7s linear infinite;
  flex: none;
}

.clear-btn {
  color: var(--c-text-dim);
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
}

.results {
  margin-top: 8px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface);
  max-width: 440px;
  max-height: 260px;
  overflow: auto;
  padding: 4px;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
}

.result-row:hover:not(:disabled) {
  background: var(--c-parent-card);
}

.result-row:disabled {
  opacity: 0.6;
  cursor: default;
}

.result-text {
  min-width: 0;
  flex: 1;
}

.result-title {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-mid);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-meta {
  display: block;
  font-size: 10.5px;
  color: var(--c-text-faint);
  font-family: var(--font-mono);
}

.result-action {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-parent-btn);
  white-space: nowrap;
}

.results-note {
  font-size: 12.5px;
  color: var(--c-text-faint);
  padding: 8px 10px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.results-note.error {
  color: var(--c-danger-text);
}

.link-id {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--c-parent-btn);
}
</style>
