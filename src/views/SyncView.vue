<script setup lang="ts">
import { computed } from "vue";
import { useSyncScreen } from "@composables/useSyncScreen";
import ProgressBar from "../components/batch/ProgressBar.vue";

const {
  syncing,
  error,
  hostLabel,
  lastSyncLabel,
  nextSyncLabel,
  progressFraction,
  stageLabel,
  tiles,
  log,
  syncNow,
} = useSyncScreen();

const pct = computed(() => `${Math.round(progressFraction.value * 100)}%`);
</script>

<template>
  <div class="screen">
    <!-- header card -->
    <div class="card head-card">
      <div class="head-row" :class="{ syncing }">
        <div class="icon">↻</div>
        <div class="head-text">
          <div class="title">Metadata sync</div>
          <div class="sub">
            Last synced {{ lastSyncLabel }} · pulls catalog metadata from the
            backend into the archive
          </div>
        </div>
        <div class="meta">
          <div class="meta-label">Source</div>
          <div class="meta-value">{{ hostLabel }}</div>
        </div>
        <div class="meta">
          <div class="meta-label">Auto-sync</div>
          <div class="meta-value">{{ nextSyncLabel }}</div>
        </div>
        <button class="sync-btn" :disabled="syncing" @click="syncNow()">
          <span v-if="syncing" class="spinner" />
          {{ syncing ? "Syncing…" : "Sync now" }}
        </button>
      </div>

      <div v-if="syncing" class="progress-block">
        <div class="progress-row">
          <ProgressBar :ratio="progressFraction" :height="9" />
          <span class="pct">{{ pct }}</span>
        </div>
        <div class="stage">{{ stageLabel }}</div>
      </div>

      <div v-if="error" class="error-line">✗ {{ error }}</div>
    </div>

    <!-- stat tiles -->
    <div class="tiles">
      <div v-for="tile in tiles" :key="tile.label" class="tile">
        <div class="tile-value" :class="tile.accent">{{ tile.value }}</div>
        <div class="tile-label">{{ tile.label }}</div>
      </div>
    </div>

    <!-- recent syncs -->
    <div class="card log-card">
      <div class="log-heading">Recent syncs</div>
      <div v-if="log.length === 0" class="log-empty">No syncs yet.</div>
      <div v-for="row in log" :key="row.id" class="log-row">
        <span class="log-dot" :class="row.status" />
        <div class="log-text">
          <div class="log-summary">{{ row.summary }}</div>
          <div class="log-detail">{{ row.detail }}</div>
        </div>
        <span class="log-time">{{ row.time }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.screen {
  padding: 22px 26px 48px;
  max-width: 760px;
  margin: 0 auto;
}

.card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 14px;
  margin-bottom: 16px;
}

.head-card {
  padding: 22px 24px;
}

.head-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.head-row.syncing {
  margin-bottom: 18px;
}

.icon {
  width: 46px;
  height: 46px;
  flex: none;
  border-radius: 12px;
  background: var(--c-primary-soft);
  color: var(--c-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
}

.head-text {
  flex: 1;
  min-width: 0;
}

.title {
  font-size: 17px;
  font-weight: 600;
}

.sub {
  font-size: 12.5px;
  color: var(--c-text-faint);
}

.meta {
  text-align: right;
}

.meta-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--c-text-faint);
  margin-bottom: 3px;
}

.meta-value {
  font-size: 12.5px;
  font-family: var(--font-mono);
  color: var(--c-primary);
}

.sync-btn {
  height: 42px;
  padding: 0 22px;
  border-radius: 10px;
  background: var(--c-primary);
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 9px;
}

.sync-btn:disabled {
  cursor: default;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.7s linear infinite;
}

.progress-block {
  margin-top: 0;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}

.pct {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--c-primary);
}

.stage {
  font-size: 12px;
  color: var(--c-text-faint);
}

.error-line {
  margin-top: 12px;
  font-size: 12.5px;
  color: var(--c-danger-deep);
  font-weight: 500;
}

/* ── tiles ──────────────────────────────────────────────────────────── */
.tiles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.tile {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  padding: 15px 16px;
}

.tile-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--c-text-strong);
  font-family: var(--font-mono);
  line-height: 1.1;
}

.tile-value.info {
  color: var(--c-info);
}

.tile-value.warn {
  color: var(--c-warn);
}

.tile-label {
  font-size: 12px;
  color: var(--c-text-faint);
  margin-top: 4px;
}

/* ── log ────────────────────────────────────────────────────────────── */
.log-card {
  padding: 8px 20px 12px;
}

.log-heading {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted);
  padding: 14px 2px 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.log-empty {
  padding: 20px 2px 14px;
  font-size: 13px;
  color: var(--c-text-faint);
}

.log-row {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 12px 2px;
  border-top: 1px solid #f2f3f8;
}

.log-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}

.log-dot.ok {
  background: var(--c-success-strong);
  box-shadow: 0 0 0 3px rgba(46, 158, 91, 0.16);
}

.log-dot.warning {
  background: #e0982f;
  box-shadow: 0 0 0 3px rgba(224, 152, 47, 0.16);
}

.log-dot.error {
  background: var(--c-danger);
  box-shadow: 0 0 0 3px rgba(217, 58, 44, 0.16);
}

.log-text {
  flex: 1;
  min-width: 0;
}

.log-summary {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--c-text-mid);
}

.log-detail {
  font-size: 11.5px;
  color: var(--c-text-dim);
  font-family: var(--font-mono);
}

.log-time {
  font-size: 12px;
  color: var(--c-text-faint);
  font-family: var(--font-mono);
  white-space: nowrap;
}
</style>
