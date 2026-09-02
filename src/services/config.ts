/**
 * Config accessor (Seam-3-adjacent application service).
 *
 * Persists non-secret {@link AppConfig} (including the Keycloak username —
 * not a secret) and the secret Keycloak password. In production these go
 * through the native secure store (`ipc.config.*`, owned by `core/config` in
 * the Arch lane). Until those commands exist — and when running outside
 * Tauri (plain `vite`) — it transparently falls back to `localStorage` so
 * the logic lane is independently runnable and testable.
 *
 * SECURITY: the `localStorage` fallback stores the password in plain text
 * and is DEV-ONLY. The real deployment must run under Tauri with the secure
 * store, so the password never touches the webview persistence layer.
 */

import {
  DEFAULT_CONFIG,
  ROOT_KEYS,
  normalizeConfig,
  type AppConfig,
  type RootKey,
  type RootStatus,
  type RootValidity,
} from "@domain/config";
import { ipc, isTauri, KC_PASSWORD_SECRET_KEY } from "@ipc/bindings";
import { APP_VERSION } from "@app/config";
import { logger } from "@lib/logger";

const CONFIG_LS_KEY = "nbcg-dc.config";
const PASSWORD_LS_KEY = `nbcg-dc.secret.${KC_PASSWORD_SECRET_KEY}`;

interface ConfigStore {
  loadConfig(): Promise<Partial<AppConfig> | null>;
  saveConfig(config: AppConfig): Promise<void>;
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  clearPassword(): Promise<void>;
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

/** Dev / non-Tauri fallback. Plain-text; not for production secrets. */
const localStore: ConfigStore = {
  async loadConfig() {
    if (!hasLocalStorage()) return null;
    const raw = localStorage.getItem(CONFIG_LS_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Partial<AppConfig>;
    } catch {
      logger.warn("config", "Corrupt local config; ignoring.");
      return null;
    }
  },
  async saveConfig(config) {
    if (!hasLocalStorage()) return;
    localStorage.setItem(CONFIG_LS_KEY, JSON.stringify(config));
  },
  async getPassword() {
    if (!hasLocalStorage()) return null;
    return localStorage.getItem(PASSWORD_LS_KEY);
  },
  async setPassword(password) {
    if (!hasLocalStorage()) return;
    localStorage.setItem(PASSWORD_LS_KEY, password);
  },
  async clearPassword() {
    if (!hasLocalStorage()) return;
    localStorage.removeItem(PASSWORD_LS_KEY);
  },
};

/** Production store via the native secure store, with automatic fallback to
 * {@link localStore} if an IPC command is missing or fails (e.g. before the
 * Arch lane has implemented it). Falls back per-operation and logs once. */
const tauriStore: ConfigStore = {
  async loadConfig() {
    try {
      return await ipc.config.load();
    } catch (err) {
      logger.warn("config", "config_load unavailable; using local fallback.", err);
      return localStore.loadConfig();
    }
  },
  async saveConfig(config) {
    try {
      await ipc.config.save(config);
    } catch (err) {
      logger.warn("config", "config_save unavailable; using local fallback.", err);
      await localStore.saveConfig(config);
    }
  },
  async getPassword() {
    try {
      return await ipc.config.getSecret(KC_PASSWORD_SECRET_KEY);
    } catch (err) {
      logger.warn("config", "config_get_secret unavailable; using local fallback.", err);
      return localStore.getPassword();
    }
  },
  async setPassword(password) {
    try {
      await ipc.config.setSecret(KC_PASSWORD_SECRET_KEY, password);
    } catch (err) {
      logger.warn("config", "config_set_secret unavailable; using local fallback.", err);
      await localStore.setPassword(password);
    }
  },
  async clearPassword() {
    try {
      await ipc.config.deleteSecret(KC_PASSWORD_SECRET_KEY);
    } catch (err) {
      logger.warn("config", "config_delete_secret unavailable; using local fallback.", err);
      await localStore.clearPassword();
    }
  },
};

const store: ConfigStore = isTauri() ? tauriStore : localStore;

/** Load persisted config merged over defaults (always returns a full object). */
export async function loadConfig(): Promise<AppConfig> {
  const persisted = await store.loadConfig();
  return { ...DEFAULT_CONFIG, ...(persisted ?? {}) };
}

/** Persist non-secret config, canonicalising the URL fields first so what is
 * stored is always the same string the client will request. */
export async function saveConfig(config: AppConfig): Promise<AppConfig> {
  const normalized = normalizeConfig(config);
  await store.saveConfig(normalized);
  return normalized;
}

/** Read the Keycloak password (secret; the username is a plain `AppConfig`
 * field, persisted by {@link saveConfig} like any other setting). */
export function getKcPassword(): Promise<string | null> {
  return store.getPassword();
}

/** Set (or, with an empty string, clear) the Keycloak password. */
export async function setKcPassword(password: string): Promise<void> {
  if (password) await store.setPassword(password);
  else await store.clearPassword();
}

// ─── folder roots (Epic 10 §Configure → Folder locations) ────────────────────

/**
 * Resolve a configured root's {@link RootValidity} against the filesystem.
 *
 * Unset → `not-set`. Otherwise `ipc.fs.pathExists` decides. When the IPC command
 * is unavailable (a plain `vite` session, or before the Arch lane implements it)
 * the answer is `unknown` rather than `invalid`: we genuinely cannot tell, and
 * flagging a perfectly good path as broken would be worse than admitting it.
 */
export async function probeRoot(path: string | null): Promise<RootValidity> {
  if (!path?.trim()) return "not-set";
  try {
    return (await ipc.fs.pathExists(path)) ? "valid" : "invalid";
  } catch (err) {
    logger.warn("config", "fs_path_exists unavailable; root validity unknown.", err);
    return "unknown";
  }
}

/** Resolve both roots' statuses in parallel (Settings shows one per row). */
export async function probeRoots(
  config: Pick<AppConfig, RootKey>,
): Promise<Record<RootKey, RootStatus>> {
  const entries = await Promise.all(
    ROOT_KEYS.map(async (key): Promise<[RootKey, RootStatus]> => {
      const path = config[key];
      return [key, { key, path, validity: await probeRoot(path) }];
    }),
  );
  return Object.fromEntries(entries) as Record<RootKey, RootStatus>;
}

/**
 * Open the OS folder picker (Settings → Browse…). Returns the chosen absolute
 * path, or `null` when the operator cancelled — or when there is no native
 * dialog to open, which a browser dev session must survive rather than throw.
 */
export async function pickDirectory(title?: string): Promise<string | null> {
  try {
    return await ipc.fs.pickDirectory(title);
  } catch (err) {
    logger.warn("config", "fs_pick_directory unavailable; no folder chosen.", err);
    return null;
  }
}

// ─── app version (Epic 10 §Configure → App version) ─────────────────────────

/**
 * The running app's version for the Settings display.
 *
 * Read from the Tauri bundle (the authoritative value, since that is what was
 * installed on the workstation) and falls back to the {@link APP_VERSION}
 * constant outside Tauri or if the call is not permitted.
 *
 * ARCH HANDOFF: `getVersion()` invokes the built-in `plugin:app|version`
 * command, so the capability needs `core:app:allow-version` — otherwise this
 * silently degrades to the compiled-in constant, which can drift from the
 * installed bundle.
 */
export async function getAppVersion(): Promise<string> {
  if (!isTauri()) return APP_VERSION;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const version = await getVersion();
    return version || APP_VERSION;
  } catch (err) {
    logger.warn("config", "app version unavailable; using the built-in constant.", err);
    return APP_VERSION;
  }
}
