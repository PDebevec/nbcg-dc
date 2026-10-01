<script setup lang="ts">
import { computed } from "vue";
import type { CopyPromptView } from "@composables/useParentCopyPrompt";
import type { PassingAnswer } from "@composables/useParentLinks";

const props = defineProps<{ prompt: CopyPromptView | null }>();

const emit = defineEmits<{ answer: [choice: PassingAnswer] }>();

/** "“Pobjeda” has different values for fields this item already has:" */
const lead = computed(() => {
  const p = props.prompt;
  if (!p) return "";
  const who = p.source ? `“${p.source}” has` : "The data-passing parents have";
  const where = p.itemCount === 1 ? "this item already has" : `${p.itemCount} items already have`;
  return `${who} different values for fields ${where}:`;
});
</script>

<template>
  <!-- Before a data-passing parent's fields go in over values the item already
       holds: what would be replaced, then overwrite them, fill only the empty
       fields, or cancel (✕) — the parent then doesn't pass data. -->
  <div v-if="prompt" class="backdrop" @click.self="emit('answer', 'cancel')">
    <div class="panel" role="dialog" aria-modal="true">
      <div class="head">
        <span>Replace filled-in fields?</span>
        <button class="x" title="Cancel" @click="emit('answer', 'cancel')">✕</button>
      </div>

      <div class="body">
        <p class="lead">{{ lead }}</p>
        <div class="fields">
          <div v-for="f in prompt.fields" :key="f.key" class="field">
            <div class="field-name">
              {{ f.label }}
              <span v-if="prompt.itemCount > 1" class="count">
                in {{ f.items }} {{ f.items === 1 ? "item" : "items" }}
              </span>
            </div>
            <div v-if="prompt.itemCount === 1" class="change">
              <span class="old">{{ f.current }}</span>
              <span class="arrow">→</span>
              <span class="new">{{ f.incoming }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="actions">
        <button class="fill" @click="emit('answer', 'fill-empty')">Fill only empty fields</button>
        <button class="overwrite" @click="emit('answer', 'overwrite-all')">Overwrite them</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Same shell as DeleteBatchDialog.vue (styles are scoped per file, so it is
   repeated rather than imported). */
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 22, 34, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
  animation: fadein 0.12s;
}

.panel {
  width: 520px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 96px);
  display: flex;
  flex-direction: column;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 14px;
  box-shadow: var(--shadow-menu);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--c-border-row);
  font-weight: 600;
  font-size: 13.5px;
  color: var(--c-text-strong);
}

.x {
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  color: #9aa1bb;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.lead {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--c-text-strong);
}

.fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field {
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  padding: 9px 12px;
  background: var(--c-surface-input);
  min-width: 0;
}

.field-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--c-text-strong);
}

.count {
  font-weight: 400;
  font-size: 12px;
  color: var(--c-text-muted);
}

.change {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 3px;
  font-size: 12.5px;
  min-width: 0;
}

.old,
.new {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.old {
  color: var(--c-text-muted);
  text-decoration: line-through;
}

.new {
  color: var(--c-text-strong);
}

.arrow {
  flex: none;
  color: var(--c-text-faint);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  padding: 13px 16px;
  border-top: 1px solid var(--c-border-row);
}

.fill,
.overwrite {
  height: 34px;
  padding: 0 14px;
  border-radius: var(--r-md);
  font-weight: 600;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
}

.fill {
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-muted);
}

.overwrite {
  border: 1px solid var(--c-danger-border);
  background: #fdf0ee;
  color: var(--c-danger-text);
}
</style>
