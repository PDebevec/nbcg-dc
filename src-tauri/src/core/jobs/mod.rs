//! The pipeline job runner (Epic 06).
//!
//! Up to [`JobLimits::max_concurrent_items`] items run at once, each through
//! its own `pdf` → `thumbnail` → `ocr` stages in strict order on one worker
//! thread; OCR is additionally capped batch-wide at
//! [`JobLimits::max_concurrent_ocr`] regardless of which worker reaches it,
//! since it's the heavy stage. See [`run_batch`]'s own doc comment for the
//! mechanism (a bounded worker pool plus a [`Semaphore`]) and [`JobLimits`]
//! for where the caps come from — a config.json knob, not a command argument.
//!
//! Handles **all six** `InputShape`s:
//!
//! - `PageImages`/`Tiffs` — `web.py` assembles the folder's images.
//! - `ImagesOnly` — thumbnail only (`web.py --thumbnail-only`); a standalone
//!   graphical work has no PDF, so no OCR either.
//! - `SuppliedPdf` — `pdf_derive.py` downscales the operator's PDF into
//!   `<folderName>.pdf`, with the original filed under `source/` (see
//!   [`SOURCE_SUBFOLDER`] for why that is required, not tidiness).
//! - `MultiplePdfs` — the discovered PDFs already *are* the web PDFs, so the
//!   `pdf` stage verifies rather than builds, and never rewrites them.
//! - `Empty` — nothing to run.
//!
//! Every field of `ItemRunRequest` the `.ts` lane decided is honoured and none
//! is re-derived here: `input_shape` (`web.py --mode`), `page_images`
//! (`--pages`), `folder_name` (`--name`), `primary_thumbnail`
//! (`--thumbnail-source`), `thumbnail_needs_choice` (withholds the stage's
//! `Done`), `split_spreads` (`split_spreads.py` before assembly) and
//! `web_pdf_bases` (one OCR text per web PDF).
//!
//! Mid-process cancellation (`Command::kill`, via `core::python`) is real.
//! An *interactive* multi-candidate thumbnail picker (there is no GUI for one
//! yet) is deliberately out of scope — see
//! `docs/tasks/06-processing-pipeline-and-jobs.md`.
//!
//! Tauri-free by design, matching `core::fs::FsWatcher`'s shape: [`run_batch`]
//! takes a plain `emit: impl FnMut(JobEvent)` closure rather than an
//! `AppHandle`, so it is unit-testable without a webview — only
//! `commands::jobs` turns that closure into real `app.emit(...)` calls.

mod limits;
mod lock;
mod shapes;
mod stages;

pub use limits::JobLimits;
pub use lock::{request_cancel, try_acquire, JobRunGuard, JobRunLock};

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;

use crate::core::cancel::CancelToken;
use crate::core::db::{items, Db};
use crate::core::python;
use crate::dto::{
    BatchRunRequest, InputShape, ItemRunRequest, JobDoneEvent, JobOutcome, JobProgressEvent,
    JobRunMode, JobStageChangedEvent, StageStatus,
};
use crate::error::{AppError, Result};

use limits::Semaphore;
use shapes::*;
use stages::*;

// ─── events ───────────────────────────────────────────────────────────────────

pub enum JobEvent {
    Progress(JobProgressEvent),
    StageChanged(JobStageChangedEvent),
    Done(JobDoneEvent),
}

fn run_item(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    emit: &mut impl FnMut(JobEvent),
    runtime: Option<&python::PythonRuntime>,
    cancel: &CancelToken,
    ocr_gate: &Semaphore,
) -> Result<ItemOutcome> {
    let mut outcome = ItemOutcome::default();
    let stages = canonical_stages(&item.stages);
    if stages.is_empty() {
        return Ok(outcome);
    }

    match item.input_shape {
        InputShape::PageImages | InputShape::Tiffs => {
            run_pdf_thumbnail_ocr(
                db,
                request,
                item,
                &stages,
                &mut outcome,
                emit,
                runtime,
                cancel,
                ocr_gate,
            )?;
        }
        InputShape::ImagesOnly => {
            run_images_only(
                db,
                request,
                item,
                &stages,
                &mut outcome,
                emit,
                runtime,
                cancel,
                ocr_gate,
            )?;
        }
        InputShape::SuppliedPdf => {
            run_supplied_pdf(
                db,
                request,
                item,
                &stages,
                &mut outcome,
                emit,
                runtime,
                cancel,
                ocr_gate,
            )?;
        }
        InputShape::MultiplePdfs => {
            run_multiple_pdfs(
                db,
                request,
                item,
                &stages,
                &mut outcome,
                emit,
                runtime,
                cancel,
                ocr_gate,
            )?;
        }
        InputShape::Empty => {
            // TS shouldn't send stages for an empty folder; handled
            // defensively the same as an unsupported shape if it somehow does.
            run_unsupported(
                db,
                request,
                item,
                &stages,
                "input shape 'empty' has nothing to run",
                &mut outcome,
                emit,
            )?;
        }
    }

    Ok(outcome)
}

