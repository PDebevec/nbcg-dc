<script setup lang="ts">
import { ref } from "vue";
import { useOverview } from "@composables/useOverview";
import StagePips from "../components/table/StagePips.vue";
import StatePill from "../components/table/StatePill.vue";

const {
  loading,
  error,
  rows,
  filters,
  search,
  infoLine,
  selectable,
  selectionCount,
  canCreateBatch,
  allVisibleSelected,
  setFilter,
  setSearch,
  onRowClick,
  toggleRow,
  selectAllVisible,
  clearSelection,
  openInExplorer,
  openAsBatch,
  createBatch,
} = useOverview();

const stageColumns = ["PDF", "Thumbnail", "OCR", "Metadata", "Uploaded"];

/** Which row's ⋯ menu is open (null = none). */
const openMenuId = ref<string | null>(null);

function toggleMenu(id: string): void {
  openMenuId.value = openMenuId.value === id ? null : id;
}

function menuOpenAsBatch(id: string): void {
  openMenuId.value = null;
  void openAsBatch(id);
}

function menuOpenInExplorer(id: string): void {
  openMenuId.value = null;
  void openInExplorer(id);
}

function rowClick(id: string): void {
  openMenuId.value = null;
  onRowClick(id);
}
</script>

<template>
  <div class="screen" @click="openMenuId = null">
    <!-- toolbar -->
    <div class="toolbar">
      <div class="seg-track">
        <button
          v-for="f in filters"
          :key="f.key"
          class="seg"
          :class="{ active: f.active }"
          @click="setFilter(f.key)"
        >
          <span class="seg-dot" :class="f.key" />
          {{ f.label }}
          <span class="seg-count">{{ f.count }}</span>
        </button>
      </div>
      <button
        v-if="selectable && rows.length > 0"
        class="select-all"
        @click="allVisibleSelected ? clearSelection() : selectAllVisible()"
      >
        <span class="check-glyph">{{ allVisibleSelected ? "✓" : "" }}</span>
        {{ allVisibleSelected ? "Clear selection" : `Select all ${rows.length}` }}
      </button>
    </div>

    <!-- info line for non-selectable filters -->
    <div v-if="infoLine" class="info-line">
      <span class="info-i">i</span>
      {{ infoLine }}
    </div>

    <!-- error banner -->
    <div v-if="error" class="error-banner">✗ {{ error }}</div>

    <!-- bulk / create-batch bar -->
    <div v-if="selectionCount > 0" class="selection-bar">
      <span class="sel-count">{{ selectionCount }} selected</span>
      <span class="sel-note">→ new batch, moved to In&nbsp;progress</span>
      <button
        class="btn-primary create-btn"
        :disabled="!canCreateBatch"
        @click="createBatch()"
      >
        <span class="batch-glyph">▤</span>Create batch
      </button>
      <button class="clear-btn" @click="clearSelection()">Clear</button>
    </div>

    <!-- table -->
    <div class="table-card">
      <table>
        <thead>
          <tr>
            <th class="col-check"></th>
            <th class="col-item">
              <div class="item-head">
                <span>Item</span>
                <div class="search-box" @click.stop>
                  <span class="search-glyph">⌕</span>
                  <input
                    :value="search"
                    placeholder="Search items…"
                    @input="setSearch(($event.target as HTMLInputElement).value)"
                  />
                </div>
              </div>
            </th>
            <th v-for="col in stageColumns" :key="col" class="col-stage">
              {{ col }}
            </th>
            <th class="col-state">State</th>
            <th class="col-menu"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.id"
            :class="{ stopped: row.state === 'stopped', 'in-batch': row.locked }"
            @click.stop="rowClick(row.id)"
          >
            <td class="col-check" @click.stop>
              <input
                v-if="row.selectable"
                type="checkbox"
                :checked="row.selected"
                @change="toggleRow(row.id)"
              />
              <span v-else-if="row.locked" class="lock" title="In a batch — locked">
                <svg
                  viewBox="0 0 20 20"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                >
                  <rect x="4.5" y="9" width="11" height="7.5" rx="1.6" />
                  <path d="M7 9V6.6a3 3 0 0 1 6 0V9" />
                </svg>
              </span>
            </td>
            <td class="col-item">
              <div class="item-cell">
                <span class="accent" :class="row.state" />
                <div class="item-text">
                  <div class="item-title">{{ row.title ?? row.folderName }}</div>
                  <div class="item-meta">
                    <span>{{ row.folderName }}</span>
                    <span v-if="row.catalogueId" class="backend-id">{{
                      row.catalogueId
                    }}</span>
                  </div>
                  <div v-if="row.errorMessage" class="item-error">
                    <span class="err-dot" />{{ row.errorMessage }}
                  </div>
                </div>
              </div>
            </td>
            <StagePips :pips="row.pips" />
            <td class="col-state">
              <StatePill :state="row.state" :label="row.stateLabel" />
            </td>
            <td class="col-menu" @click.stop>
              <button
                class="menu-btn"
                title="More actions"
                @click="toggleMenu(row.id)"
              >
                ⋯
              </button>
              <div v-if="openMenuId === row.id" class="row-menu">
                <button @click="menuOpenAsBatch(row.id)">
                  <svg
                    viewBox="0 0 20 20"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                  >
                    <rect x="2.5" y="3.5" width="12" height="12" rx="2" />
                    <line x1="7" y1="3.5" x2="7" y2="15.5" />
                  </svg>
                  {{ row.locked ? "Open batch" : "Open as batch" }}
                </button>
                <button @click="menuOpenInExplorer(row.id)">
                  <svg
                    viewBox="0 0 20 20"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                  >
                    <path
                      d="M2.6 6a1.4 1.4 0 0 1 1.4-1.4h2.6l1.4 1.8h6a1.4 1.4 0 0 1 1.4 1.4v6.4a1.4 1.4 0 0 1-1.4 1.4H4a1.4 1.4 0 0 1-1.4-1.4z"
                    />
                  </svg>
                  Open in Explorer
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="rows.length === 0 && !loading" class="empty">
        No items match this filter.
      </div>
      <div v-if="loading && rows.length === 0" class="empty">Loading items…</div>
    </div>
  </div>
