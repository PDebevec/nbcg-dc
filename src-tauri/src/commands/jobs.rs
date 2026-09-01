//! `jobs_*` — pipeline run control (Epic 06, first slice).
//!
//! Thin wrappers, per this module's own principle: resolve state, call into
//! [`crate::core::jobs`], translate the closure-based event stream into real
//! `AppHandle::emit(...)` calls. The actual queueing/execution logic lives in
//! `core::jobs`/`core::python`, entirely Tauri-free and unit-tested there.
//!
//! `jobs_start`/`jobs_reprocess` are `#[tauri::command(async)]`: a plain sync
//! command in Tauri v2 runs inline on the **main thread**
//! (`ExecutionContext::Blocking` in `tauri-macros`), so a whole-batch run
//! there would freeze the window for the run's duration *and* starve
//! `jobs_cancel` — also an invoke — of the main thread it needs to even be
//! delivered, making the runner's own cooperative cancel check unreachable
//! from any UI. `async` dispatches the body onto a tokio worker instead
//! (`tauri::async_runtime`), leaving the main thread free to handle
//! `jobs_cancel` promptly. `jobs_cancel` itself stays sync: it only flips a
//! flag and must be handled fast, so there's nothing to gain by moving it off
//! the main thread and it doesn't need to.

use tauri::{AppHandle, Emitter, State};

use crate::core::config;
use crate::core::jobs::{self, JobEvent};
use crate::dto::BatchRunRequest;
use crate::error::Result;

use super::AppState;

const JOB_PROGRESS_EVENT: &str = "job://progress";
const JOB_STAGE_CHANGED_EVENT: &str = "job://stage-changed";
const JOB_DONE_EVENT: &str = "job://done";

fn emit_job_event(app: &AppHandle, event: JobEvent) {
    let result = match event {
        JobEvent::Progress(payload) => app.emit(JOB_PROGRESS_EVENT, payload),
        JobEvent::StageChanged(payload) => app.emit(JOB_STAGE_CHANGED_EVENT, payload),
        JobEvent::Done(payload) => app.emit(JOB_DONE_EVENT, payload),
    };
    if let Err(e) = result {
        eprintln!("[nbcg-dc] failed to emit a job:// event: {e}");
    }
}

fn start_or_reprocess(
    app: AppHandle,
    state: State<'_, AppState>,
    request: BatchRunRequest,
) -> Result<()> {
    let guard = jobs::try_acquire(&state.job_run, &request.batch_id)?;
    // Config-file knob, not a command argument - a hand-edited config.json
    // takes effect on the next run with no new IPC surface. `Ok(None)`/`Err`
    // (no file yet, or a corrupt one - `config::load` already tolerates
    // that) both fall through to `JobLimits`'s own defaults.
    let limits =
        jobs::JobLimits::from_config(config::load(&state.config_dir).ok().flatten().as_ref());
    let result = jobs::run_batch(&state.db, &request, &guard, limits, |event| {
        emit_job_event(&app, event)
    });
    drop(guard);
    result
}

#[tauri::command(async)]
pub fn jobs_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: BatchRunRequest,
) -> Result<()> {
    start_or_reprocess(app, state, request)
}

#[tauri::command]
pub fn jobs_cancel(batch_id: String, state: State<'_, AppState>) -> Result<()> {
    if jobs::request_cancel(&state.job_run, &batch_id) {
        eprintln!("[nbcg-dc] jobs_cancel: batch {batch_id} - cancellation requested");
    } else {
        eprintln!("[nbcg-dc] jobs_cancel: batch {batch_id} - nothing running to cancel");
    }
    Ok(())
}

#[tauri::command(async)]
pub fn jobs_reprocess(
    app: AppHandle,
    state: State<'_, AppState>,
    request: BatchRunRequest,
) -> Result<()> {
    start_or_reprocess(app, state, request)
}