/// After a cancelled run, every stage this run queued but never finished
/// (still `Queued` or `Running` in SQLite) is reset to `Pending` rather than
/// left stuck `Queued` forever — `stagesToRun` re-runs anything not `done`,
/// so a `Pending` stage resumes cleanly on the next Start with no red the
/// operator didn't cause. Reads each item's current status back from the
/// index rather than tracking a separate bookkeeping set, so it is
/// self-correcting regardless of exactly where in the batch the cancel
/// landed — items already settled (Done/Failed/Skipped/Pending) are simply a
/// no-op here.
fn reset_unfinished_stages(
    db: &Db,
    request: &BatchRunRequest,
    emit: &mut impl FnMut(JobEvent),
) -> Result<()> {
    for item in &request.items {
        let current = db.with(|c| items::get(c, &item.item_id))?;
        for stage in canonical_stages(&item.stages) {
            let stage_name = to_stage_name(stage);
            let is_unfinished = current
                .stages
                .get(&stage_name)
                .is_some_and(|s| matches!(s.status, StageStatus::Queued | StageStatus::Running));
            if is_unfinished {
                set_stage_status(
                    db,
                    request,
                    item,
                    stage_name,
                    StageStatus::Pending,
                    None,
                    emit,
                )?;
            }
        }
    }
    Ok(())
}

/// The `ReuploadKind` a Reprocess pass's [`ItemOutcome`] implies, or `None`
/// when nothing actually changed (no reupload needed at all — e.g. every
/// requested stage was already `done` and skip-if-done left it alone, or a
/// `multiple-pdfs` item's `Pdf` stage only re-verified the operator's own
/// files). Pulled out as its own pure function (no `Db`/IO) specifically so
/// it's unit-testable without a real Python subprocess — a live OCR pass
/// isn't available in every dev/CI environment (see this module's own doc
/// comment and `core_jobs.rs`'s), so `text_changed`'s classification can't
/// always be exercised through a real end-to-end `run_batch` call, but this
/// function's logic can be pinned directly regardless.
///
/// Content changing always wins as `Full`, even when `text_changed` is also
/// set from the same pass — see [`db::items::mark_needs_reupload`]'s own doc
/// comment for why the *column* write is still more than a plain assignment
/// beyond this per-call choice (it must not downgrade an already-pending
/// `Full` from an *earlier*, still-unpublished pass).
fn reupload_kind_for(outcome: &ItemOutcome) -> Option<items::ReuploadKind> {
    if outcome.content_changed {
        Some(items::ReuploadKind::Full)
    } else if outcome.text_changed {
        Some(items::ReuploadKind::TextOnly)
    } else {
        None
    }
}

/// One item's full run, plus its own terminal `job://done` — always with
/// `batch_complete: false`; that flag is now a single event [`run_batch`]
/// emits once, after every worker has finished, since "the last item" isn't
/// well-defined once items run concurrently (see `run_batch`'s own doc
/// comment). Returns `Err` only for a genuine infra failure (e.g. a DB write
/// failing) — a Python-script failure is already caught inside [`run_item`]
/// and turned into a `Failed` stage status, never bubbled up here.
fn run_one_item(
    db: &Db,
    request: &BatchRunRequest,
    item: &ItemRunRequest,
    emit: &mut impl FnMut(JobEvent),
    runtime: Option<&python::PythonRuntime>,
    cancel: &CancelToken,
    ocr_gate: &Semaphore,
) -> Result<()> {
    let outcome = run_item(db, request, item, emit, runtime, cancel, ocr_gate)?;

    if cancel.is_cancelled() {
        // The cancel landed mid-item: its own settle points already left
        // the interrupted stage(s) `Pending` (never `Failed`), but do not
        // emit this item's own terminal event — reporting it `done`/
        // `failed` here would be wrong when a later stage never ran. The
        // post-join `reset_unfinished_stages` plus the batch-level
        // `Cancelled` event in `run_batch` cover cleanup; `resetInFlightRuns`
        // on the `.ts` side handles any item that never got a terminal event.
        return Ok(());
    }

    if request.mode == JobRunMode::Reprocess {
        if let Some(kind) = reupload_kind_for(&outcome) {
            let already_uploaded = db.with(|c| items::get(c, &item.item_id))?.uploaded;
            if already_uploaded {
                db.with(|c| items::mark_needs_reupload(c, &item.item_id, kind))?;
            }
        }
    }

    emit(JobEvent::Done(JobDoneEvent {
        batch_id: request.batch_id.clone(),
        item_id: Some(item.item_id.clone()),
        outcome: if outcome.any_failed {
            JobOutcome::Failed
        } else {
            JobOutcome::Done
        },
        error: outcome.first_error,
        batch_complete: false,
    }));
    Ok(())
}