</template>

<style scoped>
.screen {
  padding: 22px 26px 40px;
}

/* ── toolbar ─────────────────────────────────────────────────────────── */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.seg-track {
  display: flex;
  gap: 4px;
  background: var(--c-surface-seg);
  padding: 4px;
  border-radius: 10px;
}

.seg {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: var(--r-sm);
  font-size: 13px;
  font-weight: 500;
  color: var(--c-text-muted);
}

.seg.active {
  font-weight: 600;
  color: var(--c-primary);
  background: var(--c-surface);
}

.seg-dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  flex: none;
}

.seg-dot.all {
  opacity: 0;
}

.seg-dot.unprocessed {
  background: var(--c-idle);
}

.seg-dot.in-progress {
  background: var(--c-info);
}

.seg-dot.stopped {
  background: var(--c-danger);
}

.seg-dot.needs-reupload {
  background: var(--c-warn);
}

.seg-dot.done {
  background: var(--c-success);
}

.seg-count {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--c-text-dim);
  background: #dfe2ee;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  min-width: 19px;
  text-align: center;
}

.seg.active .seg-count {
  color: var(--c-primary);
  background: #e7ebfb;
}

.select-all {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 15px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-primary-soft-border);
  background: var(--c-primary-faint);
  color: var(--c-primary);
  font-weight: 600;
  font-size: 13px;
}

.check-glyph {
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--c-primary);
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
}

/* ── info / error / selection bars ──────────────────────────────────── */
.info-line {
  display: flex;
  align-items: center;
  gap: 9px;
  background: var(--c-surface-input-alt);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  padding: 9px 14px;
  margin-bottom: 14px;
  color: var(--c-text-muted);
  font-size: 12.5px;
}

.info-i {
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 50%;
  background: var(--c-border-strong);
  color: var(--c-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 11px;
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  background: var(--c-danger-bg);
  border: 1px solid var(--c-danger-border);
  border-radius: 10px;
  padding: 11px 15px;
  margin-bottom: 14px;
  color: var(--c-danger-deep);
  font-size: 13px;
  font-weight: 500;
}

.selection-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--c-primary-soft);
  border: 1px solid var(--c-primary-soft-border);
  border-radius: var(--r-lg);
  padding: 11px 16px;
  margin-bottom: 14px;
  animation: fadein 0.15s;
}

