<script setup lang="ts">
import { computed } from "vue";
import { useBatch } from "@composables/useBatch";
import SetupTab from "./batch/SetupTab.vue";
import MetadataTab from "./batch/MetadataTab.vue";
import ProcessingTab from "./batch/ProcessingTab.vue";

const props = defineProps<{ batchId: string }>();

const { header, tabs, activeTab, setTab, unlock, back } = useBatch(
  () => props.batchId,
);

/** Pill palette per status label (same mapping as BatchCard). */
const pillClass = computed(() => {
  switch (header.value?.status) {
    case "Metadata":
      return "purple";
    case "Processing":
      return "blue";
    case "Ready to upload":
    case "Uploaded":
      return "green";
    default:
      return "gray";
  }
});
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
            <span v-if="header" class="pill" :class="pillClass">
              <span v-if="header.running" class="pill-spinner" />
              <span v-else class="pill-dot" />
              {{ header.status }}
            </span>
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
      <ProcessingTab v-else :batch-id="props.batchId" />
    </div>
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

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  border-radius: var(--r-pill);
  font-size: 11px;
  font-weight: 600;
}

.pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.pill-spinner {
  width: 11px;
  height: 11px;
  border: 2px solid rgba(47, 111, 237, 0.35);
  border-top-color: var(--c-info);
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.7s linear infinite;
}

.pill.gray {
  color: var(--c-idle);
  background: var(--c-idle-bg);
}

.pill.purple {
  color: var(--c-parent);
  background: var(--c-parent-bg);
}

.pill.blue {
  color: var(--c-info);
  background: var(--c-info-bg);
}

.pill.green {
  color: var(--c-success);
  background: var(--c-success-bg);
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
