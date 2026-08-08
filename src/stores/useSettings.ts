/**
 * Settings store — the persisted {@link AppConfig} + the secret API token, and
 * the single place that (re)configures the backend API client.
 *
 * The GUI binds this via a composable; it never talks to `services/config` or
 * the client directly.
 *
 * ## Saved vs. draft (Epic 10)
 *
 * The Settings screen is a **form with an explicit Save**, so this store keeps
 * two copies: `config` (what is persisted and what the app runs on) and `draft`
 * (what is in the fields). Nothing the operator types affects the running app
 * until {@link save} succeeds — which matters because these fields point the
 * whole app at a backend: live-applying a half-typed URL would break every other
 * screen mid-edit, and Test connection has to probe the draft *without*
 * repointing the app at an unverified host (hence `createApiClient`).
 *
 * `update()` remains for callers that legitimately change one setting outright
 * (the theme toggle, a first-run wizard) and want it applied immediately.
 */

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
  DEFAULT_CONFIG,
  ROOT_KEYS,
  isConfigured,
  normalizeApiToken,
  normalizeConfig,
  summarizeToken,
  validateConfig,
  type AppConfig,
  type ConfigValidation,
  type RootKey,
  type RootStatus,
  type ThemePreference,
} from "@domain/config";
import type { ReachabilityResult } from "@domain/connection";
import {
  loadConfig,
  saveConfig,
  getApiToken,
  setApiToken,
  probeRoots,
  pickDirectory,
  getAppVersion,
} from "@services/config";
import { configureApiClient, createApiClient } from "@services/backend";
import {
  checkConnection,
  refreshRecordSchema,
  recordSchemaCacheInfo,
  type SchemaCacheInfo,
  type SchemaRefreshResult,
} from "@services/api";
import { APP_VERSION } from "@app/config";
import { logger } from "@lib/logger";

/** Roots start unprobed; a probe resolves each to valid/invalid/not-set. */
function initialRootStatuses(config: AppConfig): Record<RootKey, RootStatus> {
  return {
    unprocessedRoot: {
      key: "unprocessedRoot",
      path: config.unprocessedRoot,
      validity: "unknown",
    },
    processedRoot: {
      key: "processedRoot",
      path: config.processedRoot,
      validity: "unknown",
    },
  };
}