/// Run every item in `request`, up to `limits.max_concurrent_items` at once
/// — each item still runs its own `pdf` → `thumbnail` → `ocr` stages in
/// strict order, on one worker thread ([`std::thread::scope`], borrowing
/// `db`/the cancel token without needing `'static`/`Arc`), but different
/// items' stages can now overlap. OCR is additionally gated by
/// `limits.max_concurrent_ocr` across the *whole* batch regardless of which
/// worker reaches it — see [`Semaphore`] — since that's the heavy stage
/// (PaddleOCR); PDF/thumbnail assembly is comparatively light and is bounded
/// only by `max_concurrent_items`. Handles `Run`/`Rerun`/`Reprocess` alike -
/// `mode` only changes whether `mark_needs_reupload` fires, not the
/// execution path.
///
/// `emit` stays a plain `FnMut`, called from exactly one thread — this one.
/// Workers report events over an `mpsc` channel instead of calling `emit`
/// directly, drained here while they're still running (not after they all
/// finish, or progress would arrive in one late burst) — real concurrency in
/// the *work*, without needing every caller of [`run_batch`] (and every
/// existing test's `|e| events.push(e)`-style collector) to become `Sync`.
///
/// Per-item terminal events (`job://done` with a real `item_id`) can now
/// arrive in any order — the `.ts` reducer already keys them by `itemId`, not
/// position (`applyJobDone`). `batch_complete: true` is therefore its own,
/// separate synthetic event (`item_id: None`), emitted exactly once after
/// every worker has finished — the same shape the cancellation and
/// empty-batch paths already used, just now also used on normal completion.
///
/// Runs with no [`python::PythonRuntime`] override — bare `python`/`py` on
/// `PATH`, exactly this function's behavior before Epic 11's bundling
/// existed. Frozen at this exact 5-argument signature deliberately: it's
/// called with it 18 times across `src-tauri/tests/core_jobs.rs`, and Rust
/// has no default parameters, so widening it directly would force-edit
/// every one of those. See [`run_batch_with_runtime`] for the real
/// implementation and the vendored-runtime path `commands::jobs` uses.
pub fn run_batch(
    db: &Db,
    request: &BatchRunRequest,
    guard: &JobRunGuard<'_>,
    limits: JobLimits,
    emit: impl FnMut(JobEvent),
) -> Result<()> {
    run_batch_with_runtime(db, request, guard, limits, None, emit)
}

