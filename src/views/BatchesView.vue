<script setup lang="ts">
import { useBatches } from "@composables/useBatches";
import BatchCard from "../components/batch/BatchCard.vue";

const { cards, isEmpty, loading, error, open, newFromOverview } = useBatches();
</script>

<template>
  <div class="screen">
    <div class="head">
      <div>
        <div class="title">Batches</div>
        <div class="sub">
          Every batch that isn't finished. Only one processes at a time.
        </div>
      </div>
      <button class="new-btn" @click="newFromOverview()">
        + New from Overview
      </button>
    </div>

    <div v-if="error" class="error-banner">✗ {{ error }}</div>

    <div v-if="isEmpty" class="empty">
      <div class="empty-title">No batches yet</div>
      <div class="empty-sub">
        Select items in Overview and hit
        <b>Create batch</b> to start one.
      </div>
    </div>

    <div v-else-if="loading && cards.length === 0" class="loading">
      Loading batches…
    </div>

    <div class="grid">
      <BatchCard
        v-for="card in cards"
        :key="card.id"
        :card="card"
        @open="open"
      />
    </div>
  </div>
</template>

<style scoped>
.screen {
  padding: 22px 26px 44px;
  max-width: 1000px;
  margin: 0 auto;
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.title {
  font-size: 17px;
  font-weight: 600;
}

.sub {
  font-size: 12.5px;
  color: var(--c-text-faint);
}

.new-btn {
  margin-left: auto;
  height: 36px;
  padding: 0 15px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-primary-soft-border);
  background: var(--c-primary-faint);
  color: var(--c-primary);
  font-weight: 600;
  font-size: 13px;
}

.error-banner {
  background: var(--c-danger-bg);
  border: 1px solid var(--c-danger-border);
  border-radius: 10px;
  padding: 11px 15px;
  margin-bottom: 14px;
  color: var(--c-danger-deep);
  font-size: 13px;
  font-weight: 500;
}

.empty {
  background: var(--c-surface);
  border: 1px dashed var(--c-border-dashed);
  border-radius: 14px;
  padding: 52px;
  text-align: center;
  color: var(--c-text-faint);
}

.empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--c-text-muted);
  margin-bottom: 6px;
}

.empty-sub {
  font-size: 13px;
}

.empty-sub b {
  color: var(--c-primary);
  font-weight: 600;
}

.loading {
  padding: 40px;
  text-align: center;
  color: var(--c-text-faint);
  font-size: 14px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}
</style>
