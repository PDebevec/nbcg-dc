//! Config persistence: a JSON store for non-secret settings, the OS credential
//! store for the API token.
//!
//! The split is the whole point of this module. `nbcg-dc` authenticates with a
//! **static Keycloak bearer token** that does not expire on a useful timescale
//! and grants write access to the live catalogue. The TypeScript side falls
//! back to `localStorage` when these commands are missing (`services/config`),
//! which is fine for a `vite` dev session and *not* fine on a library
//! workstation — it would leave a live credential in plain text in the webview
//! profile. Implementing [`get_secret`]/[`set_secret`] is what retires that
//! fallback.

use std::path::{Path, PathBuf};

use crate::dto::PersistedConfig;
use crate::error::{AppError, Result};

/// Filename of the non-secret settings store, inside the app config dir.
pub const CONFIG_FILENAME: &str = "config.json";

/// Keyring service name. Namespaced to the app so it is identifiable in the
/// Windows Credential Manager UI.
const KEYRING_SERVICE: &str = "nbcg-dc";

/// Load the persisted config.
///
/// Returns `Ok(None)` when nothing has been saved yet — a fresh install, which
/// the first-run card keys off. A **corrupt** store is also reported as `None`
/// rather than an error: the alternative is an app that cannot start until
/// someone hand-edits JSON, and every value in here is re-enterable in
/// Settings.
pub fn load(config_dir: &Path) -> Result<Option<PersistedConfig>> {
    let path = config_dir.join(CONFIG_FILENAME);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw).ok())
}

/// Persist the config, atomically (temp + rename) for the same reason the
/// metadata mirror is: a torn write here is a broken launch.
pub fn save(config_dir: &Path, config: &PersistedConfig) -> Result<()> {
    std::fs::create_dir_all(config_dir)?;

    let target = config_dir.join(CONFIG_FILENAME);
    let temp = config_dir.join(format!("{CONFIG_FILENAME}.tmp"));
    let json = serde_json::to_string_pretty(config)?;

    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
    }

    match std::fs::rename(&temp, &target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            Err(e.into())
        }
    }
}

/// Persist `incoming`, first restoring the job-runner concurrency caps
/// (`maxConcurrentItems`/`maxConcurrentOcr`, `core::jobs::JobLimits`) from
/// whatever is already on disk.
///
/// Those two fields are a backend-only knob — hand-edited in `config.json`
/// directly, never surfaced in Settings — so the `.ts` settings type never
/// carries them. A plain [`save`] of whatever the GUI's `config_save` call
/// sent would therefore silently reset them to `None` on every unrelated
/// settings change (a new API URL, a theme toggle, ...). This is what
/// `commands::config::config_save` calls instead of `save` directly. A fresh
/// install has nothing to restore — `Ok(None)`/a corrupt file both fall
/// through to `incoming`'s own values, which is fine, since
/// `JobLimits::from_config` already defaults a missing value.
pub fn save_preserving_job_limits(config_dir: &Path, mut incoming: PersistedConfig) -> Result<()> {
    if let Ok(Some(existing)) = load(config_dir) {
        incoming.max_concurrent_items = existing.max_concurrent_items;
        incoming.max_concurrent_ocr = existing.max_concurrent_ocr;
    }
    save(config_dir, &incoming)
}

/// Path to the config file (exposed for tests and diagnostics).
pub fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join(CONFIG_FILENAME)
}

fn entry(key: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, key).map_err(AppError::from)
}

/// Read a secret. `Ok(None)` when it has never been set.
pub fn get_secret(key: &str) -> Result<Option<String>> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

/// Store a secret in the OS credential store.
pub fn set_secret(key: &str, value: &str) -> Result<()> {
    entry(key)?
        .set_password(value)
        .map_err(|e| AppError::Keyring(e.to_string()))
}

/// Delete a secret. Deleting one that is already absent succeeds — the caller
/// wanted it gone, and it is.
pub fn delete_secret(key: &str) -> Result<()> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}
