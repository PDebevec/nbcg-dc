/**
 * Settings store — the persisted {@link AppConfig} (including the Keycloak
 * username) + the secret Keycloak password, and the single place that
 * (re)configures the Keycloak auth helper and the backend API client.
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
  normalizeConfig,
  summarizePassword,
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
  getKcPassword,
  setKcPassword,
  probeRoots,
  pickDirectory,
  getAppVersion,
} from "@services/config";
import { configureApiClient, createApiClient } from "@services/backend";
import { configureKeycloakAuth, getKeycloakAuth, KeycloakAuthError } from "@services/keycloakAuth";
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
  /** In-memory Keycloak password (needed to mint the access token + drive the
   * masked field). Persisted separately via the secure store, not in this
   * reactive object. The username lives in `config.kcUsername` — not a
   * secret, so it needs no parallel treatment. */
  const kcPassword = ref<string | null>(null);
  const loaded = ref(false);

  // ── draft state (what is in the Settings fields) ──────────────────────────
  const draft = ref<AppConfig>({ ...DEFAULT_CONFIG });
  /** Draft password. `null` means "unchanged"; `""` means "clear it". */
  const draftPassword = ref<string | null>(null);
  const saving = ref(false);
  /** Result of the last Test connection's credentials probe (Settings →
   * "Test connection"), alongside the existing reachability `testResult`. */
  const credentialsCheck = ref<{ ok: boolean; message: string } | null>(null);

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

  const hasCredentials = computed(() => Boolean(config.value.kcUsername && kcPassword.value));
  const configured = computed(() => isConfigured(config.value));

  /** The password as the field should show it — the draft if edited, else the
   * saved one. Masking is applied by {@link passwordDisplay}. */
  const effectivePassword = computed(() =>
    draftPassword.value === null ? (kcPassword.value ?? "") : draftPassword.value,
  );

  /** Masked, non-secret rendering for the password field. */
  const passwordDisplay = computed(() => summarizePassword(effectivePassword.value));

  /** Validation of the **draft** — what gates Save. */
  const validation = computed<ConfigValidation>(() =>
    validateConfig(draft.value, effectivePassword.value),
  );

  /** Whether the draft differs from what is saved (drives "unsaved changes"). */
  const dirty = computed(() => {
    if (draftPassword.value !== null && draftPassword.value !== (kcPassword.value ?? "")) {
      return true;
    }
    const a = normalizeConfig(draft.value);
    const b = normalizeConfig(config.value);
    return (
      ROOT_KEYS.some((key) => a[key] !== b[key]) ||
      a.backendBaseUrl !== b.backendBaseUrl ||
      a.apiPrefix !== b.apiPrefix ||
      a.keycloakUrl !== b.keycloakUrl ||
      a.kcUsername !== b.kcUsername ||
      a.theme !== b.theme ||
      a.dataPassingCollectionTypes.join(",") !==
        b.dataPassingCollectionTypes.join(",")
    );
  });

  const canSave = computed(() => dirty.value && validation.value.valid && !saving.value);

  /** (Re)build the Keycloak auth helper + API client from the current
   * **saved** config + password. */
  function applyClient(): void {
    configureKeycloakAuth({
      keycloakUrl: config.value.keycloakUrl,
      getCredentials: async () =>
        config.value.kcUsername && kcPassword.value
          ? { username: config.value.kcUsername, password: kcPassword.value }
          : null,
    });
    configureApiClient({
      baseUrl: config.value.backendBaseUrl,
      apiPrefix: config.value.apiPrefix,
      getToken: () => getKeycloakAuth().getValidAccessToken(),
    });
  }

  /** Reset the draft to the saved config, discarding edits. */
  function revert(): void {
    draft.value = { ...config.value };
    draftPassword.value = null;
    testResult.value = null;
    credentialsCheck.value = null;
  }

  /** Load persisted config + password and configure the client. Idempotent. */
  async function load(): Promise<void> {
    config.value = await loadConfig();
    kcPassword.value = await getKcPassword();
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

  /** Set (empty string clears) the Keycloak password and reconfigure the
   * client, discarding any cached access token so the change takes effect on
   * the very next request. */
  async function updatePassword(password: string): Promise<void> {
    await setKcPassword(password);
    kcPassword.value = password || null;
    draftPassword.value = null;
    applyClient();
    getKeycloakAuth().clearCache();
  }

  // ── the Settings form ─────────────────────────────────────────────────────

  /** Edit draft fields (no persistence, no client change). Covers
   * `kcUsername` too — it is a plain field, same as `backendBaseUrl`. */
  function editDraft(patch: Partial<AppConfig>): void {
    draft.value = { ...draft.value, ...patch };
  }

  /** Edit the draft password. Pass `""` to clear it on save. */
  function editPassword(password: string): void {
    draftPassword.value = password;
    credentialsCheck.value = null;
  }

  /**
   * Persist the draft, then switch the running app over in one step. Returns
   * whether it saved.
   *
   * **Both writes happen before either is committed to reactive state.** These
   * fields point the whole app at a backend, and `config` is what
   * `useConnection.host` / `useSync.host` display while `applyClient()` is what
   * the `ApiClient` actually requests. Committing the config as soon as it
   * persisted meant a failing password write left those two disagreeing — the
   * UI naming the new host, every call still going to the old one, and
   * `save()` returning `false` as if nothing had happened. Staging the commit
   * keeps the in-memory state coherent whatever fails: either the app moved
   * to the new backend or it did not.
   *
   * A partial write can still reach *disk* (config persisted, password not);
   * the next `load()` reconciles that, and the operator sees an
   * unsaved-looking form rather than a silently half-applied one.
   */
  async function save(): Promise<boolean> {
    if (!validation.value.valid) return false;
    saving.value = true;
    try {
      const savedConfig = await saveConfig(draft.value);
      const savedPassword = draftPassword.value;
      if (savedPassword !== null) await setKcPassword(savedPassword);

      // Both persisted — commit.
      config.value = savedConfig;
      if (savedPassword !== null) {
        kcPassword.value = savedPassword || null;
        draftPassword.value = null;
      }
      applyClient();
      if (savedPassword !== null) getKeycloakAuth().clearCache();
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
   * `/api/health` itself needs no token (docs/PROJECT-KNOWLEDGE §3), but when
   * the effective username/password are both filled in this also does a
   * one-off Keycloak mint against them — closing the "no token probe" gap
   * (docs/tasks/10-settings-and-naming.md) by surfacing a bad password right
   * here instead of on the first real upload.
   */
  async function testConnection(): Promise<ReachabilityResult | null> {
    if (validation.value.errors.backendBaseUrl) return null;
    testing.value = true;
    try {
      const { backendBaseUrl: baseUrl, apiPrefix } = normalizeConfig(draft.value);
      const client = createApiClient({ baseUrl, apiPrefix });
      const result = await checkConnection(client, { baseUrl });
      testResult.value = result;
      await probeCredentials();
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

  /** The credentials half of {@link testConnection} — a cache-bypassing
   * one-off mint against the draft username + effective password. Skips
   * silently when either is blank; that is a legitimate, if limited,
   * configuration, not a failed check. */
  async function probeCredentials(): Promise<void> {
    const username = draft.value.kcUsername.trim();
    const password = effectivePassword.value;
    if (!username || !password) {
      credentialsCheck.value = null;
      return;
    }
    try {
      await getKeycloakAuth().mintOnce(username, password);
      credentialsCheck.value = { ok: true, message: "Keycloak login succeeded." };
    } catch (err) {
      const message =
        err instanceof KeycloakAuthError
          ? err.message
          : `Could not verify credentials: ${(err as Error)?.message ?? err}`;
      credentialsCheck.value = { ok: false, message };
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
    kcPassword,
    loaded,
    hasCredentials,
    configured,
    // draft / form
    draft,
    draftPassword,
    dirty,
    canSave,
    saving,
    validation,
    passwordDisplay,
    editDraft,
    editPassword,
    save,
    revert,
    // roots
    roots,
    refreshRootStatuses,
    browseForRoot,
    // connection
    testing,
    testResult,
    credentialsCheck,
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
    updatePassword,
  };
});