.sel-count {
  font-weight: 600;
  font-size: 13.5px;
  color: var(--c-primary);
}

.sel-note {
  font-size: 12px;
  color: #7681b8;
}

.btn-primary {
  height: 34px;
  padding: 0 16px;
  border-radius: 8px;
  background: var(--c-primary);
  color: #fff;
  font-weight: 600;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-primary:disabled {
  background: var(--c-disabled-btn);
  cursor: default;
}

.create-btn {
  margin-left: auto;
}

.batch-glyph {
  font-size: 14px;
}

.clear-btn {
  font-size: 13px;
  color: var(--c-text-muted);
}

/* ── table ───────────────────────────────────────────────────────────── */
.table-card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow-card);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
}

thead tr {
  background: var(--c-surface-thead);
  color: var(--c-text-thead);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

th {
  font-weight: 600;
  padding: 11px 6px;
}

.col-check {
  width: 34px;
  padding: 0 0 0 16px;
  vertical-align: middle;
}

th.col-check {
  padding: 11px 0 11px 16px;
}

.col-item {
  text-align: left;
  padding: 8px 12px;
}

.item-head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.search-box {
  display: flex;
  align-items: center;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 0 9px;
  height: 30px;
  width: 240px;
  text-transform: none;
}

.search-glyph {
  color: #9aa1bb;
  font-size: 13px;
}

.search-box input {
  border: none;
  background: none;
  padding: 0 7px;
  font-size: 12.5px;
  width: 100%;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--c-text-mid);
}

.col-stage {
  width: 88px;
  text-align: center;
}

.col-state {
  text-align: left;
  padding: 11px 14px;
  width: 150px;
}

.col-menu {
  width: 44px;
  padding: 11px 12px 11px 0;
  position: relative;
}

tbody tr {
  border-top: 1px solid var(--c-border-row);
  background: var(--c-surface);
  cursor: pointer;
  transition: background 0.12s;
}

tbody tr:hover {
  background: var(--c-primary-faint);
}

tbody tr.stopped {
  background: var(--c-danger-row);
}

tbody tr.stopped:hover {
  background: #fdeeec;
}

tbody tr.in-batch {
  background: #fbfcff;
}

input[type="checkbox"] {
  width: 15px;
  height: 15px;
  accent-color: var(--c-primary);
  cursor: pointer;
}

.lock {
  display: inline-flex;
  color: #b9bfd6;
}

.item-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 0;
}

.accent {
  width: 4px;
  align-self: stretch;
  border-radius: 3px;
  background: transparent;
}

.accent.stopped {
  background: var(--c-danger);
}

.accent.needs-reupload {
  background: var(--c-warn);
}

.accent.in-progress {
  background: var(--c-info);
}

.item-text {
  min-width: 0;
}

.item-title {
  font-weight: 600;
  color: var(--c-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-meta {
  font-size: 11.5px;
  color: var(--c-text-faint);
  font-family: var(--font-mono);
  display: flex;
  gap: 9px;
}

.backend-id {
  color: var(--c-primary);
}

.item-error {
  font-size: 11.5px;
  color: var(--c-danger-text);
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.err-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c-danger);
  flex: none;
}

.menu-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  color: #9aa1bb;
  font-size: 17px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
}

.menu-btn:hover {
  background: var(--c-idle-bg);
  color: var(--c-text-muted);
}

.row-menu {
  position: absolute;
  top: 40px;
  right: 12px;
  width: 210px;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  box-shadow: var(--shadow-menu);
  z-index: 25;
  padding: 5px;
  animation: fadein 0.12s;
}

.row-menu button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 9px 10px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--c-text-mid);
}

.row-menu button:hover {
  background: var(--c-primary-faint);
}

.row-menu svg {
  flex: none;
}

.empty {
  padding: 48px;
  text-align: center;
  color: var(--c-text-faint);
  font-size: 14px;
}
</style>
