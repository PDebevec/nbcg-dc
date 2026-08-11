<script setup lang="ts">
import { ref } from "vue";
import { useSettingsScreen } from "@composables/useSettingsScreen";
import SegmentedControl from "../components/common/SegmentedControl.vue";
import type { ThemePreference } from "@domain/config";

const {
  folderRows,
  browse,
  apiUrl,
  apiUrlError,
  setApiUrl,
  tokenValue,
  tokenShown,
  toggleToken,
  setToken,
  theme,
  setTheme,
  testing,
  testMessage,
  testOk,
  testConnection,
  canSave,
  saving,
  save,
  refreshingSchema,
  refreshSchema,
  appVersion,
  namingSampleFolder,
  namingOutputs,
  namingPagePreview,
} = useSettingsScreen();

const tab = ref<"configure" | "data">("configure");

const themeOptions = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];
</script>

<template>
  <div class="screen">
    <div class="tab-track">
      <button
        class="tab"
        :class="{ active: tab === 'configure' }"
        @click="tab = 'configure'"
      >
        Configure
      </button>
      <button
        class="tab"
        :class="{ active: tab === 'data' }"
        @click="tab = 'data'"
      >
        Data
      </button>
    </div>

    <!-- ── CONFIGURE ─────────────────────────────────────────────────── -->
    <template v-if="tab === 'configure'">
      <div class="card">
        <div class="card-title">Folder locations</div>
        <div class="card-desc">
          Where scans arrive and where finished items are moved.
        </div>
        <div v-for="row in folderRows" :key="row.key" class="folder-row">
          <label>{{ row.label }}</label>
          <div class="folder-line">
            <div class="path" :class="{ unset: !row.path }">
              {{ row.path || "Not set" }}
            </div>
            <button class="btn-secondary" @click="browse(row.key)">
              Browse…
            </button>
            <span class="root-status" :class="{ valid: row.valid }">
              <span class="status-dot" />{{ row.statusLabel }}
            </span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Backend connection</div>
        <div class="field">
          <label>API base URL</label>
          <input
            class="mono-input"
            :value="apiUrl"
            placeholder="https://api.nbcg.me"
            @input="setApiUrl(($event.target as HTMLInputElement).value)"
          />
          <div v-if="apiUrlError" class="field-error">{{ apiUrlError }}</div>
        </div>
        <div class="field">
          <label>API access token</label>
          <div class="token-line">
            <div class="token-box">
              <input
                class="mono-input bare"
                :value="tokenValue"
                :readonly="!tokenShown"
                placeholder="paste the access token"
                @input="setToken(($event.target as HTMLInputElement).value)"
              />
              <button class="token-toggle" @click="toggleToken()">
                {{ tokenShown ? "Hide" : "Show" }}
              </button>
            </div>
          </div>
          <div class="field-hint">
            Stored as a secret. Never shown in plain text by default.
          </div>
        </div>
        <div class="test-line">
          <button class="btn-outline" :disabled="testing" @click="testConnection()">
            {{ testing ? "Testing…" : "Test connection" }}
          </button>
          <span
            v-if="testMessage"
            class="test-result"
            :class="{ ok: testOk, fail: !testOk }"
          >
            {{ testOk ? "✓" : "✗" }} {{ testMessage }}
          </span>
        </div>
      </div>

      <div class="card">
        <div class="pref-row">
          <span class="pref-label">Theme</span>
          <div class="theme-seg">
            <SegmentedControl
              :options="themeOptions"
              :model-value="theme"
              @update:model-value="setTheme($event as ThemePreference)"
            />
          </div>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-label">Metadata schema</div>
            <div class="pref-sub">Field definitions from the backend</div>
          </div>
          <button
            class="btn-secondary"
            :disabled="refreshingSchema"
            @click="refreshSchema()"
          >
            {{ refreshingSchema ? "Refreshing…" : "↻ Refresh schema" }}
          </button>
        </div>
        <div class="pref-row last">
          <span class="pref-label">App version</span>
          <span class="version">NBCG Archive {{ appVersion }} · Tauri</span>
        </div>
      </div>

      <div class="actions">
        <button
          class="btn-primary"
          :disabled="!canSave"
          @click="save()"
        >
          {{ saving ? "Saving…" : "Save settings" }}
        </button>
      </div>
    </template>

    <!-- ── DATA ──────────────────────────────────────────────────────── -->
    <template v-else>
      <div class="naming-banner">
        <b>Naming is derived from the folder name</b> — the scanner's folder is
        the base name for every generated file. Fixed to keep the archive
        consistent; shown here for reference, not for editing.
      </div>

      <div class="card">
        <div class="card-title">Derived file names</div>
        <div class="card-desc">
          A folder named
          <span class="mono accent">{{ namingSampleFolder }}</span> produces:
        </div>
        <div class="naming-list">
          <div v-for="out in namingOutputs" :key="out.name" class="naming-row">
            <span class="mono naming-name">{{ out.name }}</span>
            <span class="naming-role">{{ out.role }}</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Multi-page numbering</div>
        <div class="card-desc">
          Items with several scanned pages append a running page number after an
          underscore — <b>_1, _2, … _10</b>. Numbers are not padded. This is
          fixed.
        </div>
        <div class="preview-box">
          <span class="preview-label">Preview</span>
          <div class="preview-chips">
            <span v-for="name in namingPagePreview" :key="name" class="chip mono">
              {{ name }}
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.screen {
  padding: 22px 26px 48px;
  max-width: 720px;
  margin: 0 auto;
}

