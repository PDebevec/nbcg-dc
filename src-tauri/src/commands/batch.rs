//! `batch_*` — local batch persistence.

use tauri::State;

use crate::core::{batch_lifecycle, db, jobs};
use crate::dto::{BatchCreateDto, BatchDeletePlanDto, BatchDto};
use crate::error::{AppError, Result};

use super::AppState;

#[tauri::command]
pub fn batch_list(state: State<'_, AppState>) -> Result<Vec<BatchDto>> {
    state.db.with(db::batches::list)
}

/// Create a batch: snapshot every member's folder for undo, then persist the
/// row, assign its number and claim its items — the row, the membership and
/// the `batch_id` stamps are one transaction (see
/// [`batch_lifecycle::create`]). Async: on a volume that can't hard-link the
/// snapshot copies files, which must not freeze the window.
#[tauri::command(async)]
pub fn batch_create(state: State<'_, AppState>, fields: BatchCreateDto) -> Result<BatchDto> {
    batch_lifecycle::create(&state.db, &fields)
}

#[tauri::command]
pub fn batch_update(state: State<'_, AppState>, batch: BatchDto) -> Result<BatchDto> {
    state.db.transaction(|tx| db::batches::update(tx, &batch))
}

/// Archive an uploaded batch, release its items and drop its snapshots.
#[tauri::command]
pub fn batch_archive(state: State<'_, AppState>, batch_id: String) -> Result<BatchDto> {
    batch_lifecycle::archive(&state.db, &batch_id)
}

/// Record, before an upload's first backend write, that this batch is about
/// to change the backend — from then on it can't be deleted.
#[tauri::command]
pub fn batch_mark_backend_touched(
    state: State<'_, AppState>,
    batch_id: String,
) -> Result<BatchDto> {
    state
        .db
        .with(|c| db::batches::mark_backend_touched(c, &batch_id))
}

/// Dry-run a delete: per member, what goes, what comes back, and why the
/// batch can't be deleted if it can't.
#[tauri::command(async)]
pub fn batch_delete_preview(
    state: State<'_, AppState>,
    batch_id: String,
) -> Result<BatchDeletePlanDto> {
    let running = jobs::running_batch(&state.job_run).as_deref() == Some(batch_id.as_str());
    batch_lifecycle::preview(&state.db, &batch_id, running)
}

/// Delete a batch, putting its members back as they were before it.
///
/// Holds the job lock while it works, so the batch can't start processing
/// mid-restore. If another batch holds it, this one can't start either until
/// that run ends — so there is nothing to wait for.
#[tauri::command(async)]
pub fn batch_delete(state: State<'_, AppState>, batch_id: String) -> Result<()> {
    let _guard = match jobs::try_acquire(&state.job_run, &batch_id) {
        Ok(guard) => Some(guard),
        Err(_) if jobs::running_batch(&state.job_run).as_deref() == Some(batch_id.as_str()) => {
            return Err(AppError::Invalid(batch_lifecycle::RUNNING_REASON.into()));
        }
        Err(_) => None,
    };
    batch_lifecycle::delete(&state.db, &batch_id, false)
}
