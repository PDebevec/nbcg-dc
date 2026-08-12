//! `sync_*` — the durable sync-run history behind the Sync screen.

use tauri::State;

use crate::core::db;
use crate::dto::{SyncRunCreateDto, SyncRunDto};
use crate::error::Result;

use super::AppState;

#[tauri::command]
pub fn sync_log_append(state: State<'_, AppState>, run: SyncRunCreateDto) -> Result<SyncRunDto> {
    state.db.transaction(|tx| db::sync_runs::append(tx, &run))
}

#[tauri::command]
pub fn sync_log_list(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<SyncRunDto>> {
    state.db.with(|conn| db::sync_runs::list(conn, limit))
}