.tab-track {
  display: flex;
  gap: 4px;
  background: var(--c-surface-seg);
  padding: 4px;
  border-radius: 10px;
  margin-bottom: 18px;
  width: fit-content;
}

.tab {
  padding: 7px 16px;
  border-radius: var(--r-sm);
  font-size: 13px;
  font-weight: 500;
  color: var(--c-text-muted);
}

.tab.active {
  font-weight: 600;
  color: var(--c-primary);
  background: var(--c-surface);
}

.card {
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-xl);
  padding: 18px 20px;
  margin-bottom: 16px;
}

.card-title {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 2px;
}

.card-desc {
  font-size: 12.5px;
  color: var(--c-text-faint);
  margin-bottom: 14px;
}

/* ── folders ────────────────────────────────────────────────────────── */
.folder-row {
  margin-bottom: 14px;
}

.folder-row label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--c-text-label);
  display: block;
  margin-bottom: 6px;
}

.folder-line {
  display: flex;
  gap: 9px;
  align-items: center;
}

.path {
  flex: 1;
  height: 39px;
  border: 1.5px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-input);
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--c-text-mid);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.path.unset {
  color: var(--c-text-dim);
}

.root-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 110px;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-warn);
}

.root-status.valid {
  color: var(--c-success);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

/* ── fields ─────────────────────────────────────────────────────────── */
.field {
  margin-bottom: 14px;
}

.field label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--c-text-label);
  display: block;
  margin-bottom: 6px;
}

.mono-input {
  width: 100%;
  height: 39px;
  border: 1.5px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-input);
  padding: 0 12px;
  font-family: var(--font-mono);
  font-size: 13px;
}

.mono-input.bare {
  border: none;
  background: none;
  padding: 0;
  height: auto;
}

.field-error {
  font-size: 12px;
  color: var(--c-danger);
  margin-top: 6px;
  font-weight: 500;
}

.field-hint {
  font-size: 11.5px;
  color: var(--c-text-dim);
  margin-top: 6px;
}

.token-line {
  display: flex;
  gap: 9px;
}

.token-box {
  flex: 1;
  display: flex;
  align-items: center;
  height: 39px;
  border: 1.5px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-input);
  padding: 0 12px;
}

.token-toggle {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-primary);
  padding: 0 4px;
  white-space: nowrap;
}

.test-line {
  display: flex;
  align-items: center;
  gap: 12px;
}

.test-result {
  font-size: 12.5px;
  font-weight: 600;
}

.test-result.ok {
  color: var(--c-success);
}

.test-result.fail {
  color: var(--c-danger);
}

/* ── prefs ──────────────────────────────────────────────────────────── */
.pref-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid #f2f3f8;
}

.pref-row.last {
  border-bottom: none;
  padding-bottom: 4px;
}

.pref-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text-label);
}

.pref-sub {
  font-size: 11.5px;
  color: var(--c-text-faint);
}

.theme-seg {
  width: 230px;
}

.version {
  font-size: 12.5px;
  color: var(--c-text-faint);
  font-family: var(--font-mono);
}

/* ── buttons ────────────────────────────────────────────────────────── */
.btn-primary {
  height: 42px;
  padding: 0 26px;
  border-radius: 10px;
  background: var(--c-primary);
  color: #fff;
  font-weight: 600;
  font-size: 14px;
}

.btn-primary:disabled {
  background: var(--c-disabled-btn);
  cursor: default;
}

.btn-secondary {
  height: 39px;
  padding: 0 15px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-border);
  background: var(--c-surface);
  font-weight: 600;
  font-size: 13px;
  color: var(--c-text-label);
  white-space: nowrap;
}

.btn-outline {
  height: 39px;
  padding: 0 16px;
  border-radius: var(--r-md);
  border: 1px solid var(--c-primary-soft-border);
  background: var(--c-primary-faint);
  color: var(--c-primary);
  font-weight: 600;
  font-size: 13px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

/* ── data tab ───────────────────────────────────────────────────────── */
.naming-banner {
  background: var(--c-primary-soft);
  border: 1px solid var(--c-primary-soft-border);
  border-radius: var(--r-lg);
  padding: 12px 15px;
  margin-bottom: 18px;
  color: var(--c-primary);
  font-size: 13px;
  line-height: 1.5;
}

.mono {
  font-family: var(--font-mono);
}

.accent {
  color: var(--c-primary);
}

.naming-list {
  display: flex;
  flex-direction: column;
}

.naming-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 2px;
  border-top: 1px solid #f2f3f8;
}

.naming-name {
  font-size: 13px;
  color: var(--c-primary);
  font-weight: 600;
  min-width: 300px;
}

.naming-role {
  font-size: 12px;
  color: var(--c-text-faint);
}

.preview-box {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #f6f8ff;
  border: 1px solid #e2e7fb;
  border-radius: 10px;
  padding: 12px 14px;
}

.preview-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #8791c0;
  flex: none;
}

.preview-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  font-size: 12.5px;
  color: var(--c-primary);
  background: var(--c-surface);
  border: 1px solid #dde3fb;
  border-radius: var(--r-sm);
  padding: 4px 9px;
}
</style>