/// [`run_batch`], with an optional vendored [`python::PythonRuntime`]
/// override — `Some` when Epic 11's bundled Python is present
/// (`commands::jobs::start_or_reprocess` passes `state.python_runtime`),
/// `None` for every existing caller/test (today's exact bare-`PATH`
/// behavior). See `run_batch`'s own doc comment for the full concurrency
/// model — identical here, just with `runtime` threaded down to every
/// `python::run_*` call via `run_one_item`/`run_item`.
pub fn run_batch_with_runtime(
    db: &Db,
    request: &BatchRunRequest,
    guard: &JobRunGuard<'_>,
    limits: JobLimits,
    runtime: Option<&python::PythonRuntime>,
    mut emit: impl FnMut(JobEvent),
) -> Result<()> {
    if request.items.is_empty() {
        emit(JobEvent::Done(JobDoneEvent {
            batch_id: request.batch_id.clone(),
            item_id: None,
            outcome: JobOutcome::Done,
            error: None,
            batch_complete: true,
        }));
        return Ok(());
    }

    // Queue everything up front, so the UI can show the whole run's shape
    // before the first stage actually starts. Single-threaded still - a
    // fixed setup pass before any worker starts.
    for item in &request.items {
        for stage in canonical_stages(&item.stages) {
            set_stage_status(
                db,
                request,
                item,
                to_stage_name(stage),
                StageStatus::Queued,
                None,
                &mut emit,
            )?;
        }
    }

    let cancel_token = guard.cancel_token();
    let ocr_gate = Semaphore::new(limits.max_concurrent_ocr);
    let next_index = AtomicUsize::new(0);
    let first_error: Mutex<Option<AppError>> = Mutex::new(None);
    let worker_count = limits.max_concurrent_items.min(request.items.len()).max(1);

    // Bind references once, outside the loop: `thread::scope`'s spawned
    // closures need `move` (a per-iteration `Sender`/`CancelToken` clone
    // can't be *borrowed* across the loop boundary into a thread that may
    // outlive that iteration), and `move` takes full ownership of whatever
    // it captures - so every worker captures a `Copy`-able shared
    // *reference* into the one `Semaphore`/`AtomicUsize`/`Mutex`, not an
    // attempt to move the shared value itself into more than one closure.
    let ocr_gate_ref = &ocr_gate;
    let next_index_ref = &next_index;
    let first_error_ref = &first_error;
    let (tx, rx) = std::sync::mpsc::channel::<JobEvent>();

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let tx = tx.clone();
            let cancel_token = cancel_token.clone();
            scope.spawn(move || {
                let mut emit_worker = |e: JobEvent| {
                    // Can only fail if every `Receiver` is already gone,
                    // which can't happen while this thread is still running
                    // inside the enclosing `thread::scope` - the receiver is
                    // drained below, in that same scope, on the calling
                    // thread.
                    let _ = tx.send(e);
                };
                loop {
                    if cancel_token.is_cancelled() {
                        return;
                    }
                    let index = next_index_ref.fetch_add(1, Ordering::SeqCst);
                    let Some(item) = request.items.get(index) else {
                        return; // the queue is drained
                    };
                    if let Err(e) = run_one_item(
                        db,
                        request,
                        item,
                        &mut emit_worker,
                        runtime,
                        &cancel_token,
                        ocr_gate_ref,
                    ) {
                        // A genuine infra failure: stop every other worker
                        // from picking up new work, same as an operator
                        // cancel, and keep the first error - it's the one
                        // most likely to point at the actual cause.
                        cancel_token.cancel();
                        let mut slot = first_error_ref.lock().unwrap_or_else(|e| e.into_inner());
                        if slot.is_none() {
                            *slot = Some(e);
                        }
                        return;
                    }
                }
            });
        }
        drop(tx); // this scope's own sender - else the channel never closes

        // Drain live, on the calling thread, while workers are still
        // running - the loop ends once every worker has dropped its own
        // `Sender` clone, i.e. once every worker has returned.
        for event in rx.iter() {
            emit(event);
        }
    });

    if cancel_token.is_cancelled() {
        reset_unfinished_stages(db, request, &mut emit)?;
    }

    if let Some(e) = first_error.into_inner().unwrap_or_else(|e| e.into_inner()) {
        // No terminal event on an infra failure, same as before this run
        // could be split across threads - the command's own `Result::Err`
        // is what the `.ts` invoke call sees.
        return Err(e);
    }

    emit(JobEvent::Done(JobDoneEvent {
        batch_id: request.batch_id.clone(),
        item_id: None,
        outcome: if cancel_token.is_cancelled() {
            JobOutcome::Cancelled
        } else {
            JobOutcome::Done
        },
        error: None,
        batch_complete: true,
    }));

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `reupload_kind_for` (Epic 07 re-upload granularity) - pinned directly
    /// since a real `text_changed = true` settle needs a live OCR pass this
    /// environment can't run (see the function's own doc comment).
    #[test]
    fn reupload_kind_for_prefers_full_over_text_only() {
        let outcome = ItemOutcome {
            content_changed: true,
            text_changed: true,
            ..Default::default()
        };
        assert_eq!(reupload_kind_for(&outcome), Some(items::ReuploadKind::Full));
    }

    #[test]
    fn reupload_kind_for_is_text_only_when_only_text_changed() {
        let outcome = ItemOutcome {
            content_changed: false,
            text_changed: true,
            ..Default::default()
        };
        assert_eq!(
            reupload_kind_for(&outcome),
            Some(items::ReuploadKind::TextOnly)
        );
    }

    #[test]
    fn reupload_kind_for_is_none_when_nothing_changed() {
        let outcome = ItemOutcome::default();
        assert_eq!(reupload_kind_for(&outcome), None);
    }
}
