//! `fs_*` — folder picking, the `metadata.json` mirror, reveal, move, raw reads.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::core::{db, fs as corefs};
use crate::dto::{IndexedItemDto, LocalMetadataFile, ScanRoot};
use crate::error::{AppError, Result};

use super::AppState;

/// Open a native folder picker. `None` when the operator cancels.
///
/// Not `async`: Tauri runs synchronous commands off the main thread, which is
/// exactly where a blocking dialog belongs. Making it async would park a
/// runtime worker for as long as the operator browses.
#[tauri::command]
pub fn fs_pick_directory(app: AppHandle, title: Option<String>) -> Result<Option<String>> {
    let mut builder = app.dialog().file();
    if let Some(title) = title {
        builder = builder.set_title(title);
    }
    Ok(builder.blocking_pick_folder().map(|p| p.to_string()))
}

#[tauri::command]
pub fn fs_path_exists(path: String) -> Result<bool> {
    Ok(corefs::path_exists(Path::new(&path)))
}

#[tauri::command]
pub fn fs_read_metadata(path: String) -> Result<Option<LocalMetadataFile>> {
    // A malformed mirror reads as absent rather than an error — the caller's
    // next write-through will replace it, and failing here would block the
    // very edit that fixes it.
    Ok(corefs::read_metadata(Path::new(&path)).unwrap_or(None))
}

#[tauri::command]
pub fn fs_write_metadata(path: String, metadata: LocalMetadataFile) -> Result<()> {
    corefs::write_metadata(Path::new(&path), &metadata)
}

/// Reveal a folder in the OS file manager.
#[tauri::command]
pub fn fs_reveal_path(app: AppHandle, path: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(PathBuf::from(&path))
        .map_err(|e| AppError::Other(format!("reveal {path}: {e}")))
}

/// Move an item's folder `/unprocessed` → `/processed` and update its row.
///
/// The filesystem move happens first and the index follows. If the index write
/// somehow failed after a successful move, the next scan reconciles it — the
/// folder is the durable fact, the row is the cache. Doing it the other way
/// round would leave the index pointing at a path that does not exist.
#[tauri::command]
pub fn fs_move_to_processed(state: State<'_, AppState>, item_id: String) -> Result<IndexedItemDto> {
    let (_, processed) = state.roots()?;
    let processed = processed
        .ok_or_else(|| AppError::Invalid("the processed root is not configured".into()))?;

    let folder_path = state.db.with(|conn| {
        let item = db::items::get(conn, &item_id)?;
        Ok(item.folder_path)
    })?;

    let destination = corefs::move_to_processed(Path::new(&folder_path), &processed)?;

    state.db.with(|conn| {
        db::items::set_location(
            conn,
            &item_id,
            ScanRoot::Processed,
            &destination.to_string_lossy(),
        )
    })
}

/// Read a file's raw bytes for a multipart upload.
///
/// Returns [`tauri::ipc::Response`] so the bytes cross the bridge as **binary**.
/// A plain `Vec<u8>` return would serialize as a JSON array of numbers —
/// several times the size, and it would arrive in JS as `number[]` rather than
/// the `ArrayBuffer` the contract promises.
#[tauri::command]
pub fn fs_read_file(path: String) -> Result<tauri::ipc::Response> {
    let bytes = corefs::read_file(Path::new(&path))?;
    Ok(tauri::ipc::Response::new(bytes))
}
