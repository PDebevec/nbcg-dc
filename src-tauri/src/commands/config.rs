//! `config_*` — settings persistence and the OS secret store.

use tauri::{AppHandle, State};

use crate::core::config;
use crate::dto::PersistedConfig;
use crate::error::Result;

use super::AppState;

#[tauri::command]
pub fn config_load(state: State<'_, AppState>) -> Result<Option<PersistedConfig>> {
    config::load(&state.config_dir)
}

#[tauri::command]
pub fn config_save(
    app: AppHandle,
    state: State<'_, AppState>,
    config: PersistedConfig,
) -> Result<()> {
    config::save(&state.config_dir, &config)?;

    // The roots may have moved, so the watcher has to follow. Failing to
    // re-point it is silent: the app keeps running, but freshly scanned
    // folders stop appearing until a relaunch.
    let (unprocessed, processed) = state.roots()?;
    crate::rewatch(&app, &state, unprocessed.as_deref(), processed.as_deref());

    Ok(())
}

#[tauri::command]
pub fn config_get_secret(key: String) -> Result<Option<String>> {
    config::get_secret(&key)
}

#[tauri::command]
pub fn config_set_secret(key: String, value: String) -> Result<()> {
    config::set_secret(&key, &value)
}

#[tauri::command]
pub fn config_delete_secret(key: String) -> Result<()> {
    config::delete_secret(&key)
}
