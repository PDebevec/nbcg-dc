//! `index_*` — scan, list, rebuild, and the two write-through paths.

use tauri::State;

use crate::core::{db, fs as corefs};
use crate::dto::{IndexedItemDto, SyncRecordDto, UploadRecordDto};
use crate::error::Result;

use super::AppState;

/// Rescan both roots, reconcile the index, and return the item list.
#[tauri::command]
pub fn index_scan(state: State<'_, AppState>) -> Result<Vec<IndexedItemDto>> {
    let (unprocessed, processed) = state.roots()?;
    let discovered = corefs::scan_roots(unprocessed.as_deref(), processed.as_deref())?;

    // One transaction for the whole reconcile: a scan that half-applied would
    // leave the Overview showing a mix of two different moments.
    state
        .db
        .transaction(|tx| db::items::reconcile(tx, &discovered))?;

    state.db.with(db::items::list)
}

/// Return the tracked items without touching the filesystem.
#[tauri::command]
pub fn index_list(state: State<'_, AppState>) -> Result<Vec<IndexedItemDto>> {
    state.db.with(db::items::list)
}

/// Reconstruct the index from the folders, then return the item list.
#[tauri::command]
pub fn index_rebuild(state: State<'_, AppState>) -> Result<Vec<IndexedItemDto>> {
    let (unprocessed, processed) = state.roots()?;
    let discovered = corefs::scan_roots(unprocessed.as_deref(), processed.as_deref())?;

    state
        .db
        .transaction(|tx| db::items::rebuild(tx, &discovered))?;

    state.db.with(db::items::list)
}

/// Record a successful upload on an item's row.
#[tauri::command]
pub fn index_record_upload(
    state: State<'_, AppState>,
    item_id: String,
    upload: UploadRecordDto,
) -> Result<IndexedItemDto> {
    state
        .db
        .transaction(|tx| db::items::record_upload(tx, &item_id, &upload))
}

/// Fold a backend sync **read** onto an item's row.
///
/// See [`SyncRecordDto`] — this path must not move the item's derived state.
#[tauri::command]
pub fn index_record_sync(
    state: State<'_, AppState>,
    item_id: String,
    sync: SyncRecordDto,
) -> Result<IndexedItemDto> {
    state
        .db
        .transaction(|tx| db::items::record_sync(tx, &item_id, &sync))
}
