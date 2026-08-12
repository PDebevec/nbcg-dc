//! `batch_*` — local batch persistence.

use tauri::State;

use crate::core::db;
use crate::dto::{BatchCreateDto, BatchDto};
use crate::error::Result;

use super::AppState;

#[tauri::command]
pub fn batch_list(state: State<'_, AppState>) -> Result<Vec<BatchDto>> {
    state.db.with(db::batches::list)
}

/// Create a batch, assign its running number, and claim its items.
///
/// Transactional: the row, the membership, and the `batch_id` stamp on each
/// item are one fact (see [`db::batches::create`]).
#[tauri::command]
pub fn batch_create(state: State<'_, AppState>, fields: BatchCreateDto) -> Result<BatchDto> {
    state.db.transaction(|tx| db::batches::create(tx, &fields))
}

#[tauri::command]
pub fn batch_update(state: State<'_, AppState>, batch: BatchDto) -> Result<BatchDto> {
    state.db.transaction(|tx| db::batches::update(tx, &batch))
}

/// Archive an uploaded batch and release its items.
#[tauri::command]
pub fn batch_archive(state: State<'_, AppState>, batch_id: String) -> Result<BatchDto> {
    state
        .db
        .transaction(|tx| db::batches::archive(tx, &batch_id))
}
