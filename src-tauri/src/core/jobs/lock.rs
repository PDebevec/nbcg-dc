//! The single-run lock: one batch at a time per workstation.

use std::sync::Mutex;

use crate::core::cancel::CancelToken;
use crate::error::{AppError, Result};

// ─── single-run lock ──────────────────────────────────────────────────────────

/// One batch running at a time, per workstation. `cancel` doubles as the
/// cancel flag — only the running batch can ever be cancelled, so one field
/// set covers both.
#[derive(Debug, Default)]
pub struct JobRunLock {
    batch_id: Option<String>,
    cancel: CancelToken,
}

/// Holds the lock for the duration of a run. `Drop` unconditionally releases
/// it — whether the run returned `Ok`, `Err`, or unwound from a panic, since
/// the mutex is only ever held for the instant of a check/set/clear, never
/// across the run itself, so it cannot be poisoned by a panic inside
/// [`run_batch`].
pub struct JobRunGuard<'a> {
    lock: &'a Mutex<JobRunLock>,
    cancel: CancelToken,
}

impl JobRunGuard<'_> {
    pub fn cancel_requested(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// A clone of this run's cancel token, threaded down into
    /// `core::python`'s spawned children so a cancel kills whichever script
    /// is currently running, not just the *next* one.
    pub fn cancel_token(&self) -> CancelToken {
        self.cancel.clone()
    }
}

impl Drop for JobRunGuard<'_> {
    fn drop(&mut self) {
        let mut guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        guard.batch_id = None;
        // A fresh token, not a reset of the old one — a stale cancel from
        // this run must never leak into the next one, and a fresh
        // `CancelToken` is the simplest way to guarantee that.
        guard.cancel = CancelToken::new();
    }
}

/// Claim the lock for `batch_id`, or fail if another batch already holds it.
pub fn try_acquire<'a>(lock: &'a Mutex<JobRunLock>, batch_id: &str) -> Result<JobRunGuard<'a>> {
    let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(running) = &guard.batch_id {
        return Err(AppError::Invalid(format!(
            "batch {running} is already running"
        )));
    }
    guard.batch_id = Some(batch_id.to_string());
    guard.cancel = CancelToken::new();
    let cancel = guard.cancel.clone();
    drop(guard);
    Ok(JobRunGuard { lock, cancel })
}

/// Request cancellation of `batch_id`'s run, if it's the one currently
/// running. Returns whether it actually matched something.
pub fn request_cancel(lock: &Mutex<JobRunLock>, batch_id: &str) -> bool {
    let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if guard.batch_id.as_deref() == Some(batch_id) {
        guard.cancel.cancel();
        true
    } else {
        false
    }
}
