/**
 * `useSettingsScreen` (Epic 01/04/08) — the view-model the **Settings** screen
 * binds to (Seam 1: Presentation ↔ Application). `SettingsView.vue` imports
 * only this; it never touches the store, services, or IPC directly.
 *
 * Configure tab: folder roots (browse + validity), backend connection (draft
 * API URL + Keycloak URL/username/password, Test connection against the
 * draft — which also validates the credentials, not just reachability),
 * theme, schema refresh, app version, Save/Revert. Data tab: the fixed
 * folder-derived naming convention, shown read-only for reference (docs/01 —
 * the prototype's naming picker was dropped).
 */

import { computed, getCurrentInstance, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useSettingsStore } from "@stores/useSettings";
import { useToastsStore } from "@stores/useToasts";
import {
  describeRootValidity,
  ROOT_KEYS,
  type RootKey,
  type ThemePreference,
} from "@domain/config";
import { derivedOutputNames, pageNames } from "@domain/naming";

/** One folder-root row on the Configure tab. */
export interface RootRowView {
  key: RootKey;
  label: string;
  /** Draft path shown in the field ('' = not set). */
  path: string;
  /** Validity of the **saved** path ("Valid" / "Not set" / …). */
  statusLabel: string;
  valid: boolean;
}

const ROOT_LABELS: Record<RootKey, string> = {
  unprocessedRoot: "/unprocessed root (new scans arrive here)",
  processedRoot: "/processed root (finished items moved here)",
};

/** Sample folder name driving the Data tab's read-only naming preview. */
const NAMING_SAMPLE_BASE = "njegos_gorski_vijenac";

export function useSettingsScreen() {
  const store = useSettingsStore();
  const toasts = useToastsStore();
  const {
    draft,
    draftPassword,
    dirty,
    canSave,
    saving,
    validation,
    passwordDisplay,
    roots,
    testing,
    testResult,
    credentialsCheck,
    refreshingSchema,
    appVersion,
  } = storeToRefs(store);

  const passwordShown = ref(false);

  const folderRows = computed<RootRowView[]>(() =>
    ROOT_KEYS.map((key) => {
      const status = roots.value[key];
      return {
        key,
        label: ROOT_LABELS[key],
        path: draft.value[key] ?? "",
        statusLabel: describeRootValidity(status.validity),
        valid: status.validity === "valid",
      };
    }),
  );

  const apiUrl = computed(() => draft.value.backendBaseUrl);
  const apiUrlError = computed(() => validation.value.errors.backendBaseUrl ?? null);
  const keycloakUrl = computed(() => draft.value.keycloakUrl);
  const keycloakUrlError = computed(() => validation.value.errors.keycloakUrl ?? null);
  const username = computed(() => draft.value.kcUsername);
  const theme = computed(() => draft.value.theme);

  /** The password field's editable value — always the draft, so typing works
   * whether or not it is revealed (the view masks it with type=password). */
  const passwordValue = computed(() => draftPassword.value ?? "");

  /** Masked summary of the currently effective password, shown as the
   * field's placeholder when no draft edit is pending. */
  const passwordPlaceholder = computed(() =>
    passwordDisplay.value.present ? passwordDisplay.value.masked : "enter the Keycloak password",
  );

  const testMessage = computed(() => testResult.value?.message ?? null);
  const testOk = computed(() => testResult.value?.reachable ?? false);
  const credentialsCheckMessage = computed(() => credentialsCheck.value?.message ?? null);
  const credentialsCheckOk = computed(() => credentialsCheck.value?.ok ?? null);

  /** Raw text of the data-passing types field while it is being edited (so a
   * trailing comma survives typing); null = show the parsed draft. */
  const dataPassingRaw = ref<string | null>(null);

  /** Comma-separated `collectionType` numbers whose parents may pass data. */
  const dataPassingTypes = computed(
    () => dataPassingRaw.value ?? draft.value.dataPassingCollectionTypes.join(", "),
  );

  function parseDataPassingTypes(raw: string): number[] {
    const list = raw
      .split(/[,\s;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0);
    return Array.from(new Set(list));
  }

  function setDataPassingTypes(raw: string): void {
    dataPassingRaw.value = raw;
    store.editDraft({ dataPassingCollectionTypes: parseDataPassingTypes(raw) });
  }

  /** Normalise the field once editing ends (blur). */
  function commitDataPassingTypes(): void {
    dataPassingRaw.value = null;
  }

  // ── actions ──────────────────────────────────────────────────────────────

  function setApiUrl(value: string): void {
    store.editDraft({ backendBaseUrl: value });
  }

  function setKeycloakUrl(value: string): void {
    store.editDraft({ keycloakUrl: value });
  }

  function setUsername(value: string): void {
    store.editDraft({ kcUsername: value });
  }

  function setPassword(value: string): void {
    store.editPassword(value);
  }

  function togglePassword(): void {
    passwordShown.value = !passwordShown.value;
  }

  async function browse(key: RootKey): Promise<void> {
    await store.browseForRoot(key);
  }

  async function setTheme(value: ThemePreference): Promise<void> {
    await store.setTheme(value);
  }

  async function testConnection(): Promise<void> {
    await store.testConnection();
  }

  async function save(): Promise<void> {
    const ok = await store.save();
    if (ok) {
      toasts.push("Settings saved.", "success");
      await store.refreshRootStatuses();
    } else if (!validation.value.valid) {
      toasts.push("Fix the highlighted fields before saving.", "warning");
    } else {
      toasts.push("Couldn't save settings.", "error");
    }
  }

  async function refreshSchema(): Promise<void> {
    const result = await store.refreshSchema();
    if (result) toasts.push("Metadata schema refreshed.", "success");
    else toasts.push("Couldn't refresh the schema.", "error");
  }

  // ── Data tab (fixed naming convention, read-only) ────────────────────────

  const namingSampleFolder = NAMING_SAMPLE_BASE;
  const namingOutputs = computed(() => {
    const names = derivedOutputNames(NAMING_SAMPLE_BASE);
    return [
      { name: names["archival-pdf"], role: "archival master · kept local" },
      { name: names["web-pdf"], role: "web PDF · uploaded" },
      { name: names["thumbnail"], role: "thumbnail · uploaded" },
      { name: names["ocr-text"], role: "full text · uploaded" },
      { name: names["metadata"], role: "metadata mirror · local" },
    ];
  });
  const namingPagePreview = computed(() => {
    const [p1, p2] = pageNames(NAMING_SAMPLE_BASE, 2, "pdf");
    return [p1, p2, `${NAMING_SAMPLE_BASE}_10.pdf`];
  });

  async function init(): Promise<void> {
    await store.refreshRootStatuses();
  }

  if (getCurrentInstance()) onMounted(init);

  return {
    // configure
    folderRows,
    browse,
    apiUrl,
    apiUrlError,
    setApiUrl,
    keycloakUrl,
    keycloakUrlError,
    setKeycloakUrl,
    username,
    setUsername,
    passwordValue,
    passwordPlaceholder,
    passwordShown,
    togglePassword,
    setPassword,
    theme,
    setTheme,
    dataPassingTypes,
    setDataPassingTypes,
    commitDataPassingTypes,
    testing,
    testMessage,
    testOk,
    credentialsCheckMessage,
    credentialsCheckOk,
    testConnection,
    dirty,
    canSave,
    saving,
    save,
    revert: store.revert,
    refreshingSchema,
    refreshSchema,
    appVersion,
    // data tab
    namingSampleFolder,
    namingOutputs,
    namingPagePreview,
  };
}
