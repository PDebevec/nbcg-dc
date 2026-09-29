<script setup lang="ts">
import type { DeleteBatchPlanView } from "@composables/useDeleteBatch";
import Spinner from "@ui/common/Spinner.vue";

defineProps<{
  open: boolean;
  loading: boolean;
  deleting: boolean;
  canConfirm: boolean;
  error: string | null;
  plan: DeleteBatchPlanView | null;
}>();

defineEmits<{ cancel: []; confirm: [] }>();
</script>

<template>
  <!-- Delete batch: every member goes back to its pre-batch snapshot. Lists
       what will be removed and put back first, flagging any file the app
       didn't make, because this can't be undone. -->
  <div v-if="open" class="backdrop" @click.self="!deleting && $emit('cancel')">
    <div class="panel" role="dialog" aria-modal="true">
      <div class="head">
        <span>{{ plan ? `Delete ${plan.label}?` : "Delete batch?" }}</span>
        <button class="x" title="Cancel" :disabled="deleting" @click="$emit('cancel')">✕</button>
      </div>

      <div class="body">
        <div v-if="loading" class="muted checking">
          <Spinner :size="12" /> Checking what this batch changed…
        </div>
        <template v-else-if="plan">
          <p v-if="plan.blockedReason" class="blocked">{{ plan.blockedReason }}</p>
          <template v-else>
            <p v-if="plan.legacy" class="lead">
              This batch was made before batches could be undone, so its folders
              can't be put back. Deleting it only unlocks its
              {{ plan.itemCount }} {{ plan.itemCount === 1 ? "item" : "items" }};
              any files it created stay where they are.
            </p>
            <p v-else class="lead">
              Every item goes back to exactly how it was before this batch.
              <b>This can't be undone.</b>
            </p>
            <p v-if="plan.handAddedCount > 0" class="warn">
              {{ plan.handAddedCount }}
              {{ plan.handAddedCount === 1 ? "file wasn't" : "files weren't" }}
              made by the app and will be deleted too — marked below.
            </p>
            <div class="items">
              <div v-for="item in plan.items" :key="item.id" class="item">
                <div class="item-head">
                  <span class="item-name">{{ item.name }}</span>
                  <span v-if="item.returnsTo" class="returns">→ {{ item.returnsTo }}</span>
                </div>
                <div v-if="item.error" class="item-error">{{ item.error }}</div>
                <div v-else-if="item.unchanged && !plan.legacy" class="muted">
                  No file changes.
                </div>
                <template v-else>
                  <div v-if="item.remove.length > 0" class="group">
                    <div class="group-label">Removed</div>
                    <div
                      v-for="f in item.remove"
                      :key="f.path"
                      class="file"
                      :class="{ hand: f.handAdded }"
                    >
                      <span class="mono">{{ f.path }}</span>
                      <span v-if="f.handAdded" class="tag">not made by the app</span>
                    </div>
                  </div>
                  <div v-if="item.restore.length > 0" class="group">
                    <div class="group-label">Put back</div>
                    <div v-for="p in item.restore" :key="p" class="file">
                      <span class="mono">{{ p }}</span>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </template>
        </template>
        <div v-if="error" class="error">✗ {{ error }}</div>
      </div>

      <div class="actions">
        <button class="cancel" :disabled="deleting" @click="$emit('cancel')">Cancel</button>
        <button class="confirm" :disabled="!canConfirm" @click="$emit('confirm')">
          <Spinner v-if="deleting" :size="11" />
          {{ deleting ? "Deleting…" : "Delete batch" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Same shell as the Close-batch confirm in ProcessingTab.vue (styles are
   scoped per file, so it is repeated rather than imported). */
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
  width: 560px;
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

.lead,
.blocked,
.warn {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--c-text-strong);
}

.blocked {
  color: var(--c-text-muted);
}

.warn {
  padding: 10px 12px;
  border: 1px solid var(--c-danger-border);
  border-radius: var(--r-md);
  background: var(--c-danger-bg);
  color: var(--c-danger-deep);
  font-size: 13px;
}

.muted {
  font-size: 12.5px;
  color: var(--c-text-muted);
}

.checking {
  display: flex;
  align-items: center;
  gap: 8px;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.item {
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  padding: 10px 12px;
  background: var(--c-surface-input);
}

.item-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.item-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--c-text-strong);
}

.returns {
  font-size: 12px;
  color: var(--c-text-muted);
}

.item-error {
  font-size: 12.5px;
  color: var(--c-danger-text);
}

.group + .group {
  margin-top: 6px;
}

.group-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--c-text-faint);
  margin-bottom: 2px;
}

.file {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--c-text-mid);
}

.file.hand {
  color: var(--c-danger-text);
  font-weight: 600;
}

.mono {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--r-xs);
  border: 1px solid var(--c-danger-border);
  background: var(--c-danger-bg);
}

.error {
  font-size: 13px;
  color: var(--c-danger-deep);
  background: var(--c-danger-bg);
  border: 1px solid var(--c-danger-border);
  border-radius: var(--r-md);
  padding: 10px 12px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  padding: 13px 16px;
  border-top: 1px solid var(--c-border-row);
}

.cancel,
.confirm {
  height: 34px;
  padding: 0 14px;
  border-radius: var(--r-md);
  font-weight: 600;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.cancel {
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-muted);
}

.confirm {
  border: 1px solid var(--c-danger-border);
  background: #fdf0ee;
  color: var(--c-danger-text);
}

.confirm:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