export const useSettingsStore = defineStore("settings", () => {
  // ── saved state (what the app runs on) ────────────────────────────────────
  const config = ref<AppConfig>({ ...DEFAULT_CONFIG });
  /** In-memory token (needed to build the client + drive the masked field).
   * Persisted separately via the secure store, not in this reactive object. */
  const apiToken = ref<string | null>(null);
  const loaded = ref(false);

  // ── draft state (what is in the Settings fields) ──────────────────────────
  const draft = ref<AppConfig>({ ...DEFAULT_CONFIG });
  /** Draft token. `null` means "unchanged"; `""` means "clear it". */
  const draftToken = ref<string | null>(null);
  const saving = ref(false);

  // ── ancillary state ───────────────────────────────────────────────────────
  const roots = ref<Record<RootKey, RootStatus>>(
    initialRootStatuses(DEFAULT_CONFIG),
  );
  const appVersion = ref(APP_VERSION);
  const testResult = ref<ReachabilityResult | null>(null);
  const testing = ref(false);
  const schemaCache = ref<SchemaCacheInfo[]>(recordSchemaCacheInfo());
  const refreshingSchema = ref(false);
  const schemaRefresh = ref<SchemaRefreshResult | null>(null);

  const hasToken = computed(() => Boolean(apiToken.value));
  const configured = computed(() => isConfigured(config.value));

  /** The token as the field should show it — the draft if edited, else the saved
   * one. Masking is applied by {@link tokenDisplay}. */
  const effectiveToken = computed(() =>
    draftToken.value === null ? (apiToken.value ?? "") : draftToken.value,
  );

  /** Masked, non-secret rendering + shape facts for the token field. */
  const tokenDisplay = computed(() => summarizeToken(effectiveToken.value));

  /** Validation of the **draft** — what gates Save. */
  const validation = computed<ConfigValidation>(() =>
    validateConfig(draft.value, effectiveToken.value),
  );

  /** Whether the draft differs from what is saved (drives "unsaved changes"). */
  const dirty = computed(() => {
    if (draftToken.value !== null && draftToken.value !== (apiToken.value ?? "")) {
      return true;
    }
    const a = normalizeConfig(draft.value);
    const b = normalizeConfig(config.value);
    return (
      ROOT_KEYS.some((key) => a[key] !== b[key]) ||
      a.backendBaseUrl !== b.backendBaseUrl ||
      a.apiPrefix !== b.apiPrefix ||
      a.theme !== b.theme ||
      a.dataPassingCollectionTypes.join(",") !==
        b.dataPassingCollectionTypes.join(",")
    );
  });

  const canSave = computed(() => dirty.value && validation.value.valid && !saving.value);

  /** (Re)build the API client from the current **saved** config + token. */
  function applyClient(): void {
    configureApiClient({
      baseUrl: config.value.backendBaseUrl,
      apiPrefix: config.value.apiPrefix,
      getToken: () => apiToken.value,
    });
  }

  /** Reset the draft to the saved config, discarding edits. */
  function revert(): void {
    draft.value = { ...config.value };
    draftToken.value = null;
    testResult.value = null;
  }

  /** Load persisted config + token and configure the client. Idempotent. */
  async function load(): Promise<void> {
    config.value = await loadConfig();
    apiToken.value = await getApiToken();
    applyClient();
    revert();
    roots.value = initialRootStatuses(config.value);
    loaded.value = true;
    // Both are best-effort display facts — neither should fail `load()` and stall
    // boot, so they run detached with their own error handling.
    void refreshRootStatuses();
    void loadAppVersion();
  }

  async function loadAppVersion(): Promise<void> {
    appVersion.value = await getAppVersion();
  }

  /** Persist a partial config change (write-through) and reconfigure. For
   * single-setting changes applied immediately; the Settings form uses
   * {@link editDraft} + {@link save}. */
  async function update(patch: Partial<AppConfig>): Promise<void> {
    // Read `dirty` BEFORE the write — afterwards an untouched draft would look
    // dirty precisely *because* the saved config moved under it.
    const hadEdits = dirty.value;
    config.value = await saveConfig({ ...config.value, ...patch });
    applyClient();
    // Keep an untouched draft in step, so opening Settings after a theme toggle
    // does not show the change as an unsaved edit.
    if (!hadEdits) draft.value = { ...config.value };
  }

  async function setTheme(theme: ThemePreference): Promise<void> {
    await update({ theme });
    // The theme control applies immediately even mid-edit, so mirror it into a
    // dirty draft too rather than leaving the form showing the old value.
    editDraft({ theme });
  }

  /** Set (empty string clears) the API token and reconfigure the client. */
  async function updateToken(token: string): Promise<void> {
    const normalized = normalizeApiToken(token);
    await setApiToken(normalized);
    apiToken.value = normalized || null;
    draftToken.value = null;
    applyClient();
  }

  // ── the Settings form ─────────────────────────────────────────────────────

  /** Edit draft fields (no persistence, no client change). */
  function editDraft(patch: Partial<AppConfig>): void {
    draft.value = { ...draft.value, ...patch };
  }

  /** Edit the draft token. Pass `""` to clear it on save. */
  function editToken(token: string): void {
    draftToken.value = normalizeApiToken(token);
  }

  /**
   * Persist the draft, then switch the running app over in one step. Returns
   * whether it saved.
   *
   * **Both writes happen before either is committed to reactive state.** These
   * fields point the whole app at a backend, and `config` is what
   * `useConnection.host` / `useSync.host` display while `applyClient()` is what
   * the `ApiClient` actually requests. Committing the config as soon as it
   * persisted meant a failing token write left those two disagreeing — the UI
   * naming the new host, every call still going to the old one, and `save()`
   * returning `false` as if nothing had happened. Staging the commit keeps the
   * in-memory state coherent whatever fails: either the app moved to the new
   * backend or it did not.
   *
   * A partial write can still reach *disk* (config persisted, token not); the
   * next `load()` reconciles that, and the operator sees an unsaved-looking form
   * rather than a silently half-applied one.
   */
  async function save(): Promise<boolean> {
    if (!validation.value.valid) return false;
    saving.value = true;
    try {
      const savedConfig = await saveConfig(draft.value);
      const savedToken = draftToken.value;
      if (savedToken !== null) await setApiToken(savedToken);

      // Both persisted — commit.
      config.value = savedConfig;
      if (savedToken !== null) {
        apiToken.value = savedToken || null;
        draftToken.value = null;
      }
      applyClient();
      draft.value = { ...config.value };
      await refreshRootStatuses();
      return true;
    } catch (err) {
      logger.error("settings", "Failed to save settings.", err);
      return false;
    } finally {
      saving.value = false;
    }
  }

  // ── folder roots ──────────────────────────────────────────────────────────

  /** Re-probe both **saved** roots' validity. */
  async function refreshRootStatuses(): Promise<void> {
    try {
      roots.value = await probeRoots(config.value);
    } catch (err) {
      logger.warn("settings", "Could not probe the configured roots.", err);
    }
  }

  /**
   * Open the folder picker for a root and put the result in the draft. Returns
   * the chosen path, or null when cancelled/unavailable.
   */
  async function browseForRoot(key: RootKey): Promise<string | null> {
    const title =
      key === "unprocessedRoot"
        ? "Choose the folder of incoming scans"
        : "Choose the folder for processed items";
    const path = await pickDirectory(title);
    if (path) editDraft({ [key]: path } as Partial<AppConfig>);
    return path;
  }

  // ── Test connection ───────────────────────────────────────────────────────

  /**
   * Probe reachability for the **draft** connection settings using a throwaway
   * client, so testing an unsaved URL never repoints the running app at it.
   * Reachability only — no token/identity verification (docs/PROJECT-KNOWLEDGE §3).
   */
  async function testConnection(): Promise<ReachabilityResult | null> {
    if (validation.value.errors.backendBaseUrl) return null;
    testing.value = true;
    try {
      const { backendBaseUrl: baseUrl, apiPrefix } = normalizeConfig(draft.value);
      const client = createApiClient({
        baseUrl,
        apiPrefix,
        getToken: () => effectiveToken.value || null,
      });
      const result = await checkConnection(client, { baseUrl });
      testResult.value = result;
      return result;
    } catch (err) {
      // checkConnection never throws, so this is a programming error, not a
      // failed probe — don't dress it up as "unreachable".
      logger.error("settings", "Test connection failed unexpectedly.", err);
      return null;
    } finally {
      testing.value = false;
    }
  }

  // ── Refresh metadata schema ───────────────────────────────────────────────

  /** Re-fetch the record schema for both levels and update the cache display. */
  async function refreshSchema(): Promise<SchemaRefreshResult | null> {
    refreshingSchema.value = true;
    try {
      const result = await refreshRecordSchema();
      schemaRefresh.value = result;
      schemaCache.value = result.levels;
      return result;
    } catch (err) {
      logger.error("settings", "Schema refresh failed unexpectedly.", err);
      return null;
    } finally {
      refreshingSchema.value = false;
    }
  }

  return {
    // saved
    config,
    apiToken,
    loaded,
    hasToken,
    configured,
    // draft / form
    draft,
    draftToken,
    dirty,
    canSave,
    saving,
    validation,
    tokenDisplay,
    editDraft,
    editToken,
    save,
    revert,
    // roots
    roots,
    refreshRootStatuses,
    browseForRoot,
    // connection
    testing,
    testResult,
    testConnection,
    // schema
    schemaCache,
    schemaRefresh,
    refreshingSchema,
    refreshSchema,
    // misc
    appVersion,
    load,
    update,
    setTheme,
    updateToken,
  };
});
