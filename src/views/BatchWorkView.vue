<script setup lang="ts">
import { useBatch } from "@composables/useBatch";
import { useDeleteBatch } from "@composables/useDeleteBatch";
import SetupTab from "./batch/SetupTab.vue";
import MetadataTab from "./batch/MetadataTab.vue";
import ProcessingTab from "./batch/ProcessingTab.vue";
import StepIndicator from "@ui/batch/StepIndicator.vue";
import ProgressBar from "@ui/batch/ProgressBar.vue";
import DeleteBatchDialog from "@ui/batch/DeleteBatchDialog.vue";
import Spinner from "@ui/common/Spinner.vue";
import Pill from "@ui/common/Pill.vue";

const props = defineProps<{ batchId: string }>();

const { header, tabs, steps, activeTab, setTab, unlock, back, editItemMetadata } = useBatch(
  () => props.batchId,
);

const {
  open: deleteOpen,
  loading: deleteLoading,
  deleting,
  error: deleteError,
  plan: deletePlan,
  canConfirm,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmDelete,
} = useDeleteBatch({ onDeleted: () => back() });
</script>

<template>
  <div class="workspace">
    <!-- header -->
    <div class="head">
      <div class="head-row">
        <button class="back-btn" title="Back to batches" @click="back()">
          ‹
        </button>
        <div class="head-text">
          <div class="head-line">
            <span class="number">{{ header?.label ?? "Batch" }}</span>
            <Pill v-if="header" :tone="header.tone" dense>
              <template v-if="header.running" #marker>
                <Spinner :size="11" />
              </template>
              {{ header.status }}
            </Pill>
            <span v-if="header?.readOnly" class="ro-badge">READ-ONLY</span>
            <button
              v-if="header?.showsUnlock"
              class="unlock-btn"
              @click="unlock()"
            >
              Edit / re-process
            </button>
          </div>
          <div class="head-sub" v-if="header">
            {{ header.itemCount }} item{{ header.itemCount === 1 ? "" : "s" }}
          </div>
        </div>
        <div v-if="header" class="saved">
          <span class="saved-dot" />{{ header.savedLabel }}
        </div>
        <!-- The wrapper carries the tooltip: a disabled button gets no hover. -->
        <span
          v-if="header"
          class="delete-wrap"
          :title="header.deleteBlocked ?? 'Delete this batch and put its items back as they were'"
        >
          <button
            class="delete-btn"
            :disabled="header.deleteBlocked != null"
            @click="requestDelete(header.id)"
          >
            Delete batch
          </button>
        </span>
      </div>

      <div v-if="header" class="head-meta">
        <div class="steps-slot">
          <StepIndicator :steps="steps" />
        </div>
        <div class="progress-slot">
          <ProgressBar :ratio="header.progress.ratio" :height="6" />
          <span class="progress-label"
            >{{ header.progress.done }}/{{ header.progress.total }} processed</span
          >
        </div>
      </div>

      <div class="tab-bar">
        <button
          v-for="(tab, i) in tabs"
          :key="tab.key"
          class="tab-btn"
          :class="{ active: tab.active }"
          @click="setTab(tab.key)"
        >
          <span class="tab-num" :class="{ active: tab.active }">{{ i + 1 }}</span>
          {{ tab.label }}
        </button>
      </div>
    </div>

    <div class="body">
      <SetupTab
        v-if="activeTab === 'setup'"
        :batch-id="props.batchId"
        @continue="setTab('metadata')"
      />
      <MetadataTab
        v-else-if="activeTab === 'metadata'"
        :batch-id="props.batchId"
        @go-processing="setTab('processing')"
      />
      <ProcessingTab v-else :batch-id="props.batchId" @edit-metadata="editItemMetadata" />
    </div>

    <DeleteBatchDialog
      :open="deleteOpen"
      :loading="deleteLoading"
      :deleting="deleting"
      :can-confirm="canConfirm"
      :error="deleteError"
      :plan="deletePlan"
      @cancel="cancelDelete()"
      @confirm="confirmDelete()"
    />
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.head {
  background: var(--c-surface);
  border-bottom: 1px solid var(--c-border);
  padding: 0 26px;
  position: sticky;
  top: 0;
  z-index: 12;
}

.head-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 0 0;
}

.back-btn {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--r-md);
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  color: var(--c-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
}

.back-btn:hover {
  background: var(--c-primary-faint);
  color: var(--c-primary);
  border-color: var(--c-primary-soft-border);
}

.head-text {
  min-width: 0;
}

.head-line {
  display: flex;
  align-items: center;
  gap: 9px;
}

.number {
  font-size: 15px;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--c-text-strong);
}


.ro-badge {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--c-text-muted);
  background: var(--c-idle-bg);
  padding: 2px 8px;
  border-radius: var(--r-xs);
}

.unlock-btn {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--c-primary);
  border: 1px solid var(--c-primary-soft-border);
  background: var(--c-primary-faint);
  padding: 3px 10px;
  border-radius: var(--r-sm);
}

.head-sub {
  font-size: 12px;
  color: var(--c-text-faint);
}

.saved {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: #7c9e86;
  font-weight: 500;
  flex: none;
}

.saved-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-success-strong);
}

.delete-wrap {
  display: inline-flex;
  flex: none;
}

.delete-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-danger-border);
  background: var(--c-surface);
  color: var(--c-danger-text);
  font-weight: 600;
  font-size: 12.5px;
}

.delete-btn:hover:not(:disabled) {
  background: var(--c-danger-bg);
}

.delete-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.head-meta {
  display: flex;
  align-items: center;
  gap: 28px;
  margin-top: 12px;
}

.steps-slot {
  width: 340px;
  flex: none;
}

.progress-slot {
  flex: 1;
  max-width: 420px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress-label {
  font-size: 11.5px;
  color: var(--c-text-faint);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.tab-bar {
  display: flex;
  gap: 2px;
  margin-top: 10px;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 16px;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--c-text-muted);
  border-bottom: 2.5px solid transparent;
  white-space: nowrap;
}

.tab-btn.active {
  font-weight: 600;
  color: var(--c-primary);
  border-bottom-color: var(--c-primary);
}

.tab-num {
  width: 19px;
  height: 19px;
  flex: none;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--c-text-muted);
  background: var(--c-idle-bg);
}

.tab-num.active {
  color: #fff;
  background: var(--c-primary);
}

.body {
  flex: 1;
  padding: 22px 26px 52px;
}
</style>
